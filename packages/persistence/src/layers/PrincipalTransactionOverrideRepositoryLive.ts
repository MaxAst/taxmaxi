/**
 * PrincipalTransactionOverrideRepositoryLive - Recorded movement facts and history reads.
 *
 * @module PrincipalTransactionOverrideRepositoryLive
 */
import {
  MovementClassificationInput,
  MovementCorrectionFacts,
  MovementCorrectionTargetIdentity,
  MovementPriceInput,
} from "@my/core/accounting"
import { and, asc, eq, getTableColumns, or } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import { createHash } from "node:crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { wrapSqlError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import {
  PrincipalTransactionOverrideRepository,
  type MovementCorrectionStream,
  type MovementSystemEvidence,
  type PrincipalTransactionOverrideHistoryRecord,
  type PrincipalTransactionOverrideRepositoryShape,
} from "../services/PrincipalTransactionOverrideRepository.ts"
import { drizzle } from "./PgClientLive.ts"

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
    economicAssetId: Schema.String,
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

/** Read an owned target and its independent streams in one repeatable-read snapshot. */
export const PrincipalTransactionOverrideRepositoryLive = Layer.effect(
  PrincipalTransactionOverrideRepository,
  Effect.gen(function* () {
    const db = yield* drizzle
    const findContext: PrincipalTransactionOverrideRepositoryShape["findContext"] = ({
      principalId,
      targetId,
    }) =>
      db
        .transaction(
          (tx) =>
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
                        eq(
                          schema.providerTransfers.id,
                          schema.transferReconciliations.providerTransferId
                        )
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
                          eq(
                            schema.inventoryMovements.providerTransferId,
                            schema.providerTransfers.id
                          ),
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
                          eq(
                            schema.transfers.id,
                            schema.transferReconciliations.canonicalTransferId
                          ),
                          eq(schema.transfers.principalId, principalId)
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
                leg?.kind === "fee"
                  ? "fee"
                  : custodyLinks.length > 0
                    ? "custody"
                    : "ownership_change"
              const current =
                leg === undefined
                  ? null
                  : yield* Effect.gen(function* () {
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
                      // Recreated row UUIDs and timestamps of persistence do not change the inspected facts.
                      const revisionPayload = yield* Schema.encodeEffect(SystemRevisionPayload)({
                        target,
                        quantity: leg.amount,
                        structure,
                        economicAssetId: leg.assetId,
                        system,
                      })
                      const systemRevision = createHash("sha256")
                        .update(revisionPayload)
                        .digest("hex")
                      const facts = yield* Schema.decodeEffect(MovementCorrectionFacts)({
                        target,
                        systemRevision,
                        quantity: leg.amount,
                        structure,
                        economicAssetId: leg.assetId,
                        direction:
                          leg.kind === "acquisition" || leg.kind === "income"
                            ? "inbound"
                            : "outbound",
                      })
                      return { legId: leg.id, transactionId: leg.transactionId, facts, system }
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
            }),
          { isolationLevel: "repeatable read", accessMode: "read only" }
        )
        .pipe(wrapSqlError("principalTransactionOverrideRepository.findContext"))
    return { findContext } satisfies PrincipalTransactionOverrideRepositoryShape
  })
)
