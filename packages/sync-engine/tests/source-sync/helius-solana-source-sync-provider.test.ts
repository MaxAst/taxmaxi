import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "@effect/vitest"
import { HeliusSolanaSourceSyncProviderFromClientLive } from "../../src/providers/helius-solana/layers/HeliusSolanaSourceSyncProviderLive.ts"
import { ActivityClassificationServiceLive } from "../../src/layers/ActivityClassificationServiceLive.ts"
import {
  HELIUS_SOLANA_PROVIDER_KEY,
  HeliusSolanaSourceSyncProvider,
} from "../../src/providers/helius-solana/services/HeliusSolanaSourceSyncProvider.ts"
import {
  HeliusSolanaAssetResolutionService,
  type HeliusSolanaResolvedAsset,
  type HeliusSolanaAssetResolutionServiceShape,
} from "../../src/providers/helius-solana/services/HeliusSolanaAssetResolutionService.ts"
import {
  HeliusSolanaAuthError,
  HeliusSolanaProviderError,
  HeliusSolanaSyncClient,
  type FetchHeliusSolanaTransactionsForAddressParams,
  type HeliusSolanaSyncClientShape,
} from "../../src/providers/helius-solana/services/HeliusSolanaSyncClient.ts"
import {
  ActivityClassificationService,
  ActivityFacts,
} from "../../src/services/ActivityClassificationService.ts"
import { AssetRepository } from "../../src/services/AssetRepository.ts"
import { AssetResolutionJobRepository } from "../../src/services/AssetResolutionJobRepository.ts"
import {
  ProviderAssetRepository,
  type ProviderAssetRepositoryShape,
} from "../../src/services/ProviderAssetRepository.ts"
import type { SourceRawRecord, SourceSyncSource } from "../../src/services/SourceSyncModels.ts"
import { FetchProviderRawBatchParams } from "../../src/shared/SourceProviderRawBatch.ts"

const isPrincipalTransferMetadata = Schema.is(Schema.Struct({ role: Schema.Literal("principal") }))

const WALLET_ADDRESS = "So11111111111111111111111111111111111111112"
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112"
const NATIVE_SOL_PSEUDO_MINT = "So11111111111111111111111111111111111111111"
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const NFT_MINT = "NftMint111111111111111111111111111111111111"
const UNKNOWN_MINT = "UnknownMint11111111111111111111111111111111"
const EXCLUDED_MINT = "ExcludedMint1111111111111111111111111111111"
const STALE_DECIMALS_MINT = "StaleDecimals1111111111111111111111111111111"
const EIGHTEEN_DECIMALS_MINT = "EighteenDecimals11111111111111111111111111111"
const MAX_DECIMALS_MINT = "MaxDecimals111111111111111111111111111111111"
const OMITTED_TYPE_EVIDENCE_MINT = "OmittedType111111111111111111111111111111111"

const makeFetchParams = ({
  providerKey = HELIUS_SOLANA_PROVIDER_KEY,
  walletAddress = WALLET_ADDRESS,
  cursorPayload = null,
  resumeHighWatermark = null,
  resumeCheckpointExternalId = null,
  pageSize = 2,
}: {
  readonly providerKey?: string
  readonly walletAddress?: string | null
  readonly cursorPayload?: unknown
  readonly resumeHighWatermark?: Date | null
  readonly resumeCheckpointExternalId?: string | null
  readonly pageSize?: number
} = {}) =>
  FetchProviderRawBatchParams.make({
    providerKey,
    sourceId: "source-solana-1",
    walletAddress,
    cursorPayload,
    resumeHighWatermark,
    resumeCheckpointExternalId,
    pageSize,
  })

const makeHeliusTransaction = ({
  signature,
  blockTime,
  meta,
}: {
  readonly signature: string
  readonly blockTime: number | null
  readonly meta: unknown
}) => ({
  slot: 1,
  transactionIndex: 0,
  transaction: {
    signatures: [signature],
    message: {
      accountKeys: [WALLET_ADDRESS],
    },
  },
  meta,
  blockTime,
})

const makeSource = (): SourceSyncSource => ({
  id: "source-solana-1",
  principalId: "principal-solana-1",
  providerKey: HELIUS_SOLANA_PROVIDER_KEY,
  cexAccountId: null,
  addressId: "address-solana-1",
  walletAddress: WALLET_ADDRESS,
})

type MakeRawRecordParams =
  | {
      readonly fullTransaction: unknown
      readonly walletTransferEvidence?: ReadonlyArray<unknown>
    }
  | {
      readonly rawRecordPayload: unknown
    }

const makeRawRecord = (params: MakeRawRecordParams): SourceRawRecord => ({
  id: "raw-solana-1",
  sourceId: "source-solana-1",
  provider: HELIUS_SOLANA_PROVIDER_KEY,
  recordType: "solana_transaction_full",
  externalAccountId: WALLET_ADDRESS,
  externalRecordId: "signature-normalized",
  externalParentId: null,
  occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
  payload:
    "rawRecordPayload" in params
      ? params.rawRecordPayload
      : {
          fullTransaction: params.fullTransaction,
          walletTransferEvidence: params.walletTransferEvidence ?? [],
        },
  importedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
  normalizedAt: null,
  normalizationError: null,
  createdAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
  updatedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
})

const makeProviderLayer = ({
  fetchTransactionsForAddress,
  fetchTransfersForAddress = () =>
    Effect.succeed({
      data: [],
      pagination: {
        hasMore: false,
        nextCursor: null,
      },
    }),
  recordProviderAssetSourceUses = () => Effect.succeed(0),
  resolveNativeAsset,
}: {
  readonly fetchTransactionsForAddress: HeliusSolanaSyncClientShape["fetchTransactionsForAddress"]
  readonly fetchTransfersForAddress?: HeliusSolanaSyncClientShape["fetchTransfersForAddress"]
  readonly recordProviderAssetSourceUses?: ProviderAssetRepositoryShape["recordProviderAssetSourceUses"]
  readonly resolveNativeAsset?: HeliusSolanaAssetResolutionServiceShape["resolveAsset"]
}) =>
  HeliusSolanaSourceSyncProviderFromClientLive.pipe(
    Layer.provide(
      Layer.succeed(
        ProviderAssetRepository,
        ProviderAssetRepository.of({
          upsertProviderAssets: () => Effect.succeed(0),
          upsertProviderAssetMappings: () => Effect.succeed(0),
          approveProviderAssetMappingAndRequestReplay: () =>
            Effect.die("approveProviderAssetMappingAndRequestReplay should not be called"),
          excludeProviderAssetMappingAndRequestReplay: () =>
            Effect.die("excludeProviderAssetMappingAndRequestReplay should not be called"),
          lockProviderAssetApprovalSnapshot: () =>
            Effect.die("lockProviderAssetApprovalSnapshot should not be called"),
          recordProviderAssetSourceUses,
          seedProviderAssetMappingsIfMissing: () => Effect.succeed(0),
          findProviderAssetByProviderAssetId: () => Effect.succeed(Option.none()),
          findProviderAssetByNaturalKey: () => Effect.succeed(Option.none()),
          findProviderAssetByCurrencyCode: () => Effect.succeed(Option.none()),
          listProviderAssetObservedRepresentations: () => Effect.succeed([]),
          findProviderAssetReviewById: () => Effect.succeed(Option.none()),
          listProviderAssetReviews: () => Effect.succeed([]),
          findProviderAssetMapping: () => Effect.succeed(Option.none()),
          findCurrentAssetResolutionPolicyEvaluation: () =>
            Effect.die("findCurrentAssetResolutionPolicyEvaluation should not be called"),
          listAssetResolutionDecisions: () =>
            Effect.die("listAssetResolutionDecisions should not be called"),
          listAssetResolutionEvidence: () =>
            Effect.die("listAssetResolutionEvidence should not be called"),
          recordAssetResolutionPolicyEvaluation: () =>
            Effect.die("recordAssetResolutionPolicyEvaluation should not be called"),
        })
      )
    ),
    Layer.provide(
      Layer.succeed(
        AssetResolutionJobRepository,
        AssetResolutionJobRepository.of({
          scheduleUnresolvedResolutionJob: () =>
            Effect.succeed({
              created: false,
              providerAssetRowId: "unused",
              evidenceRevision: 1,
            }),
          claimResolutionJob: () => Effect.die("claimResolutionJob should not be called"),
          listDispatchableResolutionJobs: () =>
            Effect.die("listDispatchableResolutionJobs should not be called"),
          heartbeatResolutionJob: () => Effect.die("heartbeatResolutionJob should not be called"),
          releaseResolutionJobAfterFailure: () =>
            Effect.die("releaseResolutionJobAfterFailure should not be called"),
          finishResolutionJob: () => Effect.die("finishResolutionJob should not be called"),
        })
      )
    ),
    Layer.provide(
      Layer.succeed(
        AssetRepository,
        AssetRepository.of({
          findAssetById: () => Effect.succeed(Option.none()),
          findAssetByCoinGeckoId: () => Effect.succeed(Option.none()),
          findRepresentationById: () => Effect.succeed(Option.none()),
          findNativeRepresentationForBlockchain: () => Effect.succeed(Option.none()),
          findRepresentationByBlockchainAndAddress: () => Effect.succeed(Option.none()),
          listBlockchains: Effect.succeed([{ id: "solana-blockchain-id", name: "solana" }]),
          upsertEconomicAssetRepresentation: () =>
            Effect.die("upsertEconomicAssetRepresentation should not be called"),
          findAssetResolutionCandidatesByDisplay: () => Effect.succeed([]),
          createStandaloneAssetRepresentation: () =>
            Effect.die("createStandaloneAssetRepresentation should not be called"),
          attachRepresentationToExistingAsset: () =>
            Effect.die("attachRepresentationToExistingAsset should not be called"),
          recordRepresentationOwnershipDecision: () =>
            Effect.die("recordRepresentationOwnershipDecision should not be called"),
          findCurrentRepresentationOwnership: () =>
            Effect.die("findCurrentRepresentationOwnership should not be called"),
        })
      )
    ),
    Layer.provide(
      Layer.succeed(
        HeliusSolanaAssetResolutionService,
        HeliusSolanaAssetResolutionService.of({
          ensureDefaultMappings: Effect.succeed({
            providerAssetCatalogCount: 0,
            defaultProviderAssetMappingCount: 0,
          }),
          resolveAsset:
            resolveNativeAsset ??
            (() =>
              Effect.succeed({
                kind: "canonical",
                assetKind: "native",
                representationTypeObserved: true,
                mintAddress: null,
                providerAssetRowId: "provider-asset-sol",
                providerAssetId: null,
                naturalKey: "native:SOL",
                currencyCode: "SOL",
                name: "Solana",
                decimals: 9,
                tokenProgram: null,
                nftHint: false,
                mappingStatus: "approved",
                mappingKind: "asset",
                canonicalAssetId: "asset-sol",
                assetRepresentationId: "representation-sol",
                canonicalFiatCurrency: null,
              } satisfies HeliusSolanaResolvedAsset)),
          resolveAssets: ({ assets }) =>
            assets.some((asset) => asset.mintAddress === NATIVE_SOL_PSEUDO_MINT)
              ? Effect.die("native SOL pseudo-mint must not reach asset resolution")
              : Effect.succeed(
                  assets.flatMap(
                    (asset): ReadonlyArray<HeliusSolanaResolvedAsset> =>
                      asset.mintAddress === null
                        ? []
                        : asset.mintAddress === WRAPPED_SOL_MINT
                          ? [
                              {
                                kind: "canonical",
                                assetKind: "token",
                                representationTypeObserved: true,
                                mintAddress: WRAPPED_SOL_MINT,
                                providerAssetRowId: "provider-asset-wrapped-sol",
                                providerAssetId: WRAPPED_SOL_MINT,
                                naturalKey: `spl:${WRAPPED_SOL_MINT}`,
                                currencyCode: "SOL",
                                name: "Wrapped SOL",
                                decimals: 9,
                                tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                                nftHint: false,
                                mappingStatus: "approved",
                                mappingKind: "asset",
                                canonicalAssetId: "asset-sol",
                                assetRepresentationId: "representation-wrapped-sol",
                                canonicalFiatCurrency: null,
                              } satisfies HeliusSolanaResolvedAsset,
                            ]
                          : asset.mintAddress === NFT_MINT
                            ? [
                                {
                                  kind: "canonical",
                                  assetKind: "nft",
                                  representationTypeObserved: true,
                                  mintAddress: asset.mintAddress,
                                  providerAssetRowId: `provider-asset-${asset.mintAddress}`,
                                  providerAssetId: asset.mintAddress,
                                  naturalKey: `spl:${asset.mintAddress}`,
                                  currencyCode: "TEST-NFT",
                                  name: "Test NFT",
                                  decimals: 0,
                                  tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                                  nftHint: true,
                                  mappingStatus: "approved",
                                  mappingKind: "asset",
                                  canonicalAssetId: "asset-test-nft",
                                  assetRepresentationId: "representation-test-nft-solana",
                                  canonicalFiatCurrency: null,
                                } satisfies HeliusSolanaResolvedAsset,
                              ]
                            : asset.mintAddress === EXCLUDED_MINT
                              ? [
                                  {
                                    kind: "excluded",
                                    assetKind: "token",
                                    representationTypeObserved: true,
                                    mintAddress: asset.mintAddress,
                                    providerAssetRowId: `provider-asset-${asset.mintAddress}`,
                                    providerAssetId: asset.mintAddress,
                                    naturalKey: `spl:${asset.mintAddress}`,
                                    currencyCode: "EXCLUDED",
                                    name: "Excluded token",
                                    decimals: 5,
                                    tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                                    nftHint: false,
                                    mappingStatus: "excluded",
                                    mappingKind: "asset",
                                    canonicalAssetId: null,
                                    assetRepresentationId: null,
                                    canonicalFiatCurrency: null,
                                  } satisfies HeliusSolanaResolvedAsset,
                                ]
                              : asset.mintAddress === UNKNOWN_MINT
                                ? [
                                    {
                                      kind: "review_required",
                                      assetKind: "token",
                                      representationTypeObserved: false,
                                      mintAddress: asset.mintAddress,
                                      providerAssetRowId: `provider-asset-${asset.mintAddress}`,
                                      providerAssetId: asset.mintAddress,
                                      naturalKey: `spl:${asset.mintAddress}`,
                                      currencyCode: asset.mintAddress,
                                      name: null,
                                      decimals: null,
                                      tokenProgram: null,
                                      nftHint: false,
                                      mappingStatus: "pending_review",
                                      mappingKind: "asset",
                                      canonicalAssetId: null,
                                      assetRepresentationId: null,
                                      canonicalFiatCurrency: null,
                                    } satisfies HeliusSolanaResolvedAsset,
                                  ]
                                : [
                                    {
                                      kind: "canonical",
                                      assetKind: "token",
                                      ...(asset.mintAddress === OMITTED_TYPE_EVIDENCE_MINT
                                        ? {}
                                        : { representationTypeObserved: true }),
                                      mintAddress: asset.mintAddress,
                                      providerAssetRowId: `provider-asset-${asset.mintAddress}`,
                                      providerAssetId: asset.mintAddress,
                                      naturalKey: `spl:${asset.mintAddress}`,
                                      currencyCode: "USDC",
                                      name: "USD Coin",
                                      decimals:
                                        asset.mintAddress === STALE_DECIMALS_MINT
                                          ? asset.observedDecimals === 5
                                            ? 2
                                            : 5
                                          : asset.mintAddress === EIGHTEEN_DECIMALS_MINT
                                            ? 18
                                            : asset.mintAddress === MAX_DECIMALS_MINT
                                              ? 255
                                              : 6,
                                      tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                                      nftHint: false,
                                      mappingStatus: "approved",
                                      mappingKind: "asset",
                                      canonicalAssetId: "asset-usdc",
                                      assetRepresentationId: "representation-usdc-solana",
                                      canonicalFiatCurrency: null,
                                    } satisfies HeliusSolanaResolvedAsset,
                                  ]
                  )
                ),
        })
      )
    ),
    Layer.provide(
      Layer.succeed(
        HeliusSolanaSyncClient,
        HeliusSolanaSyncClient.of({
          fetchTransactionsForAddress,
          fetchAssetBatch: () => Effect.die("fetchAssetBatch should not be called"),
          fetchTransfersForAddress,
        })
      )
    )
  )

const runProvider = <A, E>(
  effect: Effect.Effect<A, E, HeliusSolanaSourceSyncProvider>,
  fetchTransactionsForAddress: HeliusSolanaSyncClientShape["fetchTransactionsForAddress"],
  fetchTransfersForAddress?: HeliusSolanaSyncClientShape["fetchTransfersForAddress"]
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        fetchTransfersForAddress === undefined
          ? makeProviderLayer({ fetchTransactionsForAddress })
          : makeProviderLayer({ fetchTransactionsForAddress, fetchTransfersForAddress })
      )
    )
  )

describe("HeliusSolanaSourceSyncProviderLive", () => {
  it.effect("returns provider asset source uses with the prepared record", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const provider = yield* HeliusSolanaSourceSyncProvider
        const lookups = yield* provider.loadNormalizationLookups
        const normalized = yield* provider.prepareNormalization({
          source: makeSource(),
          sourceRecord: makeRawRecord({
            fullTransaction: makeHeliusTransaction({
              signature: "signature-record-source-use",
              blockTime: 1_735_689_600,
              meta: {
                err: null,
                fee: 5_000,
                preBalances: [2_000_000_000],
                postBalances: [1_999_995_000],
                preTokenBalances: [],
                postTokenBalances: [],
              },
            }),
          }),
          lookups,
        })
        return normalized
      }).pipe(
        Effect.provide(
          makeProviderLayer({
            fetchTransactionsForAddress: () =>
              Effect.die("Helius client should not be called during normalization"),
          })
        )
      )

      expect(result.providerTransfers).not.toHaveLength(0)
      expect(result.providerAssetRowIds).toEqual(["provider-asset-sol"])
    })
  )

  it.effect("imports paginated full Solana transactions including failed transactions", () =>
    Effect.gen(function* () {
      const calls: Array<FetchHeliusSolanaTransactionsForAddressParams> = []
      const responses: Array<unknown> = [
        {
          data: [
            makeHeliusTransaction({
              signature: "signature-1",
              blockTime: 1_735_689_600,
              meta: { err: null },
            }),
            makeHeliusTransaction({
              signature: "signature-failed",
              blockTime: 1_735_689_660,
              meta: { err: { InstructionError: [1, "Custom"] } },
            }),
          ],
          paginationToken: "next-page",
        },
        {
          data: [
            makeHeliusTransaction({
              signature: "signature-3",
              blockTime: 1_735_689_720,
              meta: { err: null },
            }),
          ],
          paginationToken: null,
        },
      ]

      const fetchTransactionsForAddress: HeliusSolanaSyncClientShape["fetchTransactionsForAddress"] =
        (params) =>
          Effect.gen(function* () {
            calls.push(params)
            const response = responses.shift()

            if (response === undefined) {
              return yield* Effect.die("Unexpected Helius request")
            }

            return response
          })

      const firstPage = yield* Effect.promise(() =>
        runProvider(
          Effect.flatMap(HeliusSolanaSourceSyncProvider, (provider) =>
            provider.fetchRawBatch(makeFetchParams())
          ),
          fetchTransactionsForAddress
        )
      )
      const secondPage = yield* Effect.promise(() =>
        runProvider(
          Effect.flatMap(HeliusSolanaSourceSyncProvider, (provider) =>
            provider.fetchRawBatch(
              makeFetchParams({
                cursorPayload: firstPage.cursorPayload,
              })
            )
          ),
          fetchTransactionsForAddress
        )
      )

      expect(calls).toHaveLength(2)
      expect(calls[0]).toMatchObject({
        walletAddress: WALLET_ADDRESS,
        config: {
          limit: 2,
          paginationToken: null,
          transactionDetails: "full",
          sortOrder: "desc",
          filters: {
            status: "any",
            tokenAccounts: "balanceChanged",
          },
        },
      })
      expect(calls[1]).toMatchObject({
        config: {
          paginationToken: "next-page",
        },
      })

      expect(firstPage.records.map((record) => record.externalRecordId)).toEqual([
        "signature-1",
        "signature-failed",
      ])
      expect(
        firstPage.records.every((record) => record.recordType === "solana_transaction_full")
      ).toBe(true)
      expect(firstPage.records.every((record) => record.externalAccountId === WALLET_ADDRESS)).toBe(
        true
      )
      expect(firstPage.records[1]?.payload).toMatchObject({
        fullTransaction: {
          meta: { err: { InstructionError: [1, "Custom"] } },
        },
        walletTransferEvidence: [],
      })
      expect(firstPage.cursorPayload).toMatchObject({
        paginationToken: "next-page",
        walletTransferExhausted: true,
      })
      expect(firstPage.done).toBe(false)
      expect(firstPage.highWatermark?.toISOString()).toBe("2025-01-01T00:01:00.000Z")

      expect(secondPage.records.map((record) => record.externalRecordId)).toEqual(["signature-3"])
      expect(secondPage.cursorPayload).toEqual({
        paginationToken: null,
        resumeBoundaryActive: false,
        resumeCheckpointExternalId: null,
        resumeHighWatermarkIso: null,
        walletTransferCursor: null,
        walletTransferExhausted: false,
        pendingWalletTransfers: [],
      })
      expect(secondPage.done).toBe(true)
    })
  )

  it.effect("caches wallet transfer evidence with raw history for later replay", () =>
    Effect.gen(function* () {
      const signature = "signature-cached-wallet-evidence"
      const olderSignature = "signature-cached-wallet-evidence-older"
      const blockTime = 1_735_689_600
      const walletTransferCursors: Array<string | null> = []

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const firstBatch = yield* provider.fetchRawBatch(makeFetchParams({ pageSize: 1 }))
            const secondBatch = yield* provider.fetchRawBatch(
              makeFetchParams({ pageSize: 1, cursorPayload: firstBatch.cursorPayload })
            )
            const firstRawRecord = firstBatch.records[0]
            const secondRawRecord = secondBatch.records[0]
            if (firstRawRecord === undefined || secondRawRecord === undefined) {
              return yield* Effect.die("Expected two cached raw records")
            }

            const lookups = yield* provider.loadNormalizationLookups
            const firstPrepared = yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ rawRecordPayload: firstRawRecord.payload }),
              lookups,
            })
            const secondPrepared = yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ rawRecordPayload: secondRawRecord.payload }),
              lookups,
            })

            return { firstRawRecord, secondRawRecord, firstPrepared, secondPrepared }
          }),
          ({ config }) =>
            Effect.succeed(
              config.paginationToken === null
                ? {
                    data: [
                      makeHeliusTransaction({
                        signature,
                        blockTime,
                        meta: { err: null },
                      }),
                    ],
                    paginationToken: "transaction-page-2",
                  }
                : {
                    data: [
                      makeHeliusTransaction({
                        signature: olderSignature,
                        blockTime: blockTime - 60,
                        meta: { err: null },
                      }),
                    ],
                    paginationToken: null,
                  }
            ),
          ({ cursor }) => {
            walletTransferCursors.push(cursor)
            if (cursor === null) {
              return Effect.succeed({
                data: [
                  {
                    signature,
                    timestamp: blockTime,
                    direction: "in" as const,
                    counterparty: "cached-counterparty",
                    mint: USDC_MINT,
                    symbol: "USDC",
                    amount: 1,
                    amountRaw: "1000000",
                    decimals: 6,
                  },
                  {
                    signature: olderSignature,
                    timestamp: blockTime - 60,
                    direction: "out" as const,
                    counterparty: "older-counterparty",
                    mint: USDC_MINT,
                    symbol: "USDC",
                    amount: 2,
                    amountRaw: "2000000",
                    decimals: 6,
                  },
                  {
                    signature: "still-older-signature",
                    timestamp: blockTime - 120,
                    direction: "in" as const,
                    counterparty: "still-older-counterparty",
                    mint: USDC_MINT,
                    symbol: "USDC",
                    amount: 3,
                    amountRaw: "3000000",
                    decimals: 6,
                  },
                ],
                pagination: { hasMore: true, nextCursor: "wallet-page-2" },
              })
            }
            return Effect.succeed({
              data: [],
              pagination:
                cursor === "wallet-page-2"
                  ? { hasMore: true, nextCursor: "wallet-page-3" }
                  : { hasMore: false, nextCursor: null },
            })
          }
        )
      )

      expect(walletTransferCursors).toEqual([null, "wallet-page-2", "wallet-page-3"])
      expect(result.firstRawRecord.payload).toMatchObject({
        walletTransferEvidence: [
          expect.objectContaining({ signature, amountRaw: "1000000", decimals: 6 }),
        ],
      })
      expect(result.secondRawRecord.payload).toMatchObject({
        walletTransferEvidence: [
          expect.objectContaining({
            signature: olderSignature,
            amountRaw: "2000000",
            decimals: 6,
          }),
        ],
      })
      expect(result.firstPrepared.providerTransfers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            observedMintAddress: USDC_MINT,
            observedDecimals: 6,
          }),
        ])
      )
      expect(result.secondPrepared.providerTransfers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            observedMintAddress: USDC_MINT,
            observedDecimals: 6,
          }),
        ])
      )
    })
  )

  it.effect("rejects a raw batch when its wallet transfer evidence is incomplete", () =>
    Effect.gen(function* () {
      const signature = "signature-raw-batch-incomplete-evidence"
      let walletTransferCalls = 0

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.flatMap(HeliusSolanaSourceSyncProvider, (provider) =>
            provider.fetchRawBatch(makeFetchParams({ pageSize: 1 }))
          ).pipe(Effect.result),
          () =>
            Effect.succeed({
              data: [
                makeHeliusTransaction({
                  signature,
                  blockTime: 1_735_689_600,
                  meta: { err: null },
                }),
              ],
              paginationToken: null,
            }),
          ({ cursor }) => {
            walletTransferCalls += 1
            return cursor === null
              ? Effect.succeed({
                  data: [
                    {
                      signature,
                      timestamp: 1_735_689_600,
                      direction: "in" as const,
                      counterparty: "counterparty-address",
                      mint: USDC_MINT,
                      symbol: "USDC",
                      amount: 1,
                      amountRaw: "1000000",
                      decimals: 6,
                    },
                  ],
                  pagination: { hasMore: true, nextCursor: "failing-wallet-page" },
                })
              : Effect.fail(
                  new HeliusSolanaProviderError({
                    message: "Later wallet transfer page failed",
                    statusCode: 503,
                    retryable: true,
                  })
                )
          }
        )
      )

      expect(walletTransferCalls).toBe(2)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          _tag: "SourceSyncProviderFailureError",
          providerKey: HELIUS_SOLANA_PROVIDER_KEY,
          retryable: true,
        })
      }
    })
  )

  it.effect("continues incremental scans only until the persisted resume boundary", () =>
    Effect.gen(function* () {
      const calls: Array<FetchHeliusSolanaTransactionsForAddressParams> = []
      const resumeHighWatermark = DateTime.toDateUtc(
        DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")
      )
      const responses: Array<unknown> = [
        {
          data: [
            makeHeliusTransaction({
              signature: "signature-newer-1",
              blockTime: 1_735_689_900,
              meta: { err: null },
            }),
            makeHeliusTransaction({
              signature: "signature-newer-2",
              blockTime: 1_735_689_840,
              meta: { err: null },
            }),
          ],
          paginationToken: "resume-page-2",
        },
        {
          data: [
            makeHeliusTransaction({
              signature: "signature-newer-3",
              blockTime: 1_735_689_780,
              meta: { err: null },
            }),
            makeHeliusTransaction({
              signature: "signature-checkpoint",
              blockTime: 1_735_689_600,
              meta: { err: null },
            }),
            makeHeliusTransaction({
              signature: "signature-older",
              blockTime: 1_735_689_540,
              meta: { err: null },
            }),
          ],
          paginationToken: "should-not-be-used",
        },
      ]

      const fetchTransactionsForAddress: HeliusSolanaSyncClientShape["fetchTransactionsForAddress"] =
        (params) =>
          Effect.gen(function* () {
            calls.push(params)
            const response = responses.shift()

            if (response === undefined) {
              return yield* Effect.die("Unexpected Helius request")
            }

            return response
          })

      const firstPage = yield* Effect.promise(() =>
        runProvider(
          Effect.flatMap(HeliusSolanaSourceSyncProvider, (provider) =>
            provider.fetchRawBatch(
              makeFetchParams({
                resumeHighWatermark,
                resumeCheckpointExternalId: "signature-checkpoint",
              })
            )
          ),
          fetchTransactionsForAddress
        )
      )
      const secondPage = yield* Effect.promise(() =>
        runProvider(
          Effect.flatMap(HeliusSolanaSourceSyncProvider, (provider) =>
            provider.fetchRawBatch(
              makeFetchParams({
                cursorPayload: firstPage.cursorPayload,
                resumeHighWatermark: firstPage.highWatermark,
                resumeCheckpointExternalId: "signature-checkpoint",
              })
            )
          ),
          fetchTransactionsForAddress
        )
      )

      expect(calls).toHaveLength(2)
      expect(calls[0]?.config.paginationToken).toBeNull()
      expect(calls[1]?.config.paginationToken).toBe("resume-page-2")
      expect(firstPage.records.map((record) => record.externalRecordId)).toEqual([
        "signature-newer-1",
        "signature-newer-2",
      ])
      expect(firstPage.cursorPayload).toMatchObject({
        paginationToken: "resume-page-2",
        resumeBoundaryActive: true,
        resumeCheckpointExternalId: "signature-checkpoint",
        resumeHighWatermarkIso: "2025-01-01T00:00:00.000Z",
        walletTransferExhausted: true,
      })
      expect(firstPage.done).toBe(false)
      expect(secondPage.records.map((record) => record.externalRecordId)).toEqual([
        "signature-newer-3",
      ])
      expect(secondPage.cursorPayload).toEqual({
        paginationToken: null,
        resumeBoundaryActive: false,
        resumeCheckpointExternalId: null,
        resumeHighWatermarkIso: null,
        walletTransferCursor: null,
        walletTransferExhausted: false,
        pendingWalletTransfers: [],
      })
      expect(secondPage.done).toBe(true)
    })
  )

  it.effect("rejects malformed persisted cursor payloads", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.flatMap(HeliusSolanaSourceSyncProvider, (provider) =>
            provider.fetchRawBatch(
              makeFetchParams({
                cursorPayload: { paginationToken: 42 },
              })
            )
          ).pipe(Effect.result),
          () => Effect.die("Helius client should not be called for malformed cursors")
        )
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          _tag: "SourceSyncCursorDecodeError",
          providerKey: HELIUS_SOLANA_PROVIDER_KEY,
        })
        expect(result.failure.message).toContain("Invalid persisted Helius Solana cursor payload")
      }
    })
  )

  it.effect("rejects incomplete persisted cursor payloads", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.flatMap(HeliusSolanaSourceSyncProvider, (provider) =>
            provider.fetchRawBatch(
              makeFetchParams({
                cursorPayload: { paginationToken: null },
              })
            )
          ).pipe(Effect.result),
          () => Effect.die("Helius client should not be called for incomplete cursors")
        )
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          _tag: "SourceSyncCursorDecodeError",
          providerKey: HELIUS_SOLANA_PROVIDER_KEY,
        })
        expect(result.failure.message).toContain("Invalid persisted Helius Solana cursor payload")
      }
    })
  )

  it.effect("fails non-retryably when a Solana source has no wallet address", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.flatMap(HeliusSolanaSourceSyncProvider, (provider) =>
            provider.fetchRawBatch(makeFetchParams({ walletAddress: null }))
          ).pipe(Effect.result),
          () => Effect.die("Helius client should not be called without a wallet address")
        )
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          _tag: "SourceSyncProviderFailureError",
          providerKey: HELIUS_SOLANA_PROVIDER_KEY,
          retryable: false,
        })
        expect(result.failure.message).toContain("has no wallet address")
      }
    })
  )

  it.effect("keeps unsupported provider-key behavior", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.flatMap(HeliusSolanaSourceSyncProvider, (provider) =>
            provider.fetchRawBatch(makeFetchParams({ providerKey: "coinbase" }))
          ).pipe(Effect.result),
          () => Effect.die("Helius client should not be called for unsupported providers")
        )
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          _tag: "UnsupportedSyncProviderError",
          providerKey: "coinbase",
        })
      }
    })
  )

  it.effect("maps auth failures to non-retryable provider failures", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.flatMap(HeliusSolanaSourceSyncProvider, (provider) =>
            provider.fetchRawBatch(makeFetchParams())
          ).pipe(Effect.result),
          () =>
            Effect.fail(
              new HeliusSolanaAuthError({
                message: "HELIUS_API_KEY is not configured",
              })
            )
        )
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          _tag: "SourceSyncProviderFailureError",
          retryable: false,
        })
        expect(result.failure.message).toBe("HELIUS_API_KEY is not configured")
      }
    })
  )

  it.effect("maps rate-limit and transient failures as retryable", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.flatMap(HeliusSolanaSourceSyncProvider, (provider) =>
            provider.fetchRawBatch(makeFetchParams())
          ).pipe(Effect.result),
          () =>
            Effect.fail(
              new HeliusSolanaProviderError({
                message: "Helius request failed with status 429",
                statusCode: 429,
                retryable: true,
              })
            )
        )
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          _tag: "SourceSyncProviderFailureError",
          retryable: true,
        })
      }
    })
  )

  it.effect("maps malformed transaction payloads to non-retryable decode failures", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.flatMap(HeliusSolanaSourceSyncProvider, (provider) =>
            provider.fetchRawBatch(makeFetchParams())
          ).pipe(Effect.result),
          () =>
            Effect.succeed({
              data: [
                {
                  slot: 1,
                  transactionIndex: 0,
                  transaction: { signatures: [] },
                  meta: null,
                  blockTime: 1_735_689_600,
                },
              ],
              paginationToken: null,
            })
        )
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          _tag: "SourceSyncProviderFailureError",
          retryable: false,
        })
        expect(result.failure.message).toContain("missing signature")
      }
    })
  )

  it.effect("rejects Helius transactions with missing block times", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.flatMap(HeliusSolanaSourceSyncProvider, (provider) =>
            provider.fetchRawBatch(makeFetchParams())
          ).pipe(Effect.result),
          () =>
            Effect.succeed({
              data: [
                makeHeliusTransaction({
                  signature: "signature-null-block-time",
                  blockTime: null,
                  meta: { err: null },
                }),
              ],
              paginationToken: null,
            })
        )
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          _tag: "SourceSyncProviderFailureError",
          providerKey: HELIUS_SOLANA_PROVIDER_KEY,
          retryable: false,
        })
        expect(result.failure.message).toContain("signature-null-block-time")
        expect(result.failure.message).toContain("missing blockTime")
      }
    })
  )

  it.effect(
    "normalizes SOL balance deltas and transaction fees from full transaction metadata",
    () =>
      Effect.gen(function* () {
        const payload = {
          slot: 123,
          transactionIndex: 4,
          transaction: {
            signatures: ["signature-normalized"],
            message: {
              accountKeys: [
                { pubkey: WALLET_ADDRESS, signer: true },
                { pubkey: "counterparty-address", signer: false },
                { pubkey: "wallet-stale-token-account", signer: false },
              ],
              instructions: [{ programId: "11111111111111111111111111111111", program: "system" }],
            },
          },
          meta: {
            err: null,
            fee: 5_000,
            preBalances: [2_000_000_000, 0],
            postBalances: [1_499_995_000, 500_000_000],
          },
          blockTime: 1_735_689_600,
          type: "TRANSFER",
          source: "SYSTEM_PROGRAM",
          description: "Transfer 0.5 SOL",
        }

        const result = yield* Effect.promise(() =>
          runProvider(
            Effect.gen(function* () {
              const provider = yield* HeliusSolanaSourceSyncProvider
              const lookups = yield* provider.loadNormalizationLookups
              return yield* provider.prepareNormalization({
                source: makeSource(),
                sourceRecord: makeRawRecord({ fullTransaction: payload }),
                lookups,
              })
            }),
            () => Effect.die("Helius client should not be called during normalization")
          )
        )

        expect(result.transaction.externalId).toBe("signature-normalized")
        expect(result.transaction.providerStatus).toBe("succeeded")
        expect(result.onchainContext).toMatchObject({
          chainTxId: "signature-normalized",
          blockHeight: "123",
          positionInBlock: "4",
          feeAmount: "5000",
          isError: false,
        })
        expect(result.canonicalTransfers.map((transfer) => transfer.amount)).toEqual([
          "0.5",
          "0.000005",
        ])
        expect(result.canonicalTransfers.map((transfer) => transfer.type)).toEqual([
          "native",
          "fee",
        ])
        expect(result.providerTransfers).toHaveLength(2)
        const principalProviderTransfer = result.providerTransfers.find((transfer) =>
          isPrincipalTransferMetadata(transfer.metadata)
        )
        expect(principalProviderTransfer).toMatchObject({
          observedBlockchainId: "solana-blockchain-id",
          observedRepresentationType: "native",
          observedContractAddress: null,
          observedMintAddress: null,
          observedDecimals: 9,
        })
        expect(result.transactionReview).toBeNull()
      })
  )

  it.effect("derives disposal and fee legs for a fully mapped Solana transfer", () =>
    Effect.gen(function* () {
      const signature = "signature-mapped-sol-transfer"
      const payload = {
        slot: 123,
        transactionIndex: 4,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              { pubkey: "counterparty-address", signer: false },
            ],
            instructions: [{ programId: "11111111111111111111111111111111", program: "system" }],
          },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [2_000_000_000, 0],
          postBalances: [1_499_995_000, 500_000_000],
        },
        blockTime: 1_735_689_600,
        type: "TRANSFER",
        source: "SYSTEM_PROGRAM",
      }

      const { prepared, legs } = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            const prepared = yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload }),
              lookups,
            })
            const legs = yield* provider.deriveLegs({
              transaction: {
                id: "transaction-mapped-sol",
                sourceId: prepared.transaction.sourceId,
                sourceRawRecordId: prepared.transaction.sourceRawRecordId,
                externalId: prepared.transaction.externalId,
                timestamp: prepared.transaction.timestamp,
                providerTransactionType: prepared.transaction.providerTransactionType,
                metadata: prepared.transaction.metadata,
                principalId: prepared.transaction.principalId,
              },
              venueContext: null,
              canonicalTransfers: prepared.canonicalTransfers.map((transfer, index) => ({
                id: `persisted-transfer-${index}`,
                sourceId: transfer.sourceId,
                sourceRawRecordId: transfer.sourceRawRecordId,
                externalId: transfer.externalId,
                txHash: transfer.txHash,
                timestamp: transfer.timestamp,
                addressId: transfer.addressId,
                assetId: transfer.assetId,
                assetRepresentationId: transfer.assetRepresentationId ?? null,
                amount: transfer.amount,
                type: transfer.type,
              })),
              legPlans: prepared.legPlans,
            })
            return { prepared, legs }
          }),
          () => Effect.die("Helius client should not be called during normalization")
        )
      )

      expect(prepared.transactionReview).toBeNull()
      expect(prepared.legDerivationStrategy).toBe("derive")
      expect(prepared.legPlans).toEqual([
        {
          transferExternalId: `${signature}:component:native_balance:${WALLET_ADDRESS}`,
          movementIdentity: {
            _tag: "identified",
            sourceRecordKey: signature,
            componentKey: `native_balance:${WALLET_ADDRESS}`,
          },
          kind: "disposal",
          role: "principal",
          derivationRule: "helius_solana_outbound",
        },
        {
          transferExternalId: `${signature}:component:meta.fee`,
          movementIdentity: {
            _tag: "identified",
            sourceRecordKey: signature,
            componentKey: "meta.fee",
          },
          kind: "fee",
          role: "fee",
          derivationRule: "helius_solana_fee",
        },
      ])
      expect(legs).toHaveLength(2)
      expect(legs[0]).toMatchObject({
        externalId: `${signature}:movement:native_balance:${WALLET_ADDRESS}:leg`,
        kind: "disposal",
        amount: "0.5",
        assetId: "asset-sol",
        assetRepresentationId: "representation-sol",
        provenance: "deterministic",
        derivationRule: "helius_solana_outbound",
        transactionId: "transaction-mapped-sol",
        sourceTransferId: "persisted-transfer-0",
        feeForTransactionId: null,
      })
      expect(legs[1]).toMatchObject({
        externalId: `${signature}:movement:meta.fee:leg`,
        kind: "fee",
        amount: "0.000005",
        assetId: "asset-sol",
        transactionId: "transaction-mapped-sol",
        sourceTransferId: "persisted-transfer-1",
        feeForTransactionId: "transaction-mapped-sol",
      })
    })
  )

  it.effect("derives an acquisition leg for a mapped inbound SPL movement", () =>
    Effect.gen(function* () {
      const signature = "signature-mapped-spl-acquisition"
      const payload = {
        slot: 127,
        transactionIndex: 3,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              { pubkey: "counterparty-address", signer: false },
              { pubkey: "wallet-token-account", signer: false },
            ],
            instructions: [],
          },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [2_000_000_000, 0, 0],
          postBalances: [1_999_995_000, 0, 0],
          preTokenBalances: [
            {
              accountIndex: 2,
              mint: USDC_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "0", decimals: 6 },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 2,
              mint: USDC_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "12500000", decimals: 6 },
            },
          ],
        },
        blockTime: 1_735_689_600,
      }

      const { prepared, legs } = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            const prepared = yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload }),
              lookups,
            })
            const legs = yield* provider.deriveLegs({
              transaction: {
                id: "transaction-mapped-spl",
                sourceId: prepared.transaction.sourceId,
                sourceRawRecordId: prepared.transaction.sourceRawRecordId,
                externalId: prepared.transaction.externalId,
                timestamp: prepared.transaction.timestamp,
                providerTransactionType: prepared.transaction.providerTransactionType,
                metadata: prepared.transaction.metadata,
                principalId: prepared.transaction.principalId,
              },
              venueContext: null,
              canonicalTransfers: prepared.canonicalTransfers.map((transfer, index) => ({
                id: `persisted-transfer-${index}`,
                sourceId: transfer.sourceId,
                sourceRawRecordId: transfer.sourceRawRecordId,
                externalId: transfer.externalId,
                txHash: transfer.txHash,
                timestamp: transfer.timestamp,
                addressId: transfer.addressId,
                assetId: transfer.assetId,
                assetRepresentationId: transfer.assetRepresentationId ?? null,
                amount: transfer.amount,
                type: transfer.type,
              })),
              legPlans: prepared.legPlans,
            })
            return { prepared, legs }
          }),
          () => Effect.die("Helius client should not be called during normalization")
        )
      )

      expect(prepared.legDerivationStrategy).toBe("derive")
      expect(legs).toHaveLength(2)

      const acquisitionLeg = legs.find((leg) => leg.kind === "acquisition")
      expect(acquisitionLeg).toMatchObject({
        assetId: "asset-usdc",
        assetRepresentationId: "representation-usdc-solana",
        amount: "12.5",
        derivationRule: "helius_solana_inbound",
        transactionId: "transaction-mapped-spl",
        feeForTransactionId: null,
      })

      const feeLeg = legs.find((leg) => leg.kind === "fee")
      expect(feeLeg).toMatchObject({
        assetId: "asset-sol",
        amount: "0.000005",
        derivationRule: "helius_solana_fee",
        feeForTransactionId: "transaction-mapped-spl",
      })
    })
  )

  it.effect("does not treat a native SOL wallet row sentinel as wrapped SOL", () =>
    Effect.gen(function* () {
      const signature = "signature-native-sol-wallet-row"
      const walletTransferEvidence = [
        {
          signature,
          timestamp: 1_735_689_600,
          direction: "out",
          counterparty: "counterparty-address",
          mint: WRAPPED_SOL_MINT,
          symbol: "SOL",
          amount: 0.5,
          amountRaw: "500000000",
          decimals: 9,
        },
      ]
      const payload = {
        slot: 123,
        transactionIndex: 4,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              { pubkey: "counterparty-address", signer: false },
            ],
            instructions: [{ programId: "11111111111111111111111111111111", program: "system" }],
          },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [2_000_000_000, 0],
          postBalances: [1_499_995_000, 500_000_000],
        },
        blockTime: 1_735_689_600,
        type: "TRANSFER",
        source: "SYSTEM_PROGRAM",
        description: "Transfer 0.5 SOL",
      }

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload, walletTransferEvidence }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization"),
          () =>
            Effect.succeed({
              data: [
                {
                  signature,
                  timestamp: 1_735_689_600,
                  direction: "out",
                  counterparty: "counterparty-address",
                  mint: WRAPPED_SOL_MINT,
                  symbol: "SOL",
                  amount: 0.5,
                  amountRaw: "500000000",
                  decimals: 9,
                },
              ],
              pagination: {
                hasMore: false,
                nextCursor: null,
              },
            })
        )
      )

      const principalProviderTransfers = result.providerTransfers.filter(
        (transfer) =>
          isPrincipalTransferMetadata(transfer.metadata) &&
          transfer.observedBlockchainId !== null &&
          transfer.observedBlockchainId !== undefined
      )

      expect(principalProviderTransfers).toEqual([
        expect.objectContaining({
          observedRepresentationType: "native",
          observedMintAddress: null,
          observedDecimals: 9,
          amount: "0.5",
        }),
      ])
      expect(result.transaction.metadata).toMatchObject({
        transferEvidenceContradictions: [],
      })
    })
  )

  it.effect("keeps SOL sentinel rows unknown when native balance evidence is absent", () =>
    Effect.gen(function* () {
      const signature = "signature-sol-sentinel-without-native-balance"
      const walletTransferEvidence = [
        {
          signature,
          timestamp: 1_735_689_600,
          direction: "out",
          counterparty: "counterparty-address",
          mint: WRAPPED_SOL_MINT,
          symbol: "SOL",
          amount: 0.5,
          amountRaw: "500000000",
          decimals: 9,
        },
      ]
      const payload = {
        slot: 123,
        transactionIndex: 4,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              { pubkey: "counterparty-address", signer: false },
            ],
            instructions: [],
          },
        },
        meta: {
          err: null,
          fee: 0,
        },
        blockTime: 1_735_689_600,
        type: "TRANSFER",
        source: "SYSTEM_PROGRAM",
      }

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload, walletTransferEvidence }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization")
        )
      )

      expect(result.providerTransfers).toEqual([
        expect.objectContaining({
          providerAssetId: "provider-asset-wrapped-sol",
          observedBlockchainId: null,
          observedRepresentationType: null,
          observedMintAddress: null,
          observedDecimals: null,
          processingMode: "evidence_only",
        }),
      ])
      expect(result.transactionReview?.matchedLayer).toBe("solana_transfer_evidence")
    })
  )

  it.effect("refines native SOL pseudo-mint wallet rows into native movements", () =>
    Effect.gen(function* () {
      const signature = "signature-native-sol-pseudo-mint-rows"
      const walletTransferEvidence = [
        {
          signature,
          timestamp: 1_735_689_600,
          direction: "out",
          counterparty: "counterparty-a",
          mint: NATIVE_SOL_PSEUDO_MINT,
          symbol: "SOL",
          amount: 0.5,
          amountRaw: "500000000",
          decimals: 9,
        },
        {
          signature,
          timestamp: 1_735_689_600,
          direction: "out",
          counterparty: "counterparty-b",
          mint: NATIVE_SOL_PSEUDO_MINT,
          symbol: "SOL",
          amount: 0.25,
          amountRaw: "250000000",
          decimals: 9,
        },
      ]
      const payload = {
        slot: 123,
        transactionIndex: 4,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              { pubkey: "counterparty-a", signer: false },
              { pubkey: "counterparty-b", signer: false },
            ],
            instructions: [{ programId: "11111111111111111111111111111111", program: "system" }],
          },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [2_000_000_000, 0, 0],
          postBalances: [1_249_995_000, 500_000_000, 250_000_000],
        },
        blockTime: 1_735_689_600,
        type: "TRANSFER",
        source: "SYSTEM_PROGRAM",
        description: "Transfer SOL twice",
      }

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload, walletTransferEvidence }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization")
        )
      )

      const principalProviderTransfers = result.providerTransfers.filter(
        (transfer) =>
          isPrincipalTransferMetadata(transfer.metadata) &&
          transfer.observedBlockchainId !== null &&
          transfer.observedBlockchainId !== undefined
      )

      expect(principalProviderTransfers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            toAddress: "counterparty-a",
            amount: "0.5",
            observedRepresentationType: "native",
            observedMintAddress: null,
            observedDecimals: 9,
          }),
          expect.objectContaining({
            toAddress: "counterparty-b",
            amount: "0.25",
            observedRepresentationType: "native",
            observedMintAddress: null,
            observedDecimals: 9,
          }),
        ])
      )
      expect(principalProviderTransfers).toHaveLength(2)
      expect(result.transaction.metadata).toMatchObject({
        transferEvidenceContradictions: [],
      })
    })
  )

  it.effect(
    "keeps unmatched native SOL pseudo-mint rows as review evidence without SPL resolution",
    () =>
      Effect.gen(function* () {
        const signature = "signature-native-sol-pseudo-mint-unmatched"
        const walletTransferEvidence = [
          {
            signature,
            timestamp: 1_735_689_600,
            direction: "in",
            counterparty: "counterparty-address",
            mint: NATIVE_SOL_PSEUDO_MINT,
            symbol: "SOL",
            amount: 0.00203928,
            amountRaw: "2039280",
            decimals: 9,
          },
        ]
        const payload = {
          slot: 123,
          transactionIndex: 4,
          transaction: {
            signatures: [signature],
            message: {
              accountKeys: [
                { pubkey: WALLET_ADDRESS, signer: true },
                { pubkey: "counterparty-address", signer: false },
              ],
              instructions: [],
            },
          },
          meta: {
            err: null,
            fee: 0,
          },
          blockTime: 1_735_689_600,
          type: "TRANSFER",
          source: "SYSTEM_PROGRAM",
        }

        const result = yield* Effect.promise(() =>
          runProvider(
            Effect.gen(function* () {
              const provider = yield* HeliusSolanaSourceSyncProvider
              const lookups = yield* provider.loadNormalizationLookups
              return yield* provider.prepareNormalization({
                source: makeSource(),
                sourceRecord: makeRawRecord({ fullTransaction: payload, walletTransferEvidence }),
                lookups,
              })
            }),
            () => Effect.die("Helius client should not be called during normalization")
          )
        )

        expect(result.providerTransfers).toEqual([])
        expect(result.transactionReview?.matchedLayer).toBe("solana_transfer_evidence")
        expect(result.transaction.metadata).toMatchObject({
          transferEvidenceContradictions: [
            expect.objectContaining({
              reason:
                "Wallet transfer row could not be classified exactly as native SOL or wrapped SOL.",
            }),
          ],
        })
      })
  )

  it.effect("preserves separate native SOL wallet rows that explain one balance delta", () =>
    Effect.gen(function* () {
      const signature = "signature-multiple-native-sol-wallet-rows"
      const walletTransferEvidence = [
        {
          signature,
          timestamp: 1_735_689_600,
          direction: "out",
          counterparty: "counterparty-a",
          mint: WRAPPED_SOL_MINT,
          symbol: "SOL",
          amount: 0.5,
          amountRaw: "500000000",
          decimals: 9,
        },
        {
          signature,
          timestamp: 1_735_689_600,
          direction: "out",
          counterparty: "counterparty-b",
          mint: WRAPPED_SOL_MINT,
          symbol: "SOL",
          amount: 0.25,
          amountRaw: "250000000",
          decimals: 9,
        },
      ]
      const payload = {
        slot: 123,
        transactionIndex: 4,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              { pubkey: "counterparty-a", signer: false },
              { pubkey: "counterparty-b", signer: false },
            ],
            instructions: [{ programId: "11111111111111111111111111111111", program: "system" }],
          },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [2_000_000_000, 0, 0],
          postBalances: [1_249_995_000, 500_000_000, 250_000_000],
        },
        blockTime: 1_735_689_600,
        type: "TRANSFER",
        source: "SYSTEM_PROGRAM",
        description: "Transfer SOL twice",
      }

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload, walletTransferEvidence }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization")
        )
      )

      const principalProviderTransfers = result.providerTransfers.filter(
        (transfer) =>
          isPrincipalTransferMetadata(transfer.metadata) &&
          transfer.observedBlockchainId !== null &&
          transfer.observedBlockchainId !== undefined
      )

      expect(principalProviderTransfers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            toAddress: "counterparty-a",
            amount: "0.5",
            observedRepresentationType: "native",
            observedMintAddress: null,
            observedDecimals: 9,
          }),
          expect.objectContaining({
            toAddress: "counterparty-b",
            amount: "0.25",
            observedRepresentationType: "native",
            observedMintAddress: null,
            observedDecimals: 9,
          }),
        ])
      )
      expect(principalProviderTransfers).toHaveLength(2)
      expect(
        result.providerTransfers.find(
          (transfer) =>
            isPrincipalTransferMetadata(transfer.metadata) &&
            transfer.processingMode !== "evidence_only"
        )
      ).toMatchObject({
        amount: "0.75",
        observedBlockchainId: null,
        observedRepresentationType: null,
        observedMintAddress: null,
        observedDecimals: null,
        processingMode: "accounting_only",
      })
      expect(result.transaction.metadata).toMatchObject({
        transferEvidenceContradictions: [],
      })
    })
  )

  it.effect("bounds native SOL subset matching for twenty distinct wallet rows", () =>
    Effect.gen(function* () {
      const signature = "signature-twenty-native-sol-wallet-rows"
      const amounts = Array.from({ length: 20 }, (_, index) => 2 ** index)
      const principalLamports = amounts.reduce((total, amount) => total + amount, 0)
      const feeLamports = 5_000
      const startingLamports = 2_000_000
      const payload = {
        slot: 123,
        transactionIndex: 4,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              ...amounts.map((_, index) => ({
                pubkey: `counterparty-${index}`,
                signer: false,
              })),
            ],
            instructions: [{ programId: "11111111111111111111111111111111", program: "system" }],
          },
        },
        meta: {
          err: null,
          fee: feeLamports,
          preBalances: [startingLamports, ...amounts.map(() => 0)],
          postBalances: [startingLamports - principalLamports - feeLamports, ...amounts],
        },
        blockTime: 1_735_689_600,
        type: "TRANSFER",
        source: "SYSTEM_PROGRAM",
        description: "Transfer SOL twenty times",
      }
      const walletTransferEvidence = amounts.map((amount, index) => ({
        signature,
        timestamp: 1_735_689_600,
        direction: "out",
        counterparty: `counterparty-${index}`,
        mint: WRAPPED_SOL_MINT,
        symbol: "SOL",
        amount: amount / 1_000_000_000,
        amountRaw: String(amount),
        decimals: 9,
      }))

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload, walletTransferEvidence }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization")
        )
      )

      const observedPrincipalTransfers = result.providerTransfers.filter(
        (transfer) =>
          isPrincipalTransferMetadata(transfer.metadata) &&
          transfer.observedBlockchainId !== null &&
          transfer.observedBlockchainId !== undefined
      )

      expect(observedPrincipalTransfers).toHaveLength(20)
      expect(observedPrincipalTransfers.map((transfer) => transfer.amount)).toEqual(
        amounts.map((amount) => `0.${String(amount).padStart(9, "0")}`)
      )
      expect(result.transaction.metadata).toMatchObject({
        transferEvidenceContradictions: [],
      })

      const ambiguousSignature = "signature-twenty-ambiguous-native-sol-wallet-rows"
      const ambiguousPayload = {
        ...payload,
        transaction: {
          ...payload.transaction,
          signatures: [ambiguousSignature],
        },
        meta: {
          ...payload.meta,
          postBalances: [startingLamports - 998 - feeLamports, ...amounts],
        },
      }
      const ambiguousWalletTransferEvidence = walletTransferEvidence.map((transfer) => ({
        ...transfer,
        signature: ambiguousSignature,
      }))
      const ambiguousResult = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({
                fullTransaction: ambiguousPayload,
                walletTransferEvidence: ambiguousWalletTransferEvidence,
              }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization")
        )
      )
      const ambiguousEvidenceTransfers = ambiguousResult.providerTransfers.filter(
        (transfer) =>
          transfer.providerAssetId === "provider-asset-wrapped-sol" &&
          transfer.observedRepresentationType === null
      )

      expect(ambiguousEvidenceTransfers).toHaveLength(20)
      expect(ambiguousEvidenceTransfers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            observedBlockchainId: null,
            observedMintAddress: null,
            observedDecimals: null,
            processingMode: "evidence_only",
          }),
        ])
      )
      expect(ambiguousResult.transactionReview?.matchedLayer).toBe("solana_transfer_evidence")
    })
  )

  it.effect("preserves bidirectional native SOL rows that explain the net balance delta", () =>
    Effect.gen(function* () {
      const signature = "signature-bidirectional-native-sol-wallet-rows"
      const walletTransferEvidence = [
        {
          signature,
          timestamp: 1_735_689_600,
          direction: "out",
          counterparty: "outbound-counterparty",
          mint: WRAPPED_SOL_MINT,
          symbol: "SOL",
          amount: 1,
          amountRaw: "1000000000",
          decimals: 9,
        },
        {
          signature,
          timestamp: 1_735_689_600,
          direction: "in",
          counterparty: "inbound-counterparty",
          mint: WRAPPED_SOL_MINT,
          symbol: "SOL",
          amount: 0.5,
          amountRaw: "500000000",
          decimals: 9,
        },
      ]
      const payload = {
        slot: 123,
        transactionIndex: 4,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              { pubkey: "outbound-counterparty", signer: false },
              { pubkey: "inbound-counterparty", signer: false },
            ],
            instructions: [{ programId: "11111111111111111111111111111111", program: "system" }],
          },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [2_000_000_000, 0, 500_000_000],
          postBalances: [1_499_995_000, 1_000_000_000, 0],
        },
        blockTime: 1_735_689_600,
        type: "TRANSFER",
        source: "SYSTEM_PROGRAM",
        description: "Send 1 SOL and receive 0.5 SOL",
      }

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload, walletTransferEvidence }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization")
        )
      )

      const principalProviderTransfers = result.providerTransfers.filter(
        (transfer) =>
          isPrincipalTransferMetadata(transfer.metadata) &&
          transfer.observedBlockchainId !== null &&
          transfer.observedBlockchainId !== undefined
      )
      expect(principalProviderTransfers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            direction: "outbound",
            toAddress: "outbound-counterparty",
            amount: "1",
            observedRepresentationType: "native",
            observedMintAddress: null,
          }),
          expect.objectContaining({
            direction: "inbound",
            fromAddress: "inbound-counterparty",
            amount: "0.5",
            observedRepresentationType: "native",
            observedMintAddress: null,
          }),
        ])
      )
      expect(principalProviderTransfers).toHaveLength(2)
    })
  )

  it.effect("does not record Solana fees when the wallet is not the fee payer", () =>
    Effect.gen(function* () {
      const payload = {
        slot: 123,
        transactionIndex: 5,
        transaction: {
          signatures: ["signature-inbound-fee-paid-by-sender"],
          message: {
            accountKeys: [
              { pubkey: "counterparty-address", signer: true },
              { pubkey: WALLET_ADDRESS, signer: false },
            ],
            instructions: [{ programId: "11111111111111111111111111111111", program: "system" }],
          },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [1_000_000_000, 2_000_000_000],
          postBalances: [499_995_000, 2_500_000_000],
        },
        blockTime: 1_735_689_600,
        type: "TRANSFER",
        source: "SYSTEM_PROGRAM",
        description: "Transfer 0.5 SOL",
      }

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization")
        )
      )

      expect(result.canonicalTransfers.map((transfer) => transfer.type)).toEqual(["native"])
      expect(result.canonicalTransfers.map((transfer) => transfer.amount)).toEqual(["0.5"])
      expect(result.providerTransfers).toHaveLength(1)
      expect(result.providerTransfers[0]).toMatchObject({
        fromAddress: "counterparty-address",
        toAddress: WALLET_ADDRESS,
        providerAssetId: "provider-asset-sol",
      })
      expect(result.transactionReview).toBeNull()
    })
  )

  it.effect("uses the first string account key as the Solana fee payer", () =>
    Effect.gen(function* () {
      const payload = {
        slot: 123,
        transactionIndex: 6,
        transaction: {
          signatures: ["signature-string-account-keys"],
          message: {
            accountKeys: ["counterparty-address", WALLET_ADDRESS],
            instructions: [{ programId: "11111111111111111111111111111111", program: "system" }],
          },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [1_000_000_000, 2_000_000_000],
          postBalances: [499_995_000, 2_500_000_000],
        },
        blockTime: 1_735_689_600,
        type: "TRANSFER",
        source: "SYSTEM_PROGRAM",
        description: "Transfer 0.5 SOL",
      }

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization")
        )
      )

      expect(result.canonicalTransfers.map((transfer) => transfer.type)).toEqual(["native"])
      expect(result.canonicalTransfers.map((transfer) => transfer.amount)).toEqual(["0.5"])
      expect(result.providerTransfers).toHaveLength(1)
      const metadata = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ activityFacts: ActivityFacts })
      )(result.transaction.metadata)
      expect(metadata.activityFacts.onchain?.feePayer).toBe("counterparty-address")
      expect(result.transactionReview).toBeNull()
    })
  )

  it.effect("normalizes failed Solana transactions to fee-only data with review state", () =>
    Effect.gen(function* () {
      const payload = {
        slot: 124,
        transactionIndex: 0,
        transaction: {
          signatures: ["signature-failed-normalized"],
          message: {
            accountKeys: [{ pubkey: WALLET_ADDRESS, signer: true }],
            instructions: [],
          },
        },
        meta: {
          err: { InstructionError: [1, "Custom"] },
          fee: 5_000,
          preBalances: [2_000_000_000],
          postBalances: [1_999_995_000],
        },
        blockTime: 1_735_689_600,
      }

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization")
        )
      )

      expect(result.transaction.providerStatus).toBe("failed")
      expect(result.canonicalTransfers.map((transfer) => transfer.type)).toEqual(["fee"])
      expect(result.canonicalTransfers.map((transfer) => transfer.amount)).toEqual(["0.000005"])
      expect(result.onchainContext?.isError).toBe(true)
      expect(result.transactionReview?.matchedLayer).toBe("solana_failed_transaction")
      expect(result.legDerivationStrategy).toBe("skip")
      expect(result.legPlans).toEqual([])
    })
  )

  it.effect(
    "marks successful Solana transactions without deterministic classification for review",
    () =>
      Effect.gen(function* () {
        const payload = {
          slot: 125,
          transactionIndex: 1,
          transaction: {
            signatures: ["signature-unknown-successful"],
            message: {
              accountKeys: [{ pubkey: WALLET_ADDRESS, signer: true }],
              instructions: [{ programId: "unknown-program", program: "unknown" }],
            },
          },
          meta: {
            err: null,
            fee: 0,
            preBalances: [2_000_000_000],
            postBalances: [2_000_000_000],
            preTokenBalances: [],
            postTokenBalances: [],
          },
          blockTime: 1_735_689_600,
          type: "UNKNOWN",
          source: "UNKNOWN_PROGRAM",
          description: "Unknown successful transaction",
        }

        const result = yield* Effect.promise(() =>
          runProvider(
            Effect.gen(function* () {
              const provider = yield* HeliusSolanaSourceSyncProvider
              const lookups = yield* provider.loadNormalizationLookups
              return yield* provider.prepareNormalization({
                source: makeSource(),
                sourceRecord: makeRawRecord({ fullTransaction: payload }),
                lookups,
              })
            }),
            () => Effect.die("Helius client should not be called during normalization")
          )
        )

        expect(result.canonicalTransfers).toHaveLength(0)
        expect(result.providerTransfers).toHaveLength(0)
        expect(result.transactionReview).toMatchObject({
          matchedLayer: "solana_unknown_activity",
          needsReview: true,
        })
      })
  )

  it.effect("prefers parsed SPL token transfer evidence when present", () =>
    Effect.gen(function* () {
      const walletTransferEvidence = [
        {
          signature: "signature-spl-normalized",
          timestamp: 1_735_689_600,
          direction: "in",
          counterparty: "counterparty-address",
          mint: USDC_MINT,
          symbol: "USDC",
          amount: 12.5,
          amountRaw: "12500000",
          decimals: 6,
        },
      ]
      const payload = {
        slot: 125,
        transactionIndex: 1,
        transaction: {
          signatures: ["signature-spl-normalized"],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              { pubkey: "counterparty-address", signer: false },
            ],
            instructions: [],
          },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [2_000_000_000, 0, 0],
          postBalances: [1_999_995_000, 0, 0],
          preTokenBalances: [],
          postTokenBalances: [],
        },
        blockTime: 1_735_689_600,
        tokenTransfers: [
          {
            mint: USDC_MINT,
            tokenAmount: 12.5,
            fromUserAccount: "counterparty-address",
            toUserAccount: WALLET_ADDRESS,
          },
        ],
      }

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload, walletTransferEvidence }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization"),
          () =>
            Effect.succeed({
              data: [
                {
                  signature: "signature-spl-normalized",
                  timestamp: 1_735_689_600,
                  direction: "in",
                  counterparty: "counterparty-address",
                  mint: USDC_MINT,
                  symbol: "USDC",
                  amount: 12.5,
                  amountRaw: "12500000",
                  decimals: 6,
                },
              ],
              pagination: {
                hasMore: false,
                nextCursor: null,
              },
            })
        )
      )

      const splTransfer = result.canonicalTransfers.find(
        (transfer) => transfer.assetId === "asset-usdc"
      )
      expect(splTransfer).toMatchObject({
        amount: "12.5",
        type: "spl",
        fromAddress: "counterparty-address",
        toAddress: WALLET_ADDRESS,
      })
      expect(splTransfer?.metadata).toMatchObject({ evidenceKind: "parsed_transfer" })
      expect(splTransfer?.metadata).toMatchObject({
        supplementalTransferRow: {
          signature: "signature-spl-normalized",
          amountRaw: "12500000",
        },
      })
      expect(result.providerTransfers.map((transfer) => transfer.externalId)).toEqual([
        "signature-spl-normalized:component:meta.fee:provider",
        "signature-spl-normalized:unidentified:parsed_transfer:1:provider",
      ])
      const splProviderTransfer = result.providerTransfers.find(
        (transfer) => transfer.providerAssetId === `provider-asset-${USDC_MINT}`
      )
      expect(splProviderTransfer?.metadata).toMatchObject({
        evidenceKind: "parsed_transfer",
        supplementalTransferRow: {
          signature: "signature-spl-normalized",
          amountRaw: "12500000",
        },
      })
      expect(splProviderTransfer).toMatchObject({
        observedBlockchainId: "solana-blockchain-id",
        observedRepresentationType: "token",
        observedContractAddress: null,
        observedMintAddress: USDC_MINT,
        observedDecimals: 6,
      })
      expect(new Set(result.providerTransfers.map((transfer) => transfer.externalId)).size).toBe(
        result.providerTransfers.length
      )

      const metadata = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ activityFacts: ActivityFacts })
      )(result.transaction.metadata)
      const classification = yield* Effect.gen(function* () {
        const classifier = yield* ActivityClassificationService
        return yield* classifier.classifyActivity({ facts: metadata.activityFacts })
      }).pipe(Effect.provide(ActivityClassificationServiceLive))
      expect(classification.evidence).toEqual(metadata.activityFacts.evidence)
    })
  )

  it.effect(
    "preserves parsed SPL decimal strings without treating catalog decimals as observed",
    () =>
      Effect.gen(function* () {
        const payload = {
          slot: 125,
          transactionIndex: 1,
          transaction: {
            signatures: ["signature-parsed-string-amount"],
            message: {
              accountKeys: [
                { pubkey: WALLET_ADDRESS, signer: true },
                { pubkey: "counterparty-address", signer: false },
              ],
              instructions: [],
            },
          },
          meta: {
            err: null,
            fee: 5_000,
            preBalances: [2_000_000_000, 0],
            postBalances: [1_999_995_000, 0],
            preTokenBalances: [],
            postTokenBalances: [],
          },
          blockTime: 1_735_689_600,
          tokenTransfers: [
            {
              mint: USDC_MINT,
              tokenAmount: "123456789012.123456",
              fromUserAccount: "counterparty-address",
              toUserAccount: WALLET_ADDRESS,
            },
          ],
        }

        const result = yield* Effect.promise(() =>
          runProvider(
            Effect.gen(function* () {
              const provider = yield* HeliusSolanaSourceSyncProvider
              const lookups = yield* provider.loadNormalizationLookups
              return yield* provider.prepareNormalization({
                source: makeSource(),
                sourceRecord: makeRawRecord({ fullTransaction: payload }),
                lookups,
              })
            }),
            () => Effect.die("Helius client should not be called during normalization")
          )
        )

        const splTransfer = result.canonicalTransfers.find(
          (transfer) => transfer.assetId === "asset-usdc"
        )
        expect(splTransfer).toMatchObject({
          amount: "123456789012.123456",
          type: "spl",
        })
        expect(splTransfer?.metadata).toMatchObject({
          evidenceKind: "parsed_transfer",
          rawUnits: "123456789012.123456",
        })

        const providerTransfer = result.providerTransfers.find(
          (transfer) => transfer.providerAssetId === `provider-asset-${USDC_MINT}`
        )
        expect(providerTransfer).toMatchObject({
          amount: "123456789012.123456",
          observedDecimals: null,
          metadata: {
            evidenceKind: "parsed_transfer",
            rawUnits: "123456789012.123456",
          },
        })
      })
  )

  it.effect("enriches reordered parsed SPL movements with exact wallet-row decimals", () =>
    Effect.gen(function* () {
      const walletTransferEvidence = [
        {
          signature: "signature-reordered-transfer-row-evidence",
          timestamp: 1_735_689_600,
          direction: "in",
          counterparty: "counterparty-unknown",
          mint: UNKNOWN_MINT,
          symbol: null,
          amount: 1.23456,
          amountRaw: "123456",
          decimals: 5,
        },
        {
          signature: "signature-reordered-transfer-row-evidence",
          timestamp: 1_735_689_600,
          direction: "in",
          counterparty: "counterparty-usdc",
          mint: USDC_MINT,
          symbol: "USDC",
          amount: 2.5,
          amountRaw: "2500000",
          decimals: 6,
        },
      ]
      const payload = {
        slot: 126,
        transactionIndex: 2,
        transaction: {
          signatures: ["signature-reordered-transfer-row-evidence"],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              { pubkey: "counterparty-usdc", signer: false },
              { pubkey: "counterparty-unknown", signer: false },
            ],
            instructions: [],
          },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [2_000_000_000, 0, 0],
          postBalances: [1_999_995_000, 0, 0],
          preTokenBalances: [],
          postTokenBalances: [],
        },
        blockTime: 1_735_689_600,
        tokenTransfers: [
          {
            mint: USDC_MINT,
            tokenAmount: "2.5",
            fromUserAccount: "counterparty-usdc",
            toUserAccount: WALLET_ADDRESS,
          },
          {
            mint: UNKNOWN_MINT,
            tokenAmount: "1.23456",
            fromUserAccount: "counterparty-unknown",
            toUserAccount: WALLET_ADDRESS,
          },
        ],
      }

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload, walletTransferEvidence }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization"),
          () =>
            Effect.succeed({
              data: [
                {
                  signature: "signature-reordered-transfer-row-evidence",
                  timestamp: 1_735_689_600,
                  direction: "in",
                  counterparty: "counterparty-unknown",
                  mint: UNKNOWN_MINT,
                  symbol: null,
                  amount: 1.23456,
                  amountRaw: "123456",
                  decimals: 5,
                },
                {
                  signature: "signature-reordered-transfer-row-evidence",
                  timestamp: 1_735_689_600,
                  direction: "in",
                  counterparty: "counterparty-usdc",
                  mint: USDC_MINT,
                  symbol: "USDC",
                  amount: 2.5,
                  amountRaw: "2500000",
                  decimals: 6,
                },
              ],
              pagination: {
                hasMore: false,
                nextCursor: null,
              },
            })
        )
      )

      const unknownTransfer = result.providerTransfers.find(
        (transfer) => transfer.providerAssetId === `provider-asset-${UNKNOWN_MINT}`
      )

      expect(unknownTransfer).toMatchObject({
        amount: "1.23456",
        observedRepresentationType: null,
        observedMintAddress: UNKNOWN_MINT,
        observedDecimals: 5,
        metadata: {
          evidenceKind: "parsed_transfer",
          rawUnits: "123456",
          supplementalTransferRow: {
            signature: "signature-reordered-transfer-row-evidence",
            amountRaw: "123456",
            decimals: 5,
          },
        },
      })
      expect(result.transaction.metadata).toMatchObject({
        transferEvidenceContradictions: [],
      })
    })
  )

  it.effect("matches reordered duplicate parsed movements by counterparty", () =>
    Effect.gen(function* () {
      const signature = "signature-reordered-duplicate-transfer-evidence"
      const walletTransferEvidence = [
        {
          signature,
          timestamp: 1_735_689_600,
          direction: "in",
          counterparty: "counterparty-b",
          mint: USDC_MINT,
          symbol: "USDC",
          amount: 1.5,
          amountRaw: "1500000",
          decimals: 6,
        },
        {
          signature,
          timestamp: 1_735_689_600,
          direction: "in",
          counterparty: "counterparty-a",
          mint: USDC_MINT,
          symbol: "USDC",
          amount: 1.5,
          amountRaw: "1500000",
          decimals: 6,
        },
      ]
      const payload = {
        slot: 126,
        transactionIndex: 2,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              { pubkey: "counterparty-a", signer: false },
              { pubkey: "counterparty-b", signer: false },
            ],
            instructions: [],
          },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [2_000_000_000, 0, 0],
          postBalances: [1_999_995_000, 0, 0],
          preTokenBalances: [],
          postTokenBalances: [],
        },
        blockTime: 1_735_689_600,
        tokenTransfers: [
          {
            mint: USDC_MINT,
            tokenAmount: "1.5",
            fromUserAccount: "counterparty-a",
            toUserAccount: WALLET_ADDRESS,
          },
          {
            mint: USDC_MINT,
            tokenAmount: "1.5",
            fromUserAccount: "counterparty-b",
            toUserAccount: WALLET_ADDRESS,
          },
        ],
      }

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload, walletTransferEvidence }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization"),
          () =>
            Effect.succeed({
              data: [
                {
                  signature,
                  timestamp: 1_735_689_600,
                  direction: "in",
                  counterparty: "counterparty-b",
                  mint: USDC_MINT,
                  symbol: "USDC",
                  amount: 1.5,
                  amountRaw: "1500000",
                  decimals: 6,
                },
                {
                  signature,
                  timestamp: 1_735_689_600,
                  direction: "in",
                  counterparty: "counterparty-a",
                  mint: USDC_MINT,
                  symbol: "USDC",
                  amount: 1.5,
                  amountRaw: "1500000",
                  decimals: 6,
                },
              ],
              pagination: {
                hasMore: false,
                nextCursor: null,
              },
            })
        )
      )

      const duplicateTransfers = result.providerTransfers.filter(
        (transfer) => transfer.providerAssetId === `provider-asset-${USDC_MINT}`
      )

      expect(duplicateTransfers).toHaveLength(2)
      expect(duplicateTransfers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fromAddress: "counterparty-a",
            metadata: expect.objectContaining({
              supplementalTransferRow: expect.objectContaining({
                counterparty: "counterparty-a",
              }),
            }),
          }),
          expect.objectContaining({
            fromAddress: "counterparty-b",
            metadata: expect.objectContaining({
              supplementalTransferRow: expect.objectContaining({
                counterparty: "counterparty-b",
              }),
            }),
          }),
        ])
      )
      expect(result.transaction.metadata).toMatchObject({
        transferEvidenceContradictions: [],
      })
    })
  )

  it.effect("preserves opposing parsed SPL transfers that match one net balance delta", () =>
    Effect.gen(function* () {
      const signature = "signature-opposing-spl-transfers"
      const payload = {
        slot: 126,
        transactionIndex: 2,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              { pubkey: "counterparty-a", signer: false },
              { pubkey: "wallet-usdc-account", signer: false },
            ],
            instructions: [],
          },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [2_000_000_000, 0, 0],
          postBalances: [1_999_995_000, 0, 0],
          preTokenBalances: [
            {
              accountIndex: 2,
              mint: USDC_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "5000000", decimals: 6 },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 2,
              mint: USDC_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "10000000", decimals: 6 },
            },
          ],
        },
        blockTime: 1_735_689_600,
        tokenTransfers: [
          {
            mint: USDC_MINT,
            tokenAmount: "10",
            fromUserAccount: "counterparty-a",
            toUserAccount: WALLET_ADDRESS,
          },
          {
            mint: USDC_MINT,
            tokenAmount: "5",
            fromUserAccount: WALLET_ADDRESS,
            toUserAccount: "counterparty-a",
          },
        ],
      }

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization")
        )
      )

      const usdcProviderTransfers = result.providerTransfers.filter(
        (transfer) => transfer.providerAssetId === `provider-asset-${USDC_MINT}`
      )

      expect(usdcProviderTransfers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            direction: "inbound",
            amount: "10",
            observedRepresentationType: "token",
            observedMintAddress: USDC_MINT,
            observedDecimals: 6,
            processingMode: "evidence_only",
          }),
          expect.objectContaining({
            direction: "outbound",
            amount: "5",
            observedRepresentationType: "token",
            observedMintAddress: USDC_MINT,
            observedDecimals: 6,
            processingMode: "evidence_only",
          }),
          expect.objectContaining({
            direction: "inbound",
            amount: "5",
            observedBlockchainId: null,
            observedRepresentationType: null,
            observedMintAddress: null,
            observedDecimals: null,
            processingMode: "accounting_only",
          }),
        ])
      )
      expect(usdcProviderTransfers).toHaveLength(3)
      expect(result.transaction.metadata).toMatchObject({ transferEvidenceContradictions: [] })
    })
  )

  it.effect("preserves same-account SPL transfers when their sum matches the balance delta", () =>
    Effect.gen(function* () {
      const signature = "signature-same-account-multiple-spl-transfers"
      const walletTransferEvidence = [
        {
          signature,
          timestamp: 1_735_689_600,
          direction: "in",
          counterparty: "counterparty-b",
          mint: USDC_MINT,
          symbol: "USDC",
          amount: 0.5,
          amountRaw: "500000",
          decimals: 6,
        },
        {
          signature,
          timestamp: 1_735_689_600,
          direction: "in",
          counterparty: "counterparty-a",
          mint: USDC_MINT,
          symbol: "USDC",
          amount: 1,
          amountRaw: "1000000",
          decimals: 6,
        },
        {
          signature,
          timestamp: 1_735_689_600,
          direction: "in",
          counterparty: "counterparty-c",
          mint: USDC_MINT,
          symbol: "USDC",
          amount: 0.5,
          amountRaw: "500000",
          decimals: 6,
        },
      ]
      const payload = {
        slot: 126,
        transactionIndex: 2,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              { pubkey: "counterparty-a", signer: false },
              { pubkey: "counterparty-b", signer: false },
              { pubkey: "counterparty-c", signer: false },
              { pubkey: "wallet-usdc-account-a", signer: false },
              { pubkey: "wallet-usdc-account-b", signer: false },
            ],
            instructions: [],
          },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [2_000_000_000, 0, 0, 0, 0, 0],
          postBalances: [1_999_995_000, 0, 0, 0, 0, 0],
          preTokenBalances: [
            {
              accountIndex: 4,
              mint: USDC_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "0", decimals: 6 },
            },
            {
              accountIndex: 5,
              mint: USDC_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "0", decimals: 6 },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 4,
              mint: USDC_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "1000000", decimals: 6 },
            },
            {
              accountIndex: 5,
              mint: USDC_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "1000000", decimals: 6 },
            },
          ],
        },
        blockTime: 1_735_689_600,
        tokenTransfers: [
          {
            mint: USDC_MINT,
            tokenAmount: "1",
            fromUserAccount: "counterparty-a",
            toUserAccount: WALLET_ADDRESS,
          },
          {
            mint: USDC_MINT,
            tokenAmount: "0.5",
            fromUserAccount: "counterparty-b",
            toUserAccount: WALLET_ADDRESS,
          },
          {
            mint: USDC_MINT,
            tokenAmount: "0.5",
            fromUserAccount: "counterparty-c",
            toUserAccount: WALLET_ADDRESS,
          },
        ],
      }

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload, walletTransferEvidence }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization"),
          ({ cursor }) =>
            Effect.succeed(
              cursor === null
                ? {
                    data: [
                      {
                        signature,
                        timestamp: 1_735_689_600,
                        direction: "in" as const,
                        counterparty: "counterparty-b",
                        mint: USDC_MINT,
                        symbol: "USDC",
                        amount: 0.5,
                        amountRaw: "500000",
                        decimals: 6,
                      },
                    ],
                    pagination: { hasMore: true, nextCursor: "same-signature-next-page" },
                  }
                : {
                    data: [
                      {
                        signature,
                        timestamp: 1_735_689_600,
                        direction: "in" as const,
                        counterparty: "counterparty-a",
                        mint: USDC_MINT,
                        symbol: "USDC",
                        amount: 1,
                        amountRaw: "1000000",
                        decimals: 6,
                      },
                      {
                        signature,
                        timestamp: 1_735_689_600,
                        direction: "in" as const,
                        counterparty: "counterparty-c",
                        mint: USDC_MINT,
                        symbol: "USDC",
                        amount: 0.5,
                        amountRaw: "500000",
                        decimals: 6,
                      },
                    ],
                    pagination: { hasMore: false, nextCursor: null },
                  }
            )
        )
      )

      const principalProviderTransfers = result.providerTransfers.filter(
        (transfer) =>
          transfer.providerAssetId === `provider-asset-${USDC_MINT}` &&
          transfer.observedBlockchainId !== null &&
          transfer.observedBlockchainId !== undefined
      )

      expect(principalProviderTransfers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fromAddress: "counterparty-a",
            amount: "1",
            observedDecimals: 6,
            metadata: expect.objectContaining({
              supplementalTransferRow: expect.objectContaining({
                counterparty: "counterparty-a",
              }),
            }),
          }),
          expect.objectContaining({
            fromAddress: "counterparty-b",
            amount: "0.5",
            observedDecimals: 6,
            metadata: expect.objectContaining({
              supplementalTransferRow: expect.objectContaining({
                counterparty: "counterparty-b",
              }),
            }),
          }),
          expect.objectContaining({
            fromAddress: "counterparty-c",
            amount: "0.5",
            observedDecimals: 6,
            metadata: expect.objectContaining({
              supplementalTransferRow: expect.objectContaining({
                counterparty: "counterparty-c",
              }),
            }),
          }),
        ])
      )
      expect(principalProviderTransfers).toHaveLength(3)
      expect(
        result.providerTransfers.filter(
          (transfer) =>
            isPrincipalTransferMetadata(transfer.metadata) && transfer.observedBlockchainId === null
        )
      ).toEqual([
        expect.objectContaining({
          amount: "1",
          processingMode: "accounting_only",
        }),
      ])
      expect(result.transaction.metadata).toMatchObject({
        transferEvidenceContradictions: [],
      })
    })
  )

  it.effect("carries token-balance decimals into matching parsed multi-transfer rows", () =>
    Effect.gen(function* () {
      const signature = "signature-parsed-multiple-balance-decimals"
      const payload = {
        slot: 126,
        transactionIndex: 2,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              { pubkey: "counterparty-a", signer: false },
              { pubkey: "counterparty-b", signer: false },
              { pubkey: "wallet-usdc-account", signer: false },
            ],
            instructions: [],
          },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [2_000_000_000, 0, 0, 0],
          postBalances: [1_999_995_000, 0, 0, 0],
          preTokenBalances: [
            {
              accountIndex: 3,
              mint: USDC_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "0", decimals: 6 },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 3,
              mint: USDC_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "2000000", decimals: 6 },
            },
          ],
        },
        blockTime: 1_735_689_600,
        tokenTransfers: [
          {
            mint: USDC_MINT,
            tokenAmount: "1",
            fromUserAccount: "counterparty-a",
            toUserAccount: WALLET_ADDRESS,
          },
          {
            mint: USDC_MINT,
            tokenAmount: "1",
            fromUserAccount: "counterparty-b",
            toUserAccount: WALLET_ADDRESS,
          },
        ],
      }

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization"),
          () => Effect.succeed({ data: [], pagination: { hasMore: false, nextCursor: null } })
        )
      )

      expect(
        result.providerTransfers.filter(
          (transfer) =>
            transfer.providerAssetId === `provider-asset-${USDC_MINT}` &&
            transfer.observedBlockchainId !== null &&
            transfer.observedBlockchainId !== undefined
        )
      ).toEqual([
        expect.objectContaining({ amount: "1", observedDecimals: 6 }),
        expect.objectContaining({ amount: "1", observedDecimals: 6 }),
      ])
      expect(
        result.canonicalTransfers.filter((transfer) => transfer.assetId === "asset-usdc")
      ).toHaveLength(1)
    })
  )

  it.effect.each(["wallet row", "token balance"] as const)(
    "rejects exact %s decimals that conflict with an approved mapping",
    (evidenceKind) =>
      Effect.gen(function* () {
        const walletTransferEvidence =
          evidenceKind === "wallet row"
            ? [
                {
                  signature: "signature-stale-catalog-decimals",
                  timestamp: 1_735_689_600,
                  direction: "in" as const,
                  counterparty: "counterparty-address",
                  mint: STALE_DECIMALS_MINT,
                  symbol: "STALE",
                  amount: 1.23456,
                  amountRaw: "123456",
                  decimals: 5,
                },
              ]
            : []
        const payload = {
          slot: 126,
          transactionIndex: 2,
          transaction: {
            signatures: ["signature-stale-catalog-decimals"],
            message: {
              accountKeys: [
                { pubkey: WALLET_ADDRESS, signer: true },
                { pubkey: "counterparty-address", signer: false },
              ],
              instructions: [],
            },
          },
          meta: {
            err: null,
            fee: 5_000,
            preBalances: [2_000_000_000, 0],
            postBalances: [1_999_995_000, 0],
            preTokenBalances:
              evidenceKind === "token balance"
                ? [
                    {
                      accountIndex: 2,
                      mint: STALE_DECIMALS_MINT,
                      owner: WALLET_ADDRESS,
                      uiTokenAmount: { amount: "0", decimals: 5 },
                    },
                  ]
                : [],
            postTokenBalances:
              evidenceKind === "token balance"
                ? [
                    {
                      accountIndex: 2,
                      mint: STALE_DECIMALS_MINT,
                      owner: WALLET_ADDRESS,
                      uiTokenAmount: { amount: "123456", decimals: 5 },
                    },
                  ]
                : [],
          },
          blockTime: 1_735_689_600,
          tokenTransfers: [
            {
              mint: STALE_DECIMALS_MINT,
              tokenAmount: "1.23456",
              fromUserAccount: "counterparty-address",
              toUserAccount: WALLET_ADDRESS,
            },
          ],
        }

        const result = yield* Effect.promise(() =>
          runProvider(
            Effect.gen(function* () {
              const provider = yield* HeliusSolanaSourceSyncProvider
              const lookups = yield* provider.loadNormalizationLookups
              return yield* provider
                .prepareNormalization({
                  source: makeSource(),
                  sourceRecord: makeRawRecord({
                    fullTransaction: payload,
                    walletTransferEvidence,
                  }),
                  lookups,
                })
                .pipe(Effect.result)
            }),
            () => Effect.die("Helius client should not be called during normalization"),
            () =>
              Effect.succeed({
                data: [
                  {
                    signature: "signature-stale-catalog-decimals",
                    timestamp: 1_735_689_600,
                    direction: "in",
                    counterparty: "counterparty-address",
                    mint: STALE_DECIMALS_MINT,
                    symbol: "STALE",
                    amount: 1.23456,
                    amountRaw: "123456",
                    decimals: 5,
                  },
                ],
                pagination: {
                  hasMore: false,
                  nextCursor: null,
                },
              })
          )
        )

        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure).toMatchObject({
            _tag: "HeliusSolanaNormalizationReferenceError",
            message:
              "Approved Solana asset mapping for USDC conflicts with observed type or decimals evidence.",
          })
        }
      })
  )

  it.effect(
    "uses wallet transfer rows as SPL evidence when full transaction SPL evidence is absent",
    () =>
      Effect.gen(function* () {
        const walletTransferEvidence = [
          {
            signature: "signature-transfer-row-normalized",
            timestamp: 1_735_689_600,
            direction: "in",
            counterparty: "counterparty-address",
            mint: USDC_MINT,
            symbol: "USDC",
            amount: 12.5,
            amountRaw: "12500000",
            decimals: 6,
          },
        ]
        const payload = {
          slot: 126,
          transactionIndex: 2,
          transaction: {
            signatures: ["signature-transfer-row-normalized"],
            message: {
              accountKeys: [
                { pubkey: WALLET_ADDRESS, signer: true },
                { pubkey: "counterparty-address", signer: false },
              ],
              instructions: [],
            },
          },
          meta: {
            err: null,
            fee: 5_000,
            preBalances: [2_000_000_000, 0],
            postBalances: [1_999_995_000, 0],
            preTokenBalances: [],
            postTokenBalances: [],
          },
          blockTime: 1_735_689_600,
        }

        const result = yield* Effect.promise(() =>
          runProvider(
            Effect.gen(function* () {
              const provider = yield* HeliusSolanaSourceSyncProvider
              const lookups = yield* provider.loadNormalizationLookups
              return yield* provider.prepareNormalization({
                source: makeSource(),
                sourceRecord: makeRawRecord({ fullTransaction: payload, walletTransferEvidence }),
                lookups,
              })
            }),
            () => Effect.die("Helius client should not be called during normalization"),
            () =>
              Effect.succeed({
                data: [
                  {
                    signature: "signature-transfer-row-normalized",
                    timestamp: 1_735_689_600,
                    direction: "in",
                    counterparty: "counterparty-address",
                    mint: USDC_MINT,
                    symbol: "USDC",
                    amount: 12.5,
                    amountRaw: "12500000",
                    decimals: 6,
                  },
                ],
                pagination: {
                  hasMore: false,
                  nextCursor: null,
                },
              })
          )
        )

        const splTransfer = result.canonicalTransfers.find(
          (transfer) => transfer.assetId === "asset-usdc"
        )
        expect(splTransfer).toMatchObject({
          amount: "12.5",
          type: "spl",
          fromAddress: "counterparty-address",
          toAddress: WALLET_ADDRESS,
        })
        expect(splTransfer?.metadata).toMatchObject({ evidenceKind: "transfer_row" })
        expect(result.transactionReview).toBeNull()
      })
  )

  it.effect("uses wallet transfer row raw units for exact display amounts", () =>
    Effect.gen(function* () {
      const walletTransferEvidence = [
        {
          signature: "signature-transfer-row-raw-amount",
          timestamp: 1_735_689_600,
          direction: "in",
          counterparty: "counterparty-address",
          mint: EIGHTEEN_DECIMALS_MINT,
          symbol: "USDC",
          amount: 1.2345678901234567,
          amountRaw: "1234567890123456789",
          decimals: 18,
        },
      ]
      const payload = {
        slot: 126,
        transactionIndex: 2,
        transaction: {
          signatures: ["signature-transfer-row-raw-amount"],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              { pubkey: "counterparty-address", signer: false },
            ],
            instructions: [],
          },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [2_000_000_000, 0],
          postBalances: [1_999_995_000, 0],
          preTokenBalances: [],
          postTokenBalances: [],
        },
        blockTime: 1_735_689_600,
      }

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload, walletTransferEvidence }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization"),
          () =>
            Effect.succeed({
              data: [
                {
                  signature: "signature-transfer-row-raw-amount",
                  timestamp: 1_735_689_600,
                  direction: "in",
                  counterparty: "counterparty-address",
                  mint: EIGHTEEN_DECIMALS_MINT,
                  symbol: "USDC",
                  amount: 1.2345678901234567,
                  amountRaw: "1234567890123456789",
                  decimals: 18,
                },
              ],
              pagination: {
                hasMore: false,
                nextCursor: null,
              },
            })
        )
      )

      const splTransfer = result.canonicalTransfers.find(
        (transfer) => transfer.assetId === "asset-usdc"
      )
      expect(splTransfer).toMatchObject({
        amount: "1.234567890123456789",
        type: "spl",
      })
      expect(splTransfer?.metadata).toMatchObject({
        evidenceKind: "transfer_row",
        rawUnits: "1234567890123456789",
      })
    })
  )

  it.effect("normalizes wrapped SOL token balance movements with their token representation", () =>
    Effect.gen(function* () {
      const payload = {
        slot: 126,
        transactionIndex: 2,
        transaction: {
          signatures: ["signature-wrapped-sol-balance"],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              { pubkey: "native-counterparty", signer: false },
              { pubkey: "wrapped-counterparty-a", signer: false },
              { pubkey: "wrapped-counterparty-b", signer: false },
              { pubkey: "wallet-wsol-account", signer: false },
            ],
            instructions: [],
          },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [2_000_000_000, 0, 0],
          postBalances: [1_999_995_000, 0, 0],
          preTokenBalances: [
            {
              accountIndex: 2,
              mint: WRAPPED_SOL_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "0", decimals: 9 },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 2,
              mint: WRAPPED_SOL_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "1250000000", decimals: 9 },
            },
          ],
        },
        blockTime: 1_735_689_600,
      }

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization")
        )
      )

      const wrappedSolTransfer = result.canonicalTransfers.find(
        (transfer) =>
          transfer.assetId === "asset-sol" && transfer.type === "spl" && transfer.amount === "1.25"
      )
      expect(wrappedSolTransfer).toMatchObject({
        amount: "1.25",
        type: "spl",
        assetId: "asset-sol",
        assetRepresentationId: "representation-wrapped-sol",
      })
      expect(wrappedSolTransfer?.metadata).toMatchObject({
        evidenceKind: "token_balance_delta",
        rawUnits: "1250000000",
        mintAddress: WRAPPED_SOL_MINT,
      })

      const providerTransfer = result.providerTransfers.find(
        (transfer) => transfer.providerAssetId === "provider-asset-wrapped-sol"
      )
      expect(providerTransfer).toMatchObject({
        observedRepresentationType: "token",
        observedMintAddress: WRAPPED_SOL_MINT,
        observedDecimals: 9,
      })
    })
  )

  it.effect("keeps native and wrapped SOL facts separate in one outbound transaction", () =>
    Effect.gen(function* () {
      const signature = "signature-native-and-wrapped-sol"
      const walletTransferEvidence = [
        {
          signature,
          timestamp: 1_735_689_600,
          direction: "out",
          counterparty: "native-counterparty",
          mint: WRAPPED_SOL_MINT,
          symbol: "SOL",
          amount: 0.5,
          amountRaw: "500000000",
          decimals: 9,
        },
        {
          signature,
          timestamp: 1_735_689_600,
          direction: "out",
          counterparty: "wrapped-counterparty-a",
          mint: WRAPPED_SOL_MINT,
          symbol: "SOL",
          amount: 0.1,
          amountRaw: "100000000",
          decimals: 9,
        },
        {
          signature,
          timestamp: 1_735_689_600,
          direction: "out",
          counterparty: "wrapped-counterparty-b",
          mint: WRAPPED_SOL_MINT,
          symbol: "SOL",
          amount: 0.15,
          amountRaw: "150000000",
          decimals: 9,
        },
      ]
      const payload = {
        slot: 126,
        transactionIndex: 2,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              { pubkey: "counterparty-address", signer: false },
              { pubkey: "wallet-wsol-account", signer: false },
            ],
            instructions: [],
          },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [2_000_000_000, 0, 0, 0, 0],
          postBalances: [1_499_995_000, 500_000_000, 0, 0, 0],
          preTokenBalances: [
            {
              accountIndex: 4,
              mint: WRAPPED_SOL_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "250000000", decimals: 9 },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 4,
              mint: WRAPPED_SOL_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "0", decimals: 9 },
            },
          ],
        },
        blockTime: 1_735_689_600,
      }

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload, walletTransferEvidence }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization"),
          () =>
            Effect.succeed({
              data: [
                {
                  signature,
                  timestamp: 1_735_689_600,
                  direction: "out",
                  counterparty: "native-counterparty",
                  mint: WRAPPED_SOL_MINT,
                  symbol: "SOL",
                  amount: 0.5,
                  amountRaw: "500000000",
                  decimals: 9,
                },
                {
                  signature,
                  timestamp: 1_735_689_600,
                  direction: "out",
                  counterparty: "wrapped-counterparty-a",
                  mint: WRAPPED_SOL_MINT,
                  symbol: "SOL",
                  amount: 0.1,
                  amountRaw: "100000000",
                  decimals: 9,
                },
                {
                  signature,
                  timestamp: 1_735_689_600,
                  direction: "out",
                  counterparty: "wrapped-counterparty-b",
                  mint: WRAPPED_SOL_MINT,
                  symbol: "SOL",
                  amount: 0.15,
                  amountRaw: "150000000",
                  decimals: 9,
                },
              ],
              pagination: {
                hasMore: false,
                nextCursor: null,
              },
            })
        )
      )

      const principalProviderTransfers = result.providerTransfers.filter(
        (transfer) =>
          isPrincipalTransferMetadata(transfer.metadata) &&
          transfer.observedBlockchainId !== null &&
          transfer.observedBlockchainId !== undefined
      )

      expect(principalProviderTransfers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            amount: "0.5",
            toAddress: "native-counterparty",
            observedRepresentationType: "native",
            observedMintAddress: null,
            observedDecimals: 9,
          }),
          expect.objectContaining({
            amount: "0.1",
            toAddress: "wrapped-counterparty-a",
            observedRepresentationType: "token",
            observedMintAddress: WRAPPED_SOL_MINT,
            observedDecimals: 9,
          }),
          expect.objectContaining({
            amount: "0.15",
            toAddress: "wrapped-counterparty-b",
            observedRepresentationType: "token",
            observedMintAddress: WRAPPED_SOL_MINT,
            observedDecimals: 9,
          }),
        ])
      )
      expect(principalProviderTransfers).toHaveLength(3)
      expect(result.transaction.metadata).toMatchObject({
        transferEvidenceContradictions: [],
      })
    })
  )

  it.effect("uses a wrapped SOL balance delta to classify matching wallet rows", () =>
    Effect.gen(function* () {
      const signature = "signature-wrapped-sol-row-from-balance"
      const walletTransferEvidence = [
        {
          signature,
          timestamp: 1_735_689_600,
          direction: "out",
          counterparty: "wrapped-counterparty",
          mint: WRAPPED_SOL_MINT,
          symbol: "SOL",
          amount: 0.25,
          amountRaw: "250000000",
          decimals: 9,
        },
      ]
      const payload = {
        slot: 126,
        transactionIndex: 2,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              { pubkey: "wrapped-counterparty", signer: false },
              { pubkey: "wallet-wsol-account", signer: false },
            ],
            instructions: [],
          },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [2_000_000_000, 0, 0],
          postBalances: [1_999_995_000, 0, 0],
          preTokenBalances: [
            {
              accountIndex: 2,
              mint: WRAPPED_SOL_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "1000000000", decimals: 9 },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 2,
              mint: WRAPPED_SOL_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "750000000", decimals: 9 },
            },
          ],
        },
        blockTime: 1_735_689_600,
      }

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload, walletTransferEvidence }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization"),
          () =>
            Effect.succeed({
              data: [
                {
                  signature,
                  timestamp: 1_735_689_600,
                  direction: "out",
                  counterparty: "wrapped-counterparty",
                  mint: WRAPPED_SOL_MINT,
                  symbol: "SOL",
                  amount: 0.25,
                  amountRaw: "250000000",
                  decimals: 9,
                },
              ],
              pagination: { hasMore: false, nextCursor: null },
            })
        )
      )

      expect(
        result.providerTransfers.find(
          (transfer) => transfer.providerAssetId === "provider-asset-wrapped-sol"
        )
      ).toMatchObject({
        amount: "0.25",
        toAddress: "wrapped-counterparty",
        observedRepresentationType: "token",
        observedMintAddress: WRAPPED_SOL_MINT,
        observedDecimals: 9,
        processingMode: "accounting_and_evidence",
        metadata: expect.objectContaining({
          supplementalTransferRow: expect.objectContaining({
            counterparty: "wrapped-counterparty",
          }),
        }),
      })
      expect(result.transaction.metadata).toMatchObject({ transferEvidenceContradictions: [] })
      expect(result.transactionReview).toBeNull()
    })
  )

  it.effect("keeps an explicit zero-net wrapped SOL round trip as token evidence", () =>
    Effect.gen(function* () {
      const signature = "signature-zero-net-wrapped-sol"
      const walletTransferEvidence = [
        {
          signature,
          timestamp: 1_735_689_600,
          direction: "out",
          counterparty: "counterparty-a",
          mint: WRAPPED_SOL_MINT,
          symbol: "SOL",
          amount: 0.25,
          amountRaw: "250000000",
          decimals: 9,
        },
        {
          signature,
          timestamp: 1_735_689_600,
          direction: "in",
          counterparty: "counterparty-b",
          mint: WRAPPED_SOL_MINT,
          symbol: "SOL",
          amount: 0.25,
          amountRaw: "250000000",
          decimals: 9,
        },
      ]
      const payload = {
        slot: 126,
        transactionIndex: 3,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              { pubkey: "counterparty-a", signer: false },
              { pubkey: "counterparty-b", signer: false },
              { pubkey: "wallet-wsol-account", signer: false },
            ],
            instructions: [],
          },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [2_000_000_000, 0, 0, 0],
          postBalances: [1_999_995_000, 0, 0, 0],
          preTokenBalances: [
            {
              accountIndex: 3,
              mint: WRAPPED_SOL_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "250000000", decimals: 9 },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 3,
              mint: WRAPPED_SOL_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "250000000", decimals: 9 },
            },
          ],
        },
        blockTime: 1_735_689_600,
        tokenTransfers: [
          {
            mint: WRAPPED_SOL_MINT,
            tokenAmount: "0.25",
            fromUserAccount: WALLET_ADDRESS,
            toUserAccount: "counterparty-a",
          },
          {
            mint: WRAPPED_SOL_MINT,
            tokenAmount: "0.25",
            fromUserAccount: "counterparty-b",
            toUserAccount: WALLET_ADDRESS,
          },
        ],
      }

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload, walletTransferEvidence }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization"),
          () =>
            Effect.succeed({
              data: [
                {
                  signature,
                  timestamp: 1_735_689_600,
                  direction: "out",
                  counterparty: "counterparty-a",
                  mint: WRAPPED_SOL_MINT,
                  symbol: "SOL",
                  amount: 0.25,
                  amountRaw: "250000000",
                  decimals: 9,
                },
                {
                  signature,
                  timestamp: 1_735_689_600,
                  direction: "in",
                  counterparty: "counterparty-b",
                  mint: WRAPPED_SOL_MINT,
                  symbol: "SOL",
                  amount: 0.25,
                  amountRaw: "250000000",
                  decimals: 9,
                },
              ],
              pagination: { hasMore: false, nextCursor: null },
            })
        )
      )

      const principalProviderTransfers = result.providerTransfers.filter(
        (transfer) =>
          isPrincipalTransferMetadata(transfer.metadata) &&
          transfer.observedBlockchainId !== null &&
          transfer.observedBlockchainId !== undefined
      )
      expect(principalProviderTransfers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            direction: "outbound",
            observedRepresentationType: "token",
            observedMintAddress: WRAPPED_SOL_MINT,
            observedDecimals: 9,
          }),
          expect.objectContaining({
            direction: "inbound",
            observedRepresentationType: "token",
            observedMintAddress: WRAPPED_SOL_MINT,
            observedDecimals: 9,
          }),
        ])
      )
      expect(principalProviderTransfers).toHaveLength(2)
    })
  )

  it.effect("falls back to token balance deltas for SPL movements", () =>
    Effect.gen(function* () {
      const payload = {
        slot: 127,
        transactionIndex: 3,
        transaction: {
          signatures: ["signature-token-balance-normalized"],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              { pubkey: "counterparty-address", signer: false },
              { pubkey: "wallet-token-account", signer: false },
            ],
            instructions: [],
          },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [2_000_000_000, 0, 0],
          postBalances: [1_999_995_000, 0, 0],
          preTokenBalances: [
            {
              accountIndex: 2,
              mint: USDC_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "0", decimals: 6 },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 2,
              mint: USDC_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "12500000", decimals: 6 },
            },
          ],
        },
        blockTime: 1_735_689_600,
      }

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization")
        )
      )

      const splTransfer = result.canonicalTransfers.find(
        (transfer) => transfer.assetId === "asset-usdc"
      )
      expect(splTransfer).toMatchObject({ amount: "12.5", type: "spl" })
      expect(splTransfer?.metadata).toMatchObject({ evidenceKind: "token_balance_delta" })
    })
  )

  it.effect("uses unique transfer evidence to replace a guessed token-balance counterparty", () =>
    Effect.gen(function* () {
      const signature = "signature-token-balance-exact-counterparty"
      const tokenProgramAddress = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
      const exactCounterparty = "exact-counterparty-address"
      const payload = {
        slot: 127,
        transactionIndex: 4,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              { pubkey: tokenProgramAddress, signer: false },
              { pubkey: exactCounterparty, signer: false },
              { pubkey: "wallet-token-account", signer: false },
            ],
            instructions: [],
          },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [2_000_000_000, 0, 0, 0],
          postBalances: [1_999_995_000, 0, 0, 0],
          preTokenBalances: [
            {
              accountIndex: 3,
              mint: USDC_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "0", decimals: 6 },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 3,
              mint: USDC_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "12500000", decimals: 6 },
            },
          ],
        },
        blockTime: 1_735_689_600,
      }
      const walletTransferEvidence = [
        {
          signature,
          timestamp: 1_735_689_600,
          direction: "in" as const,
          counterparty: exactCounterparty,
          mint: USDC_MINT,
          symbol: "USDC",
          amount: 12.5,
          amountRaw: "12500000",
          decimals: 6,
        },
      ]

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload, walletTransferEvidence }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization")
        )
      )

      const usdcProviderTransfers = result.providerTransfers.filter(
        (transfer) => transfer.providerAssetId === `provider-asset-${USDC_MINT}`
      )
      expect(usdcProviderTransfers).toEqual([
        expect.objectContaining({
          direction: "inbound",
          fromAddress: exactCounterparty,
          toAddress: WALLET_ADDRESS,
          processingMode: "accounting_and_evidence",
          observedMintAddress: USDC_MINT,
          observedDecimals: 6,
          metadata: expect.objectContaining({
            supplementalTransferRow: expect.objectContaining({ counterparty: exactCounterparty }),
          }),
        }),
      ])
    })
  )

  it.effect("preserves an unknown SPL type while recording its exact mint and decimals", () =>
    Effect.gen(function* () {
      const payload = {
        slot: 128,
        transactionIndex: 4,
        transaction: {
          signatures: ["signature-unknown-token-balance"],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              { pubkey: "counterparty-address", signer: false },
              { pubkey: "wallet-unknown-token-account", signer: false },
            ],
            instructions: [],
          },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [2_000_000_000, 0, 0],
          postBalances: [1_999_995_000, 0, 0],
          preTokenBalances: [
            {
              accountIndex: 2,
              mint: UNKNOWN_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "0", decimals: 5 },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 2,
              mint: UNKNOWN_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "123456", decimals: 5 },
            },
          ],
        },
        blockTime: 1_735_689_600,
      }

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization")
        )
      )

      const providerTransfer = result.providerTransfers.find(
        (transfer) => transfer.providerAssetId === `provider-asset-${UNKNOWN_MINT}`
      )

      expect(providerTransfer).toMatchObject({
        amount: "1.23456",
        observedBlockchainId: "solana-blockchain-id",
        observedRepresentationType: null,
        observedContractAddress: null,
        observedMintAddress: UNKNOWN_MINT,
        observedDecimals: 5,
      })
      expect(result.legDerivationStrategy).toBe("skip")
      expect(result.legPlans).toEqual([])
    })
  )

  it.effect(
    "keeps excluded SPL movements as evidence without creating accounting or review work",
    () =>
      Effect.gen(function* () {
        const payload = {
          slot: 129,
          transactionIndex: 4,
          transaction: {
            signatures: ["signature-excluded-token-balance"],
            message: {
              accountKeys: [
                { pubkey: WALLET_ADDRESS, signer: true },
                { pubkey: "counterparty-address", signer: false },
                { pubkey: "wallet-excluded-token-account", signer: false },
              ],
              instructions: [],
            },
          },
          meta: {
            err: null,
            fee: 0,
            preBalances: [2_000_000_000, 0, 0],
            postBalances: [2_000_000_000, 0, 0],
            preTokenBalances: [
              {
                accountIndex: 2,
                mint: EXCLUDED_MINT,
                owner: WALLET_ADDRESS,
                uiTokenAmount: { amount: "0", decimals: 5 },
              },
            ],
            postTokenBalances: [
              {
                accountIndex: 2,
                mint: EXCLUDED_MINT,
                owner: WALLET_ADDRESS,
                uiTokenAmount: { amount: "123456", decimals: 5 },
              },
            ],
          },
          blockTime: 1_735_689_600,
        }

        const result = yield* Effect.promise(() =>
          runProvider(
            Effect.gen(function* () {
              const provider = yield* HeliusSolanaSourceSyncProvider
              const lookups = yield* provider.loadNormalizationLookups
              return yield* provider.prepareNormalization({
                source: makeSource(),
                sourceRecord: makeRawRecord({ fullTransaction: payload }),
                lookups,
              })
            }),
            () => Effect.die("Helius client should not be called during normalization")
          )
        )

        expect(result.canonicalTransfers).toEqual([])
        expect(result.transactionReview).toBeNull()
        expect(result.providerTransfers).toEqual([
          expect.objectContaining({
            providerAssetId: `provider-asset-${EXCLUDED_MINT}`,
            processingMode: "evidence_only",
            observedMintAddress: EXCLUDED_MINT,
            observedDecimals: 5,
            amount: "1.23456",
          }),
        ])
        expect(result.legDerivationStrategy).toBe("skip")
        expect(result.legPlans).toEqual([])
      })
  )

  it.effect("keeps approved SPL accounting when native SOL is excluded", () =>
    Effect.gen(function* () {
      const payload = {
        slot: 129,
        transactionIndex: 5,
        transaction: {
          signatures: ["signature-excluded-native-sol"],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              { pubkey: "counterparty-address", signer: false },
              { pubkey: "wallet-usdc-account", signer: false },
            ],
            instructions: [],
          },
        },
        meta: {
          err: null,
          fee: 0,
          preBalances: [1_000_000_000, 1_000_000_000, 0],
          postBalances: [2_000_000_000, 0, 0],
          preTokenBalances: [
            {
              accountIndex: 2,
              mint: USDC_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "0", decimals: 6 },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 2,
              mint: USDC_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "12500000", decimals: 6 },
            },
          ],
        },
        blockTime: 1_735_689_600,
      }

      const result = yield* Effect.gen(function* () {
        const provider = yield* HeliusSolanaSourceSyncProvider
        const lookups = yield* provider.loadNormalizationLookups
        return yield* provider.prepareNormalization({
          source: makeSource(),
          sourceRecord: makeRawRecord({ fullTransaction: payload }),
          lookups,
        })
      }).pipe(
        Effect.provide(
          makeProviderLayer({
            fetchTransactionsForAddress: () =>
              Effect.die("Helius client should not be called during normalization"),
            resolveNativeAsset: () =>
              Effect.succeed({
                kind: "excluded",
                assetKind: "native",
                representationTypeObserved: true,
                mintAddress: null,
                providerAssetRowId: "provider-asset-sol",
                providerAssetId: null,
                naturalKey: "native:SOL",
                currencyCode: "SOL",
                name: "Solana",
                decimals: 9,
                tokenProgram: null,
                nftHint: false,
                mappingStatus: "excluded",
                mappingKind: "asset",
                canonicalAssetId: null,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
              }),
          })
        )
      )

      expect(result.canonicalTransfers).toEqual([
        expect.objectContaining({ assetId: "asset-usdc", amount: "12.5", type: "spl" }),
      ])
      expect(result.providerTransfers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            providerAssetId: "provider-asset-sol",
            processingMode: "evidence_only",
          }),
        ])
      )
      expect(result.legDerivationStrategy).not.toBe("skip")
      expect(result.legPlans).not.toEqual([])
    })
  )

  it.effect("ignores excluded SPL contradictions while deriving valid accounting legs", () =>
    Effect.gen(function* () {
      const signature = "signature-excluded-contradiction"
      const walletTransferEvidence = [
        {
          signature,
          timestamp: 1_735_689_600,
          direction: "in",
          counterparty: "counterparty-address",
          mint: USDC_MINT,
          symbol: "USDC",
          amount: 12.5,
          amountRaw: "12500000",
          decimals: 6,
        },
        {
          signature,
          timestamp: 1_735_689_600,
          direction: "in",
          counterparty: "counterparty-address",
          mint: EXCLUDED_MINT,
          symbol: "EXCLUDED",
          amount: 6.54321,
          amountRaw: "654321",
          decimals: 5,
        },
      ]
      const payload = {
        slot: 129,
        transactionIndex: 5,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              { pubkey: "counterparty-address", signer: false },
              { pubkey: "wallet-usdc-token-account", signer: false },
              { pubkey: "wallet-excluded-token-account", signer: false },
            ],
            instructions: [],
          },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [2_000_000_000, 0, 0, 0],
          postBalances: [1_999_995_000, 0, 0, 0],
          preTokenBalances: [
            {
              accountIndex: 2,
              mint: USDC_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "0", decimals: 6 },
            },
            {
              accountIndex: 3,
              mint: EXCLUDED_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "0", decimals: 5 },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 2,
              mint: USDC_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "12500000", decimals: 6 },
            },
            {
              accountIndex: 3,
              mint: EXCLUDED_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "123456", decimals: 5 },
            },
          ],
        },
        blockTime: 1_735_689_600,
      }

      const prepared = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload, walletTransferEvidence }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization")
        )
      )

      expect(prepared.transactionReview).toBeNull()
      expect(prepared.legDerivationStrategy).toBe("derive")
      expect(prepared.legPlans).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "acquisition",
            derivationRule: "helius_solana_inbound",
          }),
        ])
      )
      expect(
        prepared.providerTransfers.filter(
          (transfer) => transfer.providerAssetId === `provider-asset-${EXCLUDED_MINT}`
        )
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ processingMode: "evidence_only" })])
      )
    })
  )

  it.effect("records separate SPL token and NFT facts in a multi-transfer transaction", () =>
    Effect.gen(function* () {
      const payload = {
        slot: 129,
        transactionIndex: 5,
        transaction: {
          signatures: ["signature-multi-asset-token-balances"],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              { pubkey: "counterparty-address", signer: false },
              { pubkey: "wallet-usdc-account", signer: false },
              { pubkey: "wallet-nft-account", signer: false },
            ],
            instructions: [],
          },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [2_000_000_000, 0, 0, 0],
          postBalances: [1_999_995_000, 0, 0, 0],
          preTokenBalances: [
            {
              accountIndex: 2,
              mint: USDC_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "0", decimals: 6 },
            },
            {
              accountIndex: 3,
              mint: NFT_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "0", decimals: 0 },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 2,
              mint: USDC_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "2500000", decimals: 6 },
            },
            {
              accountIndex: 3,
              mint: NFT_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "1", decimals: 0 },
            },
          ],
        },
        blockTime: 1_735_689_600,
      }

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization")
        )
      )

      const principalTransfers = result.providerTransfers.filter(
        (transfer) =>
          transfer.providerAssetId === `provider-asset-${USDC_MINT}` ||
          transfer.providerAssetId === `provider-asset-${NFT_MINT}`
      )

      expect(principalTransfers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            observedRepresentationType: "token",
            observedMintAddress: USDC_MINT,
            observedDecimals: 6,
          }),
          expect.objectContaining({
            observedRepresentationType: "nft",
            observedMintAddress: NFT_MINT,
            observedDecimals: 0,
          }),
        ])
      )
      expect(principalTransfers).toHaveLength(2)
    })
  )

  it.effect("does not persist a fallback type when resolver evidence is omitted", () =>
    Effect.gen(function* () {
      const payload = {
        slot: 128,
        transactionIndex: 4,
        transaction: {
          signatures: ["signature-omitted-type-evidence"],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              { pubkey: "counterparty-address", signer: false },
              { pubkey: "wallet-omitted-type-account", signer: false },
            ],
            instructions: [],
          },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [2_000_000_000, 0, 0],
          postBalances: [1_999_995_000, 0, 0],
          preTokenBalances: [
            {
              accountIndex: 2,
              mint: OMITTED_TYPE_EVIDENCE_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "0", decimals: 6 },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 2,
              mint: OMITTED_TYPE_EVIDENCE_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "1250000", decimals: 6 },
            },
          ],
        },
        blockTime: 1_735_689_600,
      }

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization")
        )
      )

      expect(
        result.providerTransfers.find(
          (transfer) => transfer.providerAssetId === `provider-asset-${OMITTED_TYPE_EVIDENCE_MINT}`
        )
      ).toMatchObject({
        amount: "1.25",
        observedBlockchainId: "solana-blockchain-id",
        observedRepresentationType: null,
        observedMintAddress: OMITTED_TYPE_EVIDENCE_MINT,
        observedDecimals: 6,
      })
    })
  )

  it.effect("prefers exact token balance deltas over parsed SPL token summaries", () =>
    Effect.gen(function* () {
      const payload = {
        slot: 127,
        transactionIndex: 3,
        transaction: {
          signatures: ["signature-token-balance-over-parsed"],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              { pubkey: "counterparty-address", signer: false },
              { pubkey: "wallet-token-account", signer: false },
            ],
            instructions: [],
          },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [2_000_000_000, 0, 0],
          postBalances: [1_999_995_000, 0, 0],
          preTokenBalances: [
            {
              accountIndex: 2,
              mint: EIGHTEEN_DECIMALS_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "0", decimals: 18 },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 2,
              mint: EIGHTEEN_DECIMALS_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "1234567890123456789", decimals: 18 },
            },
          ],
        },
        blockTime: 1_735_689_600,
        tokenTransfers: [
          {
            mint: EIGHTEEN_DECIMALS_MINT,
            tokenAmount: 1.2345678901234567,
            fromUserAccount: "counterparty-address",
            toUserAccount: WALLET_ADDRESS,
          },
        ],
      }

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization")
        )
      )

      const splTransfer = result.canonicalTransfers.find(
        (transfer) => transfer.assetId === "asset-usdc"
      )
      expect(splTransfer).toMatchObject({
        amount: "1.234567890123456789",
        type: "spl",
      })
      expect(splTransfer?.metadata).toMatchObject({
        evidenceKind: "token_balance_delta",
        rawUnits: "1234567890123456789",
      })
    })
  )

  it.effect(
    "marks contradictory transfer-row evidence for review without overriding full transaction evidence",
    () =>
      Effect.gen(function* () {
        const walletTransferEvidence = [
          {
            signature: "signature-contradictory-transfer-row",
            timestamp: 1_735_689_600,
            direction: "in",
            counterparty: "counterparty-address",
            mint: USDC_MINT,
            symbol: "USDC",
            amount: 12.5,
            amountRaw: "1250",
            decimals: 2,
          },
        ]
        const payload = {
          slot: 128,
          transactionIndex: 4,
          transaction: {
            signatures: ["signature-contradictory-transfer-row"],
            message: {
              accountKeys: [
                { pubkey: WALLET_ADDRESS, signer: true },
                { pubkey: "counterparty-address", signer: false },
                { pubkey: "wallet-token-account", signer: false },
              ],
              instructions: [],
            },
          },
          meta: {
            err: null,
            fee: 5_000,
            preBalances: [2_000_000_000, 0, 0],
            postBalances: [1_999_995_000, 0, 0],
            preTokenBalances: [
              {
                accountIndex: 2,
                mint: USDC_MINT,
                owner: WALLET_ADDRESS,
                uiTokenAmount: { amount: "0", decimals: 6 },
              },
            ],
            postTokenBalances: [
              {
                accountIndex: 2,
                mint: USDC_MINT,
                owner: WALLET_ADDRESS,
                uiTokenAmount: { amount: "12500000", decimals: 6 },
              },
            ],
          },
          blockTime: 1_735_689_600,
        }

        const result = yield* Effect.promise(() =>
          runProvider(
            Effect.gen(function* () {
              const provider = yield* HeliusSolanaSourceSyncProvider
              const lookups = yield* provider.loadNormalizationLookups
              return yield* provider.prepareNormalization({
                source: makeSource(),
                sourceRecord: makeRawRecord({ fullTransaction: payload, walletTransferEvidence }),
                lookups,
              })
            }),
            () => Effect.die("Helius client should not be called during normalization"),
            () =>
              Effect.succeed({
                data: [
                  {
                    signature: "signature-contradictory-transfer-row",
                    timestamp: 1_735_689_600,
                    direction: "in",
                    counterparty: "counterparty-address",
                    mint: USDC_MINT,
                    symbol: "USDC",
                    amount: 12.5,
                    amountRaw: "1250",
                    decimals: 2,
                  },
                ],
                pagination: {
                  hasMore: false,
                  nextCursor: null,
                },
              })
          )
        )

        const splTransfer = result.canonicalTransfers.find(
          (transfer) => transfer.assetId === "asset-usdc"
        )
        expect(splTransfer).toMatchObject({ amount: "12.5", type: "spl" })
        expect(splTransfer?.metadata).toMatchObject({ evidenceKind: "token_balance_delta" })
        const providerTransfers = result.providerTransfers.filter(
          (transfer) => transfer.providerAssetId === `provider-asset-${USDC_MINT}`
        )
        expect(providerTransfers).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              amount: "12.5",
              observedDecimals: 6,
              processingMode: "accounting_and_evidence",
            }),
            expect.objectContaining({
              amount: "12.5",
              observedRepresentationType: "token",
              observedMintAddress: USDC_MINT,
              observedDecimals: 2,
              processingMode: "evidence_only",
            }),
          ])
        )
        expect(providerTransfers).toHaveLength(2)
        expect(result.transactionReview?.matchedLayer).toBe("solana_transfer_evidence")
      })
  )

  it.effect("represents token account close rent refunds without inventing SPL value", () =>
    Effect.gen(function* () {
      const payload = {
        slot: 129,
        transactionIndex: 5,
        transaction: {
          signatures: ["signature-close-account-rent-refund"],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              { pubkey: "closed-token-account", signer: false },
            ],
            instructions: [
              {
                program: "spl-token",
                programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                parsed: { type: "closeAccount" },
              },
            ],
          },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [2_000_000_000, 2_039_280],
          postBalances: [2_002_034_280, 0],
          preTokenBalances: [
            {
              accountIndex: 1,
              mint: USDC_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "0", decimals: 6 },
            },
          ],
          postTokenBalances: [],
        },
        blockTime: 1_735_689_600,
      }

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization"),
          () =>
            Effect.succeed({
              data: [
                {
                  signature: "signature-close-account-rent-refund",
                  timestamp: 1_735_689_600,
                  direction: "in" as const,
                  counterparty: "closed-token-account",
                  mint: WRAPPED_SOL_MINT,
                  symbol: "SOL",
                  amount: 0.00203928,
                  amountRaw: "2039280",
                  decimals: 9,
                },
              ],
              pagination: { hasMore: false, nextCursor: null },
            })
        )
      )

      const rentTransfer = result.canonicalTransfers.find((transfer) => transfer.notes !== null)
      const splTransfers = result.canonicalTransfers.filter((transfer) => transfer.type === "spl")
      expect(rentTransfer).toMatchObject({
        amount: "0.00203928",
        type: "native",
        notes: "Solana account close or rent refund balance effect",
      })
      expect(rentTransfer?.metadata).toMatchObject({ role: "rent" })
      expect(splTransfers).toHaveLength(0)
      expect(result.providerTransfers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            externalId: `signature-close-account-rent-refund:component:native_balance:${WALLET_ADDRESS}:provider`,
            observedRepresentationType: "native",
            observedDecimals: 9,
            processingMode: "accounting_and_evidence",
            metadata: expect.objectContaining({
              role: "rent",
            }),
          }),
        ])
      )
      expect(
        result.providerTransfers.filter(
          (transfer) =>
            isPrincipalTransferMetadata(transfer.metadata) &&
            transfer.processingMode === "evidence_only"
        )
      ).toEqual([])
    })
  )

  it.effect("detects token account close rent refunds from inner instructions", () =>
    Effect.gen(function* () {
      const payload = {
        slot: 129,
        transactionIndex: 5,
        transaction: {
          signatures: ["signature-inner-close-account-rent-refund"],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              { pubkey: "closed-token-account", signer: false },
            ],
            instructions: [
              {
                program: "defi-program",
                programId: "defi-program-id",
                parsed: { type: "swap" },
              },
            ],
          },
        },
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [2_000_000_000, 2_039_280],
          postBalances: [2_002_034_280, 0],
          preTokenBalances: [
            {
              accountIndex: 1,
              mint: USDC_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "0", decimals: 6 },
            },
          ],
          postTokenBalances: [],
          innerInstructions: [
            {
              index: 0,
              instructions: [
                {
                  program: "spl-token",
                  programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                  parsed: { type: "closeAccount" },
                },
              ],
            },
          ],
        },
        blockTime: 1_735_689_600,
      }

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization")
        )
      )

      const rentTransfer = result.canonicalTransfers.find((transfer) => transfer.notes !== null)
      expect(rentTransfer).toMatchObject({
        amount: "0.00203928",
        type: "native",
        notes: "Solana account close or rent refund balance effect",
      })
      expect(rentTransfer?.metadata).toMatchObject({ role: "rent" })
    })
  )

  it.effect.each([-1, 1.5, 256])(
    "returns a recoverable decode failure for invalid token decimals %s",
    (decimals) =>
      Effect.gen(function* () {
        const payload = {
          slot: 130,
          transactionIndex: 1,
          transaction: {
            signatures: ["signature-invalid-token-decimals"],
            message: {
              accountKeys: [
                { pubkey: WALLET_ADDRESS, signer: true },
                { pubkey: "wallet-token-account", signer: false },
              ],
              instructions: [],
            },
          },
          meta: {
            err: null,
            fee: 5_000,
            preBalances: [2_000_000_000, 0],
            postBalances: [1_999_995_000, 0],
            preTokenBalances: [
              {
                accountIndex: 1,
                mint: USDC_MINT,
                owner: WALLET_ADDRESS,
                uiTokenAmount: { amount: "0", decimals },
              },
            ],
            postTokenBalances: [],
          },
          blockTime: 1_735_689_600,
        }

        const result = yield* Effect.promise(() =>
          runProvider(
            Effect.gen(function* () {
              const provider = yield* HeliusSolanaSourceSyncProvider
              const lookups = yield* provider.loadNormalizationLookups
              return yield* provider
                .prepareNormalization({
                  source: makeSource(),
                  sourceRecord: makeRawRecord({ fullTransaction: payload }),
                  lookups,
                })
                .pipe(Effect.result)
            }),
            () => Effect.die("Helius client should not be called during normalization")
          )
        )

        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure._tag).toBe("HeliusSolanaNormalizationDecodeError")
        }
      })
  )

  it.effect.each(["not-an-integer", "-1", "+1", "00"])(
    "returns a typed decode failure for noncanonical wallet raw units %s",
    (amountRaw) =>
      Effect.gen(function* () {
        const signature = "signature-invalid-wallet-raw-units"
        const payload = {
          slot: 130,
          transactionIndex: 1,
          transaction: {
            signatures: [signature],
            message: {
              accountKeys: [{ pubkey: WALLET_ADDRESS, signer: true }],
              instructions: [],
            },
          },
          meta: {
            err: null,
            fee: 0,
            preBalances: [2_000_000_000],
            postBalances: [2_000_000_000],
          },
          blockTime: 1_735_689_600,
        }

        const result = yield* Effect.promise(() =>
          runProvider(
            Effect.gen(function* () {
              const provider = yield* HeliusSolanaSourceSyncProvider
              const lookups = yield* provider.loadNormalizationLookups
              return yield* provider
                .prepareNormalization({
                  source: makeSource(),
                  sourceRecord: makeRawRecord({
                    fullTransaction: payload,
                    walletTransferEvidence: [
                      {
                        signature,
                        timestamp: 1_735_689_600,
                        direction: "in",
                        counterparty: "counterparty-address",
                        mint: USDC_MINT,
                        symbol: "USDC",
                        amount: 1,
                        amountRaw,
                        decimals: 6,
                      },
                    ],
                  }),
                  lookups,
                })
                .pipe(Effect.result)
            }),
            () => Effect.die("Helius client should not be called during normalization")
          )
        )

        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure._tag).toBe("HeliusSolanaNormalizationDecodeError")
        }
      })
  )

  it.effect("rejects conflicting pre and post token decimals", () =>
    Effect.gen(function* () {
      const payload = {
        slot: 130,
        transactionIndex: 1,
        transaction: {
          signatures: ["signature-conflicting-token-decimals"],
          message: {
            accountKeys: [
              { pubkey: WALLET_ADDRESS, signer: true },
              { pubkey: "wallet-token-account", signer: false },
            ],
            instructions: [],
          },
        },
        meta: {
          err: null,
          fee: 0,
          preBalances: [2_000_000_000, 0],
          postBalances: [2_000_000_000, 0],
          preTokenBalances: [
            {
              accountIndex: 1,
              mint: USDC_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "1000000", decimals: 6 },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 1,
              mint: USDC_MINT,
              owner: WALLET_ADDRESS,
              uiTokenAmount: { amount: "1000000", decimals: 9 },
            },
          ],
        },
        blockTime: 1_735_689_600,
      }

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider
              .prepareNormalization({
                source: makeSource(),
                sourceRecord: makeRawRecord({ fullTransaction: payload }),
                lookups,
              })
              .pipe(Effect.result)
          }),
          () => Effect.die("Helius client should not be called during normalization")
        )
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          _tag: "HeliusSolanaNormalizationDecodeError",
          message: "Conflicting Solana token decimals were observed for the same balance.",
        })
      }
    })
  )

  it.effect("preserves the accepted Solana decimals ceiling exactly", () =>
    Effect.gen(function* () {
      const signature = "signature-max-token-decimals"
      const expectedAmount = `0.${"0".repeat(254)}1`
      const walletTransferEvidence = [
        {
          signature,
          timestamp: 1_735_689_600,
          direction: "in",
          counterparty: "counterparty-address",
          mint: MAX_DECIMALS_MINT,
          symbol: "USDC",
          amount: 1e-255,
          amountRaw: "1",
          decimals: 255,
        },
      ]
      const payload = {
        slot: 130,
        transactionIndex: 1,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: [{ pubkey: WALLET_ADDRESS, signer: true }],
            instructions: [],
          },
        },
        meta: {
          err: null,
          fee: 0,
          preBalances: [2_000_000_000],
          postBalances: [2_000_000_000],
        },
        blockTime: 1_735_689_600,
      }

      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider.prepareNormalization({
              source: makeSource(),
              sourceRecord: makeRawRecord({ fullTransaction: payload, walletTransferEvidence }),
              lookups,
            })
          }),
          () => Effect.die("Helius client should not be called during normalization"),
          () =>
            Effect.succeed({
              data: [
                {
                  signature,
                  timestamp: 1_735_689_600,
                  direction: "in" as const,
                  counterparty: "counterparty-address",
                  mint: MAX_DECIMALS_MINT,
                  symbol: "USDC",
                  amount: 1e-255,
                  amountRaw: "1",
                  decimals: 255,
                },
              ],
              pagination: { hasMore: false, nextCursor: null },
            })
        )
      )

      expect(result.providerTransfers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            amount: expectedAmount,
            observedMintAddress: MAX_DECIMALS_MINT,
            observedDecimals: 255,
          }),
        ])
      )
    })
  )

  it.effect("returns a recoverable decode failure for malformed cached Solana payloads", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider
              .prepareNormalization({
                source: makeSource(),
                sourceRecord: makeRawRecord({ fullTransaction: { malformed: true } }),
                lookups,
              })
              .pipe(Effect.result)
          }),
          () => Effect.die("Helius client should not be called during normalization")
        )
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("HeliusSolanaNormalizationDecodeError")
      }
    })
  )

  it.effect("rejects the old plain full-transaction raw record shape", () =>
    Effect.gen(function* () {
      const fullTransaction = makeHeliusTransaction({
        signature: "signature-old-raw-shape",
        blockTime: 1_735_689_600,
        meta: { err: null },
      })
      const result = yield* Effect.promise(() =>
        runProvider(
          Effect.gen(function* () {
            const provider = yield* HeliusSolanaSourceSyncProvider
            const lookups = yield* provider.loadNormalizationLookups
            return yield* provider
              .prepareNormalization({
                source: makeSource(),
                sourceRecord: makeRawRecord({ rawRecordPayload: fullTransaction }),
                lookups,
              })
              .pipe(Effect.result)
          }),
          () => Effect.die("Helius client should not be called during normalization"),
          () => Effect.die("Helius client should not be called during normalization")
        )
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("HeliusSolanaNormalizationDecodeError")
      }
    })
  )
})
