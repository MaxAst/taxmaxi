import { beforeEach, describe, expect, it } from "@effect/vitest"
import {
  SourceNormalizationRepository,
  SourceRawRecordRepository,
  SourceReplayRepository,
} from "@my/sync-engine/services"
import { eq } from "drizzle-orm"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { SourceNormalizationRepositoryLive } from "../../src/layers/SourceNormalizationRepositoryLive.ts"
import { SourceRawRecordRepositoryLive } from "../../src/layers/SourceRawRecordRepositoryLive.ts"
import { SourceReplayRepositoryLive } from "../../src/layers/SourceReplayRepositoryLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_PRINCIPAL_ID,
  TEST_RAW_RECORD_ID,
  TEST_SOURCE_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
  type SyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_source_replay_repo",
})

const runPg = context.runPg

await Effect.runPromise(context.recreateTestDatabase())

const runNormalization = <A, E>(effect: Effect.Effect<A, E, SourceNormalizationRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: SourceNormalizationRepositoryLive }))

const runRawRepository = <A, E>(effect: Effect.Effect<A, E, SourceRawRecordRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: SourceRawRecordRepositoryLive }))

const runReplayRepository = <A, E>(effect: Effect.Effect<A, E, SourceReplayRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: SourceReplayRepositoryLive }))

const seedReplayRawRecord = () =>
  Effect.gen(function* () {
    const db = yield* drizzle
    yield* db.insert(schema.sourceRecordsRaw).values({
      id: TEST_RAW_RECORD_ID,
      sourceId: TEST_SOURCE_ID,
      provider: "coinbase",
      recordType: "coinbase_transaction",
      externalAccountId: "coinbase-account-1",
      externalRecordId: "raw-replay-1",
      externalParentId: null,
      occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
      payload: { id: "raw-replay-1" },
      importedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
      createdAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
      updatedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
    })
  })

describe("SourceReplayRepositoryLive", () => {
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
        yield* Effect.promise(() => runPg(seedReplayRawRecord()))
      })
    )
  )

  it.effect("clears canonical source-derived rows while keeping cached raw rows reusable", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runNormalization(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts({
              transaction: {
                sourceId: TEST_SOURCE_ID,
                sourceRawRecordId: TEST_RAW_RECORD_ID,
                externalId: "tx-replay-1",
                externalGroupId: "group-replay-1",
                timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
                transactionType: "buy_fiat",
                providerTransactionType: "buy",
                providerStatus: "completed",
                providerResourcePath: "/v2/accounts/coinbase-account-1/transactions/tx-replay-1",
                providerDescription: "Replay seed buy",
                providerCreatedAt: DateTime.toDateUtc(
                  DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")
                ),
                providerUpdatedAt: DateTime.toDateUtc(
                  DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")
                ),
                metadata: { provider: "coinbase" },
                providerFiatAmount: null,
                providerFiatCurrency: null,
                principalId: TEST_PRINCIPAL_ID,
              },
              venueContext: {
                venueType: "cex",
                cexAccountId: fixture.cexAccountId,
                externalAccountId: "coinbase-account-1",
                externalOrderId: "order-replay-1",
                externalFillId: "fill-replay-1",
                side: "buy",
                instrument: "BTC-EUR",
                fillPrice: "10000.00",
                commissionAmount: null,
                commissionCurrency: null,
                metadata: { provider: "coinbase" },
              },
              providerTransfers: [],
              canonicalTransfers: [],
              providerAssetRowIds: [],
              legs: [
                {
                  movementIdentity: {
                    _tag: "identified" as const,
                    sourceRecordKey: "leg-replay-1",
                    componentKey: "movement",
                  },
                  sourceId: TEST_SOURCE_ID,
                  sourceRawRecordId: TEST_RAW_RECORD_ID,
                  externalId: "leg-replay-1",
                  txHash: null,
                  timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T10:00:00.000Z")),
                  principalId: TEST_PRINCIPAL_ID,
                  addressId: null,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "1.00000000",
                  kind: "acquisition",
                  provenance: "deterministic",
                  derivationRule: "spot_buy",
                  metadata: { provider: "coinbase" },
                  transactionId: null,
                  originKind: "none",
                  sourceTransferId: null,
                  fiatAmount: "10000.00000000",
                  fiatCurrency: "EUR",
                  feeForTransactionId: null,
                },
              ],
              transactionReview: {
                principalId: TEST_PRINCIPAL_ID,
                reviewStatus: "needs_review",
                originalTypeKey: "buy_fiat",
                originalConfidence: "0.80",
                currentTypeKey: "buy_fiat",
                legalRuleSetVersion: "de-2025-01",
                categorizationReason: "Replay fixture review",
                matchedLayer: "fixture",
                needsReview: true,
                userNotes: null,
                reviewedAt: null,
              },
              resolvedTransactionType: {
                providerTransactionType: "buy",
                transactionType: "buy_fiat",
                inventoryEffect: "acquisition",
                taxTreatment: "non_taxable_by_default",
                resolutionStrategy: "static",
                pairedRecordRequired: false,
                mappingStatus: "approved",
              },
            })
          )
        )
      )

      yield* Effect.promise(() =>
        runRawRepository(
          Effect.flatMap(SourceRawRecordRepository, (repository) =>
            repository.markRawRecordNormalized({ rawRecordId: TEST_RAW_RECORD_ID })
          )
        )
      )

      yield* Effect.promise(() =>
        runReplayRepository(
          Effect.flatMap(SourceReplayRepository, (repository) =>
            repository.resetSourceDerivedState({ sourceId: TEST_SOURCE_ID })
          )
        )
      )

      yield* Effect.promise(() =>
        runRawRepository(
          Effect.flatMap(SourceRawRecordRepository, (repository) =>
            repository.resetNormalizationStateForSource({ sourceId: TEST_SOURCE_ID })
          )
        )
      )

      const snapshot = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const transactions = yield* db
              .select()
              .from(schema.transactions)
              .where(eq(schema.transactions.sourceId, TEST_SOURCE_ID))
            const transfers = yield* db
              .select()
              .from(schema.transfers)
              .where(eq(schema.transfers.sourceId, TEST_SOURCE_ID))
            const legs = yield* db
              .select()
              .from(schema.transactionLegs)
              .where(eq(schema.transactionLegs.sourceId, TEST_SOURCE_ID))
            const reviews = yield* db.select().from(schema.transactionReviews)
            const rawRows = yield* db
              .select()
              .from(schema.sourceRecordsRaw)
              .where(eq(schema.sourceRecordsRaw.sourceId, TEST_SOURCE_ID))
            return { transactions, transfers, legs, reviews, rawRows }
          })
        )
      )

      expect(snapshot.transactions).toHaveLength(0)
      expect(snapshot.transfers).toHaveLength(0)
      expect(snapshot.legs).toHaveLength(0)
      expect(snapshot.reviews).toHaveLength(0)
      expect(snapshot.rawRows).toHaveLength(1)
      expect(snapshot.rawRows[0]?.externalRecordId).toBe("raw-replay-1")
      expect(snapshot.rawRows[0]?.normalizedAt).toBeNull()
      expect(snapshot.rawRows[0]?.normalizationError).toBeNull()
    })
  )
})
