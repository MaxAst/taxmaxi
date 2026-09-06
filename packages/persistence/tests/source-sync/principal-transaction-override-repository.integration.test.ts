import { beforeEach, describe, expect, it } from "@effect/vitest"
import { AuthUserId } from "@my/core/authentication"
import { CurrencyCode } from "@my/core/currency"
import { PrincipalId } from "@my/core/ownership"
import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { PrincipalTransactionOverrideRepositoryLive } from "../../src/layers/PrincipalTransactionOverrideRepositoryLive.ts"
import { PrincipalTransactionOverrideRepository } from "../../src/services/PrincipalTransactionOverrideRepository.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_BTC_REPRESENTATION_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const TEST_PRINCIPAL_ID = "00000000-0000-4000-8000-000000008681"
const TEST_USER_ID = "00000000-0000-4000-8000-000000008682"
const SOURCE_ID = "00000000-0000-4000-8000-000000008683"
const TARGET_ID = "00000000-0000-4000-8000-000000008601"
const OTHER_ID = "00000000-0000-4000-8000-000000008602"
const time = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00Z"))
const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_movement_history_reads",
})
const ownedPrincipal = PrincipalId.make(TEST_PRINCIPAL_ID)
const read = (targetId = TARGET_ID, principalId = ownedPrincipal) =>
  context.runWithLayer({
    layer: PrincipalTransactionOverrideRepositoryLive,
    effect: Effect.flatMap(PrincipalTransactionOverrideRepository, (repo) =>
      repo.findContext({ principalId, targetId })
    ),
  })

const seed = Effect.gen(function* () {
  const fixture = yield* seedSyncEngineRepositoryFixture({
    principalId: TEST_PRINCIPAL_ID,
    userId: TEST_USER_ID,
    sourceId: SOURCE_ID,
  })
  yield* seedSyncEngineAssets(fixture)
  const db = yield* drizzle
  yield* db.insert(schema.movementCorrectionTargets).values({
    id: TARGET_ID,
    principalId: TEST_PRINCIPAL_ID,
    sourceId: fixture.sourceId,
    sourceRecordKey: "synthetic-record",
    componentKey: "amount",
  })
  const [transaction] = yield* db
    .insert(schema.transactions)
    .values({
      sourceId: fixture.sourceId,
      principalId: TEST_PRINCIPAL_ID,
      externalId: "synthetic-record",
      timestamp: time,
      transactionType: null,
      providerTransactionType: "synthetic-credit",
    })
    .returning({ id: schema.transactions.id })
  if (transaction === undefined) return yield* Effect.die("Missing synthetic transaction")
  const legValues = {
    sourceId: fixture.sourceId,
    principalId: TEST_PRINCIPAL_ID,
    externalId: "synthetic-record:main",
    timestamp: time,
    movementCorrectionTargetId: TARGET_ID,
    assetId: TEST_BTC_ASSET_ID,
    amount: "3",
    kind: "acquisition",
    provenance: "deterministic",
    originKind: "none",
    transactionId: transaction.id,
    fiatAmount: null,
    fiatCurrency: null,
  } satisfies typeof schema.transactionLegs.$inferInsert
  const [leg] = yield* db
    .insert(schema.transactionLegs)
    .values(legValues)
    .returning({ id: schema.transactionLegs.id })
  if (leg === undefined) return yield* Effect.die("Missing synthetic leg")
  const historyValues = {
    principalId: TEST_PRINCIPAL_ID,
    sourceId: fixture.sourceId,
    targetId: TARGET_ID,
    kind: "price",
    operation: "create",
    inspectedSystemRevision: "synthetic-old-revision",
    inspectedSourceRecordKey: "synthetic-record",
    inspectedComponentKey: "amount",
    inspectedQuantity: "3",
    inspectedEconomicAssetId: TEST_BTC_ASSET_ID,
    inspectedDirection: "inbound",
    inspectedStructure: "ownership_change",
    inspectedOccurredAt: time,
    inspectedLegKind: "acquisition",
    inspectedFiatAmount: null,
    inspectedFiatCurrency: null,
    inspectedTransactionType: null,
    inspectedProviderTransactionType: "synthetic-credit",
    priceInput: {
      _tag: "total_value",
      amount: "20.00000000000000000001",
      currency: CurrencyCode.make("EUR"),
    },
    actorUserId: TEST_USER_ID,
    reason: "Synthetic recorded purchase evidence",
    supersedesOverrideId: null,
  } satisfies typeof schema.principalTransactionOverrides.$inferInsert
  return { ...fixture, legId: leg.id, transactionId: transaction.id, legValues, historyValues }
})

const EFFECTIVE_ASSET_ID = "00000000-0000-4000-8000-000000008690"
const seedIdentityContext = ({
  kind,
  state,
  fee = false,
}: {
  readonly kind: "exact" | "provider"
  readonly state: "overridden" | "unresolved" | "excluded" | "blocked"
  readonly fee?: boolean
}) =>
  Effect.gen(function* () {
    const fixture = yield* seed
    const db = yield* drizzle
    yield* db.insert(schema.assets).values({
      id: EFFECTIVE_ASSET_ID,
      name: "Synthetic effective asset",
      symbol: "SYN",
      type: "fungible",
    })
    let targetId: string
    if (kind === "exact") {
      const coordinates = {
        blockchainId: fixture.bitcoinBlockchainId,
        representationType: "token" as const,
        contractAddress:
          state === "unresolved" ? "synthetic-unknown-contract" : "sync-engine-btc-fixture",
      }
      const [use] = yield* db
        .insert(schema.sourceRepresentationUses)
        .values({ sourceId: SOURCE_ID, ...coordinates })
        .returning({ id: schema.sourceRepresentationUses.id })
      const [target] = yield* db
        .insert(schema.principalAssetOverrideTargets)
        .values({ principalId: TEST_PRINCIPAL_ID, targetKind: "representation", ...coordinates })
        .returning({ id: schema.principalAssetOverrideTargets.id })
      if (use === undefined || target === undefined)
        return yield* Effect.die("Missing synthetic exact link")
      targetId = target.id
      yield* db
        .update(schema.transactionLegs)
        .set({ sourceRepresentationUseId: use.id })
        .where(eq(schema.transactionLegs.id, fixture.legId))
    } else {
      const [provider] = yield* db
        .insert(schema.providerAssets)
        .values({
          provider: "coinbase",
          providerAssetId: "synthetic-context-provider",
          currencyCode: "SYN",
          name: "Synthetic provider asset",
          exponent: state === "blocked" ? null : 8,
          providerType: "crypto",
          rawProviderPayload: {},
          evidenceRevision: 1,
          discoveredAt: time,
          retrievedAt: time,
        })
        .returning({ id: schema.providerAssets.id })
      if (provider === undefined) return yield* Effect.die("Missing synthetic provider")
      if (state !== "unresolved")
        yield* db.insert(schema.providerAssetMappings).values({
          providerAssetRowId: provider.id,
          mappingKind: "asset",
          canonicalAssetId: TEST_BTC_ASSET_ID,
          mappingStatus: "approved",
        })
      const [target] = yield* db
        .insert(schema.principalAssetOverrideTargets)
        .values({
          principalId: TEST_PRINCIPAL_ID,
          targetKind: "provider_asset",
          providerAssetRowId: provider.id,
        })
        .returning({ id: schema.principalAssetOverrideTargets.id })
      if (target === undefined) return yield* Effect.die("Missing synthetic provider target")
      targetId = target.id
      yield* db
        .update(schema.transactionLegs)
        .set({ providerAssetRowId: provider.id })
        .where(eq(schema.transactionLegs.id, fixture.legId))
    }
    if (state !== "unresolved")
      yield* db.insert(schema.principalAssetOverrides).values({
        principalId: TEST_PRINCIPAL_ID,
        targetId,
        kind: "identity",
        operation: "create",
        inspectedSystemRevision: "synthetic-system-A",
        inspectedSystemIdentity: "resolved",
        inspectedSystemAssetId: TEST_BTC_ASSET_ID,
        replacementAssetId: EFFECTIVE_ASSET_ID,
        actorUserId: TEST_USER_ID,
        reason: "Synthetic identity evidence",
      })
    if (state === "excluded")
      yield* db.insert(schema.principalAssetOverrides).values({
        principalId: TEST_PRINCIPAL_ID,
        targetId,
        kind: "inclusion",
        operation: "create",
        inspectedSystemRevision: "synthetic-included",
        inspectedSystemInclusion: "included",
        replacementInclusion: "excluded",
        actorUserId: TEST_USER_ID,
        reason: "Synthetic exclusion",
      })
    if (fee) {
      yield* db
        .update(schema.transactionLegs)
        .set({ kind: "fee", feeForTransactionId: fixture.transactionId })
        .where(eq(schema.transactionLegs.id, fixture.legId))
      yield* db.insert(schema.inventoryMovements).values({
        sourceId: SOURCE_ID,
        principalId: TEST_PRINCIPAL_ID,
        transactionId: fixture.transactionId,
        transactionLegId: fixture.legId,
        assetId: TEST_BTC_ASSET_ID,
        timestamp: time,
        direction: "outbound",
        purpose: "fee",
        taxTreatment: "non_taxable",
        reconciliationStatus: "matched",
        amount: "3",
      })
    }
    return fixture
  })

await Effect.runPromise(context.recreateTestDatabase())
beforeEach(() => Effect.runPromise(context.recreateTestDatabase()))

describe("movement correction history reader", () => {
  it.effect("keeps current unknown system facts separate from retained precise price input", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => context.runPg(seed))
      yield* Effect.promise(() =>
        context.runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.principalTransactionOverrides).values(fixture.historyValues)
          })
        )
      )
      const result = yield* read()
      expect(Option.isSome(result)).toBe(true)
      if (Option.isNone(result)) return
      expect(result.value.current?.system.recordedFiatAmount).toBeNull()
      expect(result.value.current?.system.transactionType).toBeNull()
      expect(result.value.price.active?.input).toEqual({
        _tag: "price",
        input: fixture.historyValues.priceInput,
      })
      expect(result.value.price.active?.inspectedFacts.systemRevision).toBe(
        "synthetic-old-revision"
      )
      expect(result.value.current?.facts.systemRevision).not.toBe("synthetic-old-revision")
      expect(result.value.classification).toEqual({ leaf: null, active: null })
    })
  )

  it.effect("selects independent leaves by supersession rather than recorded timestamp", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => context.runPg(seed))
      yield* Effect.promise(() =>
        context.runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [root] = yield* db
              .insert(schema.principalTransactionOverrides)
              .values({
                ...fixture.historyValues,
                recordedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-02-01T00:00:00Z")),
              })
              .returning({ id: schema.principalTransactionOverrides.id })
            if (root === undefined) return yield* Effect.die("Missing root")
            yield* db.insert(schema.principalTransactionOverrides).values({
              ...fixture.historyValues,
              operation: "withdraw",
              supersedesOverrideId: root.id,
              priceInput: null,
              recordedAt: time,
            })
            yield* db.insert(schema.principalTransactionOverrides).values({
              ...fixture.historyValues,
              kind: "classification",
              priceInput: null,
              classificationInput: { _tag: "inbound", cause: "purchase" },
            })
          })
        )
      )
      const result = yield* read()
      if (Option.isNone(result)) return yield* Effect.die("Missing target")
      expect(result.value.price.leaf?.operation).toBe("withdraw")
      expect(result.value.price.active).toBeNull()
      expect(result.value.classification.active?.input).toEqual({
        _tag: "classification",
        input: { _tag: "inbound", cause: "purchase" },
      })
      expect(result.value.history).toHaveLength(3)
    })
  )

  it.effect(
    "returns the same absence for foreign and missing targets without exposing history",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() => context.runPg(seed))
        yield* Effect.promise(() =>
          context.runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db.insert(schema.principalTransactionOverrides).values(fixture.historyValues)
            })
          )
        )
        expect(yield* read(TARGET_ID, PrincipalId.make(OTHER_ID))).toEqual(Option.none())
        expect(yield* read(OTHER_ID)).toEqual(Option.none())
      })
  )

  it.effect(
    "retains disappeared history and keeps the system revision stable when identical legs are recreated",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() => context.runPg(seed))
        yield* Effect.promise(() =>
          context.runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db.insert(schema.principalTransactionOverrides).values(fixture.historyValues)
            })
          )
        )
        const before = yield* read()
        yield* Effect.promise(() =>
          context.runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db
                .delete(schema.transactionLegs)
                .where(eq(schema.transactionLegs.id, fixture.legId))
            })
          )
        )
        const disappeared = yield* read()
        if (Option.isNone(before) || Option.isNone(disappeared))
          return yield* Effect.die("Missing target")
        expect(disappeared.value.current).toBeNull()
        expect(disappeared.value.history).toEqual(before.value.history)
        yield* Effect.promise(() =>
          context.runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db.insert(schema.transactionLegs).values(fixture.legValues)
            })
          )
        )
        const after = yield* read()
        if (Option.isNone(after)) return yield* Effect.die("Missing target")
        expect(after.value.current?.legId).not.toBe(before.value.current?.legId)
        expect(after.value.current?.facts.systemRevision).toBe(
          before.value.current?.facts.systemRevision
        )
        expect(after.value.history).toEqual(before.value.history)
      })
  )

  it.effect(
    "changes the revision when recorded values change while preserving inspected history",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() => context.runPg(seed))
        yield* Effect.promise(() =>
          context.runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db.insert(schema.principalTransactionOverrides).values(fixture.historyValues)
            })
          )
        )
        const before = yield* read()
        yield* Effect.promise(() =>
          context.runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db
                .update(schema.transactionLegs)
                .set({ fiatAmount: "0", fiatCurrency: "EUR" })
                .where(eq(schema.transactionLegs.id, fixture.legId))
            })
          )
        )
        const after = yield* read()
        if (Option.isNone(before) || Option.isNone(after))
          return yield* Effect.die("Missing target")
        expect(after.value.current?.system.recordedFiatAmount).toBe("0.00000000")
        expect(after.value.current?.facts.systemRevision).not.toBe(
          before.value.current?.facts.systemRevision
        )
        expect(after.value.history).toEqual(before.value.history)
      })
  )

  it.effect(
    "reads approved custody from exact origin links and keeps sibling movements separate",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() => context.runPg(seed))
        const before = yield* read()
        yield* Effect.promise(() =>
          context.runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const [provider] = yield* db
                .insert(schema.providerTransfers)
                .values({
                  sourceId: fixture.sourceId,
                  transactionId: fixture.transactionId,
                  externalId: "synthetic-provider-movement",
                  fromAccountRef: "synthetic-source",
                  toAddress: "synthetic-destination",
                  timestamp: time,
                  direction: "outbound",
                  processingMode: "accounting_and_evidence",
                  amount: "3",
                })
                .returning({ id: schema.providerTransfers.id })
              const [transfer] = yield* db
                .insert(schema.transfers)
                .values({
                  sourceId: fixture.sourceId,
                  principalId: TEST_PRINCIPAL_ID,
                  externalId: "synthetic-canonical-movement",
                  fromAddress: "synthetic-source",
                  toAddress: "synthetic-destination",
                  timestamp: time,
                  type: "native",
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "3",
                })
                .returning({ id: schema.transfers.id })
              if (provider === undefined || transfer === undefined)
                return yield* Effect.die("Missing synthetic origin")
              yield* db.insert(schema.inventoryMovements).values({
                sourceId: fixture.sourceId,
                principalId: TEST_PRINCIPAL_ID,
                transactionId: fixture.transactionId,
                providerTransferId: provider.id,
                assetId: TEST_BTC_ASSET_ID,
                timestamp: time,
                direction: "outbound",
                purpose: "principal",
                taxTreatment: "non_taxable",
                reconciliationStatus: "matched",
                amount: "3",
              })
              yield* db.insert(schema.transferReconciliations).values({
                principalId: TEST_PRINCIPAL_ID,
                providerTransferId: provider.id,
                canonicalTransferId: transfer.id,
                canonicalTransactionId: fixture.transactionId,
                status: "approved",
                matchReason: "Synthetic approved custody",
                confidence: "1",
                deterministic: true,
              })
              yield* db
                .update(schema.transactionLegs)
                .set({ originKind: "canonical_transfer", sourceTransferId: transfer.id })
                .where(eq(schema.transactionLegs.id, fixture.legId))
            })
          )
        )
        const after = yield* read()
        if (Option.isNone(before) || Option.isNone(after))
          return yield* Effect.die("Missing target")
        expect(after.value.current?.facts.structure).toBe("custody")
        expect(after.value.current?.facts.systemRevision).not.toBe(
          before.value.current?.facts.systemRevision
        )
        yield* Effect.promise(() =>
          context.runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db.insert(schema.movementCorrectionTargets).values({
                id: OTHER_ID,
                principalId: TEST_PRINCIPAL_ID,
                sourceId: fixture.sourceId,
                sourceRecordKey: "synthetic-record",
                componentKey: "sibling",
              })
              yield* db.insert(schema.transactionLegs).values({
                ...fixture.legValues,
                movementCorrectionTargetId: OTHER_ID,
                externalId: "synthetic-sibling",
              })
            })
          )
        )
        const sibling = yield* read(OTHER_ID)
        if (Option.isNone(sibling)) return yield* Effect.die("Missing sibling")
        expect(sibling.value.current?.facts.structure).toBe("ownership_change")
      })
  )
  for (const kind of ["exact", "provider"] as const) {
    for (const state of ["overridden", "unresolved", "excluded", "blocked"] as const) {
      if (kind === "exact" && state === "blocked") continue
      it.effect(`reads ${kind} ${state} identity independently of eligibility`, () =>
        Effect.gen(function* () {
          const fixture = yield* Effect.promise(() =>
            context.runPg(seedIdentityContext({ kind, state }))
          )
          const found = yield* read()
          if (Option.isNone(found)) return yield* Effect.die("Missing synthetic context")
          expect(found.value.current?.facts.economicAssetId).toBe(
            state === "unresolved" ? null : EFFECTIVE_ASSET_ID
          )
          const raw = yield* Effect.promise(() =>
            context.runPg(
              Effect.gen(function* () {
                const db = yield* drizzle
                return yield* db
                  .select({ assetId: schema.transactionLegs.assetId })
                  .from(schema.transactionLegs)
                  .where(eq(schema.transactionLegs.id, fixture.legId))
              })
            )
          )
          expect(raw).toEqual([{ assetId: TEST_BTC_ASSET_ID }])
        })
      )
    }
  }

  it.effect("does not use the raw asset when a required exact link is missing", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => context.runPg(seed))
      yield* Effect.promise(() =>
        context.runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.transactionLegs)
              .set({ assetRepresentationId: TEST_BTC_REPRESENTATION_ID })
              .where(eq(schema.transactionLegs.id, fixture.legId))
          })
        )
      )
      const found = yield* read()
      if (Option.isNone(found)) return yield* Effect.die("Missing synthetic context")
      expect(found.value.current?.facts.economicAssetId).toBeNull()
    })
  )

  it.effect(
    "inspects the fee's effective asset without changing its system custody inventory",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() =>
          context.runPg(seedIdentityContext({ kind: "provider", state: "overridden", fee: true }))
        )
        const found = yield* read()
        if (Option.isNone(found) || found.value.current === null)
          return yield* Effect.die("Missing fee context")
        expect(found.value.current.facts).toMatchObject({
          economicAssetId: EFFECTIVE_ASSET_ID,
          direction: "outbound",
          structure: "fee",
        })
        yield* context.runWithLayer({
          layer: PrincipalTransactionOverrideRepositoryLive,
          effect: Effect.flatMap(PrincipalTransactionOverrideRepository, (repo) =>
            repo.create({
              principalId: ownedPrincipal,
              actorUserId: AuthUserId.make(TEST_USER_ID),
              targetId: TARGET_ID,
              expectedSystemRevision: found.value.current?.facts.systemRevision ?? "missing",
              expectedLeafId: null,
              reason: "Synthetic fee price",
              reportingCurrency: CurrencyCode.make("EUR"),
              input: {
                _tag: "price",
                input: { _tag: "total_value", amount: "1", currency: CurrencyCode.make("EUR") },
              },
            })
          ),
        })
        const rows = yield* Effect.promise(() =>
          context.runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return yield* db
                .select({
                  assetId: schema.inventoryMovements.assetId,
                  purpose: schema.inventoryMovements.purpose,
                  legId: schema.inventoryMovements.transactionLegId,
                })
                .from(schema.inventoryMovements)
            })
          )
        )
        expect(rows).toEqual([{ assetId: TEST_BTC_ASSET_ID, purpose: "fee", legId: fixture.legId }])
      })
  )
  for (const kind of ["exact", "provider"] as const) {
    it.effect(`does not apply another principal's ${kind} identity override`, () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() =>
          context.runPg(seedIdentityContext({ kind, state: "overridden" }))
        )
        const otherPrincipalId = PrincipalId.make("00000000-0000-4000-8000-000000008695")
        yield* Effect.promise(() =>
          context.runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const other = yield* seedSyncEngineRepositoryFixture({
                principalId: otherPrincipalId,
                userId: "00000000-0000-4000-8000-000000008696",
                sourceId: "00000000-0000-4000-8000-000000008697",
              })
              const [ownedLeg] = yield* db
                .select({ providerAssetRowId: schema.transactionLegs.providerAssetRowId })
                .from(schema.transactionLegs)
                .where(eq(schema.transactionLegs.id, fixture.legId))
              if (ownedLeg === undefined) return yield* Effect.die("Missing synthetic linked leg")
              let sourceRepresentationUseId: string | null = null
              if (kind === "exact") {
                const [use] = yield* db
                  .insert(schema.sourceRepresentationUses)
                  .values({
                    sourceId: other.sourceId,
                    blockchainId: fixture.bitcoinBlockchainId,
                    representationType: "token",
                    contractAddress: "sync-engine-btc-fixture",
                  })
                  .returning({ id: schema.sourceRepresentationUses.id })
                if (use === undefined) return yield* Effect.die("Missing other source-use")
                sourceRepresentationUseId = use.id
              }
              yield* db.insert(schema.movementCorrectionTargets).values({
                id: OTHER_ID,
                principalId: otherPrincipalId,
                sourceId: other.sourceId,
                sourceRecordKey: "synthetic-record",
                componentKey: "amount",
              })
              yield* db.insert(schema.transactionLegs).values({
                ...fixture.legValues,
                principalId: otherPrincipalId,
                sourceId: other.sourceId,
                transactionId: null,
                movementCorrectionTargetId: OTHER_ID,
                sourceRepresentationUseId,
                providerAssetRowId: ownedLeg.providerAssetRowId,
              })
            })
          )
        )
        const owned = yield* read()
        const other = yield* read(OTHER_ID, otherPrincipalId)
        if (Option.isNone(owned) || Option.isNone(other))
          return yield* Effect.die("Missing owned targets")
        expect(owned.value.current?.facts.economicAssetId).toBe(EFFECTIVE_ASSET_ID)
        expect(other.value.current?.facts.economicAssetId).toBe(TEST_BTC_ASSET_ID)
        expect(yield* read(TARGET_ID, otherPrincipalId)).toEqual(Option.none())
      })
    )
  }
})
