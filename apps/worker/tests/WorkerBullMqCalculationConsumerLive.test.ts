import { ConfigProvider, DateTime, Effect, Layer, Option, Result, Schema } from "effect"
import { TestClock } from "effect/testing"
import { UnrecoverableError, type JobsOptions } from "bullmq"
import { describe, expect, it } from "@effect/vitest"
import { JurisdictionCode, TaxYear } from "@my/core/accounting"
import { EUR } from "@my/core/currency"
import { PrincipalId } from "@my/core/ownership"
import {
  CalculationRunId,
  CalculationRunAlreadyStoredError,
  CalculationRunRepository,
  CalculationRunService,
  HistoricalAssetPriceRepository,
  InputLedgerRevision,
  ValuationRevision,
  type CalculationRunRepositoryShape,
  type CalculationRunServiceShape,
  type HistoricalAssetPriceRepositoryShape,
} from "@my/persistence/services"
import {
  makeWorkerBullMqCalculationConsumerLive,
  makeWorkerCalculationRecomputeQueueLive,
  type BullMqCalculationRecomputeQueue,
  type BullMqCalculationRecomputeWorker,
  type WorkerBullMqCalculationJob,
  type WorkerBullMqCalculationProcessor,
} from "../src/layers/WorkerBullMqCalculationConsumerLive.ts"
import {
  runCalculationMaintenancePass,
  WorkerCalculationMaintenanceLive,
} from "../src/layers/WorkerCalculationMaintenanceLive.ts"
import {
  CALCULATION_RECOMPUTE_JOB_NAME,
  CalculationRecomputeQueue,
  CalculationRecomputeQueueError,
  CalculationRecomputeQueuePayload,
  CoinGeckoHistoricalPriceClient,
  CoinGeckoHistoricalPriceError,
  type CoinGeckoHistoricalPriceClientShape,
} from "@my/sync-engine/services"

class WorkerTestPromiseRejectionError extends Schema.TaggedError<WorkerTestPromiseRejectionError>()(
  "WorkerTestPromiseRejectionError",
  { cause: Schema.Unknown }
) {}

const principalId = PrincipalId.make("00000000-0000-4000-8000-000000000013")
const otherPrincipalId = PrincipalId.make("00000000-0000-4000-8000-000000000014")

const makeConfigProvider = () =>
  ConfigProvider.fromEnvRecord({
    QUEUE_REDIS_URL: "redis://localhost:6379",
    CALCULATION_QUEUE_PREFIX: "test-prefix",
    CALCULATION_WORKER_CONCURRENCY: "2",
    CALCULATION_MAINTENANCE_INTERVAL_MS: "1000",
    CALCULATION_MAINTENANCE_STALE_AFTER_MS: "5000",
    CALCULATION_MAINTENANCE_BATCH_SIZE: "100",
    WORKER_ID: "worker-test-1",
  })

const makeJob = (data: unknown): WorkerBullMqCalculationJob => ({
  id: "queue-job-1",
  name: CALCULATION_RECOMPUTE_JOB_NAME,
  data,
})

const provideConfig = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(ConfigProvider.ConfigProvider, makeConfigProvider()))

const writeResult = {
  activated: true,
  inputLedgerRevision: InputLedgerRevision.make(`v2:1:1.2.:${"a".repeat(64)}`),
  valuationRevision: ValuationRevision.make(`sha256:${"b".repeat(64)}`),
  status: "complete",
} as const

const emptyHistoricalPriceRepository = HistoricalAssetPriceRepository.of({
  listMissingCoinGeckoDailyEurPriceNeeds: () => Effect.succeed([]),
  upsertCoinGeckoDailyEurPrice: () => Effect.die("unused price upsert"),
})

const unavailableHistoricalPriceClient = CoinGeckoHistoricalPriceClient.of({
  fetchDailyEurPrice: () => Effect.succeed(Option.none()),
})

const emptyCalculationRunRepository = CalculationRunRepository.of({
  fail: () => Effect.die("unused fail"),
  getLatestStatus: () => Effect.die("unused getLatestStatus"),
  getSyncStatus: () => Effect.die("unused getSyncStatus"),
  listActiveTaxYears: () => Effect.succeed([]),
  persist: () => Effect.die("unused persist"),
  settleStaleAndFindRecomputePrincipals: () => Effect.die("unused maintenance"),
  start: () => Effect.die("unused start"),
})

const withCalculationConsumer = <A>({
  effect,
  service,
  acquireWorker,
  historicalPriceRepository = emptyHistoricalPriceRepository,
  historicalPriceClient = unavailableHistoricalPriceClient,
  calculationRunRepository = emptyCalculationRunRepository,
}: {
  readonly effect: Effect.Effect<A>
  readonly service: CalculationRunServiceShape
  readonly historicalPriceRepository?: HistoricalAssetPriceRepositoryShape
  readonly historicalPriceClient?: CoinGeckoHistoricalPriceClientShape
  readonly calculationRunRepository?: CalculationRunRepositoryShape
  readonly acquireWorker: (
    processor: WorkerBullMqCalculationProcessor
  ) => Effect.Effect<BullMqCalculationRecomputeWorker>
}) =>
  Effect.scoped(
    effect.pipe(
      Effect.provide(
        makeWorkerBullMqCalculationConsumerLive({
          acquireWorker: (_config, processor) => acquireWorker(processor),
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(
                CalculationRunRepository,
                CalculationRunRepository.of(calculationRunRepository)
              ),
              Layer.succeed(CalculationRunService, CalculationRunService.of(service)),
              Layer.succeed(
                HistoricalAssetPriceRepository,
                HistoricalAssetPriceRepository.of(historicalPriceRepository)
              ),
              Layer.succeed(
                CoinGeckoHistoricalPriceClient,
                CoinGeckoHistoricalPriceClient.of(historicalPriceClient)
              )
            )
          )
        )
      ),
      provideConfig
    )
  )

const makeMaintenanceRepository = (
  settleStaleAndFindRecomputePrincipals: CalculationRunRepositoryShape["settleStaleAndFindRecomputePrincipals"]
) =>
  CalculationRunRepository.of({
    fail: () => Effect.die("unused fail"),
    getLatestStatus: () => Effect.die("unused getLatestStatus"),
    getSyncStatus: () => Effect.die("unused getSyncStatus"),
    listActiveTaxYears: () => Effect.die("unused listActiveTaxYears"),
    settleStaleAndFindRecomputePrincipals,
    persist: () => Effect.die("unused persist"),
    start: () => Effect.die("unused start"),
  })

describe("WorkerCalculationRecomputeQueueLive", () => {
  it.effect(
    "asks BullMQ to coalesce concurrent requests and retain one trailing active request",
    () =>
      Effect.gen(function* () {
        const additions: Array<{
          payload: CalculationRecomputeQueuePayload
          options: JobsOptions
        }> = []
        const queue: BullMqCalculationRecomputeQueue = {
          add: (_name, payload, options) => {
            additions.push({ payload, options })
            return Promise.resolve({ id: `job-${additions.length}` })
          },
          close: Effect.void,
        }

        yield* Effect.scoped(
          Effect.gen(function* () {
            const recomputeQueue = yield* CalculationRecomputeQueue
            yield* Effect.all(
              [
                recomputeQueue.enqueuePrincipalRecompute(principalId),
                recomputeQueue.enqueuePrincipalRecompute(principalId),
                recomputeQueue.enqueuePrincipalRecompute(principalId),
              ],
              { concurrency: "unbounded" }
            )
          }).pipe(
            Effect.provide(
              makeWorkerCalculationRecomputeQueueLive({ acquireQueue: () => Effect.succeed(queue) })
            ),
            provideConfig
          )
        )

        expect(additions).toHaveLength(3)
        expect(additions.map(({ payload }) => payload)).toEqual([
          CalculationRecomputeQueuePayload.make({ principalId }),
          CalculationRecomputeQueuePayload.make({ principalId }),
          CalculationRecomputeQueuePayload.make({ principalId }),
        ])
        for (const { options } of additions) {
          expect(options.jobId).toBeUndefined()
          expect(options.deduplication).toEqual({ id: principalId, keepLastIfActive: true })
        }
      })
  )
})

describe("WorkerCalculationMaintenanceLive", () => {
  it.effect("retries a failed request and continues enqueueing healthy principals", () =>
    Effect.gen(function* () {
      const requested: Array<string> = []
      let firstRequestFails = true
      const repository = makeMaintenanceRepository(() =>
        Effect.succeed({
          failedStaleRuns: 1,
          principalIds: [principalId, otherPrincipalId],
        })
      )
      const queue = CalculationRecomputeQueue.of({
        enqueuePrincipalRecompute: (requestedPrincipalId) =>
          Effect.gen(function* () {
            requested.push(requestedPrincipalId)
            if (requestedPrincipalId === principalId && firstRequestFails) {
              firstRequestFails = false
              return yield* new CalculationRecomputeQueueError({
                operation: "test.enqueue",
                cause: "forced queue failure",
              })
            }
          }),
      })
      const pass = runCalculationMaintenancePass({
        staleBefore: DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")),
        limit: 100,
      }).pipe(
        Effect.provide(
          Layer.merge(
            Layer.succeed(CalculationRunRepository, repository),
            Layer.succeed(CalculationRecomputeQueue, queue)
          )
        )
      )

      const first = yield* pass
      const retry = yield* pass

      expect(requested).toEqual([principalId, otherPrincipalId, principalId, otherPrincipalId])
      expect(first).toEqual({
        failedStaleRuns: 1,
        requestedRecomputes: 1,
        failedRequests: 1,
      })
      expect(retry).toEqual({
        failedStaleRuns: 1,
        requestedRecomputes: 2,
        failedRequests: 0,
      })
    })
  )

  it.effect("runs once at startup and again on the configured interval", () =>
    Effect.gen(function* () {
      let passes = 0
      const repository = makeMaintenanceRepository(() =>
        Effect.sync(() => {
          passes += 1
          return { failedStaleRuns: 0, principalIds: [] }
        })
      )
      const queue = CalculationRecomputeQueue.of({
        enqueuePrincipalRecompute: () => Effect.void,
      })

      yield* Effect.scoped(
        Effect.gen(function* () {
          expect(passes).toBe(1)
          yield* TestClock.adjust("1 second")
          yield* Effect.yieldNow
          expect(passes).toBe(2)
        }).pipe(
          Effect.provide(
            WorkerCalculationMaintenanceLive.pipe(
              Layer.provide(Layer.succeed(CalculationRunRepository, repository)),
              Layer.provide(Layer.succeed(CalculationRecomputeQueue, queue))
            )
          ),
          provideConfig
        )
      )
    })
  )
})

describe("WorkerBullMqCalculationConsumerLive", () => {
  it.effect("stores available daily prices before recomputing and tolerates fetch failure", () =>
    Effect.gen(function* () {
      let processor: WorkerBullMqCalculationProcessor | null = null
      const steps: Array<string> = []
      const firstSnapshot = DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-04T00:00:00.000Z"))
      const secondSnapshot = DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-05T00:00:00.000Z"))
      const historicalPriceRepository = HistoricalAssetPriceRepository.of({
        listMissingCoinGeckoDailyEurPriceNeeds: () =>
          Effect.sync(() => {
            steps.push("list")
            return [
              {
                assetId: "asset-sol",
                coingeckoCoinId: "solana",
                snapshotAt: firstSnapshot,
              },
              {
                assetId: "asset-missing",
                coingeckoCoinId: "missing-coin",
                snapshotAt: secondSnapshot,
              },
            ]
          }),
        upsertCoinGeckoDailyEurPrice: ({ assetId, price }) =>
          Effect.sync(() => {
            steps.push(`store:${assetId}:${price}`)
          }),
      })
      const historicalPriceClient = CoinGeckoHistoricalPriceClient.of({
        fetchDailyEurPrice: ({ coinId }) =>
          Effect.sync(() => {
            steps.push(`fetch:${coinId}`)
          }).pipe(
            Effect.flatMap(() =>
              coinId === "solana"
                ? Effect.succeed(Option.some("128.375"))
                : Effect.fail(
                    new CoinGeckoHistoricalPriceError({
                      coinId,
                      date: "2025-03-05",
                      status: 503,
                      cause: "forced upstream failure",
                    })
                  )
            )
          ),
      })
      const service = CalculationRunService.of({
        recompute: () =>
          Effect.sync(() => {
            steps.push("recompute")
            return writeResult
          }),
      })

      yield* withCalculationConsumer({
        service,
        historicalPriceRepository,
        historicalPriceClient,
        acquireWorker: (acquiredProcessor) =>
          Effect.sync(() => {
            processor = acquiredProcessor
            return { close: Effect.void }
          }),
        effect: Effect.gen(function* () {
          if (processor === null) {
            return yield* Effect.die(new Error("Processor was not acquired"))
          }
          const acquiredProcessor = processor
          yield* Effect.promise(() =>
            acquiredProcessor(makeJob(CalculationRecomputeQueuePayload.make({ principalId })))
          )
        }),
      })

      expect(steps).toEqual([
        "list",
        "fetch:solana",
        "store:asset-sol:128.375",
        "fetch:missing-coin",
        "recompute",
      ])
    })
  )

  it.effect("recomputes the principal for the current German scope", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-09-01T12:00:00.000Z"))
      let processor: WorkerBullMqCalculationProcessor | null = null
      const recomputes: Array<Parameters<CalculationRunServiceShape["recompute"]>[0]> = []
      const service = CalculationRunService.of({
        recompute: (params) =>
          Effect.sync(() => {
            recomputes.push(params)
            return writeResult
          }),
      })

      yield* withCalculationConsumer({
        service,
        acquireWorker: (acquiredProcessor) =>
          Effect.sync(() => {
            processor = acquiredProcessor
            return { close: Effect.void }
          }),
        effect: Effect.gen(function* () {
          if (processor === null) {
            return yield* Effect.die(new Error("Processor was not acquired"))
          }
          const acquiredProcessor = processor
          yield* Effect.promise(() =>
            acquiredProcessor(makeJob(CalculationRecomputeQueuePayload.make({ principalId })))
          )
        }),
      })

      expect(recomputes).toHaveLength(1)
      expect(recomputes[0]).toMatchObject({
        principalId,
        jurisdiction: JurisdictionCode.make("DE"),
        reportingCurrency: EUR,
        accountingChoices: [],
      })
      expect(CalculationRunId.make(recomputes[0]?.id ?? "")).toBe(recomputes[0]?.id)
      expect(recomputes[0]?.taxYear).toBe(TaxYear.make(2026))
    })
  )

  it.effect("recomputes earlier active German tax years as well as the current year", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-09-01T12:00:00.000Z"))
      let processor: WorkerBullMqCalculationProcessor | null = null
      const taxYears: Array<TaxYear> = []
      const service = CalculationRunService.of({
        recompute: ({ taxYear }) =>
          Effect.sync(() => {
            taxYears.push(taxYear)
            return writeResult
          }),
      })
      const repository = CalculationRunRepository.of({
        fail: () => Effect.die("unused fail"),
        getLatestStatus: () => Effect.die("unused getLatestStatus"),
        getSyncStatus: () => Effect.die("unused getSyncStatus"),
        listActiveTaxYears: () =>
          Effect.succeed([TaxYear.make(2022), TaxYear.make(2024), TaxYear.make(2026)]),
        persist: () => Effect.die("unused persist"),
        settleStaleAndFindRecomputePrincipals: () => Effect.die("unused maintenance"),
        start: () => Effect.die("unused start"),
      })

      yield* withCalculationConsumer({
        service,
        calculationRunRepository: repository,
        acquireWorker: (acquiredProcessor) =>
          Effect.sync(() => {
            processor = acquiredProcessor
            return { close: Effect.void }
          }),
        effect: Effect.gen(function* () {
          if (processor === null) {
            return yield* Effect.die(new Error("Processor was not acquired"))
          }
          const acquiredProcessor = processor
          yield* Effect.promise(() =>
            acquiredProcessor(makeJob(CalculationRecomputeQueuePayload.make({ principalId })))
          )
        }),
      })

      expect(taxYears).toEqual([TaxYear.make(2022), TaxYear.make(2024), TaxYear.make(2026)])
    })
  )

  it.effect("rejects malformed payloads without invoking the calculation service", () =>
    Effect.gen(function* () {
      let processor: WorkerBullMqCalculationProcessor | null = null
      let recomputeCount = 0
      const service = CalculationRunService.of({
        recompute: () =>
          Effect.sync(() => {
            recomputeCount += 1
            return writeResult
          }),
      })

      yield* withCalculationConsumer({
        service,
        acquireWorker: (acquiredProcessor) =>
          Effect.sync(() => {
            processor = acquiredProcessor
            return { close: Effect.void }
          }),
        effect: Effect.gen(function* () {
          if (processor === null) {
            return yield* Effect.die(new Error("Processor was not acquired"))
          }
          const acquiredProcessor = processor
          const result = yield* Effect.tryPromise({
            try: () => acquiredProcessor(makeJob({ principalId: "not-a-uuid" })),
            catch: (cause) => new WorkerTestPromiseRejectionError({ cause }),
          }).pipe(Effect.result)

          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result)) {
            expect(result.failure.cause).toBeInstanceOf(UnrecoverableError)
          }
        }),
      })

      expect(recomputeCount).toBe(0)
    })
  )

  it.effect("reads the German tax year after hydration crosses New Year", () =>
    Effect.gen(function* () {
      let processor: WorkerBullMqCalculationProcessor | null = null
      const steps: Array<string> = []
      const taxYears: Array<TaxYear> = []
      const historicalPriceRepository = HistoricalAssetPriceRepository.of({
        listMissingCoinGeckoDailyEurPriceNeeds: () =>
          Effect.gen(function* () {
            steps.push("hydrate")
            yield* TestClock.setTime(Date.parse("2025-12-31T23:00:00.000Z"))
            return []
          }),
        upsertCoinGeckoDailyEurPrice: () => Effect.die("unused price upsert"),
      })
      const service = CalculationRunService.of({
        recompute: ({ taxYear }) =>
          Effect.sync(() => {
            steps.push("recompute")
            taxYears.push(taxYear)
            return writeResult
          }),
      })

      yield* TestClock.setTime(Date.parse("2025-12-31T22:59:59.000Z"))
      yield* withCalculationConsumer({
        service,
        historicalPriceRepository,
        acquireWorker: (acquiredProcessor) =>
          Effect.sync(() => {
            processor = acquiredProcessor
            return { close: Effect.void }
          }),
        effect: Effect.gen(function* () {
          if (processor === null) {
            return yield* Effect.die(new Error("Processor was not acquired"))
          }
          const acquiredProcessor = processor
          yield* Effect.promise(() =>
            acquiredProcessor(makeJob(CalculationRecomputeQueuePayload.make({ principalId })))
          )
        }),
      })

      expect(steps).toEqual(["hydrate", "recompute"])
      expect(taxYears).toEqual([TaxYear.make(2026)])
    })
  )

  it.effect("reports calculation execution failure only through the calculation job", () =>
    Effect.gen(function* () {
      let processor: WorkerBullMqCalculationProcessor | null = null
      const runId = CalculationRunId.make("00000000-0000-4000-8000-000000000014")
      const service = CalculationRunService.of({
        recompute: () => Effect.fail(new CalculationRunAlreadyStoredError({ runId })),
      })

      yield* withCalculationConsumer({
        service,
        acquireWorker: (acquiredProcessor) =>
          Effect.sync(() => {
            processor = acquiredProcessor
            return { close: Effect.void }
          }),
        effect: Effect.gen(function* () {
          if (processor === null) {
            return yield* Effect.die(new Error("Processor was not acquired"))
          }
          const acquiredProcessor = processor
          const result = yield* Effect.tryPromise({
            try: () =>
              acquiredProcessor(makeJob(CalculationRecomputeQueuePayload.make({ principalId }))),
            catch: (cause) => new WorkerTestPromiseRejectionError({ cause }),
          }).pipe(Effect.result)

          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result)) {
            expect(result.failure.cause).toBeInstanceOf(CalculationRunAlreadyStoredError)
          }
        }),
      })
    })
  )
})
