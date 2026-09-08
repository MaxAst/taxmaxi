/**
 * WorkerBullMqCalculationConsumerLive - Coalesced principal calculation jobs.
 *
 * @module WorkerBullMqCalculationConsumerLive
 */

import {
  Queue,
  UnrecoverableError,
  Worker,
  type Job,
  type JobsOptions,
  type Processor,
} from "bullmq"
import { Config, DateTime, Effect, Exit, Layer, Option, Result, Schema } from "effect"
import { Redis } from "ioredis"
import { randomUUID } from "node:crypto"
import { JurisdictionCode, TaxYear } from "@my/core/accounting"
import { EUR } from "@my/core/currency"
import {
  CalculationRunId,
  CalculationRunRepository,
  CalculationRunService,
  HistoricalAssetPriceRepository,
  type CalculationRunWriteResult,
} from "@my/persistence/services"
import {
  CALCULATION_RECOMPUTE_JOB_NAME,
  CALCULATION_RECOMPUTE_QUEUE_NAME,
  CalculationRecomputeQueue,
  CalculationRecomputeQueueError,
  CalculationRecomputeQueuePayload,
  CoinGeckoHistoricalPriceClient,
} from "@my/sync-engine/services"
import { positiveIntConfig } from "@my/sync-engine/shared"

const DEFAULT_QUEUE_PREFIX = "taxmaxi"
const DEFAULT_CALCULATION_WORKER_CONCURRENCY = 1
const DEFAULT_CALCULATION_WORKER_LOCK_DURATION_MS = 30_000
const PROCESS_WORKER_ID = `worker-${randomUUID()}`
const GERMAN_TIME_ZONE = "Europe/Berlin"
const GERMAN_JURISDICTION = JurisdictionCode.make("DE")

/** Runtime configuration shared by the calculation producer and consumer. */
export interface WorkerBullMqCalculationConsumerConfig {
  readonly redisUrl: URL
  readonly queuePrefix: string
  readonly concurrency: number
  readonly lockDurationMs: number
  readonly workerId: string
}

/** Minimal BullMQ calculation job passed to the processor. */
export interface WorkerBullMqCalculationJob {
  readonly id?: string
  readonly name: string
  readonly data: unknown
}

/** Processor installed into the calculation BullMQ worker. */
export type WorkerBullMqCalculationProcessor = (
  job: WorkerBullMqCalculationJob
) => Promise<ReadonlyArray<CalculationRunWriteResult>>

/** Small test seam over the BullMQ calculation worker lifecycle. */
export interface BullMqCalculationRecomputeWorker {
  readonly close: Effect.Effect<void, WorkerBullMqCalculationConsumerError>
}

/** Small test seam over the BullMQ calculation queue producer. */
export interface BullMqCalculationRecomputeQueue {
  readonly add: (
    name: typeof CALCULATION_RECOMPUTE_JOB_NAME,
    payload: CalculationRecomputeQueuePayload,
    options: JobsOptions
  ) => Promise<{ readonly id?: string }>
  readonly close: Effect.Effect<void, CalculationRecomputeQueueError>
}

/** Optional BullMQ acquisition hooks used by focused worker tests. */
export interface WorkerBullMqCalculationConsumerOptions {
  readonly acquireWorker?: (
    config: WorkerBullMqCalculationConsumerConfig,
    processor: WorkerBullMqCalculationProcessor
  ) => Effect.Effect<BullMqCalculationRecomputeWorker, WorkerBullMqCalculationConsumerError>
}

/** Optional BullMQ acquisition hook used by focused queue tests. */
export interface WorkerCalculationRecomputeQueueOptions {
  readonly acquireQueue?: (
    config: WorkerBullMqCalculationConsumerConfig
  ) => Effect.Effect<BullMqCalculationRecomputeQueue, CalculationRecomputeQueueError>
}

/** Failure to acquire, run, or close the calculation worker. */
export class WorkerBullMqCalculationConsumerError extends Schema.TaggedError<WorkerBullMqCalculationConsumerError>()(
  "WorkerBullMqCalculationConsumerError",
  {
    operation: Schema.String,
    cause: Schema.Unknown,
  }
) {}

class WorkerBullMqMalformedCalculationPayloadError extends Schema.TaggedError<WorkerBullMqMalformedCalculationPayloadError>()(
  "WorkerBullMqMalformedCalculationPayloadError",
  {
    queueJobId: Schema.NullOr(Schema.String),
    cause: Schema.Unknown,
  }
) {}

const loadConfig = Effect.gen(function* () {
  return {
    redisUrl: yield* Config.url("QUEUE_REDIS_URL"),
    queuePrefix: yield* Config.string("CALCULATION_QUEUE_PREFIX").pipe(
      Config.withDefault(DEFAULT_QUEUE_PREFIX)
    ),
    concurrency: yield* positiveIntConfig({
      name: "CALCULATION_WORKER_CONCURRENCY",
      defaultValue: DEFAULT_CALCULATION_WORKER_CONCURRENCY,
    }),
    lockDurationMs: yield* positiveIntConfig({
      name: "CALCULATION_WORKER_LOCK_DURATION_MS",
      defaultValue: DEFAULT_CALCULATION_WORKER_LOCK_DURATION_MS,
    }),
    workerId: yield* Config.schema(
      Schema.Trimmed.check(Schema.isNonEmpty({ message: "WORKER_ID must not be empty" })),
      "WORKER_ID"
    ).pipe(Config.withDefault(PROCESS_WORKER_ID)),
  } satisfies WorkerBullMqCalculationConsumerConfig
})

const decodePayload = Schema.decodeUnknownEffect(CalculationRecomputeQueuePayload)

const UnknownErrorMessageSchema = Schema.Struct({
  message: Schema.Trimmed.check(Schema.isNonEmpty()),
})

const decodeUnknownErrorMessage = Schema.decodeUnknownExit(UnknownErrorMessageSchema)

const toJobFailure = (error: unknown): Error => {
  if (error instanceof Error) return error

  const decoded = decodeUnknownErrorMessage(error)
  return new Error(
    Exit.isSuccess(decoded) ? decoded.value.message : "Calculation worker job failed"
  )
}

const currentGermanTaxYear = DateTime.now.pipe(
  Effect.map(DateTime.setZoneNamedUnsafe(GERMAN_TIME_ZONE)),
  Effect.map(DateTime.toParts),
  Effect.map(({ year }) => TaxYear.make(year))
)

/** Store every available CoinGecko daily EUR quote needed by one principal. */
const hydrateCoinGeckoDailyEurPrices = (
  principalId: CalculationRecomputeQueuePayload["principalId"]
) =>
  Effect.gen(function* () {
    const repository = yield* HistoricalAssetPriceRepository
    const client = yield* CoinGeckoHistoricalPriceClient
    const needs = yield* repository.listMissingCoinGeckoDailyEurPriceNeeds({ principalId })
    const outcomes = yield* Effect.forEach(
      needs,
      (need) =>
        client
          .fetchDailyEurPrice({
            coinId: need.coingeckoCoinId,
            snapshotAt: need.snapshotAt,
          })
          .pipe(
            Effect.result,
            Effect.flatMap((result) => {
              if (Result.isFailure(result)) {
                return Effect.logError(
                  {
                    principalId,
                    assetId: need.assetId,
                    coinId: need.coingeckoCoinId,
                    snapshotAt: need.snapshotAt,
                    status: result.failure.status,
                    cause: result.failure.cause,
                  },
                  "calculation-worker:historical-price-fetch-failed"
                ).pipe(Effect.as("fetch_failed" as const))
              }

              if (Option.isNone(result.success)) {
                return Effect.succeed("unavailable" as const)
              }

              return repository
                .upsertCoinGeckoDailyEurPrice({
                  assetId: need.assetId,
                  snapshotAt: need.snapshotAt,
                  price: result.success.value,
                })
                .pipe(Effect.as("stored" as const))
            })
          ),
      { concurrency: 1 }
    )
    const summary = outcomes.reduce(
      (counts, outcome) => ({ ...counts, [outcome]: counts[outcome] + 1 }),
      { stored: 0, unavailable: 0, fetch_failed: 0 }
    )

    yield* Effect.logInfo(
      { principalId, requested: needs.length, ...summary },
      "calculation-worker:historical-price-hydration-completed"
    )
  })

const processJob = Effect.fn("worker.calculation.process", {
  attributes: { queueName: CALCULATION_RECOMPUTE_QUEUE_NAME },
  kind: "consumer",
})(function* ({
  job,
  config,
}: {
  readonly job: WorkerBullMqCalculationJob
  readonly config: WorkerBullMqCalculationConsumerConfig
}) {
  const calculationRunService = yield* CalculationRunService
  const payload = yield* decodePayload(job.data).pipe(
    Effect.mapError(
      (cause) =>
        new WorkerBullMqMalformedCalculationPayloadError({
          queueJobId: job.id ?? null,
          cause,
        })
    )
  )

  yield* Effect.logInfo(
    {
      queueName: CALCULATION_RECOMPUTE_QUEUE_NAME,
      queueJobId: job.id ?? null,
      workerId: config.workerId,
      principalId: payload.principalId,
    },
    "calculation-worker:job-started"
  )

  const calculationRunRepository = yield* CalculationRunRepository
  const principalScope = {
    principalId: payload.principalId,
    jurisdiction: GERMAN_JURISDICTION,
    reportingCurrency: EUR,
  }
  const requestedTaxYears = yield* calculationRunRepository.listRequestedTaxYears(principalScope)
  // Observe preparation inputs without reserving work during slow price hydration.
  const firstRequestedYear = requestedTaxYears[0]
  const firstPreparation =
    firstRequestedYear === undefined
      ? undefined
      : yield* calculationRunRepository.observeSyncPreparation({
          ...principalScope,
          taxYear: firstRequestedYear,
        })
  const initialHydration = yield* hydrateCoinGeckoDailyEurPrices(payload.principalId).pipe(
    Effect.result
  )
  if (firstRequestedYear === undefined && Result.isFailure(initialHydration)) {
    return yield* initialHydration.failure
  }
  const currentTaxYear = yield* currentGermanTaxYear
  const activeTaxYears = yield* calculationRunRepository.listActiveTaxYears(principalScope)
  const remainingYears = [...new Set([...requestedTaxYears, ...activeTaxYears, currentTaxYear])]
    .filter((year) => year !== firstRequestedYear)
    .sort((left, right) => left - right)
  const taxYears =
    firstRequestedYear === undefined ? remainingYears : [firstRequestedYear, ...remainingYears]
  const outcomes = yield* Effect.forEach(
    taxYears,
    (taxYear) =>
      Effect.gen(function* () {
        const runId = CalculationRunId.make(randomUUID())
        const syncPreparation =
          taxYear === firstRequestedYear
            ? firstPreparation
            : yield* calculationRunRepository.observeSyncPreparation({ ...principalScope, taxYear })
        // Stored quotes are reused; each scope observes inputs before its own preparation.
        const hydration =
          taxYear === taxYears[0]
            ? initialHydration
            : yield* hydrateCoinGeckoDailyEurPrices(payload.principalId).pipe(Effect.result)
        if (Result.isFailure(hydration)) {
          if (syncPreparation !== undefined)
            yield* calculationRunRepository.failSyncPreparation({
              ...principalScope,
              taxYear,
              preparation: syncPreparation,
              failureCode: "calculation_price_hydration_failed",
            })
          return yield* hydration.failure
        }
        return yield* calculationRunService
          .recompute({
            id: runId,
            ...principalScope,
            taxYear,
            accountingChoices: [],
            ...(syncPreparation === undefined ? {} : { syncPreparation }),
          })
          .pipe(
            Effect.tap((result) =>
              Effect.logInfo(
                {
                  queueName: CALCULATION_RECOMPUTE_QUEUE_NAME,
                  queueJobId: job.id ?? null,
                  workerId: config.workerId,
                  principalId: payload.principalId,
                  runId,
                  taxYear,
                  activated: result.activated,
                },
                "calculation-worker:tax-year-completed"
              )
            )
          )
      }).pipe(Effect.result),
    { concurrency: 1 }
  )
  const failure = outcomes.find(Result.isFailure)
  if (failure !== undefined) return yield* failure.failure
  const results = outcomes.flatMap((outcome) =>
    Result.isSuccess(outcome) ? [outcome.success] : []
  )

  yield* Effect.logInfo(
    {
      queueName: CALCULATION_RECOMPUTE_QUEUE_NAME,
      queueJobId: job.id ?? null,
      workerId: config.workerId,
      principalId: payload.principalId,
      taxYears,
    },
    "calculation-worker:job-completed"
  )

  return results
})

const acquireLiveWorker = (
  config: WorkerBullMqCalculationConsumerConfig,
  processor: WorkerBullMqCalculationProcessor
): Effect.Effect<BullMqCalculationRecomputeWorker, WorkerBullMqCalculationConsumerError> =>
  Effect.gen(function* () {
    const connection = yield* Effect.try({
      try: () => new Redis(config.redisUrl.toString(), { maxRetriesPerRequest: null }),
      catch: (cause) =>
        new WorkerBullMqCalculationConsumerError({
          operation: "workerBullMqCalculationConsumer.acquireConnection",
          cause,
        }),
    })
    const worker = yield* Effect.try({
      try: () => {
        const bullMqProcessor: Processor<
          unknown,
          ReadonlyArray<CalculationRunWriteResult>,
          typeof CALCULATION_RECOMPUTE_JOB_NAME
        > = (
          job: Job<
            unknown,
            ReadonlyArray<CalculationRunWriteResult>,
            typeof CALCULATION_RECOMPUTE_JOB_NAME
          >
        ) => processor(job)

        return new Worker<
          unknown,
          ReadonlyArray<CalculationRunWriteResult>,
          typeof CALCULATION_RECOMPUTE_JOB_NAME
        >(CALCULATION_RECOMPUTE_QUEUE_NAME, bullMqProcessor, {
          connection,
          concurrency: config.concurrency,
          lockDuration: config.lockDurationMs,
          name: config.workerId,
          prefix: config.queuePrefix,
        })
      },
      catch: (cause) =>
        new WorkerBullMqCalculationConsumerError({
          operation: "workerBullMqCalculationConsumer.acquireWorker",
          cause,
        }),
    }).pipe(Effect.tapError(() => Effect.sync(() => connection.disconnect())))

    return {
      close: Effect.tryPromise({
        try: () => worker.close().finally(() => connection.disconnect()),
        catch: (cause) =>
          new WorkerBullMqCalculationConsumerError({
            operation: "workerBullMqCalculationConsumer.close",
            cause,
          }),
      }),
    } satisfies BullMqCalculationRecomputeWorker
  })

const acquireLiveQueue = (
  config: WorkerBullMqCalculationConsumerConfig
): Effect.Effect<BullMqCalculationRecomputeQueue, CalculationRecomputeQueueError> =>
  Effect.gen(function* () {
    const connection = yield* Effect.try({
      try: () => new Redis(config.redisUrl.toString()),
      catch: (cause) =>
        new CalculationRecomputeQueueError({
          operation: "workerCalculationRecomputeQueue.acquireConnection",
          cause,
        }),
    })
    const queue = yield* Effect.try({
      try: () =>
        new Queue<
          CalculationRecomputeQueuePayload,
          ReadonlyArray<CalculationRunWriteResult>,
          typeof CALCULATION_RECOMPUTE_JOB_NAME
        >(CALCULATION_RECOMPUTE_QUEUE_NAME, {
          connection,
          prefix: config.queuePrefix,
        }),
      catch: (cause) =>
        new CalculationRecomputeQueueError({
          operation: "workerCalculationRecomputeQueue.acquireQueue",
          cause,
        }),
    }).pipe(Effect.tapError(() => Effect.sync(() => connection.disconnect())))

    return {
      add: (name, payload, options) => queue.add(name, payload, options),
      close: Effect.tryPromise({
        try: () => queue.close().finally(() => connection.disconnect()),
        catch: (cause) =>
          new CalculationRecomputeQueueError({
            operation: "workerCalculationRecomputeQueue.close",
            cause,
          }),
      }),
    } satisfies BullMqCalculationRecomputeQueue
  })

/** Construct the scoped calculation queue producer. */
export const makeWorkerCalculationRecomputeQueueLive = (
  options: WorkerCalculationRecomputeQueueOptions = {}
) =>
  Layer.effect(
    CalculationRecomputeQueue,
    Effect.gen(function* () {
      const config = yield* loadConfig
      const acquireQueue = options.acquireQueue ?? acquireLiveQueue
      const queue = yield* Effect.acquireRelease(acquireQueue(config), (toClose) =>
        toClose.close.pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              { operation: error.operation, cause: error.cause },
              "calculation-queue:close-failed"
            )
          )
        )
      )

      return CalculationRecomputeQueue.of({
        enqueuePrincipalRecompute: (principalId) =>
          Effect.gen(function* () {
            const payload = yield* decodePayload({ principalId }).pipe(
              Effect.mapError(
                (cause) =>
                  new CalculationRecomputeQueueError({
                    operation: "workerCalculationRecomputeQueue.decode",
                    cause,
                  })
              )
            )

            yield* Effect.tryPromise({
              try: () =>
                queue.add(CALCULATION_RECOMPUTE_JOB_NAME, payload, {
                  attempts: 1,
                  deduplication: { id: principalId, keepLastIfActive: true },
                  removeOnComplete: { count: 1_000 },
                  removeOnFail: { count: 5_000 },
                }),
              catch: (cause) =>
                new CalculationRecomputeQueueError({
                  operation: "workerCalculationRecomputeQueue.enqueue",
                  cause,
                }),
            })
          }).pipe(
            Effect.tap(() =>
              Effect.logInfo(
                { queueName: CALCULATION_RECOMPUTE_QUEUE_NAME, principalId },
                "calculation-queue:enqueued"
              )
            ),
            Effect.asVoid
          ),
      })
    })
  )

/** Live scoped calculation queue producer. */
export const WorkerCalculationRecomputeQueueLive = makeWorkerCalculationRecomputeQueueLive()

/** Construct the BullMQ calculation consumer. */
export const makeWorkerBullMqCalculationConsumerLive = (
  options: WorkerBullMqCalculationConsumerOptions = {}
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const config = yield* loadConfig
      const context = yield* Effect.context<
        | CalculationRunRepository
        | CalculationRunService
        | HistoricalAssetPriceRepository
        | CoinGeckoHistoricalPriceClient
      >()
      const runPromise = Effect.runPromiseWith(context)
      const acquireWorker = options.acquireWorker ?? acquireLiveWorker
      const processor: WorkerBullMqCalculationProcessor = (job) =>
        runPromise(processJob({ job, config }).pipe(Effect.result)).then((result) => {
          if (Result.isSuccess(result)) return result.success

          const error = result.failure
          if (error._tag === "WorkerBullMqMalformedCalculationPayloadError") {
            return runPromise(
              Effect.logError(
                {
                  queueName: CALCULATION_RECOMPUTE_QUEUE_NAME,
                  queueJobId: error.queueJobId,
                  workerId: config.workerId,
                  cause: error.cause,
                },
                "calculation-worker:malformed-payload"
              )
            ).then(() => {
              throw new UnrecoverableError("Malformed calculation queue payload")
            })
          }

          return runPromise(
            Effect.logError(
              {
                queueName: CALCULATION_RECOMPUTE_QUEUE_NAME,
                queueJobId: job.id ?? null,
                workerId: config.workerId,
                error,
              },
              "calculation-worker:job-failed"
            )
          ).then(() => {
            throw toJobFailure(error)
          })
        })

      const worker = yield* Effect.acquireRelease(acquireWorker(config, processor), (toClose) =>
        toClose.close.pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              { operation: error.operation, cause: error.cause },
              "calculation-worker:worker-close-failed"
            )
          )
        )
      )

      yield* Effect.logInfo(
        {
          queueName: CALCULATION_RECOMPUTE_QUEUE_NAME,
          workerId: config.workerId,
          concurrency: config.concurrency,
          lockDurationMs: config.lockDurationMs,
          queuePrefix: config.queuePrefix,
        },
        "calculation-worker:started"
      )

      return worker
    })
  )

/** Live BullMQ calculation consumer. */
export const WorkerBullMqCalculationConsumerLive = makeWorkerBullMqCalculationConsumerLive()
