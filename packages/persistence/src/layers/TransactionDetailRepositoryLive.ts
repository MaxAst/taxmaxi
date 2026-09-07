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
            const { evidence: transactionEvidence, ...transactionFacts } = transaction
            return Option.some({
              ...transactionFacts,
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
  Layer.provide(PrincipalTransactionOverrideRepositoryLive)
)
