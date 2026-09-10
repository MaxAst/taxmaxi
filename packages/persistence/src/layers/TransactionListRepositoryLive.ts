/**
 * TransactionListRepositoryLive - Drizzle-backed principal transaction list.
 *
 * @module TransactionListRepositoryLive
 */

import {
  aliasedTable,
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  inArray,
  gt,
  gte,
  lt,
  or,
  sql,
} from "drizzle-orm"

import * as BigDecimal from "effect/BigDecimal"
import * as Effect from "effect/Effect"
import * as DateTime from "effect/DateTime"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { isPersistenceError, PersistenceError, wrapSqlError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import {
  TransactionListInvalidCursorError,
  TransactionListRepository,
  TransactionListSourceNotFoundError,
  type TransactionFilterCategory,
  type TransactionListItem,
  type TransactionListMovement,
  type TransactionListRepositoryService,
} from "../services/TransactionListRepository.ts"
import { drizzle } from "./PgClientLive.ts"
import {
  activeRunScope,
  attentionPredicate,
  capturedTarget,
  loadCaptures,
  type CalculationReadScope,
} from "./TransactionReadProjection.ts"

interface TransactionReadScope extends CalculationReadScope {
  readonly principalId: string
  readonly sourceIds: ReadonlyArray<string>
  readonly assetIds: ReadonlyArray<string>
  readonly categories: ReadonlyArray<TransactionFilterCategory>
  readonly from: string | null
  readonly to: string | null
  readonly order: "newest" | "oldest"
  readonly attention: boolean
}

interface CursorParts {
  readonly timestamp: Date
  readonly id: string
}

interface GainLossSummary {
  readonly realizedGainLoss: string | null
  readonly fiatCurrency: string | null
  readonly isPartial: boolean
}

interface RunBackedGainLoss {
  readonly byTransactionId: ReadonlyMap<string, GainLossSummary>
  readonly realizedQuantityByEventId: ReadonlyMap<string, BigDecimal.BigDecimal>
}

interface CalculationEventCandidate {
  readonly eventId: string
  readonly taxYear: number
  readonly isCustodyMovement: boolean
}

const eventTaxYear = sql<number>`extract(
  year from (${schema.transactionLegs.timestamp} at time zone 'UTC') at time zone 'Europe/Berlin'
)::integer`

const matchingEventTaxYear = eq(schema.activeCalculationRuns.taxYear, eventTaxYear)

const TransactionCursorPayload = Schema.Struct({
  version: Schema.Literal(5),
  principalId: Schema.String.check(Schema.isUUID()),
  sourceIds: Schema.Array(Schema.String.check(Schema.isUUID())),
  assetIds: Schema.Array(Schema.String.check(Schema.isUUID())),
  categories: Schema.Array(Schema.String),
  from: Schema.NullOr(Schema.String),
  to: Schema.NullOr(Schema.String),
  order: Schema.Literals(["newest", "oldest"]),
  attention: Schema.Boolean,
  timestamp: Schema.DateFromString,
  id: Schema.String.check(Schema.isUUID()),
})

const TransactionCursor = Schema.fromJsonString(TransactionCursorPayload)

const makeCursor = ({
  timestamp,
  id,
  scope,
}: CursorParts & { readonly scope: TransactionReadScope }): string =>
  Schema.encodeSync(TransactionCursor)({ version: 5, timestamp, id, ...scope })

const parseCursor = ({
  cursor,
  scope,
}: {
  readonly cursor: string | null
  readonly scope: TransactionReadScope
}): Effect.Effect<Option.Option<CursorParts>, TransactionListInvalidCursorError> =>
  cursor === null
    ? Effect.succeed(Option.none())
    : Schema.decodeEffect(TransactionCursor)(cursor).pipe(
        Effect.mapError(() => new TransactionListInvalidCursorError({ cursor })),
        Effect.flatMap((payload) =>
          payload.principalId.toLowerCase() === scope.principalId &&
          JSON.stringify(payload.sourceIds) === JSON.stringify(scope.sourceIds) &&
          JSON.stringify(payload.assetIds) === JSON.stringify(scope.assetIds) &&
          JSON.stringify(payload.categories) === JSON.stringify(scope.categories) &&
          payload.from === scope.from &&
          payload.to === scope.to &&
          payload.order === scope.order &&
          payload.attention === scope.attention
            ? Effect.succeed(Option.some({ id: payload.id, timestamp: payload.timestamp }))
            : Effect.fail(new TransactionListInvalidCursorError({ cursor }))
        )
      )

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

const make = Effect.gen(function* () {
  const db = yield* drizzle
  const providerTransactionTable = aliasedTable(schema.transactions, "list_provider_transaction")
  const canonicalTransactionTable = aliasedTable(schema.transactions, "list_canonical_transaction")
  type TransactionListExecutor = Pick<typeof db, "execute" | "select" | "selectDistinct">

  const ownedLeg = (principalId: string) =>
    and(
      eq(schema.transactionLegs.transactionId, schema.transactions.id),
      eq(schema.transactionLegs.principalId, principalId),
      eq(schema.transactions.principalId, principalId),
      eq(schema.transactionLegs.sourceId, schema.transactions.sourceId)
    )

  const inputs = schema.calculationRunMovementInputs

  // Each group matches a transaction through its durable movement targets. Separate
  // EXISTS predicates allow different movements to satisfy different filter groups.
  const capturedMatch = ({
    executor,
    scope,
    predicate,
  }: {
    readonly executor: TransactionListExecutor
    readonly scope: TransactionReadScope
    readonly predicate: ReturnType<typeof sql>
  }) =>
    exists(
      executor
        .select({ targetId: inputs.targetId })
        .from(schema.transactionLegs)
        .innerJoin(
          inputs,
          and(
            eq(inputs.targetId, schema.transactionLegs.movementCorrectionTargetId),
            eq(inputs.sourceId, schema.transactionLegs.sourceId),
            eq(inputs.principalId, scope.principalId)
          )
        )
        .innerJoin(
          schema.activeCalculationRuns,
          and(eq(schema.activeCalculationRuns.runId, inputs.runId), activeRunScope(scope))
        )
        .where(and(ownedLeg(scope.principalId), capturedTarget(scope), predicate))
    )

  const categoryPredicate = (categories: ReadonlyArray<TransactionFilterCategory>) => {
    const causes = [
      ...new Set(
        categories.flatMap((category) =>
          category === "staking" ? ["staking_reward", "passive_staking_reward"] : [category]
        )
      ),
    ]
    const event = sql`${inputs.captured}->'effective'->'event'`
    return sql`(
      ${event}->>'_tag' in ('acquisition', 'disposition', 'custody_movement')
      and ${inputs.captured}->'current'->>'legKind' <> 'fee'
      and coalesce(${event}->>'cause', '') <> 'fee'
      and ${inArray(
        sql<string>`case when ${event}->>'_tag' = 'custody_movement'
        then 'custody_movement' else ${event}->>'cause' end`,
        causes
      )}
    )`
  }

  const ownedScope = (executor: TransactionListExecutor, scope: TransactionReadScope) =>
    and(
      eq(schema.transactions.principalId, scope.principalId),
      eq(schema.sources.principalId, scope.principalId),
      scope.attention ? attentionPredicate(executor, scope) : undefined,
      scope.assetIds.length === 0
        ? undefined
        : capturedMatch({
            executor,
            scope,
            predicate: sql`${inArray(
              sql<string>`coalesce(${inputs.captured}->'effective'->'event'->>'assetId',
          ${inputs.captured}->'current'->>'effectiveAssetId',
          ${inputs.captured}->'current'->>'storedAssetId')`,
              scope.assetIds
            )}`,
          }),
      scope.categories.length === 0
        ? undefined
        : capturedMatch({ executor, scope, predicate: categoryPredicate(scope.categories) }),
      scope.sourceIds.length === 0
        ? undefined
        : inArray(schema.transactions.sourceId, scope.sourceIds),
      scope.from === null
        ? undefined
        : gte(schema.transactions.timestamp, DateTime.toDateUtc(DateTime.makeUnsafe(scope.from))),
      scope.to === null
        ? undefined
        : lt(schema.transactions.timestamp, DateTime.toDateUtc(DateTime.makeUnsafe(scope.to))),
      exists(
        executor
          .select({ id: schema.transactionLegs.id })
          .from(schema.transactionLegs)
          .where(ownedLeg(scope.principalId))
      )
    )

  const loadTotalCount = (executor: TransactionListExecutor, scope: TransactionReadScope) =>
    executor
      .select({ count: count(schema.transactions.id) })
      .from(schema.transactions)
      .innerJoin(schema.sources, eq(schema.transactions.sourceId, schema.sources.id))
      .where(ownedScope(executor, scope))
      .pipe(
        wrapSqlError("transactionListRepository.list.count"),
        Effect.map((rows) => rows[0]?.count ?? 0)
      )

  const loadPageRows = ({
    cursor,
    executor,
    limit,
    scope,
  }: {
    readonly cursor: Option.Option<CursorParts>
    readonly executor: TransactionListExecutor
    readonly limit: number
    readonly scope: TransactionReadScope
  }) => {
    const compare = scope.order === "oldest" ? gt : lt
    const ordering = scope.order === "oldest" ? asc : desc
    const cursorPredicate = Option.match(cursor, {
      onNone: () => undefined,
      onSome: (value) =>
        or(
          compare(schema.transactions.timestamp, value.timestamp),
          and(
            eq(schema.transactions.timestamp, value.timestamp),
            compare(schema.transactions.id, value.id)
          )
        ),
    })
    const predicate = ownedScope(executor, scope)

    return executor
      .select({
        attention: attentionPredicate(executor, scope),
        transactionId: schema.transactions.id,
        timestamp: schema.transactions.timestamp,
        transactionType: schema.transactions.transactionType,
        description: schema.transactions.providerDescription,
        externalId: schema.transactions.externalId,
        sourceId: schema.sources.id,
        sourceName: schema.sources.name,
        sourceKind: schema.sources.sourceableType,
      })
      .from(schema.transactions)
      .innerJoin(schema.sources, eq(schema.transactions.sourceId, schema.sources.id))
      .where(cursorPredicate === undefined ? predicate : and(predicate, cursorPredicate))
      .orderBy(ordering(schema.transactions.timestamp), ordering(schema.transactions.id))
      .limit(limit + 1)
      .pipe(wrapSqlError("transactionListRepository.list.transactions"))
  }

  const loadMovements = ({
    executor,
    principalId,
    transactionIds,
  }: {
    readonly executor: TransactionListExecutor
    readonly principalId: string
    readonly transactionIds: ReadonlyArray<string>
  }) =>
    Effect.gen(function* () {
      if (transactionIds.length === 0) {
        return new Map<string, ReadonlyArray<TransactionListMovement>>()
      }

      const rows = yield* executor
        .select({
          transactionId: schema.transactionLegs.transactionId,
          targetId: schema.transactionLegs.movementCorrectionTargetId,
          amount: schema.transactionLegs.amount,
          assetSymbol: schema.assets.symbol,
          kind: schema.transactionLegs.kind,
        })
        .from(schema.transactionLegs)
        .innerJoin(schema.transactions, ownedLeg(principalId))
        .innerJoin(schema.assets, eq(schema.transactionLegs.assetId, schema.assets.id))
        .where(inArray(schema.transactionLegs.transactionId, transactionIds))
        .orderBy(asc(schema.transactionLegs.timestamp), asc(schema.transactionLegs.id))
        .pipe(wrapSqlError("transactionListRepository.list.movements"))

      const decoded = yield* Effect.forEach(rows, (row) =>
        decodeDecimal({
          operation: "transactionListRepository.list.movementAmount",
          value: row.amount,
        }).pipe(
          Effect.map((amount): readonly [string | null, TransactionListMovement] => [
            row.transactionId,
            {
              targetId: row.targetId,
              capture: null,
              amount: BigDecimal.format(amount),
              assetSymbol: row.assetSymbol,
              kind: row.kind,
            },
          ])
        )
      )
      const byTransaction = new Map<string, Array<TransactionListMovement>>()
      for (const [transactionId, movement] of decoded) {
        if (transactionId === null) continue
        const movements = byTransaction.get(transactionId) ?? []
        movements.push(movement)
        byTransaction.set(transactionId, movements)
      }
      return byTransaction
    })

  const loadGainLoss = ({
    executor,
    scope,
    transactionIds,
  }: {
    readonly executor: TransactionListExecutor
    readonly scope: CalculationReadScope
    readonly transactionIds: ReadonlyArray<string>
  }) =>
    Effect.gen(function* () {
      if (transactionIds.length === 0) {
        return {
          byTransactionId: new Map<string, GainLossSummary>(),
          realizedQuantityByEventId: new Map<string, BigDecimal.BigDecimal>(),
        } satisfies RunBackedGainLoss
      }

      const rows = yield* executor
        .select({
          transactionId: schema.transactionLegs.transactionId,
          dispositionEventId: schema.calculationRunRealizedResults.dispositionEventId,
          gainLoss: schema.calculationRunRealizedResults.gainLoss,
          quantity: schema.calculationRunRealizedResults.quantity,
          fiatCurrency: schema.activeCalculationRuns.reportingCurrency,
        })
        .from(schema.activeCalculationRuns)
        .innerJoin(
          schema.calculationRunRealizedResults,
          eq(schema.activeCalculationRuns.runId, schema.calculationRunRealizedResults.runId)
        )
        .innerJoin(
          schema.transactionLegs,
          and(
            eq(schema.calculationRunRealizedResults.dispositionEventId, schema.transactionLegs.id),
            eq(schema.calculationRunRealizedResults.sourceId, schema.transactionLegs.sourceId)
          )
        )
        .innerJoin(schema.transactions, ownedLeg(scope.principalId))
        .where(
          and(
            activeRunScope(scope),
            matchingEventTaxYear,
            inArray(schema.transactionLegs.transactionId, transactionIds),
            sql`${schema.transactionLegs.derivationRule} is distinct from 'internal_transfer_out'`
          )
        )
        .pipe(wrapSqlError("transactionListRepository.list.gainLoss"))

      const decoded = yield* Effect.forEach(rows, (row) =>
        Effect.all({
          amount: decodeDecimal({
            operation: "transactionListRepository.list.gainLossAmount",
            value: row.gainLoss,
          }),
          quantity: decodeDecimal({
            operation: "transactionListRepository.list.realizedQuantity",
            value: row.quantity,
          }),
        }).pipe(
          Effect.map(({ amount, quantity }) => ({
            transactionId: row.transactionId,
            dispositionEventId: row.dispositionEventId,
            amount,
            quantity,
            fiatCurrency: row.fiatCurrency,
          }))
        )
      )
      const amounts = new Map<string, Array<BigDecimal.BigDecimal>>()
      const currencies = new Map<string, Set<string>>()
      const realizedQuantityByEventId = new Map<string, BigDecimal.BigDecimal>()
      for (const row of decoded) {
        if (row.transactionId === null) continue
        const transactionAmounts = amounts.get(row.transactionId) ?? []
        transactionAmounts.push(row.amount)
        amounts.set(row.transactionId, transactionAmounts)
        const transactionCurrencies = currencies.get(row.transactionId) ?? new Set<string>()
        transactionCurrencies.add(row.fiatCurrency)
        currencies.set(row.transactionId, transactionCurrencies)
        realizedQuantityByEventId.set(
          row.dispositionEventId,
          BigDecimal.sum(
            realizedQuantityByEventId.get(row.dispositionEventId) ?? BigDecimal.fromBigInt(0n),
            row.quantity
          )
        )
      }

      return {
        byTransactionId: new Map(
          transactionIds.map((transactionId): readonly [string, GainLossSummary] => {
            const transactionAmounts = amounts.get(transactionId) ?? []
            const transactionCurrencies = currencies.get(transactionId) ?? new Set<string>()
            const isPartial = transactionAmounts.length > 0 && transactionCurrencies.size !== 1
            return [
              transactionId,
              {
                realizedGainLoss:
                  transactionAmounts.length === 0 || isPartial
                    ? null
                    : BigDecimal.format(BigDecimal.sumAll(transactionAmounts)),
                fiatCurrency:
                  transactionCurrencies.size === 1
                    ? (transactionCurrencies.values().next().value ?? null)
                    : null,
                isPartial,
              },
            ]
          })
        ),
        realizedQuantityByEventId,
      } satisfies RunBackedGainLoss
    })

  const loadReviewStates = ({
    executor,
    principalId,
    transactionIds,
  }: {
    readonly executor: TransactionListExecutor
    readonly principalId: string
    readonly transactionIds: ReadonlyArray<string>
  }) =>
    transactionIds.length === 0
      ? Effect.succeed(new Map<string, boolean>())
      : executor
          .select({
            transactionId: schema.transactionReviews.transactionId,
            needsReview: schema.transactionReviews.needsReview,
          })
          .from(schema.transactionReviews)
          .where(
            and(
              eq(schema.transactionReviews.principalId, principalId),
              inArray(schema.transactionReviews.transactionId, transactionIds)
            )
          )
          .pipe(
            wrapSqlError("transactionListRepository.list.reviews"),
            Effect.map(
              (rows) => new Map(rows.map((row) => [row.transactionId, row.needsReview] as const))
            )
          )

  const loadPageReconciliations = ({
    executor,
    principalId,
    sourceTransferIds,
    transactionIds,
  }: {
    readonly executor: TransactionListExecutor
    readonly principalId: string
    readonly sourceTransferIds: ReadonlyArray<string>
    readonly transactionIds: ReadonlyArray<string>
  }) => {
    const pageScope =
      sourceTransferIds.length === 0
        ? inArray(providerTransactionTable.id, transactionIds)
        : or(
            inArray(providerTransactionTable.id, transactionIds),
            inArray(schema.transferReconciliations.canonicalTransferId, sourceTransferIds)
          )

    return executor
      .select({
        id: schema.transferReconciliations.id,
        providerTransactionId: providerTransactionTable.id,
        canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
        taxYear: sql<number>`extract(
          year from (${canonicalTransactionTable.timestamp} at time zone 'UTC')
            at time zone 'Europe/Berlin'
        )::integer`,
      })
      .from(schema.transferReconciliations)
      .innerJoin(
        schema.providerTransfers,
        eq(schema.transferReconciliations.providerTransferId, schema.providerTransfers.id)
      )
      .innerJoin(
        providerTransactionTable,
        and(
          eq(schema.providerTransfers.transactionId, providerTransactionTable.id),
          eq(schema.providerTransfers.sourceId, providerTransactionTable.sourceId)
        )
      )
      .innerJoin(
        schema.inventoryMovements,
        and(
          eq(schema.inventoryMovements.providerTransferId, schema.providerTransfers.id),
          eq(schema.inventoryMovements.transactionId, providerTransactionTable.id),
          eq(schema.inventoryMovements.sourceId, schema.providerTransfers.sourceId)
        )
      )
      .innerJoin(
        schema.transfers,
        eq(schema.transferReconciliations.canonicalTransferId, schema.transfers.id)
      )
      .innerJoin(
        canonicalTransactionTable,
        and(
          eq(schema.transferReconciliations.canonicalTransactionId, canonicalTransactionTable.id),
          eq(schema.transfers.sourceId, canonicalTransactionTable.sourceId)
        )
      )
      .where(
        and(
          eq(schema.transferReconciliations.principalId, principalId),
          eq(schema.inventoryMovements.principalId, principalId),
          eq(providerTransactionTable.principalId, principalId),
          eq(canonicalTransactionTable.principalId, principalId),
          eq(schema.transfers.principalId, principalId),
          eq(schema.inventoryMovements.purpose, "principal"),
          eq(schema.inventoryMovements.reconciliationStatus, "matched"),
          or(
            eq(schema.transferReconciliations.status, "approved"),
            and(
              eq(schema.transferReconciliations.status, "auto_applied"),
              eq(schema.transferReconciliations.deterministic, true)
            )
          ),
          pageScope
        )
      )
      .pipe(wrapSqlError("transactionListRepository.list.pageReconciliations"))
  }

  const loadProcessedEventKeys = ({
    candidates,
    executor,
    scope,
  }: {
    readonly candidates: ReadonlyArray<CalculationEventCandidate>
    readonly executor: TransactionListExecutor
    readonly scope: CalculationReadScope
  }) => {
    const eventIds = [...new Set(candidates.map(({ eventId }) => eventId))]
    const taxYears = [...new Set(candidates.map(({ taxYear }) => taxYear))]
    if (eventIds.length === 0 || taxYears.length === 0) {
      return Effect.succeed(new Set<string>())
    }

    return executor
      .select({
        taxYear: schema.activeCalculationRuns.taxYear,
        eventIds: sql<ReadonlyArray<string>>`array(
          select page_candidate.event_id
          from unnest(array[${sql.join(
            eventIds.map((eventId) => sql`${eventId}`),
            sql`, `
          )}]::text[])
            as page_candidate(event_id)
          where ${schema.calculationRuns.processedEventIds} ? page_candidate.event_id
        )`,
      })
      .from(schema.activeCalculationRuns)
      .innerJoin(
        schema.calculationRuns,
        eq(schema.activeCalculationRuns.runId, schema.calculationRuns.id)
      )
      .where(and(activeRunScope(scope), inArray(schema.activeCalculationRuns.taxYear, taxYears)))
      .pipe(
        wrapSqlError("transactionListRepository.list.processedPageEvents"),
        Effect.map(
          (rows) =>
            new Set(
              rows.flatMap(({ eventIds: processedEventIds, taxYear }) =>
                processedEventIds.map((eventId) => `${taxYear}:${eventId}`)
              )
            )
        )
      )
  }

  const loadBlockedEventKeys = ({
    candidates,
    executor,
    scope,
  }: {
    readonly candidates: ReadonlyArray<CalculationEventCandidate>
    readonly executor: TransactionListExecutor
    readonly scope: CalculationReadScope
  }) => {
    const eventIds = [...new Set(candidates.map(({ eventId }) => eventId))]
    const taxYears = [...new Set(candidates.map(({ taxYear }) => taxYear))]
    if (eventIds.length === 0 || taxYears.length === 0) {
      return Effect.succeed(new Set<string>())
    }

    return executor
      .select({
        eventId: schema.calculationRunBlockers.eventId,
        taxYear: schema.activeCalculationRuns.taxYear,
      })
      .from(schema.activeCalculationRuns)
      .innerJoin(
        schema.calculationRunBlockers,
        eq(schema.activeCalculationRuns.runId, schema.calculationRunBlockers.runId)
      )
      .where(
        and(
          activeRunScope(scope),
          inArray(schema.activeCalculationRuns.taxYear, taxYears),
          inArray(schema.calculationRunBlockers.eventId, eventIds)
        )
      )
      .pipe(
        wrapSqlError("transactionListRepository.list.blockedPageEvents"),
        Effect.map((rows) => new Set(rows.map(({ eventId, taxYear }) => `${taxYear}:${eventId}`)))
      )
  }

  const loadPartialTransactionIds = ({
    executor,
    scope,
    transactionIds,
    realizedQuantityByEventId,
  }: {
    readonly executor: TransactionListExecutor
    readonly scope: CalculationReadScope
    readonly transactionIds: ReadonlyArray<string>
    readonly realizedQuantityByEventId: ReadonlyMap<string, BigDecimal.BigDecimal>
  }) =>
    Effect.gen(function* () {
      if (transactionIds.length === 0) {
        return new Set<string>()
      }

      const rows = yield* executor
        .select({
          eventId: schema.transactionLegs.id,
          transactionId: schema.transactionLegs.transactionId,
          amount: schema.transactionLegs.amount,
          kind: schema.transactionLegs.kind,
          derivationRule: schema.transactionLegs.derivationRule,
          sourceTransferId: schema.transactionLegs.sourceTransferId,
          taxYear: eventTaxYear,
        })
        .from(schema.transactionLegs)
        .innerJoin(schema.transactions, ownedLeg(scope.principalId))
        .where(inArray(schema.transactionLegs.transactionId, transactionIds))
        .pipe(wrapSqlError("transactionListRepository.list.calculationStateEvents"))

      const sourceTransferIds = rows.flatMap(({ sourceTransferId }) =>
        sourceTransferId === null ? [] : [sourceTransferId]
      )
      const reconciliations = yield* loadPageReconciliations({
        executor,
        principalId: scope.principalId,
        sourceTransferIds,
        transactionIds,
      })
      const reconciliationsByProviderTransaction = new Map<
        string,
        Array<CalculationEventCandidate>
      >()
      const reconciliationsByCanonicalTransfer = new Map<string, Array<CalculationEventCandidate>>()
      for (const reconciliation of reconciliations) {
        const candidate = {
          eventId: reconciliation.id,
          taxYear: reconciliation.taxYear,
          isCustodyMovement: true,
        } satisfies CalculationEventCandidate
        const providerCandidates =
          reconciliationsByProviderTransaction.get(reconciliation.providerTransactionId) ?? []
        providerCandidates.push(candidate)
        reconciliationsByProviderTransaction.set(
          reconciliation.providerTransactionId,
          providerCandidates
        )
        if (reconciliation.canonicalTransferId !== null) {
          const canonicalCandidates =
            reconciliationsByCanonicalTransfer.get(reconciliation.canonicalTransferId) ?? []
          canonicalCandidates.push(candidate)
          reconciliationsByCanonicalTransfer.set(
            reconciliation.canonicalTransferId,
            canonicalCandidates
          )
        }
      }

      const candidatesByEventId = new Map<string, ReadonlyArray<CalculationEventCandidate>>()
      for (const row of rows) {
        const reconciledCandidates =
          row.kind === "fee"
            ? undefined
            : row.sourceTransferId === null
              ? row.transactionId === null
                ? undefined
                : reconciliationsByProviderTransaction.get(row.transactionId)
              : reconciliationsByCanonicalTransfer.get(row.sourceTransferId)
        candidatesByEventId.set(
          row.eventId,
          reconciledCandidates ?? [
            { eventId: row.eventId, taxYear: row.taxYear, isCustodyMovement: false },
          ]
        )
      }
      const candidates = [...candidatesByEventId.values()].flat()
      const [processedEventKeys, blockedEventKeys] = yield* Effect.all([
        loadProcessedEventKeys({
          candidates,
          executor,
          scope,
        }),
        loadBlockedEventKeys({
          candidates,
          executor,
          scope,
        }),
      ])

      const partialTransactionIds = new Set<string>()
      for (const row of rows) {
        if (row.transactionId === null) continue
        if (
          row.derivationRule === "internal_transfer_in" ||
          row.derivationRule === "internal_transfer_out"
        ) {
          continue
        }
        const eventCandidates = candidatesByEventId.get(row.eventId) ?? []
        const isReconciled = eventCandidates.some(({ isCustodyMovement }) => isCustodyMovement)
        const isProcessed = eventCandidates.every(({ eventId, taxYear }) =>
          processedEventKeys.has(`${taxYear}:${eventId}`)
        )
        const isBlocked = eventCandidates.some(({ eventId, taxYear }) =>
          blockedEventKeys.has(`${taxYear}:${eventId}`)
        )
        if (!isProcessed || isBlocked) {
          partialTransactionIds.add(row.transactionId)
          continue
        }
        if (isReconciled) continue
        if (row.kind !== "disposal" && row.kind !== "fee") continue

        const disposedQuantity = yield* decodeDecimal({
          operation: "transactionListRepository.list.disposedQuantity",
          value: row.amount,
        })
        const realizedQuantity =
          realizedQuantityByEventId.get(row.eventId) ?? BigDecimal.fromBigInt(0n)
        if (!BigDecimal.equals(disposedQuantity, realizedQuantity)) {
          partialTransactionIds.add(row.transactionId)
        }
      }

      return partialTransactionIds
    })

  const list: TransactionListRepositoryService["list"] = (params) =>
    Effect.gen(function* () {
      const scope: TransactionReadScope = {
        principalId: params.principalId.toLowerCase(),
        jurisdiction: params.jurisdiction,
        reportingCurrency: params.reportingCurrency,
        attention: params.attention ?? false,
        sourceIds: [...new Set(params.sourceIds.map((id) => id.toLowerCase()))].sort(),
        assetIds: [...new Set((params.assetIds ?? []).map((id) => id.toLowerCase()))].sort(),
        categories: [...new Set(params.categories ?? [])].sort(),
        from: params.from?.toISOString() ?? null,
        to: params.to?.toISOString() ?? null,
        order: params.order ?? "newest",
      }
      const cursor = yield* parseCursor({ cursor: params.cursor, scope })
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.execute(sql`set transaction isolation level repeatable read`)
            if (scope.sourceIds.length > 0) {
              const sources = yield* tx
                .select({ id: schema.sources.id })
                .from(schema.sources)
                .where(
                  and(
                    inArray(schema.sources.id, scope.sourceIds),
                    eq(schema.sources.principalId, scope.principalId)
                  )
                )
                .pipe(wrapSqlError("transactionListRepository.list.source"))
              const ownedIds = new Set(sources.map((source) => source.id))
              const missingId = scope.sourceIds.find((id) => !ownedIds.has(id))
              if (missingId !== undefined) {
                return yield* new TransactionListSourceNotFoundError({ sourceId: missingId })
              }
            }
            const totalCount = yield* loadTotalCount(tx, scope)
            const rows = yield* loadPageRows({
              cursor,
              executor: tx,
              limit: params.limit,
              scope,
            })
            const pageRows = rows.slice(0, params.limit)
            const transactionIds = pageRows.map((row) => row.transactionId)
            const calculationScope = {
              principalId: params.principalId,
              jurisdiction: params.jurisdiction,
              reportingCurrency: params.reportingCurrency,
            } satisfies CalculationReadScope
            const [movements, gainLoss, reviewStates, captures] = yield* Effect.all(
              [
                loadMovements({ executor: tx, principalId: scope.principalId, transactionIds }),
                loadGainLoss({ executor: tx, scope: calculationScope, transactionIds }),
                loadReviewStates({ executor: tx, principalId: scope.principalId, transactionIds }),
                loadCaptures({
                  executor: tx,
                  scope: calculationScope,
                  selection: { kind: "transactions", ids: transactionIds },
                }),
              ],
              { concurrency: 1 }
            )
            const partialTransactionIds = yield* loadPartialTransactionIds({
              executor: tx,
              scope: calculationScope,
              transactionIds,
              realizedQuantityByEventId: gainLoss.realizedQuantityByEventId,
            })

            const items = pageRows.map((row): TransactionListItem => {
              const totals = gainLoss.byTransactionId.get(row.transactionId)
              const isPartial =
                partialTransactionIds.has(row.transactionId) || totals?.isPartial === true
              const capturedMovements = (movements.get(row.transactionId) ?? []).flatMap(
                (movement) => {
                  const projection = captures.get(movement.targetId)
                  return projection === undefined ? [] : [projection]
                }
              )
              const captureResults = capturedMovements.flatMap(
                (projection) => projection.movement.capture.realizedResults
              )
              const capturedGain =
                captureResults.length === 0
                  ? null
                  : BigDecimal.format(
                      BigDecimal.sumAll(
                        captureResults.map((result) => BigDecimal.fromStringUnsafe(result.gainLoss))
                      )
                    )
              const incomeAmounts = capturedMovements.flatMap((projection) =>
                projection.income === null ? [] : [projection.income]
              )
              const incomeAmount =
                incomeAmounts.length === 0
                  ? null
                  : BigDecimal.format(BigDecimal.sumAll(incomeAmounts))
              return {
                transactionId: row.transactionId,
                timestamp: row.timestamp.toISOString(),
                source: {
                  sourceId: row.sourceId,
                  name: row.sourceName,
                  kind: row.sourceKind,
                },
                transactionType: row.transactionType,
                description: row.description,
                externalId: row.externalId,
                movements: (movements.get(row.transactionId) ?? []).map(
                  (movement) => captures.get(movement.targetId)?.movement ?? movement
                ),
                income: incomeAmount,
                realizedGainLoss: capturedGain,
                fiatCurrency:
                  capturedGain === null && incomeAmount === null
                    ? null
                    : calculationScope.reportingCurrency,
                calculationState: isPartial ? "partial" : "complete",
                needsReview: reviewStates.get(row.transactionId) ?? false,
                attention: row.attention,
              }
            })
            const hasMore = rows.length > params.limit
            const last = pageRows.at(-1)

            return {
              items,
              hasMore,
              nextCursor:
                hasMore && last !== undefined
                  ? makeCursor({ timestamp: last.timestamp, id: last.transactionId, scope })
                  : null,
              totalCount,
            }
          })
        )
        .pipe(
          Effect.mapError((cause) =>
            isPersistenceError(cause) || Schema.is(TransactionListSourceNotFoundError)(cause)
              ? cause
              : new PersistenceError({
                  operation: "transactionListRepository.list.snapshot",
                  cause,
                })
          )
        )
    })

  const filterChoices: TransactionListRepositoryService["filterChoices"] = (scope) => {
    // A scalar completed capture makes the selected identity identical to row projection.
    // Uncaptured historical legs remain selectable without claiming calculated facts exist.
    const completedAsset = db
      .select({
        assetId: sql<string>`coalesce(
      ${inputs.captured}->'effective'->'event'->>'assetId',
      ${inputs.captured}->'current'->>'effectiveAssetId',
      ${inputs.captured}->'current'->>'storedAssetId'
    )::uuid`,
      })
      .from(inputs)
      .innerJoin(
        schema.activeCalculationRuns,
        and(eq(schema.activeCalculationRuns.runId, inputs.runId), activeRunScope(scope))
      )
      .where(capturedTarget(scope))
    return db
      .selectDistinct({
        assetId: schema.assets.id,
        symbol: schema.assets.symbol,
        name: schema.assets.name,
        type: schema.assets.type,
        coingeckoCoinId: schema.assets.coingeckoCoinId,
        logoUrl: schema.assets.logoUrl,
      })
      .from(schema.transactionLegs)
      .innerJoin(schema.transactions, ownedLeg(scope.principalId))
      .innerJoin(
        schema.sources,
        and(
          eq(schema.sources.id, schema.transactions.sourceId),
          eq(schema.sources.principalId, scope.principalId)
        )
      )
      .innerJoin(
        schema.assets,
        eq(schema.assets.id, sql`coalesce((${completedAsset}), ${schema.transactionLegs.assetId})`)
      )
      .orderBy(asc(schema.assets.symbol), asc(schema.assets.name), asc(schema.assets.id))
      .pipe(
        wrapSqlError("transactionListRepository.filterChoices"),
        Effect.map((assets) => ({ assets }))
      )
  }

  return TransactionListRepository.of({ list, filterChoices })
})

/** Live PostgreSQL implementation of the canonical transaction list. */
export const TransactionListRepositoryLive = Layer.effect(TransactionListRepository, make)
