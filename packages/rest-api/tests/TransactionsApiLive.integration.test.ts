import { SourceReplayRepository } from "@my/sync-engine/services"
import { PrincipalAssetOverrideRepositoryLive } from "../../persistence/src/layers/PrincipalAssetOverrideRepositoryLive.ts"
import { PrincipalAssetOverrideRepository } from "../../persistence/src/services/PrincipalAssetOverrideRepository.ts"
import { JurisdictionCode, TaxYear, type MovementPriceInput } from "@my/core/accounting"
import { AuthUserId } from "@my/core/authentication"
import { CurrencyCode } from "@my/core/currency"
import { PrincipalId } from "@my/core/ownership"
import * as Option from "effect/Option"
import { TaxMaxi } from "../../sdk/src/index.ts"
import { SourceSyncJobRepository, type SourceSyncExecutionState } from "@my/sync-engine/services"
import { PrincipalTransactionOverrideRepositoryLive } from "../../persistence/src/layers/PrincipalTransactionOverrideRepositoryLive.ts"
import { PrincipalTransactionOverrideRepository } from "../../persistence/src/services/PrincipalTransactionOverrideRepository.ts"
import { CalculationRunServiceLive } from "../../persistence/src/layers/CalculationRunServiceLive.ts"
import { CalculationRunRepositoryLive } from "../../persistence/src/layers/CalculationRunRepositoryLive.ts"
import { FactualLedgerRepositoryLive } from "../../persistence/src/layers/FactualLedgerRepositoryLive.ts"
import { CalculationRunService } from "../../persistence/src/services/CalculationRunService.ts"
import { CalculationRunId } from "../../persistence/src/services/CalculationRunRepository.ts"
import { SourceSyncQueueUnexpectedTestLive } from "./support/SourceSyncQueueUnexpectedTestLive.ts"
import { prepareMovementLegFixtures } from "../../persistence/tests/support/movement-leg-fixtures.ts"
import * as DateTime from "effect/DateTime"
import * as Statement from "effect/unstable/sql/Statement"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { HttpServerTestLive } from "./support/http-server.ts"
import {
  AuthService,
  HashedPassword,
  PasswordHasher,
  type AuthServiceShape,
} from "@my/core/authentication"
import {
  SourceNormalizationRepository,
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
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { drizzle } from "../../persistence/src/layers/PgClientLive.ts"
import { RepositoriesLive } from "../../persistence/src/layers/RepositoriesLive.ts"
import { and, eq, sql } from "../../persistence/src/query/index.ts"
import { schema } from "../../persistence/src/schema/index.ts"
import {
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
  TEST_BTC_ASSET_ID,
  TEST_BTC_REPRESENTATION_ID,
} from "../../persistence/tests/support/integration-test-kit.ts"
import { TaxMaxiApi } from "../src/definitions/TaxMaxiApi.ts"
import type { TransactionListResponse } from "../src/definitions/TransactionsApi.ts"
import { AnonSessionServiceLive } from "../src/layers/AnonSessionServiceLive.ts"
import { SimpleTokenValidatorLive } from "../src/layers/AuthMiddlewareLive.ts"
import { TaxMaxiApiLive } from "../src/layers/TaxMaxiApiLive.ts"
import { makeX402PaymentValidatorTestLive } from "./support/X402PaymentValidatorTestLive.ts"
import { SIWXProofVerifierTestLive } from "./support/SIWXProofVerifierTestLive.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_rest_api_transactions",
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
).pipe(Layer.provideMerge(PersistenceLayer), Layer.provideMerge(HttpServerTestLive))

const makeAuthenticatedClient = ({ userId }: { readonly userId: string }) =>
  Effect.gen(function* () {
    const baseHttpClient = yield* HttpClient.HttpClient
    return yield* HttpApiClient.makeWith(TaxMaxiApi, {
      httpClient: baseHttpClient.pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(`user_${userId}_admin`))
      ),
    })
  })

const getAuthenticatedStatus = ({
  path,
  userId,
}: {
  readonly path: string
  readonly userId: string
}) =>
  HttpClientRequest.get(path).pipe(
    HttpClientRequest.bearerToken(`user_${userId}_admin`),
    HttpClient.execute,
    Effect.map((response) => response.status)
  )

const fixtureIds = {
  userId: "00000000-0000-4000-8000-000000000181",
  principalId: "00000000-0000-4000-8000-000000000183",
  sourceId: "00000000-0000-4000-8000-00000000ab81",
  buyTransactionId: "00000000-0000-4000-8000-000000046101",
  sellTransactionId: "00000000-0000-4000-8000-000000046102",
  partialTransactionId: "00000000-0000-4000-8000-000000046103",
  unresolvedTransactionId: "00000000-0000-4000-8000-000000046104",
  excludedTransactionId: "00000000-0000-4000-8000-000000046105",
  internalTransferTransactionId: "00000000-0000-4000-8000-000000046106",
  pendingBasisTransactionId: "00000000-0000-4000-8000-000000046107",
  mixedCurrencyTransactionId: "00000000-0000-4000-8000-000000046108",
  missingProceedsTransactionId: "00000000-0000-4000-8000-000000046109",
  partialMatchTransactionId: "00000000-0000-4000-8000-000000046110",
  tieTransactionIds: [
    "00000000-0000-4000-8000-000000046111",
    "00000000-0000-4000-8000-000000046112",
    "00000000-0000-4000-8000-000000046113",
  ],
  buyLegId: "00000000-0000-4000-8000-000000046201",
  sellLegId: "00000000-0000-4000-8000-000000046202",
  partialLegId: "00000000-0000-4000-8000-000000046203",
  internalTransferLegId: "00000000-0000-4000-8000-000000046204",
  pendingBasisAcquisitionLegId: "00000000-0000-4000-8000-000000046205",
  pendingBasisDisposalLegId: "00000000-0000-4000-8000-000000046206",
  internalTransferOutLegId: "00000000-0000-4000-8000-000000046207",
  mixedCurrencyUsdLegId: "00000000-0000-4000-8000-000000046208",
  missingProceedsLegId: "00000000-0000-4000-8000-000000046209",
  partialMatchLegId: "00000000-0000-4000-8000-000000046210",
  tieLegIds: [
    "00000000-0000-4000-8000-000000046211",
    "00000000-0000-4000-8000-000000046212",
    "00000000-0000-4000-8000-000000046213",
  ],
  calculationRunId: "00000000-0000-4000-8000-000000046301",
  competingCalculationRunId: "00000000-0000-4000-8000-000000046302",
  boundaryCalculationRunId: "00000000-0000-4000-8000-000000046303",
  boundaryTransactionId: "00000000-0000-4000-8000-000000046121",
  boundaryLegId: "00000000-0000-4000-8000-000000046221",
  reconciliationId: "00000000-0000-4000-8000-000000046401",
  canonicalSourceId: "00000000-0000-4000-8000-000000000282",
  providerTransferTransactionId: "00000000-0000-4000-8000-000000046122",
  canonicalTransferTransactionId: "00000000-0000-4000-8000-000000046123",
  providerTransferLegId: "00000000-0000-4000-8000-000000046222",
  canonicalTransferLegId: "00000000-0000-4000-8000-000000046223",
  providerTransferId: "00000000-0000-4000-8000-000000046501",
  canonicalTransferId: "00000000-0000-4000-8000-000000046502",
  otherUserId: "00000000-0000-4000-8000-000000000191",
  otherPrincipalId: "00000000-0000-4000-8000-000000000193",
  otherSourceId: "00000000-0000-4000-8000-000000000291",
  emptySourceId: "00000000-0000-4000-8000-000000000283",
  hiddenTransactionId: "00000000-0000-4000-8000-000000046901",
} as const

const seedTransactions = Effect.gen(function* () {
  const fixture = yield* seedSyncEngineRepositoryFixture(fixtureIds)
  yield* seedSyncEngineAssets({
    baseBlockchainId: fixture.baseBlockchainId,
    bitcoinBlockchainId: fixture.bitcoinBlockchainId,
  })
  const otherFixture = yield* seedSyncEngineRepositoryFixture({
    userId: fixtureIds.otherUserId,
    principalId: fixtureIds.otherPrincipalId,
    sourceId: fixtureIds.otherSourceId,
  })
  const db = yield* drizzle

  yield* db.insert(schema.transactions).values([
    {
      id: fixtureIds.buyTransactionId,
      sourceId: fixture.sourceId,
      principalId: fixture.principalId,
      externalId: "transaction-buy",
      timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-01T12:00:00.000Z")),
      transactionType: "buy_fiat",
      providerDescription: "Buy BTC",
    },
    {
      id: fixtureIds.sellTransactionId,
      sourceId: fixture.sourceId,
      principalId: fixture.principalId,
      externalId: "transaction-sell",
      timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-10T12:00:00.000Z")),
      transactionType: "sell_fiat",
      providerDescription: "Sell BTC",
    },
    {
      id: fixtureIds.partialTransactionId,
      sourceId: fixture.sourceId,
      principalId: fixture.principalId,
      externalId: "transaction-partial-valuation",
      timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-05T12:00:00.000Z")),
      transactionType: "buy_fiat",
      providerDescription: "Buy BTC with valuation pending",
    },
    {
      id: fixtureIds.unresolvedTransactionId,
      sourceId: fixture.sourceId,
      principalId: fixture.principalId,
      externalId: "coinbase-unresolved-asset",
      timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T12:00:00.000Z")),
      transactionType: null,
      providerDescription: "Unresolved Coinbase activity",
      metadata: { provider: "coinbase", assetIdentity: "unresolved" },
    },
    {
      id: fixtureIds.excludedTransactionId,
      sourceId: fixture.sourceId,
      principalId: fixture.principalId,
      externalId: "coinbase-excluded-asset",
      timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-09T12:00:00.000Z")),
      transactionType: null,
      providerDescription: "Excluded Coinbase activity",
      metadata: { provider: "coinbase", inclusion: "excluded" },
    },
    {
      id: fixtureIds.hiddenTransactionId,
      sourceId: otherFixture.sourceId,
      principalId: otherFixture.principalId,
      externalId: "other-principal-transaction",
      timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T12:00:00.000Z")),
      transactionType: "buy_fiat",
    },
  ])
  yield* db.insert(schema.transactionLegs).values(
    yield* prepareMovementLegFixtures([
      {
        movementIdentity: {
          sourceRecordKey: "other-principal-transaction:acquisition",
          componentKey: "movement",
        },
        sourceId: otherFixture.sourceId,
        principalId: otherFixture.principalId,
        externalId: "other-principal-transaction:acquisition",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T12:00:00.000Z")),
        assetId: TEST_BTC_ASSET_ID,
        amount: "1",
        kind: "acquisition",
        provenance: "deterministic",
        originKind: "none" as const,
        transactionId: fixtureIds.hiddenTransactionId,
        fiatAmount: null,
        fiatCurrency: null,
      },
      {
        movementIdentity: {
          sourceRecordKey: "transaction-buy:acquisition",
          componentKey: "movement",
        },
        id: fixtureIds.buyLegId,
        sourceId: fixture.sourceId,
        principalId: fixture.principalId,
        externalId: "transaction-buy:acquisition",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-01T12:00:00.000Z")),
        assetId: TEST_BTC_ASSET_ID,
        amount: "0.5",
        kind: "acquisition",
        provenance: "deterministic",
        originKind: "none" as const,
        transactionId: fixtureIds.buyTransactionId,
        fiatAmount: "10000",
        fiatCurrency: "EUR",
      },
      {
        movementIdentity: {
          sourceRecordKey: "transaction-sell:disposal",
          componentKey: "movement",
        },
        id: fixtureIds.sellLegId,
        sourceId: fixture.sourceId,
        principalId: fixture.principalId,
        externalId: "transaction-sell:disposal",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-10T12:00:00.000Z")),
        assetId: TEST_BTC_ASSET_ID,
        amount: "0.4",
        kind: "disposal",
        provenance: "deterministic",
        originKind: "none" as const,
        transactionId: fixtureIds.sellTransactionId,
        fiatAmount: "6000",
        fiatCurrency: "EUR",
      },
      {
        movementIdentity: {
          sourceRecordKey: "transaction-partial-valuation:acquisition",
          componentKey: "movement",
        },
        id: fixtureIds.partialLegId,
        sourceId: fixture.sourceId,
        principalId: fixture.principalId,
        externalId: "transaction-partial-valuation:acquisition",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-05T12:00:00.000Z")),
        assetId: TEST_BTC_ASSET_ID,
        amount: "0.1",
        kind: "acquisition",
        provenance: "deterministic",
        originKind: "none" as const,
        transactionId: fixtureIds.partialTransactionId,
        fiatAmount: null,
        fiatCurrency: null,
      },
    ])
  )
  const completedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"))
  yield* db.insert(schema.calculationRuns).values({
    id: fixtureIds.calculationRunId,
    principalId: fixture.principalId,
    jurisdiction: "DE",
    taxYear: 2025,
    reportingCurrency: "EUR",
    engineVersion: "test-engine-v1",
    ruleSetVersion: "de-crypto-income-tax-v2025-03-06",
    inputLedgerRevision: `v2:1:1.1.1:${"a".repeat(64)}`,
    valuationRevision: `sha256:${"b".repeat(64)}`,
    status: "partial",
    accountingMethod: "fifo",
    inventoryScope: "per_custody_unit",
    appliedChoiceIds: [],
    appliedRules: [],
    processedEventIds: [fixtureIds.buyLegId, fixtureIds.partialLegId, fixtureIds.sellLegId],
    startedAt: completedAt,
    completedAt,
  })
  yield* db.insert(schema.calculationRunCustodyUnits).values({
    runId: fixtureIds.calculationRunId,
    principalId: fixture.principalId,
    custodyUnitId: fixture.sourceId,
  })
  yield* db.insert(schema.calculationRunCustodyUnitSources).values({
    runId: fixtureIds.calculationRunId,
    principalId: fixture.principalId,
    custodyUnitId: fixture.sourceId,
    sourceId: fixture.sourceId,
  })
  yield* db.insert(schema.calculationRunAllocations).values({
    runId: fixtureIds.calculationRunId,
    principalId: fixture.principalId,
    sequence: 0,
    acquisitionEventId: fixtureIds.buyLegId,
    dispositionEventId: fixtureIds.sellLegId,
    assetId: TEST_BTC_ASSET_ID,
    custodyUnitId: fixture.sourceId,
    acquiredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-01T12:00:00.000Z")),
    disposedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-10T12:00:00.000Z")),
    quantity: "0.4",
    costBasis: "4000",
  })
  yield* db.insert(schema.calculationRunRealizedResults).values({
    runId: fixtureIds.calculationRunId,
    sequence: 0,
    sourceId: fixture.sourceId,
    allocationSequence: 0,
    acquisitionEventId: fixtureIds.buyLegId,
    dispositionEventId: fixtureIds.sellLegId,
    assetId: TEST_BTC_ASSET_ID,
    acquiredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-01T12:00:00.000Z")),
    disposedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-10T12:00:00.000Z")),
    quantity: "0.4",
    costBasis: "4000",
    proceeds: "6000",
    gainLoss: "2000",
    treatmentCodes: ["de.taxable_private_disposal"],
  })
  yield* db.insert(schema.calculationRunBlockers).values({
    runId: fixtureIds.calculationRunId,
    principalId: fixture.principalId,
    sequence: 0,
    code: "missing_valuation",
    eventId: fixtureIds.partialLegId,
    assetId: TEST_BTC_ASSET_ID,
    custodyUnitId: fixture.sourceId,
    missingQuantity: null,
  })
  yield* db.insert(schema.activeCalculationRuns).values({
    principalId: fixture.principalId,
    jurisdiction: "DE",
    taxYear: 2025,
    reportingCurrency: "EUR",
    runId: fixtureIds.calculationRunId,
    minimumActivationRevision: "0",
  })

  yield* db.insert(schema.calculationRuns).values({
    id: fixtureIds.competingCalculationRunId,
    principalId: fixture.principalId,
    jurisdiction: "US",
    taxYear: 2025,
    reportingCurrency: "USD",
    engineVersion: "test-engine-v1",
    ruleSetVersion: "us-test-only",
    inputLedgerRevision: `v2:1:1.1.1:${"c".repeat(64)}`,
    valuationRevision: `sha256:${"d".repeat(64)}`,
    status: "complete",
    accountingMethod: "fifo",
    inventoryScope: "per_custody_unit",
    appliedChoiceIds: [],
    appliedRules: [],
    processedEventIds: [fixtureIds.sellLegId],
    startedAt: completedAt,
    completedAt,
  })
  yield* db.insert(schema.calculationRunCustodyUnits).values({
    runId: fixtureIds.competingCalculationRunId,
    principalId: fixture.principalId,
    custodyUnitId: fixture.sourceId,
  })
  yield* db.insert(schema.calculationRunCustodyUnitSources).values({
    runId: fixtureIds.competingCalculationRunId,
    principalId: fixture.principalId,
    custodyUnitId: fixture.sourceId,
    sourceId: fixture.sourceId,
  })
  yield* db.insert(schema.calculationRunAllocations).values({
    runId: fixtureIds.competingCalculationRunId,
    principalId: fixture.principalId,
    sequence: 0,
    acquisitionEventId: fixtureIds.buyLegId,
    dispositionEventId: fixtureIds.sellLegId,
    assetId: TEST_BTC_ASSET_ID,
    custodyUnitId: fixture.sourceId,
    acquiredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-01T12:00:00.000Z")),
    disposedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-10T12:00:00.000Z")),
    quantity: "0.4",
    costBasis: "1000",
  })
  yield* db.insert(schema.calculationRunRealizedResults).values({
    runId: fixtureIds.competingCalculationRunId,
    sequence: 0,
    sourceId: fixture.sourceId,
    allocationSequence: 0,
    acquisitionEventId: fixtureIds.buyLegId,
    dispositionEventId: fixtureIds.sellLegId,
    assetId: TEST_BTC_ASSET_ID,
    acquiredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-01T12:00:00.000Z")),
    disposedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-10T12:00:00.000Z")),
    quantity: "0.4",
    costBasis: "1000",
    proceeds: "9000",
    gainLoss: "8000",
    treatmentCodes: ["us.test-only"],
  })
  yield* db.insert(schema.activeCalculationRuns).values({
    principalId: fixture.principalId,
    jurisdiction: "US",
    taxYear: 2025,
    reportingCurrency: "USD",
    runId: fixtureIds.competingCalculationRunId,
    minimumActivationRevision: "0",
  })

  return fixture
})

const seedSourceFilterFixtures = Effect.gen(function* () {
  const fixture = yield* seedTransactions
  const db = yield* drizzle
  for (const sourceId of [fixtureIds.canonicalSourceId, fixtureIds.emptySourceId]) {
    const [address] = yield* db
      .insert(schema.addresses)
      .values({
        principalId: fixture.principalId,
        address: `bc1qsourcefilter${sourceId}`,
        type: "bitcoin",
        name: "Source filter fixture",
      })
      .returning({ id: schema.addresses.id })
    if (address === undefined) return yield* Effect.die("Failed to create source filter address")
    yield* db.insert(schema.sources).values({
      id: sourceId,
      principalId: fixture.principalId,
      name: "Other owned source",
      providerKey: "bitcoin-rpc",
      sourceableType: "onchain",
      addressId: address.id,
    })
  }
  const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-07T12:00:00.000Z"))
  yield* db.insert(schema.transactions).values({
    id: fixtureIds.canonicalTransferTransactionId,
    sourceId: fixtureIds.canonicalSourceId,
    principalId: fixture.principalId,
    externalId: "other-owned-source-acquisition",
    timestamp,
    transactionType: "buy_fiat",
  })
  yield* db.insert(schema.transactionLegs).values(
    yield* prepareMovementLegFixtures([
      {
        movementIdentity: {
          sourceRecordKey: "other-owned-source-acquisition:leg",
          componentKey: "movement",
        },
        sourceId: fixtureIds.canonicalSourceId,
        principalId: fixture.principalId,
        externalId: "other-owned-source-acquisition:leg",
        timestamp,
        assetId: TEST_BTC_ASSET_ID,
        amount: "1",
        kind: "acquisition",
        provenance: "deterministic",
        originKind: "none",
        transactionId: fixtureIds.canonicalTransferTransactionId,
        fiatAmount: null,
        fiatCurrency: null,
      },
    ])
  )
  return fixture
})

// Source records and movements cross the same writer used by sync before API reads.
const seedQueryFilterFixtures = (attention = false) =>
  Effect.gen(function* () {
    const fixture = yield* seedSyncEngineRepositoryFixture({
      principalId: fixtureIds.principalId,
      userId: fixtureIds.userId,
      sourceId: fixtureIds.sourceId,
    })
    yield* seedSyncEngineAssets(fixture)
    const db = yield* drizzle
    for (const sourceId of [fixtureIds.canonicalSourceId, fixtureIds.emptySourceId]) {
      const [address] = yield* db
        .insert(schema.addresses)
        .values({
          principalId: fixture.principalId,
          address: `bc1qquery${sourceId}`,
          type: "bitcoin",
          name: "Query fixture",
        })
        .returning({ id: schema.addresses.id })
      if (address === undefined) return yield* Effect.die("Missing fixture address")
      yield* db.insert(schema.sources).values({
        id: sourceId,
        principalId: fixture.principalId,
        name: "Query source",
        providerKey: "bitcoin-rpc",
        sourceableType: "onchain",
        addressId: address.id,
      })
    }
    yield* seedSyncEngineRepositoryFixture({
      principalId: fixtureIds.otherPrincipalId,
      userId: fixtureIds.otherUserId,
      sourceId: fixtureIds.otherSourceId,
    })
    const feeAssetId = "00000000-0000-4000-8000-000000009901"
    if (attention)
      yield* db.insert(schema.assets).values({
        id: feeAssetId,
        name: "Unpriced historical fee",
        symbol: "BTC",
        type: "fungible",
      })
    const writer = yield* SourceNormalizationRepository
    const ids: Array<string> = []
    for (const [index, sourceId] of [
      fixture.sourceId,
      fixture.sourceId,
      fixtureIds.canonicalSourceId,
      fixtureIds.emptySourceId,
      ...(attention ? [fixtureIds.emptySourceId] : []),
    ].entries()) {
      const timestamp = DateTime.toDateUtc(
        DateTime.makeUnsafe(index === 0 ? "2025-03-01T00:00:00Z" : "2025-03-02T00:00:00Z")
      )
      const externalId = `query-${index}`
      const kind = attention && index === 1 ? ("disposal" as const) : ("acquisition" as const)
      const transactionType = kind === "disposal" ? "sell_fiat" : "buy_fiat"
      const assetId = attention && index === 2 ? feeAssetId : TEST_BTC_ASSET_ID
      const persisted = yield* writer.persistNormalizedArtifacts({
        transaction: {
          sourceId,
          principalId: fixture.principalId,
          sourceRawRecordId: null,
          externalId,
          externalGroupId: null,
          timestamp,
          transactionType,
          providerTransactionType: "buy",
          providerStatus: "completed",
          providerResourcePath: null,
          providerDescription: null,
          providerCreatedAt: timestamp,
          providerUpdatedAt: timestamp,
          metadata: null,
          providerFiatAmount: attention ? (index === 1 ? "30" : "20") : null,
          providerFiatCurrency: attention ? "EUR" : null,
        },
        venueContext: {
          venueType: "cex",
          cexAccountId: null,
          externalAccountId: null,
          externalOrderId: null,
          externalFillId: null,
          side: null,
          instrument: null,
          fillPrice: null,
          commissionAmount: null,
          commissionCurrency: null,
          metadata: null,
        },
        providerTransfers: [],
        canonicalTransfers: [],
        providerAssetRowIds: [],
        transactionReview:
          attention && index >= 2
            ? {
                principalId: fixture.principalId,
                reviewStatus: "needs_review",
                originalTypeKey: null,
                originalConfidence: null,
                currentTypeKey: null,
                legalRuleSetVersion: null,
                categorizationReason: "Fixture explicit review",
                matchedLayer: null,
                needsReview: true,
                userNotes: null,
                reviewedAt: null,
              }
            : null,
        resolvedTransactionType: {
          providerTransactionType: "buy",
          transactionType,
          inventoryEffect: "acquisition",
          taxTreatment: "requires_additional_rule_logic",
          resolutionStrategy: "static",
          pairedRecordRequired: false,
          mappingStatus: "approved",
        },
        deriveLegs: ({ transaction }) =>
          Effect.succeed(
            attention && index >= 3
              ? []
              : [
                  {
                    movementIdentity: {
                      _tag: "identified" as const,
                      sourceRecordKey: externalId,
                      componentKey: "acquisition",
                    },
                    sourceId,
                    principalId: fixture.principalId,
                    sourceRawRecordId: null,
                    externalId: `${externalId}:leg`,
                    txHash: null,
                    timestamp,
                    addressId: null,
                    assetId,
                    amount: "1",
                    kind,
                    provenance: "deterministic" as const,
                    originKind: "none" as const,
                    derivationRule: "query-fixture",
                    metadata: null,
                    transactionId: transaction.id,
                    sourceTransferId: null,
                    fiatAmount: null,
                    fiatCurrency: null,
                    feeForTransactionId: null,
                  },
                ].flatMap((leg) =>
                  attention && index === 1
                    ? [
                        leg,
                        {
                          ...leg,
                          assetId: feeAssetId,
                          amount: "0.1",
                          kind: "fee" as const,
                          externalId: `${externalId}:fee`,
                          movementIdentity: {
                            _tag: "identified" as const,
                            sourceRecordKey: externalId,
                            componentKey: "fee",
                          },
                        },
                      ]
                    : [leg]
                )
          ),
      })
      ids.push(persisted.transaction.id)
    }
    return { ...fixture, ids }
  })

await Effect.runPromise(context.recreateTestDatabase())

describe("TransactionsApiLive", () => {
  beforeEach(() => Effect.runPromise(Effect.asVoid(context.recreateTestDatabase())))

  it.effect(
    "shares exact writer-linked attention across rows, count, cursor and historical choices",
    () =>
      Effect.gen(function* () {
        const fixture = yield* seedQueryFilterFixtures(true)
        const calculation = yield* context.runWithLayer({
          layer: runLayer,
          effect: Effect.flatMap(CalculationRunService, (service) =>
            service.recompute({
              id: runId(80),
              principalId: PrincipalId.make(fixture.principalId),
              jurisdiction: scope.jurisdiction,
              taxYear: TaxYear.make(2025),
              reportingCurrency: EUR,
              accountingChoices: [],
            })
          ),
        })
        expect(calculation.status).toBe("partial")
        const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
        const all = yield* client.transactions.listTransactions({ query: { limit: 10 } })
        expect(all.totalCount).toBe(3)
        expect(
          all.transactions
            .filter((row) => row.attention)
            .map((row) => row.transactionId)
            .sort()
        ).toEqual([fixture.ids[1], fixture.ids[2]].sort())
        const sale = all.transactions.find((row) => row.transactionId === fixture.ids[1])
        expect(sale).toMatchObject({ attention: true, needsReview: false, realizedGainLoss: "10" })
        expect(all.transactions.find((row) => row.transactionId === fixture.ids[0])).toMatchObject({
          attention: false,
          needsReview: false,
        })
        const first = yield* client.transactions.listTransactions({
          query: { attention: true, limit: 1 },
        })
        expect(first.totalCount).toBe(2)
        expect(first.transactions).toHaveLength(1)
        const cursor = first.page.nextCursor
        if (cursor === null) return yield* Effect.die("Expected attention cursor")
        const second = yield* client.transactions.listTransactions({
          query: { attention: true, limit: 1, cursor },
        })
        expect(second.totalCount).toBe(2)
        expect(second.page.hasMore).toBe(false)
        expect(
          new Set([...first.transactions, ...second.transactions].map((row) => row.transactionId))
            .size
        ).toBe(2)
        const jobs = yield* SourceSyncJobRepository
        const job = yield* jobs.createOrReuseJob({
          sourceId: fixture.sourceId,
          principalId: fixture.principalId,
          mode: "sync",
          maxAttempts: 1,
        })
        yield* jobs.claimJob({
          jobId: job.id,
          workerId: "attention-proof",
          startedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-09-10T00:00:00Z")),
        })
        yield* jobs.failJob({
          jobId: job.id,
          message: "Fixture scope-only failure",
          completedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-09-10T00:00:00Z")),
        })
        const afterFailure = yield* client.transactions.listTransactions({
          query: { attention: true, limit: 10 },
        })
        expect(afterFailure.totalCount).toBe(2)
        expect(afterFailure.transactions.map((row) => row.transactionId).sort()).toEqual(
          [fixture.ids[1], fixture.ids[2]].sort()
        )
        const invalid = yield* client.transactions
          .listTransactions({ query: { attention: false, cursor } })
          .pipe(Effect.result)
        expect(invalid._tag).toBe("Failure")
        const choices = yield* client.transactions.filterChoices()
        expect(choices.assets.map((asset) => asset.assetId).sort()).toEqual(
          [TEST_BTC_ASSET_ID, "00000000-0000-4000-8000-000000009901"].sort()
        )
        expect(new Set(choices.assets.map((asset) => asset.symbol))).toEqual(new Set(["BTC"]))
        expect(new Set(choices.assets.map((asset) => asset.name)).size).toBe(2)
        const db = yield* drizzle
        const inventory = yield* db
          .select({ quantity: schema.calculationRunDerivedLots.remainingQuantity })
          .from(schema.calculationRunDerivedLots)
          .where(
            and(
              eq(schema.calculationRunDerivedLots.runId, runId(80)),
              eq(schema.calculationRunDerivedLots.assetId, TEST_BTC_ASSET_ID)
            )
          )
        expect(
          inventory.every((lot) => BigDecimal.isZero(BigDecimal.fromStringUnsafe(lot.quantity)))
        ).toBe(true)
        const foreign = yield* makeAuthenticatedClient({ userId: fixtureIds.otherUserId })
        expect((yield* foreign.transactions.filterChoices()).assets).toEqual([])
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect(
    "filters writer-produced rows by owned source sets and UTC dates with query-bound ordering",
    () =>
      Effect.gen(function* () {
        const fixture = yield* seedQueryFilterFixtures()
        const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
        const sourceIds = [fixture.sourceId, fixtureIds.canonicalSourceId]
        const all = yield* client.transactions.listTransactions({ query: { sourceIds: [] } })
        expect(all.totalCount).toBe(4)
        for (const selected of [sourceIds, [fixture.sourceId, ...sourceIds]]) {
          const response = yield* client.transactions.listTransactions({
            query: { sourceIds: selected },
          })
          expect(response.totalCount).toBe(3)
          expect(response.transactions.map((row) => row.transactionId).sort()).toEqual(
            fixture.ids.slice(0, 3).sort()
          )
        }
        for (const sourceId of [
          fixture.sourceId,
          fixtureIds.canonicalSourceId,
          fixtureIds.emptySourceId,
        ]) {
          const response = yield* client.transactions.listTransactions({
            query: { sourceIds: [sourceId] },
          })
          expect(response.totalCount).toBe(sourceId === fixture.sourceId ? 2 : 1)
        }
        const foreign = yield* client.transactions
          .listTransactions({ query: { sourceIds: [...sourceIds, fixtureIds.otherSourceId] } })
          .pipe(Effect.flip)
        expect(foreign).toMatchObject({ _tag: "SourceNotFoundError" })
        const both = yield* client.transactions
          .listTransactions({ query: { sourceId: fixture.sourceId, sourceIds } })
          .pipe(Effect.flip)
        expect(both).toMatchObject({ _tag: "TransactionBadRequestError" })
        const from = DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-01T00:00:00Z"))
        const to = DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-02T00:00:00Z"))
        const interval = yield* client.transactions.listTransactions({
          query: { sourceIds, from, to },
        })
        expect(interval.totalCount).toBe(1)
        expect(interval.transactions.map((row) => row.transactionId)).toEqual(
          fixture.ids.slice(0, 1)
        )
        for (const order of ["newest", "oldest"] as const) {
          const readIds: Array<string> = []
          let cursor: string | undefined
          for (let page = 0; page < 3; page++) {
            const response = yield* client.transactions.listTransactions({
              query: {
                sourceIds: [
                  fixtureIds.canonicalSourceId.toUpperCase(),
                  fixture.sourceId,
                  fixture.sourceId,
                ],
                from,
                order,
                limit: 1,
                cursor,
              },
            })
            expect(response.totalCount).toBe(3)
            readIds.push(...response.transactions.map((row) => row.transactionId))
            cursor = response.page.nextCursor ?? undefined
          }
          const ties = fixture.ids.slice(1, 3).sort()
          expect(readIds).toEqual(
            order === "oldest"
              ? [...fixture.ids.slice(0, 1), ...ties]
              : [...ties.reverse(), ...fixture.ids.slice(0, 1)]
          )
          expect(cursor).toBeUndefined()
        }
        const first = yield* client.transactions.listTransactions({
          query: { sourceIds, from, limit: 1 },
        })
        const cursor = first.page.nextCursor
        if (cursor === null) return yield* Effect.die("Expected query cursor")
        for (const change of [
          { sourceIds: [fixture.sourceId] },
          { from: to },
          { to: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-03T00:00:00Z")) },
          { order: "oldest" as const },
        ]) {
          const error = yield* client.transactions
            .listTransactions({ query: { sourceIds, from, cursor, ...change } })
            .pipe(Effect.flip)
          expect(error).toMatchObject({ _tag: "TransactionBadRequestError" })
        }
        const equivalent = yield* client.transactions.listTransactions({
          query: {
            sourceIds: [
              fixtureIds.canonicalSourceId.toUpperCase(),
              fixture.sourceId,
              fixture.sourceId,
            ],
            from,
            cursor,
            order: "newest",
            limit: 1,
          },
        })
        expect(equivalent.transactions).toHaveLength(1)
        const shorthand = yield* client.transactions.listTransactions({
          query: { sourceId: fixture.sourceId, limit: 1 },
        })
        if (shorthand.page.nextCursor === null)
          return yield* Effect.die("Expected shorthand cursor")
        const setPage = yield* client.transactions.listTransactions({
          query: { sourceIds: [fixture.sourceId], cursor: shorthand.page.nextCursor },
        })
        expect(setPage.transactions).toHaveLength(1)
        for (const path of [
          "?from=invalid",
          "?from=2025-03-01T00:00:00",
          "?from=2025-03-02T00:00:00Z&to=2025-03-01T00:00:00Z",
          "?from=2025-03-01T00:00:00Z&to=2025-03-01T00:00:00Z",
          "?sourceIds=invalid",
          "?order=sideways",
        ]) {
          expect(
            yield* getAuthenticatedStatus({
              path: `/v1/transactions${path}`,
              userId: fixture.userId,
            })
          ).toBe(400)
        }
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("rejects impossible date boundaries and accepts leap dates with explicit offsets", () =>
    Effect.gen(function* () {
      const fixture = yield* seedQueryFilterFixtures()
      for (const date of [
        "2025-02-30T00:00:00Z",
        "2025-02-29T00:00:00Z",
        "1900-02-29T00:00:00Z",
        "2024-02-30T00:00:00+01:00",
        "2025-04-31T00:00:00-05:00",
        "2025-00-01T00:00:00Z",
        "2025-13-01T00:00:00Z",
        "2025-01-00T00:00:00Z",
        "2025-01-32T00:00:00Z",
        "2025-03-01T24:00:00Z",
        "2025-03-01T00:60:00Z",
        "2025-03-01T00:00:60Z",
        "2025-03-01T00:00:00+24:00",
      ]) {
        for (const key of ["from", "to"]) {
          expect(
            yield* getAuthenticatedStatus({
              path: `/v1/transactions?${key}=${encodeURIComponent(date)}`,
              userId: fixture.userId,
            })
          ).toBe(400)
        }
      }
      for (const date of [
        "2024-02-29T23:59:59.123Z",
        "2000-02-29T00:00:00Z",
        "2024-02-29T00:30:00+01:00",
        "2024-02-29T23:30:00-05:00",
      ]) {
        for (const key of ["from", "to"]) {
          expect(
            yield* getAuthenticatedStatus({
              path: `/v1/transactions?${key}=${encodeURIComponent(date)}`,
              userId: fixture.userId,
            })
          ).toBe(200)
        }
      }
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("pages 1204 transactions at 500 and hydrates only the selected movement IDs", () => {
    const statements: Array<{ text: string; params: ReadonlyArray<unknown> }> = []
    const capture: Statement.Transformer = (statement) =>
      Effect.sync(() => {
        const [text, params] = statement.compile()
        statements.push({ text, params })
        return statement
      })
    return Effect.gen(function* () {
      const fixture = yield* seedSyncEngineRepositoryFixture({
        principalId: fixtureIds.principalId,
        userId: fixtureIds.userId,
        sourceId: fixtureIds.sourceId,
      })
      yield* seedSyncEngineAssets(fixture)
      const db = yield* drizzle
      const inputs = Array.from({ length: 1204 }, (_, index) => ({
        id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
        externalId: `pagination-${index}`,
        timestamp: DateTime.toDateUtc(
          DateTime.add(DateTime.makeUnsafe("2025-01-01T00:00:00Z"), { minutes: index })
        ),
        transactionType: "buy_fiat",
      }))
      yield* db.insert(schema.transactions).values(inputs)
      yield* db.insert(schema.transactionLegs).values(
        yield* prepareMovementLegFixtures(
          inputs.map((transaction, index) => ({
            principalId: fixture.principalId,
            sourceId: fixture.sourceId,
            transactionId: transaction.id,
            timestamp: transaction.timestamp,
            externalId: `${transaction.externalId}:acquisition`,
            movementIdentity: {
              sourceRecordKey: transaction.externalId,
              componentKey: "principal",
            },
            assetId: TEST_BTC_ASSET_ID,
            amount: String(index + 1),
            kind: "acquisition" as const,
            provenance: "deterministic",
            originKind: "none" as const,
          }))
        )
      )
      const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
      const defaultPage = yield* client.transactions.listTransactions({ query: {} })
      expect(defaultPage.transactions).toHaveLength(25)
      const expectedIds = inputs.map(({ id }) => id).reverse()
      const seen: string[] = []
      let cursor: string | undefined
      for (const count of [500, 500, 204]) {
        statements.length = 0
        const response = yield* client.transactions.listTransactions({
          query: { limit: 500, cursor },
        })
        const selectedIds = response.transactions.map(({ transactionId }) => transactionId)
        expect(selectedIds).toEqual(expectedIds.slice(seen.length, seen.length + count))
        expect(response.totalCount).toBe(1204)
        expect(response.transactions).toHaveLength(count)
        expect(response.transactions.every(({ movements }) => movements.length === 1)).toBe(true)
        const hydration = statements.filter(
          ({ text }) =>
            text.startsWith("select ") &&
            text.includes('from "transaction_legs"') &&
            text.includes('join "assets"')
        )
        expect(hydration).toHaveLength(1)
        expect(hydration[0]?.text).toContain('"transaction_legs"."transaction_id" in (')
        expect(hydration[0]?.params).toEqual([
          fixture.principalId,
          fixture.principalId,
          ...selectedIds,
        ])
        const captureReads = statements.filter(({ text }) =>
          text.startsWith('select "calculation_run_movement_inputs".')
        )
        expect(captureReads).toHaveLength(3)
        for (const read of captureReads) {
          expect(read.params).toContain(fixture.principalId)
          expect(read.params.slice(-selectedIds.length)).toEqual(selectedIds)
        }
        seen.push(...selectedIds)
        expect(response.page.hasMore).toBe(seen.length < 1204)
        if (seen.length < 1204) {
          expect(response.page.nextCursor).not.toBeNull()
          cursor = response.page.nextCursor ?? undefined
        } else {
          expect(response.page.nextCursor).toBeNull()
        }
      }
      expect(new Set(seen).size).toBe(1204)
      expect(
        yield* getAuthenticatedStatus({
          path: "/v1/transactions?limit=501",
          userId: fixture.userId,
        })
      ).toBe(400)
    }).pipe(
      Effect.provide(HttpLive),
      Effect.provideService(Statement.CurrentTransformer, capture),
      Effect.scoped
    )
  })

  it.effect(
    "returns active income separately from gains and withholds blocked or pending income",
    () =>
      Effect.gen(function* () {
        const fixture = yield* seedTransactions
        const db = yield* drizzle
        for (const legId of [fixtureIds.buyLegId, fixtureIds.partialLegId]) {
          yield* db
            .update(schema.transactionLegs)
            .set({ kind: "income" })
            .where(eq(schema.transactionLegs.id, legId))
        }
        yield* db.insert(schema.calculationRunIncomeResults).values([
          {
            runId: fixtureIds.calculationRunId,
            sequence: 0,
            sourceId: fixture.sourceId,
            eventId: fixtureIds.buyLegId,
            assetId: TEST_BTC_ASSET_ID,
            occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-01T12:00:00Z")),
            quantity: "0.1",
            value: "12.34",
            treatmentCodes: [],
          },
          {
            runId: fixtureIds.calculationRunId,
            sequence: 1,
            sourceId: fixture.sourceId,
            eventId: fixtureIds.partialLegId,
            assetId: TEST_BTC_ASSET_ID,
            occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-05T12:00:00Z")),
            quantity: "0.1",
            value: "99",
            treatmentCodes: [],
          },
          {
            runId: fixtureIds.competingCalculationRunId,
            sequence: 0,
            sourceId: fixture.sourceId,
            eventId: fixtureIds.buyLegId,
            assetId: TEST_BTC_ASSET_ID,
            occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-01T12:00:00Z")),
            quantity: "0.1",
            value: "999",
            treatmentCodes: [],
          },
        ])
        const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
        const response = yield* client.transactions.listTransactions({ query: { limit: 10 } })
        expect(
          response.transactions.find((row) => row.transactionId === fixtureIds.buyTransactionId)
        ).toMatchObject({
          income: null,
          realizedGainLoss: null,
          fiatCurrency: null,
          calculationState: "complete",
        })
        expect(
          response.transactions.find((row) => row.transactionId === fixtureIds.partialTransactionId)
        ).toMatchObject({ income: null, fiatCurrency: null, calculationState: "partial" })
        expect(
          response.transactions.find((row) => row.transactionId === fixtureIds.sellTransactionId)
        ).toMatchObject({ income: null, realizedGainLoss: null })
        yield* db
          .update(schema.activeCalculationRuns)
          .set({ runId: null })
          .where(eq(schema.activeCalculationRuns.principalId, fixture.principalId))
        const pending = yield* client.transactions.listTransactions({ query: { limit: 10 } })
        expect(
          pending.transactions.find((row) => row.transactionId === fixtureIds.buyTransactionId)
        ).toMatchObject({ income: null, fiatCurrency: null, calculationState: "partial" })
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect(
    "lists compact principal-owned transactions with an exact total and stable cursor",
    () =>
      Effect.asVoid(
        Effect.gen(function* () {
          const fixture = yield* seedTransactions
          const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
          const first = yield* client.transactions.listTransactions({ query: { limit: 1 } })

          expect(first.totalCount).toBe(3)
          expect(first.transactions).toMatchObject([
            {
              transactionId: fixtureIds.sellTransactionId,
              timestamp: "2025-03-10T12:00:00.000Z",
              source: {
                sourceId: fixture.sourceId,
                name: `Coinbase Source ${fixture.sourceId}`,
                kind: "cex",
              },
              transactionType: "sell_fiat",
              description: "Sell BTC",
              externalId: "transaction-sell",
              movements: [{ amount: "0.4", assetSymbol: "BTC", kind: "disposal" }],
              realizedGainLoss: null,
              fiatCurrency: null,
              calculationState: "complete",
              needsReview: false,
            },
          ])
          expect(first.page.hasMore).toBe(true)
          expect(first.page.nextCursor).not.toBeNull()

          const cursor = first.page.nextCursor
          if (cursor === null) {
            return yield* Effect.die("Expected a transaction cursor")
          }

          const second = yield* client.transactions.listTransactions({
            query: { cursor, limit: 1 },
          })
          expect(second.totalCount).toBe(3)
          expect(second.transactions.map((transaction) => transaction.transactionId)).toEqual([
            fixtureIds.partialTransactionId,
          ])
          expect(second.transactions[0]).toMatchObject({
            movements: [{ amount: "0.1", assetSymbol: "BTC", kind: "acquisition" }],
            realizedGainLoss: null,
            fiatCurrency: null,
            calculationState: "partial",
          })
          expect(second.page.hasMore).toBe(true)

          const secondCursor = second.page.nextCursor
          if (secondCursor === null) {
            return yield* Effect.die("Expected a second transaction cursor")
          }

          const third = yield* client.transactions.listTransactions({
            query: { cursor: secondCursor, limit: 1 },
          })
          expect(third.totalCount).toBe(3)
          expect(third.transactions.map((transaction) => transaction.transactionId)).toEqual([
            fixtureIds.buyTransactionId,
          ])
          expect(third.transactions[0]?.calculationState).toBe("complete")
          expect(third.page).toEqual({ hasMore: false, nextCursor: null })

          const listedIds = [
            ...first.transactions,
            ...second.transactions,
            ...third.transactions,
          ].map((transaction) => transaction.transactionId)
          expect(listedIds).not.toContain(fixtureIds.unresolvedTransactionId)
          expect(listedIds).not.toContain(fixtureIds.excludedTransactionId)
          expect(listedIds).not.toContain(fixtureIds.hiddenTransactionId)
        }).pipe(Effect.provide(HttpLive), Effect.scoped)
      )
  )

  it.effect("filters rows and exact totals to one owned source through every page", () =>
    Effect.gen(function* () {
      const fixture = yield* seedSourceFilterFixtures
      const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
      const unfiltered = yield* client.transactions.listTransactions({ query: {} })
      expect(unfiltered.totalCount).toBe(4)

      const rows: Array<TransactionListResponse["transactions"][number]> = []
      let cursor: string | undefined
      for (let index = 0; index < 3; index++) {
        const page = yield* client.transactions.listTransactions({
          query: { sourceId: fixture.sourceId, limit: 1, cursor },
        })
        expect(page.totalCount).toBe(3)
        expect(page.transactions).toHaveLength(1)
        expect(page.page.hasMore).toBe(index < 2)
        rows.push(...page.transactions)
        cursor = page.page.nextCursor ?? undefined
      }
      expect(cursor).toBeUndefined()
      expect(rows).toEqual(
        unfiltered.transactions.filter((row) => row.source.sourceId === fixture.sourceId)
      )
      expect(rows.map((row) => row.transactionId)).toEqual([
        fixtureIds.sellTransactionId,
        fixtureIds.partialTransactionId,
        fixtureIds.buyTransactionId,
      ])
      expect(rows[1]).toMatchObject({
        calculationState: "partial",
        realizedGainLoss: null,
        fiatCurrency: null,
      })

      const otherSource = yield* client.transactions.listTransactions({
        query: { sourceId: fixtureIds.canonicalSourceId },
      })
      expect(otherSource.totalCount).toBe(1)
      expect(otherSource.transactions.map((row) => row.transactionId)).toEqual([
        fixtureIds.canonicalTransferTransactionId,
      ])
      const empty = yield* client.transactions.listTransactions({
        query: { sourceId: fixtureIds.emptySourceId },
      })
      expect(empty).toEqual({
        transactions: [],
        totalCount: 0,
        page: { nextCursor: null, hasMore: false },
      })
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("ignores mismatched leg ownership in rows, counts, facts, and calculations", () =>
    Effect.gen(function* () {
      const fixture = yield* seedSourceFilterFixtures
      const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
      const queries = [
        {},
        { sourceId: fixture.sourceId },
        { sourceId: fixtureIds.canonicalSourceId },
      ]
      const before = yield* Effect.forEach(queries, (query) =>
        client.transactions.listTransactions({ query })
      )
      const db = yield* drizzle
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-10T12:00:00.000Z"))
      const mismatches = [
        {
          principalId: fixtureIds.otherPrincipalId,
          sourceId: fixtureIds.otherSourceId,
          orphanTransactionId: fixtureIds.unresolvedTransactionId,
        },
        {
          principalId: fixture.principalId,
          sourceId: fixtureIds.canonicalSourceId,
          orphanTransactionId: fixtureIds.excludedTransactionId,
        },
      ]
      const extraProcessedEventIds: Array<string> = []
      for (const [index, mismatch] of mismatches.entries()) {
        const leg = {
          principalId: mismatch.principalId,
          sourceId: mismatch.sourceId,
          timestamp,
          assetId: TEST_BTC_ASSET_ID,
          amount: "9",
          provenance: "deterministic" as const,
          originKind: "none" as const,
          fiatAmount: "1004",
          fiatCurrency: "EUR",
        }
        yield* db.insert(schema.transactionLegs).values(
          yield* prepareMovementLegFixtures([
            {
              movementIdentity: {
                sourceRecordKey: `mismatched-orphan-${index}`,
                componentKey: "movement",
              },
              ...leg,
              externalId: `mismatched-orphan-${index}`,
              kind: "acquisition",
              transactionId: mismatch.orphanTransactionId,
            },
            {
              movementIdentity: {
                sourceRecordKey: `mismatched-acquisition-${index}`,
                componentKey: "movement",
              },
              ...leg,
              externalId: `mismatched-acquisition-${index}`,
              kind: "acquisition",
              transactionId: fixtureIds.buyTransactionId,
            },
          ])
        )
        const [disposal] = yield* db
          .insert(schema.transactionLegs)
          .values(
            yield* prepareMovementLegFixtures([
              {
                movementIdentity: {
                  sourceRecordKey: `mismatched-disposal-${index}`,
                  componentKey: "movement",
                },
                ...leg,
                externalId: `mismatched-disposal-${index}`,
                kind: "disposal",
                transactionId: fixtureIds.sellTransactionId,
              },
            ])
          )
          .returning({ id: schema.transactionLegs.id })
        if (disposal === undefined) return yield* Effect.die("Expected mismatched disposal fixture")
        extraProcessedEventIds.push(disposal.id)
        yield* db.insert(schema.calculationRunAllocations).values({
          runId: fixtureIds.calculationRunId,
          principalId: fixture.principalId,
          sequence: index + 1,
          acquisitionEventId: fixtureIds.buyLegId,
          dispositionEventId: disposal.id,
          assetId: TEST_BTC_ASSET_ID,
          custodyUnitId: fixture.sourceId,
          acquiredAt: timestamp,
          disposedAt: timestamp,
          quantity: "9",
          costBasis: "5",
        })
        yield* db.insert(schema.calculationRunRealizedResults).values({
          runId: fixtureIds.calculationRunId,
          sourceId: fixture.sourceId,
          sequence: index + 1,
          allocationSequence: index + 1,
          acquisitionEventId: fixtureIds.buyLegId,
          dispositionEventId: disposal.id,
          assetId: TEST_BTC_ASSET_ID,
          acquiredAt: timestamp,
          disposedAt: timestamp,
          quantity: "9",
          costBasis: "5",
          proceeds: "1004",
          gainLoss: "999",
          treatmentCodes: ["de.taxable_private_disposal"],
        })
      }
      yield* db
        .update(schema.calculationRuns)
        .set({
          processedEventIds: [
            fixtureIds.buyLegId,
            fixtureIds.partialLegId,
            fixtureIds.sellLegId,
            ...extraProcessedEventIds,
          ],
        })
        .where(eq(schema.calculationRuns.id, fixtureIds.calculationRunId))
      yield* db.insert(schema.transactionReviews).values({
        transactionId: fixtureIds.sellTransactionId,
        principalId: fixtureIds.otherPrincipalId,
        needsReview: true,
      })
      const after = yield* Effect.forEach(queries, (query) =>
        client.transactions.listTransactions({ query })
      )
      expect(after).toEqual(before)
      expect(after[0]?.totalCount).toBe(4)
      expect(after[1]?.totalCount).toBe(3)
      expect(
        after[1]?.transactions.find((row) => row.transactionId === fixtureIds.sellTransactionId)
      ).toMatchObject({
        realizedGainLoss: null,
        calculationState: "complete",
        movements: [{ amount: "0.4", assetSymbol: "BTC", kind: "disposal" }],
        needsReview: false,
      })
      expect(
        after[1]?.transactions.find((row) => row.transactionId === fixtureIds.buyTransactionId)
          ?.calculationState
      ).toBe("complete")
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("continues source pagination across uppercase and lowercase UUID spellings", () =>
    Effect.gen(function* () {
      const fixture = yield* seedTransactions
      const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
      expect(fixture.sourceId.toUpperCase()).not.toBe(fixture.sourceId)
      const first = yield* client.transactions.listTransactions({
        query: { sourceId: fixture.sourceId.toUpperCase(), limit: 1 },
      })
      const rowSourceId = first.transactions[0]?.source.sourceId
      if (first.page.nextCursor === null || rowSourceId === undefined) {
        return yield* Effect.die("Expected a source cursor and row")
      }
      expect(rowSourceId).toBe(fixture.sourceId)
      const second = yield* client.transactions.listTransactions({
        query: { sourceId: rowSourceId, cursor: first.page.nextCursor, limit: 1 },
      })
      if (second.page.nextCursor === null)
        return yield* Effect.die("Expected a second source cursor")
      const third = yield* client.transactions.listTransactions({
        query: { sourceId: rowSourceId.toUpperCase(), cursor: second.page.nextCursor, limit: 1 },
      })
      expect([first, second, third].map((page) => page.transactions[0]?.transactionId)).toEqual([
        fixtureIds.sellTransactionId,
        fixtureIds.partialTransactionId,
        fixtureIds.buyTransactionId,
      ])
      expect([first, second, third].map((page) => page.totalCount)).toEqual([3, 3, 3])
      expect(third.page).toEqual({ hasMore: false, nextCursor: null })
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("returns the same typed not-found outcome for absent and unowned sources", () =>
    Effect.gen(function* () {
      const fixture = yield* seedTransactions
      const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
      for (const sourceId of [fixtureIds.otherSourceId, fixtureIds.emptySourceId]) {
        const error = yield* client.transactions
          .listTransactions({ query: { sourceId } })
          .pipe(Effect.flip)
        expect(error).toMatchObject({ _tag: "SourceNotFoundError", message: "Source not found." })
        const status = yield* getAuthenticatedStatus({
          path: `/v1/transactions?sourceId=${sourceId}`,
          userId: fixture.userId,
        })
        expect(status).toBe(404)
      }
      const status = yield* getAuthenticatedStatus({
        path: "/v1/transactions?sourceId=invalid",
        userId: fixture.userId,
      })
      expect(status).toBe(400)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("rejects cursors reused across source and principal scopes", () =>
    Effect.gen(function* () {
      const fixture = yield* seedSourceFilterFixtures
      const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
      const otherClient = yield* makeAuthenticatedClient({ userId: fixtureIds.otherUserId })
      const filtered = yield* client.transactions.listTransactions({
        query: { sourceId: fixture.sourceId, limit: 1 },
      })
      const unfiltered = yield* client.transactions.listTransactions({ query: { limit: 1 } })
      if (filtered.page.nextCursor === null || unfiltered.page.nextCursor === null) {
        return yield* Effect.die("Expected filtered and unfiltered cursors")
      }
      for (const query of [
        { cursor: filtered.page.nextCursor },
        { cursor: filtered.page.nextCursor, sourceId: fixtureIds.canonicalSourceId },
        { cursor: unfiltered.page.nextCursor, sourceId: fixture.sourceId },
      ]) {
        const error = yield* client.transactions.listTransactions({ query }).pipe(Effect.flip)
        expect(error).toMatchObject({ _tag: "TransactionBadRequestError" })
      }
      const crossPrincipal = yield* otherClient.transactions
        .listTransactions({ query: { cursor: unfiltered.page.nextCursor } })
        .pipe(Effect.flip)
      expect(crossPrincipal).toMatchObject({ _tag: "TransactionBadRequestError" })
      const crossPrincipalSource = yield* otherClient.transactions
        .listTransactions({
          query: { cursor: filtered.page.nextCursor, sourceId: fixtureIds.otherSourceId },
        })
        .pipe(Effect.flip)
      expect(crossPrincipalSource).toMatchObject({ _tag: "TransactionBadRequestError" })
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("uses the German year reached after converting the stored UTC timestamp", () =>
    Effect.asVoid(
      Effect.gen(function* () {
        const fixture = yield* seedTransactions
        const db = yield* drizzle
        const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-12-31T23:30:00.000Z"))
        const completedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"))

        yield* db.insert(schema.transactions).values({
          id: fixtureIds.boundaryTransactionId,
          sourceId: fixture.sourceId,
          principalId: fixture.principalId,
          externalId: "transaction-german-year-boundary",
          timestamp: occurredAt,
          transactionType: "sell_fiat",
        })
        yield* db.insert(schema.transactionLegs).values(
          yield* prepareMovementLegFixtures([
            {
              movementIdentity: {
                sourceRecordKey: "transaction-german-year-boundary:disposal",
                componentKey: "movement",
              },
              id: fixtureIds.boundaryLegId,
              sourceId: fixture.sourceId,
              principalId: fixture.principalId,
              externalId: "transaction-german-year-boundary:disposal",
              timestamp: occurredAt,
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.1",
              kind: "disposal",
              provenance: "deterministic",
              originKind: "none" as const,
              transactionId: fixtureIds.boundaryTransactionId,
              fiatAmount: "2000",
              fiatCurrency: "EUR",
            },
          ])
        )
        yield* db.insert(schema.calculationRuns).values({
          id: fixtureIds.boundaryCalculationRunId,
          principalId: fixture.principalId,
          jurisdiction: "DE",
          taxYear: 2026,
          reportingCurrency: "EUR",
          engineVersion: "test-engine-v1",
          ruleSetVersion: "de-crypto-income-tax-v2025-03-06",
          inputLedgerRevision: `v2:1:1.1.1:${"e".repeat(64)}`,
          valuationRevision: `sha256:${"f".repeat(64)}`,
          status: "complete",
          accountingMethod: "fifo",
          inventoryScope: "per_custody_unit",
          appliedChoiceIds: [],
          appliedRules: [],
          processedEventIds: [fixtureIds.boundaryLegId],
          startedAt: completedAt,
          completedAt,
        })
        yield* db.insert(schema.calculationRunCustodyUnits).values({
          runId: fixtureIds.boundaryCalculationRunId,
          principalId: fixture.principalId,
          custodyUnitId: fixture.sourceId,
        })
        yield* db.insert(schema.calculationRunCustodyUnitSources).values({
          runId: fixtureIds.boundaryCalculationRunId,
          principalId: fixture.principalId,
          custodyUnitId: fixture.sourceId,
          sourceId: fixture.sourceId,
        })
        yield* db.insert(schema.calculationRunAllocations).values({
          runId: fixtureIds.boundaryCalculationRunId,
          principalId: fixture.principalId,
          sequence: 0,
          acquisitionEventId: fixtureIds.buyLegId,
          dispositionEventId: fixtureIds.boundaryLegId,
          assetId: TEST_BTC_ASSET_ID,
          custodyUnitId: fixture.sourceId,
          acquiredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-01T12:00:00.000Z")),
          disposedAt: occurredAt,
          quantity: "0.1",
          costBasis: "1000",
        })
        yield* db.insert(schema.calculationRunRealizedResults).values({
          runId: fixtureIds.boundaryCalculationRunId,
          sequence: 0,
          sourceId: fixture.sourceId,
          allocationSequence: 0,
          acquisitionEventId: fixtureIds.buyLegId,
          dispositionEventId: fixtureIds.boundaryLegId,
          assetId: TEST_BTC_ASSET_ID,
          acquiredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-01T12:00:00.000Z")),
          disposedAt: occurredAt,
          quantity: "0.1",
          costBasis: "1000",
          proceeds: "2000",
          gainLoss: "1000",
          treatmentCodes: ["de.taxable_private_disposal"],
        })
        yield* db.insert(schema.activeCalculationRuns).values({
          principalId: fixture.principalId,
          jurisdiction: "DE",
          taxYear: 2026,
          reportingCurrency: "EUR",
          runId: fixtureIds.boundaryCalculationRunId,
          minimumActivationRevision: "0",
        })

        const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
        const response = yield* client.transactions.listTransactions({ query: { limit: 100 } })
        const transaction = response.transactions.find(
          ({ transactionId }) => transactionId === fixtureIds.boundaryTransactionId
        )

        expect(transaction).toMatchObject({
          realizedGainLoss: null,
          fiatCurrency: null,
          calculationState: "complete",
        })
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
  )

  it.effect("uses a processed custody movement for both reconciled transaction rows", () =>
    Effect.asVoid(
      Effect.gen(function* () {
        const fixture = yield* seedTransactions
        const db = yield* drizzle
        const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:01:00.000Z"))
        const providerOccurredAt = DateTime.toDateUtc(
          DateTime.makeUnsafe("2024-12-31T22:59:00.000Z")
        )
        const [address] = yield* db
          .insert(schema.addresses)
          .values({
            principalId: fixture.principalId,
            address: "bc1qtransactionlistreconciliation",
            type: "bitcoin",
            name: "Transaction list reconciliation",
          })
          .returning({ id: schema.addresses.id })
        if (address === undefined) return yield* Effect.die("Failed to create canonical address")

        yield* db.insert(schema.sources).values({
          id: fixtureIds.canonicalSourceId,
          principalId: fixture.principalId,
          name: "Canonical Bitcoin source",
          providerKey: "bitcoin-rpc",
          sourceableType: "onchain",
          addressId: address.id,
        })
        yield* db.insert(schema.transactions).values([
          {
            id: fixtureIds.providerTransferTransactionId,
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            externalId: "provider-transfer-transaction",
            providerFiatAmount: "999",
            providerFiatCurrency: "EUR",
            timestamp: providerOccurredAt,
            transactionType: "internal_transfer",
          },
          {
            id: fixtureIds.canonicalTransferTransactionId,
            sourceId: fixtureIds.canonicalSourceId,
            principalId: fixture.principalId,
            externalId: "canonical-transfer-transaction",
            timestamp: occurredAt,
            transactionType: "internal_transfer",
          },
        ])
        const [custodyAsset] = yield* db
          .insert(schema.providerAssets)
          .values({
            provider: "synthetic",
            providerAssetId: "custody-btc",
            currencyCode: "BTC",
            name: "Bitcoin custody asset",
            exponent: 8,
            providerType: "crypto",
            rawProviderPayload: {},
            evidenceRevision: 1,
            discoveredAt: occurredAt,
            retrievedAt: occurredAt,
          })
          .returning({ id: schema.providerAssets.id })
        if (custodyAsset === undefined) return yield* Effect.die("Missing custody asset evidence")
        yield* db.insert(schema.providerAssetMappings).values({
          providerAssetRowId: custodyAsset.id,
          mappingKind: "asset",
          canonicalAssetId: TEST_BTC_ASSET_ID,
          mappingStatus: "approved",
        })
        yield* db.insert(schema.providerAssetSourceUses).values([
          { providerAssetRowId: custodyAsset.id, sourceId: fixture.sourceId },
          { providerAssetRowId: custodyAsset.id, sourceId: fixtureIds.canonicalSourceId },
        ])
        yield* db.insert(schema.providerAssetTransactionUses).values([
          {
            providerAssetRowId: custodyAsset.id,
            sourceId: fixture.sourceId,
            transactionId: fixtureIds.providerTransferTransactionId,
          },
          {
            providerAssetRowId: custodyAsset.id,
            sourceId: fixtureIds.canonicalSourceId,
            transactionId: fixtureIds.canonicalTransferTransactionId,
          },
        ])
        yield* db.insert(schema.transfers).values({
          id: fixtureIds.canonicalTransferId,
          providerAssetRowId: custodyAsset.id,
          sourceId: fixtureIds.canonicalSourceId,
          principalId: fixture.principalId,
          externalId: "canonical-transfer",
          timestamp: occurredAt,
          type: "utxo",
          fromAddress: "external",
          toAddress: "bc1qtransactionlistreconciliation",
          assetId: TEST_BTC_ASSET_ID,
          amount: "0.2",
        })
        yield* db.insert(schema.providerTransfers).values({
          id: fixtureIds.providerTransferId,
          providerAssetId: custodyAsset.id,
          sourceId: fixture.sourceId,
          transactionId: fixtureIds.providerTransferTransactionId,
          externalId: "provider-transfer",
          timestamp: providerOccurredAt,
          direction: "outbound",
          processingMode: "accounting_only",
          fromAccountRef: "own:coinbase",
          toAddress: "bc1qtransactionlistreconciliation",
          amount: "0.2",
        })
        yield* db.insert(schema.transactionLegs).values(
          yield* prepareMovementLegFixtures([
            {
              movementIdentity: {
                sourceRecordKey: "provider-transfer-transaction:disposal",
                componentKey: "movement",
              },
              id: fixtureIds.providerTransferLegId,
              sourceId: fixture.sourceId,
              principalId: fixture.principalId,
              externalId: "provider-transfer-transaction:disposal",
              timestamp: providerOccurredAt,
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.2",
              kind: "disposal",
              provenance: "deterministic",
              originKind: "provider_transfer" as const,
              providerTransferId: fixtureIds.providerTransferId,
              derivationRule: "provider_transfer_outbound",
              transactionId: fixtureIds.providerTransferTransactionId,
            },
            {
              movementIdentity: {
                sourceRecordKey: "canonical-transfer-transaction:acquisition",
                componentKey: "movement",
              },
              id: fixtureIds.canonicalTransferLegId,
              sourceId: fixtureIds.canonicalSourceId,
              principalId: fixture.principalId,
              externalId: "canonical-transfer-transaction:acquisition",
              timestamp: occurredAt,
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.2",
              kind: "acquisition",
              provenance: "deterministic",
              originKind: "canonical_transfer" as const,
              derivationRule: "onchain_transfer_inbound",
              transactionId: fixtureIds.canonicalTransferTransactionId,
              sourceTransferId: fixtureIds.canonicalTransferId,
            },
          ])
        )
        yield* db.insert(schema.inventoryMovements).values({
          principalId: fixture.principalId,
          sourceId: fixture.sourceId,
          transactionId: fixtureIds.providerTransferTransactionId,
          providerTransferId: fixtureIds.providerTransferId,
          assetId: TEST_BTC_ASSET_ID,
          timestamp: occurredAt,
          direction: "outbound",
          purpose: "principal",
          taxTreatment: "non_taxable",
          reconciliationStatus: "matched",
          amount: "0.2",
        })
        yield* db.insert(schema.transferReconciliations).values({
          id: fixtureIds.reconciliationId,
          principalId: fixture.principalId,
          providerTransferId: fixtureIds.providerTransferId,
          canonicalTransferId: fixtureIds.canonicalTransferId,
          canonicalTransactionId: fixtureIds.canonicalTransferTransactionId,
          status: "approved",
          matchReason: "approved deterministic integration fixture",
          confidence: "1",
          deterministic: true,
        })
        yield* db
          .update(schema.calculationRuns)
          .set({
            processedEventIds: [
              fixtureIds.buyLegId,
              fixtureIds.partialLegId,
              fixtureIds.sellLegId,
              fixtureIds.reconciliationId,
            ],
          })
          .where(eq(schema.calculationRuns.id, fixtureIds.calculationRunId))

        const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
        const response = yield* client.transactions.listTransactions({ query: { limit: 100 } })
        const reconciledTransactionIds: ReadonlySet<string> = new Set([
          fixtureIds.providerTransferTransactionId,
          fixtureIds.canonicalTransferTransactionId,
        ])
        const reconciledTransactions = response.transactions.filter(({ transactionId }) =>
          reconciledTransactionIds.has(transactionId)
        )

        expect(reconciledTransactions).toHaveLength(2)
        expect(reconciledTransactions.map(({ calculationState }) => calculationState)).toEqual([
          "complete",
          "complete",
        ])

        yield* db.insert(schema.calculationRunBlockers).values({
          runId: fixtureIds.calculationRunId,
          principalId: fixture.principalId,
          sequence: 1,
          code: "movement_shortage",
          eventId: fixtureIds.reconciliationId,
          assetId: TEST_BTC_ASSET_ID,
          custodyUnitId: fixture.sourceId,
          missingQuantity: "0.1",
        })

        const blockedResponse = yield* client.transactions.listTransactions({
          query: { limit: 100 },
        })
        const blockedReconciledTransactions = blockedResponse.transactions.filter(
          ({ transactionId }) => reconciledTransactionIds.has(transactionId)
        )
        expect(
          blockedReconciledTransactions.map(({ calculationState }) => calculationState)
        ).toEqual(["partial", "partial"])
        // Transaction money without an exact custody event link is not movement consideration.
        const capturedRunId = CalculationRunId.make("00000000-0000-4000-8000-000000007249")
        yield* context.runWithLayer({
          layer: runLayer,
          effect: Effect.flatMap(CalculationRunService, (service) =>
            service.recompute({
              id: CalculationRunId.make("00000000-0000-4000-8000-000000007248"),
              principalId: PrincipalId.make(fixture.principalId),
              jurisdiction: JurisdictionCode.make("DE"),
              taxYear: TaxYear.make(2024),
              reportingCurrency: EUR,
              accountingChoices: [],
            })
          ),
        })
        yield* context.runWithLayer({
          layer: runLayer,
          effect: Effect.flatMap(CalculationRunService, (service) =>
            service.recompute({
              id: capturedRunId,
              principalId: PrincipalId.make(fixture.principalId),
              jurisdiction: JurisdictionCode.make("DE"),
              taxYear: TaxYear.make(2025),
              reportingCurrency: EUR,
              accountingChoices: [],
            })
          ),
        })
        const capturedResponse = yield* client.transactions.listTransactions({
          query: { limit: 100 },
        })
        const capturedRows = capturedResponse.transactions.filter((row) =>
          reconciledTransactionIds.has(row.transactionId)
        )
        expect(capturedRows).toHaveLength(2)
        for (const row of capturedRows) {
          expect(row.movements[0]?.capture).toMatchObject({
            runId: capturedRunId,
            outcome: "included",
            eventKind: "custody_movement",
            valuationState: "not_evaluated",
            selectedValue: null,
            providerConsiderations: [],
            realizedResults: [],
          })
        }
        const recorded = yield* db
          .select({ captured: schema.calculationRunMovementInputs.captured })
          .from(schema.calculationRunMovementInputs)
          .where(
            and(
              eq(schema.calculationRunMovementInputs.runId, capturedRunId),
              sql`${schema.calculationRunMovementInputs.transactionId} in (${fixtureIds.providerTransferTransactionId}, ${fixtureIds.canonicalTransferTransactionId})`
            )
          )
        expect(recorded).toHaveLength(2)
        for (const row of recorded) expect(row.captured.current?.structure).toBe("custody")
        const older = yield* db
          .select({ captured: schema.calculationRunMovementInputs.captured })
          .from(schema.calculationRunMovementInputs)
          .where(
            and(
              eq(schema.calculationRunMovementInputs.runId, "00000000-0000-4000-8000-000000007248"),
              eq(
                schema.calculationRunMovementInputs.transactionId,
                fixtureIds.providerTransferTransactionId
              )
            )
          )
        expect(older).toHaveLength(1)
        expect(older[0]?.captured.currentOutcome).toBe("outside_period")
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
  )

  it.effect("keeps processed-state reads bounded when the active run has off-page history", () =>
    Effect.asVoid(
      Effect.gen(function* () {
        const fixture = yield* seedTransactions
        const db = yield* drizzle
        const offPageEventIds = Array.from(
          { length: 20_000 },
          (_, index) => `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`
        )
        yield* db
          .update(schema.calculationRuns)
          .set({
            processedEventIds: [
              ...offPageEventIds,
              fixtureIds.buyLegId,
              fixtureIds.partialLegId,
              fixtureIds.sellLegId,
            ],
          })
          .where(eq(schema.calculationRuns.id, fixtureIds.calculationRunId))

        const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
        const response = yield* client.transactions.listTransactions({ query: { limit: 1 } })

        expect(response.transactions).toMatchObject([
          {
            transactionId: fixtureIds.sellTransactionId,
            calculationState: "complete",
            realizedGainLoss: null,
          },
        ])
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
  )

  it.effect("uses the transaction ID as the cursor tie-breaker for equal timestamps", () =>
    Effect.asVoid(
      Effect.gen(function* () {
        const fixture = yield* seedTransactions
        const db = yield* drizzle
        const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T12:00:00.000Z"))

        yield* db.insert(schema.transactions).values(
          fixtureIds.tieTransactionIds.map((id, index) => ({
            id,
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            externalId: `transaction-tie-${index + 1}`,
            timestamp,
            transactionType: "buy_fiat",
          }))
        )
        yield* db.insert(schema.transactionLegs).values(
          yield* prepareMovementLegFixtures(
            fixtureIds.tieLegIds.map((id, index) => ({
              movementIdentity: {
                sourceRecordKey: `transaction-tie-${index + 1}:acquisition`,
                componentKey: "movement",
              },
              id,
              sourceId: fixture.sourceId,
              principalId: fixture.principalId,
              externalId: `transaction-tie-${index + 1}:acquisition`,
              timestamp,
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.1",
              kind: "acquisition" as const,
              provenance: "deterministic" as const,
              originKind: "none" as const,
              transactionId: fixtureIds.tieTransactionIds[index],
              fiatAmount: "1000",
              fiatCurrency: "EUR",
            }))
          )
        )

        const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
        const listedIds: Array<string> = []
        let cursor: string | null = null

        for (let page = 0; page < 3; page += 1) {
          const response: TransactionListResponse = yield* client.transactions.listTransactions({
            query: { ...(cursor === null ? {} : { cursor }), limit: 1 },
          })
          listedIds.push(...response.transactions.map((transaction) => transaction.transactionId))
          cursor = response.page.nextCursor
        }

        expect(listedIds).toEqual(
          [...fixtureIds.tieTransactionIds].sort((left, right) => right.localeCompare(left))
        )
        expect(new Set(listedIds).size).toBe(3)
        expect(cursor).not.toBeNull()
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
  )

  it.effect("returns 400 for a malformed transaction cursor", () =>
    Effect.gen(function* () {
      const status = yield* Effect.gen(function* () {
        const fixture = yield* seedTransactions
        return yield* getAuthenticatedStatus({
          path: "/v1/transactions?cursor=not-a-cursor",
          userId: fixture.userId,
        })
      }).pipe(Effect.provide(HttpLive), Effect.scoped)

      expect(status).toBe(400)
    })
  )

  it.effect("keeps a factual disposal visible without creating a FIFO shortage review", () =>
    Effect.asVoid(
      Effect.gen(function* () {
        const fixture = yield* seedTransactions
        const repository = yield* SourceNormalizationRepository
        const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-11T12:00:00.000Z"))

        const persisted = yield* repository.persistNormalizedArtifacts({
          transaction: {
            sourceId: fixture.sourceId,
            sourceRawRecordId: null,
            externalId: "transaction-overdrawn-disposal",
            externalGroupId: null,
            timestamp,
            transactionType: "sell_fiat",
            providerTransactionType: "sell",
            providerStatus: "completed",
            providerResourcePath: null,
            providerDescription: "Sell BTC beyond legacy lot balance",
            providerCreatedAt: timestamp,
            providerUpdatedAt: timestamp,
            metadata: { provider: "coinbase" },
            providerFiatAmount: "12000",
            providerFiatCurrency: "EUR",
            principalId: fixture.principalId,
          },
          venueContext: {
            venueType: "cex",
            cexAccountId: fixture.cexAccountId,
            externalAccountId: "coinbase-account-1",
            externalOrderId: null,
            externalFillId: null,
            side: "sell",
            instrument: "BTC-EUR",
            fillPrice: "12000",
            commissionAmount: null,
            commissionCurrency: null,
            metadata: { provider: "coinbase" },
          },
          providerTransfers: [],
          canonicalTransfers: [],
          providerAssetRowIds: [],
          deriveLegs: ({ transaction }) =>
            Effect.succeed([
              {
                movementIdentity: {
                  _tag: "identified" as const,
                  sourceRecordKey: "transaction-overdrawn-disposal:disposal",
                  componentKey: "movement",
                },
                sourceId: fixture.sourceId,
                sourceRawRecordId: null,
                externalId: "transaction-overdrawn-disposal:disposal",
                txHash: null,
                timestamp,
                principalId: fixture.principalId,
                addressId: null,
                assetId: TEST_BTC_ASSET_ID,
                amount: "1",
                kind: "disposal",
                provenance: "deterministic",
                originKind: "none" as const,
                derivationRule: "provider_observed_sell",
                metadata: { provider: "coinbase" },
                transactionId: transaction.id,
                sourceTransferId: null,
                fiatAmount: "12000",
                fiatCurrency: "EUR",
                feeForTransactionId: null,
              },
            ]),
          transactionReview: null,
          resolvedTransactionType: {
            providerTransactionType: "sell",
            transactionType: "sell_fiat",
            inventoryEffect: "disposal",
            taxTreatment: "taxable_by_default",
            resolutionStrategy: "static",
            pairedRecordRequired: false,
            mappingStatus: "approved",
          },
        })

        const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
        const response = yield* client.transactions.listTransactions({ query: { limit: 100 } })
        const transaction = response.transactions.find(
          (candidate) => candidate.transactionId === persisted.transaction.id
        )

        expect(response.transactions.map((candidate) => candidate.transactionId)).toContain(
          persisted.transaction.id
        )
        expect(transaction).toMatchObject({
          externalId: "transaction-overdrawn-disposal",
          movements: [{ amount: "1", assetSymbol: "BTC", kind: "disposal" }],
          calculationState: "partial",
          needsReview: false,
        })
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
  )

  it.effect("keeps non-taxable transfers complete and marks unfinished calculations partial", () =>
    Effect.asVoid(
      Effect.gen(function* () {
        const fixture = yield* seedTransactions
        const db = yield* drizzle

        yield* db.insert(schema.transactions).values([
          {
            id: fixtureIds.internalTransferTransactionId,
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            externalId: "transaction-internal-transfer",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-20T12:00:00.000Z")),
            transactionType: "internal_transfer",
          },
          {
            id: fixtureIds.pendingBasisTransactionId,
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            externalId: "transaction-pending-basis",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-21T12:00:00.000Z")),
            transactionType: "sell_fiat",
          },
          {
            id: fixtureIds.mixedCurrencyTransactionId,
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            externalId: "transaction-mixed-currency",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-22T12:00:00.000Z")),
            transactionType: "sell_fiat",
          },
          {
            id: fixtureIds.missingProceedsTransactionId,
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            externalId: "transaction-missing-proceeds",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-23T12:00:00.000Z")),
            transactionType: "sell_fiat",
          },
          {
            id: fixtureIds.partialMatchTransactionId,
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            externalId: "transaction-partial-match",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-24T12:00:00.000Z")),
            transactionType: "sell_fiat",
          },
        ])
        yield* db.insert(schema.transactionLegs).values(
          yield* prepareMovementLegFixtures([
            {
              movementIdentity: {
                sourceRecordKey: "transaction-internal-transfer:in",
                componentKey: "movement",
              },
              id: fixtureIds.internalTransferLegId,
              sourceId: fixture.sourceId,
              principalId: fixture.principalId,
              externalId: "transaction-internal-transfer:in",
              timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-20T12:00:00.000Z")),
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.1",
              kind: "acquisition",
              provenance: "deterministic",
              originKind: "none" as const,
              transactionId: fixtureIds.internalTransferTransactionId,
              derivationRule: "internal_transfer_in",
              fiatAmount: null,
              fiatCurrency: null,
            },
            {
              movementIdentity: {
                sourceRecordKey: "transaction-buy:pending-basis-acquisition",
                componentKey: "movement",
              },
              id: fixtureIds.pendingBasisAcquisitionLegId,
              sourceId: fixture.sourceId,
              principalId: fixture.principalId,
              externalId: "transaction-buy:pending-basis-acquisition",
              timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-02T12:00:00.000Z")),
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.1",
              kind: "acquisition",
              provenance: "deterministic",
              originKind: "none" as const,
              transactionId: fixtureIds.buyTransactionId,
              fiatAmount: "1000",
              fiatCurrency: "EUR",
            },
            {
              movementIdentity: {
                sourceRecordKey: "transaction-pending-basis:disposal",
                componentKey: "movement",
              },
              id: fixtureIds.pendingBasisDisposalLegId,
              sourceId: fixture.sourceId,
              principalId: fixture.principalId,
              externalId: "transaction-pending-basis:disposal",
              timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-21T12:00:00.000Z")),
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.1",
              kind: "disposal",
              provenance: "deterministic",
              originKind: "none" as const,
              transactionId: fixtureIds.pendingBasisTransactionId,
              fiatAmount: "1500",
              fiatCurrency: "EUR",
            },
            {
              movementIdentity: {
                sourceRecordKey: "transaction-internal-transfer:out",
                componentKey: "movement",
              },
              id: fixtureIds.internalTransferOutLegId,
              sourceId: fixture.sourceId,
              principalId: fixture.principalId,
              externalId: "transaction-internal-transfer:out",
              timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-20T12:00:00.000Z")),
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.1",
              kind: "disposal",
              provenance: "deterministic",
              originKind: "none" as const,
              transactionId: fixtureIds.internalTransferTransactionId,
              derivationRule: "internal_transfer_out",
              fiatAmount: "1000",
              fiatCurrency: "EUR",
            },
            {
              movementIdentity: {
                sourceRecordKey: "transaction-mixed-currency:usd",
                componentKey: "movement",
              },
              id: fixtureIds.mixedCurrencyUsdLegId,
              sourceId: fixture.sourceId,
              principalId: fixture.principalId,
              externalId: "transaction-mixed-currency:usd",
              timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-22T12:00:01.000Z")),
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.1",
              kind: "disposal",
              provenance: "deterministic",
              originKind: "none" as const,
              transactionId: fixtureIds.mixedCurrencyTransactionId,
              fiatAmount: "1600",
              fiatCurrency: "USD",
            },
            {
              movementIdentity: {
                sourceRecordKey: "transaction-missing-proceeds:disposal",
                componentKey: "movement",
              },
              id: fixtureIds.missingProceedsLegId,
              sourceId: fixture.sourceId,
              principalId: fixture.principalId,
              externalId: "transaction-missing-proceeds:disposal",
              timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-23T12:00:00.000Z")),
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.1",
              kind: "disposal",
              provenance: "deterministic",
              originKind: "none" as const,
              transactionId: fixtureIds.missingProceedsTransactionId,
              fiatAmount: null,
              fiatCurrency: null,
            },
            {
              movementIdentity: {
                sourceRecordKey: "transaction-partial-match:disposal",
                componentKey: "movement",
              },
              id: fixtureIds.partialMatchLegId,
              sourceId: fixture.sourceId,
              principalId: fixture.principalId,
              externalId: "transaction-partial-match:disposal",
              timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-24T12:00:00.000Z")),
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.1",
              kind: "disposal",
              provenance: "deterministic",
              originKind: "none" as const,
              transactionId: fixtureIds.partialMatchTransactionId,
              fiatAmount: "1500",
              fiatCurrency: "EUR",
            },
          ])
        )
        const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
        const response = yield* client.transactions.listTransactions({ query: { limit: 20 } })
        const internalTransfer = response.transactions.find(
          (transaction) => transaction.transactionId === fixtureIds.internalTransferTransactionId
        )
        const pendingBasis = response.transactions.find(
          (transaction) => transaction.transactionId === fixtureIds.pendingBasisTransactionId
        )
        const mixedCurrency = response.transactions.find(
          (transaction) => transaction.transactionId === fixtureIds.mixedCurrencyTransactionId
        )
        const missingProceeds = response.transactions.find(
          (transaction) => transaction.transactionId === fixtureIds.missingProceedsTransactionId
        )
        const partialMatch = response.transactions.find(
          (transaction) => transaction.transactionId === fixtureIds.partialMatchTransactionId
        )
        if (
          internalTransfer === undefined ||
          pendingBasis === undefined ||
          mixedCurrency === undefined ||
          missingProceeds === undefined ||
          partialMatch === undefined
        ) {
          return yield* Effect.die("Expected calculation-state fixtures in the transaction list")
        }

        expect(internalTransfer).toMatchObject({
          calculationState: "complete",
          realizedGainLoss: null,
          fiatCurrency: null,
        })
        expect(pendingBasis).toMatchObject({
          calculationState: "partial",
          realizedGainLoss: null,
          fiatCurrency: null,
        })
        expect(mixedCurrency).toMatchObject({
          calculationState: "partial",
          realizedGainLoss: null,
          fiatCurrency: null,
        })
        expect(missingProceeds).toMatchObject({
          calculationState: "partial",
          realizedGainLoss: null,
          fiatCurrency: null,
        })
        expect(partialMatch).toMatchObject({
          calculationState: "partial",
          realizedGainLoss: null,
          fiatCurrency: null,
        })
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
  )
})

// The same real correction and calculation writers used by the repository proof.
const scope = {
  jurisdiction: JurisdictionCode.make("DE"),
  taxYear: TaxYear.make(2026),
  reportingCurrency: CurrencyCode.make("EUR"),
}
const PRINCIPAL_ID = PrincipalId.make("00000000-0000-4000-8000-000000007101")
const USER_ID = AuthUserId.make("00000000-0000-4000-8000-000000007102")
const SOURCE_ID = "00000000-0000-4000-8000-000000007103"
const EUR = CurrencyCode.make("EUR")
const runPg = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    import("../../persistence/tests/support/integration-test-kit.ts").SyncEngineRepositoryTestRuntime
  >
) => effect.pipe(Effect.provide(TestPgClientLive), Effect.scoped)
const runId = (index: number) =>
  CalculationRunId.make(`00000000-0000-4000-8000-${String(7200 + index).padStart(12, "0")}`)
const runLayer = CalculationRunServiceLive.pipe(
  Layer.provide(Layer.merge(CalculationRunRepositoryLive, FactualLedgerRepositoryLive))
)
const recompute = (index: number) =>
  context.runWithLayer({
    layer: runLayer,
    effect: Effect.flatMap(CalculationRunService, (service) =>
      service.recompute({
        id: runId(index),
        principalId: PRINCIPAL_ID,
        ...scope,
        accountingChoices: [],
      })
    ),
  })
const seedCalculation = (quantity = "2") =>
  Effect.gen(function* () {
    const fixture = yield* seedSyncEngineRepositoryFixture({
      principalId: PRINCIPAL_ID,
      userId: USER_ID,
      sourceId: SOURCE_ID,
    })
    yield* seedSyncEngineAssets(fixture)
    const db = yield* drizzle
    const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2026-02-01T00:00:00Z"))
    const saleTimestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2026-03-01T00:00:00Z"))
    const [purchase, sale] = yield* db
      .insert(schema.transactions)
      .values([
        {
          principalId: PRINCIPAL_ID,
          sourceId: SOURCE_ID,
          externalId: "synthetic-purchase",
          timestamp,
          transactionType: "buy_fiat",
          providerFiatAmount: null,
          providerFiatCurrency: null,
        },
        {
          principalId: PRINCIPAL_ID,
          sourceId: SOURCE_ID,
          externalId: "synthetic-sale",
          timestamp: saleTimestamp,
          transactionType: "sell_fiat",
          providerFiatAmount: "30",
          providerFiatCurrency: "EUR",
        },
      ])
      .returning({ id: schema.transactions.id })
    if (purchase === undefined || sale === undefined)
      return yield* Effect.die("Missing synthetic transactions")
    const legs = yield* prepareMovementLegFixtures([
      {
        movementIdentity: { sourceRecordKey: "synthetic-purchase", componentKey: "principal" },
        principalId: PRINCIPAL_ID,
        sourceId: SOURCE_ID,
        externalId: "synthetic-purchase-leg",
        transactionId: purchase.id,
        timestamp,
        assetId: TEST_BTC_ASSET_ID,
        amount: quantity,
        kind: "acquisition",
        provenance: "deterministic",
        originKind: "none",
      },
      {
        movementIdentity: { sourceRecordKey: "synthetic-sale", componentKey: "principal" },
        principalId: PRINCIPAL_ID,
        sourceId: SOURCE_ID,
        externalId: "synthetic-sale-leg",
        transactionId: sale.id,
        timestamp: saleTimestamp,
        assetId: TEST_BTC_ASSET_ID,
        amount: quantity,
        kind: "disposal",
        provenance: "deterministic",
        originKind: "none",
      },
    ])
    const [acquisition, disposition] = yield* db
      .insert(schema.transactionLegs)
      .values(legs)
      .returning({
        id: schema.transactionLegs.id,
        targetId: schema.transactionLegs.movementCorrectionTargetId,
      })
    if (acquisition === undefined || disposition === undefined)
      return yield* Effect.die("Missing synthetic movements")
    return {
      acquisition,
      disposition,
      purchaseId: purchase.id,
      saleId: sale.id,
    }
  })

// Replay the fixture through the real reset and normalization writers, preserving writer-recorded targets.
const replaySyntheticSource = (replacement?: {
  readonly timestamp?: string
  readonly kind?: "acquisition" | "disposal" | "income" | "fee"
  readonly amount?: string
  readonly assetId?: string
  readonly afterReset?: () => ReturnType<typeof recompute>
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const transactions = yield* db
      .select({
        id: schema.transactions.id,
        externalId: schema.transactions.externalId,
        timestamp: schema.transactions.timestamp,
        transactionType: schema.transactions.transactionType,
        providerTransactionType: schema.transactions.providerTransactionType,
        providerFiatAmount: schema.transactions.providerFiatAmount,
        providerFiatCurrency: schema.transactions.providerFiatCurrency,
      })
      .from(schema.transactions)
      .where(eq(schema.transactions.sourceId, SOURCE_ID))
    const legs = yield* db
      .select({
        id: schema.transactionLegs.id,
        transactionId: schema.transactionLegs.transactionId,
        targetId: schema.transactionLegs.movementCorrectionTargetId,
        externalId: schema.transactionLegs.externalId,
        amount: schema.transactionLegs.amount,
        kind: schema.transactionLegs.kind,
        assetId: schema.transactionLegs.assetId,
        sourceRecordKey: schema.movementCorrectionTargets.sourceRecordKey,
        componentKey: schema.movementCorrectionTargets.componentKey,
      })
      .from(schema.transactionLegs)
      .innerJoin(
        schema.movementCorrectionTargets,
        eq(schema.movementCorrectionTargets.id, schema.transactionLegs.movementCorrectionTargetId)
      )
      .where(eq(schema.transactionLegs.sourceId, SOURCE_ID))
    const reset = yield* SourceReplayRepository
    yield* reset.resetSourceDerivedState({ sourceId: SOURCE_ID })
    if (replacement?.afterReset !== undefined) yield* replacement.afterReset()
    const writer = yield* SourceNormalizationRepository
    for (const old of transactions) {
      yield* writer.persistNormalizedArtifacts({
        transaction: {
          sourceId: SOURCE_ID,
          sourceRawRecordId: null,
          externalId: old.externalId,
          externalGroupId: null,
          timestamp:
            replacement?.timestamp === undefined
              ? old.timestamp
              : DateTime.toDateUtc(DateTime.makeUnsafe(replacement.timestamp)),
          transactionType: old.transactionType,
          providerTransactionType: old.providerTransactionType,
          providerStatus: "completed",
          providerResourcePath: null,
          providerDescription: null,
          providerCreatedAt: old.timestamp,
          providerUpdatedAt: old.timestamp,
          metadata: null,
          providerFiatAmount: old.providerFiatAmount,
          providerFiatCurrency: old.providerFiatCurrency,
          principalId: PRINCIPAL_ID,
        },
        venueContext: {
          venueType: "cex",
          cexAccountId: null,
          externalAccountId: null,
          externalOrderId: null,
          externalFillId: null,
          side: null,
          instrument: null,
          fillPrice: null,
          commissionAmount: null,
          commissionCurrency: null,
          metadata: null,
        },
        providerTransfers: [],
        canonicalTransfers: [],
        providerAssetRowIds: [],
        transactionReview: null,
        resolvedTransactionType: {
          providerTransactionType:
            old.providerTransactionType ?? old.transactionType ?? "synthetic",
          transactionType: old.transactionType,
          inventoryEffect: "unknown",
          taxTreatment: "requires_additional_rule_logic",
          resolutionStrategy: "static",
          pairedRecordRequired: false,
          mappingStatus: "approved",
        },
        deriveLegs: ({ transaction }) =>
          Effect.succeed(
            legs
              .filter((leg) => leg.transactionId === old.id)
              .map((leg) => ({
                movementIdentity: {
                  _tag: "identified" as const,
                  sourceRecordKey: leg.sourceRecordKey,
                  componentKey: leg.componentKey,
                },
                sourceId: SOURCE_ID,
                sourceRawRecordId: null,
                externalId: leg.externalId,
                txHash: null,
                timestamp:
                  replacement?.timestamp === undefined
                    ? old.timestamp
                    : DateTime.toDateUtc(DateTime.makeUnsafe(replacement.timestamp)),
                principalId: PRINCIPAL_ID,
                addressId: null,
                assetId: replacement?.assetId ?? leg.assetId,
                amount: replacement?.amount ?? leg.amount,
                kind: replacement?.kind ?? leg.kind,
                provenance: "deterministic" as const,
                originKind: "none" as const,
                derivationRule: "synthetic-replay",
                metadata: null,
                transactionId: transaction.id,
                sourceTransferId: null,
                fiatAmount: null,
                fiatCurrency: null,
                feeForTransactionId: null,
              }))
          ),
      })
    }
    const replayed = yield* db
      .select({
        id: schema.transactionLegs.id,
        transactionId: schema.transactionLegs.transactionId,
        targetId: schema.transactionLegs.movementCorrectionTargetId,
      })
      .from(schema.transactionLegs)
      .where(eq(schema.transactionLegs.sourceId, SOURCE_ID))
    expect(replayed).toHaveLength(legs.length)
    for (const leg of replayed) {
      const old = legs.find(({ targetId }) => targetId === leg.targetId)
      expect(old).toBeDefined()
      expect(leg.id).not.toBe(old?.id)
      expect(leg.transactionId).not.toBe(old?.transactionId)
    }
    return replayed
  })

const changePrice = ({
  operation,
  targetId,
  input,
}: {
  readonly operation: "create" | "replace" | "withdraw"
  readonly targetId: string
  readonly input?: MovementPriceInput
}) =>
  context.runWithLayer({
    layer: PrincipalTransactionOverrideRepositoryLive,
    effect: Effect.flatMap(PrincipalTransactionOverrideRepository, (repository) =>
      Effect.gen(function* () {
        const found = yield* repository.findContext({
          principalId: PRINCIPAL_ID,
          targetId,
          reportingCurrency: EUR,
        })
        if (Option.isNone(found) || found.value.current === null)
          return yield* Effect.die("Missing current synthetic movement")
        const parameters = {
          principalId: PRINCIPAL_ID,
          actorUserId: USER_ID,
          targetId,
          expectedSystemRevision: found.value.current.facts.systemRevision,
          expectedLeafId: found.value.price.leaf?.id ?? null,
          reason: "Synthetic price evidence",
          reportingCurrency: EUR,
        }
        const result =
          operation === "withdraw"
            ? yield* repository.withdraw({ ...parameters, kind: "price" })
            : input === undefined
              ? yield* Effect.die("Missing synthetic price")
              : yield* repository[operation]({
                  ...parameters,
                  reportingCurrency: EUR,
                  input: { _tag: "price", input },
                })
        if (Option.isNone(result)) return yield* Effect.die("Synthetic correction was not accepted")
        return result.value
      })
    ),
  })

const completeReplay = (jobId: string) => {
  const state: SourceSyncExecutionState = {
    phase: "completed",
    processedRecords: 1,
    totalRecords: 1,
    fetchedRecords: 1,
    normalizedRecords: 1,
    failedRecords: 0,
    cursorPayload: null,
    highWatermark: null,
    checkpointExternalId: null,
    checkpointRawRecordId: null,
  }
  return context.runWithLayer({
    layer: RepositoriesLive,
    effect: Effect.flatMap(SourceSyncJobRepository, (repo) =>
      Effect.gen(function* () {
        const job = yield* runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ status: schema.processingJobs.status })
              .from(schema.processingJobs)
              .where(eq(schema.processingJobs.id, jobId))
          })
        )
        if (job[0]?.status === "pending")
          yield* repo.claimJob({
            jobId,
            workerId: "synthetic-projection-worker",
            startedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00Z")),
          })
        return yield* repo.completeJob({ jobId, state })
      })
    ),
  })
}

const storedRun = (index: number) =>
  runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      return {
        results: yield* db
          .select({
            acquisitionEventId: schema.calculationRunRealizedResults.acquisitionEventId,
            dispositionEventId: schema.calculationRunRealizedResults.dispositionEventId,
            costBasis: schema.calculationRunRealizedResults.costBasis,
            proceeds: schema.calculationRunRealizedResults.proceeds,
            gainLoss: schema.calculationRunRealizedResults.gainLoss,
            treatmentCodes: schema.calculationRunRealizedResults.treatmentCodes,
          })
          .from(schema.calculationRunRealizedResults)
          .where(eq(schema.calculationRunRealizedResults.runId, runId(index))),
        inputs: yield* db
          .select({ captured: schema.calculationRunCorrectionInputs.captured })
          .from(schema.calculationRunCorrectionInputs)
          .where(eq(schema.calculationRunCorrectionInputs.runId, runId(index))),
      }
    })
  )

const acceptTotal = ({
  targetId,
  amount,
  operation = "create",
}: {
  readonly targetId: string
  readonly amount: string
  readonly operation?: "create" | "replace"
}) => changePrice({ targetId, operation, input: { _tag: "total_value", amount, currency: EUR } })

describe("writer-produced transaction income", () => {
  beforeEach(() => Effect.runPromise(context.recreateTestDatabase()))

  it.effect("keeps receipt income, a real disposal gain, and unavailable income separate", () =>
    Effect.gen(function* () {
      const fixture = yield* seedSyncEngineRepositoryFixture({
        principalId: PRINCIPAL_ID,
        userId: USER_ID,
        sourceId: SOURCE_ID,
      })
      yield* seedSyncEngineAssets(fixture)
      const db = yield* drizzle
      const inputs = [
        { externalId: "income-only", day: "01", quantity: "1", value: "2" },
        { externalId: "income-and-disposal", day: "02", quantity: "2", value: null },
        { externalId: "income-unavailable", day: "03", quantity: "1", value: null },
      ] as const
      const transactions = yield* Effect.forEach(inputs, (input) =>
        Effect.gen(function* () {
          const timestamp = DateTime.toDateUtc(
            DateTime.makeUnsafe(`2026-02-${input.day}T12:00:00Z`)
          )
          const [transaction] = yield* db
            .insert(schema.transactions)
            .values({
              principalId: PRINCIPAL_ID,
              sourceId: SOURCE_ID,
              externalId: input.externalId,
              timestamp,
              transactionType: "staking_reward",
              providerTransactionType: "earn_payout",
              providerFiatAmount: input.value,
              providerFiatCurrency: input.value === null ? null : "EUR",
            })
            .returning({ id: schema.transactions.id })
          if (transaction === undefined) return yield* Effect.die("Missing income transaction")
          const common = {
            principalId: PRINCIPAL_ID,
            sourceId: SOURCE_ID,
            transactionId: transaction.id,
            timestamp,
            assetId: TEST_BTC_ASSET_ID,
            provenance: "deterministic" as const,
            originKind: "none" as const,
          }
          const legs = yield* prepareMovementLegFixtures([
            {
              ...common,
              movementIdentity: { sourceRecordKey: input.externalId, componentKey: "income" },
              externalId: `${input.externalId}-income`,
              amount: input.quantity,
              kind: "income",
            },
            ...(input.externalId === "income-and-disposal"
              ? [
                  {
                    ...common,
                    movementIdentity: {
                      sourceRecordKey: input.externalId,
                      componentKey: "disposal",
                    },
                    externalId: `${input.externalId}-disposal`,
                    amount: "0.25",
                    kind: "disposal" as const,
                  },
                ]
              : []),
          ])
          const movements = yield* db.insert(schema.transactionLegs).values(legs).returning({
            id: schema.transactionLegs.id,
            kind: schema.transactionLegs.kind,
            targetId: schema.transactionLegs.movementCorrectionTargetId,
          })
          return { ...transaction, externalId: input.externalId, movements }
        })
      )
      // The second receipt uses the day's quote. Its disposal consumes the first
      // receipt's EUR2/unit basis: EUR0.25 proceeds minus EUR0.50 basis.
      yield* db.insert(schema.assetPrices).values({
        assetId: TEST_BTC_ASSET_ID,
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2026-02-02T00:00:00Z")),
        price: "1",
        currency: "EUR",
        source: "synthetic-income-proof",
      })
      const disposal = transactions
        .flatMap(({ movements }) => movements)
        .find(({ kind }) => kind === "disposal")
      if (disposal === undefined) return yield* Effect.die("Missing synthetic disposal")
      // A same-row staking disposition has unknown system cause. Record a real
      // sale correction so the writer can produce a complete disposal result.
      const corrected = yield* context.runWithLayer({
        layer: PrincipalTransactionOverrideRepositoryLive,
        effect: Effect.flatMap(PrincipalTransactionOverrideRepository, (repository) =>
          Effect.gen(function* () {
            const found = yield* repository.findContext({
              principalId: PRINCIPAL_ID,
              targetId: disposal.targetId,
              reportingCurrency: EUR,
            })
            if (Option.isNone(found) || found.value.current === null)
              return yield* Effect.die("Missing disposal context")
            const accepted = yield* repository.create({
              principalId: PRINCIPAL_ID,
              actorUserId: USER_ID,
              targetId: disposal.targetId,
              reportingCurrency: EUR,
              expectedSystemRevision: found.value.current.facts.systemRevision,
              expectedLeafId: null,
              reason: "Synthetic sale paired with staking income",
              input: { _tag: "classification", input: { _tag: "outbound", cause: "sale" } },
            })
            if (Option.isNone(accepted))
              return yield* Effect.die("Missing accepted sale correction")
            return accepted.value
          })
        ),
      })
      yield* completeReplay(corrected.processingJobId)
      const priced = yield* acceptTotal({ targetId: disposal.targetId, amount: "0.25" })
      yield* completeReplay(priced.processingJobId)
      yield* recompute(30)
      const storedIncome = yield* db
        .select({
          eventId: schema.calculationRunIncomeResults.eventId,
          value: schema.calculationRunIncomeResults.value,
        })
        .from(schema.calculationRunIncomeResults)
        .where(eq(schema.calculationRunIncomeResults.runId, runId(30)))
      const storedDisposals = yield* db
        .select({
          eventId: schema.calculationRunRealizedResults.dispositionEventId,
          gainLoss: schema.calculationRunRealizedResults.gainLoss,
        })
        .from(schema.calculationRunRealizedResults)
        .where(eq(schema.calculationRunRealizedResults.runId, runId(30)))
      expect(storedIncome).toHaveLength(2)
      expect(
        storedIncome.map(({ value }) => BigDecimal.format(BigDecimal.fromStringUnsafe(value)))
      ).toEqual(["2", "2"])
      expect(storedDisposals).toHaveLength(1)
      expect(
        storedDisposals.map(({ gainLoss }) =>
          BigDecimal.format(BigDecimal.fromStringUnsafe(gainLoss))
        )
      ).toEqual(["-0.25"])
      const client = yield* makeAuthenticatedClient({ userId: USER_ID })
      const response = yield* client.transactions.listTransactions({ query: { limit: 10 } })
      for (const transaction of transactions) {
        const row = response.transactions.find(
          ({ transactionId }) => transactionId === transaction.id
        )
        const incomeEvent = transaction.movements.find(({ kind }) => kind === "income")
        if (transaction.externalId === "income-unavailable") {
          expect(storedIncome.some(({ eventId }) => eventId === incomeEvent?.id)).toBe(false)
          expect(row).toMatchObject({ income: null, realizedGainLoss: null })
        } else {
          expect(storedIncome.find(({ eventId }) => eventId === incomeEvent?.id)).toBeDefined()
          expect(row).toMatchObject({
            income: "2",
            realizedGainLoss: transaction.externalId === "income-only" ? null : "-0.25",
            fiatCurrency: "EUR",
          })
        }
      }
      const correctedRow = response.transactions.find(({ transactionId }) =>
        transactions.some(
          (transaction) =>
            transaction.id === transactionId && transaction.externalId === "income-and-disposal"
        )
      )
      expect(
        correctedRow?.movements.find(({ targetId }) => targetId === disposal.targetId)?.capture
      ).toMatchObject({
        cause: "sale",
        eventKind: "disposition",
        eventId: disposal.id,
        selectedValue: { kind: "user_valuation", amount: "0.25", currency: "EUR" },
      })
      expect(storedDisposals[0]?.eventId).toBe(disposal.id)
      const replayed = yield* replaySyntheticSource()
      const afterReplay = yield* client.transactions.listTransactions({ query: { limit: 10 } })
      const incomeRow = afterReplay.transactions.find((row) =>
        row.movements.some(({ targetId }) => targetId === disposal.targetId)
      )
      expect(incomeRow).toMatchObject({
        income: "2",
        realizedGainLoss: "-0.25",
        fiatCurrency: "EUR",
      })
      expect(
        incomeRow?.movements.find(({ targetId }) => targetId === disposal.targetId)?.capture
      ).toMatchObject({ eventId: disposal.id, runId: runId(30) })
      expect(replayed.find(({ targetId }) => targetId === disposal.targetId)?.id).not.toBe(
        disposal.id
      )
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )
})

describe("writer-produced transaction list captures", () => {
  beforeEach(() => Effect.runPromise(context.recreateTestDatabase()))

  it.effect("keeps absent capture unavailable when its durable target reappears after replay", () =>
    Effect.gen(function* () {
      const fixture = yield* seedCalculation("10")
      const accepted = yield* acceptTotal({ targetId: fixture.acquisition.targetId, amount: "20" })
      yield* completeReplay(accepted.processingJobId)
      yield* replaySyntheticSource({ afterReset: () => recompute(44) })
      const db = yield* drizzle
      const absent = yield* db
        .select({ captured: schema.calculationRunMovementInputs.captured })
        .from(schema.calculationRunMovementInputs)
        .where(
          and(
            eq(schema.calculationRunMovementInputs.runId, runId(44)),
            eq(schema.calculationRunMovementInputs.targetId, fixture.acquisition.targetId)
          )
        )
      expect(absent).toHaveLength(1)
      expect(absent[0]?.captured).toMatchObject({ current: null, currentOutcome: "absent" })
      const client = yield* makeAuthenticatedClient({ userId: USER_ID })
      const response = yield* client.transactions.listTransactions({ query: { limit: 10 } })
      const purchase = response.transactions.find((row) =>
        row.movements.some(({ targetId }) => targetId === fixture.acquisition.targetId)
      )
      expect(purchase).toMatchObject({ income: null, realizedGainLoss: null, fiatCurrency: null })
      expect(purchase?.movements[0]?.capture).toBeNull()
      const retained = yield* db
        .select({ captured: schema.calculationRunMovementInputs.captured })
        .from(schema.calculationRunMovementInputs)
        .where(
          and(
            eq(schema.calculationRunMovementInputs.runId, runId(44)),
            eq(schema.calculationRunMovementInputs.targetId, fixture.acquisition.targetId)
          )
        )
      expect(retained).toEqual(absent)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect(
    "retains withheld movement display facts after replay changes the imported movement",
    () =>
      Effect.gen(function* () {
        const fixture = yield* seedCalculation("10")
        const db = yield* drizzle
        yield* db
          .update(schema.transactionLegs)
          .set({ assetRepresentationId: TEST_BTC_REPRESENTATION_ID })
          .where(eq(schema.transactionLegs.id, fixture.acquisition.id))
        yield* recompute(43)
        const client = yield* makeAuthenticatedClient({ userId: USER_ID })
        const before = yield* client.transactions.listTransactions({ query: { limit: 10 } })
        const original = before.transactions.find((row) =>
          row.movements.some(({ targetId }) => targetId === fixture.acquisition.targetId)
        )?.movements[0]
        expect(original).toMatchObject({
          amount: "10",
          assetSymbol: "BTC",
          kind: "acquisition",
          capture: { runId: runId(43), outcome: "withheld", eventId: null },
        })
        const replayAssetId = "00000000-0000-4000-8000-000000007297"
        yield* db
          .insert(schema.assets)
          .values({ id: replayAssetId, name: "New replay asset", symbol: "NEW", type: "fungible" })
        yield* replaySyntheticSource({
          kind: "fee",
          amount: "99",
          assetId: replayAssetId,
          timestamp: "2027-03-01T00:00:00Z",
        })
        const after = yield* client.transactions.listTransactions({ query: { limit: 10 } })
        const replayed = after.transactions.find((row) =>
          row.movements.some(({ targetId }) => targetId === fixture.acquisition.targetId)
        )?.movements[0]
        expect(replayed).toEqual(original)
        expect(
          before.transactions.find((row) =>
            row.movements.some((movement) => movement.targetId === fixture.acquisition.targetId)
          )?.attention
        ).toBe(true)
        expect(
          after.transactions.find((row) =>
            row.movements.some((movement) => movement.targetId === fixture.acquisition.targetId)
          )?.attention
        ).toBe(true)
        const choices = yield* client.transactions.filterChoices()
        expect(choices.assets.map((asset) => asset.assetId)).toContain(TEST_BTC_ASSET_ID)
        expect(choices.assets.map((asset) => asset.assetId)).not.toContain(replayAssetId)
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("reads combined asset, category and price corrections from the completed capture", () =>
    Effect.gen(function* () {
      const fixture = yield* seedCalculation("10")
      const db = yield* drizzle
      const replacementAssetId = "00000000-0000-4000-8000-000000007299"
      yield* db.insert(schema.assets).values({
        id: replacementAssetId,
        name: "Selected asset",
        symbol: "SELECTED",
        type: "fungible",
      })
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2026-02-01T00:00:00Z"))
      const [provider] = yield* db
        .insert(schema.providerAssets)
        .values({
          provider: "synthetic",
          providerAssetId: "list-corrected-asset",
          currencyCode: "BTC",
          name: "Synthetic Bitcoin",
          exponent: 8,
          providerType: "crypto",
          rawProviderPayload: {},
          evidenceRevision: 1,
          discoveredAt: timestamp,
          retrievedAt: timestamp,
        })
        .returning({ id: schema.providerAssets.id })
      if (provider === undefined) return yield* Effect.die("Missing provider asset")
      yield* db
        .insert(schema.providerAssetSourceUses)
        .values({ providerAssetRowId: provider.id, sourceId: SOURCE_ID })
      yield* db.insert(schema.providerAssetTransactionUses).values({
        providerAssetRowId: provider.id,
        transactionId: fixture.purchaseId,
        sourceId: SOURCE_ID,
      })
      yield* db.insert(schema.providerAssetMappings).values({
        providerAssetRowId: provider.id,
        mappingKind: "asset",
        canonicalAssetId: TEST_BTC_ASSET_ID,
        mappingStatus: "approved",
      })
      yield* db
        .update(schema.transactionLegs)
        .set({ providerAssetRowId: provider.id, kind: "income" })
        .where(eq(schema.transactionLegs.id, fixture.acquisition.id))
      yield* db
        .update(schema.transactions)
        .set({ transactionType: "staking_reward" })
        .where(eq(schema.transactions.id, fixture.purchaseId))
      const assetCorrection = yield* context.runWithLayer({
        layer: PrincipalAssetOverrideRepositoryLive,
        effect: Effect.flatMap(PrincipalAssetOverrideRepository, (repository) =>
          Effect.gen(function* () {
            const target = { _tag: "provider_asset", providerAssetRowId: provider.id } as const
            const initial = yield* repository.findProjection({ principalId: PRINCIPAL_ID, target })
            if (Option.isNone(initial)) return yield* Effect.die("Missing asset projection")
            const created = yield* repository.create({
              principalId: PRINCIPAL_ID,
              actorUserId: USER_ID,
              target,
              expectedSystemRevision: initial.value.system.identityRevision,
              reason: "Synthetic selected asset",
              replacement: { _tag: "identity", assetId: replacementAssetId },
            })
            if (Option.isNone(created))
              return yield* Effect.die("Asset correction was not accepted")
            expect(created.value.activeIdentityOverride?.replacementIdentity?.assetId).toBe(
              replacementAssetId
            )
            return created.value
          })
        ),
      })
      const classified = yield* context.runWithLayer({
        layer: PrincipalTransactionOverrideRepositoryLive,
        effect: Effect.flatMap(PrincipalTransactionOverrideRepository, (repository) =>
          Effect.gen(function* () {
            const found = yield* repository.findContext({
              principalId: PRINCIPAL_ID,
              targetId: fixture.acquisition.targetId,
              reportingCurrency: EUR,
            })
            if (Option.isNone(found) || found.value.current === null)
              return yield* Effect.die("Missing current movement")
            const accepted = yield* repository.create({
              principalId: PRINCIPAL_ID,
              actorUserId: USER_ID,
              targetId: fixture.acquisition.targetId,
              reportingCurrency: EUR,
              expectedSystemRevision: found.value.current.facts.systemRevision,
              expectedLeafId: null,
              reason: "Synthetic purchase category",
              input: { _tag: "classification", input: { _tag: "inbound", cause: "purchase" } },
            })
            if (Option.isNone(accepted)) return yield* Effect.die("Missing accepted category")
            return accepted.value
          })
        ),
      })
      yield* completeReplay(classified.processingJobId)
      const priced = yield* acceptTotal({ targetId: fixture.acquisition.targetId, amount: "20" })
      yield* completeReplay(priced.processingJobId)
      yield* recompute(42)
      const client = yield* makeAuthenticatedClient({ userId: USER_ID })
      const response = yield* client.transactions.listTransactions({ query: { limit: 10 } })
      const purchase = response.transactions.find(
        ({ transactionId }) => transactionId === fixture.purchaseId
      )
      expect(purchase?.movements[0]).toMatchObject({
        targetId: fixture.acquisition.targetId,
        amount: "10",
        assetSymbol: "SELECTED",
        kind: "acquisition",
        capture: {
          runId: runId(42),
          assetId: replacementAssetId,
          assetSymbol: "SELECTED",
          cause: "purchase",
          selectedValue: { kind: "user_valuation", amount: "20", currency: "EUR" },
        },
      })
      const active = assetCorrection.activeIdentityOverride
      if (active === null) return yield* Effect.die("Missing accepted asset override")
      yield* context.runWithLayer({
        layer: PrincipalAssetOverrideRepositoryLive,
        effect: Effect.flatMap(PrincipalAssetOverrideRepository, (repository) =>
          repository
            .replace({
              principalId: PRINCIPAL_ID,
              actorUserId: USER_ID,
              target: { _tag: "provider_asset", providerAssetRowId: provider.id },
              expectedActiveOverrideId: active.id,
              expectedSystemRevision: assetCorrection.system.identityRevision,
              replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
              reason: "Synthetic newer pending identity",
            })
            .pipe(
              Effect.tap((result) => Effect.sync(() => expect(Option.isSome(result)).toBe(true)))
            )
        ),
      })
      const pending = yield* client.transactions.listTransactions({ query: { limit: 10 } })
      expect(
        pending.transactions.find((row) => row.transactionId === fixture.purchaseId)?.movements
      ).toEqual(purchase?.movements)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect(
    "keeps fee targets separate and preserves known captures beside an unrelated blocked movement",
    () =>
      Effect.gen(function* () {
        const fixture = yield* seedCalculation("10")
        const db = yield* drizzle
        const feeAssetId = "00000000-0000-4000-8000-000000007298"
        yield* db
          .insert(schema.assets)
          .values({ id: feeAssetId, name: "Unpriced fee asset", symbol: "FEE", type: "fungible" })
        const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2026-03-01T00:00:00Z"))
        const [fee] = yield* db
          .insert(schema.transactionLegs)
          .values(
            yield* prepareMovementLegFixtures([
              {
                movementIdentity: { sourceRecordKey: "synthetic-sale", componentKey: "fee" },
                principalId: PRINCIPAL_ID,
                sourceId: SOURCE_ID,
                externalId: "synthetic-sale-fee",
                transactionId: fixture.saleId,
                timestamp,
                assetId: feeAssetId,
                amount: "0.1",
                kind: "fee",
                provenance: "deterministic",
                originKind: "none",
              },
            ])
          )
          .returning({ targetId: schema.transactionLegs.movementCorrectionTargetId })
        if (fee === undefined) return yield* Effect.die("Missing synthetic fee")
        const accepted = yield* acceptTotal({
          targetId: fixture.acquisition.targetId,
          amount: "20",
        })
        yield* completeReplay(accepted.processingJobId)
        const result = yield* recompute(41)
        expect(result.status).toBe("partial")
        const client = yield* makeAuthenticatedClient({ userId: USER_ID })
        const response = yield* client.transactions.listTransactions({ query: { limit: 10 } })
        const purchase = response.transactions.find(
          ({ transactionId }) => transactionId === fixture.purchaseId
        )
        const sale = response.transactions.find(
          ({ transactionId }) => transactionId === fixture.saleId
        )
        expect(purchase?.movements[0]?.capture).toMatchObject({
          runId: runId(41),
          quantity: "10",
          selectedValue: { kind: "user_valuation", amount: "20", currency: "EUR" },
        })
        expect(sale?.realizedGainLoss).toBe("10")
        expect(sale?.movements).toHaveLength(2)
        expect(new Set(sale?.movements.map(({ targetId }) => targetId))).toEqual(
          new Set([fixture.disposition.targetId, fee.targetId])
        )
        expect(sale?.movements.find(({ kind }) => kind === "fee")).toMatchObject({
          targetId: fee.targetId,
          amount: "0.1",
          capture: { runId: runId(41) },
        })
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect(
    "retains original purchase value after selling all ten units through HTTP and both SDKs",
    () =>
      Effect.gen(function* () {
        const fixture = yield* seedCalculation("10")
        const client = yield* makeAuthenticatedClient({ userId: USER_ID })
        const before = yield* client.transactions.listTransactions({ query: { limit: 10 } })
        expect(
          before.transactions
            .flatMap(({ movements }) => movements)
            .every(({ capture }) => capture === null)
        ).toBe(true)
        const accepted = yield* acceptTotal({
          targetId: fixture.acquisition.targetId,
          amount: "20",
        })
        yield* completeReplay(accepted.processingJobId)
        yield* recompute(40)
        const db = yield* drizzle
        const inventory = yield* db
          .select({ quantity: schema.calculationRunDerivedLots.remainingQuantity })
          .from(schema.calculationRunDerivedLots)
          .where(eq(schema.calculationRunDerivedLots.runId, runId(40)))
        expect(inventory).toEqual([])
        const server = yield* HttpServer.HttpServer
        if (server.address._tag !== "TcpAddress")
          return yield* Effect.die("Expected TCP test server")
        const sdk = new TaxMaxi({
          apiKey: `user_${USER_ID}_admin`,
          baseUrl: `http://127.0.0.1:${server.address.port}`,
        })
        const responses = [
          yield* client.transactions.listTransactions({ query: { limit: 10 } }),
          yield* sdk.effect.transactions.list({ limit: 10 }),
          yield* Effect.promise(() => sdk.transactions.list({ limit: 10 })),
        ]
        for (const response of responses) {
          const purchase = response.transactions.find(
            ({ transactionId }) => transactionId === fixture.purchaseId
          )
          const sale = response.transactions.find(
            ({ transactionId }) => transactionId === fixture.saleId
          )
          expect(purchase?.movements).toEqual([
            expect.objectContaining({
              targetId: fixture.acquisition.targetId,
              capture: expect.objectContaining({
                runId: runId(40),
                eventId: fixture.acquisition.id,
                quantity: "10",
                assetId: TEST_BTC_ASSET_ID,
                eventKind: "acquisition",
                outcome: "included",
                valuationState: "selected",
                selectedValue: { kind: "user_valuation", amount: "20", currency: "EUR" },
                acquisitionCostBasis: null,
                realizedResults: [],
              }),
            }),
          ])
          expect(sale?.movements).toEqual([
            expect.objectContaining({
              targetId: fixture.disposition.targetId,
              capture: expect.objectContaining({
                runId: runId(40),
                eventId: fixture.disposition.id,
                providerConsiderations: [{ amount: "30", currency: "EUR" }],
                quantity: "10",
                eventKind: "disposition",
                selectedValue: { kind: "observed_consideration", amount: "30", currency: "EUR" },
                realizedResults: [
                  expect.objectContaining({
                    acquisitionEventId: fixture.acquisition.id,
                    quantity: "10",
                    costBasis: "20",
                    proceeds: "30",
                    gainLoss: "10",
                    currency: "EUR",
                  }),
                ],
              }),
            }),
          ])
        }
        yield* replaySyntheticSource()
        const replayedPage = yield* client.transactions.listTransactions({ query: { limit: 10 } })
        expect(
          replayedPage.transactions.find((row) =>
            row.movements.some(({ targetId }) => targetId === fixture.disposition.targetId)
          )
        ).toMatchObject({ realizedGainLoss: "10", fiatCurrency: "EUR" })
        yield* acceptTotal({
          targetId: fixture.acquisition.targetId,
          amount: "40",
          operation: "replace",
        })
        const pending = yield* client.transactions.listTransactions({ query: { limit: 10 } })
        expect(
          pending.transactions.find((row) =>
            row.movements.some(({ targetId }) => targetId === fixture.acquisition.targetId)
          )?.movements[0]?.capture
        ).toMatchObject({
          runId: runId(40),
          quantity: "10",
          selectedValue: { kind: "user_valuation", amount: "20", currency: "EUR" },
        })
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )
})

describe("transaction detail HTTP and SDK", () => {
  beforeEach(() => Effect.runPromise(context.recreateTestDatabase()))

  for (const style of ["Effect", "Promise"] as const) {
    it.effect(`reads actual correction runs and retained history through the ${style} SDK`, () =>
      Effect.gen(function* () {
        const fixture = yield* seedCalculation()
        const server = yield* HttpServer.HttpServer
        if (server.address._tag !== "TcpAddress")
          return yield* Effect.die("Expected TCP test server")
        const sdk = new TaxMaxi({
          apiKey: `user_${USER_ID}_admin`,
          baseUrl: `http://127.0.0.1:${server.address.port}`,
        })
        const get = (transactionId: string) =>
          style === "Effect"
            ? sdk.effect.transactions.get({ transactionId, taxYear: 2026 })
            : Effect.promise(() => sdk.transactions.get({ transactionId, taxYear: 2026 }))
        const before = yield* get(fixture.saleId)
        expect(before.calculation.run).toBeNull()
        expect(before.calculation.allocations).toEqual([])
        expect(before.classificationHistoryStatus).toBe("unavailable")
        expect(before.sourceRawRecordId).toBeNull()
        expect(before.timestamp).toBe("2026-03-01T00:00:00.000Z")
        expect(before.movements[0]?.id).toBe(fixture.disposition.id)

        const accepted = yield* acceptTotal({
          targetId: fixture.acquisition.targetId,
          amount: "20",
        })
        yield* completeReplay(accepted.processingJobId)
        yield* recompute(1)
        const retained = yield* storedRun(1)
        const sale = yield* get(fixture.saleId)
        expect(sale.calculation.run).toMatchObject({
          id: runId(1),
          status: "complete",
          taxYear: 2026,
          jurisdiction: "DE",
          reportingCurrency: "EUR",
        })
        expect(sale.calculation.run?.inputLedgerRevision).toBeTruthy()
        expect(sale.calculation.run?.valuationRevision).toBeTruthy()
        expect(sale.calculation.allocations).toHaveLength(1)
        expect(sale.calculation.allocations[0]).toMatchObject({
          ...retained.results[0],
          costBasis: "20",
          proceeds: "30",
          gainLoss: "10",
        })
        expect(sale.calculation.correctionInputs).toContainEqual(
          expect.objectContaining({
            history: expect.objectContaining({ id: accepted.overrideId }),
            application: "applied",
            resolvedPrice: expect.objectContaining({ totalValue: "20" }),
          })
        )
        const replacement = yield* acceptTotal({
          targetId: fixture.acquisition.targetId,
          amount: "30",
          operation: "replace",
        })
        const pending = yield* get(fixture.purchaseId)
        expect(pending.calculation.run?.id).toBe(runId(1))
        expect(pending.movementOverrides[0]?.price).toMatchObject({
          active: { id: replacement.overrideId },
          coverage: null,
        })
        expect(
          pending.movementOverrides[0]?.inputs.corrections.find(
            (input) => input.application === "applied"
          )?.resolvedPrice?.totalValue
        ).toBe("30")
        expect(
          pending.calculation.correctionInputs.find(
            (input) => input.history.id === accepted.overrideId
          )?.resolvedPrice?.totalValue
        ).toBe("20")
        expect(
          pending.calculation.correctionInputs.some(
            (input) => input.history.id === replacement.overrideId
          )
        ).toBe(false)
        yield* completeReplay(replacement.processingJobId)
        yield* recompute(2)
        const replaced = yield* get(fixture.saleId)
        const replacementStored = yield* storedRun(2)
        expect(replaced.calculation.allocations[0]).toMatchObject({
          ...replacementStored.results[0],
          costBasis: "30",
          proceeds: "30",
          gainLoss: "0",
        })
        expect(replaced.calculation.run?.id).toBe(runId(2))
        expect(yield* storedRun(1)).toEqual(retained)
        const withdrawal = yield* changePrice({
          targetId: fixture.acquisition.targetId,
          operation: "withdraw",
        })
        const withdrawn = yield* get(fixture.purchaseId)
        expect(withdrawn.movementOverrides[0]?.price.active).toBeNull()
        const history = withdrawn.movementOverrides[0]?.context.history ?? []
        expect(history).toHaveLength(3)
        for (const row of history) {
          expect(row.actorUserId).toBe(USER_ID)
          expect(row.reason).toBe("Synthetic price evidence")
          expect(row.recordedAt).toEqual(expect.any(String))
        }
        expect(history.find((row) => row.id === withdrawal.overrideId)).toMatchObject({
          operation: "withdraw",
          supersedesOverrideId: replacement.overrideId,
          input: null,
        })
        expect(
          withdrawn.calculation.correctionInputs.find(
            (input) => input.history.id === replacement.overrideId
          )?.application
        ).toBe("applied")
        yield* completeReplay(withdrawal.processingJobId)
        yield* recompute(3)
        const partial = yield* get(fixture.purchaseId)
        expect(partial.calculation.run).toMatchObject({ id: runId(3), status: "partial" })
        expect(partial.calculation.allocations[0]).toMatchObject({
          costBasis: null,
          proceeds: null,
          gainLoss: null,
        })
        expect(partial.calculation.correctionInputs).toContainEqual(
          expect.objectContaining({
            history: expect.objectContaining({ id: withdrawal.overrideId }),
            application: "inactive",
            streamState: "withdrawn",
            resolvedPrice: null,
          })
        )
        expect(yield* storedRun(1)).toEqual(retained)
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
  }

  it.effect(
    "enforces transaction detail ownership, canonical IDs, year validation and authentication",
    () =>
      Effect.gen(function* () {
        yield* seedTransactions
        for (const [transactionId, expected] of [
          [fixtureIds.sellTransactionId, 200],
          [fixtureIds.hiddenTransactionId, 404],
          [fixtureIds.unresolvedTransactionId, 404],
          [fixtureIds.excludedTransactionId, 404],
          ["00000000-0000-4000-8000-000000009999", 404],
          ["not-a-uuid", 400],
        ] as const) {
          expect(
            yield* getAuthenticatedStatus({
              path: `/v1/transactions/${transactionId}?taxYear=2025`,
              userId: fixtureIds.userId,
            })
          ).toBe(expected)
        }
        for (const query of ["", "?taxYear=invalid", "?taxYear=2025.5", "?taxYear=0"]) {
          expect(
            yield* getAuthenticatedStatus({
              path: `/v1/transactions/${fixtureIds.sellTransactionId}${query}`,
              userId: fixtureIds.userId,
            })
          ).toBe(400)
        }
        const unauthenticated = yield* HttpClientRequest.get(
          `/v1/transactions/${fixtureIds.sellTransactionId}?taxYear=2025`
        ).pipe(HttpClient.execute)
        expect(unauthenticated.status).toBe(401)
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )
})
