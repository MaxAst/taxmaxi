import { prepareMovementLegFixtures } from "../support/movement-leg-fixtures.ts"
import * as DateTime from "effect/DateTime"
import { asc, eq, inArray, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { AuthUserId } from "@my/core/authentication"
import { PrincipalId } from "@my/core/ownership"
import { AssetRepositoryLive } from "../../src/layers/AssetRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { AssetResolutionJobRepositoryLive } from "../../src/layers/AssetResolutionJobRepositoryLive.ts"
import { ProviderAssetRepositoryLive } from "../../src/layers/ProviderAssetRepositoryLive.ts"
import { ProviderReferenceRepositoryLive } from "../../src/layers/ProviderReferenceRepositoryLive.ts"
import { PrincipalAssetOverrideRepositoryLive } from "../../src/layers/PrincipalAssetOverrideRepositoryLive.ts"
import { SourceNormalizationRepositoryLive } from "../../src/layers/SourceNormalizationRepositoryLive.ts"
import { SourceRawRecordRepositoryLive } from "../../src/layers/SourceRawRecordRepositoryLive.ts"
import { SourceReplayRepositoryLive } from "../../src/layers/SourceReplayRepositoryLive.ts"
import { schema } from "../../src/schema/index.ts"
import { PrincipalAssetOverrideRepository } from "../../src/services/PrincipalAssetOverrideRepository.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_BTC_REPRESENTATION_ID,
  TEST_RAW_RECORD_ID,
  TEST_SOURCE_ID,
  TEST_PRINCIPAL_ID,
  makeIntegrationTestDatabaseContext,
  type SyncEngineRepositoryFixture,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"
import {
  SourceNormalizationRepository,
  SourceReplayRepository,
  SourceSyncCreditExhaustedError,
  SyncEngineStorageError,
  type SourceTransactionReviewDraft,
  type SourceMovementIdentity,
} from "@my/sync-engine/services"
import {
  CoinbaseLegDerivationServiceLive,
  CoinbaseRecordNormalizerLive,
  CoinbaseReferenceDataService,
  CoinbaseReferenceDataServiceLive,
  CoinbaseReferenceMappingServiceLive,
  CoinbaseSourceSyncProvider,
  CoinbaseSourceSyncProviderLive,
  CoinbaseSyncClient,
  resolveCoinbasePrimaryAsset,
} from "@my/sync-engine/providers/coinbase"
import type { SourceRawRecord, SourceSyncSource } from "@my/sync-engine/services"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_source_normalization_repo",
})

const runPg = context.runPg
await Effect.runPromise(context.recreateTestDatabase())

const loadSourceRepresentationUses = (sourceId: string) =>
  runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      return yield* db
        .select({
          representationType: schema.sourceRepresentationUses.representationType,
          contractAddress: schema.sourceRepresentationUses.contractAddress,
          mintAddress: schema.sourceRepresentationUses.mintAddress,
        })
        .from(schema.sourceRepresentationUses)
        .where(eq(schema.sourceRepresentationUses.sourceId, sourceId))
        .orderBy(
          asc(schema.sourceRepresentationUses.representationType),
          asc(schema.sourceRepresentationUses.contractAddress),
          asc(schema.sourceRepresentationUses.mintAddress)
        )
    })
  )

const runRepository = <A, E>(effect: Effect.Effect<A, E, SourceNormalizationRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: SourceNormalizationRepositoryLive }))

const runReplayRepository = <A, E>(effect: Effect.Effect<A, E, SourceReplayRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: SourceReplayRepositoryLive }))

const SourceAndOverrideRepositoryTestLayer = Layer.mergeAll(
  SourceNormalizationRepositoryLive,
  PrincipalAssetOverrideRepositoryLive
)

const runSourceAndOverrideRepositories = <A, E>(
  effect: Effect.Effect<A, E, SourceNormalizationRepository | PrincipalAssetOverrideRepository>
) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: SourceAndOverrideRepositoryTestLayer }))

const CoinbaseSyncClientTestLive = Layer.succeed(CoinbaseSyncClient, {
  fetchAccountsPage: () => Effect.die("CoinbaseSyncClient test stub: fetchAccountsPage"),
  fetchTransactionsPage: () => Effect.die("CoinbaseSyncClient test stub: fetchTransactionsPage"),
  fetchFiatCurrencies: Effect.succeed([
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
  ] as const),
  fetchCryptoCurrencies: Effect.succeed([
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
      currencyCode: "SOL",
      name: "Solana",
      providerAssetId: "sol-provider-asset",
      exponent: 9,
      providerType: "crypto",
      payload: {
        code: "SOL",
        name: "Solana",
        exponent: 9,
        type: "crypto",
        asset_id: "sol-provider-asset",
      },
    },
  ] as const),
})

const CoinbaseReferenceMappingWithDepsLive = CoinbaseReferenceMappingServiceLive.pipe(
  Layer.provide(AssetResolutionJobRepositoryLive),
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
  Layer.provide(AssetRepositoryLive),
  Layer.provide(ProviderAssetRepositoryLive),
  Layer.provide(ProviderReferenceRepositoryLive),
  Layer.provide(SourceRawRecordRepositoryLive)
)

const CoinbaseNormalizationTestLayer = Layer.mergeAll(
  SourceNormalizationRepositoryLive,
  CoinbaseReferenceDataWithDepsLive,
  CoinbaseSourceSyncProviderWithDepsLive
)

const runCoinbaseNormalization = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    CoinbaseReferenceDataService | CoinbaseSourceSyncProvider | SourceNormalizationRepository
  >
) => Effect.runPromise(context.runWithLayer({ effect, layer: CoinbaseNormalizationTestLayer }))

const APPROVED_MAPPING = {
  providerTransactionType: "buy",
  transactionType: "buy_fiat",
  inventoryEffect: "acquisition",
  taxTreatment: "non_taxable_by_default",
  resolutionStrategy: "static",
  pairedRecordRequired: false,
  mappingStatus: "approved",
} as const

const OVERRIDE_ASSET_ID = "00000000-0000-4000-8000-000000000482"
const SECOND_OVERRIDE_SOURCE_ID = "00000000-0000-4000-8000-000000000282"
const CONCURRENT_USER_ID = "00000000-0000-4000-8000-000000000483"
const CONCURRENT_PRINCIPAL_ID = "00000000-0000-4000-8000-000000000484"
const CONCURRENT_SOURCE_A_ID = "00000000-0000-4000-8000-000000000485"
const CONCURRENT_SOURCE_B_ID = "00000000-0000-4000-8000-000000000486"
const SECOND_PRINCIPAL_USER_ID = "00000000-0000-4000-8000-000000000487"
const SECOND_PRINCIPAL_ID = "00000000-0000-4000-8000-000000000488"
const SECOND_PRINCIPAL_SOURCE_ID = "00000000-0000-4000-8000-000000000489"
const PROVIDER_OVERRIDE_ASSET_ID = "00000000-0000-4000-8000-000000000490"
const SECOND_PROVIDER_OVERRIDE_ASSET_ID = "00000000-0000-4000-8000-000000000491"
const PROVIDER_ASSET_ROW_A_ID = "00000000-0000-4000-8000-000000000492"
const PROVIDER_ASSET_ROW_B_ID = "00000000-0000-4000-8000-000000000493"
const PROVIDER_ASSET_ROW_EXCLUDED_ID = "00000000-0000-4000-8000-000000000494"
const PROVIDER_ASSET_ROW_USER_EXCLUDED_ID = "00000000-0000-4000-8000-000000000495"
const PROVIDER_ASSET_ROW_UNRESOLVED_ID = "00000000-0000-4000-8000-000000000498"
const PROVIDER_ASSET_ROW_UNSUPPORTED_ID = "00000000-0000-4000-8000-000000000499"

const seedExactIdentityOverride = ({
  fixture,
  reason,
}: {
  readonly fixture: SyncEngineRepositoryFixture
  readonly reason: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    yield* db
      .insert(schema.assets)
      .values({
        id: OVERRIDE_ASSET_ID,
        name: "Principal-selected asset",
        symbol: "SELECTED",
        type: "fungible",
      })
      .onConflictDoNothing({ target: schema.assets.id })
    const [target] = yield* db
      .insert(schema.principalAssetOverrideTargets)
      .values({
        principalId: TEST_PRINCIPAL_ID,
        targetKind: "representation",
        blockchainId: fixture.bitcoinBlockchainId,
        representationType: "token",
        contractAddress: "sync-engine-btc-fixture",
      })
      .returning({ id: schema.principalAssetOverrideTargets.id })
    if (target === undefined) return yield* Effect.die("Failed to create override target")

    const [override] = yield* db
      .insert(schema.principalAssetOverrides)
      .values({
        principalId: TEST_PRINCIPAL_ID,
        targetId: target.id,
        kind: "identity",
        operation: "create",
        inspectedSystemRevision: "exact-override-system-v1",
        inspectedSystemIdentity: "resolved",
        inspectedSystemAssetId: TEST_BTC_ASSET_ID,
        replacementAssetId: OVERRIDE_ASSET_ID,
        actorUserId: fixture.userId,
        reason,
      })
      .returning({ id: schema.principalAssetOverrides.id })
    if (override === undefined) return yield* Effect.die("Failed to create override")
    return { targetId: target.id, overrideId: override.id }
  })

const seedAdditionalOverrideSource = ({
  fixture,
  sourceId = SECOND_OVERRIDE_SOURCE_ID,
  principalId = TEST_PRINCIPAL_ID,
}: {
  readonly fixture: SyncEngineRepositoryFixture
  readonly sourceId?: string
  readonly principalId?: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [firstAccount] = yield* db
      .select({ cexId: schema.cexAccount.cexId })
      .from(schema.cexAccount)
      .where(eq(schema.cexAccount.id, fixture.cexAccountId))
    if (firstAccount === undefined) return yield* Effect.die("Missing first CEX account")

    const [secondAccount] = yield* db
      .insert(schema.cexAccount)
      .values({
        cexId: firstAccount.cexId,
        principalId,
        providerUserId: `override-provider-user-${sourceId}`,
        providerAccountId: `override-provider-account-${sourceId}`,
      })
      .returning({ id: schema.cexAccount.id })
    if (secondAccount === undefined) return yield* Effect.die("Failed to create provider account")

    yield* db.insert(schema.sources).values({
      id: sourceId,
      principalId,
      name: "Additional exact representation provider",
      providerKey: `exact-provider-${sourceId}`,
      sourceableType: "cex",
      cexAccountId: secondAccount.id,
    })
    return secondAccount.id
  })

interface ExactOverrideArtifactOptions {
  readonly movementIdentities?: ReadonlyArray<SourceMovementIdentity>
  readonly movementKind?: "acquisition" | "fee"
  readonly beforePersist?: Effect.Effect<void>
  readonly sourceId?: string
  readonly cexAccountId?: string
  readonly includeCanonicalTransfer?: boolean
  readonly inputAssetId?: string
  readonly principalId?: string
  readonly providerObservedRepresentationType?: "native" | "token" | "nft" | null
  readonly sourceRawRecordId?: string | null
}

const persistExactOverrideArtifact = ({
  externalId,
  fixture,
  occurredAt,
  sourceId = TEST_SOURCE_ID,
  cexAccountId = fixture.cexAccountId,
  includeCanonicalTransfer = true,
  inputAssetId = TEST_BTC_ASSET_ID,
  principalId = TEST_PRINCIPAL_ID,
  providerObservedRepresentationType = "token",
  sourceRawRecordId = null,
  beforePersist,
  movementIdentities,
  movementKind = "acquisition",
}: ExactOverrideArtifactOptions & {
  readonly externalId: string
  readonly fixture: SyncEngineRepositoryFixture
  readonly occurredAt: Date
}) =>
  runRepository(
    Effect.flatMap(SourceNormalizationRepository, (repository) =>
      repository.persistNormalizedArtifacts({
        ...(beforePersist === undefined ? {} : { beforePersist }),
        transaction: {
          sourceId,
          sourceRawRecordId,
          externalId: `${externalId}-transaction`,
          externalGroupId: externalId,
          timestamp: occurredAt,
          transactionType: "buy_fiat",
          providerTransactionType: "buy",
          providerStatus: "completed",
          providerResourcePath: `/test/${externalId}`,
          providerDescription: "Exact representation override fixture",
          providerCreatedAt: occurredAt,
          providerUpdatedAt: occurredAt,
          metadata: { evidence: externalId },
          providerFiatAmount: null,
          providerFiatCurrency: null,
          principalId,
        },
        venueContext: {
          venueType: "cex",
          cexAccountId,
          externalAccountId: "coinbase-account-1",
          externalOrderId: null,
          externalFillId: null,
          side: "buy",
          instrument: "BTC-EUR",
          fillPrice: "10000",
          commissionAmount: null,
          commissionCurrency: null,
          metadata: { evidence: externalId },
        },
        providerTransfers: [
          {
            sourceId,
            sourceRawRecordId,
            externalId: `${externalId}-evidence`,
            externalGroupId: externalId,
            providerAssetId: null,
            timestamp: occurredAt,
            direction: "inbound",
            processingMode: "evidence_only",
            fromAccountRef: "external",
            toAccountRef: "owned",
            fromAddress: null,
            toAddress: null,
            networkName: "bitcoin",
            networkHash: `${externalId}-hash`,
            observedBlockchainId: fixture.bitcoinBlockchainId,
            observedRepresentationType: providerObservedRepresentationType,
            observedContractAddress: "sync-engine-btc-fixture",
            observedMintAddress: null,
            observedDecimals: 8,
            amount: "1",
            metadata: { evidence: externalId },
          },
        ],
        canonicalTransfers: includeCanonicalTransfer
          ? [
              {
                sourceId,
                principalId,
                sourceRawRecordId,
                externalId: `${externalId}-transfer`,
                externalGroupId: externalId,
                addressId: null,
                blockchainId: fixture.bitcoinBlockchainId,
                txHash: null,
                timestamp: occurredAt,
                type: "cex",
                fromAddress: null,
                toAddress: null,
                fromAccountRef: "external",
                toAccountRef: "owned",
                fromPartyType: null,
                fromPartyResourcePath: null,
                toPartyType: null,
                toPartyResourcePath: null,
                assetId: inputAssetId,
                assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
                amount: "1",
                tokenId: null,
                notes: null,
                metadata: { evidence: externalId },
              },
            ]
          : [],
        providerAssetRowIds: [],
        deriveLegs: ({ transaction }) =>
          Effect.succeed(
            (
              movementIdentities ?? [
                {
                  _tag: "identified",
                  sourceRecordKey: `${externalId}-leg`,
                  componentKey: "movement",
                },
              ]
            ).map((movementIdentity, index) => ({
              movementIdentity,
              sourceId,
              sourceRawRecordId,
              externalId: index === 0 ? `${externalId}-leg` : `${externalId}-leg-${index}`,
              txHash: null,
              timestamp: occurredAt,
              principalId,
              addressId: null,
              assetId: inputAssetId,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
              amount: "1",
              kind: movementKind,
              provenance: "deterministic" as const,
              derivationRule: "exact_override_fixture",
              metadata: { evidence: externalId },
              transactionId: movementKind === "fee" ? transaction.id : null,
              originKind: "none" as const,
              providerTransferId: null,
              sourceTransferId: null,
              fiatAmount: null,
              fiatCurrency: null,
              feeForTransactionId: movementKind === "fee" ? transaction.id : null,
            }))
          ),
        transactionReview: null,
        resolvedTransactionType: APPROVED_MAPPING,
      })
    )
  )

const persistExactOverrideCallbackArtifact = ({
  externalId,
  fixture,
  kind,
  occurredAt,
  providerStatus,
  sourceId = TEST_SOURCE_ID,
  cexAccountId = fixture.cexAccountId,
  principalId = TEST_PRINCIPAL_ID,
  providerAssetRowId = null,
  assetRepresentationId = TEST_BTC_REPRESENTATION_ID,
  legUsesSourceTransferTargetOnly = false,
  includeCanonicalTransfer = true,
  beforePersist,
  deriveFailure,
}: {
  readonly externalId: string
  readonly fixture: SyncEngineRepositoryFixture
  readonly kind: "acquisition" | "fee"
  readonly occurredAt: Date
  readonly providerStatus: "pending" | "completed"
  readonly sourceId?: string
  readonly cexAccountId?: string
  readonly principalId?: string
  readonly providerAssetRowId?: string | null
  readonly assetRepresentationId?: string | null
  readonly legUsesSourceTransferTargetOnly?: boolean
  readonly includeCanonicalTransfer?: boolean
  readonly beforePersist?: Effect.Effect<void>
  readonly deriveFailure?: SyncEngineStorageError
}) =>
  runRepository(
    Effect.flatMap(SourceNormalizationRepository, (repository) =>
      repository.persistNormalizedArtifacts({
        ...(beforePersist === undefined ? {} : { beforePersist }),
        transaction: {
          sourceId,
          sourceRawRecordId: null,
          externalId: `${externalId}-transaction`,
          externalGroupId: externalId,
          timestamp: occurredAt,
          transactionType: "buy_fiat",
          providerTransactionType: "buy",
          providerStatus,
          providerResourcePath: `/test/${externalId}`,
          providerDescription: "Callback-derived exact override fixture",
          providerCreatedAt: occurredAt,
          providerUpdatedAt: occurredAt,
          metadata: { evidence: externalId },
          providerFiatAmount: null,
          providerFiatCurrency: null,
          principalId,
        },
        venueContext: {
          venueType: "cex",
          cexAccountId,
          externalAccountId: "coinbase-account-1",
          externalOrderId: null,
          externalFillId: null,
          side: "buy",
          instrument: "BTC-EUR",
          fillPrice: "10000",
          commissionAmount: null,
          commissionCurrency: null,
          metadata: { evidence: externalId },
        },
        providerTransfers: [],
        canonicalTransfers: includeCanonicalTransfer
          ? [
              {
                sourceId,
                principalId,
                sourceRawRecordId: null,
                externalId: `${externalId}-transfer`,
                externalGroupId: externalId,
                addressId: null,
                blockchainId: fixture.bitcoinBlockchainId,
                txHash: null,
                timestamp: occurredAt,
                type: "cex",
                fromAddress: null,
                toAddress: null,
                fromAccountRef: "external",
                toAccountRef: "owned",
                fromPartyType: null,
                fromPartyResourcePath: null,
                toPartyType: null,
                toPartyResourcePath: null,
                assetId: TEST_BTC_ASSET_ID,
                assetRepresentationId,
                providerAssetRowId,
                amount: "1",
                tokenId: null,
                notes: null,
                metadata: { evidence: externalId },
              },
            ]
          : [],
        providerAssetRowIds: providerAssetRowId === null ? [] : [providerAssetRowId],
        deriveLegs: ({ transaction, canonicalTransfers }) => {
          if (deriveFailure !== undefined) return Effect.fail(deriveFailure)

          const [transfer] = canonicalTransfers
          if (includeCanonicalTransfer && transfer === undefined) {
            return Effect.die("Missing callback transfer")
          }
          const assetId = transfer?.assetId ?? TEST_BTC_ASSET_ID
          const assetRepresentationId =
            transfer?.assetRepresentationId ?? TEST_BTC_REPRESENTATION_ID

          return Effect.succeed([
            {
              movementIdentity: {
                _tag: "identified" as const,
                sourceRecordKey: externalId,
                componentKey: "principal",
              },
              sourceId,
              sourceRawRecordId: null,
              externalId: `${externalId}-leg`,
              txHash: null,
              timestamp: occurredAt,
              principalId,
              addressId: null,
              assetId,
              assetRepresentationId: legUsesSourceTransferTargetOnly ? null : assetRepresentationId,
              amount: "1",
              kind,
              provenance: "deterministic" as const,
              derivationRule: "callback_exact_override_fixture",
              metadata: { derivedFromAssetId: assetId },
              transactionId: transaction.id,
              sourceTransferId: transfer?.id ?? null,
              ...(transfer === undefined
                ? { originKind: "none" as const, providerTransferId: null }
                : {}),
              fiatAmount: null,
              fiatCurrency: null,
              feeForTransactionId: kind === "fee" ? transaction.id : null,
            },
          ])
        },
        transactionReview: null,
        resolvedTransactionType: APPROVED_MAPPING,
      })
    )
  )

const loadExactOverrideEvidenceSnapshot = () =>
  runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const [rawRecord] = yield* db
        .select({
          sourceId: schema.sourceRecordsRaw.sourceId,
          externalRecordId: schema.sourceRecordsRaw.externalRecordId,
          payload: schema.sourceRecordsRaw.payload,
        })
        .from(schema.sourceRecordsRaw)
        .where(eq(schema.sourceRecordsRaw.id, TEST_RAW_RECORD_ID))
      const [providerTransfer] = yield* db
        .select({
          processingMode: schema.providerTransfers.processingMode,
          observedBlockchainId: schema.providerTransfers.observedBlockchainId,
          observedRepresentationType: schema.providerTransfers.observedRepresentationType,
          observedContractAddress: schema.providerTransfers.observedContractAddress,
          observedDecimals: schema.providerTransfers.observedDecimals,
          metadata: schema.providerTransfers.metadata,
        })
        .from(schema.providerTransfers)
        .where(eq(schema.providerTransfers.externalId, "historical-exact-evidence"))
      const [globalRepresentation] = yield* db
        .select({
          assetId: schema.assetRepresentations.assetId,
          blockchainId: schema.assetRepresentations.blockchainId,
          type: schema.assetRepresentations.type,
          contractAddress: schema.assetRepresentations.contractAddress,
        })
        .from(schema.assetRepresentations)
        .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))

      return { rawRecord, providerTransfer, globalRepresentation }
    })
  )

const seedRawRecord = ({
  rawRecordId,
  externalRecordId,
  occurredAt,
  payload,
  externalAccountId = "coinbase-account-1",
  externalParentId = null,
}: {
  readonly rawRecordId: string
  readonly externalRecordId: string
  readonly occurredAt: Date
  readonly payload?: unknown
  readonly externalAccountId?: string
  readonly externalParentId?: string | null
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    yield* db.insert(schema.sourceRecordsRaw).values({
      id: rawRecordId,
      sourceId: TEST_SOURCE_ID,
      provider: "coinbase",
      recordType: "coinbase_transaction",
      externalAccountId,
      externalRecordId,
      externalParentId,
      occurredAt,
      payload: payload ?? { id: externalRecordId },
      importedAt: occurredAt,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    })
  })

const buildCoinbaseSource = ({
  cexAccountId,
}: {
  readonly cexAccountId: string
}): SourceSyncSource => ({
  id: TEST_SOURCE_ID,
  principalId: TEST_PRINCIPAL_ID,
  providerKey: "coinbase",
  cexAccountId,
  addressId: null,
  walletAddress: null,
})

const buildSeededRawRecord = ({
  rawRecordId,
  externalRecordId,
  occurredAt,
  payload,
  externalParentId = null,
  externalAccountId = "coinbase-account-1",
}: {
  readonly rawRecordId: string
  readonly externalRecordId: string
  readonly occurredAt: Date
  readonly payload: unknown
  readonly externalParentId?: string | null
  readonly externalAccountId?: string
}): SourceRawRecord => ({
  id: rawRecordId,
  sourceId: TEST_SOURCE_ID,
  provider: "coinbase",
  recordType: "coinbase_transaction",
  externalAccountId,
  externalRecordId,
  externalParentId,
  occurredAt,
  payload,
  importedAt: occurredAt,
  normalizedAt: null,
  normalizationError: null,
  createdAt: occurredAt,
  updatedAt: occurredAt,
})

const makeCoinbaseReceivePayload = ({
  id,
  timestamp,
}: {
  readonly id: string
  readonly timestamp: Date
}) => ({
  id,
  type: "receive",
  status: "completed",
  amount: { amount: "0.25000000", currency: "BTC" },
  native_amount: { amount: "2500.00", currency: "EUR" },
  created_at: timestamp.toISOString(),
  resource_path: `/v2/accounts/coinbase-account-1/transactions/${id}`,
  from: { resource: "user", id: "coinbase-external-user" },
})

const seedCoinbaseReplayRecords = ({
  historicalRawRecordId,
  historicalPayload,
  occurredAt,
  laterRawRecordId,
  laterPayload,
  laterOccurredAt,
}: {
  readonly historicalRawRecordId: string
  readonly historicalPayload: unknown
  readonly occurredAt: Date
  readonly laterRawRecordId: string
  readonly laterPayload: unknown
  readonly laterOccurredAt: Date
}) =>
  Effect.gen(function* () {
    yield* seedRawRecord({
      rawRecordId: historicalRawRecordId,
      externalRecordId: "raw-coinbase-policy-excluded-history",
      occurredAt,
      payload: historicalPayload,
    })
    yield* seedRawRecord({
      rawRecordId: laterRawRecordId,
      externalRecordId: "raw-coinbase-policy-excluded-later",
      occurredAt: laterOccurredAt,
      payload: laterPayload,
    })
  })

const markCoinbaseBtcProviderAssetExcluded = Effect.gen(function* () {
  const db = yield* drizzle
  const [providerAsset] = yield* db
    .select({ id: schema.providerAssets.id })
    .from(schema.providerAssets)
    .where(eq(schema.providerAssets.currencyCode, "BTC"))
    .limit(1)
  if (providerAsset === undefined) return yield* Effect.die("Missing Coinbase BTC provider asset")

  yield* db
    .update(schema.providerAssetMappings)
    .set({ canonicalAssetId: null, assetRepresentationId: null, mappingStatus: "excluded" })
    .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAsset.id))
  yield* db
    .delete(schema.assetResolutionCurrentState)
    .where(eq(schema.assetResolutionCurrentState.providerAssetRowId, providerAsset.id))

  return providerAsset.id
})

const insertCoinbaseProviderOverrides = ({
  actorUserId,
  providerAssetRowId,
}: {
  readonly actorUserId: string
  readonly providerAssetRowId: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    yield* db.insert(schema.assets).values({
      id: PROVIDER_OVERRIDE_ASSET_ID,
      name: "Principal-selected excluded asset",
      symbol: "SELECTED",
      type: "fungible",
    })
    const [target] = yield* db
      .insert(schema.principalAssetOverrideTargets)
      .values({
        principalId: TEST_PRINCIPAL_ID,
        targetKind: "provider_asset",
        providerAssetRowId,
      })
      .returning({ id: schema.principalAssetOverrideTargets.id })
    if (target === undefined) return yield* Effect.die("Failed to create Coinbase override target")

    yield* db.insert(schema.principalAssetOverrides).values([
      {
        principalId: TEST_PRINCIPAL_ID,
        targetId: target.id,
        kind: "identity",
        operation: "create",
        inspectedSystemRevision: "coinbase-policy-excluded-v1",
        inspectedSystemIdentity: "unresolved",
        replacementAssetId: PROVIDER_OVERRIDE_ASSET_ID,
        actorUserId,
        reason: "Resolve the excluded Coinbase row for this principal",
      },
      {
        principalId: TEST_PRINCIPAL_ID,
        targetId: target.id,
        kind: "inclusion",
        operation: "create",
        inspectedSystemRevision: "coinbase-policy-excluded-v1",
        inspectedSystemInclusion: "excluded",
        replacementInclusion: "included",
        actorUserId,
        reason: "Include the sound excluded Coinbase row for this principal",
      },
    ])
  })

const loadCoinbasePreOverrideState = (transactionId: string) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const targetLinks = yield* db
      .select({ providerAssetRowId: schema.providerAssetTransactionUses.providerAssetRowId })
      .from(schema.providerAssetTransactionUses)
      .where(eq(schema.providerAssetTransactionUses.transactionId, transactionId))
    const movements = yield* db
      .select({ id: schema.inventoryMovements.id })
      .from(schema.inventoryMovements)
      .where(eq(schema.inventoryMovements.transactionId, transactionId))
    return { movements, targetLinks }
  })

const loadCoinbasePostOverrideState = ({
  providerAssetRowId,
  transactionIds,
}: {
  readonly providerAssetRowId: string
  readonly transactionIds: ReadonlyArray<string>
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const movements = yield* db
      .select({
        assetId: schema.inventoryMovements.assetId,
        transactionId: schema.inventoryMovements.transactionId,
      })
      .from(schema.inventoryMovements)
      .where(inArray(schema.inventoryMovements.transactionId, transactionIds))
    const [mapping] = yield* db
      .select({
        canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
        mappingStatus: schema.providerAssetMappings.mappingStatus,
      })
      .from(schema.providerAssetMappings)
      .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAssetRowId))
    return { mapping, movements }
  })

const loadProviderTransferSourceUseId = (externalId: string) =>
  runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const [providerTransfer] = yield* db
        .select({ sourceRepresentationUseId: schema.providerTransfers.sourceRepresentationUseId })
        .from(schema.providerTransfers)
        .where(eq(schema.providerTransfers.externalId, externalId))
      return providerTransfer?.sourceRepresentationUseId
    })
  )

const persistCoinbaseNormalization = ({
  source,
  sourceRecord,
  skipLegDerivation = false,
  omitProviderTransfers = false,
  omitProviderTransferObservation = false,
  providerTransferObservedBlockchainId,
  sameAssetExactSiblingBlockchainId,
  sameAssetExactSiblingPosition,
  providerTransferRole,
  includeOriginlessSibling = false,
  invalidProviderOrigin,
  refreshReferenceData = true,
}: {
  readonly source: SourceSyncSource
  readonly sourceRecord: SourceRawRecord
  readonly skipLegDerivation?: boolean
  readonly omitProviderTransfers?: boolean
  readonly omitProviderTransferObservation?: boolean
  readonly providerTransferObservedBlockchainId?: string
  readonly sameAssetExactSiblingBlockchainId?: string
  readonly sameAssetExactSiblingPosition?: "before" | "after"
  readonly providerTransferRole?: "principal" | "fee"
  readonly includeOriginlessSibling?: boolean
  readonly invalidProviderOrigin?: "mismatched_transaction" | "dual_origin"
  readonly refreshReferenceData?: boolean
}) =>
  Effect.gen(function* () {
    const referenceDataService = yield* CoinbaseReferenceDataService
    const coinbaseSourceSyncProvider = yield* CoinbaseSourceSyncProvider
    const sourceNormalizationRepository = yield* SourceNormalizationRepository

    if (refreshReferenceData) {
      yield* referenceDataService.refreshReferenceData
    }
    const lookups = yield* coinbaseSourceSyncProvider.loadNormalizationLookups
    const prepared = yield* coinbaseSourceSyncProvider.prepareNormalization({
      source,
      sourceRecord,
      lookups,
    })
    const primaryProviderTransfer =
      omitProviderTransfers || prepared.primaryProviderTransfer === null
        ? null
        : {
            ...prepared.primaryProviderTransfer,
            ...(omitProviderTransferObservation
              ? {
                  observedBlockchainId: null,
                  observedRepresentationType: null,
                  observedContractAddress: null,
                  observedMintAddress: null,
                  observedDecimals: null,
                }
              : providerTransferObservedBlockchainId === undefined
                ? {}
                : {
                    observedBlockchainId: providerTransferObservedBlockchainId,
                    observedRepresentationType: "token" as const,
                    observedContractAddress: "sync-engine-btc-fixture",
                    observedMintAddress: null,
                    observedDecimals: 8,
                  }),
            metadata:
              providerTransferRole === undefined
                ? prepared.primaryProviderTransfer.metadata
                : { role: providerTransferRole },
          }
    const exactSiblingProviderTransfer =
      primaryProviderTransfer === null ||
      sameAssetExactSiblingBlockchainId === undefined ||
      sameAssetExactSiblingPosition === undefined
        ? null
        : {
            ...primaryProviderTransfer,
            externalId: `${primaryProviderTransfer.externalId ?? sourceRecord.id}:exact-sibling`,
            processingMode: "evidence_only" as const,
            observedBlockchainId: sameAssetExactSiblingBlockchainId,
            observedRepresentationType: "token" as const,
            observedContractAddress: "sync-engine-btc-fixture",
            observedMintAddress: null,
            observedDecimals: 8,
          }
    const providerTransfers =
      primaryProviderTransfer === null
        ? []
        : exactSiblingProviderTransfer === null
          ? [primaryProviderTransfer]
          : sameAssetExactSiblingPosition === "before"
            ? [exactSiblingProviderTransfer, primaryProviderTransfer]
            : [primaryProviderTransfer, exactSiblingProviderTransfer]

    return yield* sourceNormalizationRepository.persistNormalizedArtifacts(
      (prepared.legDerivationStrategy === "derive" ||
        prepared.assetDecisionLegDerivationCandidate !== null) &&
        !skipLegDerivation
        ? {
            transaction: prepared.transaction,
            venueContext: prepared.venueContext,
            providerTransfers,
            canonicalTransfers: prepared.canonicalTransfers,
            providerAssetRowIds: prepared.providerAssetRowIds,
            transactionReview: prepared.transactionReview,
            resolvedTransactionType: prepared.resolvedTransactionType,
            deriveLegs: ({
              transaction,
              venueContext,
              providerTransferByDraft,
              canonicalTransfers,
              resolveProviderAssetDecision,
              persistProviderAssetTransferCandidate,
              withholdAccountingFacts,
            }) => {
              const persistedPrimaryProviderTransfer =
                primaryProviderTransfer === null
                  ? null
                  : providerTransferByDraft.get(primaryProviderTransfer)
              if (
                primaryProviderTransfer !== null &&
                persistedPrimaryProviderTransfer === undefined
              ) {
                return Effect.die("Missing persisted primary provider transfer")
              }

              const primaryAssetResult = resolveCoinbasePrimaryAsset({
                candidate: prepared.assetDecisionLegDerivationCandidate,
                primaryAsset: prepared.primaryAsset,
                providerAssetTarget:
                  persistedPrimaryProviderTransfer?.providerAssetId === null ||
                  persistedPrimaryProviderTransfer?.providerAssetId === undefined
                    ? prepared.assetDecisionLegDerivationCandidate === null
                      ? null
                      : {
                          _tag: "provider_asset_transaction_use",
                          providerAssetRowId:
                            prepared.assetDecisionLegDerivationCandidate.providerAssetRowId,
                        }
                    : {
                        _tag: "provider_transfer",
                        providerAssetRowId: persistedPrimaryProviderTransfer.providerAssetId,
                        sourceRepresentationUseId:
                          persistedPrimaryProviderTransfer.sourceRepresentationUseId,
                      },
                resolveProviderAssetDecision,
              })
              if (primaryAssetResult._tag === "withheld") return Effect.succeed([])

              return Effect.gen(function* () {
                const feeTransferResults = yield* Effect.forEach(
                  prepared.feeTransferCandidates,
                  (candidate) =>
                    persistProviderAssetTransferCandidate({
                      _tag: "provider_asset_transfer_candidate",
                      target: {
                        _tag: "provider_asset_transaction_use",
                        providerAssetRowId: candidate.providerAssetRowId,
                      },
                      transfer: candidate.transfer,
                    }),
                  { concurrency: 1 }
                )
                if (feeTransferResults.some(({ _tag }) => _tag !== "included")) return []

                const resolvedFeeTransfers = feeTransferResults.flatMap((result) =>
                  result._tag === "included" ? [result.transfer] : []
                )
                const legDerivation = yield* coinbaseSourceSyncProvider.deriveLegs({
                  transaction,
                  venueContext,
                  primaryAsset: primaryAssetResult.asset,
                  primaryProviderTransferId: persistedPrimaryProviderTransfer?.id ?? null,
                  canonicalTransfers: [...canonicalTransfers, ...resolvedFeeTransfers],
                  deriveMainLeg: prepared.deriveMainLeg,
                })
                if (legDerivation._tag === "withheld") {
                  withholdAccountingFacts(legDerivation.reason)
                  return []
                }
                return legDerivation.legs
              }).pipe(
                Effect.map((legs) => {
                  const completeLegs = includeOriginlessSibling
                    ? [
                        ...legs,
                        {
                          movementIdentity: {
                            _tag: "identified" as const,
                            sourceRecordKey:
                              sourceRecord.externalRecordId ?? "originless-sibling-fixture",
                            componentKey: "movement",
                          },
                          sourceId: transaction.sourceId,
                          sourceRawRecordId: transaction.sourceRawRecordId,
                          externalId: `${transaction.externalId ?? transaction.id}:unrelated`,
                          txHash: null,
                          timestamp: transaction.timestamp,
                          principalId: transaction.principalId,
                          addressId: null,
                          assetId: TEST_BTC_ASSET_ID,
                          assetRepresentationId: null,
                          amount: "0.25000000",
                          kind: "acquisition" as const,
                          provenance: "deterministic" as const,
                          derivationRule: "t10c_unrelated_sibling",
                          providerAssetRowId: prepared.providerAssetRowIds[0] ?? null,
                          metadata: { fixture: "t10c_originless_sibling" },
                          transactionId: transaction.id,
                          originKind: "none" as const,
                          providerTransferId: null,
                          sourceTransferId: null,
                          fiatAmount: null,
                          fiatCurrency: null,
                          feeForTransactionId: null,
                        },
                      ]
                    : legs

                  const [providerOriginLeg, ...remainingLegs] = completeLegs
                  if (providerOriginLeg === undefined || invalidProviderOrigin === undefined) {
                    return completeLegs
                  }

                  return [
                    {
                      ...providerOriginLeg,
                      transactionId:
                        invalidProviderOrigin === "mismatched_transaction"
                          ? "00000000-0000-4000-8000-000000000799"
                          : providerOriginLeg.transactionId,
                      sourceTransferId:
                        invalidProviderOrigin === "dual_origin"
                          ? "00000000-0000-4000-8000-000000000798"
                          : providerOriginLeg.sourceTransferId,
                    },
                    ...remainingLegs,
                  ]
                })
              )
            },
          }
        : {
            transaction: prepared.transaction,
            venueContext: prepared.venueContext,
            providerTransfers,
            canonicalTransfers: prepared.canonicalTransfers,
            providerAssetRowIds: prepared.providerAssetRowIds,
            transactionReview: prepared.transactionReview,
            resolvedTransactionType: prepared.resolvedTransactionType,
            legs: [],
          }
    )
  })

describe("SourceNormalizationRepositoryLive", () => {
  let fixture: SyncEngineRepositoryFixture

  // Shared by the credit tests: minimal billable buy artifacts for one raw record.
  const buildBuyArtifacts = ({
    externalId,
    occurredAt,
    sourceRawRecordId,
  }: {
    readonly externalId: string
    readonly occurredAt: Date
    readonly sourceRawRecordId: string
  }) =>
    ({
      transaction: {
        sourceId: TEST_SOURCE_ID,
        sourceRawRecordId,
        externalId,
        externalGroupId: null,
        timestamp: occurredAt,
        transactionType: "buy_fiat",
        providerTransactionType: "buy",
        providerStatus: "completed",
        providerResourcePath: null,
        providerDescription: null,
        providerCreatedAt: occurredAt,
        providerUpdatedAt: occurredAt,
        metadata: null,
        providerFiatAmount: null,
        providerFiatCurrency: null,
        principalId: TEST_PRINCIPAL_ID,
      },
      venueContext: {
        venueType: "cex" as const,
        cexAccountId: fixture.cexAccountId,
        externalAccountId: "coinbase-account-1",
        externalOrderId: null,
        externalFillId: null,
        side: "buy" as const,
        instrument: "BTC-EUR",
        fillPrice: "10000.00",
        commissionAmount: null,
        commissionCurrency: null,
        metadata: null,
      },
      providerTransfers: [],
      canonicalTransfers: [],
      providerAssetRowIds: [],
      legs: [],
      transactionReview: null,
      resolvedTransactionType: APPROVED_MAPPING,
    }) as const

  const seedProviderDecisionAssets = (occurredAt: Date) =>
    Effect.gen(function* () {
      const db = yield* drizzle
      yield* db.insert(schema.assets).values([
        {
          id: PROVIDER_OVERRIDE_ASSET_ID,
          name: "First provider-selected asset",
          symbol: "PROVIDER-A",
          type: "fungible",
        },
        {
          id: SECOND_PROVIDER_OVERRIDE_ASSET_ID,
          name: "Second provider-selected asset",
          symbol: "PROVIDER-B",
          type: "fungible",
        },
      ])
      yield* db.insert(schema.providerAssets).values([
        {
          id: PROVIDER_ASSET_ROW_A_ID,
          provider: "coinbase",
          providerAssetId: "duplicate-row-a",
          currencyCode: "DUP",
          name: "Duplicate row A",
          exponent: 8,
          providerType: "crypto",
          rawProviderPayload: { row: "a" },
          retrievedAt: occurredAt,
        },
        {
          id: PROVIDER_ASSET_ROW_B_ID,
          provider: "coinbase",
          providerAssetId: "duplicate-row-b",
          currencyCode: "DUP",
          name: "Duplicate row B",
          exponent: 8,
          providerType: "crypto",
          rawProviderPayload: { row: "b" },
          retrievedAt: occurredAt,
        },
        {
          id: PROVIDER_ASSET_ROW_EXCLUDED_ID,
          provider: "coinbase",
          providerAssetId: "globally-excluded-row",
          currencyCode: "EXCLUDED",
          name: "Globally excluded row",
          exponent: 8,
          providerType: "crypto",
          rawProviderPayload: { row: "excluded" },
          retrievedAt: occurredAt,
        },
        {
          id: PROVIDER_ASSET_ROW_USER_EXCLUDED_ID,
          provider: "coinbase",
          providerAssetId: "user-excluded-row",
          currencyCode: "USER-EXCLUDED",
          name: "User excluded row",
          exponent: 8,
          providerType: "crypto",
          rawProviderPayload: { row: "user-excluded" },
          retrievedAt: occurredAt,
        },
      ])
    })

  const seedProviderDecisionMappings = Effect.gen(function* () {
    const db = yield* drizzle
    yield* db.insert(schema.providerAssetMappings).values([
      {
        providerAssetRowId: PROVIDER_ASSET_ROW_A_ID,
        mappingKind: "asset",
        canonicalAssetId: TEST_BTC_ASSET_ID,
        mappingStatus: "approved",
      },
      {
        providerAssetRowId: PROVIDER_ASSET_ROW_B_ID,
        mappingKind: "asset",
        canonicalAssetId: TEST_BTC_ASSET_ID,
        mappingStatus: "approved",
      },
      {
        providerAssetRowId: PROVIDER_ASSET_ROW_EXCLUDED_ID,
        mappingKind: "asset",
        canonicalAssetId: null,
        mappingStatus: "excluded",
      },
      {
        providerAssetRowId: PROVIDER_ASSET_ROW_USER_EXCLUDED_ID,
        mappingKind: "asset",
        canonicalAssetId: TEST_BTC_ASSET_ID,
        mappingStatus: "approved",
      },
    ])
  })

  const seedProviderDecisionTargets = Effect.gen(function* () {
    const db = yield* drizzle
    const targets = yield* db
      .insert(schema.principalAssetOverrideTargets)
      .values(
        [
          PROVIDER_ASSET_ROW_A_ID,
          PROVIDER_ASSET_ROW_B_ID,
          PROVIDER_ASSET_ROW_EXCLUDED_ID,
          PROVIDER_ASSET_ROW_USER_EXCLUDED_ID,
        ].map((providerAssetRowId) => ({
          principalId: TEST_PRINCIPAL_ID,
          targetKind: "provider_asset" as const,
          providerAssetRowId,
        }))
      )
      .returning({
        id: schema.principalAssetOverrideTargets.id,
        providerAssetRowId: schema.principalAssetOverrideTargets.providerAssetRowId,
      })
    const targetByProviderAsset = new Map(
      targets.flatMap((target) =>
        target.providerAssetRowId === null ? [] : [[target.providerAssetRowId, target.id] as const]
      )
    )
    const targetA = targetByProviderAsset.get(PROVIDER_ASSET_ROW_A_ID)
    const targetB = targetByProviderAsset.get(PROVIDER_ASSET_ROW_B_ID)
    const excludedTarget = targetByProviderAsset.get(PROVIDER_ASSET_ROW_EXCLUDED_ID)
    const userExcludedTarget = targetByProviderAsset.get(PROVIDER_ASSET_ROW_USER_EXCLUDED_ID)
    if (
      targetA === undefined ||
      targetB === undefined ||
      excludedTarget === undefined ||
      userExcludedTarget === undefined
    ) {
      return yield* Effect.die("Failed to seed provider override targets")
    }
    return { targetA, targetB, excludedTarget, userExcludedTarget }
  })

  const seedProviderDecisionOverrides = ({
    targetA,
    targetB,
    excludedTarget,
    userExcludedTarget,
  }: {
    readonly targetA: string
    readonly targetB: string
    readonly excludedTarget: string
    readonly userExcludedTarget: string
  }) =>
    Effect.gen(function* () {
      const db = yield* drizzle
      yield* db.insert(schema.principalAssetOverrides).values([
        {
          principalId: TEST_PRINCIPAL_ID,
          targetId: targetA,
          kind: "identity",
          operation: "create",
          inspectedSystemRevision: "provider-row-a-v1",
          inspectedSystemIdentity: "resolved",
          inspectedSystemAssetId: TEST_BTC_ASSET_ID,
          replacementAssetId: PROVIDER_OVERRIDE_ASSET_ID,
          actorUserId: fixture.userId,
          reason: "Select the first duplicate provider row",
        },
        {
          principalId: TEST_PRINCIPAL_ID,
          targetId: targetB,
          kind: "identity",
          operation: "create",
          inspectedSystemRevision: "provider-row-b-v1",
          inspectedSystemIdentity: "resolved",
          inspectedSystemAssetId: TEST_BTC_ASSET_ID,
          replacementAssetId: SECOND_PROVIDER_OVERRIDE_ASSET_ID,
          actorUserId: fixture.userId,
          reason: "Select the second duplicate provider row",
        },
        {
          principalId: TEST_PRINCIPAL_ID,
          targetId: excludedTarget,
          kind: "identity",
          operation: "create",
          inspectedSystemRevision: "provider-row-excluded-v1",
          inspectedSystemIdentity: "unresolved",
          replacementAssetId: PROVIDER_OVERRIDE_ASSET_ID,
          actorUserId: fixture.userId,
          reason: "Resolve the excluded observation for principal accounting",
        },
        {
          principalId: TEST_PRINCIPAL_ID,
          targetId: excludedTarget,
          kind: "inclusion",
          operation: "create",
          inspectedSystemRevision: "provider-row-excluded-v1",
          inspectedSystemInclusion: "excluded",
          replacementInclusion: "included",
          actorUserId: fixture.userId,
          reason: "T12 will decide whether this global exclusion can be reversed",
        },
        {
          principalId: TEST_PRINCIPAL_ID,
          targetId: userExcludedTarget,
          kind: "inclusion",
          operation: "create",
          inspectedSystemRevision: "provider-row-user-excluded-v1",
          inspectedSystemInclusion: "included",
          replacementInclusion: "excluded",
          actorUserId: fixture.userId,
          reason: "Exclude only this provider observation",
        },
      ])
    })

  const seedProviderDecisionFixture = (occurredAt: Date) =>
    runPg(
      Effect.gen(function* () {
        const secondPrincipalFixture = yield* seedSyncEngineRepositoryFixture({
          userId: SECOND_PRINCIPAL_USER_ID,
          principalId: SECOND_PRINCIPAL_ID,
          sourceId: SECOND_PRINCIPAL_SOURCE_ID,
        })
        yield* seedProviderDecisionAssets(occurredAt)
        yield* seedProviderDecisionMappings
        const targets = yield* seedProviderDecisionTargets
        yield* seedProviderDecisionOverrides(targets)
        return secondPrincipalFixture
      })
    )

  const persistProviderDecisionArtifacts = ({
    occurredAt,
    externalId,
    principalId = TEST_PRINCIPAL_ID,
    sourceId = TEST_SOURCE_ID,
    cexAccountId = fixture.cexAccountId,
    providerTransfers = [],
    legs,
    transactionReview = null,
    transactionReviewWithoutProviderAssetMapping,
    afterProviderDecision,
  }: {
    readonly occurredAt: Date
    readonly externalId: string
    readonly principalId?: string
    readonly sourceId?: string
    readonly cexAccountId?: string
    readonly providerTransfers?: ReadonlyArray<{
      readonly providerAssetId: string
      readonly observedBlockchainId: string | null
      readonly processingMode?: "accounting_and_evidence" | "evidence_only"
      readonly direction?: "inbound" | "outbound"
      readonly role?: "principal" | "fee"
    }>
    readonly legs: ReadonlyArray<{
      readonly externalId: string
      readonly providerAssetRowId: string
      readonly assetRepresentationId?: string | null
      readonly kind?: "acquisition" | "fee"
    }>
    readonly transactionReview?: SourceTransactionReviewDraft | null
    readonly transactionReviewWithoutProviderAssetMapping?: SourceTransactionReviewDraft | null
    readonly afterProviderDecision?: Effect.Effect<void>
  }) =>
    runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts({
          transaction: {
            sourceId,
            sourceRawRecordId: null,
            externalId,
            externalGroupId: externalId,
            timestamp: occurredAt,
            transactionType: "buy_fiat",
            providerTransactionType: "buy",
            providerStatus: "completed",
            providerResourcePath: `/test/${externalId}`,
            providerDescription: "Provider fallback fixture",
            providerCreatedAt: occurredAt,
            providerUpdatedAt: occurredAt,
            metadata: { evidence: externalId },
            providerFiatAmount: null,
            providerFiatCurrency: null,
            principalId,
          },
          venueContext: {
            venueType: "cex",
            cexAccountId,
            externalAccountId: "coinbase-account-1",
            externalOrderId: null,
            externalFillId: null,
            side: "buy",
            instrument: "DUP-EUR",
            fillPrice: "100",
            commissionAmount: null,
            commissionCurrency: null,
            metadata: { evidence: externalId },
          },
          providerTransfers: providerTransfers.map((transfer, index) => ({
            sourceId,
            sourceRawRecordId: null,
            externalId: `${externalId}-provider-${index}`,
            externalGroupId: externalId,
            providerAssetId: transfer.providerAssetId,
            timestamp: occurredAt,
            direction: transfer.direction ?? ("inbound" as const),
            processingMode: transfer.processingMode ?? ("evidence_only" as const),
            fromAccountRef: "external",
            toAccountRef: "owned",
            fromAddress: null,
            toAddress: null,
            networkName: "bitcoin",
            networkHash: `${externalId}-hash-${index}`,
            observedBlockchainId: transfer.observedBlockchainId,
            observedRepresentationType:
              transfer.observedBlockchainId === null ? null : ("token" as const),
            observedContractAddress:
              transfer.observedBlockchainId === null ? null : "sync-engine-btc-fixture",
            observedMintAddress: null,
            observedDecimals: transfer.observedBlockchainId === null ? null : 8,
            amount: "1",
            metadata: { evidence: externalId, role: transfer.role ?? "principal" },
          })),
          canonicalTransfers: [],
          providerAssetRowIds: legs.map(({ providerAssetRowId }) => providerAssetRowId),
          deriveLegs: ({
            transaction,
            recordTransactionReviewWithoutProviderAssetMapping,
            resolveProviderAssetDecision,
          }) =>
            Effect.gen(function* () {
              if (transactionReviewWithoutProviderAssetMapping !== undefined) {
                recordTransactionReviewWithoutProviderAssetMapping(
                  transactionReviewWithoutProviderAssetMapping
                )
              }
              if (afterProviderDecision !== undefined) {
                const [firstLeg] = legs
                if (firstLeg === undefined) {
                  return yield* Effect.die("Missing provider decision leg for pause")
                }
                resolveProviderAssetDecision({
                  _tag: "provider_asset_transaction_use",
                  providerAssetRowId: firstLeg.providerAssetRowId,
                })
                yield* afterProviderDecision
              }
              return legs.map((leg) => ({
                movementIdentity: {
                  _tag: "identified" as const,
                  sourceRecordKey: leg.externalId,
                  componentKey: "movement",
                },
                sourceId,
                sourceRawRecordId: null,
                externalId: leg.externalId,
                txHash: null,
                timestamp: occurredAt,
                principalId,
                addressId: null,
                assetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: leg.assetRepresentationId ?? null,
                amount: "1",
                kind: leg.kind ?? "acquisition",
                provenance: "deterministic" as const,
                derivationRule: "provider_fallback_fixture",
                providerAssetRowId: leg.providerAssetRowId,
                metadata: { evidence: leg.externalId },
                transactionId: transaction.id,
                originKind: "none" as const,
                providerTransferId: null,
                sourceTransferId: null,
                fiatAmount: null,
                fiatCurrency: null,
                feeForTransactionId: leg.kind === "fee" ? transaction.id : null,
              }))
            }),
          transactionReview,
          resolvedTransactionType: APPROVED_MAPPING,
        })
      )
    )

  const persistExactPrimaryWithChainlessFeeCandidate = ({
    occurredAt,
    externalId,
    providerAssetRowId,
    withholdAfterCandidate = false,
  }: {
    readonly occurredAt: Date
    readonly externalId: string
    readonly providerAssetRowId: string
    readonly withholdAfterCandidate?: boolean
  }) =>
    runRepository(
      Effect.flatMap(SourceNormalizationRepository, (repository) =>
        repository.persistNormalizedArtifacts({
          transaction: {
            sourceId: TEST_SOURCE_ID,
            sourceRawRecordId: null,
            externalId,
            externalGroupId: externalId,
            timestamp: occurredAt,
            transactionType: "staking_reward",
            providerTransactionType: "staking_reward",
            providerStatus: "completed",
            providerResourcePath: `/test/${externalId}`,
            providerDescription: "Exact principal movement with a chainless fee candidate",
            providerCreatedAt: occurredAt,
            providerUpdatedAt: occurredAt,
            metadata: { evidence: externalId },
            providerFiatAmount: null,
            providerFiatCurrency: null,
            principalId: TEST_PRINCIPAL_ID,
          },
          venueContext: {
            venueType: "cex",
            cexAccountId: fixture.cexAccountId,
            externalAccountId: "coinbase-account-1",
            externalOrderId: null,
            externalFillId: null,
            side: null,
            instrument: null,
            fillPrice: null,
            commissionAmount: null,
            commissionCurrency: null,
            metadata: { evidence: externalId },
          },
          providerTransfers: [
            {
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId: null,
              externalId: `${externalId}-principal-provider-transfer`,
              externalGroupId: externalId,
              providerAssetId: providerAssetRowId,
              timestamp: occurredAt,
              direction: "inbound",
              processingMode: "accounting_and_evidence",
              fromAccountRef: "external",
              toAccountRef: "owned",
              fromAddress: null,
              toAddress: null,
              networkName: "bitcoin",
              networkHash: `${externalId}-hash`,
              observedBlockchainId: fixture.bitcoinBlockchainId,
              observedRepresentationType: "token",
              observedContractAddress: "sync-engine-btc-fixture",
              observedMintAddress: null,
              observedDecimals: 8,
              amount: "1",
              metadata: { role: "principal" },
            },
          ],
          canonicalTransfers: withholdAfterCandidate
            ? [
                {
                  sourceId: TEST_SOURCE_ID,
                  principalId: TEST_PRINCIPAL_ID,
                  sourceRawRecordId: null,
                  externalId: `${externalId}-ordinary-transfer`,
                  externalGroupId: externalId,
                  addressId: null,
                  blockchainId: fixture.bitcoinBlockchainId,
                  txHash: null,
                  timestamp: occurredAt,
                  type: "cex",
                  fromAddress: null,
                  toAddress: null,
                  fromAccountRef: "external",
                  toAccountRef: "owned",
                  fromPartyType: null,
                  fromPartyResourcePath: null,
                  toPartyType: null,
                  toPartyResourcePath: null,
                  assetId: TEST_BTC_ASSET_ID,
                  assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
                  providerAssetRowId,
                  amount: "1",
                  tokenId: null,
                  notes: null,
                  metadata: { role: "principal" },
                },
              ]
            : [],
          providerAssetRowIds: [providerAssetRowId],
          deriveLegs: ({
            transaction,
            providerTransfers,
            resolveProviderAssetDecision,
            persistProviderAssetTransferCandidate,
            recordProviderAssetTransferCandidateIdentity,
            withholdAccountingFacts,
          }) =>
            Effect.gen(function* () {
              const [principalProviderTransfer] = providerTransfers
              if (principalProviderTransfer === undefined) {
                return yield* Effect.die("Missing exact principal provider transfer")
              }
              const target = {
                _tag: "provider_asset_transaction_use" as const,
                providerAssetRowId,
              }
              recordProviderAssetTransferCandidateIdentity({
                sourceId: TEST_SOURCE_ID,
                externalId: `${externalId}-fee-transfer`,
              })
              const feeDecision = resolveProviderAssetDecision(target)
              if (feeDecision._tag !== "included") return []

              const feeTransfer = yield* persistProviderAssetTransferCandidate({
                _tag: "provider_asset_transfer_candidate",
                target,
                transfer: {
                  sourceId: TEST_SOURCE_ID,
                  principalId: TEST_PRINCIPAL_ID,
                  sourceRawRecordId: null,
                  externalId: `${externalId}-fee-transfer`,
                  externalGroupId: externalId,
                  addressId: null,
                  blockchainId: null,
                  txHash: null,
                  timestamp: occurredAt,
                  type: "cex",
                  fromAddress: null,
                  toAddress: null,
                  fromAccountRef: "owned",
                  toAccountRef: "provider",
                  fromPartyType: null,
                  fromPartyResourcePath: null,
                  toPartyType: null,
                  toPartyResourcePath: null,
                  assetRepresentationId: null,
                  amount: "0.01",
                  tokenId: null,
                  notes: null,
                  metadata: { role: "fee" },
                },
              })
              if (feeTransfer._tag !== "included") return []
              if (withholdAfterCandidate) {
                withholdAccountingFacts("malformed_movement")
                return []
              }

              return [
                {
                  movementIdentity: {
                    _tag: "identified" as const,
                    sourceRecordKey: `${externalId}-principal-leg`,
                    componentKey: "movement",
                  },
                  sourceId: TEST_SOURCE_ID,
                  sourceRawRecordId: null,
                  externalId: `${externalId}-principal-leg`,
                  txHash: null,
                  timestamp: occurredAt,
                  principalId: TEST_PRINCIPAL_ID,
                  addressId: null,
                  assetId: TEST_BTC_ASSET_ID,
                  assetRepresentationId: null,
                  amount: "1",
                  kind: "income" as const,
                  provenance: "deterministic" as const,
                  derivationRule: "exact_principal_with_chainless_fee_fixture",
                  providerAssetRowId,
                  metadata: null,
                  transactionId: transaction.id,
                  originKind: "provider_transfer" as const,
                  providerTransferId: principalProviderTransfer.id,
                  sourceTransferId: null,
                  fiatAmount: null,
                  fiatCurrency: null,
                  feeForTransactionId: null,
                },
                {
                  movementIdentity: {
                    _tag: "identified" as const,
                    sourceRecordKey: `${externalId}-fee-leg`,
                    componentKey: "movement",
                  },
                  sourceId: TEST_SOURCE_ID,
                  sourceRawRecordId: null,
                  externalId: `${externalId}-fee-leg`,
                  txHash: null,
                  timestamp: occurredAt,
                  principalId: TEST_PRINCIPAL_ID,
                  addressId: null,
                  assetId: feeTransfer.transfer.assetId,
                  assetRepresentationId: null,
                  amount: "0.01",
                  kind: "fee" as const,
                  provenance: "deterministic" as const,
                  derivationRule: "exact_principal_with_chainless_fee_fixture",
                  providerAssetRowId,
                  metadata: null,
                  transactionId: transaction.id,
                  originKind: "canonical_transfer" as const,
                  providerTransferId: null,
                  sourceTransferId: feeTransfer.transfer.id,
                  fiatAmount: null,
                  fiatCurrency: null,
                  feeForTransactionId: transaction.id,
                },
              ]
            }),
          transactionReview: {
            principalId: TEST_PRINCIPAL_ID,
            reviewStatus: "needs_review",
            originalTypeKey: "staking_reward",
            originalConfidence: null,
            currentTypeKey: "staking_reward",
            legalRuleSetVersion: null,
            categorizationReason: "provider fixture review",
            matchedLayer: "provider_fixture",
            needsReview: true,
            userNotes: null,
            reviewedAt: null,
          },
          resolvedTransactionType: APPROVED_MAPPING,
        })
      )
    )

  const loadProviderDecisionEvidence = () =>
    runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [review] = yield* db
          .select({
            reviewStatus: schema.transactionReviews.reviewStatus,
            matchedLayer: schema.transactionReviews.matchedLayer,
          })
          .from(schema.transactionReviews)
          .innerJoin(
            schema.transactions,
            eq(schema.transactions.id, schema.transactionReviews.transactionId)
          )
          .where(eq(schema.transactions.externalId, "provider-contradictory"))
        const mappings = yield* db
          .select({
            providerAssetRowId: schema.providerAssetMappings.providerAssetRowId,
            canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
            mappingStatus: schema.providerAssetMappings.mappingStatus,
          })
          .from(schema.providerAssetMappings)
        const providerEvidence = yield* db
          .select({ rawProviderPayload: schema.providerAssets.rawProviderPayload })
          .from(schema.providerAssets)
          .where(eq(schema.providerAssets.id, PROVIDER_ASSET_ROW_A_ID))
        return { review, mappings, providerEvidence }
      })
    )

  beforeEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* context.recreateTestDatabase()
        fixture = yield* Effect.promise(() => runPg(seedSyncEngineRepositoryFixture()))
        yield* Effect.promise(() =>
          runPg(
            seedSyncEngineAssets({
              baseBlockchainId: fixture.baseBlockchainId,
              bitcoinBlockchainId: fixture.bitcoinBlockchainId,
            })
          )
        )
        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db
                .insert(schema.assets)
                .values({
                  id: TEST_BTC_ASSET_ID,
                  name: "Bitcoin",
                  symbol: "BTC",
                  type: "fungible",
                })
                .onConflictDoNothing({ target: schema.assets.id })
            })
          )
        )
        yield* Effect.promise(() =>
          runPg(
            seedRawRecord({
              rawRecordId: TEST_RAW_RECORD_ID,
              externalRecordId: "raw-acquire-1",
              occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
            })
          )
        )
      })
    )
  )

  it.effect("records exact and provider targets again on replay", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T09:45:00.000Z"))
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderDecisionAssets(occurredAt)
            yield* seedProviderDecisionMappings
          })
        )
      )

      const providerArtifact = yield* Effect.promise(() =>
        persistExactOverrideArtifact({
          externalId: "recorded-provider-target",
          fixture,
          occurredAt,
        })
      )
      const transferArtifact = yield* Effect.promise(() =>
        persistExactOverrideCallbackArtifact({
          externalId: "recorded-transfer-target",
          fixture,
          kind: "acquisition",
          occurredAt,
          providerStatus: "pending",
          providerAssetRowId: PROVIDER_ASSET_ROW_A_ID,
          legUsesSourceTransferTargetOnly: true,
        })
      )

      const loadStoredTargets = () =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [providerTransfer] = yield* db
              .select({
                id: schema.providerTransfers.id,
                sourceRepresentationUseId: schema.providerTransfers.sourceRepresentationUseId,
              })
              .from(schema.providerTransfers)
              .where(eq(schema.providerTransfers.externalId, "recorded-provider-target-evidence"))
            const canonicalTransfers = yield* db
              .select({
                id: schema.transfers.id,
                externalId: schema.transfers.externalId,
                sourceRepresentationUseId: schema.transfers.sourceRepresentationUseId,
                providerAssetRowId: schema.transfers.providerAssetRowId,
              })
              .from(schema.transfers)
              .where(
                inArray(schema.transfers.externalId, [
                  "recorded-provider-target-transfer",
                  "recorded-transfer-target-transfer",
                ])
              )
              .orderBy(asc(schema.transfers.externalId))
            const legs = yield* db
              .select({
                id: schema.transactionLegs.id,
                externalId: schema.transactionLegs.externalId,
                assetRepresentationId: schema.transactionLegs.assetRepresentationId,
                sourceRepresentationUseId: schema.transactionLegs.sourceRepresentationUseId,
                providerAssetRowId: schema.transactionLegs.providerAssetRowId,
                metadata: schema.transactionLegs.metadata,
              })
              .from(schema.transactionLegs)
              .where(
                inArray(schema.transactionLegs.externalId, [
                  "recorded-provider-target-leg",
                  "recorded-transfer-target-leg",
                ])
              )
              .orderBy(asc(schema.transactionLegs.externalId))
            return { providerTransfer, canonicalTransfers, legs }
          })
        )
      const storedTargets = yield* Effect.promise(loadStoredTargets)
      const providerCanonicalTransfer = storedTargets.canonicalTransfers.find(
        ({ externalId }) => externalId === "recorded-provider-target-transfer"
      )
      const linkedCanonicalTransfer = storedTargets.canonicalTransfers.find(
        ({ externalId }) => externalId === "recorded-transfer-target-transfer"
      )
      const providerLeg = storedTargets.legs.find(
        ({ externalId }) => externalId === "recorded-provider-target-leg"
      )
      const linkedLeg = storedTargets.legs.find(
        ({ externalId }) => externalId === "recorded-transfer-target-leg"
      )
      const providerUseId = storedTargets.providerTransfer?.sourceRepresentationUseId
      const transferUseId = linkedCanonicalTransfer?.sourceRepresentationUseId
      expect(providerUseId).toBeTruthy()
      expect(transferUseId).toBeTruthy()
      expect(providerCanonicalTransfer?.sourceRepresentationUseId).toBe(providerUseId)
      expect(providerLeg?.sourceRepresentationUseId).toBe(providerUseId)
      expect(linkedCanonicalTransfer?.providerAssetRowId).toBe(PROVIDER_ASSET_ROW_A_ID)
      expect(linkedLeg).toMatchObject({
        assetRepresentationId: null,
        sourceRepresentationUseId: transferUseId,
        providerAssetRowId: PROVIDER_ASSET_ROW_A_ID,
      })

      const partialProviderReplay = yield* Effect.promise(() =>
        persistExactOverrideArtifact({
          externalId: "recorded-provider-target",
          fixture,
          occurredAt,
          providerObservedRepresentationType: null,
        })
      )
      expect(partialProviderReplay.providerTransfers[0]).toMatchObject({
        id: providerArtifact.providerTransfers[0]?.id,
        observedRepresentationType: "token",
        sourceRepresentationUseId: providerUseId,
      })

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.providerTransfers)
              .set({ sourceRepresentationUseId: null })
              .where(eq(schema.providerTransfers.externalId, "recorded-provider-target-evidence"))
            yield* db
              .update(schema.transfers)
              .set({ sourceRepresentationUseId: null, providerAssetRowId: null })
              .where(
                inArray(schema.transfers.externalId, [
                  "recorded-provider-target-transfer",
                  "recorded-transfer-target-transfer",
                ])
              )
            yield* db
              .update(schema.transactionLegs)
              .set({ sourceRepresentationUseId: null, providerAssetRowId: null })
              .where(
                inArray(schema.transactionLegs.externalId, [
                  "recorded-provider-target-leg",
                  "recorded-transfer-target-leg",
                ])
              )
          })
        )
      )

      const replayedProviderArtifact = yield* Effect.promise(() =>
        persistExactOverrideArtifact({
          externalId: "recorded-provider-target",
          fixture,
          occurredAt,
        })
      )
      const replayedTransferArtifact = yield* Effect.promise(() =>
        persistExactOverrideCallbackArtifact({
          externalId: "recorded-transfer-target",
          fixture,
          kind: "acquisition",
          occurredAt,
          providerStatus: "pending",
          providerAssetRowId: PROVIDER_ASSET_ROW_A_ID,
          legUsesSourceTransferTargetOnly: true,
        })
      )

      expect(replayedProviderArtifact.providerTransfers[0]?.id).toBe(
        providerArtifact.providerTransfers[0]?.id
      )
      expect(replayedTransferArtifact.canonicalTransfers[0]?.id).toBe(
        transferArtifact.canonicalTransfers[0]?.id
      )
      expect(replayedTransferArtifact.legs[0]?.id).toBe(transferArtifact.legs[0]?.id)
      expect(yield* Effect.promise(loadStoredTargets)).toEqual(storedTargets)
      expect(linkedLeg?.metadata).toEqual({ derivedFromAssetId: TEST_BTC_ASSET_ID })
    })
  )

  it.effect("keeps the canonical transaction ID stable after deletion and re-creation", () =>
    Effect.gen(function* () {
      const transaction = {
        sourceId: TEST_SOURCE_ID,
        sourceRawRecordId: TEST_RAW_RECORD_ID,
        externalId: null,
        externalGroupId: "group-stable-rematerialization",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
        transactionType: "buy_fiat",
        providerTransactionType: "buy",
        providerStatus: "completed",
        providerResourcePath:
          "/v2/accounts/coinbase-account-1/transactions/tx-stable-rematerialization",
        providerDescription: "Stable rematerialization fixture",
        providerCreatedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
        providerUpdatedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
        metadata: { provider: "coinbase" },
        providerFiatAmount: null,
        providerFiatCurrency: null,
        principalId: TEST_PRINCIPAL_ID,
      } as const
      const venueContext = {
        venueType: "cex",
        cexAccountId: fixture.cexAccountId,
        externalAccountId: "coinbase-account-1",
        externalOrderId: null,
        externalFillId: null,
        side: "buy",
        instrument: "BTC-EUR",
        fillPrice: "10000",
        commissionAmount: null,
        commissionCurrency: null,
        metadata: { provider: "coinbase" },
      } as const
      const persist = (externalId: string | null) =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts({
              transaction: { ...transaction, externalId },
              venueContext,
              providerTransfers: [],
              canonicalTransfers: [],
              providerAssetRowIds: [],
              legs: [],
              transactionReview: null,
              resolvedTransactionType: APPROVED_MAPPING,
            })
          )
        )

      const first = yield* Effect.promise(() => persist(null))
      const repeated = yield* Effect.promise(() => persist(null))
      expect(repeated.transaction.id).toBe(first.transaction.id)
      const discovered = yield* Effect.promise(() => persist("discovered-stable-external-id"))
      const corrected = yield* Effect.promise(() => persist("corrected-stable-external-id"))
      expect(discovered.transaction.id).toBe(first.transaction.id)
      expect(corrected.transaction.id).toBe(first.transaction.id)
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .delete(schema.transactions)
              .where(eq(schema.transactions.id, first.transaction.id))
          })
        )
      )
      const recreated = yield* Effect.promise(() => persist("corrected-stable-external-id"))

      expect(recreated.transaction.id).toBe(first.transaction.id)
    })
  )

  it.effect("uses one override history snapshot for a racing source write", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T09:30:00.000Z"))
      const reachedPersistHook = yield* Latch.make()
      const releasePersistHook = yield* Latch.make()
      const sourceWrite = yield* Effect.forkChild(
        Effect.promise(() =>
          persistExactOverrideArtifact({
            externalId: "racing-override-snapshot",
            fixture,
            occurredAt,
            beforePersist: Effect.gen(function* () {
              yield* reachedPersistHook.open
              yield* releasePersistHook.await
            }),
          })
        )
      )

      yield* reachedPersistHook.await
      yield* Effect.promise(() =>
        runPg(
          seedExactIdentityOverride({
            fixture,
            reason: "Commit after the source captured its override history",
          })
        )
      )
      yield* releasePersistHook.open

      const racingResult = yield* Fiber.join(sourceWrite)
      expect(racingResult.canonicalTransfers[0]).toMatchObject({
        assetId: TEST_BTC_ASSET_ID,
        assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
      })
      expect(racingResult.legs[0]?.assetId).toBe(TEST_BTC_ASSET_ID)

      const laterResult = yield* Effect.promise(() =>
        persistExactOverrideArtifact({
          externalId: "after-racing-override-snapshot",
          fixture,
          occurredAt,
        })
      )
      expect(laterResult.canonicalTransfers[0]?.assetId).toBe(OVERRIDE_ASSET_ID)
      expect(laterResult.legs[0]?.assetId).toBe(OVERRIDE_ASSET_ID)
    })
  )

  it.effect("applies captured history to a callback-derived representation", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T09:35:00.000Z"))
      const activeOverride = yield* Effect.promise(() =>
        runPg(
          seedExactIdentityOverride({
            fixture,
            reason: "Use the first selected asset for callback-derived facts",
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.assets).values({
              id: PROVIDER_OVERRIDE_ASSET_ID,
              name: "Later principal-selected asset",
              symbol: "LATER",
              type: "fungible",
            })
          })
        )
      )

      const reachedPersistHook = yield* Latch.make()
      const releasePersistHook = yield* Latch.make()
      const sourceWrite = yield* Effect.forkChild(
        Effect.promise(() =>
          persistExactOverrideCallbackArtifact({
            externalId: "racing-callback-override-snapshot",
            fixture,
            kind: "acquisition",
            occurredAt,
            providerStatus: "pending",
            includeCanonicalTransfer: false,
            beforePersist: Effect.gen(function* () {
              yield* reachedPersistHook.open
              yield* releasePersistHook.await
            }),
          })
        )
      )

      yield* reachedPersistHook.await
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.principalAssetOverrides).values({
              principalId: TEST_PRINCIPAL_ID,
              targetId: activeOverride.targetId,
              kind: "identity",
              operation: "replace",
              inspectedSystemRevision: "exact-override-system-v1",
              inspectedSystemIdentity: "resolved",
              inspectedSystemAssetId: TEST_BTC_ASSET_ID,
              replacementAssetId: PROVIDER_OVERRIDE_ASSET_ID,
              actorUserId: fixture.userId,
              reason: "Commit a later identity after the source captured history",
              supersedesOverrideId: activeOverride.overrideId,
            })
          })
        )
      )
      yield* releasePersistHook.open

      const racingResult = yield* Fiber.join(sourceWrite)
      expect(racingResult.canonicalTransfers).toEqual([])
      expect(racingResult.legs[0]).toMatchObject({
        assetId: OVERRIDE_ASSET_ID,
        assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
      })

      const laterResult = yield* Effect.promise(() =>
        persistExactOverrideCallbackArtifact({
          externalId: "after-racing-callback-override-snapshot",
          fixture,
          kind: "acquisition",
          occurredAt,
          providerStatus: "pending",
          includeCanonicalTransfer: false,
        })
      )
      expect(laterResult.legs[0]?.assetId).toBe(PROVIDER_OVERRIDE_ASSET_ID)
    })
  )

  it.effect("applies one exact identity override to replayed and future accounting facts", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:00:00.000Z"))
      const secondCexAccountId = yield* Effect.promise(() =>
        runPg(seedAdditionalOverrideSource({ fixture }))
      )
      const secondPrincipalFixture = yield* Effect.promise(() =>
        runPg(
          seedSyncEngineRepositoryFixture({
            userId: SECOND_PRINCIPAL_USER_ID,
            principalId: SECOND_PRINCIPAL_ID,
            sourceId: SECOND_PRINCIPAL_SOURCE_ID,
          })
        )
      )
      const persist = (externalId: string, options: ExactOverrideArtifactOptions = {}) =>
        persistExactOverrideArtifact({ externalId, fixture, occurredAt, ...options })

      const catalogCorrected = yield* Effect.promise(() =>
        persist("catalog-leg-only", {
          includeCanonicalTransfer: false,
          inputAssetId: OVERRIDE_ASSET_ID,
        })
      )
      expect(catalogCorrected.legs[0]?.assetId).toBe(TEST_BTC_ASSET_ID)

      const beforeOverride = yield* Effect.promise(() =>
        persist("historical-exact", { sourceRawRecordId: TEST_RAW_RECORD_ID })
      )
      expect(beforeOverride.canonicalTransfers[0]).toMatchObject({
        assetId: TEST_BTC_ASSET_ID,
        assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
      })
      const evidenceBeforeOverride = yield* Effect.promise(loadExactOverrideEvidenceSnapshot)

      const activeOverride = yield* Effect.promise(() =>
        runPg(
          seedExactIdentityOverride({
            fixture,
            reason: "Use the selected economic asset in this principal's facts",
          })
        )
      )

      const replayed = yield* Effect.promise(() =>
        persist("historical-exact", { sourceRawRecordId: TEST_RAW_RECORD_ID })
      )
      const future = yield* Effect.promise(() => persist("future-exact"))
      const secondProvider = yield* Effect.promise(() =>
        persist("second-provider-exact", {
          sourceId: SECOND_OVERRIDE_SOURCE_ID,
          cexAccountId: secondCexAccountId,
        })
      )
      const secondPrincipal = yield* Effect.promise(() =>
        persist("second-principal-exact", {
          sourceId: SECOND_PRINCIPAL_SOURCE_ID,
          cexAccountId: secondPrincipalFixture.cexAccountId,
          principalId: SECOND_PRINCIPAL_ID,
        })
      )

      for (const result of [replayed, future, secondProvider]) {
        expect(result.canonicalTransfers[0]).toMatchObject({
          assetId: OVERRIDE_ASSET_ID,
          assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
        })
        expect(result.legs[0]).toMatchObject({
          assetId: OVERRIDE_ASSET_ID,
          assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
          derivationRule: "exact_override_fixture",
        })
        expect(result.providerTransfers[0]).toMatchObject({
          processingMode: "evidence_only",
          observedBlockchainId: fixture.bitcoinBlockchainId,
          observedContractAddress: "sync-engine-btc-fixture",
        })
      }
      expect(secondPrincipal.canonicalTransfers[0]).toMatchObject({
        assetId: TEST_BTC_ASSET_ID,
        assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
      })
      expect(secondPrincipal.legs[0]?.assetId).toBe(TEST_BTC_ASSET_ID)
      expect(yield* Effect.promise(loadExactOverrideEvidenceSnapshot)).toEqual(
        evidenceBeforeOverride
      )

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.principalAssetOverrides).values({
              principalId: TEST_PRINCIPAL_ID,
              targetId: activeOverride.targetId,
              kind: "identity",
              operation: "withdraw",
              inspectedSystemRevision: "exact-override-system-v1",
              inspectedSystemIdentity: "resolved",
              inspectedSystemAssetId: TEST_BTC_ASSET_ID,
              actorUserId: fixture.userId,
              reason: "Return to the system economic identity",
              supersedesOverrideId: activeOverride.overrideId,
            })
          })
        )
      )
      const afterWithdrawal = yield* Effect.promise(() => persist("withdrawn-exact"))
      expect(afterWithdrawal.canonicalTransfers[0]).toMatchObject({
        assetId: TEST_BTC_ASSET_ID,
        assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
      })
      expect(afterWithdrawal.legs[0]?.assetId).toBe(TEST_BTC_ASSET_ID)

      const transactions = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                transactionType: schema.transactions.transactionType,
                metadata: schema.transactions.metadata,
              })
              .from(schema.transactions)
              .where(eq(schema.transactions.principalId, TEST_PRINCIPAL_ID))
          })
        )
      )
      expect(transactions).toEqual(
        expect.arrayContaining([
          {
            transactionType: "buy_fiat",
            metadata: { evidence: "historical-exact" },
          },
          {
            transactionType: "buy_fiat",
            metadata: { evidence: "future-exact" },
          },
          {
            transactionType: "buy_fiat",
            metadata: { evidence: "second-provider-exact" },
          },
        ])
      )
    })
  )

  it.effect("applies a chainless provider identity decision", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:20:00.000Z"))
      yield* Effect.promise(() => seedProviderDecisionFixture(occurredAt))

      const result = yield* Effect.promise(() =>
        persistProviderDecisionArtifacts({
          occurredAt,
          externalId: "provider-identity",
          legs: [
            { externalId: "provider-identity-leg", providerAssetRowId: PROVIDER_ASSET_ROW_A_ID },
            {
              externalId: "provider-identity-fee",
              providerAssetRowId: PROVIDER_ASSET_ROW_A_ID,
              kind: "fee",
            },
          ],
        })
      )

      const feeInventory = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ assetId: schema.inventoryMovements.assetId })
              .from(schema.inventoryMovements)
              .where(eq(schema.inventoryMovements.purpose, "fee"))
          })
        )
      )
      expect(result.legs.map(({ assetId }) => assetId)).toEqual([
        PROVIDER_OVERRIDE_ASSET_ID,
        PROVIDER_OVERRIDE_ASSET_ID,
      ])
      expect(feeInventory).toEqual([{ assetId: TEST_BTC_ASSET_ID }])
    })
  )

  it.effect("applies one chainless provider identity to its transfer and derived fee leg", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:25:00.000Z"))
      yield* Effect.promise(() => seedProviderDecisionFixture(occurredAt))

      const result = yield* Effect.promise(() =>
        persistExactOverrideCallbackArtifact({
          externalId: "provider-chainless-canonical-fee",
          fixture,
          kind: "fee",
          occurredAt,
          providerStatus: "completed",
          providerAssetRowId: PROVIDER_ASSET_ROW_A_ID,
          assetRepresentationId: null,
          legUsesSourceTransferTargetOnly: true,
        })
      )
      const [stored] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                transferAssetId: schema.transfers.assetId,
                transferProviderAssetRowId: schema.transfers.providerAssetRowId,
                legAssetId: schema.transactionLegs.assetId,
                movementAssetId: schema.inventoryMovements.assetId,
              })
              .from(schema.transactionLegs)
              .innerJoin(
                schema.transfers,
                eq(schema.transfers.id, schema.transactionLegs.sourceTransferId)
              )
              .innerJoin(
                schema.inventoryMovements,
                eq(schema.inventoryMovements.transactionLegId, schema.transactionLegs.id)
              )
              .where(eq(schema.transactionLegs.externalId, "provider-chainless-canonical-fee-leg"))
          })
        )
      )

      expect(result.canonicalTransfers[0]?.assetId).toBe(PROVIDER_OVERRIDE_ASSET_ID)
      expect(result.legs[0]?.assetId).toBe(PROVIDER_OVERRIDE_ASSET_ID)
      expect(stored).toEqual({
        transferAssetId: PROVIDER_OVERRIDE_ASSET_ID,
        transferProviderAssetRowId: PROVIDER_ASSET_ROW_A_ID,
        legAssetId: PROVIDER_OVERRIDE_ASSET_ID,
        movementAssetId: TEST_BTC_ASSET_ID,
      })
    })
  )

  it.effect("keeps a typed review when missing decimals withhold provider facts", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:30:00.000Z"))
      yield* Effect.promise(() => seedProviderDecisionFixture(occurredAt))
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.providerAssets)
              .set({ exponent: null })
              .where(eq(schema.providerAssets.id, PROVIDER_ASSET_ROW_A_ID))
          })
        )
      )

      const result = yield* Effect.promise(() =>
        persistProviderDecisionArtifacts({
          occurredAt,
          externalId: "provider-missing-decimals-review",
          legs: [
            {
              externalId: "provider-missing-decimals-review-leg",
              providerAssetRowId: PROVIDER_ASSET_ROW_A_ID,
            },
          ],
        })
      )
      const [review] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                categorizationReason: schema.transactionReviews.categorizationReason,
                matchedLayer: schema.transactionReviews.matchedLayer,
                reviewStatus: schema.transactionReviews.reviewStatus,
              })
              .from(schema.transactionReviews)
              .where(eq(schema.transactionReviews.transactionId, result.transaction.id))
          })
        )
      )

      expect(result.legs).toEqual([])
      expect(review).toMatchObject({
        matchedLayer: "principal_asset_override",
        reviewStatus: "needs_review",
      })
      expect(review?.categorizationReason).toContain("missing_decimals")
    })
  )

  it.effect("replays a sound exact representation after a principal includes it", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:15:00.000Z"))
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.assetRepresentations)
              .set({ isSpam: true })
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
          })
        )
      )

      const beforeOverride = yield* Effect.promise(() =>
        persistExactOverrideArtifact({
          externalId: "exact-policy-excluded",
          fixture,
          occurredAt,
        })
      )
      expect(beforeOverride.legs).toEqual([])

      const exactUse = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [use] = yield* db
              .select({ id: schema.sourceRepresentationUses.id })
              .from(schema.sourceRepresentationUses)
              .where(eq(schema.sourceRepresentationUses.sourceId, TEST_SOURCE_ID))
            return use
          })
        )
      )
      expect(exactUse?.id).toBeDefined()

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const { targetId } = yield* seedExactIdentityOverride({
              fixture,
              reason: "Keep the principal-selected identity for the included representation",
            })
            yield* db.insert(schema.principalAssetOverrides).values({
              principalId: TEST_PRINCIPAL_ID,
              targetId,
              kind: "inclusion",
              operation: "create",
              inspectedSystemRevision: "exact-policy-excluded-v1",
              inspectedSystemInclusion: "excluded",
              replacementInclusion: "included",
              actorUserId: fixture.userId,
              reason: "Include this sound representation for the principal",
            })
          })
        )
      )

      const replayed = yield* Effect.promise(() =>
        persistExactOverrideArtifact({
          externalId: "exact-policy-excluded",
          fixture,
          occurredAt,
        })
      )
      const storedState = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [globalRepresentation] = yield* db
              .select({
                assetId: schema.assetRepresentations.assetId,
                isSpam: schema.assetRepresentations.isSpam,
              })
              .from(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
            const [leg] = yield* db
              .select({
                sourceRepresentationUseId: schema.transactionLegs.sourceRepresentationUseId,
              })
              .from(schema.transactionLegs)
              .where(eq(schema.transactionLegs.externalId, "exact-policy-excluded-leg"))
            return { globalRepresentation, leg }
          })
        )
      )

      expect(storedState.leg?.sourceRepresentationUseId).toBe(exactUse?.id)
      expect(replayed.legs).toEqual([
        expect.objectContaining({
          assetId: OVERRIDE_ASSET_ID,
          assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
        }),
      ])
      expect(storedState.globalRepresentation).toEqual({
        assetId: TEST_BTC_ASSET_ID,
        isSpam: true,
      })
    })
  )

  it.effect("keeps exact identity ahead of a provider fallback", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:20:00.000Z"))
      yield* Effect.promise(() => seedProviderDecisionFixture(occurredAt))

      const result = yield* Effect.promise(() =>
        persistProviderDecisionArtifacts({
          occurredAt,
          externalId: "provider-exact-wins",
          providerTransfers: [
            {
              providerAssetId: PROVIDER_ASSET_ROW_USER_EXCLUDED_ID,
              observedBlockchainId: fixture.bitcoinBlockchainId,
            },
          ],
          legs: [
            {
              externalId: "provider-exact-wins-leg",
              providerAssetRowId: PROVIDER_ASSET_ROW_A_ID,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
            },
          ],
        })
      )

      expect(result.legs.map(({ assetId }) => assetId)).toEqual([TEST_BTC_ASSET_ID])
    })
  )

  it.effect("keeps exact-linked provider fee inventory on the system asset", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:20:00.000Z"))
      yield* Effect.promise(() => seedProviderDecisionFixture(occurredAt))
      yield* Effect.promise(() =>
        runPg(
          seedExactIdentityOverride({
            fixture,
            reason: "Use the selected identity for accounting but not fee custody",
          })
        )
      )

      yield* Effect.promise(() =>
        persistProviderDecisionArtifacts({
          occurredAt,
          externalId: "provider-exact-fee-system-asset",
          providerTransfers: [
            {
              providerAssetId: PROVIDER_ASSET_ROW_A_ID,
              observedBlockchainId: fixture.bitcoinBlockchainId,
              processingMode: "accounting_and_evidence",
              direction: "outbound",
              role: "fee",
            },
          ],
          legs: [
            {
              externalId: "provider-exact-fee-system-asset-leg",
              providerAssetRowId: PROVIDER_ASSET_ROW_A_ID,
              kind: "fee",
            },
          ],
        })
      )

      const [feeMovement] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                assetId: schema.inventoryMovements.assetId,
                assetRepresentationId: schema.inventoryMovements.assetRepresentationId,
                sourceRepresentationUseId: schema.providerTransfers.sourceRepresentationUseId,
              })
              .from(schema.inventoryMovements)
              .innerJoin(
                schema.providerTransfers,
                eq(schema.providerTransfers.id, schema.inventoryMovements.providerTransferId)
              )
              .where(
                eq(
                  schema.providerTransfers.externalId,
                  "provider-exact-fee-system-asset-provider-0"
                )
              )
          })
        )
      )

      expect(feeMovement?.sourceRepresentationUseId).not.toBeNull()
      expect(feeMovement?.assetId).toBe(TEST_BTC_ASSET_ID)
      expect(feeMovement?.assetRepresentationId).toBe(TEST_BTC_REPRESENTATION_ID)
    })
  )

  it.effect("does not pair provider mapping representation with a replacement asset", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:22:00.000Z"))
      yield* Effect.promise(() => seedProviderDecisionFixture(occurredAt))
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.providerAssetMappings)
              .set({ assetRepresentationId: TEST_BTC_REPRESENTATION_ID })
              .where(eq(schema.providerAssetMappings.providerAssetRowId, PROVIDER_ASSET_ROW_A_ID))
          })
        )
      )

      const result = yield* Effect.promise(() =>
        persistProviderDecisionArtifacts({
          occurredAt,
          externalId: "provider-replacement-inventory-pair",
          providerTransfers: [
            {
              providerAssetId: PROVIDER_ASSET_ROW_A_ID,
              observedBlockchainId: null,
              processingMode: "accounting_and_evidence",
            },
          ],
          legs: [
            {
              externalId: "provider-replacement-inventory-pair-leg",
              providerAssetRowId: PROVIDER_ASSET_ROW_A_ID,
            },
          ],
        })
      )
      const [movement] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                assetId: schema.inventoryMovements.assetId,
                assetRepresentationId: schema.inventoryMovements.assetRepresentationId,
              })
              .from(schema.inventoryMovements)
              .innerJoin(
                schema.providerTransfers,
                eq(schema.providerTransfers.id, schema.inventoryMovements.providerTransferId)
              )
              .where(
                eq(
                  schema.providerTransfers.externalId,
                  "provider-replacement-inventory-pair-provider-0"
                )
              )
          })
        )
      )

      expect(result.legs[0]?.assetId).toBe(PROVIDER_OVERRIDE_ASSET_ID)
      expect(movement).toEqual({
        assetId: PROVIDER_OVERRIDE_ASSET_ID,
        assetRepresentationId: null,
      })
    })
  )

  it.effect("withholds an exact-linked fact whose provider row is globally excluded", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:20:00.000Z"))
      yield* Effect.promise(() => seedProviderDecisionFixture(occurredAt))

      const result = yield* Effect.promise(() =>
        persistProviderDecisionArtifacts({
          occurredAt,
          externalId: "provider-exact-system-excluded",
          providerTransfers: [
            {
              providerAssetId: PROVIDER_ASSET_ROW_EXCLUDED_ID,
              observedBlockchainId: fixture.bitcoinBlockchainId,
              processingMode: "accounting_and_evidence",
            },
          ],
          legs: [
            {
              externalId: "provider-exact-system-excluded-leg",
              providerAssetRowId: PROVIDER_ASSET_ROW_EXCLUDED_ID,
            },
          ],
        })
      )

      const sourceUseId = yield* Effect.promise(() =>
        loadProviderTransferSourceUseId("provider-exact-system-excluded-provider-0")
      )
      const [review] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ id: schema.transactionReviews.id })
              .from(schema.transactionReviews)
              .where(eq(schema.transactionReviews.transactionId, result.transaction.id))
          })
        )
      )

      expect(sourceUseId).not.toBeNull()
      expect(result.legs).toEqual([])
      expect(review).toBeUndefined()
    })
  )

  it.effect("keeps a typed review when an exact recorded identity is unresolved", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:21:00.000Z"))
      yield* Effect.promise(() => seedProviderDecisionFixture(occurredAt))
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.assetRepresentations)
              .set({ contractAddress: "catalog-no-longer-matches-recorded-use" })
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
          })
        )
      )

      const result = yield* Effect.promise(() =>
        persistProviderDecisionArtifacts({
          occurredAt,
          externalId: "provider-exact-unresolved",
          providerTransfers: [
            {
              providerAssetId: PROVIDER_ASSET_ROW_A_ID,
              observedBlockchainId: fixture.bitcoinBlockchainId,
              processingMode: "accounting_and_evidence",
            },
          ],
          legs: [
            {
              externalId: "provider-exact-unresolved-leg",
              providerAssetRowId: PROVIDER_ASSET_ROW_A_ID,
            },
          ],
        })
      )
      const [stored] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                categorizationReason: schema.transactionReviews.categorizationReason,
                matchedLayer: schema.transactionReviews.matchedLayer,
                sourceRepresentationUseId: schema.providerTransfers.sourceRepresentationUseId,
              })
              .from(schema.providerTransfers)
              .innerJoin(
                schema.transactionReviews,
                eq(schema.transactionReviews.transactionId, result.transaction.id)
              )
              .where(
                eq(schema.providerTransfers.externalId, "provider-exact-unresolved-provider-0")
              )
          })
        )
      )

      expect(result.legs).toEqual([])
      expect(stored?.sourceRepresentationUseId).not.toBeNull()
      expect(stored?.matchedLayer).toContain("principal_asset_override")
      expect(stored?.categorizationReason).toContain("unresolved identity")
    })
  )

  it.effect("uses a persisted exact provider link when retry omits observation fields", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:20:00.000Z"))
      yield* Effect.promise(() => seedProviderDecisionFixture(occurredAt))
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.providerAssetMappings)
              .set({ canonicalAssetId: null, mappingStatus: "pending_review" })
              .where(
                eq(
                  schema.providerAssetMappings.providerAssetRowId,
                  PROVIDER_ASSET_ROW_USER_EXCLUDED_ID
                )
              )
          })
        )
      )
      const transactionReview: SourceTransactionReviewDraft = {
        principalId: TEST_PRINCIPAL_ID,
        reviewStatus: "needs_review",
        originalTypeKey: "buy_fiat",
        originalConfidence: null,
        currentTypeKey: "buy_fiat",
        legalRuleSetVersion: null,
        categorizationReason:
          "provider_asset_mapping: Coinbase provider asset mapping review is required before canonical normalization can continue for USER-EXCLUDED.",
        matchedLayer: "provider_asset_mapping",
        needsReview: true,
        userNotes: null,
        reviewedAt: null,
      }
      const artifacts = {
        occurredAt,
        externalId: "provider-exact-retry",
        transactionReview,
        transactionReviewWithoutProviderAssetMapping: null,
        legs: [
          {
            externalId: "provider-exact-retry-leg",
            providerAssetRowId: PROVIDER_ASSET_ROW_USER_EXCLUDED_ID,
            assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
          },
        ],
      } as const

      const first = yield* Effect.promise(() =>
        persistProviderDecisionArtifacts({
          ...artifacts,
          providerTransfers: [
            {
              providerAssetId: PROVIDER_ASSET_ROW_USER_EXCLUDED_ID,
              observedBlockchainId: fixture.bitcoinBlockchainId,
              processingMode: "accounting_and_evidence",
            },
          ],
        })
      )
      const firstUseId = yield* Effect.promise(() =>
        loadProviderTransferSourceUseId("provider-exact-retry-provider-0")
      )
      expect(firstUseId).not.toBeNull()
      expect(first.legs.map(({ assetId }) => assetId)).toEqual([TEST_BTC_ASSET_ID])

      const retried = yield* Effect.promise(() =>
        persistProviderDecisionArtifacts({
          ...artifacts,
          providerTransfers: [
            {
              providerAssetId: PROVIDER_ASSET_ROW_USER_EXCLUDED_ID,
              observedBlockchainId: null,
              processingMode: "accounting_and_evidence",
            },
          ],
        })
      )

      const retriedUseId = yield* Effect.promise(() =>
        loadProviderTransferSourceUseId("provider-exact-retry-provider-0")
      )
      const [review] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ id: schema.transactionReviews.id })
              .from(schema.transactionReviews)
              .where(eq(schema.transactionReviews.transactionId, retried.transaction.id))
          })
        )
      )
      expect(retriedUseId).toBe(firstUseId)
      expect(retried.legs.map(({ assetId }) => assetId)).toEqual([TEST_BTC_ASSET_ID])
      expect(review).toBeUndefined()
    })
  )

  it.effect("withholds an exact leg with a chainless excluded sibling", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:20:00.000Z"))
      yield* Effect.promise(() => seedProviderDecisionFixture(occurredAt))

      const result = yield* Effect.promise(() =>
        persistProviderDecisionArtifacts({
          occurredAt,
          externalId: "provider-exact-with-chainless-sibling",
          providerTransfers: [
            {
              providerAssetId: PROVIDER_ASSET_ROW_USER_EXCLUDED_ID,
              observedBlockchainId: fixture.bitcoinBlockchainId,
              processingMode: "accounting_and_evidence",
            },
          ],
          legs: [
            {
              externalId: "provider-exact-with-chainless-sibling-exact",
              providerAssetRowId: PROVIDER_ASSET_ROW_USER_EXCLUDED_ID,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
            },
            {
              externalId: "provider-exact-with-chainless-sibling-chainless",
              providerAssetRowId: PROVIDER_ASSET_ROW_USER_EXCLUDED_ID,
            },
          ],
        })
      )

      expect(result.legs).toEqual([])
    })
  )

  it.effect(
    "preflights a recorded chainless target even when an exact sibling shares its row",
    () =>
      Effect.gen(function* () {
        const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:20:00.000Z"))
        yield* Effect.promise(() => seedProviderDecisionFixture(occurredAt))

        const result = yield* Effect.promise(() =>
          persistExactPrimaryWithChainlessFeeCandidate({
            occurredAt,
            externalId: "exact-primary-with-excluded-chainless-fee",
            providerAssetRowId: PROVIDER_ASSET_ROW_USER_EXCLUDED_ID,
          })
        )
        const state = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const movements = yield* db
                .select({ id: schema.inventoryMovements.id })
                .from(schema.inventoryMovements)
                .where(eq(schema.inventoryMovements.transactionId, result.transaction.id))
              const [review] = yield* db
                .select({ matchedLayer: schema.transactionReviews.matchedLayer })
                .from(schema.transactionReviews)
                .where(eq(schema.transactionReviews.transactionId, result.transaction.id))
              return { movements, review }
            })
          )
        )

        expect(result.providerTransfers).toEqual([
          expect.objectContaining({
            providerAssetId: PROVIDER_ASSET_ROW_USER_EXCLUDED_ID,
            sourceRepresentationUseId: expect.any(String),
          }),
        ])
        expect(result.canonicalTransfers).toEqual([])
        expect(result.legs).toEqual([])
        expect(state.movements).toEqual([])
        expect(state.review?.matchedLayer).toContain("provider_fixture")
      })
  )

  it.effect("removes only a persisted candidate when a later malformed movement withholds", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:20:00.000Z"))
      yield* Effect.promise(() => seedProviderDecisionFixture(occurredAt))

      const result = yield* Effect.promise(() =>
        persistExactPrimaryWithChainlessFeeCandidate({
          occurredAt,
          externalId: "candidate-before-malformed-withholding",
          providerAssetRowId: PROVIDER_ASSET_ROW_A_ID,
          withholdAfterCandidate: true,
        })
      )
      const state = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const transfers = yield* db
              .select({ externalId: schema.transfers.externalId })
              .from(schema.transfers)
              .where(
                inArray(schema.transfers.externalId, [
                  "candidate-before-malformed-withholding-fee-transfer",
                  "candidate-before-malformed-withholding-ordinary-transfer",
                ])
              )
            const legs = yield* db
              .select({ id: schema.transactionLegs.id })
              .from(schema.transactionLegs)
              .where(eq(schema.transactionLegs.transactionId, result.transaction.id))
            const inventory = yield* db
              .select({ id: schema.inventoryMovements.id })
              .from(schema.inventoryMovements)
              .where(eq(schema.inventoryMovements.transactionId, result.transaction.id))
            const [review] = yield* db
              .select({
                categorizationReason: schema.transactionReviews.categorizationReason,
                matchedLayer: schema.transactionReviews.matchedLayer,
              })
              .from(schema.transactionReviews)
              .where(eq(schema.transactionReviews.transactionId, result.transaction.id))
            return { transfers, legs, inventory, review }
          })
        )
      )

      expect(result.providerTransfers).toEqual([
        expect.objectContaining({
          externalId: "candidate-before-malformed-withholding-principal-provider-transfer",
        }),
      ])
      expect(result.canonicalTransfers).toEqual([
        expect.objectContaining({
          externalId: "candidate-before-malformed-withholding-ordinary-transfer",
        }),
      ])
      expect(result.legs).toEqual([])
      expect(state.transfers).toEqual([
        { externalId: "candidate-before-malformed-withholding-ordinary-transfer" },
      ])
      expect(state.legs).toEqual([])
      expect(state.inventory).toEqual([])
      expect(state.review?.matchedLayer).toContain("principal_asset_override")
      expect(state.review?.categorizationReason).toContain("malformed_movement")
    })
  )

  it.effect("removes a prior candidate when its retry becomes technically blocked", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:20:00.000Z"))
      yield* Effect.promise(() => seedProviderDecisionFixture(occurredAt))
      const params = {
        occurredAt,
        externalId: "candidate-included-then-blocked",
        providerAssetRowId: PROVIDER_ASSET_ROW_A_ID,
      }

      const included = yield* Effect.promise(() =>
        persistExactPrimaryWithChainlessFeeCandidate(params)
      )
      expect(included.canonicalTransfers).toEqual([
        expect.objectContaining({ externalId: "candidate-included-then-blocked-fee-transfer" }),
      ])
      expect(included.legs).toHaveLength(2)

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.providerAssets)
              .set({ exponent: null })
              .where(eq(schema.providerAssets.id, PROVIDER_ASSET_ROW_A_ID))
          })
        )
      )

      const withheld = yield* Effect.promise(() =>
        persistExactPrimaryWithChainlessFeeCandidate(params)
      )
      const state = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const candidateTransfers = yield* db
              .select({ id: schema.transfers.id })
              .from(schema.transfers)
              .where(
                eq(schema.transfers.externalId, "candidate-included-then-blocked-fee-transfer")
              )
            const legs = yield* db
              .select({ id: schema.transactionLegs.id })
              .from(schema.transactionLegs)
              .where(eq(schema.transactionLegs.transactionId, withheld.transaction.id))
            const inventory = yield* db
              .select({ id: schema.inventoryMovements.id })
              .from(schema.inventoryMovements)
              .where(eq(schema.inventoryMovements.transactionId, withheld.transaction.id))
            const providerEvidence = yield* db
              .select({ id: schema.providerTransfers.id })
              .from(schema.providerTransfers)
              .where(eq(schema.providerTransfers.transactionId, withheld.transaction.id))
            return { candidateTransfers, inventory, legs, providerEvidence }
          })
        )
      )

      expect(withheld.canonicalTransfers).toEqual([])
      expect(withheld.legs).toEqual([])
      expect(state.candidateTransfers).toEqual([])
      expect(state.legs).toEqual([])
      expect(state.inventory).toEqual([])
      expect(state.providerEvidence).toHaveLength(1)
    })
  )

  it.effect("keeps exact and provider fallback identities separate for one provider row", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:20:00.000Z"))
      yield* Effect.promise(() => seedProviderDecisionFixture(occurredAt))

      const result = yield* Effect.promise(() =>
        persistExactPrimaryWithChainlessFeeCandidate({
          occurredAt,
          externalId: "exact-primary-with-provider-identity-fee",
          providerAssetRowId: PROVIDER_ASSET_ROW_A_ID,
        })
      )
      const inventory = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                assetId: schema.inventoryMovements.assetId,
                purpose: schema.inventoryMovements.purpose,
              })
              .from(schema.inventoryMovements)
              .where(eq(schema.inventoryMovements.transactionId, result.transaction.id))
          })
        )
      )

      expect(result.legs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "income",
            assetId: TEST_BTC_ASSET_ID,
          }),
          expect.objectContaining({
            kind: "fee",
            assetId: PROVIDER_OVERRIDE_ASSET_ID,
          }),
        ])
      )
      expect(result.canonicalTransfers).toEqual([
        expect.objectContaining({ assetId: PROVIDER_OVERRIDE_ASSET_ID }),
      ])
      expect(inventory).toHaveLength(2)
      expect(inventory.every(({ assetId }) => assetId === TEST_BTC_ASSET_ID)).toBe(true)
    })
  )

  it.effect("lets a sound principal inclusion reverse global provider exclusion", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:20:00.000Z"))
      yield* Effect.promise(() => seedProviderDecisionFixture(occurredAt))

      const result = yield* Effect.promise(() =>
        persistProviderDecisionArtifacts({
          occurredAt,
          externalId: "provider-system-excluded",
          legs: [
            {
              externalId: "provider-system-excluded-leg",
              providerAssetRowId: PROVIDER_ASSET_ROW_EXCLUDED_ID,
            },
          ],
        })
      )

      const targetLinks = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                providerAssetRowId: schema.providerAssetTransactionUses.providerAssetRowId,
              })
              .from(schema.providerAssetTransactionUses)
              .where(eq(schema.providerAssetTransactionUses.transactionId, result.transaction.id))
          })
        )
      )

      expect(targetLinks).toEqual([{ providerAssetRowId: PROVIDER_ASSET_ROW_EXCLUDED_ID }])
      expect(result.legs).toEqual([
        expect.objectContaining({
          assetId: PROVIDER_OVERRIDE_ASSET_ID,
          providerAssetRowId: PROVIDER_ASSET_ROW_EXCLUDED_ID,
        }),
      ])
    })
  )

  it.effect("clears only a resolved provider mapping review", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:21:00.000Z"))
      yield* Effect.promise(() => seedProviderDecisionFixture(occurredAt))
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.providerAssetMappings)
              .set({ canonicalAssetId: null, mappingStatus: "pending_review" })
              .where(
                inArray(schema.providerAssetMappings.providerAssetRowId, [
                  PROVIDER_ASSET_ROW_A_ID,
                  PROVIDER_ASSET_ROW_USER_EXCLUDED_ID,
                ])
              )
          })
        )
      )

      const mappingReason =
        "provider_asset_mapping: Coinbase provider asset mapping review is required before canonical normalization can continue for DUP."
      const makeReview = ({
        reason,
        layer,
      }: {
        readonly reason: string
        readonly layer: string
      }): SourceTransactionReviewDraft => ({
        principalId: TEST_PRINCIPAL_ID,
        reviewStatus: "needs_review",
        originalTypeKey: "buy_fiat",
        originalConfidence: null,
        currentTypeKey: "buy_fiat",
        legalRuleSetVersion: null,
        categorizationReason: reason,
        matchedLayer: layer,
        needsReview: true,
        userNotes: null,
        reviewedAt: null,
      })

      const mappingOnly = yield* Effect.promise(() =>
        persistProviderDecisionArtifacts({
          occurredAt,
          externalId: "resolved-provider-mapping-review-only",
          legs: [
            {
              externalId: "resolved-provider-mapping-review-only-leg",
              providerAssetRowId: PROVIDER_ASSET_ROW_A_ID,
            },
          ],
          transactionReview: makeReview({ reason: mappingReason, layer: "provider_asset_mapping" }),
          transactionReviewWithoutProviderAssetMapping: null,
        })
      )
      const independentReason = "Coinbase send still needs transaction-type review."
      const mappingAndIndependent = yield* Effect.promise(() =>
        persistProviderDecisionArtifacts({
          occurredAt,
          externalId: "resolved-provider-mapping-review-with-independent",
          legs: [
            {
              externalId: "resolved-provider-mapping-review-with-independent-leg",
              providerAssetRowId: PROVIDER_ASSET_ROW_A_ID,
            },
          ],
          transactionReview: makeReview({
            reason: `${independentReason} ${mappingReason}`,
            layer: "coinbase_reference_mapping,provider_asset_mapping",
          }),
          transactionReviewWithoutProviderAssetMapping: makeReview({
            reason: independentReason,
            layer: "coinbase_reference_mapping",
          }),
        })
      )
      const stillBlocked = yield* Effect.promise(() =>
        persistProviderDecisionArtifacts({
          occurredAt,
          externalId: "still-blocked-provider-mapping-review",
          legs: [
            {
              externalId: "still-blocked-provider-mapping-review-leg",
              providerAssetRowId: PROVIDER_ASSET_ROW_USER_EXCLUDED_ID,
            },
          ],
          transactionReview: makeReview({ reason: mappingReason, layer: "provider_asset_mapping" }),
          transactionReviewWithoutProviderAssetMapping: null,
        })
      )
      const reviews = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                transactionId: schema.transactionReviews.transactionId,
                categorizationReason: schema.transactionReviews.categorizationReason,
                matchedLayer: schema.transactionReviews.matchedLayer,
              })
              .from(schema.transactionReviews)
              .where(
                inArray(schema.transactionReviews.transactionId, [
                  mappingOnly.transaction.id,
                  mappingAndIndependent.transaction.id,
                  stillBlocked.transaction.id,
                ])
              )
          })
        )
      )

      expect(mappingOnly.legs).toEqual([
        expect.objectContaining({ assetId: PROVIDER_OVERRIDE_ASSET_ID }),
      ])
      expect(
        reviews.find(({ transactionId }) => transactionId === mappingOnly.transaction.id)
      ).toBe(undefined)
      expect(
        reviews.find(({ transactionId }) => transactionId === mappingAndIndependent.transaction.id)
      ).toEqual({
        transactionId: mappingAndIndependent.transaction.id,
        categorizationReason: independentReason,
        matchedLayer: "coinbase_reference_mapping",
      })
      expect(stillBlocked.legs).toEqual([])
      expect(
        reviews.find(({ transactionId }) => transactionId === stillBlocked.transaction.id)
      ).toEqual({
        transactionId: stillBlocked.transaction.id,
        categorizationReason: expect.stringContaining(mappingReason),
        matchedLayer: expect.stringContaining("provider_asset_mapping"),
      })
    })
  )

  it.effect("withholds missing-decimal, unresolved, and unsupported provider rows", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:22:00.000Z"))
      yield* Effect.promise(() => seedProviderDecisionFixture(occurredAt))
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.providerAssets)
              .set({ exponent: null })
              .where(eq(schema.providerAssets.id, PROVIDER_ASSET_ROW_A_ID))
            yield* db.insert(schema.providerAssets).values([
              {
                id: PROVIDER_ASSET_ROW_UNRESOLVED_ID,
                provider: "coinbase",
                providerAssetId: "unresolved-row",
                currencyCode: "UNRESOLVED",
                name: "Unresolved row",
                exponent: 8,
                providerType: "crypto",
                rawProviderPayload: { row: "unresolved" },
                retrievedAt: occurredAt,
              },
              {
                id: PROVIDER_ASSET_ROW_UNSUPPORTED_ID,
                provider: "coinbase",
                providerAssetId: "unsupported-row",
                currencyCode: "UNSUPPORTED",
                name: "Unsupported row",
                exponent: 8,
                providerType: "collectible",
                rawProviderPayload: { row: "unsupported" },
                retrievedAt: occurredAt,
              },
            ])
            yield* db.insert(schema.providerAssetMappings).values([
              {
                providerAssetRowId: PROVIDER_ASSET_ROW_UNRESOLVED_ID,
                mappingKind: "asset",
                canonicalAssetId: null,
                mappingStatus: "pending_review",
              },
              {
                providerAssetRowId: PROVIDER_ASSET_ROW_UNSUPPORTED_ID,
                mappingKind: "asset",
                canonicalAssetId: null,
                mappingStatus: "pending_review",
              },
            ])
            const [unsupportedTarget] = yield* db
              .insert(schema.principalAssetOverrideTargets)
              .values({
                principalId: TEST_PRINCIPAL_ID,
                targetKind: "provider_asset",
                providerAssetRowId: PROVIDER_ASSET_ROW_UNSUPPORTED_ID,
              })
              .returning({ id: schema.principalAssetOverrideTargets.id })
            if (unsupportedTarget === undefined) {
              return yield* Effect.die("Failed to seed unsupported provider target")
            }
            yield* db.insert(schema.principalAssetOverrides).values({
              principalId: TEST_PRINCIPAL_ID,
              targetId: unsupportedTarget.id,
              kind: "identity",
              operation: "create",
              inspectedSystemRevision: "unsupported-provider-row-v1",
              inspectedSystemIdentity: "unresolved",
              replacementAssetId: PROVIDER_OVERRIDE_ASSET_ID,
              actorUserId: fixture.userId,
              reason: "Identity cannot bypass an unsupported provider asset type",
            })
          })
        )
      )

      const cases = [
        {
          externalId: "provider-missing-decimals",
          providerAssetRowId: PROVIDER_ASSET_ROW_A_ID,
        },
        {
          externalId: "provider-unresolved",
          providerAssetRowId: PROVIDER_ASSET_ROW_UNRESOLVED_ID,
        },
        {
          externalId: "provider-unsupported",
          providerAssetRowId: PROVIDER_ASSET_ROW_UNSUPPORTED_ID,
        },
      ] as const
      const results = yield* Effect.forEach(cases, ({ externalId, providerAssetRowId }) =>
        Effect.promise(() =>
          persistProviderDecisionArtifacts({
            occurredAt,
            externalId,
            legs: [{ externalId: `${externalId}-leg`, providerAssetRowId }],
          })
        )
      )
      const storedState = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const targetLinks = yield* db
              .select({
                providerAssetRowId: schema.providerAssetTransactionUses.providerAssetRowId,
                transactionId: schema.providerAssetTransactionUses.transactionId,
              })
              .from(schema.providerAssetTransactionUses)
              .where(
                inArray(
                  schema.providerAssetTransactionUses.transactionId,
                  results.map(({ transaction }) => transaction.id)
                )
              )
            const evidence = yield* db
              .select({
                id: schema.providerAssets.id,
                rawProviderPayload: schema.providerAssets.rawProviderPayload,
              })
              .from(schema.providerAssets)
              .where(
                inArray(schema.providerAssets.id, [
                  PROVIDER_ASSET_ROW_A_ID,
                  PROVIDER_ASSET_ROW_UNRESOLVED_ID,
                  PROVIDER_ASSET_ROW_UNSUPPORTED_ID,
                ])
              )
            return { evidence, targetLinks }
          })
        )
      )

      expect(storedState.targetLinks.map(({ providerAssetRowId }) => providerAssetRowId)).toEqual(
        expect.arrayContaining(cases.map(({ providerAssetRowId }) => providerAssetRowId))
      )
      expect(results.flatMap(({ legs }) => legs)).toEqual([])
      expect(storedState.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: PROVIDER_ASSET_ROW_A_ID }),
          {
            id: PROVIDER_ASSET_ROW_UNRESOLVED_ID,
            rawProviderPayload: { row: "unresolved" },
          },
          {
            id: PROVIDER_ASSET_ROW_UNSUPPORTED_ID,
            rawProviderPayload: { row: "unsupported" },
          },
        ])
      )
    })
  )

  it.effect(
    "replays and later derives a Coinbase asset-decision candidate through its exact provider row",
    () =>
      Effect.gen(function* () {
        const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:25:00.000Z"))
        const laterOccurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-02T10:25:00.000Z"))
        const historicalRawRecordId = "00000000-0000-4000-8000-000000000496"
        const laterRawRecordId = "00000000-0000-4000-8000-000000000497"
        const historicalPayload = makeCoinbaseReceivePayload({
          id: "coinbase-policy-excluded-history",
          timestamp: occurredAt,
        })
        const laterPayload = makeCoinbaseReceivePayload({
          id: "coinbase-policy-excluded-later",
          timestamp: laterOccurredAt,
        })

        yield* Effect.promise(() =>
          runPg(
            seedCoinbaseReplayRecords({
              historicalRawRecordId,
              historicalPayload,
              occurredAt,
              laterRawRecordId,
              laterPayload,
              laterOccurredAt,
            })
          )
        )
        yield* Effect.promise(() =>
          runCoinbaseNormalization(
            Effect.flatMap(
              CoinbaseReferenceDataService,
              ({ refreshReferenceData }) => refreshReferenceData
            )
          )
        )
        const providerAssetRowId = yield* Effect.promise(() =>
          runPg(markCoinbaseBtcProviderAssetExcluded)
        )
        const source = buildCoinbaseSource({ cexAccountId: fixture.cexAccountId })
        const historicalSourceRecord = buildSeededRawRecord({
          rawRecordId: historicalRawRecordId,
          externalRecordId: "raw-coinbase-policy-excluded-history",
          occurredAt,
          payload: historicalPayload,
        })
        const prepared = yield* Effect.promise(() =>
          runCoinbaseNormalization(
            Effect.gen(function* () {
              const provider = yield* CoinbaseSourceSyncProvider
              const lookups = yield* provider.loadNormalizationLookups
              return yield* provider.prepareNormalization({
                source,
                sourceRecord: historicalSourceRecord,
                lookups,
              })
            })
          )
        )
        expect(prepared).toMatchObject({
          legDerivationStrategy: "skip",
          assetDecisionLegDerivationCandidate: {
            providerAssetRowId,
            currencyCode: "BTC",
          },
        })

        const beforeOverride = yield* Effect.promise(() =>
          runCoinbaseNormalization(
            persistCoinbaseNormalization({
              source,
              sourceRecord: historicalSourceRecord,
              refreshReferenceData: false,
            })
          )
        )
        const beforeOverrideState = yield* Effect.promise(() =>
          runPg(loadCoinbasePreOverrideState(beforeOverride.transaction.id))
        )
        expect(beforeOverrideState.targetLinks).toEqual([{ providerAssetRowId }])
        expect(beforeOverride.legs).toEqual([])
        expect(beforeOverride.providerTransfers).toHaveLength(1)
        expect(beforeOverrideState.movements).toEqual([])

        yield* Effect.promise(() =>
          runPg(
            insertCoinbaseProviderOverrides({
              actorUserId: fixture.userId,
              providerAssetRowId,
            })
          )
        )

        const replayed = yield* Effect.promise(() =>
          runCoinbaseNormalization(
            persistCoinbaseNormalization({
              source,
              sourceRecord: historicalSourceRecord,
              refreshReferenceData: false,
            })
          )
        )
        const later = yield* Effect.promise(() =>
          runCoinbaseNormalization(
            persistCoinbaseNormalization({
              source,
              sourceRecord: buildSeededRawRecord({
                rawRecordId: laterRawRecordId,
                externalRecordId: "raw-coinbase-policy-excluded-later",
                occurredAt: laterOccurredAt,
                payload: laterPayload,
              }),
              refreshReferenceData: false,
            })
          )
        )
        const afterOverrideState = yield* Effect.promise(() =>
          runPg(
            loadCoinbasePostOverrideState({
              providerAssetRowId,
              transactionIds: [replayed.transaction.id, later.transaction.id],
            })
          )
        )

        expect(replayed.legs).toEqual([
          expect.objectContaining({
            assetId: PROVIDER_OVERRIDE_ASSET_ID,
            providerAssetRowId,
          }),
        ])
        expect(later.legs).toEqual([
          expect.objectContaining({
            assetId: PROVIDER_OVERRIDE_ASSET_ID,
            providerAssetRowId,
          }),
        ])
        expect(afterOverrideState.movements).toEqual(
          expect.arrayContaining([
            { assetId: PROVIDER_OVERRIDE_ASSET_ID, transactionId: replayed.transaction.id },
            { assetId: PROVIDER_OVERRIDE_ASSET_ID, transactionId: later.transaction.id },
          ])
        )
        expect(afterOverrideState.mapping).toEqual({
          canonicalAssetId: null,
          mappingStatus: "excluded",
        })
      })
  )

  it.effect(
    "uses a persisted exact target when a Coinbase candidate retry omits observation fields",
    () =>
      Effect.gen(function* () {
        const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:25:00.000Z"))
        const rawRecordId = "00000000-0000-4000-8000-000000000498"
        const payload = makeCoinbaseReceivePayload({
          id: "coinbase-exact-candidate-retry",
          timestamp: occurredAt,
        })
        yield* Effect.promise(() =>
          runPg(
            seedRawRecord({
              rawRecordId,
              externalRecordId: "raw-coinbase-exact-candidate-retry",
              occurredAt,
              payload,
            })
          )
        )
        yield* Effect.promise(() =>
          runCoinbaseNormalization(
            Effect.flatMap(
              CoinbaseReferenceDataService,
              ({ refreshReferenceData }) => refreshReferenceData
            )
          )
        )
        const providerAssetRowId = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const [providerAsset] = yield* db
                .select({ id: schema.providerAssets.id })
                .from(schema.providerAssets)
                .where(eq(schema.providerAssets.currencyCode, "BTC"))
                .limit(1)
              if (providerAsset === undefined) {
                return yield* Effect.die("Missing Coinbase BTC provider asset")
              }
              yield* db
                .update(schema.providerAssetMappings)
                .set({
                  canonicalAssetId: null,
                  assetRepresentationId: null,
                  mappingStatus: "pending_review",
                })
                .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAsset.id))
              yield* db
                .delete(schema.assetResolutionCurrentState)
                .where(eq(schema.assetResolutionCurrentState.providerAssetRowId, providerAsset.id))
              return providerAsset.id
            })
          )
        )
        yield* Effect.promise(() =>
          runPg(
            insertCoinbaseProviderOverrides({
              actorUserId: fixture.userId,
              providerAssetRowId,
            })
          )
        )
        const source = buildCoinbaseSource({ cexAccountId: fixture.cexAccountId })
        const sourceRecord = buildSeededRawRecord({
          rawRecordId,
          externalRecordId: "raw-coinbase-exact-candidate-retry",
          occurredAt,
          payload,
        })

        const first = yield* Effect.promise(() =>
          runCoinbaseNormalization(
            persistCoinbaseNormalization({
              source,
              sourceRecord,
              providerTransferObservedBlockchainId: fixture.bitcoinBlockchainId,
              refreshReferenceData: false,
            })
          )
        )
        const providerTransferExternalId = first.providerTransfers[0]?.externalId
        if (providerTransferExternalId === null || providerTransferExternalId === undefined) {
          return yield* Effect.die("Missing Coinbase provider transfer external id")
        }
        const firstUseId = yield* Effect.promise(() =>
          loadProviderTransferSourceUseId(providerTransferExternalId)
        )
        expect(firstUseId).not.toBeNull()
        expect(first.legs).toEqual([
          expect.objectContaining({ assetId: TEST_BTC_ASSET_ID, providerAssetRowId }),
        ])

        const retried = yield* Effect.promise(() =>
          runCoinbaseNormalization(
            persistCoinbaseNormalization({
              source,
              sourceRecord,
              omitProviderTransferObservation: true,
              refreshReferenceData: false,
            })
          )
        )
        const retriedUseId = yield* Effect.promise(() =>
          loadProviderTransferSourceUseId(providerTransferExternalId)
        )

        expect(retriedUseId).toBe(firstUseId)
        expect(retried.legs).toEqual([
          expect.objectContaining({ assetId: TEST_BTC_ASSET_ID, providerAssetRowId }),
        ])

        yield* Effect.forEach(
          ["before", "after"] as const,
          (sameAssetExactSiblingPosition, index) =>
            Effect.gen(function* () {
              const siblingRawRecordId =
                index === 0
                  ? "00000000-0000-4000-8000-000000000499"
                  : "00000000-0000-4000-8000-000000000500"
              const siblingPayload = makeCoinbaseReceivePayload({
                id: `coinbase-chainless-candidate-${sameAssetExactSiblingPosition}`,
                timestamp: occurredAt,
              })
              yield* Effect.promise(() =>
                runPg(
                  seedRawRecord({
                    rawRecordId: siblingRawRecordId,
                    externalRecordId: `raw-coinbase-chainless-candidate-${sameAssetExactSiblingPosition}`,
                    occurredAt,
                    payload: siblingPayload,
                  })
                )
              )
              const siblingResult = yield* Effect.promise(() =>
                runCoinbaseNormalization(
                  persistCoinbaseNormalization({
                    source,
                    sourceRecord: buildSeededRawRecord({
                      rawRecordId: siblingRawRecordId,
                      externalRecordId: `raw-coinbase-chainless-candidate-${sameAssetExactSiblingPosition}`,
                      occurredAt,
                      payload: siblingPayload,
                    }),
                    omitProviderTransferObservation: true,
                    sameAssetExactSiblingBlockchainId: fixture.bitcoinBlockchainId,
                    sameAssetExactSiblingPosition,
                    refreshReferenceData: false,
                  })
                )
              )

              expect(
                siblingResult.providerTransfers.map(({ sourceRepresentationUseId }) =>
                  sourceRepresentationUseId === null ? "chainless" : "exact"
                )
              ).toEqual(
                sameAssetExactSiblingPosition === "before"
                  ? ["exact", "chainless"]
                  : ["chainless", "exact"]
              )
              expect(siblingResult.legs).toEqual([
                expect.objectContaining({
                  assetId: PROVIDER_OVERRIDE_ASSET_ID,
                  providerAssetRowId,
                }),
              ])
            })
        )
      })
  )

  it.effect("replaces included facts when a later technical decision withholds", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:20:00.000Z"))
      yield* Effect.promise(() => seedProviderDecisionFixture(occurredAt))
      const externalId = "provider-included-then-technically-blocked"
      const artifacts = {
        occurredAt,
        externalId,
        providerTransfers: [
          {
            providerAssetId: PROVIDER_ASSET_ROW_A_ID,
            observedBlockchainId: null,
            processingMode: "accounting_and_evidence" as const,
          },
        ],
        legs: [
          {
            externalId: `${externalId}-leg`,
            providerAssetRowId: PROVIDER_ASSET_ROW_A_ID,
          },
        ],
      }

      const included = yield* Effect.promise(() => persistProviderDecisionArtifacts(artifacts))
      expect(included.legs).toHaveLength(1)

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.providerAssets)
              .set({ exponent: null })
              .where(eq(schema.providerAssets.id, PROVIDER_ASSET_ROW_A_ID))
          })
        )
      )

      const withheld = yield* Effect.promise(() => persistProviderDecisionArtifacts(artifacts))
      const state = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const legs = yield* db
              .select({ id: schema.transactionLegs.id })
              .from(schema.transactionLegs)
              .where(eq(schema.transactionLegs.transactionId, withheld.transaction.id))
            const inventory = yield* db
              .select({ id: schema.inventoryMovements.id })
              .from(schema.inventoryMovements)
              .where(eq(schema.inventoryMovements.transactionId, withheld.transaction.id))
            const providerEvidence = yield* db
              .select({ id: schema.providerTransfers.id })
              .from(schema.providerTransfers)
              .where(eq(schema.providerTransfers.transactionId, withheld.transaction.id))
            const [review] = yield* db
              .select({ categorizationReason: schema.transactionReviews.categorizationReason })
              .from(schema.transactionReviews)
              .where(eq(schema.transactionReviews.transactionId, withheld.transaction.id))
            return { inventory, legs, providerEvidence, review }
          })
        )
      )

      expect(withheld.legs).toEqual([])
      expect(state.legs).toEqual([])
      expect(state.inventory).toEqual([])
      expect(state.providerEvidence).toHaveLength(1)
      expect(state.review?.categorizationReason).toContain("missing_decimals")
    })
  )

  it.effect(
    "reuses one provider decision view through derivation and final preflight",
    () =>
      Effect.gen(function* () {
        const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:20:00.000Z"))
        yield* Effect.promise(() => seedProviderDecisionFixture(occurredAt))
        const decisionResolved = yield* Latch.make()
        const releaseDerivation = yield* Latch.make()
        const sourceWrite = yield* Effect.forkChild(
          Effect.promise(() =>
            persistProviderDecisionArtifacts({
              occurredAt,
              externalId: "provider-decision-snapshot-during-derivation",
              legs: [
                {
                  externalId: "provider-decision-snapshot-during-derivation-leg",
                  providerAssetRowId: PROVIDER_ASSET_ROW_A_ID,
                },
              ],
              afterProviderDecision: decisionResolved.open.pipe(
                Effect.andThen(releaseDerivation.await)
              ),
            })
          )
        )

        yield* decisionResolved.await
        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db
                .update(schema.providerAssets)
                .set({ exponent: null })
                .where(eq(schema.providerAssets.id, PROVIDER_ASSET_ROW_A_ID))
            })
          )
        )
        yield* releaseDerivation.open

        const first = yield* Fiber.join(sourceWrite)
        const later = yield* Effect.promise(() =>
          persistProviderDecisionArtifacts({
            occurredAt,
            externalId: "provider-decision-after-reference-change",
            legs: [
              {
                externalId: "provider-decision-after-reference-change-leg",
                providerAssetRowId: PROVIDER_ASSET_ROW_A_ID,
              },
            ],
          })
        )

        expect(first.legs).toHaveLength(1)
        expect(later.legs).toEqual([])
      }),
    15_000
  )

  it.effect("withholds all accounting legs when a principal exclusion applies", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:20:00.000Z"))
      yield* Effect.promise(() => seedProviderDecisionFixture(occurredAt))

      const result = yield* Effect.promise(() =>
        persistProviderDecisionArtifacts({
          occurredAt,
          externalId: "provider-targeted-exclusion",
          legs: [
            {
              externalId: "provider-targeted-exclusion-omitted",
              providerAssetRowId: PROVIDER_ASSET_ROW_USER_EXCLUDED_ID,
            },
            {
              externalId: "provider-targeted-exclusion-kept",
              providerAssetRowId: PROVIDER_ASSET_ROW_A_ID,
            },
          ],
        })
      )
      const [review] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                categorizationReason: schema.transactionReviews.categorizationReason,
                matchedLayer: schema.transactionReviews.matchedLayer,
              })
              .from(schema.transactionReviews)
              .where(eq(schema.transactionReviews.transactionId, result.transaction.id))
          })
        )
      )

      expect(result.legs).toEqual([])
      expect(review?.matchedLayer).toContain("principal_asset_override")
      expect(review?.categorizationReason).toContain("active principal exclusion")
    })
  )

  it.effect("keeps later technical review reasons when an earlier leg is excluded", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:20:00.000Z"))
      yield* Effect.promise(() => seedProviderDecisionFixture(occurredAt))
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.providerAssets)
              .set({ exponent: null })
              .where(eq(schema.providerAssets.id, PROVIDER_ASSET_ROW_A_ID))
          })
        )
      )

      const result = yield* Effect.promise(() =>
        persistProviderDecisionArtifacts({
          occurredAt,
          externalId: "provider-exclusion-before-technical-blocker",
          legs: [
            {
              externalId: "provider-exclusion-before-technical-blocker-excluded",
              providerAssetRowId: PROVIDER_ASSET_ROW_USER_EXCLUDED_ID,
            },
            {
              externalId: "provider-exclusion-before-technical-blocker-missing-decimals",
              providerAssetRowId: PROVIDER_ASSET_ROW_A_ID,
            },
          ],
        })
      )
      const [review] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ categorizationReason: schema.transactionReviews.categorizationReason })
              .from(schema.transactionReviews)
              .where(eq(schema.transactionReviews.transactionId, result.transaction.id))
          })
        )
      )

      expect(result.legs).toEqual([])
      expect(review?.categorizationReason).toContain("missing_decimals")
    })
  )

  it.effect("keeps different recorded provider targets independent", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:20:00.000Z"))
      yield* Effect.promise(() => seedProviderDecisionFixture(occurredAt))

      const result = yield* Effect.promise(() =>
        persistProviderDecisionArtifacts({
          occurredAt,
          externalId: "provider-contradictory",
          legs: [
            {
              externalId: "provider-contradictory-a",
              providerAssetRowId: PROVIDER_ASSET_ROW_A_ID,
            },
            {
              externalId: "provider-contradictory-b",
              providerAssetRowId: PROVIDER_ASSET_ROW_B_ID,
            },
          ],
        })
      )
      const stored = yield* Effect.promise(loadProviderDecisionEvidence)

      expect(result.legs.map(({ assetId }) => assetId)).toEqual([
        PROVIDER_OVERRIDE_ASSET_ID,
        SECOND_PROVIDER_OVERRIDE_ASSET_ID,
      ])
      expect(stored.review).toBeUndefined()
      expect(stored.mappings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            providerAssetRowId: PROVIDER_ASSET_ROW_A_ID,
            canonicalAssetId: TEST_BTC_ASSET_ID,
            mappingStatus: "approved",
          }),
          expect.objectContaining({
            providerAssetRowId: PROVIDER_ASSET_ROW_B_ID,
            canonicalAssetId: TEST_BTC_ASSET_ID,
            mappingStatus: "approved",
          }),
        ])
      )
      expect(stored.providerEvidence).toEqual([{ rawProviderPayload: { row: "a" } }])
    })
  )

  it.effect("keeps another principal on the system provider identity", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:20:00.000Z"))
      const secondPrincipalFixture = yield* Effect.promise(() =>
        seedProviderDecisionFixture(occurredAt)
      )

      const result = yield* Effect.promise(() =>
        persistProviderDecisionArtifacts({
          occurredAt,
          externalId: "provider-second-principal",
          principalId: SECOND_PRINCIPAL_ID,
          sourceId: SECOND_PRINCIPAL_SOURCE_ID,
          cexAccountId: secondPrincipalFixture.cexAccountId,
          legs: [
            {
              externalId: "provider-second-principal-leg",
              providerAssetRowId: PROVIDER_ASSET_ROW_A_ID,
            },
          ],
        })
      )

      expect(result.legs.map(({ assetId }) => assetId)).toEqual([TEST_BTC_ASSET_ID])
    })
  )

  it.effect("tracks callback-derived representations for later override replay", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:30:00.000Z"))
      const overrideFixture = yield* Effect.promise(() =>
        runPg(
          seedSyncEngineRepositoryFixture({
            userId: CONCURRENT_USER_ID,
            principalId: CONCURRENT_PRINCIPAL_ID,
            sourceId: CONCURRENT_SOURCE_A_ID,
          })
        )
      )
      const secondCexAccountId = yield* Effect.promise(() =>
        runPg(
          seedAdditionalOverrideSource({
            fixture: overrideFixture,
            sourceId: CONCURRENT_SOURCE_B_ID,
            principalId: CONCURRENT_PRINCIPAL_ID,
          })
        )
      )
      yield* Effect.promise(() =>
        persistExactOverrideArtifact({
          externalId: "override-origin-source",
          fixture: overrideFixture,
          occurredAt,
          sourceId: CONCURRENT_SOURCE_A_ID,
          cexAccountId: overrideFixture.cexAccountId,
          principalId: CONCURRENT_PRINCIPAL_ID,
        })
      )
      const historical = yield* Effect.promise(() =>
        persistExactOverrideCallbackArtifact({
          externalId: "historical-callback-source",
          fixture: overrideFixture,
          kind: "acquisition",
          occurredAt,
          providerStatus: "pending",
          sourceId: CONCURRENT_SOURCE_B_ID,
          cexAccountId: secondCexAccountId,
          principalId: CONCURRENT_PRINCIPAL_ID,
        })
      )
      expect(historical.canonicalTransfers[0]?.assetId).toBe(TEST_BTC_ASSET_ID)
      expect(historical.legs[0]?.assetId).toBe(TEST_BTC_ASSET_ID)

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.assets).values({
              id: OVERRIDE_ASSET_ID,
              name: "Principal-selected asset",
              symbol: "SELECTED",
              type: "fungible",
            })
          })
        )
      )
      const target = {
        _tag: "representation" as const,
        blockchain: "bitcoin",
        type: "token" as const,
        contractAddress: "sync-engine-btc-fixture",
        mintAddress: null,
      }
      const createdProjection = Option.getOrThrow(
        yield* Effect.promise(() =>
          runSourceAndOverrideRepositories(
            Effect.gen(function* () {
              const overrideRepository = yield* PrincipalAssetOverrideRepository
              const projection = Option.getOrThrow(
                yield* overrideRepository.findProjection({
                  principalId: PrincipalId.make(CONCURRENT_PRINCIPAL_ID),
                  target,
                })
              )
              return yield* overrideRepository.create({
                actorUserId: AuthUserId.make(CONCURRENT_USER_ID),
                expectedSystemRevision: projection.system.identityRevision,
                principalId: PrincipalId.make(CONCURRENT_PRINCIPAL_ID),
                reason: "Replay every source that stored the exact representation",
                replacement: { _tag: "identity", assetId: OVERRIDE_ASSET_ID },
                target,
              })
            })
          )
        )
      )
      const activeOverrideId = createdProjection.activeIdentityOverride?.id
      expect(activeOverrideId).toBeDefined()
      const applicationSources = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ sourceId: schema.principalAssetOverrideApplications.sourceId })
              .from(schema.principalAssetOverrideApplications)
              .where(
                eq(schema.principalAssetOverrideApplications.overrideId, activeOverrideId ?? "")
              )
          })
        )
      )
      expect(applicationSources.map(({ sourceId }) => sourceId)).toEqual(
        expect.arrayContaining([CONCURRENT_SOURCE_A_ID, CONCURRENT_SOURCE_B_ID])
      )

      const replayed = yield* Effect.promise(() =>
        persistExactOverrideCallbackArtifact({
          externalId: "historical-callback-source",
          fixture: overrideFixture,
          kind: "acquisition",
          occurredAt,
          providerStatus: "pending",
          sourceId: CONCURRENT_SOURCE_B_ID,
          cexAccountId: secondCexAccountId,
          principalId: CONCURRENT_PRINCIPAL_ID,
        })
      )
      expect(replayed.canonicalTransfers[0]?.assetId).toBe(OVERRIDE_ASSET_ID)
      expect(replayed.legs[0]?.assetId).toBe(OVERRIDE_ASSET_ID)
    })
  )

  it.effect("keeps callback evidence and fee inventory on the system asset", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T11:00:00.000Z"))
      yield* Effect.promise(() =>
        runPg(
          seedExactIdentityOverride({
            fixture,
            reason: "Apply the selected asset after callback derivation",
          })
        )
      )

      const callbackDerived = yield* Effect.promise(() =>
        persistExactOverrideCallbackArtifact({
          externalId: "callback-derived",
          fixture,
          kind: "acquisition",
          occurredAt,
          providerStatus: "pending",
        })
      )
      expect(callbackDerived.canonicalTransfers[0]?.assetId).toBe(OVERRIDE_ASSET_ID)
      expect(callbackDerived.legs[0]).toMatchObject({
        assetId: OVERRIDE_ASSET_ID,
        assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
      })

      const [callbackDerivedLeg] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ metadata: schema.transactionLegs.metadata })
              .from(schema.transactionLegs)
              .where(eq(schema.transactionLegs.externalId, "callback-derived-leg"))
          })
        )
      )
      expect(callbackDerivedLeg?.metadata).toEqual({ derivedFromAssetId: TEST_BTC_ASSET_ID })

      const feeDerived = yield* Effect.promise(() =>
        persistExactOverrideCallbackArtifact({
          externalId: "callback-derived-fee",
          fixture,
          kind: "fee",
          occurredAt,
          providerStatus: "completed",
        })
      )
      expect(feeDerived.legs[0]).toMatchObject({
        assetId: OVERRIDE_ASSET_ID,
        assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
        kind: "fee",
      })

      const [feeState] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                assetId: schema.inventoryMovements.assetId,
                assetRepresentationId: schema.inventoryMovements.assetRepresentationId,
                originKind: schema.transactionLegs.originKind,
                providerTransferId: schema.transactionLegs.providerTransferId,
                sourceTransferId: schema.transactionLegs.sourceTransferId,
              })
              .from(schema.inventoryMovements)
              .innerJoin(
                schema.transactionLegs,
                eq(schema.transactionLegs.id, schema.inventoryMovements.transactionLegId)
              )
              .where(eq(schema.transactionLegs.externalId, "callback-derived-fee-leg"))
          })
        )
      )
      expect(feeState).toEqual({
        assetId: TEST_BTC_ASSET_ID,
        assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
        originKind: "canonical_transfer",
        providerTransferId: null,
        sourceTransferId: feeDerived.canonicalTransfers[0]?.id,
      })
    })
  )

  it.effect("propagates a storage failure from leg derivation and rolls back", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T11:05:00.000Z"))
      const failure = new SyncEngineStorageError({
        operation: "sourceNormalizationRepository.test.deriveLegs",
        cause: "injected storage failure",
      })

      const caught = yield* Effect.flip(
        Effect.tryPromise({
          try: () =>
            persistExactOverrideCallbackArtifact({
              externalId: "callback-storage-failure",
              fixture,
              kind: "acquisition",
              occurredAt,
              providerStatus: "completed",
              deriveFailure: failure,
            }),
          catch: (error) => ({ error }),
        })
      )
      expect(caught.error).toMatchObject({
        _tag: "SyncEngineStorageError",
        operation: "sourceNormalizationRepository.test.deriveLegs",
      })

      const stored = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const transactions = yield* db
              .select({ id: schema.transactions.id })
              .from(schema.transactions)
              .where(eq(schema.transactions.externalId, "callback-storage-failure-transaction"))
            const transfers = yield* db
              .select({ id: schema.transfers.id })
              .from(schema.transfers)
              .where(eq(schema.transfers.externalId, "callback-storage-failure-transfer"))
            return { transactions, transfers }
          })
        )
      )

      expect(stored).toEqual({ transactions: [], transfers: [] })
    })
  )

  it.effect("serializes a source's first representation use with override scheduling", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-02T10:00:00.000Z"))
      const concurrentFixture = yield* Effect.promise(() =>
        runPg(
          seedSyncEngineRepositoryFixture({
            userId: CONCURRENT_USER_ID,
            principalId: CONCURRENT_PRINCIPAL_ID,
            sourceId: CONCURRENT_SOURCE_A_ID,
          })
        )
      )
      const secondCexAccountId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.assets).values({
              id: OVERRIDE_ASSET_ID,
              name: "Principal-selected asset",
              symbol: "SELECTED",
              type: "fungible",
            })
            const [firstAccount] = yield* db
              .select({ cexId: schema.cexAccount.cexId })
              .from(schema.cexAccount)
              .where(eq(schema.cexAccount.id, concurrentFixture.cexAccountId))
            if (firstAccount === undefined) return yield* Effect.die("Missing first CEX account")
            const [secondAccount] = yield* db
              .insert(schema.cexAccount)
              .values({
                cexId: firstAccount.cexId,
                principalId: CONCURRENT_PRINCIPAL_ID,
                providerUserId: "concurrent-provider-user",
                providerAccountId: "concurrent-provider-account",
              })
              .returning({ id: schema.cexAccount.id })
            if (secondAccount === undefined) {
              return yield* Effect.die("Failed to create concurrent provider account")
            }
            yield* db.insert(schema.sources).values({
              id: CONCURRENT_SOURCE_B_ID,
              principalId: CONCURRENT_PRINCIPAL_ID,
              name: "Concurrent exact representation provider",
              providerKey: "concurrent-exact-provider",
              sourceableType: "cex",
              cexAccountId: secondAccount.id,
            })
            yield* db.insert(schema.sourceRepresentationUses).values({
              sourceId: CONCURRENT_SOURCE_A_ID,
              blockchainId: fixture.bitcoinBlockchainId,
              representationType: "token",
              contractAddress: "sync-engine-btc-fixture",
              mintAddress: null,
            })
            return secondAccount.id
          })
        )
      )

      const sourceOwnsPrincipalLock = yield* Latch.make()
      const releaseSourceWrite = yield* Latch.make()
      const [stored, created] = yield* Effect.promise(() =>
        runSourceAndOverrideRepositories(
          Effect.gen(function* () {
            const sourceRepository = yield* SourceNormalizationRepository
            const overrideRepository = yield* PrincipalAssetOverrideRepository
            const projection = Option.getOrThrow(
              yield* overrideRepository.findProjection({
                principalId: PrincipalId.make(CONCURRENT_PRINCIPAL_ID),
                target: {
                  _tag: "representation",
                  blockchain: "bitcoin",
                  type: "token",
                  contractAddress: "sync-engine-btc-fixture",
                  mintAddress: null,
                },
              })
            )
            return yield* Effect.all(
              [
                sourceRepository.persistNormalizedArtifacts({
                  beforePersist: Effect.gen(function* () {
                    yield* sourceOwnsPrincipalLock.open
                    yield* releaseSourceWrite.await
                  }),
                  transaction: {
                    sourceId: CONCURRENT_SOURCE_B_ID,
                    sourceRawRecordId: null,
                    externalId: "concurrent-first-use-transaction",
                    externalGroupId: "concurrent-first-use",
                    timestamp: occurredAt,
                    transactionType: "buy_fiat",
                    providerTransactionType: "buy",
                    providerStatus: "pending",
                    providerResourcePath: "/test/concurrent-first-use",
                    providerDescription: "Concurrent first representation use",
                    providerCreatedAt: occurredAt,
                    providerUpdatedAt: occurredAt,
                    metadata: null,
                    providerFiatAmount: null,
                    providerFiatCurrency: null,
                    principalId: CONCURRENT_PRINCIPAL_ID,
                  },
                  venueContext: {
                    venueType: "cex",
                    cexAccountId: secondCexAccountId,
                    externalAccountId: "concurrent-provider-account",
                    externalOrderId: null,
                    externalFillId: null,
                    side: "buy",
                    instrument: "BTC-EUR",
                    fillPrice: "10000",
                    commissionAmount: null,
                    commissionCurrency: null,
                    metadata: null,
                  },
                  providerTransfers: [
                    {
                      sourceId: CONCURRENT_SOURCE_B_ID,
                      sourceRawRecordId: null,
                      externalId: "concurrent-first-use-evidence",
                      externalGroupId: "concurrent-first-use",
                      providerAssetId: null,
                      timestamp: occurredAt,
                      direction: "inbound",
                      processingMode: "evidence_only",
                      fromAccountRef: "external",
                      toAccountRef: "owned",
                      fromAddress: null,
                      toAddress: null,
                      networkName: "bitcoin",
                      networkHash: "concurrent-first-use-hash",
                      observedBlockchainId: fixture.bitcoinBlockchainId,
                      observedRepresentationType: "token",
                      observedContractAddress: "sync-engine-btc-fixture",
                      observedMintAddress: null,
                      observedDecimals: 8,
                      amount: "1",
                      metadata: null,
                    },
                  ],
                  canonicalTransfers: [
                    {
                      sourceId: CONCURRENT_SOURCE_B_ID,
                      principalId: CONCURRENT_PRINCIPAL_ID,
                      sourceRawRecordId: null,
                      externalId: "concurrent-first-use-transfer",
                      externalGroupId: "concurrent-first-use",
                      addressId: null,
                      blockchainId: fixture.bitcoinBlockchainId,
                      txHash: null,
                      timestamp: occurredAt,
                      type: "cex",
                      fromAddress: null,
                      toAddress: null,
                      fromAccountRef: "external",
                      toAccountRef: "owned",
                      fromPartyType: null,
                      fromPartyResourcePath: null,
                      toPartyType: null,
                      toPartyResourcePath: null,
                      assetId: TEST_BTC_ASSET_ID,
                      assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
                      amount: "1",
                      tokenId: null,
                      notes: null,
                      metadata: null,
                    },
                  ],
                  providerAssetRowIds: [],
                  legs: [],
                  transactionReview: null,
                  resolvedTransactionType: APPROVED_MAPPING,
                }),
                sourceOwnsPrincipalLock.await.pipe(
                  Effect.andThen(
                    overrideRepository.create({
                      actorUserId: AuthUserId.make(CONCURRENT_USER_ID),
                      expectedSystemRevision: projection.system.identityRevision,
                      principalId: PrincipalId.make(CONCURRENT_PRINCIPAL_ID),
                      reason: "Use the selected asset for every matching source",
                      replacement: { _tag: "identity", assetId: OVERRIDE_ASSET_ID },
                      target: {
                        _tag: "representation",
                        blockchain: "bitcoin",
                        type: "token",
                        contractAddress: "sync-engine-btc-fixture",
                        mintAddress: null,
                      },
                    })
                  )
                ),
                sourceOwnsPrincipalLock.await.pipe(
                  Effect.andThen(
                    Effect.promise(() =>
                      context.waitForQueryBlockedOnLock({ queryIncludes: "principals" })
                    )
                  ),
                  Effect.andThen(releaseSourceWrite.open)
                ),
              ],
              { concurrency: "unbounded" }
            )
          })
        )
      )

      const createdProjection = Option.getOrThrow(created)
      const activeOverrideId = createdProjection.activeIdentityOverride?.id
      expect(stored.canonicalTransfers[0]?.assetId).toBe(TEST_BTC_ASSET_ID)
      expect(activeOverrideId).toBeDefined()
      const durableReplay = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                sourceId: schema.principalAssetOverrideApplications.sourceId,
                mode: schema.processingJobs.mode,
                status: schema.processingJobs.status,
                progressDetails: schema.processingJobs.progressDetails,
              })
              .from(schema.principalAssetOverrideApplications)
              .innerJoin(
                schema.processingJobs,
                eq(
                  schema.processingJobs.id,
                  schema.principalAssetOverrideApplications.processingJobId
                )
              )
              .where(
                eq(schema.principalAssetOverrideApplications.overrideId, activeOverrideId ?? "")
              )
          })
        )
      )
      expect(durableReplay).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceId: CONCURRENT_SOURCE_B_ID,
            mode: "replay",
            status: "pending",
            progressDetails: expect.objectContaining({
              mode: "replay",
              reason: "principal_asset_override",
              overrideId: activeOverrideId,
            }),
          }),
        ])
      )
    })
  )

  it.effect("applies an override that wins the principal lock before a source's first use", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-02T10:05:00.000Z"))
      const concurrentFixture = yield* Effect.promise(() =>
        runPg(
          seedSyncEngineRepositoryFixture({
            userId: CONCURRENT_USER_ID,
            principalId: CONCURRENT_PRINCIPAL_ID,
            sourceId: CONCURRENT_SOURCE_A_ID,
          })
        )
      )
      const secondCexAccountId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.assets).values({
              id: OVERRIDE_ASSET_ID,
              name: "Principal-selected asset",
              symbol: "SELECTED",
              type: "fungible",
            })
            yield* db.insert(schema.sourceRepresentationUses).values({
              sourceId: CONCURRENT_SOURCE_A_ID,
              blockchainId: concurrentFixture.bitcoinBlockchainId,
              representationType: "token",
              contractAddress: "sync-engine-btc-fixture",
              mintAddress: null,
            })
            return yield* seedAdditionalOverrideSource({
              fixture: concurrentFixture,
              sourceId: CONCURRENT_SOURCE_B_ID,
              principalId: CONCURRENT_PRINCIPAL_ID,
            })
          })
        )
      )
      const target = {
        _tag: "representation" as const,
        blockchain: "bitcoin",
        type: "token" as const,
        contractAddress: "sync-engine-btc-fixture",
        mintAddress: null,
      }
      const projection = Option.getOrThrow(
        yield* Effect.promise(() =>
          runSourceAndOverrideRepositories(
            Effect.flatMap(PrincipalAssetOverrideRepository, (overrideRepository) =>
              overrideRepository.findProjection({
                principalId: PrincipalId.make(CONCURRENT_PRINCIPAL_ID),
                target,
              })
            )
          )
        )
      )
      const gateHeld = yield* Latch.make()
      const releaseGate = yield* Latch.make()
      const gate = yield* Effect.forkChild(
        Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db.transaction((tx) =>
                Effect.gen(function* () {
                  yield* tx.execute(
                    sql`select pg_advisory_xact_lock(hashtextextended('t12b1-override-first', 0))`
                  )
                  yield* gateHeld.open
                  yield* releaseGate.await
                })
              )
            })
          )
        )
      )
      yield* gateHeld.await
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.execute(sql`
              create function hold_override_after_principal_lock() returns trigger
              language plpgsql as $trigger$
              begin
                perform pg_advisory_xact_lock(hashtextextended('t12b1-override-first', 0));
                return new;
              end
              $trigger$
            `)
            yield* db.execute(sql`
              create trigger hold_override_after_principal_lock
              before insert on principal_asset_overrides
              for each row execute function hold_override_after_principal_lock()
            `)
          })
        )
      )
      const overrideMutation = yield* Effect.forkChild(
        Effect.promise(() =>
          runSourceAndOverrideRepositories(
            Effect.flatMap(PrincipalAssetOverrideRepository, (overrideRepository) =>
              overrideRepository.create({
                actorUserId: AuthUserId.make(CONCURRENT_USER_ID),
                expectedSystemRevision: projection.system.identityRevision,
                principalId: PrincipalId.make(CONCURRENT_PRINCIPAL_ID),
                reason: "Win the principal lock before the source records its first use",
                replacement: { _tag: "identity", assetId: OVERRIDE_ASSET_ID },
                target,
              })
            )
          )
        )
      )
      yield* Effect.promise(() =>
        context.waitForQueryBlockedOnLock({ queryIncludes: "principal_asset_overrides" })
      )
      const sourceWrite = yield* Effect.forkChild(
        Effect.promise(() =>
          persistExactOverrideArtifact({
            externalId: "override-first-use",
            fixture: concurrentFixture,
            occurredAt,
            sourceId: CONCURRENT_SOURCE_B_ID,
            cexAccountId: secondCexAccountId,
            principalId: CONCURRENT_PRINCIPAL_ID,
          })
        )
      )
      yield* Effect.promise(() =>
        context.waitForQueryBlockedOnLock({ queryIncludes: "principals" })
      )
      yield* releaseGate.open
      yield* Fiber.join(gate)
      yield* Fiber.join(overrideMutation)

      const stored = yield* Fiber.join(sourceWrite)
      expect(stored.canonicalTransfers[0]?.assetId).toBe(OVERRIDE_ASSET_ID)
      expect(stored.legs[0]?.assetId).toBe(OVERRIDE_ASSET_ID)
    })
  )

  it.effect("keeps transaction-level provider asset uses in step with each persist", () =>
    Effect.gen(function* () {
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z"))
      const [assetA, assetB] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const rows = yield* db
              .insert(schema.providerAssets)
              .values([
                {
                  provider: "coinbase",
                  providerAssetId: "tx-use-asset-a",
                  currencyCode: "TXA",
                  retrievedAt: timestamp,
                },
                {
                  provider: "coinbase",
                  providerAssetId: "tx-use-asset-b",
                  currencyCode: "TXB",
                  retrievedAt: timestamp,
                },
              ])
              .returning({ id: schema.providerAssets.id })
            if (rows.length !== 2) return yield* Effect.die("Failed to seed provider assets")
            return rows
          })
        )
      )
      if (assetA === undefined || assetB === undefined) {
        throw new Error("Failed to seed provider assets")
      }

      const persist = (providerAssetRowIds: ReadonlyArray<string>) =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts({
              transaction: {
                sourceId: TEST_SOURCE_ID,
                sourceRawRecordId: null,
                externalId: "transaction-with-provider-asset-uses",
                externalGroupId: null,
                timestamp,
                transactionType: "buy_fiat",
                providerTransactionType: "buy",
                providerStatus: "completed",
                providerResourcePath: null,
                providerDescription: "Transaction with provider asset uses",
                providerCreatedAt: timestamp,
                providerUpdatedAt: timestamp,
                metadata: { provider: "test" },
                providerFiatAmount: null,
                providerFiatCurrency: null,
                principalId: TEST_PRINCIPAL_ID,
              },
              venueContext: {
                venueType: "cex",
                cexAccountId: fixture.cexAccountId,
                externalAccountId: "test-account",
                externalOrderId: null,
                externalFillId: null,
                side: "buy",
                instrument: "BTC-EUR",
                fillPrice: "10000",
                commissionAmount: null,
                commissionCurrency: null,
                metadata: { provider: "test" },
              },
              providerTransfers: [],
              canonicalTransfers: [],
              providerAssetRowIds,
              legs: [],
              transactionReview: null,
              resolvedTransactionType: APPROVED_MAPPING,
            })
          )
        )

      const selectUses = (transactionId: string) =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                providerAssetRowId: schema.providerAssetTransactionUses.providerAssetRowId,
                sourceId: schema.providerAssetTransactionUses.sourceId,
              })
              .from(schema.providerAssetTransactionUses)
              .where(eq(schema.providerAssetTransactionUses.transactionId, transactionId))
              .orderBy(asc(schema.providerAssetTransactionUses.providerAssetRowId))
          })
        )

      const persisted = yield* Effect.promise(() => persist([assetA.id, assetB.id, assetA.id]))
      expect(yield* Effect.promise(() => selectUses(persisted.transaction.id))).toEqual(
        [assetA.id, assetB.id]
          .sort()
          .map((providerAssetRowId) => ({ providerAssetRowId, sourceId: TEST_SOURCE_ID }))
      )

      // A replay can change the record's dependencies; stale rows must go.
      yield* Effect.promise(() => persist([assetB.id]))
      expect(yield* Effect.promise(() => selectUses(persisted.transaction.id))).toEqual([
        { providerAssetRowId: assetB.id, sourceId: TEST_SOURCE_ID },
      ])

      yield* Effect.promise(() => persist([]))
      expect(yield* Effect.promise(() => selectUses(persisted.transaction.id))).toEqual([])
    })
  )

  it.effect("keeps an external-only transaction ID stable after deletion and re-creation", () =>
    Effect.gen(function* () {
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z"))
      const persist = () =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts({
              transaction: {
                sourceId: TEST_SOURCE_ID,
                sourceRawRecordId: null,
                externalId: "external-only-stable-transaction",
                externalGroupId: null,
                timestamp,
                transactionType: "buy_fiat",
                providerTransactionType: "buy",
                providerStatus: "completed",
                providerResourcePath: null,
                providerDescription: "External-only stable transaction",
                providerCreatedAt: timestamp,
                providerUpdatedAt: timestamp,
                metadata: { provider: "test" },
                providerFiatAmount: null,
                providerFiatCurrency: null,
                principalId: TEST_PRINCIPAL_ID,
              },
              venueContext: {
                venueType: "cex",
                cexAccountId: fixture.cexAccountId,
                externalAccountId: "test-account",
                externalOrderId: null,
                externalFillId: null,
                side: "buy",
                instrument: "BTC-EUR",
                fillPrice: "10000",
                commissionAmount: null,
                commissionCurrency: null,
                metadata: { provider: "test" },
              },
              providerTransfers: [],
              canonicalTransfers: [],
              providerAssetRowIds: [],
              legs: [],
              transactionReview: null,
              resolvedTransactionType: APPROVED_MAPPING,
            })
          )
        )

      const first = yield* Effect.promise(() => persist())
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .delete(schema.transactions)
              .where(eq(schema.transactions.id, first.transaction.id))
          })
        )
      )
      const recreated = yield* Effect.promise(() => persist())

      expect(recreated.transaction.id).toBe(first.transaction.id)
    })
  )

  it.effect("reserves replay credits atomically before derived state can be reset", () =>
    Effect.gen(function* () {
      const secondRawRecordId = "00000000-0000-0000-0000-000000000484"
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.delete(schema.creditLedger)
            yield* db.insert(schema.creditLedger).values({
              userId: fixture.userId,
              delta: 1,
              kind: "manual_adjustment",
              reference: "test:single-replay-credit",
              paymentReference: null,
              expiresAt: null,
            })
            yield* seedRawRecord({
              rawRecordId: secondRawRecordId,
              externalRecordId: "raw-replay-credit-second",
              occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T10:00:00.000Z")),
            })
          })
        )
      )

      const replayCreditError = yield* Effect.promise(() =>
        runRepository(
          Effect.flip(
            Effect.flatMap(SourceNormalizationRepository, (repository) =>
              repository.reserveReplayTransactionCredits({
                reservationId: "replay-credit-atomicity",
                transactions: [
                  {
                    sourceId: TEST_SOURCE_ID,
                    sourceRawRecordId: TEST_RAW_RECORD_ID,
                    externalId: "replay-credit-first",
                    principalId: TEST_PRINCIPAL_ID,
                  },
                  {
                    sourceId: TEST_SOURCE_ID,
                    sourceRawRecordId: secondRawRecordId,
                    externalId: "replay-credit-second",
                    principalId: TEST_PRINCIPAL_ID,
                  },
                ],
              })
            )
          )
        )
      )

      expect(replayCreditError).toBeInstanceOf(SourceSyncCreditExhaustedError)
      expect(replayCreditError).toMatchObject({ reasonCode: "no_usable_credits" })

      const usage = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ count: sql<number>`count(*)` })
              .from(schema.creditLedger)
              .where(eq(schema.creditLedger.kind, "transaction_usage"))
          })
        )
      )

      expect(Number(usage[0]?.count ?? 0)).toBe(0)
    })
  )

  it.effect("releases only the credits inserted by a failed replay reservation", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.delete(schema.creditLedger)
            yield* db.insert(schema.creditLedger).values({
              userId: fixture.userId,
              delta: 1,
              kind: "manual_adjustment",
              reference: "test:replay-credit-compensation",
              paymentReference: null,
              expiresAt: null,
            })
          })
        )
      )

      const references = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.reserveReplayTransactionCredits({
              reservationId: "replay-credit-compensation",
              transactions: [
                {
                  sourceId: TEST_SOURCE_ID,
                  sourceRawRecordId: TEST_RAW_RECORD_ID,
                  externalId: "replay-credit-compensation",
                  principalId: TEST_PRINCIPAL_ID,
                },
              ],
            })
          )
        )
      )

      expect(references).toEqual([
        {
          reference: `transaction:${TEST_SOURCE_ID}:external:replay-credit-compensation`,
          sourceRawRecordId: TEST_RAW_RECORD_ID,
        },
      ])

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.releaseReplayTransactionCredits({
              reservationId: "replay-credit-compensation",
              references: references.map(({ reference }) => reference),
            })
          )
        )
      )

      const ledger = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                kind: schema.creditLedger.kind,
                reference: schema.creditLedger.reference,
              })
              .from(schema.creditLedger)
          })
        )
      )

      expect(ledger).toEqual([
        { kind: "manual_adjustment", reference: "test:replay-credit-compensation" },
      ])
    })
  )

  it.effect("lets a successor adopt a replay reservation before stale cleanup runs", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z"))
      const transaction = {
        sourceId: TEST_SOURCE_ID,
        sourceRawRecordId: TEST_RAW_RECORD_ID,
        externalId: "replay-credit-adoption",
        externalGroupId: null,
        timestamp: occurredAt,
        transactionType: "buy_fiat",
        providerTransactionType: "buy",
        providerStatus: "completed",
        providerResourcePath: null,
        providerDescription: null,
        providerCreatedAt: occurredAt,
        providerUpdatedAt: occurredAt,
        metadata: null,
        providerFiatAmount: null,
        providerFiatCurrency: null,
        principalId: TEST_PRINCIPAL_ID,
      } as const
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.delete(schema.creditLedger)
            yield* db.insert(schema.creditLedger).values({
              userId: fixture.userId,
              delta: 1,
              kind: "manual_adjustment",
              reference: "test:replay-credit-adoption",
              paymentReference: null,
              expiresAt: null,
            })
          })
        )
      )

      const first = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.reserveReplayTransactionCredits({
              reservationId: "replay-owner-old",
              transactions: [transaction],
            })
          )
        )
      )
      const adopted = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.reserveReplayTransactionCredits({
              reservationId: "replay-owner-successor",
              transactions: [transaction],
            })
          )
        )
      )
      const stalePersistence = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository
              .persistNormalizedArtifacts({
                replayReservationId: "replay-owner-old",
                transaction,
                venueContext: {
                  venueType: "cex",
                  cexAccountId: fixture.cexAccountId,
                  externalAccountId: "coinbase-account-1",
                  externalOrderId: null,
                  externalFillId: null,
                  side: "buy",
                  instrument: "BTC-EUR",
                  fillPrice: "10000.00",
                  commissionAmount: null,
                  commissionCurrency: null,
                  metadata: null,
                },
                providerTransfers: [],
                canonicalTransfers: [],
                providerAssetRowIds: [],
                legs: [],
                transactionReview: null,
                resolvedTransactionType: APPROVED_MAPPING,
              })
              .pipe(Effect.result)
          )
        )
      )
      yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* SourceNormalizationRepository
            yield* repository.releaseReplayTransactionCredits({
              reservationId: "replay-owner-old",
              references: first.map(({ reference }) => reference),
            })
            yield* repository.persistNormalizedArtifacts({
              replayReservationId: "replay-owner-successor",
              transaction,
              venueContext: {
                venueType: "cex",
                cexAccountId: fixture.cexAccountId,
                externalAccountId: "coinbase-account-1",
                externalOrderId: null,
                externalFillId: null,
                side: "buy",
                instrument: "BTC-EUR",
                fillPrice: "10000.00",
                commissionAmount: null,
                commissionCurrency: null,
                metadata: null,
              },
              providerTransfers: [],
              canonicalTransfers: [],
              providerAssetRowIds: [],
              legs: [],
              transactionReview: null,
              resolvedTransactionType: APPROVED_MAPPING,
            })
            yield* repository.releaseReplayTransactionCredits({
              reservationId: "replay-owner-successor",
              references: first.map(({ reference }) => reference),
            })
          })
        )
      )

      const usage = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                reference: schema.creditLedger.reference,
                replayReservationId: schema.creditLedger.replayReservationId,
              })
              .from(schema.creditLedger)
              .where(eq(schema.creditLedger.kind, "transaction_usage"))
          })
        )
      )

      expect(stalePersistence._tag).toBe("Failure")
      expect(adopted).toEqual(first)
      expect(usage).toEqual([
        {
          reference: `transaction:${TEST_SOURCE_ID}:external:replay-credit-adoption`,
          replayReservationId: null,
        },
      ])
    })
  )

  it.effect("releases an adopted replay reservation when the successor fails", () =>
    Effect.gen(function* () {
      const transaction = {
        sourceId: TEST_SOURCE_ID,
        sourceRawRecordId: TEST_RAW_RECORD_ID,
        externalId: "replay-credit-adoption-failure",
        principalId: TEST_PRINCIPAL_ID,
      }
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.delete(schema.creditLedger)
            yield* db.insert(schema.creditLedger).values({
              userId: fixture.userId,
              delta: 1,
              kind: "manual_adjustment",
              reference: "test:replay-credit-adoption-failure",
              paymentReference: null,
              expiresAt: null,
            })
          })
        )
      )

      const first = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.reserveReplayTransactionCredits({
              reservationId: "replay-owner-old",
              transactions: [transaction],
            })
          )
        )
      )
      const adopted = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.reserveReplayTransactionCredits({
              reservationId: "replay-owner-successor",
              transactions: [transaction],
            })
          )
        )
      )

      yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* SourceNormalizationRepository
            yield* repository.releaseReplayTransactionCredits({
              reservationId: "replay-owner-old",
              references: first.map(({ reference }) => reference),
            })
            yield* repository.releaseReplayTransactionCredits({
              reservationId: "replay-owner-successor",
              references: adopted.map(({ reference }) => reference),
            })
          })
        )
      )

      const usage = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ reference: schema.creditLedger.reference })
              .from(schema.creditLedger)
              .where(eq(schema.creditLedger.kind, "transaction_usage"))
          })
        )
      )

      expect(adopted).toEqual(first)
      expect(usage).toEqual([])
    })
  )

  it.effect("consumes one credit for a registered user transaction across source replay", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z"))
      const artifacts = {
        transaction: {
          sourceId: TEST_SOURCE_ID,
          sourceRawRecordId: TEST_RAW_RECORD_ID,
          externalId: "transaction-with-credit",
          externalGroupId: null,
          timestamp: occurredAt,
          transactionType: "buy_fiat",
          providerTransactionType: "buy",
          providerStatus: "completed",
          providerResourcePath: null,
          providerDescription: null,
          providerCreatedAt: occurredAt,
          providerUpdatedAt: occurredAt,
          metadata: null,
          providerFiatAmount: null,
          providerFiatCurrency: null,
          principalId: TEST_PRINCIPAL_ID,
        },
        venueContext: {
          venueType: "cex" as const,
          cexAccountId: fixture.cexAccountId,
          externalAccountId: "coinbase-account-1",
          externalOrderId: null,
          externalFillId: null,
          side: "buy" as const,
          instrument: "BTC-EUR",
          fillPrice: "10000.00",
          commissionAmount: null,
          commissionCurrency: null,
          metadata: null,
        },
        providerTransfers: [],
        canonicalTransfers: [],
        providerAssetRowIds: [],
        legs: [],
        transactionReview: null,
        resolvedTransactionType: APPROVED_MAPPING,
      } as const

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts(artifacts)
          )
        )
      )
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.sourceRecordsRaw)
              .set({
                importedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-03T00:00:00.000Z")),
                updatedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-03T00:00:00.000Z")),
              })
              .where(eq(schema.sourceRecordsRaw.id, TEST_RAW_RECORD_ID))
            yield* db
              .delete(schema.transactions)
              .where(eq(schema.transactions.externalId, "transaction-with-credit"))
          })
        )
      )
      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts(artifacts)
          )
        )
      )

      const usage = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                count: sql<number>`count(*)`,
                totalDelta: sql<number>`coalesce(sum(${schema.creditLedger.delta}), 0)`,
              })
              .from(schema.creditLedger)
              .where(eq(schema.creditLedger.kind, "transaction_usage"))
          })
        )
      )

      expect(Number(usage[0]?.count ?? 0)).toBe(1)
      expect(Number(usage[0]?.totalDelta ?? 0)).toBe(-1)
    })
  )

  it.effect(
    "commits an earlier transaction and fails a typed credit-exhausted error once a registered user's balance runs out",
    () =>
      Effect.gen(function* () {
        const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z"))
        const secondRawRecordId = "00000000-0000-0000-0000-000000000382"

        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db.delete(schema.creditLedger)
              yield* db.insert(schema.creditLedger).values({
                userId: fixture.userId,
                delta: 1,
                kind: "manual_adjustment",
                reference: "test:single-usable-credit",
                expiresAt: null,
              })
            })
          )
        )
        yield* Effect.promise(() =>
          runPg(
            seedRawRecord({
              rawRecordId: secondRawRecordId,
              externalRecordId: "raw-acquire-2",
              occurredAt,
            })
          )
        )

        yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(SourceNormalizationRepository, (repository) =>
              repository.persistNormalizedArtifacts(
                buildBuyArtifacts({
                  occurredAt,
                  externalId: "transaction-covered-by-credit",
                  sourceRawRecordId: TEST_RAW_RECORD_ID,
                })
              )
            )
          )
        )

        const error = yield* Effect.promise(() =>
          runRepository(
            Effect.flip(
              Effect.flatMap(SourceNormalizationRepository, (repository) =>
                repository.persistNormalizedArtifacts(
                  buildBuyArtifacts({
                    occurredAt,
                    externalId: "transaction-blocked-by-exhaustion",
                    sourceRawRecordId: secondRawRecordId,
                  })
                )
              )
            )
          )
        )

        expect(error).toBeInstanceOf(SourceSyncCreditExhaustedError)
        expect(error).toMatchObject({
          _tag: "SourceSyncCreditExhaustedError",
          reasonCode: "no_usable_credits",
          availableCredits: 0,
        })

        const persistedTransactions = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return yield* db
                .select({ externalId: schema.transactions.externalId })
                .from(schema.transactions)
                .where(eq(schema.transactions.sourceId, TEST_SOURCE_ID))
            })
          )
        )

        expect(persistedTransactions.map((row) => row.externalId)).toEqual([
          "transaction-covered-by-credit",
        ])

        const usage = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return yield* db
                .select({
                  count: sql<number>`count(*)`,
                  totalDelta: sql<number>`coalesce(sum(${schema.creditLedger.delta}), 0)`,
                })
                .from(schema.creditLedger)
                .where(eq(schema.creditLedger.kind, "transaction_usage"))
            })
          )
        )

        expect(Number(usage[0]?.count ?? 0)).toBe(1)
        expect(Number(usage[0]?.totalDelta ?? 0)).toBe(-1)
      })
  )

  it.effect("continues after a credit top-up and never charges a covered transaction twice", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z"))
      const secondRawRecordId = "00000000-0000-0000-0000-000000000383"

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.delete(schema.creditLedger)
            yield* db.insert(schema.creditLedger).values({
              userId: fixture.userId,
              delta: 1,
              kind: "manual_adjustment",
              reference: "test:continue-initial-credit",
              expiresAt: null,
            })
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(
          seedRawRecord({
            rawRecordId: secondRawRecordId,
            externalRecordId: "raw-continue-2",
            occurredAt,
          })
        )
      )

      const coveredArtifacts = buildBuyArtifacts({
        occurredAt,
        externalId: "transaction-continue-covered",
        sourceRawRecordId: TEST_RAW_RECORD_ID,
      })
      const pausedArtifacts = buildBuyArtifacts({
        occurredAt,
        externalId: "transaction-continue-paused",
        sourceRawRecordId: secondRawRecordId,
      })
      const persist = (artifacts: ReturnType<typeof buildBuyArtifacts>) =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts(artifacts)
          )
        )

      yield* Effect.promise(() => persist(coveredArtifacts))
      const pauseError = yield* Effect.promise(() =>
        runRepository(
          Effect.flip(
            Effect.flatMap(SourceNormalizationRepository, (repository) =>
              repository.persistNormalizedArtifacts(pausedArtifacts)
            )
          )
        )
      )
      expect(pauseError).toBeInstanceOf(SourceSyncCreditExhaustedError)

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.creditLedger).values({
              userId: fixture.userId,
              delta: 2,
              kind: "manual_adjustment",
              reference: "test:continue-top-up",
              expiresAt: null,
            })
          })
        )
      )

      // The continue pass replays the paused transaction and may also revisit the
      // covered one; neither may produce a second usage charge.
      yield* Effect.promise(() => persist(pausedArtifacts))
      yield* Effect.promise(() => persist(coveredArtifacts))
      yield* Effect.promise(() => persist(pausedArtifacts))

      const persistedTransactions = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ externalId: schema.transactions.externalId })
              .from(schema.transactions)
              .where(eq(schema.transactions.sourceId, TEST_SOURCE_ID))
              .orderBy(asc(schema.transactions.externalId))
          })
        )
      )
      expect(persistedTransactions.map((row) => row.externalId)).toEqual([
        "transaction-continue-covered",
        "transaction-continue-paused",
      ])

      const usage = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                reference: schema.creditLedger.reference,
                delta: schema.creditLedger.delta,
              })
              .from(schema.creditLedger)
              .where(eq(schema.creditLedger.kind, "transaction_usage"))
              .orderBy(asc(schema.creditLedger.reference))
          })
        )
      )
      expect(usage).toHaveLength(2)
      expect(usage.map((row) => Number(row.delta))).toEqual([-1, -1])
      expect(new Set(usage.map((row) => row.reference)).size).toBe(2)
    })
  )

  it.live("aggregates active credit entries by expiry before choosing a bucket", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z"))
      const depletedExpiry = DateTime.toDateUtc(DateTime.addDuration(yield* DateTime.now, "1 hour"))
      const availableExpiry = DateTime.toDateUtc(
        DateTime.addDuration(yield* DateTime.now, "2 hours")
      )

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.delete(schema.creditLedger)
            yield* db.insert(schema.creditLedger).values([
              {
                userId: fixture.userId,
                delta: 2,
                kind: "manual_adjustment",
                reference: "test:depleted-expiring-grant",
                expiresAt: depletedExpiry,
              },
              {
                userId: fixture.userId,
                delta: -2,
                kind: "transaction_usage",
                reference: "test:depleted-expiring-usage",
                expiresAt: depletedExpiry,
              },
              {
                userId: fixture.userId,
                delta: 1,
                kind: "manual_adjustment",
                reference: "test:available-expiring-grant:first",
                expiresAt: availableExpiry,
              },
              {
                userId: fixture.userId,
                delta: 1,
                kind: "manual_adjustment",
                reference: "test:available-expiring-grant:second",
                expiresAt: availableExpiry,
              },
              {
                userId: fixture.userId,
                delta: 100,
                kind: "manual_adjustment",
                reference: "test:expired-grant",
                expiresAt: DateTime.toDateUtc(
                  DateTime.subtractDuration(yield* DateTime.now, "1 hour")
                ),
              },
              {
                userId: fixture.userId,
                delta: 2,
                kind: "manual_adjustment",
                reference: "test:permanent-grant",
                expiresAt: null,
              },
            ])
          })
        )
      )

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts({
              transaction: {
                sourceId: TEST_SOURCE_ID,
                sourceRawRecordId: TEST_RAW_RECORD_ID,
                externalId: "transaction-using-aggregated-credit-bucket",
                externalGroupId: null,
                timestamp: occurredAt,
                transactionType: "buy_fiat",
                providerTransactionType: "buy",
                providerStatus: "completed",
                providerResourcePath: null,
                providerDescription: null,
                providerCreatedAt: occurredAt,
                providerUpdatedAt: occurredAt,
                metadata: null,
                providerFiatAmount: null,
                providerFiatCurrency: null,
                principalId: TEST_PRINCIPAL_ID,
              },
              venueContext: {
                venueType: "cex",
                cexAccountId: fixture.cexAccountId,
                externalAccountId: "coinbase-account-1",
                externalOrderId: null,
                externalFillId: null,
                side: "buy",
                instrument: "BTC-EUR",
                fillPrice: "10000.00",
                commissionAmount: null,
                commissionCurrency: null,
                metadata: null,
              },
              providerTransfers: [],
              canonicalTransfers: [],
              providerAssetRowIds: [],
              legs: [],
              transactionReview: null,
              resolvedTransactionType: APPROVED_MAPPING,
            })
          )
        )
      )

      const usage = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ expiresAt: schema.creditLedger.expiresAt })
              .from(schema.creditLedger)
              .where(
                eq(
                  schema.creditLedger.reference,
                  `transaction:${TEST_SOURCE_ID}:external:transaction-using-aggregated-credit-bucket`
                )
              )
          })
        )
      )

      expect(usage).toEqual([{ expiresAt: availableExpiry }])
    })
  )

  it.effect("keeps a raw-record credit when replay later discovers external ids", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z"))
      const artifacts = (externalId: string | null) =>
        ({
          transaction: {
            sourceId: TEST_SOURCE_ID,
            sourceRawRecordId: TEST_RAW_RECORD_ID,
            externalId,
            externalGroupId: null,
            timestamp: occurredAt,
            transactionType: "buy_fiat",
            providerTransactionType: "buy",
            providerStatus: "completed",
            providerResourcePath: null,
            providerDescription: null,
            providerCreatedAt: occurredAt,
            providerUpdatedAt: occurredAt,
            metadata: null,
            providerFiatAmount: null,
            providerFiatCurrency: null,
            principalId: TEST_PRINCIPAL_ID,
          },
          venueContext: {
            venueType: "cex" as const,
            cexAccountId: fixture.cexAccountId,
            externalAccountId: "coinbase-account-1",
            externalOrderId: null,
            externalFillId: null,
            side: "buy",
            instrument: "BTC-EUR",
            fillPrice: "10000.00",
            commissionAmount: null,
            commissionCurrency: null,
            metadata: null,
          },
          providerTransfers: [],
          canonicalTransfers: [],
          providerAssetRowIds: [],
          legs: [],
          transactionReview: null,
          resolvedTransactionType: APPROVED_MAPPING,
        }) as const

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts(artifacts(null))
          )
        )
      )
      const firstReservation = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.reserveReplayTransactionCredits({
              reservationId: "replay-discovers-external-a",
              transactions: [artifacts("discovered-external-a").transaction],
            })
          )
        )
      )
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .delete(schema.transactions)
              .where(eq(schema.transactions.sourceId, TEST_SOURCE_ID))
          })
        )
      )
      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts(artifacts("discovered-external-a"))
          )
        )
      )
      const secondReservation = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.reserveReplayTransactionCredits({
              reservationId: "replay-discovers-external-b",
              transactions: [artifacts("discovered-external-b").transaction],
            })
          )
        )
      )

      const usage = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ reference: schema.creditLedger.reference })
              .from(schema.creditLedger)
              .where(eq(schema.creditLedger.kind, "transaction_usage"))
          })
        )
      )

      expect(firstReservation).toEqual([])
      expect(secondReservation).toEqual([])
      expect(usage).toEqual([
        { reference: `transaction:${TEST_SOURCE_ID}:raw:${TEST_RAW_RECORD_ID}` },
      ])
    })
  )

  it.effect(
    "migrates a corrected external credit identity and still deduplicates another raw row",
    () =>
      Effect.gen(function* () {
        const secondRawRecordId = "00000000-0000-0000-0000-000000000485"
        const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z"))
        const artifacts = ({
          externalId,
          sourceRawRecordId,
        }: {
          readonly externalId: string
          readonly sourceRawRecordId: string
        }) =>
          ({
            transaction: {
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId,
              externalId,
              externalGroupId: null,
              timestamp: occurredAt,
              transactionType: "buy_fiat",
              providerTransactionType: "buy",
              providerStatus: "completed",
              providerResourcePath: null,
              providerDescription: null,
              providerCreatedAt: occurredAt,
              providerUpdatedAt: occurredAt,
              metadata: null,
              providerFiatAmount: null,
              providerFiatCurrency: null,
              principalId: TEST_PRINCIPAL_ID,
            },
            venueContext: {
              venueType: "cex" as const,
              cexAccountId: fixture.cexAccountId,
              externalAccountId: "coinbase-account-1",
              externalOrderId: null,
              externalFillId: null,
              side: "buy",
              instrument: "BTC-EUR",
              fillPrice: "10000.00",
              commissionAmount: null,
              commissionCurrency: null,
              metadata: null,
            },
            providerTransfers: [],
            canonicalTransfers: [],
            providerAssetRowIds: [],
            legs: [],
            transactionReview: null,
            resolvedTransactionType: APPROVED_MAPPING,
          }) as const
        const original = artifacts({
          externalId: "external-before-correction",
          sourceRawRecordId: TEST_RAW_RECORD_ID,
        })
        const corrected = artifacts({
          externalId: "external-after-correction",
          sourceRawRecordId: TEST_RAW_RECORD_ID,
        })

        yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(SourceNormalizationRepository, (repository) =>
              repository.persistNormalizedArtifacts(original)
            )
          )
        )
        const correctionReservation = yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(SourceNormalizationRepository, (repository) =>
              repository.reserveReplayTransactionCredits({
                reservationId: "replay-corrects-external",
                transactions: [corrected.transaction],
              })
            )
          )
        )
        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db
                .delete(schema.transactions)
                .where(eq(schema.transactions.sourceId, TEST_SOURCE_ID))
              yield* seedRawRecord({
                rawRecordId: secondRawRecordId,
                externalRecordId: "raw-corrected-duplicate",
                occurredAt,
              })
            })
          )
        )
        yield* Effect.promise(() =>
          runRepository(
            Effect.gen(function* () {
              const repository = yield* SourceNormalizationRepository
              yield* repository.persistNormalizedArtifacts(corrected)
              yield* repository.persistNormalizedArtifacts(
                artifacts({
                  externalId: "external-after-correction",
                  sourceRawRecordId: secondRawRecordId,
                })
              )
            })
          )
        )

        const usage = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return yield* db
                .select({
                  delta: schema.creditLedger.delta,
                  reference: schema.creditLedger.reference,
                })
                .from(schema.creditLedger)
                .where(eq(schema.creditLedger.kind, "transaction_usage"))
            })
          )
        )

        expect(correctionReservation).toEqual([])
        expect(usage).toEqual([
          {
            delta: -1,
            reference: `transaction:${TEST_SOURCE_ID}:external:external-after-correction`,
          },
        ])
      })
  )

  it.effect("allows only one concurrent transaction when one credit remains across sources", () =>
    Effect.gen(function* () {
      const secondSourceId = "00000000-0000-0000-0000-000000000481"
      const secondRawRecordId = "00000000-0000-0000-0000-000000000482"
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z"))
      const secondCexAccountId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.delete(schema.creditLedger)
            yield* db.insert(schema.creditLedger).values({
              userId: fixture.userId,
              delta: 1,
              kind: "manual_adjustment",
              reference: "test:one-concurrent-credit",
              paymentReference: null,
              expiresAt: null,
            })
            const [currentAccount] = yield* db
              .select({ cexId: schema.cexAccount.cexId })
              .from(schema.cexAccount)
              .where(eq(schema.cexAccount.id, fixture.cexAccountId))
              .limit(1)
            if (currentAccount === undefined) {
              return yield* Effect.die("Missing primary CEX account fixture")
            }
            const [secondAccount] = yield* db
              .insert(schema.cexAccount)
              .values({
                cexId: currentAccount.cexId,
                principalId: TEST_PRINCIPAL_ID,
                providerUserId: "coinbase-concurrent-user",
                providerAccountId: "coinbase-concurrent-account",
                accessToken: "test-access-token",
                refreshToken: "test-refresh-token",
                expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe("2030-01-01T00:00:00.000Z")),
                scopes: "wallet:accounts:read wallet:transactions:read",
              })
              .returning({ id: schema.cexAccount.id })
            if (secondAccount === undefined) {
              return yield* Effect.die("Failed to create second CEX account fixture")
            }
            yield* db.insert(schema.sources).values({
              id: secondSourceId,
              principalId: TEST_PRINCIPAL_ID,
              name: "Concurrent Coinbase Source",
              providerKey: "coinbase",
              sourceableType: "cex",
              cexAccountId: secondAccount.id,
              addressId: null,
            })
            yield* db.insert(schema.sourceRecordsRaw).values({
              id: secondRawRecordId,
              sourceId: secondSourceId,
              provider: "coinbase",
              recordType: "coinbase_transaction",
              externalAccountId: "coinbase-concurrent-account",
              externalRecordId: "raw-concurrent-second",
              occurredAt,
              payload: { id: "raw-concurrent-second" },
              importedAt: occurredAt,
            })
            return secondAccount.id
          })
        )
      )

      const artifacts = ({
        sourceId,
        sourceRawRecordId,
        externalId,
        cexAccountId,
        externalAccountId,
      }: {
        readonly sourceId: string
        readonly sourceRawRecordId: string
        readonly externalId: string
        readonly cexAccountId: string
        readonly externalAccountId: string
      }) => ({
        transaction: {
          sourceId,
          sourceRawRecordId,
          externalId,
          externalGroupId: null,
          timestamp: occurredAt,
          transactionType: "buy_fiat" as const,
          providerTransactionType: "buy",
          providerStatus: "completed",
          providerResourcePath: null,
          providerDescription: null,
          providerCreatedAt: occurredAt,
          providerUpdatedAt: occurredAt,
          metadata: null,
          providerFiatAmount: null,
          providerFiatCurrency: null,
          principalId: TEST_PRINCIPAL_ID,
        },
        venueContext: {
          venueType: "cex" as const,
          cexAccountId,
          externalAccountId,
          externalOrderId: null,
          externalFillId: null,
          side: "buy" as const,
          instrument: "BTC-EUR",
          fillPrice: "10000.00",
          commissionAmount: null,
          commissionCurrency: null,
          metadata: null,
        },
        providerTransfers: [],
        canonicalTransfers: [],
        providerAssetRowIds: [],
        legs: [],
        transactionReview: null,
        resolvedTransactionType: APPROVED_MAPPING,
      })
      const results = yield* Effect.promise(() =>
        Promise.allSettled([
          runRepository(
            Effect.flatMap(SourceNormalizationRepository, (repository) =>
              repository.persistNormalizedArtifacts(
                artifacts({
                  sourceId: TEST_SOURCE_ID,
                  sourceRawRecordId: TEST_RAW_RECORD_ID,
                  externalId: "concurrent-credit-first",
                  cexAccountId: fixture.cexAccountId,
                  externalAccountId: "coinbase-account-1",
                })
              )
            )
          ),
          runRepository(
            Effect.flatMap(SourceNormalizationRepository, (repository) =>
              repository.persistNormalizedArtifacts(
                artifacts({
                  sourceId: secondSourceId,
                  sourceRawRecordId: secondRawRecordId,
                  externalId: "concurrent-credit-second",
                  cexAccountId: secondCexAccountId,
                  externalAccountId: "coinbase-concurrent-account",
                })
              )
            )
          ),
        ])
      )

      const state = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const usage = yield* db
              .select({
                count: sql<number>`count(*)`,
                delta: sql<number>`sum(${schema.creditLedger.delta})`,
              })
              .from(schema.creditLedger)
              .where(eq(schema.creditLedger.kind, "transaction_usage"))
            const transactions = yield* db
              .select({ externalId: schema.transactions.externalId })
              .from(schema.transactions)
            return { usage, transactions }
          })
        )
      )

      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1)
      expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1)
      expect(Number(state.usage[0]?.count ?? 0)).toBe(1)
      expect(Number(state.usage[0]?.delta ?? 0)).toBe(-1)
      expect(
        state.transactions.filter(({ externalId }) => externalId?.startsWith("concurrent-credit-"))
      ).toHaveLength(1)
    })
  )

  it.effect("preserves x402 payment for raw records retained when a source is claimed", () =>
    Effect.gen(function* () {
      const anonymousPrincipalId = "00000000-0000-0000-0000-000000000491"
      const postClaimRawRecordId = "00000000-0000-0000-0000-000000000492"
      const claimConsumedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:00:00.000Z"))
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z"))
      const paidArtifacts = {
        transaction: {
          sourceId: TEST_SOURCE_ID,
          sourceRawRecordId: TEST_RAW_RECORD_ID,
          externalId: "claimed-x402-paid-transaction",
          externalGroupId: null,
          timestamp: occurredAt,
          transactionType: "buy_fiat",
          providerTransactionType: "buy",
          providerStatus: "completed",
          providerResourcePath: null,
          providerDescription: null,
          providerCreatedAt: occurredAt,
          providerUpdatedAt: occurredAt,
          metadata: null,
          providerFiatAmount: null,
          providerFiatCurrency: null,
          principalId: TEST_PRINCIPAL_ID,
        },
        venueContext: {
          venueType: "cex" as const,
          cexAccountId: fixture.cexAccountId,
          externalAccountId: "coinbase-account-1",
          externalOrderId: null,
          externalFillId: null,
          side: "buy" as const,
          instrument: "BTC-EUR",
          fillPrice: "10000.00",
          commissionAmount: null,
          commissionCurrency: null,
          metadata: null,
        },
        providerTransfers: [],
        canonicalTransfers: [],
        providerAssetRowIds: [],
        legs: [],
        transactionReview: null,
        resolvedTransactionType: APPROVED_MAPPING,
      } as const

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.delete(schema.creditLedger)
            yield* db.delete(schema.billingAccounts)
            yield* db.insert(schema.principals).values({
              id: anonymousPrincipalId,
              kind: "anonymous_wallet",
              userId: null,
            })
            yield* db.insert(schema.principalClaims).values({
              principalId: anonymousPrincipalId,
              sourceId: TEST_SOURCE_ID,
              requestId: "00000000-0000-0000-0000-000000000493",
              claimType: "x402_receipt",
              claimValueHash: "claimed-x402-paid-replay",
              consumedAt: claimConsumedAt,
            })
          })
        )
      )

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts(paidArtifacts)
          )
        )
      )
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .delete(schema.transactions)
              .where(eq(schema.transactions.externalId, "claimed-x402-paid-transaction"))
          })
        )
      )
      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts(paidArtifacts)
          )
        )
      )

      yield* Effect.promise(() =>
        runPg(
          seedRawRecord({
            rawRecordId: postClaimRawRecordId,
            externalRecordId: "raw-after-x402-claim",
            occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-03T00:00:00.000Z")),
          })
        )
      )
      const postClaimCreditError = yield* Effect.promise(() =>
        runRepository(
          Effect.flip(
            Effect.flatMap(SourceNormalizationRepository, (repository) =>
              repository.persistNormalizedArtifacts({
                ...paidArtifacts,
                transaction: {
                  ...paidArtifacts.transaction,
                  sourceRawRecordId: postClaimRawRecordId,
                  externalId: "transaction-after-x402-claim",
                  timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-03T00:00:00.000Z")),
                  providerCreatedAt: DateTime.toDateUtc(
                    DateTime.makeUnsafe("2025-01-03T00:00:00.000Z")
                  ),
                  providerUpdatedAt: DateTime.toDateUtc(
                    DateTime.makeUnsafe("2025-01-03T00:00:00.000Z")
                  ),
                },
              })
            )
          )
        )
      )

      expect(postClaimCreditError).toBeInstanceOf(SourceSyncCreditExhaustedError)
      expect(postClaimCreditError).toMatchObject({ reasonCode: "no_usable_credits" })

      const state = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const usage = yield* db
              .select({ count: sql<number>`count(*)` })
              .from(schema.creditLedger)
              .where(eq(schema.creditLedger.kind, "transaction_usage"))
            const transactions = yield* db
              .select({ externalId: schema.transactions.externalId })
              .from(schema.transactions)
            return { usage, transactions }
          })
        )
      )

      expect(Number(state.usage[0]?.count ?? 0)).toBe(0)
      expect(state.transactions.map(({ externalId }) => externalId)).toContain(
        "claimed-x402-paid-transaction"
      )
      expect(state.transactions.map(({ externalId }) => externalId)).not.toContain(
        "transaction-after-x402-claim"
      )
    })
  )

  it.effect("rolls back a registered user transaction when credits are exhausted", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z"))

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.delete(schema.creditLedger)
          })
        )
      )

      const noCreditError = yield* Effect.promise(() =>
        runRepository(
          Effect.flip(
            Effect.flatMap(SourceNormalizationRepository, (repository) =>
              repository.persistNormalizedArtifacts({
                transaction: {
                  sourceId: TEST_SOURCE_ID,
                  sourceRawRecordId: TEST_RAW_RECORD_ID,
                  externalId: "transaction-without-credit",
                  externalGroupId: null,
                  timestamp: occurredAt,
                  transactionType: "buy_fiat",
                  providerTransactionType: "buy",
                  providerStatus: "completed",
                  providerResourcePath: null,
                  providerDescription: null,
                  providerCreatedAt: occurredAt,
                  providerUpdatedAt: occurredAt,
                  metadata: null,
                  providerFiatAmount: null,
                  providerFiatCurrency: null,
                  principalId: TEST_PRINCIPAL_ID,
                },
                venueContext: {
                  venueType: "cex",
                  cexAccountId: fixture.cexAccountId,
                  externalAccountId: "coinbase-account-1",
                  externalOrderId: null,
                  externalFillId: null,
                  side: "buy",
                  instrument: "BTC-EUR",
                  fillPrice: "10000.00",
                  commissionAmount: null,
                  commissionCurrency: null,
                  metadata: null,
                },
                providerTransfers: [],
                canonicalTransfers: [],
                providerAssetRowIds: [],
                legs: [],
                transactionReview: null,
                resolvedTransactionType: APPROVED_MAPPING,
              })
            )
          )
        )
      )

      expect(noCreditError).toBeInstanceOf(SourceSyncCreditExhaustedError)
      expect(noCreditError).toMatchObject({ reasonCode: "no_usable_credits" })

      const persistedTransactions = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ count: sql<number>`count(*)` })
              .from(schema.transactions)
              .where(eq(schema.transactions.externalId, "transaction-without-credit"))
          })
        )
      )

      expect(Number(persistedTransactions[0]?.count ?? 0)).toBe(0)
    })
  )

  it.effect("persists exact observed provider transfer representations", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z"))
      const smallestU8DecimalAmount = `0.${"0".repeat(254)}1`
      const globalRepresentationCountBefore = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [row] = yield* db
              .select({ count: sql<number>`count(*)` })
              .from(schema.assetRepresentations)
            return Number(row?.count ?? 0)
          })
        )
      )
      const sharedTransfer = {
        sourceId: TEST_SOURCE_ID,
        sourceRawRecordId: TEST_RAW_RECORD_ID,
        externalGroupId: "group-observed-representations",
        providerAssetId: null,
        timestamp: occurredAt,
        direction: "inbound" as const,
        processingMode: "accounting_and_evidence" as const,
        fromAccountRef: null,
        toAccountRef: null,
        fromAddress: "external-address",
        toAddress: "owned-address",
        networkName: "base",
        networkHash: "hash-observed-representations",
        observedBlockchainId: fixture.baseBlockchainId,
        observedContractAddress: null,
        observedMintAddress: null,
        amount: "1",
        metadata: { provider: "test-onchain-adapter" },
      }
      const providerTransfers = [
        {
          ...sharedTransfer,
          externalId: "observed-native",
          observedRepresentationType: "native" as const,
          observedDecimals: 18,
        },
        {
          ...sharedTransfer,
          externalId: "observed-token",
          observedRepresentationType: "token" as const,
          observedContractAddress: "0xAbCd000000000000000000000000000000000096",
          observedDecimals: 6,
        },
        {
          ...sharedTransfer,
          externalId: "observed-case-sensitive-contract",
          observedRepresentationType: "token" as const,
          observedContractAddress: "CaseSensitiveContractAddress",
          observedDecimals: 6,
        },
        {
          ...sharedTransfer,
          externalId: "observed-nft",
          observedRepresentationType: "nft" as const,
          observedMintAddress: "NftMint111111111111111111111111111111111111",
          observedDecimals: 0,
        },
        {
          ...sharedTransfer,
          externalId: "observed-unknown-type",
          observedRepresentationType: null,
          observedMintAddress: "UnknownMint11111111111111111111111111111111",
          observedDecimals: 5,
        },
        {
          ...sharedTransfer,
          externalId: "observed-max-decimals",
          observedRepresentationType: "token" as const,
          observedMintAddress: "MaxDecimalsMint111111111111111111111111111111",
          observedDecimals: 255,
          amount: smallestU8DecimalAmount,
        },
      ]

      const normalizedArtifacts = {
        transaction: {
          sourceId: TEST_SOURCE_ID,
          sourceRawRecordId: TEST_RAW_RECORD_ID,
          externalId: "tx-observed-representations",
          externalGroupId: "group-observed-representations",
          timestamp: occurredAt,
          transactionType: "buy_fiat",
          providerTransactionType: "buy",
          providerStatus: "completed",
          providerResourcePath: null,
          providerDescription: null,
          providerCreatedAt: occurredAt,
          providerUpdatedAt: occurredAt,
          metadata: { provider: "test-onchain-adapter" },
          providerFiatAmount: null,
          providerFiatCurrency: null,
          principalId: TEST_PRINCIPAL_ID,
        },
        venueContext: {
          venueType: "dex",
          cexAccountId: null,
          externalAccountId: "owned-address",
          externalOrderId: null,
          externalFillId: null,
          side: null,
          instrument: null,
          fillPrice: null,
          commissionAmount: null,
          commissionCurrency: null,
          metadata: { provider: "test-onchain-adapter" },
        },
        providerTransfers,
        canonicalTransfers: [],
        providerAssetRowIds: [],
        legs: [],
        transactionReview: null,
        resolvedTransactionType: APPROVED_MAPPING,
      } as const

      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts(normalizedArtifacts)
          )
        )
      )

      expect(result.providerTransfers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            externalId: "observed-native",
            observedBlockchainId: fixture.baseBlockchainId,
            observedRepresentationType: "native",
            observedContractAddress: null,
            observedMintAddress: null,
            observedDecimals: 18,
          }),
          expect.objectContaining({
            externalId: "observed-token",
            observedBlockchainId: fixture.baseBlockchainId,
            observedRepresentationType: "token",
            observedContractAddress: "0xAbCd000000000000000000000000000000000096",
            observedMintAddress: null,
            observedDecimals: 6,
          }),
          expect.objectContaining({
            externalId: "observed-case-sensitive-contract",
            observedBlockchainId: fixture.baseBlockchainId,
            observedRepresentationType: "token",
            observedContractAddress: "CaseSensitiveContractAddress",
            observedMintAddress: null,
            observedDecimals: 6,
          }),
          expect.objectContaining({
            externalId: "observed-nft",
            observedBlockchainId: fixture.baseBlockchainId,
            observedRepresentationType: "nft",
            observedContractAddress: null,
            observedMintAddress: "NftMint111111111111111111111111111111111111",
            observedDecimals: 0,
          }),
          expect.objectContaining({
            externalId: "observed-unknown-type",
            observedBlockchainId: fixture.baseBlockchainId,
            observedRepresentationType: null,
            observedContractAddress: null,
            observedMintAddress: "UnknownMint11111111111111111111111111111111",
            observedDecimals: 5,
          }),
          expect.objectContaining({
            externalId: "observed-max-decimals",
            observedRepresentationType: "token",
            observedMintAddress: "MaxDecimalsMint111111111111111111111111111111",
            observedDecimals: 255,
            amount: smallestU8DecimalAmount,
          }),
        ])
      )

      const sourceUses = yield* Effect.promise(() => loadSourceRepresentationUses(TEST_SOURCE_ID))
      const globalRepresentationCount = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [globalCount] = yield* db
              .select({ count: sql<number>`count(*)` })
              .from(schema.assetRepresentations)
            return Number(globalCount?.count ?? 0)
          })
        )
      )

      expect({ sourceUses, globalRepresentationCount }).toEqual({
        sourceUses: [
          {
            representationType: "native",
            contractAddress: null,
            mintAddress: null,
          },
          {
            representationType: "token",
            contractAddress: "0xabcd000000000000000000000000000000000096",
            mintAddress: null,
          },
          {
            representationType: "token",
            contractAddress: "CaseSensitiveContractAddress",
            mintAddress: null,
          },
          {
            representationType: "token",
            contractAddress: null,
            mintAddress: "MaxDecimalsMint111111111111111111111111111111",
          },
          {
            representationType: "nft",
            contractAddress: null,
            mintAddress: "NftMint111111111111111111111111111111111111",
          },
        ],
        globalRepresentationCount: globalRepresentationCountBefore,
      })

      const observedNativeTransfer = result.providerTransfers.find(
        (transfer) => transfer.externalId === "observed-native"
      )
      expect(observedNativeTransfer).toBeDefined()
      if (observedNativeTransfer === undefined) {
        return
      }

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [canonicalTransfer] = yield* db
              .insert(schema.transfers)
              .values({
                sourceId: TEST_SOURCE_ID,
                sourceRawRecordId: TEST_RAW_RECORD_ID,
                principalId: TEST_PRINCIPAL_ID,
                externalId: "canonical-observed-native",
                externalGroupId: "group-observed-representations",
                addressId: null,
                blockchainId: null,
                txHash: null,
                timestamp: occurredAt,
                type: "cex",
                fromAddress: "external-address",
                toAddress: "owned-address",
                fromAccountRef: null,
                toAccountRef: null,
                fromPartyType: null,
                fromPartyResourcePath: null,
                toPartyType: null,
                toPartyResourcePath: null,
                assetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: null,
                amount: "1",
                tokenId: null,
                notes: null,
                metadata: { provider: "test-onchain-adapter" },
              })
              .returning({ id: schema.transfers.id })

            if (canonicalTransfer === undefined) {
              return yield* Effect.die("Failed to create canonical transfer fixture")
            }

            yield* db.insert(schema.transferReconciliations).values({
              principalId: TEST_PRINCIPAL_ID,
              providerTransferId: observedNativeTransfer.id,
              canonicalTransferId: canonicalTransfer.id,
              canonicalTransactionId: result.transaction.id,
              status: "auto_applied",
              matchReason: "test_stale_observation",
              confidence: "1",
              deterministic: true,
              reviewMetadata: null,
            })
          })
        )
      )

      yield* Effect.promise(() =>
        expect(
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db
                .update(schema.providerTransfers)
                .set({ observedMintAddress: null })
                .where(eq(schema.providerTransfers.externalId, "observed-unknown-type"))
            })
          )
        ).rejects.toThrow()
      )

      yield* Effect.promise(() =>
        expect(
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db
                .update(schema.providerTransfers)
                .set({ processingMode: "accounting_only" })
                .where(eq(schema.providerTransfers.externalId, "observed-native"))
            })
          )
        ).rejects.toThrow()
      )

      yield* Effect.promise(() =>
        expect(
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db
                .update(schema.providerTransfers)
                .set({ processingMode: "stale" })
                .where(eq(schema.providerTransfers.externalId, "observed-native"))
            })
          )
        ).rejects.toThrow()
      )

      yield* Effect.promise(() =>
        expect(
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db
                .update(schema.providerTransfers)
                .set({
                  observedContractAddress: "0x0000000000000000000000000000000000000096",
                })
                .where(eq(schema.providerTransfers.externalId, "observed-unknown-type"))
            })
          )
        ).rejects.toThrow()
      )

      yield* Effect.promise(() =>
        expect(
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db
                .update(schema.providerTransfers)
                .set({ observedDecimals: -1 })
                .where(eq(schema.providerTransfers.externalId, "observed-native"))
            })
          )
        ).rejects.toThrow()
      )

      const partialRetryResult = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts({
              ...normalizedArtifacts,
              providerTransfers: providerTransfers.map((transfer) =>
                transfer.externalId === "observed-unknown-type"
                  ? {
                      ...transfer,
                      observedDecimals: null,
                      amount: "2",
                      metadata: {
                        provider: "retry-without-exact-decimal-evidence",
                        rawUnits: "2",
                      },
                    }
                  : transfer
              ),
            })
          )
        )
      )
      const partiallyRetriedUnknownType = partialRetryResult.providerTransfers.find(
        (transfer) => transfer.externalId === "observed-unknown-type"
      )

      expect(partiallyRetriedUnknownType).toMatchObject({
        observedBlockchainId: fixture.baseBlockchainId,
        observedRepresentationType: null,
        observedContractAddress: null,
        observedMintAddress: "UnknownMint11111111111111111111111111111111",
        observedDecimals: 5,
        amount: expect.stringMatching(/^2(?:\.0+)?$/),
        metadata: {
          provider: "retry-without-exact-decimal-evidence",
          rawUnits: "2",
        },
      })

      const retryResult = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts({
              ...normalizedArtifacts,
              providerTransfers: providerTransfers.map((transfer) =>
                transfer.externalId === "observed-unknown-type"
                  ? {
                      ...transfer,
                      observedBlockchainId: null,
                      observedRepresentationType: null,
                      observedContractAddress: null,
                      observedMintAddress: null,
                      observedDecimals: null,
                      amount: "3",
                      metadata: {
                        provider: "retry-without-observed-representation",
                        rawUnits: "3",
                      },
                    }
                  : transfer
              ),
            })
          )
        )
      )
      const retriedUnknownType = retryResult.providerTransfers.find(
        (transfer) => transfer.externalId === "observed-unknown-type"
      )

      expect(retriedUnknownType).toMatchObject({
        observedBlockchainId: fixture.baseBlockchainId,
        observedRepresentationType: null,
        observedContractAddress: null,
        observedMintAddress: "UnknownMint11111111111111111111111111111111",
        observedDecimals: 5,
        amount: expect.stringMatching(/^3(?:\.0+)?$/),
        metadata: {
          provider: "retry-without-observed-representation",
          rawUnits: "3",
        },
      })

      const correctedResult = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts({
              ...normalizedArtifacts,
              providerTransfers: providerTransfers.map((transfer) =>
                transfer.externalId === "observed-token"
                  ? {
                      ...transfer,
                      observedContractAddress: null,
                      observedMintAddress: "0xAbCd000000000000000000000000000000000097",
                      observedDecimals: 9,
                      amount: "3",
                      metadata: {
                        provider: "corrected-mint-observation",
                        rawUnits: "3000000000",
                      },
                    }
                  : transfer
              ),
            })
          )
        )
      )
      const correctedToken = correctedResult.providerTransfers.find(
        (transfer) => transfer.externalId === "observed-token"
      )

      expect(correctedToken).toMatchObject({
        observedBlockchainId: fixture.baseBlockchainId,
        observedRepresentationType: "token",
        observedContractAddress: null,
        observedMintAddress: "0xAbCd000000000000000000000000000000000097",
        observedDecimals: 9,
        amount: expect.stringMatching(/^3(?:\.0+)?$/),
        metadata: { provider: "corrected-mint-observation", rawUnits: "3000000000" },
      })

      const nativeCorrectionResult = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts({
              ...normalizedArtifacts,
              providerTransfers: providerTransfers.map((transfer) =>
                transfer.externalId === "observed-token"
                  ? {
                      ...transfer,
                      observedRepresentationType: "native" as const,
                      observedContractAddress: null,
                      observedMintAddress: null,
                      observedDecimals: 18,
                      amount: "4",
                      metadata: {
                        provider: "corrected-native-observation",
                        rawUnits: "4000000000000000000",
                      },
                    }
                  : transfer
              ),
            })
          )
        )
      )
      const correctedNative = nativeCorrectionResult.providerTransfers.find(
        (transfer) => transfer.externalId === "observed-token"
      )

      expect(correctedNative).toMatchObject({
        observedBlockchainId: fixture.baseBlockchainId,
        observedRepresentationType: "native",
        observedContractAddress: null,
        observedMintAddress: null,
        observedDecimals: 18,
        amount: expect.stringMatching(/^4(?:\.0+)?$/),
        metadata: {
          provider: "corrected-native-observation",
          rawUnits: "4000000000000000000",
        },
      })

      const accountingOnlyResult = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts({
              ...normalizedArtifacts,
              providerTransfers: providerTransfers.map((transfer) =>
                transfer.externalId === "observed-nft"
                  ? {
                      ...transfer,
                      observedBlockchainId: null,
                      observedRepresentationType: null,
                      observedContractAddress: null,
                      observedMintAddress: null,
                      observedDecimals: null,
                      processingMode: "accounting_only" as const,
                      metadata: { provider: "test-onchain-adapter" },
                    }
                  : transfer
              ),
            })
          )
        )
      )
      expect(
        accountingOnlyResult.providerTransfers.find(
          (transfer) => transfer.externalId === "observed-nft"
        )
      ).toMatchObject({
        observedBlockchainId: null,
        observedRepresentationType: null,
        observedContractAddress: null,
        observedMintAddress: null,
        observedDecimals: null,
        processingMode: "accounting_only",
        metadata: { provider: "test-onchain-adapter" },
      })

      const persistWithoutObservedTransfers = () =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts({
              ...normalizedArtifacts,
              providerTransfers: [],
            })
          )
        )

      yield* Effect.promise(() =>
        expect(persistWithoutObservedTransfers()).rejects.toThrow(
          "sourceNormalizationRepository.clearStaleObservedProviderTransferRepresentations.activeReconciliation"
        )
      )

      const stateAfterRejectedRemoval = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const activeReconciliations = yield* db
              .select()
              .from(schema.transferReconciliations)
              .where(
                eq(schema.transferReconciliations.providerTransferId, observedNativeTransfer.id)
              )
            const preservedTransfers = yield* db
              .select()
              .from(schema.providerTransfers)
              .where(eq(schema.providerTransfers.externalGroupId, "group-observed-representations"))

            return { activeReconciliations, preservedTransfers }
          })
        )
      )

      expect(stateAfterRejectedRemoval.activeReconciliations).toEqual([
        expect.objectContaining({
          providerTransferId: observedNativeTransfer.id,
          status: "auto_applied",
        }),
      ])
      expect(stateAfterRejectedRemoval.preservedTransfers).toHaveLength(6)
      expect(stateAfterRejectedRemoval.preservedTransfers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            externalId: "observed-native",
            observedRepresentationType: "native",
            observedDecimals: 18,
          }),
        ])
      )

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.transferReconciliations)
              .set({ status: "approved" })
              .where(
                eq(schema.transferReconciliations.providerTransferId, observedNativeTransfer.id)
              )
          })
        )
      )
      yield* Effect.promise(() =>
        expect(persistWithoutObservedTransfers()).rejects.toThrow(
          "sourceNormalizationRepository.clearStaleObservedProviderTransferRepresentations.activeReconciliation"
        )
      )

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .delete(schema.transferReconciliations)
              .where(
                eq(schema.transferReconciliations.providerTransferId, observedNativeTransfer.id)
              )
          })
        )
      )
      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts({
              ...normalizedArtifacts,
              providerTransfers: [],
            })
          )
        )
      )

      const staleProviderTransfers = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select()
              .from(schema.providerTransfers)
              .where(eq(schema.providerTransfers.externalGroupId, "group-observed-representations"))
          })
        )
      )

      expect(staleProviderTransfers).toHaveLength(6)
      expect(staleProviderTransfers).toEqual(
        expect.arrayContaining(
          providerTransfers.map((transfer) =>
            expect.objectContaining({
              externalId: transfer.externalId,
              observedBlockchainId: null,
              observedRepresentationType: null,
              observedContractAddress: null,
              observedMintAddress: null,
              observedDecimals: null,
              processingMode: "stale",
            })
          )
        )
      )

      const historicalAndFutureUses = yield* Effect.promise(() =>
        loadSourceRepresentationUses(TEST_SOURCE_ID)
      )

      expect(historicalAndFutureUses).toEqual([
        { representationType: "native", contractAddress: null, mintAddress: null },
        {
          representationType: "token",
          contractAddress: "0xabcd000000000000000000000000000000000096",
          mintAddress: null,
        },
        {
          representationType: "token",
          contractAddress: "CaseSensitiveContractAddress",
          mintAddress: null,
        },
        {
          representationType: "token",
          contractAddress: null,
          mintAddress: "0xabcd000000000000000000000000000000000097",
        },
        {
          representationType: "token",
          contractAddress: null,
          mintAddress: "MaxDecimalsMint111111111111111111111111111111",
        },
        {
          representationType: "nft",
          contractAddress: null,
          mintAddress: "NftMint111111111111111111111111111111111111",
        },
      ])
    })
  )

  it.effect("persists a reviewable partial normalization with no canonical legs", () =>
    Effect.gen(function* () {
      const partialRawRecordId = "00000000-0000-0000-0000-000000000591"

      yield* Effect.promise(() =>
        runPg(
          seedRawRecord({
            rawRecordId: partialRawRecordId,
            externalRecordId: "raw-partial-review-1",
            occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-15T10:00:00.000Z")),
          })
        )
      )

      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts({
              transaction: {
                sourceId: TEST_SOURCE_ID,
                sourceRawRecordId: partialRawRecordId,
                externalId: "tx-partial-review-1",
                externalGroupId: "group-partial-review-1",
                timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-15T10:00:00.000Z")),
                transactionType: "buy_fiat",
                providerTransactionType: "buy",
                providerStatus: "completed",
                providerResourcePath:
                  "/v2/accounts/coinbase-account-1/transactions/tx-partial-review-1",
                providerDescription: "Fixture partial normalization",
                providerCreatedAt: DateTime.toDateUtc(
                  DateTime.makeUnsafe("2025-01-15T10:00:00.000Z")
                ),
                providerUpdatedAt: DateTime.toDateUtc(
                  DateTime.makeUnsafe("2025-01-15T10:00:00.000Z")
                ),
                metadata: { provider: "coinbase", partial: true },
                providerFiatAmount: null,
                providerFiatCurrency: null,
                principalId: TEST_PRINCIPAL_ID,
              },
              venueContext: {
                venueType: "cex",
                cexAccountId: fixture.cexAccountId,
                externalAccountId: "coinbase-account-1",
                externalOrderId: "order-partial-review-1",
                externalFillId: "fill-partial-review-1",
                side: "buy",
                instrument: "HYPE-EUR",
                fillPrice: "42.00",
                commissionAmount: null,
                commissionCurrency: null,
                metadata: { provider: "coinbase", partial: true },
              },
              providerTransfers: [],
              canonicalTransfers: [],
              providerAssetRowIds: [],
              legs: [],
              transactionReview: {
                principalId: TEST_PRINCIPAL_ID,
                reviewStatus: "needs_review",
                originalTypeKey: "buy_fiat",
                originalConfidence: null,
                currentTypeKey: "buy_fiat",
                legalRuleSetVersion: null,
                categorizationReason:
                  "provider_asset_mapping: Coinbase provider asset mapping review is required.",
                matchedLayer: "provider_asset_mapping",
                needsReview: true,
                userNotes: null,
                reviewedAt: null,
              },
              resolvedTransactionType: APPROVED_MAPPING,
            })
          )
        )
      )

      expect(result.transaction.externalId).toBe("tx-partial-review-1")
      expect(result.legs).toHaveLength(0)

      const counts = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [review] = yield* db
              .select({
                reviewStatus: schema.transactionReviews.reviewStatus,
                matchedLayer: schema.transactionReviews.matchedLayer,
                needsReview: schema.transactionReviews.needsReview,
                categorizationReason: schema.transactionReviews.categorizationReason,
              })
              .from(schema.transactionReviews)
              .where(eq(schema.transactionReviews.principalId, TEST_PRINCIPAL_ID))
              .orderBy(schema.transactionReviews.createdAt)
              .limit(1)
            const legs = yield* db.select().from(schema.transactionLegs)
            const [rawRecord] = yield* db
              .select({
                normalizedAt: schema.sourceRecordsRaw.normalizedAt,
                normalizationError: schema.sourceRecordsRaw.normalizationError,
              })
              .from(schema.sourceRecordsRaw)
              .where(eq(schema.sourceRecordsRaw.id, partialRawRecordId))
              .limit(1)

            return {
              review,
              legs,
              rawRecord,
            }
          })
        )
      )

      expect(counts.review).toEqual(
        expect.objectContaining({
          reviewStatus: "needs_review",
          matchedLayer: "provider_asset_mapping",
          needsReview: true,
          categorizationReason: expect.stringContaining("provider_asset_mapping"),
        })
      )
      expect(counts.legs).toHaveLength(0)
      expect(counts.rawRecord?.normalizedAt).not.toBeNull()
      expect(counts.rawRecord?.normalizationError).toBeNull()
    })
  )

  it.effect("resets reconciliation when replay changes only the asset representation", () =>
    Effect.gen(function* () {
      const rawRecordId = "00000000-0000-0000-0000-000000000710"
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:00:00.000Z"))
      const payload = {
        id: "tx-representation-replay-send",
        type: "send",
        status: "completed",
        amount: { amount: "-0.10000000", currency: "BTC" },
        native_amount: { amount: "-1500.00", currency: "EUR" },
        created_at: occurredAt.toISOString(),
        resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-representation-replay-send",
        network: {
          status: "confirmed",
          hash: "tx-representation-replay-hash",
          network_name: "bitcoin",
        },
        to: {
          address: "bc1qrepresentationreplaydestination",
          resource: "address",
        },
      }

      yield* Effect.promise(() =>
        runPg(
          seedRawRecord({
            rawRecordId,
            externalRecordId: "raw-representation-replay-send",
            occurredAt,
            payload,
          })
        )
      )

      const source = buildCoinbaseSource({ cexAccountId: fixture.cexAccountId })
      const normalize = () =>
        runCoinbaseNormalization(
          persistCoinbaseNormalization({
            source,
            sourceRecord: buildSeededRawRecord({
              rawRecordId,
              externalRecordId: "raw-representation-replay-send",
              occurredAt,
              payload,
            }),
          })
        )

      yield* Effect.promise(() => normalize())
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [providerAsset] = yield* db
              .select({ id: schema.providerAssets.id })
              .from(schema.providerAssets)
              .where(eq(schema.providerAssets.currencyCode, "BTC"))
              .limit(1)

            if (providerAsset === undefined) {
              return yield* Effect.die("Missing Coinbase BTC provider asset")
            }

            yield* db
              .update(schema.providerAssetMappings)
              .set({ assetRepresentationId: TEST_BTC_REPRESENTATION_ID })
              .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAsset.id))
            yield* db
              .update(schema.inventoryMovements)
              .set({ taxTreatment: "non_taxable", reconciliationStatus: "matched" })
              .where(eq(schema.inventoryMovements.purpose, "principal"))
          })
        )
      )

      yield* Effect.promise(() => normalize())

      const [movement] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select()
              .from(schema.inventoryMovements)
              .where(eq(schema.inventoryMovements.purpose, "principal"))
          })
        )
      )

      expect(movement).toEqual(
        expect.objectContaining({
          assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
          taxTreatment: "non_taxable",
          reconciliationStatus: "unmatched",
        })
      )
    })
  )

  it.effect("keeps a receive whose sender-paid network fee exceeds the credited amount", () =>
    Effect.gen(function* () {
      const receiveRawRecordId = "00000000-0000-0000-0000-000000000729"
      const receivedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-02T10:00:00.000Z"))
      const receivePayload = {
        id: "tx-small-receive",
        type: "receive",
        status: "completed",
        amount: { amount: "0.00005000", currency: "BTC" },
        native_amount: { amount: "0.50", currency: "EUR" },
        created_at: receivedAt.toISOString(),
        resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-small-receive",
        network: {
          status: "confirmed",
          hash: "tx-small-receive-hash",
          network_name: "base",
          transaction_fee: { amount: "0.00010000", currency: "BTC" },
        },
        from: {
          address: "bc1qsmallreceiveorigin",
          resource: "address",
        },
      }

      yield* Effect.promise(() =>
        runPg(
          seedRawRecord({
            rawRecordId: receiveRawRecordId,
            externalRecordId: "raw-small-receive",
            occurredAt: receivedAt,
            payload: receivePayload,
          })
        )
      )

      const result = yield* Effect.promise(() =>
        runCoinbaseNormalization(
          persistCoinbaseNormalization({
            source: buildCoinbaseSource({ cexAccountId: fixture.cexAccountId }),
            sourceRecord: buildSeededRawRecord({
              rawRecordId: receiveRawRecordId,
              externalRecordId: "raw-small-receive",
              occurredAt: receivedAt,
              payload: receivePayload,
            }),
          })
        )
      )

      expect(result.providerTransfers).toEqual([
        expect.objectContaining({
          externalId: "tx-small-receive:principal",
          direction: "inbound",
          amount: expect.stringContaining("0.00005000"),
        }),
      ])
      expect(result.canonicalTransfers).toHaveLength(0)
      expect(result.legs).toEqual([
        expect.objectContaining({
          kind: "acquisition",
          amount: expect.stringContaining("0.00005000"),
        }),
      ])
    })
  )

  it.effect("moves a replayed fee movement to the leg's current transaction and raw record", () =>
    Effect.gen(function* () {
      const newRawRecordId = "00000000-0000-0000-0000-000000000710"
      const oldTransactionId = "00000000-0000-0000-0000-000000000712"
      const feeLegExternalId = "fee-leg-moved-between-transactions"
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-03T10:00:00.000Z"))

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* seedRawRecord({
              rawRecordId: newRawRecordId,
              externalRecordId: "raw-fee-new-parent",
              occurredAt,
            })
            yield* db.insert(schema.transactions).values({
              id: oldTransactionId,
              sourceId: TEST_SOURCE_ID,
              sourceRawRecordId: TEST_RAW_RECORD_ID,
              externalId: "fee-old-parent",
              timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-02T10:00:00.000Z")),
              principalId: TEST_PRINCIPAL_ID,
            })
            const [feeLeg] = yield* db
              .insert(schema.transactionLegs)
              .values(
                yield* prepareMovementLegFixtures([
                  {
                    movementIdentity: {
                      sourceRecordKey: feeLegExternalId,
                      componentKey: "movement",
                    },
                    sourceId: TEST_SOURCE_ID,
                    sourceRawRecordId: TEST_RAW_RECORD_ID,
                    externalId: feeLegExternalId,
                    timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-02T10:00:00.000Z")),
                    principalId: TEST_PRINCIPAL_ID,
                    assetId: TEST_BTC_ASSET_ID,
                    amount: "0.10000000",
                    kind: "fee",
                    provenance: "deterministic",
                    originKind: "none" as const,
                    transactionId: oldTransactionId,
                    feeForTransactionId: oldTransactionId,
                  },
                ])
              )
              .returning({ id: schema.transactionLegs.id })

            if (feeLeg === undefined) {
              return yield* Effect.die("Failed to create replayed fee movement leg")
            }

            const [movement] = yield* db
              .insert(schema.inventoryMovements)
              .values({
                principalId: TEST_PRINCIPAL_ID,
                sourceId: TEST_SOURCE_ID,
                sourceRawRecordId: TEST_RAW_RECORD_ID,
                transactionId: oldTransactionId,
                transactionLegId: feeLeg.id,
                assetId: TEST_BTC_ASSET_ID,
                timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-02T10:00:00.000Z")),
                direction: "outbound",
                purpose: "fee",
                taxTreatment: "non_taxable",
                reconciliationStatus: "matched",
                amount: "0.10000000",
              })
              .returning({ id: schema.inventoryMovements.id })

            if (movement === undefined) {
              return yield* Effect.die("Failed to create replayed fee movement")
            }
          })
        )
      )

      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts({
              transaction: {
                sourceId: TEST_SOURCE_ID,
                sourceRawRecordId: newRawRecordId,
                externalId: "fee-new-parent",
                externalGroupId: null,
                timestamp: occurredAt,
                transactionType: "buy_fiat",
                providerTransactionType: "buy",
                providerStatus: "completed",
                providerResourcePath: null,
                providerDescription: null,
                providerCreatedAt: occurredAt,
                providerUpdatedAt: occurredAt,
                metadata: { provider: "coinbase" },
                providerFiatAmount: null,
                providerFiatCurrency: null,
                principalId: TEST_PRINCIPAL_ID,
              },
              venueContext: {
                venueType: "cex",
                cexAccountId: fixture.cexAccountId,
                externalAccountId: "coinbase-account-1",
                externalOrderId: "fee-new-parent-order",
                externalFillId: null,
                side: null,
                instrument: null,
                fillPrice: null,
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
                      sourceRecordKey: feeLegExternalId,
                      componentKey: "movement",
                    },
                    sourceId: TEST_SOURCE_ID,
                    sourceRawRecordId: newRawRecordId,
                    externalId: feeLegExternalId,
                    txHash: null,
                    timestamp: occurredAt,
                    principalId: TEST_PRINCIPAL_ID,
                    addressId: null,
                    assetId: TEST_BTC_ASSET_ID,
                    amount: "0.10000000",
                    kind: "fee" as const,
                    provenance: "deterministic" as const,
                    derivationRule: "commission",
                    metadata: { provider: "coinbase" },
                    transactionId: transaction.id,
                    originKind: "none" as const,
                    providerTransferId: null,
                    sourceTransferId: null,
                    fiatAmount: null,
                    fiatCurrency: null,
                    feeForTransactionId: transaction.id,
                  },
                ]),
              transactionReview: null,
              resolvedTransactionType: APPROVED_MAPPING,
            })
          )
        )
      )

      const [movement] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db.select().from(schema.inventoryMovements)
          })
        )
      )

      expect(movement).toEqual(
        expect.objectContaining({
          transactionId: result.transaction.id,
          sourceRawRecordId: newRawRecordId,
          taxTreatment: "non_taxable",
          reconciliationStatus: "unmatched",
        })
      )
    })
  )

  it.effect("rejects mismatched and dual provider-transfer origins", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-03T09:00:00.000Z"))
      const payload = {
        id: "tx-provider-origin-validation",
        type: "receive",
        status: "completed",
        amount: { amount: "0.05000000", currency: "BTC" },
        native_amount: { amount: "750.00", currency: "EUR" },
        created_at: occurredAt.toISOString(),
        resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-provider-origin-validation",
        description: "T10c provider-origin validation fixture",
        network: {
          status: "confirmed",
          hash: "tx-provider-origin-validation-hash",
          network_name: "base",
        },
        from: {
          address: "bc1qprovideroriginvalidationsource",
          resource: "address",
        },
      }
      const source = buildCoinbaseSource({ cexAccountId: fixture.cexAccountId })
      const sourceRecord = buildSeededRawRecord({
        rawRecordId: TEST_RAW_RECORD_ID,
        externalRecordId: "raw-acquire-1",
        occurredAt,
        payload,
      })

      const mismatchedTransactionError = yield* Effect.promise(() =>
        runCoinbaseNormalization(
          persistCoinbaseNormalization({
            source,
            sourceRecord,
            invalidProviderOrigin: "mismatched_transaction",
          }).pipe(Effect.flip)
        )
      )
      expect(mismatchedTransactionError).toMatchObject({
        _tag: "SyncEngineStorageError",
        operation: "sourceNormalizationRepository.finalizeTransactionLegOrigins.scope",
      })

      const dualOriginError = yield* Effect.promise(() =>
        runCoinbaseNormalization(
          persistCoinbaseNormalization({
            source,
            sourceRecord,
            invalidProviderOrigin: "dual_origin",
          }).pipe(Effect.flip)
        )
      )
      expect(dualOriginError).toMatchObject({
        _tag: "SyncEngineStorageError",
        operation: "sourceNormalizationRepository.finalizeTransactionLegOrigins.links",
      })
    })
  )

  it.effect("replays the producer-known provider transfer origin without borrowing it", () =>
    Effect.gen(function* () {
      const rawRecordId = "00000000-0000-0000-0000-000000000693"
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-03T10:00:00.000Z"))
      const payload = {
        id: "tx-receive-provider-transfer-replay-1",
        type: "receive",
        status: "completed",
        amount: { amount: "0.05000000", currency: "BTC" },
        native_amount: { amount: "750.00", currency: "EUR" },
        created_at: occurredAt.toISOString(),
        resource_path:
          "/v2/accounts/coinbase-account-1/transactions/tx-receive-provider-transfer-replay-1",
        description: "T10c provider-origin replay fixture",
        network: {
          status: "confirmed",
          hash: "tx-receive-provider-transfer-replay-hash-1",
          network_name: "base",
        },
        from: {
          address: "bc1qprovidertransferreplaysource",
          resource: "address",
        },
      }

      yield* Effect.promise(() =>
        runPg(
          seedRawRecord({
            rawRecordId,
            externalRecordId: "raw-provider-receive-replay-1",
            occurredAt,
            payload,
          })
        )
      )

      const source = buildCoinbaseSource({ cexAccountId: fixture.cexAccountId })
      const sourceRecord = buildSeededRawRecord({
        rawRecordId,
        externalRecordId: "raw-provider-receive-replay-1",
        occurredAt,
        payload,
      })

      const firstResult = yield* Effect.promise(() =>
        runCoinbaseNormalization(
          persistCoinbaseNormalization({
            source,
            sourceRecord,
            includeOriginlessSibling: true,
          })
        )
      )

      const firstProviderTransfer = firstResult.providerTransfers[0]
      if (firstProviderTransfer === undefined) {
        return yield* Effect.die("Missing provider transfer from T10c replay fixture")
      }

      const loadLegs = () =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                externalId: schema.transactionLegs.externalId,
                originKind: schema.transactionLegs.originKind,
                providerTransferId: schema.transactionLegs.providerTransferId,
                sourceTransferId: schema.transactionLegs.sourceTransferId,
              })
              .from(schema.transactionLegs)
              .where(eq(schema.transactionLegs.transactionId, firstResult.transaction.id))
              .orderBy(asc(schema.transactionLegs.externalId))
          })
        )

      expect(yield* Effect.promise(loadLegs)).toEqual([
        {
          externalId: "tx-receive-provider-transfer-replay-1:main",
          originKind: "provider_transfer",
          providerTransferId: firstProviderTransfer.id,
          sourceTransferId: null,
        },
        {
          externalId: "tx-receive-provider-transfer-replay-1:unrelated",
          originKind: "none",
          providerTransferId: null,
          sourceTransferId: null,
        },
      ])

      yield* Effect.promise(() =>
        runReplayRepository(
          Effect.flatMap(SourceReplayRepository, (repository) =>
            repository.resetSourceDerivedState({ sourceId: source.id })
          )
        )
      )

      expect(yield* Effect.promise(loadLegs)).toEqual([])

      const replayResult = yield* Effect.promise(() =>
        runCoinbaseNormalization(
          persistCoinbaseNormalization({
            source,
            sourceRecord,
            includeOriginlessSibling: true,
          })
        )
      )

      const replayedProviderTransfer = replayResult.providerTransfers[0]
      if (replayedProviderTransfer === undefined) {
        return yield* Effect.die("Missing replayed provider transfer from T10c fixture")
      }

      expect(replayedProviderTransfer.id).not.toBe(firstProviderTransfer.id)

      expect(yield* Effect.promise(loadLegs)).toEqual([
        {
          externalId: "tx-receive-provider-transfer-replay-1:main",
          originKind: "provider_transfer",
          providerTransferId: replayedProviderTransfer.id,
          sourceTransferId: null,
        },
        {
          externalId: "tx-receive-provider-transfer-replay-1:unrelated",
          originKind: "none",
          providerTransferId: null,
          sourceTransferId: null,
        },
      ])
    })
  )
  it.effect("records distinct same-token fee components and retains them through replay", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z"))
      const movementIdentities: ReadonlyArray<SourceMovementIdentity> = [
        {
          _tag: "identified",
          sourceRecordKey: "synthetic-two-fees",
          componentKey: "network.transaction_fee",
        },
        { _tag: "identified", sourceRecordKey: "synthetic-two-fees", componentKey: "commission" },
      ]
      const persist = () =>
        persistExactOverrideArtifact({
          externalId: "synthetic-two-fees",
          fixture,
          occurredAt,
          movementIdentities,
          movementKind: "fee",
          includeCanonicalTransfer: false,
        })
      const first = yield* Effect.promise(persist)
      expect(first.legs).toHaveLength(2)
      expect(new Set(first.legs.map((leg) => leg.movementCorrectionTargetId)).size).toBe(2)
      yield* Effect.promise(() =>
        runReplayRepository(
          Effect.flatMap(SourceReplayRepository, (repository) =>
            repository.resetSourceDerivedState({ sourceId: TEST_SOURCE_ID })
          )
        )
      )
      const replayed = yield* Effect.promise(persist)
      expect(replayed.legs.map((leg) => leg.movementCorrectionTargetId)).toEqual(
        first.legs.map((leg) => leg.movementCorrectionTargetId)
      )
      expect(replayed.legs.every((leg) => first.legs.every((old) => old.id !== leg.id))).toBe(true)
    })
  )

  it.effect(
    "withholds duplicate explicit producer components and preserves unrelated records",
    () =>
      Effect.gen(function* () {
        const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z"))
        const identity: SourceMovementIdentity = {
          _tag: "identified",
          sourceRecordKey: "synthetic-ambiguous",
          componentKey: "amount",
        }
        const result = yield* Effect.promise(() =>
          persistExactOverrideArtifact({
            externalId: "synthetic-ambiguous",
            fixture,
            occurredAt,
            movementIdentities: [identity, identity],
          })
        )
        expect(result.legs).toHaveLength(0)
        const review = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return yield* db
                .select({ reason: schema.transactionReviews.categorizationReason })
                .from(schema.transactionReviews)
                .where(eq(schema.transactionReviews.transactionId, result.transaction.id))
            })
          )
        )
        expect(review).toEqual([{ reason: "ambiguous_movement_identity" }])
        const next = yield* Effect.promise(() =>
          persistExactOverrideArtifact({ externalId: "synthetic-unrelated", fixture, occurredAt })
        )
        expect(next.legs).toHaveLength(1)
      })
  )

  it.effect(
    "rejects foreign-owned target links and retains targets when source deletion is attempted",
    () =>
      Effect.gen(function* () {
        const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z"))
        yield* Effect.promise(() =>
          persistExactOverrideArtifact({
            externalId: "synthetic-owned-target",
            fixture,
            occurredAt,
          })
        )
        const foreignPrincipalId = "00000000-0000-4000-8000-000000008501"
        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db
                .insert(schema.principals)
                .values({ id: foreignPrincipalId, kind: "anonymous_wallet" })
            })
          )
        )
        const targetOwnerChange = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return yield* db
                .update(schema.movementCorrectionTargets)
                .set({ principalId: foreignPrincipalId })
                .where(eq(schema.movementCorrectionTargets.sourceId, TEST_SOURCE_ID))
                .pipe(Effect.exit)
            })
          )
        )
        expect(targetOwnerChange._tag).toBe("Failure")
        const legOwnerChange = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return yield* db
                .update(schema.transactionLegs)
                .set({ principalId: foreignPrincipalId })
                .where(eq(schema.transactionLegs.sourceId, TEST_SOURCE_ID))
                .pipe(Effect.exit)
            })
          )
        )
        expect(legOwnerChange._tag).toBe("Failure")
        const sourceDeletion = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return yield* db
                .delete(schema.sources)
                .where(eq(schema.sources.id, TEST_SOURCE_ID))
                .pipe(Effect.exit)
            })
          )
        )
        expect(sourceDeletion._tag).toBe("Failure")
        const targetCount = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return yield* db
                .select({ id: schema.movementCorrectionTargets.id })
                .from(schema.movementCorrectionTargets)
                .where(eq(schema.movementCorrectionTargets.sourceId, TEST_SOURCE_ID))
            })
          )
        )
        expect(targetCount).toHaveLength(1)
      })
  )
})
