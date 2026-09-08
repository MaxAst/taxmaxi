import * as DateTime from "effect/DateTime"
import { and, eq, inArray } from "drizzle-orm"
import * as BigDecimal from "effect/BigDecimal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { SourceSyncServiceLive, TransferReconciliationServiceLive } from "@my/sync-engine/layers"
import { AuthUserId } from "@my/core/authentication"
import { PrincipalId } from "@my/core/ownership"
import { SourceSyncJobExecutorLive } from "../../src/layers/SourceSyncJobExecutorLive.ts"
import { SourceProviderRegistryLive } from "../../src/layers/SourceProviderRegistryLive.ts"
import { HeliusSolanaSourceSyncProviderLive } from "../../src/providers/helius-solana/layers/HeliusSolanaSourceSyncProviderLive.ts"
import { CoinbaseLegDerivationServiceLive } from "../../src/providers/coinbase/layers/CoinbaseLegDerivationServiceLive.ts"
import { CoinbaseRecordNormalizerLive } from "../../src/providers/coinbase/layers/CoinbaseRecordNormalizerLive.ts"
import {
  CoinbaseRecordNormalizer,
  type CoinbaseRecordNormalizationResult,
} from "../../src/providers/coinbase/services/CoinbaseRecordNormalizer.ts"
import { CoinbaseReferenceDataServiceLive } from "../../src/providers/coinbase/layers/CoinbaseReferenceDataServiceLive.ts"
import { CoinbaseReferenceMappingServiceLive } from "../../src/providers/coinbase/layers/CoinbaseReferenceMappingServiceLive.ts"
import { CoinbaseSourceSyncProviderLive } from "../../src/providers/coinbase/layers/CoinbaseSourceSyncProviderLive.ts"
import { CoinbaseSourceSyncProvider } from "../../src/providers/coinbase/services/CoinbaseSourceSyncProvider.ts"
import {
  CoinbaseSyncClient,
  type CoinbaseCryptoCurrencyRecord,
  type CoinbaseFiatCurrencyRecord,
} from "../../src/providers/coinbase/services/CoinbaseSyncClient.ts"
import {
  AssetExceptionRepository,
  SourceNormalizationRepository,
  SourceSyncService,
} from "@my/sync-engine/services"
import { AssetRepositoryLive } from "../../../persistence/src/layers/AssetRepositoryLive.ts"
import { AssetExceptionRepositoryLive } from "../../../persistence/src/layers/AssetExceptionRepositoryLive.ts"
import { ProviderAssetRepositoryLive } from "../../../persistence/src/layers/ProviderAssetRepositoryLive.ts"
import { ProviderReferenceRepositoryLive } from "../../../persistence/src/layers/ProviderReferenceRepositoryLive.ts"
import { RepositoriesLive } from "../../../persistence/src/layers/RepositoriesLive.ts"
import { drizzle } from "../../../persistence/src/layers/PgClientLive.ts"
import { PrincipalAssetOverrideRepository } from "../../../persistence/src/services/PrincipalAssetOverrideRepository.ts"
import { schema } from "../../../persistence/src/schema/index.ts"
import {
  makeIntegrationTestDatabaseContext,
  seedSyncEngineRepositoryFixture,
} from "../../../persistence/tests/support/integration-test-kit.ts"
import { ProviderRawRecord } from "../../src/shared/SourceProviderRawBatch.ts"
import type { SourceRawRecord, SourceSyncSource } from "../../src/services/SourceSyncModels.ts"
import { SourceSyncQueueInlineExecutorTestLive } from "../support/SourceSyncQueueInlineExecutorTestLive.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_sync_engine_coinbase_pr04",
})
const TestPgClientLive = context.TestPgClientLive
const recreateTestDatabase = context.recreateTestDatabase
const BTC_ASSET_ID = "00000000-0000-0000-0000-000000000541"
const BTC_BASE_REPRESENTATION_ID = "00000000-0000-0000-0000-000000000543"
const DOT_ASSET_ID = "00000000-0000-0000-0000-000000000542"
const PROVIDER_OVERRIDE_ASSET_ID = "00000000-0000-4000-8000-000000000544"

const expectDecimalAmount = (actual: string, expected: string) => {
  const actualDecimal = BigDecimal.fromString(actual)
  const expectedDecimal = BigDecimal.fromString(expected)

  expect(Option.isSome(actualDecimal)).toBe(true)
  expect(Option.isSome(expectedDecimal)).toBe(true)
  if (Option.isSome(actualDecimal) && Option.isSome(expectedDecimal)) {
    expect(BigDecimal.equals(actualDecimal.value, expectedDecimal.value)).toBe(true)
  }
}

const makeCoinbaseRecord = ({
  externalRecordId,
  occurredAt,
  payload,
  recordType = "coinbase_transaction",
}: {
  readonly externalRecordId: string
  readonly occurredAt: Date
  readonly payload: unknown
  readonly recordType?: "coinbase_account" | "coinbase_transaction"
}): ProviderRawRecord =>
  ProviderRawRecord.make({
    providerKey: "coinbase",
    recordType,
    externalRecordId,
    externalAccountId: "coinbase-account-1",
    externalParentId: null,
    occurredAt,
    payload,
  })

const defaultSyncRecords = [
  makeCoinbaseRecord({
    recordType: "coinbase_account",
    externalRecordId: "coinbase-account-1",
    occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
    payload: {
      id: "coinbase-account-1",
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-01T00:00:00.000Z",
    },
  }),
  makeCoinbaseRecord({
    externalRecordId: "tx-buy-1",
    occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
    payload: {
      id: "tx-buy-1",
      type: "buy",
      status: "completed",
      amount: { amount: "1.00000000", currency: "BTC" },
      native_amount: { amount: "10000.00", currency: "EUR" },
      created_at: "2025-01-01T10:00:00.000Z",
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-buy-1",
      description: "Seed buy",
    },
  }),
  makeCoinbaseRecord({
    externalRecordId: "tx-sell-1",
    occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:00:00.000Z")),
    payload: {
      id: "tx-sell-1",
      type: "advanced_trade_fill",
      status: "completed",
      amount: { amount: "-0.40000000", currency: "BTC" },
      native_amount: { amount: "-6000.00", currency: "EUR" },
      created_at: "2025-02-01T10:00:00.000Z",
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-sell-1",
      advanced_trade_fill: {
        commission: "0.01000000",
        fill_price: "15000.00",
        order_id: "order-sell-1",
        order_side: "sell",
        product_id: "BTC-EUR",
      },
    },
  }),
  makeCoinbaseRecord({
    externalRecordId: "tx-income-1",
    occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-01T10:00:00.000Z")),
    payload: {
      id: "tx-income-1",
      type: "staking_reward",
      status: "completed",
      amount: { amount: "0.020123619236", currency: "DOT" },
      native_amount: { amount: "700.00", currency: "EUR" },
      created_at: "2025-03-01T10:00:00.000Z",
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-income-1",
      description: "Staking reward",
    },
  }),
  makeCoinbaseRecord({
    externalRecordId: "tx-send-1",
    occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-01T10:00:00.000Z")),
    payload: {
      id: "tx-send-1",
      type: "send",
      status: "completed",
      amount: { amount: "-0.10000000", currency: "BTC" },
      native_amount: { amount: "-1500.00", currency: "EUR" },
      created_at: "2025-04-01T10:00:00.000Z",
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-send-1",
      network: {
        status: "confirmed",
        hash: "tx-send-hash-1",
        network_name: "base",
        transaction_fee: { amount: "0.00010000", currency: "BTC" },
      },
      to: {
        address: "bc1qexampledestination",
        resource: "address",
      },
    },
  }),
] as const

const defaultFiatCurrencies = [
  {
    currencyCode: "EUR",
    name: "Euro",
    minSize: "0.01",
    payload: {
      id: "EUR",
      name: "Euro",
      min_size: "0.01",
    },
  },
] as const

const defaultCryptoCurrencies = [
  {
    currencyCode: "BTC",
    name: "Bitcoin",
    providerAssetId: "btc-provider-asset",
    exponent: 8,
    providerType: "crypto",
    payload: {
      code: "BTC",
      name: "Bitcoin",
      exponent: 8,
      type: "crypto",
      asset_id: "btc-provider-asset",
    },
  },
  {
    currencyCode: "ETH",
    name: "Ethereum",
    providerAssetId: "eth-provider-asset",
    exponent: 8,
    providerType: "crypto",
    payload: {
      code: "ETH",
      name: "Ethereum",
      exponent: 8,
      type: "crypto",
      asset_id: "eth-provider-asset",
    },
  },
  {
    currencyCode: "ETH2",
    name: "Ethereum 2",
    providerAssetId: "eth2-provider-asset",
    exponent: 8,
    providerType: "crypto",
    payload: {
      code: "ETH2",
      name: "Ethereum 2",
      exponent: 8,
      type: "crypto",
      asset_id: "eth2-provider-asset",
    },
  },
  {
    currencyCode: "TAO",
    name: "Bittensor",
    providerAssetId: "tao-provider-asset",
    exponent: 8,
    providerType: "crypto",
    payload: {
      code: "TAO",
      name: "Bittensor",
      exponent: 8,
      type: "crypto",
      asset_id: "tao-provider-asset",
    },
  },
  {
    currencyCode: "DOT",
    name: "Polkadot",
    providerAssetId: "dot-provider-asset",
    exponent: 10,
    providerType: "crypto",
    payload: {
      code: "DOT",
      name: "Polkadot",
      exponent: 10,
      type: "crypto",
      asset_id: "dot-provider-asset",
    },
  },
] as const

const hypeCryptoCurrency = {
  currencyCode: "HYPE",
  name: "Hyperliquid",
  providerAssetId: "hype-provider-asset",
  exponent: 8,
  providerType: "crypto",
  payload: {
    code: "HYPE",
    name: "Hyperliquid",
    exponent: 8,
    type: "crypto",
    asset_id: "hype-provider-asset",
  },
} as const

const blockedFeeCryptoCurrency = {
  currencyCode: "BLOCK",
  name: "Blocked fee asset",
  providerAssetId: "blocked-fee-provider-asset",
  exponent: 8,
  providerType: "crypto",
  payload: {
    code: "BLOCK",
    name: "Blocked fee asset",
    exponent: 8,
    type: "crypto",
    asset_id: "blocked-fee-provider-asset",
  },
} as const

const makeHypeReviewableSyncRecords = () =>
  [
    makeCoinbaseRecord({
      recordType: "coinbase_account",
      externalRecordId: "coinbase-account-1",
      occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
      payload: {
        id: "coinbase-account-1",
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      },
    }),
    makeCoinbaseRecord({
      externalRecordId: "tx-hype-buy-1",
      occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-05-01T10:00:00.000Z")),
      payload: {
        id: "tx-hype-buy-1",
        type: "buy",
        status: "completed",
        amount: { amount: "25.00000000", currency: "HYPE" },
        native_amount: { amount: "1050.00", currency: "EUR" },
        created_at: "2025-05-01T10:00:00.000Z",
        resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-hype-buy-1",
        description: "HYPE buy awaiting provider asset review",
      },
    }),
  ] as const

const makeHypeWithBtcFeeSyncRecords = () =>
  [
    makeCoinbaseRecord({
      recordType: "coinbase_account",
      externalRecordId: "coinbase-account-1",
      occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
      payload: {
        id: "coinbase-account-1",
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      },
    }),
    makeCoinbaseRecord({
      externalRecordId: "tx-hype-buy-with-btc-fee",
      occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-05-01T10:00:00.000Z")),
      payload: {
        id: "tx-hype-buy-with-btc-fee",
        type: "buy",
        status: "completed",
        amount: { amount: "25.00000000", currency: "HYPE" },
        native_amount: { amount: "1050.00", currency: "EUR" },
        network: {
          status: "confirmed",
          network_name: "base",
          transaction_fee: { amount: "0.00010000", currency: "BTC" },
        },
        created_at: "2025-05-01T10:00:00.000Z",
        resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-hype-buy-with-btc-fee",
      },
    }),
  ] as const

const makeBtcWithHypeFeeSyncRecords = () =>
  [
    makeCoinbaseRecord({
      recordType: "coinbase_account",
      externalRecordId: "coinbase-account-1",
      occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
      payload: {
        id: "coinbase-account-1",
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      },
    }),
    makeCoinbaseRecord({
      externalRecordId: "tx-btc-with-hype-fee",
      occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-05-01T10:00:00.000Z")),
      payload: {
        id: "tx-btc-with-hype-fee",
        type: "buy",
        status: "completed",
        amount: { amount: "0.01000000", currency: "BTC" },
        native_amount: { amount: "500.00", currency: "EUR" },
        network: {
          status: "confirmed",
          network_name: "base",
          transaction_fee: { amount: "0.10000000", currency: "HYPE" },
        },
        created_at: "2025-05-01T10:00:00.000Z",
        resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-btc-with-hype-fee",
      },
    }),
  ] as const

let activeSyncRecords: ReadonlyArray<ProviderRawRecord> = defaultSyncRecords
let activeFiatCurrencies: ReadonlyArray<CoinbaseFiatCurrencyRecord> = defaultFiatCurrencies
let activeCryptoCurrencies: ReadonlyArray<CoinbaseCryptoCurrencyRecord> = defaultCryptoCurrencies
let remoteReferenceCatalogAvailable = true

const CoinbaseSyncClientTestLive = Layer.succeed(CoinbaseSyncClient, {
  fetchAccountsPage: () =>
    Effect.succeed({
      records: activeSyncRecords
        .filter((record) => record.recordType === "coinbase_account")
        .map((record) => ({
          id: record.externalRecordId,
          occurredAt: record.occurredAt,
          payload: record.payload,
        })),
      nextCursor: null,
    }),
  fetchTransactionsPage: ({ accountId }) =>
    Effect.succeed({
      records: activeSyncRecords
        .filter((record) => record.recordType === "coinbase_transaction")
        .map((record) => ({
          id: record.externalRecordId,
          accountId: record.externalAccountId ?? accountId,
          parentId: record.externalParentId,
          occurredAt: record.occurredAt,
          payload: record.payload,
        })),
      nextCursor: null,
    }),
  fetchFiatCurrencies: Effect.suspend(() =>
    remoteReferenceCatalogAvailable
      ? Effect.succeed(activeFiatCurrencies)
      : Effect.die("Remote fiat reference catalog should not be called during replay")
  ),
  fetchCryptoCurrencies: Effect.suspend(() =>
    remoteReferenceCatalogAvailable
      ? Effect.succeed(activeCryptoCurrencies)
      : Effect.die("Remote crypto reference catalog should not be called during replay")
  ),
})

const CoinbaseReferenceMappingWithDepsLive = CoinbaseReferenceMappingServiceLive.pipe(
  Layer.provide(ProviderAssetRepositoryLive),
  Layer.provide(ProviderReferenceRepositoryLive),
  Layer.provide(AssetRepositoryLive)
)

const CoinbaseReferenceDataWithDepsLive = CoinbaseReferenceDataServiceLive.pipe(
  Layer.provideMerge(CoinbaseSyncClientTestLive),
  Layer.provide(CoinbaseReferenceMappingWithDepsLive),
  Layer.provide(ProviderAssetRepositoryLive),
  Layer.provide(ProviderReferenceRepositoryLive)
)

const CoinbaseSourceSyncProviderWithDepsLive = CoinbaseSourceSyncProviderLive.pipe(
  Layer.provide(CoinbaseRecordNormalizerLive),
  Layer.provide(CoinbaseLegDerivationServiceLive),
  Layer.provide(CoinbaseReferenceDataWithDepsLive),
  Layer.provide(CoinbaseReferenceMappingWithDepsLive),
  Layer.provide(CoinbaseSyncClientTestLive),
  Layer.provide(AssetRepositoryLive)
)

const SourceSyncJobExecutorTestLive = SourceSyncJobExecutorLive.pipe(
  Layer.provide(TransferReconciliationServiceLive),
  Layer.provide(
    SourceProviderRegistryLive.pipe(
      Layer.provide(CoinbaseSourceSyncProviderWithDepsLive),
      Layer.provide(HeliusSolanaSourceSyncProviderLive)
    )
  ),
  Layer.provide(CoinbaseSourceSyncProviderWithDepsLive)
)

const SourceSyncLayer = SourceSyncServiceLive.pipe(
  Layer.provide(SourceSyncQueueInlineExecutorTestLive),
  Layer.provide(SourceSyncJobExecutorTestLive)
)

const TestLayer = SourceSyncLayer.pipe(
  Layer.provideMerge(CoinbaseSourceSyncProviderWithDepsLive),
  Layer.provideMerge(RepositoriesLive),
  Layer.provideMerge(TestPgClientLive)
)

const userId = "00000000-0000-4000-8000-000000000101"
const principalId = "00000000-0000-4000-8000-000000000102"
const sourceId = "00000000-0000-0000-0000-000000000201"
const DUAL_FEE_RAW_RECORD_ID = "00000000-0000-4000-8000-000000000546"
const DUAL_FEE_FIRST_PROVIDER_ASSET_ROW_ID = "00000000-0000-4000-8000-000000000547"
const DUAL_FEE_SECOND_PROVIDER_ASSET_ROW_ID = "00000000-0000-4000-8000-000000000548"
const DUAL_FEE_OCCURRED_AT = DateTime.toDateUtc(DateTime.makeUnsafe("2025-06-03T10:00:00.000Z"))
const DUAL_FEE_PAYLOAD = {
  id: "tx-dual-same-currency-fee",
  type: "advanced_trade_fill",
  status: "completed",
  amount: { amount: "-0.40000000", currency: "BTC" },
  native_amount: { amount: "-6000.00", currency: "EUR" },
  created_at: DUAL_FEE_OCCURRED_AT.toISOString(),
  resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-dual-same-currency-fee",
  network: {
    status: "confirmed",
    hash: "dual-same-currency-fee-hash",
    network_name: "bitcoin",
    transaction_fee: { amount: "0.00010000", currency: "BTC" },
  },
  advanced_trade_fill: {
    commission: { amount: "0.00020000", currency: "BTC" },
    fill_price: "15000.00",
    order_id: "dual-same-currency-fee-order",
    order_side: "sell",
    product_id: "BTC-EUR",
  },
} as const
const DUAL_FEE_RESOLVED_TRANSACTION_TYPE = {
  providerTransactionType: "advanced_trade_fill",
  transactionType: "sell_fiat",
  inventoryEffect: "disposal",
  taxTreatment: "taxable_by_default",
  resolutionStrategy: "venue_side",
  pairedRecordRequired: false,
  mappingStatus: "approved",
} as const
const seedCoinbaseSource = () =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* seedSyncEngineRepositoryFixture({
      userId,
      principalId,
      sourceId,
    })

    yield* db.insert(schema.assets).values([
      {
        id: BTC_ASSET_ID,
        name: "Bitcoin",
        symbol: "BTC",
        coingeckoCoinId: "bitcoin",
        type: "fungible",
      },
      {
        id: DOT_ASSET_ID,
        name: "Polkadot",
        symbol: "DOT",
        coingeckoCoinId: "polkadot",
        type: "fungible",
      },
    ])

    const [baseBlockchain] = yield* db
      .select({ id: schema.blockchains.id })
      .from(schema.blockchains)
      .where(eq(schema.blockchains.name, "base"))
      .limit(1)
    if (baseBlockchain === undefined) {
      return yield* Effect.die("Missing seeded base blockchain")
    }

    yield* db.insert(schema.assetRepresentations).values({
      id: BTC_BASE_REPRESENTATION_ID,
      assetId: BTC_ASSET_ID,
      blockchainId: baseBlockchain.id,
      type: "native",
      decimals: 8,
    })
  }).pipe(Effect.provide(TestPgClientLive))

const runSync = () =>
  Effect.gen(function* () {
    const sourceSync = yield* SourceSyncService
    return yield* sourceSync.startSourceSyncJob({
      principalId,
      sourceId,
    })
  }).pipe(Effect.provide(TestLayer))

const fetchJobDetails = ({ jobId }: { readonly jobId: string }) =>
  Effect.gen(function* () {
    const sourceSync = yield* SourceSyncService
    return yield* sourceSync.getSourceSyncJob({
      principalId,
      sourceId,
      jobId,
    })
  }).pipe(Effect.provide(TestLayer))

const replaySource = () =>
  Effect.gen(function* () {
    const sourceSync = yield* SourceSyncService
    const summary = yield* sourceSync.replaySourceSyncJob({
      principalId,
      sourceId,
    })
    return yield* sourceSync.getSourceSyncJob({
      principalId,
      sourceId,
      jobId: summary.jobId,
    })
  }).pipe(Effect.provide(TestLayer))

const dualFeeSourceRecord = (): SourceRawRecord => ({
  id: DUAL_FEE_RAW_RECORD_ID,
  sourceId,
  provider: "coinbase",
  recordType: "coinbase_transaction",
  externalAccountId: "coinbase-account-1",
  externalRecordId: DUAL_FEE_PAYLOAD.id,
  externalParentId: null,
  occurredAt: DUAL_FEE_OCCURRED_AT,
  payload: DUAL_FEE_PAYLOAD,
  importedAt: DUAL_FEE_OCCURRED_AT,
  normalizedAt: null,
  normalizationError: null,
  createdAt: DUAL_FEE_OCCURRED_AT,
  updatedAt: DUAL_FEE_OCCURRED_AT,
})

const seedDualFeeProviderRows = () =>
  Effect.gen(function* () {
    const db = yield* drizzle
    yield* db.insert(schema.providerAssets).values([
      {
        id: DUAL_FEE_FIRST_PROVIDER_ASSET_ROW_ID,
        provider: "coinbase",
        providerAssetId: "btc-dual-fee-a",
        currencyCode: "BTC",
        name: "Bitcoin dual fee A",
        exponent: 8,
        providerType: "crypto",
        rawProviderPayload: { row: "dual-fee-a" },
        retrievedAt: DUAL_FEE_OCCURRED_AT,
      },
      {
        id: DUAL_FEE_SECOND_PROVIDER_ASSET_ROW_ID,
        provider: "coinbase",
        providerAssetId: "btc-dual-fee-b",
        currencyCode: "BTC",
        name: "Bitcoin dual fee B",
        exponent: 8,
        providerType: "crypto",
        rawProviderPayload: { row: "dual-fee-b" },
        retrievedAt: DUAL_FEE_OCCURRED_AT,
      },
    ])
    yield* db.insert(schema.providerAssetMappings).values([
      {
        providerAssetRowId: DUAL_FEE_FIRST_PROVIDER_ASSET_ROW_ID,
        mappingKind: "asset",
        canonicalAssetId: BTC_ASSET_ID,
        mappingStatus: "approved",
      },
      {
        providerAssetRowId: DUAL_FEE_SECOND_PROVIDER_ASSET_ROW_ID,
        mappingKind: "asset",
        canonicalAssetId: DOT_ASSET_ID,
        mappingStatus: "approved",
      },
    ])
    yield* db.insert(schema.sourceRecordsRaw).values({
      id: DUAL_FEE_RAW_RECORD_ID,
      sourceId,
      provider: "coinbase",
      recordType: "coinbase_transaction",
      externalAccountId: "coinbase-account-1",
      externalRecordId: DUAL_FEE_PAYLOAD.id,
      externalParentId: null,
      occurredAt: DUAL_FEE_OCCURRED_AT,
      payload: DUAL_FEE_PAYLOAD,
      importedAt: DUAL_FEE_OCCURRED_AT,
      createdAt: DUAL_FEE_OCCURRED_AT,
      updatedAt: DUAL_FEE_OCCURRED_AT,
    })
  }).pipe(Effect.provide(TestPgClientLive))

const normalizeDualFeeRecord = () =>
  Effect.gen(function* () {
    const resolutions = [
      {
        assetId: BTC_ASSET_ID,
        providerAssetRowId: DUAL_FEE_FIRST_PROVIDER_ASSET_ROW_ID,
      },
      {
        assetId: DOT_ASSET_ID,
        providerAssetRowId: DUAL_FEE_SECOND_PROVIDER_ASSET_ROW_ID,
      },
    ] as const
    let resolutionIndex = 0
    const normalizer = yield* CoinbaseRecordNormalizer
    return yield* normalizer.normalize({
      source: {
        id: sourceId,
        principalId,
        providerKey: "coinbase",
        cexAccountId: null,
        addressId: null,
        walletAddress: null,
      },
      sourceRecord: dualFeeSourceRecord(),
      resolveAsset: () =>
        Effect.gen(function* () {
          const resolution = resolutions[resolutionIndex]
          resolutionIndex += 1
          if (resolution === undefined) {
            return yield* Effect.die("Unexpected extra Coinbase fee asset resolution")
          }
          return {
            assetId: Option.some(resolution.assetId),
            providerAssetRowId: resolution.providerAssetRowId,
          }
        }),
      resolveBlockchainId: () => Option.none(),
    })
  }).pipe(Effect.provide(CoinbaseRecordNormalizerLive))

const persistDualFeeNormalization = (normalized: CoinbaseRecordNormalizationResult) =>
  Effect.gen(function* () {
    const provider = yield* CoinbaseSourceSyncProvider
    const repository = yield* SourceNormalizationRepository
    return yield* repository.persistNormalizedArtifacts({
      transaction: {
        ...normalized.transaction,
        transactionType: DUAL_FEE_RESOLVED_TRANSACTION_TYPE.transactionType,
        metadata: {
          provider: "coinbase",
          amount: DUAL_FEE_PAYLOAD.amount,
          nativeAmount: DUAL_FEE_PAYLOAD.native_amount,
          network: DUAL_FEE_PAYLOAD.network,
          from: null,
          to: null,
          coinbaseReferenceMapping: DUAL_FEE_RESOLVED_TRANSACTION_TYPE,
        },
      },
      venueContext: normalized.venueContext,
      providerTransfers: normalized.providerTransfers,
      canonicalTransfers: normalized.canonicalTransfers,
      providerAssetRowIds: [
        DUAL_FEE_FIRST_PROVIDER_ASSET_ROW_ID,
        DUAL_FEE_SECOND_PROVIDER_ASSET_ROW_ID,
      ],
      transactionReview: null,
      resolvedTransactionType: DUAL_FEE_RESOLVED_TRANSACTION_TYPE,
      deriveLegs: ({ transaction, venueContext, canonicalTransfers, withholdAccountingFacts }) =>
        Effect.gen(function* () {
          const legDerivation = yield* provider.deriveLegs({
            transaction,
            venueContext,
            primaryAsset: null,
            primaryProviderTransferId: null,
            canonicalTransfers,
            deriveMainLeg: false,
          })
          if (legDerivation._tag === "withheld") {
            withholdAccountingFacts(legDerivation.reason)
            return []
          }
          return legDerivation.legs
        }),
    })
  }).pipe(Effect.provide(TestLayer))

const loadDualFeeAssetPairs = () =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const storedFeeLegs = yield* db
      .select({
        assetId: schema.transactionLegs.assetId,
        providerAssetRowId: schema.transactionLegs.providerAssetRowId,
      })
      .from(schema.transactionLegs)
      .where(
        inArray(schema.transactionLegs.externalId, [
          `${DUAL_FEE_PAYLOAD.id}:network_fee:fee_leg`,
          `${DUAL_FEE_PAYLOAD.id}:commission:fee_leg`,
        ])
      )
    return storedFeeLegs
  }).pipe(Effect.provide(TestPgClientLive))

const prepareLegacyProviderOverrideReplay = () =>
  Effect.gen(function* () {
    const db = yield* drizzle
    yield* db.insert(schema.assets).values({
      id: PROVIDER_OVERRIDE_ASSET_ID,
      name: "Principal Coinbase selection",
      symbol: "CB-SELECTED",
      type: "fungible",
    })
    const [providerAsset] = yield* db
      .select({
        id: schema.providerAssets.id,
        rawProviderPayload: schema.providerAssets.rawProviderPayload,
      })
      .from(schema.providerAssets)
      .where(
        and(
          eq(schema.providerAssets.provider, "coinbase"),
          eq(schema.providerAssets.providerAssetId, "btc-provider-asset")
        )
      )
      .limit(1)
    if (providerAsset === undefined) {
      return yield* Effect.die("Missing Coinbase BTC provider asset")
    }
    const [mapping] = yield* db
      .select({
        canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
        assetRepresentationId: schema.providerAssetMappings.assetRepresentationId,
        mappingStatus: schema.providerAssetMappings.mappingStatus,
      })
      .from(schema.providerAssetMappings)
      .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAsset.id))
      .limit(1)
    const [historicalMainLeg] = yield* db
      .select({ id: schema.transactionLegs.id })
      .from(schema.transactionLegs)
      .where(eq(schema.transactionLegs.externalId, "tx-buy-1:main"))
      .limit(1)
    if (historicalMainLeg === undefined) {
      return yield* Effect.die("Missing historical Coinbase main leg")
    }
    yield* db
      .update(schema.transactionLegs)
      .set({ metadata: { legacyWithoutProviderAssetRowId: true } })
      .where(
        inArray(schema.transactionLegs.externalId, [
          "tx-buy-1:main",
          "tx-send-1:network_fee:fee_leg",
        ])
      )
    return { providerAsset, mapping, historicalMainLeg }
  }).pipe(Effect.provide(TestPgClientLive))

const createProviderIdentityOverride = ({
  providerAssetRowId,
}: {
  readonly providerAssetRowId: string
}) =>
  Effect.gen(function* () {
    const repository = yield* PrincipalAssetOverrideRepository
    const target = {
      _tag: "provider_asset" as const,
      providerAssetRowId,
    }
    const projection = Option.getOrThrow(
      yield* repository.findProjection({
        principalId: PrincipalId.make(principalId),
        target,
      })
    )
    return Option.getOrThrow(
      yield* repository.create({
        actorUserId: AuthUserId.make(userId),
        expectedSystemRevision: projection.system.identityRevision,
        principalId: PrincipalId.make(principalId),
        reason: "Use the selected economic asset for chainless Coinbase BTC rows",
        replacement: { _tag: "identity", assetId: PROVIDER_OVERRIDE_ASSET_ID },
        target,
      })
    )
  }).pipe(Effect.provide(TestLayer))

const createProviderInclusionOverride = ({
  providerAssetRowId,
}: {
  readonly providerAssetRowId: string
}) =>
  Effect.gen(function* () {
    const repository = yield* PrincipalAssetOverrideRepository
    const target = {
      _tag: "provider_asset" as const,
      providerAssetRowId,
    }
    const projection = Option.getOrThrow(
      yield* repository.findProjection({
        principalId: PrincipalId.make(principalId),
        target,
      })
    )
    return Option.getOrThrow(
      yield* repository.create({
        actorUserId: AuthUserId.make(userId),
        expectedSystemRevision: projection.system.inclusionRevision,
        principalId: PrincipalId.make(principalId),
        reason: "Include this sound Coinbase provider asset for the principal",
        replacement: { _tag: "inclusion", inclusion: "included" },
        target,
      })
    )
  }).pipe(Effect.provide(TestLayer))

const loadProviderOverrideApplicationSources = (overrideId: string) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    return yield* db
      .select({ sourceId: schema.principalAssetOverrideApplications.sourceId })
      .from(schema.principalAssetOverrideApplications)
      .where(eq(schema.principalAssetOverrideApplications.overrideId, overrideId))
  }).pipe(Effect.provide(TestPgClientLive))

const loadProviderOverrideLegs = () =>
  Effect.gen(function* () {
    const db = yield* drizzle
    return yield* db
      .select({
        id: schema.transactionLegs.id,
        externalId: schema.transactionLegs.externalId,
        assetId: schema.transactionLegs.assetId,
        providerAssetRowId: schema.transactionLegs.providerAssetRowId,
      })
      .from(schema.transactionLegs)
      .where(eq(schema.transactionLegs.sourceId, sourceId))
  }).pipe(Effect.provide(TestPgClientLive))

const useFutureProviderOverrideSyncRecord = () => {
  remoteReferenceCatalogAvailable = true
  activeSyncRecords = [
    defaultSyncRecords[0],
    makeCoinbaseRecord({
      externalRecordId: "tx-buy-after-provider-override",
      occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-06-01T10:00:00.000Z")),
      payload: {
        id: "tx-buy-after-provider-override",
        type: "buy",
        status: "completed",
        amount: { amount: "0.25000000", currency: "BTC" },
        native_amount: { amount: "2500.00", currency: "EUR" },
        created_at: "2025-06-01T10:00:00.000Z",
        resource_path:
          "/v2/accounts/coinbase-account-1/transactions/tx-buy-after-provider-override",
      },
    }),
    ...defaultSyncRecords.slice(1),
  ]
}

const loadFutureProviderOverrideState = (providerAssetRowId: string) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [futureLeg] = yield* db
      .select({
        assetId: schema.transactionLegs.assetId,
        providerAssetRowId: schema.transactionLegs.providerAssetRowId,
      })
      .from(schema.transactionLegs)
      .where(eq(schema.transactionLegs.externalId, "tx-buy-after-provider-override:main"))
      .limit(1)
    const [providerAsset] = yield* db
      .select({ rawProviderPayload: schema.providerAssets.rawProviderPayload })
      .from(schema.providerAssets)
      .where(eq(schema.providerAssets.id, providerAssetRowId))
      .limit(1)
    const [mapping] = yield* db
      .select({
        canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
        assetRepresentationId: schema.providerAssetMappings.assetRepresentationId,
        mappingStatus: schema.providerAssetMappings.mappingStatus,
      })
      .from(schema.providerAssetMappings)
      .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAssetRowId))
      .limit(1)
    return { futureLeg, providerAsset, mapping }
  }).pipe(Effect.provide(TestPgClientLive))

const fetchProviderTransferState = () =>
  Effect.gen(function* () {
    const db = yield* drizzle

    const providerTransferRows = yield* db
      .select({
        id: schema.providerTransfers.id,
        externalId: schema.providerTransfers.externalId,
        direction: schema.providerTransfers.direction,
        amount: schema.providerTransfers.amount,
      })
      .from(schema.providerTransfers)
      .where(eq(schema.providerTransfers.sourceId, sourceId))

    const inventoryMovements = yield* db
      .select({
        providerTransferId: schema.inventoryMovements.providerTransferId,
        assetId: schema.inventoryMovements.assetId,
        direction: schema.inventoryMovements.direction,
        amount: schema.inventoryMovements.amount,
      })
      .from(schema.inventoryMovements)
      .where(eq(schema.inventoryMovements.sourceId, sourceId))

    return {
      providerTransferRows,
      inventoryMovements,
    }
  }).pipe(Effect.provide(TestPgClientLive))

const fetchCounts = () =>
  Effect.gen(function* () {
    const db = yield* drizzle

    const rawRows = yield* db
      .select({
        id: schema.sourceRecordsRaw.id,
        externalRecordId: schema.sourceRecordsRaw.externalRecordId,
        normalizedAt: schema.sourceRecordsRaw.normalizedAt,
        normalizationError: schema.sourceRecordsRaw.normalizationError,
      })
      .from(schema.sourceRecordsRaw)
      .where(eq(schema.sourceRecordsRaw.sourceId, sourceId))

    const transactions = yield* db
      .select({
        id: schema.transactions.id,
        externalId: schema.transactions.externalId,
        transactionType: schema.transactions.transactionType,
        providerStatus: schema.transactions.providerStatus,
      })
      .from(schema.transactions)
      .where(eq(schema.transactions.sourceId, sourceId))

    const venueContexts = yield* db
      .select({ transactionId: schema.transactionVenueContext.transactionId })
      .from(schema.transactionVenueContext)

    const transactionReviews = yield* db
      .select({
        transactionId: schema.transactionReviews.transactionId,
        reviewStatus: schema.transactionReviews.reviewStatus,
        needsReview: schema.transactionReviews.needsReview,
        originalTypeKey: schema.transactionReviews.originalTypeKey,
        currentTypeKey: schema.transactionReviews.currentTypeKey,
        categorizationReason: schema.transactionReviews.categorizationReason,
        matchedLayer: schema.transactionReviews.matchedLayer,
      })
      .from(schema.transactionReviews)

    const transfers = yield* db
      .select({
        externalId: schema.transfers.externalId,
      })
      .from(schema.transfers)
      .where(eq(schema.transfers.sourceId, sourceId))

    const legs = yield* db
      .select({
        kind: schema.transactionLegs.kind,
        derivationRule: schema.transactionLegs.derivationRule,
      })
      .from(schema.transactionLegs)
      .where(eq(schema.transactionLegs.sourceId, sourceId))

    const transactionTypeCatalogRows = yield* db
      .select({
        providerTransactionType: schema.providerTransactionTypeCatalog.providerTransactionType,
      })
      .from(schema.providerTransactionTypeCatalog)
      .where(eq(schema.providerTransactionTypeCatalog.provider, "coinbase"))

    const providerAssetRows = yield* db
      .select({ currencyCode: schema.providerAssets.currencyCode })
      .from(schema.providerAssets)
      .where(eq(schema.providerAssets.provider, "coinbase"))

    return {
      rawRows,
      transactions,
      transactionReviews,
      transactionCount: transactions.length,
      venueContextCount: venueContexts.length,
      transfers,
      legs,
      transactionTypeCatalogCount: transactionTypeCatalogRows.length,
      providerAssetCatalogCount: providerAssetRows.length,
    }
  }).pipe(Effect.provide(TestPgClientLive))

const fetchProviderAssetState = ({ currencyCode }: { readonly currencyCode: string }) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    const [providerAsset] = yield* db
      .select({
        id: schema.providerAssets.id,
        providerAssetId: schema.providerAssets.providerAssetId,
        currencyCode: schema.providerAssets.currencyCode,
        providerType: schema.providerAssets.providerType,
      })
      .from(schema.providerAssets)
      .where(
        and(
          eq(schema.providerAssets.provider, "coinbase"),
          eq(schema.providerAssets.currencyCode, currencyCode.toUpperCase())
        )
      )
      .limit(1)

    const [mapping] =
      providerAsset === undefined
        ? [undefined]
        : yield* db
            .select({
              mappingStatus: schema.providerAssetMappings.mappingStatus,
              mappingKind: schema.providerAssetMappings.mappingKind,
              canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
              assetRepresentationId: schema.providerAssetMappings.assetRepresentationId,
            })
            .from(schema.providerAssetMappings)
            .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAsset.id))
            .limit(1)

    return {
      providerAsset,
      mapping: mapping ?? null,
    }
  }).pipe(Effect.provide(TestPgClientLive))

const seedPendingProviderAssetMapping = ({
  currencyCode,
  providerAssetId,
  providerType,
}: {
  readonly currencyCode: string
  readonly providerAssetId: string
  readonly providerType: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const now = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-15T10:00:00.000Z"))

    const [providerAsset] = yield* db
      .insert(schema.providerAssets)
      .values({
        provider: "coinbase",
        providerAssetId,
        naturalKey: null,
        currencyCode,
        name: currencyCode,
        exponent: 8,
        providerType,
        rawProviderPayload: {
          code: currencyCode,
          type: providerType,
          asset_id: providerAssetId,
        },
        discoveredAt: now,
        retrievedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({
        id: schema.providerAssets.id,
      })

    if (providerAsset === undefined) {
      return yield* Effect.die("Failed to seed provider asset fixture")
    }

    yield* db.insert(schema.providerAssetMappings).values({
      providerAssetRowId: providerAsset.id,
      mappingKind: "asset",
      canonicalAssetId: null,
      assetRepresentationId: null,
      canonicalFiatCurrency: null,
      mappingStatus: "pending_review",
      reviewerNotes: "Fixture pending provider asset review",
      sourceNotes: "Fixture pending provider asset review",
      createdAt: now,
      updatedAt: now,
    })
  }).pipe(Effect.provide(TestPgClientLive))

const seedCanonicalAsset = ({ symbol }: { readonly symbol: string }) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [asset] = yield* db
      .insert(schema.assets)
      .values({
        name: `${symbol} Test Asset`,
        symbol,
        type: "fungible",
      })
      .returning({ id: schema.assets.id })

    if (asset === undefined) {
      return yield* Effect.die(`Failed to seed ${symbol} canonical asset fixture`)
    }

    return asset.id
  }).pipe(Effect.provide(TestPgClientLive))

const approveProviderAssetMappingToCanonicalAsset = ({
  currencyCode,
  canonicalAssetId,
  assetRepresentationId,
}: {
  readonly currencyCode: string
  readonly canonicalAssetId: string | null
  readonly assetRepresentationId: string | null
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const now = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-16T10:00:00.000Z"))
    const [providerAsset] = yield* db
      .select({ id: schema.providerAssets.id })
      .from(schema.providerAssets)
      .where(
        and(
          eq(schema.providerAssets.provider, "coinbase"),
          eq(schema.providerAssets.currencyCode, currencyCode.toUpperCase())
        )
      )
      .limit(1)

    if (providerAsset === undefined) {
      return yield* Effect.die(
        `Missing ${currencyCode} provider asset fixture for mapping approval`
      )
    }

    yield* db
      .update(schema.providerAssetMappings)
      .set({
        mappingKind: "asset",
        canonicalAssetId,
        assetRepresentationId,
        canonicalFiatCurrency: null,
        mappingStatus: "approved",
        reviewerNotes: "Approved after provider asset repair",
        sourceNotes: "Approved after provider asset repair",
        updatedAt: now,
      })
      .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAsset.id))
  }).pipe(Effect.provide(TestPgClientLive))

const excludeProviderAssetMapping = ({ currencyCode }: { readonly currencyCode: string }) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [providerAsset] = yield* db
      .select({ id: schema.providerAssets.id })
      .from(schema.providerAssets)
      .where(
        and(
          eq(schema.providerAssets.provider, "coinbase"),
          eq(schema.providerAssets.currencyCode, currencyCode.toUpperCase())
        )
      )
      .limit(1)

    if (providerAsset === undefined) {
      return yield* Effect.die(`Missing ${currencyCode} provider asset fixture for exclusion`)
    }

    yield* db
      .update(schema.providerAssetMappings)
      .set({
        mappingStatus: "excluded",
        canonicalAssetId: null,
        assetRepresentationId: null,
        canonicalFiatCurrency: null,
        reviewerNotes: "Excluded by administrator",
        sourceNotes: "Settled exclusion fixture",
      })
      .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAsset.id))
  }).pipe(Effect.provide(TestPgClientLive))

await Effect.runPromise(recreateTestDatabase())

describe("coinbase normalization persistence", () => {
  beforeEach(() =>
    Effect.gen(function* () {
      activeSyncRecords = defaultSyncRecords
      activeFiatCurrencies = defaultFiatCurrencies
      activeCryptoCurrencies = defaultCryptoCurrencies
      remoteReferenceCatalogAvailable = true
      yield* recreateTestDatabase()
      yield* seedCoinbaseSource()
    }).pipe(Effect.runPromise)
  )

  it.effect(
    "persists zero, pending, and failed Coinbase tx rows for review without inventory legs",
    () =>
      Effect.gen(function* () {
        activeSyncRecords = [
          makeCoinbaseRecord({
            recordType: "coinbase_account",
            externalRecordId: "coinbase-account-1",
            occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
            payload: {
              id: "coinbase-account-1",
              created_at: "2025-01-01T00:00:00.000Z",
              updated_at: "2025-01-01T00:00:00.000Z",
            },
          }),
          ...(["completed", "pending", "failed"] as const).map((status, index) =>
            makeCoinbaseRecord({
              externalRecordId: `tx-${status}-without-inventory`,
              occurredAt: DateTime.toDateUtc(
                DateTime.makeUnsafe(`2025-01-0${index + 2}T10:00:00.000Z`)
              ),
              payload: {
                id: `tx-${status}-without-inventory`,
                type: "tx",
                status,
                amount: {
                  amount: status === "completed" ? "0.00000000" : "0.40000000",
                  currency: "BTC",
                },
                native_amount: {
                  amount: status === "completed" ? "0.00" : "4000.00",
                  currency: "EUR",
                },
                network: {
                  status: "confirmed",
                  network_name: "base",
                  transaction_fee: { amount: "0.10000000", currency: "HYPE" },
                },
                created_at: `2025-01-0${index + 2}T10:00:00.000Z`,
                resource_path: `/v2/accounts/coinbase-account-1/transactions/tx-${status}-without-inventory`,
                description: `Uncategorized ${status} row`,
              },
            })
          ),
        ]

        yield* Effect.gen(function* () {
          activeCryptoCurrencies = [...defaultCryptoCurrencies, hypeCryptoCurrency]
          yield* seedPendingProviderAssetMapping({
            currencyCode: "HYPE",
            providerAssetId: "hype-provider-asset",
            providerType: "crypto",
          })
          yield* excludeProviderAssetMapping({ currencyCode: "HYPE" })
          yield* runSync()
          const state = yield* fetchCounts()

          expect(state.rawRows.every((row) => row.normalizedAt !== null)).toBe(true)
          expect(state.rawRows.every((row) => row.normalizationError === null)).toBe(true)
          expect(
            state.transactions
              .map((row) => row.providerStatus)
              .sort((left, right) => (left ?? "").localeCompare(right ?? ""))
          ).toEqual(["completed", "failed", "pending"])
          expect(state.transactionReviews).toHaveLength(3)
          expect(state.transactionReviews.every((row) => row.needsReview)).toBe(true)
          expect(state.transfers).toEqual([])
          expect(state.legs).toHaveLength(0)
        })
      })
  )

  it.effect("clears resolved mapping review without reopening closed no-derivation rows", () =>
    Effect.gen(function* () {
      const account = makeCoinbaseRecord({
        recordType: "coinbase_account",
        externalRecordId: "coinbase-account-1",
        occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
        payload: {
          id: "coinbase-account-1",
          created_at: "2025-01-01T00:00:00.000Z",
          updated_at: "2025-01-01T00:00:00.000Z",
        },
      })
      activeSyncRecords = [
        account,
        ...(
          [
            { status: "completed", amount: "0.00000000" },
            { status: "pending", amount: "0.40000000" },
          ] as const
        ).map(({ status, amount }, index) =>
          makeCoinbaseRecord({
            externalRecordId: `tx-${status}-hype-no-derivation`,
            occurredAt: DateTime.toDateUtc(
              DateTime.makeUnsafe(`2025-01-0${index + 2}T10:00:00.000Z`)
            ),
            payload: {
              id: `tx-${status}-hype-no-derivation`,
              type: "tx",
              status,
              amount: { amount, currency: "HYPE" },
              native_amount: { amount: "4000.00", currency: "EUR" },
              created_at: `2025-01-0${index + 2}T10:00:00.000Z`,
              resource_path: `/v2/accounts/coinbase-account-1/transactions/tx-${status}-hype-no-derivation`,
            },
          })
        ),
      ]
      activeCryptoCurrencies = [...defaultCryptoCurrencies, hypeCryptoCurrency]
      yield* seedPendingProviderAssetMapping({
        currencyCode: "HYPE",
        providerAssetId: "hype-provider-asset",
        providerType: "crypto",
      })
      yield* runSync()

      const providerAsset = yield* Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .insert(schema.assets)
          .values({
            id: PROVIDER_OVERRIDE_ASSET_ID,
            name: "Principal HYPE selection",
            symbol: "HYPE-SELECTED",
            type: "fungible",
          })
          .onConflictDoNothing({ target: schema.assets.id })
        const [row] = yield* db
          .select({ id: schema.providerAssets.id })
          .from(schema.providerAssets)
          .where(
            and(
              eq(schema.providerAssets.provider, "coinbase"),
              eq(schema.providerAssets.currencyCode, "HYPE")
            )
          )
          .limit(1)
        if (row === undefined) return yield* Effect.die("Missing HYPE provider asset")
        return row
      }).pipe(Effect.provide(TestPgClientLive))

      yield* createProviderIdentityOverride({ providerAssetRowId: providerAsset.id })
      remoteReferenceCatalogAvailable = false
      const replay = yield* replaySource()
      const state = yield* fetchCounts()

      expect(replay.status).toBe("completed")
      expect(state.legs).toEqual([])
      expect(state.transfers).toEqual([])
      expect(state.transactionReviews).toHaveLength(2)
      expect(
        state.transactionReviews.every(
          ({ matchedLayer }) => matchedLayer?.includes("provider_asset_mapping") === false
        )
      ).toBe(true)
      const pendingTransaction = state.transactions.find(
        ({ externalId }) => externalId === "tx-pending-hype-no-derivation"
      )
      expect(
        state.transactionReviews.some(
          ({ transactionId }) => transactionId === pendingTransaction?.id
        )
      ).toBe(true)
    })
  )

  it.effect("persists a settled fiat Coinbase tx for review without an inventory leg", () =>
    Effect.gen(function* () {
      activeSyncRecords = [
        makeCoinbaseRecord({
          recordType: "coinbase_account",
          externalRecordId: "coinbase-account-1",
          occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
          payload: {
            id: "coinbase-account-1",
            created_at: "2025-01-01T00:00:00.000Z",
            updated_at: "2025-01-01T00:00:00.000Z",
          },
        }),
        makeCoinbaseRecord({
          externalRecordId: "tx-fiat-credit-1",
          occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T10:00:00.000Z")),
          payload: {
            id: "tx-fiat-credit-1",
            type: "tx",
            status: "completed",
            amount: { amount: "100.00", currency: "EUR" },
            native_amount: { amount: "100.00", currency: "EUR" },
            created_at: "2025-01-02T10:00:00.000Z",
            resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-fiat-credit-1",
            description: "Uncategorized fiat credit",
          },
        }),
      ]

      yield* Effect.gen(function* () {
        yield* runSync()
        const state = yield* fetchCounts()

        expect(state.rawRows.every((row) => row.normalizationError === null)).toBe(true)
        expect(state.transactions).toEqual([
          expect.objectContaining({
            externalId: "tx-fiat-credit-1",
            providerStatus: "completed",
          }),
        ])
        expect(state.transactionReviews).toEqual([
          expect.objectContaining({
            reviewStatus: "needs_review",
            needsReview: true,
            originalTypeKey: "uncategorized",
            currentTypeKey: "uncategorized",
          }),
        ])
        expect(state.legs).toHaveLength(0)
      })
    })
  )

  it.effect("persists normalized Coinbase artifacts idempotently across reruns", () =>
    Effect.asVoid(
      Effect.gen(function* () {
        yield* runSync()
        const firstRun = yield* fetchCounts()

        expect(firstRun.rawRows).toHaveLength(5)
        expect(firstRun.rawRows.every((row) => row.normalizedAt !== null)).toBe(true)
        expect(firstRun.rawRows.every((row) => row.normalizationError === null)).toBe(true)
        expect(firstRun.transactionCount).toBe(4)
        expect(
          firstRun.transactions
            .map((row) => row.transactionType)
            .sort((left, right) => (left ?? "").localeCompare(right ?? ""))
        ).toEqual(["buy_fiat", "internal_transfer", "sell_fiat", "staking_reward"])
        expect(firstRun.venueContextCount).toBe(4)
        expect(
          firstRun.transfers
            .map((row) => row.externalId)
            .sort((left, right) => (left ?? "").localeCompare(right ?? ""))
        ).toEqual(["tx-send-1:network_fee"])
        expect(firstRun.legs).toHaveLength(4)
        expect(firstRun.transactionReviews).toEqual([
          expect.objectContaining({
            reviewStatus: "needs_review",
            needsReview: true,
            originalTypeKey: "internal_transfer",
            currentTypeKey: "internal_transfer",
          }),
        ])
        expect(firstRun.transactionTypeCatalogCount).toBeGreaterThanOrEqual(29)
        expect(firstRun.providerAssetCatalogCount).toBeGreaterThanOrEqual(3)

        yield* runSync()
        const secondRun = yield* fetchCounts()

        expect(secondRun.transactionCount).toBe(firstRun.transactionCount)
        expect(secondRun.venueContextCount).toBe(firstRun.venueContextCount)
        expect(secondRun.transactionReviews).toHaveLength(firstRun.transactionReviews.length)
        expect(secondRun.transfers).toHaveLength(firstRun.transfers.length)
        expect(secondRun.legs).toHaveLength(firstRun.legs.length)
      })
    )
  )

  it.effect("carries the exact Coinbase provider asset row into main and fee legs", () =>
    Effect.gen(function* () {
      yield* runSync()

      const state = yield* Effect.gen(function* () {
        const db = yield* drizzle
        const [btcProviderAsset] = yield* db
          .select({ id: schema.providerAssets.id })
          .from(schema.providerAssets)
          .where(
            and(
              eq(schema.providerAssets.provider, "coinbase"),
              eq(schema.providerAssets.providerAssetId, "btc-provider-asset")
            )
          )
          .limit(1)
        if (btcProviderAsset === undefined) {
          return yield* Effect.die("Missing Coinbase BTC provider asset")
        }

        const legs = yield* db
          .select({
            externalId: schema.transactionLegs.externalId,
            sourceTransferId: schema.transactionLegs.sourceTransferId,
            providerAssetRowId: schema.transactionLegs.providerAssetRowId,
          })
          .from(schema.transactionLegs)
          .where(eq(schema.transactionLegs.sourceId, sourceId))

        return { btcProviderAsset, legs }
      }).pipe(Effect.provide(TestPgClientLive))

      const mainLeg = state.legs.find((leg) => leg.externalId === "tx-buy-1:main")
      const feeLeg = state.legs.find((leg) => leg.externalId === "tx-send-1:network_fee:fee_leg")
      expect(mainLeg?.sourceTransferId).toBeNull()
      expect(feeLeg?.sourceTransferId).not.toBeNull()
      expect(mainLeg?.providerAssetRowId).toBe(state.btcProviderAsset.id)
      expect(feeLeg?.providerAssetRowId).toBe(state.btcProviderAsset.id)
    })
  )

  it.effect("keeps the selected provider row when duplicate Coinbase currencies exist", () =>
    Effect.gen(function* () {
      yield* runSync()
      const duplicateProviderAssetRowId = "00000000-0000-4000-8000-000000000545"
      const farFuture = DateTime.toDateUtc(DateTime.makeUnsafe("2099-01-01T00:00:00.000Z"))
      yield* Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.providerAssets).values({
          id: duplicateProviderAssetRowId,
          provider: "coinbase",
          providerAssetId: "btc-duplicate-provider-asset",
          currencyCode: "BTC",
          name: "Bitcoin duplicate observation",
          exponent: 8,
          providerType: "crypto",
          rawProviderPayload: { row: "duplicate-btc" },
          retrievedAt: farFuture,
        })
        yield* db.insert(schema.providerAssetMappings).values({
          providerAssetRowId: duplicateProviderAssetRowId,
          mappingKind: "asset",
          canonicalAssetId: DOT_ASSET_ID,
          mappingStatus: "approved",
        })
      }).pipe(Effect.provide(TestPgClientLive))

      activeSyncRecords = [
        defaultSyncRecords[0],
        makeCoinbaseRecord({
          externalRecordId: "tx-buy-duplicate-btc-row",
          occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-06-02T10:00:00.000Z")),
          payload: {
            id: "tx-buy-duplicate-btc-row",
            type: "buy",
            status: "completed",
            amount: { amount: "0.50000000", currency: "BTC" },
            native_amount: { amount: "5000.00", currency: "EUR" },
            created_at: "2025-06-02T10:00:00.000Z",
            resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-buy-duplicate-btc-row",
          },
        }),
        ...defaultSyncRecords.slice(1),
      ]
      yield* runSync()

      const [leg] = yield* Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({
            assetId: schema.transactionLegs.assetId,
            providerAssetRowId: schema.transactionLegs.providerAssetRowId,
          })
          .from(schema.transactionLegs)
          .where(eq(schema.transactionLegs.externalId, "tx-buy-duplicate-btc-row:main"))
          .limit(1)
      }).pipe(Effect.provide(TestPgClientLive))
      expect(leg?.assetId).toBe(DOT_ASSET_ID)
      expect(leg?.providerAssetRowId).toBe(duplicateProviderAssetRowId)
    })
  )

  it.effect("persists each same-currency fee with its resolved provider row", () =>
    Effect.gen(function* () {
      yield* seedDualFeeProviderRows()
      const normalized = yield* normalizeDualFeeRecord()
      yield* persistDualFeeNormalization(normalized)
      const pairs = yield* loadDualFeeAssetPairs()

      expect(pairs).toEqual(
        expect.arrayContaining([
          {
            assetId: BTC_ASSET_ID,
            providerAssetRowId: DUAL_FEE_FIRST_PROVIDER_ASSET_ROW_ID,
          },
          {
            assetId: DOT_ASSET_ID,
            providerAssetRowId: DUAL_FEE_SECOND_PROVIDER_ASSET_ROW_ID,
          },
        ])
      )
    })
  )

  it.effect(
    "replays historical Coinbase legs and applies the provider override to later rows",
    () =>
      Effect.gen(function* () {
        yield* runSync()
        const before = yield* prepareLegacyProviderOverrideReplay()
        const created = yield* createProviderIdentityOverride({
          providerAssetRowId: before.providerAsset.id,
        })
        const overrideId = created.activeIdentityOverride?.id
        if (overrideId === undefined) {
          return yield* Effect.die("Created provider identity override has no active record")
        }

        expect(created.recomputation.status).toBe("updating")
        expect(yield* loadProviderOverrideApplicationSources(overrideId)).toEqual([{ sourceId }])

        remoteReferenceCatalogAvailable = false
        const replay = yield* replaySource()
        const replayed = yield* loadProviderOverrideLegs()
        const historicalMainLeg = replayed.find(({ externalId }) => externalId === "tx-buy-1:main")
        const historicalFeeLeg = replayed.find(
          ({ externalId }) => externalId === "tx-send-1:network_fee:fee_leg"
        )

        expect(replay.status).toBe("completed")
        expect(historicalMainLeg).toMatchObject({
          assetId: PROVIDER_OVERRIDE_ASSET_ID,
          providerAssetRowId: before.providerAsset.id,
        })
        expect(historicalMainLeg?.id).not.toBe(before.historicalMainLeg.id)
        expect(historicalFeeLeg).toMatchObject({
          assetId: PROVIDER_OVERRIDE_ASSET_ID,
          providerAssetRowId: before.providerAsset.id,
        })

        useFutureProviderOverrideSyncRecord()
        yield* runSync()
        const after = yield* loadFutureProviderOverrideState(before.providerAsset.id)

        expect(after.futureLeg).toMatchObject({
          assetId: PROVIDER_OVERRIDE_ASSET_ID,
          providerAssetRowId: before.providerAsset.id,
        })
        expect(after.providerAsset?.rawProviderPayload).toEqual(
          before.providerAsset.rawProviderPayload
        )
        expect(after.mapping).toEqual(before.mapping)
      })
  )

  it.effect("does not mark approved fiat primary currency mappings as unresolved assets", () =>
    Effect.gen(function* () {
      activeSyncRecords = [
        makeCoinbaseRecord({
          recordType: "coinbase_account",
          externalRecordId: "coinbase-account-1",
          occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
          payload: {
            id: "coinbase-account-1",
            created_at: "2025-01-01T00:00:00.000Z",
            updated_at: "2025-01-01T00:00:00.000Z",
          },
        }),
        makeCoinbaseRecord({
          externalRecordId: "tx-fiat-deposit-1",
          occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T10:00:00.000Z")),
          payload: {
            id: "tx-fiat-deposit-1",
            type: "fiat_deposit",
            status: "completed",
            amount: { amount: "1000.00", currency: "EUR" },
            native_amount: { amount: "1000.00", currency: "EUR" },
            created_at: "2025-01-02T10:00:00.000Z",
            resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-fiat-deposit-1",
            description: "Fiat deposit",
          },
        }),
      ]

      yield* Effect.gen(function* () {
        yield* runSync()
        const state = yield* fetchCounts()

        expect(state.rawRows).toHaveLength(2)
        expect(state.rawRows.every((row) => row.normalizedAt !== null)).toBe(true)
        expect(state.rawRows.every((row) => row.normalizationError === null)).toBe(true)
        expect(state.transactions).toEqual([
          expect.objectContaining({
            externalId: "tx-fiat-deposit-1",
            transactionType: "internal_transfer",
          }),
        ])
        expect(state.transactionReviews).toHaveLength(0)
        expect(state.legs).toHaveLength(0)
      })
    })
  )

  it.effect("treats a positive-amount Coinbase send as an inbound factual movement", () =>
    Effect.gen(function* () {
      activeSyncRecords = [
        ...defaultSyncRecords,
        makeCoinbaseRecord({
          externalRecordId: "tx-deposit-send-1",
          occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-05-01T10:00:00.000Z")),
          payload: {
            id: "tx-deposit-send-1",
            type: "send",
            status: "completed",
            amount: { amount: "87.9500000000", currency: "DOT" },
            native_amount: { amount: "300.00", currency: "EUR" },
            created_at: "2025-05-01T10:00:00.000Z",
            resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-deposit-send-1",
            description: "Staked DOT moved into Coinbase",
            network: {
              status: "confirmed",
              hash: "tx-deposit-send-hash-1",
              network_name: "polkadot",
            },
            from: {
              address: "1exampledotorigin",
              resource: "address",
            },
          },
        }),
      ]

      yield* Effect.gen(function* () {
        yield* runSync()

        const state = yield* fetchProviderTransferState()

        const depositTransfer = state.providerTransferRows.find(
          (row) => row.externalId === "tx-deposit-send-1:principal"
        )
        expect(depositTransfer).toBeDefined()
        expect(depositTransfer?.direction).toBe("inbound")
        expectDecimalAmount(String(depositTransfer?.amount), "87.95")

        const withdrawalTransfer = state.providerTransferRows.find(
          (row) => row.externalId === "tx-send-1:principal"
        )
        expect(withdrawalTransfer?.direction).toBe("outbound")

        const depositMovement = state.inventoryMovements.find(
          (movement) => movement.providerTransferId === depositTransfer?.id
        )
        expect(depositMovement).toBeDefined()
        expect(depositMovement?.assetId).toBe(DOT_ASSET_ID)
        expect(depositMovement?.direction).toBe("inbound")
        expectDecimalAmount(String(depositMovement?.amount), "87.95")
        const replay = yield* replaySource()
        expect(replay.status).toBe("completed")

        const replayedState = yield* fetchProviderTransferState()
        const replayedDepositTransfer = replayedState.providerTransferRows.find(
          (row) => row.externalId === "tx-deposit-send-1:principal"
        )
        expect(replayedDepositTransfer?.direction).toBe("inbound")
        const replayedDepositMovement = replayedState.inventoryMovements.find(
          (movement) => movement.providerTransferId === replayedDepositTransfer?.id
        )
        expect(replayedDepositMovement?.direction).toBe("inbound")
        expectDecimalAmount(String(replayedDepositMovement?.amount), "87.95")
      })
    })
  )

  it.effect(
    "normalizes an unknown Coinbase provider asset into a reviewable partial transaction instead of failing",
    () =>
      Effect.gen(function* () {
        activeSyncRecords = makeHypeReviewableSyncRecords()
        activeCryptoCurrencies = [...defaultCryptoCurrencies, hypeCryptoCurrency]

        yield* Effect.gen(function* () {
          const summary = yield* runSync()
          const job = yield* fetchJobDetails({ jobId: summary.jobId })
          const counts = yield* fetchCounts()
          const providerAssetState = yield* fetchProviderAssetState({ currencyCode: "HYPE" })

          expect(job.status).toBe("completed")
          expect(job.normalizedRecords).toBe(2)
          expect(job.failedRecords).toBe(0)
          expect(
            counts.rawRows.find((row) => row.externalRecordId === "tx-hype-buy-1")?.normalizedAt
          ).not.toBeNull()
          expect(
            counts.rawRows.find((row) => row.externalRecordId === "tx-hype-buy-1")
              ?.normalizationError
          ).toBeNull()
          expect(counts.transactions).toEqual([
            expect.objectContaining({
              externalId: "tx-hype-buy-1",
              transactionType: "buy_fiat",
            }),
          ])
          expect(counts.venueContextCount).toBe(1)
          expect(counts.legs).toHaveLength(0)
          expect(counts.transactionReviews).toEqual([
            expect.objectContaining({
              reviewStatus: "needs_review",
              matchedLayer: expect.stringContaining("provider_asset_mapping"),
              needsReview: true,
              originalTypeKey: "buy_fiat",
              currentTypeKey: "buy_fiat",
              categorizationReason: expect.stringContaining("provider_asset_mapping"),
            }),
          ])
          expect(providerAssetState.providerAsset).toMatchObject({
            providerAssetId: "hype-provider-asset",
            currencyCode: "HYPE",
          })
          expect(providerAssetState.mapping).toMatchObject({
            mappingStatus: "pending_review",
            mappingKind: "asset",
            canonicalAssetId: null,
          })
        })
      })
  )

  it.effect("keeps a pending provider asset mapping on the reviewable normalization path", () =>
    Effect.gen(function* () {
      activeSyncRecords = makeHypeReviewableSyncRecords()
      activeCryptoCurrencies = [...defaultCryptoCurrencies, hypeCryptoCurrency]

      yield* Effect.gen(function* () {
        yield* seedPendingProviderAssetMapping({
          currencyCode: "HYPE",
          providerAssetId: "hype-provider-asset",
          providerType: "crypto",
        })

        const summary = yield* runSync()
        const job = yield* fetchJobDetails({ jobId: summary.jobId })
        const counts = yield* fetchCounts()
        const providerAssetState = yield* fetchProviderAssetState({ currencyCode: "HYPE" })

        expect(job.status).toBe("completed")
        expect(job.normalizedRecords).toBe(2)
        expect(job.failedRecords).toBe(0)
        expect(
          counts.rawRows.find((row) => row.externalRecordId === "tx-hype-buy-1")?.normalizationError
        ).toBeNull()
        expect(counts.transactions).toEqual([
          expect.objectContaining({
            externalId: "tx-hype-buy-1",
            transactionType: "buy_fiat",
          }),
        ])
        expect(counts.legs).toHaveLength(0)
        expect(counts.transactionReviews).toEqual([
          expect.objectContaining({
            matchedLayer: expect.stringContaining("provider_asset_mapping"),
            reviewStatus: "needs_review",
          }),
        ])
        expect(providerAssetState.mapping).toMatchObject({
          mappingStatus: "pending_review",
          mappingKind: "asset",
        })
      })
    })
  )

  it.effect("withholds the whole transaction when its primary provider asset is excluded", () =>
    Effect.gen(function* () {
      activeSyncRecords = makeHypeWithBtcFeeSyncRecords()
      activeCryptoCurrencies = [...defaultCryptoCurrencies, hypeCryptoCurrency]

      yield* Effect.gen(function* () {
        yield* seedPendingProviderAssetMapping({
          currencyCode: "HYPE",
          providerAssetId: "hype-provider-asset",
          providerType: "crypto",
        })
        yield* excludeProviderAssetMapping({ currencyCode: "HYPE" })

        const jobsBefore = yield* Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({ id: schema.assetResolutionJobs.id })
            .from(schema.assetResolutionJobs)
        }).pipe(Effect.provide(TestPgClientLive))
        yield* runSync()
        const counts = yield* fetchCounts()
        const providerAssetState = yield* fetchProviderAssetState({ currencyCode: "HYPE" })
        const resolutionJobsAfter = yield* Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({ id: schema.assetResolutionJobs.id })
            .from(schema.assetResolutionJobs)
        }).pipe(Effect.provide(TestPgClientLive))

        expect(
          counts.rawRows.find((row) => row.externalRecordId === "tx-hype-buy-with-btc-fee")
            ?.normalizationError
        ).toBeNull()
        expect(counts.transactions).toEqual([
          expect.objectContaining({ externalId: "tx-hype-buy-with-btc-fee" }),
        ])
        expect(counts.legs).toHaveLength(0)
        expect(
          counts.transactionReviews.some(
            (review) => review.matchedLayer?.includes("provider_asset_mapping") === true
          )
        ).toBe(false)
        expect(providerAssetState.mapping).toMatchObject({ mappingStatus: "excluded" })
        expect(resolutionJobsAfter).toHaveLength(jobsBefore.length + 1)

        const btcUsage = yield* Effect.gen(function* () {
          const db = yield* drizzle
          const [btcProviderAsset] = yield* db
            .select({
              id: schema.providerAssets.id,
              evidenceRevision: schema.providerAssets.evidenceRevision,
            })
            .from(schema.providerAssets)
            .where(
              and(
                eq(schema.providerAssets.provider, "coinbase"),
                eq(schema.providerAssets.currencyCode, "BTC")
              )
            )
            .limit(1)
          if (btcProviderAsset === undefined) {
            return yield* Effect.die("Missing BTC provider asset after fee normalization")
          }

          const uses = yield* db
            .select({ sourceId: schema.providerAssetSourceUses.sourceId })
            .from(schema.providerAssetSourceUses)
            .where(eq(schema.providerAssetSourceUses.providerAssetRowId, btcProviderAsset.id))

          return { btcProviderAsset, uses }
        }).pipe(Effect.provide(TestPgClientLive))

        expect(btcUsage.uses).toEqual([{ sourceId }])

        const exclusionFixture = yield* Effect.gen(function* () {
          const db = yield* drizzle
          const [decision] = yield* db
            .insert(schema.assetResolutionDecisions)
            .values({
              providerAssetRowId: btcUsage.btcProviderAsset.id,
              evidenceRevision: btcUsage.btcProviderAsset.evidenceRevision,
              policyRevision: "test:approved-fee",
              outcome: "attach",
              assetId: BTC_ASSET_ID,
              assetRepresentationId: null,
              actor: "policy:test:approved-fee",
            })
            .returning({ id: schema.assetResolutionDecisions.id })
          if (decision === undefined) {
            return yield* Effect.die("Failed to seed BTC fee decision")
          }
          const [evidence] = yield* db
            .insert(schema.assetResolutionEvidence)
            .values({
              decisionId: decision.id,
              authority: "provider",
              claimKind: "metadata",
              sourceLocator: "coinbase:currency:BTC",
              retrievedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-05-01T10:00:00.000Z")),
              evidenceRevision: btcUsage.btcProviderAsset.evidenceRevision,
              decodedClaim: { currencyCode: "BTC" },
              rawPayload: { currencyCode: "BTC" },
            })
            .returning({ id: schema.assetResolutionEvidence.id })
          if (evidence === undefined) {
            return yield* Effect.die("Failed to seed BTC fee evidence")
          }
          yield* db
            .insert(schema.assetResolutionCurrentState)
            .values({
              providerAssetRowId: btcUsage.btcProviderAsset.id,
              currentConclusionId: decision.id,
              currentPolicyEvaluationId: decision.id,
            })
            .onConflictDoUpdate({
              target: schema.assetResolutionCurrentState.providerAssetRowId,
              set: {
                currentConclusionId: decision.id,
                currentPolicyEvaluationId: decision.id,
              },
            })
          return { decisionId: decision.id, evidenceId: evidence.id }
        }).pipe(Effect.provide(TestPgClientLive))

        const submitted = yield* Effect.gen(function* () {
          const assetExceptionRepository = yield* AssetExceptionRepository
          return yield* assetExceptionRepository.submitDecision({
            actorId: userId,
            input: {
              providerAssetRowId: btcUsage.btcProviderAsset.id,
              claim: { _tag: "exclusion", reason: "confirmed_spam" },
              evidenceRevision: btcUsage.btcProviderAsset.evidenceRevision,
              currentConclusionRevision: exclusionFixture.decisionId,
              currentPolicyEvaluationRevision: exclusionFixture.decisionId,
              evidenceSnapshotIds: [exclusionFixture.evidenceId],
              rationale: "The approved fee observation was later confirmed as excluded.",
              expectedResultingAssetId: null,
              expectedAssetOutcome: "none",
              expectedRepresentationOutcome: "none",
            },
          })
        }).pipe(
          Effect.provide(AssetExceptionRepositoryLive.pipe(Layer.provideMerge(TestPgClientLive)))
        )
        expect(submitted._tag).toBe("accepted")

        const rematerializations = yield* Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              sourceId: schema.assetDecisionRematerializations.sourceId,
              processingJobId: schema.assetDecisionRematerializations.processingJobId,
            })
            .from(schema.assetDecisionRematerializations)
        }).pipe(Effect.provide(TestPgClientLive))
        expect(rematerializations).toEqual([{ sourceId, processingJobId: expect.any(String) }])
      })
    })
  )

  it.effect("withholds all legs for an excluded fee without reopening mapping review", () =>
    Effect.gen(function* () {
      activeSyncRecords = makeBtcWithHypeFeeSyncRecords()
      activeCryptoCurrencies = [...defaultCryptoCurrencies, hypeCryptoCurrency]

      yield* Effect.gen(function* () {
        yield* seedPendingProviderAssetMapping({
          currencyCode: "HYPE",
          providerAssetId: "hype-provider-asset",
          providerType: "crypto",
        })
        yield* excludeProviderAssetMapping({ currencyCode: "HYPE" })

        const jobsBefore = yield* Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({ id: schema.assetResolutionJobs.id })
            .from(schema.assetResolutionJobs)
        }).pipe(Effect.provide(TestPgClientLive))
        yield* runSync()
        const counts = yield* fetchCounts()
        const jobsAfter = yield* Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({ id: schema.assetResolutionJobs.id })
            .from(schema.assetResolutionJobs)
        }).pipe(Effect.provide(TestPgClientLive))

        expect(
          counts.transactionReviews.some(
            (review) => review.matchedLayer?.includes("provider_asset_mapping") === true
          )
        ).toBe(false)
        expect(
          counts.rawRows.find((row) => row.externalRecordId === "tx-btc-with-hype-fee")
            ?.normalizationError
        ).toBeNull()
        expect(counts.legs).toHaveLength(0)
        expect(jobsAfter).toHaveLength(jobsBefore.length + 1)
      })
    })
  )

  it.effect("preflights every mixed fee candidate before persisting any candidate transfer", () =>
    Effect.gen(function* () {
      const accountRecord = makeCoinbaseRecord({
        recordType: "coinbase_account",
        externalRecordId: "coinbase-account-1",
        occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
        payload: {
          id: "coinbase-account-1",
          created_at: "2025-01-01T00:00:00.000Z",
          updated_at: "2025-01-01T00:00:00.000Z",
        },
      })
      const mixedFeeRecord = ({
        externalRecordId,
        commissionCurrency,
        networkFeeCurrency,
      }: {
        readonly externalRecordId: string
        readonly commissionCurrency: "BLOCK" | "HYPE"
        readonly networkFeeCurrency: "BLOCK" | "HYPE"
      }) =>
        makeCoinbaseRecord({
          externalRecordId,
          occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-05-02T10:00:00.000Z")),
          payload: {
            id: externalRecordId,
            type: "advanced_trade_fill",
            status: "completed",
            amount: { amount: "-0.40000000", currency: "BTC" },
            native_amount: { amount: "-6000.00", currency: "EUR" },
            network: {
              status: "confirmed",
              network_name: "bitcoin",
              transaction_fee: { amount: "0.00010000", currency: networkFeeCurrency },
            },
            advanced_trade_fill: {
              commission: { amount: "0.00020000", currency: commissionCurrency },
              fill_price: "15000.00",
              order_id: `${externalRecordId}-order`,
              order_side: "sell",
              product_id: "BTC-EUR",
            },
            created_at: "2025-05-02T10:00:00.000Z",
            resource_path: `/v2/accounts/coinbase-account-1/transactions/${externalRecordId}`,
          },
        })

      activeSyncRecords = [
        accountRecord,
        mixedFeeRecord({
          externalRecordId: "tx-mixed-fees-included-first",
          commissionCurrency: "BLOCK",
          networkFeeCurrency: "HYPE",
        }),
        mixedFeeRecord({
          externalRecordId: "tx-mixed-fees-blocked-first",
          commissionCurrency: "HYPE",
          networkFeeCurrency: "BLOCK",
        }),
      ]
      activeCryptoCurrencies = [
        ...defaultCryptoCurrencies,
        hypeCryptoCurrency,
        blockedFeeCryptoCurrency,
      ]

      yield* seedPendingProviderAssetMapping({
        currencyCode: "HYPE",
        providerAssetId: "hype-provider-asset",
        providerType: "crypto",
      })
      yield* seedPendingProviderAssetMapping({
        currencyCode: "BLOCK",
        providerAssetId: "blocked-fee-provider-asset",
        providerType: "crypto",
      })
      yield* excludeProviderAssetMapping({ currencyCode: "HYPE" })
      yield* excludeProviderAssetMapping({ currencyCode: "BLOCK" })
      yield* runSync()

      const providerAssets = yield* Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .insert(schema.assets)
          .values({
            id: PROVIDER_OVERRIDE_ASSET_ID,
            name: "Principal HYPE selection",
            symbol: "HYPE-SELECTED",
            type: "fungible",
          })
          .onConflictDoNothing({ target: schema.assets.id })
        const rows = yield* db
          .select({
            id: schema.providerAssets.id,
            currencyCode: schema.providerAssets.currencyCode,
          })
          .from(schema.providerAssets)
          .where(inArray(schema.providerAssets.currencyCode, ["HYPE", "BLOCK"]))
        const hype = rows.find(({ currencyCode }) => currencyCode === "HYPE")
        const blocked = rows.find(({ currencyCode }) => currencyCode === "BLOCK")
        if (hype === undefined || blocked === undefined) {
          return yield* Effect.die("Missing mixed fee provider assets")
        }
        yield* db
          .update(schema.providerAssets)
          .set({ exponent: null })
          .where(eq(schema.providerAssets.id, blocked.id))
        return { hype, blocked }
      }).pipe(Effect.provide(TestPgClientLive))

      yield* createProviderIdentityOverride({ providerAssetRowId: providerAssets.hype.id })
      yield* createProviderInclusionOverride({ providerAssetRowId: providerAssets.hype.id })
      remoteReferenceCatalogAvailable = false
      const replay = yield* replaySource()
      expect(replay.status).toBe("completed")

      const state = yield* Effect.gen(function* () {
        const db = yield* drizzle
        const uses = yield* db
          .select({ currencyCode: schema.providerAssets.currencyCode })
          .from(schema.providerAssetTransactionUses)
          .innerJoin(
            schema.providerAssets,
            eq(schema.providerAssets.id, schema.providerAssetTransactionUses.providerAssetRowId)
          )
          .where(
            inArray(schema.providerAssets.id, [providerAssets.hype.id, providerAssets.blocked.id])
          )
        const reviews = yield* db
          .select({
            categorizationReason: schema.transactionReviews.categorizationReason,
            matchedLayer: schema.transactionReviews.matchedLayer,
          })
          .from(schema.transactionReviews)
        return { uses, reviews }
      }).pipe(Effect.provide(TestPgClientLive))
      const counts = yield* fetchCounts()

      expect(counts.transactions).toHaveLength(2)
      expect(counts.transfers).toEqual([])
      expect(counts.legs).toEqual([])
      expect(state.uses.map(({ currencyCode }) => currencyCode).sort()).toEqual([
        "BLOCK",
        "BLOCK",
        "HYPE",
        "HYPE",
      ])
      expect(state.reviews).toHaveLength(2)
      expect(
        state.reviews.every(
          ({ categorizationReason, matchedLayer }) =>
            categorizationReason?.includes("missing_decimals") === true &&
            matchedLayer?.includes("principal_asset_override") === true
        )
      ).toBe(true)
    })
  )

  it.effect(
    "removes replayed fee facts when their writer-built candidate later becomes blocked",
    () =>
      Effect.gen(function* () {
        activeSyncRecords = makeBtcWithHypeFeeSyncRecords()
        activeCryptoCurrencies = [...defaultCryptoCurrencies, hypeCryptoCurrency]

        yield* seedPendingProviderAssetMapping({
          currencyCode: "HYPE",
          providerAssetId: "hype-provider-asset",
          providerType: "crypto",
        })
        yield* excludeProviderAssetMapping({ currencyCode: "HYPE" })
        yield* runSync()

        const before = yield* fetchCounts()
        expect(before.legs).toHaveLength(0)

        const providerAsset = yield* Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .insert(schema.assets)
            .values({
              id: PROVIDER_OVERRIDE_ASSET_ID,
              name: "Principal HYPE selection",
              symbol: "HYPE-SELECTED",
              type: "fungible",
            })
            .onConflictDoNothing({ target: schema.assets.id })
          const [row] = yield* db
            .select({ id: schema.providerAssets.id })
            .from(schema.providerAssets)
            .where(
              and(
                eq(schema.providerAssets.provider, "coinbase"),
                eq(schema.providerAssets.currencyCode, "HYPE")
              )
            )
            .limit(1)
          if (row === undefined) return yield* Effect.die("Missing HYPE provider asset")

          const uses = yield* db
            .select({ providerAssetRowId: schema.providerAssetTransactionUses.providerAssetRowId })
            .from(schema.providerAssetTransactionUses)
            .where(eq(schema.providerAssetTransactionUses.providerAssetRowId, row.id))
          expect(uses).toEqual([{ providerAssetRowId: row.id }])
          return row
        }).pipe(Effect.provide(TestPgClientLive))

        yield* createProviderIdentityOverride({ providerAssetRowId: providerAsset.id })
        yield* createProviderInclusionOverride({ providerAssetRowId: providerAsset.id })
        remoteReferenceCatalogAvailable = false
        const replay = yield* replaySource()
        expect(replay.status).toBe("completed")

        const state = yield* Effect.gen(function* () {
          const db = yield* drizzle
          const [feeTransfer] = yield* db
            .select({
              id: schema.transfers.id,
              assetId: schema.transfers.assetId,
              providerAssetRowId: schema.transfers.providerAssetRowId,
            })
            .from(schema.transfers)
            .where(eq(schema.transfers.externalId, "tx-btc-with-hype-fee:network_fee"))
          const legs = yield* db
            .select({
              externalId: schema.transactionLegs.externalId,
              assetId: schema.transactionLegs.assetId,
              providerAssetRowId: schema.transactionLegs.providerAssetRowId,
              sourceTransferId: schema.transactionLegs.sourceTransferId,
            })
            .from(schema.transactionLegs)
          const [mapping] = yield* db
            .select({
              canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
              mappingStatus: schema.providerAssetMappings.mappingStatus,
            })
            .from(schema.providerAssetMappings)
            .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAsset.id))
          const inventoryMovements = yield* db
            .select({
              assetId: schema.inventoryMovements.assetId,
              purpose: schema.inventoryMovements.purpose,
              transactionLegId: schema.inventoryMovements.transactionLegId,
            })
            .from(schema.inventoryMovements)
          return { feeTransfer, inventoryMovements, legs, mapping }
        }).pipe(Effect.provide(TestPgClientLive))

        const mainLeg = state.legs.find(
          ({ externalId }) => externalId === "tx-btc-with-hype-fee:main"
        )
        const feeLeg = state.legs.find(
          ({ externalId }) => externalId === "tx-btc-with-hype-fee:network_fee:fee_leg"
        )
        expect(mainLeg).toBeDefined()
        expect(state.feeTransfer).toEqual({
          id: expect.any(String),
          assetId: PROVIDER_OVERRIDE_ASSET_ID,
          providerAssetRowId: providerAsset.id,
        })
        expect(feeLeg).toEqual({
          externalId: "tx-btc-with-hype-fee:network_fee:fee_leg",
          assetId: PROVIDER_OVERRIDE_ASSET_ID,
          providerAssetRowId: providerAsset.id,
          sourceTransferId: state.feeTransfer?.id,
        })
        expect(state.inventoryMovements).toEqual([])
        expect(state.mapping).toEqual({ canonicalAssetId: null, mappingStatus: "excluded" })

        yield* Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .update(schema.providerAssets)
            .set({ exponent: null })
            .where(eq(schema.providerAssets.id, providerAsset.id))
        }).pipe(Effect.provide(TestPgClientLive))

        const blockedReplay = yield* replaySource()
        const blockedState = yield* Effect.gen(function* () {
          const db = yield* drizzle
          const candidateTransfers = yield* db
            .select({ id: schema.transfers.id })
            .from(schema.transfers)
            .where(eq(schema.transfers.externalId, "tx-btc-with-hype-fee:network_fee"))
          const legs = yield* db
            .select({ id: schema.transactionLegs.id })
            .from(schema.transactionLegs)
          const inventoryMovements = yield* db
            .select({ id: schema.inventoryMovements.id })
            .from(schema.inventoryMovements)
          const [review] = yield* db
            .select({
              categorizationReason: schema.transactionReviews.categorizationReason,
              matchedLayer: schema.transactionReviews.matchedLayer,
            })
            .from(schema.transactionReviews)
            .innerJoin(
              schema.transactions,
              eq(schema.transactions.id, schema.transactionReviews.transactionId)
            )
            .where(eq(schema.transactions.externalId, "tx-btc-with-hype-fee"))
          const providerUses = yield* db
            .select({ providerAssetRowId: schema.providerAssetTransactionUses.providerAssetRowId })
            .from(schema.providerAssetTransactionUses)
            .where(eq(schema.providerAssetTransactionUses.providerAssetRowId, providerAsset.id))
          return { candidateTransfers, inventoryMovements, legs, providerUses, review }
        }).pipe(Effect.provide(TestPgClientLive))

        expect(blockedReplay.status).toBe("completed")
        expect(blockedState.candidateTransfers).toEqual([])
        expect(blockedState.legs).toEqual([])
        expect(blockedState.inventoryMovements).toEqual([])
        expect(blockedState.providerUses).toEqual([{ providerAssetRowId: providerAsset.id }])
        expect(blockedState.review?.categorizationReason).toContain("missing_decimals")
        expect(blockedState.review?.matchedLayer).toContain("principal_asset_override")
      })
  )

  it.effect(
    "carries the writer-built fee candidate through provider preparation without changing results",
    () =>
      Effect.gen(function* () {
        activeCryptoCurrencies = [...defaultCryptoCurrencies, hypeCryptoCurrency]
        const providerRecord = makeBtcWithHypeFeeSyncRecords().find(
          (record) => record.recordType === "coinbase_transaction"
        )
        if (providerRecord === undefined) {
          return yield* Effect.die("Missing BTC transaction with HYPE fee fixture")
        }

        const source: SourceSyncSource = {
          id: sourceId,
          principalId,
          providerKey: "coinbase",
          cexAccountId: null,
          addressId: null,
          walletAddress: null,
        }
        const sourceRecord: SourceRawRecord = {
          id: "00000000-0000-4000-8000-000000000211",
          sourceId,
          provider: "coinbase",
          recordType: providerRecord.recordType,
          externalAccountId: providerRecord.externalAccountId,
          externalRecordId: providerRecord.externalRecordId,
          externalParentId: providerRecord.externalParentId,
          occurredAt: providerRecord.occurredAt,
          payload: providerRecord.payload,
          importedAt: providerRecord.occurredAt,
          normalizedAt: null,
          normalizationError: null,
          createdAt: providerRecord.occurredAt,
          updatedAt: providerRecord.occurredAt,
        }

        const fixture = yield* Effect.gen(function* () {
          const provider = yield* CoinbaseSourceSyncProvider
          yield* provider.refreshReferenceData
          const lookups = yield* provider.loadNormalizationLookups
          const db = yield* drizzle
          const [providerAsset] = yield* db
            .select({ id: schema.providerAssets.id })
            .from(schema.providerAssets)
            .where(
              and(
                eq(schema.providerAssets.provider, "coinbase"),
                eq(schema.providerAssets.currencyCode, "HYPE")
              )
            )
            .limit(1)
          if (providerAsset === undefined) {
            return yield* Effect.die("Missing HYPE fee provider asset fixture")
          }

          const unresolved = yield* provider.prepareNormalization({
            source,
            sourceRecord,
            lookups,
          })
          yield* excludeProviderAssetMapping({ currencyCode: "HYPE" })
          const excluded = yield* provider.prepareNormalization({
            source,
            sourceRecord,
            lookups,
          })

          return { excluded, providerAssetRowId: providerAsset.id, unresolved }
        }).pipe(Effect.provide(TestLayer))

        const expectedCandidate = {
          _tag: "asset_decision_fee_transfer",
          providerAssetRowId: fixture.providerAssetRowId,
          transfer: expect.objectContaining({
            sourceId,
            principalId,
            sourceRawRecordId: sourceRecord.id,
            externalId: "tx-btc-with-hype-fee:network_fee",
            externalGroupId: "tx-btc-with-hype-fee",
            blockchainId: expect.any(String),
            timestamp: providerRecord.occurredAt,
            type: "fee",
            fromAccountRef: "coinbase-account-1",
            toAccountRef: "coinbase:network",
            toPartyType: "fee",
            assetRepresentationId: null,
            amount: "0.10000000",
            notes: "Coinbase network transaction fee",
          }),
        }

        expect(fixture.unresolved.feeTransferCandidates).toEqual([expectedCandidate])
        expect(fixture.excluded.feeTransferCandidates).toEqual([expectedCandidate])
        expect(fixture.unresolved.canonicalTransfers).toEqual([])
        expect(fixture.excluded.canonicalTransfers).toEqual([])
        expect(fixture.unresolved.providerTransfers).toEqual([])
        expect(fixture.excluded.providerTransfers).toEqual([])
        expect(fixture.unresolved.legDerivationStrategy).toBe("skip")
        expect(fixture.excluded.legDerivationStrategy).toBe("skip")
        expect(fixture.unresolved.transactionReview).toMatchObject({
          matchedLayer: "provider_asset_mapping",
          reviewStatus: "needs_review",
        })
        expect(fixture.excluded.transactionReview).toBeNull()
      })
  )

  it.effect("records source use for a pending fee provider asset", () =>
    Effect.gen(function* () {
      activeSyncRecords = makeBtcWithHypeFeeSyncRecords()
      activeCryptoCurrencies = [...defaultCryptoCurrencies, hypeCryptoCurrency]

      yield* Effect.gen(function* () {
        yield* seedPendingProviderAssetMapping({
          currencyCode: "HYPE",
          providerAssetId: "hype-provider-asset",
          providerType: "crypto",
        })

        yield* runSync()

        const providerAssetUses = yield* Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({ sourceId: schema.providerAssetSourceUses.sourceId })
            .from(schema.providerAssetSourceUses)
            .innerJoin(
              schema.providerAssets,
              eq(schema.providerAssets.id, schema.providerAssetSourceUses.providerAssetRowId)
            )
            .where(
              and(
                eq(schema.providerAssets.provider, "coinbase"),
                eq(schema.providerAssets.currencyCode, "HYPE")
              )
            )
        }).pipe(Effect.provide(TestPgClientLive))

        expect(providerAssetUses).toEqual([{ sourceId }])
      })
    })
  )

  it.effect("returns source uses without persisting them before normalized artifacts", () =>
    Effect.gen(function* () {
      activeCryptoCurrencies = [...defaultCryptoCurrencies, hypeCryptoCurrency]

      const hypeRecord = makeHypeReviewableSyncRecords().find(
        (record) => record.recordType === "coinbase_transaction"
      )
      if (hypeRecord === undefined) {
        expect.fail("Missing HYPE transaction fixture")
      }

      const source: SourceSyncSource = {
        id: sourceId,
        principalId,
        providerKey: "coinbase",
        cexAccountId: null,
        addressId: null,
        walletAddress: null,
      }
      const sourceRecord: SourceRawRecord = {
        id: "00000000-0000-4000-8000-000000000209",
        sourceId,
        provider: "coinbase",
        recordType: hypeRecord.recordType,
        externalAccountId: hypeRecord.externalAccountId,
        externalRecordId: hypeRecord.externalRecordId,
        externalParentId: hypeRecord.externalParentId,
        occurredAt: hypeRecord.occurredAt,
        payload: hypeRecord.payload,
        importedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-05-01T10:01:00.000Z")),
        normalizedAt: null,
        normalizationError: null,
        createdAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-05-01T10:01:00.000Z")),
        updatedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-05-01T10:01:00.000Z")),
      }

      const fixture = yield* Effect.gen(function* () {
        const provider = yield* CoinbaseSourceSyncProvider
        yield* provider.refreshReferenceData
        const lookups = yield* provider.loadNormalizationLookups
        const db = yield* drizzle
        const [providerAsset] = yield* db
          .select({
            id: schema.providerAssets.id,
            retrievedAt: schema.providerAssets.retrievedAt,
          })
          .from(schema.providerAssets)
          .where(
            and(
              eq(schema.providerAssets.provider, "coinbase"),
              eq(schema.providerAssets.currencyCode, "HYPE")
            )
          )
          .limit(1)
        if (providerAsset === undefined) {
          return yield* Effect.die("Missing HYPE provider asset fixture")
        }

        return {
          lookups,
          providerAssetRowId: providerAsset.id,
        }
      }).pipe(Effect.provide(TestLayer))

      const prepared = yield* Effect.gen(function* () {
        const provider = yield* CoinbaseSourceSyncProvider
        return yield* provider.prepareNormalization({
          source,
          sourceRecord,
          lookups: fixture.lookups,
        })
      }).pipe(Effect.provide(TestLayer))

      const state = yield* Effect.promise(() =>
        context.runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const sourceUses = yield* db
              .select({ sourceId: schema.providerAssetSourceUses.sourceId })
              .from(schema.providerAssetSourceUses)
              .where(
                eq(schema.providerAssetSourceUses.providerAssetRowId, fixture.providerAssetRowId)
              )
            const jobs = yield* db
              .select({
                mode: schema.processingJobs.mode,
                status: schema.processingJobs.status,
              })
              .from(schema.processingJobs)
              .where(eq(schema.processingJobs.sourceId, sourceId))
            return { jobs, sourceUses }
          })
        )
      )

      expect(prepared.legDerivationStrategy).toBe("skip")
      expect(prepared.providerAssetRowIds).toContain(fixture.providerAssetRowId)
      expect(prepared.transactionReview).toMatchObject({
        matchedLayer: "provider_asset_mapping",
        reviewStatus: "needs_review",
      })
      expect(state.sourceUses).toEqual([])
      expect(state.jobs).toEqual([])
    })
  )

  it.effect("replays reviewable raw rows after approving an economic asset mapping", () =>
    Effect.gen(function* () {
      activeSyncRecords = makeHypeReviewableSyncRecords()
      activeCryptoCurrencies = [...defaultCryptoCurrencies, hypeCryptoCurrency]

      yield* Effect.gen(function* () {
        yield* seedPendingProviderAssetMapping({
          currencyCode: "HYPE",
          providerAssetId: "hype-provider-asset",
          providerType: "crypto",
        })

        const reviewableSummary = yield* runSync()
        const reviewableJob = yield* fetchJobDetails({ jobId: reviewableSummary.jobId })
        const reviewableCounts = yield* fetchCounts()

        expect(reviewableJob.status).toBe("completed")
        expect(reviewableJob.normalizedRecords).toBe(2)
        expect(reviewableJob.failedRecords).toBe(0)
        expect(
          reviewableCounts.rawRows.find((row) => row.externalRecordId === "tx-hype-buy-1")
            ?.normalizedAt
        ).not.toBeNull()
        expect(
          reviewableCounts.rawRows.find((row) => row.externalRecordId === "tx-hype-buy-1")
            ?.normalizationError
        ).toBeNull()
        expect(reviewableCounts.transactions).toHaveLength(1)
        expect(reviewableCounts.legs).toHaveLength(0)
        const providerAssetUses = yield* Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({ sourceId: schema.providerAssetSourceUses.sourceId })
            .from(schema.providerAssetSourceUses)
            .innerJoin(
              schema.providerAssets,
              eq(schema.providerAssets.id, schema.providerAssetSourceUses.providerAssetRowId)
            )
            .where(eq(schema.providerAssets.currencyCode, "HYPE"))
        }).pipe(Effect.provide(TestPgClientLive))
        expect(providerAssetUses).toEqual([{ sourceId }])

        const hypeAssetId = yield* seedCanonicalAsset({
          symbol: "HYPE",
        })
        yield* approveProviderAssetMappingToCanonicalAsset({
          currencyCode: "HYPE",
          canonicalAssetId: hypeAssetId,
          assetRepresentationId: null,
        })

        activeSyncRecords = []
        const repairedJob = yield* replaySource()
        const repairedCounts = yield* fetchCounts()
        const repairedRawRow = repairedCounts.rawRows.find(
          (row) => row.externalRecordId === "tx-hype-buy-1"
        )

        expect(repairedJob.status).toBe("completed")
        expect(repairedJob.normalizedRecords).toBe(2)
        expect(repairedJob.failedRecords).toBe(0)
        expect(repairedRawRow?.normalizedAt).not.toBeNull()
        expect(repairedRawRow?.normalizationError).toBeNull()
        expect(repairedCounts.transactions).toEqual([
          expect.objectContaining({
            externalId: "tx-hype-buy-1",
            transactionType: "buy_fiat",
          }),
        ])
        expect(repairedCounts.legs).toEqual([
          expect.objectContaining({
            kind: "acquisition",
            derivationRule: "coinbase_buy",
          }),
        ])

        const replay = yield* replaySource()
        const replayedCounts = yield* fetchCounts()

        expect(replay.status).toBe("completed")
        expect(replayedCounts.transactions).toHaveLength(repairedCounts.transactions.length)
        expect(replayedCounts.transfers).toHaveLength(repairedCounts.transfers.length)
        expect(replayedCounts.legs).toHaveLength(repairedCounts.legs.length)
      })
    })
  )

  it.effect("withholds a malformed derived movement while preserving evidence and review", () =>
    Effect.gen(function* () {
      activeSyncRecords = [
        makeCoinbaseRecord({
          recordType: "coinbase_account",
          externalRecordId: "coinbase-account-1",
          occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
          payload: {
            id: "coinbase-account-1",
            created_at: "2025-01-01T00:00:00.000Z",
            updated_at: "2025-01-01T00:00:00.000Z",
          },
        }),
        makeCoinbaseRecord({
          externalRecordId: "tx-negative-reward",
          occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-05-02T10:00:00.000Z")),
          payload: {
            id: "tx-negative-reward",
            type: "staking_reward",
            status: "completed",
            amount: { amount: "-0.01000000", currency: "BTC" },
            native_amount: { amount: "-100.00", currency: "EUR" },
            created_at: "2025-05-02T10:00:00.000Z",
            resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-negative-reward",
            description: "Invalid negative staking reward",
          },
        }),
      ]

      const summary = yield* runSync()
      const job = yield* fetchJobDetails({ jobId: summary.jobId })
      const counts = yield* fetchCounts()
      const inventory = yield* Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({ id: schema.inventoryMovements.id })
          .from(schema.inventoryMovements)
          .where(eq(schema.inventoryMovements.sourceId, sourceId))
      }).pipe(Effect.provide(TestPgClientLive))
      const rawRow = counts.rawRows.find(
        ({ externalRecordId }) => externalRecordId === "tx-negative-reward"
      )

      expect(job.status).toBe("completed")
      expect(job.normalizedRecords).toBe(2)
      expect(job.failedRecords).toBe(0)
      expect(rawRow?.normalizedAt).not.toBeNull()
      expect(rawRow?.normalizationError).toBeNull()
      expect(counts.transactions).toEqual([
        expect.objectContaining({ externalId: "tx-negative-reward" }),
      ])
      expect(counts.legs).toEqual([])
      expect(inventory).toEqual([])
      expect(counts.transactionReviews).toEqual([
        expect.objectContaining({
          categorizationReason: expect.stringContaining("malformed_movement"),
          matchedLayer: expect.stringContaining("principal_asset_override"),
        }),
      ])
    })
  )

  it.effect("still fails malformed Coinbase payloads normally", () =>
    Effect.gen(function* () {
      activeSyncRecords = [
        makeCoinbaseRecord({
          recordType: "coinbase_account",
          externalRecordId: "coinbase-account-1",
          occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
          payload: {
            id: "coinbase-account-1",
            created_at: "2025-01-01T00:00:00.000Z",
            updated_at: "2025-01-01T00:00:00.000Z",
          },
        }),
        makeCoinbaseRecord({
          externalRecordId: "tx-malformed-1",
          occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-05-02T10:00:00.000Z")),
          payload: {
            id: "tx-malformed-1",
            type: "buy",
            status: "completed",
            amount: { amount: "1.00000000", currency: "BTC" },
            native_amount: { amount: "1000.00", currency: "EUR" },
            resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-malformed-1",
          },
        }),
      ]

      yield* Effect.gen(function* () {
        const summary = yield* runSync()
        const job = yield* fetchJobDetails({ jobId: summary.jobId })
        const counts = yield* fetchCounts()

        expect(job.status).toBe("completed")
        expect(job.normalizedRecords).toBe(1)
        expect(job.failedRecords).toBe(1)
        expect(
          counts.rawRows.find((row) => row.externalRecordId === "tx-malformed-1")?.normalizedAt
        ).toBeNull()
        expect(
          counts.rawRows.find((row) => row.externalRecordId === "tx-malformed-1")
            ?.normalizationError
        ).toContain("Failed to decode Coinbase transaction payload")
        expect(counts.transactions).toHaveLength(0)
        expect(counts.transactionReviews).toHaveLength(0)
      })
    })
  )
})
