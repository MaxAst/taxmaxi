import { JurisdictionCode, TaxYear, type MovementCorrectionInput } from "@my/core/accounting"
import { AuthUserId } from "@my/core/authentication"
import { CurrencyCode } from "@my/core/currency"
import { PrincipalId } from "@my/core/ownership"
import * as BigDecimal from "effect/BigDecimal"
import * as Option from "effect/Option"
import { CalculationRunServiceLive } from "../../../persistence/src/layers/CalculationRunServiceLive.ts"
import { CalculationRunRepositoryLive } from "../../../persistence/src/layers/CalculationRunRepositoryLive.ts"
import { FactualLedgerRepositoryLive } from "../../../persistence/src/layers/FactualLedgerRepositoryLive.ts"
import { PrincipalTransactionOverrideRepositoryLive } from "../../../persistence/src/layers/PrincipalTransactionOverrideRepositoryLive.ts"
import { CalculationRunService } from "../../../persistence/src/services/CalculationRunService.ts"
import { CalculationRunId } from "../../../persistence/src/services/CalculationRunRepository.ts"
import { FactualLedgerRepository } from "../../../persistence/src/services/FactualLedgerRepository.ts"
import { PrincipalTransactionOverrideRepository } from "../../../persistence/src/services/PrincipalTransactionOverrideRepository.ts"
import * as DateTime from "effect/DateTime"
import { SourceNormalizationRepository, SourceReplayRepository } from "@my/sync-engine/services"
import { SourceNormalizationRepositoryLive } from "../../../persistence/src/layers/SourceNormalizationRepositoryLive.ts"
import { SourceReplayRepositoryLive } from "../../../persistence/src/layers/SourceReplayRepositoryLive.ts"
import { seedSyncEngineRepositoryFixture } from "../../../persistence/tests/support/integration-test-kit.ts"
import { HeliusSolanaSourceSyncProviderFromClientAndAssetResolutionLive } from "../../src/providers/helius-solana/layers/HeliusSolanaSourceSyncProviderLive.ts"
import { HeliusSolanaSourceSyncProvider } from "../../src/providers/helius-solana/services/HeliusSolanaSourceSyncProvider.ts"
import { SOLANA_USDC_MINT, SOLANA_USDT_MINT, SOLANA_WRAPPED_NATIVE_MINT } from "@my/core/assets"
import { and, eq, inArray, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { AssetRepositoryLive } from "../../../persistence/src/layers/AssetRepositoryLive.ts"
import { AssetResolutionJobRepositoryLive } from "../../../persistence/src/layers/AssetResolutionJobRepositoryLive.ts"
import { ProviderAssetRepositoryLive } from "../../../persistence/src/layers/ProviderAssetRepositoryLive.ts"
import { drizzle } from "../../../persistence/src/layers/PgClientLive.ts"
import { schema } from "../../../persistence/src/schema/index.ts"
import { makeIntegrationTestDatabaseContext } from "../../../persistence/tests/support/integration-test-kit.ts"
import { HeliusSolanaAssetResolutionServiceLive } from "../../src/providers/helius-solana/layers/HeliusSolanaAssetResolutionServiceLive.ts"
import { HeliusSolanaAssetResolutionService } from "../../src/providers/helius-solana/services/HeliusSolanaAssetResolutionService.ts"
import {
  HeliusSolanaSyncClient,
  type HeliusSolanaSyncClientShape,
} from "../../src/providers/helius-solana/services/HeliusSolanaSyncClient.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_sync_engine_helius_assets_pr16",
})

await Effect.runPromise(context.recreateTestDatabase())

const SOL_ASSET_ID = "00000000-0000-4000-8000-000000001601"
const USDC_ASSET_ID = "00000000-0000-4000-8000-000000001602"
const USDT_ASSET_ID = "00000000-0000-0000-0000-000000001603"
const UNKNOWN_ASSET_ID = "00000000-0000-0000-0000-000000001604"
const NFT_ASSET_ID = "00000000-0000-0000-0000-000000001606"
const SOL_REPRESENTATION_ID = "00000000-0000-4000-8000-000000001601"
const WRAPPED_SOL_REPRESENTATION_ID = "00000000-0000-4000-8000-000000001605"
const USDC_REPRESENTATION_ID = "00000000-0000-4000-8000-000000001602"
const USDT_REPRESENTATION_ID = "00000000-0000-4000-8000-000000001603"
const UNKNOWN_REPRESENTATION_ID = "00000000-0000-4000-8000-000000001604"
const NFT_REPRESENTATION_ID = "00000000-0000-4000-8000-000000001606"
const UNKNOWN_MINT = "Drift111111111111111111111111111111111111111"
const NFT_MINT = "Nft11111111111111111111111111111111111111111"
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"

const makeDasAsset = ({
  mintAddress,
  symbol,
  name,
  decimals,
  tokenProgram = TOKEN_PROGRAM,
  interfaceName = "FungibleToken",
}: {
  readonly mintAddress: string
  readonly symbol?: string
  readonly name: string
  readonly decimals?: number
  readonly tokenProgram?: string
  readonly interfaceName?: string
}) => ({
  id: mintAddress,
  interface: interfaceName,
  content: {
    metadata: {
      name,
      symbol,
      token_standard: interfaceName,
    },
  },
  token_info: {
    symbol,
    decimals,
    token_program: tokenProgram,
  },
  compression: {
    compressed: false,
  },
  burnt: false,
})

const resetAssetResolutionFixture = Effect.gen(function* () {
  const db = yield* drizzle
  const [solanaBlockchain] = yield* db
    .select({ id: schema.blockchains.id })
    .from(schema.blockchains)
    .where(eq(schema.blockchains.name, "solana"))
    .limit(1)

  if (solanaBlockchain === undefined) {
    return yield* Effect.die("Missing seeded Solana blockchain")
  }

  yield* db.delete(schema.providerAssetMappings)
  yield* db.delete(schema.providerAssets)

  yield* db
    .delete(schema.assetRepresentations)
    .where(eq(schema.assetRepresentations.blockchainId, solanaBlockchain.id))
  yield* db
    .delete(schema.assets)
    .where(
      inArray(schema.assets.id, [
        SOL_ASSET_ID,
        USDC_ASSET_ID,
        USDT_ASSET_ID,
        UNKNOWN_ASSET_ID,
        NFT_ASSET_ID,
      ])
    )

  yield* db.insert(schema.assets).values([
    {
      id: SOL_ASSET_ID,
      name: "Solana",
      symbol: "SOL",
      type: "fungible",
    },
    {
      id: USDC_ASSET_ID,
      name: "USD Coin",
      symbol: "USDC",
      type: "fungible",
    },
    {
      id: USDT_ASSET_ID,
      name: "Tether USD",
      symbol: "USDT",
      type: "fungible",
    },
  ])

  yield* db.insert(schema.assetRepresentations).values([
    {
      id: SOL_REPRESENTATION_ID,
      assetId: SOL_ASSET_ID,
      blockchainId: solanaBlockchain.id,
      type: "native",
      contractAddress: null,
      mintAddress: null,
      decimals: 9,
    },
    {
      id: WRAPPED_SOL_REPRESENTATION_ID,
      assetId: SOL_ASSET_ID,
      blockchainId: solanaBlockchain.id,
      type: "token",
      contractAddress: null,
      mintAddress: SOLANA_WRAPPED_NATIVE_MINT,
      decimals: 9,
    },
    {
      id: USDC_REPRESENTATION_ID,
      assetId: USDC_ASSET_ID,
      blockchainId: solanaBlockchain.id,
      type: "token",
      contractAddress: null,
      mintAddress: SOLANA_USDC_MINT,
      decimals: 6,
    },
    {
      id: USDT_REPRESENTATION_ID,
      assetId: USDT_ASSET_ID,
      blockchainId: solanaBlockchain.id,
      type: "token",
      contractAddress: null,
      mintAddress: SOLANA_USDT_MINT,
      decimals: 6,
    },
  ])

  return solanaBlockchain.id
})

const HeliusSolanaAssetResolutionTestLive = (
  fetchAssetBatch: HeliusSolanaSyncClientShape["fetchAssetBatch"]
) =>
  HeliusSolanaAssetResolutionServiceLive.pipe(
    Layer.provide(AssetRepositoryLive),
    Layer.provide(AssetResolutionJobRepositoryLive),
    Layer.provide(ProviderAssetRepositoryLive),
    Layer.provide(
      Layer.succeed(
        HeliusSolanaSyncClient,
        HeliusSolanaSyncClient.of({
          fetchTransactionsForAddress: () =>
            Effect.die("fetchTransactionsForAddress should not be called"),
          fetchAssetBatch,
          fetchTransfersForAddress: () =>
            Effect.die("fetchTransfersForAddress should not be called"),
        })
      )
    )
  )

const runAssetService = <A, E>(
  effect: Effect.Effect<A, E, HeliusSolanaAssetResolutionService>,
  fetchAssetBatch: HeliusSolanaSyncClientShape["fetchAssetBatch"]
) =>
  Effect.runPromise(
    context.runWithLayer({
      effect,
      layer: HeliusSolanaAssetResolutionTestLive(fetchAssetBatch),
    })
  )

const fetchProviderAssetState = ({ mintAddress }: { readonly mintAddress: string }) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [state] = yield* db
      .select({
        providerAssetRowId: schema.providerAssets.id,
        providerAssetId: schema.providerAssets.providerAssetId,
        naturalKey: schema.providerAssets.naturalKey,
        currencyCode: schema.providerAssets.currencyCode,
        exponent: schema.providerAssets.exponent,
        providerType: schema.providerAssets.providerType,
        rawProviderPayload: schema.providerAssets.rawProviderPayload,
        mappingKind: schema.providerAssetMappings.mappingKind,
        mappingStatus: schema.providerAssetMappings.mappingStatus,
        canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
        assetRepresentationId: schema.providerAssetMappings.assetRepresentationId,
        sourceNotes: schema.providerAssetMappings.sourceNotes,
      })
      .from(schema.providerAssets)
      .leftJoin(
        schema.providerAssetMappings,
        eq(schema.providerAssetMappings.providerAssetRowId, schema.providerAssets.id)
      )
      .where(
        and(
          eq(schema.providerAssets.provider, "helius-solana"),
          eq(schema.providerAssets.providerAssetId, mintAddress)
        )
      )
      .limit(1)

    return state ?? null
  })

describe("HeliusSolanaAssetResolutionServiceLive", () => {
  beforeEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* context.recreateTestDatabase()
        yield* Effect.promise(() => context.runPg(resetAssetResolutionFixture))
      })
    )
  )

  it.effect("resolves native SOL without a DAS metadata call", () =>
    Effect.gen(function* () {
      let dasCallCount = 0

      const result = yield* Effect.promise(() =>
        runAssetService(
          Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
            service.resolveAsset({
              kind: "native",
              mintAddress: null,
            })
          ),
          () =>
            Effect.sync(() => {
              dasCallCount += 1
              return []
            })
        )
      )

      expect(dasCallCount).toBe(0)
      expect(result).toMatchObject({
        kind: "canonical",
        assetKind: "native",
        providerAssetId: null,
        currencyCode: "SOL",
        decimals: 9,
        mappingStatus: "approved",
        canonicalAssetId: SOL_ASSET_ID,
        assetRepresentationId: SOL_REPRESENTATION_ID,
      })
    })
  )

  it.effect("resolves wrapped SOL to its mint representation", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runAssetService(
          Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
            Effect.gen(function* () {
              yield* service.ensureDefaultMappings

              return yield* service.resolveAsset({
                kind: "spl",
                mintAddress: SOLANA_WRAPPED_NATIVE_MINT,
              })
            })
          ),
          () => Effect.die("DAS should not be called for wrapped SOL default mapping")
        )
      )

      expect(result).toMatchObject({
        kind: "canonical",
        assetKind: "token",
        mintAddress: SOLANA_WRAPPED_NATIVE_MINT,
        canonicalAssetId: SOL_ASSET_ID,
        assetRepresentationId: WRAPPED_SOL_REPRESENTATION_ID,
      })
    })
  )

  it.effect("rejects a wrapped SOL mapping that points to native SOL", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runAssetService(
          Effect.flatMap(
            HeliusSolanaAssetResolutionService,
            (service) => service.ensureDefaultMappings
          ),
          () => Effect.die("DAS should not be called while seeding default mappings")
        )
      )

      yield* Effect.promise(() =>
        context.runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [wrappedSolProviderAsset] = yield* db
              .select({ id: schema.providerAssets.id })
              .from(schema.providerAssets)
              .where(eq(schema.providerAssets.providerAssetId, SOLANA_WRAPPED_NATIVE_MINT))
              .limit(1)

            if (wrappedSolProviderAsset === undefined) {
              return yield* Effect.die("Missing wrapped SOL provider asset")
            }

            yield* db
              .update(schema.providerAssetMappings)
              .set({
                canonicalAssetId: SOL_ASSET_ID,
                assetRepresentationId: SOL_REPRESENTATION_ID,
                mappingStatus: "approved",
              })
              .where(
                eq(schema.providerAssetMappings.providerAssetRowId, wrappedSolProviderAsset.id)
              )
          })
        )
      )

      const result = yield* Effect.promise(() =>
        runAssetService(
          Effect.result(
            Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
              service.resolveAsset({
                kind: "spl",
                mintAddress: SOLANA_WRAPPED_NATIVE_MINT,
              })
            )
          ),
          () => Effect.die("DAS should not be called for an approved mapping")
        )
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          _tag: "HeliusSolanaBrokenApprovedProviderAssetMappingError",
          mintAddress: SOLANA_WRAPPED_NATIVE_MINT,
        })
      }
    })
  )

  it.effect("rejects an approved mapping whose stored decimals no longer match", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runAssetService(
          Effect.flatMap(
            HeliusSolanaAssetResolutionService,
            (service) => service.ensureDefaultMappings
          ),
          () => Effect.die("DAS should not be called while seeding default mappings")
        )
      )

      yield* Effect.promise(() =>
        context.runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.providerAssets)
              .set({ exponent: 8 })
              .where(eq(schema.providerAssets.providerAssetId, SOLANA_WRAPPED_NATIVE_MINT))
          })
        )
      )

      const result = yield* Effect.promise(() =>
        runAssetService(
          Effect.result(
            Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
              service.resolveAsset({
                kind: "spl",
                mintAddress: SOLANA_WRAPPED_NATIVE_MINT,
              })
            )
          ),
          () => Effect.die("DAS should not be called for an approved mapping")
        )
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          _tag: "HeliusSolanaBrokenApprovedProviderAssetMappingError",
          mintAddress: SOLANA_WRAPPED_NATIVE_MINT,
          message:
            "Helius Solana provider asset mapping for SOL conflicts with its exact type or decimals evidence.",
        })
      }
    })
  )

  it.effect(
    "resolves known SPL stablecoin mints through one DAS batch and approved canonical mappings",
    () =>
      Effect.gen(function* () {
        const dasCalls: Array<ReadonlyArray<string>> = []

        const result = yield* Effect.promise(() =>
          runAssetService(
            Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
              service.resolveAssets({
                assets: [
                  {
                    kind: "spl",
                    mintAddress: SOLANA_USDC_MINT,
                  },
                  {
                    kind: "spl",
                    mintAddress: SOLANA_USDT_MINT,
                  },
                ],
              })
            ),
            ({ mintAddresses }) =>
              Effect.sync(() => {
                dasCalls.push(mintAddresses)
                return [
                  makeDasAsset({
                    mintAddress: SOLANA_USDC_MINT,
                    symbol: "USDC",
                    name: "USD Coin",
                    decimals: 6,
                    tokenProgram: TOKEN_PROGRAM,
                  }),
                  makeDasAsset({
                    mintAddress: SOLANA_USDT_MINT,
                    symbol: "USDT",
                    name: "Tether USD",
                    decimals: 6,
                    tokenProgram: TOKEN_PROGRAM,
                  }),
                ]
              })
          )
        )

        expect(dasCalls).toEqual([[SOLANA_USDC_MINT, SOLANA_USDT_MINT]])
        expect(result.map((asset) => asset.canonicalAssetId)).toEqual([
          USDC_ASSET_ID,
          USDT_ASSET_ID,
        ])
        expect(result.every((asset) => asset.kind === "canonical")).toBe(true)
        expect(result.every((asset) => asset.tokenProgram === TOKEN_PROGRAM)).toBe(true)

        const usdcState = yield* Effect.promise(() =>
          context.runPg(
            fetchProviderAssetState({
              mintAddress: SOLANA_USDC_MINT,
            })
          )
        )

        expect(usdcState).toMatchObject({
          currencyCode: "USDC",
          exponent: 6,
          providerType: "spl-token",
          mappingKind: "asset",
          mappingStatus: "approved",
          canonicalAssetId: USDC_ASSET_ID,
          assetRepresentationId: USDC_REPRESENTATION_ID,
        })
        expect(usdcState?.rawProviderPayload).toMatchObject({
          source: "helius_das_get_asset_batch",
          tokenProgram: TOKEN_PROGRAM,
          nftHint: false,
        })
      })
  )

  it.effect(
    "resolves approved built-in SPL mappings without refreshing non-DAS provider metadata",
    () =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() =>
          runAssetService(
            Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
              Effect.gen(function* () {
                yield* service.ensureDefaultMappings

                return yield* service.resolveAsset({
                  kind: "spl",
                  mintAddress: SOLANA_USDC_MINT,
                })
              })
            ),
            () => Effect.die("DAS should not be called for approved cached mapping")
          )
        )

        expect(result).toMatchObject({
          kind: "canonical",
          assetKind: "token",
          mintAddress: SOLANA_USDC_MINT,
          currencyCode: "USDC",
          decimals: 6,
          tokenProgram: null,
          mappingStatus: "approved",
          canonicalAssetId: USDC_ASSET_ID,
          assetRepresentationId: USDC_REPRESENTATION_ID,
        })

        const usdcState = yield* Effect.promise(() =>
          context.runPg(
            fetchProviderAssetState({
              mintAddress: SOLANA_USDC_MINT,
            })
          )
        )

        expect(usdcState?.rawProviderPayload).toMatchObject({
          source: "taxmaxi_builtin_solana_asset_mapping",
        })
      })
  )

  it.effect("persists unknown SPL mints as pending provider asset review instead of failing", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runAssetService(
          Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
            service.resolveAsset({
              kind: "spl",
              mintAddress: UNKNOWN_MINT,
              rawProviderPayload: {
                signature: "unknown-asset-signature",
              },
            })
          ),
          () =>
            Effect.succeed([
              makeDasAsset({
                mintAddress: UNKNOWN_MINT,
                name: "Drift Example",
                decimals: 5,
                tokenProgram: TOKEN_2022_PROGRAM,
              }),
            ])
        )
      )

      expect(result).toMatchObject({
        kind: "review_required",
        assetKind: "token",
        representationTypeObserved: true,
        mintAddress: UNKNOWN_MINT,
        decimals: 5,
        tokenProgram: TOKEN_2022_PROGRAM,
        mappingStatus: "pending_review",
        canonicalAssetId: null,
      })

      const state = yield* Effect.promise(() =>
        context.runPg(fetchProviderAssetState({ mintAddress: UNKNOWN_MINT }))
      )

      expect(state).toMatchObject({
        providerAssetId: UNKNOWN_MINT,
        naturalKey: `solana:mint:${UNKNOWN_MINT}`,
        currencyCode: "SOLANA_MINT_DRIFT111",
        providerType: "spl-token-2022",
        mappingStatus: "pending_review",
        canonicalAssetId: null,
      })
      expect(state?.rawProviderPayload).toMatchObject({
        source: "helius_das_get_asset_batch",
        tokenProgram: TOKEN_2022_PROGRAM,
        nftHint: false,
      })
    })
  )

  it.effect("returns an explicit excluded result for an excluded provider asset mapping", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runAssetService(
          Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
            service.resolveAsset({
              kind: "spl",
              mintAddress: UNKNOWN_MINT,
            })
          ),
          () =>
            Effect.succeed([
              makeDasAsset({
                mintAddress: UNKNOWN_MINT,
                name: "Excluded example",
                decimals: 5,
              }),
            ])
        )
      )

      const state = yield* Effect.promise(() =>
        context.runPg(fetchProviderAssetState({ mintAddress: UNKNOWN_MINT }))
      )
      if (state === null) {
        expect.fail("Expected the Helius provider asset fixture to exist")
      }

      yield* Effect.promise(() =>
        context.runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.providerAssetMappings)
              .set({ mappingStatus: "excluded" })
              .where(eq(schema.providerAssetMappings.providerAssetRowId, state.providerAssetRowId))
          })
        )
      )

      const result = yield* Effect.promise(() =>
        runAssetService(
          Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
            service.resolveAsset({
              kind: "spl",
              mintAddress: UNKNOWN_MINT,
            })
          ),
          () => Effect.die("DAS metadata should already be persisted")
        )
      )

      expect(result).toMatchObject({
        kind: "excluded",
        mappingStatus: "excluded",
        canonicalAssetId: null,
        assetRepresentationId: null,
      })
    })
  )

  it.effect("resolves an excluded fallback observation without refreshing DAS metadata", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runAssetService(
          Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
            service.resolveAsset({
              kind: "spl",
              mintAddress: UNKNOWN_MINT,
              rawProviderPayload: { signature: "fallback-observation" },
            })
          ),
          () => Effect.succeed([])
        )
      )

      const state = yield* Effect.promise(() =>
        context.runPg(fetchProviderAssetState({ mintAddress: UNKNOWN_MINT }))
      )
      if (state === null) {
        expect.fail("Expected the fallback Helius provider asset fixture to exist")
      }

      yield* Effect.promise(() =>
        context.runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.providerAssetMappings)
              .set({ mappingStatus: "excluded" })
              .where(eq(schema.providerAssetMappings.providerAssetRowId, state.providerAssetRowId))
          })
        )
      )

      let dasCalls = 0
      const result = yield* Effect.promise(() =>
        runAssetService(
          Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
            service.resolveAsset({
              kind: "spl",
              mintAddress: UNKNOWN_MINT,
              rawProviderPayload: { signature: "replay-observation" },
            })
          ),
          () => {
            dasCalls += 1
            return Effect.die("DAS outage must not block a settled exclusion replay")
          }
        )
      )

      expect(dasCalls).toBe(0)
      expect(result).toMatchObject({
        kind: "excluded",
        mintAddress: UNKNOWN_MINT,
        mappingStatus: "excluded",
        canonicalAssetId: null,
        assetRepresentationId: null,
      })
    })
  )

  it.effect(
    "keeps an exact known non-default representation pending and schedules resolution",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          context.runPg(
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

              yield* db.insert(schema.assets).values({
                id: UNKNOWN_ASSET_ID,
                name: "Drift Example",
                symbol: "DRIFT",
                type: "fungible",
              })
              yield* db.insert(schema.assetRepresentations).values({
                id: UNKNOWN_REPRESENTATION_ID,
                assetId: UNKNOWN_ASSET_ID,
                blockchainId: solanaBlockchain.id,
                contractAddress: null,
                mintAddress: UNKNOWN_MINT,
                decimals: 6,
                type: "token",
              })
            })
          )
        )

        const result = yield* Effect.promise(() =>
          runAssetService(
            Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
              service.resolveAsset({
                kind: "spl",
                mintAddress: UNKNOWN_MINT,
              })
            ),
            () =>
              Effect.succeed([
                makeDasAsset({
                  mintAddress: UNKNOWN_MINT,
                  symbol: "DRIFT",
                  name: "Drift Example",
                  decimals: 6,
                }),
              ])
          )
        )

        const state = yield* Effect.promise(() =>
          context.runPg(fetchProviderAssetState({ mintAddress: UNKNOWN_MINT }))
        )
        const resolutionJobs = yield* Effect.promise(() =>
          context.runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return yield* db
                .select({
                  providerAssetRowId: schema.assetResolutionJobs.providerAssetRowId,
                  status: schema.assetResolutionJobs.status,
                })
                .from(schema.assetResolutionJobs)
            })
          )
        )

        expect(result).toMatchObject({
          kind: "review_required",
          mappingStatus: "pending_review",
          canonicalAssetId: null,
          assetRepresentationId: null,
        })
        expect(state).toMatchObject({
          mappingStatus: "pending_review",
          canonicalAssetId: null,
          assetRepresentationId: null,
        })
        expect(resolutionJobs).toEqual([
          {
            providerAssetRowId: state?.providerAssetRowId,
            status: "pending",
          },
        ])
      })
  )

  it.effect("keeps an exact mint pending when current raw decimals conflict", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        context.runPg(
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

            yield* db.insert(schema.assets).values({
              id: UNKNOWN_ASSET_ID,
              name: "Drift Example",
              symbol: "DRIFT",
              type: "fungible",
            })
            yield* db.insert(schema.assetRepresentations).values({
              id: UNKNOWN_REPRESENTATION_ID,
              assetId: UNKNOWN_ASSET_ID,
              blockchainId: solanaBlockchain.id,
              contractAddress: null,
              mintAddress: UNKNOWN_MINT,
              decimals: 6,
              type: "token",
            })
          })
        )
      )

      const result = yield* Effect.promise(() =>
        runAssetService(
          Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
            service.resolveAsset({
              kind: "spl",
              mintAddress: UNKNOWN_MINT,
              observedDecimals: 5,
            })
          ),
          () =>
            Effect.succeed([
              makeDasAsset({
                mintAddress: UNKNOWN_MINT,
                symbol: "DRIFT",
                name: "Drift Example",
                decimals: 6,
              }),
            ])
        )
      )
      const state = yield* Effect.promise(() =>
        context.runPg(fetchProviderAssetState({ mintAddress: UNKNOWN_MINT }))
      )

      expect(result).toMatchObject({
        kind: "review_required",
        mappingStatus: "pending_review",
        canonicalAssetId: null,
        assetRepresentationId: null,
      })
      expect(state).toMatchObject({
        mappingStatus: "pending_review",
        canonicalAssetId: null,
        assetRepresentationId: null,
      })
    })
  )

  it.effect("keeps an exact known NFT pending when DAS decimals are missing", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        context.runPg(
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

            yield* db.insert(schema.assets).values({
              id: NFT_ASSET_ID,
              name: "Known NFT",
              symbol: "KNFT",
              type: "nft",
            })
            yield* db.insert(schema.assetRepresentations).values({
              id: NFT_REPRESENTATION_ID,
              assetId: NFT_ASSET_ID,
              blockchainId: solanaBlockchain.id,
              contractAddress: null,
              mintAddress: NFT_MINT,
              decimals: 0,
              type: "nft",
            })
          })
        )
      )

      const result = yield* Effect.promise(() =>
        runAssetService(
          Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
            service.resolveAsset({
              kind: "spl",
              mintAddress: NFT_MINT,
            })
          ),
          () =>
            Effect.succeed([
              {
                id: NFT_MINT,
                interface: "V1_PRINT",
                content: { metadata: { name: "Known NFT", symbol: "KNFT" } },
              },
            ])
        )
      )

      expect(result).toMatchObject({
        kind: "review_required",
        assetKind: "nft",
        representationTypeObserved: true,
        decimals: null,
        mappingStatus: "pending_review",
        canonicalAssetId: null,
        assetRepresentationId: null,
        nftHint: true,
      })
    })
  )

  it.effect(
    "recovers observed type evidence from cached DAS payloads without a derived marker",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          runAssetService(
            Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
              service.resolveAsset({
                kind: "spl",
                mintAddress: UNKNOWN_MINT,
              })
            ),
            () =>
              Effect.succeed([
                makeDasAsset({
                  mintAddress: UNKNOWN_MINT,
                  name: "Cached Token",
                  decimals: 5,
                }),
              ])
          )
        )

        yield* Effect.promise(() =>
          context.runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db
                .update(schema.providerAssets)
                .set({
                  rawProviderPayload: sql`${schema.providerAssets.rawProviderPayload} - 'representationTypeObserved'`,
                })
                .where(eq(schema.providerAssets.providerAssetId, UNKNOWN_MINT))
            })
          )
        )

        const result = yield* Effect.promise(() =>
          runAssetService(
            Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
              service.resolveAsset({
                kind: "spl",
                mintAddress: UNKNOWN_MINT,
              })
            ),
            () => Effect.die("Cached DAS metadata should not be refetched")
          )
        )

        expect(result).toMatchObject({
          assetKind: "token",
          representationTypeObserved: true,
          mintAddress: UNKNOWN_MINT,
        })
      })
  )

  it.effect("marks token-versus-NFT type as unknown when the DAS record is missing", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runAssetService(
          Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
            service.resolveAsset({
              kind: "spl",
              mintAddress: UNKNOWN_MINT,
            })
          ),
          () => Effect.succeed([])
        )
      )

      expect(result).toMatchObject({
        kind: "review_required",
        assetKind: "token",
        representationTypeObserved: false,
        mintAddress: UNKNOWN_MINT,
        decimals: null,
        mappingStatus: "pending_review",
      })
    })
  )

  it.effect("refreshes sparse DAS records until token-versus-NFT type is observed", () =>
    Effect.gen(function* () {
      const sparseResult = yield* Effect.promise(() =>
        runAssetService(
          Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
            service.resolveAsset({
              kind: "spl",
              mintAddress: UNKNOWN_MINT,
            })
          ),
          () =>
            Effect.succeed([
              {
                id: UNKNOWN_MINT,
                content: {
                  metadata: {
                    name: "Name That Looks Like An NFT",
                    symbol: "NFT",
                  },
                },
                token_info: {
                  symbol: "NFT",
                },
              },
            ])
        )
      )

      expect(sparseResult).toMatchObject({
        kind: "review_required",
        assetKind: "token",
        representationTypeObserved: false,
        mintAddress: UNKNOWN_MINT,
        decimals: null,
        mappingStatus: "pending_review",
      })

      const refreshedResult = yield* Effect.promise(() =>
        runAssetService(
          Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
            service.resolveAsset({
              kind: "spl",
              mintAddress: UNKNOWN_MINT,
            })
          ),
          () =>
            Effect.succeed([
              makeDasAsset({
                mintAddress: UNKNOWN_MINT,
                name: "Now Identified NFT",
                decimals: 0,
                interfaceName: "V1_PRINT",
              }),
            ])
        )
      )

      expect(refreshedResult).toMatchObject({
        kind: "review_required",
        assetKind: "nft",
        representationTypeObserved: true,
        mintAddress: UNKNOWN_MINT,
        decimals: 0,
        mappingStatus: "pending_review",
      })
    })
  )

  it.effect("recognizes an explicit non-fungible DAS token standard", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runAssetService(
          Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
            service.resolveAsset({
              kind: "spl",
              mintAddress: UNKNOWN_MINT,
            })
          ),
          () =>
            Effect.succeed([
              makeDasAsset({
                mintAddress: UNKNOWN_MINT,
                name: "Programmable NFT",
                decimals: 0,
                interfaceName: "ProgrammableNonFungible",
              }),
            ])
        )
      )

      expect(result).toMatchObject({
        kind: "review_required",
        assetKind: "nft",
        representationTypeObserved: true,
        mintAddress: UNKNOWN_MINT,
        decimals: 0,
        mappingStatus: "pending_review",
      })
    })
  )

  it.effect("preserves observed decimals when a type refresh omits them", () =>
    Effect.gen(function* () {
      const sparseResult = yield* Effect.promise(() =>
        runAssetService(
          Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
            service.resolveAsset({
              kind: "spl",
              mintAddress: UNKNOWN_MINT,
            })
          ),
          () =>
            Effect.succeed([
              {
                id: UNKNOWN_MINT,
                content: {
                  metadata: {
                    name: "Sparse asset with decimals",
                    symbol: "SPARSE",
                  },
                },
                token_info: {
                  symbol: "SPARSE",
                  decimals: 5,
                },
              },
            ])
        )
      )

      expect(sparseResult).toMatchObject({
        representationTypeObserved: false,
        decimals: 5,
      })

      const refreshedResult = yield* Effect.promise(() =>
        runAssetService(
          Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
            service.resolveAsset({
              kind: "spl",
              mintAddress: UNKNOWN_MINT,
            })
          ),
          () =>
            Effect.succeed([
              {
                id: UNKNOWN_MINT,
                interface: "V1_PRINT",
                content: {
                  metadata: {
                    name: "Identified NFT without decimals",
                    symbol: "NFT",
                  },
                },
              },
            ])
        )
      )

      expect(refreshedResult).toMatchObject({
        assetKind: "nft",
        representationTypeObserved: true,
        decimals: 5,
      })
    })
  )

  it.effect.each(["V1_PRINT", "MplCoreAsset"])(
    "recognizes the explicit %s DAS NFT interface",
    (interfaceName) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() =>
          runAssetService(
            Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
              service.resolveAsset({
                kind: "spl",
                mintAddress: UNKNOWN_MINT,
              })
            ),
            () =>
              Effect.succeed([
                {
                  id: UNKNOWN_MINT,
                  interface: interfaceName,
                  content: {
                    metadata: {
                      name: "Explicit NFT Interface",
                    },
                  },
                  token_info: {
                    decimals: 0,
                    token_program: TOKEN_PROGRAM,
                  },
                  compression: {
                    compressed: false,
                  },
                },
              ])
          )
        )

        expect(result).toMatchObject({
          kind: "review_required",
          assetKind: "nft",
          representationTypeObserved: true,
          mintAddress: UNKNOWN_MINT,
          decimals: 0,
        })
      })
  )

  it.effect("derives the asset kind from cached DAS evidence instead of stale stored fields", () =>
    Effect.gen(function* () {
      const cachedDasAsset = makeDasAsset({
        mintAddress: UNKNOWN_MINT,
        name: "Cached Explicit NFT",
        decimals: 0,
        interfaceName: "V1_PRINT",
      })

      yield* Effect.promise(() =>
        runAssetService(
          Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
            service.resolveAsset({
              kind: "spl",
              mintAddress: UNKNOWN_MINT,
            })
          ),
          () => Effect.succeed([cachedDasAsset])
        )
      )

      yield* Effect.promise(() =>
        context.runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.providerAssets)
              .set({
                providerType: "spl-token",
                rawProviderPayload: {
                  source: "helius_das_get_asset_batch",
                  tokenProgram: TOKEN_PROGRAM,
                  nftHint: false,
                  asset: cachedDasAsset,
                },
              })
              .where(eq(schema.providerAssets.providerAssetId, UNKNOWN_MINT))
          })
        )
      )

      const result = yield* Effect.promise(() =>
        runAssetService(
          Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
            service.resolveAsset({
              kind: "spl",
              mintAddress: UNKNOWN_MINT,
            })
          ),
          () => Effect.die("Complete cached DAS metadata should not be refetched")
        )
      )

      expect(result).toMatchObject({
        assetKind: "nft",
        representationTypeObserved: true,
        mintAddress: UNKNOWN_MINT,
        nftHint: true,
      })
    })
  )

  it.effect("fails with a typed decode error for malformed DAS asset metadata", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runAssetService(
          Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
            service
              .resolveAsset({
                kind: "spl",
                mintAddress: UNKNOWN_MINT,
              })
              .pipe(Effect.result)
          ),
          () =>
            Effect.succeed([
              {
                id: UNKNOWN_MINT,
                token_info: {
                  decimals: "6",
                },
              },
            ])
        )
      )

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          _tag: "HeliusSolanaAssetMetadataDecodeError",
        })
        expect(result.failure.message).toContain("Invalid Helius DAS asset batch payload")
      }
    })
  )

  it.effect(
    "resolves a previously pending mint deterministically after provider asset approval",
    () =>
      Effect.gen(function* () {
        let dasCallCount = 0

        yield* Effect.promise(() =>
          runAssetService(
            Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
              service.resolveAsset({
                kind: "spl",
                mintAddress: UNKNOWN_MINT,
              })
            ),
            () =>
              Effect.sync(() => {
                dasCallCount += 1
                return [
                  makeDasAsset({
                    mintAddress: UNKNOWN_MINT,
                    symbol: "DRIFT",
                    name: "Drift Example",
                    decimals: 6,
                  }),
                ]
              })
          )
        )

        const providerAssetState = yield* Effect.promise(() =>
          context.runPg(fetchProviderAssetState({ mintAddress: UNKNOWN_MINT }))
        )
        if (providerAssetState === null) {
          expect.fail("Expected pending provider asset state")
        }

        yield* Effect.promise(() =>
          context.runPg(
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

              yield* db.insert(schema.assets).values({
                id: UNKNOWN_ASSET_ID,
                name: "Drift Example",
                symbol: "DRIFT",
                type: "fungible",
              })
              yield* db.insert(schema.assetRepresentations).values({
                id: UNKNOWN_REPRESENTATION_ID,
                assetId: UNKNOWN_ASSET_ID,
                blockchainId: solanaBlockchain.id,
                contractAddress: null,
                mintAddress: UNKNOWN_MINT,
                decimals: 6,
                type: "token",
              })

              yield* db
                .update(schema.providerAssetMappings)
                .set({
                  mappingKind: "asset",
                  canonicalAssetId: UNKNOWN_ASSET_ID,
                  assetRepresentationId: UNKNOWN_REPRESENTATION_ID,
                  canonicalFiatCurrency: null,
                  mappingStatus: "approved",
                  reviewerNotes: "Approved in test",
                  sourceNotes: "Approved in test",
                })
                .where(
                  eq(
                    schema.providerAssetMappings.providerAssetRowId,
                    providerAssetState.providerAssetRowId
                  )
                )
            })
          )
        )

        const replayResult = yield* Effect.promise(() =>
          runAssetService(
            Effect.flatMap(HeliusSolanaAssetResolutionService, (service) =>
              service.resolveAsset({
                kind: "spl",
                mintAddress: UNKNOWN_MINT,
              })
            ),
            () => Effect.die("DAS should not be called when approved mapping is cached")
          )
        )

        expect(dasCallCount).toBe(1)
        expect(replayResult).toMatchObject({
          kind: "canonical",
          mintAddress: UNKNOWN_MINT,
          canonicalAssetId: UNKNOWN_ASSET_ID,
          assetRepresentationId: UNKNOWN_REPRESENTATION_ID,
          mappingStatus: "approved",
        })
      })
  )
})

describe("Helius movement target persistence and replay", () => {
  const movementPrincipalId = "00000000-0000-4000-8000-000000007521"
  const movementUserId = "00000000-0000-4000-8000-000000007522"
  const movementSourceId = "00000000-0000-4000-8000-000000007523"
  const wallet = "11111111111111111111111111111111ab"
  const addressId = "00000000-0000-4000-8000-000000007501"
  const time = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z"))
  const client = Layer.succeed(HeliusSolanaSyncClient, {
    fetchTransactionsForAddress: () => Effect.die("Cached normalization must not fetch history"),
    fetchTransfersForAddress: () => Effect.die("Cached normalization must not fetch transfers"),
    fetchAssetBatch: () =>
      Effect.succeed({
        result: [
          makeDasAsset({
            mintAddress: SOLANA_USDC_MINT,
            symbol: "USDC",
            name: "USD Coin",
            decimals: 6,
          }),
        ],
      }),
  })
  const assets = HeliusSolanaAssetResolutionServiceLive.pipe(
    Layer.provide(AssetRepositoryLive),
    Layer.provide(AssetResolutionJobRepositoryLive),
    Layer.provide(ProviderAssetRepositoryLive),
    Layer.provide(client)
  )
  const provider = HeliusSolanaSourceSyncProviderFromClientAndAssetResolutionLive.pipe(
    Layer.provide(assets),
    Layer.provide(client),
    Layer.provide(AssetRepositoryLive),
    Layer.provide(ProviderAssetRepositoryLive)
  )
  const layer = Layer.mergeAll(
    provider,
    SourceNormalizationRepositoryLive,
    SourceReplayRepositoryLive,
    PrincipalTransactionOverrideRepositoryLive,
    FactualLedgerRepositoryLive,
    CalculationRunServiceLive.pipe(
      Layer.provide(Layer.merge(CalculationRunRepositoryLive, FactualLedgerRepositoryLive))
    )
  )

  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | HeliusSolanaSourceSyncProvider
      | SourceNormalizationRepository
      | SourceReplayRepository
      | PrincipalTransactionOverrideRepository
      | FactualLedgerRepository
      | CalculationRunService
    >
  ) => Effect.runPromise(context.runWithLayer({ effect, layer }))

  const normalize = ({
    recordKey,
    order = [1, 2],
    parsed = false,
    amounts,
    cachedRecord,
  }: {
    readonly recordKey: string
    readonly order?: ReadonlyArray<number>
    readonly parsed?: boolean
    readonly amounts?: ReadonlyArray<string>
    readonly cachedRecord?: { readonly id: string; readonly payload: unknown }
  }) =>
    run(
      Effect.gen(function* () {
        const provider = yield* HeliusSolanaSourceSyncProvider
        const repository = yield* SourceNormalizationRepository
        const balances = order.map((accountIndex, index) => ({
          accountIndex,
          mint: SOLANA_USDC_MINT,
          owner: wallet,
          uiTokenAmount: {
            amount: amounts?.[index] ?? "1000000",
            decimals: 6,
            uiAmount: 1,
            uiAmountString: "1",
          },
        }))
        const prepared = yield* provider.prepareNormalization({
          source: {
            id: movementSourceId,
            principalId: movementPrincipalId,
            providerKey: "helius-solana",
            cexAccountId: null,
            addressId,
            walletAddress: wallet,
          },
          sourceRecord: {
            id: cachedRecord?.id ?? "00000000-0000-4000-8000-000000007502",
            sourceId: movementSourceId,
            provider: "helius-solana",
            recordType: "solana_transaction_full",
            externalAccountId: wallet,
            externalRecordId: recordKey,
            externalParentId: null,
            occurredAt: time,
            importedAt: time,
            normalizedAt: null,
            normalizationError: null,
            createdAt: time,
            updatedAt: time,
            payload: cachedRecord?.payload ?? {
              fullTransaction: {
                slot: 1,
                transaction: {
                  signatures: [recordKey],
                  message: { accountKeys: [wallet, "token-account-one", "token-account-two"] },
                },
                blockTime: 1735689600,
                meta: {
                  err: null,
                  fee: 5000,
                  preBalances: [1000000000, 0, 0],
                  postBalances: [999995000, 0, 0],
                  preTokenBalances: [],
                  postTokenBalances: parsed ? [] : balances,
                },
                ...(parsed
                  ? {
                      tokenTransfers: [
                        {
                          mint: SOLANA_USDC_MINT,
                          tokenAmount: "1",
                          fromUserAccount: "external",
                          toUserAccount: wallet,
                        },
                      ],
                    }
                  : {}),
              },
              walletTransferEvidence: [],
            },
          },
          lookups: yield* provider.loadNormalizationLookups,
        })
        return yield* repository.persistNormalizedArtifacts({
          transaction: { ...prepared.transaction, sourceRawRecordId: cachedRecord?.id ?? null },
          venueContext: prepared.venueContext,
          onchainContext: prepared.onchainContext,
          canonicalTransfers: prepared.canonicalTransfers.map((transfer) => ({
            ...transfer,
            sourceRawRecordId: cachedRecord?.id ?? null,
          })),
          providerTransfers: prepared.providerTransfers.map((transfer) => ({
            ...transfer,
            sourceRawRecordId: cachedRecord?.id ?? null,
          })),
          providerAssetRowIds: prepared.providerAssetRowIds,
          transactionReview: prepared.transactionReview,
          resolvedTransactionType: prepared.resolvedTransactionType,
          deriveLegs: ({ transaction, venueContext, canonicalTransfers }) =>
            prepared.legDerivationStrategy === "skip"
              ? Effect.succeed([])
              : provider.deriveLegs({
                  transaction,
                  venueContext,
                  canonicalTransfers,
                  legPlans: prepared.legPlans,
                }),
        })
      })
    )

  const links = () =>
    context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return yield* db
          .select({
            legId: schema.transactionLegs.id,
            targetId: schema.movementCorrectionTargets.id,
            recordKey: schema.movementCorrectionTargets.sourceRecordKey,
            component: schema.movementCorrectionTargets.componentKey,
          })
          .from(schema.transactionLegs)
          .innerJoin(
            schema.movementCorrectionTargets,
            eq(
              schema.transactionLegs.movementCorrectionTargetId,
              schema.movementCorrectionTargets.id
            )
          )
          .where(eq(schema.transactionLegs.sourceId, movementSourceId))
          .orderBy(schema.movementCorrectionTargets.componentKey)
      })
    )

  beforeEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* context.recreateTestDatabase()
        yield* Effect.promise(() =>
          context.runPg(
            Effect.gen(function* () {
              yield* resetAssetResolutionFixture
              yield* seedSyncEngineRepositoryFixture({
                principalId: movementPrincipalId,
                userId: movementUserId,
                sourceId: movementSourceId,
              })
              const db = yield* drizzle
              yield* db.insert(schema.addresses).values({
                id: addressId,
                address: wallet,
                principalId: movementPrincipalId,
                type: "solana",
                name: "Synthetic target wallet",
              })
              yield* db
                .update(schema.sources)
                .set({
                  sourceableType: "onchain",
                  addressId,
                  cexAccountId: null,
                  providerKey: "helius-solana",
                })
                .where(eq(schema.sources.id, movementSourceId))
            })
          )
        )
        yield* Effect.promise(() =>
          run(
            Effect.flatMap(
              HeliusSolanaSourceSyncProvider,
              (provider) => provider.refreshReferenceData
            )
          )
        )
      })
    )
  )

  it.effect(
    "keeps equal-token components distinct through reordered normalization, replay, and disappearance",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => normalize({ recordKey: "synthetic-components" }))
        const first = yield* Effect.promise(links)
        expect(first).toHaveLength(3)
        expect(new Set(first.map((row) => row.targetId)).size).toBe(3)
        expect(first.map((row) => row.component)).toEqual([
          "meta.fee",
          `token_balance:1:${SOLANA_USDC_MINT}`,
          `token_balance:2:${SOLANA_USDC_MINT}`,
        ])
        yield* Effect.promise(() => normalize({ recordKey: "synthetic-components", order: [2, 1] }))
        expect(yield* Effect.promise(links)).toEqual(first)
        yield* Effect.promise(() =>
          run(
            Effect.flatMap(SourceReplayRepository, (repository) =>
              repository.resetSourceDerivedState({ sourceId: movementSourceId })
            )
          )
        )
        yield* Effect.promise(() => normalize({ recordKey: "synthetic-components", order: [2, 1] }))
        const replayed = yield* Effect.promise(links)
        expect(replayed.map(({ targetId }) => targetId)).toEqual(
          first.map(({ targetId }) => targetId)
        )
        expect(replayed.every((row) => first.every((old) => old.legId !== row.legId))).toBe(true)
        yield* Effect.promise(() =>
          run(
            Effect.flatMap(SourceReplayRepository, (repository) =>
              repository.resetSourceDerivedState({ sourceId: movementSourceId })
            )
          )
        )
        yield* Effect.promise(() => normalize({ recordKey: "synthetic-components", order: [1] }))
        expect(yield* Effect.promise(links)).toHaveLength(2)
        const targets = yield* Effect.promise(() =>
          context.runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return yield* db
                .select({ id: schema.movementCorrectionTargets.id })
                .from(schema.movementCorrectionTargets)
                .where(eq(schema.movementCorrectionTargets.sourceId, movementSourceId))
            })
          )
        )
        expect(targets).toHaveLength(3)
      })
  )

  it.effect("keeps accepted corrections on one equal-token component through cached replay", () =>
    Effect.gen(function* () {
      const recordKey = "synthetic-corrected-components"
      const principalId = PrincipalId.make(movementPrincipalId)
      const currency = CurrencyCode.make("EUR")
      const firstRunId = CalculationRunId.make("00000000-0000-4000-8000-000000007511")
      const replayRunId = CalculationRunId.make("00000000-0000-4000-8000-000000007512")
      const cacheRecord = (order: ReadonlyArray<number>) =>
        context.runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const payload = {
              fullTransaction: {
                slot: 1,
                transaction: {
                  signatures: [recordKey],
                  message: { accountKeys: [wallet, "token-account-one", "token-account-two"] },
                },
                blockTime: 1735689600,
                meta: {
                  err: null,
                  fee: 5000,
                  preBalances: [1000000000, 0, 0],
                  postBalances: [999995000, 0, 0],
                  preTokenBalances: [],
                  postTokenBalances: order.map((accountIndex) => ({
                    accountIndex,
                    mint: SOLANA_USDC_MINT,
                    owner: wallet,
                    uiTokenAmount: {
                      amount: "1000000",
                      decimals: 6,
                      uiAmount: 1,
                      uiAmountString: "1",
                    },
                  })),
                },
              },
              walletTransferEvidence: [],
            }
            yield* db
              .insert(schema.sourceRecordsRaw)
              .values({
                sourceId: movementSourceId,
                provider: "helius-solana",
                recordType: "solana_transaction_full",
                externalAccountId: wallet,
                externalRecordId: recordKey,
                occurredAt: time,
                payload,
              })
              .onConflictDoUpdate({
                target: [
                  schema.sourceRecordsRaw.sourceId,
                  schema.sourceRecordsRaw.recordType,
                  schema.sourceRecordsRaw.externalRecordId,
                ],
                set: { payload },
              })
            const [cached] = yield* db
              .select({ id: schema.sourceRecordsRaw.id, payload: schema.sourceRecordsRaw.payload })
              .from(schema.sourceRecordsRaw)
              .where(eq(schema.sourceRecordsRaw.externalRecordId, recordKey))
            if (cached === undefined) return yield* Effect.die("Missing cached Helius record")
            return cached
          })
        )
      const cached = yield* Effect.promise(() => cacheRecord([1, 2]))
      yield* Effect.promise(() => normalize({ recordKey, cachedRecord: cached }))
      const first = yield* Effect.promise(links)
      const corrected = first.find(
        ({ component }) => component === `token_balance:1:${SOLANA_USDC_MINT}`
      )
      const sibling = first.find(
        ({ component }) => component === `token_balance:2:${SOLANA_USDC_MINT}`
      )
      const fee = first.find(({ component }) => component === "meta.fee")
      if (corrected === undefined || sibling === undefined || fee === undefined)
        return yield* Effect.die("Missing equal-token correction fixtures")
      expect(first).toHaveLength(3)
      const loadLedger = () =>
        run(
          Effect.flatMap(FactualLedgerRepository, (repository) =>
            repository.load({ principalId, reportingCurrency: currency })
          )
        )
      const originalLedger = yield* Effect.promise(loadLedger)
      expect(originalLedger.events).toHaveLength(3)
      expect(originalLedger.valuationFacts).toEqual([])
      expect(originalLedger.events.find((event) => event.id === fee.legId)).toMatchObject({
        _tag: "disposition",
        cause: "fee",
      })
      const accept = (input: MovementCorrectionInput) =>
        run(
          Effect.gen(function* () {
            const repository = yield* PrincipalTransactionOverrideRepository
            const found = yield* repository.findContext({
              principalId,
              targetId: corrected.targetId,
              reportingCurrency: currency,
            })
            if (Option.isNone(found) || found.value.current === null)
              return yield* Effect.die("Missing inspectable Helius movement")
            const accepted = yield* repository.create({
              principalId,
              actorUserId: AuthUserId.make(movementUserId),
              targetId: corrected.targetId,
              reportingCurrency: currency,
              expectedSystemRevision: found.value.current.facts.systemRevision,
              expectedLeafId: null,
              reason: "Synthetic account-index component evidence",
              input,
            })
            if (Option.isNone(accepted))
              return yield* Effect.die("Helius correction was not accepted")
            return accepted.value
          })
        )
      const price = yield* Effect.promise(() =>
        accept({ _tag: "price", input: { _tag: "total_value", amount: "7", currency } })
      )
      const classification = yield* Effect.promise(() =>
        accept({ _tag: "classification", input: { _tag: "inbound", cause: "purchase" } })
      )
      const acceptedContext = classification.context
      expect(acceptedContext.history).toHaveLength(2)
      expect(
        acceptedContext.history.every((record) => record.targetId === corrected.targetId)
      ).toBe(true)
      expect(acceptedContext.history.map((record) => record.inspectedValuationEvidence)).toEqual([
        { reportingCurrency: currency, facts: [] },
        { reportingCurrency: currency, facts: [] },
      ])
      const recompute = (id: CalculationRunId) =>
        run(
          Effect.flatMap(CalculationRunService, (service) =>
            service.recompute({
              id,
              principalId,
              jurisdiction: JurisdictionCode.make("DE"),
              taxYear: TaxYear.make(2025),
              reportingCurrency: currency,
              accountingChoices: [],
            })
          )
        )
      const readRun = (id: CalculationRunId) =>
        context.runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const lots = yield* db
              .select({
                eventId: schema.calculationRunDerivedLots.acquisitionEventId,
                costBasisPerUnit: schema.calculationRunDerivedLots.costBasisPerUnit,
              })
              .from(schema.calculationRunDerivedLots)
              .where(eq(schema.calculationRunDerivedLots.runId, id))
              .orderBy(schema.calculationRunDerivedLots.sequence)
            const inputs = yield* db
              .select({ captured: schema.calculationRunCorrectionInputs.captured })
              .from(schema.calculationRunCorrectionInputs)
              .where(eq(schema.calculationRunCorrectionInputs.runId, id))
              .orderBy(schema.calculationRunCorrectionInputs.overrideId)
            return { lots, inputs }
          })
        )
      const effectiveBefore = yield* Effect.promise(loadLedger)
      const beforePrice = effectiveBefore.valuationFacts.filter(
        (fact) => fact._tag === "user_valuation"
      )
      expect(beforePrice).toHaveLength(1)
      expect(beforePrice[0]?.eventId).toBe(corrected.legId)
      expect(beforePrice[0]?.evidenceReference).toBe(`movement-price:${price.overrideId}`)
      expect(beforePrice[0]?.amount.toString()).toBe("7 EUR")
      expect(effectiveBefore.events.find((event) => event.id === corrected.legId)).toMatchObject({
        _tag: "acquisition",
        cause: "purchase",
      })
      for (const untouched of [sibling, fee]) {
        expect(effectiveBefore.events.find((event) => event.id === untouched.legId)).toEqual(
          originalLedger.events.find((event) => event.id === untouched.legId)
        )
      }
      yield* Effect.promise(() => recompute(firstRunId))
      const firstRun = yield* Effect.promise(() => readRun(firstRunId))
      expect(firstRun.inputs.map(({ captured }) => captured.history.id).sort()).toEqual(
        [price.overrideId, classification.overrideId].sort()
      )
      const correctedLot = firstRun.lots.find((lot) => lot.eventId === corrected.legId)
      expect(
        correctedLot?.costBasisPerUnit === null || correctedLot?.costBasisPerUnit === undefined
          ? false
          : BigDecimal.equals(
              BigDecimal.fromStringUnsafe(correctedLot.costBasisPerUnit),
              BigDecimal.fromStringUnsafe("7")
            )
      ).toBe(true)

      const reorderedCache = yield* Effect.promise(() => cacheRecord([2, 1]))
      expect(reorderedCache.id).toBe(cached.id)
      yield* Effect.promise(() =>
        run(
          Effect.flatMap(SourceReplayRepository, (repository) =>
            repository.resetSourceDerivedState({ sourceId: movementSourceId })
          )
        )
      )
      yield* Effect.promise(() => normalize({ recordKey, cachedRecord: reorderedCache }))
      const replayed = yield* Effect.promise(links)
      expect(replayed.map(({ targetId, component }) => ({ targetId, component }))).toEqual(
        first.map(({ targetId, component }) => ({ targetId, component }))
      )
      expect(replayed.every((row) => first.every((old) => old.legId !== row.legId))).toBe(true)
      const replayedCorrection = replayed.find(({ targetId }) => targetId === corrected.targetId)
      const replayedSibling = replayed.find(({ targetId }) => targetId === sibling.targetId)
      const replayedFee = replayed.find(({ targetId }) => targetId === fee.targetId)
      if (
        replayedCorrection === undefined ||
        replayedSibling === undefined ||
        replayedFee === undefined
      )
        return yield* Effect.die("Missing replayed component links")
      const found = yield* Effect.promise(() =>
        run(
          Effect.flatMap(PrincipalTransactionOverrideRepository, (repository) =>
            repository.findContext({
              principalId,
              targetId: corrected.targetId,
              reportingCurrency: currency,
            })
          )
        )
      )
      if (Option.isNone(found)) return yield* Effect.die("Missing correction after replay")
      expect(found.value.history).toEqual(acceptedContext.history)
      expect(found.value.current?.facts).toEqual(acceptedContext.current?.facts)
      expect(found.value.current?.legId).toBe(replayedCorrection.legId)
      const effectiveAfter = yield* Effect.promise(loadLedger)
      const afterPrice = effectiveAfter.valuationFacts.filter(
        (fact) => fact._tag === "user_valuation"
      )
      expect(afterPrice).toHaveLength(1)
      expect(afterPrice[0]?.eventId).toBe(replayedCorrection.legId)
      expect(afterPrice[0]?.evidenceReference).toBe(`movement-price:${price.overrideId}`)
      expect(afterPrice[0]?.amount).toEqual(beforePrice[0]?.amount)
      expect(
        effectiveAfter.events.find((event) => event.id === replayedCorrection.legId)
      ).toMatchObject({ _tag: "acquisition", cause: "purchase" })
      for (const [old, current] of [
        [sibling, replayedSibling],
        [fee, replayedFee],
      ] as const) {
        const previous = effectiveBefore.events.find((event) => event.id === old.legId)
        const next = effectiveAfter.events.find((event) => event.id === current.legId)
        expect(next).toEqual(
          previous === undefined ? undefined : { ...previous, id: current.legId }
        )
      }
      yield* Effect.promise(() => recompute(replayRunId))
      const replayRun = yield* Effect.promise(() => readRun(replayRunId))
      expect(replayRun.inputs.map(({ captured }) => captured.history)).toEqual(
        firstRun.inputs.map(({ captured }) => captured.history)
      )
      expect(
        replayRun.inputs.every(
          ({ captured }) => captured.current?.legId === replayedCorrection.legId
        )
      ).toBe(true)
      const replayedLot = replayRun.lots.find((lot) => lot.eventId === replayedCorrection.legId)
      expect(replayedLot?.costBasisPerUnit).toBe(correctedLot?.costBasisPerUnit)
      expect(yield* Effect.promise(() => readRun(firstRunId))).toEqual(firstRun)
      const retainedRaw = yield* Effect.promise(() =>
        context.runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ id: schema.sourceRecordsRaw.id, payload: schema.sourceRecordsRaw.payload })
              .from(schema.sourceRecordsRaw)
              .where(eq(schema.sourceRecordsRaw.id, cached.id))
          })
        )
      )
      expect(retainedRaw).toEqual([reorderedCache])
    })
  )

  it.effect(
    "withholds an unidentified parsed movement with a review while the next source record continues",
    () =>
      Effect.gen(function* () {
        const withheld = yield* Effect.promise(() =>
          normalize({ recordKey: "synthetic-no-component", parsed: true })
        )
        expect(withheld.legs).toHaveLength(0)
        const review = yield* Effect.promise(() =>
          context.runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return yield* db
                .select({
                  reason: schema.transactionReviews.categorizationReason,
                  needsReview: schema.transactionReviews.needsReview,
                })
                .from(schema.transactionReviews)
                .where(eq(schema.transactionReviews.transactionId, withheld.transaction.id))
            })
          )
        )
        expect(review).toEqual([{ reason: "missing_movement_identity", needsReview: true }])
        const next = yield* Effect.promise(() => normalize({ recordKey: "synthetic-next-record" }))
        expect(next.legs).toHaveLength(3)
        expect(yield* Effect.promise(links)).toHaveLength(3)
      })
  )
  it.effect("withholds repeated source-native components instead of merging their identity", () =>
    Effect.gen(function* () {
      for (const amounts of [
        ["1000000", "1000000"],
        ["1000000", "0"],
        ["0", "1000000"],
      ]) {
        const result = yield* Effect.promise(() =>
          normalize({
            recordKey: `synthetic-duplicate-component-${amounts.join("-")}`,
            order: [1, 1],
            amounts,
          })
        )
        expect(result.legs).toHaveLength(0)
        const review = yield* Effect.promise(() =>
          context.runPg(
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
      }
    })
  )
})
