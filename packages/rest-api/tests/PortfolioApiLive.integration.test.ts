import { seedMovementLegs } from "../../persistence/tests/support/movement-leg-fixtures.ts"
import * as DateTime from "effect/DateTime"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
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
import { PortfolioAssetsResponse } from "../src/definitions/PortfolioApi.ts"
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
    yield* seedMovementLegs([
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
    yield* seedMovementLegs([
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
})
