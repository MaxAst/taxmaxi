import { prepareMovementLegFixtures } from "../support/movement-leg-fixtures.ts"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { PrincipalId } from "@my/core/ownership"
import { eq } from "drizzle-orm"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import { HistoricalAssetPriceRepositoryLive } from "../../src/layers/HistoricalAssetPriceRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import { HistoricalAssetPriceRepository } from "../../src/services/HistoricalAssetPriceRepository.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_EUR_ASSET_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const TEST_PRINCIPAL_ID = PrincipalId.make("00000000-0000-4000-8000-000000000183")
const TEST_ONCHAIN_SOURCE_ID = "00000000-0000-4000-8000-000000000281"
const TEST_CEX_SOURCE_ID = "00000000-0000-4000-8000-000000000282"
const TEST_ADDRESS_ID = "00000000-0000-4000-8000-000000000283"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_historical_asset_price_repo",
})

const runPg = context.runPg

const runRepository = <A, E>(effect: Effect.Effect<A, E, HistoricalAssetPriceRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: HistoricalAssetPriceRepositoryLive }))

const utcDate = (value: string): Date => DateTime.toDateUtc(DateTime.makeUnsafe(value))

await Effect.runPromise(context.recreateTestDatabase())

describe("HistoricalAssetPriceRepositoryLive", () => {
  beforeEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* context.recreateTestDatabase()
        const fixture = yield* Effect.promise(() =>
          runPg(
            seedSyncEngineRepositoryFixture({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_CEX_SOURCE_ID,
            })
          )
        )
        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              yield* seedSyncEngineAssets({
                baseBlockchainId: fixture.baseBlockchainId,
                bitcoinBlockchainId: fixture.bitcoinBlockchainId,
              })
              const db = yield* drizzle
              yield* db.insert(schema.addresses).values({
                id: TEST_ADDRESS_ID,
                address: "HistoricalPrice11111111111111111111111111111",
                type: "solana",
                name: "Historical price fixture",
                principalId: TEST_PRINCIPAL_ID,
              })
              yield* db.insert(schema.sources).values({
                id: TEST_ONCHAIN_SOURCE_ID,
                principalId: TEST_PRINCIPAL_ID,
                name: "Historical price on-chain source",
                providerKey: "helius-solana",
                sourceableType: "onchain",
                addressId: TEST_ADDRESS_ID,
              })
            })
          )
        )
      })
    )
  )

  it.effect("lists each missing canonical on-chain asset UTC day once", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures([
                {
                  movementIdentity: {
                    sourceRecordKey: "historical-price-acquisition",
                    componentKey: "movement",
                  },
                  sourceId: TEST_ONCHAIN_SOURCE_ID,
                  externalId: "historical-price-acquisition",
                  timestamp: utcDate("2025-03-04T01:00:00.000Z"),
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "2",
                  kind: "acquisition",
                  provenance: "deterministic",
                  originKind: "none" as const,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "historical-price-income-same-day",
                    componentKey: "movement",
                  },
                  sourceId: TEST_ONCHAIN_SOURCE_ID,
                  externalId: "historical-price-income-same-day",
                  timestamp: utcDate("2025-03-04T23:59:59.000Z"),
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "1",
                  kind: "income",
                  provenance: "deterministic",
                  originKind: "none" as const,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "historical-price-disposition",
                    componentKey: "movement",
                  },
                  sourceId: TEST_ONCHAIN_SOURCE_ID,
                  externalId: "historical-price-disposition",
                  timestamp: utcDate("2025-03-05T12:00:00.000Z"),
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "1",
                  kind: "disposal",
                  provenance: "deterministic",
                  originKind: "none" as const,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "historical-price-no-coin-id",
                    componentKey: "movement",
                  },
                  sourceId: TEST_ONCHAIN_SOURCE_ID,
                  externalId: "historical-price-no-coin-id",
                  timestamp: utcDate("2025-03-04T12:00:00.000Z"),
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_EUR_ASSET_ID,
                  amount: "1",
                  kind: "fee",
                  provenance: "deterministic",
                  originKind: "none" as const,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "historical-price-cex",
                    componentKey: "movement",
                  },
                  sourceId: TEST_CEX_SOURCE_ID,
                  externalId: "historical-price-cex",
                  timestamp: utcDate("2025-03-06T12:00:00.000Z"),
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "1",
                  kind: "disposal",
                  provenance: "deterministic",
                  originKind: "none" as const,
                },
              ])
            )
            yield* db.insert(schema.assetPrices).values({
              assetId: TEST_BTC_ASSET_ID,
              timestamp: utcDate("2025-03-05T00:00:00.000Z"),
              price: "81000",
              currency: "EUR",
              source: "manual",
            })
          })
        )
      )

      const needs = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(HistoricalAssetPriceRepository, (repository) =>
            repository.listMissingCoinGeckoDailyEurPriceNeeds({
              principalId: TEST_PRINCIPAL_ID,
            })
          )
        )
      )

      expect(needs).toEqual([
        {
          assetId: TEST_BTC_ASSET_ID,
          coingeckoCoinId: "bitcoin",
          snapshotAt: utcDate("2025-03-04T00:00:00.000Z"),
        },
      ])
    })
  )

  it.effect("upserts one CoinGecko EUR row at the canonical asset-day key", () =>
    Effect.gen(function* () {
      const snapshotAt = utcDate("2025-03-04T00:00:00.000Z")
      const store = (price: string) =>
        runRepository(
          Effect.flatMap(HistoricalAssetPriceRepository, (repository) =>
            repository.upsertCoinGeckoDailyEurPrice({
              assetId: TEST_BTC_ASSET_ID,
              snapshotAt,
              price,
            })
          )
        )

      yield* Effect.promise(() => store("81000.125"))
      yield* Effect.promise(() => store("82000.25"))

      const rows = yield* Effect.promise(() =>
        runPg(
          Effect.flatMap(drizzle, (db) =>
            db
              .select({
                timestamp: schema.assetPrices.timestamp,
                price: schema.assetPrices.price,
                currency: schema.assetPrices.currency,
                source: schema.assetPrices.source,
              })
              .from(schema.assetPrices)
              .where(eq(schema.assetPrices.assetId, TEST_BTC_ASSET_ID))
          )
        )
      )

      expect(rows).toEqual([
        {
          timestamp: snapshotAt,
          price: "82000.250000000000000000",
          currency: "EUR",
          source: "coingecko",
        },
      ])
    })
  )

  it.effect("does not replace an existing canonical EUR quote from another source", () =>
    Effect.gen(function* () {
      const snapshotAt = utcDate("2025-03-04T00:00:00.000Z")

      yield* Effect.promise(() =>
        runPg(
          Effect.flatMap(drizzle, (db) =>
            db.insert(schema.assetPrices).values({
              assetId: TEST_BTC_ASSET_ID,
              timestamp: snapshotAt,
              price: "81000.125",
              currency: "EUR",
              source: "manual",
            })
          )
        )
      )

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(HistoricalAssetPriceRepository, (repository) =>
            repository.upsertCoinGeckoDailyEurPrice({
              assetId: TEST_BTC_ASSET_ID,
              snapshotAt,
              price: "82000.25",
            })
          )
        )
      )

      const rows = yield* Effect.promise(() =>
        runPg(
          Effect.flatMap(drizzle, (db) =>
            db
              .select({ price: schema.assetPrices.price, source: schema.assetPrices.source })
              .from(schema.assetPrices)
              .where(eq(schema.assetPrices.assetId, TEST_BTC_ASSET_ID))
          )
        )
      )

      expect(rows).toEqual([{ price: "81000.125000000000000000", source: "manual" }])
    })
  )
})
