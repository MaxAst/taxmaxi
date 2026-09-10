/** Shared completed movement projections and row attention through recorded links.
 * @module TransactionReadProjection
 */
import { aliasedTable, and, asc, eq, exists, notExists, inArray, or, sql } from "drizzle-orm"
import { AccountingEvent, ValuationFact, type JurisdictionCode } from "@my/core/accounting"
import { CurrencyCode } from "@my/core/currency"
import * as BigDecimal from "effect/BigDecimal"
import * as Effect from "effect/Effect"
import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import { PersistenceError, wrapSqlError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import type {
  TransactionListMovement,
  TransactionListMovementCapture,
} from "../services/TransactionListRepository.ts"
import type { drizzle } from "./PgClientLive.ts"

type TransactionReadExecutor = Pick<Effect.Success<typeof drizzle>, "select">
const canonicalTransactionTable = aliasedTable(schema.transactions, "list_canonical_transaction")

const CapturedMovement = Schema.Struct({
  targetId: Schema.String.check(Schema.isUUID()),
  currentOutcome: Schema.Literals(["included", "withheld", "absent", "outside_period"]),
  current: Schema.NullOr(
    Schema.Struct({
      legId: Schema.String.check(Schema.isUUID()),
      transactionId: Schema.NullOr(Schema.String.check(Schema.isUUID())),
      quantity: Schema.toEncoded(Schema.BigDecimalFromString),
      occurredAt: Schema.DateTimeUtcFromString,
      legKind: Schema.Literals(["acquisition", "disposal", "income", "fee"]),
      effectiveAssetId: Schema.NullOr(Schema.String.check(Schema.isUUID())),
      storedAssetId: Schema.String.check(Schema.isUUID()),
      custody: Schema.Array(
        Schema.Struct({
          reconciliationId: Schema.String.check(Schema.isUUID()),
          occurredAt: Schema.DateTimeUtcFromString,
        })
      ),
    })
  ),
  effective: Schema.Struct({
    event: Schema.NullOr(Schema.toEncoded(AccountingEvent)),
    valuationFacts: Schema.Array(Schema.toEncoded(ValuationFact)),
  }),
})

const CapturedValuation = Schema.Union([
  Schema.Struct({ _tag: Schema.Literals(["not_evaluated", "missing", "ambiguous"]) }),
  Schema.TaggedStruct("selected", {
    kind: Schema.Literals(["user_valuation", "observed_consideration", "market_quote"]),
    total: Schema.Struct({
      amount: Schema.toEncoded(Schema.BigDecimalFromString),
      currency: CurrencyCode,
    }),
  }),
])

const INCOME_CAUSES = new Set([
  "airdrop",
  "mining_reward",
  "staking_reward",
  "passive_staking_reward",
  "reward",
  "payment",
])

/** Completed movement display and recorded links shared by list and detail. */
export interface CapturedMovementProjection {
  readonly movement: TransactionListMovement & { readonly capture: TransactionListMovementCapture }
  readonly recorded: typeof CapturedMovement.Type
  readonly income: BigDecimal.BigDecimal | null
}

const recordedYear = (timestamp: DateTime.Utc) =>
  DateTime.getPart(DateTime.setZoneNamedUnsafe(timestamp, "Europe/Berlin"), "year")

/** Annual calculation identity; omitted year selects each movement’s recorded period. */
export interface CalculationReadScope {
  readonly principalId: string
  readonly jurisdiction: JurisdictionCode
  readonly taxYear?: number
  readonly reportingCurrency: CurrencyCode
}

const eventTaxYear = sql<number>`extract(
  year from (${schema.transactionLegs.timestamp} at time zone 'UTC') at time zone 'Europe/Berlin'
)::integer`

/** Match an active calculation under the requested principal and monetary scope. */
export const activeRunScope = (scope: CalculationReadScope) =>
  and(
    eq(schema.activeCalculationRuns.principalId, scope.principalId),
    eq(schema.activeCalculationRuns.jurisdiction, scope.jurisdiction),
    eq(schema.activeCalculationRuns.reportingCurrency, scope.reportingCurrency),
    scope.taxYear === undefined
      ? undefined
      : eq(schema.activeCalculationRuns.taxYear, scope.taxYear)
  )

const matchingEventTaxYear = eq(schema.activeCalculationRuns.taxYear, eventTaxYear)

const decodeDecimal = ({
  operation,
  value,
}: {
  readonly operation: string
  readonly value: unknown
}) =>
  Schema.decodeUnknownEffect(Schema.BigDecimalFromString)(value).pipe(
    Effect.mapError(
      () =>
        new PersistenceError({
          operation,
          cause: `Invalid decimal value: ${String(value)}`,
        })
    )
  )

const ownedLeg = (principalId: string) =>
  and(
    or(
      eq(schema.transactionLegs.transactionId, schema.transactions.id),
      eq(schema.transactionLegs.feeForTransactionId, schema.transactions.id)
    ),
    eq(schema.transactionLegs.principalId, principalId),
    eq(schema.transactions.principalId, principalId),
    eq(schema.transactionLegs.sourceId, schema.transactions.sourceId)
  )

const inputs = schema.calculationRunMovementInputs
const blockers = schema.calculationRunBlockers

// Use the occurrence period recorded in the completed projection, never a replayed leg's date.
const capturedPeriod = sql<boolean>`(
  case
    when ${inputs.captured}->'effective'->'event'->>'id' is not null then
      extract(year from to_timestamp((${inputs.captured}->'effective'->'event'->'occurredAt'->>'epochMillis')::numeric / 1000) at time zone 'Europe/Berlin') = ${schema.activeCalculationRuns.taxYear}
    when jsonb_array_length(coalesce(${inputs.captured}->'current'->'custody', '[]'::jsonb)) > 0 then
      exists (select 1 from jsonb_array_elements(${inputs.captured}->'current'->'custody') as context
        where extract(year from (context->>'occurredAt')::timestamptz at time zone 'Europe/Berlin') = ${schema.activeCalculationRuns.taxYear})
    else extract(year from (${inputs.captured}->'current'->>'occurredAt')::timestamptz at time zone 'Europe/Berlin') = ${schema.activeCalculationRuns.taxYear}
  end
)`

/** Exact target and recorded-period predicate for a current owned movement. */
export const capturedTarget = (scope: CalculationReadScope) =>
  and(
    eq(inputs.principalId, scope.principalId),
    eq(inputs.targetId, schema.transactionLegs.movementCorrectionTargetId),
    eq(inputs.sourceId, schema.transactionLegs.sourceId),
    capturedPeriod
  )

const hasNoCapture = (executor: TransactionReadExecutor, scope: CalculationReadScope) =>
  notExists(
    executor
      .select({ targetId: inputs.targetId })
      .from(inputs)
      .where(
        and(
          eq(inputs.runId, schema.activeCalculationRuns.runId),
          eq(inputs.principalId, scope.principalId),
          eq(inputs.sourceId, schema.transactionLegs.sourceId),
          eq(inputs.targetId, schema.transactionLegs.movementCorrectionTargetId)
        )
      )
  )

/** Row attention from explicit owned reviews and recorded blocker links. */
export const attentionPredicate = (
  executor: TransactionReadExecutor,
  scope: CalculationReadScope
) =>
  sql<boolean>`(${exists(
    executor
      .select({ id: schema.transactionReviews.id })
      .from(schema.transactionReviews)
      .where(
        and(
          eq(schema.transactionReviews.principalId, scope.principalId),
          eq(schema.transactionReviews.transactionId, schema.transactions.id),
          eq(schema.transactionReviews.needsReview, true)
        )
      )
  )} or ${exists(
    executor
      .select({ id: schema.transactionLegs.id })
      .from(schema.transactionLegs)
      .innerJoin(
        inputs,
        and(
          eq(inputs.principalId, scope.principalId),
          eq(inputs.targetId, schema.transactionLegs.movementCorrectionTargetId),
          eq(inputs.sourceId, schema.transactionLegs.sourceId)
        )
      )
      .innerJoin(
        schema.activeCalculationRuns,
        and(eq(schema.activeCalculationRuns.runId, inputs.runId), activeRunScope(scope))
      )
      .innerJoin(
        blockers,
        and(
          eq(blockers.runId, inputs.runId),
          eq(blockers.principalId, scope.principalId),
          or(
            eq(blockers.eventId, inputs.eventId),
            sql`${blockers.eventId}::text = ${inputs.captured}->'current'->>'legId'`,
            sql`${blockers.eventId}::text = ${inputs.captured}->'current'->>'transactionId'`,
            sql`exists (select 1 from jsonb_array_elements(coalesce(${inputs.captured}->'current'->'custody', '[]'::jsonb)) as context
            where context->>'reconciliationId' = ${blockers.eventId}::text
            and extract(year from (context->>'occurredAt')::timestamptz at time zone 'Europe/Berlin') = ${schema.activeCalculationRuns.taxYear})`
          )
        )
      )
      .where(and(ownedLeg(scope.principalId), capturedPeriod))
  )} or ${exists(
    // Old runs have no movement capture. Only their still-recorded exact IDs can link attention.
    executor
      .select({ id: schema.transactionLegs.id })
      .from(schema.transactionLegs)
      .innerJoin(schema.activeCalculationRuns, and(activeRunScope(scope), matchingEventTaxYear))
      .innerJoin(
        blockers,
        and(
          eq(blockers.runId, schema.activeCalculationRuns.runId),
          eq(blockers.principalId, scope.principalId),
          or(
            eq(blockers.eventId, schema.transactionLegs.id),
            eq(blockers.eventId, schema.transactions.id)
          )
        )
      )
      .where(and(ownedLeg(scope.principalId), hasNoCapture(executor, scope)))
  )} or ${exists(
    executor
      .select({ id: schema.transactionLegs.id })
      .from(schema.transactionLegs)
      .innerJoin(
        schema.transferReconciliations,
        and(
          eq(schema.transferReconciliations.principalId, scope.principalId),
          or(
            and(
              eq(schema.transactionLegs.originKind, "canonical_transfer"),
              eq(
                schema.transactionLegs.sourceTransferId,
                schema.transferReconciliations.canonicalTransferId
              )
            ),
            and(
              eq(schema.transactionLegs.originKind, "provider_transfer"),
              eq(
                schema.transactionLegs.providerTransferId,
                schema.transferReconciliations.providerTransferId
              )
            )
          )
        )
      )
      .innerJoin(
        canonicalTransactionTable,
        and(
          eq(canonicalTransactionTable.id, schema.transferReconciliations.canonicalTransactionId),
          eq(canonicalTransactionTable.principalId, scope.principalId)
        )
      )
      .innerJoin(
        schema.activeCalculationRuns,
        and(
          activeRunScope(scope),
          sql`extract(year from (${canonicalTransactionTable.timestamp} at time zone 'UTC') at time zone 'Europe/Berlin') = ${schema.activeCalculationRuns.taxYear}`
        )
      )
      .innerJoin(
        blockers,
        and(
          eq(blockers.runId, schema.activeCalculationRuns.runId),
          eq(blockers.principalId, scope.principalId),
          eq(blockers.eventId, schema.transferReconciliations.id)
        )
      )
      .where(and(ownedLeg(scope.principalId), hasNoCapture(executor, scope)))
  )})`

/** Read completed facts for a page’s transaction IDs or detail’s exact discovered targets. */
export const loadCaptures = ({
  executor,
  scope,
  selection,
}: {
  readonly executor: TransactionReadExecutor
  readonly scope: CalculationReadScope
  readonly selection:
    | { readonly kind: "transactions"; readonly ids: ReadonlyArray<string> }
    | { readonly kind: "targets"; readonly ids: ReadonlyArray<string> }
}) =>
  Effect.gen(function* () {
    const byTarget = new Map<string, CapturedMovementProjection>()
    if (selection.ids.length === 0) return byTarget
    const inputs = schema.calculationRunMovementInputs
    // Replays can replace transaction/leg IDs. The owned durable target connects the
    // current page to historical captures without rewriting their original transaction link.
    const currentTarget = and(
      eq(schema.transactionLegs.movementCorrectionTargetId, inputs.targetId),
      eq(schema.transactionLegs.sourceId, inputs.sourceId),
      eq(schema.transactionLegs.principalId, inputs.principalId)
    )
    const selectedPage = and(
      eq(inputs.principalId, scope.principalId),
      selection.kind === "transactions"
        ? inArray(schema.transactionLegs.transactionId, selection.ids)
        : inArray(inputs.targetId, selection.ids)
    )
    const rows = yield* executor
      .select({
        targetId: inputs.targetId,
        runId: inputs.runId,
        taxYear: schema.activeCalculationRuns.taxYear,
        eventId: inputs.eventId,
        captured: inputs.captured,
        valuation: inputs.valuation,
      })
      .from(inputs)
      .innerJoin(
        schema.activeCalculationRuns,
        and(eq(schema.activeCalculationRuns.runId, inputs.runId), activeRunScope(scope))
      )
      .innerJoin(schema.transactionLegs, currentTarget)
      .where(selectedPage)
      .pipe(wrapSqlError("transactionListRepository.list.captures"))
    const candidates = yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        const captured = yield* Schema.decodeEffect(CapturedMovement)(row.captured)
        const valuation = yield* Schema.decodeEffect(CapturedValuation)(row.valuation)
        const event = captured.effective.event
        const current = captured.current
        // An absent target has no completed movement facts or event year to project.
        if (current === null) return null
        const timestamps =
          event !== null
            ? [
                yield* Schema.decodeEffect(Schema.DateTimeUtcFromMillis)(
                  event.occurredAt.epochMillis
                ),
              ]
            : current.custody.length > 0
              ? current.custody.map((context) => context.occurredAt)
              : [current.occurredAt]
        return timestamps.some((timestamp) => recordedYear(timestamp) === row.taxYear)
          ? { ...row, captured: { ...captured, current }, valuation }
          : null
      }).pipe(
        Effect.mapError(
          (cause) =>
            new PersistenceError({
              operation: "transactionListRepository.list.decodeCapture",
              cause,
            })
        )
      )
    )
    const decoded = candidates.filter((row) => row !== null)
    const assetIds = [
      ...new Set(
        decoded.map(
          ({ captured }) =>
            captured.effective.event?.assetId ??
            captured.current.effectiveAssetId ??
            captured.current.storedAssetId
        )
      ),
    ]
    const assets =
      assetIds.length === 0
        ? []
        : yield* executor
            .select({ id: schema.assets.id, symbol: schema.assets.symbol })
            .from(schema.assets)
            .where(inArray(schema.assets.id, assetIds))
            .pipe(wrapSqlError("transactionListRepository.list.capturedAssets"))
    const symbols = new Map(assets.map((asset) => [asset.id, asset.symbol]))
    const results = schema.calculationRunRealizedResults
    const allocations = yield* executor
      .select({
        targetId: inputs.targetId,
        runId: inputs.runId,
        acquisitionEventId: results.acquisitionEventId,
        quantity: results.quantity,
        costBasis: results.costBasis,
        proceeds: results.proceeds,
        gainLoss: results.gainLoss,
      })
      .from(inputs)
      .innerJoin(
        schema.activeCalculationRuns,
        and(eq(schema.activeCalculationRuns.runId, inputs.runId), activeRunScope(scope))
      )
      .innerJoin(
        results,
        and(
          eq(results.runId, inputs.runId),
          eq(results.dispositionEventId, inputs.eventId),
          eq(results.sourceId, inputs.sourceId)
        )
      )
      .innerJoin(schema.transactionLegs, currentTarget)
      .where(selectedPage)
      .orderBy(asc(results.sequence))
      .pipe(wrapSqlError("transactionListRepository.list.capturedResults"))
    const incomeResults = schema.calculationRunIncomeResults
    const incomeRows = yield* executor
      .select({ targetId: inputs.targetId, runId: inputs.runId, value: incomeResults.value })
      .from(inputs)
      .innerJoin(
        schema.activeCalculationRuns,
        and(eq(schema.activeCalculationRuns.runId, inputs.runId), activeRunScope(scope))
      )
      .innerJoin(
        incomeResults,
        and(
          eq(incomeResults.runId, inputs.runId),
          eq(incomeResults.eventId, inputs.eventId),
          eq(incomeResults.sourceId, inputs.sourceId)
        )
      )
      .innerJoin(schema.transactionLegs, currentTarget)
      .where(selectedPage)
      .pipe(wrapSqlError("transactionListRepository.list.capturedIncome"))
    for (const { targetId, runId, eventId, captured, valuation } of decoded) {
      if (byTarget.has(targetId))
        return yield* new PersistenceError({
          operation: "transactionListRepository.list.captureScope",
          cause: "Multiple active captures describe the same movement period",
        })
      const event = captured.effective.event
      const assetId =
        event?.assetId ?? captured.current.effectiveAssetId ?? captured.current.storedAssetId
      const assetSymbol = symbols.get(assetId)
      if (assetSymbol === undefined)
        return yield* new PersistenceError({
          operation: "transactionListRepository.list.capturedAsset",
          cause: "Captured movement references missing asset metadata",
        })
      const realizedResults = yield* Effect.forEach(
        allocations.filter((row) => row.targetId === targetId && row.runId === runId),
        (row) =>
          Effect.gen(function* () {
            const amount = (value: string) =>
              decodeDecimal({
                operation: "transactionListRepository.list.capturedResultAmount",
                value,
              }).pipe(Effect.map(BigDecimal.format))
            const amounts = yield* Effect.all({
              quantity: amount(row.quantity),
              costBasis: amount(row.costBasis),
              proceeds: amount(row.proceeds),
              gainLoss: amount(row.gainLoss),
            })
            return {
              acquisitionEventId: row.acquisitionEventId,
              ...amounts,
              currency: scope.reportingCurrency,
            }
          })
      )
      const quantity = yield* decodeDecimal({
        operation: "transactionListRepository.list.capturedQuantity",
        value: event?.quantity ?? captured.current.quantity,
      }).pipe(Effect.map(BigDecimal.format))
      const money = ({
        amount,
        currency,
      }: {
        readonly amount: string
        readonly currency: string
      }) =>
        decodeDecimal({
          operation: "transactionListRepository.list.capturedMoney",
          value: amount,
        }).pipe(Effect.map((value) => ({ amount: BigDecimal.format(value), currency })))
      const selectedValue =
        valuation._tag === "selected"
          ? { kind: valuation.kind, ...(yield* money(valuation.total)) }
          : null
      const providerConsiderations = yield* Effect.forEach(
        captured.effective.valuationFacts.flatMap((fact) =>
          fact._tag === "observed_consideration" && fact.eventId === eventId ? [fact.amount] : []
        ),
        money
      )
      const capture: TransactionListMovementCapture = {
        runId,
        eventId,
        outcome: captured.currentOutcome,
        quantity,
        assetId,
        assetSymbol,
        eventKind: event?._tag ?? null,
        cause: event === null || event._tag === "custody_movement" ? null : event.cause,
        valuationState: valuation._tag,
        selectedValue,
        providerConsiderations,
        acquisitionCostBasis: null,
        realizedResults,
      }
      let kind = captured.current.legKind
      if (event?._tag === "disposition") kind = event.cause === "fee" ? "fee" : "disposal"
      if (event?._tag === "acquisition")
        kind = INCOME_CAUSES.has(event.cause) ? "income" : "acquisition"
      const incomeAmounts = yield* Effect.forEach(
        incomeRows.filter((row) => row.targetId === targetId && row.runId === runId),
        (row) =>
          decodeDecimal({
            operation: "transactionListRepository.list.capturedIncomeAmount",
            value: row.value,
          })
      )
      byTarget.set(targetId, {
        recorded: captured,
        movement: { targetId, amount: quantity, assetSymbol, kind, capture },
        income: incomeAmounts.length === 0 ? null : BigDecimal.sumAll(incomeAmounts),
      })
    }
    return byTarget
  })
