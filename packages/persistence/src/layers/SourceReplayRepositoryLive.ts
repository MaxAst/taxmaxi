/**
 * SourceReplayRepositoryLive - Canonical source-derived replay reset persistence.
 *
 * @module SourceReplayRepositoryLive
 */

import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { drizzle } from "./PgClientLive.ts"
import { schema } from "../schema/index.ts"
import { SourceReplayRepository, type SourceReplayRepositoryShape } from "@my/sync-engine/services"
import {
  nowDate,
  toSyncEngineStorageError,
  type SyncEngineDbTransaction,
  wrapSyncEngineSqlError,
} from "./SyncEngineRepositorySupport.ts"

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const clearSourceFacts = ({
    tx,
    sourceId,
  }: {
    readonly tx: SyncEngineDbTransaction
    readonly sourceId: string
  }) =>
    Effect.gen(function* () {
      // Durable movement correction targets and history survive derived-row recreation.
      yield* tx
        .delete(schema.transactionLegs)
        .where(eq(schema.transactionLegs.sourceId, sourceId))
        .pipe(wrapSyncEngineSqlError("sourceReplayRepository.resetSourceDerivedState.deleteLegs"))

      yield* tx
        .delete(schema.transactions)
        .where(eq(schema.transactions.sourceId, sourceId))
        .pipe(
          wrapSyncEngineSqlError(
            "sourceReplayRepository.resetSourceDerivedState.deleteTransactions"
          )
        )

      yield* tx
        .delete(schema.transfers)
        .where(eq(schema.transfers.sourceId, sourceId))
        .pipe(
          wrapSyncEngineSqlError("sourceReplayRepository.resetSourceDerivedState.deleteTransfers")
        )

      yield* tx
        .update(schema.sourceRecordsRaw)
        .set({ normalizedAt: null, normalizationError: null, updatedAt: nowDate() })
        .where(eq(schema.sourceRecordsRaw.sourceId, sourceId))
        .pipe(wrapSyncEngineSqlError("sourceReplayRepository.resetSourceDerivedState.resetRawRows"))
    })

  const resetSourceDerivedState: SourceReplayRepositoryShape["resetSourceDerivedState"] = ({
    sourceId,
  }) =>
    db
      .transaction((tx) => clearSourceFacts({ tx, sourceId }))
      .pipe(
        Effect.mapError((error) =>
          toSyncEngineStorageError({
            error,
            operation: "sourceReplayRepository.resetSourceDerivedState.transaction",
          })
        )
      )

  return SourceReplayRepository.of({
    resetSourceDerivedState,
  } satisfies SourceReplayRepositoryShape)
})

const SourceReplayResetRepositoryLive = Layer.effect(SourceReplayRepository, make)

/** Live persistence for replay resets. */
export const SourceReplayRepositoryLive = SourceReplayResetRepositoryLive
