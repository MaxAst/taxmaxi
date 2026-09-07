import { beforeEach, describe, expect, it } from "@effect/vitest"
import { JurisdictionCode, TaxYear } from "@my/core/accounting"
import { CurrencyCode } from "@my/core/currency"
import { PrincipalId } from "@my/core/ownership"
import { count, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as DateTime from "effect/DateTime"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { PrincipalTransactionOverrideRepositoryLive } from "../../src/layers/PrincipalTransactionOverrideRepositoryLive.ts"
import { PrincipalTransactionOverrideRepository } from "../../src/services/PrincipalTransactionOverrideRepository.ts"
import { TransactionDetailRepositoryLive } from "../../src/layers/TransactionDetailRepositoryLive.ts"
import { TransactionDetailRepository } from "../../src/services/TransactionDetailRepository.ts"
import { schema } from "../../src/schema/index.ts"
import { prepareMovementLegFixtures } from "../support/movement-leg-fixtures.ts"
import {
  TEST_BTC_ASSET_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_transaction_detail",
})
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    import("../support/integration-test-kit.ts").SyncEngineRepositoryTestRuntime
  >
) => effect.pipe(Effect.provide(context.TestPgClientLive), Effect.scoped)
const time = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00Z"))
const scope = {
  jurisdiction: JurisdictionCode.make("DE"),
  taxYear: TaxYear.make(2026),
  reportingCurrency: CurrencyCode.make("EUR"),
}
const seed = Effect.gen(function* () {
  const fixture = yield* seedSyncEngineRepositoryFixture({
    principalId: "00000000-0000-4000-8000-000000008781",
    userId: "00000000-0000-4000-8000-000000008782",
    sourceId: "00000000-0000-4000-8000-000000008783",
  })
  yield* seedSyncEngineAssets(fixture)
  const db = yield* drizzle
  const [transaction, unresolved, excluded] = yield* db
    .insert(schema.transactions)
    .values(
      ["owned", "unresolved", "excluded"].map((externalId) => ({
        sourceId: fixture.sourceId,
        principalId: fixture.principalId,
        externalId,
        timestamp: time,
      }))
    )
    .returning({ id: schema.transactions.id })
  if (transaction === undefined || unresolved === undefined || excluded === undefined)
    return yield* Effect.die("Missing fixture transactions")
  const [raw] = yield* db
    .insert(schema.sourceRecordsRaw)
    .values({
      sourceId: fixture.sourceId,
      provider: "synthetic",
      recordType: "transfer",
      externalRecordId: "safe-evidence",
      occurredAt: time,
      payload: { secret: "must not leak" },
      externalAccountId: "private-account",
    })
    .returning({ id: schema.sourceRecordsRaw.id })
  if (raw === undefined) return yield* Effect.die("Missing fixture evidence")
  const legs = yield* prepareMovementLegFixtures(
    ["first", "second"].map((componentKey) => ({
      sourceId: fixture.sourceId,
      principalId: fixture.principalId,
      externalId: componentKey,
      timestamp: time,
      assetId: TEST_BTC_ASSET_ID,
      amount: "3",
      kind: "acquisition" as const,
      provenance: "deterministic" as const,
      originKind: "none" as const,
      transactionId: transaction.id,
      sourceRawRecordId: componentKey === "first" ? raw.id : null,
      movementIdentity: { sourceRecordKey: "owned", componentKey },
    }))
  )
  const inserted = yield* db.insert(schema.transactionLegs).values(legs).returning({
    id: schema.transactionLegs.id,
    targetId: schema.transactionLegs.movementCorrectionTargetId,
    rawId: schema.transactionLegs.sourceRawRecordId,
  })
  return {
    ...fixture,
    transactionId: transaction.id,
    unresolvedId: unresolved.id,
    excludedId: excluded.id,
    inserted,
  }
})
const read = (transactionId: string, principalId: string) =>
  context.runWithLayer({
    layer: TransactionDetailRepositoryLive,
    effect: Effect.flatMap(TransactionDetailRepository, (repo) =>
      repo.find({ transactionId, principalId: PrincipalId.make(principalId), scope })
    ),
  })
await Effect.runPromise(context.recreateTestDatabase())
beforeEach(() => Effect.runPromise(context.recreateTestDatabase()))

describe("transaction detail repository", () => {
  it.effect("returns exact equal movements and safe evidence in a read-only snapshot", () =>
    Effect.gen(function* () {
      const fixture = yield* run(seed)
      const detail = Option.getOrThrow(yield* read(fixture.transactionId, fixture.principalId))
      expect(detail.movements).toHaveLength(2)
      for (const leg of fixture.inserted) {
        expect(detail.movements.find((movement) => movement.id === leg.id)).toMatchObject({
          movementCorrectionTargetId: leg.targetId,
          sourceRawRecordId: leg.rawId,
          originKind: "none",
          evidenceStatus: leg.rawId === null ? "unavailable" : "available",
        })
      }
      expect(detail.classificationHistoryStatus).toBe("unavailable")
      const evidence = detail.movements.find(
        (movement) => movement.evidenceStatus === "available"
      )?.evidence
      expect(evidence).toMatchObject({ provider: "synthetic", externalRecordId: "safe-evidence" })
      expect(evidence).not.toHaveProperty("payload")
      expect(evidence).not.toHaveProperty("externalAccountId")
      const rows = yield* run(
        Effect.gen(function* () {
          const db = yield* drizzle
          return {
            jobs: yield* db.select({ count: count() }).from(schema.processingJobs),
            overrides: yield* db
              .select({ count: count() })
              .from(schema.principalTransactionOverrides),
            legs: yield* db.select({ count: count() }).from(schema.transactionLegs),
          }
        })
      )
      expect(rows).toEqual({
        jobs: [{ count: 0 }],
        overrides: [{ count: 0 }],
        legs: [{ count: 2 }],
      })
    })
  )
  it.effect("returns no detail for absent, foreign, unresolved and excluded identifiers", () =>
    Effect.gen(function* () {
      const fixture = yield* run(seed)
      for (const id of [
        fixture.unresolvedId,
        fixture.excludedId,
        "00000000-0000-4000-8000-000000008799",
      ])
        expect(Option.isNone(yield* read(id, fixture.principalId))).toBe(true)
      expect(
        Option.isNone(yield* read(fixture.transactionId, "00000000-0000-4000-8000-000000008799"))
      ).toBe(true)
      yield* run(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .delete(schema.transactionLegs)
            .where(eq(schema.transactionLegs.transactionId, fixture.transactionId))
        })
      )
      expect(Option.isNone(yield* read(fixture.transactionId, fixture.principalId))).toBe(true)
    })
  )
  it.effect("rejects snapshot discovery without a read-only repeatable-read transaction", () =>
    Effect.gen(function* () {
      const fixture = yield* run(seed)
      const results = yield* context.runWithLayer({
        layer: PrincipalTransactionOverrideRepositoryLive.pipe(
          Layer.provideMerge(context.TestPgClientLive)
        ),
        effect: Effect.gen(function* () {
          const repo = yield* PrincipalTransactionOverrideRepository
          const db = yield* drizzle
          const request = repo.findTransactionTargetsInSnapshot({
            principalId: PrincipalId.make(fixture.principalId),
            transactionId: fixture.transactionId,
            scope,
          })
          return [
            yield* Effect.result(request),
            yield* db.transaction(() => Effect.result(request), {
              isolationLevel: "read committed",
              accessMode: "read only",
            }),
            yield* db.transaction(() => Effect.result(request), {
              isolationLevel: "repeatable read",
              accessMode: "read write",
            }),
          ]
        }),
      })
      expect(results.map((result) => result._tag)).toEqual(["Failure", "Failure", "Failure"])
    })
  )
  it.effect("follows exact fee and custody links without adopting equal siblings", () =>
    Effect.gen(function* () {
      const fixture = yield* run(seed)
      const links = yield* run(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [provider] = yield* db
            .insert(schema.providerTransfers)
            .values({
              sourceId: fixture.sourceId,
              transactionId: fixture.transactionId,
              externalId: "provider",
              fromAccountRef: "source",
              toAddress: "destination",
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
              principalId: fixture.principalId,
              externalId: "canonical",
              fromAddress: "source",
              toAddress: "destination",
              timestamp: time,
              type: "native",
              assetId: TEST_BTC_ASSET_ID,
              amount: "3",
            })
            .returning({ id: schema.transfers.id })
          if (provider === undefined || transfer === undefined)
            return yield* Effect.die("Missing origins")
          yield* db.insert(schema.inventoryMovements).values({
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
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
          const [reconciliation] = yield* db
            .insert(schema.transferReconciliations)
            .values({
              principalId: fixture.principalId,
              providerTransferId: provider.id,
              canonicalTransferId: transfer.id,
              canonicalTransactionId: fixture.excludedId,
              status: "approved",
              matchReason: "Synthetic custody",
              confidence: "1",
              deterministic: true,
            })
            .returning({ id: schema.transferReconciliations.id })
          const first = fixture.inserted[0]
          if (first === undefined || reconciliation === undefined)
            return yield* Effect.die("Missing fixture movement")
          yield* db
            .update(schema.transactionLegs)
            .set({
              originKind: "canonical_transfer",
              sourceTransferId: transfer.id,
              transactionId: fixture.excludedId,
            })
            .where(eq(schema.transactionLegs.id, first.id))
          const feeValues = yield* prepareMovementLegFixtures(
            ["linked-fee", "unrelated-fee"].map((componentKey) => ({
              sourceId: fixture.sourceId,
              principalId: fixture.principalId,
              externalId: componentKey,
              timestamp: time,
              assetId: TEST_BTC_ASSET_ID,
              amount: "3",
              kind: "fee" as const,
              provenance: "deterministic" as const,
              originKind: "none" as const,
              transactionId: fixture.unresolvedId,
              feeForTransactionId:
                componentKey === "linked-fee" ? fixture.transactionId : fixture.unresolvedId,
              movementIdentity: { sourceRecordKey: componentKey, componentKey: "fee" },
            }))
          )
          const fees = yield* db.insert(schema.transactionLegs).values(feeValues).returning({
            id: schema.transactionLegs.id,
            feeForTransactionId: schema.transactionLegs.feeForTransactionId,
          })
          const [unlinkedProvider] = yield* db
            .insert(schema.providerTransfers)
            .values({
              sourceId: fixture.sourceId,
              transactionId: fixture.unresolvedId,
              externalId: "unlinked-provider",
              fromAccountRef: "source",
              toAddress: "destination",
              timestamp: time,
              direction: "outbound",
              processingMode: "accounting_and_evidence",
              amount: "3",
            })
            .returning({ id: schema.providerTransfers.id })
          const [unlinkedTransfer] = yield* db
            .insert(schema.transfers)
            .values({
              sourceId: fixture.sourceId,
              principalId: fixture.principalId,
              externalId: "unlinked-canonical",
              fromAddress: "source",
              toAddress: "destination",
              timestamp: time,
              type: "native",
              assetId: TEST_BTC_ASSET_ID,
              amount: "3",
            })
            .returning({ id: schema.transfers.id })
          if (unlinkedProvider === undefined || unlinkedTransfer === undefined)
            return yield* Effect.die("Missing unlinked origins")
          yield* db.insert(schema.inventoryMovements).values({
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            transactionId: fixture.unresolvedId,
            providerTransferId: unlinkedProvider.id,
            assetId: TEST_BTC_ASSET_ID,
            timestamp: time,
            direction: "outbound",
            purpose: "principal",
            taxTreatment: "non_taxable",
            reconciliationStatus: "matched",
            amount: "3",
          })
          yield* db.insert(schema.transferReconciliations).values({
            principalId: fixture.principalId,
            providerTransferId: unlinkedProvider.id,
            canonicalTransferId: unlinkedTransfer.id,
            canonicalTransactionId: fixture.excludedId,
            status: "approved",
            matchReason: "Synthetic unrelated custody",
            confidence: "1",
            deterministic: true,
          })
          const unlinkedValues = yield* prepareMovementLegFixtures([
            {
              sourceId: fixture.sourceId,
              principalId: fixture.principalId,
              externalId: "unlinked-leg",
              timestamp: time,
              assetId: TEST_BTC_ASSET_ID,
              amount: "3",
              kind: "acquisition",
              provenance: "deterministic",
              originKind: "canonical_transfer",
              sourceTransferId: unlinkedTransfer.id,
              transactionId: fixture.excludedId,
              movementIdentity: { sourceRecordKey: "unlinked-leg", componentKey: "main" },
            },
          ])
          const [unlinkedLeg] = yield* db
            .insert(schema.transactionLegs)
            .values(unlinkedValues)
            .returning({ id: schema.transactionLegs.id })
          if (unlinkedLeg === undefined) return yield* Effect.die("Missing unlinked leg")
          return { first, transfer, reconciliation, fees, unlinkedLeg }
        })
      )
      const detail = Option.getOrThrow(yield* read(fixture.transactionId, fixture.principalId))
      expect(detail.movements).toHaveLength(3)
      expect(detail.movements.some((movement) => movement.id === links.unlinkedLeg.id)).toBe(false)
      expect(
        detail.movements.find((movement) => movement.id === links.first.id)?.transactionId
      ).toBe(fixture.excludedId)
      expect(
        detail.movements.find((movement) => movement.id === links.first.id)?.sourceTransferId
      ).toBe(links.transfer.id)
      expect(detail.reconciliations.map((row) => row.id)).toEqual([links.reconciliation.id])
      for (const fee of links.fees)
        expect(detail.movements.some((movement) => movement.id === fee.id)).toBe(
          fee.feeForTransactionId === fixture.transactionId
        )
    })
  )
})
