import * as DateTime from "effect/DateTime"
import { and, eq } from "drizzle-orm"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import {
  ASSET_RESOLUTION_POLICY_REVISION,
  AssetResolutionUpstreamFailure,
  RegistryLookupNotFound,
  type AssetResolutionRegistryEvidence,
} from "@my/core/assets"
import { SourceSyncServiceLive, TransferReconciliationServiceLive } from "@my/sync-engine/layers"
import { SourceSyncJobExecutorLive } from "../../src/layers/SourceSyncJobExecutorLive.ts"
import { SourceProviderRegistryLive } from "../../src/layers/SourceProviderRegistryLive.ts"
import { AssetResolutionJobExecutorLive } from "../../src/layers/AssetResolutionJobExecutorLive.ts"
import { HeliusSolanaSourceSyncProviderLive } from "../../src/providers/helius-solana/layers/HeliusSolanaSourceSyncProviderLive.ts"
import { CoinbaseLegDerivationServiceLive } from "../../src/providers/coinbase/layers/CoinbaseLegDerivationServiceLive.ts"
import { CoinbaseRecordNormalizerLive } from "../../src/providers/coinbase/layers/CoinbaseRecordNormalizerLive.ts"
import { CoinbaseReferenceDataServiceLive } from "../../src/providers/coinbase/layers/CoinbaseReferenceDataServiceLive.ts"
import { CoinbaseReferenceMappingServiceLive } from "../../src/providers/coinbase/layers/CoinbaseReferenceMappingServiceLive.ts"
import { CoinbaseSourceSyncProviderLive } from "../../src/providers/coinbase/layers/CoinbaseSourceSyncProviderLive.ts"
import { CoinbaseSyncClient } from "../../src/providers/coinbase/services/CoinbaseSyncClient.ts"
import {
  AssetResolutionCoinGeckoClient,
  AssetExceptionRepository,
  AssetResolutionCoinGeckoRetryableError,
  AssetResolutionJobExecutor,
  AssetResolutionJobRepository,
  ProviderAssetRepository,
  SourceSyncService,
} from "@my/sync-engine/services"
import {
  AssetResolutionJupiterClient,
  AssetResolutionJupiterRetryableError,
} from "../../src/providers/jupiter/services/AssetResolutionJupiterClient.ts"
import { AssetRepositoryLive } from "../../../persistence/src/layers/AssetRepositoryLive.ts"
import { ProviderAssetRepositoryLive } from "../../../persistence/src/layers/ProviderAssetRepositoryLive.ts"
import { ProviderReferenceRepositoryLive } from "../../../persistence/src/layers/ProviderReferenceRepositoryLive.ts"
import { RepositoriesLive } from "../../../persistence/src/layers/RepositoriesLive.ts"
import { drizzle } from "../../../persistence/src/layers/PgClientLive.ts"
import { schema } from "../../../persistence/src/schema/index.ts"
import {
  makeIntegrationTestDatabaseContext,
  seedSyncEngineRepositoryFixture,
} from "../../../persistence/tests/support/integration-test-kit.ts"
import { ProviderRawRecord } from "../../src/shared/SourceProviderRawBatch.ts"
import { TaxCalculationService } from "../../../persistence/src/services/index.ts"
import { SourceSyncQueueInlineExecutorTestLive } from "../support/SourceSyncQueueInlineExecutorTestLive.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_sync_engine_asset_resolution_attach_143",
})
const TestPgClientLive = context.TestPgClientLive

const userId = "00000000-0000-0000-0000-000000000161"
const principalId = "00000000-0000-0000-0000-000000000162"
const sourceId = "00000000-0000-0000-0000-000000000261"
const ORB_ASSET_ID = "00000000-0000-4000-8000-000000000561"
const ORB_CORRECTION_ASSET_ID = "00000000-0000-4000-8000-000000000562"
const ORB_MINT = "OrbTestMint1111111111111111111111111111111"
const ORB_COINGECKO_ID = "orb-test-coin"

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

const syncRecords = [
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
    externalRecordId: "tx-orb-buy-1",
    occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-05-01T10:00:00.000Z")),
    payload: {
      id: "tx-orb-buy-1",
      type: "buy",
      status: "completed",
      amount: { amount: "25.00000000", currency: "ORB" },
      native_amount: { amount: "1050.00", currency: "EUR" },
      created_at: "2025-05-01T10:00:00.000Z",
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-orb-buy-1",
      description: "ORB buy awaiting automatic resolution",
    },
  }),
] as const

let providerFetchCount = 0

const CoinbaseSyncClientTestLive = Layer.succeed(CoinbaseSyncClient, {
  fetchAccountsPage: () =>
    Effect.sync(() => ({
      records:
        providerFetchCount === 0
          ? syncRecords
              .filter((record) => record.recordType === "coinbase_account")
              .map((record) => ({
                id: record.externalRecordId,
                occurredAt: record.occurredAt,
                payload: record.payload,
              }))
          : [],
      nextCursor: null,
    })),
  fetchTransactionsPage: ({ accountId }) =>
    Effect.sync(() => {
      const records =
        providerFetchCount === 0
          ? syncRecords
              .filter((record) => record.recordType === "coinbase_transaction")
              .map((record) => ({
                id: record.externalRecordId,
                accountId: record.externalAccountId ?? accountId,
                parentId: record.externalParentId,
                occurredAt: record.occurredAt,
                payload: record.payload,
              }))
          : []

      providerFetchCount += 1

      return { records, nextCursor: null }
    }),
  fetchFiatCurrencies: Effect.succeed([
    {
      currencyCode: "EUR",
      name: "Euro",
      minSize: "0.01",
      payload: { id: "EUR", name: "Euro", min_size: "0.01" },
    },
  ] as const),
  fetchCryptoCurrencies: Effect.succeed([
    {
      currencyCode: "ORB",
      name: "Orb Test Coin",
      providerAssetId: "orb-provider-asset",
      exponent: 8,
      providerType: "crypto",
      payload: {
        code: "ORB",
        name: "Orb Test Coin",
        exponent: 8,
        type: "crypto",
        asset_id: "orb-provider-asset",
      },
    },
  ] as const),
})

const orbCoinGeckoUpstreamFailure = new AssetResolutionUpstreamFailure({ source: "coingecko" })

type FakeCoinGeckoMode = "success" | "retryable" | "terminal" | "not_found"

let coinGeckoMode: FakeCoinGeckoMode = "success"
let coinGeckoFetchGate: {
  readonly started: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
} | null = null

const FakeAssetResolutionCoinGeckoClientLive = Layer.succeed(AssetResolutionCoinGeckoClient, {
  fetchCoinByContract: ({
    platformId,
    address,
  }): Effect.Effect<AssetResolutionRegistryEvidence, AssetResolutionCoinGeckoRetryableError> =>
    Effect.gen(function* () {
      if (coinGeckoFetchGate !== null) {
        yield* Deferred.succeed(coinGeckoFetchGate.started, undefined)
        yield* Deferred.await(coinGeckoFetchGate.release)
      }
      if (coinGeckoMode === "retryable") {
        return yield* new AssetResolutionCoinGeckoRetryableError({
          status: 429,
          cause: "rate limited",
        })
      }

      if (coinGeckoMode === "terminal") {
        return orbCoinGeckoUpstreamFailure
      }

      if (coinGeckoMode === "not_found") {
        return new RegistryLookupNotFound()
      }

      return platformId === "solana" && address === ORB_MINT
        ? {
            _tag: "payload" as const,
            payload: {
              id: ORB_COINGECKO_ID,
              symbol: "orb",
              name: "Orb Test Coin",
              asset_platform_id: "solana",
              platforms: { solana: ORB_MINT },
              detail_platforms: { solana: { decimal_place: 8, contract_address: ORB_MINT } },
            },
          }
        : new RegistryLookupNotFound()
    }),
})

type FakeJupiterMode =
  | "not_indexed"
  | "banned"
  | "suspicious"
  | "unverified"
  | "verified"
  | "retryable"

let jupiterMode: FakeJupiterMode = "not_indexed"
let jupiterFetchGate: {
  readonly started: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
} | null = null

const jupiterSearchPayload = (mode: FakeJupiterMode) => {
  if (mode === "banned") {
    return [{ id: ORB_MINT, name: "", symbol: "", tags: ["banned", "unknown"] }]
  }
  if (mode === "suspicious") {
    return [{ id: ORB_MINT, name: "Orb Test Coin", symbol: "ORB", audit: { isSus: true } }]
  }
  if (mode === "unverified") {
    return [{ id: ORB_MINT, name: "Orb Test Coin", symbol: "ORB" }]
  }
  if (mode === "verified") {
    return [{ id: ORB_MINT, name: "Orb Test Coin", symbol: "ORB", isVerified: true }]
  }

  return []
}

const FakeAssetResolutionJupiterClientLive = Layer.succeed(AssetResolutionJupiterClient, {
  fetchTokenByMint: ({
    mintAddress,
  }): Effect.Effect<AssetResolutionRegistryEvidence, AssetResolutionJupiterRetryableError> =>
    Effect.gen(function* () {
      if (jupiterFetchGate !== null) {
        yield* Deferred.succeed(jupiterFetchGate.started, undefined)
        yield* Deferred.await(jupiterFetchGate.release)
      }
      if (jupiterMode === "retryable") {
        return yield* new AssetResolutionJupiterRetryableError({
          status: 429,
          cause: "rate limited",
        })
      }

      return {
        _tag: "payload" as const,
        payload: mintAddress === ORB_MINT ? jupiterSearchPayload(jupiterMode) : [],
      }
    }),
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

const AssetResolutionJobExecutorTestLive = AssetResolutionJobExecutorLive.pipe(
  Layer.provide(ProviderAssetRepositoryLive),
  Layer.provide(AssetRepositoryLive),
  Layer.provide(FakeAssetResolutionCoinGeckoClientLive),
  Layer.provide(FakeAssetResolutionJupiterClientLive)
)

const TestLayer = SourceSyncLayer.pipe(
  Layer.provideMerge(AssetResolutionJobExecutorTestLive),
  Layer.provideMerge(CoinbaseSourceSyncProviderWithDepsLive),
  Layer.provideMerge(RepositoriesLive),
  Layer.provideMerge(TestPgClientLive)
)

const seedCoinbaseSource = () =>
  seedSyncEngineRepositoryFixture({ userId, principalId, sourceId }).pipe(
    Effect.asVoid,
    Effect.provide(TestPgClientLive)
  )

const insertOrbAsset = ({
  id = ORB_ASSET_ID,
  name = "Orb Test Coin",
  coingeckoCoinId = ORB_COINGECKO_ID,
}: {
  readonly id?: string
  readonly name?: string
  readonly coingeckoCoinId?: string | null
} = {}) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db.insert(schema.assets).values({
      id,
      name,
      symbol: "ORB",
      coingeckoCoinId,
      type: "fungible",
    })
  }).pipe(Effect.provide(TestPgClientLive))

/**
 * Record the exact on-chain identity behind the ORB buy as evidence-only
 * provider-transfer history. A pending Coinbase observation has no transfer
 * or leg rows yet (leg derivation is skipped until the mapping resolves), so
 * this persists the same evidence a real on-chain-aware provider would have
 * recorded inline, without waiting on live sync/replay wiring.
 */
const recordOrbSolanaObservation = () =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [solanaBlockchain] = yield* db
      .select({ id: schema.blockchains.id })
      .from(schema.blockchains)
      .where(eq(schema.blockchains.name, "solana"))
      .limit(1)

    if (solanaBlockchain === undefined) {
      return yield* Effect.die("Missing seeded Solana blockchain")
    }

    const [transaction] = yield* db
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.sourceId, sourceId),
          eq(schema.transactions.externalId, "tx-orb-buy-1")
        )
      )
      .limit(1)

    if (transaction === undefined) {
      return yield* Effect.die("Missing tx-orb-buy-1 transaction fixture")
    }

    const [providerAsset] = yield* db
      .select({ id: schema.providerAssets.id })
      .from(schema.providerAssets)
      .where(
        and(
          eq(schema.providerAssets.provider, "coinbase"),
          eq(schema.providerAssets.currencyCode, "ORB")
        )
      )
      .limit(1)

    if (providerAsset === undefined) {
      return yield* Effect.die("Missing ORB provider asset fixture")
    }

    yield* db.insert(schema.providerTransfers).values({
      sourceId,
      transactionId: transaction.id,
      externalId: "tx-orb-buy-1:onchain-evidence",
      providerAssetId: providerAsset.id,
      timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-05-01T10:00:00.000Z")),
      direction: "inbound",
      processingMode: "evidence_only",
      fromAccountRef: "external",
      toAccountRef: "coinbase-account-1",
      observedBlockchainId: solanaBlockchain.id,
      observedRepresentationType: "token",
      observedContractAddress: null,
      observedMintAddress: ORB_MINT,
      observedDecimals: 8,
      amount: "25",
    })
  }).pipe(Effect.provide(TestPgClientLive))

const SECOND_PROVIDER_ASSET_ROW_ID = "00000000-4000-4000-8000-000000000661"

/**
 * A second provider surfaces the same ORB mint under its own provider asset
 * identity, as a later Solana integration would.
 */
const recordSecondProviderObservationOfOrbMint = () =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [solanaBlockchain] = yield* db
      .select({ id: schema.blockchains.id })
      .from(schema.blockchains)
      .where(eq(schema.blockchains.name, "solana"))
      .limit(1)

    if (solanaBlockchain === undefined) {
      return yield* Effect.die("Missing seeded Solana blockchain")
    }

    const [transaction] = yield* db
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.sourceId, sourceId),
          eq(schema.transactions.externalId, "tx-orb-buy-1")
        )
      )
      .limit(1)

    if (transaction === undefined) {
      return yield* Effect.die("Missing tx-orb-buy-1 transaction fixture")
    }

    yield* db.insert(schema.providerAssets).values({
      id: SECOND_PROVIDER_ASSET_ROW_ID,
      provider: "helius-solana",
      providerAssetId: null,
      naturalKey: `solana:mint:${ORB_MINT}`,
      currencyCode: "ORB",
      name: "Orb Test Coin",
      exponent: 8,
      providerType: "crypto",
      rawProviderPayload: { source: "test" },
      retrievedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-05-01T10:00:00.000Z")),
    })

    yield* db.insert(schema.providerAssetMappings).values({
      providerAssetRowId: SECOND_PROVIDER_ASSET_ROW_ID,
      mappingKind: "asset",
      canonicalAssetId: null,
      assetRepresentationId: null,
      canonicalFiatCurrency: null,
      mappingStatus: "pending_review",
      reviewerNotes: null,
      sourceNotes: "Default mapping awaiting resolution.",
    })

    yield* db.insert(schema.providerTransfers).values({
      sourceId,
      transactionId: transaction.id,
      externalId: "tx-orb-buy-1:second-provider-evidence",
      providerAssetId: SECOND_PROVIDER_ASSET_ROW_ID,
      timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-05-01T10:00:00.000Z")),
      direction: "inbound",
      processingMode: "evidence_only",
      fromAccountRef: "external",
      toAccountRef: "coinbase-account-1",
      observedBlockchainId: solanaBlockchain.id,
      observedRepresentationType: "token",
      observedContractAddress: null,
      observedMintAddress: ORB_MINT,
      observedDecimals: 8,
      amount: "25",
    })
  }).pipe(Effect.provide(TestPgClientLive))

const scheduleSecondProviderResolutionJob = () =>
  Effect.gen(function* () {
    const repository = yield* AssetResolutionJobRepository
    return yield* repository.scheduleUnresolvedResolutionJob({
      providerAssetRowId: SECOND_PROVIDER_ASSET_ROW_ID,
    })
  }).pipe(Effect.provide(TestLayer))

const fetchPendingResolutionJobId = () =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [job] = yield* db
      .select({ id: schema.assetResolutionJobs.id })
      .from(schema.assetResolutionJobs)
      .innerJoin(
        schema.providerAssets,
        eq(schema.assetResolutionJobs.providerAssetRowId, schema.providerAssets.id)
      )
      .where(
        and(
          eq(schema.providerAssets.provider, "coinbase"),
          eq(schema.providerAssets.currencyCode, "ORB")
        )
      )
      .limit(1)

    if (job === undefined) {
      return yield* Effect.die("Missing durable resolution job for ORB provider asset")
    }

    return job.id
  }).pipe(Effect.provide(TestPgClientLive))

const fetchResolutionJobState = ({ jobId }: { readonly jobId: string }) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [job] = yield* db
      .select({
        status: schema.assetResolutionJobs.status,
        attemptCount: schema.assetResolutionJobs.attemptCount,
        nextRetryAt: schema.assetResolutionJobs.nextRetryAt,
        errorMessage: schema.assetResolutionJobs.errorMessage,
      })
      .from(schema.assetResolutionJobs)
      .where(eq(schema.assetResolutionJobs.id, jobId))
      .limit(1)

    if (job === undefined) {
      return yield* Effect.die(`Missing asset resolution job ${jobId}`)
    }

    return job
  }).pipe(Effect.provide(TestPgClientLive))

const runSync = () =>
  Effect.gen(function* () {
    const sourceSync = yield* SourceSyncService
    return yield* sourceSync.startSourceSyncJob({ principalId, sourceId })
  }).pipe(Effect.provide(TestLayer))

const runResolutionJob = ({ jobId }: { readonly jobId: string }) =>
  Effect.gen(function* () {
    const executor = yield* AssetResolutionJobExecutor
    return yield* executor.executeJob({ jobId })
  }).pipe(Effect.provide(TestLayer))

const replaySource = () =>
  Effect.gen(function* () {
    const sourceSync = yield* SourceSyncService
    const summary = yield* sourceSync.replaySourceSyncJob({ principalId, sourceId })
    return yield* sourceSync.getSourceSyncJob({ principalId, sourceId, jobId: summary.jobId })
  }).pipe(Effect.provide(TestLayer))

const calculateTax = () =>
  Effect.gen(function* () {
    const taxCalculation = yield* TaxCalculationService
    return yield* taxCalculation.calculateTax({
      sourceId,
      jurisdiction: "germany",
      year: 2025,
    })
  }).pipe(Effect.provide(TestLayer))

const fetchAttachState = () =>
  Effect.gen(function* () {
    const db = yield* drizzle

    const [mapping] = yield* db
      .select({
        mappingStatus: schema.providerAssetMappings.mappingStatus,
        canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
        assetRepresentationId: schema.providerAssetMappings.assetRepresentationId,
      })
      .from(schema.providerAssetMappings)
      .innerJoin(
        schema.providerAssets,
        eq(schema.providerAssetMappings.providerAssetRowId, schema.providerAssets.id)
      )
      .where(eq(schema.providerAssets.currencyCode, "ORB"))
      .limit(1)

    const decisions = yield* db
      .select({
        id: schema.assetResolutionDecisions.id,
        outcome: schema.assetResolutionDecisions.outcome,
        assetId: schema.assetResolutionDecisions.assetId,
        assetRepresentationId: schema.assetResolutionDecisions.assetRepresentationId,
        policyRevision: schema.assetResolutionDecisions.policyRevision,
        actor: schema.assetResolutionDecisions.actor,
        reason: schema.assetResolutionDecisions.reason,
        currentConclusionId: schema.assetResolutionCurrentState.currentConclusionId,
        currentPolicyEvaluationId: schema.assetResolutionCurrentState.currentPolicyEvaluationId,
      })
      .from(schema.assetResolutionDecisions)
      .innerJoin(
        schema.providerAssets,
        eq(schema.assetResolutionDecisions.providerAssetRowId, schema.providerAssets.id)
      )
      .leftJoin(
        schema.assetResolutionCurrentState,
        eq(schema.assetResolutionCurrentState.providerAssetRowId, schema.providerAssets.id)
      )
      .where(eq(schema.providerAssets.currencyCode, "ORB"))

    const evidence = yield* db
      .select({
        authority: schema.assetResolutionEvidence.authority,
        claimKind: schema.assetResolutionEvidence.claimKind,
        sourceLocator: schema.assetResolutionEvidence.sourceLocator,
        evidenceRevision: schema.assetResolutionEvidence.evidenceRevision,
        decodedClaim: schema.assetResolutionEvidence.decodedClaim,
        rawPayload: schema.assetResolutionEvidence.rawPayload,
      })
      .from(schema.assetResolutionEvidence)
      .innerJoin(
        schema.assetResolutionDecisions,
        eq(schema.assetResolutionEvidence.decisionId, schema.assetResolutionDecisions.id)
      )
      .innerJoin(
        schema.providerAssets,
        eq(schema.assetResolutionDecisions.providerAssetRowId, schema.providerAssets.id)
      )
      .where(eq(schema.providerAssets.currencyCode, "ORB"))
      .orderBy(schema.assetResolutionEvidence.authority)

    const representations = yield* db
      .select({
        assetId: schema.assetRepresentations.assetId,
        type: schema.assetRepresentations.type,
        mintAddress: schema.assetRepresentations.mintAddress,
        decimals: schema.assetRepresentations.decimals,
      })
      .from(schema.assetRepresentations)
      .where(eq(schema.assetRepresentations.mintAddress, ORB_MINT))

    const ownershipDecisions = yield* db
      .select({
        assetRepresentationId: schema.assetRepresentationOwnershipDecisions.assetRepresentationId,
        assetId: schema.assetRepresentationOwnershipDecisions.assetId,
        actor: schema.assetRepresentationOwnershipDecisions.actor,
      })
      .from(schema.assetRepresentationOwnershipDecisions)
      .innerJoin(
        schema.assetRepresentations,
        eq(
          schema.assetRepresentationOwnershipDecisions.assetRepresentationId,
          schema.assetRepresentations.id
        )
      )
      .where(eq(schema.assetRepresentations.mintAddress, ORB_MINT))

    const replayJobs = yield* db
      .select({ mode: schema.processingJobs.mode, status: schema.processingJobs.status })
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.sourceId, sourceId))

    const owningAssets = yield* db
      .select({
        id: schema.assets.id,
        name: schema.assets.name,
        symbol: schema.assets.symbol,
        type: schema.assets.type,
        coingeckoCoinId: schema.assets.coingeckoCoinId,
      })
      .from(schema.assets)
      .innerJoin(
        schema.assetRepresentations,
        eq(schema.assetRepresentations.assetId, schema.assets.id)
      )
      .where(eq(schema.assetRepresentations.mintAddress, ORB_MINT))

    return {
      mapping,
      decisions,
      evidence,
      ownershipDecisions,
      representations,
      replayJobs,
      owningAssets,
    }
  }).pipe(Effect.provide(TestPgClientLive))

const fetchAccountingState = () =>
  Effect.gen(function* () {
    const db = yield* drizzle

    const legs = yield* db
      .select({
        assetId: schema.transactionLegs.assetId,
        kind: schema.transactionLegs.kind,
        derivationRule: schema.transactionLegs.derivationRule,
      })
      .from(schema.transactionLegs)
      .where(eq(schema.transactionLegs.sourceId, sourceId))

    const rawRecords = yield* db
      .select({ externalRecordId: schema.sourceRecordsRaw.externalRecordId })
      .from(schema.sourceRecordsRaw)
      .where(
        and(
          eq(schema.sourceRecordsRaw.sourceId, sourceId),
          eq(schema.sourceRecordsRaw.externalRecordId, "tx-orb-buy-1")
        )
      )

    const transactions = yield* db
      .select({
        id: schema.transactions.id,
        externalId: schema.transactions.externalId,
        sourceRawRecordId: schema.transactions.sourceRawRecordId,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.sourceId, sourceId),
          eq(schema.transactions.externalId, "tx-orb-buy-1")
        )
      )

    return { legs, rawRecords, transactions }
  }).pipe(Effect.provide(TestPgClientLive))

await Effect.runPromise(context.recreateTestDatabase())

describe("asset resolution attach and rebuild", () => {
  beforeEach(() =>
    Effect.gen(function* () {
      providerFetchCount = 0
      coinGeckoMode = "success"
      coinGeckoFetchGate = null
      jupiterMode = "not_indexed"
      jupiterFetchGate = null
      yield* context.recreateTestDatabase()
      yield* seedCoinbaseSource()
    }).pipe(Effect.runPromise)
  )

  it.effect("attaches a new exact representation and rebuilds every affected source", () =>
    Effect.asVoid(
      Effect.gen(function* () {
        yield* runSync()

        const pendingTax = yield* calculateTax().pipe(Effect.result)
        expect(pendingTax._tag).toBe("Failure")

        yield* insertOrbAsset()
        yield* recordOrbSolanaObservation()
        const jobId = yield* fetchPendingResolutionJobId()

        const result = yield* runResolutionJob({ jobId })
        expect(result.outcome).toBe("attached")

        const attachState = yield* fetchAttachState()
        expect(attachState.mapping).toMatchObject({
          mappingStatus: "approved",
          canonicalAssetId: ORB_ASSET_ID,
        })
        expect(attachState.mapping?.assetRepresentationId).not.toBeNull()
        expect(attachState.decisions).toEqual([
          expect.objectContaining({
            outcome: "attach",
            assetId: ORB_ASSET_ID,
            actor: "system:asset-resolution-policy",
          }),
        ])
        expect(attachState.representations).toEqual([
          expect.objectContaining({
            assetId: ORB_ASSET_ID,
            type: "token",
            mintAddress: ORB_MINT,
            decimals: 8,
          }),
        ])
        expect(attachState.evidence).toEqual([
          expect.objectContaining({
            authority: "chain",
            claimKind: "chain_fact",
            evidenceRevision: 1,
            decodedClaim: expect.objectContaining({ mintAddress: ORB_MINT, decimals: 8 }),
          }),
          expect.objectContaining({
            authority: "coingecko",
            claimKind: "registry_platform_mapping",
            sourceLocator: `coingecko://coins/solana/contract/${ORB_MINT}`,
            evidenceRevision: 1,
            rawPayload: expect.objectContaining({
              payload: expect.objectContaining({ id: ORB_COINGECKO_ID }),
            }),
          }),
          expect.objectContaining({
            authority: "jupiter",
            claimKind: "legitimacy",
            sourceLocator: `jupiter://tokens/v2/search?query=${ORB_MINT}`,
            evidenceRevision: 1,
            decodedClaim: null,
          }),
        ])
        expect(attachState.ownershipDecisions).toEqual([
          expect.objectContaining({
            assetId: ORB_ASSET_ID,
            actor: "system:asset-resolution-policy",
          }),
        ])
        expect(attachState.replayJobs).toContainEqual({ mode: "replay", status: "pending" })

        const duplicateResult = yield* runResolutionJob({ jobId })
        expect(duplicateResult.outcome).toBe("already_claimed")

        const replay = yield* replaySource()
        expect(replay.status).toBe("completed")

        // Rematerialization runs from stored raw records: the provider was
        // fetched exactly once, by the original sync.
        expect(providerFetchCount).toBe(1)

        const accountingState = yield* fetchAccountingState()
        expect(accountingState.legs).toEqual([
          expect.objectContaining({ kind: "acquisition", derivationRule: "coinbase_buy" }),
        ])
        expect((yield* calculateTax().pipe(Effect.result))._tag).toBe("Failure")
      })
    )
  )

  it.effect("keeps an approved conclusion while later evidence reopens policy review", () =>
    Effect.asVoid(
      Effect.gen(function* () {
        yield* runSync()
        yield* insertOrbAsset()
        yield* recordOrbSolanaObservation()
        const firstJobId = yield* fetchPendingResolutionJobId()
        expect((yield* runResolutionJob({ jobId: firstJobId })).outcome).toBe("attached")

        const before = yield* fetchAttachState()
        const firstDecision = before.decisions[0]
        if (firstDecision === undefined) {
          return yield* Effect.die("Missing approved conclusion")
        }

        const laterJobId = "00000000-4000-4000-8000-000000000773"
        const providerAssetRowId = yield* Effect.gen(function* () {
          const db = yield* drizzle
          const [providerAsset] = yield* db
            .select({ id: schema.providerAssets.id })
            .from(schema.providerAssets)
            .where(
              and(
                eq(schema.providerAssets.provider, "coinbase"),
                eq(schema.providerAssets.currencyCode, "ORB")
              )
            )
            .limit(1)
          if (providerAsset === undefined) {
            return yield* Effect.die("Missing approved ORB observation")
          }
          yield* db
            .update(schema.providerAssets)
            .set({ evidenceRevision: 2 })
            .where(eq(schema.providerAssets.id, providerAsset.id))
          yield* db
            .update(schema.providerTransfers)
            .set({ observedDecimals: 9 })
            .where(eq(schema.providerTransfers.providerAssetId, providerAsset.id))
          yield* db.insert(schema.assetResolutionJobs).values({
            id: laterJobId,
            providerAssetRowId: providerAsset.id,
            evidenceRevision: 2,
            policyRevision: ASSET_RESOLUTION_POLICY_REVISION,
            status: "pending",
          })
          return providerAsset.id
        })

        expect((yield* runResolutionJob({ jobId: laterJobId })).outcome).toBe("fail_closed")
        const after = yield* fetchAttachState()
        expect(after.mapping).toEqual(before.mapping)
        expect(after.decisions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ outcome: "attach", assetId: ORB_ASSET_ID }),
            expect.objectContaining({
              outcome: "fail_closed",
              reason: "incompatible_decimals",
            }),
          ])
        )

        const repository = yield* AssetExceptionRepository
        const detail = yield* repository.findDetail({
          _tag: "row_id",
          providerAssetRowId,
        })
        expect(Option.getOrNull(detail)).toMatchObject({
          reviewStatus: "unresolved",
          currentConclusion: { outcome: "attach", evidenceRevision: 1 },
          currentPolicyEvaluation: { outcome: "fail_closed", evidenceRevision: 2 },
        })
      }).pipe(Effect.provide(TestLayer))
    )
  )

  it.effect("keeps a manual approval settled when in-flight policy research finishes", () =>
    Effect.asVoid(
      Effect.gen(function* () {
        yield* runSync()
        yield* insertOrbAsset()
        yield* recordOrbSolanaObservation()
        const jobId = yield* fetchPendingResolutionJobId()

        coinGeckoMode = "terminal"
        const researchStarted = yield* Deferred.make<void>()
        const releaseResearch = yield* Deferred.make<void>()
        coinGeckoFetchGate = { started: researchStarted, release: releaseResearch }
        const worker = yield* Effect.forkChild(runResolutionJob({ jobId }))
        yield* Deferred.await(researchStarted)

        const providerAssetRepository = yield* ProviderAssetRepository
        const review = yield* providerAssetRepository.findProviderAssetReviewById({
          providerAssetRowId: yield* Effect.gen(function* () {
            const db = yield* drizzle
            const [providerAsset] = yield* db
              .select({ id: schema.providerAssets.id })
              .from(schema.providerAssets)
              .where(
                and(
                  eq(schema.providerAssets.provider, "coinbase"),
                  eq(schema.providerAssets.currencyCode, "ORB")
                )
              )
              .limit(1)
            if (providerAsset === undefined) {
              return yield* Effect.die("Missing ORB provider asset fixture")
            }
            return providerAsset.id
          }),
        })
        if (Option.isNone(review)) {
          return yield* Effect.die("Missing ORB provider asset review")
        }
        const providerAssetRowId = review.value.providerAsset.id
        const observations =
          yield* providerAssetRepository.listProviderAssetObservedRepresentations({
            providerAssetRowId,
          })
        yield* providerAssetRepository.approveProviderAssetMappingAndRequestReplay({
          mapping: {
            providerAssetRowId,
            mappingKind: "asset",
            canonicalAssetId: ORB_ASSET_ID,
            assetRepresentationId: null,
            canonicalFiatCurrency: null,
            mappingStatus: "approved",
            reviewerNotes: "Approved while policy research was in flight.",
            sourceNotes: "Manual approval race regression.",
          },
          conclusion: {
            providerAssetRowId,
            evidenceRevision: review.value.providerAsset.evidenceRevision,
            policyRevision: "2026-08-26.manual-canonicalization.1",
            claim: {
              _tag: "identity",
              assetId: ORB_ASSET_ID,
              newAsset: null,
              representation: null,
            },
            assetId: ORB_ASSET_ID,
            assetRepresentationId: null,
            rationale: "Approved while policy research was in flight.",
            evidence: [
              {
                authority: "human_admin",
                claimKind: "canonical_asset_selection",
                sourceLocator: `taxmaxi://provider-assets/${providerAssetRowId}/manual-canonicalization`,
                retrievedAt: review.value.providerAsset.retrievedAt,
                evidenceRevision: review.value.providerAsset.evidenceRevision,
                decodedClaim: { canonicalAssetId: ORB_ASSET_ID },
                rawPayload: review.value.providerAsset.rawProviderPayload,
              },
            ],
            actor: "system:manual-asset-canonicalization",
          },
          expectedObservedRepresentations: observations,
          expectedProviderAssetRetrievedAt: review.value.providerAsset.retrievedAt,
        })

        yield* Deferred.succeed(releaseResearch, undefined)
        expect((yield* Fiber.join(worker)).outcome).toBe("fail_closed")

        const state = yield* fetchAttachState()
        const manualConclusion = state.decisions.find(
          ({ actor }) => actor === "system:manual-asset-canonicalization"
        )
        const staleEvaluation = state.decisions.find(({ outcome }) => outcome === "fail_closed")
        expect(state.mapping).toMatchObject({
          mappingStatus: "approved",
          canonicalAssetId: ORB_ASSET_ID,
        })
        expect(manualConclusion).toMatchObject({
          assetId: ORB_ASSET_ID,
          id: manualConclusion?.currentConclusionId,
          currentPolicyEvaluationId: staleEvaluation?.id,
        })
        expect(staleEvaluation?.id).toBe(staleEvaluation?.currentPolicyEvaluationId)

        const repository = yield* AssetExceptionRepository
        const detail = yield* repository.findDetail({
          _tag: "row_id",
          providerAssetRowId,
        })
        expect(Option.getOrNull(detail)).toMatchObject({
          reviewStatus: "approved",
          currentConclusion: { id: manualConclusion?.id, outcome: "attach" },
          currentPolicyEvaluation: { id: staleEvaluation?.id, outcome: "fail_closed" },
        })
      }).pipe(Effect.provide(TestLayer))
    )
  )

  it.effect(
    "creates a standalone asset for an unambiguous long-tail mint and includes it after replay",
    () =>
      Effect.asVoid(
        Effect.gen(function* () {
          yield* runSync()

          const pendingTax = yield* calculateTax().pipe(Effect.result)
          expect(pendingTax._tag).toBe("Failure")

          // No ORB economic asset exists and the registry does not know the
          // mint, but Jupiter vouches for it: the exact long-tail
          // representation creates its own asset.
          coinGeckoMode = "not_found"
          jupiterMode = "verified"
          yield* recordOrbSolanaObservation()
          const jobId = yield* fetchPendingResolutionJobId()

          const result = yield* runResolutionJob({ jobId })
          expect(result.outcome).toBe("created")

          const state = yield* fetchAttachState()
          expect(state.owningAssets).toEqual([
            expect.objectContaining({
              name: "Orb Test Coin",
              symbol: "ORB",
              type: "fungible",
              coingeckoCoinId: null,
            }),
          ])
          const createdAssetId = state.owningAssets[0]?.id
          expect(state.mapping).toMatchObject({
            mappingStatus: "approved",
            canonicalAssetId: createdAssetId,
          })
          expect(state.mapping?.assetRepresentationId).not.toBeNull()
          expect(state.decisions).toEqual([
            expect.objectContaining({
              outcome: "create_standalone",
              assetId: createdAssetId,
              actor: "system:asset-resolution-policy",
            }),
          ])
          expect(state.decisions[0]?.assetRepresentationId).not.toBeNull()
          expect(state.representations).toEqual([
            expect.objectContaining({
              assetId: createdAssetId,
              type: "token",
              mintAddress: ORB_MINT,
              decimals: 8,
            }),
          ])
          expect(state.evidence).toEqual([
            expect.objectContaining({
              authority: "chain",
              claimKind: "chain_fact",
              evidenceRevision: 1,
              decodedClaim: expect.objectContaining({ mintAddress: ORB_MINT, decimals: 8 }),
            }),
            expect.objectContaining({
              authority: "coingecko",
              claimKind: "registry_platform_mapping",
              sourceLocator: `coingecko://coins/solana/contract/${ORB_MINT}`,
              evidenceRevision: 1,
              rawPayload: expect.objectContaining({ _tag: "registry_not_found" }),
            }),
            expect.objectContaining({
              authority: "jupiter",
              claimKind: "legitimacy",
              sourceLocator: `jupiter://tokens/v2/search?query=${ORB_MINT}`,
              evidenceRevision: 1,
              decodedClaim: expect.objectContaining({ verdict: "verified" }),
            }),
          ])
          expect(state.ownershipDecisions).toEqual([
            expect.objectContaining({
              assetId: createdAssetId,
              actor: "system:asset-resolution-policy",
            }),
          ])
          expect(state.replayJobs).toContainEqual({ mode: "replay", status: "pending" })

          const duplicateResult = yield* runResolutionJob({ jobId })
          expect(duplicateResult.outcome).toBe("already_claimed")

          const replay = yield* replaySource()
          expect(replay.status).toBe("completed")

          // Rematerialization runs from stored raw records: the provider was
          // fetched exactly once, by the original sync.
          expect(providerFetchCount).toBe(1)

          const accountingState = yield* fetchAccountingState()
          expect(accountingState.legs).toEqual([
            expect.objectContaining({ kind: "acquisition", derivationRule: "coinbase_buy" }),
          ])
          expect((yield* calculateTax().pipe(Effect.result))._tag).toBe("Failure")
        })
      )
  )

  it.effect(
    "creates a standalone asset stamped with the registry coin id no local asset owns",
    () =>
      Effect.asVoid(
        Effect.gen(function* () {
          yield* runSync()
          // The registry knows the mint as orb-test-coin, but no local asset
          // owns that coin id and no display candidate exists.
          yield* recordOrbSolanaObservation()
          const jobId = yield* fetchPendingResolutionJobId()

          const result = yield* runResolutionJob({ jobId })
          expect(result.outcome).toBe("created")

          const state = yield* fetchAttachState()
          expect(state.owningAssets).toEqual([
            expect.objectContaining({
              name: "Orb Test Coin",
              symbol: "ORB",
              coingeckoCoinId: ORB_COINGECKO_ID,
            }),
          ])
          expect(state.decisions).toEqual([
            expect.objectContaining({ outcome: "create_standalone" }),
          ])
          expect(state.mapping).toMatchObject({ mappingStatus: "approved" })
        })
      )
  )

  it.effect("attaches through registry linkage even when a same-symbol clone exists", () =>
    Effect.asVoid(
      Effect.gen(function* () {
        yield* runSync()
        yield* insertOrbAsset()
        // A same-display clone without a CoinGecko id cannot block the
        // deterministic registry linkage to the id-carrying asset.
        yield* insertOrbAsset({
          id: "00000000-0000-0000-0000-000000000562",
          name: "Orb Test Coin Clone",
          coingeckoCoinId: null,
        })
        yield* recordOrbSolanaObservation()
        const jobId = yield* fetchPendingResolutionJobId()

        const result = yield* runResolutionJob({ jobId })
        expect(result.outcome).toBe("attached")

        const state = yield* fetchAttachState()
        expect(state.decisions).toEqual([
          expect.objectContaining({
            outcome: "attach",
            assetId: ORB_ASSET_ID,
            actor: "system:asset-resolution-policy",
          }),
        ])
        expect(state.mapping).toMatchObject({
          mappingStatus: "approved",
          canonicalAssetId: ORB_ASSET_ID,
        })
      })
    )
  )

  it.effect(
    "stays pending as a display collision when the colliding asset has no registry linkage",
    () =>
      Effect.asVoid(
        Effect.gen(function* () {
          yield* runSync()
          // The only ORB asset has no CoinGecko id, and the registry does not
          // know the mint: the display match alone must neither attach nor
          // allow a potentially duplicate standalone asset.
          yield* insertOrbAsset({ coingeckoCoinId: null })
          coinGeckoMode = "not_found"
          yield* recordOrbSolanaObservation()
          const jobId = yield* fetchPendingResolutionJobId()

          const result = yield* runResolutionJob({ jobId })
          expect(result.outcome).toBe("pending")

          const state = yield* fetchAttachState()
          expect(state.decisions).toEqual([
            expect.objectContaining({
              outcome: "pending",
              reason: "display_collision",
              actor: "system:asset-resolution-policy",
            }),
          ])
          expect(state.mapping).toMatchObject({ mappingStatus: "pending_review" })
          expect(state.representations).toEqual([])

          const job = yield* fetchResolutionJobState({ jobId })
          expect(job.status).toBe("completed")
        })
      )
  )

  it.effect("stays pending as an unverified asset when no registry vouches for the mint", () =>
    Effect.asVoid(
      Effect.gen(function* () {
        yield* runSync()
        // The registry does not know the mint and Jupiter has never indexed
        // it. The absence of spam evidence must not create a canonical
        // asset; the observation waits for human review.
        coinGeckoMode = "not_found"
        yield* recordOrbSolanaObservation()
        const jobId = yield* fetchPendingResolutionJobId()

        const result = yield* runResolutionJob({ jobId })
        expect(result.outcome).toBe("pending")

        const state = yield* fetchAttachState()
        expect(state.owningAssets).toEqual([])
        expect(state.decisions).toEqual([
          expect.objectContaining({
            outcome: "pending",
            reason: "unverified_asset",
            actor: "system:asset-resolution-policy",
          }),
        ])
        expect(state.mapping).toMatchObject({ mappingStatus: "pending_review" })
        expect(state.representations).toEqual([])

        const job = yield* fetchResolutionJobState({ jobId })
        expect(job.status).toBe("completed")
      })
    )
  )

  it.effect("leaves a stale evidence revision without a decision and without attaching", () =>
    Effect.asVoid(
      Effect.gen(function* () {
        yield* runSync()
        yield* insertOrbAsset()
        yield* recordOrbSolanaObservation()
        const staleJobId = yield* fetchPendingResolutionJobId()

        yield* Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .update(schema.providerAssets)
            .set({ evidenceRevision: 2 })
            .where(
              and(
                eq(schema.providerAssets.provider, "coinbase"),
                eq(schema.providerAssets.currencyCode, "ORB")
              )
            )
        }).pipe(Effect.provide(TestPgClientLive))

        const result = yield* runResolutionJob({ jobId: staleJobId })
        expect(result.outcome).toBe("stale")

        const attachState = yield* fetchAttachState()
        expect(attachState.mapping).toMatchObject({ mappingStatus: "pending_review" })
        expect(attachState.decisions).toEqual([])
        expect(attachState.representations).toEqual([])
      })
    )
  )

  it.effect.each([
    {
      expectedDecision: "pending" as const,
      registryMode: "not_found" as const,
      legitimacyMode: "not_indexed" as const,
      seedTargetAsset: false,
    },
    {
      expectedDecision: "fail_closed" as const,
      registryMode: "success" as const,
      legitimacyMode: "banned" as const,
      seedTargetAsset: true,
    },
  ])(
    "does not persist an in-flight stale $expectedDecision evaluation",
    ({ registryMode, legitimacyMode, seedTargetAsset }) =>
      Effect.asVoid(
        Effect.gen(function* () {
          yield* runSync()
          if (seedTargetAsset) {
            yield* insertOrbAsset()
          }
          yield* recordOrbSolanaObservation()
          const jobId = yield* fetchPendingResolutionJobId()

          coinGeckoMode = registryMode
          jupiterMode = legitimacyMode
          const researchStarted = yield* Deferred.make<void>()
          const releaseResearch = yield* Deferred.make<void>()
          jupiterFetchGate = { started: researchStarted, release: releaseResearch }
          const worker = yield* Effect.forkChild(runResolutionJob({ jobId }))
          yield* Deferred.await(researchStarted)

          yield* Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.providerAssets)
              .set({ evidenceRevision: 2 })
              .where(
                and(
                  eq(schema.providerAssets.provider, "coinbase"),
                  eq(schema.providerAssets.currencyCode, "ORB")
                )
              )
          }).pipe(Effect.provide(TestPgClientLive))
          yield* Deferred.succeed(releaseResearch, undefined)

          expect((yield* Fiber.join(worker)).outcome).toBe("stale")
          const state = yield* fetchAttachState()
          expect(state.decisions).toEqual([])
          expect(state.evidence).toEqual([])
          expect(state.mapping).toMatchObject({ mappingStatus: "pending_review" })
          expect((yield* fetchResolutionJobState({ jobId })).status).toBe("completed")
        }).pipe(Effect.provide(TestLayer))
      )
  )

  it.effect.each([
    {
      expectedDecision: "attach" as const,
      registryMode: "success" as const,
      legitimacyMode: "not_indexed" as const,
      seedTargetAsset: true,
    },
    {
      expectedDecision: "create_standalone" as const,
      registryMode: "not_found" as const,
      legitimacyMode: "verified" as const,
      seedTargetAsset: false,
    },
    {
      expectedDecision: "excluded" as const,
      registryMode: "not_found" as const,
      legitimacyMode: "banned" as const,
      seedTargetAsset: false,
    },
  ])(
    "does not apply an in-flight stale $expectedDecision decision",
    ({ registryMode, legitimacyMode, seedTargetAsset }) =>
      Effect.asVoid(
        Effect.gen(function* () {
          yield* runSync()
          if (seedTargetAsset) {
            yield* insertOrbAsset()
          }
          yield* recordOrbSolanaObservation()
          const jobId = yield* fetchPendingResolutionJobId()
          const before = yield* fetchAttachState()

          coinGeckoMode = registryMode
          jupiterMode = legitimacyMode
          const researchStarted = yield* Deferred.make<void>()
          const releaseResearch = yield* Deferred.make<void>()
          jupiterFetchGate = { started: researchStarted, release: releaseResearch }
          const worker = yield* Effect.forkChild(runResolutionJob({ jobId }))
          yield* Deferred.await(researchStarted)

          yield* Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.providerAssets)
              .set({ evidenceRevision: 2 })
              .where(
                and(
                  eq(schema.providerAssets.provider, "coinbase"),
                  eq(schema.providerAssets.currencyCode, "ORB")
                )
              )
          }).pipe(Effect.provide(TestPgClientLive))
          yield* Deferred.succeed(releaseResearch, undefined)

          expect((yield* Fiber.join(worker)).outcome).toBe("stale")
          const after = yield* fetchAttachState()
          expect(after.decisions).toEqual(before.decisions)
          expect(after.evidence).toEqual(before.evidence)
          expect(after.mapping).toEqual(before.mapping)
          expect(after.ownershipDecisions).toEqual(before.ownershipDecisions)
          expect(after.owningAssets).toEqual(before.owningAssets)
          expect(after.representations).toEqual(before.representations)
          expect(after.replayJobs).toEqual(before.replayJobs)
          expect((yield* fetchResolutionJobState({ jobId })).status).toBe("completed")
        }).pipe(Effect.provide(TestLayer))
      )
  )

  it.effect.each(["approved", "excluded"] as const)(
    "does not append stale history for an already %s mapping",
    (settledStatus) =>
      Effect.asVoid(
        Effect.gen(function* () {
          yield* runSync()
          if (settledStatus === "approved") {
            yield* insertOrbAsset()
          } else {
            coinGeckoMode = "not_found"
            jupiterMode = "banned"
          }
          yield* recordOrbSolanaObservation()
          const firstJobId = yield* fetchPendingResolutionJobId()
          expect((yield* runResolutionJob({ jobId: firstJobId })).outcome).toBe(
            settledStatus === "approved" ? "attached" : "excluded"
          )
          const before = yield* fetchAttachState()

          const staleJobId =
            settledStatus === "approved"
              ? "00000000-4000-4000-8000-000000000774"
              : "00000000-4000-4000-8000-000000000775"
          yield* Effect.gen(function* () {
            const db = yield* drizzle
            const [providerAsset] = yield* db
              .update(schema.providerAssets)
              .set({ evidenceRevision: 2 })
              .where(
                and(
                  eq(schema.providerAssets.provider, "coinbase"),
                  eq(schema.providerAssets.currencyCode, "ORB")
                )
              )
              .returning({ id: schema.providerAssets.id })
            if (providerAsset === undefined) {
              return yield* Effect.die("Missing settled ORB observation")
            }
            yield* db.insert(schema.assetResolutionJobs).values({
              id: staleJobId,
              providerAssetRowId: providerAsset.id,
              evidenceRevision: 2,
              policyRevision: ASSET_RESOLUTION_POLICY_REVISION,
              status: "pending",
            })
          }).pipe(Effect.provide(TestPgClientLive))

          coinGeckoMode = settledStatus === "approved" ? "success" : "not_found"
          jupiterMode = settledStatus === "approved" ? "not_indexed" : "unverified"
          const researchStarted = yield* Deferred.make<void>()
          const releaseResearch = yield* Deferred.make<void>()
          jupiterFetchGate = { started: researchStarted, release: releaseResearch }
          const worker = yield* Effect.forkChild(runResolutionJob({ jobId: staleJobId }))
          yield* Deferred.await(researchStarted)

          yield* Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.providerAssets)
              .set({ evidenceRevision: 3 })
              .where(
                and(
                  eq(schema.providerAssets.provider, "coinbase"),
                  eq(schema.providerAssets.currencyCode, "ORB")
                )
              )
          }).pipe(Effect.provide(TestPgClientLive))
          yield* Deferred.succeed(releaseResearch, undefined)

          expect((yield* Fiber.join(worker)).outcome).toBe("stale")
          const after = yield* fetchAttachState()
          expect(after.decisions).toEqual(before.decisions)
          expect(after.evidence).toEqual(before.evidence)
          expect(after.mapping).toEqual(before.mapping)
          expect((yield* fetchResolutionJobState({ jobId: staleJobId })).status).toBe("completed")
        }).pipe(Effect.provide(TestLayer))
      )
  )

  it.effect(
    "releases the job for retry on a transient CoinGecko failure without recording a decision",
    () =>
      Effect.asVoid(
        Effect.gen(function* () {
          yield* runSync()
          yield* insertOrbAsset()
          yield* recordOrbSolanaObservation()
          const jobId = yield* fetchPendingResolutionJobId()

          coinGeckoMode = "retryable"
          const failed = yield* runResolutionJob({ jobId }).pipe(Effect.result)
          expect(failed._tag).toBe("Failure")
          if (failed._tag === "Failure") {
            expect(failed.failure).toMatchObject({
              _tag: "AssetResolutionEvidenceRetryableError",
              source: "coingecko",
              status: 429,
            })
          }

          const stateAfterFailure = yield* fetchAttachState()
          expect(stateAfterFailure.decisions).toEqual([])
          expect(stateAfterFailure.representations).toEqual([])

          const jobAfterFailure = yield* fetchResolutionJobState({ jobId })
          expect(jobAfterFailure.status).toBe("pending")
          expect(jobAfterFailure.nextRetryAt).not.toBeNull()
          expect(jobAfterFailure.attemptCount).toBe(1)

          // Once the upstream recovers and the retry delay passes, the same job
          // reaches the same decision a first-attempt success would have.
          coinGeckoMode = "success"
          yield* Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.assetResolutionJobs)
              .set({
                nextRetryAt: DateTime.toDateUtc(
                  DateTime.subtractDuration(yield* DateTime.now, "1 second")
                ),
              })
              .where(eq(schema.assetResolutionJobs.id, jobId))
          }).pipe(Effect.provide(TestPgClientLive))

          const retried = yield* runResolutionJob({ jobId })
          expect(retried.outcome).toBe("attached")

          const stateAfterRetry = yield* fetchAttachState()
          expect(stateAfterRetry.decisions).toEqual([
            expect.objectContaining({ outcome: "attach", assetId: ORB_ASSET_ID }),
          ])
        })
      )
  )

  it.effect(
    "re-executing at the same evidence revision keeps the original decision and repeats nothing",
    () =>
      Effect.asVoid(
        Effect.gen(function* () {
          yield* runSync()
          yield* insertOrbAsset()
          yield* recordOrbSolanaObservation()
          const jobId = yield* fetchPendingResolutionJobId()

          const first = yield* runResolutionJob({ jobId })
          expect(first.outcome).toBe("attached")

          // Simulate a crash after the decision was recorded but before the
          // job completed: the job goes back to pending and runs again at the
          // same evidence revision.
          yield* Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.assetResolutionJobs)
              .set({ status: "pending", nextRetryAt: null, workerId: null, heartbeatAt: null })
              .where(eq(schema.assetResolutionJobs.id, jobId))
          }).pipe(Effect.provide(TestPgClientLive))

          const replay = yield* runResolutionJob({ jobId })
          expect(replay.outcome).toBe("attached")

          const state = yield* fetchAttachState()
          expect(state.decisions).toHaveLength(1)
          expect(state.decisions[0]).toMatchObject({ outcome: "attach", assetId: ORB_ASSET_ID })
          expect(state.representations).toHaveLength(1)
        })
      )
  )

  it.effect(
    "resolves a second provider's observation of a settled representation without registry evidence",
    () =>
      Effect.asVoid(
        Effect.gen(function* () {
          yield* runSync()
          yield* insertOrbAsset()
          yield* recordOrbSolanaObservation()
          const firstJobId = yield* fetchPendingResolutionJobId()
          const first = yield* runResolutionJob({ jobId: firstJobId })
          expect(first.outcome).toBe("attached")

          // The registry is now unavailable; only the settled ownership can
          // resolve the second provider's observation of the same mint.
          coinGeckoMode = "terminal"
          yield* recordSecondProviderObservationOfOrbMint()
          const scheduled = yield* scheduleSecondProviderResolutionJob()
          expect(scheduled.created).toBe(true)

          const [secondJob] = yield* Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ id: schema.assetResolutionJobs.id })
              .from(schema.assetResolutionJobs)
              .where(
                eq(schema.assetResolutionJobs.providerAssetRowId, SECOND_PROVIDER_ASSET_ROW_ID)
              )
              .limit(1)
          }).pipe(Effect.provide(TestPgClientLive))
          if (secondJob === undefined) {
            throw new Error("Expected a resolution job for the second provider asset")
          }

          const second = yield* runResolutionJob({ jobId: secondJob.id })
          expect(second.outcome).toBe("attached")

          const state = yield* fetchAttachState()
          // Still exactly one ORB representation and one settled owner.
          expect(state.representations).toHaveLength(1)
          expect(state.ownershipDecisions).toHaveLength(1)

          const [secondMapping] = yield* Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                mappingStatus: schema.providerAssetMappings.mappingStatus,
                canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
              })
              .from(schema.providerAssetMappings)
              .where(
                eq(schema.providerAssetMappings.providerAssetRowId, SECOND_PROVIDER_ASSET_ROW_ID)
              )
              .limit(1)
          }).pipe(Effect.provide(TestPgClientLive))
          expect(secondMapping).toMatchObject({
            mappingStatus: "approved",
            canonicalAssetId: ORB_ASSET_ID,
          })
        })
      )
  )

  it.effect(
    "fails closed and records Jupiter evidence when a settled representation is banned",
    () =>
      Effect.asVoid(
        Effect.gen(function* () {
          yield* runSync()
          yield* insertOrbAsset()
          yield* recordOrbSolanaObservation()
          const firstJobId = yield* fetchPendingResolutionJobId()
          const first = yield* runResolutionJob({ jobId: firstJobId })
          expect(first.outcome).toBe("attached")

          coinGeckoMode = "terminal"
          jupiterMode = "banned"
          yield* recordSecondProviderObservationOfOrbMint()
          yield* scheduleSecondProviderResolutionJob()

          const [secondJob] = yield* Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ id: schema.assetResolutionJobs.id })
              .from(schema.assetResolutionJobs)
              .where(
                eq(schema.assetResolutionJobs.providerAssetRowId, SECOND_PROVIDER_ASSET_ROW_ID)
              )
              .limit(1)
          }).pipe(Effect.provide(TestPgClientLive))
          if (secondJob === undefined) {
            throw new Error("Expected a resolution job for the second provider asset")
          }

          const second = yield* runResolutionJob({ jobId: secondJob.id })
          expect(second.outcome).toBe("fail_closed")

          const result = yield* Effect.gen(function* () {
            const db = yield* drizzle
            const [mapping] = yield* db
              .select({ mappingStatus: schema.providerAssetMappings.mappingStatus })
              .from(schema.providerAssetMappings)
              .where(
                eq(schema.providerAssetMappings.providerAssetRowId, SECOND_PROVIDER_ASSET_ROW_ID)
              )
              .limit(1)
            const [decision] = yield* db
              .select({
                id: schema.assetResolutionDecisions.id,
                outcome: schema.assetResolutionDecisions.outcome,
                reason: schema.assetResolutionDecisions.reason,
              })
              .from(schema.assetResolutionDecisions)
              .where(
                eq(schema.assetResolutionDecisions.providerAssetRowId, SECOND_PROVIDER_ASSET_ROW_ID)
              )
              .limit(1)
            const evidence =
              decision === undefined
                ? []
                : yield* db
                    .select({
                      authority: schema.assetResolutionEvidence.authority,
                      decodedClaim: schema.assetResolutionEvidence.decodedClaim,
                    })
                    .from(schema.assetResolutionEvidence)
                    .where(eq(schema.assetResolutionEvidence.decisionId, decision.id))

            return { mapping, decision, evidence }
          }).pipe(Effect.provide(TestPgClientLive))

          expect(result.mapping).toMatchObject({ mappingStatus: "pending_review" })
          expect(result.decision).toMatchObject({
            outcome: "fail_closed",
            reason: "conflicting_evidence",
          })
          expect(result.evidence).toHaveLength(2)
          expect(result.evidence).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ authority: "chain" }),
              expect.objectContaining({
                authority: "jupiter",
                decodedClaim: expect.objectContaining({ verdict: "banned" }),
              }),
            ])
          )
        })
      )
  )

  it.effect("records a fail_closed decision exactly once for a terminal CoinGecko failure", () =>
    Effect.asVoid(
      Effect.gen(function* () {
        yield* runSync()
        yield* insertOrbAsset()
        yield* recordOrbSolanaObservation()
        const jobId = yield* fetchPendingResolutionJobId()

        coinGeckoMode = "terminal"
        const result = yield* runResolutionJob({ jobId })
        expect(result.outcome).toBe("fail_closed")

        const state = yield* fetchAttachState()
        expect(state.decisions).toEqual([
          expect.objectContaining({ outcome: "fail_closed", reason: "upstream_failure" }),
        ])
        expect(state.representations).toEqual([])

        const job = yield* fetchResolutionJobState({ jobId })
        expect(job.status).toBe("completed")

        const duplicate = yield* runResolutionJob({ jobId })
        expect(duplicate.outcome).toBe("already_claimed")

        const stateAfterDuplicate = yield* fetchAttachState()
        expect(stateAfterDuplicate.decisions).toHaveLength(1)
      })
    )
  )

  it.effect("excludes a Jupiter-banned mint as a final answer", () =>
    Effect.asVoid(
      Effect.gen(function* () {
        coinGeckoMode = "not_found"
        jupiterMode = "banned"

        yield* runSync()

        const pendingTax = yield* calculateTax().pipe(Effect.result)
        expect(pendingTax._tag).toBe("Failure")

        yield* recordOrbSolanaObservation()
        const jobId = yield* fetchPendingResolutionJobId()

        const result = yield* runResolutionJob({ jobId })
        expect(result.outcome).toBe("excluded")

        const state = yield* fetchAttachState()
        expect(state.mapping).toMatchObject({
          mappingStatus: "excluded",
          canonicalAssetId: null,
          assetRepresentationId: null,
        })
        expect(state.decisions).toEqual([
          expect.objectContaining({
            outcome: "excluded",
            reason: "authority_banned",
            assetId: null,
            actor: "system:asset-resolution-policy",
          }),
        ])
        expect(state.evidence).toEqual([
          expect.objectContaining({ authority: "chain", claimKind: "chain_fact" }),
          expect.objectContaining({ authority: "coingecko" }),
          expect.objectContaining({
            authority: "jupiter",
            claimKind: "legitimacy",
            sourceLocator: `jupiter://tokens/v2/search?query=${ORB_MINT}`,
            evidenceRevision: 1,
            decodedClaim: expect.objectContaining({ verdict: "banned" }),
            rawPayload: expect.objectContaining({
              payload: [expect.objectContaining({ tags: ["banned", "unknown"] })],
            }),
          }),
        ])
        expect(state.representations).toEqual([])
        expect(state.replayJobs).toContainEqual({ mode: "replay", status: "pending" })

        const replay = yield* replaySource()
        expect(replay.status).toBe("completed")

        // The excluded observation's raw transaction stays stored, but it
        // produces no factual accounting events.
        const accountingState = yield* fetchAccountingState()
        expect(accountingState.legs).toEqual([])
        expect(accountingState.rawRecords).toEqual([{ externalRecordId: "tx-orb-buy-1" }])
        expect(accountingState.transactions).toEqual([
          expect.objectContaining({
            externalId: "tx-orb-buy-1",
            sourceRawRecordId: expect.any(String),
          }),
        ])

        // The reader never falls back to mutable derived state while the
        // queued recompute has not produced an active run in this fixture.
        expect((yield* calculateTax().pipe(Effect.result))._tag).toBe("Failure")
      })
    )
  )

  it.effect(
    "supersedes an exclusion, replays stored data, and calculates from the replacement identity",
    () =>
      Effect.asVoid(
        Effect.gen(function* () {
          coinGeckoMode = "not_found"
          jupiterMode = "banned"
          yield* runSync()
          yield* recordOrbSolanaObservation()
          const jobId = yield* fetchPendingResolutionJobId()
          expect((yield* runResolutionJob({ jobId })).outcome).toBe("excluded")
          yield* insertOrbAsset({
            id: ORB_CORRECTION_ASSET_ID,
            name: "Orb Replacement",
            coingeckoCoinId: null,
          })

          const repository = yield* AssetExceptionRepository
          const observation = yield* Effect.gen(function* () {
            const db = yield* drizzle
            const [row] = yield* db
              .select({ id: schema.providerAssets.id })
              .from(schema.providerAssets)
              .where(
                and(
                  eq(schema.providerAssets.provider, "coinbase"),
                  eq(schema.providerAssets.currencyCode, "ORB")
                )
              )
              .limit(1)
            return row
          })
          if (observation === undefined) {
            return yield* Effect.die("Missing ORB observation")
          }
          const before = yield* repository.findDetail({
            _tag: "row_id",
            providerAssetRowId: observation.id,
          })
          if (Option.isNone(before) || before.value.currentConclusion === null) {
            return yield* Effect.die("Missing settled exclusion detail")
          }
          const exclusionId = before.value.currentConclusion.id
          const input = {
            providerAssetRowId: observation.id,
            claim: {
              _tag: "identity" as const,
              assetId: ORB_CORRECTION_ASSET_ID,
              newAsset: null,
              representation: {
                blockchain: "solana",
                type: "token" as const,
                contractAddress: null,
                mintAddress: ORB_MINT,
                decimals: 8,
              },
            },
            evidenceRevision: before.value.evidenceRevision,
            currentConclusionRevision: before.value.currentConclusionRevision,
            currentPolicyEvaluationRevision: before.value.currentPolicyEvaluationRevision,
            evidenceSnapshotIds: before.value.evidence.map(({ id }) => id),
            rationale: "The mint is a legitimate standalone asset despite the registry verdict.",
          }
          const preview = yield* repository.previewDecision(input)
          if (preview._tag !== "ready") {
            return yield* Effect.die(`Expected correction preview, received ${preview._tag}`)
          }
          const accepted = yield* repository.submitDecision({
            input: {
              ...input,
              expectedResultingAssetId: preview.preview.resultingAssetId,
              expectedAssetOutcome: preview.preview.assetOutcome,
              expectedRepresentationOutcome: preview.preview.representationOutcome,
            },
            actorId: userId,
          })
          expect(accepted._tag).toBe("accepted")

          const blockedTax = yield* calculateTax().pipe(Effect.result)
          expect(blockedTax._tag).toBe("Failure")
          expect((yield* replaySource()).status).toBe("completed")

          const after = yield* repository.findDetail({
            _tag: "row_id",
            providerAssetRowId: observation.id,
          })
          if (Option.isNone(after)) {
            return yield* Effect.die("Missing corrected observation detail")
          }
          expect(after.value.currentConclusion).toMatchObject({
            assetId: ORB_CORRECTION_ASSET_ID,
            outcome: "identity",
            supersedesConclusionId: exclusionId,
          })
          expect(after.value.decisionHistory).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: exclusionId, outcome: "excluded" }),
              expect.objectContaining({
                outcome: "identity",
                supersedesConclusionId: exclusionId,
              }),
            ])
          )
          expect(after.value.rematerialization).toMatchObject({ status: "complete" })

          const accountingState = yield* fetchAccountingState()
          expect(accountingState.legs).toEqual([
            expect.objectContaining({
              assetId: ORB_CORRECTION_ASSET_ID,
              kind: "acquisition",
              derivationRule: "coinbase_buy",
            }),
          ])
          expect((yield* calculateTax().pipe(Effect.result))._tag).toBe("Failure")
        }).pipe(Effect.provide(TestLayer))
      )
  )

  it.effect("keeps an exclusion settled when a later job runs at a new evidence revision", () =>
    Effect.asVoid(
      Effect.gen(function* () {
        coinGeckoMode = "not_found"
        jupiterMode = "banned"

        yield* runSync()
        yield* recordOrbSolanaObservation()
        const jobId = yield* fetchPendingResolutionJobId()

        const first = yield* runResolutionJob({ jobId })
        expect(first.outcome).toBe("excluded")

        const duplicate = yield* runResolutionJob({ jobId })
        expect(duplicate.outcome).toBe("already_claimed")

        // Jupiter un-bans the mint and the observation's evidence changes.
        // The new policy evaluation reopens review without touching the
        // recorded exclusion, because reversal still requires a human.
        jupiterMode = "unverified"
        const secondJobId = "00000000-4000-4000-8000-000000000771"
        yield* Effect.gen(function* () {
          const db = yield* drizzle
          const [providerAsset] = yield* db
            .select({ id: schema.providerAssets.id })
            .from(schema.providerAssets)
            .where(
              and(
                eq(schema.providerAssets.provider, "coinbase"),
                eq(schema.providerAssets.currencyCode, "ORB")
              )
            )
            .limit(1)
          if (providerAsset === undefined) {
            return yield* Effect.die("Missing ORB provider asset fixture")
          }

          yield* db
            .update(schema.providerAssets)
            .set({ evidenceRevision: 2 })
            .where(eq(schema.providerAssets.id, providerAsset.id))
          yield* db.insert(schema.assetResolutionJobs).values({
            id: secondJobId,
            providerAssetRowId: providerAsset.id,
            evidenceRevision: 2,
            policyRevision: ASSET_RESOLUTION_POLICY_REVISION,
            status: "pending",
          })
        }).pipe(Effect.provide(TestPgClientLive))

        const second = yield* runResolutionJob({ jobId: secondJobId })
        expect(second.outcome).toBe("pending")

        const state = yield* fetchAttachState()
        expect(state.mapping).toMatchObject({ mappingStatus: "excluded" })
        expect(state.decisions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ outcome: "excluded" }),
            expect.objectContaining({ outcome: "pending" }),
          ])
        )
        expect(state.decisions).toHaveLength(2)
        expect(state.representations).toEqual([])

        const secondJob = yield* fetchResolutionJobState({ jobId: secondJobId })
        expect(secondJob.status).toBe("completed")

        // Compatible registry evidence at another later revision is still
        // only a policy evaluation. It must not replace the settled human
        // conclusion or mutate its mapping projection automatically.
        yield* insertOrbAsset()
        coinGeckoMode = "success"
        const thirdJobId = "00000000-4000-4000-8000-000000000773"
        yield* Effect.gen(function* () {
          const db = yield* drizzle
          const [providerAsset] = yield* db
            .select({ id: schema.providerAssets.id })
            .from(schema.providerAssets)
            .where(
              and(
                eq(schema.providerAssets.provider, "coinbase"),
                eq(schema.providerAssets.currencyCode, "ORB")
              )
            )
            .limit(1)
          if (providerAsset === undefined) {
            return yield* Effect.die("Missing ORB provider asset fixture")
          }

          yield* db
            .update(schema.providerAssets)
            .set({ evidenceRevision: 3 })
            .where(eq(schema.providerAssets.id, providerAsset.id))
          yield* db.insert(schema.assetResolutionJobs).values({
            id: thirdJobId,
            providerAssetRowId: providerAsset.id,
            evidenceRevision: 3,
            policyRevision: ASSET_RESOLUTION_POLICY_REVISION,
            status: "pending",
          })
        }).pipe(Effect.provide(TestPgClientLive))

        const third = yield* runResolutionJob({ jobId: thirdJobId })
        expect(third.outcome).toBe("evaluated")

        const conclusiveState = yield* fetchAttachState()
        expect(conclusiveState.mapping).toMatchObject({ mappingStatus: "excluded" })
        expect(conclusiveState.representations).toEqual([])
        const exclusion = conclusiveState.decisions.find(({ outcome }) => outcome === "excluded")
        const laterAttach = conclusiveState.decisions.find(({ outcome }) => outcome === "attach")
        expect(exclusion).toMatchObject({
          id: exclusion?.currentConclusionId,
        })
        expect(laterAttach).toMatchObject({
          assetId: ORB_ASSET_ID,
          assetRepresentationId: null,
          id: laterAttach?.currentPolicyEvaluationId,
        })
        expect(laterAttach?.id).not.toBe(laterAttach?.currentConclusionId)
      })
    )
  )

  it.effect(
    "keeps a conclusive reevaluation of a trusted fiat mapping out of the conclusion pointer",
    () =>
      Effect.asVoid(
        Effect.gen(function* () {
          coinGeckoMode = "not_found"
          jupiterMode = "banned"

          yield* runSync()
          yield* recordOrbSolanaObservation()
          const jobId = yield* fetchPendingResolutionJobId()

          // Trusted reference mappings are seeded as approved without any
          // decision history, so they have no conclusion. Approve the mapping
          // as fiat directly to reproduce that state before the job runs.
          const providerAssetRowId = yield* Effect.gen(function* () {
            const db = yield* drizzle
            const [providerAsset] = yield* db
              .select({ id: schema.providerAssets.id })
              .from(schema.providerAssets)
              .where(
                and(
                  eq(schema.providerAssets.provider, "coinbase"),
                  eq(schema.providerAssets.currencyCode, "ORB")
                )
              )
              .limit(1)
            if (providerAsset === undefined) {
              return yield* Effect.die("Missing ORB provider asset fixture")
            }

            const [mapping] = yield* db
              .update(schema.providerAssetMappings)
              .set({
                mappingKind: "fiat",
                canonicalAssetId: null,
                canonicalFiatCurrency: "EUR",
                mappingStatus: "approved",
              })
              .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAsset.id))
              .returning({ id: schema.providerAssetMappings.id })
            if (mapping === undefined) {
              return yield* Effect.die("Missing ORB provider asset mapping fixture")
            }
            return providerAsset.id
          }).pipe(Effect.provide(TestPgClientLive))

          const result = yield* runResolutionJob({ jobId })
          expect(result.outcome).toBe("evaluated")

          // The conclusive evaluation must stay a policy evaluation: filling
          // the empty conclusion pointer would read as agreement and hide the
          // reclassified mapping from exception review.
          const state = yield* fetchAttachState()
          expect(state.mapping).toMatchObject({ mappingStatus: "approved" })
          expect(state.decisions).toEqual([
            expect.objectContaining({
              outcome: "excluded",
              currentConclusionId: null,
            }),
          ])
          const evaluation = state.decisions[0]
          expect(evaluation?.id).toBe(evaluation?.currentPolicyEvaluationId)

          const repository = yield* AssetExceptionRepository
          const detail = yield* repository.findDetail({
            _tag: "row_id",
            providerAssetRowId,
          })
          expect(Option.getOrNull(detail)).toMatchObject({
            currentConclusion: null,
            currentPolicyEvaluation: { id: evaluation?.id, outcome: "excluded" },
          })

          // With no conclusion to compare, the conclusive evaluation must
          // still rank as a disagreement in the exception queue.
          const listed = yield* repository.listExceptions({
            cursor: null,
            limit: 10,
            query: null,
          })
          expect(listed).toEqual([
            expect.objectContaining({
              providerAssetRowId,
              reason: "conclusion_disagreement",
            }),
          ])
        }).pipe(Effect.provide(TestLayer))
      )
  )

  it.effect("fails closed when Jupiter bans a mint that exact registry evidence would attach", () =>
    Effect.asVoid(
      Effect.gen(function* () {
        jupiterMode = "banned"

        yield* runSync()
        yield* insertOrbAsset()
        yield* recordOrbSolanaObservation()
        const jobId = yield* fetchPendingResolutionJobId()

        const result = yield* runResolutionJob({ jobId })
        expect(result.outcome).toBe("fail_closed")

        const state = yield* fetchAttachState()
        expect(state.mapping).toMatchObject({ mappingStatus: "pending_review" })
        expect(state.decisions).toEqual([
          expect.objectContaining({ outcome: "fail_closed", reason: "conflicting_evidence" }),
        ])
        expect(state.representations).toEqual([])
      })
    )
  )

  it.effect("pauses on suspicious signals but creates when a later signal is verified", () =>
    Effect.asVoid(
      Effect.gen(function* () {
        coinGeckoMode = "not_found"
        jupiterMode = "suspicious"

        yield* runSync()
        yield* recordOrbSolanaObservation()
        const jobId = yield* fetchPendingResolutionJobId()

        const suspicious = yield* runResolutionJob({ jobId })
        expect(suspicious.outcome).toBe("pending")

        const state = yield* fetchAttachState()
        expect(state.mapping).toMatchObject({ mappingStatus: "pending_review" })
        expect(state.decisions).toEqual([
          expect.objectContaining({ outcome: "pending", reason: "spam_evidence" }),
        ])

        // A suspicious-only observation keeps blocking the calculation: it
        // is an open question, not a final exclusion.
        const blockedTax = yield* calculateTax().pipe(Effect.result)
        expect(blockedTax._tag).toBe("Failure")

        // A later verified verdict vouches for the token: the same
        // observation at a new evidence revision follows the normal
        // standalone-create path.
        jupiterMode = "verified"
        const secondJobId = "00000000-4000-4000-8000-000000000772"
        yield* Effect.gen(function* () {
          const db = yield* drizzle
          const [providerAsset] = yield* db
            .select({ id: schema.providerAssets.id })
            .from(schema.providerAssets)
            .where(
              and(
                eq(schema.providerAssets.provider, "coinbase"),
                eq(schema.providerAssets.currencyCode, "ORB")
              )
            )
            .limit(1)
          if (providerAsset === undefined) {
            return yield* Effect.die("Missing ORB provider asset fixture")
          }

          yield* db
            .update(schema.providerAssets)
            .set({ evidenceRevision: 2 })
            .where(eq(schema.providerAssets.id, providerAsset.id))
          yield* db.insert(schema.assetResolutionJobs).values({
            id: secondJobId,
            providerAssetRowId: providerAsset.id,
            evidenceRevision: 2,
            policyRevision: ASSET_RESOLUTION_POLICY_REVISION,
            status: "pending",
          })
        }).pipe(Effect.provide(TestPgClientLive))

        const verified = yield* runResolutionJob({ jobId: secondJobId })
        expect(verified.outcome).toBe("created")

        const verifiedState = yield* fetchAttachState()
        expect(verifiedState.mapping).toMatchObject({ mappingStatus: "approved" })
        expect(verifiedState.representations).toEqual([
          expect.objectContaining({ type: "token", mintAddress: ORB_MINT, decimals: 8 }),
        ])
      })
    )
  )

  it.effect(
    "releases the job for retry on a transient Jupiter failure without recording a decision",
    () =>
      Effect.asVoid(
        Effect.gen(function* () {
          coinGeckoMode = "not_found"
          jupiterMode = "retryable"

          yield* runSync()
          yield* recordOrbSolanaObservation()
          const jobId = yield* fetchPendingResolutionJobId()

          const failed = yield* runResolutionJob({ jobId }).pipe(Effect.result)
          expect(failed._tag).toBe("Failure")
          if (failed._tag === "Failure") {
            expect(failed.failure).toMatchObject({
              _tag: "AssetResolutionEvidenceRetryableError",
              source: "jupiter",
              status: 429,
            })
          }

          const stateAfterFailure = yield* fetchAttachState()
          expect(stateAfterFailure.decisions).toEqual([])

          const jobAfterFailure = yield* fetchResolutionJobState({ jobId })
          expect(jobAfterFailure.status).toBe("pending")
          expect(jobAfterFailure.nextRetryAt).not.toBeNull()

          // Once Jupiter recovers, the same job reaches the exclusion a
          // first-attempt success would have.
          jupiterMode = "banned"
          yield* Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.assetResolutionJobs)
              .set({
                nextRetryAt: DateTime.toDateUtc(
                  DateTime.subtractDuration(yield* DateTime.now, "1 second")
                ),
              })
              .where(eq(schema.assetResolutionJobs.id, jobId))
          }).pipe(Effect.provide(TestPgClientLive))

          const retried = yield* runResolutionJob({ jobId })
          expect(retried.outcome).toBe("excluded")
        })
      )
  )
})
