import { prepareMovementLegFixtures } from "../support/movement-leg-fixtures.ts"
import * as DateTime from "effect/DateTime"
import { eq, inArray, sql } from "drizzle-orm"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { TransferReconciliationServiceLive } from "@my/sync-engine/layers"
import {
  SourceNormalizationRepository,
  SourceReplayRepository,
  SyncEngineTransaction,
  TransferReconciliationRepository,
  TransferReconciliationService,
} from "@my/sync-engine/services"
import { SourceNormalizationRepositoryLive } from "../../src/layers/SourceNormalizationRepositoryLive.ts"
import { SourceReplayRepositoryLive } from "../../src/layers/SourceReplayRepositoryLive.ts"
import { SyncEngineTransactionLive } from "../../src/layers/SyncEngineTransactionLive.ts"
import { TransferReconciliationRepositoryLive } from "../../src/layers/TransferReconciliationRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_BTC_REPRESENTATION_ID,
  TEST_EUR_ASSET_ID,
  TEST_EUR_REPRESENTATION_ID,
  TEST_SOURCE_ID,
  TEST_PRINCIPAL_ID,
  makeIntegrationTestDatabaseContext,
  type SyncEngineRepositoryFixture,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_transfer_reconciliation_repo",
})

const runPg = context.runPg

const TransferReconciliationTestLayer = TransferReconciliationServiceLive.pipe(
  Layer.provide(TransferReconciliationRepositoryLive)
)
const ReplayTransactionTestLayer = Layer.mergeAll(
  TransferReconciliationRepositoryLive,
  SyncEngineTransactionLive,
  SourceReplayRepositoryLive
)

const runTransferReconciliation = <A, E>(
  effect: Effect.Effect<A, E, TransferReconciliationService>
) => Effect.runPromise(context.runWithLayer({ effect, layer: TransferReconciliationTestLayer }))

const runTransferReconciliationRepository = <A, E>(
  effect: Effect.Effect<A, E, TransferReconciliationRepository>
) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: TransferReconciliationRepositoryLive }))

const runReplayTransaction = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    SourceReplayRepository | TransferReconciliationRepository | SyncEngineTransaction
  >
) => Effect.runPromise(context.runWithLayer({ effect, layer: ReplayTransactionTestLayer }))

const runSourceNormalization = <A, E>(effect: Effect.Effect<A, E, SourceNormalizationRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: SourceNormalizationRepositoryLive }))

const ONCHAIN_ADDRESS_ID = "00000000-0000-0000-0000-000000000701"
const ONCHAIN_SOURCE_ID = "00000000-0000-0000-0000-000000000702"
const SECOND_ONCHAIN_ADDRESS_ID = "00000000-0000-0000-0000-000000000703"
const SECOND_ONCHAIN_SOURCE_ID = "00000000-0000-0000-0000-000000000704"
const OVERRIDE_ASSET_ID = "00000000-0000-4000-8000-000000000705"

await Effect.runPromise(context.recreateTestDatabase())

const seedApprovedProviderAsset = ({
  providerAssetId = "btc-provider-asset",
  canonicalAssetId = TEST_BTC_ASSET_ID,
  assetRepresentationId = TEST_BTC_REPRESENTATION_ID,
  currencyCode = "BTC",
}: {
  readonly providerAssetId?: string
  readonly canonicalAssetId?: string
  readonly assetRepresentationId?: string | null
  readonly currencyCode?: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const now = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T00:00:00.000Z"))

    const [providerAsset] = yield* db
      .insert(schema.providerAssets)
      .values({
        provider: "coinbase",
        providerAssetId,
        naturalKey: null,
        currencyCode,
        name: currencyCode,
        exponent: 8,
        providerType: "crypto",
        rawProviderPayload: { asset_id: providerAssetId, code: "BTC" },
        retrievedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.providerAssets.id })

    if (providerAsset === undefined) {
      return yield* Effect.die("Failed to create provider asset fixture")
    }

    yield* db.insert(schema.providerAssetMappings).values({
      providerAssetRowId: providerAsset.id,
      mappingKind: "asset",
      canonicalAssetId,
      assetRepresentationId,
      canonicalFiatCurrency: null,
      mappingStatus: "approved",
      reviewerNotes: null,
      sourceNotes: null,
      createdAt: now,
      updatedAt: now,
    })

    return providerAsset.id
  })

const seedOwnedOnchainSource = ({
  walletAddress,
  addressType = "bitcoin",
  providerKey = "bitcoin",
  addressId = ONCHAIN_ADDRESS_ID,
  sourceId = ONCHAIN_SOURCE_ID,
}: {
  readonly walletAddress: string
  readonly addressType?: "bitcoin" | "evm" | "solana"
  readonly providerKey?: string
  readonly addressId?: string
  readonly sourceId?: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const now = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T00:00:00.000Z"))

    yield* db.insert(schema.addresses).values({
      id: addressId,
      address: walletAddress,
      type: addressType,
      name: "Owned bitcoin wallet",
      principalId: TEST_PRINCIPAL_ID,
      createdAt: now,
      updatedAt: now,
    })

    yield* db.insert(schema.sources).values({
      id: sourceId,
      principalId: TEST_PRINCIPAL_ID,
      name: "Owned bitcoin source",
      providerKey,
      sourceableType: "onchain",
      addressId,
      cexAccountId: null,
      createdAt: now,
      updatedAt: now,
    })
  })

const seedProviderTransfer = ({
  providerAssetRowId,
  externalId,
  timestamp,
  amount,
  direction = "outbound",
  fromAddress = null,
  toAddress,
  networkHash,
  networkName = "bitcoin",
}: {
  readonly providerAssetRowId: string
  readonly externalId: string
  readonly timestamp: Date
  readonly amount: string
  readonly direction?: "inbound" | "outbound"
  readonly fromAddress?: string | null
  readonly toAddress: string
  readonly networkHash: string | null
  readonly networkName?: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    const [transaction] = yield* db
      .insert(schema.transactions)
      .values({
        sourceId: TEST_SOURCE_ID,
        sourceRawRecordId: null,
        externalId: `${externalId}:tx`,
        externalGroupId: `${externalId}:group`,
        timestamp,
        transactionType: null,
        providerTransactionType: "send",
        providerStatus: "completed",
        providerResourcePath: `/v2/accounts/coinbase-account-1/transactions/${externalId}`,
        providerDescription: "Provider transfer fixture",
        providerCreatedAt: timestamp,
        providerUpdatedAt: timestamp,
        metadata: { provider: "coinbase" },
        providerFiatAmount: null,
        providerFiatCurrency: null,
        principalId: TEST_PRINCIPAL_ID,
      })
      .returning({ id: schema.transactions.id })

    if (transaction === undefined) {
      return yield* Effect.die("Failed to create provider transfer transaction fixture")
    }

    const [providerTransfer] = yield* db
      .insert(schema.providerTransfers)
      .values({
        sourceId: TEST_SOURCE_ID,
        sourceRawRecordId: null,
        transactionId: transaction.id,
        externalId,
        externalGroupId: `${externalId}:group`,
        providerAssetId: providerAssetRowId,
        timestamp,
        direction,
        processingMode: "accounting_and_evidence",
        fromAccountRef: "coinbase-account-1",
        toAccountRef: null,
        fromAddress,
        toAddress,
        networkName,
        networkHash,
        amount,
        metadata: { provider: "coinbase" },
      })
      .returning({ id: schema.providerTransfers.id })

    if (providerTransfer === undefined) {
      return yield* Effect.die("Failed to create provider transfer fixture")
    }

    return providerTransfer.id
  })

const seedCustodyMovement = ({
  amount,
  providerTransferId,
  timestamp,
}: {
  readonly amount: string
  readonly providerTransferId: string
  readonly timestamp: Date
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [providerTransfer] = yield* db
      .select({ transactionId: schema.providerTransfers.transactionId })
      .from(schema.providerTransfers)
      .where(eq(schema.providerTransfers.id, providerTransferId))
      .limit(1)
    if (providerTransfer === undefined) {
      return yield* Effect.die("Failed to seed custody movement")
    }
    const [movement] = yield* db
      .insert(schema.inventoryMovements)
      .values({
        principalId: TEST_PRINCIPAL_ID,
        sourceId: TEST_SOURCE_ID,
        transactionId: providerTransfer.transactionId,
        providerTransferId,
        assetId: TEST_BTC_ASSET_ID,
        timestamp,
        direction: "outbound",
        purpose: "principal",
        taxTreatment: "pending_review",
        reconciliationStatus: "unmatched",
        amount,
      })
      .returning({ id: schema.inventoryMovements.id })
    if (movement === undefined) return yield* Effect.die("Failed to seed custody movement")
    return { movementId: movement.id }
  })

const seedOnchainReceipt = ({
  externalId,
  txHash,
  timestamp,
  amount,
  walletAddress,
  blockchainId,
  assetId = TEST_BTC_ASSET_ID,
  assetRepresentationId = TEST_BTC_REPRESENTATION_ID,
  transferType = "utxo",
  sourceId = ONCHAIN_SOURCE_ID,
  addressId = ONCHAIN_ADDRESS_ID,
}: {
  readonly externalId: string
  readonly txHash: string
  readonly timestamp: Date
  readonly amount: string
  readonly walletAddress: string
  readonly blockchainId: string
  readonly assetId?: string
  readonly assetRepresentationId?: string | null
  readonly transferType?: "utxo" | "erc20"
  readonly sourceId?: string
  readonly addressId?: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    const [transaction] = yield* db
      .insert(schema.transactions)
      .values({
        sourceId,
        sourceRawRecordId: null,
        externalId: `${externalId}:transaction`,
        externalGroupId: externalId,
        timestamp,
        transactionType: null,
        providerTransactionType: null,
        providerStatus: "confirmed",
        providerResourcePath: null,
        providerDescription: "Onchain receipt fixture",
        providerCreatedAt: timestamp,
        providerUpdatedAt: timestamp,
        metadata: { provider: "bitcoin" },
        providerFiatAmount: null,
        providerFiatCurrency: null,
        principalId: TEST_PRINCIPAL_ID,
      })
      .returning({ id: schema.transactions.id })

    if (transaction === undefined) {
      return yield* Effect.die("Failed to create onchain transaction fixture")
    }

    yield* db.insert(schema.transactionOnchainContext).values({
      transactionId: transaction.id,
      blockchainId,
      addressId,
      chainTxId: txHash,
      blockHeight: "1",
      blockHash: `block-${txHash}`,
      positionInBlock: "0",
      fromAddress: "bc1qexternalorigin0000000000000000000000000",
      toAddress: walletAddress,
      gasUsed: null,
      gasPrice: null,
      feeAmount: null,
      feeAssetId: null,
      feeCostBasisAmount: null,
      feeCostBasisCurrency: null,
      isError: false,
      functionName: null,
      metadata: { provider: "bitcoin" },
    })

    const [transfer] = yield* db
      .insert(schema.transfers)
      .values({
        sourceId,
        sourceRawRecordId: null,
        externalId,
        externalGroupId: externalId,
        addressId,
        blockchainId,
        txHash,
        timestamp,
        type: transferType,
        fromAddress: "bc1qexternalorigin0000000000000000000000000",
        toAddress: walletAddress,
        fromAccountRef: null,
        toAccountRef: null,
        fromPartyType: "address",
        fromPartyResourcePath: null,
        toPartyType: "address",
        toPartyResourcePath: null,
        assetId,
        assetRepresentationId,
        amount,
        tokenId: null,
        notes: null,
        metadata: { provider: "bitcoin" },
        principalId: TEST_PRINCIPAL_ID,
      })
      .returning({ id: schema.transfers.id })

    if (transfer === undefined) {
      return yield* Effect.die("Failed to create onchain transfer fixture")
    }

    return {
      transferId: transfer.id,
      transactionId: transaction.id,
    }
  })

const seedObservedOnchainReceipt = ({
  externalId,
  transactionExternalId = `${externalId}:transaction`,
  canonicalTransferExternalId = null,
  txHash,
  timestamp,
  amount,
  walletAddress,
  blockchainId,
  role = "principal",
  observedAsset = {
    provider: "bitcoin",
    providerAssetId: "bitcoin:native",
    naturalKey: "bitcoin:native",
    currencyCode: "BTC",
    name: "Bitcoin",
    exponent: 8,
    providerType: "native",
    networkName: "bitcoin",
    fromAddress: "bc1qexternalorigin0000000000000000000000000",
    representationType: "native",
    contractAddress: null,
    mintAddress: null,
    decimals: 8,
  },
}: {
  readonly externalId: string
  readonly transactionExternalId?: string
  readonly canonicalTransferExternalId?: string | null
  readonly txHash: string
  readonly timestamp: Date
  readonly amount: string
  readonly walletAddress: string
  readonly blockchainId: string
  readonly role?: "principal" | "fee" | "rent"
  readonly observedAsset?: {
    readonly provider: string
    readonly providerAssetId: string
    readonly naturalKey: string
    readonly currencyCode: string
    readonly name: string
    readonly exponent: number
    readonly providerType: string
    readonly networkName: string
    readonly fromAddress: string
    readonly representationType: "native" | "token" | "nft"
    readonly contractAddress: string | null
    readonly mintAddress: string | null
    readonly decimals: number
  }
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [providerAsset] = yield* db
      .insert(schema.providerAssets)
      .values({
        provider: observedAsset.provider,
        providerAssetId: observedAsset.providerAssetId,
        naturalKey: observedAsset.naturalKey,
        currencyCode: observedAsset.currencyCode,
        name: observedAsset.name,
        exponent: observedAsset.exponent,
        providerType: observedAsset.providerType,
        rawProviderPayload: { source: "test" },
        retrievedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning({ id: schema.providerAssets.id })

    if (providerAsset === undefined) {
      return yield* Effect.die("Failed to create observed provider asset fixture")
    }

    const [transaction] = yield* db
      .insert(schema.transactions)
      .values({
        sourceId: ONCHAIN_SOURCE_ID,
        sourceRawRecordId: null,
        externalId: transactionExternalId,
        externalGroupId: externalId,
        timestamp,
        transactionType: null,
        providerTransactionType: "transfer",
        providerStatus: "confirmed",
        providerResourcePath: null,
        providerDescription: "Observed onchain receipt fixture",
        providerCreatedAt: timestamp,
        providerUpdatedAt: timestamp,
        metadata: { provider: observedAsset.provider },
        providerFiatAmount: null,
        providerFiatCurrency: null,
        principalId: TEST_PRINCIPAL_ID,
      })
      .returning({ id: schema.transactions.id })

    if (transaction === undefined) {
      return yield* Effect.die("Failed to create observed transaction fixture")
    }

    const [providerTransfer] = yield* db
      .insert(schema.providerTransfers)
      .values({
        sourceId: ONCHAIN_SOURCE_ID,
        sourceRawRecordId: null,
        transactionId: transaction.id,
        externalId,
        externalGroupId: externalId,
        providerAssetId: providerAsset.id,
        timestamp,
        direction: "inbound",
        processingMode: "evidence_only",
        fromAccountRef: null,
        toAccountRef: null,
        fromAddress: observedAsset.fromAddress,
        toAddress: walletAddress,
        networkName: observedAsset.networkName,
        networkHash: txHash,
        observedBlockchainId: blockchainId,
        observedRepresentationType: observedAsset.representationType,
        observedContractAddress: observedAsset.contractAddress,
        observedMintAddress: observedAsset.mintAddress,
        observedDecimals: observedAsset.decimals,
        amount,
        metadata: { provider: observedAsset.provider, role, canonicalTransferExternalId },
      })
      .returning({ id: schema.providerTransfers.id })

    if (providerTransfer === undefined) {
      return yield* Effect.die("Failed to create observed provider transfer fixture")
    }

    return {
      providerAssetRowId: providerAsset.id,
      providerTransferId: providerTransfer.id,
      transactionId: transaction.id,
    }
  })

const seedExactReconciliationOverride = ({
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
        name: "Principal-selected Bitcoin",
        symbol: "BTC-SELECTED",
        type: "fungible",
      })
      .onConflictDoNothing({ target: schema.assets.id })
    const [representation] = yield* db
      .select({
        blockchainId: schema.assetRepresentations.blockchainId,
        representationType: schema.assetRepresentations.type,
        contractAddress: schema.assetRepresentations.contractAddress,
        mintAddress: schema.assetRepresentations.mintAddress,
      })
      .from(schema.assetRepresentations)
      .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
    if (representation === undefined) return yield* Effect.die("Missing Bitcoin representation")

    const [target] = yield* db
      .insert(schema.principalAssetOverrideTargets)
      .values({
        principalId: TEST_PRINCIPAL_ID,
        targetKind: "representation",
        ...representation,
      })
      .returning({ id: schema.principalAssetOverrideTargets.id })
    if (target === undefined) return yield* Effect.die("Failed to create override target")

    yield* db.insert(schema.principalAssetOverrides).values({
      principalId: TEST_PRINCIPAL_ID,
      targetId: target.id,
      kind: "identity",
      operation: "create",
      inspectedSystemRevision: "reconciliation-exact-override-v1",
      inspectedSystemIdentity: "resolved",
      inspectedSystemAssetId: TEST_BTC_ASSET_ID,
      replacementAssetId: OVERRIDE_ASSET_ID,
      actorUserId: fixture.userId,
      reason,
    })
  })

describe("TransferReconciliationServiceLive", () => {
  let fixture: SyncEngineRepositoryFixture

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
      })
    )
  )

  it.effect("keeps split evidence-only transfers out of inventory and reconciliation", () =>
    Effect.gen(function* () {
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:00:00.000Z"))
      const providerAssetRowId = yield* Effect.promise(() => runPg(seedApprovedProviderAsset({})))

      const persisted = yield* Effect.promise(() =>
        runSourceNormalization(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts({
              transaction: {
                sourceId: TEST_SOURCE_ID,
                sourceRawRecordId: null,
                externalId: "split-native-evidence",
                externalGroupId: "split-native-evidence",
                timestamp,
                transactionType: "internal_transfer",
                providerTransactionType: "transfer",
                providerStatus: "completed",
                providerResourcePath: null,
                providerDescription: "Split native transfer evidence",
                providerCreatedAt: timestamp,
                providerUpdatedAt: timestamp,
                metadata: { provider: "helius-solana" },
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
                metadata: { provider: "helius-solana" },
              },
              providerTransfers: [
                {
                  sourceId: TEST_SOURCE_ID,
                  sourceRawRecordId: null,
                  externalId: "split-native-evidence:accounting",
                  externalGroupId: "split-native-evidence",
                  providerAssetId: providerAssetRowId,
                  timestamp,
                  direction: "outbound",
                  processingMode: "accounting_only",
                  fromAccountRef: null,
                  toAccountRef: null,
                  fromAddress: "owned-address",
                  toAddress: "counterparty",
                  networkName: "bitcoin",
                  networkHash: "split-native-evidence-hash",
                  observedBlockchainId: null,
                  observedRepresentationType: null,
                  observedContractAddress: null,
                  observedMintAddress: null,
                  observedDecimals: null,
                  amount: "0.75",
                  metadata: {},
                },
                ...[
                  { suffix: "a", amount: "0.5" },
                  { suffix: "b", amount: "0.25" },
                ].map(({ suffix, amount }) => ({
                  sourceId: TEST_SOURCE_ID,
                  sourceRawRecordId: null,
                  externalId: `split-native-evidence:${suffix}`,
                  externalGroupId: "split-native-evidence",
                  providerAssetId: providerAssetRowId,
                  timestamp,
                  direction: "outbound" as const,
                  processingMode: "evidence_only" as const,
                  fromAccountRef: null,
                  toAccountRef: null,
                  fromAddress: "owned-address",
                  toAddress: `counterparty-${suffix}`,
                  networkName: "bitcoin",
                  networkHash: "split-native-evidence-hash",
                  observedBlockchainId: fixture.bitcoinBlockchainId,
                  observedRepresentationType: "native" as const,
                  observedContractAddress: null,
                  observedMintAddress: null,
                  observedDecimals: 8,
                  amount,
                  metadata: {},
                })),
              ],
              canonicalTransfers: [],
              providerAssetRowIds: [],
              legs: [],
              transactionReview: null,
              resolvedTransactionType: {
                providerTransactionType: "transfer",
                transactionType: "internal_transfer",
                inventoryEffect: "internal_transfer",
                taxTreatment: "non_taxable_by_default",
                resolutionStrategy: "amount_sign",
                pairedRecordRequired: true,
                mappingStatus: "approved",
              },
            })
          )
        )
      )

      const reconciliationCandidates = yield* Effect.promise(() =>
        runTransferReconciliationRepository(
          Effect.flatMap(TransferReconciliationRepository, (repository) =>
            repository.listProviderTransfersForReconciliation({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )
      const inventoryMovements = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                providerTransferId: schema.inventoryMovements.providerTransferId,
                amount: schema.inventoryMovements.amount,
              })
              .from(schema.inventoryMovements)
              .where(eq(schema.inventoryMovements.transactionId, persisted.transaction.id))
          })
        )
      )
      const accountingTransfer = persisted.providerTransfers.find(
        (transfer) => transfer.externalId === "split-native-evidence:accounting"
      )

      expect(persisted.providerTransfers).toHaveLength(3)
      expect(accountingTransfer).toBeDefined()
      expect(inventoryMovements).toEqual([
        {
          providerTransferId: accountingTransfer?.id,
          amount: expect.stringMatching(/^0\.75(?:0+)?$/),
        },
      ])
      expect(reconciliationCandidates.map((candidate) => candidate.providerTransferId)).toEqual([
        accountingTransfer?.id,
      ])

      const evidenceTransfer = persisted.providerTransfers.find(
        (transfer) => transfer.externalId === "split-native-evidence:a"
      )
      expect(evidenceTransfer).toBeDefined()
      if (evidenceTransfer === undefined) {
        return
      }

      const walletAddress = "bc1qownedevidenceonly0000000000000000000000"
      yield* Effect.promise(() => runPg(seedOwnedOnchainSource({ walletAddress })))
      const receipt = yield* Effect.promise(() =>
        runPg(
          seedOnchainReceipt({
            externalId: "evidence-only-receipt",
            txHash: "split-native-evidence-hash",
            timestamp,
            amount: "0.5",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
          })
        )
      )
      const reconciliationId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [reconciliation] = yield* db
              .insert(schema.transferReconciliations)
              .values({
                principalId: TEST_PRINCIPAL_ID,
                providerTransferId: evidenceTransfer.id,
                canonicalTransferId: receipt.transferId,
                canonicalTransactionId: receipt.transactionId,
                status: "auto_applied",
                matchReason: "test_evidence_only_filter",
                confidence: "1",
                deterministic: true,
                reviewMetadata: null,
              })
              .returning({ id: schema.transferReconciliations.id })

            if (reconciliation === undefined) {
              return yield* Effect.die("Failed to create evidence-only reconciliation")
            }

            return reconciliation.id
          })
        )
      )

      const canonicalization = yield* Effect.promise(() =>
        runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.applyDeterministicInternalTransferCanonicalization({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
              reconciliationId,
            })
          )
        )
      )

      expect(canonicalization).toEqual({ canonicalizedPairs: 0 })
    })
  )

  it.effect("records a deterministic owned onchain receipt for canonicalization", () =>
    Effect.gen(function* () {
      const walletAddress = "bc1qownedwalletdeterministic00000000000000000"
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:00:00.000Z"))

      const providerAssetRowId = yield* Effect.promise(() => runPg(seedApprovedProviderAsset({})))
      yield* Effect.promise(() => runPg(seedOwnedOnchainSource({ walletAddress })))
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          seedProviderTransfer({
            providerAssetRowId,
            externalId: "provider-transfer-deterministic",
            timestamp,
            amount: "0.10000000",
            toAddress: walletAddress,
            networkHash: "btc-deterministic-hash-1",
          })
        )
      )
      const receiptTimestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:05:00.000Z"))
      const receipt = yield* Effect.promise(() =>
        runPg(
          seedOnchainReceipt({
            externalId: "onchain-receipt-deterministic",
            txHash: "btc-deterministic-hash-1",
            timestamp: receiptTimestamp,
            amount: "0.10000000",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
          })
        )
      )
      const providerTransactionId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [providerTransfer] = yield* db
              .select({ transactionId: schema.providerTransfers.transactionId })
              .from(schema.providerTransfers)
              .where(eq(schema.providerTransfers.id, providerTransferId))
            if (providerTransfer === undefined) {
              return yield* Effect.die("Failed to load the provider transfer transaction")
            }
            yield* db.insert(schema.inventoryMovements).values({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
              transactionId: providerTransfer.transactionId,
              providerTransferId,
              assetId: TEST_BTC_ASSET_ID,
              timestamp,
              direction: "outbound",
              purpose: "principal",
              taxTreatment: "pending_review",
              reconciliationStatus: "unmatched",
              amount: "0.10000000",
            })
            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures([
                {
                  movementIdentity: {
                    sourceRecordKey: "provider-transfer-deterministic:disposition",
                    componentKey: "movement",
                  },
                  sourceId: TEST_SOURCE_ID,
                  externalId: "provider-transfer-deterministic:disposition",
                  timestamp,
                  principalId: TEST_PRINCIPAL_ID,
                  transactionId: providerTransfer.transactionId,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "0.10000000",
                  kind: "disposal",
                  provenance: "deterministic",
                  originKind: "provider_transfer" as const,
                  providerTransferId,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "onchain-receipt-deterministic:acquisition",
                    componentKey: "movement",
                  },
                  sourceId: ONCHAIN_SOURCE_ID,
                  externalId: "onchain-receipt-deterministic:acquisition",
                  timestamp: receiptTimestamp,
                  principalId: TEST_PRINCIPAL_ID,
                  transactionId: receipt.transactionId,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "0.10000000",
                  kind: "acquisition",
                  provenance: "deterministic",
                  originKind: "canonical_transfer" as const,
                  sourceTransferId: receipt.transferId,
                },
              ])
            )
            return providerTransfer.transactionId
          })
        )
      )

      const summary = yield* Effect.promise(() =>
        runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.reconcileTransferCandidates({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )

      const [reconciliation] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                id: schema.transferReconciliations.id,
                providerTransferId: schema.transferReconciliations.providerTransferId,
                canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
                canonicalTransactionId: schema.transferReconciliations.canonicalTransactionId,
                status: schema.transferReconciliations.status,
                matchReason: schema.transferReconciliations.matchReason,
                deterministic: schema.transferReconciliations.deterministic,
              })
              .from(schema.transferReconciliations)
              .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
          })
        )
      )

      expect(summary).toEqual(
        expect.objectContaining({
          evaluatedProviderTransfers: 1,
          autoApplied: 1,
        })
      )
      expect(reconciliation).toEqual(
        expect.objectContaining({
          providerTransferId,
          canonicalTransferId: receipt.transferId,
          canonicalTransactionId: receipt.transactionId,
          status: "auto_applied",
          matchReason: "deterministic_wallet_receipt_match",
          deterministic: true,
        })
      )
      if (reconciliation === undefined) {
        return yield* Effect.die("Expected the deterministic reconciliation")
      }

      const canonicalization = yield* Effect.promise(() =>
        runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.applyDeterministicInternalTransferCanonicalization({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
              reconciliationId: reconciliation.id,
            })
          )
        )
      )
      const state = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const transactions = yield* db
              .select({ transactionType: schema.transactions.transactionType })
              .from(schema.transactions)
              .where(
                inArray(schema.transactions.id, [providerTransactionId, receipt.transactionId])
              )
            const [movement] = yield* db
              .select({
                reconciliationStatus: schema.inventoryMovements.reconciliationStatus,
                taxTreatment: schema.inventoryMovements.taxTreatment,
              })
              .from(schema.inventoryMovements)
              .where(eq(schema.inventoryMovements.providerTransferId, providerTransferId))
            const factualLegs = yield* db
              .select({ kind: schema.transactionLegs.kind })
              .from(schema.transactionLegs)
              .where(
                inArray(schema.transactionLegs.transactionId, [
                  providerTransactionId,
                  receipt.transactionId,
                ])
              )
            return {
              transactions,
              movement,
              factualLegs,
            }
          })
        )
      )

      expect(canonicalization).toEqual({ canonicalizedPairs: 1 })
      expect(state.transactions).toHaveLength(2)
      expect(state.transactions.every(({ transactionType }) => transactionType === null)).toBe(true)
      expect(state.movement).toEqual({
        reconciliationStatus: "matched",
        taxTreatment: "pending_review",
      })
      expect(state.factualLegs.map(({ kind }) => kind).sort()).toEqual(["acquisition", "disposal"])

      const legacyReviewTransactionId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.transactions)
              .set({ transactionType: "internal_transfer" })
              .where(eq(schema.transactions.id, providerTransactionId))
            const [legacyReviewTransaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: TEST_SOURCE_ID,
                externalId: "legacy-multilayer-review-transaction",
                timestamp,
                transactionType: "internal_transfer",
                principalId: TEST_PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            if (legacyReviewTransaction === undefined) {
              return yield* Effect.die("Failed to create legacy review transaction")
            }
            yield* db.insert(schema.transactionReviews).values([
              {
                transactionId: providerTransactionId,
                principalId: TEST_PRINCIPAL_ID,
                reviewStatus: "needs_review",
                originalTypeKey: null,
                currentTypeKey: "internal_transfer",
                categorizationReason:
                  "Deterministic provider transfer reconciled to a principal-owned onchain transfer.",
                matchedLayer: "transfer_reconciliation",
                needsReview: true,
              },
              {
                transactionId: receipt.transactionId,
                principalId: TEST_PRINCIPAL_ID,
                reviewStatus: "needs_review",
                originalTypeKey: null,
                currentTypeKey: null,
                categorizationReason: "Keep unrelated review.",
                matchedLayer: null,
                needsReview: true,
              },
              {
                transactionId: legacyReviewTransaction.id,
                principalId: TEST_PRINCIPAL_ID,
                reviewStatus: "needs_review",
                originalTypeKey: null,
                currentTypeKey: "internal_transfer",
                categorizationReason:
                  "Deterministic provider transfer reconciled to a principal-owned onchain transfer.\nKeep asset review.",
                matchedLayer: "transfer_reconciliation,asset_resolution",
                needsReview: true,
              },
            ])
            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures([
                {
                  movementIdentity: {
                    sourceRecordKey: "legacy-multilayer-review-internal-leg",
                    componentKey: "movement",
                  },
                  sourceId: TEST_SOURCE_ID,
                  externalId: "legacy-multilayer-review-internal-leg",
                  timestamp,
                  principalId: TEST_PRINCIPAL_ID,
                  transactionId: legacyReviewTransaction.id,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "0.10000000",
                  kind: "disposal",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  derivationRule: "internal_transfer_out",
                  metadata: { reconciliation: { providerTransferId } },
                },
              ])
            )
            return legacyReviewTransaction.id
          })
        )
      )

      yield* Effect.promise(() =>
        runTransferReconciliationRepository(
          Effect.flatMap(TransferReconciliationRepository, (repository) =>
            repository.upsertTransferReconciliation({
              principalId: TEST_PRINCIPAL_ID,
              providerTransferId,
              canonicalTransferId: null,
              canonicalTransactionId: null,
              status: "needs_review",
              matchReason: "candidate_invalidated",
              confidence: "0.0000",
              deterministic: false,
              reviewMetadata: {},
            })
          )
        )
      )
      const restoredState = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [movement] = yield* db
              .select({ reconciliationStatus: schema.inventoryMovements.reconciliationStatus })
              .from(schema.inventoryMovements)
              .where(eq(schema.inventoryMovements.providerTransferId, providerTransferId))
            const reviews = yield* db
              .select({
                transactionId: schema.transactionReviews.transactionId,
                categorizationReason: schema.transactionReviews.categorizationReason,
                matchedLayer: schema.transactionReviews.matchedLayer,
              })
              .from(schema.transactionReviews)
              .where(
                inArray(schema.transactionReviews.transactionId, [
                  providerTransactionId,
                  receipt.transactionId,
                  legacyReviewTransactionId,
                ])
              )
            const [providerTransaction] = yield* db
              .select({ transactionType: schema.transactions.transactionType })
              .from(schema.transactions)
              .where(eq(schema.transactions.id, providerTransactionId))
            const legacyLegs = yield* db
              .select({ id: schema.transactionLegs.id })
              .from(schema.transactionLegs)
              .where(eq(schema.transactionLegs.transactionId, legacyReviewTransactionId))
            return { movement, reviews, providerTransaction, legacyLegs }
          })
        )
      )

      expect(restoredState.movement?.reconciliationStatus).toBe("unmatched")
      expect(restoredState.providerTransaction?.transactionType).toBe(null)
      expect(restoredState.legacyLegs).toEqual([])
      expect(restoredState.reviews).not.toContainEqual(
        expect.objectContaining({ transactionId: providerTransactionId })
      )
      expect(restoredState.reviews).toContainEqual({
        transactionId: receipt.transactionId,
        categorizationReason: "Keep unrelated review.",
        matchedLayer: null,
      })
      expect(restoredState.reviews).toContainEqual({
        transactionId: legacyReviewTransactionId,
        categorizationReason: "Keep asset review.",
        matchedLayer: "asset_resolution",
      })
    })
  )

  it.effect("reconciles an exact representation using the principal's active asset", () =>
    Effect.gen(function* () {
      const walletAddress = "bc1qoverridewallet0000000000000000000000000"
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-11T10:00:00.000Z"))
      const providerAssetRowId = yield* Effect.promise(() => runPg(seedApprovedProviderAsset({})))
      yield* Effect.promise(() => runPg(seedOwnedOnchainSource({ walletAddress })))
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          seedProviderTransfer({
            providerAssetRowId,
            externalId: "provider-transfer-exact-override",
            timestamp,
            amount: "0.10000000",
            toAddress: walletAddress,
            networkHash: "btc-exact-override-hash",
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(seedCustodyMovement({ amount: "0.10000000", providerTransferId, timestamp }))
      )
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.assets).values({
              id: OVERRIDE_ASSET_ID,
              name: "Principal-selected Bitcoin",
              symbol: "BTC-SELECTED",
              type: "fungible",
            })
          })
        )
      )
      const receiptTimestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-11T10:05:00.000Z"))
      const receipt = yield* Effect.promise(() =>
        runPg(
          seedOnchainReceipt({
            externalId: "onchain-receipt-exact-override",
            txHash: "btc-exact-override-hash",
            timestamp: receiptTimestamp,
            amount: "0.10000000",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
            assetId: OVERRIDE_ASSET_ID,
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [representation] = yield* db
              .select({
                blockchainId: schema.assetRepresentations.blockchainId,
                representationType: schema.assetRepresentations.type,
                contractAddress: schema.assetRepresentations.contractAddress,
                mintAddress: schema.assetRepresentations.mintAddress,
              })
              .from(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
            if (representation === undefined) {
              return yield* Effect.die("Missing Bitcoin representation")
            }
            const [target] = yield* db
              .insert(schema.principalAssetOverrideTargets)
              .values({
                principalId: TEST_PRINCIPAL_ID,
                targetKind: "representation",
                ...representation,
              })
              .returning({ id: schema.principalAssetOverrideTargets.id })
            if (target === undefined) return yield* Effect.die("Failed to create override target")
            yield* db.insert(schema.principalAssetOverrides).values({
              principalId: TEST_PRINCIPAL_ID,
              targetId: target.id,
              kind: "identity",
              operation: "create",
              inspectedSystemRevision: "reconciliation-exact-override-v1",
              inspectedSystemIdentity: "resolved",
              inspectedSystemAssetId: TEST_BTC_ASSET_ID,
              replacementAssetId: OVERRIDE_ASSET_ID,
              actorUserId: fixture.userId,
              reason: "Use the selected asset during reconciliation",
            })
          })
        )
      )

      const summary = yield* Effect.promise(() =>
        runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.reconcileTransferCandidates({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )
      const [reconciliation] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
                status: schema.transferReconciliations.status,
                matchReason: schema.transferReconciliations.matchReason,
              })
              .from(schema.transferReconciliations)
              .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
          })
        )
      )

      expect(summary).toMatchObject({ evaluatedProviderTransfers: 1, autoApplied: 1 })
      expect(reconciliation).toEqual({
        canonicalTransferId: receipt.transferId,
        status: "auto_applied",
        matchReason: "deterministic_wallet_receipt_match",
      })
    })
  )

  it.effect("reconciles evidence-only onchain facts using the principal's active asset", () =>
    Effect.gen(function* () {
      const walletAddress = "bc1qoverrideevidence000000000000000000000000"
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-11T11:00:00.000Z"))
      const networkHash = "btc-exact-override-evidence-hash"
      const providerAssetRowId = yield* Effect.promise(() => runPg(seedApprovedProviderAsset({})))
      yield* Effect.promise(() => runPg(seedOwnedOnchainSource({ walletAddress })))
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          seedProviderTransfer({
            providerAssetRowId,
            externalId: "provider-transfer-exact-override-evidence",
            timestamp,
            amount: "0.10000000",
            toAddress: walletAddress,
            networkHash,
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(seedCustodyMovement({ amount: "0.10000000", providerTransferId, timestamp }))
      )
      const observed = yield* Effect.promise(() =>
        runPg(
          seedObservedOnchainReceipt({
            externalId: "onchain-evidence-exact-override",
            transactionExternalId: "onchain-evidence-exact-override:observed-transaction",
            canonicalTransferExternalId: "onchain-canonical-exact-override",
            txHash: networkHash,
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-11T11:05:00.000Z")),
            amount: "0.10000000",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
            observedAsset: {
              provider: "bitcoin",
              providerAssetId: "bitcoin:exact-override-evidence",
              naturalKey: "bitcoin:exact-override-evidence",
              currencyCode: "BTC",
              name: "Bitcoin",
              exponent: 8,
              providerType: "token",
              networkName: "bitcoin",
              fromAddress: "bc1qexternalorigin0000000000000000000000000",
              representationType: "token",
              contractAddress: "sync-engine-btc-fixture",
              mintAddress: null,
              decimals: 8,
            },
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.providerAssetMappings).values({
              providerAssetRowId: observed.providerAssetRowId,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: null,
              sourceNotes: null,
            })
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(
          seedExactReconciliationOverride({
            fixture,
            reason: "Use the selected asset for onchain evidence reconciliation",
          })
        )
      )

      const candidates = yield* Effect.promise(() =>
        runTransferReconciliationRepository(
          Effect.flatMap(TransferReconciliationRepository, (repository) =>
            repository.findOnchainTransferCandidates({
              principalId: TEST_PRINCIPAL_ID,
              direction: "outbound",
              walletAddress,
              timestampStart: timestamp,
              timestampEnd: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-11T11:10:00.000Z")),
              networkName: "bitcoin",
              networkHash,
            })
          )
        )
      )
      expect(candidates).toEqual([
        expect.objectContaining({
          observedProviderTransferId: observed.providerTransferId,
          transferId: null,
          assetId: OVERRIDE_ASSET_ID,
          assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
        }),
      ])

      const summary = yield* Effect.promise(() =>
        runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.reconcileTransferCandidates({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )
      const [reconciliation] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                canonicalTransactionId: schema.transferReconciliations.canonicalTransactionId,
                canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
                status: schema.transferReconciliations.status,
                matchReason: schema.transferReconciliations.matchReason,
              })
              .from(schema.transferReconciliations)
              .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
          })
        )
      )

      expect(summary).toMatchObject({ evaluatedProviderTransfers: 1, pending: 1, needsReview: 0 })
      expect(reconciliation).toEqual({
        canonicalTransactionId: observed.transactionId,
        canonicalTransferId: null,
        status: "pending",
        matchReason: "destination_source_replay_pending",
      })

      const replayedReceipt = yield* Effect.promise(() =>
        runPg(
          seedOnchainReceipt({
            externalId: "onchain-canonical-exact-override",
            txHash: networkHash,
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-11T11:05:00.000Z")),
            amount: "0.10000000",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
            assetId: OVERRIDE_ASSET_ID,
          })
        )
      )
      const completedSummary = yield* Effect.promise(() =>
        runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.reconcileTransferCandidates({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )
      const [completedReconciliation] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
                status: schema.transferReconciliations.status,
                matchReason: schema.transferReconciliations.matchReason,
              })
              .from(schema.transferReconciliations)
              .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
          })
        )
      )
      expect(completedSummary).toMatchObject({ evaluatedProviderTransfers: 1, autoApplied: 1 })
      expect(completedReconciliation).toEqual({
        canonicalTransferId: replayedReceipt.transferId,
        status: "auto_applied",
        matchReason: "deterministic_wallet_receipt_match",
      })
    })
  )

  it.effect("keeps a real non-override economic asset conflict in review", () =>
    Effect.gen(function* () {
      const walletAddress = "bc1qconflictwallet000000000000000000000000"
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-12T10:00:00.000Z"))
      const providerAssetRowId = yield* Effect.promise(() => runPg(seedApprovedProviderAsset({})))
      yield* Effect.promise(() => runPg(seedOwnedOnchainSource({ walletAddress })))
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          seedProviderTransfer({
            providerAssetRowId,
            externalId: "provider-transfer-real-asset-conflict",
            timestamp,
            amount: "0.10000000",
            toAddress: walletAddress,
            networkHash: "btc-real-asset-conflict-hash",
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(seedCustodyMovement({ amount: "0.10000000", providerTransferId, timestamp }))
      )
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.assets).values({
              id: OVERRIDE_ASSET_ID,
              name: "Conflicting Bitcoin asset",
              symbol: "BTC-CONFLICT",
              type: "fungible",
            })
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(
          seedOnchainReceipt({
            externalId: "onchain-receipt-real-asset-conflict",
            txHash: "btc-real-asset-conflict-hash",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-12T10:05:00.000Z")),
            amount: "0.10000000",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
            assetId: OVERRIDE_ASSET_ID,
          })
        )
      )

      const summary = yield* Effect.promise(() =>
        runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.reconcileTransferCandidates({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )
      const [reconciliation] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                status: schema.transferReconciliations.status,
                matchReason: schema.transferReconciliations.matchReason,
              })
              .from(schema.transferReconciliations)
              .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
          })
        )
      )

      expect(summary).toMatchObject({ evaluatedProviderTransfers: 1, needsReview: 1 })
      expect(reconciliation).toEqual({
        status: "needs_review",
        matchReason: "representation_economic_asset_conflict",
      })
    })
  )

  it.effect("unmatches both factual movements when an inbound reconciliation is invalidated", () =>
    Effect.gen(function* () {
      const walletAddress = "bc1qinboundrollback00000000000000000000000000"
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T12:00:00.000Z"))
      const providerAssetRowId = yield* Effect.promise(() => runPg(seedApprovedProviderAsset({})))
      yield* Effect.promise(() => runPg(seedOwnedOnchainSource({ walletAddress })))
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          seedProviderTransfer({
            providerAssetRowId,
            externalId: "provider-transfer-inbound-rollback",
            timestamp,
            amount: "0.20000000",
            direction: "inbound",
            fromAddress: walletAddress,
            toAddress: "coinbase-account-1",
            networkHash: "btc-inbound-rollback-hash",
          })
        )
      )
      const receipt = yield* Effect.promise(() =>
        runPg(
          seedOnchainReceipt({
            externalId: "onchain-transfer-inbound-rollback",
            txHash: "btc-inbound-rollback-hash",
            timestamp,
            amount: "0.20000000",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
          })
        )
      )
      const custodyProviderTransferId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [providerTransfer] = yield* db
              .select({ transactionId: schema.providerTransfers.transactionId })
              .from(schema.providerTransfers)
              .where(eq(schema.providerTransfers.id, providerTransferId))
            if (providerTransfer === undefined) {
              return yield* Effect.die("Failed to load inbound provider transaction")
            }
            const [custodyProviderTransfer] = yield* db
              .insert(schema.providerTransfers)
              .values({
                sourceId: ONCHAIN_SOURCE_ID,
                transactionId: receipt.transactionId,
                externalId: "custody-provider-transfer-inbound-rollback",
                timestamp,
                direction: "outbound",
                processingMode: "accounting_and_evidence",
                providerAssetId: providerAssetRowId,
                fromAddress: walletAddress,
                toAddress: "coinbase-account-1",
                networkName: "bitcoin",
                networkHash: "btc-inbound-rollback-hash",
                amount: "0.20000000",
                metadata: {
                  canonicalTransferExternalId: "onchain-transfer-inbound-rollback",
                },
              })
              .returning({ id: schema.providerTransfers.id })
            if (custodyProviderTransfer === undefined) {
              return yield* Effect.die("Failed to create inbound custody provider transfer")
            }
            yield* db.insert(schema.inventoryMovements).values([
              {
                principalId: TEST_PRINCIPAL_ID,
                sourceId: TEST_SOURCE_ID,
                transactionId: providerTransfer.transactionId,
                providerTransferId,
                assetId: TEST_BTC_ASSET_ID,
                timestamp,
                direction: "inbound",
                purpose: "principal",
                taxTreatment: "pending_review",
                reconciliationStatus: "unmatched",
                amount: "0.20000000",
              },
              {
                principalId: TEST_PRINCIPAL_ID,
                sourceId: ONCHAIN_SOURCE_ID,
                transactionId: receipt.transactionId,
                providerTransferId: custodyProviderTransfer.id,
                assetId: TEST_BTC_ASSET_ID,
                timestamp,
                direction: "outbound",
                purpose: "principal",
                taxTreatment: "pending_review",
                reconciliationStatus: "unmatched",
                amount: "0.20000000",
              },
            ])
            return custodyProviderTransfer.id
          })
        )
      )

      yield* Effect.promise(() =>
        runTransferReconciliationRepository(
          Effect.flatMap(TransferReconciliationRepository, (repository) =>
            repository.upsertTransferReconciliation({
              principalId: TEST_PRINCIPAL_ID,
              providerTransferId,
              canonicalTransferId: receipt.transferId,
              canonicalTransactionId: receipt.transactionId,
              status: "auto_applied",
              matchReason: "deterministic_wallet_send_match",
              confidence: "1.0000",
              deterministic: true,
              reviewMetadata: {},
            })
          )
        )
      )
      yield* Effect.promise(() =>
        runTransferReconciliationRepository(
          Effect.flatMap(TransferReconciliationRepository, (repository) =>
            repository.applyDeterministicInternalTransferCanonicalization({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )

      const loadMovementStatuses = () =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                providerTransferId: schema.inventoryMovements.providerTransferId,
                reconciliationStatus: schema.inventoryMovements.reconciliationStatus,
              })
              .from(schema.inventoryMovements)
              .where(
                inArray(schema.inventoryMovements.providerTransferId, [
                  providerTransferId,
                  custodyProviderTransferId,
                ])
              )
              .orderBy(schema.inventoryMovements.providerTransferId)
          })
        )

      expect(yield* Effect.promise(loadMovementStatuses)).toEqual([
        expect.objectContaining({ reconciliationStatus: "matched" }),
        expect.objectContaining({ reconciliationStatus: "matched" }),
      ])

      yield* Effect.promise(() =>
        runTransferReconciliationRepository(
          Effect.flatMap(TransferReconciliationRepository, (repository) =>
            repository.upsertTransferReconciliation({
              principalId: TEST_PRINCIPAL_ID,
              providerTransferId,
              canonicalTransferId: null,
              canonicalTransactionId: null,
              status: "needs_review",
              matchReason: "candidate_invalidated",
              confidence: "0.0000",
              deterministic: false,
              reviewMetadata: {},
            })
          )
        )
      )

      expect(yield* Effect.promise(loadMovementStatuses)).toEqual([
        expect.objectContaining({ reconciliationStatus: "unmatched" }),
        expect.objectContaining({ reconciliationStatus: "unmatched" }),
      ])
    })
  )

  it.effect.each([
    ["approved", "provider"],
    ["changed", "provider"],
    ["approved", "canonical"],
    ["changed", "canonical"],
  ] as const)(
    "preserves %s accounting legs on the %s transaction instead of canonicalizing them automatically",
    (testCase) => {
      const [reviewStatus, reviewedSide] = testCase
      return Effect.gen(function* () {
        const walletAddress = `bc1qownedwalletreviewed${reviewStatus}${reviewedSide}000000000`
        const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:30:00.000Z"))
        const providerAssetRowId = yield* Effect.promise(() =>
          runPg(
            seedApprovedProviderAsset({
              providerAssetId: `btc-provider-reviewed-${reviewStatus}`,
            })
          )
        )
        yield* Effect.promise(() => runPg(seedOwnedOnchainSource({ walletAddress })))
        const providerTransferId = yield* Effect.promise(() =>
          runPg(
            seedProviderTransfer({
              providerAssetRowId,
              externalId: `provider-transfer-reviewed-${reviewStatus}`,
              timestamp,
              amount: "0.10000000",
              toAddress: walletAddress,
              networkHash: `btc-reviewed-${reviewStatus}-hash`,
            })
          )
        )
        const receipt = yield* Effect.promise(() =>
          runPg(
            seedOnchainReceipt({
              externalId: `onchain-receipt-reviewed-${reviewStatus}-${reviewedSide}`,
              txHash: `btc-reviewed-${reviewStatus}-hash`,
              timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:35:00.000Z")),
              amount: "0.10000000",
              walletAddress,
              blockchainId: fixture.bitcoinBlockchainId,
            })
          )
        )

        const reviewedFixture = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const [providerTransfer] = yield* db
                .select({ transactionId: schema.providerTransfers.transactionId })
                .from(schema.providerTransfers)
                .where(eq(schema.providerTransfers.id, providerTransferId))
                .limit(1)
              if (providerTransfer === undefined) {
                return yield* Effect.die("Failed to load reviewed provider transaction")
              }

              const reviewedTransactionId =
                reviewedSide === "provider" ? providerTransfer.transactionId : receipt.transactionId
              const reviewedSourceId =
                reviewedSide === "provider" ? TEST_SOURCE_ID : ONCHAIN_SOURCE_ID

              yield* db
                .update(schema.transactions)
                .set({ transactionType: "sell_fiat" })
                .where(eq(schema.transactions.id, reviewedTransactionId))
              yield* db.insert(schema.transactionReviews).values({
                transactionId: reviewedTransactionId,
                principalId: TEST_PRINCIPAL_ID,
                reviewStatus,
                originalTypeKey: "internal_transfer",
                currentTypeKey: "sell_fiat",
                categorizationReason: "User reviewed this send as a taxable gift.",
                matchedLayer: "manual",
                needsReview: false,
                userNotes: "Preserve the reviewed gift accounting.",
                reviewedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T11:00:00.000Z")),
              })
              const [giftLeg] = yield* db
                .insert(schema.transactionLegs)
                .values(
                  yield* prepareMovementLegFixtures([
                    {
                      movementIdentity: {
                        sourceRecordKey: `reviewed-${reviewStatus}-${reviewedSide}:gift`,
                        componentKey: "movement",
                      },
                      sourceId: reviewedSourceId,
                      transactionId: reviewedTransactionId,
                      externalId: `reviewed-${reviewStatus}-${reviewedSide}:gift`,
                      timestamp,
                      principalId: TEST_PRINCIPAL_ID,
                      assetId: TEST_BTC_ASSET_ID,
                      amount: "0.10000000",
                      kind: "disposal",
                      provenance: "manual",
                      originKind: "none" as const,
                      derivationRule: "manual_taxable_disposal",
                      fiatAmount: "5000.00",
                      fiatCurrency: "EUR",
                    },
                  ])
                )
                .returning({ id: schema.transactionLegs.id })
              if (giftLeg === undefined) {
                return yield* Effect.die("Failed to create reviewed accounting leg")
              }

              return { giftLegId: giftLeg.id, transactionId: reviewedTransactionId }
            })
          )
        )

        yield* Effect.promise(() =>
          runTransferReconciliation(
            Effect.flatMap(TransferReconciliationService, (service) =>
              service.reconcileTransferCandidates({
                principalId: TEST_PRINCIPAL_ID,
                sourceId: TEST_SOURCE_ID,
              })
            )
          )
        )
        const canonicalization = yield* Effect.promise(() =>
          runTransferReconciliation(
            Effect.flatMap(TransferReconciliationService, (service) =>
              service.applyDeterministicInternalTransferCanonicalization({
                principalId: TEST_PRINCIPAL_ID,
                sourceId: TEST_SOURCE_ID,
              })
            )
          )
        )
        const state = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const [transaction] = yield* db
                .select({ transactionType: schema.transactions.transactionType })
                .from(schema.transactions)
                .where(eq(schema.transactions.id, reviewedFixture.transactionId))
              const [review] = yield* db
                .select({
                  reviewStatus: schema.transactionReviews.reviewStatus,
                  currentTypeKey: schema.transactionReviews.currentTypeKey,
                  userNotes: schema.transactionReviews.userNotes,
                })
                .from(schema.transactionReviews)
                .where(eq(schema.transactionReviews.transactionId, reviewedFixture.transactionId))
              const giftLegs = yield* db
                .select({ id: schema.transactionLegs.id })
                .from(schema.transactionLegs)
                .where(eq(schema.transactionLegs.id, reviewedFixture.giftLegId))
              const internalLegs = yield* db
                .select({ id: schema.transactionLegs.id })
                .from(schema.transactionLegs)
                .where(
                  inArray(schema.transactionLegs.derivationRule, [
                    "internal_transfer_out",
                    "internal_transfer_in",
                  ])
                )
              const [reconciliation] = yield* db
                .select({
                  status: schema.transferReconciliations.status,
                  matchReason: schema.transferReconciliations.matchReason,
                })
                .from(schema.transferReconciliations)
                .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
              return { giftLegs, internalLegs, reconciliation, review, transaction }
            })
          )
        )

        expect(canonicalization).toEqual({ canonicalizedPairs: 0 })
        expect(state.transaction).toEqual({ transactionType: "sell_fiat" })
        expect(state.review).toEqual({
          reviewStatus,
          currentTypeKey: "sell_fiat",
          userNotes: "Preserve the reviewed gift accounting.",
        })
        expect(state.giftLegs).toEqual([{ id: reviewedFixture.giftLegId }])
        expect(state.internalLegs).toHaveLength(0)
        expect(state.reconciliation).toMatchObject({
          status: "needs_review",
          matchReason: "manual_transaction_review_preserved",
        })
      })
    }
  )

  it.effect("revalidates provider movement facts before canonicalization", () =>
    Effect.gen(function* () {
      const walletAddress = "bc1qownedwalletstalefacts000000000000000000"
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T11:00:00.000Z"))
      const providerAssetRowId = yield* Effect.promise(() =>
        runPg(seedApprovedProviderAsset({ providerAssetId: "btc-provider-stale-facts" }))
      )
      yield* Effect.promise(() => runPg(seedOwnedOnchainSource({ walletAddress })))
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          seedProviderTransfer({
            providerAssetRowId,
            externalId: "provider-transfer-stale-facts",
            timestamp,
            amount: "0.10000000",
            toAddress: walletAddress,
            networkHash: "btc-stale-facts-hash",
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(
          seedOnchainReceipt({
            externalId: "onchain-receipt-stale-facts",
            txHash: "btc-stale-facts-hash",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T11:05:00.000Z")),
            amount: "0.10000000",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
          })
        )
      )

      yield* Effect.promise(() =>
        runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.reconcileTransferCandidates({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )
      const providerTransactionId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [providerTransfer] = yield* db
              .select({ transactionId: schema.providerTransfers.transactionId })
              .from(schema.providerTransfers)
              .where(eq(schema.providerTransfers.id, providerTransferId))
            if (providerTransfer === undefined) {
              return yield* Effect.die("Failed to load stale-facts provider transaction")
            }
            yield* db.insert(schema.inventoryMovements).values({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
              transactionId: providerTransfer.transactionId,
              providerTransferId,
              assetId: TEST_BTC_ASSET_ID,
              timestamp,
              direction: "outbound",
              purpose: "principal",
              taxTreatment: "pending_review",
              reconciliationStatus: "unmatched",
              amount: "0.10000000",
            })
            return providerTransfer.transactionId
          })
        )
      )
      expect(
        yield* Effect.promise(() =>
          runTransferReconciliation(
            Effect.flatMap(TransferReconciliationService, (service) =>
              service.applyDeterministicInternalTransferCanonicalization({
                principalId: TEST_PRINCIPAL_ID,
                sourceId: TEST_SOURCE_ID,
              })
            )
          )
        )
      ).toEqual({ canonicalizedPairs: 1 })
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.transactions)
              .set({ transactionType: "internal_transfer" })
              .where(eq(schema.transactions.id, providerTransactionId))
            yield* db.insert(schema.transactionReviews).values({
              transactionId: providerTransactionId,
              principalId: TEST_PRINCIPAL_ID,
              reviewStatus: "needs_review",
              originalTypeKey: null,
              currentTypeKey: "internal_transfer",
              categorizationReason:
                "Deterministic provider transfer reconciled to a principal-owned onchain transfer.",
              matchedLayer: "transfer_reconciliation",
              needsReview: true,
            })
            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures([
                {
                  movementIdentity: {
                    sourceRecordKey: "stale-facts-legacy-internal-leg",
                    componentKey: "movement",
                  },
                  sourceId: TEST_SOURCE_ID,
                  externalId: "stale-facts-legacy-internal-leg",
                  timestamp,
                  principalId: TEST_PRINCIPAL_ID,
                  transactionId: providerTransactionId,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "0.10000000",
                  kind: "disposal",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  derivationRule: "internal_transfer_out",
                  metadata: { reconciliation: { providerTransferId } },
                },
              ])
            )
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.providerTransfers)
              .set({ amount: "0.20000000" })
              .where(eq(schema.providerTransfers.id, providerTransferId))
          })
        )
      )
      const [preApply] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                amount: schema.providerTransfers.amount,
                reviewMetadata: schema.transferReconciliations.reviewMetadata,
                revalidateMovementFacts: sql<boolean>`
              (${schema.transferReconciliations.reviewMetadata}->>'revalidateMovementFacts')::boolean
            `,
              })
              .from(schema.transferReconciliations)
              .innerJoin(
                schema.providerTransfers,
                eq(schema.providerTransfers.id, schema.transferReconciliations.providerTransferId)
              )
              .where(eq(schema.providerTransfers.id, providerTransferId))
          })
        )
      )
      expect(preApply).toMatchObject({ revalidateMovementFacts: true })

      const canonicalization = yield* Effect.promise(() =>
        runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.applyDeterministicInternalTransferCanonicalization({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )
      const state = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [reconciliation] = yield* db
              .select({
                status: schema.transferReconciliations.status,
                matchReason: schema.transferReconciliations.matchReason,
              })
              .from(schema.transferReconciliations)
              .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
            const internalLegs = yield* db
              .select({ id: schema.transactionLegs.id })
              .from(schema.transactionLegs)
              .where(
                inArray(schema.transactionLegs.derivationRule, [
                  "internal_transfer_out",
                  "internal_transfer_in",
                ])
              )
            const [movement] = yield* db
              .select({ reconciliationStatus: schema.inventoryMovements.reconciliationStatus })
              .from(schema.inventoryMovements)
              .where(eq(schema.inventoryMovements.providerTransferId, providerTransferId))
            const [review] = yield* db
              .select({ transactionId: schema.transactionReviews.transactionId })
              .from(schema.transactionReviews)
              .where(eq(schema.transactionReviews.transactionId, providerTransactionId))
            const [transaction] = yield* db
              .select({ transactionType: schema.transactions.transactionType })
              .from(schema.transactions)
              .where(eq(schema.transactions.id, providerTransactionId))
            return { internalLegs, movement, reconciliation, review, transaction }
          })
        )
      )

      expect(canonicalization).toEqual({ canonicalizedPairs: 0 })
      expect(state.reconciliation).toMatchObject({
        status: "needs_review",
        matchReason: "movement_facts_changed_before_canonicalization",
      })
      expect(state.internalLegs).toHaveLength(0)
      expect(state.movement?.reconciliationStatus).toBe("unmatched")
      expect(state.review).toBeUndefined()
      expect(state.transaction?.transactionType).toBe(null)
    })
  )

  it.effect("moves both provider transfers to review when they claim one canonical receipt", () =>
    Effect.gen(function* () {
      const walletAddress = "bc1qownedwalletduplicateclaim00000000000000000"
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-11T12:00:00.000Z"))
      const providerAssetRowId = yield* Effect.promise(() =>
        runPg(seedApprovedProviderAsset({ providerAssetId: "btc-provider-duplicate-claim" }))
      )
      yield* Effect.promise(() => runPg(seedOwnedOnchainSource({ walletAddress })))
      const providerTransferIds = yield* Effect.promise(() =>
        Promise.all(
          ["a", "b"].map((suffix) =>
            runPg(
              seedProviderTransfer({
                providerAssetRowId,
                externalId: `provider-transfer-duplicate-claim-${suffix}`,
                timestamp,
                amount: "0.12500000",
                toAddress: walletAddress,
                networkHash: "btc-duplicate-claim-hash",
              })
            )
          )
        )
      )
      yield* Effect.promise(() =>
        runPg(
          seedOnchainReceipt({
            externalId: "onchain-receipt-duplicate-claim",
            txHash: "btc-duplicate-claim-hash",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-11T12:05:00.000Z")),
            amount: "0.12500000",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
          })
        )
      )
      yield* Effect.promise(() =>
        runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.reconcileTransferCandidates({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )
      const applySummary = yield* Effect.promise(() =>
        runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.applyDeterministicInternalTransferCanonicalization({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )
      const state = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const reconciliations = yield* db
              .select({
                providerTransferId: schema.transferReconciliations.providerTransferId,
                status: schema.transferReconciliations.status,
                canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
              })
              .from(schema.transferReconciliations)
              .where(
                inArray(schema.transferReconciliations.providerTransferId, providerTransferIds)
              )
            const internalLegs = yield* db
              .select({ id: schema.transactionLegs.id })
              .from(schema.transactionLegs)
              .where(
                inArray(schema.transactionLegs.derivationRule, [
                  "internal_transfer_out",
                  "internal_transfer_in",
                ])
              )
            return { reconciliations, internalLegs }
          })
        )
      )

      expect(applySummary).toEqual({ canonicalizedPairs: 0 })
      expect(state.reconciliations).toHaveLength(2)
      expect(state.reconciliations).toEqual(
        expect.arrayContaining(
          providerTransferIds.map((providerTransferId) => ({
            providerTransferId,
            status: "needs_review",
            canonicalTransferId: null,
          }))
        )
      )
      expect(state.internalLegs).toHaveLength(0)
    })
  )

  it.effect("revalidates the candidate set after locking the destination source", () =>
    Effect.gen(function* () {
      const walletAddress = "bc1qownedwalletstalesnapshot000000000000000000"
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-11T13:00:00.000Z"))
      const providerAssetRowId = yield* Effect.promise(() =>
        runPg(seedApprovedProviderAsset({ providerAssetId: "btc-provider-stale-snapshot" }))
      )
      yield* Effect.promise(() => runPg(seedOwnedOnchainSource({ walletAddress })))
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          seedProviderTransfer({
            providerAssetRowId,
            externalId: "provider-transfer-stale-snapshot",
            timestamp,
            amount: "0.12500000",
            toAddress: walletAddress,
            networkHash: null,
          })
        )
      )
      const search = {
        principalId: TEST_PRINCIPAL_ID,
        direction: "outbound" as const,
        walletAddress,
        timestampStart: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-11T12:00:00.000Z")),
        timestampEnd: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-11T14:00:00.000Z")),
        networkName: "bitcoin",
        networkHash: null,
      }
      const firstReceipt = yield* Effect.promise(() =>
        runPg(
          seedOnchainReceipt({
            externalId: "onchain-receipt-stale-snapshot-1",
            txHash: "btc-stale-snapshot-hash-1",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-11T13:05:00.000Z")),
            amount: "0.12500000",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
          })
        )
      )
      const initialCandidates = yield* Effect.promise(() =>
        runTransferReconciliationRepository(
          Effect.flatMap(TransferReconciliationRepository, (repository) =>
            repository.findOnchainTransferCandidates(search)
          )
        )
      )
      expect(initialCandidates).toHaveLength(1)
      const initialCandidate = initialCandidates[0]
      if (initialCandidate === undefined) {
        throw new Error("Missing initial reconciliation candidate")
      }
      const candidateFingerprint = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Unknown)
      )([
        initialCandidate.transferId,
        initialCandidate.observedProviderTransferId,
        initialCandidate.transactionId,
        initialCandidate.sourceId,
        initialCandidate.addressId,
        initialCandidate.blockchainId,
        initialCandidate.blockchainName,
        initialCandidate.txHash,
        initialCandidate.timestamp.toISOString(),
        initialCandidate.fromAddress,
        initialCandidate.toAddress,
        initialCandidate.providerAssetRowId,
        initialCandidate.providerAssetMappingStatus,
        initialCandidate.assetId,
        initialCandidate.assetRepresentationId,
        initialCandidate.representationType,
        initialCandidate.contractAddress,
        initialCandidate.mintAddress,
        initialCandidate.decimals,
        initialCandidate.amount,
      ])

      const lockAcquired = yield* Deferred.make<void>()
      const releaseLock = yield* Deferred.make<void>()
      const lockDestinationSource = runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .select({ id: schema.sources.id })
                .from(schema.sources)
                .where(eq(schema.sources.id, ONCHAIN_SOURCE_ID))
                .for("no key update")
              yield* Deferred.succeed(lockAcquired, undefined)
              yield* Deferred.await(releaseLock)
            })
          )
        })
      )
      yield* Deferred.await(lockAcquired)

      const upsert = runTransferReconciliationRepository(
        Effect.flatMap(TransferReconciliationRepository, (repository) =>
          repository.upsertTransferReconciliation({
            principalId: TEST_PRINCIPAL_ID,
            providerTransferId,
            canonicalTransferId: firstReceipt.transferId,
            canonicalTransactionId: firstReceipt.transactionId,
            status: "auto_applied",
            matchReason: "single_exact_onchain_receipt",
            confidence: "1.0000",
            deterministic: true,
            reviewMetadata: {},
            candidateSnapshot: {
              search,
              providerAmount: "0.12500000",
              candidateFingerprints: [candidateFingerprint],
            },
          })
        )
      )
      yield* Effect.promise(() =>
        context.waitForQueryBlockedOnLock({ queryIncludes: 'from "sources"' })
      )

      yield* Effect.promise(() =>
        runPg(
          seedOnchainReceipt({
            externalId: "onchain-receipt-stale-snapshot-2",
            txHash: "btc-stale-snapshot-hash-2",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-11T13:06:00.000Z")),
            amount: "0.12500000",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
          })
        )
      )
      yield* Deferred.succeed(releaseLock, undefined)
      const [result] = yield* Effect.promise(() => Promise.all([upsert, lockDestinationSource]))
      const state = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [reconciliation] = yield* db
              .select({
                status: schema.transferReconciliations.status,
                canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
                matchReason: schema.transferReconciliations.matchReason,
              })
              .from(schema.transferReconciliations)
              .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
            const internalLegs = yield* db
              .select({ id: schema.transactionLegs.id })
              .from(schema.transactionLegs)
              .where(
                inArray(schema.transactionLegs.derivationRule, [
                  "internal_transfer_out",
                  "internal_transfer_in",
                ])
              )
            return { internalLegs, reconciliation }
          })
        )
      )

      expect(result.candidateSnapshotChanged).toBe(true)
      expect(state.reconciliation).toEqual({
        status: "needs_review",
        canonicalTransferId: null,
        matchReason: "candidate_set_changed_during_reconciliation",
      })
      expect(state.internalLegs).toHaveLength(0)
    })
  )

  it.effect("compares EVM transaction hashes without case sensitivity", () =>
    Effect.gen(function* () {
      const walletAddress = "0xAbCd00000000000000000000000000000000Ef01"
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:00:00.000Z"))
      const providerAssetRowId = yield* Effect.promise(() =>
        runPg(
          seedApprovedProviderAsset({
            providerAssetId: "eur-provider-evm-hash",
            canonicalAssetId: TEST_EUR_ASSET_ID,
            assetRepresentationId: null,
            currencyCode: "EUR",
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(
          seedOwnedOnchainSource({
            walletAddress,
            addressType: "evm",
            providerKey: "base",
          })
        )
      )
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          seedProviderTransfer({
            providerAssetRowId,
            externalId: "provider-transfer-evm-hash",
            timestamp,
            amount: "12.5",
            toAddress: walletAddress.toLowerCase(),
            networkHash: "0xABCDEF1234",
            networkName: "base",
          })
        )
      )
      const receipt = yield* Effect.promise(() =>
        runPg(
          seedOnchainReceipt({
            externalId: "onchain-receipt-evm-hash",
            txHash: "0xabcdef1234",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-12T10:00:00.000Z")),
            amount: "12.5",
            walletAddress,
            blockchainId: fixture.baseBlockchainId,
            assetId: TEST_EUR_ASSET_ID,
            assetRepresentationId: TEST_EUR_REPRESENTATION_ID,
            transferType: "erc20",
          })
        )
      )

      yield* Effect.promise(() =>
        runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.reconcileTransferCandidates({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )

      const [reconciliation] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
                status: schema.transferReconciliations.status,
                matchReason: schema.transferReconciliations.matchReason,
              })
              .from(schema.transferReconciliations)
              .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
          })
        )
      )

      expect(reconciliation).toMatchObject({
        canonicalTransferId: receipt.transferId,
        status: "auto_applied",
        matchReason: "deterministic_wallet_receipt_match",
      })
    })
  )

  it.effect("compares Bitcoin transaction ids without case sensitivity", () =>
    Effect.gen(function* () {
      const walletAddress = "bc1qownedwalletbtchash000000000000000000000"
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:00:00.000Z"))
      const providerAssetRowId = yield* Effect.promise(() =>
        runPg(seedApprovedProviderAsset({ providerAssetId: "btc-provider-hash-case" }))
      )
      yield* Effect.promise(() => runPg(seedOwnedOnchainSource({ walletAddress })))
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          seedProviderTransfer({
            providerAssetRowId,
            externalId: "provider-transfer-btc-hash-case",
            timestamp,
            amount: "0.125",
            toAddress: walletAddress,
            networkHash: "ABCDEF1234567890",
          })
        )
      )
      const receipt = yield* Effect.promise(() =>
        runPg(
          seedOnchainReceipt({
            externalId: "onchain-receipt-btc-hash-case",
            txHash: "abcdef1234567890",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:05:00.000Z")),
            amount: "0.125",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
          })
        )
      )

      yield* Effect.promise(() =>
        runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.reconcileTransferCandidates({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )

      const [reconciliation] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
                status: schema.transferReconciliations.status,
                matchReason: schema.transferReconciliations.matchReason,
                deterministic: schema.transferReconciliations.deterministic,
              })
              .from(schema.transferReconciliations)
              .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
          })
        )
      )

      expect(reconciliation).toMatchObject({
        canonicalTransferId: receipt.transferId,
        status: "auto_applied",
        matchReason: "deterministic_wallet_receipt_match",
        deterministic: true,
      })
    })
  )

  it.effect("keeps Solana signatures case-sensitive", () =>
    Effect.gen(function* () {
      const walletAddress = "SoOwnedWalletSignature111111111111111111111111"
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:00:00.000Z"))
      const solanaBlockchainId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [blockchain] = yield* db
              .select({ id: schema.blockchains.id })
              .from(schema.blockchains)
              .where(eq(schema.blockchains.name, "solana"))
              .limit(1)

            if (blockchain === undefined) {
              return yield* Effect.die("Missing seeded Solana blockchain")
            }

            return blockchain.id
          })
        )
      )
      const providerAssetRowId = yield* Effect.promise(() =>
        runPg(seedApprovedProviderAsset({ providerAssetId: "sol-provider-signature-case" }))
      )
      yield* Effect.promise(() =>
        runPg(
          seedOwnedOnchainSource({
            walletAddress,
            addressType: "solana",
            providerKey: "helius-solana",
          })
        )
      )
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          seedProviderTransfer({
            providerAssetRowId,
            externalId: "provider-transfer-sol-signature-case",
            timestamp,
            amount: "1.25",
            toAddress: walletAddress,
            networkHash: "SolanaSignatureABC",
            networkName: "solana",
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(
          seedOnchainReceipt({
            externalId: "onchain-receipt-sol-signature-case",
            txHash: "solanasignatureabc",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:05:00.000Z")),
            amount: "1.25",
            walletAddress,
            blockchainId: solanaBlockchainId,
          })
        )
      )

      yield* Effect.promise(() =>
        runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.reconcileTransferCandidates({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )

      const [reconciliation] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
                status: schema.transferReconciliations.status,
                matchReason: schema.transferReconciliations.matchReason,
              })
              .from(schema.transferReconciliations)
              .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
          })
        )
      )

      expect(reconciliation).toMatchObject({
        canonicalTransferId: null,
        status: "pending",
        matchReason: "no_candidate_onchain_receipt",
      })
    })
  )

  it.effect("keeps exact movement candidates ambiguous before checking economic identity", () =>
    Effect.gen(function* () {
      const walletAddress = "bc1qownedwalletknownasset000000000000000000"
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:00:00.000Z"))
      const providerAssetRowId = yield* Effect.promise(() =>
        runPg(seedApprovedProviderAsset({ providerAssetId: "btc-provider-known-asset" }))
      )
      yield* Effect.promise(() => runPg(seedOwnedOnchainSource({ walletAddress })))
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          seedProviderTransfer({
            providerAssetRowId,
            externalId: "provider-transfer-known-asset",
            timestamp,
            amount: "0.5",
            toAddress: walletAddress,
            networkHash: null,
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(
          seedOnchainReceipt({
            externalId: "onchain-receipt-known-asset",
            txHash: "btc-known-asset",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:05:00.000Z")),
            amount: "0.5",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(
          seedOnchainReceipt({
            externalId: "onchain-receipt-other-asset",
            txHash: "btc-other-asset",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:06:00.000Z")),
            amount: "0.5",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
            assetId: TEST_EUR_ASSET_ID,
            assetRepresentationId: null,
          })
        )
      )

      yield* Effect.promise(() =>
        runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.reconcileTransferCandidates({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )

      const [reconciliation] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
                status: schema.transferReconciliations.status,
                matchReason: schema.transferReconciliations.matchReason,
              })
              .from(schema.transferReconciliations)
              .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
          })
        )
      )

      expect(reconciliation).toMatchObject({
        canonicalTransferId: null,
        status: "needs_review",
        matchReason: "multiple_candidate_onchain_receipts",
      })
    })
  )

  it.effect("keeps a sole candidate pending when exact representation evidence is missing", () =>
    Effect.gen(function* () {
      const walletAddress = "bc1qownedwalletassetconflict00000000000000000"
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:00:00.000Z"))
      const providerAssetRowId = yield* Effect.promise(() =>
        runPg(seedApprovedProviderAsset({ providerAssetId: "btc-provider-asset-conflict" }))
      )
      yield* Effect.promise(() => runPg(seedOwnedOnchainSource({ walletAddress })))
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          seedProviderTransfer({
            providerAssetRowId,
            externalId: "provider-transfer-asset-conflict",
            timestamp,
            amount: "0.5",
            toAddress: walletAddress,
            networkHash: null,
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(
          seedOnchainReceipt({
            externalId: "onchain-receipt-asset-conflict",
            txHash: "btc-asset-conflict",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:05:00.000Z")),
            amount: "0.5",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
            assetId: TEST_EUR_ASSET_ID,
            assetRepresentationId: null,
          })
        )
      )

      yield* Effect.promise(() =>
        runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.reconcileTransferCandidates({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )

      const state = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [reconciliation] = yield* db
              .select({
                canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
                status: schema.transferReconciliations.status,
                matchReason: schema.transferReconciliations.matchReason,
                deterministic: schema.transferReconciliations.deterministic,
              })
              .from(schema.transferReconciliations)
              .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
            const inventoryMovements = yield* db
              .select({ id: schema.inventoryMovements.id })
              .from(schema.inventoryMovements)
              .where(eq(schema.inventoryMovements.providerTransferId, providerTransferId))

            return { reconciliation, inventoryMovements }
          })
        )
      )

      expect(state.reconciliation).toMatchObject({
        canonicalTransferId: null,
        status: "pending",
        matchReason: "destination_representation_observation_missing",
        deterministic: false,
      })
      expect(state.inventoryMovements).toEqual([])
    })
  )

  it.effect("requires exact representation identity on a preferred canonical candidate", () =>
    Effect.gen(function* () {
      const walletAddress = "bc1qownedwalletdedup0000000000000000000000"
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:00:00.000Z"))
      const providerAssetRowId = yield* Effect.promise(() =>
        runPg(
          seedApprovedProviderAsset({
            providerAssetId: "btc-provider-dedup",
            assetRepresentationId: null,
          })
        )
      )
      yield* Effect.promise(() => runPg(seedOwnedOnchainSource({ walletAddress })))
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          seedProviderTransfer({
            providerAssetRowId,
            externalId: "provider-transfer-dedup",
            timestamp,
            amount: "0.75",
            toAddress: walletAddress,
            networkHash: null,
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(
          seedOnchainReceipt({
            externalId: "onchain-shared-dedup",
            txHash: "btc-shared-dedup",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:05:00.000Z")),
            amount: "0.75",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
            assetRepresentationId: null,
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(
          seedObservedOnchainReceipt({
            externalId: "onchain-shared-dedup:provider:principal:0",
            transactionExternalId: "onchain-shared-dedup:observed-transaction",
            canonicalTransferExternalId: "onchain-shared-dedup",
            txHash: "btc-shared-dedup",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:05:00.000Z")),
            amount: "0.75",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
          })
        )
      )

      yield* Effect.promise(() =>
        runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.reconcileTransferCandidates({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )

      const [reconciliation] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
                status: schema.transferReconciliations.status,
                matchReason: schema.transferReconciliations.matchReason,
              })
              .from(schema.transferReconciliations)
              .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
          })
        )
      )

      expect(reconciliation).toMatchObject({
        canonicalTransferId: null,
        status: "pending",
        matchReason: "destination_representation_observation_missing",
      })
    })
  )

  it.effect("compares uniformly cased Bitcoin Bech32 addresses without case sensitivity", () =>
    Effect.gen(function* () {
      const walletAddress = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:00:00.000Z"))
      const providerAssetRowId = yield* Effect.promise(() =>
        runPg(seedApprovedProviderAsset({ providerAssetId: "btc-provider-bech32-case" }))
      )
      yield* Effect.promise(() => runPg(seedOwnedOnchainSource({ walletAddress })))
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          seedProviderTransfer({
            providerAssetRowId,
            externalId: "provider-transfer-bech32-case",
            timestamp,
            amount: "0.25",
            toAddress: walletAddress.toUpperCase(),
            networkHash: null,
          })
        )
      )
      const receipt = yield* Effect.promise(() =>
        runPg(
          seedOnchainReceipt({
            externalId: "onchain-receipt-bech32-case",
            txHash: "btc-bech32-case",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:05:00.000Z")),
            amount: "0.25",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.transfers)
              .set({ toAddress: walletAddress.toUpperCase() })
              .where(eq(schema.transfers.id, receipt.transferId))
          })
        )
      )

      yield* Effect.promise(() =>
        runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.reconcileTransferCandidates({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )

      const [reconciliation] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
                status: schema.transferReconciliations.status,
                matchReason: schema.transferReconciliations.matchReason,
              })
              .from(schema.transferReconciliations)
              .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
          })
        )
      )

      expect(reconciliation).toMatchObject({
        canonicalTransferId: receipt.transferId,
        status: "auto_applied",
        matchReason: "deterministic_wallet_receipt_match",
      })
    })
  )

  it.effect("keeps Bitcoin Base58 address comparisons case-sensitive", () =>
    Effect.gen(function* () {
      const walletAddress = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT"
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:00:00.000Z"))
      const providerAssetRowId = yield* Effect.promise(() =>
        runPg(seedApprovedProviderAsset({ providerAssetId: "btc-provider-base58-case" }))
      )
      yield* Effect.promise(() => runPg(seedOwnedOnchainSource({ walletAddress })))
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          seedProviderTransfer({
            providerAssetRowId,
            externalId: "provider-transfer-base58-case",
            timestamp,
            amount: "0.25",
            toAddress: walletAddress,
            networkHash: null,
          })
        )
      )
      const receipt = yield* Effect.promise(() =>
        runPg(
          seedOnchainReceipt({
            externalId: "onchain-receipt-base58-case",
            txHash: "btc-base58-case",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:05:00.000Z")),
            amount: "0.25",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.transfers)
              .set({ toAddress: walletAddress.toLowerCase() })
              .where(eq(schema.transfers.id, receipt.transferId))
          })
        )
      )

      yield* Effect.promise(() =>
        runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.reconcileTransferCandidates({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )

      const [reconciliation] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
                status: schema.transferReconciliations.status,
                matchReason: schema.transferReconciliations.matchReason,
              })
              .from(schema.transferReconciliations)
              .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
          })
        )
      )

      expect(reconciliation).toMatchObject({
        canonicalTransferId: null,
        status: "pending",
        matchReason: "no_candidate_onchain_receipt",
      })
    })
  )

  it.effect("keeps mixed-case Bitcoin Bech32 addresses case-sensitive", () =>
    Effect.gen(function* () {
      const walletAddress = "bc1qW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:00:00.000Z"))
      const providerAssetRowId = yield* Effect.promise(() =>
        runPg(seedApprovedProviderAsset({ providerAssetId: "btc-provider-bech32-mixed-case" }))
      )
      yield* Effect.promise(() => runPg(seedOwnedOnchainSource({ walletAddress })))
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          seedProviderTransfer({
            providerAssetRowId,
            externalId: "provider-transfer-bech32-mixed-case",
            timestamp,
            amount: "0.25",
            toAddress: walletAddress.toLowerCase(),
            networkHash: null,
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(
          seedOnchainReceipt({
            externalId: "onchain-receipt-bech32-mixed-case",
            txHash: "btc-bech32-mixed-case",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:05:00.000Z")),
            amount: "0.25",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
          })
        )
      )

      yield* Effect.promise(() =>
        runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.reconcileTransferCandidates({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )

      const [reconciliation] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
                status: schema.transferReconciliations.status,
                matchReason: schema.transferReconciliations.matchReason,
              })
              .from(schema.transferReconciliations)
              .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
          })
        )
      )

      expect(reconciliation).toMatchObject({
        canonicalTransferId: null,
        status: "pending",
        matchReason: "no_candidate_onchain_receipt",
      })
    })
  )

  it.effect("excludes canonical and observed fee movements from exact-hash candidates", () =>
    Effect.gen(function* () {
      const walletAddress = "bc1qownedwalletfee0000000000000000000000000"
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:00:00.000Z"))
      const providerAssetRowId = yield* Effect.promise(() =>
        runPg(seedApprovedProviderAsset({ providerAssetId: "btc-provider-fee" }))
      )
      yield* Effect.promise(() => runPg(seedOwnedOnchainSource({ walletAddress })))
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          seedProviderTransfer({
            providerAssetRowId,
            externalId: "provider-transfer-fee",
            timestamp,
            amount: "0.0001",
            toAddress: walletAddress,
            networkHash: "btc-fee-hash",
          })
        )
      )
      const fee = yield* Effect.promise(() =>
        runPg(
          seedOnchainReceipt({
            externalId: "onchain-fee",
            txHash: "btc-fee-hash",
            timestamp,
            amount: "0.0001",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.transfers)
              .set({ type: "fee", metadata: { provider: "bitcoin", role: "fee" } })
              .where(eq(schema.transfers.id, fee.transferId))
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(
          seedObservedOnchainReceipt({
            externalId: "observed-onchain-fee",
            txHash: "btc-fee-hash",
            timestamp,
            amount: "0.0001",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
            role: "fee",
          })
        )
      )

      yield* Effect.promise(() =>
        runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.reconcileTransferCandidates({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )

      const [reconciliation] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
                status: schema.transferReconciliations.status,
                matchReason: schema.transferReconciliations.matchReason,
              })
              .from(schema.transferReconciliations)
              .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
          })
        )
      )

      expect(reconciliation).toMatchObject({
        canonicalTransferId: null,
        status: "pending",
        matchReason: "no_candidate_onchain_receipt",
      })
    })
  )

  it.effect("excludes observed candidates with excluded asset mappings", () =>
    Effect.gen(function* () {
      const walletAddress = "bc1qownedwalletexcludedasset000000000000000000"
      const makeObservedAsset = (suffix: string) => ({
        provider: "bitcoin",
        providerAssetId: `bitcoin:${suffix}`,
        naturalKey: `bitcoin:${suffix}`,
        currencyCode: "BTC",
        name: `Bitcoin ${suffix}`,
        exponent: 8,
        providerType: "native",
        networkName: "bitcoin",
        fromAddress: "bc1qexternalorigin0000000000000000000000000",
        representationType: "native" as const,
        contractAddress: null,
        mintAddress: null,
        decimals: 8,
      })

      yield* Effect.promise(() => runPg(seedOwnedOnchainSource({ walletAddress })))
      const excluded = yield* Effect.promise(() =>
        runPg(
          seedObservedOnchainReceipt({
            externalId: "observed-excluded-asset",
            txHash: "btc-excluded-asset-hash",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:01:00.000Z")),
            amount: "0.10",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
            observedAsset: makeObservedAsset("excluded"),
          })
        )
      )
      const unmapped = yield* Effect.promise(() =>
        runPg(
          seedObservedOnchainReceipt({
            externalId: "observed-unmapped-asset",
            txHash: "btc-unmapped-asset-hash",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:02:00.000Z")),
            amount: "0.20",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
            observedAsset: makeObservedAsset("unmapped"),
          })
        )
      )
      const pending = yield* Effect.promise(() =>
        runPg(
          seedObservedOnchainReceipt({
            externalId: "observed-pending-asset",
            txHash: "btc-pending-asset-hash",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:03:00.000Z")),
            amount: "0.30",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
            observedAsset: makeObservedAsset("pending"),
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.providerAssetMappings).values([
              {
                providerAssetRowId: excluded.providerAssetRowId,
                mappingKind: "asset",
                canonicalAssetId: null,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "excluded",
                reviewerNotes: null,
                sourceNotes: "Excluded by policy",
              },
              {
                providerAssetRowId: pending.providerAssetRowId,
                mappingKind: "asset",
                canonicalAssetId: null,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "pending_review",
                reviewerNotes: null,
                sourceNotes: "Awaiting review",
              },
            ])
          })
        )
      )

      const candidates = yield* Effect.promise(() =>
        runTransferReconciliationRepository(
          Effect.flatMap(TransferReconciliationRepository, (repository) =>
            repository.findOnchainTransferCandidates({
              principalId: TEST_PRINCIPAL_ID,
              direction: "outbound",
              walletAddress,
              timestampStart: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:00:00.000Z")),
              timestampEnd: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:05:00.000Z")),
              networkName: "bitcoin",
              networkHash: null,
            })
          )
        )
      )

      expect(
        candidates.map(({ observedProviderTransferId, providerAssetMappingStatus }) => ({
          observedProviderTransferId,
          providerAssetMappingStatus,
        }))
      ).toEqual([
        {
          observedProviderTransferId: unmapped.providerTransferId,
          providerAssetMappingStatus: null,
        },
        {
          observedProviderTransferId: pending.providerTransferId,
          providerAssetMappingStatus: "pending_review",
        },
      ])
    })
  )

  it.effect("defers an approved observed representation until its canonical transfer exists", () =>
    Effect.gen(function* () {
      const walletAddress = "bc1qownedwalletapprovedobservation000000000000"
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:00:00.000Z"))
      const providerAssetRowId = yield* Effect.promise(() =>
        runPg(seedApprovedProviderAsset({ providerAssetId: "btc-provider-approved-observation" }))
      )
      yield* Effect.promise(() => runPg(seedOwnedOnchainSource({ walletAddress })))
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          seedProviderTransfer({
            providerAssetRowId,
            externalId: "provider-transfer-approved-observation",
            timestamp,
            amount: "0.25",
            toAddress: walletAddress,
            networkHash: "btc-approved-observation-hash",
          })
        )
      )
      const observed = yield* Effect.promise(() =>
        runPg(
          seedObservedOnchainReceipt({
            externalId: "observed-approved-representation",
            txHash: "btc-approved-observation-hash",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:05:00.000Z")),
            amount: "0.25",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.providerAssetMappings).values({
              providerAssetRowId: observed.providerAssetRowId,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: null,
              sourceNotes: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
          })
        )
      )

      const summary = yield* Effect.promise(() =>
        runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.reconcileTransferCandidates({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )
      const canonicalization = yield* Effect.promise(() =>
        runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.applyDeterministicInternalTransferCanonicalization({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )
      const state = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [reconciliation] = yield* db
              .select({
                canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
                canonicalTransactionId: schema.transferReconciliations.canonicalTransactionId,
                status: schema.transferReconciliations.status,
                matchReason: schema.transferReconciliations.matchReason,
                deterministic: schema.transferReconciliations.deterministic,
              })
              .from(schema.transferReconciliations)
              .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
            const inventoryMovements = yield* db
              .select({ id: schema.inventoryMovements.id })
              .from(schema.inventoryMovements)
              .where(eq(schema.inventoryMovements.providerTransferId, providerTransferId))

            return { reconciliation, inventoryMovements }
          })
        )
      )

      expect(summary).toEqual(
        expect.objectContaining({
          evaluatedProviderTransfers: 1,
          pending: 1,
        })
      )
      expect(state.reconciliation).toMatchObject({
        canonicalTransferId: null,
        canonicalTransactionId: observed.transactionId,
        status: "pending",
        matchReason: "destination_source_replay_pending",
        deterministic: false,
      })
      expect(canonicalization).toEqual({ canonicalizedPairs: 0 })
      expect(state.inventoryMovements).toEqual([])
    })
  )

  it.effect("records first-seen representation evidence without moving inventory", () =>
    Effect.gen(function* () {
      const walletAddress = "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0"
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:00:00.000Z"))
      const providerAssetRowId = yield* Effect.promise(() =>
        runPg(
          seedApprovedProviderAsset({
            providerAssetId: "btc-provider-pending-representation",
            assetRepresentationId: null,
          })
        )
      )
      yield* Effect.promise(() => runPg(seedOwnedOnchainSource({ walletAddress })))
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          seedProviderTransfer({
            providerAssetRowId,
            externalId: "provider-transfer-pending-representation",
            timestamp,
            amount: "0.33",
            toAddress: walletAddress.toUpperCase(),
            networkHash: null,
          })
        )
      )
      const observed = yield* Effect.promise(() =>
        runPg(
          seedObservedOnchainReceipt({
            externalId: "observed-pending-representation",
            txHash: "btc-pending-representation",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:05:00.000Z")),
            amount: "0.33",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.providerTransfers)
              .set({ toAddress: walletAddress.toUpperCase() })
              .where(eq(schema.providerTransfers.id, observed.providerTransferId))
          })
        )
      )

      yield* Effect.promise(() =>
        runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.reconcileTransferCandidates({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )

      const state = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [reconciliation] = yield* db
              .select({
                canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
                canonicalTransactionId: schema.transferReconciliations.canonicalTransactionId,
                status: schema.transferReconciliations.status,
                matchReason: schema.transferReconciliations.matchReason,
                deterministic: schema.transferReconciliations.deterministic,
              })
              .from(schema.transferReconciliations)
              .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
            const [mapping] = yield* db
              .select({
                mappingStatus: schema.providerAssetMappings.mappingStatus,
                canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
                assetRepresentationId: schema.providerAssetMappings.assetRepresentationId,
                sourceNotes: schema.providerAssetMappings.sourceNotes,
              })
              .from(schema.providerAssetMappings)
              .where(
                eq(schema.providerAssetMappings.providerAssetRowId, observed.providerAssetRowId)
              )
            const inventoryMovements = yield* db
              .select({ id: schema.inventoryMovements.id })
              .from(schema.inventoryMovements)
              .where(eq(schema.inventoryMovements.providerTransferId, providerTransferId))

            return { reconciliation, mapping, inventoryMovements }
          })
        )
      )

      expect(state.reconciliation).toMatchObject({
        canonicalTransferId: null,
        canonicalTransactionId: observed.transactionId,
        status: "pending",
        matchReason: "asset_representation_review_pending",
        deterministic: false,
      })
      expect(state.mapping).toMatchObject({
        mappingStatus: "pending_review",
        canonicalAssetId: null,
        assetRepresentationId: null,
      })
      expect(state.mapping?.sourceNotes).toContain("transfer_reconciliation_evidence:")
      expect(state.mapping?.sourceNotes).toContain(TEST_BTC_ASSET_ID)
      expect(state.inventoryMovements).toEqual([])
    })
  )

  it.effect("records a first-seen Solana mint from a Coinbase transfer as pending evidence", () =>
    Effect.gen(function* () {
      const walletAddress = "SoOwnedWalletPendingMint1111111111111111111111"
      const mintAddress = "PendingMint1111111111111111111111111111111111"
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:00:00.000Z"))
      const solanaBlockchainId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [blockchain] = yield* db
              .select({ id: schema.blockchains.id })
              .from(schema.blockchains)
              .where(eq(schema.blockchains.name, "solana"))
              .limit(1)

            if (blockchain === undefined) {
              return yield* Effect.die("Missing seeded Solana blockchain")
            }

            return blockchain.id
          })
        )
      )
      const providerAssetRowId = yield* Effect.promise(() =>
        runPg(
          seedApprovedProviderAsset({
            providerAssetId: "btc-provider-pending-solana-mint",
            assetRepresentationId: null,
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(
          seedOwnedOnchainSource({
            walletAddress,
            addressType: "solana",
            providerKey: "helius-solana",
          })
        )
      )
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          seedProviderTransfer({
            providerAssetRowId,
            externalId: "provider-transfer-pending-solana-mint",
            timestamp,
            amount: "0.33",
            toAddress: walletAddress,
            networkHash: "SolanaPendingMintSignature",
            networkName: "solana",
          })
        )
      )
      const observed = yield* Effect.promise(() =>
        runPg(
          seedObservedOnchainReceipt({
            externalId: "observed-pending-solana-mint",
            txHash: "SolanaPendingMintSignature",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T10:05:00.000Z")),
            amount: "0.33",
            walletAddress,
            blockchainId: solanaBlockchainId,
            observedAsset: {
              provider: "helius-solana",
              providerAssetId: mintAddress,
              naturalKey: `solana:mint:${mintAddress}`,
              currencyCode: "UNKNOWN",
              name: "Unknown Solana token",
              exponent: 6,
              providerType: "spl-token",
              networkName: "solana",
              fromAddress: "SoExternalOrigin1111111111111111111111111111",
              representationType: "token",
              contractAddress: null,
              mintAddress,
              decimals: 6,
            },
          })
        )
      )

      yield* Effect.promise(() =>
        runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.reconcileTransferCandidates({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )

      const state = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [reconciliation] = yield* db
              .select({
                canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
                canonicalTransactionId: schema.transferReconciliations.canonicalTransactionId,
                status: schema.transferReconciliations.status,
                matchReason: schema.transferReconciliations.matchReason,
                deterministic: schema.transferReconciliations.deterministic,
              })
              .from(schema.transferReconciliations)
              .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
            const [mapping] = yield* db
              .select({
                mappingStatus: schema.providerAssetMappings.mappingStatus,
                canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
                assetRepresentationId: schema.providerAssetMappings.assetRepresentationId,
                sourceNotes: schema.providerAssetMappings.sourceNotes,
              })
              .from(schema.providerAssetMappings)
              .where(
                eq(schema.providerAssetMappings.providerAssetRowId, observed.providerAssetRowId)
              )
            const inventoryMovements = yield* db
              .select({ id: schema.inventoryMovements.id })
              .from(schema.inventoryMovements)
              .where(eq(schema.inventoryMovements.providerTransferId, providerTransferId))

            return { reconciliation, mapping, inventoryMovements }
          })
        )
      )

      expect(state.reconciliation).toMatchObject({
        canonicalTransferId: null,
        canonicalTransactionId: observed.transactionId,
        status: "pending",
        matchReason: "asset_representation_review_pending",
        deterministic: false,
      })
      expect(state.mapping).toMatchObject({
        mappingStatus: "pending_review",
        canonicalAssetId: null,
        assetRepresentationId: null,
      })
      expect(state.mapping?.sourceNotes).toContain("transfer_reconciliation_evidence:")
      expect(state.mapping?.sourceNotes).toContain(TEST_BTC_ASSET_ID)
      expect(state.inventoryMovements).toEqual([])
    })
  )

  it.effect("marks competing owned receipts as needs_review instead of forcing a match", () =>
    Effect.gen(function* () {
      const walletAddress = "bc1qownedwalletambiguous000000000000000000"
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-11T10:00:00.000Z"))

      const providerAssetRowId = yield* Effect.promise(() =>
        runPg(
          seedApprovedProviderAsset({
            providerAssetId: "btc-provider-asset-ambiguous",
          })
        )
      )
      yield* Effect.promise(() => runPg(seedOwnedOnchainSource({ walletAddress })))
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          seedProviderTransfer({
            providerAssetRowId,
            externalId: "provider-transfer-ambiguous",
            timestamp,
            amount: "0.25000000",
            toAddress: walletAddress,
            networkHash: null,
          })
        )
      )

      yield* Effect.promise(() =>
        runPg(
          seedOnchainReceipt({
            externalId: "onchain-receipt-ambiguous-1",
            txHash: "btc-ambiguous-hash-1",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-11T10:05:00.000Z")),
            amount: "0.25000000",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(
          seedOnchainReceipt({
            externalId: "onchain-receipt-ambiguous-2",
            txHash: "btc-ambiguous-hash-2",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-11T10:08:00.000Z")),
            amount: "0.25000000",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
          })
        )
      )

      const summary = yield* Effect.promise(() =>
        runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.reconcileTransferCandidates({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )

      const [reconciliation] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select()
              .from(schema.transferReconciliations)
              .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
          })
        )
      )

      expect(summary).toEqual(
        expect.objectContaining({
          evaluatedProviderTransfers: 1,
          needsReview: 1,
        })
      )
      expect(reconciliation).toEqual(
        expect.objectContaining({
          providerTransferId,
          canonicalTransferId: null,
          canonicalTransactionId: null,
          status: "needs_review",
          matchReason: "multiple_candidate_onchain_receipts",
          deterministic: false,
        })
      )
    })
  )

  it.effect("keeps reconciliation reruns idempotent for the same provider transfer", () =>
    Effect.gen(function* () {
      const walletAddress = "bc1qownedwalletrerun00000000000000000000000"
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-12T10:00:00.000Z"))

      const providerAssetRowId = yield* Effect.promise(() =>
        runPg(
          seedApprovedProviderAsset({
            providerAssetId: "btc-provider-asset-rerun",
          })
        )
      )
      yield* Effect.promise(() => runPg(seedOwnedOnchainSource({ walletAddress })))
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          seedProviderTransfer({
            providerAssetRowId,
            externalId: "provider-transfer-rerun",
            timestamp,
            amount: "0.05000000",
            toAddress: walletAddress,
            networkHash: "btc-rerun-hash-1",
          })
        )
      )

      yield* Effect.promise(() =>
        runPg(
          seedOnchainReceipt({
            externalId: "onchain-receipt-rerun",
            txHash: "btc-rerun-hash-1",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-12T10:03:00.000Z")),
            amount: "0.05000000",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
          })
        )
      )

      yield* Effect.promise(() =>
        runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.reconcileTransferCandidates({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )

      yield* Effect.promise(() =>
        runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.reconcileTransferCandidates({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
      )

      const reconciliations = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select()
              .from(schema.transferReconciliations)
              .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
          })
        )
      )

      expect(reconciliations).toHaveLength(1)
      expect(reconciliations[0]).toEqual(
        expect.objectContaining({
          providerTransferId,
          status: "auto_applied",
          deterministic: true,
        })
      )
    })
  )

  it.effect("does not overwrite an admin-reviewed reconciliation on later upserts", () =>
    Effect.gen(function* () {
      const walletAddress = "bc1qownedwalletreviewlocked00000000000000000"
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-13T10:00:00.000Z"))

      const providerAssetRowId = yield* Effect.promise(() =>
        runPg(
          seedApprovedProviderAsset({
            providerAssetId: "btc-provider-asset-reviewed",
          })
        )
      )
      yield* Effect.promise(() => runPg(seedOwnedOnchainSource({ walletAddress })))
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          seedProviderTransfer({
            providerAssetRowId,
            externalId: "provider-transfer-reviewed",
            timestamp,
            amount: "0.20000000",
            toAddress: walletAddress,
            networkHash: "btc-reviewed-hash-1",
          })
        )
      )
      const receipt = yield* Effect.promise(() =>
        runPg(
          seedOnchainReceipt({
            externalId: "onchain-receipt-reviewed",
            txHash: "btc-reviewed-hash-1",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-13T10:05:00.000Z")),
            amount: "0.20000000",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
          })
        )
      )

      yield* Effect.promise(() =>
        runTransferReconciliationRepository(
          Effect.flatMap(TransferReconciliationRepository, (repository) =>
            repository.upsertTransferReconciliation({
              principalId: TEST_PRINCIPAL_ID,
              providerTransferId,
              canonicalTransferId: receipt.transferId,
              canonicalTransactionId: receipt.transactionId,
              status: "approved",
              matchReason: "admin_locked_match",
              confidence: "1.0000",
              deterministic: true,
              reviewMetadata: {
                adminReview: {
                  action: "approved",
                },
              },
            })
          )
        )
      )

      yield* Effect.promise(() =>
        runTransferReconciliationRepository(
          Effect.flatMap(TransferReconciliationRepository, (repository) =>
            repository.upsertTransferReconciliation({
              principalId: TEST_PRINCIPAL_ID,
              providerTransferId,
              canonicalTransferId: null,
              canonicalTransactionId: null,
              status: "pending",
              matchReason: "rerun_should_not_win",
              confidence: "0.1000",
              deterministic: false,
              reviewMetadata: {},
            })
          )
        )
      )

      const [reconciliation] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select()
              .from(schema.transferReconciliations)
              .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
          })
        )
      )

      expect(reconciliation).toEqual(
        expect.objectContaining({
          providerTransferId,
          canonicalTransferId: receipt.transferId,
          canonicalTransactionId: receipt.transactionId,
          status: "approved",
          matchReason: "admin_locked_match",
          deterministic: true,
        })
      )
    })
  )

  it.live(
    "retries when an eligible reconciliation adds an unlocked source after the snapshot",
    () =>
      Effect.gen(function* () {
        const walletAddress = "bc1qownedwalletreselect000000000000000000000"
        const secondWalletAddress = "bc1qownedwalletreselectsecond0000000000000000"
        const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-13T10:00:00.000Z"))
        const providerAssetRowId = yield* Effect.promise(() =>
          runPg(
            seedApprovedProviderAsset({
              providerAssetId: "btc-provider-asset-reselect",
            })
          )
        )
        yield* Effect.promise(() => runPg(seedOwnedOnchainSource({ walletAddress })))
        yield* Effect.promise(() =>
          runPg(
            seedOwnedOnchainSource({
              walletAddress: secondWalletAddress,
              addressId: SECOND_ONCHAIN_ADDRESS_ID,
              sourceId: SECOND_ONCHAIN_SOURCE_ID,
            })
          )
        )

        const firstProviderTransferId = yield* Effect.promise(() =>
          runPg(
            seedProviderTransfer({
              providerAssetRowId,
              externalId: "provider-transfer-reselect",
              timestamp,
              amount: "0.10000000",
              toAddress: walletAddress,
              networkHash: "btc-reselect-hash",
            })
          )
        )
        const firstReceipt = yield* Effect.promise(() =>
          runPg(
            seedOnchainReceipt({
              externalId: "onchain-receipt-reselect",
              txHash: "btc-reselect-hash",
              timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-13T10:05:00.000Z")),
              amount: "0.10000000",
              walletAddress,
              blockchainId: fixture.bitcoinBlockchainId,
            })
          )
        )
        const secondProviderTransferId = yield* Effect.promise(() =>
          runPg(
            seedProviderTransfer({
              providerAssetRowId,
              externalId: "provider-transfer-reselect-second",
              timestamp,
              amount: "0.20000000",
              toAddress: secondWalletAddress,
              networkHash: "btc-reselect-hash-second",
            })
          )
        )
        const secondReceipt = yield* Effect.promise(() =>
          runPg(
            seedOnchainReceipt({
              externalId: "onchain-receipt-reselect-second",
              txHash: "btc-reselect-hash-second",
              timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-13T10:06:00.000Z")),
              amount: "0.20000000",
              walletAddress: secondWalletAddress,
              blockchainId: fixture.bitcoinBlockchainId,
              addressId: SECOND_ONCHAIN_ADDRESS_ID,
              sourceId: SECOND_ONCHAIN_SOURCE_ID,
            })
          )
        )

        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db.insert(schema.transferReconciliations).values([
                {
                  principalId: TEST_PRINCIPAL_ID,
                  providerTransferId: firstProviderTransferId,
                  canonicalTransferId: firstReceipt.transferId,
                  canonicalTransactionId: firstReceipt.transactionId,
                  status: "approved",
                  matchReason: "admin_approved_fixture",
                  confidence: "1.0000",
                  deterministic: true,
                  reviewMetadata: {},
                },
                {
                  principalId: TEST_PRINCIPAL_ID,
                  providerTransferId: secondProviderTransferId,
                  canonicalTransferId: secondReceipt.transferId,
                  canonicalTransactionId: secondReceipt.transactionId,
                  status: "pending",
                  matchReason: "awaiting_snapshot_race",
                  confidence: "1.0000",
                  deterministic: true,
                  reviewMetadata: {},
                },
              ])
            })
          )
        )

        const firstLockAcquired = yield* Deferred.make<void>()
        const releaseFirstLock = yield* Deferred.make<void>()
        const firstDestinationLock = runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.transaction((tx) =>
              Effect.gen(function* () {
                yield* tx
                  .select({ id: schema.sources.id })
                  .from(schema.sources)
                  .where(eq(schema.sources.id, ONCHAIN_SOURCE_ID))
                  .for("update")
                yield* Deferred.succeed(firstLockAcquired, undefined)
                yield* Deferred.await(releaseFirstLock)
              })
            )
          })
        )
        const secondLockAcquired = yield* Deferred.make<void>()
        const releaseSecondLock = yield* Deferred.make<void>()
        const secondDestinationLock = runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.transaction((tx) =>
              Effect.gen(function* () {
                yield* tx
                  .select({ id: schema.sources.id })
                  .from(schema.sources)
                  .where(eq(schema.sources.id, SECOND_ONCHAIN_SOURCE_ID))
                  .for("update")
                yield* Deferred.succeed(secondLockAcquired, undefined)
                yield* Deferred.await(releaseSecondLock)
              })
            )
          })
        )

        yield* Deferred.await(firstLockAcquired)
        yield* Deferred.await(secondLockAcquired)

        const canonicalization = runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.applyDeterministicInternalTransferCanonicalization({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
            })
          )
        )
        const earlyOutcome = yield* Effect.race(
          Effect.promise(() => canonicalization.then(() => "completed" as const)),
          Effect.sleep("50 millis").pipe(Effect.as("blocked" as const))
        )

        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db
                .update(schema.transferReconciliations)
                .set({ status: "approved" })
                .where(
                  eq(schema.transferReconciliations.providerTransferId, secondProviderTransferId)
                )
            })
          )
        )
        yield* Deferred.succeed(releaseFirstLock, undefined)
        const retryOutcome = yield* Effect.race(
          Effect.promise(() => canonicalization.then(() => "completed" as const)),
          Effect.sleep("100 millis").pipe(Effect.as("blocked" as const))
        )
        yield* Deferred.succeed(releaseSecondLock, undefined)
        const [summary] = yield* Effect.promise(() =>
          Promise.all([canonicalization, firstDestinationLock, secondDestinationLock])
        )

        expect(earlyOutcome).toBe("blocked")
        expect(retryOutcome).toBe("blocked")
        expect(summary).toEqual({ canonicalizedPairs: 2 })
      })
  )

  it.effect("locks the replay source before taking the reconciliation snapshot", () =>
    Effect.gen(function* () {
      const lockAcquired = yield* Deferred.make<void>()
      const releaseLock = yield* Deferred.make<void>()
      const heldSourceLock = runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .select({ id: schema.sources.id })
                .from(schema.sources)
                .where(eq(schema.sources.id, TEST_SOURCE_ID))
                .for("update")
              yield* Deferred.succeed(lockAcquired, undefined)
              yield* Deferred.await(releaseLock)
            })
          )
        })
      )
      yield* Deferred.await(lockAcquired)

      const rollback = runTransferReconciliationRepository(
        Effect.flatMap(TransferReconciliationRepository, (repository) =>
          repository.rollbackReconciliationsForSourceReplay({ sourceId: TEST_SOURCE_ID })
        )
      )
      yield* Effect.promise(() => context.waitForQueryBlockedOnLock({ queryIncludes: "sources" }))
      yield* Deferred.succeed(releaseLock, undefined)
      yield* Effect.promise(() => Promise.all([heldSourceLock, rollback]))
    })
  )

  it.live("holds replay source locks through the shared rollback transaction", () =>
    Effect.gen(function* () {
      const walletAddress = "bc1qownedwalletreplaylockset000000000000000000"
      const providerTimestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-14T09:00:00.000Z"))
      const providerAssetRowId = yield* Effect.promise(() =>
        runPg(seedApprovedProviderAsset({ providerAssetId: "btc-source-replay-lock-set" }))
      )
      yield* Effect.promise(() => runPg(seedOwnedOnchainSource({ walletAddress })))
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          seedProviderTransfer({
            providerAssetRowId,
            externalId: "provider-transfer-source-replay-lock-set",
            timestamp: providerTimestamp,
            amount: "0.12500000",
            toAddress: walletAddress,
            networkHash: "btc-source-replay-lock-set-hash",
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(
          seedCustodyMovement({
            amount: "0.12500000",
            providerTransferId,
            timestamp: providerTimestamp,
          })
        )
      )
      const receipt = yield* Effect.promise(() =>
        runPg(
          seedOnchainReceipt({
            externalId: "onchain-receipt-source-replay-lock-set",
            txHash: "btc-source-replay-lock-set-hash",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-14T09:05:00.000Z")),
            amount: "0.12500000",
            walletAddress,
            blockchainId: fixture.bitcoinBlockchainId,
          })
        )
      )
      const reconciliationId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [reconciliation] = yield* db
              .insert(schema.transferReconciliations)
              .values({
                principalId: TEST_PRINCIPAL_ID,
                providerTransferId,
                canonicalTransferId: receipt.transferId,
                canonicalTransactionId: receipt.transactionId,
                status: "approved",
                matchReason: "admin_approved_fixture",
                confidence: "1.0000",
                deterministic: true,
                reviewMetadata: {},
              })
              .returning({ id: schema.transferReconciliations.id })
            if (reconciliation === undefined) {
              return yield* Effect.die("Failed to create replay lock-set reconciliation")
            }
            return reconciliation.id
          })
        )
      )
      yield* Effect.promise(() =>
        runTransferReconciliation(
          Effect.flatMap(TransferReconciliationService, (service) =>
            service.applyDeterministicInternalTransferCanonicalization({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
              reconciliationId,
            })
          )
        )
      )

      const derivedSourceId = "00000000-0000-0000-0000-000000000791"
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [address] = yield* db
              .insert(schema.addresses)
              .values({
                address: "bc1qreplaylockderived0000000000000000000000",
                type: "bitcoin",
                name: "Replay lock derived source",
                principalId: TEST_PRINCIPAL_ID,
              })
              .returning({ id: schema.addresses.id })
            if (address === undefined) {
              return yield* Effect.die("Failed to create replay lock derived address")
            }
            yield* db.insert(schema.sources).values({
              id: derivedSourceId,
              principalId: TEST_PRINCIPAL_ID,
              name: "Replay lock derived source",
              providerKey: "bitcoin-rpc",
              sourceableType: "onchain",
              cexAccountId: null,
              addressId: address.id,
            })
            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures([
                {
                  movementIdentity: {
                    sourceRecordKey: "source-replay-lock-derived-leg",
                    componentKey: "movement",
                  },
                  sourceId: derivedSourceId,
                  externalId: "source-replay-lock-derived-leg",
                  timestamp: providerTimestamp,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "0.12500000",
                  kind: "acquisition",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  derivationRule: "internal_transfer_in",
                  metadata: { reconciliation: { providerTransferId } },
                },
              ])
            )
          })
        )
      )

      const rollbackFinished = yield* Deferred.make<void>()
      const releaseTransaction = yield* Deferred.make<void>()
      const rollbackTransaction = runReplayTransaction(
        Effect.gen(function* () {
          const repository = yield* TransferReconciliationRepository
          const transaction = yield* SyncEngineTransaction
          yield* transaction.run(
            Effect.gen(function* () {
              yield* repository.rollbackReconciliationsForSourceReplay({
                sourceId: TEST_SOURCE_ID,
              })
              yield* Deferred.succeed(rollbackFinished, undefined)
              yield* Deferred.await(releaseTransaction)
            })
          )
        })
      )
      yield* Deferred.await(rollbackFinished)

      const competingSourceLocks = [TEST_SOURCE_ID, ONCHAIN_SOURCE_ID, derivedSourceId].map(
        (sourceId) =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db.transaction((tx) =>
                tx
                  .select({ id: schema.sources.id })
                  .from(schema.sources)
                  .where(eq(schema.sources.id, sourceId))
                  .for("update")
              )
            })
          )
      )
      yield* Effect.promise(() => context.waitForQueryBlockedOnLock({ queryIncludes: "sources" }))
      let blockedLockCount = 0
      for (let attempt = 0; attempt < 100 && blockedLockCount < 3; attempt += 1) {
        const [row] = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return yield* db.$client<{ readonly count: string }>`
            select count(*)::text as count
            from pg_stat_activity
            where datname = current_database()
              and wait_event_type = 'Lock'
              and query like '%sources%for update%'
          `
            })
          )
        )
        blockedLockCount = Number(row?.count ?? "0")
        if (blockedLockCount < 3) {
          yield* Effect.sleep("10 millis")
        }
      }
      expect(blockedLockCount).toBeGreaterThanOrEqual(3)
      yield* Deferred.succeed(releaseTransaction, undefined)
      yield* Effect.promise(() => Promise.all([rollbackTransaction, ...competingSourceLocks]))
    })
  )
})
