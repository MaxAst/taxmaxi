import { beforeEach, describe, expect, it } from "@effect/vitest"
import { CurrencyCode } from "@my/core/currency"
import { eq, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as DateTime from "effect/DateTime"
import { drizzle } from "../../src/layers/PgClientLive.ts"
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
const TARGET_ID = "00000000-0000-4000-8000-000000008501"
const OTHER_USER_ID = "00000000-0000-4000-8000-000000008502"
const OTHER_PRINCIPAL_ID = "00000000-0000-4000-8000-000000008503"
const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_movement_history_schema",
})
const time = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00Z"))

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
  yield* db.insert(schema.users).values({ id: OTHER_USER_ID, email: "other-history@example.com" })
  yield* db
    .insert(schema.principals)
    .values({ id: OTHER_PRINCIPAL_ID, kind: "user", userId: OTHER_USER_ID })
  return {
    principalId: TEST_PRINCIPAL_ID,
    sourceId: fixture.sourceId,
    targetId: TARGET_ID,
    kind: "price",
    operation: "create",
    inspectedSystemRevision: "synthetic-revision",
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
    inspectedDerivationRule: "synthetic-amount",
    inspectedFeeForSourceRecordKey: null,
    priceInput: {
      _tag: "total_value",
      amount: "0.0000000000000000000000001",
      currency: CurrencyCode.make("EUR"),
    },
    classificationInput: null,
    actorUserId: TEST_USER_ID,
    reason: "Synthetic source evidence",
    supersedesOverrideId: null,
  } satisfies typeof schema.principalTransactionOverrides.$inferInsert
})

await Effect.runPromise(context.recreateTestDatabase())

beforeEach(() => Effect.runPromise(context.recreateTestDatabase()))

describe("movement correction history schema", () => {
  it.effect("stores precise tagged input, explicit zero and independent stream roots", () =>
    Effect.promise(() =>
      context.runPg(
        Effect.gen(function* () {
          const fixture = yield* seed
          const db = yield* drizzle
          const [price] = yield* db
            .insert(schema.principalTransactionOverrides)
            .values(fixture)
            .returning({
              id: schema.principalTransactionOverrides.id,
              price: schema.principalTransactionOverrides.priceInput,
            })
          expect(price?.price).toEqual(fixture.priceInput)
          yield* db.insert(schema.principalTransactionOverrides).values({
            ...fixture,
            kind: "classification",
            priceInput: null,
            classificationInput: { _tag: "inbound", cause: "purchase" },
          })
          if (price === undefined) return yield* Effect.die("Missing synthetic history")
          yield* db.insert(schema.principalTransactionOverrides).values({
            ...fixture,
            operation: "replace",
            supersedesOverrideId: price.id,
            priceInput: { _tag: "unit_price", amount: "0", currency: CurrencyCode.make("EUR") },
          })
          expect(
            yield* db
              .select({ id: schema.principalTransactionOverrides.id })
              .from(schema.principalTransactionOverrides)
          ).toHaveLength(3)
        })
      )
    )
  )

  it.effect("rejects malformed price and classification payloads at the database boundary", () =>
    Effect.promise(() =>
      context.runPg(
        Effect.gen(function* () {
          const fixture = yield* seed
          const db = yield* drizzle
          for (const payload of [
            { _tag: "unit_price", amount: 1, currency: "EUR" },
            { _tag: "unit_price", amount: "-1", currency: "EUR" },
            { _tag: "unit_price", amount: "1", currency: "USDC" },
            { _tag: "unit_price", amount: "1", currency: "EUR", total: "2" },
            { _tag: "unit_price", amount: "1" },
          ]) {
            const result = yield* db
              .insert(schema.principalTransactionOverrides)
              .values({ ...fixture, priceInput: sql`${payload}::jsonb` })
              .pipe(Effect.result)
            expect(result._tag).toBe("Failure")
          }
          for (const payload of [
            { _tag: "outbound", cause: "sale" },
            { _tag: "inbound", cause: "tax_exempt" },
          ]) {
            expect(
              (yield* db
                .insert(schema.principalTransactionOverrides)
                .values({
                  ...fixture,
                  kind: "classification",
                  priceInput: null,
                  classificationInput: sql`${payload}::jsonb`,
                })
                .pipe(Effect.result))._tag
            ).toBe("Failure")
          }
          expect(
            (yield* db
              .insert(schema.principalTransactionOverrides)
              .values({ ...fixture, inspectedQuantity: "0" })
              .pipe(Effect.result))._tag
          ).toBe("Failure")
          expect(
            (yield* db
              .insert(schema.principalTransactionOverrides)
              .values({ ...fixture, reason: "\u2003" })
              .pipe(Effect.result))._tag
          ).toBe("Failure")
        })
      )
    )
  )

  it.effect(
    "retains history across source claims without changing actor or inspected ownership",
    () =>
      Effect.promise(() =>
        context.runPg(
          Effect.gen(function* () {
            const fixture = yield* seed
            const db = yield* drizzle
            yield* db.insert(schema.principalTransactionOverrides).values(fixture)
            const before = yield* db
              .select({
                principalId: schema.principalTransactionOverrides.principalId,
                actor: schema.principalTransactionOverrides.actorUserId,
                source: schema.principalTransactionOverrides.sourceId,
                key: schema.principalTransactionOverrides.inspectedSourceRecordKey,
              })
              .from(schema.principalTransactionOverrides)
            yield* db
              .update(schema.sources)
              .set({ principalId: OTHER_PRINCIPAL_ID })
              .where(eq(schema.sources.id, fixture.sourceId))
            const after = yield* db
              .select({
                principalId: schema.principalTransactionOverrides.principalId,
                actor: schema.principalTransactionOverrides.actorUserId,
                source: schema.principalTransactionOverrides.sourceId,
                key: schema.principalTransactionOverrides.inspectedSourceRecordKey,
              })
              .from(schema.principalTransactionOverrides)
            expect(after).toEqual(before)
            expect(
              yield* db
                .select({ owner: schema.movementCorrectionTargets.principalId })
                .from(schema.movementCorrectionTargets)
            ).toEqual([{ owner: OTHER_PRINCIPAL_ID }])
            expect(
              (yield* db
                .delete(schema.principals)
                .where(eq(schema.principals.id, TEST_PRINCIPAL_ID))
                .pipe(Effect.result))._tag
            ).toBe("Failure")
            expect(
              (yield* db
                .delete(schema.users)
                .where(eq(schema.users.id, TEST_USER_ID))
                .pipe(Effect.result))._tag
            ).toBe("Failure")
            expect(
              (yield* db
                .delete(schema.sources)
                .where(eq(schema.sources.id, fixture.sourceId))
                .pipe(Effect.result))._tag
            ).toBe("Failure")
            expect(
              (yield* db
                .delete(schema.movementCorrectionTargets)
                .where(eq(schema.movementCorrectionTargets.id, TARGET_ID))
                .pipe(Effect.result))._tag
            ).toBe("Failure")
          })
        )
      )
  )

  it.effect("rejects duplicate roots, stream branches and cross-kind supersession", () =>
    Effect.promise(() =>
      context.runPg(
        Effect.gen(function* () {
          const fixture = yield* seed
          const db = yield* drizzle
          const [root] = yield* db
            .insert(schema.principalTransactionOverrides)
            .values(fixture)
            .returning({ id: schema.principalTransactionOverrides.id })
          if (root === undefined) return yield* Effect.die("Missing synthetic root")
          expect(
            (yield* db
              .insert(schema.principalTransactionOverrides)
              .values(fixture)
              .pipe(Effect.result))._tag
          ).toBe("Failure")
          yield* db
            .insert(schema.principalTransactionOverrides)
            .values({ ...fixture, operation: "replace", supersedesOverrideId: root.id })
          expect(
            (yield* db
              .insert(schema.principalTransactionOverrides)
              .values({ ...fixture, operation: "replace", supersedesOverrideId: root.id })
              .pipe(Effect.result))._tag
          ).toBe("Failure")
          expect(
            (yield* db
              .insert(schema.principalTransactionOverrides)
              .values({
                ...fixture,
                kind: "classification",
                operation: "replace",
                priceInput: null,
                classificationInput: { _tag: "inbound", cause: "purchase" },
                supersedesOverrideId: root.id,
              })
              .pipe(Effect.result))._tag
          ).toBe("Failure")
        })
      )
    )
  )

  it.effect("rejects direct history updates and deletes", () =>
    Effect.promise(() =>
      context.runPg(
        Effect.gen(function* () {
          const fixture = yield* seed
          const db = yield* drizzle
          yield* db.insert(schema.principalTransactionOverrides).values(fixture)
          expect(
            (yield* db
              .update(schema.principalTransactionOverrides)
              .set({ reason: "Rewritten" })
              .pipe(Effect.result))._tag
          ).toBe("Failure")
          expect(
            (yield* db.delete(schema.principalTransactionOverrides).pipe(Effect.result))._tag
          ).toBe("Failure")
        })
      )
    )
  )

  it.effect("rejects a foreign actor and a foreign inspected source component", () =>
    Effect.promise(() =>
      context.runPg(
        Effect.gen(function* () {
          const fixture = yield* seed
          const db = yield* drizzle
          expect(
            (yield* db
              .insert(schema.principalTransactionOverrides)
              .values({ ...fixture, actorUserId: OTHER_USER_ID })
              .pipe(Effect.result))._tag
          ).toBe("Failure")
          expect(
            (yield* db
              .insert(schema.principalTransactionOverrides)
              .values({ ...fixture, inspectedComponentKey: "another-component" })
              .pipe(Effect.result))._tag
          ).toBe("Failure")
        })
      )
    )
  )

  it.effect("requires create-after-withdraw and rejects create over an active stream", () =>
    Effect.promise(() =>
      context.runPg(
        Effect.gen(function* () {
          const fixture = yield* seed
          const db = yield* drizzle
          const [root] = yield* db
            .insert(schema.principalTransactionOverrides)
            .values(fixture)
            .returning({ id: schema.principalTransactionOverrides.id })
          if (root === undefined) return yield* Effect.die("Missing synthetic root")
          expect(
            (yield* db
              .insert(schema.principalTransactionOverrides)
              .values({ ...fixture, supersedesOverrideId: root.id })
              .pipe(Effect.result))._tag
          ).toBe("Failure")
          const [withdrawal] = yield* db
            .insert(schema.principalTransactionOverrides)
            .values({
              ...fixture,
              operation: "withdraw",
              priceInput: null,
              supersedesOverrideId: root.id,
            })
            .returning({ id: schema.principalTransactionOverrides.id })
          if (withdrawal === undefined) return yield* Effect.die("Missing synthetic withdrawal")
          expect(
            (yield* db
              .insert(schema.principalTransactionOverrides)
              .values({ ...fixture, operation: "replace", supersedesOverrideId: withdrawal.id })
              .pipe(Effect.result))._tag
          ).toBe("Failure")
          yield* db
            .insert(schema.principalTransactionOverrides)
            .values({ ...fixture, supersedesOverrideId: withdrawal.id })
        })
      )
    )
  )

  it.effect("prevents rewriting a durable target key", () =>
    Effect.promise(() =>
      context.runPg(
        Effect.gen(function* () {
          yield* seed
          const db = yield* drizzle
          expect(
            (yield* db
              .update(schema.movementCorrectionTargets)
              .set({ componentKey: "different" })
              .where(eq(schema.movementCorrectionTargets.id, TARGET_ID))
              .pipe(Effect.result))._tag
          ).toBe("Failure")
        })
      )
    )
  )
  it.effect("rejects work linked to a job owned by another principal", () =>
    Effect.promise(() =>
      context.runPg(
        Effect.gen(function* () {
          const fixture = yield* seed
          const db = yield* drizzle
          const [record] = yield* db
            .insert(schema.principalTransactionOverrides)
            .values(fixture)
            .returning({ id: schema.principalTransactionOverrides.id })
          const [job] = yield* db
            .insert(schema.processingJobs)
            .values({
              sourceId: fixture.sourceId,
              principalId: OTHER_PRINCIPAL_ID,
              mode: "replay",
              status: "completed",
            })
            .returning({ id: schema.processingJobs.id })
          if (record === undefined || job === undefined)
            return yield* Effect.die("Missing synthetic application fixture")
          expect(
            (yield* db
              .insert(schema.principalTransactionOverrideApplications)
              .values({
                overrideId: record.id,
                sourceId: fixture.sourceId,
                processingJobId: job.id,
              })
              .pipe(Effect.result))._tag
          ).toBe("Failure")
        })
      )
    )
  )
})
