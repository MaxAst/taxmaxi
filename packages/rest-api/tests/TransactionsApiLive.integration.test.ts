import { seedMovementLegs } from "../../persistence/tests/support/movement-leg-fixtures.ts"
import * as DateTime from "effect/DateTime"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { NodeHttpServer } from "@effect/platform-node"
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
import * as Chunk from "effect/Chunk"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { drizzle } from "../../persistence/src/layers/PgClientLive.ts"
import { RepositoriesLive } from "../../persistence/src/layers/RepositoriesLive.ts"
import { eq } from "../../persistence/src/query/index.ts"
import { schema } from "../../persistence/src/schema/index.ts"
import {
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
  TEST_BTC_ASSET_ID,
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
    yield* seedMovementLegs([
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
    yield* seedMovementLegs([
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

await Effect.runPromise(context.recreateTestDatabase())

describe("TransactionsApiLive", () => {
  beforeEach(() => Effect.runPromise(Effect.asVoid(context.recreateTestDatabase())))

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
              realizedGainLoss: "2000",
              fiatCurrency: "EUR",
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
          yield* seedMovementLegs([
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
            yield* seedMovementLegs([
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
        realizedGainLoss: "2000",
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
          yield* seedMovementLegs([
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
          realizedGainLoss: "1000",
          fiatCurrency: "EUR",
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
        const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-01T12:00:00.000Z"))
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
            timestamp: occurredAt,
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
        yield* db.insert(schema.transfers).values({
          id: fixtureIds.canonicalTransferId,
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
          sourceId: fixture.sourceId,
          transactionId: fixtureIds.providerTransferTransactionId,
          externalId: "provider-transfer",
          timestamp: occurredAt,
          direction: "outbound",
          processingMode: "accounting_only",
          fromAccountRef: "own:coinbase",
          toAddress: "bc1qtransactionlistreconciliation",
          amount: "0.2",
        })
        yield* db.insert(schema.transactionLegs).values(
          yield* seedMovementLegs([
            {
              movementIdentity: {
                sourceRecordKey: "provider-transfer-transaction:disposal",
                componentKey: "movement",
              },
              id: fixtureIds.providerTransferLegId,
              sourceId: fixture.sourceId,
              principalId: fixture.principalId,
              externalId: "provider-transfer-transaction:disposal",
              timestamp: occurredAt,
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
            realizedGainLoss: "2000",
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
          yield* seedMovementLegs(
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
          yield* seedMovementLegs([
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
