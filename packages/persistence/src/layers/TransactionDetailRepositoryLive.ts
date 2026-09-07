/** Read-only transaction detail through recorded movement and evidence links.
 * @module TransactionDetailRepositoryLive
 */
import { and, asc, eq, exists, inArray, or } from "drizzle-orm"
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
} from "../services/TransactionDetailRepository.ts"
import { PrincipalTransactionOverrideRepositoryLive } from "./PrincipalTransactionOverrideRepositoryLive.ts"
import { drizzle } from "./PgClientLive.ts"

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
                      evidence: {
                        id: schema.sourceRecordsRaw.id,
                        provider: schema.sourceRecordsRaw.provider,
                        recordType: schema.sourceRecordsRaw.recordType,
                        externalRecordId: schema.sourceRecordsRaw.externalRecordId,
                        occurredAt: schema.sourceRecordsRaw.occurredAt,
                        importedAt: schema.sourceRecordsRaw.importedAt,
                      },
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
            const reconciliations =
              providerIds.length === 0 && canonicalIds.length === 0
                ? []
                : yield* tx
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
                          inArray(schema.transferReconciliations.providerTransferId, providerIds),
                          inArray(schema.transferReconciliations.canonicalTransferId, canonicalIds)
                        )
                      )
                    )
                    .orderBy(asc(schema.transferReconciliations.id))
            return Option.some({
              ...transaction,
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
