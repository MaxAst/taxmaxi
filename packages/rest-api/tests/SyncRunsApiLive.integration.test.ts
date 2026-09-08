import { nextTestUuid } from "./support/TestUuid.ts"
import * as DateTime from "effect/DateTime"
import { HttpApiClient } from "effect/unstable/httpapi"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { NodeHttpServer } from "@effect/platform-node"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { JurisdictionCode, TaxYear } from "@my/core/accounting"
import {
  AuthService,
  HashedPassword,
  PasswordHasher,
  type AuthServiceShape,
} from "@my/core/authentication"
import { EUR } from "@my/core/currency"
import { PrincipalId } from "@my/core/ownership"
import {
  SOURCE_SYNC_QUEUE_NAME,
  SourceSyncJobRepository,
  SourceSyncQueue,
  SourceSyncQueueError,
  TransferReconciliationService,
  type SourceSyncQueuePayload,
  type TransferReconciliationServiceShape,
} from "@my/sync-engine/services"
import { SourceSyncRunServiceLive, SourceSyncServiceLive } from "@my/sync-engine/layers"
import * as Chunk from "effect/Chunk"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import { PersistenceError } from "../../persistence/src/errors/RepositoryError.ts"
import {
  CalculationRunRepositoryLive,
  CalculationRunServiceLive,
  FactualLedgerRepositoryLive,
} from "../../persistence/src/layers/index.ts"
import { drizzle, runSqlUnsafe } from "../../persistence/src/layers/PgClientLive.ts"
import { RepositoriesLive } from "../../persistence/src/layers/RepositoriesLive.ts"
import { schema } from "../../persistence/src/schema/index.ts"
import {
  CalculationRunId,
  CalculationRunRepository,
  CalculationRunService,
  TaxCalculationService,
  type ExposedCalculationRunStatus,
} from "../../persistence/src/services/index.ts"
import { makeIntegrationTestDatabaseContext } from "../../persistence/tests/support/integration-test-kit.ts"
import { TaxMaxiApi } from "../src/definitions/TaxMaxiApi.ts"
import { AnonSessionServiceLive } from "../src/layers/AnonSessionServiceLive.ts"
import { SimpleTokenValidatorLive } from "../src/layers/AuthMiddlewareLive.ts"
import { TaxMaxiApiLive } from "../src/layers/TaxMaxiApiLive.ts"
import { makeX402PaymentValidatorTestLive } from "./support/X402PaymentValidatorTestLive.ts"
import { SIWXProofVerifierTestLive } from "./support/SIWXProofVerifierTestLive.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_rest_api_sync_runs",
})
const TestPgClientLive = context.TestPgClientLive

const queuedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"))
const queueEvents: Array<SourceSyncQueuePayload> = []
const X402PaymentValidatorTestLive = makeX402PaymentValidatorTestLive({
  validPaymentHeader: "valid-test-x402-payment",
})
const TestConfigProvider = ConfigProvider.fromEnvRecord({
  ANON_SESSION_SECRET: "test-anon-session-secret-32-bytes-long",
})
const AnonSessionServiceTestLive = AnonSessionServiceLive.pipe(
  Layer.provide(ConfigProvider.layer(TestConfigProvider))
)

const SourceSyncQueueTestLive = Layer.effect(
  SourceSyncQueue,
  Effect.gen(function* () {
    const sourceSyncJobRepository = yield* SourceSyncJobRepository

    return SourceSyncQueue.of({
      enqueueSourceSyncJob: (payload) =>
        Effect.gen(function* () {
          queueEvents.push(payload)
          yield* sourceSyncJobRepository
            .attachQueueMetadata({
              jobId: payload.jobId,
              queueName: SOURCE_SYNC_QUEUE_NAME,
              queueJobId: payload.jobId,
              queuedAt,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new SourceSyncQueueError({
                    operation: "test.attachQueueMetadata",
                    cause,
                  })
              )
            )
        }),
    })
  })
)

const AuthServiceTestLive = Layer.succeed(AuthService, {
  login: () => Effect.die("AuthService test stub: login not implemented"),
  register: () => Effect.die("AuthService test stub: register not implemented"),
  startEmailVerification: () =>
    Effect.die("AuthService test stub: startEmailVerification not implemented"),
  resendEmailVerification: () =>
    Effect.die("AuthService test stub: resendEmailVerification not implemented"),
  verifyEmail: () => Effect.die("AuthService test stub: verifyEmail not implemented"),
  startOAuthLogin: () => Effect.die("AuthService test stub: startOAuthLogin not implemented"),
  completeOAuthLogin: () => Effect.die("AuthService test stub: completeOAuthLogin not implemented"),
  startLink: () => Effect.die("AuthService test stub: startLink not implemented"),
  completeLink: () => Effect.die("AuthService test stub: completeLink not implemented"),
  logout: () => Effect.die("AuthService test stub: logout not implemented"),
  validateSession: () => Effect.die("AuthService test stub: validateSession not implemented"),
  linkIdentity: () => Effect.die("AuthService test stub: linkIdentity not implemented"),
  getEnabledProviders: Effect.succeed(Chunk.fromIterable(["local", "coinbase"] as const)),
} satisfies AuthServiceShape)

const PasswordHasherTestLive = Layer.succeed(PasswordHasher, {
  hash: () => Effect.succeed(HashedPassword.make("test-password-hash")),
  verify: () => Effect.succeed(true),
})

const TaxCalculationServiceTestLive = Layer.succeed(TaxCalculationService, {
  calculateTax: () => Effect.die("TaxCalculationService test stub: calculateTax"),
})

const TransferReconciliationServiceTestLive = Layer.succeed(TransferReconciliationService, {
  reconcileTransferCandidates: () =>
    Effect.die(
      "TransferReconciliationService test stub: reconcileTransferCandidates not implemented"
    ),
  rollbackReconciliationsForSourceReplay: () => Effect.void,
  applyDeterministicInternalTransferCanonicalization: () =>
    Effect.die(
      "TransferReconciliationService test stub: applyDeterministicInternalTransferCanonicalization not implemented"
    ),
} satisfies TransferReconciliationServiceShape)

const SourceSyncServiceWithDepsTestLive = SourceSyncServiceLive.pipe(
  Layer.provide(SourceSyncQueueTestLive),
  Layer.provide(RepositoriesLive)
)

const SourceSyncRunServiceWithDepsTestLive = SourceSyncRunServiceLive.pipe(
  Layer.provide(SourceSyncServiceWithDepsTestLive),
  Layer.provide(RepositoriesLive)
)

const PersistenceLayer = Layer.mergeAll(
  RepositoriesLive,
  SourceSyncServiceWithDepsTestLive,
  SourceSyncRunServiceWithDepsTestLive,
  TaxCalculationServiceTestLive,
  TransferReconciliationServiceTestLive,
  AuthServiceTestLive,
  PasswordHasherTestLive
).pipe(Layer.provideMerge(TestPgClientLive))

const HttpLive = HttpRouter.serve(
  TaxMaxiApiLive.pipe(
    Layer.provide(SourceSyncQueueTestLive),
    Layer.provide(AnonSessionServiceTestLive),
    Layer.provide(SIWXProofVerifierTestLive),
    Layer.provide(X402PaymentValidatorTestLive),
    Layer.provide(SimpleTokenValidatorLive)
  )
).pipe(Layer.provideMerge(PersistenceLayer), Layer.provideMerge(NodeHttpServer.layerTest))

const CalculationRunStatusFailureTestLive = Layer.succeed(
  CalculationRunRepository,
  CalculationRunRepository.of({
    fail: () => Effect.die("CalculationRunRepository test stub: fail"),
    getSyncStatus: () => Effect.die("unused getSyncStatus"),
    getLatestStatus: () =>
      Effect.fail(
        new PersistenceError({
          operation: "calculationRunRepository.getLatestStatus.test",
          cause: "forced calculation status read failure",
        })
      ),
    listActiveTaxYears: () => Effect.die("CalculationRunRepository test stub: listActiveTaxYears"),
    settleStaleAndFindRecomputePrincipals: () =>
      Effect.die("CalculationRunRepository test stub: maintenance"),
    persist: () => Effect.die("CalculationRunRepository test stub: persist"),
    start: () => Effect.die("CalculationRunRepository test stub: start"),
  })
)

const HttpWithCalculationRunStatusFailureLive = HttpRouter.serve(
  TaxMaxiApiLive.pipe(
    Layer.provide(SourceSyncQueueTestLive),
    Layer.provide(CalculationRunStatusFailureTestLive),
    Layer.provide(AnonSessionServiceTestLive),
    Layer.provide(SIWXProofVerifierTestLive),
    Layer.provide(X402PaymentValidatorTestLive),
    Layer.provide(SimpleTokenValidatorLive)
  )
).pipe(Layer.provideMerge(PersistenceLayer), Layer.provideMerge(NodeHttpServer.layerTest))

const makeAuthenticatedClient = ({ userId }: { readonly userId: string }) =>
  Effect.gen(function* () {
    const baseHttpClient = yield* HttpClient.HttpClient
    return yield* HttpApiClient.makeWith(TaxMaxiApi, {
      httpClient: baseHttpClient.pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(`user_${userId}_admin`))
      ),
    })
  })

const seedCoinbaseSources = ({
  userId,
  principalId,
  sourceIds,
}: {
  readonly userId: string
  readonly principalId: string
  readonly sourceIds: ReadonlyArray<string>
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db.insert(schema.users).values({
      id: userId,
      email: `${userId}@taxmaxi.test`,
      name: "Sync Runs API Test User",
    })
    yield* db.insert(schema.principals).values({
      id: principalId,
      kind: "user",
      userId,
    })

    const coinbaseCex = yield* db
      .select({ id: schema.cex.id, name: schema.cex.name })
      .from(schema.cex)
      .pipe(Effect.map((rows) => rows.find((row) => row.name === "coinbase")))

    if (coinbaseCex === undefined) {
      return yield* Effect.die("Missing seeded coinbase CEX fixture")
    }

    yield* Effect.forEach(sourceIds, (sourceId, index) =>
      Effect.gen(function* () {
        const [createdAccount] = yield* db
          .insert(schema.cexAccount)
          .values({
            cexId: coinbaseCex.id,
            principalId,
            providerUserId: `${sourceId}-provider-user`,
            providerAccountId: `${sourceId}-provider-account`,
            accessToken: "test-access-token",
            refreshToken: "test-refresh-token",
            expiresAt: DateTime.toDateUtc(DateTime.addDuration(yield* DateTime.now, "1 hour")),
            scopes: "wallet:accounts:read wallet:transactions:read",
          })
          .returning({ id: schema.cexAccount.id })

        if (createdAccount === undefined) {
          return yield* Effect.die("Failed to create cex account fixture")
        }

        yield* db.insert(schema.sources).values({
          id: sourceId,
          name: `Coinbase ${index}`,
          providerKey: "coinbase",
          sourceableType: "cex",
          cexAccountId: createdAccount.id,
          principalId,
        })
      })
    )
  })

const seedPrincipalUser = ({
  userId,
  principalId,
}: {
  readonly userId: string
  readonly principalId: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    yield* db.insert(schema.users).values({
      id: userId,
      email: `${userId}@taxmaxi.test`,
      name: "Sync Runs API Test User",
    })
    yield* db.insert(schema.principals).values({
      id: principalId,
      kind: "user",
      userId,
    })
  })

const markJobTerminal = ({
  jobId,
  status,
}: {
  readonly jobId: string
  readonly status: "completed" | "failed"
}) =>
  runSqlUnsafe({
    statement: `
      UPDATE processing_jobs
      SET
        status = $1,
        completed_at = $2,
        error_message = $3,
        progress_details = $4::jsonb,
        updated_at = $2
      WHERE id = $5
    `,
    params: [
      status,
      DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:05:00.000Z")),
      status === "failed" ? "Provider failed" : null,
      JSON.stringify({
        fetchedRecords: status === "completed" ? 4 : 0,
        normalizedRecords: status === "completed" ? 3 : 0,
        failedRecords: status === "failed" ? 1 : 0,
      }),
      jobId,
    ],
  })

const currentGermanTaxYear = DateTime.now.pipe(
  Effect.map(DateTime.setZoneNamedUnsafe("Europe/Berlin")),
  Effect.map(DateTime.toParts),
  Effect.map(({ year }) => year)
)

const seedCalculationRun = ({
  id,
  principalId,
  status,
  revisionSequence,
  jurisdiction = "DE",
  taxYear,
  reportingCurrency = "EUR",
  createdAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:10:00.000Z")),
}: {
  readonly id: string
  readonly principalId: string
  readonly status: ExposedCalculationRunStatus
  readonly revisionSequence: number
  readonly jurisdiction?: string
  readonly taxYear?: number
  readonly reportingCurrency?: string
  readonly createdAt?: Date
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const effectiveTaxYear = taxYear ?? (yield* currentGermanTaxYear)
    const isSuccessful = status === "complete" || status === "partial"
    const isTerminal = isSuccessful || status === "failed"

    yield* db.insert(schema.calculationRuns).values({
      id,
      principalId,
      jurisdiction,
      taxYear: effectiveTaxYear,
      reportingCurrency,
      engineVersion: "test-engine-v1",
      ruleSetVersion: "test-rules-v1",
      inputLedgerRevision: `v1:${revisionSequence}:${"a".repeat(64)}`,
      valuationRevision: `sha256:${"b".repeat(64)}`,
      status,
      accountingMethod: isSuccessful ? "fifo" : null,
      inventoryScope: isSuccessful ? "per_custody_unit" : null,
      appliedChoiceIds: [],
      appliedRules: [],
      processedEventIds: [],
      failureCode: status === "failed" ? "calculation_stale_recomputed" : null,
      failureMessage: null,
      startedAt: createdAt,
      completedAt: isTerminal ? createdAt : null,
      createdAt,
      updatedAt: createdAt,
    })
  })

await Effect.runPromise(context.recreateTestDatabase())

describe("SyncRunsApiLive", () => {
  beforeEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        queueEvents.length = 0
        yield* context.recreateTestDatabase()
      })
    )
  )

  it.effect("starts a user-wide run with one queued child item per source", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      const sourceIds = [nextTestUuid(), nextTestUuid()]
      yield* seedCoinbaseSources({ userId, principalId, sourceIds })

      const client = yield* makeAuthenticatedClient({ userId })
      const run = yield* client.syncRuns.startSyncRun(undefined)

      expect(run.status).toBe("queued")
      expect(run.requestedSourceCount).toBe(2)
      expect(run.queuedSourceCount).toBe(2)
      expect(run.items).toHaveLength(2)
      expect(run.items.map((item) => item.sourceId).sort()).toEqual(sourceIds.sort())
      expect(run.items.every((item) => item.provider === "coinbase")).toBe(true)
      expect(run.items.every((item) => item.status === "queued")).toBe(true)
      expect(run.calculationRun).toBeNull()
      expect(queueEvents).toHaveLength(2)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("returns a started sync when its post-start calculation status read fails", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      yield* seedCoinbaseSources({ userId, principalId, sourceIds: [nextTestUuid()] })

      const client = yield* makeAuthenticatedClient({ userId })
      const run = yield* client.syncRuns.startSyncRun(undefined)

      expect(run.runId).toBeDefined()
      expect(run.calculationRun).toBeNull()
      expect(queueEvents).toHaveLength(1)
    }).pipe(Effect.provide(HttpWithCalculationRunStatusFailureLive), Effect.scoped)
  )

  it.effect("returns a stable code when a calculation status read fails", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      yield* seedCoinbaseSources({ userId, principalId, sourceIds: [nextTestUuid()] })

      const client = yield* makeAuthenticatedClient({ userId })
      const started = yield* client.syncRuns.startSyncRun(undefined)
      const result = yield* client.syncRuns
        .getSyncRun({ params: { runId: started.runId } })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("CalculationRunStatusUnavailableError")
        if (result.failure._tag === "CalculationRunStatusUnavailableError") {
          expect(result.failure.code).toBe("calculation_run_status_unavailable")
        }
      }
    }).pipe(Effect.provide(HttpWithCalculationRunStatusFailureLive), Effect.scoped)
  )

  it.effect("observes a committed running calculation before its terminal result", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      const runId = nextTestUuid()
      yield* seedCoinbaseSources({ userId, principalId, sourceIds: [nextTestUuid()] })

      const terminalWriteReached = yield* Deferred.make<void>()
      const releaseTerminalWrite = yield* Deferred.make<void>()
      const CoordinatedCalculationRunRepositoryLive = Layer.effect(
        CalculationRunRepository,
        Effect.map(CalculationRunRepository, (repository) =>
          CalculationRunRepository.of({
            fail: repository.fail,
            getLatestStatus: repository.getLatestStatus,
            getSyncStatus: repository.getSyncStatus,
            listActiveTaxYears: repository.listActiveTaxYears,
            settleStaleAndFindRecomputePrincipals: repository.settleStaleAndFindRecomputePrincipals,
            persist: (params) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(terminalWriteReached, undefined)
                yield* Deferred.await(releaseTerminalWrite)
                return yield* repository.persist(params)
              }),
            start: repository.start,
          })
        )
      ).pipe(Layer.provide(CalculationRunRepositoryLive))
      const CoordinatedCalculationRunServiceLive = CalculationRunServiceLive.pipe(
        Layer.provide(
          Layer.merge(CoordinatedCalculationRunRepositoryLive, FactualLedgerRepositoryLive)
        )
      )
      const taxYear = TaxYear.make(yield* currentGermanTaxYear)
      const calculation = yield* Effect.forkChild(
        context.runWithLayer({
          effect: Effect.flatMap(CalculationRunService, (service) =>
            service.recompute({
              id: CalculationRunId.make(runId),
              principalId: PrincipalId.make(principalId),
              jurisdiction: JurisdictionCode.make("DE"),
              taxYear,
              reportingCurrency: EUR,
              accountingChoices: [],
            })
          ),
          layer: CoordinatedCalculationRunServiceLive,
        })
      )

      yield* Deferred.await(terminalWriteReached)
      const client = yield* makeAuthenticatedClient({ userId })
      const syncRun = yield* client.syncRuns.startSyncRun(undefined)
      const whileRunning = yield* client.syncRuns.getSyncRun({
        params: { runId: syncRun.runId },
      })

      expect(whileRunning.calculationRun).toEqual({
        runId,
        status: "running",
        failureCode: null,
      })

      yield* Deferred.succeed(releaseTerminalWrite, undefined)
      yield* Fiber.join(calculation)
      const afterCompletion = yield* client.syncRuns.getSyncRun({
        params: { runId: syncRun.runId },
      })

      expect(afterCompletion.calculationRun).toEqual({
        runId,
        status: "complete",
        failureCode: null,
      })
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("returns no calculation run from another principal", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      const otherUserId = nextTestUuid()
      const otherPrincipalId = nextTestUuid()
      yield* seedCoinbaseSources({ userId, principalId, sourceIds: [nextTestUuid()] })
      yield* seedPrincipalUser({ userId: otherUserId, principalId: otherPrincipalId })
      yield* seedCalculationRun({
        id: nextTestUuid(),
        principalId: otherPrincipalId,
        status: "complete",
        revisionSequence: 1,
      })

      const client = yield* makeAuthenticatedClient({ userId })
      const started = yield* client.syncRuns.startSyncRun(undefined)
      const loaded = yield* client.syncRuns.getSyncRun({ params: { runId: started.runId } })

      expect(loaded.calculationRun).toBeNull()
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("returns the latest DE/EUR/current-year calculation status by ledger revision", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      yield* seedCoinbaseSources({ userId, principalId, sourceIds: [nextTestUuid()] })

      const client = yield* makeAuthenticatedClient({ userId })
      const started = yield* client.syncRuns.startSyncRun(undefined)
      const statuses: ReadonlyArray<ExposedCalculationRunStatus> = [
        "running",
        "complete",
        "partial",
        "failed",
      ]

      for (const [index, status] of statuses.entries()) {
        const runId = nextTestUuid()
        yield* seedCalculationRun({
          id: runId,
          principalId,
          status,
          revisionSequence: index + 1,
        })

        const loaded = yield* client.syncRuns.getSyncRun({ params: { runId: started.runId } })
        expect(loaded.calculationRun).toEqual({
          runId,
          status,
          failureCode: status === "failed" ? "calculation_stale_recomputed" : null,
        })
      }

      const lowerTieRunId = "00000000-0000-4000-8000-000000000001"
      const higherTieRunId = "00000000-0000-4000-8000-000000000002"
      yield* seedCalculationRun({
        id: lowerTieRunId,
        principalId,
        status: "partial",
        revisionSequence: 5,
      })
      yield* seedCalculationRun({
        id: higherTieRunId,
        principalId,
        status: "complete",
        revisionSequence: 5,
      })

      const deterministicTie = yield* client.syncRuns.getSyncRun({
        params: { runId: started.runId },
      })
      expect(deterministicTie.calculationRun).toEqual({
        runId: higherTieRunId,
        status: "complete",
        failureCode: null,
      })

      yield* seedCalculationRun({
        id: nextTestUuid(),
        principalId,
        status: "complete",
        revisionSequence: 2,
        createdAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:20:00.000Z")),
      })
      yield* seedCalculationRun({
        id: nextTestUuid(),
        principalId,
        status: "complete",
        revisionSequence: 99,
        reportingCurrency: "USD",
      })
      const taxYear = yield* currentGermanTaxYear
      yield* seedCalculationRun({
        id: nextTestUuid(),
        principalId,
        status: "complete",
        revisionSequence: 100,
        taxYear: taxYear - 1,
      })

      const loaded = yield* client.syncRuns.getSyncRun({ params: { runId: started.runId } })
      expect(loaded.calculationRun).toEqual({
        runId: higherTieRunId,
        status: "complete",
        failureCode: null,
      })
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("returns the current user's run", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      const sourceIds = [nextTestUuid()]
      yield* seedCoinbaseSources({ userId, principalId, sourceIds })

      const client = yield* makeAuthenticatedClient({ userId })
      const started = yield* client.syncRuns.startSyncRun(undefined)
      const loaded = yield* client.syncRuns.getSyncRun({
        params: { runId: started.runId },
      })

      expect(loaded.runId).toBe(started.runId)
      expect(loaded.items).toHaveLength(1)
      const loadedJobId = loaded.items[0]?.jobId
      const startedJobId = started.items[0]?.jobId
      expect(loadedJobId).toBeDefined()
      expect(startedJobId).toBeDefined()
      expect(loadedJobId).toBe(startedJobId)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("rejects another user's run", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const otherUserId = nextTestUuid()
      yield* seedCoinbaseSources({
        userId,
        principalId: nextTestUuid(),
        sourceIds: [nextTestUuid()],
      })
      yield* seedPrincipalUser({ userId: otherUserId, principalId: nextTestUuid() })

      const ownerClient = yield* makeAuthenticatedClient({ userId })
      const started = yield* ownerClient.syncRuns.startSyncRun(undefined)
      const otherClient = yield* makeAuthenticatedClient({ userId: otherUserId })
      const result = yield* otherClient.syncRuns
        .getSyncRun({
          params: { runId: started.runId },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("SyncRunNotFoundError")
      }
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("refreshes child completion into aggregate API status", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      const sourceIds = [nextTestUuid(), nextTestUuid()]
      yield* seedCoinbaseSources({ userId, principalId, sourceIds })

      const client = yield* makeAuthenticatedClient({ userId })
      const started = yield* client.syncRuns.startSyncRun(undefined)

      const [firstItem, secondItem] = started.items
      if (
        firstItem === undefined ||
        secondItem === undefined ||
        firstItem.jobId === null ||
        secondItem.jobId === null
      ) {
        return yield* Effect.die("Expected two sync run items")
      }

      yield* markJobTerminal({ jobId: firstItem.jobId, status: "completed" })
      yield* markJobTerminal({ jobId: secondItem.jobId, status: "failed" })

      const loaded = yield* client.syncRuns.getSyncRun({
        params: { runId: started.runId },
      })

      expect(loaded.status).toBe("partially_failed")
      expect(loaded.completedSourceCount).toBe(1)
      expect(loaded.failedSourceCount).toBe(1)
      expect(loaded.items.map((item) => item.status).sort()).toEqual(["completed", "failed"])
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )
})
