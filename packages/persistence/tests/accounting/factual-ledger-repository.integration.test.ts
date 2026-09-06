import { prepareMovementLegFixtures } from "../support/movement-leg-fixtures.ts"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { CurrencyCode } from "@my/core/currency"
import { PrincipalId } from "@my/core/ownership"
import { and, eq, sql } from "drizzle-orm"
import * as BigDecimal from "effect/BigDecimal"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import { FactualLedgerRepositoryLive } from "../../src/layers/FactualLedgerRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import { FactualLedgerRepository } from "../../src/services/FactualLedgerRepository.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_BTC_REPRESENTATION_ID,
  TEST_USER_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const TEST_CUSTODY_SOURCE_ID = "00000000-0000-4000-8000-000000000281"
const TEST_CUSTODY_SOURCE_USE_ID = "00000000-0000-4000-8000-000000000291"
const TEST_DESTINATION_SOURCE_ID = "00000000-0000-4000-8000-000000000282"
const TEST_PRINCIPAL_ID = PrincipalId.make("00000000-0000-4000-8000-000000000183")
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000184"
const OTHER_PRINCIPAL_ID = PrincipalId.make("00000000-0000-4000-8000-000000000185")
const OTHER_SOURCE_ID = "00000000-0000-4000-8000-000000000283"
const NON_COINBASE_SOURCE_ID = "00000000-0000-4000-8000-000000000284"
const OVERRIDE_ASSET_ID = "00000000-0000-4000-8000-000000000482"
const PROVIDER_ASSET_ROW_ID = "00000000-0000-4000-8000-000000000701"
const DUPLICATE_PROVIDER_ASSET_ROW_ID = "00000000-0000-4000-8000-000000000702"
const EXCLUDED_PROVIDER_ASSET_ROW_ID = "00000000-0000-4000-8000-000000000703"
const CONCLUDED_PROVIDER_ASSET_ROW_ID = "00000000-0000-4000-8000-000000000704"
const MIXED_PROVIDER_ASSET_ROW_ID = "00000000-0000-4000-8000-000000000705"
const MIXED_OTHER_PROVIDER_ASSET_ROW_ID = "00000000-0000-4000-8000-000000000706"
const CONVERGED_PROVIDER_ASSET_ROW_ID = "00000000-0000-4000-8000-000000000707"
const CONVERGED_OTHER_PROVIDER_ASSET_ROW_ID = "00000000-0000-4000-8000-000000000708"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_factual_ledger_repo",
})

const runPg = context.runPg

const runRepository = <A, E>(effect: Effect.Effect<A, E, FactualLedgerRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: FactualLedgerRepositoryLive }))

const loadFactualLedgerInCurrency = (reportingCurrency: CurrencyCode) =>
  runRepository(
    Effect.flatMap(FactualLedgerRepository, (repository) =>
      repository.load({
        principalId: TEST_PRINCIPAL_ID,
        reportingCurrency,
      })
    )
  )

const loadFactualLedger = () => loadFactualLedgerInCurrency(CurrencyCode.make("EUR"))

const loadFactualLedgerBefore = (occurredBefore: Date) =>
  runRepository(
    Effect.flatMap(FactualLedgerRepository, (repository) =>
      repository.load({
        principalId: TEST_PRINCIPAL_ID,
        reportingCurrency: CurrencyCode.make("EUR"),
        occurredBefore,
      })
    )
  )

const loadFactualLedgerError = (reportingCurrency = CurrencyCode.make("EUR")) =>
  runRepository(
    Effect.flip(
      Effect.flatMap(FactualLedgerRepository, (repository) =>
        repository.load({
          principalId: TEST_PRINCIPAL_ID,
          reportingCurrency,
        })
      )
    )
  )

const seedOverrideAsset = Effect.gen(function* () {
  const db = yield* drizzle
  yield* db.insert(schema.assets).values({
    id: OVERRIDE_ASSET_ID,
    name: "Current provider conclusion asset",
    symbol: "CONCLUDED",
    type: "fungible",
  })
})

const seedProviderBoundaryAsset = ({
  providerAssetRowId,
  providerAssetId,
  canonicalAssetId,
  mappingStatus = "approved",
  currentConclusion,
}: {
  readonly providerAssetRowId: string
  readonly providerAssetId: string
  readonly canonicalAssetId: string
  readonly mappingStatus?: "approved" | "excluded"
  readonly currentConclusion?: {
    readonly outcome: "attach" | "excluded"
    readonly assetId?: string
  }
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-06T10:00:00.000Z"))
    yield* db.insert(schema.providerAssets).values({
      id: providerAssetRowId,
      provider: "coinbase",
      providerAssetId,
      currencyCode: "BOUNDARY",
      name: providerAssetId,
      providerType: "crypto",
      exponent: 8,
      rawProviderPayload: { asset_id: providerAssetId },
      evidenceRevision: 1,
      discoveredAt: occurredAt,
      retrievedAt: occurredAt,
    })
    yield* db.insert(schema.providerAssetMappings).values({
      providerAssetRowId,
      mappingKind: "asset",
      canonicalAssetId,
      mappingStatus,
    })
    if (currentConclusion === undefined) return

    const [conclusion] = yield* db
      .insert(schema.assetResolutionDecisions)
      .values({
        providerAssetRowId,
        evidenceRevision: 1,
        policyRevision: "provider-boundary-v1",
        outcome: currentConclusion.outcome,
        assetId: currentConclusion.assetId,
        actor: "user:provider-review",
      })
      .returning({ id: schema.assetResolutionDecisions.id })
    if (conclusion === undefined) {
      return yield* Effect.die("Failed to create current provider conclusion")
    }
    yield* db.insert(schema.assetResolutionCurrentState).values({
      providerAssetRowId,
      currentConclusionId: conclusion.id,
    })
  })

const createProviderOverride = ({
  providerAssetRowId,
  kind,
  replacementAssetId,
  replacementInclusion,
  inspectedSystemAssetId = TEST_BTC_ASSET_ID,
}: {
  readonly providerAssetRowId: string
  readonly kind: "identity" | "inclusion"
  readonly replacementAssetId?: string
  readonly replacementInclusion?: "included" | "excluded"
  readonly inspectedSystemAssetId?: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [target] = yield* db
      .insert(schema.principalAssetOverrideTargets)
      .values({
        principalId: TEST_PRINCIPAL_ID,
        targetKind: "provider_asset",
        providerAssetRowId,
      })
      .returning({ id: schema.principalAssetOverrideTargets.id })
    if (target === undefined) return yield* Effect.die("Failed to create provider target")

    yield* db.insert(schema.principalAssetOverrides).values({
      principalId: TEST_PRINCIPAL_ID,
      targetId: target.id,
      kind,
      operation: "create",
      inspectedSystemRevision: `provider-boundary-${kind}-v1`,
      inspectedSystemIdentity: kind === "identity" ? "resolved" : undefined,
      inspectedSystemAssetId: kind === "identity" ? inspectedSystemAssetId : undefined,
      inspectedSystemInclusion: kind === "inclusion" ? "included" : undefined,
      replacementAssetId,
      replacementInclusion,
      actorUserId: TEST_USER_ID,
      reason: `Test provider ${kind} boundary`,
    })
  })

const createExactIdentityOverride = Effect.gen(function* () {
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
  if (representation === undefined) return yield* Effect.die("Missing exact representation")

  const [target] = yield* db
    .insert(schema.principalAssetOverrideTargets)
    .values({
      principalId: TEST_PRINCIPAL_ID,
      targetKind: "representation",
      blockchainId: representation.blockchainId,
      representationType: representation.representationType,
      contractAddress: representation.contractAddress,
      mintAddress: representation.mintAddress,
    })
    .returning({ id: schema.principalAssetOverrideTargets.id })
  if (target === undefined) return yield* Effect.die("Failed to create exact target")

  yield* db.insert(schema.principalAssetOverrides).values({
    principalId: TEST_PRINCIPAL_ID,
    targetId: target.id,
    kind: "identity",
    operation: "create",
    inspectedSystemRevision: "exact-provider-boundary-v1",
    inspectedSystemIdentity: "resolved",
    inspectedSystemAssetId: TEST_BTC_ASSET_ID,
    replacementAssetId: OVERRIDE_ASSET_ID,
    actorUserId: TEST_USER_ID,
    reason: "Test exact identity boundary",
  })
})

const recordRepresentationUse = ({
  assetRepresentationId,
  id,
  sourceId,
}: {
  readonly assetRepresentationId: string
  readonly id?: string
  readonly sourceId: string
}) =>
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
      .where(eq(schema.assetRepresentations.id, assetRepresentationId))
    if (representation === undefined) return yield* Effect.die("Missing representation")

    yield* db
      .insert(schema.sourceRepresentationUses)
      .values({ id, sourceId, ...representation })
      .onConflictDoNothing()
    const [recordedUse] = yield* db
      .select({ id: schema.sourceRepresentationUses.id })
      .from(schema.sourceRepresentationUses)
      .where(
        and(
          eq(schema.sourceRepresentationUses.sourceId, sourceId),
          eq(schema.sourceRepresentationUses.blockchainId, representation.blockchainId),
          eq(schema.sourceRepresentationUses.representationType, representation.representationType),
          sql`${schema.sourceRepresentationUses.contractAddress} is not distinct from ${representation.contractAddress}`,
          sql`${schema.sourceRepresentationUses.mintAddress} is not distinct from ${representation.mintAddress}`
        )
      )
    if (recordedUse === undefined) return yield* Effect.die("Failed to record representation use")
    return recordedUse.id
  })

const seedProviderBoundaryTransaction = ({
  externalId,
  legs,
}: {
  readonly externalId: string
  readonly legs: ReadonlyArray<{
    readonly externalId: string
    readonly assetId: string
    readonly kind: "acquisition" | "fee"
    readonly providerAssetRowId?: string
    readonly assetRepresentationId?: string
  }>
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-06T10:00:00.000Z"))
    const [transaction] = yield* db
      .insert(schema.transactions)
      .values({
        sourceId: TEST_CUSTODY_SOURCE_ID,
        externalId,
        timestamp: occurredAt,
        transactionType: "buy_fiat",
        principalId: TEST_PRINCIPAL_ID,
      })
      .returning({ id: schema.transactions.id })
    if (transaction === undefined) return yield* Effect.die("Failed to create transaction")

    const sourceUseByRepresentation = new Map<string, string>()
    for (const representationId of new Set(
      legs.flatMap(({ assetRepresentationId }) =>
        assetRepresentationId === undefined ? [] : [assetRepresentationId]
      )
    )) {
      sourceUseByRepresentation.set(
        representationId,
        yield* recordRepresentationUse({
          assetRepresentationId: representationId,
          sourceId: TEST_CUSTODY_SOURCE_ID,
        })
      )
    }

    yield* db.insert(schema.transactionLegs).values(
      yield* prepareMovementLegFixtures(
        legs.map((leg) => ({
          movementIdentity: { sourceRecordKey: leg.externalId, componentKey: "movement" },
          sourceId: TEST_CUSTODY_SOURCE_ID,
          externalId: leg.externalId,
          timestamp: occurredAt,
          principalId: TEST_PRINCIPAL_ID,
          assetId: leg.assetId,
          assetRepresentationId: leg.assetRepresentationId,
          sourceRepresentationUseId:
            leg.assetRepresentationId === undefined
              ? undefined
              : sourceUseByRepresentation.get(leg.assetRepresentationId),
          amount: "1",
          kind: leg.kind,
          provenance: "deterministic" as const,
          originKind: "none" as const,
          providerAssetRowId: leg.providerAssetRowId,
          transactionId: transaction.id,
        }))
      )
    )
  })

const seedCexSource = ({
  sourceId,
  fixtureName,
  providerKey = "coinbase",
}: {
  readonly sourceId: string
  readonly fixtureName: string
  readonly providerKey?: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [existingAccount] = yield* db
      .select({ cexId: schema.cexAccount.cexId })
      .from(schema.cexAccount)
      .where(eq(schema.cexAccount.principalId, TEST_PRINCIPAL_ID))
      .limit(1)

    if (existingAccount === undefined) {
      return yield* Effect.die("Missing source account fixture")
    }

    const [account] = yield* db
      .insert(schema.cexAccount)
      .values({
        cexId: existingAccount.cexId,
        principalId: TEST_PRINCIPAL_ID,
        providerUserId: `${fixtureName}-user`,
        providerAccountId: `${fixtureName}-account`,
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-03-04T10:00:00.000Z")),
        scopes: "wallet:accounts:read wallet:transactions:read",
      })
      .returning({ id: schema.cexAccount.id })

    if (account === undefined) {
      return yield* Effect.die(`Failed to create account for ${fixtureName}`)
    }

    yield* db.insert(schema.sources).values({
      id: sourceId,
      principalId: TEST_PRINCIPAL_ID,
      name: fixtureName,
      providerKey,
      sourceableType: "cex",
      cexAccountId: account.id,
    })
  })

const seedCustodyReconciliation = ({
  reconciliationId,
  fixtureName,
  providerSourceId,
  canonicalSourceId,
  providerTimestamp,
  canonicalTimestamp,
  direction,
  amount,
  canonicalAmount,
  reconciliationStatus,
  status,
  deterministic,
  providerTransferSourceId,
  providerAssetRowId,
  providerHasExactUse = true,
  inventorySourceId,
  canonicalTransferSourceId,
}: {
  readonly reconciliationId: string
  readonly fixtureName: string
  readonly providerSourceId: string
  readonly canonicalSourceId: string
  readonly providerTimestamp: Date
  readonly canonicalTimestamp: Date
  readonly direction: "inbound" | "outbound"
  readonly amount: string
  readonly canonicalAmount?: string
  readonly reconciliationStatus: "matched" | "unmatched"
  readonly status: "approved" | "auto_applied" | "pending"
  readonly deterministic: boolean
  readonly providerTransferSourceId?: string
  readonly providerAssetRowId?: string
  readonly providerHasExactUse?: boolean
  readonly inventorySourceId?: string
  readonly canonicalTransferSourceId?: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [providerTransaction, canonicalTransaction] = yield* db
      .insert(schema.transactions)
      .values([
        {
          sourceId: providerSourceId,
          externalId: `${fixtureName}-provider-transaction`,
          timestamp: providerTimestamp,
          transactionType: "internal_transfer",
          principalId: TEST_PRINCIPAL_ID,
        },
        {
          sourceId: canonicalSourceId,
          externalId: `${fixtureName}-canonical-transaction`,
          timestamp: canonicalTimestamp,
          transactionType: "internal_transfer",
          principalId: TEST_PRINCIPAL_ID,
        },
      ])
      .returning({ id: schema.transactions.id })

    if (providerTransaction === undefined || canonicalTransaction === undefined) {
      return yield* Effect.die(`Failed to create transactions for ${fixtureName}`)
    }

    const providerSourceRepresentationUseId = providerHasExactUse
      ? yield* recordRepresentationUse({
          assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
          sourceId: providerTransferSourceId ?? providerSourceId,
        })
      : undefined
    const [providerTransfer] = yield* db
      .insert(schema.providerTransfers)
      .values({
        sourceId: providerTransferSourceId ?? providerSourceId,
        transactionId: providerTransaction.id,
        externalId: `${fixtureName}-provider-transfer`,
        providerAssetId: providerAssetRowId,
        sourceRepresentationUseId: providerSourceRepresentationUseId,
        timestamp: providerTimestamp,
        direction,
        processingMode: "accounting_only",
        fromAccountRef: "own:origin",
        toAccountRef: "own:destination",
        amount,
      })
      .returning({ id: schema.providerTransfers.id })
    const canonicalSourceRepresentationUseId = yield* recordRepresentationUse({
      assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
      sourceId: canonicalTransferSourceId ?? canonicalSourceId,
    })
    const [canonicalTransfer] = yield* db
      .insert(schema.transfers)
      .values({
        sourceId: canonicalTransferSourceId ?? canonicalSourceId,
        principalId: TEST_PRINCIPAL_ID,
        externalId: `${fixtureName}-canonical-transfer`,
        timestamp: canonicalTimestamp,
        type: "cex",
        fromAccountRef: "own:origin",
        toAccountRef: "own:destination",
        assetId: TEST_BTC_ASSET_ID,
        assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
        sourceRepresentationUseId: canonicalSourceRepresentationUseId,
        amount: canonicalAmount ?? amount,
      })
      .returning({ id: schema.transfers.id })

    if (providerTransfer === undefined || canonicalTransfer === undefined) {
      return yield* Effect.die(`Failed to create transfers for ${fixtureName}`)
    }

    yield* db.insert(schema.inventoryMovements).values({
      principalId: TEST_PRINCIPAL_ID,
      sourceId: inventorySourceId ?? providerSourceId,
      transactionId: providerTransaction.id,
      providerTransferId: providerTransfer.id,
      assetId: TEST_BTC_ASSET_ID,
      timestamp: providerTimestamp,
      direction,
      purpose: "principal",
      taxTreatment: "non_taxable",
      reconciliationStatus,
      amount,
    })
    yield* db.insert(schema.transferReconciliations).values({
      id: reconciliationId,
      principalId: TEST_PRINCIPAL_ID,
      providerTransferId: providerTransfer.id,
      canonicalTransferId: canonicalTransfer.id,
      canonicalTransactionId: canonicalTransaction.id,
      status,
      matchReason: `${fixtureName} integration fixture`,
      confidence: status === "pending" ? "0.5" : "1",
      deterministic,
    })

    return {
      providerTransferId: providerTransfer.id,
      providerSourceRepresentationUseId,
      providerTransactionId: providerTransaction.id,
      canonicalTransactionId: canonicalTransaction.id,
      canonicalTransferId: canonicalTransfer.id,
    }
  })

await Effect.runPromise(context.recreateTestDatabase())

describe("FactualLedgerRepositoryLive", () => {
  beforeEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* context.recreateTestDatabase()
        const fixture = yield* Effect.promise(() =>
          runPg(
            seedSyncEngineRepositoryFixture({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_CUSTODY_SOURCE_ID,
            })
          )
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
            recordRepresentationUse({
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
              id: TEST_CUSTODY_SOURCE_USE_ID,
              sourceId: TEST_CUSTODY_SOURCE_ID,
            })
          )
        )
      })
    )
  )

  it.effect("loads stored legs as a deterministically ordered factual ledger", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-03T10:00:00.000Z"))

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [purchaseTransaction, saleTransaction] = yield* db
              .insert(schema.transactions)
              .values([
                {
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "factual-ledger-purchase",
                  timestamp: occurredAt,
                  transactionType: "buy_fiat",
                  principalId: TEST_PRINCIPAL_ID,
                },
                {
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "factual-ledger-sale",
                  timestamp: occurredAt,
                  transactionType: "sell_fiat",
                  principalId: TEST_PRINCIPAL_ID,
                },
              ])
              .returning({ id: schema.transactions.id })

            if (purchaseTransaction === undefined || saleTransaction === undefined) {
              return yield* Effect.die("Failed to create factual ledger transactions")
            }

            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures([
                {
                  movementIdentity: {
                    sourceRecordKey: "factual-ledger-purchase-leg",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000002",
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "factual-ledger-purchase-leg",
                  timestamp: occurredAt,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  sourceRepresentationUseId: TEST_CUSTODY_SOURCE_USE_ID,
                  amount: "1.25",
                  kind: "acquisition",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  transactionId: purchaseTransaction.id,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "factual-ledger-sale-leg",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000001",
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "factual-ledger-sale-leg",
                  timestamp: occurredAt,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  sourceRepresentationUseId: TEST_CUSTODY_SOURCE_USE_ID,
                  amount: "0.5",
                  kind: "disposal",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  transactionId: saleTransaction.id,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "factual-ledger-sale-acquisition-leg",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000003",
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "factual-ledger-sale-acquisition-leg",
                  timestamp: occurredAt,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  sourceRepresentationUseId: TEST_CUSTODY_SOURCE_USE_ID,
                  amount: "0.75",
                  kind: "acquisition",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  transactionId: saleTransaction.id,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "factual-ledger-purchase-disposition-leg",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000004",
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "factual-ledger-purchase-disposition-leg",
                  timestamp: occurredAt,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  sourceRepresentationUseId: TEST_CUSTODY_SOURCE_USE_ID,
                  amount: "0.25",
                  kind: "disposal",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  transactionId: purchaseTransaction.id,
                },
              ])
            )
          })
        )
      )

      const result = yield* Effect.promise(loadFactualLedger)

      expect(
        result.events.map((event) => ({
          id: event.id,
          type: event._tag,
          cause: event._tag === "custody_movement" ? null : event.cause,
          transactionReference: event.transactionReference,
        }))
      ).toEqual([
        {
          id: "10000000-0000-4000-8000-000000000001",
          type: "disposition",
          cause: "sale",
          transactionReference: "factual-ledger-sale",
        },
        {
          id: "10000000-0000-4000-8000-000000000002",
          type: "acquisition",
          cause: "purchase",
          transactionReference: "factual-ledger-purchase",
        },
        {
          id: "10000000-0000-4000-8000-000000000003",
          type: "acquisition",
          cause: "purchase",
          transactionReference: "factual-ledger-sale",
        },
        {
          id: "10000000-0000-4000-8000-000000000004",
          type: "disposition",
          cause: "sale",
          transactionReference: "factual-ledger-purchase",
        },
      ])
      expect(
        BigDecimal.equals(
          result.events[0]?.quantity ?? BigDecimal.fromBigInt(0n),
          BigDecimal.fromStringUnsafe("0.5")
        )
      ).toBe(true)
      expect(
        BigDecimal.equals(
          result.events[1]?.quantity ?? BigDecimal.fromBigInt(0n),
          BigDecimal.fromStringUnsafe("1.25")
        )
      ).toBe(true)
      expect(result.valuationFacts).toEqual([])
    })
  )

  it.effect("classifies only Coinbase staking payouts as passive staking rewards", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-03T10:00:00.000Z"))

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* seedCexSource({
              sourceId: NON_COINBASE_SOURCE_ID,
              fixtureName: "Other CEX",
              providerKey: "other-cex",
            })
            const otherSourceUseId = yield* recordRepresentationUse({
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
              sourceId: NON_COINBASE_SOURCE_ID,
            })
            const transactionInputs = [
              {
                sourceId: TEST_CUSTODY_SOURCE_ID,
                externalId: "coinbase-staking-reward",
                transactionType: "staking_reward",
                providerTransactionType: "staking_reward",
              },
              {
                sourceId: TEST_CUSTODY_SOURCE_ID,
                externalId: "coinbase-earn-payout",
                transactionType: "staking_reward",
                providerTransactionType: "earn_payout",
              },
              {
                sourceId: TEST_CUSTODY_SOURCE_ID,
                externalId: "coinbase-interest-received",
                transactionType: "interest_received",
                providerTransactionType: "interest",
              },
              {
                sourceId: TEST_CUSTODY_SOURCE_ID,
                externalId: "coinbase-other-interest",
                transactionType: "interest_received",
                providerTransactionType: "lending_interest",
              },
              {
                sourceId: NON_COINBASE_SOURCE_ID,
                externalId: "other-staking-reward",
                transactionType: "staking_reward",
                providerTransactionType: "staking_reward",
              },
              {
                sourceId: NON_COINBASE_SOURCE_ID,
                externalId: "other-interest-received",
                transactionType: "interest_received",
                providerTransactionType: "interest",
              },
            ] as const
            const transactions = yield* db
              .insert(schema.transactions)
              .values(
                transactionInputs.map((transaction) => ({
                  ...transaction,
                  timestamp: occurredAt,
                  principalId: TEST_PRINCIPAL_ID,
                }))
              )
              .returning({
                id: schema.transactions.id,
                externalId: schema.transactions.externalId,
                sourceId: schema.transactions.sourceId,
              })

            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures(
                transactions.map((transaction, index) => {
                  return {
                    movementIdentity: {
                      sourceRecordKey: transaction.externalId ?? "income-fixture",
                      componentKey: "movement",
                    },
                    id: `10000000-0000-4000-8000-00000000001${index}`,
                    sourceId: transaction.sourceId,
                    externalId: `${transaction.externalId ?? transaction.id}-leg`,
                    timestamp: occurredAt,
                    principalId: TEST_PRINCIPAL_ID,
                    assetId: TEST_BTC_ASSET_ID,
                    sourceRepresentationUseId:
                      transaction.sourceId === TEST_CUSTODY_SOURCE_ID
                        ? TEST_CUSTODY_SOURCE_USE_ID
                        : otherSourceUseId,
                    amount: "1",
                    kind: "income" as const,
                    provenance: "deterministic" as const,
                    originKind: "none" as const,
                    transactionId: transaction.id,
                  }
                })
              )
            )
          })
        )
      )

      const result = yield* Effect.promise(loadFactualLedger)

      expect(
        result.events.map((event) => ({
          transactionReference: event.transactionReference,
          cause: event._tag === "acquisition" ? event.cause : null,
        }))
      ).toEqual([
        { transactionReference: "coinbase-staking-reward", cause: "passive_staking_reward" },
        { transactionReference: "coinbase-earn-payout", cause: "passive_staking_reward" },
        { transactionReference: "coinbase-interest-received", cause: "passive_staking_reward" },
        { transactionReference: "coinbase-other-interest", cause: "reward" },
        { transactionReference: "other-staking-reward", cause: "staking_reward" },
        { transactionReference: "other-interest-received", cause: "reward" },
      ])
    })
  )

  it.effect("applies exact identity overrides at read time without crossing principals", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-04T10:00:00.000Z"))

      const activeOverride = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* seedCexSource({
              sourceId: TEST_DESTINATION_SOURCE_ID,
              fixtureName: "second-provider-source",
            })
            yield* db
              .update(schema.sources)
              .set({ providerKey: "second-exact-provider" })
              .where(eq(schema.sources.id, TEST_DESTINATION_SOURCE_ID))
            yield* seedSyncEngineRepositoryFixture({
              userId: OTHER_USER_ID,
              principalId: OTHER_PRINCIPAL_ID,
              sourceId: OTHER_SOURCE_ID,
            })
            yield* db.insert(schema.assets).values({
              id: OVERRIDE_ASSET_ID,
              name: "Principal-selected asset",
              symbol: "SELECTED",
              type: "fungible",
            })
            const [representation] = yield* db
              .select({
                blockchainId: schema.assetRepresentations.blockchainId,
                type: schema.assetRepresentations.type,
                contractAddress: schema.assetRepresentations.contractAddress,
                mintAddress: schema.assetRepresentations.mintAddress,
              })
              .from(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
            if (representation === undefined) {
              return yield* Effect.die("Missing exact representation fixture")
            }

            const [target] = yield* db
              .insert(schema.principalAssetOverrideTargets)
              .values({
                principalId: TEST_PRINCIPAL_ID,
                targetKind: "representation",
                blockchainId: representation.blockchainId,
                representationType: representation.type,
                contractAddress: representation.contractAddress,
                mintAddress: representation.mintAddress,
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
                inspectedSystemRevision: "adapter-system-v1",
                inspectedSystemIdentity: "resolved",
                inspectedSystemAssetId: TEST_BTC_ASSET_ID,
                replacementAssetId: OVERRIDE_ASSET_ID,
                actorUserId: TEST_USER_ID,
                reason: "Use a principal-local economic identity",
              })
              .returning({ id: schema.principalAssetOverrides.id })
            if (override === undefined) return yield* Effect.die("Failed to create override")

            const transactions = yield* db
              .insert(schema.transactions)
              .values([
                {
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "adapter-first-provider",
                  timestamp: occurredAt,
                  transactionType: "buy_fiat",
                  principalId: TEST_PRINCIPAL_ID,
                },
                {
                  sourceId: TEST_DESTINATION_SOURCE_ID,
                  externalId: "adapter-second-provider",
                  timestamp: occurredAt,
                  transactionType: "buy_fiat",
                  principalId: TEST_PRINCIPAL_ID,
                },
                {
                  sourceId: OTHER_SOURCE_ID,
                  externalId: "adapter-other-principal",
                  timestamp: occurredAt,
                  transactionType: "buy_fiat",
                  principalId: OTHER_PRINCIPAL_ID,
                },
              ])
              .returning({ id: schema.transactions.id })
            const [firstTransaction, secondTransaction, otherTransaction] = transactions
            if (
              firstTransaction === undefined ||
              secondTransaction === undefined ||
              otherTransaction === undefined
            ) {
              return yield* Effect.die("Failed to create facts")
            }
            const factTransactions = [firstTransaction, secondTransaction, otherTransaction]
            const sourceUseIds = yield* Effect.forEach(
              [TEST_CUSTODY_SOURCE_ID, TEST_DESTINATION_SOURCE_ID, OTHER_SOURCE_ID],
              (sourceId) =>
                recordRepresentationUse({
                  assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
                  sourceId,
                })
            )

            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures(
                factTransactions.map((transaction, index) => ({
                  movementIdentity: {
                    sourceRecordKey: `adapter-exact-leg-${index}`,
                    componentKey: "movement",
                  },
                  sourceId:
                    index === 0
                      ? TEST_CUSTODY_SOURCE_ID
                      : index === 1
                        ? TEST_DESTINATION_SOURCE_ID
                        : OTHER_SOURCE_ID,
                  externalId: `adapter-exact-leg-${index}`,
                  timestamp: occurredAt,
                  principalId: index === 2 ? OTHER_PRINCIPAL_ID : TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
                  sourceRepresentationUseId: sourceUseIds[index],
                  amount: "1",
                  kind: "acquisition" as const,
                  provenance: "deterministic" as const,
                  originKind: "none" as const,
                  transactionId: transaction.id,
                }))
              )
            )

            // Evidence-only observations stay as evidence and never become accounting events.
            yield* db.insert(schema.providerTransfers).values({
              sourceId: TEST_CUSTODY_SOURCE_ID,
              transactionId: firstTransaction.id,
              externalId: "adapter-evidence-only",
              timestamp: occurredAt,
              direction: "inbound",
              processingMode: "evidence_only",
              fromAccountRef: "external",
              toAccountRef: "owned",
              observedBlockchainId: representation.blockchainId,
              observedRepresentationType: representation.type,
              observedContractAddress: representation.contractAddress,
              observedMintAddress: representation.mintAddress,
              amount: "7",
            })
            return { targetId: target.id, overrideId: override.id }
          })
        )
      )

      const principalLedger = yield* Effect.promise(loadFactualLedger)
      const otherLedger = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(FactualLedgerRepository, (repository) =>
            repository.load({
              principalId: OTHER_PRINCIPAL_ID,
              reportingCurrency: CurrencyCode.make("EUR"),
            })
          )
        )
      )
      const [representation] = yield* Effect.promise(() =>
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

      expect(principalLedger.events).toHaveLength(2)
      expect(principalLedger.events.map(({ assetId }) => assetId)).toEqual([
        OVERRIDE_ASSET_ID,
        OVERRIDE_ASSET_ID,
      ])
      expect(principalLedger.principalAssetOverrideRevision).toHaveLength(1)
      expect(otherLedger.events).toHaveLength(1)
      expect(otherLedger.events[0]?.assetId).toBe(TEST_BTC_ASSET_ID)
      expect(otherLedger.principalAssetOverrideRevision).toEqual([])
      expect(representation?.assetId).toBe(TEST_BTC_ASSET_ID)

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.principalAssetOverrides).values({
              principalId: TEST_PRINCIPAL_ID,
              targetId: activeOverride.targetId,
              kind: "identity",
              operation: "withdraw",
              inspectedSystemRevision: "adapter-system-v1",
              inspectedSystemIdentity: "resolved",
              inspectedSystemAssetId: TEST_BTC_ASSET_ID,
              actorUserId: TEST_USER_ID,
              reason: "Return adapted events to the system identity",
              supersedesOverrideId: activeOverride.overrideId,
            })
          })
        )
      )
      const withdrawnLedger = yield* Effect.promise(loadFactualLedger)
      expect(withdrawnLedger.events.map(({ assetId }) => assetId)).toEqual([
        TEST_BTC_ASSET_ID,
        TEST_BTC_ASSET_ID,
      ])
      expect(withdrawnLedger.principalAssetOverrideRevision[0]?.operation).toBe("withdraw")
    })
  )

  it.effect("applies chainless provider-asset identity by exact row at read time", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-05T10:00:00.000Z"))
      const activeOverride = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* seedSyncEngineRepositoryFixture({
              userId: OTHER_USER_ID,
              principalId: OTHER_PRINCIPAL_ID,
              sourceId: OTHER_SOURCE_ID,
            })
            yield* db.insert(schema.assets).values({
              id: OVERRIDE_ASSET_ID,
              name: "Principal-selected provider asset",
              symbol: "SELECTED",
              type: "fungible",
            })
            const [representation] = yield* db
              .select({ blockchainId: schema.assetRepresentations.blockchainId })
              .from(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
            if (representation === undefined) {
              return yield* Effect.die("Missing exact representation fixture")
            }
            yield* db.insert(schema.providerAssets).values([
              {
                id: PROVIDER_ASSET_ROW_ID,
                provider: "coinbase",
                providerAssetId: "duplicate-stable-a",
                currencyCode: "DUP",
                name: "Duplicate provider asset",
                providerType: "crypto",
                exponent: 8,
                rawProviderPayload: { asset_id: "duplicate-stable-a" },
                evidenceRevision: 1,
                discoveredAt: occurredAt,
                retrievedAt: occurredAt,
              },
              {
                id: DUPLICATE_PROVIDER_ASSET_ROW_ID,
                provider: "coinbase",
                providerAssetId: "duplicate-stable-b",
                currencyCode: "DUP",
                name: "Duplicate provider asset",
                providerType: "crypto",
                exponent: 8,
                rawProviderPayload: { asset_id: "duplicate-stable-b" },
                evidenceRevision: 1,
                discoveredAt: occurredAt,
                retrievedAt: occurredAt,
              },
            ])
            yield* db.insert(schema.providerAssetMappings).values([
              {
                providerAssetRowId: PROVIDER_ASSET_ROW_ID,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                mappingStatus: "approved",
              },
              {
                providerAssetRowId: DUPLICATE_PROVIDER_ASSET_ROW_ID,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                mappingStatus: "approved",
              },
            ])

            const [target] = yield* db
              .insert(schema.principalAssetOverrideTargets)
              .values({
                principalId: TEST_PRINCIPAL_ID,
                targetKind: "provider_asset",
                providerAssetRowId: PROVIDER_ASSET_ROW_ID,
              })
              .returning({ id: schema.principalAssetOverrideTargets.id })
            if (target === undefined) return yield* Effect.die("Failed to create provider target")

            const [override] = yield* db
              .insert(schema.principalAssetOverrides)
              .values({
                principalId: TEST_PRINCIPAL_ID,
                targetId: target.id,
                kind: "identity",
                operation: "create",
                inspectedSystemRevision: "provider-adapter-system-v1",
                inspectedSystemIdentity: "resolved",
                inspectedSystemAssetId: TEST_BTC_ASSET_ID,
                replacementAssetId: OVERRIDE_ASSET_ID,
                actorUserId: TEST_USER_ID,
                reason: "Use the selected provider-row identity",
              })
              .returning({ id: schema.principalAssetOverrides.id })
            if (override === undefined) return yield* Effect.die("Failed to create override")

            const transactions = yield* db
              .insert(schema.transactions)
              .values([
                {
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "provider-adapter-selected-row",
                  timestamp: occurredAt,
                  transactionType: "buy_fiat",
                  principalId: TEST_PRINCIPAL_ID,
                },
                {
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "provider-adapter-duplicate-row",
                  timestamp: occurredAt,
                  transactionType: "buy_fiat",
                  principalId: TEST_PRINCIPAL_ID,
                },
                {
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "provider-adapter-exact-wins",
                  timestamp: occurredAt,
                  transactionType: "buy_fiat",
                  principalId: TEST_PRINCIPAL_ID,
                },
                {
                  sourceId: OTHER_SOURCE_ID,
                  externalId: "provider-adapter-other-principal",
                  timestamp: occurredAt,
                  transactionType: "buy_fiat",
                  principalId: OTHER_PRINCIPAL_ID,
                },
                {
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "provider-adapter-contradiction",
                  timestamp: occurredAt,
                  transactionType: "buy_fiat",
                  principalId: TEST_PRINCIPAL_ID,
                },
              ])
              .returning({ id: schema.transactions.id })
            const [
              selectedTransaction,
              duplicateTransaction,
              exactTransaction,
              otherTransaction,
              contradictoryTransaction,
            ] = transactions
            if (
              selectedTransaction === undefined ||
              duplicateTransaction === undefined ||
              exactTransaction === undefined ||
              otherTransaction === undefined ||
              contradictoryTransaction === undefined
            ) {
              return yield* Effect.die("Failed to create provider adapter facts")
            }
            const exactSourceUseId = yield* recordRepresentationUse({
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
              sourceId: TEST_CUSTODY_SOURCE_ID,
            })

            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures([
                {
                  movementIdentity: {
                    sourceRecordKey: "provider-adapter-selected-row-leg",
                    componentKey: "movement",
                  },
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "provider-adapter-selected-row-leg",
                  timestamp: occurredAt,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "1",
                  kind: "acquisition",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  providerAssetRowId: PROVIDER_ASSET_ROW_ID,
                  transactionId: selectedTransaction.id,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "provider-adapter-duplicate-row-leg",
                    componentKey: "movement",
                  },
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "provider-adapter-duplicate-row-leg",
                  timestamp: occurredAt,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "1",
                  kind: "acquisition",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  providerAssetRowId: DUPLICATE_PROVIDER_ASSET_ROW_ID,
                  transactionId: duplicateTransaction.id,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "provider-adapter-exact-wins-leg",
                    componentKey: "movement",
                  },
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "provider-adapter-exact-wins-leg",
                  timestamp: occurredAt,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "1",
                  kind: "acquisition",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  providerAssetRowId: PROVIDER_ASSET_ROW_ID,
                  sourceRepresentationUseId: exactSourceUseId,
                  transactionId: exactTransaction.id,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "provider-adapter-other-principal-leg",
                    componentKey: "movement",
                  },
                  sourceId: OTHER_SOURCE_ID,
                  externalId: "provider-adapter-other-principal-leg",
                  timestamp: occurredAt,
                  principalId: OTHER_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "1",
                  kind: "acquisition",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  providerAssetRowId: PROVIDER_ASSET_ROW_ID,
                  transactionId: otherTransaction.id,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "provider-adapter-contradiction-selected-leg",
                    componentKey: "movement",
                  },
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "provider-adapter-contradiction-selected-leg",
                  timestamp: occurredAt,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "1",
                  kind: "acquisition",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  providerAssetRowId: PROVIDER_ASSET_ROW_ID,
                  transactionId: contradictoryTransaction.id,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "provider-adapter-contradiction-system-leg",
                    componentKey: "movement",
                  },
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "provider-adapter-contradiction-system-leg",
                  timestamp: occurredAt,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "1",
                  kind: "acquisition",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  providerAssetRowId: DUPLICATE_PROVIDER_ASSET_ROW_ID,
                  transactionId: contradictoryTransaction.id,
                },
              ])
            )
            yield* db.insert(schema.providerTransfers).values({
              sourceId: TEST_CUSTODY_SOURCE_ID,
              transactionId: exactTransaction.id,
              externalId: "provider-adapter-exact-observation",
              providerAssetId: PROVIDER_ASSET_ROW_ID,
              timestamp: occurredAt,
              direction: "inbound",
              processingMode: "evidence_only",
              fromAccountRef: "external",
              toAccountRef: "owned",
              observedBlockchainId: representation.blockchainId,
              observedRepresentationType: "native",
              amount: "1",
            })

            return { targetId: target.id, overrideId: override.id }
          })
        )
      )

      const principalLedger = yield* Effect.promise(loadFactualLedger)
      const otherLedger = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(FactualLedgerRepository, (repository) =>
            repository.load({
              principalId: OTHER_PRINCIPAL_ID,
              reportingCurrency: CurrencyCode.make("EUR"),
            })
          )
        )
      )

      expect(
        Object.fromEntries(
          principalLedger.events.map((event) => [event.transactionReference, event.assetId])
        )
      ).toEqual({
        "provider-adapter-selected-row": OVERRIDE_ASSET_ID,
        "provider-adapter-duplicate-row": TEST_BTC_ASSET_ID,
        "provider-adapter-exact-wins": TEST_BTC_ASSET_ID,
      })
      expect(otherLedger.events[0]?.assetId).toBe(TEST_BTC_ASSET_ID)
      expect(principalLedger.principalAssetOverrideRevision).toEqual([
        expect.objectContaining({
          target: expect.objectContaining({
            _tag: "provider_asset",
            providerAssetRowId: PROVIDER_ASSET_ROW_ID,
          }),
          kind: "identity",
          overrideId: activeOverride.overrideId,
          operation: "create",
        }),
      ])

      const inclusionOverrideId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [override] = yield* db
              .insert(schema.principalAssetOverrides)
              .values({
                principalId: TEST_PRINCIPAL_ID,
                targetId: activeOverride.targetId,
                kind: "inclusion",
                operation: "create",
                inspectedSystemRevision: "provider-adapter-inclusion-v1",
                inspectedSystemInclusion: "included",
                replacementInclusion: "excluded",
                actorUserId: TEST_USER_ID,
                reason: "Exclude this chainless provider row",
              })
              .returning({ id: schema.principalAssetOverrides.id })
            if (override === undefined) {
              return yield* Effect.die("Failed to create provider inclusion override")
            }
            return override.id
          })
        )
      )
      const excludedLedger = yield* Effect.promise(loadFactualLedger)
      expect(
        Object.fromEntries(
          excludedLedger.events.map((event) => [event.transactionReference, event.assetId])
        )
      ).toEqual({
        "provider-adapter-duplicate-row": TEST_BTC_ASSET_ID,
        "provider-adapter-exact-wins": TEST_BTC_ASSET_ID,
      })

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.principalAssetOverrides).values([
              {
                principalId: TEST_PRINCIPAL_ID,
                targetId: activeOverride.targetId,
                kind: "inclusion" as const,
                operation: "withdraw" as const,
                inspectedSystemRevision: "provider-adapter-inclusion-v1",
                inspectedSystemInclusion: "included" as const,
                actorUserId: TEST_USER_ID,
                reason: "Return this provider row to system inclusion",
                supersedesOverrideId: inclusionOverrideId,
              },
              {
                principalId: TEST_PRINCIPAL_ID,
                targetId: activeOverride.targetId,
                kind: "identity" as const,
                operation: "withdraw" as const,
                inspectedSystemRevision: "provider-adapter-system-v1",
                inspectedSystemIdentity: "resolved" as const,
                inspectedSystemAssetId: TEST_BTC_ASSET_ID,
                actorUserId: TEST_USER_ID,
                reason: "Return provider facts to the system identity",
                supersedesOverrideId: activeOverride.overrideId,
              },
            ])
          })
        )
      )

      const withdrawnLedger = yield* Effect.promise(loadFactualLedger)
      expect(withdrawnLedger.events.every(({ assetId }) => assetId === TEST_BTC_ASSET_ID)).toBe(
        true
      )
      expect(withdrawnLedger.events).toHaveLength(5)
      expect(withdrawnLedger.principalAssetOverrideRevision[0]).toEqual(
        expect.objectContaining({ operation: "withdraw" })
      )

      const mappings = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                providerAssetRowId: schema.providerAssetMappings.providerAssetRowId,
                canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
              })
              .from(schema.providerAssetMappings)
          })
        )
      )
      expect(mappings).toEqual(
        expect.arrayContaining([
          { providerAssetRowId: PROVIDER_ASSET_ROW_ID, canonicalAssetId: TEST_BTC_ASSET_ID },
          {
            providerAssetRowId: DUPLICATE_PROVIDER_ASSET_ROW_ID,
            canonicalAssetId: TEST_BTC_ASSET_ID,
          },
        ])
      )
    })
  )

  it.effect("uses the current provider identity conclusion over its mapping", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedOverrideAsset
            yield* seedProviderBoundaryAsset({
              providerAssetRowId: CONCLUDED_PROVIDER_ASSET_ROW_ID,
              providerAssetId: "current-conclusion",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              currentConclusion: { outcome: "attach", assetId: OVERRIDE_ASSET_ID },
            })
            yield* seedProviderBoundaryTransaction({
              externalId: "provider-boundary-current-conclusion",
              legs: [
                {
                  externalId: "provider-boundary-current-conclusion-leg",
                  assetId: TEST_BTC_ASSET_ID,
                  kind: "acquisition",
                  providerAssetRowId: CONCLUDED_PROVIDER_ASSET_ROW_ID,
                },
              ],
            })
          })
        )
      )

      const ledger = yield* Effect.promise(loadFactualLedger)
      expect(ledger.events.map(({ assetId }) => assetId)).toEqual([OVERRIDE_ASSET_ID])
    })
  )

  it.effect("does not reverse an excluded provider conclusion before T12", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderBoundaryAsset({
              providerAssetRowId: EXCLUDED_PROVIDER_ASSET_ROW_ID,
              providerAssetId: "current-exclusion",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              currentConclusion: { outcome: "excluded" },
            })
            yield* createProviderOverride({
              providerAssetRowId: EXCLUDED_PROVIDER_ASSET_ROW_ID,
              kind: "inclusion",
              replacementInclusion: "included",
            })
            yield* seedProviderBoundaryTransaction({
              externalId: "provider-boundary-current-exclusion",
              legs: [
                {
                  externalId: "provider-boundary-current-exclusion-leg",
                  assetId: TEST_BTC_ASSET_ID,
                  kind: "acquisition",
                  providerAssetRowId: EXCLUDED_PROVIDER_ASSET_ROW_ID,
                },
              ],
            })
            yield* seedProviderBoundaryTransaction({
              externalId: "provider-boundary-exact-current-exclusion",
              legs: [
                {
                  externalId: "provider-boundary-exact-current-exclusion-leg",
                  assetId: TEST_BTC_ASSET_ID,
                  assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
                  kind: "acquisition",
                  providerAssetRowId: EXCLUDED_PROVIDER_ASSET_ROW_ID,
                },
                {
                  externalId: "provider-boundary-exact-current-exclusion-kept-leg",
                  assetId: TEST_BTC_ASSET_ID,
                  assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
                  kind: "acquisition",
                },
              ],
            })
          })
        )
      )

      const ledger = yield* Effect.promise(loadFactualLedger)
      expect(ledger.events).toEqual([])
    })
  )

  it.effect("withholds a whole provider transaction when one leg is excluded", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderBoundaryAsset({
              providerAssetRowId: MIXED_PROVIDER_ASSET_ROW_ID,
              providerAssetId: "mixed-excluded",
              canonicalAssetId: TEST_BTC_ASSET_ID,
            })
            yield* seedProviderBoundaryAsset({
              providerAssetRowId: MIXED_OTHER_PROVIDER_ASSET_ROW_ID,
              providerAssetId: "mixed-kept",
              canonicalAssetId: TEST_BTC_ASSET_ID,
            })
            yield* createProviderOverride({
              providerAssetRowId: MIXED_PROVIDER_ASSET_ROW_ID,
              kind: "inclusion",
              replacementInclusion: "excluded",
            })
            yield* seedProviderBoundaryTransaction({
              externalId: "provider-boundary-mixed-exclusion",
              legs: [
                {
                  externalId: "provider-boundary-mixed-excluded-leg",
                  assetId: TEST_BTC_ASSET_ID,
                  kind: "fee",
                  providerAssetRowId: MIXED_PROVIDER_ASSET_ROW_ID,
                },
                {
                  externalId: "provider-boundary-mixed-kept-leg",
                  assetId: TEST_BTC_ASSET_ID,
                  kind: "acquisition",
                  providerAssetRowId: MIXED_OTHER_PROVIDER_ASSET_ROW_ID,
                },
              ],
            })
            yield* seedProviderBoundaryTransaction({
              externalId: "provider-boundary-unrelated",
              legs: [
                {
                  externalId: "provider-boundary-unrelated-leg",
                  assetId: TEST_BTC_ASSET_ID,
                  kind: "acquisition",
                  providerAssetRowId: MIXED_OTHER_PROVIDER_ASSET_ROW_ID,
                },
              ],
            })
          })
        )
      )

      const ledger = yield* Effect.promise(loadFactualLedger)
      expect(ledger.events).toHaveLength(1)
      expect(ledger.events[0]?._tag).toBe("acquisition")
      expect(ledger.events[0]?.assetId).toBe(TEST_BTC_ASSET_ID)
      expect(ledger.events[0]?.transactionReference).toBe("provider-boundary-unrelated")
    })
  )

  it.effect("withholds exact and provider legs with contradictory effective identities", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedOverrideAsset
            yield* seedProviderBoundaryAsset({
              providerAssetRowId: MIXED_OTHER_PROVIDER_ASSET_ROW_ID,
              providerAssetId: "exact-provider-conflict",
              canonicalAssetId: TEST_BTC_ASSET_ID,
            })
            yield* createExactIdentityOverride
            yield* seedProviderBoundaryTransaction({
              externalId: "provider-boundary-exact-provider-contradiction",
              legs: [
                {
                  externalId: "provider-boundary-exact-conflict-leg",
                  assetId: OVERRIDE_ASSET_ID,
                  assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
                  kind: "acquisition",
                },
                {
                  externalId: "provider-boundary-provider-conflict-leg",
                  assetId: TEST_BTC_ASSET_ID,
                  kind: "acquisition",
                  providerAssetRowId: MIXED_OTHER_PROVIDER_ASSET_ROW_ID,
                },
              ],
            })
          })
        )
      )

      const ledger = yield* Effect.promise(loadFactualLedger)
      expect(ledger.events).toEqual([])
    })
  )

  it.effect("groups provider conflicts by the current system identity", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedOverrideAsset
            yield* seedProviderBoundaryAsset({
              providerAssetRowId: CONVERGED_PROVIDER_ASSET_ROW_ID,
              providerAssetId: "converged-stale-row",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              currentConclusion: { outcome: "attach", assetId: OVERRIDE_ASSET_ID },
            })
            yield* seedProviderBoundaryAsset({
              providerAssetRowId: CONVERGED_OTHER_PROVIDER_ASSET_ROW_ID,
              providerAssetId: "converged-current-row",
              canonicalAssetId: OVERRIDE_ASSET_ID,
            })
            yield* createProviderOverride({
              providerAssetRowId: CONVERGED_PROVIDER_ASSET_ROW_ID,
              kind: "identity",
              inspectedSystemAssetId: OVERRIDE_ASSET_ID,
              replacementAssetId: TEST_BTC_ASSET_ID,
            })
            yield* seedProviderBoundaryTransaction({
              externalId: "provider-boundary-converged-conflict",
              legs: [
                {
                  externalId: "provider-boundary-converged-stale-leg",
                  assetId: TEST_BTC_ASSET_ID,
                  kind: "acquisition",
                  providerAssetRowId: CONVERGED_PROVIDER_ASSET_ROW_ID,
                },
                {
                  externalId: "provider-boundary-converged-current-leg",
                  assetId: OVERRIDE_ASSET_ID,
                  kind: "acquisition",
                  providerAssetRowId: CONVERGED_OTHER_PROVIDER_ASSET_ROW_ID,
                },
              ],
            })
          })
        )
      )

      const ledger = yield* Effect.promise(loadFactualLedger)
      expect(ledger.events).toEqual([])
    })
  )

  it.effect("links a fee disposition to the operation it paid for", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-04T10:00:00.000Z"))

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [operation, feeTransaction] = yield* db
              .insert(schema.transactions)
              .values([
                {
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "paid-operation",
                  timestamp: occurredAt,
                  transactionType: "swap_crypto_to_crypto",
                  principalId: TEST_PRINCIPAL_ID,
                },
                {
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "fee-transaction",
                  timestamp: occurredAt,
                  transactionType: "gas_fee",
                  principalId: TEST_PRINCIPAL_ID,
                },
              ])
              .returning({ id: schema.transactions.id })

            if (operation === undefined || feeTransaction === undefined) {
              return yield* Effect.die("Failed to create fee transaction fixtures")
            }

            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures([
                {
                  movementIdentity: {
                    sourceRecordKey: "paid-operation-fee-leg",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000005",
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "paid-operation-fee-leg",
                  timestamp: occurredAt,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  sourceRepresentationUseId: TEST_CUSTODY_SOURCE_USE_ID,
                  amount: "0.01",
                  kind: "fee",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  transactionId: feeTransaction.id,
                  feeForTransactionId: operation.id,
                },
              ])
            )
          })
        )
      )

      const result = yield* Effect.promise(loadFactualLedger)

      expect(result.events).toEqual([
        expect.objectContaining({
          _tag: "disposition",
          cause: "fee",
          transactionReference: "paid-operation",
        }),
      ])
    })
  )

  it.effect("returns malformed blockers for non-positive leg quantities", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-04T11:00:00.000Z"))

      for (const [id, amount] of [
        ["10000000-0000-4000-8000-000000000006", "0"],
        ["10000000-0000-4000-8000-000000000007", "-1"],
      ] as const) {
        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db.insert(schema.transactionLegs).values(
                yield* prepareMovementLegFixtures([
                  {
                    movementIdentity: {
                      sourceRecordKey: `invalid-quantity-${amount}`,
                      componentKey: "movement",
                    },
                    id,
                    sourceId: TEST_CUSTODY_SOURCE_ID,
                    externalId: `invalid-quantity-${amount}`,
                    timestamp: occurredAt,
                    principalId: TEST_PRINCIPAL_ID,
                    assetId: TEST_BTC_ASSET_ID,
                    sourceRepresentationUseId: TEST_CUSTODY_SOURCE_USE_ID,
                    amount,
                    kind: "acquisition",
                    provenance: "deterministic",
                    originKind: "none" as const,
                  },
                ])
              )
            })
          )
        )

        const result = yield* Effect.promise(loadFactualLedger)
        expect(result.events).toEqual([])
        expect(result.inputBlockers).toEqual([
          expect.objectContaining({
            code: "malformed_movement",
            eventId: id,
            assetId: TEST_BTC_ASSET_ID,
          }),
        ])

        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db.delete(schema.transactionLegs).where(eq(schema.transactionLegs.id, id))
            })
          )
        )
      }
    })
  )

  it.effect("returns a malformed blocker for a zero canonical-transfer quantity", () =>
    Effect.gen(function* () {
      const providerTimestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-04T12:00:00.000Z"))
      const canonicalTimestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-04T12:02:00.000Z"))

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedCexSource({
              sourceId: TEST_DESTINATION_SOURCE_ID,
              fixtureName: "Zero-quantity destination source",
            })
            yield* seedCustodyReconciliation({
              reconciliationId: "10000000-0000-4000-8000-000000000008",
              fixtureName: "zero-quantity-custody",
              providerSourceId: TEST_CUSTODY_SOURCE_ID,
              canonicalSourceId: TEST_DESTINATION_SOURCE_ID,
              providerTimestamp,
              canonicalTimestamp,
              direction: "outbound",
              amount: "1",
              canonicalAmount: "0",
              reconciliationStatus: "matched",
              status: "approved",
              deterministic: false,
            })
          })
        )
      )

      const result = yield* Effect.promise(loadFactualLedger)
      expect(result.events).toEqual([])
      expect(result.inputBlockers).toEqual([
        expect.objectContaining({
          code: "malformed_movement",
          eventId: "10000000-0000-4000-8000-000000000008",
          assetId: TEST_BTC_ASSET_ID,
        }),
      ])
    })
  )

  it.effect("rejects an unsupported reporting currency through the repository error channel", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-04T13:00:00.000Z"))

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [transaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: TEST_CUSTODY_SOURCE_ID,
                externalId: "unsupported-reporting-currency",
                timestamp: occurredAt,
                transactionType: "buy_fiat",
                providerFiatAmount: "100",
                providerFiatCurrency: "NOK",
                principalId: TEST_PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })

            if (transaction === undefined) {
              return yield* Effect.die("Failed to create unsupported-currency transaction")
            }

            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures([
                {
                  movementIdentity: {
                    sourceRecordKey: "unsupported-reporting-currency-leg",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000009",
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "unsupported-reporting-currency-leg",
                  timestamp: occurredAt,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  sourceRepresentationUseId: TEST_CUSTODY_SOURCE_USE_ID,
                  amount: "1",
                  kind: "acquisition",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  transactionId: transaction.id,
                },
              ])
            )
            yield* db.insert(schema.assetPrices).values({
              assetId: TEST_BTC_ASSET_ID,
              timestamp: occurredAt,
              price: "50",
              currency: "NOK",
              source: "unsupported-currency-feed",
            })
          })
        )
      )

      const error = yield* Effect.promise(() => loadFactualLedgerError(CurrencyCode.make("NOK")))
      expect(error).toMatchObject({
        _tag: "PersistenceError",
        operation: "factualLedgerRepository.load.reportingCurrency",
      })
    })
  )

  it.effect("does not adapt transaction or source facts owned by another principal", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-05T10:00:00.000Z"))

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* seedSyncEngineRepositoryFixture({
              userId: OTHER_USER_ID,
              principalId: OTHER_PRINCIPAL_ID,
              sourceId: OTHER_SOURCE_ID,
            })
            const [
              foreignSourceTransaction,
              foreignTransactionOnOwnedSource,
              mismatchedSourceTransaction,
              mismatchedFeeTarget,
            ] = yield* db
              .insert(schema.transactions)
              .values([
                {
                  sourceId: OTHER_SOURCE_ID,
                  externalId: "foreign-source-transaction",
                  timestamp: occurredAt,
                  transactionType: "buy_fiat",
                  providerFiatAmount: "900",
                  providerFiatCurrency: "EUR",
                  principalId: OTHER_PRINCIPAL_ID,
                },
                {
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "foreign-transaction-on-owned-source",
                  timestamp: occurredAt,
                  transactionType: "sell_fiat",
                  providerFiatAmount: "800",
                  providerFiatCurrency: "EUR",
                  principalId: OTHER_PRINCIPAL_ID,
                },
                {
                  sourceId: OTHER_SOURCE_ID,
                  externalId: "same-principal-transaction-on-foreign-source",
                  timestamp: occurredAt,
                  transactionType: "buy_fiat",
                  providerFiatAmount: "700",
                  providerFiatCurrency: "EUR",
                  principalId: TEST_PRINCIPAL_ID,
                },
                {
                  sourceId: OTHER_SOURCE_ID,
                  externalId: "same-principal-fee-target-on-foreign-source",
                  timestamp: occurredAt,
                  transactionType: "swap_crypto_to_crypto",
                  principalId: TEST_PRINCIPAL_ID,
                },
              ])
              .returning({ id: schema.transactions.id })

            if (
              foreignSourceTransaction === undefined ||
              foreignTransactionOnOwnedSource === undefined ||
              mismatchedSourceTransaction === undefined ||
              mismatchedFeeTarget === undefined
            ) {
              return yield* Effect.die("Failed to create cross-principal transactions")
            }

            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures([
                {
                  movementIdentity: {
                    sourceRecordKey: "foreign-source-leg",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000040",
                  sourceId: OTHER_SOURCE_ID,
                  externalId: "foreign-source-leg",
                  timestamp: occurredAt,
                  principalId: OTHER_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "1",
                  kind: "acquisition",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  transactionId: foreignSourceTransaction.id,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "owned-source-leg",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000041",
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "owned-source-leg",
                  timestamp: occurredAt,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  sourceRepresentationUseId: TEST_CUSTODY_SOURCE_USE_ID,
                  amount: "2",
                  kind: "disposal",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  transactionId: foreignTransactionOnOwnedSource.id,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "owned-source-leg-with-other-source-transaction",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000042",
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "owned-source-leg-with-other-source-transaction",
                  timestamp: occurredAt,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  sourceRepresentationUseId: TEST_CUSTODY_SOURCE_USE_ID,
                  amount: "3",
                  kind: "acquisition",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  transactionId: mismatchedSourceTransaction.id,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "owned-source-fee-leg-with-foreign-source-target",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000043",
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "owned-source-fee-leg-with-foreign-source-target",
                  timestamp: occurredAt,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  sourceRepresentationUseId: TEST_CUSTODY_SOURCE_USE_ID,
                  amount: "0.01",
                  kind: "fee",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  feeForTransactionId: mismatchedFeeTarget.id,
                },
              ])
            )
          })
        )
      )

      const result = yield* Effect.promise(loadFactualLedger)

      expect(result.events).toEqual([
        expect.objectContaining({
          id: "10000000-0000-4000-8000-000000000041",
          _tag: "disposition",
          cause: "unknown",
        }),
        expect.objectContaining({
          id: "10000000-0000-4000-8000-000000000042",
          _tag: "acquisition",
          cause: "unknown",
        }),
        expect.objectContaining({
          id: "10000000-0000-4000-8000-000000000043",
          _tag: "disposition",
          cause: "fee",
        }),
      ])
      expect(result.events.map(({ transactionReference }) => transactionReference)).toEqual([
        undefined,
        undefined,
        undefined,
      ])
      expect(result.valuationFacts).toEqual([])
    })
  )

  it.effect("keeps provider consideration separate from the exact daily market quote", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-03T10:00:00.000Z"))
      const historicalQuoteAt = DateTime.toDateUtc(DateTime.makeUnsafe("2020-01-01T09:00:00.000Z"))
      const dailyQuoteAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-03T00:00:00.000Z"))
      const intradayQuoteAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-03T09:40:00.000Z"))
      const invalidQuoteAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-03T09:50:00.000Z"))
      const negativeQuoteAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-03T09:55:00.000Z"))
      const laterQuoteAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-03T11:00:00.000Z"))

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [transaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: TEST_CUSTODY_SOURCE_ID,
                externalGroupId: "   ",
                externalId: "  factual-ledger-valued-purchase  ",
                timestamp: occurredAt,
                transactionType: "buy_fiat",
                providerResourcePath: "  /v2/transactions/valued-purchase  ",
                providerFiatAmount: "1250.50",
                providerFiatCurrency: "EUR",
                principalId: TEST_PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })

            if (transaction === undefined) {
              return yield* Effect.die("Failed to create valued factual ledger transaction")
            }

            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures([
                {
                  movementIdentity: {
                    sourceRecordKey: "factual-ledger-valued-purchase-leg",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000010",
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "factual-ledger-valued-purchase-leg",
                  timestamp: occurredAt,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  sourceRepresentationUseId: TEST_CUSTODY_SOURCE_USE_ID,
                  amount: "2",
                  kind: "acquisition",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  transactionId: transaction.id,
                  fiatAmount: "999.00",
                  fiatCurrency: "EUR",
                },
              ])
            )
            yield* db.insert(schema.assetPrices).values([
              {
                assetId: TEST_BTC_ASSET_ID,
                timestamp: historicalQuoteAt,
                price: "99999",
                currency: "EUR",
                source: "unused-historical-feed",
              },
              {
                assetId: TEST_BTC_ASSET_ID,
                timestamp: dailyQuoteAt,
                price: "600.25",
                currency: "EUR",
                source: "coingecko",
              },
              {
                assetId: TEST_BTC_ASSET_ID,
                timestamp: dailyQuoteAt,
                price: "700.25",
                currency: "USD",
                source: "coingecko",
              },
              {
                assetId: TEST_BTC_ASSET_ID,
                timestamp: intradayQuoteAt,
                price: "650.75",
                currency: "EUR",
                source: "intraday-feed",
              },
              {
                assetId: TEST_BTC_ASSET_ID,
                timestamp: invalidQuoteAt,
                price: "NaN",
                currency: "EUR",
                source: "invalid-market-feed",
              },
              {
                assetId: TEST_BTC_ASSET_ID,
                timestamp: negativeQuoteAt,
                price: "-1",
                currency: "EUR",
                source: "negative-market-feed",
              },
              {
                assetId: TEST_BTC_ASSET_ID,
                timestamp: laterQuoteAt,
                price: "700.50",
                currency: "EUR",
                source: "future-market-feed",
              },
            ])
          })
        )
      )

      const result = yield* Effect.promise(loadFactualLedger)

      expect(result.events[0]?.transactionReference).toBe("factual-ledger-valued-purchase")

      expect(
        result.valuationFacts.map((fact) =>
          fact._tag === "observed_consideration"
            ? {
                type: fact._tag,
                eventId: fact.eventId,
                amount: fact.amount.format(),
                evidenceReference: fact.evidenceReference,
              }
            : {
                type: fact._tag,
                eventId: fact.eventId,
                unitPrice: fact.unitPrice.format(),
                quotedAt: fact.quotedAt.toISOString(),
                source: fact.source,
              }
        )
      ).toEqual([
        {
          type: "observed_consideration",
          eventId: "10000000-0000-4000-8000-000000000010",
          amount: "1250.5",
          evidenceReference: "/v2/transactions/valued-purchase",
        },
        {
          type: "market_quote",
          eventId: "10000000-0000-4000-8000-000000000010",
          unitPrice: "600.25",
          quotedAt: "2025-02-03T00:00:00.000Z",
          source: "coingecko",
        },
      ])

      const usdResult = yield* Effect.promise(() =>
        loadFactualLedgerInCurrency(CurrencyCode.make("USD"))
      )

      expect(usdResult.valuationFacts).toEqual([])
    })
  )

  it.effect("preserves valid quote sources exactly and omits unusable sources", () =>
    Effect.gen(function* () {
      const quoteFixtures = [
        {
          id: "10000000-0000-4000-8000-000000000050",
          day: "2025-05-01",
          source: null,
        },
        {
          id: "10000000-0000-4000-8000-000000000051",
          day: "2025-05-02",
          source: "",
        },
        {
          id: "10000000-0000-4000-8000-000000000052",
          day: "2025-05-03",
          source: " padded-source ",
        },
        {
          id: "10000000-0000-4000-8000-000000000053",
          day: "2025-05-04",
          source: "exact-source",
        },
      ] as const

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [transaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: TEST_CUSTODY_SOURCE_ID,
                externalId: "quote-source-validation",
                timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-05-01T10:00:00.000Z")),
                transactionType: "buy_fiat",
                principalId: TEST_PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })

            if (transaction === undefined) {
              return yield* Effect.die("Failed to create quote-source transaction")
            }

            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures(
                quoteFixtures.map(({ day, id }) => ({
                  movementIdentity: {
                    sourceRecordKey: `quote-source-leg-${day}`,
                    componentKey: "movement",
                  },
                  id,
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: `quote-source-leg-${day}`,
                  timestamp: DateTime.toDateUtc(DateTime.makeUnsafe(`${day}T10:00:00.000Z`)),
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  sourceRepresentationUseId: TEST_CUSTODY_SOURCE_USE_ID,
                  amount: "1",
                  kind: "acquisition" as const,
                  provenance: "deterministic" as const,
                  originKind: "none" as const,
                  transactionId: transaction.id,
                }))
              )
            )
            yield* db.insert(schema.assetPrices).values(
              quoteFixtures.map(({ day, source }) => ({
                assetId: TEST_BTC_ASSET_ID,
                timestamp: DateTime.toDateUtc(DateTime.makeUnsafe(`${day}T00:00:00.000Z`)),
                price: "100",
                currency: "EUR",
                source,
              }))
            )
          })
        )
      )

      const result = yield* Effect.promise(loadFactualLedger)

      expect(result.valuationFacts).toHaveLength(1)
      expect(result.valuationFacts[0]).toMatchObject({
        _tag: "market_quote",
        eventId: "10000000-0000-4000-8000-000000000053",
        source: "exact-source",
      })
    })
  )

  it.effect("omits unusable provider money and exact daily quotes", () =>
    Effect.gen(function* () {
      const negativeAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-01T10:00:00.000Z"))
      const ambiguousAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-02T10:00:00.000Z"))
      const invalidAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-03T10:00:00.000Z"))

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [negativeTransaction, ambiguousTransaction, invalidTransaction] = yield* db
              .insert(schema.transactions)
              .values([
                {
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "negative-provider-money",
                  timestamp: negativeAt,
                  transactionType: "sell_fiat",
                  providerFiatAmount: "-100",
                  providerFiatCurrency: "EUR",
                  principalId: TEST_PRINCIPAL_ID,
                },
                {
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "ambiguous-provider-money",
                  timestamp: ambiguousAt,
                  transactionType: "swap_crypto_to_crypto",
                  providerFiatAmount: "500",
                  providerFiatCurrency: "EUR",
                  principalId: TEST_PRINCIPAL_ID,
                },
                {
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "invalid-provider-money",
                  timestamp: invalidAt,
                  transactionType: "buy_fiat",
                  providerFiatAmount: "NaN",
                  providerFiatCurrency: "EUR",
                  principalId: TEST_PRINCIPAL_ID,
                },
              ])
              .returning({ id: schema.transactions.id })

            if (
              negativeTransaction === undefined ||
              ambiguousTransaction === undefined ||
              invalidTransaction === undefined
            ) {
              return yield* Effect.die("Failed to create provider-money fixtures")
            }

            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures([
                {
                  movementIdentity: {
                    sourceRecordKey: "negative-provider-money-leg",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000030",
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "negative-provider-money-leg",
                  timestamp: negativeAt,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  sourceRepresentationUseId: TEST_CUSTODY_SOURCE_USE_ID,
                  amount: "1",
                  kind: "disposal",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  transactionId: negativeTransaction.id,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "ambiguous-provider-money-out",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000031",
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "ambiguous-provider-money-out",
                  timestamp: ambiguousAt,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  sourceRepresentationUseId: TEST_CUSTODY_SOURCE_USE_ID,
                  amount: "1",
                  kind: "disposal",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  transactionId: ambiguousTransaction.id,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "ambiguous-provider-money-in",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000032",
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "ambiguous-provider-money-in",
                  timestamp: ambiguousAt,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  sourceRepresentationUseId: TEST_CUSTODY_SOURCE_USE_ID,
                  amount: "2",
                  kind: "acquisition",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  transactionId: ambiguousTransaction.id,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "invalid-provider-money-leg",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000033",
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "invalid-provider-money-leg",
                  timestamp: invalidAt,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  sourceRepresentationUseId: TEST_CUSTODY_SOURCE_USE_ID,
                  amount: "1",
                  kind: "acquisition",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  transactionId: invalidTransaction.id,
                },
              ])
            )
            yield* db.insert(schema.assetPrices).values([
              {
                assetId: TEST_BTC_ASSET_ID,
                timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-01T00:00:00.000Z")),
                price: "-1",
                currency: "EUR",
                source: "coingecko",
              },
              {
                assetId: TEST_BTC_ASSET_ID,
                timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-02T00:00:00.000Z")),
                price: "0",
                currency: "EUR",
                source: "coingecko",
              },
              {
                assetId: TEST_BTC_ASSET_ID,
                timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-03T00:00:00.000Z")),
                price: "NaN",
                currency: "EUR",
                source: "coingecko",
              },
            ])
          })
        )
      )

      const result = yield* Effect.promise(loadFactualLedger)

      expect(result.events).toHaveLength(4)
      expect(result.valuationFacts).toEqual([])
    })
  )

  it.effect("adapts only finalized custody reconciliations in provider direction", () =>
    Effect.gen(function* () {
      const providerTimestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-04T10:00:00.000Z"))
      const canonicalTimestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-04T10:02:00.000Z"))
      const inboundProviderTimestamp = DateTime.toDateUtc(
        DateTime.makeUnsafe("2025-03-04T11:00:00.000Z")
      )
      const inboundCanonicalTimestamp = DateTime.toDateUtc(
        DateTime.makeUnsafe("2025-03-04T11:02:00.000Z")
      )

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* seedCexSource({
              sourceId: TEST_DESTINATION_SOURCE_ID,
              fixtureName: "Destination custody source",
            })
            const destinationSourceUseId = yield* recordRepresentationUse({
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
              sourceId: TEST_DESTINATION_SOURCE_ID,
            })
            yield* seedSyncEngineRepositoryFixture({
              userId: OTHER_USER_ID,
              principalId: OTHER_PRINCIPAL_ID,
              sourceId: OTHER_SOURCE_ID,
            })

            const finalized = yield* seedCustodyReconciliation({
              reconciliationId: "10000000-0000-4000-8000-000000000020",
              fixtureName: "custody",
              providerSourceId: TEST_CUSTODY_SOURCE_ID,
              canonicalSourceId: TEST_DESTINATION_SOURCE_ID,
              providerTimestamp,
              canonicalTimestamp,
              direction: "outbound",
              amount: "0.75",
              reconciliationStatus: "matched",
              status: "approved",
              deterministic: false,
            })
            const finalizedInbound = yield* seedCustodyReconciliation({
              reconciliationId: "10000000-0000-4000-8000-000000000023",
              fixtureName: "custody-inbound",
              providerSourceId: TEST_DESTINATION_SOURCE_ID,
              canonicalSourceId: TEST_CUSTODY_SOURCE_ID,
              providerTimestamp: inboundProviderTimestamp,
              canonicalTimestamp: inboundCanonicalTimestamp,
              direction: "inbound",
              amount: "0.5",
              reconciliationStatus: "matched",
              status: "auto_applied",
              deterministic: true,
            })
            yield* seedCustodyReconciliation({
              reconciliationId: "10000000-0000-4000-8000-000000000024",
              fixtureName: "custody-pending",
              providerSourceId: TEST_CUSTODY_SOURCE_ID,
              canonicalSourceId: TEST_DESTINATION_SOURCE_ID,
              providerTimestamp: inboundProviderTimestamp,
              canonicalTimestamp: inboundCanonicalTimestamp,
              direction: "outbound",
              amount: "0.25",
              reconciliationStatus: "unmatched",
              status: "pending",
              deterministic: false,
            })
            yield* seedCustodyReconciliation({
              reconciliationId: "10000000-0000-4000-8000-000000000025",
              fixtureName: "custody-foreign-provider-transfer-source",
              providerSourceId: TEST_CUSTODY_SOURCE_ID,
              canonicalSourceId: TEST_DESTINATION_SOURCE_ID,
              providerTransferSourceId: OTHER_SOURCE_ID,
              providerTimestamp: inboundProviderTimestamp,
              canonicalTimestamp: inboundCanonicalTimestamp,
              direction: "outbound",
              amount: "0.125",
              reconciliationStatus: "matched",
              status: "approved",
              deterministic: false,
            })
            yield* seedCustodyReconciliation({
              reconciliationId: "10000000-0000-4000-8000-000000000026",
              fixtureName: "custody-foreign-inventory-source",
              providerSourceId: TEST_CUSTODY_SOURCE_ID,
              canonicalSourceId: TEST_DESTINATION_SOURCE_ID,
              inventorySourceId: OTHER_SOURCE_ID,
              providerTimestamp: inboundProviderTimestamp,
              canonicalTimestamp: inboundCanonicalTimestamp,
              direction: "outbound",
              amount: "0.125",
              reconciliationStatus: "matched",
              status: "approved",
              deterministic: false,
            })
            yield* seedCustodyReconciliation({
              reconciliationId: "10000000-0000-4000-8000-000000000027",
              fixtureName: "custody-foreign-canonical-transfer-source",
              providerSourceId: TEST_CUSTODY_SOURCE_ID,
              canonicalSourceId: TEST_DESTINATION_SOURCE_ID,
              canonicalTransferSourceId: OTHER_SOURCE_ID,
              providerTimestamp: inboundProviderTimestamp,
              canonicalTimestamp: inboundCanonicalTimestamp,
              direction: "outbound",
              amount: "0.125",
              reconciliationStatus: "matched",
              status: "approved",
              deterministic: false,
            })
            const [unrelatedTransfer] = yield* db
              .insert(schema.transfers)
              .values({
                sourceId: TEST_DESTINATION_SOURCE_ID,
                principalId: TEST_PRINCIPAL_ID,
                externalId: "custody-unrelated-canonical-transfer",
                timestamp: canonicalTimestamp,
                type: "cex",
                fromAccountRef: "external:origin",
                toAccountRef: "own:destination",
                assetId: TEST_BTC_ASSET_ID,
                amount: "0.125",
              })
              .returning({ id: schema.transfers.id })
            if (unrelatedTransfer === undefined) {
              return yield* Effect.die("Failed to create unrelated canonical transfer")
            }
            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures([
                {
                  movementIdentity: {
                    sourceRecordKey: "custody-unrelated-provider-sibling",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000014",
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "custody-unrelated-provider-sibling",
                  timestamp: providerTimestamp,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  sourceRepresentationUseId: finalized.providerSourceRepresentationUseId,
                  amount: "0.25",
                  kind: "acquisition",
                  provenance: "deterministic",
                  originKind: "none",
                  transactionId: finalized.providerTransactionId,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "custody-provider-disposition-leg",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000017",
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "custody-provider-disposition-leg",
                  timestamp: providerTimestamp,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "0.75",
                  kind: "disposal",
                  provenance: "deterministic",
                  originKind: "provider_transfer" as const,
                  providerTransferId: finalized.providerTransferId,
                  transactionId: finalized.providerTransactionId,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "custody-canonical-acquisition-leg",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000018",
                  sourceId: TEST_DESTINATION_SOURCE_ID,
                  externalId: "custody-canonical-acquisition-leg",
                  timestamp: canonicalTimestamp,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "0.75",
                  kind: "acquisition",
                  provenance: "deterministic",
                  originKind: "canonical_transfer" as const,
                  transactionId: finalized.canonicalTransactionId,
                  sourceTransferId: finalized.canonicalTransferId,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "custody-inbound-provider-acquisition-leg",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000019",
                  sourceId: TEST_DESTINATION_SOURCE_ID,
                  externalId: "custody-inbound-provider-acquisition-leg",
                  timestamp: inboundProviderTimestamp,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "0.5",
                  kind: "acquisition",
                  provenance: "deterministic",
                  originKind: "provider_transfer" as const,
                  providerTransferId: finalizedInbound.providerTransferId,
                  transactionId: finalizedInbound.providerTransactionId,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "custody-inbound-canonical-disposition-leg",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000016",
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "custody-inbound-canonical-disposition-leg",
                  timestamp: inboundCanonicalTimestamp,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "0.5",
                  kind: "disposal",
                  provenance: "deterministic",
                  originKind: "canonical_transfer" as const,
                  transactionId: finalizedInbound.canonicalTransactionId,
                  sourceTransferId: finalizedInbound.canonicalTransferId,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "custody-unrelated-canonical-leg",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000015",
                  sourceId: TEST_DESTINATION_SOURCE_ID,
                  externalId: "custody-unrelated-canonical-leg",
                  timestamp: canonicalTimestamp,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  sourceRepresentationUseId: destinationSourceUseId,
                  amount: "0.125",
                  kind: "acquisition",
                  provenance: "deterministic",
                  originKind: "canonical_transfer" as const,
                  transactionId: finalized.canonicalTransactionId,
                  sourceTransferId: unrelatedTransfer.id,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "custody-internal-out-leg",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000021",
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "custody-internal-out-leg",
                  timestamp: providerTimestamp,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "0.75",
                  kind: "disposal",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  derivationRule: "internal_transfer_out",
                  transactionId: finalized.providerTransactionId,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "custody-internal-in-leg",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000022",
                  sourceId: TEST_DESTINATION_SOURCE_ID,
                  externalId: "custody-internal-in-leg",
                  timestamp: canonicalTimestamp,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "0.75",
                  kind: "acquisition",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  derivationRule: "internal_transfer_in",
                  transactionId: finalized.canonicalTransactionId,
                },
              ])
            )
            yield* db.insert(schema.assetPrices).values({
              assetId: TEST_BTC_ASSET_ID,
              timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-04T00:00:00.000Z")),
              price: "50000",
              currency: "EUR",
              source: "coingecko",
            })
          })
        )
      )

      const result = yield* Effect.promise(loadFactualLedger)

      expect(result.events).toHaveLength(4)
      expect(result.events[0]).toMatchObject({
        _tag: "acquisition",
        id: "10000000-0000-4000-8000-000000000014",
      })
      expect(result.events[1]).toMatchObject({
        _tag: "acquisition",
        id: "10000000-0000-4000-8000-000000000015",
      })
      expect(result.events[2]).toMatchObject({
        _tag: "custody_movement",
        id: "10000000-0000-4000-8000-000000000020",
        assetId: TEST_BTC_ASSET_ID,
        fromCustodySourceId: TEST_CUSTODY_SOURCE_ID,
        toCustodySourceId: TEST_DESTINATION_SOURCE_ID,
        transactionReference: "custody-canonical-transaction",
      })
      expect(result.events[2]?.occurredAt.toISOString()).toBe("2025-03-04T10:02:00.000Z")
      expect(
        BigDecimal.equals(
          result.events[2]?.quantity ?? BigDecimal.fromBigInt(0n),
          BigDecimal.fromStringUnsafe("0.75")
        )
      ).toBe(true)
      expect(result.events[3]).toMatchObject({
        _tag: "custody_movement",
        id: "10000000-0000-4000-8000-000000000023",
        assetId: TEST_BTC_ASSET_ID,
        fromCustodySourceId: TEST_CUSTODY_SOURCE_ID,
        toCustodySourceId: TEST_DESTINATION_SOURCE_ID,
        transactionReference: "custody-inbound-canonical-transaction",
      })
      expect(result.events[3]?.occurredAt.toISOString()).toBe("2025-03-04T11:02:00.000Z")
      expect(result.valuationFacts).toHaveLength(2)
      expect(result.valuationFacts.map(({ eventId }) => eventId)).toEqual([
        "10000000-0000-4000-8000-000000000014",
        "10000000-0000-4000-8000-000000000015",
      ])
    })
  )

  it.effect("keeps an out-of-scope custody event from exposing its earlier origin leg", () =>
    Effect.gen(function* () {
      const providerTimestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-12-31T23:58:00.000Z"))
      const canonicalTimestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:02:00.000Z"))

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* seedCexSource({
              sourceId: TEST_DESTINATION_SOURCE_ID,
              fixtureName: "Cross-year custody destination",
            })
            const reconciliation = yield* seedCustodyReconciliation({
              reconciliationId: "10000000-0000-4000-8000-000000000033",
              fixtureName: "cross-year-custody",
              providerSourceId: TEST_CUSTODY_SOURCE_ID,
              canonicalSourceId: TEST_DESTINATION_SOURCE_ID,
              providerTimestamp,
              canonicalTimestamp,
              direction: "outbound",
              amount: "0.5",
              reconciliationStatus: "matched",
              status: "approved",
              deterministic: false,
            })
            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures([
                {
                  movementIdentity: {
                    sourceRecordKey: "cross-year-provider-origin-leg",
                    componentKey: "movement",
                  },
                  id: "10000000-0000-4000-8000-000000000034",
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "cross-year-provider-origin-leg",
                  timestamp: providerTimestamp,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  sourceRepresentationUseId: reconciliation.providerSourceRepresentationUseId,
                  amount: "0.5",
                  kind: "disposal",
                  provenance: "deterministic",
                  originKind: "provider_transfer",
                  providerTransferId: reconciliation.providerTransferId,
                  transactionId: reconciliation.providerTransactionId,
                },
              ])
            )
          })
        )
      )

      const earlierLedger = yield* Effect.promise(() =>
        loadFactualLedgerBefore(DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")))
      )
      expect(earlierLedger.events).toEqual([])
      expect(earlierLedger.inputBlockers).toEqual([])

      const laterLedger = yield* Effect.promise(loadFactualLedger)
      expect(laterLedger.events).toEqual([
        expect.objectContaining({
          _tag: "custody_movement",
          id: "10000000-0000-4000-8000-000000000033",
        }),
      ])
      expect(laterLedger.inputBlockers).toEqual([])
    })
  )

  it.effect("returns a provider blocker when the other custody side is excluded", () =>
    Effect.gen(function* () {
      const providerTimestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-05T10:00:00.000Z"))
      const canonicalTimestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-05T10:02:00.000Z"))

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* seedCexSource({
              sourceId: TEST_DESTINATION_SOURCE_ID,
              fixtureName: "Blocked custody destination",
            })
            yield* seedProviderBoundaryAsset({
              providerAssetRowId: MIXED_PROVIDER_ASSET_ROW_ID,
              providerAssetId: "blocked-reconciliation",
              canonicalAssetId: TEST_BTC_ASSET_ID,
            })
            yield* seedProviderBoundaryAsset({
              providerAssetRowId: MIXED_OTHER_PROVIDER_ASSET_ROW_ID,
              providerAssetId: "canonical-reconciliation",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              currentConclusion: { outcome: "excluded" },
            })
            yield* db
              .update(schema.providerAssets)
              .set({ exponent: null })
              .where(eq(schema.providerAssets.id, MIXED_PROVIDER_ASSET_ROW_ID))
            const reconciliation = yield* seedCustodyReconciliation({
              reconciliationId: "10000000-0000-4000-8000-000000000032",
              fixtureName: "blocked-custody",
              providerSourceId: TEST_CUSTODY_SOURCE_ID,
              canonicalSourceId: TEST_DESTINATION_SOURCE_ID,
              providerAssetRowId: MIXED_PROVIDER_ASSET_ROW_ID,
              providerHasExactUse: false,
              providerTimestamp,
              canonicalTimestamp,
              direction: "outbound",
              amount: "0.5",
              reconciliationStatus: "matched",
              status: "approved",
              deterministic: false,
            })
            yield* db
              .update(schema.transfers)
              .set({ providerAssetRowId: MIXED_OTHER_PROVIDER_ASSET_ROW_ID })
              .where(eq(schema.transfers.id, reconciliation.canonicalTransferId))
          })
        )
      )

      const result = yield* Effect.promise(loadFactualLedger)
      expect(result.events).toEqual([])
      expect(result.inputBlockers).toEqual([
        expect.objectContaining({
          code: "missing_decimals",
          eventId: "10000000-0000-4000-8000-000000000032",
          assetId: TEST_BTC_ASSET_ID,
          providerAssetRowId: MIXED_PROVIDER_ASSET_ROW_ID,
        }),
      ])
    })
  )

  it.effect("withholds globally excluded custody movements without leaking their legs", () =>
    Effect.gen(function* () {
      const providerTimestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-05T10:00:00.000Z"))
      const canonicalTimestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-05T10:02:00.000Z"))

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* seedCexSource({
              sourceId: TEST_DESTINATION_SOURCE_ID,
              fixtureName: "Excluded reconciliation destination",
            })
            yield* seedProviderBoundaryAsset({
              providerAssetRowId: EXCLUDED_PROVIDER_ASSET_ROW_ID,
              providerAssetId: "excluded-reconciliation",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              currentConclusion: { outcome: "excluded" },
            })
            yield* seedProviderBoundaryAsset({
              providerAssetRowId: MIXED_OTHER_PROVIDER_ASSET_ROW_ID,
              providerAssetId: "included-reconciliation",
              canonicalAssetId: TEST_BTC_ASSET_ID,
            })
            const excluded = yield* seedCustodyReconciliation({
              reconciliationId: "10000000-0000-4000-8000-000000000030",
              fixtureName: "excluded-custody",
              providerSourceId: TEST_CUSTODY_SOURCE_ID,
              canonicalSourceId: TEST_DESTINATION_SOURCE_ID,
              providerAssetRowId: EXCLUDED_PROVIDER_ASSET_ROW_ID,
              providerTimestamp,
              canonicalTimestamp,
              direction: "outbound",
              amount: "0.75",
              reconciliationStatus: "matched",
              status: "approved",
              deterministic: false,
            })
            yield* seedCustodyReconciliation({
              reconciliationId: "10000000-0000-4000-8000-000000000031",
              fixtureName: "included-custody",
              providerSourceId: TEST_CUSTODY_SOURCE_ID,
              canonicalSourceId: TEST_DESTINATION_SOURCE_ID,
              providerAssetRowId: MIXED_OTHER_PROVIDER_ASSET_ROW_ID,
              providerTimestamp,
              canonicalTimestamp,
              direction: "outbound",
              amount: "0.5",
              reconciliationStatus: "matched",
              status: "auto_applied",
              deterministic: true,
            })
            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures([
                {
                  movementIdentity: {
                    sourceRecordKey: "excluded-custody-provider-leg",
                    componentKey: "movement",
                  },
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "excluded-custody-provider-leg",
                  timestamp: providerTimestamp,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "0.75",
                  kind: "disposal",
                  provenance: "deterministic",
                  originKind: "provider_transfer" as const,
                  providerTransferId: excluded.providerTransferId,
                  transactionId: excluded.providerTransactionId,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "excluded-custody-canonical-leg",
                    componentKey: "movement",
                  },
                  sourceId: TEST_DESTINATION_SOURCE_ID,
                  externalId: "excluded-custody-canonical-leg",
                  timestamp: canonicalTimestamp,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "0.75",
                  kind: "acquisition",
                  provenance: "deterministic",
                  originKind: "canonical_transfer" as const,
                  transactionId: excluded.canonicalTransactionId,
                  sourceTransferId: excluded.canonicalTransferId,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "excluded-custody-synthetic-out",
                    componentKey: "movement",
                  },
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "excluded-custody-synthetic-out",
                  timestamp: providerTimestamp,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "0.75",
                  kind: "disposal",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  derivationRule: "internal_transfer_out",
                  transactionId: excluded.providerTransactionId,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "excluded-custody-synthetic-in",
                    componentKey: "movement",
                  },
                  sourceId: TEST_DESTINATION_SOURCE_ID,
                  externalId: "excluded-custody-synthetic-in",
                  timestamp: canonicalTimestamp,
                  principalId: TEST_PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "0.75",
                  kind: "acquisition",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  derivationRule: "internal_transfer_in",
                  transactionId: excluded.canonicalTransactionId,
                },
              ])
            )
          })
        )
      )

      const result = yield* Effect.promise(loadFactualLedger)
      expect(result.events.map(({ id }) => id)).toEqual(["10000000-0000-4000-8000-000000000031"])
      expect(result.events[0]?._tag).toBe("custody_movement")
    })
  )
})
