/**
 * PrincipalTransactionOverrideRepositoryLive - Recorded movement facts and history reads.
 *
 * @module PrincipalTransactionOverrideRepositoryLive
 */
import {
  ObservedConsiderationFact,
  MarketQuoteFact,
  AccountingEvent,
  ValuationFact,
  format as formatAccountingQuantity,
  MovementClassificationInput,
  MovementCorrectionInput,
  MovementCorrectionInputError,
  resolveMovementPrice,
  validateMovementClassification,
  MovementCorrectionFacts,
  MovementCorrectionTargetIdentity,
  MovementPriceInput,
} from "@my/core/accounting"
import { germanTaxYearEndExclusive, UnsupportedJurisdictionError } from "@my/accounting"
import { CurrencyCode } from "@my/core/currency"
import type { FactualLedgerSnapshot } from "../services/FactualLedgerRepository.ts"
import { makeFactualLedgerSnapshotReader } from "./FactualLedgerSnapshotReader.ts"
import {
  and,
  asc,
  desc,
  eq,
  ne,
  exists,
  notExists,
  inArray,
  isNull,
  isNotNull,
  sql,
  getTableColumns,
  or,
} from "drizzle-orm"
import type { MovementValuationEvidence } from "../services/FactualLedgerRepository.ts"
import { MovementValuationEvidenceSchema } from "./PrincipalTransactionOverrideDecisionLoader.ts"
import { alias } from "drizzle-orm/pg-core"
import { createHash } from "node:crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { PersistenceError, isPersistenceError, wrapSqlError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import {
  PrincipalTransactionOverrideRepository,
  MovementCorrectionConflictError,
  MovementCorrectionValidationError,
  type MovementCalculationScope,
  type MovementCorrectionReplay,
  type MovementCorrectionStreamProjection,
  type SetMovementCorrectionParams,
  type WithdrawMovementCorrectionParams,
  type PrincipalTransactionOverrideContext,
  type MovementCorrectionStream,
  type MovementSystemEvidence,
  type PrincipalTransactionOverrideHistoryRecord,
  type PrincipalTransactionOverrideRepositoryShape,
} from "../services/PrincipalTransactionOverrideRepository.ts"
import { databaseErrorMetadata } from "../errors/DatabaseErrorMetadata.ts"
import { scheduleSourceReplays } from "./SourceReplayScheduling.ts"
import type { SyncEngineDbTransaction } from "./SyncEngineRepositorySupport.ts"
import { drizzle } from "./PgClientLive.ts"
import { makePrincipalAssetOverrideDecisionLoader } from "./PrincipalAssetOverrideDecisionLoader.ts"

const REQUESTED_REPLAY = alias(schema.processingJobs, "movement_requested_replay")
const FOLLOW_UP_REPLAY = alias(schema.processingJobs, "movement_follow_up_replay")
const ENGINE_INPUTS = Schema.Struct({
  event: Schema.NullOr(Schema.toEncoded(AccountingEvent)),
  valuationFacts: Schema.Array(Schema.toEncoded(ValuationFact)),
  classificationEvidence: Schema.optionalKey(
    Schema.TaggedStruct("user_assertion", { overrideId: Schema.String })
  ),
})
const COVERED_INPUT = Schema.Struct({
  application: Schema.Literals(["inactive", "not_applied", "applied", "needs_attention"]),
  applicationProblem: Schema.NullOr(
    Schema.Literals([
      "target_unavailable",
      "target_ineligible",
      "target_changed",
      "quantity_changed",
      "asset_changed",
      "structure_changed",
      "reporting_currency_mismatch",
    ])
  ),
  resolvedPrice: Schema.NullOr(
    Schema.Struct({
      totalValue: Schema.String,
      unitPrice: Schema.Struct({ amount: Schema.String, rounded: Schema.Boolean }),
      currency: CurrencyCode,
    })
  ),
  system: ENGINE_INPUTS,
  effective: ENGINE_INPUTS,
})

const PROVIDER_TRANSACTION = alias(schema.transactions, "movement_correction_provider_transaction")
const CANONICAL_TRANSACTION = alias(
  schema.transactions,
  "movement_correction_canonical_transaction"
)
const PROVIDER_SOURCE = alias(schema.sources, "movement_correction_provider_source")
const CANONICAL_SOURCE = alias(schema.sources, "movement_correction_canonical_source")
const FEE_TRANSACTION = alias(schema.transactions, "movement_correction_fee_transaction")

const SystemRevisionPayload = Schema.fromJsonString(
  Schema.Struct({
    target: MovementCorrectionTargetIdentity,
    quantity: Schema.String,
    structure: Schema.Literals(["ownership_change", "fee", "custody"]),
    economicAssetId: Schema.NullOr(Schema.String),
    storedAssetId: Schema.String,
    valuationCurrency: Schema.String,
    valuationFacts: Schema.Array(Schema.Array(Schema.Union([Schema.String, Schema.Finite]))),
    system: Schema.Struct({
      occurredAt: Schema.DateFromString,
      legKind: Schema.Literals(["acquisition", "disposal", "income", "fee"]),
      recordedFiatAmount: Schema.NullOr(Schema.String),
      recordedFiatCurrency: Schema.NullOr(Schema.String),
      transactionType: Schema.NullOr(Schema.String),
      providerTransactionType: Schema.NullOr(Schema.String),
      derivationRule: Schema.NullOr(Schema.String),
      feeForSourceRecordKey: Schema.NullOr(Schema.String),
    }),
  })
)

const decodeHistory = (row: typeof schema.principalTransactionOverrides.$inferSelect) =>
  Effect.gen(function* () {
    const inspectedFacts = yield* Schema.decodeEffect(MovementCorrectionFacts)({
      target: {
        principalId: row.principalId,
        sourceId: row.sourceId,
        sourceRecordKey: row.inspectedSourceRecordKey,
        componentKey: row.inspectedComponentKey,
      },
      systemRevision: row.inspectedSystemRevision,
      quantity: row.inspectedQuantity,
      economicAssetId: row.inspectedEconomicAssetId,
      direction: row.inspectedDirection,
      structure: row.inspectedStructure,
    })
    const input =
      row.operation === "withdraw"
        ? null
        : row.kind === "price"
          ? {
              _tag: "price" as const,
              input: yield* Schema.decodeUnknownEffect(MovementPriceInput)(row.priceInput),
            }
          : {
              _tag: "classification" as const,
              input: yield* Schema.decodeUnknownEffect(MovementClassificationInput)(
                row.classificationInput
              ),
            }
    return {
      id: row.id,
      principalId: row.principalId,
      sourceId: row.sourceId,
      targetId: row.targetId,
      kind: row.kind,
      operation: row.operation,
      inspectedFacts,
      input,
      inspectedValuationEvidence: yield* Schema.decodeEffect(MovementValuationEvidenceSchema)(
        row.inspectedValuationEvidence
      ),
      inspectedSystem: {
        occurredAt: row.inspectedOccurredAt,
        legKind: row.inspectedLegKind,
        recordedFiatAmount: row.inspectedFiatAmount,
        recordedFiatCurrency: row.inspectedFiatCurrency,
        transactionType: row.inspectedTransactionType,
        providerTransactionType: row.inspectedProviderTransactionType,
        derivationRule: row.inspectedDerivationRule,
        feeForSourceRecordKey: row.inspectedFeeForSourceRecordKey,
      },
      actorUserId: row.actorUserId,
      reason: row.reason,
      supersedesOverrideId: row.supersedesOverrideId,
      recordedAt: row.recordedAt,
    } satisfies PrincipalTransactionOverrideHistoryRecord
  })

// Stream membership and supersession are recorded facts, independent of timestamps or row ordering.
const stream = (
  history: ReadonlyArray<PrincipalTransactionOverrideHistoryRecord>,
  kind: "price" | "classification"
): MovementCorrectionStream => {
  const records = history.filter((record) => record.kind === kind)
  const superseded = new Set(
    records.flatMap((record) =>
      record.supersedesOverrideId === null ? [] : [record.supersedesOverrideId]
    )
  )
  const leaf = records.find((record) => !superseded.has(record.id)) ?? null
  return { leaf, active: leaf?.operation === "withdraw" ? null : leaf }
}

const loadContext = ({
  tx,
  assetLoader,
  snapshotReader,
  principalId,
  targetId,
  reportingCurrency,
  retainedValuationEvidence,
  allowUnavailableInspection = false,
}: {
  readonly snapshotReader: Effect.Success<typeof makeFactualLedgerSnapshotReader>
  readonly reportingCurrency: CurrencyCode
  readonly retainedValuationEvidence?: MovementValuationEvidence
  readonly allowUnavailableInspection?: boolean
  readonly assetLoader: Effect.Success<typeof makePrincipalAssetOverrideDecisionLoader>
  readonly tx: SyncEngineDbTransaction
  readonly principalId: PrincipalTransactionOverrideContext["target"]["principalId"]
  readonly targetId: string
}) =>
  Effect.gen(function* () {
    const [targetRow] = yield* tx
      .select({
        id: schema.movementCorrectionTargets.id,
        principalId: schema.movementCorrectionTargets.principalId,
        sourceId: schema.movementCorrectionTargets.sourceId,
        sourceRecordKey: schema.movementCorrectionTargets.sourceRecordKey,
        componentKey: schema.movementCorrectionTargets.componentKey,
      })
      .from(schema.movementCorrectionTargets)
      .innerJoin(
        schema.sources,
        and(
          eq(schema.sources.id, schema.movementCorrectionTargets.sourceId),
          eq(schema.sources.principalId, principalId)
        )
      )
      .where(
        and(
          eq(schema.movementCorrectionTargets.id, targetId),
          eq(schema.movementCorrectionTargets.principalId, principalId)
        )
      )
      .limit(1)
    if (targetRow === undefined) return Option.none()
    const target = yield* Schema.decodeEffect(MovementCorrectionTargetIdentity)(targetRow)
    const [leg] = yield* tx
      .select({
        id: schema.transactionLegs.id,
        originKind: schema.transactionLegs.originKind,
        sourceTransferId: schema.transactionLegs.sourceTransferId,
        providerTransferId: schema.transactionLegs.providerTransferId,
        transactionId: schema.transactionLegs.transactionId,
        amount: schema.transactionLegs.amount,
        assetId: schema.transactionLegs.assetId,
        assetRepresentationId: schema.transactionLegs.assetRepresentationId,
        sourceRepresentationUseId: schema.transactionLegs.sourceRepresentationUseId,
        providerAssetRowId: schema.transactionLegs.providerAssetRowId,
        sourceRawRecordId: schema.transactionLegs.sourceRawRecordId,
        kind: schema.transactionLegs.kind,
        occurredAt: schema.transactionLegs.timestamp,
        recordedFiatAmount: schema.transactionLegs.fiatAmount,
        recordedFiatCurrency: schema.transactionLegs.fiatCurrency,
        derivationRule: schema.transactionLegs.derivationRule,
        transactionType: schema.transactions.transactionType,
        providerTransactionType: schema.transactions.providerTransactionType,
        feeForSourceRecordKey: FEE_TRANSACTION.externalId,
      })
      .from(schema.transactionLegs)
      .leftJoin(
        schema.transactions,
        and(
          eq(schema.transactions.id, schema.transactionLegs.transactionId),
          eq(schema.transactions.sourceId, target.sourceId),
          eq(schema.transactions.principalId, principalId)
        )
      )
      .leftJoin(
        FEE_TRANSACTION,
        and(
          eq(FEE_TRANSACTION.id, schema.transactionLegs.feeForTransactionId),
          eq(FEE_TRANSACTION.sourceId, target.sourceId),
          eq(FEE_TRANSACTION.principalId, principalId)
        )
      )
      .where(
        and(
          eq(schema.transactionLegs.movementCorrectionTargetId, targetId),
          eq(schema.transactionLegs.sourceId, target.sourceId),
          eq(schema.transactionLegs.principalId, principalId)
        )
      )
      .limit(1)
    const originCondition =
      leg?.originKind === "canonical_transfer" && leg.sourceTransferId !== null
        ? eq(schema.transferReconciliations.canonicalTransferId, leg.sourceTransferId)
        : leg?.originKind === "provider_transfer" && leg.providerTransferId !== null
          ? eq(schema.transferReconciliations.providerTransferId, leg.providerTransferId)
          : null
    const custodyLinks =
      originCondition === null || leg?.kind === "fee"
        ? []
        : yield* tx
            .select({ id: schema.transferReconciliations.id })
            .from(schema.transferReconciliations)
            .innerJoin(
              schema.providerTransfers,
              eq(schema.providerTransfers.id, schema.transferReconciliations.providerTransferId)
            )
            .innerJoin(
              PROVIDER_TRANSACTION,
              and(
                eq(PROVIDER_TRANSACTION.id, schema.providerTransfers.transactionId),
                eq(PROVIDER_TRANSACTION.sourceId, schema.providerTransfers.sourceId),
                eq(PROVIDER_TRANSACTION.principalId, principalId)
              )
            )
            .innerJoin(
              PROVIDER_SOURCE,
              and(
                eq(PROVIDER_SOURCE.id, PROVIDER_TRANSACTION.sourceId),
                eq(PROVIDER_SOURCE.principalId, principalId)
              )
            )
            .innerJoin(
              schema.inventoryMovements,
              and(
                eq(schema.inventoryMovements.providerTransferId, schema.providerTransfers.id),
                eq(schema.inventoryMovements.transactionId, PROVIDER_TRANSACTION.id),
                eq(schema.inventoryMovements.sourceId, PROVIDER_SOURCE.id),
                eq(schema.inventoryMovements.principalId, principalId),
                eq(schema.inventoryMovements.purpose, "principal"),
                eq(schema.inventoryMovements.reconciliationStatus, "matched")
              )
            )
            .innerJoin(
              schema.transfers,
              and(
                eq(schema.transfers.id, schema.transferReconciliations.canonicalTransferId),
                eq(schema.transfers.principalId, principalId)
              )
            )
            .innerJoin(
              CANONICAL_TRANSACTION,
              and(
                eq(CANONICAL_TRANSACTION.id, schema.transferReconciliations.canonicalTransactionId),
                eq(CANONICAL_TRANSACTION.sourceId, schema.transfers.sourceId),
                eq(CANONICAL_TRANSACTION.principalId, principalId)
              )
            )
            .innerJoin(
              CANONICAL_SOURCE,
              and(
                eq(CANONICAL_SOURCE.id, CANONICAL_TRANSACTION.sourceId),
                eq(CANONICAL_SOURCE.principalId, principalId)
              )
            )
            .where(
              and(
                originCondition,
                eq(schema.transferReconciliations.principalId, principalId),
                or(
                  eq(schema.transferReconciliations.status, "approved"),
                  and(
                    eq(schema.transferReconciliations.status, "auto_applied"),
                    eq(schema.transferReconciliations.deterministic, true)
                  )
                )
              )
            )
            .limit(1)
    const structure =
      leg?.kind === "fee" ? "fee" : custodyLinks.length > 0 ? "custody" : "ownership_change"
    const current =
      leg === undefined
        ? null
        : yield* Effect.gen(function* () {
            const decisions = yield* assetLoader.load({
              principalId,
              sourceRepresentationUseIds:
                leg.sourceRepresentationUseId === null ? [] : [leg.sourceRepresentationUseId],
              providerAssetRowIds: leg.providerAssetRowId === null ? [] : [leg.providerAssetRowId],
            })
            const exact =
              leg.sourceRepresentationUseId === null
                ? undefined
                : decisions.sourceRepresentationUseDecisionById.get(leg.sourceRepresentationUseId)
            // These are identity facts, not permission to bypass inclusion or technical withholding.
            // A required but unavailable exact link cannot use either the provider or stored asset.
            const economicAssetId =
              leg.sourceRepresentationUseId !== null
                ? (exact?.identityReplacementAssetId ?? exact?.systemAssetId ?? null)
                : leg.assetRepresentationId !== null
                  ? null
                  : leg.providerAssetRowId !== null
                    ? (decisions.providerAssetDecisionById.get(leg.providerAssetRowId)
                        ?.effectiveAssetId ?? null)
                    : leg.sourceRawRecordId !== null || leg.originKind !== "none"
                      ? null
                      : leg.assetId
            const system: MovementSystemEvidence = {
              occurredAt: leg.occurredAt,
              legKind: leg.kind,
              recordedFiatAmount: leg.recordedFiatAmount,
              recordedFiatCurrency: leg.recordedFiatCurrency,
              transactionType: leg.transactionType,
              providerTransactionType: leg.providerTransactionType,
              derivationRule: leg.derivationRule,
              feeForSourceRecordKey: leg.feeForSourceRecordKey,
            }
            const valuationEvidence =
              retainedValuationEvidence ??
              (yield* Effect.gen(function* () {
                const snapshot = yield* snapshotReader.load({ principalId, reportingCurrency })
                return yield* Schema.decodeUnknownEffect(MovementValuationEvidenceSchema)({
                  reportingCurrency,
                  facts: snapshot.movements.get(targetId)?.system.valuationFacts ?? [],
                })
              }))
            // The audit keeps original event/reference IDs; the revision compares actual valuation content.
            const valuationFacts = yield* Effect.forEach(valuationEvidence.facts, (encoded) =>
              Effect.gen(function* () {
                const fact = yield* Schema.decodeEffect(
                  Schema.Union([ObservedConsiderationFact, MarketQuoteFact])
                )(encoded)
                return fact._tag === "observed_consideration"
                  ? [fact._tag, fact.amount.format(), fact.amount.currency]
                  : [
                      fact._tag,
                      fact.unitPrice.format(),
                      fact.unitPrice.currency,
                      fact.quotedAt.epochMillis,
                      fact.source,
                    ]
              })
            )
            // Recreated row UUIDs and timestamps of persistence do not change the inspected facts.
            const revisionPayload = yield* Schema.encodeEffect(SystemRevisionPayload)({
              target,
              quantity: leg.amount,
              structure,
              economicAssetId,
              storedAssetId: leg.assetId,
              valuationCurrency: valuationEvidence.reportingCurrency,
              valuationFacts,
              system,
            })
            const systemRevision = createHash("sha256").update(revisionPayload).digest("hex")
            const facts = yield* Schema.decodeEffect(MovementCorrectionFacts)({
              target,
              systemRevision,
              quantity: leg.amount,
              structure,
              economicAssetId,
              direction:
                leg.kind === "acquisition" || leg.kind === "income" ? "inbound" : "outbound",
            }).pipe(
              Effect.catch((error) =>
                allowUnavailableInspection ? Effect.succeed(null) : Effect.fail(error)
              )
            )
            return facts === null
              ? null
              : {
                  legId: leg.id,
                  transactionId: leg.transactionId,
                  facts,
                  system,
                  valuationEvidence,
                }
          })
    // Every history column is returned as audit context; no replacement is applied here.
    const rows = yield* tx
      .select(getTableColumns(schema.principalTransactionOverrides))
      .from(schema.principalTransactionOverrides)
      .where(
        and(
          eq(schema.principalTransactionOverrides.targetId, targetId),
          eq(schema.principalTransactionOverrides.principalId, principalId),
          eq(schema.principalTransactionOverrides.sourceId, target.sourceId)
        )
      )
      .orderBy(
        asc(schema.principalTransactionOverrides.recordedAt),
        asc(schema.principalTransactionOverrides.id)
      )
    const history = yield* Effect.forEach(rows, decodeHistory)
    return Option.some({
      targetId,
      target,
      current,
      price: stream(history, "price"),
      classification: stream(history, "classification"),
      history,
    })
  }).pipe(wrapSqlError("principalTransactionOverrideRepository.loadContext"))

type MutationRequest =
  | (SetMovementCorrectionParams & { readonly operation: "create" | "replace" })
  | (WithdrawMovementCorrectionParams & { readonly operation: "withdraw" })

/** Read consistent context and accept history with exact replay work atomically. */
export const PrincipalTransactionOverrideRepositoryLive = Layer.effect(
  PrincipalTransactionOverrideRepository,
  Effect.gen(function* () {
    const db = yield* drizzle
    const assetLoader = yield* makePrincipalAssetOverrideDecisionLoader
    const snapshotReader = yield* makeFactualLedgerSnapshotReader
    const findContext: PrincipalTransactionOverrideRepositoryShape["findContext"] = (params) =>
      db
        .transaction((tx) => loadContext({ tx, assetLoader, snapshotReader, ...params }), {
          isolationLevel: "repeatable read",
          accessMode: "read only",
        })
        .pipe(wrapSqlError("principalTransactionOverrideRepository.findContext"))

    // Each projection request shares current facts across all targets. The year-scoped
    // calculation read stays separate because its eligibility rules include the cutoff.
    const makeInspectionReader = (): Effect.Success<typeof makeFactualLedgerSnapshotReader> => {
      const snapshots = new Map<CurrencyCode, FactualLedgerSnapshot>()
      return {
        load: (params) =>
          Effect.gen(function* () {
            const existing = snapshots.get(params.reportingCurrency)
            if (existing !== undefined) return existing
            const snapshot = yield* snapshotReader.load({
              principalId: params.principalId,
              reportingCurrency: params.reportingCurrency,
            })
            snapshots.set(params.reportingCurrency, snapshot)
            return snapshot
          }),
      }
    }

    const loadCoverage = ({
      tx,
      context,
      kind,
      scope,
    }: {
      readonly tx: SyncEngineDbTransaction
      readonly context: PrincipalTransactionOverrideContext
      readonly kind: "price" | "classification"
      readonly scope: MovementCalculationScope
    }) =>
      Effect.gen(function* () {
        const leaf = context[kind].leaf
        if (leaf === null)
          return {
            replay: {
              status: "not_scheduled",
              processingJobId: null,
              followUpJobId: null,
            } as const,
            coverage: null,
          }
        const [job] = yield* tx
          .select({
            processingJobId: REQUESTED_REPLAY.id,
            requestedStatus: REQUESTED_REPLAY.status,
            followUpMode: REQUESTED_REPLAY.followUpMode,
            followUpJobId: REQUESTED_REPLAY.followUpJobId,
            followUpStatus: FOLLOW_UP_REPLAY.status,
          })
          .from(schema.principalTransactionOverrideApplications)
          .leftJoin(
            REQUESTED_REPLAY,
            and(
              eq(
                REQUESTED_REPLAY.id,
                schema.principalTransactionOverrideApplications.processingJobId
              ),
              eq(REQUESTED_REPLAY.principalId, leaf.principalId),
              eq(REQUESTED_REPLAY.sourceId, leaf.sourceId)
            )
          )
          .leftJoin(
            FOLLOW_UP_REPLAY,
            and(
              eq(FOLLOW_UP_REPLAY.id, REQUESTED_REPLAY.followUpJobId),
              eq(FOLLOW_UP_REPLAY.principalId, leaf.principalId),
              eq(FOLLOW_UP_REPLAY.sourceId, leaf.sourceId)
            )
          )
          .where(
            and(
              eq(schema.principalTransactionOverrideApplications.overrideId, leaf.id),
              eq(schema.principalTransactionOverrideApplications.sourceId, leaf.sourceId)
            )
          )
        const status =
          job?.processingJobId == null
            ? "failed"
            : job.followUpJobId !== null
              ? job.followUpStatus === "completed"
                ? "complete"
                : job.followUpStatus === null ||
                    job.followUpStatus === "failed" ||
                    job.followUpStatus === "credit_required"
                  ? "failed"
                  : "updating"
              : job.requestedStatus === "failed" || job.requestedStatus === "credit_required"
                ? "failed"
                : job.requestedStatus === "completed" && job.followUpMode === null
                  ? "complete"
                  : "updating"
        const replay: MovementCorrectionReplay = {
          status,
          processingJobId: job?.processingJobId ?? null,
          followUpJobId: job?.followUpJobId ?? null,
        }
        const historyIds = context.history
          .filter((record) => record.kind === kind)
          .map((record) => record.id)
        const runSnapshot = sql`case when split_part(${schema.calculationRuns.inputLedgerRevision}, ':', 1) = 'v2' then replace(split_part(${schema.calculationRuns.inputLedgerRevision}, ':', 3), '.', ':')::pg_snapshot else null end`
        const [run] = yield* tx
          .select({
            runId: schema.calculationRuns.id,
            status: schema.calculationRuns.status,
            failureCode: schema.calculationRuns.failureCode,
            input: schema.calculationRunCorrectionInputs.captured,
          })
          .from(schema.calculationRuns)
          .innerJoin(
            schema.calculationRunCorrectionInputs,
            and(
              eq(schema.calculationRunCorrectionInputs.runId, schema.calculationRuns.id),
              eq(schema.calculationRunCorrectionInputs.principalId, leaf.principalId),
              eq(schema.calculationRunCorrectionInputs.targetId, context.targetId),
              eq(schema.calculationRunCorrectionInputs.overrideId, leaf.id),
              eq(schema.calculationRunCorrectionInputs.kind, kind)
            )
          )
          .where(
            and(
              eq(schema.calculationRuns.principalId, leaf.principalId),
              eq(schema.calculationRuns.jurisdiction, scope.jurisdiction),
              eq(schema.calculationRuns.taxYear, scope.taxYear),
              eq(schema.calculationRuns.reportingCurrency, scope.reportingCurrency),
              ne(schema.calculationRuns.status, "pending"),
              sql`split_part(${schema.calculationRuns.inputLedgerRevision}, ':', 1) = 'v2'`,
              notExists(
                tx
                  .select({ id: schema.principalTransactionOverrides.id })
                  .from(schema.principalTransactionOverrides)
                  .where(
                    and(
                      inArray(schema.principalTransactionOverrides.id, historyIds),
                      sql`not pg_visible_in_snapshot(${schema.principalTransactionOverrides}.xmin::text::xid8, ${runSnapshot})`
                    )
                  )
              ),
              exists(
                tx
                  .select({ id: schema.principalTransactionOverrideApplications.overrideId })
                  .from(schema.principalTransactionOverrideApplications)
                  .innerJoin(
                    REQUESTED_REPLAY,
                    and(
                      eq(
                        REQUESTED_REPLAY.id,
                        schema.principalTransactionOverrideApplications.processingJobId
                      ),
                      eq(REQUESTED_REPLAY.principalId, leaf.principalId),
                      eq(REQUESTED_REPLAY.sourceId, leaf.sourceId)
                    )
                  )
                  .leftJoin(
                    FOLLOW_UP_REPLAY,
                    and(
                      eq(FOLLOW_UP_REPLAY.id, REQUESTED_REPLAY.followUpJobId),
                      eq(FOLLOW_UP_REPLAY.principalId, leaf.principalId),
                      eq(FOLLOW_UP_REPLAY.sourceId, leaf.sourceId)
                    )
                  )
                  .where(
                    and(
                      eq(schema.principalTransactionOverrideApplications.overrideId, leaf.id),
                      sql`pg_visible_in_snapshot(${schema.principalTransactionOverrideApplications}.xmin::text::xid8, ${runSnapshot})`,
                      sql`pg_visible_in_snapshot(${REQUESTED_REPLAY}.xmin::text::xid8, ${runSnapshot})`,
                      or(
                        and(
                          isNull(REQUESTED_REPLAY.followUpJobId),
                          isNull(REQUESTED_REPLAY.followUpMode),
                          eq(REQUESTED_REPLAY.status, "completed")
                        ),
                        and(
                          isNotNull(REQUESTED_REPLAY.followUpJobId),
                          eq(FOLLOW_UP_REPLAY.status, "completed"),
                          sql`pg_visible_in_snapshot(${FOLLOW_UP_REPLAY}.xmin::text::xid8, ${runSnapshot})`
                        )
                      )
                    )
                  )
              )
            )
          )
          .orderBy(
            desc(sql`split_part(${schema.calculationRuns.inputLedgerRevision}, ':', 2)::numeric`),
            desc(schema.calculationRuns.id)
          )
          .limit(1)
        if (run === undefined || run.status === "pending") return { replay, coverage: null }
        const input = yield* Schema.decodeEffect(COVERED_INPUT)(run.input)
        return {
          replay,
          coverage: {
            runId: run.runId,
            status: run.status,
            failureCode: run.failureCode,
            overrideId: leaf.id,
            input,
          },
        }
      })

    const project = ({
      inspectionReader,
      tx,
      context,
      snapshot,
      scope,
    }: {
      readonly tx: SyncEngineDbTransaction
      readonly context: PrincipalTransactionOverrideContext
      readonly snapshot: FactualLedgerSnapshot
      readonly inspectionReader: Effect.Success<typeof makeFactualLedgerSnapshotReader>
      readonly scope: MovementCalculationScope
    }) =>
      Effect.gen(function* () {
        const inputs = snapshot.movements.get(context.targetId) ?? {
          targetId: context.targetId,
          current: null,
          currentOutcome: "absent" as const,
          system: { event: null, valuationFacts: [] },
          effective: { event: null, valuationFacts: [] },
          corrections: [],
        }
        const streams = yield* Effect.forEach(["price", "classification"] as const, (kind) =>
          Effect.gen(function* () {
            const stream = context[kind]
            const periodHistory = context.history.filter((record) => record.kind === kind)
            const outsidePeriod =
              inputs.currentOutcome === "outside_period" ||
              (inputs.current === null &&
                periodHistory.length > 0 &&
                periodHistory.every(
                  (record) =>
                    record.inspectedSystem.occurredAt >=
                    germanTaxYearEndExclusive(scope.taxYear).toDate()
                ))
            const capture = inputs.corrections.find((input) => input.history.id === stream.leaf?.id)
            const { replay, coverage } = yield* loadCoverage({ tx, context, kind, scope })
            const inspectedCurrency = stream.active?.inspectedValuationEvidence.reportingCurrency
            const currentInspection =
              inspectedCurrency === undefined || inspectedCurrency === scope.reportingCurrency
                ? context.current
                : yield* loadContext({
                    tx,
                    assetLoader,
                    snapshotReader: inspectionReader,
                    principalId: context.target.principalId,
                    targetId: context.targetId,
                    reportingCurrency: inspectedCurrency,
                    allowUnavailableInspection: true,
                  }).pipe(
                    Effect.map((value) => (Option.isSome(value) ? value.value.current : null))
                  )
            const projection: MovementCorrectionStreamProjection = {
              ...stream,
              stale:
                stream.active !== null &&
                (currentInspection === null ||
                  stream.active.inspectedFacts.systemRevision !==
                    currentInspection.facts.systemRevision),
              application:
                capture?.application ?? (stream.active === null ? "inactive" : "not_applied"),
              applicationProblem: capture?.applicationProblem ?? null,
              resolvedPrice: capture?.resolvedPrice ?? null,
              replay,
              coverage,
              coverageStatus:
                stream.leaf === null
                  ? "not_requested"
                  : outsidePeriod
                    ? "outside_period"
                    : replay.status === "failed"
                      ? "failed"
                      : replay.status !== "complete" ||
                          coverage === null ||
                          coverage.status === "running"
                        ? "updating"
                        : coverage.status === "failed"
                          ? "failed"
                          : "covered",
            }
            return projection
          })
        )
        const [price, classification] = streams
        if (price === undefined || classification === undefined)
          return yield* new PersistenceError({
            operation: "movementCorrection.project.streams",
            cause: "Missing stream projection",
          })
        return { context, scope, inputs, price, classification }
      })

    const readScope = (scope: MovementCalculationScope) =>
      scope.jurisdiction === "DE"
        ? Effect.succeed(germanTaxYearEndExclusive(scope.taxYear).toDate())
        : Effect.fail(new UnsupportedJurisdictionError({ jurisdiction: scope.jurisdiction }))

    const findProjection: PrincipalTransactionOverrideRepositoryShape["findProjection"] = (
      params
    ) =>
      db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const inspectionReader = makeInspectionReader()
              const context = yield* loadContext({
                tx,
                assetLoader,
                snapshotReader: inspectionReader,
                reportingCurrency: params.scope.reportingCurrency,
                ...params,
                allowUnavailableInspection: true,
              })
              if (Option.isNone(context)) return Option.none()
              const occurredBefore = yield* readScope(params.scope)
              const snapshot = yield* snapshotReader.load({
                principalId: params.principalId,
                reportingCurrency: params.scope.reportingCurrency,
                occurredBefore,
              })
              return Option.some(
                yield* project({
                  tx,
                  context: context.value,
                  snapshot,
                  scope: params.scope,
                  inspectionReader,
                })
              )
            }),
          { isolationLevel: "repeatable read", accessMode: "read only" }
        )
        .pipe(
          Effect.mapError((cause) =>
            Schema.is(UnsupportedJurisdictionError)(cause)
              ? cause
              : isPersistenceError(cause)
                ? cause
                : new PersistenceError({ operation: "movementCorrection.findProjection", cause })
          )
        )

    const findTransactionTargets: PrincipalTransactionOverrideRepositoryShape["findTransactionTargets"] =
      (params) =>
        db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const [transaction] = yield* tx
                  .select({ id: schema.transactions.id, sourceId: schema.transactions.sourceId })
                  .from(schema.transactions)
                  .innerJoin(
                    schema.sources,
                    and(
                      eq(schema.sources.id, schema.transactions.sourceId),
                      eq(schema.sources.principalId, params.principalId)
                    )
                  )
                  .where(
                    and(
                      eq(schema.transactions.id, params.transactionId),
                      eq(schema.transactions.principalId, params.principalId)
                    )
                  )
                if (transaction === undefined) return Option.none()
                const rows = yield* tx
                  .selectDistinct({ targetId: schema.transactionLegs.movementCorrectionTargetId })
                  .from(schema.transactionLegs)
                  .innerJoin(
                    schema.sources,
                    and(
                      eq(schema.sources.id, schema.transactionLegs.sourceId),
                      eq(schema.sources.principalId, params.principalId)
                    )
                  )
                  .innerJoin(
                    schema.movementCorrectionTargets,
                    and(
                      eq(
                        schema.movementCorrectionTargets.id,
                        schema.transactionLegs.movementCorrectionTargetId
                      ),
                      eq(
                        schema.movementCorrectionTargets.sourceId,
                        schema.transactionLegs.sourceId
                      ),
                      eq(schema.movementCorrectionTargets.principalId, params.principalId)
                    )
                  )
                  .where(
                    and(
                      eq(schema.transactionLegs.principalId, params.principalId),
                      or(
                        and(
                          eq(schema.transactionLegs.transactionId, params.transactionId),
                          eq(schema.transactionLegs.sourceId, transaction.sourceId)
                        ),
                        and(
                          eq(schema.transactionLegs.feeForTransactionId, params.transactionId),
                          eq(schema.transactionLegs.sourceId, transaction.sourceId)
                        ),
                        exists(
                          tx
                            .select({ id: schema.providerTransfers.id })
                            .from(schema.providerTransfers)
                            .where(
                              and(
                                eq(schema.transactionLegs.originKind, "provider_transfer"),
                                eq(
                                  schema.providerTransfers.id,
                                  schema.transactionLegs.providerTransferId
                                ),
                                eq(
                                  schema.providerTransfers.sourceId,
                                  schema.transactionLegs.sourceId
                                ),
                                eq(schema.providerTransfers.transactionId, params.transactionId),
                                eq(schema.providerTransfers.sourceId, transaction.sourceId)
                              )
                            )
                        ),
                        exists(
                          tx
                            .select({ id: schema.transferReconciliations.id })
                            .from(schema.transferReconciliations)
                            .innerJoin(
                              schema.providerTransfers,
                              eq(
                                schema.providerTransfers.id,
                                schema.transferReconciliations.providerTransferId
                              )
                            )
                            .innerJoin(
                              PROVIDER_TRANSACTION,
                              and(
                                eq(PROVIDER_TRANSACTION.id, schema.providerTransfers.transactionId),
                                eq(
                                  PROVIDER_TRANSACTION.sourceId,
                                  schema.providerTransfers.sourceId
                                ),
                                eq(PROVIDER_TRANSACTION.principalId, params.principalId)
                              )
                            )
                            .innerJoin(
                              PROVIDER_SOURCE,
                              and(
                                eq(PROVIDER_SOURCE.id, schema.providerTransfers.sourceId),
                                eq(PROVIDER_SOURCE.principalId, params.principalId)
                              )
                            )
                            .innerJoin(
                              schema.transfers,
                              and(
                                eq(
                                  schema.transfers.id,
                                  schema.transferReconciliations.canonicalTransferId
                                ),
                                eq(schema.transfers.principalId, params.principalId)
                              )
                            )
                            .innerJoin(
                              CANONICAL_TRANSACTION,
                              and(
                                eq(
                                  CANONICAL_TRANSACTION.id,
                                  schema.transferReconciliations.canonicalTransactionId
                                ),
                                eq(CANONICAL_TRANSACTION.sourceId, schema.transfers.sourceId),
                                eq(CANONICAL_TRANSACTION.principalId, params.principalId)
                              )
                            )
                            .innerJoin(
                              CANONICAL_SOURCE,
                              and(
                                eq(CANONICAL_SOURCE.id, schema.transfers.sourceId),
                                eq(CANONICAL_SOURCE.principalId, params.principalId)
                              )
                            )
                            .where(
                              and(
                                eq(schema.transferReconciliations.principalId, params.principalId),
                                or(
                                  eq(schema.transferReconciliations.status, "approved"),
                                  and(
                                    eq(schema.transferReconciliations.status, "auto_applied"),
                                    eq(schema.transferReconciliations.deterministic, true)
                                  )
                                ),
                                or(
                                  eq(
                                    schema.transferReconciliations.canonicalTransactionId,
                                    params.transactionId
                                  ),
                                  eq(schema.providerTransfers.transactionId, params.transactionId)
                                ),
                                or(
                                  and(
                                    eq(schema.transactionLegs.originKind, "canonical_transfer"),
                                    eq(
                                      schema.transactionLegs.sourceTransferId,
                                      schema.transfers.id
                                    ),
                                    eq(schema.transactionLegs.sourceId, schema.transfers.sourceId)
                                  ),
                                  and(
                                    eq(schema.transactionLegs.originKind, "provider_transfer"),
                                    eq(
                                      schema.transactionLegs.providerTransferId,
                                      schema.providerTransfers.id
                                    ),
                                    eq(
                                      schema.transactionLegs.sourceId,
                                      schema.providerTransfers.sourceId
                                    )
                                  )
                                )
                              )
                            )
                        )
                      )
                    )
                  )
                  .orderBy(asc(schema.transactionLegs.movementCorrectionTargetId))
                const occurredBefore = yield* readScope(params.scope)
                if (rows.length === 0) return Option.some([])
                const snapshot = yield* snapshotReader.load({
                  principalId: params.principalId,
                  reportingCurrency: params.scope.reportingCurrency,
                  occurredBefore,
                })
                const inspectionReader = makeInspectionReader()
                const projections = yield* Effect.forEach(rows, ({ targetId }) =>
                  Effect.gen(function* () {
                    const context = yield* loadContext({
                      tx,
                      assetLoader,
                      snapshotReader: inspectionReader,
                      reportingCurrency: params.scope.reportingCurrency,
                      principalId: params.principalId,
                      targetId,
                      allowUnavailableInspection: true,
                    })
                    if (Option.isNone(context))
                      return yield* new PersistenceError({
                        operation: "movementCorrection.discover",
                        cause: "Owned target disappeared inside snapshot",
                      })
                    return yield* project({
                      tx,
                      context: context.value,
                      snapshot,
                      scope: params.scope,
                      inspectionReader,
                    })
                  })
                )
                return Option.some(projections)
              }),
            { isolationLevel: "repeatable read", accessMode: "read only" }
          )
          .pipe(
            Effect.mapError((cause) =>
              Schema.is(UnsupportedJurisdictionError)(cause)
                ? cause
                : isPersistenceError(cause)
                  ? cause
                  : new PersistenceError({
                      operation: "movementCorrection.findTransactionTargets",
                      cause,
                    })
            )
          )

    const mutate = (request: MutationRequest) =>
      db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              // Serialize changes by the current owner, then lock the exact source/target relation.
              // A concurrent source claim must commit before this ownership check or wait until acceptance.
              const [principal] = yield* tx
                .select({ userId: schema.principals.userId, kind: schema.principals.kind })
                .from(schema.principals)
                .where(eq(schema.principals.id, request.principalId))
                .for("update")
              const [owned] = yield* tx
                .select({ id: schema.movementCorrectionTargets.id })
                .from(schema.movementCorrectionTargets)
                .innerJoin(
                  schema.sources,
                  and(
                    eq(schema.sources.id, schema.movementCorrectionTargets.sourceId),
                    eq(schema.sources.principalId, request.principalId)
                  )
                )
                .where(
                  and(
                    eq(schema.movementCorrectionTargets.id, request.targetId),
                    eq(schema.movementCorrectionTargets.principalId, request.principalId)
                  )
                )
                .for("update")
              if (owned === undefined) return Option.none()
              if (principal?.kind !== "user" || principal.userId !== request.actorUserId) {
                return yield* new MovementCorrectionValidationError({ code: "invalid_actor" })
              }
              const loaded = yield* loadContext({
                tx,
                assetLoader,
                snapshotReader,
                reportingCurrency: request.reportingCurrency,
                principalId: request.principalId,
                targetId: request.targetId,
              })
              if (Option.isNone(loaded)) return Option.none()
              const context = loaded.value
              const current = context.current
              if (current === null)
                return yield* new MovementCorrectionValidationError({ code: "target_unavailable" })
              const input =
                request.operation === "withdraw"
                  ? null
                  : yield* Schema.decodeEffect(MovementCorrectionInput)(request.input).pipe(
                      Effect.mapError(
                        () => new MovementCorrectionValidationError({ code: "invalid_input" })
                      )
                    )
              const kind = yield* Schema.decodeUnknownEffect(
                Schema.Literals(["price", "classification"])
              )(request.operation === "withdraw" ? request.kind : input?._tag).pipe(
                Effect.mapError(
                  () => new MovementCorrectionValidationError({ code: "invalid_input" })
                )
              )
              const selected = context[kind]
              const conflictKinds = [
                ...((selected.leaf?.id ?? null) === request.expectedLeafId
                  ? []
                  : ["stream_leaf" as const]),
                ...(current.facts.systemRevision === request.expectedSystemRevision
                  ? []
                  : ["system_revision" as const]),
              ]
              if (conflictKinds.length > 0)
                return yield* new MovementCorrectionConflictError({
                  conflictKinds,
                  currentContext: context,
                })
              if (request.operation === "create" && selected.active !== null)
                return yield* new MovementCorrectionValidationError({ code: "stream_active" })
              if (request.operation !== "create" && selected.active === null)
                return yield* new MovementCorrectionValidationError({ code: "stream_inactive" })
              const reason = yield* Schema.decodeEffect(Schema.Trimmed.check(Schema.isNonEmpty()))(
                request.reason
              ).pipe(
                Effect.mapError(
                  () => new MovementCorrectionValidationError({ code: "invalid_reason" })
                )
              )
              if (input !== null && request.operation !== "withdraw") {
                if (input._tag === "price")
                  yield* resolveMovementPrice({
                    input: input.input,
                    facts: current.facts,
                    reportingCurrency: request.reportingCurrency,
                  })
                else
                  yield* validateMovementClassification({
                    input: input.input,
                    facts: current.facts,
                  })
              }
              const now = DateTime.toDateUtc(yield* DateTime.now)
              const { facts, system } = current
              const [record] = yield* tx
                .insert(schema.principalTransactionOverrides)
                .values({
                  principalId: request.principalId,
                  sourceId: context.target.sourceId,
                  targetId: request.targetId,
                  kind,
                  operation: request.operation,
                  actorUserId: request.actorUserId,
                  reason,
                  supersedesOverrideId: request.expectedLeafId,
                  recordedAt: now,
                  inspectedSystemRevision: facts.systemRevision,
                  inspectedValuationEvidence: current.valuationEvidence,
                  inspectedSourceRecordKey: context.target.sourceRecordKey,
                  inspectedComponentKey: context.target.componentKey,
                  inspectedQuantity: formatAccountingQuantity(facts.quantity),
                  inspectedEconomicAssetId: facts.economicAssetId,
                  inspectedDirection: facts.direction,
                  inspectedStructure: facts.structure,
                  inspectedOccurredAt: system.occurredAt,
                  inspectedLegKind: system.legKind,
                  inspectedFiatAmount: system.recordedFiatAmount,
                  inspectedFiatCurrency: system.recordedFiatCurrency,
                  inspectedTransactionType: system.transactionType,
                  inspectedProviderTransactionType: system.providerTransactionType,
                  inspectedDerivationRule: system.derivationRule,
                  inspectedFeeForSourceRecordKey: system.feeForSourceRecordKey,
                  priceInput: input?._tag === "price" ? input.input : null,
                  classificationInput: input?._tag === "classification" ? input.input : null,
                })
                .returning({ id: schema.principalTransactionOverrides.id })
              if (record === undefined)
                return yield* new PersistenceError({
                  operation: "movementCorrection.insert",
                  cause: "Insert returned no event",
                })
              const [replay] = yield* scheduleSourceReplays({
                tx,
                sources: [{ sourceId: context.target.sourceId, principalId: request.principalId }],
                now,
                pendingReplayPolicy: "reuse",
                progressDetails: {
                  mode: "replay",
                  reason: "movement_correction",
                  overrideId: record.id,
                },
                errorOperation: (step) => `principalTransactionOverrideRepository.schedule.${step}`,
              })
              if (replay === undefined)
                return yield* new PersistenceError({
                  operation: "movementCorrection.schedule",
                  cause: "No source replay selected",
                })
              yield* tx.insert(schema.principalTransactionOverrideApplications).values({
                overrideId: record.id,
                sourceId: replay.sourceId,
                processingJobId: replay.processingJobId,
                createdAt: now,
              })
              const updated = yield* loadContext({
                tx,
                assetLoader,
                snapshotReader,
                reportingCurrency: request.reportingCurrency,
                retainedValuationEvidence: current.valuationEvidence,
                principalId: request.principalId,
                targetId: request.targetId,
              })
              if (Option.isNone(updated))
                return yield* new PersistenceError({
                  operation: "movementCorrection.reload",
                  cause: "Owned target disappeared during acceptance",
                })
              return Option.some({
                context: updated.value,
                overrideId: record.id,
                sourceId: replay.sourceId,
                processingJobId: replay.processingJobId,
              })
            }),
          { isolationLevel: "serializable" }
        )
        .pipe(
          Effect.retry({
            times: 2,
            while: (error) => {
              const code = databaseErrorMetadata(error)?.code
              return code === "40001" || code === "40P01"
            },
          }),
          Effect.mapError((cause) =>
            cause instanceof MovementCorrectionConflictError ||
            cause instanceof MovementCorrectionValidationError ||
            Schema.is(MovementCorrectionInputError)(cause) ||
            isPersistenceError(cause)
              ? cause
              : new PersistenceError({
                  operation: "principalTransactionOverrideRepository.mutate",
                  cause,
                })
          )
        )
    return {
      findContext,
      findProjection,
      findTransactionTargets,
      create: (params) => mutate({ ...params, operation: "create" }),
      replace: (params) => mutate({ ...params, operation: "replace" }),
      withdraw: (params) => mutate({ ...params, operation: "withdraw" }),
    } satisfies PrincipalTransactionOverrideRepositoryShape
  })
)
