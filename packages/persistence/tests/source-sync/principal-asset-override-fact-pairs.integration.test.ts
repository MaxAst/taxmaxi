import { prepareMovementLegFixtures } from "../support/movement-leg-fixtures.ts"
import { PgClient } from "@effect/sql-pg"
import { eq } from "drizzle-orm"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { SourceNormalizationRepositoryLive } from "../../src/layers/SourceNormalizationRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import { SourceNormalizationRepository } from "@my/sync-engine/services"
import {
  TEST_BTC_ASSET_ID,
  TEST_BTC_REPRESENTATION_ID,
  TEST_EUR_ASSET_ID,
  TEST_PRINCIPAL_ID,
  TEST_SOURCE_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_principal_override_fact_pairs",
})

const runPg = context.runPg
const runRepository = <A, E>(effect: Effect.Effect<A, E, SourceNormalizationRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: SourceNormalizationRepositoryLive }))

const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-05-01T10:00:00.000Z"))
const missingAssetId = "00000000-0000-4000-8000-000000009991"
const missingRepresentationId = "00000000-0000-4000-8000-000000009992"

const makeTransfer = ({
  assetId = TEST_BTC_ASSET_ID,
  assetRepresentationId = TEST_BTC_REPRESENTATION_ID,
  externalId = "fact-pair-transfer",
}: {
  readonly assetId?: string
  readonly assetRepresentationId?: string
  readonly externalId?: string
} = {}) => ({
  sourceId: TEST_SOURCE_ID,
  sourceRawRecordId: null,
  principalId: TEST_PRINCIPAL_ID,
  externalId,
  externalGroupId: null,
  addressId: null,
  blockchainId: null,
  txHash: null,
  timestamp: occurredAt,
  type: "cex" as const,
  fromAddress: null,
  toAddress: null,
  fromAccountRef: "external-account",
  toAccountRef: "owned-account",
  fromPartyType: null,
  fromPartyResourcePath: null,
  toPartyType: null,
  toPartyResourcePath: null,
  assetId,
  assetRepresentationId,
  amount: "1",
  tokenId: null,
  notes: null,
  metadata: null,
})

const makeLeg = ({
  assetId = TEST_BTC_ASSET_ID,
  assetRepresentationId = TEST_BTC_REPRESENTATION_ID,
  externalId = "fact-pair-leg",
}: {
  readonly assetId?: string
  readonly assetRepresentationId?: string
  readonly externalId?: string
} = {}) => ({
  movementIdentity: {
    _tag: "identified" as const,
    sourceRecordKey: externalId,
    componentKey: "movement",
  },
  sourceId: TEST_SOURCE_ID,
  sourceRawRecordId: null,
  externalId,
  txHash: null,
  timestamp: occurredAt,
  principalId: TEST_PRINCIPAL_ID,
  addressId: null,
  assetId,
  assetRepresentationId,
  amount: "1",
  kind: "acquisition" as const,
  provenance: "deterministic" as const,
  originKind: "none" as const,
  derivationRule: "test_catalog_identity",
  metadata: null,
  transactionId: null,
  sourceTransferId: null,
  fiatAmount: null,
  fiatCurrency: null,
  feeForTransactionId: null,
})

await Effect.runPromise(context.recreateTestDatabase())

beforeEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* context.recreateTestDatabase()
      const fixture = yield* Effect.promise(() => runPg(seedSyncEngineRepositoryFixture()))
      yield* Effect.promise(() => runPg(seedSyncEngineAssets(fixture)))
    })
  )
)

describe("principal asset override fact pairs", () => {
  it.effect("accepts an override-selected asset with the original representation", () =>
    Effect.gen(function* () {
      const inserted = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [transfer] = yield* db
              .insert(schema.transfers)
              .values(
                makeTransfer({
                  assetId: TEST_EUR_ASSET_ID,
                  externalId: "override-pair-transfer",
                })
              )
              .returning({
                assetId: schema.transfers.assetId,
                assetRepresentationId: schema.transfers.assetRepresentationId,
              })
            const [leg] = yield* db
              .insert(schema.transactionLegs)
              .values(
                yield* prepareMovementLegFixtures([
                  makeLeg({
                    assetId: TEST_EUR_ASSET_ID,
                    externalId: "override-pair-leg",
                  }),
                ])
              )
              .returning({
                assetId: schema.transactionLegs.assetId,
                assetRepresentationId: schema.transactionLegs.assetRepresentationId,
              })

            return { transfer, leg }
          })
        )
      )

      expect(inserted).toEqual({
        transfer: {
          assetId: TEST_EUR_ASSET_ID,
          assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
        },
        leg: {
          assetId: TEST_EUR_ASSET_ID,
          assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
        },
      })
    })
  )

  it.effect("keeps independent asset and representation existence checks", () =>
    Effect.gen(function* () {
      const insertTransfer = (assetId: string, assetRepresentationId: string, externalId: string) =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .insert(schema.transfers)
              .values(makeTransfer({ assetId, assetRepresentationId, externalId }))
          })
        )

      const insertLeg = (assetId: string, assetRepresentationId: string, externalId: string) =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .insert(schema.transactionLegs)
              .values(
                yield* prepareMovementLegFixtures([
                  makeLeg({ assetId, assetRepresentationId, externalId }),
                ])
              )
          })
        )

      yield* Effect.promise(() =>
        expect(
          insertTransfer(missingAssetId, TEST_BTC_REPRESENTATION_ID, "missing-transfer-asset")
        ).rejects.toThrow()
      )
      yield* Effect.promise(() =>
        expect(
          insertTransfer(TEST_BTC_ASSET_ID, missingRepresentationId, "missing-transfer-repr")
        ).rejects.toThrow()
      )
      yield* Effect.promise(() =>
        expect(
          insertLeg(missingAssetId, TEST_BTC_REPRESENTATION_ID, "missing-leg-asset")
        ).rejects.toThrow()
      )
      yield* Effect.promise(() =>
        expect(
          insertLeg(TEST_BTC_ASSET_ID, missingRepresentationId, "missing-leg-repr")
        ).rejects.toThrow()
      )
    })
  )

  it.effect("keeps normal source-fact writes aligned with the global catalog", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runRepository(
          SourceNormalizationRepository.pipe(
            Effect.flatMap((repository) =>
              repository.persistNormalizedArtifacts({
                transaction: {
                  sourceId: TEST_SOURCE_ID,
                  sourceRawRecordId: null,
                  externalId: "normal-catalog-pair-transaction",
                  externalGroupId: null,
                  timestamp: occurredAt,
                  transactionType: "buy_fiat",
                  providerTransactionType: "buy",
                  providerStatus: "pending",
                  providerResourcePath: null,
                  providerDescription: "Normal catalog pair fixture",
                  providerCreatedAt: occurredAt,
                  providerUpdatedAt: occurredAt,
                  metadata: null,
                  providerFiatAmount: null,
                  providerFiatCurrency: null,
                  principalId: TEST_PRINCIPAL_ID,
                },
                venueContext: {
                  venueType: "cex",
                  cexAccountId: null,
                  externalAccountId: "owned-account",
                  externalOrderId: null,
                  externalFillId: null,
                  side: "buy",
                  instrument: "BTC-EUR",
                  fillPrice: "10000",
                  commissionAmount: null,
                  commissionCurrency: null,
                  metadata: null,
                },
                providerTransfers: [],
                canonicalTransfers: [makeTransfer({ externalId: "normal-catalog-transfer" })],
                providerAssetRowIds: [],
                legs: [makeLeg({ externalId: "normal-catalog-leg" })],
                transactionReview: null,
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
      )

      const [catalogRepresentation] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ assetId: schema.assetRepresentations.assetId })
              .from(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
          })
        )
      )

      expect(catalogRepresentation).toEqual({ assetId: TEST_BTC_ASSET_ID })
      expect(result.canonicalTransfers).toEqual([
        expect.objectContaining({
          assetId: catalogRepresentation?.assetId,
          assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
        }),
      ])
      expect(result.legs).toEqual([
        expect.objectContaining({
          assetId: catalogRepresentation?.assetId,
          assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
        }),
      ])
    })
  )

  it.effect("leaves global mapping and inventory pair constraints in place", () =>
    Effect.gen(function* () {
      const constraints = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const client = yield* PgClient.PgClient
            return yield* client<{
              readonly constraintName: string
              readonly definition: string
            }>`
              select conname as "constraintName", pg_get_constraintdef(oid) as definition
              from pg_constraint
              where conname in (
                'provider_asset_mappings_representation_matches_asset_fk',
                'inventory_movements_representation_matches_asset_fk',
                'transfers_asset_representation_fk',
                'transaction_legs_asset_representation_fk',
                'transfers_representation_matches_asset_fk',
                'transaction_legs_representation_matches_asset_fk'
              )
              order by conname
            `
          })
        )
      )

      expect(constraints).toEqual([
        expect.objectContaining({
          constraintName: "inventory_movements_representation_matches_asset_fk",
          definition: expect.stringContaining("FOREIGN KEY (asset_id, asset_representation_id)"),
        }),
        expect.objectContaining({
          constraintName: "provider_asset_mappings_representation_matches_asset_fk",
          definition: expect.stringContaining(
            "FOREIGN KEY (canonical_asset_id, asset_representation_id)"
          ),
        }),
        expect.objectContaining({
          constraintName: "transaction_legs_asset_representation_fk",
          definition: expect.stringContaining("FOREIGN KEY (asset_representation_id)"),
        }),
        expect.objectContaining({
          constraintName: "transfers_asset_representation_fk",
          definition: expect.stringContaining("FOREIGN KEY (asset_representation_id)"),
        }),
      ])
    })
  )
})
