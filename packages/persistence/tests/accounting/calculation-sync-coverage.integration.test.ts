import { beforeEach, describe, expect, it } from "@effect/vitest"
import { JurisdictionCode, TaxYear } from "@my/core/accounting"
import { CurrencyCode } from "@my/core/currency"
import { PrincipalId } from "@my/core/ownership"
import { SourceId } from "@my/core/source"
import { PrincipalClaimRepositoryLive } from "../../src/layers/PrincipalClaimRepositoryLive.ts"
import { PrincipalClaimRepository } from "../../src/services/PrincipalClaimRepository.ts"
import {
  SourceSyncJobRepository,
  CalculationRecomputeQueue,
  CalculationRecomputeQueueError,
  CoinGeckoHistoricalPriceClient,
  CALCULATION_RECOMPUTE_JOB_NAME,
} from "@my/sync-engine/services"
import { HistoricalAssetPriceRepository } from "../../src/services/HistoricalAssetPriceRepository.ts"
import { ConfigProvider, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import {
  makeWorkerBullMqCalculationConsumerLive,
  type WorkerBullMqCalculationProcessor,
} from "../../../../apps/worker/src/layers/WorkerBullMqCalculationConsumerLive.ts"
import { runCalculationMaintenancePass } from "../../../../apps/worker/src/layers/WorkerCalculationMaintenanceLive.ts"
import { eq, sql } from "drizzle-orm"
import * as BigDecimal from "effect/BigDecimal"
import * as DateTime from "effect/DateTime"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Exit from "effect/Exit"
import { PersistenceError } from "../../src/errors/RepositoryError.ts"
import * as Layer from "effect/Layer"
import { vi } from "vitest"
import { CalculationRunRepositoryLive } from "../../src/layers/CalculationRunRepositoryLive.ts"
import { CalculationRunServiceLive } from "../../src/layers/CalculationRunServiceLive.ts"
import { FactualLedgerRepositoryLive } from "../../src/layers/FactualLedgerRepositoryLive.ts"
import { SourceSyncJobRepositoryLive } from "../../src/layers/SourceSyncJobRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  CalculationRunId,
  CalculationSyncRequestId,
  CalculationRunRepository,
  type CalculationRunRepositoryShape,
} from "../../src/services/CalculationRunRepository.ts"
import { CalculationRunService } from "../../src/services/CalculationRunService.ts"
import { FactualLedgerRepository } from "../../src/services/FactualLedgerRepository.ts"
import { prepareMovementLegFixtures } from "../support/movement-leg-fixtures.ts"
import {
  TEST_BTC_ASSET_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const TEST_PRINCIPAL_ID = "00000000-0000-4000-8000-000000000183"
const TEST_SOURCE_ID = "00000000-0000-4000-8000-000000000281"

const context = makeIntegrationTestDatabaseContext({ databaseNamePrefix: "taxmaxi_sync_coverage" })
const runPg = context.runPg
const R0 = CalculationRunId.make("00000000-0000-4000-8000-000000000910")
const R1 = CalculationRunId.make("00000000-0000-4000-8000-000000000911")
const R2 = CalculationRunId.make("00000000-0000-4000-8000-000000000912")
const scope = {
  principalId: PrincipalId.make(TEST_PRINCIPAL_ID),
  jurisdiction: JurisdictionCode.make("DE"),
  taxYear: TaxYear.make(2026),
  reportingCurrency: CurrencyCode.make("EUR"),
}
const serviceLayer = CalculationRunServiceLive.pipe(
  Layer.provide(Layer.merge(CalculationRunRepositoryLive, FactualLedgerRepositoryLive))
)
const recomputeEffect = (id: CalculationRunId) =>
  Effect.flatMap(CalculationRunService, (service) =>
    service.recompute({ ...scope, id, accountingChoices: [] })
  )
const recompute = (id: CalculationRunId) =>
  Effect.runPromise(context.runWithLayer({ effect: recomputeEffect(id), layer: serviceLayer }))
const readStatus = (sourceJobId?: string) =>
  Effect.runPromise(
    context.runWithLayer({
      layer: CalculationRunRepositoryLive,
      effect: Effect.flatMap(CalculationRunRepository, (repository) =>
        repository.getSyncStatus({
          ...scope,
          ...(sourceJobId === undefined ? {} : { sourceJobId }),
        })
      ),
    })
  )
const completeJob = ({
  sourceId = TEST_SOURCE_ID,
  principalId = TEST_PRINCIPAL_ID,
}: { readonly sourceId?: string; readonly principalId?: string } = {}) =>
  Effect.runPromise(
    context.runWithLayer({
      layer: SourceSyncJobRepositoryLive,
      effect: Effect.gen(function* () {
        const repository = yield* SourceSyncJobRepository
        const job = yield* repository.createOrReuseJob({
          sourceId,
          principalId,
          mode: "sync",
          maxAttempts: 3,
        })
        yield* repository.claimJob({
          jobId: job.id,
          workerId: "joined-proof",
          startedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-02-01T00:00:00Z")),
        })
        // Completion records the Berlin year when its Effect is constructed.
        const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-02-01T00:00:00Z"))
        const completion = repository.completeJob({
          jobId: job.id,
          state: {
            phase: "completed",
            processedRecords: 0,
            totalRecords: 0,
            fetchedRecords: 0,
            normalizedRecords: 0,
            failedRecords: 0,
            cursorPayload: null,
            highWatermark: null,
            checkpointExternalId: null,
            checkpointRawRecordId: null,
          },
        })
        clock.mockRestore()
        yield* completion
        return job.id
      }),
    })
  )
const capturedIds = (runId: CalculationRunId) =>
  runPg(
    Effect.flatMap(drizzle, (db) =>
      db
        .select({ requestId: schema.calculationRunSyncRequests.requestId })
        .from(schema.calculationRunSyncRequests)
        .where(eq(schema.calculationRunSyncRequests.runId, runId))
    )
  )

// Only queue acquisition and external price I/O are controlled; calculations and storage stay real.
const withWorker = <A, E, R>(
  use: (processor: WorkerBullMqCalculationProcessor) => Effect.Effect<A, E, R>,
  options: {
    readonly priceNeeds?: ReturnType<
      typeof HistoricalAssetPriceRepository.of
    >["listMissingCoinGeckoDailyEurPriceNeeds"]
    readonly wrapRepository?: (
      repository: CalculationRunRepositoryShape
    ) => CalculationRunRepositoryShape
    readonly ledgerLayer?: typeof FactualLedgerRepositoryLive
  } = {}
) =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<WorkerBullMqCalculationProcessor>()
    const repositoryLayer = Layer.effect(
      CalculationRunRepository,
      Effect.map(
        CalculationRunRepository,
        (repository) => options.wrapRepository?.(repository) ?? repository
      )
    ).pipe(Layer.provide(CalculationRunRepositoryLive))
    const dependencies = Layer.mergeAll(
      repositoryLayer,
      CalculationRunServiceLive.pipe(
        Layer.provide(
          Layer.merge(repositoryLayer, options.ledgerLayer ?? FactualLedgerRepositoryLive)
        )
      ),
      Layer.succeed(
        HistoricalAssetPriceRepository,
        HistoricalAssetPriceRepository.of({
          listMissingCoinGeckoDailyEurPriceNeeds: options.priceNeeds ?? (() => Effect.succeed([])),
          upsertCoinGeckoDailyEurPrice: () => Effect.die("No price needs in this fixture"),
        })
      ),
      Layer.succeed(
        CoinGeckoHistoricalPriceClient,
        CoinGeckoHistoricalPriceClient.of({
          fetchDailyEurPrice: () => Effect.succeed(Option.none()),
        })
      )
    )
    const workerLayer = makeWorkerBullMqCalculationConsumerLive({
      acquireWorker: (_config, processor) =>
        Deferred.succeed(ready, processor).pipe(Effect.as({ close: Effect.void })),
    }).pipe(Layer.provide(dependencies), Layer.fresh)
    return yield* Effect.scoped(
      Deferred.await(ready).pipe(
        Effect.flatMap(use),
        Effect.provide(workerLayer.pipe(Layer.provide(context.TestPgClientLive))),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({ QUEUE_REDIS_URL: "redis://localhost:6379" })
        )
      )
    )
  })
const deliver = (processor: WorkerBullMqCalculationProcessor) =>
  Effect.tryPromise({
    try: () =>
      processor({ name: CALCULATION_RECOMPUTE_JOB_NAME, data: { principalId: scope.principalId } }),
    catch: (cause) => new PersistenceError({ operation: "joined.worker", cause }),
  })
const maintenance = (
  queue: ReturnType<typeof CalculationRecomputeQueue.of>,
  staleBefore = DateTime.toDateUtc(DateTime.makeUnsafe("2000-01-01T00:00:00Z"))
) =>
  context.runWithLayer({
    layer: Layer.merge(
      CalculationRunRepositoryLive,
      Layer.succeed(CalculationRecomputeQueue, queue)
    ),
    effect: runCalculationMaintenancePass({ staleBefore, limit: 100 }),
  })
const repositoryEffect = <A, E>(
  use: (repository: CalculationRunRepositoryShape) => Effect.Effect<A, E>
) =>
  context.runWithLayer({
    layer: CalculationRunRepositoryLive,
    effect: Effect.flatMap(CalculationRunRepository, use),
  })
const statusForYear = (taxYear: number, sourceJobId: string) =>
  repositoryEffect((repository) =>
    repository.getSyncStatus({ ...scope, taxYear: TaxYear.make(taxYear), sourceJobId })
  )

// Size-limit fixture: each queued request explicitly belongs to its own completed job.
// Joined acceptance tests use completeJob; this isolates repository bulk I/O.
const seedManyAcceptedRequests = () =>
  runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const acceptedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-02-01T00:00:00Z"))
      const pairs = Array.from({ length: 8200 }, (_, index) => ({
        jobId: `00000000-0000-4000-8001-${index.toString(16).padStart(12, "0")}`,
        requestId: `00000000-0000-4000-9001-${index.toString(16).padStart(12, "0")}`,
      }))
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const records = yield* Schema.encodeEffect(
            Schema.fromJsonString(
              Schema.Array(Schema.Struct({ jobId: Schema.String, requestId: Schema.String }))
            )
          )(pairs)
          yield* tx.execute(sql`
            INSERT INTO processing_jobs (id, source_id, principal_id, status, completed_at)
            SELECT pair."jobId", ${TEST_SOURCE_ID}::uuid, ${scope.principalId}::uuid, 'completed', ${acceptedAt.toISOString()}::timestamp
            FROM jsonb_to_recordset(${records}::jsonb) AS pair("jobId" uuid, "requestId" uuid)
          `)
          yield* tx.execute(sql`
            INSERT INTO calculation_sync_requests (id, source_id, principal_id, source_job_id, jurisdiction, tax_year, reporting_currency, status, requested_at)
            SELECT pair."requestId", ${TEST_SOURCE_ID}::uuid, ${scope.principalId}::uuid, pair."jobId", ${scope.jurisdiction}, ${scope.taxYear}, ${scope.reportingCurrency}, 'queued', ${acceptedAt.toISOString()}::timestamptz
            FROM jsonb_to_recordset(${records}::jsonb) AS pair("jobId" uuid, "requestId" uuid)
          `)
        })
      )
      // Give FK lookups current statistics after this synthetic bulk insert.
      // Otherwise the empty-table estimate favors scanning every request in the scope.
      yield* db.execute(sql`ANALYZE calculation_sync_requests`)
      return pairs.map((pair) => pair.requestId)
    })
  )

// Clone the migrated template once; beforeEach then clears its seeded assets before our fixtures.
await Effect.runPromise(context.recreateTestDatabase())
beforeEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* context.recreateTestDatabase()
      const fixture = yield* Effect.promise(() =>
        runPg(
          seedSyncEngineRepositoryFixture({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
          })
        )
      )
      yield* Effect.promise(() => runPg(seedSyncEngineAssets(fixture)))
    })
  )
)

describe("completed sync through accounting snapshot and shared status", () => {
  it.effect(
    "a claimed anonymous source cannot resurrect a deleted run through late finalization",
    () =>
      Effect.gen(function* () {
        const claimedSourceId = SourceId.make("00000000-0000-4000-8000-000000000291")
        const targetPrincipalId = PrincipalId.make("00000000-0000-4000-8000-000000000193")
        const targetSourceId = "00000000-0000-4000-8000-000000000293"
        const claimRequestId = "00000000-0000-4000-8000-000000000294"
        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db
                .update(schema.principals)
                .set({ kind: "anonymous_wallet", userId: null })
                .where(eq(schema.principals.id, TEST_PRINCIPAL_ID))
              yield* seedSyncEngineRepositoryFixture({
                principalId: targetPrincipalId,
                sourceId: targetSourceId,
                userId: "00000000-0000-4000-8000-000000000194",
              })
              yield* db
                .update(schema.cexAccount)
                .set({ providerAccountId: "target-account" })
                .where(eq(schema.cexAccount.principalId, targetPrincipalId))
              const [address] = yield* db
                .insert(schema.addresses)
                .values({
                  principalId: TEST_PRINCIPAL_ID,
                  address: "bc1qsynthetic-claim-late-finalization",
                  type: "bitcoin",
                  name: "Claim source A",
                })
                .returning({ id: schema.addresses.id })
              if (address === undefined) return yield* Effect.die("Missing source A address")
              yield* db.insert(schema.sources).values({
                id: claimedSourceId,
                principalId: TEST_PRINCIPAL_ID,
                name: "Source A",
                providerKey: "bitcoin",
                sourceableType: "onchain",
                addressId: address.id,
              })
              yield* db.insert(schema.principalClaims).values({
                principalId: TEST_PRINCIPAL_ID,
                sourceId: claimedSourceId,
                requestId: claimRequestId,
                claimType: "cli_claim_token",
                claimValueHash: "joined-late-finalization-claim",
                chainType: "bitcoin",
                walletAddress: "bc1qsynthetic-claim-late-finalization",
                year: 2026,
                jurisdiction: "germany",
              })
              yield* db.insert(schema.principalClaims).values({
                principalId: TEST_PRINCIPAL_ID,
                sourceId: claimedSourceId,
                requestId: claimRequestId,
                claimType: "x402_receipt",
                claimValueHash: "joined-late-finalization-receipt",
                chainType: "bitcoin",
                walletAddress: "bc1qsynthetic-claim-late-finalization",
                year: 2026,
                jurisdiction: "germany",
              })
            })
          )
        )
        const retainedJob = yield* Effect.promise(() => completeJob())
        yield* Effect.promise(() =>
          completeJob({ sourceId: targetSourceId, principalId: targetPrincipalId })
        )
        const services = yield* Effect.context<never>()
        const targetStatus = () =>
          Effect.runPromiseWith(services)(
            context.runWithLayer({
              layer: CalculationRunRepositoryLive,
              effect: Effect.flatMap(CalculationRunRepository, (repository) =>
                repository.getSyncStatus({ ...scope, principalId: targetPrincipalId })
              ),
            })
          )
        const targetBefore = yield* Effect.promise(targetStatus)
        const reachedPersist = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const repositoryLayer = Layer.effect(
          CalculationRunRepository,
          Effect.map(CalculationRunRepository, (repository) =>
            CalculationRunRepository.of({
              ...repository,
              persist: (params) =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(reachedPersist, undefined)
                  yield* Deferred.await(release)
                  return yield* repository.persist(params)
                }),
            })
          )
        ).pipe(Layer.provide(CalculationRunRepositoryLive))
        const layer = CalculationRunServiceLive.pipe(
          Layer.provide(Layer.merge(repositoryLayer, FactualLedgerRepositoryLive))
        )
        const running = yield* Effect.forkChild(
          Effect.exit(context.runWithLayer({ layer, effect: recomputeEffect(R1) }))
        )
        yield* Deferred.await(reachedPersist)
        expect((yield* Effect.promise(() => readStatus(retainedJob))).jobs[0]?.work).toMatchObject({
          status: "running",
          attempts: [{ runId: R1, status: "running" }],
        })
        yield* context.runWithLayer({
          layer: PrincipalClaimRepositoryLive,
          effect: Effect.flatMap(PrincipalClaimRepository, (repository) =>
            repository.claimAnonymousSourceForUser({
              anonymousPrincipalId: scope.principalId,
              userPrincipalId: targetPrincipalId,
              sourceId: claimedSourceId,
              requestId: claimRequestId,
              claimValueHash: "joined-late-finalization-claim",
            })
          ),
        })
        expect((yield* Effect.promise(() => readStatus(retainedJob))).jobs[0]?.work).toMatchObject({
          status: "queued",
          attempts: [],
        })
        yield* Deferred.succeed(release, undefined)
        expect(Exit.isFailure(yield* Fiber.join(running))).toBe(true)
        const evidence = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const runs = yield* db
                .select({ id: schema.calculationRuns.id })
                .from(schema.calculationRuns)
                .where(eq(schema.calculationRuns.id, R1))
              const captures = yield* db
                .select({ runId: schema.calculationRunSyncCaptures.runId })
                .from(schema.calculationRunSyncCaptures)
                .where(eq(schema.calculationRunSyncCaptures.runId, R1))
              const attempts = yield* db
                .select({ id: schema.calculationSyncAttempts.id })
                .from(schema.calculationSyncAttempts)
                .where(eq(schema.calculationSyncAttempts.runId, R1))
              return { runs, captures, attempts }
            })
          )
        )
        expect(evidence).toEqual({ runs: [], captures: [], attempts: [] })
        expect(yield* Effect.promise(() => capturedIds(R1))).toEqual([])
        expect((yield* Effect.promise(() => readStatus(retainedJob))).jobs[0]?.work).toMatchObject({
          status: "queued",
          attempts: [],
        })
        expect(yield* Effect.promise(targetStatus)).toEqual(targetBefore)
      })
  )

  it.effect("running and failed attempts cannot cover a job; retry keeps their history", () =>
    Effect.gen(function* () {
      const job = yield* Effect.promise(() => completeJob())
      const reachedPersist = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const repositoryLayer = Layer.effect(
        CalculationRunRepository,
        Effect.map(CalculationRunRepository, (repository) =>
          CalculationRunRepository.of({
            ...repository,
            persist: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(reachedPersist, undefined)
                yield* Deferred.await(release)
                return yield* new PersistenceError({
                  operation: "synthetic.persist.failure",
                  cause: "injected storage failure",
                })
              }),
          })
        )
      ).pipe(Layer.provide(CalculationRunRepositoryLive))
      const layer = CalculationRunServiceLive.pipe(
        Layer.provide(Layer.merge(repositoryLayer, FactualLedgerRepositoryLive))
      )
      const running = yield* Effect.forkChild(
        Effect.exit(context.runWithLayer({ layer, effect: recomputeEffect(R1) }))
      )
      yield* Deferred.await(reachedPersist)
      expect((yield* Effect.promise(() => readStatus(job))).jobs[0]).toMatchObject({
        coveringRun: null,
        work: { status: "running", attempts: [{ runId: R1, status: "running" }] },
      })
      yield* Deferred.succeed(release, undefined)
      expect(Exit.isFailure(yield* Fiber.join(running))).toBe(true)
      const failed = yield* Effect.promise(() => readStatus(job))
      expect(failed.jobs[0]).toMatchObject({
        coveringRun: null,
        work: {
          status: "failed",
          attempts: [{ runId: R1, status: "failed", failureCode: "calculation_failed" }],
        },
      })
      yield* Effect.promise(() => recompute(R2))
      const retried = yield* Effect.promise(() => readStatus(job))
      expect(retried.jobs[0]).toMatchObject({
        activeCoverage: "covered",
        work: {
          status: "succeeded",
          attempts: [
            { runId: R1, status: "failed" },
            { runId: R2, status: "succeeded" },
          ],
        },
      })
    })
  )

  it.effect("an older finalized run does not replace the newer active result", () =>
    Effect.gen(function* () {
      const job = yield* Effect.promise(() => completeJob())
      const reachedPersist = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const repositoryLayer = Layer.effect(
        CalculationRunRepository,
        Effect.map(CalculationRunRepository, (repository) =>
          CalculationRunRepository.of({
            ...repository,
            persist: (params) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(reachedPersist, undefined)
                yield* Deferred.await(release)
                return yield* repository.persist(params)
              }),
          })
        )
      ).pipe(Layer.provide(CalculationRunRepositoryLive))
      const layer = CalculationRunServiceLive.pipe(
        Layer.provide(Layer.merge(repositoryLayer, FactualLedgerRepositoryLive))
      )
      const running = yield* Effect.forkChild(
        context.runWithLayer({ layer, effect: recomputeEffect(R1) })
      )
      yield* Deferred.await(reachedPersist)
      yield* Effect.promise(() => recompute(R2))
      const newer = yield* Effect.promise(() => readStatus(job))
      expect(newer.activeRun?.runId).toBe(R2)
      expect(newer.jobs[0]?.work?.attempts).toMatchObject([{ runId: R1, status: "running" }])
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(running)).activated).toBe(false)
      expect((yield* Effect.promise(() => readStatus(job))).activeRun).toEqual(newer.activeRun)
      expect(yield* Effect.promise(() => capturedIds(R1))).toEqual(
        yield* Effect.promise(() => capturedIds(R2))
      )
    })
  )

  it.effect(
    "a finalized covering run cannot certify the active result when activation is withheld",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => recompute(R0))
        const job = yield* Effect.promise(() => completeJob())
        const reachedPersist = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const repositoryLayer = Layer.effect(
          CalculationRunRepository,
          Effect.map(CalculationRunRepository, (repository) =>
            CalculationRunRepository.of({
              ...repository,
              persist: (params) =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(reachedPersist, undefined)
                  yield* Deferred.await(release)
                  return yield* repository.persist(params)
                }),
            })
          )
        ).pipe(Layer.provide(CalculationRunRepositoryLive))
        const layer = CalculationRunServiceLive.pipe(
          Layer.provide(Layer.merge(repositoryLayer, FactualLedgerRepositoryLive))
        )
        const running = yield* Effect.forkChild(
          context.runWithLayer({ layer, effect: recomputeEffect(R1) })
        )
        yield* Deferred.await(reachedPersist)
        // A later committed invalidation guards the existing active result while the old snapshot finishes.
        yield* Effect.promise(() =>
          runPg(
            Effect.flatMap(drizzle, (db) =>
              db
                .update(schema.activeCalculationRuns)
                .set({ minimumActivationRevision: sql`pg_current_xact_id()::text::numeric` })
                .where(eq(schema.activeCalculationRuns.principalId, TEST_PRINCIPAL_ID))
            )
          )
        )
        yield* Deferred.succeed(release, undefined)
        expect((yield* Fiber.join(running)).activated).toBe(false)
        const status = yield* Effect.promise(() => readStatus(job))
        expect(status.activeRun?.runId).toBe(R0)
        expect(status.jobs[0]).toMatchObject({
          activeCoverage: "not_covered",
          coveringRun: { runId: R1, status: "complete" },
          work: { status: "succeeded" },
        })
      })
  )

  it.effect("legacy coverage is unknown without a capture marker", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.calculationRuns).values({
              ...scope,
              id: R0,
              engineVersion: "legacy",
              ruleSetVersion: "legacy",
              inputLedgerRevision: "legacy",
              valuationRevision: "legacy",
              status: "complete",
              accountingMethod: "fifo",
              inventoryScope: "per_custody_unit",
              appliedChoiceIds: [],
              appliedRules: [],
              processedEventIds: [],
              completedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00Z")),
            })
            yield* db.insert(schema.activeCalculationRuns).values({ ...scope, runId: R0 })
          })
        )
      )
      const job = yield* Effect.promise(() => completeJob())
      expect((yield* Effect.promise(() => readStatus(job))).jobs[0]?.activeCoverage).toBe("unknown")
    })
  )

  it.effect("a partial calculation covers its captured job without becoming complete", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures([
                {
                  movementIdentity: {
                    sourceRecordKey: "missing-value",
                    componentKey: "principal",
                  },
                  sourceId: TEST_SOURCE_ID,
                  principalId: TEST_PRINCIPAL_ID,
                  externalId: "missing-value",
                  timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00Z")),
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "1",
                  kind: "income",
                  provenance: "deterministic",
                  originKind: "none",
                },
              ])
            )
          })
        )
      )
      const job = yield* Effect.promise(() => completeJob())
      expect((yield* Effect.promise(() => recompute(R1))).status).toBe("partial")
      expect((yield* Effect.promise(() => readStatus(job))).jobs[0]).toMatchObject({
        activeCoverage: "covered",
        coveringRun: { runId: R1, status: "partial" },
        work: { status: "succeeded" },
      })
    })
  )

  it.effect("sync_snapshot_covers_exact_job", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => recompute(R0))
      const oldCapture = yield* Effect.promise(() => capturedIds(R0))
      expect(oldCapture).toEqual([])
      const job = yield* Effect.promise(() => completeJob())
      const queued = yield* Effect.promise(() => readStatus(job))
      expect(queued.activeRun?.runId).toBe(R0)
      expect(queued.jobs[0]).toMatchObject({
        sourceJobId: job,
        activeCoverage: "not_covered",
        coveringRun: null,
        work: { status: "queued", attempts: [] },
      })
      const requestId = queued.jobs[0]?.work?.requestId
      expect(requestId).toBeDefined()
      yield* Effect.promise(() => recompute(R1))
      const settled = yield* Effect.promise(() => readStatus(job))
      expect(settled.activeRun).toEqual({ runId: R1, status: "complete" })
      expect(settled.jobs[0]).toMatchObject({
        activeCoverage: "covered",
        coveringRun: { runId: R1, status: "complete" },
        work: {
          requestId,
          status: "succeeded",
          attempts: [{ runId: R1, status: "succeeded", failureCode: null }],
        },
      })
      expect(yield* Effect.promise(() => capturedIds(R1))).toEqual([{ requestId }])
      expect(yield* Effect.promise(() => capturedIds(R0))).toEqual(oldCapture)
      yield* Effect.promise(() => recompute(R2))
      expect(yield* Effect.promise(() => capturedIds(R2))).toEqual([{ requestId }])
      expect((yield* Effect.promise(() => readStatus(job))).jobs[0]?.activeCoverage).toBe("covered")
      expect(yield* Effect.promise(() => capturedIds(R1))).toEqual([{ requestId }])
    })
  )

  it.effect("sync_after_snapshot_requires_next_run", () =>
    Effect.gen(function* () {
      const firstJob = yield* Effect.promise(() => completeJob())
      const snapshotEstablished = yield* Deferred.make<void>()
      const releaseSnapshot = yield* Deferred.make<void>()
      const coordinatedLedger = Layer.effect(
        FactualLedgerRepository,
        Effect.map(FactualLedgerRepository, (repository) =>
          FactualLedgerRepository.of({
            load: (params) =>
              Effect.gen(function* () {
                // The service has established its PostgreSQL snapshot, but neither facts nor request IDs have been loaded.
                yield* Deferred.succeed(snapshotEstablished, undefined)
                yield* Deferred.await(releaseSnapshot)
                return yield* repository.load(params)
              }),
          })
        )
      ).pipe(Layer.provide(FactualLedgerRepositoryLive))
      const layer = CalculationRunServiceLive.pipe(
        Layer.provide(Layer.merge(CalculationRunRepositoryLive, coordinatedLedger))
      )
      const running = yield* Effect.forkChild(
        context.runWithLayer({ layer, effect: recomputeEffect(R1) })
      )
      yield* Deferred.await(snapshotEstablished)
      const laterJob = yield* Effect.promise(() => completeJob())
      yield* Deferred.succeed(releaseSnapshot, undefined)
      yield* Fiber.join(running)
      const first = yield* Effect.promise(() => readStatus(firstJob))
      const later = yield* Effect.promise(() => readStatus(laterJob))
      expect(first.jobs[0]?.activeCoverage).toBe("covered")
      expect(first.work.status).toBe("queued")
      expect(
        first.work.requests.some(
          (request) => request.sourceJobId === laterJob && request.status === "queued"
        )
      ).toBe(true)
      expect(later.jobs[0]).toMatchObject({
        activeCoverage: "not_covered",
        coveringRun: null,
        work: { status: "queued", attempts: [] },
      })
      expect(yield* Effect.promise(() => capturedIds(R1))).toEqual([
        { requestId: first.jobs[0]?.work?.requestId },
      ])
      yield* Effect.promise(() => recompute(R2))
      const after = yield* Effect.promise(() => readStatus(laterJob))
      expect(after.jobs[0]).toMatchObject({
        activeCoverage: "covered",
        work: { status: "succeeded", attempts: [{ runId: R2, status: "succeeded" }] },
      })
      expect(yield* Effect.promise(() => capturedIds(R2))).toHaveLength(2)
      expect(yield* Effect.promise(() => capturedIds(R1))).toEqual([
        { requestId: first.jobs[0]?.work?.requestId },
      ])
    })
  )

  it.effect("coverage_preserves_full_history", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => runPg(seedFullHistory))
      const job = yield* Effect.promise(() => completeJob())
      yield* Effect.promise(() => recompute(R1))
      const stored = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const runs = yield* db
              .select({ taxYear: schema.calculationRuns.taxYear })
              .from(schema.calculationRuns)
            const realized = yield* db
              .select({
                costBasis: schema.calculationRunRealizedResults.costBasis,
                proceeds: schema.calculationRunRealizedResults.proceeds,
                gain: schema.calculationRunRealizedResults.gainLoss,
              })
              .from(schema.calculationRunRealizedResults)
              .where(eq(schema.calculationRunRealizedResults.runId, R1))
            const lots = yield* db
              .select({ remainingQuantity: schema.calculationRunDerivedLots.remainingQuantity })
              .from(schema.calculationRunDerivedLots)
              .where(eq(schema.calculationRunDerivedLots.runId, R1))
            return { runs, realized, lots }
          })
        )
      )
      expect(stored.runs).toEqual([{ taxYear: 2026 }])
      expect(stored.realized).toHaveLength(1)
      expect(decimalEquals(stored.realized[0]?.costBasis, "1")).toBe(true)
      expect(decimalEquals(stored.realized[0]?.proceeds, "2")).toBe(true)
      expect(decimalEquals(stored.realized[0]?.gain, "1")).toBe(true)
      // Fully consumed lots are omitted from the remaining inventory.
      expect(stored.lots).toEqual([])
      const remainingQuantity = stored.lots.reduce(
        (total, lot) => BigDecimal.sum(total, BigDecimal.fromStringUnsafe(lot.remainingQuantity)),
        BigDecimal.fromStringUnsafe("0")
      )
      expect(BigDecimal.equals(remainingQuantity, BigDecimal.fromStringUnsafe("0"))).toBe(true)
      expect((yield* Effect.promise(() => readStatus(job))).jobs[0]).toMatchObject({
        activeCoverage: "covered",
        coveringRun: { runId: R1, status: "complete" },
      })
    })
  )
})

const decimalEquals = (value: string | undefined, expected: string) =>
  value !== undefined &&
  BigDecimal.equals(BigDecimal.fromStringUnsafe(value), BigDecimal.fromStringUnsafe(expected))
const seedFullHistory = Effect.gen(function* () {
  const db = yield* drizzle
  const [principal] = yield* db
    .select({ userId: schema.principals.userId })
    .from(schema.principals)
    .where(eq(schema.principals.id, TEST_PRINCIPAL_ID))
  if (principal?.userId === null || principal?.userId === undefined)
    return yield* Effect.die("Missing fixture user")
  for (const movement of [
    {
      externalId: "buy-2024",
      timestamp: "2024-02-01T00:00:00Z",
      kind: "acquisition",
      transactionType: "buy_fiat",
      direction: "inbound",
      total: "1",
    },
    {
      externalId: "sale-2026",
      timestamp: "2026-02-01T00:00:00Z",
      kind: "disposal",
      transactionType: "sell_fiat",
      direction: "outbound",
      total: "2",
    },
  ] as const) {
    const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe(movement.timestamp))
    const [transaction] = yield* db
      .insert(schema.transactions)
      .values({
        sourceId: TEST_SOURCE_ID,
        principalId: TEST_PRINCIPAL_ID,
        externalId: movement.externalId,
        timestamp,
        transactionType: movement.transactionType,
        providerFiatAmount: "10",
        providerFiatCurrency: "EUR",
      })
      .returning({ id: schema.transactions.id })
    if (transaction === undefined) return yield* Effect.die("Missing history transaction")
    const [leg] = yield* db
      .insert(schema.transactionLegs)
      .values(
        yield* prepareMovementLegFixtures([
          {
            movementIdentity: { sourceRecordKey: movement.externalId, componentKey: "principal" },
            sourceId: TEST_SOURCE_ID,
            principalId: TEST_PRINCIPAL_ID,
            externalId: movement.externalId,
            timestamp,
            assetId: TEST_BTC_ASSET_ID,
            amount: "3",
            kind: movement.kind,
            provenance: "deterministic",
            originKind: "none",
            transactionId: transaction.id,
          },
        ])
      )
      .returning({
        id: schema.transactionLegs.id,
        targetId: schema.transactionLegs.movementCorrectionTargetId,
      })
    if (leg === undefined) return yield* Effect.die("Missing history movement")
    // Exact effective totals differ from provider values and exercise the real correction input path.
    yield* db.insert(schema.principalTransactionOverrides).values({
      principalId: TEST_PRINCIPAL_ID,
      sourceId: TEST_SOURCE_ID,
      targetId: leg.targetId,
      kind: "price",
      operation: "create",
      inspectedSystemRevision: "synthetic-revision",
      inspectedSourceRecordKey: movement.externalId,
      inspectedComponentKey: "principal",
      inspectedQuantity: "3",
      inspectedEconomicAssetId: TEST_BTC_ASSET_ID,
      inspectedDirection: movement.direction,
      inspectedStructure: "ownership_change",
      inspectedOccurredAt: timestamp,
      inspectedLegKind: movement.kind,
      inspectedFiatAmount: null,
      inspectedFiatCurrency: null,
      inspectedValuationEvidence: {
        reportingCurrency: scope.reportingCurrency,
        facts: [
          {
            _tag: "observed_consideration",
            eventId: leg.id,
            amount: { amount: "10", currency: scope.reportingCurrency },
            evidenceReference: `transaction:${transaction.id}`,
          },
        ],
      },
      inspectedTransactionType: movement.transactionType,
      inspectedProviderTransactionType: null,
      inspectedDerivationRule: null,
      inspectedFeeForSourceRecordKey: null,
      priceInput: {
        _tag: "total_value",
        amount: movement.total,
        currency: scope.reportingCurrency,
      },
      classificationInput: null,
      actorUserId: principal.userId,
      reason: "Synthetic full-history total",
      supersedesOverrideId: null,
    })
  }
})

describe("completed sync through worker and durable recovery", () => {
  it.effect("completion_dispatch_recovers and failed hydration retains exact runless history", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-02-01T00:00:00Z"))
      const job = yield* Effect.promise(() => completeJob())
      const requestId = (yield* Effect.promise(() => readStatus(job))).jobs[0]?.work?.requestId
      const failedDispatch = yield* maintenance(
        CalculationRecomputeQueue.of({
          enqueuePrincipalRecompute: () =>
            Effect.fail(
              new CalculationRecomputeQueueError({
                operation: "synthetic.enqueue",
                cause: "queue unavailable",
              })
            ),
        })
      )
      expect(failedDispatch.failedRequests).toBe(1)
      expect((yield* Effect.promise(() => readStatus(job))).jobs[0]?.work).toMatchObject({
        requestId,
        status: "queued",
        attempts: [],
      })
      yield* withWorker(
        (processor) =>
          Effect.gen(function* () {
            expect(Exit.isFailure(yield* Effect.exit(deliver(processor)))).toBe(true)
          }),
        {
          priceNeeds: () =>
            Effect.fail(
              new PersistenceError({
                operation: "synthetic.price-needs",
                cause: "hydration storage unavailable",
              })
            ),
        }
      )
      const failed = (yield* Effect.promise(() => readStatus(job))).jobs[0]?.work
      expect(failed).toMatchObject({
        requestId,
        status: "failed",
        attempts: [
          { runId: null, status: "failed", failureCode: "calculation_price_hydration_failed" },
        ],
      })
      yield* TestClock.setTime(Date.parse("2026-02-01T00:00:01Z"))
      const dispatches: string[] = []
      yield* maintenance(
        CalculationRecomputeQueue.of({
          enqueuePrincipalRecompute: (principalId) =>
            Effect.sync(() => {
              dispatches.push(principalId)
            }),
        })
      )
      expect(dispatches).toEqual([scope.principalId])
      yield* withWorker((processor) => deliver(processor))
      const settled = (yield* Effect.promise(() => readStatus(job))).jobs[0]
      expect(settled).toMatchObject({
        activeCoverage: "covered",
        work: {
          requestId,
          status: "succeeded",
          attempts: [{ ...failed?.attempts[0] }, { status: "succeeded" }],
        },
      })
      expect(settled?.work?.attempts[1]?.runId).not.toBeNull()
    })
  )

  it.effect("coalesced_scopes_do_not_lose_requests across a failed year and year rollover", () =>
    Effect.gen(function* () {
      yield* context.runWithLayer({
        layer: serviceLayer,
        effect: Effect.flatMap(CalculationRunService, (service) =>
          service.recompute({
            ...scope,
            taxYear: TaxYear.make(2024),
            id: R0,
            accountingChoices: [],
          })
        ),
      })
      const job = yield* Effect.promise(() => completeJob())
      yield* TestClock.setTime(Date.parse("2027-02-01T00:00:00Z"))
      yield* withWorker(
        (processor) =>
          Effect.gen(function* () {
            expect(Exit.isFailure(yield* Effect.exit(deliver(processor)))).toBe(true)
          }),
        {
          wrapRepository: (repository) => ({
            ...repository,
            start: (params) =>
              params.taxYear === 2024
                ? Effect.fail(
                    new PersistenceError({ operation: "synthetic.2024", cause: "one scope fails" })
                  )
                : repository.start(params),
          }),
        }
      )
      expect((yield* statusForYear(2024, job)).jobs[0]?.work?.status).toBe("failed")
      expect((yield* statusForYear(2026, job)).jobs[0]?.work?.status).toBe("succeeded")
      expect((yield* statusForYear(2025, job)).work.status).toBe("not_requested")
      expect((yield* statusForYear(2027, job)).work.status).toBe("not_requested")
      yield* withWorker((processor) => deliver(processor))
      expect((yield* statusForYear(2024, job)).jobs[0]?.work?.status).toBe("succeeded")
      const links = yield* Effect.promise(() =>
        runPg(
          Effect.flatMap(drizzle, (db) =>
            db
              .select({ taxYear: schema.calculationRunSyncRequests.taxYear })
              .from(schema.calculationRunSyncRequests)
          )
        )
      )
      expect(links.every((link) => link.taxYear === 2024 || link.taxYear === 2026)).toBe(true)
    })
  )

  it.effect("a slow expired 2024 calculation does not age the later 2026 claim", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-02-01T00:00:00Z"))
      yield* context.runWithLayer({
        layer: serviceLayer,
        effect: Effect.flatMap(CalculationRunService, (service) =>
          service.recompute({
            ...scope,
            taxYear: TaxYear.make(2024),
            id: R0,
            accountingChoices: [],
          })
        ),
      })
      const job = yield* Effect.promise(() => completeJob())
      const reached = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* withWorker(
        (processor) =>
          Effect.gen(function* () {
            const running = yield* Effect.forkChild(Effect.exit(deliver(processor)))
            yield* Deferred.await(reached)
            expect((yield* statusForYear(2024, job)).jobs[0]?.work?.status).toBe("running")
            expect((yield* statusForYear(2026, job)).jobs[0]?.work).toMatchObject({
              status: "queued",
              attempts: [],
            })
            yield* TestClock.setTime(Date.parse("2026-02-01T00:06:00Z"))
            const repaired = yield* maintenance(
              CalculationRecomputeQueue.of({ enqueuePrincipalRecompute: () => Effect.void }),
              DateTime.toDateUtc(DateTime.makeUnsafe("2026-02-01T00:01:00Z"))
            )
            expect(repaired.failedStaleRuns).toBe(1)
            expect((yield* statusForYear(2026, job)).jobs[0]?.work).toMatchObject({
              status: "queued",
              attempts: [],
            })
            yield* Deferred.succeed(release, undefined)
            expect(Exit.isFailure(yield* Fiber.join(running))).toBe(true)
            expect((yield* statusForYear(2024, job)).jobs[0]?.work).toMatchObject({
              status: "failed",
              attempts: [{ failureCode: "calculation_stale_recomputed" }],
            })
            const later = (yield* statusForYear(2026, job)).jobs[0]
            expect(later).toMatchObject({
              activeCoverage: "covered",
              work: { status: "succeeded", attempts: [{ status: "succeeded" }] },
            })
            expect(later?.work?.attempts).toHaveLength(1)
            const started = yield* Effect.promise(() =>
              runPg(
                Effect.flatMap(drizzle, (db) =>
                  db
                    .select({ startedAt: schema.calculationSyncAttempts.startedAt })
                    .from(schema.calculationSyncAttempts)
                    .where(eq(schema.calculationSyncAttempts.taxYear, 2026))
                )
              )
            )
            expect(started).toEqual([
              { startedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-02-01T00:06:00Z")) },
            ])
          }).pipe(Effect.ensuring(Deferred.succeed(release, undefined))),
        {
          wrapRepository: (repository) => ({
            ...repository,
            persist: (params) =>
              params.result.taxYear === 2024
                ? Effect.gen(function* () {
                    yield* Deferred.succeed(reached, undefined)
                    yield* Deferred.await(release)
                    return yield* repository.persist(params)
                  })
                : repository.persist(params),
          }),
        }
      )
    })
  )

  it.effect(
    "two consumers and maintenance preserve jobs accepted after the accounting snapshot",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-02-01T00:00:00Z"))
        const firstJob = yield* Effect.promise(() => completeJob())
        let firstRun: CalculationRunId | undefined
        let secondRun: CalculationRunId | undefined
        const established = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const ledgerLayer = Layer.effect(
          FactualLedgerRepository,
          Effect.map(FactualLedgerRepository, (repository) =>
            FactualLedgerRepository.of({
              load: (params) =>
                Effect.gen(function* () {
                  // loadSnapshot has already fixed PostgreSQL visibility before this real factual read.
                  yield* Deferred.succeed(established, undefined)
                  yield* Deferred.await(release)
                  return yield* repository.load(params)
                }),
            })
          )
        ).pipe(Layer.provide(FactualLedgerRepositoryLive))
        yield* withWorker(
          (first) =>
            Effect.gen(function* () {
              const running = yield* Effect.forkChild(deliver(first))
              yield* Deferred.await(established)
              const laterJob = yield* Effect.promise(() => completeJob())
              const queued: string[] = []
              yield* maintenance(
                CalculationRecomputeQueue.of({
                  enqueuePrincipalRecompute: (principalId) =>
                    Effect.sync(() => {
                      queued.push(principalId)
                    }),
                })
              )
              expect(queued).toContain(scope.principalId)
              yield* withWorker((second) => deliver(second), {
                wrapRepository: (repository) => ({
                  ...repository,
                  start: (params) =>
                    Effect.gen(function* () {
                      secondRun = params.id
                      return yield* repository.start(params)
                    }),
                }),
              })
              const secondResult = yield* Effect.promise(() => readStatus(laterJob))
              expect(secondResult.jobs[0]?.work?.status).toBe("succeeded")
              yield* Deferred.succeed(release, undefined)
              yield* Fiber.join(running)
              const firstStatus = yield* Effect.promise(() => readStatus(firstJob))
              const laterStatus = yield* Effect.promise(() => readStatus(laterJob))
              expect(firstRun).toBeDefined()
              if (firstRun === undefined)
                return yield* Effect.die("First consumer did not start a run")
              const firstRunId = firstRun
              expect(yield* Effect.promise(() => capturedIds(firstRunId))).toEqual([
                { requestId: firstStatus.jobs[0]?.work?.requestId },
              ])
              if (secondRun === undefined)
                return yield* Effect.die("Second consumer did not start a run")
              const secondRunId = secondRun
              expect(
                (yield* Effect.promise(() => capturedIds(secondRunId))).sort((left, right) =>
                  left.requestId.localeCompare(right.requestId)
                )
              ).toEqual(
                [firstStatus.jobs[0]?.work?.requestId, laterStatus.jobs[0]?.work?.requestId]
                  .sort((left, right) => (left ?? "").localeCompare(right ?? ""))
                  .map((requestId) => ({ requestId }))
              )
              expect(firstStatus.jobs[0]?.work?.attempts).toMatchObject([
                { runId: secondRun, status: "succeeded" },
              ])
              expect(laterStatus.jobs[0]?.work?.attempts).toMatchObject([
                { runId: secondRun, status: "succeeded" },
              ])
              expect(laterStatus.jobs[0]?.work?.attempts).toHaveLength(1)
              expect(laterStatus.jobs[0]?.work?.status).toBe("succeeded")
              // Duplicate delivery adds coverage, but never a second attempt to already settled work.
              yield* withWorker((second) => deliver(second))
              expect(
                (yield* Effect.promise(() => readStatus(laterJob))).jobs[0]?.work?.attempts
              ).toHaveLength(1)
            }).pipe(Effect.ensuring(Deferred.succeed(release, undefined))),
          {
            ledgerLayer,
            wrapRepository: (repository) => ({
              ...repository,
              start: (params) =>
                Effect.gen(function* () {
                  firstRun = params.id
                  return yield* repository.start(params)
                }),
            }),
          }
        )
      })
  )

  it.effect("a non-sync worker delivery creates no requests or source links", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-02-01T00:00:00Z"))
      yield* withWorker((processor) => deliver(processor))
      const status = yield* Effect.promise(() => readStatus())
      expect(status.work.status).toBe("not_requested")
      expect(status.activeRun).not.toBeNull()
      const rows = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return {
              requests: yield* db
                .select({ id: schema.calculationSyncRequests.id })
                .from(schema.calculationSyncRequests),
              links: yield* db
                .select({ requestId: schema.calculationRunSyncRequests.requestId })
                .from(schema.calculationRunSyncRequests),
              captures: yield* db
                .select({ runId: schema.calculationRunSyncCaptures.runId })
                .from(schema.calculationRunSyncCaptures),
            }
          })
        )
      )
      expect(rows.requests).toEqual([])
      expect(rows.links).toEqual([])
      expect(rows.captures).toHaveLength(1)
    })
  )

  it.effect("65536 absent captured IDs reject atomically without exceeding SQL bind limits", () =>
    Effect.gen(function* () {
      const requestIds = Array.from({ length: 65536 }, (_, index) =>
        CalculationSyncRequestId.make(
          `00000000-0000-4000-9002-${index.toString(16).padStart(12, "0")}`
        )
      )
      const repositoryLayer = Layer.effect(
        CalculationRunRepository,
        Effect.map(CalculationRunRepository, (repository) =>
          CalculationRunRepository.of({
            ...repository,
            start: (params) => repository.start({ ...params, syncCapture: { requestIds } }),
          })
        )
      ).pipe(Layer.provide(CalculationRunRepositoryLive))
      const outcome = yield* context
        .runWithLayer({
          layer: CalculationRunServiceLive.pipe(
            Layer.provide(Layer.merge(repositoryLayer, FactualLedgerRepositoryLive))
          ),
          effect: recomputeEffect(R1),
        })
        .pipe(Effect.result)
      expect(outcome).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "CalculationRunAlreadyStoredError" },
      })
      expect(yield* Effect.promise(() => capturedIds(R1))).toEqual([])
      const runs = yield* Effect.promise(() =>
        runPg(
          Effect.flatMap(drizzle, (db) =>
            db.select({ id: schema.calculationRuns.id }).from(schema.calculationRuns)
          )
        )
      )
      expect(runs).toEqual([])
    })
  )

  it.effect(
    "8200 accepted requests create exact run-linked attempts at the accounting snapshot",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-02-01T00:00:00Z"))
        const requestIds = yield* Effect.promise(seedManyAcceptedRequests)
        yield* context.runWithLayer({ layer: serviceLayer, effect: recomputeEffect(R1) })
        expect(
          (yield* Effect.promise(() => capturedIds(R1)))
            .map((row) => row.requestId)
            .sort((left, right) => left.localeCompare(right))
        ).toEqual(requestIds)
        const state = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return {
                requests: yield* db
                  .select({
                    id: schema.calculationSyncRequests.id,
                    status: schema.calculationSyncRequests.status,
                  })
                  .from(schema.calculationSyncRequests),
                attempts: yield* db
                  .select({
                    requestId: schema.calculationSyncAttempts.requestId,
                    attemptId: schema.calculationSyncAttempts.id,
                    status: schema.calculationSyncAttempts.status,
                    runId: schema.calculationSyncAttempts.runId,
                  })
                  .from(schema.calculationSyncAttempts),
              }
            })
          )
        )
        expect(
          state.requests.map((row) => row.id).sort((left, right) => left.localeCompare(right))
        ).toEqual(requestIds)
        expect(state.requests.every((row) => row.status === "succeeded")).toBe(true)
        expect(
          state.attempts
            .map((row) => row.requestId)
            .sort((left, right) => left.localeCompare(right))
        ).toEqual(requestIds)
        expect(state.attempts.every((row) => row.status === "succeeded" && row.runId === R1)).toBe(
          true
        )
        expect(new Set(state.attempts.map((row) => row.attemptId)).size).toBe(8200)
      })
  )

  it.effect(
    "preparation failure records only observed owned requests and excludes later work",
    () =>
      Effect.gen(function* () {
        const firstJob = yield* Effect.promise(() => completeJob())
        const preparation = yield* repositoryEffect((repository) =>
          repository.observeSyncPreparation(scope)
        )
        const foreignPrincipal = PrincipalId.make("00000000-0000-4000-8000-000000000199")
        const foreignSource = "00000000-0000-4000-8000-000000000299"
        yield* Effect.promise(() =>
          runPg(
            seedSyncEngineRepositoryFixture({
              principalId: foreignPrincipal,
              sourceId: foreignSource,
              userId: "00000000-0000-4000-8000-000000000198",
            })
          )
        )
        yield* Effect.promise(() =>
          completeJob({ principalId: foreignPrincipal, sourceId: foreignSource })
        )
        const foreignPreparation = yield* repositoryEffect((repository) =>
          repository.observeSyncPreparation({ ...scope, principalId: foreignPrincipal })
        )
        const laterJob = yield* Effect.promise(() => completeJob())
        yield* repositoryEffect((repository) =>
          repository.failSyncPreparation({
            ...scope,
            preparation: {
              ...preparation,
              requestIds: [...preparation.requestIds, ...foreignPreparation.requestIds],
            },
            failureCode: "synthetic_preparation_failure",
          })
        )
        expect((yield* Effect.promise(() => readStatus(firstJob))).jobs[0]?.work).toMatchObject({
          status: "failed",
          attempts: [
            { runId: null, status: "failed", failureCode: "synthetic_preparation_failure" },
          ],
        })
        expect((yield* Effect.promise(() => readStatus(laterJob))).jobs[0]?.work).toMatchObject({
          status: "queued",
          attempts: [],
        })
        const foreign = yield* repositoryEffect((repository) =>
          repository.getSyncStatus({ ...scope, principalId: foreignPrincipal })
        )
        expect(foreign.jobs[0]?.work).toMatchObject({ status: "queued", attempts: [] })
      })
  )

  it.effect("preparation failure safely records 8200 exact terminal runless attempts", () =>
    Effect.gen(function* () {
      const requestIds = yield* Effect.promise(seedManyAcceptedRequests)
      const preparation = yield* repositoryEffect((repository) =>
        repository.observeSyncPreparation(scope)
      )
      expect([...preparation.requestIds].sort((left, right) => left.localeCompare(right))).toEqual(
        requestIds
      )
      yield* repositoryEffect((repository) =>
        repository.failSyncPreparation({
          ...scope,
          preparation,
          failureCode: "synthetic_bulk_preparation_failure",
        })
      )
      const attempts = yield* Effect.promise(() =>
        runPg(
          Effect.flatMap(drizzle, (db) =>
            db
              .select({
                id: schema.calculationSyncAttempts.id,
                requestId: schema.calculationSyncAttempts.requestId,
                status: schema.calculationSyncAttempts.status,
                runId: schema.calculationSyncAttempts.runId,
                failureCode: schema.calculationSyncAttempts.failureCode,
              })
              .from(schema.calculationSyncAttempts)
          )
        )
      )
      expect(
        attempts.map((row) => row.requestId).sort((left, right) => left.localeCompare(right))
      ).toEqual(requestIds)
      expect(new Set(attempts.map((row) => row.id)).size).toBe(8200)
      expect(
        attempts.every(
          (row) =>
            row.status === "failed" &&
            row.runId === null &&
            row.failureCode === "synthetic_bulk_preparation_failure"
        )
      ).toBe(true)
    })
  )

  it.effect("slow failed hydration keeps its original observation and actual failure time", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-02-01T00:00:00Z"))
      const firstJob = yield* Effect.promise(() => completeJob())
      const reached = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* withWorker(
        (processor) =>
          Effect.gen(function* () {
            const running = yield* Effect.forkChild(Effect.exit(deliver(processor)))
            yield* Deferred.await(reached)
            const laterJob = yield* Effect.promise(() => completeJob())
            yield* TestClock.setTime(Date.parse("2026-02-01T00:06:00Z"))
            const repaired = yield* maintenance(
              CalculationRecomputeQueue.of({ enqueuePrincipalRecompute: () => Effect.void }),
              DateTime.toDateUtc(DateTime.makeUnsafe("2026-02-01T00:01:00Z"))
            )
            expect(repaired.failedStaleRuns).toBe(0)
            yield* Deferred.succeed(release, undefined)
            expect(Exit.isFailure(yield* Fiber.join(running))).toBe(true)
            const first = (yield* Effect.promise(() => readStatus(firstJob))).jobs[0]?.work
            expect(first).toMatchObject({
              status: "failed",
              attempts: [
                {
                  status: "failed",
                  runId: null,
                  failureCode: "calculation_price_hydration_failed",
                },
              ],
            })
            expect((yield* Effect.promise(() => readStatus(laterJob))).jobs[0]?.work).toMatchObject(
              { status: "queued", attempts: [] }
            )
            const attempts = yield* Effect.promise(() =>
              runPg(
                Effect.flatMap(drizzle, (db) =>
                  db
                    .select({
                      requestId: schema.calculationSyncAttempts.requestId,
                      startedAt: schema.calculationSyncAttempts.startedAt,
                      completedAt: schema.calculationSyncAttempts.completedAt,
                    })
                    .from(schema.calculationSyncAttempts)
                )
              )
            )
            expect(attempts).toEqual([
              {
                requestId: first?.requestId,
                startedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-02-01T00:00:00Z")),
                completedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-02-01T00:06:00Z")),
              },
            ])
          }).pipe(Effect.ensuring(Deferred.succeed(release, undefined))),
        {
          priceNeeds: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(reached, undefined)
              yield* Deferred.await(release)
              return yield* new PersistenceError({
                operation: "synthetic.slow_hydration",
                cause: "price storage unavailable",
              })
            }),
        }
      )
    })
  )

  for (const phase of ["hydration", "snapshot"] as const) {
    it.effect(
      `slow ${phase} remains eligible through maintenance and preserves later accepted work`,
      () =>
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse("2026-02-01T00:00:00Z"))
          const firstJob = yield* Effect.promise(() => completeJob())
          const reached = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const pause = Deferred.succeed(reached, undefined).pipe(
            Effect.andThen(Deferred.await(release))
          )
          const ledgerLayer = Layer.effect(
            FactualLedgerRepository,
            Effect.map(FactualLedgerRepository, (repository) =>
              FactualLedgerRepository.of({
                load: (params) => pause.pipe(Effect.andThen(repository.load(params))),
              })
            )
          ).pipe(Layer.provide(FactualLedgerRepositoryLive))
          yield* withWorker(
            (processor) =>
              Effect.gen(function* () {
                const running = yield* Effect.forkChild(deliver(processor))
                yield* Deferred.await(reached)
                const laterJob = yield* Effect.promise(() => completeJob())
                yield* TestClock.setTime(Date.parse("2026-02-01T00:06:00Z"))
                const repaired = yield* maintenance(
                  CalculationRecomputeQueue.of({ enqueuePrincipalRecompute: () => Effect.void }),
                  DateTime.toDateUtc(DateTime.makeUnsafe("2026-02-01T00:01:00Z"))
                )
                expect(repaired.failedStaleRuns).toBe(0)
                expect(
                  (yield* Effect.promise(() => readStatus(firstJob))).jobs[0]?.work
                ).toMatchObject({ status: "queued", attempts: [] })
                expect(
                  (yield* Effect.promise(() => readStatus(laterJob))).jobs[0]?.work
                ).toMatchObject({ status: "queued", attempts: [] })
                yield* Deferred.succeed(release, undefined)
                yield* Fiber.join(running)
                expect(
                  (yield* Effect.promise(() => readStatus(firstJob))).jobs[0]?.work
                ).toMatchObject({ status: "succeeded", attempts: [{ status: "succeeded" }] })
                expect(
                  (yield* Effect.promise(() => readStatus(laterJob))).jobs[0]?.work?.status
                ).toBe(phase === "snapshot" ? "queued" : "succeeded")
                yield* withWorker((next) => deliver(next))
                expect(
                  (yield* Effect.promise(() => readStatus(laterJob))).jobs[0]?.work?.status
                ).toBe("succeeded")
              }).pipe(Effect.ensuring(Deferred.succeed(release, undefined))),
            phase === "snapshot" ? { ledgerLayer } : { priceNeeds: () => pause.pipe(Effect.as([])) }
          )
        })
    )
  }

  it.effect("bounded maintenance advances past a repeatedly failing principal", () =>
    Effect.gen(function* () {
      const laterPrincipal = PrincipalId.make("00000000-0000-4000-8000-000000000199")
      const laterSource = "00000000-0000-4000-8000-000000000299"
      yield* Effect.promise(() =>
        runPg(
          seedSyncEngineRepositoryFixture({
            principalId: laterPrincipal,
            sourceId: laterSource,
            userId: "00000000-0000-4000-8000-000000000198",
          })
        )
      )
      yield* Effect.promise(() => completeJob())
      yield* Effect.promise(() =>
        completeJob({ principalId: laterPrincipal, sourceId: laterSource })
      )
      const deliveries: string[] = []
      const queue = CalculationRecomputeQueue.of({
        enqueuePrincipalRecompute: (principalId) =>
          Effect.gen(function* () {
            deliveries.push(principalId)
            if (principalId === scope.principalId)
              return yield* Effect.fail(
                new CalculationRecomputeQueueError({
                  operation: "synthetic.queue",
                  cause: "first principal keeps failing",
                })
              )
          }),
      })
      const pass = (afterPrincipalId?: PrincipalId) =>
        context.runWithLayer({
          layer: Layer.merge(
            CalculationRunRepositoryLive,
            Layer.succeed(CalculationRecomputeQueue, queue)
          ),
          effect: runCalculationMaintenancePass({
            limit: 1,
            staleBefore: DateTime.toDateUtc(DateTime.makeUnsafe("2000-01-01T00:00:00Z")),
            ...(afterPrincipalId === undefined ? {} : { afterPrincipalId }),
          }),
        })
      const first = yield* pass()
      expect(deliveries).toEqual([scope.principalId])
      expect(first.failedRequests).toBe(1)
      expect(first.nextAfterPrincipalId).toBe(scope.principalId)
      const second = yield* pass(scope.principalId)
      expect(deliveries).toEqual([scope.principalId, laterPrincipal])
      expect(second.requestedRecomputes).toBe(1)
      expect(second.nextAfterPrincipalId).toBe(laterPrincipal)
      expect((yield* pass(laterPrincipal)).nextAfterPrincipalId).toBeNull()
    })
  )

  it.effect(
    "maintenance expires a started run while late preparation and finalization leave its replacement intact",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-02-01T00:00:00Z"))
        const job = yield* Effect.promise(() => completeJob())
        const preparation = yield* repositoryEffect((repository) =>
          repository.observeSyncPreparation(scope)
        )
        const reached = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const repositoryLayer = Layer.effect(
          CalculationRunRepository,
          Effect.map(CalculationRunRepository, (repository) =>
            CalculationRunRepository.of({
              ...repository,
              persist: (params) =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(reached, undefined)
                  yield* Deferred.await(release)
                  return yield* repository.persist(params)
                }),
            })
          )
        ).pipe(Layer.provide(CalculationRunRepositoryLive))
        yield* Effect.gen(function* () {
          const delayed = yield* Effect.forkChild(
            Effect.exit(
              context.runWithLayer({
                layer: CalculationRunServiceLive.pipe(
                  Layer.provide(Layer.merge(repositoryLayer, FactualLedgerRepositoryLive))
                ),
                effect: recomputeEffect(R1),
              })
            )
          )
          yield* Deferred.await(reached)
          yield* repositoryEffect((repository) =>
            repository.failSyncPreparation({
              ...scope,
              preparation,
              failureCode: "late_preparation_failure",
            })
          )
          expect((yield* Effect.promise(() => readStatus(job))).jobs[0]?.work).toMatchObject({
            status: "running",
            attempts: [{ status: "running", runId: R1 }],
          })
          yield* TestClock.setTime(Date.parse("2026-02-01T00:06:00Z"))
          const repaired = yield* maintenance(
            CalculationRecomputeQueue.of({ enqueuePrincipalRecompute: () => Effect.void }),
            DateTime.toDateUtc(DateTime.makeUnsafe("2099-01-01T00:00:00Z"))
          )
          expect(repaired.failedStaleRuns).toBe(1)
          yield* withWorker((processor) => deliver(processor))
          const replacement = yield* Effect.promise(() => readStatus(job))
          expect(replacement.jobs[0]?.work).toMatchObject({
            status: "succeeded",
            attempts: [
              { runId: R1, status: "failed", failureCode: "calculation_stale_recomputed" },
              { status: "succeeded" },
            ],
          })
          yield* repositoryEffect((repository) =>
            repository.failSyncPreparation({
              ...scope,
              preparation,
              failureCode: "late_old_failure",
            })
          )
          yield* Deferred.succeed(release, undefined)
          expect(Exit.isFailure(yield* Fiber.join(delayed))).toBe(true)
          expect(yield* Effect.promise(() => readStatus(job))).toEqual(replacement)
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
      })
  )
})
