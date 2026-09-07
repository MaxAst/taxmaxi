/** Read-only transaction detail through recorded movement and evidence links.
 * @module TransactionDetailRepositoryLive
 */
import {
  AccountingEvent,
  MovementCorrectionFacts,
  MovementCorrectionInput,
  MovementCorrectionKind,
  ObservedConsiderationFact,
  MarketQuoteFact,
  ValuationFact,
} from "@my/core/accounting"
import { PrincipalAssetOverrideTarget } from "@my/core/assets"
import { CurrencyCode } from "@my/core/currency"
import * as BigDecimal from "effect/BigDecimal"
import { and, asc, eq, exists, inArray, ne, or, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { UnsupportedJurisdictionError } from "@my/accounting"
import * as Schema from "effect/Schema"
import { isPersistenceError, PersistenceError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import { PrincipalAssetOverrideRepository } from "../services/PrincipalAssetOverrideRepository.ts"
import { PrincipalAssetOverrideRepositoryLive } from "./PrincipalAssetOverrideRepositoryLive.ts"
import {
  PrincipalTransactionOverrideRepository,
  type PrincipalTransactionOverrideProjection,
} from "../services/PrincipalTransactionOverrideRepository.ts"
import {
  TransactionDetailRepository,
  type TransactionDetailRepositoryService,
  type TransactionDetailEvidenceLink,
  type TransactionDetailCalculation,
  type TransactionDetailMovement,
} from "../services/TransactionDetailRepository.ts"
import { PrincipalTransactionOverrideRepositoryLive } from "./PrincipalTransactionOverrideRepositoryLive.ts"
import { drizzle } from "./PgClientLive.ts"

const Uuid = Schema.String.check(Schema.isUUID())

const IsoDate = Schema.toEncoded(Schema.DateTimeUtcFromString)

const NullableText = Schema.NullOr(Schema.String)

const Application = Schema.Literals(["inactive", "not_applied", "applied", "needs_attention"])

const ApplicationProblem = Schema.NullOr(
  Schema.Literals([
    "target_unavailable",
    "target_ineligible",
    "target_changed",
    "quantity_changed",
    "asset_changed",
    "structure_changed",
    "reporting_currency_mismatch",
  ])
)

const ResolvedPrice = Schema.NullOr(
  Schema.Struct({
    totalValue: Schema.String,
    unitPrice: Schema.Struct({ amount: Schema.String, rounded: Schema.Boolean }),
    currency: CurrencyCode,
  })
)

const SystemEvidence = Schema.Struct({
  occurredAt: IsoDate,
  legKind: Schema.Literals(["acquisition", "disposal", "income", "fee"]),
  recordedFiatAmount: NullableText,
  recordedFiatCurrency: NullableText,
  transactionType: NullableText,
  providerTransactionType: NullableText,
  derivationRule: NullableText,
  feeForSourceRecordKey: NullableText,
})

const ValuationEvidence = Schema.Struct({
  reportingCurrency: CurrencyCode,
  facts: Schema.Array(
    Schema.Union([Schema.toEncoded(ObservedConsiderationFact), Schema.toEncoded(MarketQuoteFact)])
  ),
})

/** Immutable accepted facts and original evidence, independently of current conclusions. */

const TransactionOverrideHistoryRecord = Schema.Struct({
  id: Uuid,
  principalId: Uuid,
  sourceId: Uuid,
  targetId: Uuid,
  kind: MovementCorrectionKind,
  operation: Schema.Literals(["create", "replace", "withdraw"]),
  inspectedFacts: Schema.toEncoded(MovementCorrectionFacts),
  inspectedSystem: SystemEvidence,
  inspectedValuationEvidence: ValuationEvidence,
  input: Schema.NullOr(MovementCorrectionInput),
  actorUserId: Uuid,
  reason: Schema.String,
  supersedesOverrideId: Schema.NullOr(Uuid),
  recordedAt: IsoDate,
})

const EngineInputs = Schema.Struct({
  event: Schema.NullOr(Schema.toEncoded(AccountingEvent)),
  valuationFacts: Schema.Array(Schema.toEncoded(ValuationFact)),
  classificationEvidence: Schema.optionalKey(
    Schema.TaggedStruct("user_assertion", { overrideId: Uuid })
  ),
})

const CustodyContext = Schema.Struct({
  reconciliationId: Uuid,
  canonicalTransferId: Uuid,
  providerTransferId: Uuid,
  canonicalTransactionId: Schema.NullOr(Uuid),
  providerTransactionId: Uuid,
  canonicalSourceId: Uuid,
  providerSourceId: Uuid,
  occurredAt: IsoDate,
  quantity: Schema.String,
  canonicalStoredAssetId: Uuid,
  providerStoredAssetId: Uuid,
  providerDirection: Schema.Literals(["inbound", "outbound"]),
  outcome: Schema.Literals(["included", "withheld", "outside_period"]),
})

const LegContext = Schema.Struct({
  targetId: Uuid,
  legId: Uuid,
  sourceId: Uuid,
  transactionId: Schema.NullOr(Uuid),
  occurredAt: IsoDate,
  quantity: Schema.String,
  storedAssetId: Uuid,
  effectiveAssetId: Schema.NullOr(Uuid),
  direction: Schema.Literals(["inbound", "outbound"]),
  structure: Schema.Literals(["ownership_change", "fee", "custody"]),
  legKind: Schema.Literals(["acquisition", "income", "disposal", "fee"]),
  transactionType: NullableText,
  providerTransactionType: NullableText,
  recordedFiatAmount: NullableText,
  recordedFiatCurrency: NullableText,
  providerFiatAmount: NullableText,
  providerFiatCurrency: NullableText,
  derivationRule: NullableText,
  feeForSourceRecordKey: NullableText,
  originKind: Schema.Literals(["none", "canonical_transfer", "provider_transfer"]),
  sourceTransferId: Schema.NullOr(Uuid),
  providerTransferId: Schema.NullOr(Uuid),
  custody: Schema.Array(CustodyContext),
})

const CurrentOutcome = Schema.Literals(["included", "withheld", "absent", "outside_period"])

const ApplicationFields = {
  application: Application,
  applicationProblem: ApplicationProblem,
  resolvedPrice: ResolvedPrice,
  system: EngineInputs,
  effective: EngineInputs,
}

const CapturedInput = Schema.Struct({
  history: TransactionOverrideHistoryRecord,
  current: Schema.NullOr(LegContext),
  currentOutcome: CurrentOutcome,
  streamState: Schema.Literals(["active", "withdrawn", "superseded"]),
  reportingCurrency: CurrencyCode,
  ...ApplicationFields,
})

const exactDecimal = (value: string) =>
  Schema.decodeEffect(Schema.BigDecimalFromString)(value).pipe(Effect.map(BigDecimal.format))
const exactNullable = (value: string | null) =>
  value === null ? Effect.succeed(null) : exactDecimal(value)

const safeRawEvidence = {
  sourceId: schema.sourceRecordsRaw.sourceId,
  id: schema.sourceRecordsRaw.id,
  provider: schema.sourceRecordsRaw.provider,
  recordType: schema.sourceRecordsRaw.recordType,
  externalRecordId: schema.sourceRecordsRaw.externalRecordId,
  occurredAt: schema.sourceRecordsRaw.occurredAt,
  importedAt: schema.sourceRecordsRaw.importedAt,
}

const evidenceLink = (
  link: Omit<TransactionDetailEvidenceLink, "status">
): TransactionDetailEvidenceLink => ({
  ...link,
  status: link.evidence === null ? "unavailable" : "available",
})

const make = Effect.gen(function* () {
  const db = yield* drizzle
  const targets = yield* PrincipalTransactionOverrideRepository
  const assets = yield* PrincipalAssetOverrideRepository
  const readAssetOverrides = ({
    executor,
    movements,
    principalId,
  }: {
    readonly executor: Pick<typeof db, "select">
    readonly movements: ReadonlyArray<
      Pick<
        TransactionDetailMovement,
        "id" | "sourceId" | "sourceRepresentationUseId" | "providerAssetRowId"
      >
    >
    readonly principalId: Parameters<TransactionDetailRepositoryService["find"]>[0]["principalId"]
  }) =>
    Effect.forEach(movements, (movement) =>
      Effect.gen(function* () {
        const [representation] =
          movement.sourceRepresentationUseId === null
            ? []
            : yield* executor
                .select({
                  blockchain: schema.blockchains.name,
                  type: schema.sourceRepresentationUses.representationType,
                  contractAddress: schema.sourceRepresentationUses.contractAddress,
                  mintAddress: schema.sourceRepresentationUses.mintAddress,
                })
                .from(schema.sourceRepresentationUses)
                .innerJoin(
                  schema.blockchains,
                  eq(schema.blockchains.id, schema.sourceRepresentationUses.blockchainId)
                )
                .where(
                  and(
                    eq(schema.sourceRepresentationUses.id, movement.sourceRepresentationUseId),
                    eq(schema.sourceRepresentationUses.sourceId, movement.sourceId)
                  )
                )
        // An unavailable exact link must not silently become a provider fallback.
        const target =
          representation !== undefined
            ? yield* Schema.decodeEffect(PrincipalAssetOverrideTarget)({
                _tag: "representation",
                ...representation,
              })
            : movement.sourceRepresentationUseId === null && movement.providerAssetRowId !== null
              ? yield* Schema.decodeEffect(PrincipalAssetOverrideTarget)({
                  _tag: "provider_asset",
                  providerAssetRowId: movement.providerAssetRowId,
                })
              : null
        const projection =
          target === null ? Option.none() : yield* assets.findProjection({ principalId, target })
        return { movementId: movement.id, projection: Option.getOrNull(projection) }
      })
    )
  const readCalculation = ({
    executor,
    params,
    movementIds,
    movementOverrides,
    targetIds,
  }: {
    readonly executor: Pick<typeof db, "select">
    readonly params: Parameters<TransactionDetailRepositoryService["find"]>[0]
    readonly movementIds: ReadonlyArray<string>
    readonly movementOverrides: ReadonlyArray<PrincipalTransactionOverrideProjection>
    readonly targetIds: ReadonlyArray<string>
  }) =>
    Effect.gen(function* () {
      const [selectedRun] = yield* executor
        .select({
          id: schema.calculationRuns.id,
          jurisdiction: schema.calculationRuns.jurisdiction,
          taxYear: schema.calculationRuns.taxYear,
          reportingCurrency: schema.calculationRuns.reportingCurrency,
          status: schema.calculationRuns.status,
          engineVersion: schema.calculationRuns.engineVersion,
          ruleSetVersion: schema.calculationRuns.ruleSetVersion,
          inputLedgerRevision: schema.calculationRuns.inputLedgerRevision,
          valuationRevision: schema.calculationRuns.valuationRevision,
          failureCode: schema.calculationRuns.failureCode,
          processedEventIds: schema.calculationRuns.processedEventIds,
        })
        .from(schema.activeCalculationRuns)
        .innerJoin(
          schema.calculationRuns,
          and(
            eq(schema.calculationRuns.id, schema.activeCalculationRuns.runId),
            eq(schema.calculationRuns.principalId, params.principalId)
          )
        )
        .where(
          and(
            eq(schema.activeCalculationRuns.principalId, params.principalId),
            eq(schema.activeCalculationRuns.jurisdiction, params.scope.jurisdiction),
            eq(schema.activeCalculationRuns.taxYear, params.scope.taxYear),
            eq(schema.activeCalculationRuns.reportingCurrency, params.scope.reportingCurrency)
          )
        )
      if (selectedRun === undefined)
        return {
          run: null,
          state: "partial",
          monetaryStatus: "unavailable",
          derivedLots: [],
          allocations: [],
          income: [],
          blockers: [],
          processedEventIds: [],
          correctionInputs: [],
        } satisfies TransactionDetailCalculation
      const { processedEventIds: storedProcessedIds, ...run } = selectedRun
      const processedIds = yield* Schema.decodeEffect(Schema.Array(Schema.String))(
        storedProcessedIds
      )
      // The current factual projection records custody event links as well as leg events.
      const eventIds = [
        ...new Set([
          ...movementIds,
          ...movementOverrides.flatMap(
            (projection) =>
              projection.inputs.current?.custody.map((custody) => custody.reconciliationId) ?? []
          ),
        ]),
      ]
      const allocations = yield* executor
        .select({
          sequence: schema.calculationRunAllocations.sequence,
          acquisitionEventId: schema.calculationRunAllocations.acquisitionEventId,
          dispositionEventId: schema.calculationRunAllocations.dispositionEventId,
          assetId: schema.calculationRunAllocations.assetId,
          custodyUnitId: schema.calculationRunAllocations.custodyUnitId,
          acquiredAt: schema.calculationRunAllocations.acquiredAt,
          disposedAt: schema.calculationRunAllocations.disposedAt,
          quantity: schema.calculationRunAllocations.quantity,
          costBasis: schema.calculationRunAllocations.costBasis,
          proceeds: schema.calculationRunRealizedResults.proceeds,
          gainLoss: schema.calculationRunRealizedResults.gainLoss,
          treatmentCodes: schema.calculationRunRealizedResults.treatmentCodes,
        })
        .from(schema.calculationRunAllocations)
        .leftJoin(
          schema.calculationRunRealizedResults,
          and(
            eq(schema.calculationRunRealizedResults.runId, run.id),
            eq(
              schema.calculationRunRealizedResults.allocationSequence,
              schema.calculationRunAllocations.sequence
            )
          )
        )
        .where(
          and(
            eq(schema.calculationRunAllocations.runId, run.id),
            eq(schema.calculationRunAllocations.principalId, params.principalId),
            or(
              inArray(schema.calculationRunAllocations.dispositionEventId, eventIds),
              inArray(schema.calculationRunAllocations.acquisitionEventId, eventIds)
            )
          )
        )
        .orderBy(asc(schema.calculationRunAllocations.sequence))
      const derivedLots = yield* executor
        .select({
          sequence: schema.calculationRunDerivedLots.sequence,
          acquisitionEventId: schema.calculationRunDerivedLots.acquisitionEventId,
          assetId: schema.calculationRunDerivedLots.assetId,
          custodyUnitId: schema.calculationRunDerivedLots.custodyUnitId,
          acquiredAt: schema.calculationRunDerivedLots.acquiredAt,
          remainingQuantity: schema.calculationRunDerivedLots.remainingQuantity,
          costBasisPerUnit: schema.calculationRunDerivedLots.costBasisPerUnit,
        })
        .from(schema.calculationRunDerivedLots)
        .where(
          and(
            eq(schema.calculationRunDerivedLots.runId, run.id),
            eq(schema.calculationRunDerivedLots.principalId, params.principalId),
            inArray(schema.calculationRunDerivedLots.acquisitionEventId, eventIds)
          )
        )
        .orderBy(asc(schema.calculationRunDerivedLots.sequence))
      const income = yield* executor
        .select({
          sequence: schema.calculationRunIncomeResults.sequence,
          sourceId: schema.calculationRunIncomeResults.sourceId,
          eventId: schema.calculationRunIncomeResults.eventId,
          assetId: schema.calculationRunIncomeResults.assetId,
          occurredAt: schema.calculationRunIncomeResults.occurredAt,
          quantity: schema.calculationRunIncomeResults.quantity,
          value: schema.calculationRunIncomeResults.value,
          treatmentCodes: schema.calculationRunIncomeResults.treatmentCodes,
        })
        .from(schema.calculationRunIncomeResults)
        .where(
          and(
            eq(schema.calculationRunIncomeResults.runId, run.id),
            inArray(schema.calculationRunIncomeResults.eventId, eventIds)
          )
        )
        .orderBy(asc(schema.calculationRunIncomeResults.sequence))
      const linkedEventIds = [
        ...new Set([
          ...eventIds,
          ...allocations.flatMap((allocation) => [
            allocation.acquisitionEventId,
            allocation.dispositionEventId,
          ]),
        ]),
      ]
      const blockers = yield* executor
        .select({
          sequence: schema.calculationRunBlockers.sequence,
          eventId: schema.calculationRunBlockers.eventId,
          code: schema.calculationRunBlockers.code,
          assetId: schema.calculationRunBlockers.assetId,
          providerAssetRowId: schema.calculationRunBlockers.providerAssetRowId,
          custodyUnitId: schema.calculationRunBlockers.custodyUnitId,
          missingQuantity: schema.calculationRunBlockers.missingQuantity,
        })
        .from(schema.calculationRunBlockers)
        .where(
          and(
            eq(schema.calculationRunBlockers.runId, run.id),
            eq(schema.calculationRunBlockers.principalId, params.principalId),
            inArray(schema.calculationRunBlockers.eventId, linkedEventIds)
          )
        )
        .orderBy(asc(schema.calculationRunBlockers.sequence))
      const capturedRows = yield* executor
        .select({ captured: schema.calculationRunCorrectionInputs.captured })
        .from(schema.calculationRunCorrectionInputs)
        .where(
          and(
            eq(schema.calculationRunCorrectionInputs.runId, run.id),
            eq(schema.calculationRunCorrectionInputs.principalId, params.principalId),
            or(
              inArray(schema.calculationRunCorrectionInputs.targetId, targetIds),
              inArray(
                sql<string>`${schema.calculationRunCorrectionInputs.captured}->'effective'->'event'->>'id'`,
                linkedEventIds
              )
            )
          )
        )
        .orderBy(asc(schema.calculationRunCorrectionInputs.overrideId))
      const correctionInputs = yield* Effect.forEach(capturedRows, (row) =>
        Schema.decodeEffect(CapturedInput)(row.captured)
      )
      const exactAllocations = yield* Effect.forEach(allocations, (row) =>
        Effect.gen(function* () {
          return {
            ...row,
            quantity: yield* exactDecimal(row.quantity),
            costBasis: yield* exactNullable(row.costBasis),
            proceeds: yield* exactNullable(row.proceeds),
            gainLoss: yield* exactNullable(row.gainLoss),
            treatmentCodes: yield* Schema.decodeEffect(Schema.Array(Schema.String))(
              row.treatmentCodes ?? []
            ),
          }
        })
      )
      const exactLots = yield* Effect.forEach(derivedLots, (row) =>
        Effect.gen(function* () {
          return {
            ...row,
            remainingQuantity: yield* exactDecimal(row.remainingQuantity),
            costBasisPerUnit: yield* exactNullable(row.costBasisPerUnit),
          }
        })
      )
      const exactIncome = yield* Effect.forEach(income, (row) =>
        Effect.gen(function* () {
          return {
            ...row,
            quantity: yield* exactDecimal(row.quantity),
            value: yield* exactDecimal(row.value),
            treatmentCodes: yield* Schema.decodeEffect(Schema.Array(Schema.String))(
              row.treatmentCodes
            ),
          }
        })
      )
      const exactBlockers = yield* Effect.forEach(blockers, (row) =>
        Effect.gen(function* () {
          return { ...row, missingQuantity: yield* exactNullable(row.missingQuantity) }
        })
      )
      const processedEventIds = eventIds.filter((id) => processedIds.includes(id))
      const expectedIds = movementOverrides.flatMap((projection) => {
        const custody = projection.inputs.current?.custody ?? []
        return custody.length > 0
          ? custody.map((item) => item.reconciliationId)
          : projection.inputs.current === null
            ? []
            : [projection.inputs.current.legId]
      })
      const custodyIds = new Set(
        movementOverrides.flatMap(
          (projection) =>
            projection.inputs.current?.custody.map((item) => item.reconciliationId) ?? []
        )
      )
      const hasStoredResult = (id: string) =>
        custodyIds.has(id) ||
        allocations.some((row) => row.acquisitionEventId === id || row.dispositionEventId === id) ||
        income.some((row) => row.eventId === id) ||
        derivedLots.some((row) => row.acquisitionEventId === id)
      const allMoneyKnown =
        allocations.every(
          (row) => row.costBasis !== null && row.proceeds !== null && row.gainLoss !== null
        ) && derivedLots.every((row) => row.costBasisPerUnit !== null)
      const complete =
        expectedIds.length > 0 &&
        expectedIds.every((id) => processedIds.includes(id) && hasStoredResult(id)) &&
        blockers.length === 0 &&
        allMoneyKnown
      const hasMoney =
        allocations.some(
          (row) => row.costBasis !== null || row.proceeds !== null || row.gainLoss !== null
        ) ||
        income.length > 0 ||
        derivedLots.some((row) => row.costBasisPerUnit !== null)
      const custodyOnly = expectedIds.length > 0 && expectedIds.every((id) => custodyIds.has(id))
      const monetaryStatus =
        custodyOnly && complete
          ? "not_applicable"
          : !hasMoney
            ? "unavailable"
            : complete
              ? "available"
              : "partial"
      return {
        run,
        state: complete ? "complete" : "partial",
        monetaryStatus,
        derivedLots: exactLots,
        allocations: exactAllocations,
        income: exactIncome,
        blockers: exactBlockers,
        processedEventIds,
        correctionInputs,
      } satisfies TransactionDetailCalculation
    })
  const find: TransactionDetailRepositoryService["find"] = (params) =>
    db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            const [transaction] = yield* tx
              .select({
                transactionId: schema.transactions.id,
                sourceRawRecordId: schema.transactions.sourceRawRecordId,
                evidence: safeRawEvidence,
                timestamp: schema.transactions.timestamp,
                transactionType: schema.transactions.transactionType,
                providerTransactionType: schema.transactions.providerTransactionType,
                description: schema.transactions.providerDescription,
                externalId: schema.transactions.externalId,
                source: {
                  sourceId: schema.sources.id,
                  name: schema.sources.name,
                  kind: schema.sources.sourceableType,
                },
              })
              .from(schema.transactions)
              .innerJoin(
                schema.sources,
                and(
                  eq(schema.sources.id, schema.transactions.sourceId),
                  eq(schema.sources.principalId, params.principalId)
                )
              )
              .leftJoin(
                schema.sourceRecordsRaw,
                and(
                  eq(schema.sourceRecordsRaw.id, schema.transactions.sourceRawRecordId),
                  eq(schema.sourceRecordsRaw.sourceId, schema.transactions.sourceId)
                )
              )
              .where(
                and(
                  eq(schema.transactions.id, params.transactionId),
                  eq(schema.transactions.principalId, params.principalId),
                  exists(
                    tx
                      .select({ id: schema.transactionLegs.id })
                      .from(schema.transactionLegs)
                      .where(
                        and(
                          eq(schema.transactionLegs.transactionId, schema.transactions.id),
                          eq(schema.transactionLegs.sourceId, schema.transactions.sourceId),
                          eq(schema.transactionLegs.principalId, params.principalId)
                        )
                      )
                  )
                )
              )
            if (transaction === undefined) return Option.none()
            // Discovery owns fee and custody association; never repeat its target selection by shape.
            const discovered = yield* targets.findTransactionTargetsInSnapshot(params)
            const movementOverrides = Option.getOrElse(discovered, () => [])
            const targetIds = movementOverrides.map((projection) => projection.context.targetId)
            const movements =
              targetIds.length === 0
                ? []
                : yield* tx
                    .select({
                      id: schema.transactionLegs.id,
                      transactionId: schema.transactionLegs.transactionId,
                      sourceId: schema.transactionLegs.sourceId,
                      timestamp: schema.transactionLegs.timestamp,
                      assetId: schema.transactionLegs.assetId,
                      amount: schema.transactionLegs.amount,
                      kind: schema.transactionLegs.kind,
                      provenance: schema.transactionLegs.provenance,
                      derivationRule: schema.transactionLegs.derivationRule,
                      movementCorrectionTargetId: schema.transactionLegs.movementCorrectionTargetId,
                      sourceRawRecordId: schema.transactionLegs.sourceRawRecordId,
                      sourceRepresentationUseId: schema.transactionLegs.sourceRepresentationUseId,
                      providerAssetRowId: schema.transactionLegs.providerAssetRowId,
                      assetRepresentationId: schema.transactionLegs.assetRepresentationId,
                      originKind: schema.transactionLegs.originKind,
                      providerTransferId: schema.transactionLegs.providerTransferId,
                      sourceTransferId: schema.transactionLegs.sourceTransferId,
                      feeForTransactionId: schema.transactionLegs.feeForTransactionId,
                      evidence: safeRawEvidence,
                    })
                    .from(schema.transactionLegs)
                    .leftJoin(
                      schema.sourceRecordsRaw,
                      and(
                        eq(schema.sourceRecordsRaw.id, schema.transactionLegs.sourceRawRecordId),
                        eq(schema.sourceRecordsRaw.sourceId, schema.transactionLegs.sourceId)
                      )
                    )
                    .where(
                      and(
                        eq(schema.transactionLegs.principalId, params.principalId),
                        inArray(schema.transactionLegs.movementCorrectionTargetId, targetIds)
                      )
                    )
                    .orderBy(asc(schema.transactionLegs.timestamp), asc(schema.transactionLegs.id))
            const movementIds = movements.map((movement) => movement.id)
            const transactionIds = [
              params.transactionId,
              ...movements.flatMap((movement) =>
                movement.transactionId === null ? [] : [movement.transactionId]
              ),
            ]
            // Retained provider evidence belongs to its recorded transaction even without a leg.
            const linkedProviders = yield* tx
              .select({ id: schema.providerTransfers.id })
              .from(schema.providerTransfers)
              .innerJoin(
                schema.sources,
                and(
                  eq(schema.sources.id, schema.providerTransfers.sourceId),
                  eq(schema.sources.principalId, params.principalId)
                )
              )
              .where(
                or(
                  exists(
                    tx
                      .select({ id: schema.transactions.id })
                      .from(schema.transactions)
                      .where(
                        and(
                          eq(schema.transactions.id, params.transactionId),
                          eq(schema.transactions.id, schema.providerTransfers.transactionId),
                          eq(schema.transactions.sourceId, schema.providerTransfers.sourceId),
                          eq(schema.transactions.principalId, params.principalId)
                        )
                      )
                  ),
                  exists(
                    tx
                      .select({ id: schema.transactionLegs.id })
                      .from(schema.transactionLegs)
                      .where(
                        and(
                          inArray(schema.transactionLegs.id, movementIds),
                          eq(schema.transactionLegs.originKind, "provider_transfer"),
                          eq(
                            schema.transactionLegs.providerTransferId,
                            schema.providerTransfers.id
                          ),
                          eq(schema.transactionLegs.sourceId, schema.providerTransfers.sourceId),
                          eq(schema.transactionLegs.principalId, params.principalId)
                        )
                      )
                  )
                )
              )
            const providerIds = linkedProviders.map((row) => row.id)
            const canonicalOrigins =
              movementIds.length === 0
                ? []
                : yield* tx
                    .selectDistinct({ id: schema.transfers.id })
                    .from(schema.transfers)
                    .innerJoin(
                      schema.transactionLegs,
                      and(
                        inArray(schema.transactionLegs.id, movementIds),
                        eq(schema.transactionLegs.originKind, "canonical_transfer"),
                        eq(schema.transactionLegs.sourceTransferId, schema.transfers.id),
                        eq(schema.transactionLegs.sourceId, schema.transfers.sourceId),
                        eq(schema.transactionLegs.principalId, params.principalId)
                      )
                    )
                    .where(eq(schema.transfers.principalId, params.principalId))
            const canonicalIds = canonicalOrigins.map((row) => row.id)
            const reconciliations = yield* tx
              .select({
                id: schema.transferReconciliations.id,
                providerTransferId: schema.transferReconciliations.providerTransferId,
                canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
                canonicalTransactionId: schema.transferReconciliations.canonicalTransactionId,
                status: schema.transferReconciliations.status,
                matchReason: schema.transferReconciliations.matchReason,
                deterministic: schema.transferReconciliations.deterministic,
              })
              .from(schema.transferReconciliations)
              .where(
                and(
                  eq(schema.transferReconciliations.principalId, params.principalId),
                  or(
                    eq(schema.transferReconciliations.canonicalTransactionId, params.transactionId),
                    inArray(schema.transferReconciliations.providerTransferId, providerIds),
                    inArray(schema.transferReconciliations.canonicalTransferId, canonicalIds)
                  )
                )
              )
              .orderBy(asc(schema.transferReconciliations.id))
            const evidenceProviderIds = [
              ...providerIds,
              ...reconciliations.map((row) => row.providerTransferId),
            ]
            const evidenceTransactionIds = [
              ...transactionIds,
              ...reconciliations.flatMap((row) =>
                row.canonicalTransactionId === null ? [] : [row.canonicalTransactionId]
              ),
            ]
            const movementTransactionEvidence = yield* tx
              .select({
                originId: schema.transactions.id,
                sourceId: schema.transactions.sourceId,
                sourceRawRecordId: schema.transactions.sourceRawRecordId,
                evidence: safeRawEvidence,
              })
              .from(schema.transactions)
              .innerJoin(
                schema.sources,
                and(
                  eq(schema.sources.id, schema.transactions.sourceId),
                  eq(schema.sources.principalId, params.principalId)
                )
              )
              .leftJoin(
                schema.sourceRecordsRaw,
                and(
                  eq(schema.sourceRecordsRaw.id, schema.transactions.sourceRawRecordId),
                  eq(schema.sourceRecordsRaw.sourceId, schema.transactions.sourceId)
                )
              )
              .where(
                and(
                  or(
                    inArray(schema.transactions.id, evidenceTransactionIds),
                    exists(
                      tx
                        .select({ id: schema.providerTransfers.id })
                        .from(schema.providerTransfers)
                        .where(
                          and(
                            inArray(schema.providerTransfers.id, evidenceProviderIds),
                            eq(schema.providerTransfers.transactionId, schema.transactions.id),
                            eq(schema.providerTransfers.sourceId, schema.transactions.sourceId)
                          )
                        )
                    )
                  ),
                  eq(schema.transactions.principalId, params.principalId),
                  ne(schema.transactions.id, params.transactionId)
                )
              )
              .orderBy(asc(schema.transactions.id))
            const providerEvidence =
              evidenceProviderIds.length === 0
                ? []
                : yield* tx
                    .select({
                      originId: schema.providerTransfers.id,
                      sourceId: schema.providerTransfers.sourceId,
                      sourceRawRecordId: schema.providerTransfers.sourceRawRecordId,
                      evidence: safeRawEvidence,
                    })
                    .from(schema.providerTransfers)
                    .innerJoin(
                      schema.sources,
                      and(
                        eq(schema.sources.id, schema.providerTransfers.sourceId),
                        eq(schema.sources.principalId, params.principalId)
                      )
                    )
                    .leftJoin(
                      schema.sourceRecordsRaw,
                      and(
                        eq(schema.sourceRecordsRaw.id, schema.providerTransfers.sourceRawRecordId),
                        eq(schema.sourceRecordsRaw.sourceId, schema.providerTransfers.sourceId)
                      )
                    )
                    .where(inArray(schema.providerTransfers.id, evidenceProviderIds))
                    .orderBy(asc(schema.providerTransfers.id))
            const evidenceCanonicalIds = [
              ...canonicalIds,
              ...reconciliations.flatMap((row) =>
                row.canonicalTransferId === null ? [] : [row.canonicalTransferId]
              ),
            ]
            const canonicalEvidence =
              evidenceCanonicalIds.length === 0
                ? []
                : yield* tx
                    .select({
                      originId: schema.transfers.id,
                      sourceId: schema.transfers.sourceId,
                      sourceRawRecordId: schema.transfers.sourceRawRecordId,
                      evidence: safeRawEvidence,
                    })
                    .from(schema.transfers)
                    .innerJoin(
                      schema.sources,
                      and(
                        eq(schema.sources.id, schema.transfers.sourceId),
                        eq(schema.sources.principalId, params.principalId)
                      )
                    )
                    .leftJoin(
                      schema.sourceRecordsRaw,
                      and(
                        eq(schema.sourceRecordsRaw.id, schema.transfers.sourceRawRecordId),
                        eq(schema.sourceRecordsRaw.sourceId, schema.transfers.sourceId)
                      )
                    )
                    .where(
                      and(
                        inArray(schema.transfers.id, evidenceCanonicalIds),
                        eq(schema.transfers.principalId, params.principalId)
                      )
                    )
                    .orderBy(asc(schema.transfers.id))
            const assetOverrides = yield* readAssetOverrides({
              executor: tx,
              movements,
              principalId: params.principalId,
            })
            const calculation = yield* readCalculation({
              executor: tx,
              params,
              movementIds,
              movementOverrides,
              targetIds,
            })
            const { evidence: transactionEvidence, ...transactionFacts } = transaction
            return Option.some({
              ...transactionFacts,
              movementOverrides,
              assetOverrides,
              calculation,
              sourceEvidence: [
                evidenceLink({
                  origin: "transaction",
                  originId: transaction.transactionId,
                  sourceId: transaction.source.sourceId,
                  sourceRawRecordId: transaction.sourceRawRecordId,
                  evidence: transactionEvidence,
                }),
                ...movementTransactionEvidence.map((link) =>
                  evidenceLink({ ...link, origin: "transaction" })
                ),
                ...movements.map((movement) =>
                  evidenceLink({
                    origin: "leg",
                    originId: movement.id,
                    sourceId: movement.sourceId,
                    sourceRawRecordId: movement.sourceRawRecordId,
                    evidence: movement.evidence,
                  })
                ),
                ...providerEvidence.map((link) =>
                  evidenceLink({ ...link, origin: "provider_transfer" })
                ),
                ...canonicalEvidence.map((link) =>
                  evidenceLink({ ...link, origin: "canonical_transfer" })
                ),
              ],
              reconciliations,
              movements: movements.map((movement) => ({
                ...movement,
                evidenceStatus:
                  movement.evidence === null ? ("unavailable" as const) : ("available" as const),
              })),
              classificationHistoryStatus: "unavailable" as const,
            })
          }),
        { isolationLevel: "repeatable read", accessMode: "read only" }
      )
      .pipe(
        Effect.mapError((cause) =>
          Schema.is(UnsupportedJurisdictionError)(cause)
            ? cause
            : isPersistenceError(cause)
              ? cause
              : new PersistenceError({ operation: "transactionDetailRepository.find", cause })
        )
      )
  return { find } satisfies TransactionDetailRepositoryService
})

/** Drizzle-backed detail reader, sharing the established correction target discovery. */
export const TransactionDetailRepositoryLive = Layer.effect(TransactionDetailRepository, make).pipe(
  Layer.provide(PrincipalTransactionOverrideRepositoryLive),
  Layer.provide(PrincipalAssetOverrideRepositoryLive)
)
