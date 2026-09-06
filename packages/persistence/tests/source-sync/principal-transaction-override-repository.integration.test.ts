import { beforeEach, describe, expect, it } from "@effect/vitest"
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
})
