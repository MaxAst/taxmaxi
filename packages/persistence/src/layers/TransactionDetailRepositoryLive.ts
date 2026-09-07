/** Read-only transaction detail through recorded movement and evidence links.
 * @module TransactionDetailRepositoryLive
 */
import { and, asc, eq, exists, inArray, ne, or } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { UnsupportedJurisdictionError } from "@my/accounting"
import * as Schema from "effect/Schema"
import { isPersistenceError, PersistenceError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import { PrincipalTransactionOverrideRepository } from "../services/PrincipalTransactionOverrideRepository.ts"
import {
  TransactionDetailRepository,
  type TransactionDetailRepositoryService,
  type TransactionDetailEvidenceLink,
} from "../services/TransactionDetailRepository.ts"
import { PrincipalTransactionOverrideRepositoryLive } from "./PrincipalTransactionOverrideRepositoryLive.ts"
import { drizzle } from "./PgClientLive.ts"

const safeRawEvidence = {
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
            const targetIds = Option.getOrElse(discovered, () => []).map(
              (projection) => projection.context.targetId
            )
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
            const providerIds = movements.flatMap((movement) =>
              movement.providerTransferId === null ? [] : [movement.providerTransferId]
            )
            const canonicalIds = movements.flatMap((movement) =>
              movement.sourceTransferId === null ? [] : [movement.sourceTransferId]
            )
            const movementIds = movements.map((movement) => movement.id)
            const movementTransactionEvidence =
              movementIds.length === 0
                ? []
                : yield* tx
                    .selectDistinct({
                      originId: schema.transactions.id,
                      sourceRawRecordId: schema.transactions.sourceRawRecordId,
                      evidence: safeRawEvidence,
                    })
                    .from(schema.transactions)
                    .innerJoin(
                      schema.transactionLegs,
                      and(
                        eq(schema.transactionLegs.transactionId, schema.transactions.id),
                        eq(schema.transactionLegs.sourceId, schema.transactions.sourceId),
                        eq(schema.transactionLegs.principalId, params.principalId),
                        inArray(schema.transactionLegs.id, movementIds)
                      )
                    )
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
                        eq(schema.transactions.principalId, params.principalId),
                        ne(schema.transactions.id, params.transactionId)
                      )
                    )
                    .orderBy(asc(schema.transactions.id))
            const providerEvidence =
              providerIds.length === 0
                ? []
                : yield* tx
                    .select({
                      originId: schema.providerTransfers.id,
                      sourceRawRecordId: schema.providerTransfers.sourceRawRecordId,
                      evidence: safeRawEvidence,
                    })
                    .from(schema.providerTransfers)
                    .innerJoin(
                      schema.transactionLegs,
                      and(
                        eq(schema.transactionLegs.originKind, "provider_transfer"),
                        eq(schema.transactionLegs.providerTransferId, schema.providerTransfers.id),
                        eq(schema.transactionLegs.sourceId, schema.providerTransfers.sourceId),
                        eq(schema.transactionLegs.principalId, params.principalId),
                        inArray(schema.transactionLegs.id, movementIds)
                      )
                    )
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
                    .orderBy(asc(schema.providerTransfers.id))
            const canonicalEvidence =
              canonicalIds.length === 0
                ? []
                : yield* tx
                    .select({
                      originId: schema.transfers.id,
                      sourceRawRecordId: schema.transfers.sourceRawRecordId,
                      evidence: safeRawEvidence,
                    })
                    .from(schema.transfers)
                    .innerJoin(
                      schema.transactionLegs,
                      and(
                        eq(schema.transactionLegs.originKind, "canonical_transfer"),
                        eq(schema.transactionLegs.sourceTransferId, schema.transfers.id),
                        eq(schema.transactionLegs.sourceId, schema.transfers.sourceId),
                        eq(schema.transactionLegs.principalId, params.principalId),
                        inArray(schema.transactionLegs.id, movementIds)
                      )
                    )
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
                    .where(eq(schema.transfers.principalId, params.principalId))
                    .orderBy(asc(schema.transfers.id))
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
            const { evidence: transactionEvidence, ...transactionFacts } = transaction
            return Option.some({
              ...transactionFacts,
              sourceEvidence: [
                evidenceLink({
                  origin: "transaction",
                  originId: transaction.transactionId,
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
  Layer.provide(PrincipalTransactionOverrideRepositoryLive)
)
