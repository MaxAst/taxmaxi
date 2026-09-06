import { seedMovementLegs } from "../support/movement-leg-fixtures.ts"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { eq } from "drizzle-orm"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_BTC_REPRESENTATION_ID,
  TEST_PRINCIPAL_ID,
  TEST_SOURCE_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const TRANSACTION_ID = "00000000-0000-4000-8000-000000001001"
const PROVIDER_TRANSFER_ID = "00000000-0000-4000-8000-000000001002"
const TRANSFER_ID = "00000000-0000-4000-8000-000000001003"
const LEG_ID = "00000000-0000-4000-8000-000000001004"
const REPRESENTATION_USE_ID = "00000000-0000-4000-8000-000000001005"
const PROVIDER_ASSET_ROW_ID = "00000000-0000-4000-8000-000000001006"
const OTHER_USER_ID = "00000000-0000-4000-8000-000000001007"
const OTHER_PRINCIPAL_ID = "00000000-0000-4000-8000-000000001008"
const OTHER_SOURCE_ID = "00000000-0000-4000-8000-000000001009"
const OTHER_REPRESENTATION_USE_ID = "00000000-0000-4000-8000-000000001010"
const MISSING_REPRESENTATION_USE_ID = "00000000-0000-4000-8000-000000001011"
const MISSING_PROVIDER_ASSET_ROW_ID = "00000000-0000-4000-8000-000000001012"
const RECONCILIATION_ID = "00000000-0000-4000-8000-000000001016"
const OCCURRED_AT = DateTime.toDateUtc(DateTime.makeUnsafe("2025-05-01T10:00:00.000Z"))

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_fact_target_links_schema",
})

const runPg = context.runPg
let bitcoinBlockchainId = ""

await Effect.runPromise(context.recreateTestDatabase())

const insertTransaction = () =>
  Effect.gen(function* () {
    const db = yield* drizzle
    yield* db.insert(schema.transactions).values({
      id: TRANSACTION_ID,
      sourceId: TEST_SOURCE_ID,
      externalId: "fact-target-links",
      timestamp: OCCURRED_AT,
      principalId: TEST_PRINCIPAL_ID,
    })
  })

const providerTransferValues = (sourceRepresentationUseId: string) => ({
  id: PROVIDER_TRANSFER_ID,
  sourceId: TEST_SOURCE_ID,
  transactionId: TRANSACTION_ID,
  externalId: "fact-target-provider-transfer",
  providerAssetId: PROVIDER_ASSET_ROW_ID,
  sourceRepresentationUseId,
  timestamp: OCCURRED_AT,
  direction: "inbound" as const,
  processingMode: "accounting_and_evidence" as const,
  fromAccountRef: "external-account",
  toAccountRef: "owned-account",
  observedBlockchainId: bitcoinBlockchainId,
  observedRepresentationType: "token" as const,
  observedContractAddress: "fact-target-btc",
  observedMintAddress: null,
  observedDecimals: null,
  amount: "1",
})

const transferValues = ({
  id = TRANSFER_ID,
  sourceRepresentationUseId = REPRESENTATION_USE_ID,
  providerAssetRowId = PROVIDER_ASSET_ROW_ID,
}: {
  readonly id?: string
  readonly sourceRepresentationUseId?: string
  readonly providerAssetRowId?: string
} = {}) => ({
  id,
  sourceId: TEST_SOURCE_ID,
  principalId: TEST_PRINCIPAL_ID,
  externalId: `fact-target-transfer-${id}`,
  timestamp: OCCURRED_AT,
  type: "cex" as const,
  fromAccountRef: "external-account",
  toAccountRef: "owned-account",
  assetId: TEST_BTC_ASSET_ID,
  assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
  sourceRepresentationUseId,
  providerAssetRowId,
  amount: "1",
})

const legValues = ({
  id = LEG_ID,
  sourceRepresentationUseId = REPRESENTATION_USE_ID,
  providerAssetRowId = PROVIDER_ASSET_ROW_ID,
  sourceTransferId = TRANSFER_ID,
}: {
  readonly id?: string
  readonly sourceRepresentationUseId?: string
  readonly providerAssetRowId?: string
  readonly sourceTransferId?: string | null
} = {}) => ({
  movementIdentity: {
    _tag: "identified" as const,
    sourceRecordKey: "fact-target-record",
    componentKey: "movement",
  },
  id,
  sourceId: TEST_SOURCE_ID,
  externalId: `fact-target-leg-${id}`,
  timestamp: OCCURRED_AT,
  principalId: TEST_PRINCIPAL_ID,
  assetId: TEST_BTC_ASSET_ID,
  assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
  sourceRepresentationUseId,
  providerAssetRowId,
  amount: "1",
  kind: "acquisition" as const,
  provenance: "deterministic" as const,
  originKind: sourceTransferId === null ? ("none" as const) : ("canonical_transfer" as const),
  transactionId: TRANSACTION_ID,
  sourceTransferId,
})

beforeEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* context.recreateTestDatabase()
      const fixture = yield* Effect.promise(() => runPg(seedSyncEngineRepositoryFixture()))
      bitcoinBlockchainId = fixture.bitcoinBlockchainId
      yield* Effect.promise(() => runPg(seedSyncEngineAssets(fixture)))
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.providerAssets).values({
              id: PROVIDER_ASSET_ROW_ID,
              provider: "coinbase",
              providerAssetId: "fact-target-provider-asset",
              currencyCode: "BTC",
              providerType: "crypto",
              exponent: 8,
              retrievedAt: OCCURRED_AT,
            })
            yield* db.insert(schema.sourceRepresentationUses).values({
              id: REPRESENTATION_USE_ID,
              sourceId: TEST_SOURCE_ID,
              blockchainId: fixture.bitcoinBlockchainId,
              representationType: "token",
              contractAddress: "fact-target-btc",
              mintAddress: null,
            })
            yield* insertTransaction()
          })
        )
      )
    })
  )
)

describe("fact target link schema", () => {
  it.effect("stores exact-use and provider-row links that custody origins can follow", () =>
    Effect.promise(() =>
      runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .insert(schema.providerTransfers)
            .values(providerTransferValues(REPRESENTATION_USE_ID))
          yield* db.insert(schema.transfers).values(transferValues())
          yield* db.insert(schema.transactionLegs).values(yield* seedMovementLegs([legValues()]))
          yield* db.insert(schema.transferReconciliations).values({
            id: RECONCILIATION_ID,
            principalId: TEST_PRINCIPAL_ID,
            providerTransferId: PROVIDER_TRANSFER_ID,
            canonicalTransferId: TRANSFER_ID,
            canonicalTransactionId: TRANSACTION_ID,
            status: "auto_applied",
            matchReason: "same recorded source fact",
            confidence: "1",
            deterministic: true,
          })
          yield* db.insert(schema.inventoryMovements).values([
            {
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
              transactionId: TRANSACTION_ID,
              providerTransferId: PROVIDER_TRANSFER_ID,
              assetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
              timestamp: OCCURRED_AT,
              direction: "inbound",
              purpose: "principal",
              taxTreatment: "pending_review",
              reconciliationStatus: "unmatched",
              amount: "1",
            },
            {
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
              transactionId: TRANSACTION_ID,
              transactionLegId: LEG_ID,
              assetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
              timestamp: OCCURRED_AT,
              direction: "outbound",
              purpose: "fee",
              taxTreatment: "pending_review",
              reconciliationStatus: "unmatched",
              amount: "0.1",
            },
          ])

          const [providerTransfer] = yield* db
            .select({
              sourceRepresentationUseId: schema.providerTransfers.sourceRepresentationUseId,
              providerAssetRowId: schema.providerTransfers.providerAssetId,
            })
            .from(schema.providerTransfers)
            .where(eq(schema.providerTransfers.id, PROVIDER_TRANSFER_ID))
          const [transfer] = yield* db
            .select({
              sourceRepresentationUseId: schema.transfers.sourceRepresentationUseId,
              providerAssetRowId: schema.transfers.providerAssetRowId,
            })
            .from(schema.transfers)
            .where(eq(schema.transfers.id, TRANSFER_ID))
          const [leg] = yield* db
            .select({
              sourceRepresentationUseId: schema.transactionLegs.sourceRepresentationUseId,
              providerAssetRowId: schema.transactionLegs.providerAssetRowId,
            })
            .from(schema.transactionLegs)
            .where(eq(schema.transactionLegs.id, LEG_ID))
          const custodyOrigins = yield* db
            .select({
              providerTransferId: schema.inventoryMovements.providerTransferId,
              transactionLegId: schema.inventoryMovements.transactionLegId,
            })
            .from(schema.inventoryMovements)
          const [reconciledTarget] = yield* db
            .select({
              providerRepresentationUseId: schema.providerTransfers.sourceRepresentationUseId,
              canonicalRepresentationUseId: schema.transfers.sourceRepresentationUseId,
              providerAssetRowId: schema.providerTransfers.providerAssetId,
              canonicalProviderAssetRowId: schema.transfers.providerAssetRowId,
            })
            .from(schema.transferReconciliations)
            .innerJoin(
              schema.providerTransfers,
              eq(schema.providerTransfers.id, schema.transferReconciliations.providerTransferId)
            )
            .innerJoin(
              schema.transfers,
              eq(schema.transfers.id, schema.transferReconciliations.canonicalTransferId)
            )
            .where(eq(schema.transferReconciliations.id, RECONCILIATION_ID))

          expect(providerTransfer).toEqual({
            sourceRepresentationUseId: REPRESENTATION_USE_ID,
            providerAssetRowId: PROVIDER_ASSET_ROW_ID,
          })
          expect(transfer).toEqual(providerTransfer)
          expect(leg).toEqual(providerTransfer)
          expect(custodyOrigins).toEqual(
            expect.arrayContaining([
              { providerTransferId: PROVIDER_TRANSFER_ID, transactionLegId: null },
              { providerTransferId: null, transactionLegId: LEG_ID },
            ])
          )
          expect(reconciledTarget).toEqual({
            providerRepresentationUseId: REPRESENTATION_USE_ID,
            canonicalRepresentationUseId: REPRESENTATION_USE_ID,
            providerAssetRowId: PROVIDER_ASSET_ROW_ID,
            canonicalProviderAssetRowId: PROVIDER_ASSET_ROW_ID,
          })
        })
      )
    )
  )

  it.effect("rejects a representation use owned by another source", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const other = yield* seedSyncEngineRepositoryFixture({
              userId: OTHER_USER_ID,
              principalId: OTHER_PRINCIPAL_ID,
              sourceId: OTHER_SOURCE_ID,
            })
            const db = yield* drizzle
            yield* db.insert(schema.sourceRepresentationUses).values({
              id: OTHER_REPRESENTATION_USE_ID,
              sourceId: OTHER_SOURCE_ID,
              blockchainId: other.bitcoinBlockchainId,
              representationType: "token",
              contractAddress: "other-source-btc",
              mintAddress: null,
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
                .insert(schema.providerTransfers)
                .values(providerTransferValues(OTHER_REPRESENTATION_USE_ID))
            })
          )
        ).rejects.toThrow()
      )
      yield* Effect.promise(() =>
        expect(
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db.insert(schema.transfers).values(
                transferValues({
                  id: "00000000-0000-4000-8000-000000001013",
                  sourceRepresentationUseId: OTHER_REPRESENTATION_USE_ID,
                })
              )
            })
          )
        ).rejects.toThrow()
      )
      yield* Effect.promise(() =>
        expect(
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db.insert(schema.transactionLegs).values(
                yield* seedMovementLegs([
                  legValues({
                    id: "00000000-0000-4000-8000-000000001014",
                    sourceRepresentationUseId: OTHER_REPRESENTATION_USE_ID,
                    sourceTransferId: null,
                  }),
                ])
              )
            })
          )
        ).rejects.toThrow()
      )
    })
  )

  it.effect("rejects missing target rows and keeps an exact link after provider-row deletion", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        expect(
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db
                .insert(schema.providerTransfers)
                .values(providerTransferValues(MISSING_REPRESENTATION_USE_ID))
            })
          )
        ).rejects.toThrow()
      )
      yield* Effect.promise(() =>
        expect(
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db.insert(schema.transfers).values(
                transferValues({
                  id: "00000000-0000-4000-8000-000000001015",
                  providerAssetRowId: MISSING_PROVIDER_ASSET_ROW_ID,
                })
              )
            })
          )
        ).rejects.toThrow()
      )

      const remainingExactLink = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.transfers).values(transferValues())
            yield* db
              .delete(schema.providerAssets)
              .where(eq(schema.providerAssets.id, PROVIDER_ASSET_ROW_ID))

            const [stored] = yield* db
              .select({
                sourceRepresentationUseId: schema.transfers.sourceRepresentationUseId,
                providerAssetRowId: schema.transfers.providerAssetRowId,
              })
              .from(schema.transfers)
              .where(eq(schema.transfers.id, TRANSFER_ID))

            return stored
          })
        )
      )

      expect(remainingExactLink).toEqual({
        sourceRepresentationUseId: REPRESENTATION_USE_ID,
        providerAssetRowId: null,
      })
    })
  )
})
