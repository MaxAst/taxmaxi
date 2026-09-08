import { prepareMovementLegFixtures } from "../support/movement-leg-fixtures.ts"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { JurisdictionCode, TaxYear } from "@my/core/accounting"
import { CurrencyCode } from "@my/core/currency"
import { PrincipalId } from "@my/core/ownership"
import { SourceNormalizationRepository, SourceReplayRepository } from "@my/sync-engine/services"
import { eq } from "drizzle-orm"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { CalculationRunRepositoryLive } from "../../src/layers/CalculationRunRepositoryLive.ts"
import { CalculationRunServiceLive } from "../../src/layers/CalculationRunServiceLive.ts"
import { FactualLedgerRepositoryLive } from "../../src/layers/FactualLedgerRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { SourceReplayRepositoryLive } from "../../src/layers/SourceReplayRepositoryLive.ts"
import { SourceNormalizationRepositoryLive } from "../../src/layers/SourceNormalizationRepositoryLive.ts"
import { schema } from "../../src/schema/index.ts"
import { PersistenceError } from "../../src/errors/RepositoryError.ts"
import {
  CalculationRunId,
  CalculationRunRepository,
  type CalculationRunRepositoryShape,
} from "../../src/services/CalculationRunRepository.ts"
import { CalculationRunService } from "../../src/services/CalculationRunService.ts"
import { FactualLedgerRepository } from "../../src/services/FactualLedgerRepository.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_BTC_REPRESENTATION_ID,
  TEST_USER_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const PRINCIPAL_ID = PrincipalId.make("00000000-0000-4000-8000-000000000183")
const SOURCE_ID = "00000000-0000-4000-8000-000000000281"
const SOURCE_USE_ID = "00000000-0000-4000-8000-000000000291"
const REPLACEMENT_ASSET_ID = "00000000-0000-4000-8000-000000000483"
const INCLUDED_PROVIDER_ASSET_ID = "00000000-0000-4000-8000-000000000721"
const BLOCKED_PROVIDER_ASSET_ID = "00000000-0000-4000-8000-000000000722"
const UNRESOLVED_PROVIDER_ASSET_ID = "00000000-0000-4000-8000-000000000723"
const EUR = CurrencyCode.make("EUR")

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_principal_override_application",
})

const runPg = context.runPg

const runFactualLedger = <A, E>(effect: Effect.Effect<A, E, FactualLedgerRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: FactualLedgerRepositoryLive }))

const runSourceNormalization = <A, E>(effect: Effect.Effect<A, E, SourceNormalizationRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: SourceNormalizationRepositoryLive }))

const loadLedger = () =>
  runFactualLedger(
    Effect.flatMap(FactualLedgerRepository, (repository) =>
      repository.load({ principalId: PRINCIPAL_ID, reportingCurrency: EUR })
    )
  )

const CalculationRunServiceTestLive = CalculationRunServiceLive.pipe(
  Layer.provide(Layer.merge(CalculationRunRepositoryLive, FactualLedgerRepositoryLive))
)

const calculationRunServiceWithPersist = (
  makePersist: (
    repository: CalculationRunRepositoryShape
  ) => CalculationRunRepositoryShape["persist"]
) => {
  const repositoryLive = Layer.effect(
    CalculationRunRepository,
    Effect.map(CalculationRunRepository, (repository) =>
      CalculationRunRepository.of({
        fail: repository.fail,
        getLatestStatus: repository.getLatestStatus,
        getSyncStatus: repository.getSyncStatus,
        listActiveTaxYears: repository.listActiveTaxYears,
        persist: makePersist(repository),
        settleStaleAndFindRecomputePrincipals: repository.settleStaleAndFindRecomputePrincipals,
        start: repository.start,
      })
    )
  ).pipe(Layer.provide(CalculationRunRepositoryLive))

  return CalculationRunServiceLive.pipe(
    Layer.provide(Layer.merge(repositoryLive, FactualLedgerRepositoryLive))
  )
}

const recomputeEffect = (id: string, taxYear = 2025) =>
  Effect.flatMap(CalculationRunService, (service) =>
    service.recompute({
      id: CalculationRunId.make(id),
      principalId: PRINCIPAL_ID,
      jurisdiction: JurisdictionCode.make("DE"),
      taxYear: TaxYear.make(taxYear),
      reportingCurrency: EUR,
      accountingChoices: [],
    })
  )

const recompute = (id: string, taxYear = 2025) =>
  Effect.runPromise(
    context.runWithLayer({
      effect: recomputeEffect(id, taxYear),
      layer: CalculationRunServiceTestLive,
    })
  )

const createOverride = ({
  kind,
  providerAssetRowId,
  replacementAssetId,
  replacementInclusion,
}: {
  readonly kind: "identity" | "inclusion"
  readonly providerAssetRowId: string
  readonly replacementAssetId?: string
  readonly replacementInclusion?: "included" | "excluded"
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [target] = yield* db
      .insert(schema.principalAssetOverrideTargets)
      .values({
        principalId: PRINCIPAL_ID,
        targetKind: "provider_asset",
        providerAssetRowId,
      })
      .returning({ id: schema.principalAssetOverrideTargets.id })
    if (target === undefined) return yield* Effect.die("Failed to create override target")

    yield* db.insert(schema.principalAssetOverrides).values({
      principalId: PRINCIPAL_ID,
      targetId: target.id,
      kind,
      operation: "create",
      inspectedSystemRevision: `application-${providerAssetRowId}-${kind}`,
      inspectedSystemIdentity: kind === "identity" ? "unresolved" : undefined,
      inspectedSystemInclusion: kind === "inclusion" ? "included" : undefined,
      replacementAssetId,
      replacementInclusion,
      actorUserId: TEST_USER_ID,
      reason: "Exercise the fact adapter override decision",
    })
  })

const seedProviderAsset = ({
  canonicalAssetId = TEST_BTC_ASSET_ID,
  exponent = 8,
  id,
  mappingStatus = "approved",
  providerType = "crypto",
}: {
  readonly canonicalAssetId?: string | null
  readonly exponent?: number | null
  readonly id: string
  readonly mappingStatus?: "approved" | "excluded"
  readonly providerType?: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T10:00:00.000Z"))
    yield* db.insert(schema.providerAssets).values({
      id,
      provider: "coinbase",
      providerAssetId: `application-${id}`,
      currencyCode: "APP",
      name: "Application asset",
      exponent,
      providerType,
      rawProviderPayload: { asset_id: id },
      evidenceRevision: 1,
      discoveredAt: occurredAt,
      retrievedAt: occurredAt,
    })
    if (canonicalAssetId === null) return

    yield* db.insert(schema.providerAssetMappings).values({
      providerAssetRowId: id,
      mappingKind: "asset",
      canonicalAssetId,
      mappingStatus,
    })
  })

const seedProviderTransaction = ({
  externalId,
  inventoryAssetId = TEST_BTC_ASSET_ID,
  legId,
  occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T10:00:00.000Z")),
  providerAssetRowId,
  sourceRepresentationUseId,
}: {
  readonly externalId: string
  readonly inventoryAssetId?: string | null
  readonly legId?: string
  readonly occurredAt?: Date
  readonly providerAssetRowId: string
  readonly sourceRepresentationUseId?: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [rawRecord] = yield* db
      .insert(schema.sourceRecordsRaw)
      .values({
        sourceId: SOURCE_ID,
        provider: "coinbase",
        recordType: "transaction",
        externalRecordId: `${externalId}-raw`,
        occurredAt,
        payload: { id: externalId },
      })
      .returning({ id: schema.sourceRecordsRaw.id })
    if (rawRecord === undefined) return yield* Effect.die("Failed to create raw record")
    const [transaction] = yield* db
      .insert(schema.transactions)
      .values({
        sourceId: SOURCE_ID,
        sourceRawRecordId: rawRecord.id,
        externalId,
        timestamp: occurredAt,
        transactionType: "buy_fiat",
        principalId: PRINCIPAL_ID,
      })
      .returning({ id: schema.transactions.id })
    if (transaction === undefined) return yield* Effect.die("Failed to create transaction")

    const [providerTransfer] = yield* db
      .insert(schema.providerTransfers)
      .values({
        sourceId: SOURCE_ID,
        sourceRawRecordId: rawRecord.id,
        transactionId: transaction.id,
        externalId: `${externalId}-provider-transfer`,
        providerAssetId: providerAssetRowId,
        sourceRepresentationUseId,
        timestamp: occurredAt,
        direction: "inbound",
        processingMode: "accounting_and_evidence",
        fromAccountRef: "provider",
        toAccountRef: "principal",
        amount: "1",
      })
      .returning({ id: schema.providerTransfers.id })
    if (providerTransfer === undefined) return yield* Effect.die("Failed to create provider fact")

    if (inventoryAssetId !== null) {
      yield* db.insert(schema.inventoryMovements).values({
        principalId: PRINCIPAL_ID,
        sourceId: SOURCE_ID,
        sourceRawRecordId: rawRecord.id,
        transactionId: transaction.id,
        providerTransferId: providerTransfer.id,
        assetId: inventoryAssetId,
        timestamp: occurredAt,
        direction: "inbound",
        purpose: "principal",
        taxTreatment: "taxable",
        reconciliationStatus: "unmatched",
        amount: "1",
      })
    }

    if (legId !== undefined) {
      yield* db.insert(schema.transactionLegs).values(
        yield* prepareMovementLegFixtures([
          {
            movementIdentity: { sourceRecordKey: `${externalId}-leg`, componentKey: "movement" },
            id: legId,
            sourceId: SOURCE_ID,
            sourceRawRecordId: rawRecord.id,
            externalId: `${externalId}-leg`,
            timestamp: occurredAt,
            principalId: PRINCIPAL_ID,
            assetId: TEST_BTC_ASSET_ID,
            sourceRepresentationUseId,
            providerAssetRowId,
            amount: "1",
            kind: "acquisition",
            provenance: "deterministic",
            originKind: "provider_transfer",
            providerTransferId: providerTransfer.id,
            transactionId: transaction.id,
          },
        ])
      )
    }

    return { providerTransferId: providerTransfer.id, transactionId: transaction.id }
  })

await Effect.runPromise(context.recreateTestDatabase())

describe("principal asset override application", () => {
  beforeEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* context.recreateTestDatabase()
        const fixture = yield* Effect.promise(() =>
          runPg(seedSyncEngineRepositoryFixture({ principalId: PRINCIPAL_ID, sourceId: SOURCE_ID }))
        )
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
              const [representation] = yield* db
                .select({
                  blockchainId: schema.assetRepresentations.blockchainId,
                  representationType: schema.assetRepresentations.type,
                  contractAddress: schema.assetRepresentations.contractAddress,
                  mintAddress: schema.assetRepresentations.mintAddress,
                })
                .from(schema.assetRepresentations)
                .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
              if (representation === undefined) return yield* Effect.die("Missing representation")
              yield* db.insert(schema.sourceRepresentationUses).values({
                id: SOURCE_USE_ID,
                sourceId: SOURCE_ID,
                ...representation,
              })
              yield* db.insert(schema.assets).values({
                id: REPLACEMENT_ASSET_ID,
                name: "Principal replacement",
                symbol: "REPLACEMENT",
                type: "fungible",
              })
            })
          )
        )
      })
    )
  )

  it.effect("uses only the target recorded on each provider fact", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({ id: INCLUDED_PROVIDER_ASSET_ID })
            yield* seedProviderAsset({ id: BLOCKED_PROVIDER_ASSET_ID })
            yield* createOverride({
              kind: "identity",
              providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
              replacementAssetId: REPLACEMENT_ASSET_ID,
            })
            yield* seedProviderTransaction({
              externalId: "selected-provider-row",
              legId: "10000000-0000-4000-8000-000000000101",
              providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
            })
            yield* seedProviderTransaction({
              externalId: "same-shaped-provider-row",
              legId: "10000000-0000-4000-8000-000000000102",
              providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
            })
          })
        )
      )

      const storedTargets = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                providerAssetRowId: schema.transactionLegs.providerAssetRowId,
                sourceRepresentationUseId: schema.transactionLegs.sourceRepresentationUseId,
              })
              .from(schema.transactionLegs)
          })
        )
      )
      expect(storedTargets).toEqual(
        expect.arrayContaining([
          {
            providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
            sourceRepresentationUseId: null,
          },
          {
            providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
            sourceRepresentationUseId: null,
          },
        ])
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(
        Object.fromEntries(
          ledger.events.map((event) => [event.transactionReference, event.assetId])
        )
      ).toEqual({
        "selected-provider-row": REPLACEMENT_ASSET_ID,
        "same-shaped-provider-row": TEST_BTC_ASSET_ID,
      })
    })
  )

  it.effect("does not borrow provider identity for an exact-linked fact", () =>
    Effect.gen(function* () {
      const legId = "10000000-0000-4000-8000-000000000112"
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({ id: INCLUDED_PROVIDER_ASSET_ID })
            yield* createOverride({
              kind: "identity",
              providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
              replacementAssetId: REPLACEMENT_ASSET_ID,
            })
            const db = yield* drizzle
            const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T10:30:00.000Z"))
            const [representation] = yield* db
              .select({ blockchainId: schema.assetRepresentations.blockchainId })
              .from(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
            if (representation === undefined) return yield* Effect.die("Missing blockchain")
            const [sourceUse] = yield* db
              .insert(schema.sourceRepresentationUses)
              .values({
                sourceId: SOURCE_ID,
                blockchainId: representation.blockchainId,
                representationType: "token",
                contractAddress: "0x2222222222222222222222222222222222222222",
              })
              .returning({ id: schema.sourceRepresentationUses.id })
            const [transaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: SOURCE_ID,
                externalId: "exact-with-provider-identity",
                timestamp: occurredAt,
                transactionType: "buy_fiat",
                principalId: PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            if (sourceUse === undefined || transaction === undefined) {
              return yield* Effect.die("Failed to create exact-link fixture")
            }
            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures([
                {
                  movementIdentity: {
                    sourceRecordKey: "exact-with-provider-identity-leg",
                    componentKey: "movement",
                  },
                  id: legId,
                  sourceId: SOURCE_ID,
                  externalId: "exact-with-provider-identity-leg",
                  timestamp: occurredAt,
                  principalId: PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  sourceRepresentationUseId: sourceUse.id,
                  providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
                  amount: "1",
                  kind: "acquisition",
                  provenance: "deterministic",
                  originKind: "none",
                  transactionId: transaction.id,
                },
              ])
            )
          })
        )
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers).toEqual([
        expect.objectContaining({
          code: "unresolved_identity",
          eventId: legId,
          assetId: TEST_BTC_ASSET_ID,
          providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
        }),
      ])
    })
  )

  it.effect("uses exact catalog metadata instead of provider technical metadata", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({ id: BLOCKED_PROVIDER_ASSET_ID, exponent: null })
            yield* seedProviderTransaction({
              externalId: "exact-catalog-metadata",
              legId: "10000000-0000-4000-8000-000000000115",
              providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
              sourceRepresentationUseId: SOURCE_USE_ID,
            })
          })
        )
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(ledger.events).toEqual([
        expect.objectContaining({
          id: "10000000-0000-4000-8000-000000000115",
          assetId: TEST_BTC_ASSET_ID,
        }),
      ])
      expect(ledger.inputBlockers).toEqual([])
    })
  )

  it.effect("keeps a Solana asset review partial until replay creates facts", () =>
    Effect.gen(function* () {
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({ id: INCLUDED_PROVIDER_ASSET_ID })
            const db = yield* drizzle
            const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T10:45:00.000Z"))
            const [representation] = yield* db
              .select({ blockchainId: schema.assetRepresentations.blockchainId })
              .from(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
            if (representation === undefined) return yield* Effect.die("Missing blockchain")
            const exactCoordinates = {
              blockchainId: representation.blockchainId,
              representationType: "token" as const,
              contractAddress: "0x3333333333333333333333333333333333333333",
            }
            const [sourceUse] = yield* db
              .insert(schema.sourceRepresentationUses)
              .values({ sourceId: SOURCE_ID, ...exactCoordinates })
              .returning({ id: schema.sourceRepresentationUses.id })
            const [target] = yield* db
              .insert(schema.principalAssetOverrideTargets)
              .values({
                principalId: PRINCIPAL_ID,
                targetKind: "representation",
                ...exactCoordinates,
              })
              .returning({ id: schema.principalAssetOverrideTargets.id })
            if (sourceUse === undefined || target === undefined) {
              return yield* Effect.die("Failed to create pre-catalog exact target")
            }
            yield* db.insert(schema.principalAssetOverrides).values({
              principalId: PRINCIPAL_ID,
              targetId: target.id,
              kind: "identity",
              operation: "create",
              inspectedSystemRevision: "solana-review-v1",
              inspectedSystemIdentity: "unresolved",
              replacementAssetId: REPLACEMENT_ASSET_ID,
              actorUserId: TEST_USER_ID,
              reason: "Resolve the exact Solana representation before replay",
            })
            const [transaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: SOURCE_ID,
                externalId: "solana-review-before-replay",
                timestamp: occurredAt,
                transactionType: "trade_other",
                principalId: PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            if (transaction === undefined) return yield* Effect.die("Failed to create transaction")
            const [providerTransfer] = yield* db
              .insert(schema.providerTransfers)
              .values({
                sourceId: SOURCE_ID,
                transactionId: transaction.id,
                externalId: "solana-review-provider-transfer",
                providerAssetId: INCLUDED_PROVIDER_ASSET_ID,
                sourceRepresentationUseId: sourceUse.id,
                timestamp: occurredAt,
                direction: "inbound",
                processingMode: "accounting_and_evidence",
                fromAccountRef: "external",
                toAccountRef: "principal",
                amount: "1",
              })
              .returning({ id: schema.providerTransfers.id })
            if (providerTransfer === undefined) {
              return yield* Effect.die("Failed to create provider transfer")
            }
            yield* db.insert(schema.providerAssetTransactionUses).values({
              providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
              transactionId: transaction.id,
              sourceId: SOURCE_ID,
            })
            yield* db.insert(schema.transactionReviews).values({
              principalId: PRINCIPAL_ID,
              transactionId: transaction.id,
              needsReview: true,
              matchedLayer: "solana_asset_mapping",
            })
            return providerTransfer.id
          })
        )
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "malformed_movement",
            eventId: providerTransferId,
            assetId: REPLACEMENT_ASSET_ID,
            providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
          }),
        ])
      )
    })
  )

  it.effect("withholds the whole transaction when one recorded target is excluded", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({ id: INCLUDED_PROVIDER_ASSET_ID })
            yield* seedProviderAsset({ id: BLOCKED_PROVIDER_ASSET_ID })
            yield* createOverride({
              kind: "inclusion",
              providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
              replacementInclusion: "excluded",
            })
            const db = yield* drizzle
            const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T11:00:00.000Z"))
            const [transaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: SOURCE_ID,
                externalId: "atomic-exclusion",
                timestamp: occurredAt,
                transactionType: "swap_crypto_to_crypto",
                principalId: PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            if (transaction === undefined) return yield* Effect.die("Failed to create transaction")
            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures([
                {
                  movementIdentity: {
                    sourceRecordKey: "atomic-exclusion-disposal",
                    componentKey: "movement",
                  },
                  sourceId: SOURCE_ID,
                  externalId: "atomic-exclusion-disposal",
                  timestamp: occurredAt,
                  principalId: PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
                  amount: "1",
                  kind: "disposal" as const,
                  provenance: "deterministic" as const,
                  originKind: "none" as const,
                  transactionId: transaction.id,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "atomic-exclusion-acquisition",
                    componentKey: "movement",
                  },
                  sourceId: SOURCE_ID,
                  externalId: "atomic-exclusion-acquisition",
                  timestamp: occurredAt,
                  principalId: PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
                  amount: "2",
                  kind: "acquisition" as const,
                  provenance: "deterministic" as const,
                  originKind: "none" as const,
                  transactionId: transaction.id,
                },
              ])
            )
          })
        )
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers).toEqual([])
    })
  )

  it.effect("blocks a fiat-linked accounting leg and its sibling", () =>
    Effect.gen(function* () {
      const fiatLegId = "10000000-0000-4000-8000-000000000116"
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T11:05:00.000Z"))
            yield* db.insert(schema.providerAssets).values({
              id: INCLUDED_PROVIDER_ASSET_ID,
              provider: "coinbase",
              providerAssetId: "fiat-linked-accounting-leg",
              currencyCode: "EUR",
              name: "Euro",
              exponent: 2,
              providerType: "fiat",
              rawProviderPayload: { asset_id: "fiat-linked-accounting-leg" },
              evidenceRevision: 1,
              discoveredAt: occurredAt,
              retrievedAt: occurredAt,
            })
            yield* db.insert(schema.providerAssetMappings).values({
              providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
              mappingKind: "fiat",
              canonicalFiatCurrency: "EUR",
              mappingStatus: "approved",
            })
            const [transaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: SOURCE_ID,
                externalId: "fiat-linked-accounting-transaction",
                timestamp: occurredAt,
                transactionType: "trade_other",
                principalId: PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            if (transaction === undefined) return yield* Effect.die("Failed to create transaction")
            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures([
                {
                  movementIdentity: {
                    sourceRecordKey: "fiat-linked-accounting-leg",
                    componentKey: "movement",
                  },
                  id: fiatLegId,
                  sourceId: SOURCE_ID,
                  externalId: "fiat-linked-accounting-leg",
                  timestamp: occurredAt,
                  principalId: PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
                  amount: "1",
                  kind: "disposal" as const,
                  provenance: "deterministic" as const,
                  originKind: "none" as const,
                  transactionId: transaction.id,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "fiat-linked-crypto-sibling",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000117",
                  sourceId: SOURCE_ID,
                  externalId: "fiat-linked-crypto-sibling",
                  timestamp: occurredAt,
                  principalId: PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  sourceRepresentationUseId: SOURCE_USE_ID,
                  amount: "1",
                  kind: "acquisition" as const,
                  provenance: "deterministic" as const,
                  originKind: "none" as const,
                  transactionId: transaction.id,
                },
              ])
            )
          })
        )
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers).toEqual([
        expect.objectContaining({
          code: "malformed_movement",
          eventId: fiatLegId,
          assetId: TEST_BTC_ASSET_ID,
          providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
        }),
      ])
    })
  )

  it.effect("preflights a suppressed internal-transfer leg before its sibling", () =>
    Effect.gen(function* () {
      const internalLegId = "10000000-0000-4000-8000-000000000118"
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({ id: BLOCKED_PROVIDER_ASSET_ID, exponent: null })
            const db = yield* drizzle
            const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T11:10:00.000Z"))
            const [transaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: SOURCE_ID,
                externalId: "blocked-internal-transfer-transaction",
                timestamp: occurredAt,
                transactionType: "internal_transfer",
                principalId: PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            if (transaction === undefined) return yield* Effect.die("Failed to create transaction")
            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures([
                {
                  movementIdentity: {
                    sourceRecordKey: "blocked-internal-transfer-leg",
                    componentKey: "movement",
                  },
                  id: internalLegId,
                  sourceId: SOURCE_ID,
                  externalId: "blocked-internal-transfer-leg",
                  timestamp: occurredAt,
                  principalId: PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
                  amount: "1",
                  kind: "acquisition" as const,
                  provenance: "deterministic" as const,
                  originKind: "none" as const,
                  derivationRule: "internal_transfer_in" as const,
                  transactionId: transaction.id,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "internal-transfer-sibling",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000119",
                  sourceId: SOURCE_ID,
                  externalId: "internal-transfer-sibling",
                  timestamp: occurredAt,
                  principalId: PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  sourceRepresentationUseId: SOURCE_USE_ID,
                  amount: "1",
                  kind: "disposal" as const,
                  provenance: "deterministic" as const,
                  originKind: "none" as const,
                  transactionId: transaction.id,
                },
              ])
            )
          })
        )
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers).toEqual([
        expect.objectContaining({
          code: "missing_decimals",
          eventId: internalLegId,
          providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
        }),
      ])
    })
  )

  it.effect("withholds a fee transaction and the operation it paid for together", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({ id: BLOCKED_PROVIDER_ASSET_ID })
            yield* createOverride({
              kind: "inclusion",
              providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
              replacementInclusion: "excluded",
            })
            const db = yield* drizzle
            const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T11:15:00.000Z"))
            const [operation] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: SOURCE_ID,
                externalId: "fee-atomic-operation",
                timestamp: occurredAt,
                transactionType: "buy_fiat",
                principalId: PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            const [feeTransaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: SOURCE_ID,
                externalId: "fee-atomic-fee",
                timestamp: occurredAt,
                transactionType: "gas_fee",
                principalId: PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            if (operation === undefined || feeTransaction === undefined) {
              return yield* Effect.die("Failed to create fee transaction fixtures")
            }
            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures([
                {
                  movementIdentity: {
                    sourceRecordKey: "fee-atomic-operation-leg",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000110",
                  sourceId: SOURCE_ID,
                  externalId: "fee-atomic-operation-leg",
                  timestamp: occurredAt,
                  principalId: PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  sourceRepresentationUseId: SOURCE_USE_ID,
                  amount: "1",
                  kind: "acquisition" as const,
                  provenance: "deterministic" as const,
                  originKind: "none" as const,
                  transactionId: operation.id,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "fee-atomic-fee-leg",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000111",
                  sourceId: SOURCE_ID,
                  externalId: "fee-atomic-fee-leg",
                  timestamp: occurredAt,
                  principalId: PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
                  amount: "0.01",
                  kind: "fee" as const,
                  provenance: "deterministic" as const,
                  originKind: "none" as const,
                  transactionId: feeTransaction.id,
                  feeForTransactionId: operation.id,
                },
              ])
            )
          })
        )
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers).toEqual([])
    })
  )

  it.effect("withholds a transactionless fee with its excluded operation", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({ id: BLOCKED_PROVIDER_ASSET_ID })
            yield* createOverride({
              kind: "inclusion",
              providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
              replacementInclusion: "excluded",
            })
            const db = yield* drizzle
            const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T11:20:00.000Z"))
            const [operation] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: SOURCE_ID,
                externalId: "transactionless-fee-operation",
                timestamp: occurredAt,
                transactionType: "buy_fiat",
                principalId: PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            if (operation === undefined) return yield* Effect.die("Failed to create operation")
            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures([
                {
                  movementIdentity: {
                    sourceRecordKey: "transactionless-fee-operation-leg",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000113",
                  sourceId: SOURCE_ID,
                  externalId: "transactionless-fee-operation-leg",
                  timestamp: occurredAt,
                  principalId: PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
                  amount: "1",
                  kind: "acquisition" as const,
                  provenance: "deterministic" as const,
                  originKind: "none" as const,
                  transactionId: operation.id,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "transactionless-fee-leg",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000114",
                  sourceId: SOURCE_ID,
                  externalId: "transactionless-fee-leg",
                  timestamp: occurredAt,
                  principalId: PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  sourceRepresentationUseId: SOURCE_USE_ID,
                  amount: "0.01",
                  kind: "fee" as const,
                  provenance: "deterministic" as const,
                  originKind: "none" as const,
                  feeForTransactionId: operation.id,
                },
              ])
            )
          })
        )
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers).toEqual([])
    })
  )

  it.effect("lets exact inclusion reverse representation spam but not a fiat-row exclusion", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T11:30:00.000Z"))
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.assetRepresentations)
              .set({ isSpam: true })
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
            yield* db.insert(schema.providerAssets).values({
              id: INCLUDED_PROVIDER_ASSET_ID,
              provider: "coinbase",
              providerAssetId: "excluded-fiat-exact-evidence",
              currencyCode: "EUR",
              name: "Euro",
              exponent: 2,
              providerType: "fiat",
              rawProviderPayload: { asset_id: "excluded-fiat-exact-evidence" },
              evidenceRevision: 1,
              discoveredAt: occurredAt,
              retrievedAt: occurredAt,
            })
            yield* db.insert(schema.providerAssetMappings).values({
              providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
              mappingKind: "fiat",
              canonicalFiatCurrency: "EUR",
              mappingStatus: "approved",
            })
            const [representation] = yield* db
              .select({
                blockchainId: schema.assetRepresentations.blockchainId,
                representationType: schema.assetRepresentations.type,
                contractAddress: schema.assetRepresentations.contractAddress,
                mintAddress: schema.assetRepresentations.mintAddress,
              })
              .from(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
            if (representation === undefined) return yield* Effect.die("Missing representation")
            const [target] = yield* db
              .insert(schema.principalAssetOverrideTargets)
              .values({
                principalId: PRINCIPAL_ID,
                targetKind: "representation",
                ...representation,
              })
              .returning({ id: schema.principalAssetOverrideTargets.id })
            if (target === undefined) return yield* Effect.die("Failed to create target")
            yield* db.insert(schema.principalAssetOverrides).values({
              principalId: PRINCIPAL_ID,
              targetId: target.id,
              kind: "inclusion",
              operation: "create",
              inspectedSystemRevision: "exact-inclusion-v1",
              inspectedSystemInclusion: "excluded",
              replacementInclusion: "included",
              actorUserId: TEST_USER_ID,
              reason: "Include this exact representation for the principal",
            })
          })
        )
      )

      yield* Effect.promise(() =>
        runSourceNormalization(
          Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts({
              transaction: {
                sourceId: SOURCE_ID,
                sourceRawRecordId: null,
                externalId: "exact-inclusion",
                externalGroupId: null,
                timestamp: occurredAt,
                transactionType: "buy_fiat",
                providerTransactionType: "buy",
                providerStatus: "completed",
                providerResourcePath: null,
                providerDescription: "Exact-linked fiat exclusion fixture",
                providerCreatedAt: occurredAt,
                providerUpdatedAt: occurredAt,
                metadata: null,
                providerFiatAmount: null,
                providerFiatCurrency: null,
                principalId: PRINCIPAL_ID,
              },
              venueContext: {
                venueType: "cex",
                cexAccountId: null,
                externalAccountId: "owned-account",
                externalOrderId: null,
                externalFillId: null,
                side: "buy",
                instrument: "BTC-EUR",
                fillPrice: "50000",
                commissionAmount: null,
                commissionCurrency: null,
                metadata: null,
              },
              providerTransfers: [],
              canonicalTransfers: [],
              providerAssetRowIds: [INCLUDED_PROVIDER_ASSET_ID],
              deriveLegs: ({ transaction }) =>
                Effect.succeed([
                  {
                    movementIdentity: {
                      _tag: "identified" as const,
                      sourceRecordKey: "exact-inclusion-leg",
                      componentKey: "movement",
                    },
                    sourceId: SOURCE_ID,
                    sourceRawRecordId: null,
                    externalId: "exact-inclusion-leg",
                    txHash: null,
                    timestamp: occurredAt,
                    principalId: PRINCIPAL_ID,
                    addressId: null,
                    assetId: TEST_BTC_ASSET_ID,
                    assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
                    amount: "1",
                    kind: "acquisition" as const,
                    provenance: "deterministic" as const,
                    derivationRule: "exact_fiat_exclusion_fixture",
                    providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
                    metadata: null,
                    transactionId: transaction.id,
                    originKind: "none" as const,
                    providerTransferId: null,
                    sourceTransferId: null,
                    fiatAmount: null,
                    fiatCurrency: null,
                    feeForTransactionId: null,
                  },
                ]),
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

      const [storedTarget] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                providerAssetRowId: schema.transactionLegs.providerAssetRowId,
                sourceRepresentationUseId: schema.transactionLegs.sourceRepresentationUseId,
              })
              .from(schema.transactionLegs)
              .where(eq(schema.transactionLegs.externalId, "exact-inclusion-leg"))
          })
        )
      )
      expect(storedTarget).toEqual({
        providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
        sourceRepresentationUseId: SOURCE_USE_ID,
      })

      const ledger = yield* Effect.promise(loadLedger)
      expect(ledger.events.map(({ transactionReference }) => transactionReference)).toEqual([
        "exact-inclusion",
      ])

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.providerAssetMappings)
              .set({ mappingStatus: "excluded" })
              .where(
                eq(schema.providerAssetMappings.providerAssetRowId, INCLUDED_PROVIDER_ASSET_ID)
              )
          })
        )
      )

      expect((yield* Effect.promise(loadLedger)).events).toEqual([])
    })
  )

  it.effect("handles pre-catalog, deleted, and fiat targets only through recorded links", () =>
    Effect.gen(function* () {
      const ids = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T11:45:00.000Z"))
            const [representation] = yield* db
              .select({ blockchainId: schema.assetRepresentations.blockchainId })
              .from(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
            if (representation === undefined) return yield* Effect.die("Missing blockchain")
            const exactCoordinates = {
              blockchainId: representation.blockchainId,
              representationType: "token" as const,
              contractAddress: "0x1111111111111111111111111111111111111111",
            }
            const [sourceUse] = yield* db
              .insert(schema.sourceRepresentationUses)
              .values({ sourceId: SOURCE_ID, ...exactCoordinates })
              .returning({ id: schema.sourceRepresentationUses.id })
            const [target] = yield* db
              .insert(schema.principalAssetOverrideTargets)
              .values({
                principalId: PRINCIPAL_ID,
                targetKind: "representation",
                ...exactCoordinates,
              })
              .returning({ id: schema.principalAssetOverrideTargets.id })
            if (sourceUse === undefined || target === undefined) {
              return yield* Effect.die("Failed to create pre-catalog target")
            }
            const [identityOverride] = yield* db
              .insert(schema.principalAssetOverrides)
              .values({
                principalId: PRINCIPAL_ID,
                targetId: target.id,
                kind: "identity",
                operation: "create",
                inspectedSystemRevision: "pre-catalog-v1",
                inspectedSystemIdentity: "unresolved",
                replacementAssetId: REPLACEMENT_ASSET_ID,
                actorUserId: TEST_USER_ID,
                reason: "Resolve an exact representation before the global catalog",
              })
              .returning({ id: schema.principalAssetOverrides.id })
            if (identityOverride === undefined) {
              return yield* Effect.die("Failed to create pre-catalog override")
            }
            const [preCatalogTransaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: SOURCE_ID,
                externalId: "pre-catalog-exact",
                timestamp: occurredAt,
                transactionType: "buy_fiat",
                principalId: PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            if (preCatalogTransaction === undefined) {
              return yield* Effect.die("Failed to create pre-catalog transaction")
            }
            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures([
                {
                  movementIdentity: {
                    sourceRecordKey: "pre-catalog-exact-leg",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000107",
                  sourceId: SOURCE_ID,
                  externalId: "pre-catalog-exact-leg",
                  timestamp: occurredAt,
                  principalId: PRINCIPAL_ID,
                  assetId: REPLACEMENT_ASSET_ID,
                  sourceRepresentationUseId: sourceUse.id,
                  amount: "1",
                  kind: "acquisition",
                  provenance: "deterministic",
                  originKind: "none",
                  transactionId: preCatalogTransaction.id,
                },
              ])
            )

            yield* db.insert(schema.providerAssets).values({
              id: INCLUDED_PROVIDER_ASSET_ID,
              provider: "coinbase",
              providerAssetId: "fiat-eur",
              currencyCode: "EUR",
              name: "Euro",
              exponent: 2,
              providerType: "fiat",
              rawProviderPayload: { asset_id: "fiat-eur" },
              evidenceRevision: 1,
              discoveredAt: occurredAt,
              retrievedAt: occurredAt,
            })
            yield* db.insert(schema.providerAssetMappings).values({
              providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
              mappingKind: "fiat",
              canonicalFiatCurrency: "EUR",
              mappingStatus: "approved",
            })
            const fiat = yield* seedProviderTransaction({
              externalId: "ignored-fiat-provider-fact",
              inventoryAssetId: null,
              providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
            })
            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures([
                {
                  movementIdentity: {
                    sourceRecordKey: "crypto-sibling-of-fiat-evidence",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000109",
                  sourceId: SOURCE_ID,
                  externalId: "crypto-sibling-of-fiat-evidence",
                  timestamp: occurredAt,
                  principalId: PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  sourceRepresentationUseId: SOURCE_USE_ID,
                  amount: "1",
                  kind: "acquisition",
                  provenance: "deterministic",
                  originKind: "none",
                  transactionId: fiat.transactionId,
                },
              ])
            )

            yield* seedProviderAsset({ id: BLOCKED_PROVIDER_ASSET_ID })
            const deleted = yield* seedProviderTransaction({
              externalId: "deleted-provider-row",
              legId: "10000000-0000-4000-8000-000000000108",
              providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
            })
            yield* db
              .delete(schema.providerAssetMappings)
              .where(eq(schema.providerAssetMappings.providerAssetRowId, BLOCKED_PROVIDER_ASSET_ID))
            yield* db
              .delete(schema.providerAssets)
              .where(eq(schema.providerAssets.id, BLOCKED_PROVIDER_ASSET_ID))
            return {
              deletedProviderTransferId: deleted.providerTransferId,
              preCatalogOverrideId: identityOverride.id,
              preCatalogTargetId: target.id,
            }
          })
        )
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(ledger.events).toEqual([
        expect.objectContaining({
          id: "10000000-0000-4000-8000-000000000107",
          assetId: REPLACEMENT_ASSET_ID,
        }),
        expect.objectContaining({
          id: "10000000-0000-4000-8000-000000000109",
          assetId: TEST_BTC_ASSET_ID,
        }),
      ])
      expect(ledger.inputBlockers.filter(({ code }) => code === "malformed_movement")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ eventId: ids.deletedProviderTransferId }),
          expect.objectContaining({ eventId: "10000000-0000-4000-8000-000000000108" }),
        ])
      )
      expect(
        ledger.inputBlockers.some(
          (blocker) =>
            "providerAssetRowId" in blocker &&
            blocker.providerAssetRowId === INCLUDED_PROVIDER_ASSET_ID
        )
      ).toBe(false)

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.principalAssetOverrides).values({
              principalId: PRINCIPAL_ID,
              targetId: ids.preCatalogTargetId,
              kind: "identity",
              operation: "withdraw",
              inspectedSystemRevision: "pre-catalog-v1",
              inspectedSystemIdentity: "unresolved",
              actorUserId: TEST_USER_ID,
              reason: "Return the pre-catalog target to its unresolved system identity",
              supersedesOverrideId: ids.preCatalogOverrideId,
            })
          })
        )
      )

      const withdrawnLedger = yield* Effect.promise(loadLedger)
      expect(withdrawnLedger.events.map(({ id }) => id)).toEqual([
        "10000000-0000-4000-8000-000000000109",
      ])
      expect(withdrawnLedger.inputBlockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "unresolved_identity",
            eventId: "10000000-0000-4000-8000-000000000107",
            assetId: REPLACEMENT_ASSET_ID,
          }),
        ])
      )
    })
  )

  it.effect("turns unresolved, technically blocked, and linkless facts into typed blockers", () =>
    Effect.gen(function* () {
      const targets = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({ id: BLOCKED_PROVIDER_ASSET_ID, exponent: null })
            yield* seedProviderAsset({
              id: UNRESOLVED_PROVIDER_ASSET_ID,
              canonicalAssetId: null,
            })
            const missingDecimals = yield* seedProviderTransaction({
              externalId: "missing-decimals",
              legId: "10000000-0000-4000-8000-000000000103",
              providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
            })
            const unresolved = yield* seedProviderTransaction({
              externalId: "unresolved-provider-row",
              inventoryAssetId: null,
              providerAssetRowId: UNRESOLVED_PROVIDER_ASSET_ID,
            })
            const db = yield* drizzle
            const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T12:00:00.000Z"))
            const [rawRecord] = yield* db
              .insert(schema.sourceRecordsRaw)
              .values({
                sourceId: SOURCE_ID,
                provider: "coinbase",
                recordType: "transaction",
                externalRecordId: "linkless-leg",
                occurredAt,
                payload: { id: "linkless-leg" },
              })
              .returning({ id: schema.sourceRecordsRaw.id })
            if (rawRecord === undefined) return yield* Effect.die("Failed to create raw record")
            const [linkless] = yield* db
              .insert(schema.transactionLegs)
              .values(
                yield* prepareMovementLegFixtures([
                  {
                    movementIdentity: { sourceRecordKey: "linkless-leg", componentKey: "movement" },
                    id: "10000000-0000-4000-8000-000000000104",
                    sourceId: SOURCE_ID,
                    sourceRawRecordId: rawRecord.id,
                    externalId: "linkless-leg",
                    timestamp: occurredAt,
                    principalId: PRINCIPAL_ID,
                    assetId: TEST_BTC_ASSET_ID,
                    amount: "1",
                    kind: "acquisition",
                    provenance: "deterministic",
                    originKind: "none",
                  },
                ])
              )
              .returning({ id: schema.transactionLegs.id })
            if (linkless === undefined) return yield* Effect.die("Failed to create linkless leg")
            const [sourceTransfer] = yield* db
              .insert(schema.transfers)
              .values({
                sourceId: SOURCE_ID,
                principalId: PRINCIPAL_ID,
                externalId: "targetless-source-transfer",
                timestamp: occurredAt,
                type: "cex",
                fromAccountRef: "provider",
                toAccountRef: "principal",
                assetId: TEST_BTC_ASSET_ID,
                amount: "1",
              })
              .returning({ id: schema.transfers.id })
            if (sourceTransfer === undefined) {
              return yield* Effect.die("Failed to create targetless source transfer")
            }
            const [transferLinked] = yield* db
              .insert(schema.transactionLegs)
              .values(
                yield* prepareMovementLegFixtures([
                  {
                    movementIdentity: {
                      sourceRecordKey: "targetless-source-transfer-leg",
                      componentKey: "movement",
                    },
                    id: "10000000-0000-4000-8000-000000000120",
                    sourceId: SOURCE_ID,
                    externalId: "targetless-source-transfer-leg",
                    timestamp: occurredAt,
                    principalId: PRINCIPAL_ID,
                    assetId: TEST_BTC_ASSET_ID,
                    amount: "1",
                    kind: "acquisition",
                    provenance: "deterministic",
                    originKind: "canonical_transfer",
                    sourceTransferId: sourceTransfer.id,
                  },
                ])
              )
              .returning({ id: schema.transactionLegs.id })
            if (transferLinked === undefined) {
              return yield* Effect.die("Failed to create targetless transfer-linked leg")
            }
            return { linkless, missingDecimals, transferLinked, unresolved }
          })
        )
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "malformed_movement",
            eventId: targets.linkless.id,
            assetId: TEST_BTC_ASSET_ID,
          }),
          expect.objectContaining({
            code: "malformed_movement",
            eventId: targets.transferLinked.id,
            assetId: TEST_BTC_ASSET_ID,
          }),
          expect.objectContaining({
            code: "missing_decimals",
            providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
          }),
          expect.objectContaining({
            code: "unresolved_identity",
            assetId: null,
            providerAssetRowId: UNRESOLVED_PROVIDER_ASSET_ID,
          }),
        ])
      )
    })
  )

  it.effect("preflights a finalized reconciliation that lacks a canonical transfer", () =>
    Effect.gen(function* () {
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({ id: BLOCKED_PROVIDER_ASSET_ID, exponent: null })
            const db = yield* drizzle
            const [representation] = yield* db
              .select({ blockchainId: schema.assetRepresentations.blockchainId })
              .from(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
            if (representation === undefined) return yield* Effect.die("Missing blockchain")
            const [sourceUse] = yield* db
              .insert(schema.sourceRepresentationUses)
              .values({
                sourceId: SOURCE_ID,
                blockchainId: representation.blockchainId,
                representationType: "token",
                contractAddress: "0x3333333333333333333333333333333333333333",
              })
              .returning({ id: schema.sourceRepresentationUses.id })
            if (sourceUse === undefined) return yield* Effect.die("Failed to create source use")
            const fact = yield* seedProviderTransaction({
              externalId: "incomplete-finalized-reconciliation",
              providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
              sourceRepresentationUseId: sourceUse.id,
            })
            yield* db.insert(schema.transferReconciliations).values({
              principalId: PRINCIPAL_ID,
              providerTransferId: fact.providerTransferId,
              canonicalTransactionId: fact.transactionId,
              status: "approved",
              matchReason: "Incomplete approved fixture",
            })
            return fact.providerTransferId
          })
        )
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "missing_decimals",
            eventId: providerTransferId,
            providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
          }),
          expect.objectContaining({
            code: "unresolved_identity",
            eventId: providerTransferId,
            providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
          }),
        ])
      )
    })
  )

  it.effect("returns a blocker for a review-only provider use behind evidence", () =>
    Effect.gen(function* () {
      const transactionId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({
              id: UNRESOLVED_PROVIDER_ASSET_ID,
              canonicalAssetId: null,
            })
            const db = yield* drizzle
            const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T12:15:00.000Z"))
            const [transaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: SOURCE_ID,
                externalId: "review-only-provider-use",
                timestamp: occurredAt,
                transactionType: "trade_other",
                principalId: PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            if (transaction === undefined) {
              return yield* Effect.die("Failed to create review-only transaction")
            }
            yield* db.insert(schema.providerAssetTransactionUses).values({
              providerAssetRowId: UNRESOLVED_PROVIDER_ASSET_ID,
              transactionId: transaction.id,
              sourceId: SOURCE_ID,
            })
            yield* db.insert(schema.providerTransfers).values({
              sourceId: SOURCE_ID,
              transactionId: transaction.id,
              externalId: "review-only-evidence",
              providerAssetId: UNRESOLVED_PROVIDER_ASSET_ID,
              timestamp: occurredAt,
              direction: "inbound",
              processingMode: "evidence_only",
              fromAccountRef: "provider",
              toAccountRef: "principal",
              amount: "1",
            })
            yield* db.insert(schema.transactionReviews).values({
              principalId: PRINCIPAL_ID,
              transactionId: transaction.id,
              needsReview: true,
              matchedLayer: "provider_asset_mapping",
            })
            return transaction.id
          })
        )
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers).toEqual([
        expect.objectContaining({
          code: "unresolved_identity",
          eventId: transactionId,
          assetId: null,
          providerAssetRowId: UNRESOLVED_PROVIDER_ASSET_ID,
        }),
      ])
    })
  )

  it.effect("does not let a sibling leg suppress an open provider use", () =>
    Effect.gen(function* () {
      const ids = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({ id: INCLUDED_PROVIDER_ASSET_ID })
            const db = yield* drizzle
            const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T12:30:00.000Z"))
            const [transaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: SOURCE_ID,
                externalId: "open-use-with-sibling-leg",
                timestamp: occurredAt,
                transactionType: "trade_other",
                principalId: PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            if (transaction === undefined) return yield* Effect.die("Failed to create transaction")
            const [leg] = yield* db
              .insert(schema.transactionLegs)
              .values(
                yield* prepareMovementLegFixtures([
                  {
                    movementIdentity: {
                      sourceRecordKey: "open-use-sibling-leg",
                      componentKey: "movement",
                    },
                    sourceId: SOURCE_ID,
                    externalId: "open-use-sibling-leg",
                    timestamp: occurredAt,
                    principalId: PRINCIPAL_ID,
                    assetId: TEST_BTC_ASSET_ID,
                    providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
                    amount: "1",
                    kind: "acquisition",
                    provenance: "deterministic",
                    originKind: "none",
                    transactionId: transaction.id,
                  },
                ])
              )
              .returning({ id: schema.transactionLegs.id })
            if (leg === undefined) return yield* Effect.die("Failed to create sibling leg")
            yield* db.insert(schema.providerAssetTransactionUses).values({
              providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
              transactionId: transaction.id,
              sourceId: SOURCE_ID,
            })
            yield* db.insert(schema.transactionReviews).values({
              principalId: PRINCIPAL_ID,
              transactionId: transaction.id,
              needsReview: true,
              matchedLayer: "provider_asset_mapping",
            })
            return { legId: leg.id, transactionId: transaction.id }
          })
        )
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(ledger.events.some(({ id }) => id === ids.legId)).toBe(false)
      expect(ledger.inputBlockers).toEqual([
        expect.objectContaining({
          code: "malformed_movement",
          eventId: ids.transactionId,
          assetId: TEST_BTC_ASSET_ID,
          providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
        }),
      ])
    })
  )

  it.effect("fails instead of reporting complete when deletion erases every blocker link", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({
              id: UNRESOLVED_PROVIDER_ASSET_ID,
              canonicalAssetId: null,
            })
            yield* seedProviderTransaction({
              externalId: "deleted-targetless-provider-row",
              inventoryAssetId: null,
              providerAssetRowId: UNRESOLVED_PROVIDER_ASSET_ID,
            })
            const db = yield* drizzle
            yield* db
              .delete(schema.providerAssets)
              .where(eq(schema.providerAssets.id, UNRESOLVED_PROVIDER_ASSET_ID))
          })
        )
      )

      yield* Effect.promise(() =>
        expect(loadLedger()).rejects.toMatchObject({
          operation: "factualLedgerRepository.load.unaddressableBlocker",
        })
      )
    })
  )

  it.effect("classifies a disappearing blocker target as a stale run", () =>
    Effect.gen(function* () {
      const activeRunId = "00000000-0000-4000-8000-000000000925"
      const staleRunId = "00000000-0000-4000-8000-000000000926"
      const followUpRunId = "00000000-0000-4000-8000-000000000927"

      yield* Effect.promise(() => recompute(activeRunId))
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({
              id: UNRESOLVED_PROVIDER_ASSET_ID,
              canonicalAssetId: null,
            })
            yield* seedProviderTransaction({
              externalId: "blocker-target-deleted-after-snapshot",
              inventoryAssetId: null,
              providerAssetRowId: UNRESOLVED_PROVIDER_ASSET_ID,
            })
          })
        )
      )

      const racingServiceLive = calculationRunServiceWithPersist(
        (repository) => (params) =>
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              runPg(
                Effect.gen(function* () {
                  const db = yield* drizzle
                  yield* db
                    .delete(schema.providerAssets)
                    .where(eq(schema.providerAssets.id, UNRESOLVED_PROVIDER_ASSET_ID))
                })
              )
            )
            return yield* repository.persist(params)
          })
      )
      const error = yield* Effect.flip(
        context.runWithLayer({
          effect: recomputeEffect(staleRunId),
          layer: racingServiceLive,
        })
      )
      expect(error).toBeInstanceOf(PersistenceError)

      const afterFailure = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [run] = yield* db
              .select({
                status: schema.calculationRuns.status,
                failureCode: schema.calculationRuns.failureCode,
              })
              .from(schema.calculationRuns)
              .where(eq(schema.calculationRuns.id, staleRunId))
            const [active] = yield* db
              .select({ runId: schema.activeCalculationRuns.runId })
              .from(schema.activeCalculationRuns)
              .where(eq(schema.activeCalculationRuns.principalId, PRINCIPAL_ID))
            return { active, run }
          })
        )
      )
      expect(afterFailure).toEqual({
        active: { runId: activeRunId },
        run: { status: "failed", failureCode: "calculation_stale_recomputed" },
      })

      yield* context.runWithLayer({
        effect: Effect.flatMap(SourceReplayRepository, (repository) =>
          repository.resetSourceDerivedState({ sourceId: SOURCE_ID })
        ),
        layer: SourceReplayRepositoryLive,
      })
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const completedAt = yield* DateTime.nowAsDate
            yield* db.insert(schema.processingJobs).values({
              sourceId: SOURCE_ID,
              principalId: PRINCIPAL_ID,
              status: "completed",
              completedAt,
            })
          })
        )
      )
      const maintenance = yield* context.runWithLayer({
        effect: Effect.flatMap(CalculationRunRepository, (repository) =>
          repository.settleStaleAndFindRecomputePrincipals({
            staleBefore: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
            limit: 100,
          })
        ),
        layer: CalculationRunRepositoryLive,
      })
      expect(maintenance.principalIds).toContain(PRINCIPAL_ID)

      yield* Effect.promise(() => recompute(followUpRunId))
      const afterFollowUp = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [run] = yield* db
              .select({ status: schema.calculationRuns.status })
              .from(schema.calculationRuns)
              .where(eq(schema.calculationRuns.id, followUpRunId))
            const [active] = yield* db
              .select({ runId: schema.activeCalculationRuns.runId })
              .from(schema.activeCalculationRuns)
              .where(eq(schema.activeCalculationRuns.principalId, PRINCIPAL_ID))
            return { active, run }
          })
        )
      )
      expect(afterFollowUp).toEqual({
        active: { runId: followUpRunId },
        run: { status: "complete" },
      })
    })
  )

  it.effect("stores adapter blockers on a partial calculation run", () =>
    Effect.gen(function* () {
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({
              id: UNRESOLVED_PROVIDER_ASSET_ID,
              canonicalAssetId: null,
            })
            const fact = yield* seedProviderTransaction({
              externalId: "partial-run-unresolved",
              inventoryAssetId: null,
              providerAssetRowId: UNRESOLVED_PROVIDER_ASSET_ID,
            })
            return fact.providerTransferId
          })
        )
      )

      yield* Effect.promise(() => recompute("00000000-0000-4000-8000-000000000921"))
      const stored = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [run] = yield* db
              .select({ status: schema.calculationRuns.status })
              .from(schema.calculationRuns)
              .where(eq(schema.calculationRuns.id, "00000000-0000-4000-8000-000000000921"))
            const blockers = yield* db
              .select({
                code: schema.calculationRunBlockers.code,
                eventId: schema.calculationRunBlockers.eventId,
                assetId: schema.calculationRunBlockers.assetId,
                providerAssetRowId: schema.calculationRunBlockers.providerAssetRowId,
              })
              .from(schema.calculationRunBlockers)
              .where(
                eq(schema.calculationRunBlockers.runId, "00000000-0000-4000-8000-000000000921")
              )
            return { blockers, run }
          })
        )
      )

      expect(stored.run?.status).toBe("partial")
      expect(stored.blockers).toEqual([
        {
          code: "unresolved_identity",
          eventId: providerTransferId,
          assetId: null,
          providerAssetRowId: UNRESOLVED_PROVIDER_ASSET_ID,
        },
      ])
    })
  )

  it.effect("stores unsupported-type blockers while unrelated facts still calculate", () =>
    Effect.gen(function* () {
      const blockedSiblingId = "10000000-0000-4000-8000-000000000123"
      const unrelatedLegId = "10000000-0000-4000-8000-000000000124"
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({
              id: UNRESOLVED_PROVIDER_ASSET_ID,
              canonicalAssetId: null,
              providerType: "unsupported-provider-type",
            })
            yield* seedProviderAsset({ id: INCLUDED_PROVIDER_ASSET_ID })
            const blocked = yield* seedProviderTransaction({
              externalId: "unsupported-provider-type",
              inventoryAssetId: null,
              providerAssetRowId: UNRESOLVED_PROVIDER_ASSET_ID,
            })
            yield* seedProviderTransaction({
              externalId: "unrelated-supported-asset",
              legId: unrelatedLegId,
              providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
            })
            const db = yield* drizzle
            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures([
                {
                  movementIdentity: {
                    sourceRecordKey: "unsupported-provider-type-sibling",
                    componentKey: "movement",
                  },
                  id: blockedSiblingId,
                  sourceId: SOURCE_ID,
                  externalId: "unsupported-provider-type-sibling",
                  timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T10:00:00.000Z")),
                  principalId: PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  sourceRepresentationUseId: SOURCE_USE_ID,
                  amount: "1",
                  kind: "acquisition",
                  provenance: "deterministic",
                  originKind: "none",
                  transactionId: blocked.transactionId,
                },
              ])
            )
            yield* db.insert(schema.assetPrices).values({
              assetId: TEST_BTC_ASSET_ID,
              timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T00:00:00.000Z")),
              price: "50000",
              currency: "EUR",
              source: "coingecko",
            })
            return blocked.providerTransferId
          })
        )
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(ledger.events.map(({ id }) => id)).toEqual([unrelatedLegId])
      expect(ledger.inputBlockers).toHaveLength(2)
      expect(ledger.inputBlockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "unresolved_identity",
            eventId: providerTransferId,
            providerAssetRowId: UNRESOLVED_PROVIDER_ASSET_ID,
          }),
          expect.objectContaining({
            code: "unsupported_asset_type",
            eventId: providerTransferId,
            providerAssetRowId: UNRESOLVED_PROVIDER_ASSET_ID,
          }),
        ])
      )

      const runId = "00000000-0000-4000-8000-000000000931"
      yield* Effect.promise(() => recompute(runId))
      const stored = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [run] = yield* db
              .select({ status: schema.calculationRuns.status })
              .from(schema.calculationRuns)
              .where(eq(schema.calculationRuns.id, runId))
            const blockers = yield* db
              .select({ code: schema.calculationRunBlockers.code })
              .from(schema.calculationRunBlockers)
              .where(eq(schema.calculationRunBlockers.runId, runId))
            const lots = yield* db
              .select({ acquisitionEventId: schema.calculationRunDerivedLots.acquisitionEventId })
              .from(schema.calculationRunDerivedLots)
              .where(eq(schema.calculationRunDerivedLots.runId, runId))
            return { blockers, lots, run }
          })
        )
      )
      expect(stored.run).toEqual({ status: "partial" })
      expect(stored.lots).toEqual([{ acquisitionEventId: unrelatedLegId }])
      expect(stored.blockers).toHaveLength(2)
      expect(stored.blockers).toEqual(
        expect.arrayContaining([
          { code: "unresolved_identity" },
          { code: "unsupported_asset_type" },
        ])
      )
    })
  )

  it.effect("scopes blockers and atomic withholding at the German civil-year boundary", () =>
    Effect.gen(function* () {
      const earlierLegId = "10000000-0000-4000-8000-000000000121"
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const earlierAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-12-31T22:59:59.999Z"))
            const futureAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-12-31T23:00:00.000Z"))
            yield* seedProviderAsset({ id: INCLUDED_PROVIDER_ASSET_ID })
            yield* seedProviderAsset({
              id: UNRESOLVED_PROVIDER_ASSET_ID,
              canonicalAssetId: null,
            })
            const earlier = yield* seedProviderTransaction({
              externalId: "tax-year-operation",
              legId: earlierLegId,
              occurredAt: earlierAt,
              providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
            })
            const db = yield* drizzle
            const [futureTransaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: SOURCE_ID,
                externalId: "post-tax-year-blocked-fee",
                timestamp: futureAt,
                transactionType: "fee",
                principalId: PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            if (futureTransaction === undefined) {
              return yield* Effect.die("Failed to create post-tax-year fee transaction")
            }
            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures([
                {
                  movementIdentity: {
                    sourceRecordKey: "post-tax-year-blocked-fee-leg",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000122",
                  sourceId: SOURCE_ID,
                  externalId: "post-tax-year-blocked-fee-leg",
                  timestamp: futureAt,
                  principalId: PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  providerAssetRowId: UNRESOLVED_PROVIDER_ASSET_ID,
                  amount: "0.01",
                  kind: "fee",
                  provenance: "deterministic",
                  originKind: "none",
                  transactionId: futureTransaction.id,
                  feeForTransactionId: earlier.transactionId,
                },
              ])
            )
            yield* db.insert(schema.assetPrices).values({
              assetId: TEST_BTC_ASSET_ID,
              timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-12-31T00:00:00.000Z")),
              price: "50000",
              currency: "EUR",
              source: "coingecko",
            })
          })
        )
      )

      const earlierRunId = "00000000-0000-4000-8000-000000000928"
      const laterRunId = "00000000-0000-4000-8000-000000000929"
      yield* Effect.promise(() => recompute(earlierRunId, 2025))
      const earlierStored = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [run] = yield* db
              .select({ status: schema.calculationRuns.status })
              .from(schema.calculationRuns)
              .where(eq(schema.calculationRuns.id, earlierRunId))
            const blockers = yield* db
              .select({ code: schema.calculationRunBlockers.code })
              .from(schema.calculationRunBlockers)
              .where(eq(schema.calculationRunBlockers.runId, earlierRunId))
            const lots = yield* db
              .select({ acquisitionEventId: schema.calculationRunDerivedLots.acquisitionEventId })
              .from(schema.calculationRunDerivedLots)
              .where(eq(schema.calculationRunDerivedLots.runId, earlierRunId))
            return { blockers, lots, run }
          })
        )
      )
      expect(earlierStored).toEqual({
        blockers: [],
        lots: [{ acquisitionEventId: earlierLegId }],
        run: { status: "complete" },
      })

      yield* Effect.promise(() => recompute(laterRunId, 2026))
      const laterStored = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [run] = yield* db
              .select({ status: schema.calculationRuns.status })
              .from(schema.calculationRuns)
              .where(eq(schema.calculationRuns.id, laterRunId))
            const blockers = yield* db
              .select({ code: schema.calculationRunBlockers.code })
              .from(schema.calculationRunBlockers)
              .where(eq(schema.calculationRunBlockers.runId, laterRunId))
            const lots = yield* db
              .select({ acquisitionEventId: schema.calculationRunDerivedLots.acquisitionEventId })
              .from(schema.calculationRunDerivedLots)
              .where(eq(schema.calculationRunDerivedLots.runId, laterRunId))
            return { blockers, lots, run }
          })
        )
      )
      expect(laterStored).toEqual({
        blockers: [{ code: "unresolved_identity" }],
        lots: [],
        run: { status: "partial" },
      })
    })
  )

  it.effect("changes the factual hash when a no-op override record is added", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({ id: INCLUDED_PROVIDER_ASSET_ID })
            yield* seedProviderTransaction({
              externalId: "revision-provider-fact",
              legId: "10000000-0000-4000-8000-000000000105",
              providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
            })
          })
        )
      )
      yield* Effect.promise(() => recompute("00000000-0000-4000-8000-000000000922"))

      yield* Effect.promise(() =>
        runPg(
          createOverride({
            kind: "inclusion",
            providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
            replacementInclusion: "included",
          })
        )
      )
      yield* Effect.promise(() => recompute("00000000-0000-4000-8000-000000000923"))

      const revisions = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ revision: schema.calculationRuns.inputLedgerRevision })
              .from(schema.calculationRuns)
          })
        )
      )
      const hashes = revisions.map(({ revision }) => revision.split(":").at(-1))
      expect(hashes).toHaveLength(2)
      expect(hashes[0]).not.toBe(hashes[1])
    })
  )
})
