/**
 * WorkerCalculationMaintenanceLive - Durable replacement of missing calculation work.
 *
 * @module WorkerCalculationMaintenanceLive
 */

import { DateTime, Effect, Layer } from "effect"
import type { PrincipalId } from "@my/core/ownership"
import type { PersistenceError } from "@my/persistence/errors"
import { CalculationRunRepository } from "@my/persistence/services"
import { CalculationRecomputeQueue } from "@my/sync-engine/services"
import { positiveIntConfig } from "@my/sync-engine/shared"

const DEFAULT_MAINTENANCE_INTERVAL_MS = 60_000
const DEFAULT_STALE_AFTER_MS = 300_000
const DEFAULT_BATCH_SIZE = 100

interface WorkerCalculationMaintenanceConfig {
  readonly intervalMs: number
  readonly staleAfterMs: number
  readonly batchSize: number
}

const loadConfig = Effect.gen(function* () {
  return {
    intervalMs: yield* positiveIntConfig({
      name: "CALCULATION_MAINTENANCE_INTERVAL_MS",
      defaultValue: DEFAULT_MAINTENANCE_INTERVAL_MS,
    }),
    staleAfterMs: yield* positiveIntConfig({
      name: "CALCULATION_MAINTENANCE_STALE_AFTER_MS",
      defaultValue: DEFAULT_STALE_AFTER_MS,
    }),
    batchSize: yield* positiveIntConfig({
      name: "CALCULATION_MAINTENANCE_BATCH_SIZE",
      defaultValue: DEFAULT_BATCH_SIZE,
    }),
  } satisfies WorkerCalculationMaintenanceConfig
})

/** Outcome of one bounded durable calculation-maintenance pass. */
export interface WorkerCalculationMaintenanceSummary {
  readonly failedStaleRuns: number
  readonly nextAfterPrincipalId: PrincipalId | null
  readonly requestedRecomputes: number
  readonly failedRequests: number
}

/** Settle stale runs and enqueue the principals whose derived state needs replacing. */
export const runCalculationMaintenancePass = ({
  staleBefore,
  limit,
  afterPrincipalId,
}: {
  readonly staleBefore: Date
  readonly limit: number
  readonly afterPrincipalId?: PrincipalId
}): Effect.Effect<
  WorkerCalculationMaintenanceSummary,
  PersistenceError,
  CalculationRunRepository | CalculationRecomputeQueue
> =>
  Effect.gen(function* () {
    const repository = yield* CalculationRunRepository
    const queue = yield* CalculationRecomputeQueue
    const maintenance = yield* repository.settleStaleAndFindRecomputePrincipals({
      staleBefore,
      limit,
      ...(afterPrincipalId === undefined ? {} : { afterPrincipalId }),
    })
    const requested = yield* Effect.forEach(
      maintenance.principalIds,
      (principalId) =>
        queue.enqueuePrincipalRecompute(principalId).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logError(
              { principalId, operation: error.operation, cause: error.cause },
              "calculation-maintenance:enqueue-failed"
            ).pipe(Effect.as(false))
          )
        ),
      { concurrency: 1 }
    )

    return {
      failedStaleRuns: maintenance.failedStaleRuns,
      nextAfterPrincipalId: maintenance.nextAfterPrincipalId,
      requestedRecomputes: requested.filter(Boolean).length,
      failedRequests: requested.filter((succeeded) => !succeeded).length,
    }
  })

/** Run calculation maintenance at startup and on a small periodic cadence. */
export const WorkerCalculationMaintenanceLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* loadConfig
    let afterPrincipalId: PrincipalId | undefined

    const runPass = Effect.gen(function* () {
      const currentTime = yield* DateTime.now
      const staleBefore = currentTime.pipe(
        DateTime.subtract({ milliseconds: config.staleAfterMs }),
        DateTime.toDateUtc
      )
      const summary = yield* runCalculationMaintenancePass({
        staleBefore,
        limit: config.batchSize,
        ...(afterPrincipalId === undefined ? {} : { afterPrincipalId }),
      })
      afterPrincipalId = summary.nextAfterPrincipalId ?? undefined

      yield* Effect.logInfo(
        { ...summary, staleBefore, batchSize: config.batchSize },
        "calculation-maintenance:pass-completed"
      )
    }).pipe(
      Effect.catch((error) => Effect.logError({ error }, "calculation-maintenance:pass-failed"))
    )

    yield* runPass
    yield* Effect.sleep(config.intervalMs).pipe(
      Effect.andThen(runPass),
      Effect.forever,
      Effect.forkScoped
    )
  })
)
