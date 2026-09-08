import { TaxMaxi, TaxMaxiError, toTaxMaxiError } from "../../sdk/src/index.ts"
import { SourceSyncQueueUnexpectedTestLive } from "./support/SourceSyncQueueUnexpectedTestLive.ts"
import { prepareMovementLegFixtures } from "../../persistence/tests/support/movement-leg-fixtures.ts"
import * as DateTime from "effect/DateTime"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { NodeHttpServer } from "@effect/platform-node"
import { JurisdictionCode, TaxYear } from "@my/core/accounting"
import {
  AuthService,
  HashedPassword,
  PasswordHasher,
  type AuthServiceShape,
} from "@my/core/authentication"
import { CurrencyCode } from "@my/core/currency"
import { PrincipalId } from "@my/core/ownership"
import {
  SourceSyncJobRepository,
  SourceSyncRunService,
  SourceSyncService,
  TransferReconciliationService,
  type SourceSyncRunServiceShape,
  type SourceSyncServiceShape,
  type TransferReconciliationServiceShape,
} from "@my/sync-engine/services"
import * as BigDecimal from "effect/BigDecimal"
import * as Chunk from "effect/Chunk"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Deferred from "effect/Deferred"
import * as Fiber from "effect/Fiber"
import * as Exit from "effect/Exit"
import { vi } from "vitest"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { drizzle } from "../../persistence/src/layers/PgClientLive.ts"
import { eq } from "../../persistence/src/query/index.ts"
import { RepositoriesLive } from "../../persistence/src/layers/RepositoriesLive.ts"
import { CalculationRunRepositoryLive } from "../../persistence/src/layers/CalculationRunRepositoryLive.ts"
import { CalculationRunServiceLive } from "../../persistence/src/layers/CalculationRunServiceLive.ts"
import { FactualLedgerRepositoryLive } from "../../persistence/src/layers/FactualLedgerRepositoryLive.ts"
import { PersistenceError } from "../../persistence/src/errors/RepositoryError.ts"
import { schema } from "../../persistence/src/schema/index.ts"
import {
  CalculationRunId,
  CalculationRunRepository,
} from "../../persistence/src/services/CalculationRunRepository.ts"
import { CalculationRunService } from "../../persistence/src/services/CalculationRunService.ts"
import {
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
  TEST_BTC_ASSET_ID,
} from "../../persistence/tests/support/integration-test-kit.ts"
import { AnonSessionServiceLive } from "../src/layers/AnonSessionServiceLive.ts"
import {
  PortfolioCalculationStatusResponse,
  PortfolioAssetsResponse,
} from "../src/definitions/PortfolioApi.ts"
import { SourceFifoLotsResponse, SourceOverviewResponse } from "../src/definitions/SourcesApi.ts"
import { SimpleTokenValidatorLive } from "../src/layers/AuthMiddlewareLive.ts"
import { TaxMaxiApiLive } from "../src/layers/TaxMaxiApiLive.ts"
import { makeX402PaymentValidatorTestLive } from "./support/X402PaymentValidatorTestLive.ts"
import { SIWXProofVerifierTestLive } from "./support/SIWXProofVerifierTestLive.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_rest_api_portfolio",
})
const TestPgClientLive = context.TestPgClientLive
const TestConfigProvider = ConfigProvider.fromEnvRecord({
  ANON_SESSION_SECRET: "test-anon-session-secret-32-bytes-long",
})
const AnonSessionServiceTestLive = AnonSessionServiceLive.pipe(
  Layer.provide(ConfigProvider.layer(TestConfigProvider))
)
const X402PaymentValidatorTestLive = makeX402PaymentValidatorTestLive({
  validPaymentHeader: "valid-test-x402-payment",
})

const SourceSyncServiceTestLive = Layer.succeed(SourceSyncService, {
  startSourceSyncJob: () =>
    Effect.die("SourceSyncService test stub: startSourceSyncJob not implemented"),
  replaySourceSyncJob: () =>
    Effect.die("SourceSyncService test stub: replaySourceSyncJob not implemented"),
  getSourceSyncJob: () =>
    Effect.die("SourceSyncService test stub: getSourceSyncJob not implemented"),
} satisfies SourceSyncServiceShape)

const SourceSyncRunServiceTestLive = Layer.succeed(SourceSyncRunService, {
  startSyncRun: () => Effect.die("SourceSyncRunService test stub: startSyncRun not implemented"),
  getSyncRun: () => Effect.die("SourceSyncRunService test stub: getSyncRun not implemented"),
} satisfies SourceSyncRunServiceShape)

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

const PersistenceLayer = Layer.mergeAll(
  RepositoriesLive,
  SourceSyncServiceTestLive,
  SourceSyncRunServiceTestLive,
  TransferReconciliationServiceTestLive,
  AuthServiceTestLive,
  PasswordHasherTestLive
).pipe(Layer.provideMerge(TestPgClientLive))

const HttpLive = HttpRouter.serve(
  TaxMaxiApiLive.pipe(
    Layer.provide(SourceSyncQueueUnexpectedTestLive),
    Layer.provide(AnonSessionServiceTestLive),
    Layer.provide(SIWXProofVerifierTestLive),
    Layer.provide(X402PaymentValidatorTestLive),
    Layer.provide(SimpleTokenValidatorLive)
  )
).pipe(Layer.provideMerge(PersistenceLayer), Layer.provideMerge(NodeHttpServer.layerTest))

const fixtureIds = {
  userId: "00000000-0000-4000-8000-000000000481",
  principalId: "00000000-0000-4000-8000-000000000482",
  sourceId: "00000000-0000-4000-8000-000000000483",
  activeRunId: "00000000-0000-4000-8000-000000000484",
  latestRunId: "00000000-0000-4000-8000-000000000485",
  acquisitionEventId: "00000000-0000-4000-8000-000000000486",
  factualLegId: "00000000-0000-4000-8000-000000000487",
  otherCustodyUnitId: "00000000-0000-4000-8000-000000000488",
  otherAcquisitionEventId: "00000000-0000-4000-8000-000000000489",
  unpricedAssetId: "00000000-0000-4000-8000-000000000490",
  valuedTransactionId: "00000000-0000-4000-8000-000000000491",
  unpricedTransactionId: "00000000-0000-4000-8000-000000000492",
  valuedLegId: "00000000-0000-4000-8000-000000000493",
  unpricedLegId: "00000000-0000-4000-8000-000000000494",
} as const

const currentGermanTaxYear = DateTime.now.pipe(
  Effect.map(DateTime.setZoneNamedUnsafe("Europe/Berlin")),
  Effect.map(DateTime.toParts),
  Effect.map(({ year }) => year)
)

const seedActivePortfolioRun = Effect.gen(function* () {
  const fixture = yield* seedSyncEngineRepositoryFixture(fixtureIds)
  yield* seedSyncEngineAssets({
    baseBlockchainId: fixture.baseBlockchainId,
    bitcoinBlockchainId: fixture.bitcoinBlockchainId,
  })

  const db = yield* drizzle
  const taxYear = yield* currentGermanTaxYear
  const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2026-05-01T10:00:00.000Z"))

  yield* db
    .update(schema.assets)
    .set({ coingeckoCoinId: null })
    .where(eq(schema.assets.id, TEST_BTC_ASSET_ID))

  yield* db.insert(schema.calculationRuns).values([
    {
      id: fixtureIds.activeRunId,
      principalId: fixture.principalId,
      jurisdiction: "DE",
      taxYear,
      reportingCurrency: "EUR",
      engineVersion: "test-engine-v1",
      ruleSetVersion: "test-rules-v1",
      inputLedgerRevision: `v2:1:1.1.1:${"a".repeat(64)}`,
      valuationRevision: `sha256:${"b".repeat(64)}`,
      status: "partial",
      accountingMethod: "fifo",
      inventoryScope: "per_custody_unit",
      appliedChoiceIds: [],
      appliedRules: [],
      processedEventIds: [fixtureIds.acquisitionEventId],
      startedAt: timestamp,
      completedAt: timestamp,
    },
    {
      id: fixtureIds.latestRunId,
      principalId: fixture.principalId,
      jurisdiction: "DE",
      taxYear,
      reportingCurrency: "EUR",
      engineVersion: "test-engine-v1",
      ruleSetVersion: "test-rules-v1",
      inputLedgerRevision: `v2:2:2.2.2:${"c".repeat(64)}`,
      valuationRevision: `sha256:${"d".repeat(64)}`,
      status: "running",
      appliedChoiceIds: [],
      appliedRules: [],
      processedEventIds: [],
      startedAt: timestamp,
    },
  ])

  yield* db.insert(schema.calculationRunCustodyUnits).values({
    runId: fixtureIds.activeRunId,
    principalId: fixture.principalId,
    custodyUnitId: fixture.sourceId,
  })
  yield* db.insert(schema.calculationRunCustodyUnitSources).values({
    runId: fixtureIds.activeRunId,
    principalId: fixture.principalId,
    custodyUnitId: fixture.sourceId,
    sourceId: fixture.sourceId,
  })
  yield* db.insert(schema.calculationRunDerivedLots).values({
    runId: fixtureIds.activeRunId,
    principalId: fixture.principalId,
    sequence: 0,
    acquisitionEventId: fixtureIds.acquisitionEventId,
    assetId: TEST_BTC_ASSET_ID,
    custodyUnitId: fixture.sourceId,
    acquiredAt: timestamp,
    remainingQuantity: "2",
    costBasisPerUnit: "10",
  })
  yield* db.insert(schema.calculationRunBlockers).values([
    {
      runId: fixtureIds.activeRunId,
      principalId: fixture.principalId,
      sequence: 0,
      code: "missing_valuation",
      eventId: fixtureIds.acquisitionEventId,
      assetId: TEST_BTC_ASSET_ID,
      custodyUnitId: fixture.sourceId,
    },
    {
      runId: fixtureIds.activeRunId,
      principalId: fixture.principalId,
      sequence: 1,
      code: "missing_valuation",
      eventId: fixtureIds.factualLegId,
      assetId: TEST_BTC_ASSET_ID,
      custodyUnitId: fixture.sourceId,
    },
    {
      runId: fixtureIds.activeRunId,
      principalId: fixture.principalId,
      sequence: 2,
      code: "unknown_cause",
      eventId: fixtureIds.factualLegId,
      assetId: TEST_BTC_ASSET_ID,
      custodyUnitId: fixture.sourceId,
    },
  ])
  yield* db.insert(schema.activeCalculationRuns).values({
    principalId: fixture.principalId,
    jurisdiction: "DE",
    taxYear,
    reportingCurrency: "EUR",
    runId: fixtureIds.activeRunId,
    minimumActivationRevision: "0",
  })
})

const seedFactualLedgerOnly = Effect.gen(function* () {
  const fixture = yield* seedSyncEngineRepositoryFixture(fixtureIds)
  yield* seedSyncEngineAssets({
    baseBlockchainId: fixture.baseBlockchainId,
    bitcoinBlockchainId: fixture.bitcoinBlockchainId,
  })

  const db = yield* drizzle
  const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2026-05-01T10:00:00.000Z"))
  yield* db.insert(schema.transactionLegs).values(
    yield* prepareMovementLegFixtures([
      {
        movementIdentity: {
          sourceRecordKey: "portfolio-factual-only-leg",
          componentKey: "movement",
        },
        id: fixtureIds.factualLegId,
        sourceId: fixture.sourceId,
        externalId: "portfolio-factual-only-leg",
        timestamp,
        principalId: fixture.principalId,
        assetId: TEST_BTC_ASSET_ID,
        assetRepresentationId: null,
        amount: "99",
        kind: "acquisition",
        provenance: "deterministic",
        originKind: "none" as const,
        fiatAmount: "990",
        fiatCurrency: "EUR",
      },
    ])
  )
})

const seedValuedAndUnpricedFacts = Effect.gen(function* () {
  const fixture = yield* seedSyncEngineRepositoryFixture(fixtureIds)
  yield* seedSyncEngineAssets({
    baseBlockchainId: fixture.baseBlockchainId,
    bitcoinBlockchainId: fixture.bitcoinBlockchainId,
  })

  const db = yield* drizzle
  const taxYear = yield* currentGermanTaxYear
  const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe(`${taxYear}-05-01T10:00:00.000Z`))
  const quoteAt = DateTime.toDateUtc(DateTime.makeUnsafe(`${taxYear}-05-01T00:00:00.000Z`))

  yield* db
    .update(schema.assets)
    .set({ coingeckoCoinId: null })
    .where(eq(schema.assets.id, TEST_BTC_ASSET_ID))
  yield* db.insert(schema.assets).values({
    id: fixtureIds.unpricedAssetId,
    name: "Unpriced T17 asset",
    symbol: "NOPRICE",
    coingeckoCoinId: null,
    type: "fungible",
  })
  yield* db.insert(schema.transactions).values([
    {
      id: fixtureIds.valuedTransactionId,
      sourceId: fixture.sourceId,
      externalId: "t17-valued-acquisition",
      timestamp,
      transactionType: "buy_fiat",
      principalId: fixture.principalId,
    },
    {
      id: fixtureIds.unpricedTransactionId,
      sourceId: fixture.sourceId,
      externalId: "t17-unpriced-acquisition",
      timestamp,
      transactionType: "buy_fiat",
      principalId: fixture.principalId,
    },
  ])
  yield* db.insert(schema.transactionLegs).values(
    yield* prepareMovementLegFixtures([
      {
        movementIdentity: {
          sourceRecordKey: "t17-valued-acquisition-leg",
          componentKey: "movement",
        },
        id: fixtureIds.valuedLegId,
        sourceId: fixture.sourceId,
        externalId: "t17-valued-acquisition-leg",
        timestamp,
        principalId: fixture.principalId,
        assetId: TEST_BTC_ASSET_ID,
        amount: "2",
        kind: "acquisition",
        provenance: "deterministic",
        originKind: "none" as const,
        transactionId: fixtureIds.valuedTransactionId,
      },
      {
        movementIdentity: {
          sourceRecordKey: "t17-unpriced-acquisition-leg",
          componentKey: "movement",
        },
        id: fixtureIds.unpricedLegId,
        sourceId: fixture.sourceId,
        externalId: "t17-unpriced-acquisition-leg",
        timestamp,
        principalId: fixture.principalId,
        assetId: fixtureIds.unpricedAssetId,
        amount: "3",
        kind: "acquisition",
        provenance: "deterministic",
        originKind: "none" as const,
        transactionId: fixtureIds.unpricedTransactionId,
      },
    ])
  )
  yield* db.insert(schema.assetPrices).values({
    assetId: TEST_BTC_ASSET_ID,
    timestamp: quoteAt,
    price: "100",
    currency: "EUR",
    source: "t17-daily-quote",
  })

  return { principalId: fixture.principalId, taxYear }
})

const seedOtherCustodyUnitPosition = Effect.gen(function* () {
  const db = yield* drizzle
  const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2026-05-02T10:00:00.000Z"))

  yield* db.insert(schema.custodyUnits).values({
    id: fixtureIds.otherCustodyUnitId,
    principalId: fixtureIds.principalId,
  })
  yield* db.insert(schema.calculationRunCustodyUnits).values({
    runId: fixtureIds.activeRunId,
    principalId: fixtureIds.principalId,
    custodyUnitId: fixtureIds.otherCustodyUnitId,
  })
  yield* db.insert(schema.calculationRunDerivedLots).values({
    runId: fixtureIds.activeRunId,
    principalId: fixtureIds.principalId,
    sequence: 1,
    acquisitionEventId: fixtureIds.otherAcquisitionEventId,
    assetId: TEST_BTC_ASSET_ID,
    custodyUnitId: fixtureIds.otherCustodyUnitId,
    acquiredAt: timestamp,
    remainingQuantity: "3",
    costBasisPerUnit: "20",
  })
})

const FailingCalculationRunRepositoryLive = Layer.effect(
  CalculationRunRepository,
  Effect.map(CalculationRunRepository, (repository) =>
    CalculationRunRepository.of({
      fail: repository.fail,
      getLatestStatus: repository.getLatestStatus,
      getSyncStatus: repository.getSyncStatus,
      observeSyncPreparation: repository.observeSyncPreparation,
      failSyncPreparation: repository.failSyncPreparation,
      listRequestedTaxYears: repository.listRequestedTaxYears,
      listActiveTaxYears: repository.listActiveTaxYears,
      persist: () =>
        Effect.fail(
          new PersistenceError({
            operation: "portfolioApiLive.t17.persist",
            cause: "forced T17 calculation persistence failure",
          })
        ),
      settleStaleAndFindRecomputePrincipals: repository.settleStaleAndFindRecomputePrincipals,
      start: repository.start,
    })
  )
).pipe(Layer.provide(CalculationRunRepositoryLive))

const FailingCalculationRunServiceLive = CalculationRunServiceLive.pipe(
  Layer.provide(Layer.merge(FailingCalculationRunRepositoryLive, FactualLedgerRepositoryLive))
)

const CalculationRunServiceTestLive = CalculationRunServiceLive.pipe(
  Layer.provide(Layer.merge(CalculationRunRepositoryLive, FactualLedgerRepositoryLive))
)

const makeRecompute = ({
  principalId,
  runId,
  taxYear,
}: {
  readonly principalId: string
  readonly runId: string
  readonly taxYear: number
}) =>
  Effect.flatMap(CalculationRunService, (service) =>
    service.recompute({
      id: CalculationRunId.make(runId),
      principalId: PrincipalId.make(principalId),
      jurisdiction: JurisdictionCode.make("DE"),
      taxYear: TaxYear.make(taxYear),
      reportingCurrency: CurrencyCode.make("EUR"),
      accountingChoices: [],
    })
  )

const getPortfolio = ({
  userId,
  path = "/v1/portfolio/assets",
}: {
  userId: string
  path?: string
}) =>
  Effect.gen(function* () {
    const response = yield* HttpClientRequest.get(path).pipe(
      HttpClientRequest.bearerToken(`user_${userId}_admin`),
      HttpClient.execute
    )
    return { status: response.status, body: yield* response.json }
  })

const getSourceOverview = ({ sourceId, userId }: { sourceId: string; userId: string }) =>
  Effect.gen(function* () {
    const response = yield* HttpClientRequest.get(`/v1/sources/${sourceId}/overview`).pipe(
      HttpClientRequest.bearerToken(`user_${userId}_admin`),
      HttpClient.execute
    )
    return { status: response.status, body: yield* response.json }
  })

const getSourceFifoLots = ({ sourceId, userId }: { sourceId: string; userId: string }) =>
  Effect.gen(function* () {
    const response = yield* HttpClientRequest.get(
      `/v1/sources/${sourceId}/fifo-lots?limit=100`
    ).pipe(HttpClientRequest.bearerToken(`user_${userId}_admin`), HttpClient.execute)
    return { status: response.status, body: yield* response.json }
  })

// Each read starts fresh SDK clients against the same real HTTP server. Comparing
// the whole wire value preserves every request/attempt ID, state, null and date.
const calculationStatus = (sourceJobId?: string, taxYear = 2024) =>
  HttpServer.addressFormattedWith((baseUrl) =>
    Effect.gen(function* () {
      const { status, body } = yield* getPortfolio({
        userId: fixtureIds.userId,
        path: `/v1/portfolio/calculation-status?taxYear=${taxYear}${sourceJobId === undefined ? "" : `&sourceJobId=${sourceJobId}`}`,
      })
      expect(status).toBe(200)
      const input = { taxYear, ...(sourceJobId === undefined ? {} : { sourceJobId }) }
      const options = { baseUrl, apiKey: `user_${fixtureIds.userId}_admin` }
      const promiseResult = yield* Effect.promise(() =>
        new TaxMaxi(options).portfolio.getCalculationStatus(input)
      )
      const effectResult = yield* new TaxMaxi(options).effect.portfolio.getCalculationStatus(input)
      expect(promiseResult).toEqual(body)
      expect(effectResult).toEqual(body)
      return yield* Schema.decodeUnknownEffect(PortfolioCalculationStatusResponse)(body)
    })
  ).pipe(Effect.provide(HttpLive), Effect.scoped)

const completeCalculationSourceJob = context.runWithLayer({
  layer: RepositoriesLive,
  effect: Effect.gen(function* () {
    const repository = yield* SourceSyncJobRepository
    const job = yield* repository.createOrReuseJob({
      sourceId: fixtureIds.sourceId,
      principalId: fixtureIds.principalId,
      mode: "sync",
      maxAttempts: 3,
    })
    yield* repository.claimJob({
      jobId: job.id,
      workerId: "http-proof",
      startedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-02-01T00:00:00Z")),
    })
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

const recomputeSelectedYear = (runId: string) =>
  makeRecompute({
    principalId: fixtureIds.principalId,
    runId,
    taxYear: 2024,
  })

const seedCalculationStatus = seedSyncEngineRepositoryFixture(fixtureIds).pipe(
  Effect.provide(TestPgClientLive),
  Effect.scoped
)

const readCalculationEvidence = Effect.gen(function* () {
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
        id: schema.calculationSyncAttempts.id,
        status: schema.calculationSyncAttempts.status,
      })
      .from(schema.calculationSyncAttempts),
    runs: yield* db
      .select({ id: schema.calculationRuns.id, status: schema.calculationRuns.status })
      .from(schema.calculationRuns),
  }
}).pipe(Effect.provide(TestPgClientLive), Effect.scoped)

await Effect.runPromise(context.recreateTestDatabase())

describe("PortfolioApiLive", () => {
  beforeEach(() => Effect.runPromise(context.recreateTestDatabase()))

  it.effect("serves the active run while exposing a newer calculation in progress", () =>
    Effect.gen(function* () {
      yield* seedActivePortfolioRun.pipe(Effect.provide(TestPgClientLive), Effect.scoped)

      const response = yield* getPortfolio({ userId: fixtureIds.userId }).pipe(
        Effect.provide(HttpLive),
        Effect.scoped
      )

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({
        activeRun: {
          runId: fixtureIds.activeRunId,
          status: "partial",
          blockerCounts: [
            { code: "missing_valuation", count: 2 },
            { code: "unknown_cause", count: 1 },
          ],
        },
        latestRun: { runId: fixtureIds.latestRunId, status: "running", failureCode: null },
        summary: {
          totalValue: null,
          costBasis: null,
          profitLoss: null,
          profitLossPercentage: null,
        },
        assets: [
          {
            assetId: TEST_BTC_ASSET_ID,
            amount: "2",
            currentPrice: null,
            totalValue: null,
            profitLoss: null,
          },
        ],
      })
    })
  )

  it.effect("keeps valued facts while an unpriced asset makes the public run partial", () =>
    Effect.gen(function* () {
      const { principalId, taxYear } = yield* seedValuedAndUnpricedFacts.pipe(
        Effect.provide(TestPgClientLive),
        Effect.scoped
      )
      yield* context.runWithLayer({
        effect: makeRecompute({
          principalId,
          runId: fixtureIds.activeRunId,
          taxYear,
        }),
        layer: CalculationRunServiceTestLive,
      })

      const response = yield* getPortfolio({ userId: fixtureIds.userId }).pipe(
        Effect.provide(HttpLive),
        Effect.scoped
      )
      const portfolio = yield* Schema.decodeUnknownEffect(PortfolioAssetsResponse)(response.body)
      const fifoLotsResponse = yield* getSourceFifoLots({
        sourceId: fixtureIds.sourceId,
        userId: fixtureIds.userId,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
      const fifoLots = yield* Schema.decodeUnknownEffect(SourceFifoLotsResponse)(
        fifoLotsResponse.body
      )

      expect(response.status).toBe(200)
      expect(portfolio.activeRun).toMatchObject({
        runId: fixtureIds.activeRunId,
        status: "partial",
        blockerCounts: [{ code: "missing_valuation", count: 1 }],
      })
      expect(portfolio.latestRun).toMatchObject({
        runId: fixtureIds.activeRunId,
        status: "partial",
        failureCode: null,
      })
      expect(
        portfolio.assets.map(({ assetId, amount, currentPrice, totalValue }) => ({
          assetId,
          amount: BigDecimal.format(amount),
          currentPrice,
          totalValue,
        }))
      ).toEqual([
        {
          assetId: TEST_BTC_ASSET_ID,
          amount: "2",
          currentPrice: null,
          totalValue: null,
        },
        {
          assetId: fixtureIds.unpricedAssetId,
          amount: "3",
          currentPrice: null,
          totalValue: null,
        },
      ])
      expect(fifoLotsResponse.status).toBe(200)
      expect(fifoLots.calculationRunId).toBe(fixtureIds.activeRunId)
      expect(
        fifoLots.fifoLots.map(
          ({ asset, costBasisCurrency, costBasisPerToken, costBasisStatus }) => ({
            assetId: asset.assetId,
            costBasisCurrency,
            costBasisPerToken,
            costBasisStatus,
          })
        )
      ).toEqual([
        {
          assetId: TEST_BTC_ASSET_ID,
          costBasisCurrency: "EUR",
          costBasisPerToken: "100",
          costBasisStatus: "known",
        },
        {
          assetId: fixtureIds.unpricedAssetId,
          costBasisCurrency: null,
          costBasisPerToken: null,
          costBasisStatus: "pending_review",
        },
      ])
    })
  )

  it.effect("keeps the prior active result readable when a newer calculation fails", () =>
    Effect.gen(function* () {
      yield* seedActivePortfolioRun.pipe(Effect.provide(TestPgClientLive), Effect.scoped)
      const beforePortfolioResponse = yield* getPortfolio({ userId: fixtureIds.userId }).pipe(
        Effect.provide(HttpLive),
        Effect.scoped
      )
      const beforeOverviewResponse = yield* getSourceOverview({
        sourceId: fixtureIds.sourceId,
        userId: fixtureIds.userId,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
      const beforePortfolio = yield* Schema.decodeUnknownEffect(PortfolioAssetsResponse)(
        beforePortfolioResponse.body
      )
      const beforeOverview = yield* Schema.decodeUnknownEffect(SourceOverviewResponse)(
        beforeOverviewResponse.body
      )
      yield* Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .delete(schema.calculationRuns)
          .where(eq(schema.calculationRuns.id, fixtureIds.latestRunId))
      }).pipe(Effect.provide(TestPgClientLive), Effect.scoped)

      const taxYear = yield* currentGermanTaxYear
      const failure = yield* context.runWithLayer({
        effect: makeRecompute({
          principalId: fixtureIds.principalId,
          runId: fixtureIds.latestRunId,
          taxYear,
        }).pipe(Effect.flip),
        layer: FailingCalculationRunServiceLive,
      })
      expect(failure).toMatchObject({
        operation: "portfolioApiLive.t17.persist",
      })

      const portfolio = yield* getPortfolio({ userId: fixtureIds.userId }).pipe(
        Effect.provide(HttpLive),
        Effect.scoped
      )
      const overview = yield* getSourceOverview({
        sourceId: fixtureIds.sourceId,
        userId: fixtureIds.userId,
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
      const afterPortfolio = yield* Schema.decodeUnknownEffect(PortfolioAssetsResponse)(
        portfolio.body
      )
      const afterOverview = yield* Schema.decodeUnknownEffect(SourceOverviewResponse)(overview.body)

      expect(portfolio).toMatchObject({
        status: 200,
        body: {
          activeRun: {
            runId: fixtureIds.activeRunId,
            status: "partial",
            blockerCounts: [
              { code: "missing_valuation", count: 2 },
              { code: "unknown_cause", count: 1 },
            ],
          },
          latestRun: {
            runId: fixtureIds.latestRunId,
            status: "failed",
            failureCode: "calculation_failed",
          },
          assets: [{ assetId: TEST_BTC_ASSET_ID, amount: "2" }],
        },
      })
      expect(overview).toMatchObject({
        status: 200,
        body: {
          calculationRunId: fixtureIds.activeRunId,
          source: { id: fixtureIds.sourceId },
          totals: { fifoLotCount: 1 },
        },
      })
      expect({
        activeRun: afterPortfolio.activeRun,
        summary: afterPortfolio.summary,
        assets: afterPortfolio.assets,
      }).toEqual({
        activeRun: beforePortfolio.activeRun,
        summary: beforePortfolio.summary,
        assets: beforePortfolio.assets,
      })
      expect(afterOverview).toEqual(beforeOverview)
    })
  )

  it.effect("returns an empty portfolio instead of deriving positions from factual rows", () =>
    Effect.gen(function* () {
      yield* seedFactualLedgerOnly.pipe(Effect.provide(TestPgClientLive), Effect.scoped)

      const response = yield* getPortfolio({ userId: fixtureIds.userId }).pipe(
        Effect.provide(HttpLive),
        Effect.scoped
      )

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({
        activeRun: null,
        latestRun: null,
        assets: [],
      })
    })
  )

  it.effect("filters positions through the active run custody-unit snapshot", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* seedActivePortfolioRun
        yield* seedOtherCustodyUnitPosition
      }).pipe(Effect.provide(TestPgClientLive), Effect.scoped)

      const responses = yield* Effect.gen(function* () {
        const all = yield* getPortfolio({ userId: fixtureIds.userId })
        const selected = yield* getPortfolio({
          userId: fixtureIds.userId,
          path: `/v1/portfolio/assets?sourceId=${fixtureIds.sourceId}`,
        })
        return { all, selected }
      }).pipe(Effect.provide(HttpLive), Effect.scoped)

      expect(responses.all.body).toMatchObject({ assets: [{ amount: "5" }] })
      expect(responses.selected.body).toMatchObject({ assets: [{ amount: "2" }] })
    })
  )

  it.effect("keeps EUR run positions when another live display currency is requested", () =>
    Effect.gen(function* () {
      yield* seedActivePortfolioRun.pipe(Effect.provide(TestPgClientLive), Effect.scoped)

      const response = yield* getPortfolio({
        userId: fixtureIds.userId,
        path: "/v1/portfolio/assets?currency=usd",
      }).pipe(Effect.provide(HttpLive), Effect.scoped)

      expect(response.body).toMatchObject({
        currency: "USD",
        activeRun: { runId: fixtureIds.activeRunId },
        assets: [{ amount: "2", profitLoss: null }],
      })
    })
  )
  it.effect(
    "discovers selected-year work over HTTP and keeps R0 until the captured R1 settles",
    () =>
      Effect.gen(function* () {
        yield* seedCalculationStatus
        yield* context.runWithLayer({
          layer: CalculationRunServiceTestLive,
          effect: recomputeSelectedYear(fixtureIds.activeRunId),
        })
        const job = yield* completeCalculationSourceJob
        const queued = yield* calculationStatus(job)
        expect(queued.scope).toEqual({
          jurisdiction: "DE",
          taxYear: 2024,
          reportingCurrency: "EUR",
        })
        expect(queued.activeRun).toEqual({ runId: fixtureIds.activeRunId, status: "complete" })
        expect(queued.jobs).toMatchObject([
          {
            sourceJobId: job,
            activeCoverage: "not_covered",
            coveringRun: null,
            work: { status: "queued", attempts: [] },
          },
        ])
        const requestId = queued.jobs[0]?.work?.requestId
        expect(requestId).toBeDefined()
        const beforeReads = yield* readCalculationEvidence
        expect((yield* calculationStatus()).work.requests).toMatchObject([
          { requestId, sourceJobId: job },
        ])
        expect((yield* calculationStatus(job, 2026)).work.status).toBe("queued")
        expect((yield* calculationStatus(job, 2025)).activeRun).toBeNull()
        expect((yield* calculationStatus(job, 2025)).work).toEqual({
          status: "not_requested",
          requests: [],
        })
        expect(yield* readCalculationEvidence).toEqual(beforeReads)

        const reached = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const repositoryLayer = Layer.effect(
          CalculationRunRepository,
          Effect.map(CalculationRunRepository, (repository) =>
            CalculationRunRepository.of({
              ...repository,
              persist: (params) =>
                Deferred.succeed(reached, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(repository.persist(params))
                ),
            })
          )
        ).pipe(Layer.provide(CalculationRunRepositoryLive))
        const layer = CalculationRunServiceLive.pipe(
          Layer.provide(Layer.merge(repositoryLayer, FactualLedgerRepositoryLive))
        )
        const fiber = yield* Effect.forkChild(
          context.runWithLayer({ layer, effect: recomputeSelectedYear(fixtureIds.latestRunId) })
        )
        const runningAttempt = yield* Effect.gen(function* () {
          yield* Deferred.await(reached)
          const running = yield* calculationStatus(job)
          expect(running.activeRun).toEqual(queued.activeRun)
          expect(running.jobs).toMatchObject([
            {
              coveringRun: null,
              activeCoverage: "not_covered",
              work: {
                requestId,
                status: "running",
                attempts: [{ runId: fixtureIds.latestRunId, status: "running" }],
              },
            },
          ])
          return running.jobs[0]?.work?.attempts[0]?.attemptId
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
        yield* Fiber.join(fiber)
        expect(runningAttempt).toBeDefined()
        const covered = yield* calculationStatus(job)
        expect(covered.activeRun).toEqual({ runId: fixtureIds.latestRunId, status: "complete" })
        expect(covered.jobs).toMatchObject([
          {
            activeCoverage: "covered",
            coveringRun: { runId: fixtureIds.latestRunId, status: "complete" },
            work: {
              requestId,
              status: "succeeded",
              attempts: [{ runId: fixtureIds.latestRunId, status: "succeeded", failureCode: null }],
            },
          },
        ])
        expect(covered.jobs[0]?.work?.attempts[0]?.attemptId).toBe(runningAttempt)
        expect(yield* calculationStatus()).toEqual(covered)
        const captured = yield* Effect.flatMap(drizzle, (db) =>
          db
            .select({
              runId: schema.calculationRunSyncRequests.runId,
              requestId: schema.calculationRunSyncRequests.requestId,
            })
            .from(schema.calculationRunSyncRequests)
        ).pipe(Effect.provide(TestPgClientLive), Effect.scoped)
        expect(captured).toEqual([{ runId: fixtureIds.latestRunId, requestId }])
        const nextJob = yield* completeCalculationSourceJob
        const filtered = yield* calculationStatus(job)
        expect(filtered.jobs).toHaveLength(1)
        expect(filtered.jobs[0]?.sourceJobId).toBe(job)
        expect(filtered.work).toMatchObject({
          status: "queued",
          requests: [{ sourceJobId: nextJob }],
        })
      })
  )

  it.effect(
    "reports a failed calculation without claiming coverage or replacing the active result",
    () =>
      Effect.gen(function* () {
        yield* seedCalculationStatus
        yield* context.runWithLayer({
          layer: CalculationRunServiceTestLive,
          effect: recomputeSelectedYear(fixtureIds.activeRunId),
        })
        const job = yield* completeCalculationSourceJob
        const result = yield* Effect.exit(
          context.runWithLayer({
            layer: FailingCalculationRunServiceLive,
            effect: recomputeSelectedYear(fixtureIds.latestRunId),
          })
        )
        expect(Exit.isFailure(result)).toBe(true)
        const failed = yield* calculationStatus(job)
        expect(failed.activeRun?.runId).toBe(fixtureIds.activeRunId)
        expect(failed.work.status).toBe("failed")
        expect(failed.jobs).toMatchObject([
          {
            coveringRun: null,
            activeCoverage: "not_covered",
            work: {
              status: "failed",
              attempts: [
                {
                  runId: fixtureIds.latestRunId,
                  status: "failed",
                  failureCode: "calculation_failed",
                },
              ],
            },
          },
        ])
      })
  )

  it.effect("exposes an exact runless preparation failure without covering its source job", () =>
    Effect.gen(function* () {
      yield* seedCalculationStatus
      yield* context.runWithLayer({
        layer: CalculationRunServiceTestLive,
        effect: recomputeSelectedYear(fixtureIds.activeRunId),
      })
      const job = yield* completeCalculationSourceJob
      const queued = yield* calculationStatus(job)
      const requestId = queued.jobs[0]?.work?.requestId
      expect(requestId).toBeDefined()
      yield* context.runWithLayer({
        layer: CalculationRunRepositoryLive,
        effect: Effect.gen(function* () {
          const repository = yield* CalculationRunRepository
          const scope = {
            principalId: PrincipalId.make(fixtureIds.principalId),
            jurisdiction: JurisdictionCode.make("DE"),
            taxYear: TaxYear.make(2024),
            reportingCurrency: CurrencyCode.make("EUR"),
          }
          const preparation = yield* repository.observeSyncPreparation(scope)
          expect(preparation.requestIds).toEqual([requestId])
          yield* repository.failSyncPreparation({
            ...scope,
            preparation,
            failureCode: "price_hydration_failed",
          })
        }),
      })
      const failed = yield* calculationStatus(job)
      expect(failed.activeRun).toEqual(queued.activeRun)
      expect(failed.work.status).toBe("failed")
      expect(failed.jobs).toMatchObject([
        {
          coveringRun: null,
          activeCoverage: "not_covered",
          work: {
            requestId,
            status: "failed",
            attempts: [{ runId: null, status: "failed", failureCode: "price_hydration_failed" }],
          },
        },
      ])
      expect(failed.jobs[0]?.work?.attempts[0]?.attemptId).toBeDefined()
      expect(yield* calculationStatus()).toEqual(failed)
    })
  )

  it.effect("distinguishes legacy unknown coverage from a real partial covering run", () =>
    Effect.gen(function* () {
      yield* seedActivePortfolioRun.pipe(Effect.provide(TestPgClientLive), Effect.scoped)
      const job = yield* completeCalculationSourceJob
      const taxYear = yield* currentGermanTaxYear
      expect((yield* calculationStatus(job, taxYear)).jobs[0]?.activeCoverage).toBe("unknown")
      yield* Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .delete(schema.calculationRuns)
          .where(eq(schema.calculationRuns.id, fixtureIds.latestRunId))
        yield* db.insert(schema.transactionLegs).values(
          yield* prepareMovementLegFixtures([
            {
              movementIdentity: { sourceRecordKey: "http-unpriced", componentKey: "principal" },
              sourceId: fixtureIds.sourceId,
              principalId: fixtureIds.principalId,
              externalId: "http-unpriced",
              timestamp: DateTime.toDateUtc(DateTime.makeUnsafe(`${taxYear}-01-01T00:00:00Z`)),
              assetId: TEST_BTC_ASSET_ID,
              amount: "1",
              kind: "income",
              provenance: "deterministic",
              originKind: "none",
            },
          ])
        )
      }).pipe(Effect.provide(TestPgClientLive), Effect.scoped)
      yield* context.runWithLayer({
        layer: CalculationRunServiceTestLive,
        effect: makeRecompute({
          principalId: fixtureIds.principalId,
          runId: fixtureIds.latestRunId,
          taxYear,
        }),
      })
      const status = yield* calculationStatus(job, taxYear)
      expect(status.activeRun).toEqual({ runId: fixtureIds.latestRunId, status: "partial" })
      expect(status.jobs).toMatchObject([
        {
          activeCoverage: "covered",
          coveringRun: { runId: fixtureIds.latestRunId, status: "partial" },
          work: { status: "succeeded" },
        },
      ])
    })
  )

  it.effect(
    "validates calculation-status authentication, year and job ownership without writes",
    () =>
      Effect.gen(function* () {
        yield* seedCalculationStatus
        const foreign = yield* seedSyncEngineRepositoryFixture({
          userId: "00000000-0000-4000-8000-000000000581",
          principalId: "00000000-0000-4000-8000-000000000582",
          sourceId: "00000000-0000-4000-8000-000000000583",
        }).pipe(Effect.provide(TestPgClientLive), Effect.scoped)
        const jobs = yield* context.runWithLayer({
          layer: RepositoriesLive,
          effect: Effect.gen(function* () {
            const repository = yield* SourceSyncJobRepository
            const owned = yield* repository.createOrReuseJob({
              sourceId: fixtureIds.sourceId,
              principalId: fixtureIds.principalId,
              mode: "sync",
              maxAttempts: 3,
            })
            const other = yield* repository.createOrReuseJob({
              sourceId: foreign.sourceId,
              principalId: foreign.principalId,
              mode: "sync",
              maxAttempts: 3,
            })
            return { owned, other }
          }),
        })
        const beforeReads = yield* readCalculationEvidence
        const pending = yield* calculationStatus(jobs.owned.id)
        expect(pending.jobs).toMatchObject([
          { sourceJobStatus: "pending", work: null, coveringRun: null, activeCoverage: "unknown" },
        ])
        const responses = yield* Effect.gen(function* () {
          const absent = yield* getPortfolio({
            userId: fixtureIds.userId,
            path: "/v1/portfolio/calculation-status?taxYear=2024&sourceJobId=00000000-0000-4000-8000-000000000599",
          })
          const other = yield* getPortfolio({
            userId: fixtureIds.userId,
            path: `/v1/portfolio/calculation-status?taxYear=2024&sourceJobId=${jobs.other.id}`,
          })
          for (const query of [
            "",
            "taxYear=hello",
            "taxYear=2024.5",
            "taxYear=Infinity",
            "taxYear=2024&sourceJobId=bad",
          ]) {
            expect(
              (yield* getPortfolio({
                userId: fixtureIds.userId,
                path: `/v1/portfolio/calculation-status?${query}`,
              })).status
            ).toBe(400)
          }
          yield* HttpServer.addressFormattedWith((baseUrl) =>
            Effect.gen(function* () {
              const client = new TaxMaxi({
                baseUrl,
                apiKey: `user_${fixtureIds.userId}_admin`,
              })
              for (const sourceJobId of ["00000000-0000-4000-8000-000000000599", jobs.other.id]) {
                const input = { taxYear: 2024, sourceJobId }
                const effectError = yield* Effect.flip(
                  client.effect.portfolio.getCalculationStatus(input)
                )
                expect(effectError).toMatchObject({ code: "source_job_not_found" })
                expect(toTaxMaxiError(effectError)).toMatchObject({
                  status: 404,
                  code: "PortfolioCalculationJobNotFoundResponse",
                  cause: { code: "source_job_not_found" },
                })
                yield* Effect.promise(() =>
                  expect(client.portfolio.getCalculationStatus(input)).rejects.toMatchObject({
                    status: 404,
                    code: "PortfolioCalculationJobNotFoundResponse",
                    cause: { code: "source_job_not_found" },
                  })
                )
              }
              for (const input of [
                { taxYear: 2024.5 },
                { taxYear: Number.POSITIVE_INFINITY },
                { taxYear: 2024, sourceJobId: "bad" },
              ]) {
                const effectError = yield* Effect.flip(
                  client.effect.portfolio.getCalculationStatus(input)
                )
                expect(toTaxMaxiError(effectError).status).toBe(400)
                const result = client.portfolio.getCalculationStatus(input)
                yield* Effect.promise(() => expect(result).rejects.toBeInstanceOf(TaxMaxiError))
                yield* Effect.promise(() => expect(result).rejects.toMatchObject({ status: 400 }))
              }
            })
          )
          const unauthorized = yield* HttpClientRequest.get(
            "/v1/portfolio/calculation-status?taxYear=2024"
          ).pipe(HttpClient.execute)
          expect(unauthorized.status).toBe(401)
          return { absent, other }
        }).pipe(Effect.provide(HttpLive), Effect.scoped)
        expect(responses.absent.status).toBe(404)
        expect(responses.absent.body).toMatchObject({ code: "source_job_not_found" })
        expect(responses.other).toEqual(responses.absent)
        expect(yield* readCalculationEvidence).toEqual(beforeReads)
        yield* context.runWithLayer({
          layer: RepositoriesLive,
          effect: Effect.gen(function* () {
            const repository = yield* SourceSyncJobRepository
            const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2026-02-01T00:00:00Z"))
            yield* repository.claimJob({
              jobId: jobs.owned.id,
              workerId: "http-proof",
              startedAt: timestamp,
            })
            yield* repository.failJob({
              jobId: jobs.owned.id,
              message: "fixture provider failure",
              completedAt: timestamp,
            })
          }),
        })
        expect((yield* calculationStatus(jobs.owned.id)).jobs).toMatchObject([
          { sourceJobStatus: "failed", work: null, coveringRun: null, activeCoverage: "unknown" },
        ])
      })
  )
})
