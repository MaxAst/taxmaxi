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
          const [canonicalRaw] = yield* db
            .insert(schema.sourceRecordsRaw)
            .values({
              sourceId: fixture.sourceId,
              provider: "synthetic",
              recordType: "transaction",
              externalRecordId: "canonical-transaction-evidence",
              occurredAt: time,
              payload: {},
            })
            .returning({ id: schema.sourceRecordsRaw.id })
          if (canonicalRaw === undefined)
            return yield* Effect.die("Missing canonical transaction evidence")
          yield* db
            .update(schema.transactions)
            .set({ sourceRawRecordId: canonicalRaw.id })
            .where(eq(schema.transactions.id, fixture.excludedId))
          return { first, transfer, reconciliation, fees, unlinkedLeg, canonicalRaw }
        })
      )
      const detail = Option.getOrThrow(yield* read(fixture.transactionId, fixture.principalId))
      expect(
        detail.sourceEvidence.find(
          (link) => link.origin === "transaction" && link.originId === fixture.excludedId
        )
      ).toMatchObject({
        sourceRawRecordId: links.canonicalRaw.id,
        status: "available",
        evidence: { id: links.canonicalRaw.id },
      })
      expect(detail.sourceRawRecordId).toBeNull()
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
  it.effect("retains transaction and exact origin evidence without changing null leg links", () =>
    Effect.gen(function* () {
      const fixture = yield* run(seed)
      const links = yield* run(
        Effect.gen(function* () {
          const db = yield* drizzle
          const foreign = yield* seedSyncEngineRepositoryFixture({
            principalId: "00000000-0000-4000-8000-000000008791",
            userId: "00000000-0000-4000-8000-000000008792",
            sourceId: "00000000-0000-4000-8000-000000008793",
          })
          const records = yield* db
            .insert(schema.sourceRecordsRaw)
            .values(
              ["transaction", "provider", "canonical", "unrelated", "foreign"].map((name) => ({
                sourceId: name === "foreign" ? foreign.sourceId : fixture.sourceId,
                provider: "synthetic",
                recordType: "transfer",
                externalRecordId: name,
                occurredAt: time,
                payload: { secret: name },
              }))
            )
            .returning({
              id: schema.sourceRecordsRaw.id,
              name: schema.sourceRecordsRaw.externalRecordId,
            })
          const transactionRaw = records.find((row) => row.name === "transaction")
          const providerRaw = records.find((row) => row.name === "provider")
          const canonicalRaw = records.find((row) => row.name === "canonical")
          const foreignRaw = records.find((row) => row.name === "foreign")
          const [first, second] = fixture.inserted
          if (
            transactionRaw === undefined ||
            providerRaw === undefined ||
            canonicalRaw === undefined ||
            foreignRaw === undefined ||
            first === undefined ||
            second === undefined
          )
            return yield* Effect.die("Missing evidence fixtures")
          const [provider] = yield* db
            .insert(schema.providerTransfers)
            .values({
              sourceId: fixture.sourceId,
              transactionId: fixture.transactionId,
              sourceRawRecordId: providerRaw.id,
              externalId: "evidence-provider",
              timestamp: time,
              direction: "inbound",
              processingMode: "evidence_only",
              amount: "3",
              fromAccountRef: "source",
              toAddress: "destination",
            })
            .returning({ id: schema.providerTransfers.id })
          const [canonical] = yield* db
            .insert(schema.transfers)
            .values({
              sourceId: fixture.sourceId,
              principalId: fixture.principalId,
              sourceRawRecordId: canonicalRaw.id,
              externalId: "evidence-canonical",
              timestamp: time,
              type: "native",
              assetId: TEST_BTC_ASSET_ID,
              amount: "3",
              fromAddress: "source",
              toAddress: "destination",
            })
            .returning({ id: schema.transfers.id })
          if (provider === undefined || canonical === undefined)
            return yield* Effect.die("Missing evidence origins")
          yield* db
            .update(schema.transactions)
            .set({ sourceRawRecordId: transactionRaw.id })
            .where(eq(schema.transactions.id, fixture.transactionId))
          yield* db
            .update(schema.transactionLegs)
            .set({
              sourceRawRecordId: null,
              originKind: "provider_transfer",
              providerTransferId: provider.id,
            })
            .where(eq(schema.transactionLegs.id, first.id))
          yield* db
            .update(schema.transactionLegs)
            .set({
              sourceRawRecordId: null,
              originKind: "canonical_transfer",
              sourceTransferId: canonical.id,
            })
            .where(eq(schema.transactionLegs.id, second.id))
          return {
            first,
            second,
            provider,
            canonical,
            transactionRaw,
            providerRaw,
            canonicalRaw,
            foreignRaw,
          }
        })
      )
      const detail = Option.getOrThrow(yield* read(fixture.transactionId, fixture.principalId))
      expect(
        detail.movements.every(
          (movement) =>
            movement.sourceRawRecordId === null && movement.evidenceStatus === "unavailable"
        )
      ).toBe(true)
      expect(detail.sourceRawRecordId).toBe(links.transactionRaw.id)
      expect(
        detail.sourceEvidence
          .filter((link) => link.status === "available")
          .map((link) => ({
            origin: link.origin,
            originId: link.originId,
            rawId: link.evidence?.id,
          }))
      ).toEqual([
        { origin: "transaction", originId: fixture.transactionId, rawId: links.transactionRaw.id },
        { origin: "provider_transfer", originId: links.provider.id, rawId: links.providerRaw.id },
        {
          origin: "canonical_transfer",
          originId: links.canonical.id,
          rawId: links.canonicalRaw.id,
        },
      ])
      yield* run(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .update(schema.transactions)
            .set({ sourceRawRecordId: links.foreignRaw.id })
            .where(eq(schema.transactions.id, fixture.transactionId))
          yield* db
            .update(schema.providerTransfers)
            .set({ sourceRawRecordId: links.foreignRaw.id })
            .where(eq(schema.providerTransfers.id, links.provider.id))
          yield* db
            .update(schema.transfers)
            .set({ sourceRawRecordId: links.foreignRaw.id })
            .where(eq(schema.transfers.id, links.canonical.id))
          yield* db
            .update(schema.transactionLegs)
            .set({ sourceRawRecordId: links.foreignRaw.id })
            .where(eq(schema.transactionLegs.id, links.first.id))
        })
      )
      const guarded = Option.getOrThrow(yield* read(fixture.transactionId, fixture.principalId))
      expect(
        guarded.sourceEvidence.every(
          (link) => link.evidence === null && link.status === "unavailable"
        )
      ).toBe(true)
    })
  )
  it.effect("returns direct pending reconciliation links without transfer origins", () =>
    Effect.gen(function* () {
      const fixture = yield* run(seed)
      const expected = yield* run(
        Effect.gen(function* () {
          const db = yield* drizzle
          const foreign = yield* seedSyncEngineRepositoryFixture({
            principalId: "00000000-0000-4000-8000-000000008791",
            userId: "00000000-0000-4000-8000-000000008792",
            sourceId: "00000000-0000-4000-8000-000000008793",
          })
          const [foreignTransaction] = yield* db
            .insert(schema.transactions)
            .values({
              sourceId: foreign.sourceId,
              principalId: foreign.principalId,
              externalId: "foreign-pending",
              timestamp: time,
            })
            .returning({ id: schema.transactions.id })
          if (foreignTransaction === undefined)
            return yield* Effect.die("Missing foreign transaction")
          const [providerTransactionRaw] = yield* db
            .insert(schema.sourceRecordsRaw)
            .values({
              sourceId: fixture.sourceId,
              provider: "synthetic",
              recordType: "transaction",
              externalRecordId: "pending-provider-transaction",
              occurredAt: time,
              payload: {},
            })
            .returning({ id: schema.sourceRecordsRaw.id })
          if (providerTransactionRaw === undefined)
            return yield* Effect.die("Missing provider transaction evidence")
          yield* db
            .update(schema.transactions)
            .set({ sourceRawRecordId: providerTransactionRaw.id })
            .where(eq(schema.transactions.id, fixture.unresolvedId))
          const results: Array<string> = []
          for (const name of ["pending", "needs_review", "unrelated", "foreign"] as const) {
            const [provider] = yield* db
              .insert(schema.providerTransfers)
              .values({
                sourceId: name === "foreign" ? foreign.sourceId : fixture.sourceId,
                transactionId: name === "foreign" ? foreignTransaction.id : fixture.unresolvedId,
                externalId: name,
                timestamp: time,
                direction: "outbound",
                processingMode: "evidence_only",
                amount: "3",
                fromAccountRef: "source",
                toAddress: "destination",
              })
              .returning({ id: schema.providerTransfers.id })
            if (provider === undefined) return yield* Effect.die("Missing pending provider")
            const [row] = yield* db
              .insert(schema.transferReconciliations)
              .values({
                principalId: name === "foreign" ? foreign.principalId : fixture.principalId,
                providerTransferId: provider.id,
                canonicalTransferId: null,
                canonicalTransactionId:
                  name === "unrelated" ? fixture.excludedId : fixture.transactionId,
                status: name === "needs_review" ? "needs_review" : "pending",
                matchReason: "Synthetic pending match",
              })
              .returning({ id: schema.transferReconciliations.id })
            if (row === undefined) return yield* Effect.die("Missing pending reconciliation")
            if (name === "pending" || name === "needs_review") results.push(row.id)
          }
          return results.sort()
        })
      )
      const detail = Option.getOrThrow(yield* read(fixture.transactionId, fixture.principalId))
      expect(detail.movements.every((movement) => movement.originKind === "none")).toBe(true)
      expect(
        detail.sourceEvidence.find(
          (link) => link.origin === "transaction" && link.originId === fixture.unresolvedId
        )
      ).toMatchObject({
        status: "available",
        sourceId: fixture.sourceId,
        evidence: { sourceId: fixture.sourceId, externalRecordId: "pending-provider-transaction" },
      })
      expect(detail.reconciliations.map((row) => row.id)).toEqual(expected)
      expect(detail.reconciliations.map((row) => row.status).sort()).toEqual([
        "needs_review",
        "pending",
      ])
      expect(detail.reconciliations.every((row) => row.canonicalTransferId === null)).toBe(true)
    })
  )
  it.effect(
    "follows direct provider and reconciliation endpoint evidence without current legs or status filtering",
    () =>
      Effect.gen(function* () {
        const fixture = yield* run(seed)
        const expected = yield* run(
          Effect.gen(function* () {
            const db = yield* drizzle
            const foreign = yield* seedSyncEngineRepositoryFixture({
              principalId: "00000000-0000-4000-8000-000000008791",
              userId: "00000000-0000-4000-8000-000000008792",
              sourceId: "00000000-0000-4000-8000-000000008793",
            })
            const [account] = yield* db
              .select({ cexId: schema.cexAccount.cexId })
              .from(schema.cexAccount)
              .where(eq(schema.cexAccount.id, fixture.cexAccountId))
            if (account === undefined) return yield* Effect.die("Missing source account")
            const [otherAccount] = yield* db
              .insert(schema.cexAccount)
              .values({
                cexId: account.cexId,
                principalId: fixture.principalId,
                providerAccountId: "canonical-evidence-account",
              })
              .returning({ id: schema.cexAccount.id })
            if (otherAccount === undefined) return yield* Effect.die("Missing canonical account")
            const [otherSource] = yield* db
              .insert(schema.sources)
              .values({
                principalId: fixture.principalId,
                cexAccountId: otherAccount.id,
                sourceableType: "cex",
                name: "Canonical evidence source",
              })
              .returning({ id: schema.sources.id })
            if (otherSource === undefined) return yield* Effect.die("Missing canonical source")
            const [canonicalTransaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: otherSource.id,
                principalId: fixture.principalId,
                externalId: "canonical-endpoint",
                timestamp: time,
              })
              .returning({ id: schema.transactions.id })
            const [providerAsset] = yield* db
              .insert(schema.providerAssets)
              .values({
                provider: "synthetic",
                providerAssetId: "stale-provider-asset",
                currencyCode: "BTC",
                retrievedAt: time,
              })
              .returning({ id: schema.providerAssets.id })
            if (canonicalTransaction === undefined || providerAsset === undefined)
              return yield* Effect.die("Missing endpoint fixtures")
            const expectedLinks: Array<{
              origin: string
              originId: string
              sourceId: string
              rawId: string
              externalRecordId: string
            }> = []
            const expectedReconciliations: Array<string> = []
            for (const status of [
              "pending",
              "needs_review",
              "rejected",
              "approved",
              "auto_applied",
            ] as const) {
              const [providerRaw, canonicalRaw] = yield* db
                .insert(schema.sourceRecordsRaw)
                .values([
                  {
                    sourceId: fixture.sourceId,
                    provider: "synthetic-provider",
                    recordType: "transfer",
                    externalRecordId: `provider-${status}`,
                    occurredAt: time,
                    payload: {},
                  },
                  {
                    sourceId: otherSource.id,
                    provider: "synthetic-canonical",
                    recordType: "transfer",
                    externalRecordId: `canonical-${status}`,
                    occurredAt: time,
                    payload: {},
                  },
                ])
                .returning({ id: schema.sourceRecordsRaw.id })
              if (providerRaw === undefined || canonicalRaw === undefined)
                return yield* Effect.die("Missing endpoint raw rows")
              const [provider] = yield* db
                .insert(schema.providerTransfers)
                .values({
                  sourceId: fixture.sourceId,
                  transactionId: fixture.transactionId,
                  sourceRawRecordId: providerRaw.id,
                  externalId: status,
                  providerAssetId: providerAsset.id,
                  timestamp: time,
                  direction: "outbound",
                  processingMode:
                    status === "rejected" ? "accounting_and_evidence" : "evidence_only",
                  amount: "3",
                  fromAccountRef: "source",
                  toAddress: "destination",
                })
                .returning({ id: schema.providerTransfers.id })
              const [canonical] = yield* db
                .insert(schema.transfers)
                .values({
                  sourceId: otherSource.id,
                  principalId: fixture.principalId,
                  sourceRawRecordId: canonicalRaw.id,
                  externalId: status,
                  timestamp: time,
                  type: "native",
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "3",
                  fromAddress: "source",
                  toAddress: "destination",
                })
                .returning({ id: schema.transfers.id })
              if (provider === undefined || canonical === undefined)
                return yield* Effect.die("Missing retained endpoint")
              const [reconciliation] = yield* db
                .insert(schema.transferReconciliations)
                .values({
                  principalId: fixture.principalId,
                  providerTransferId: provider.id,
                  canonicalTransferId: canonical.id,
                  canonicalTransactionId: canonicalTransaction.id,
                  status,
                  deterministic: status === "auto_applied",
                  matchReason: "Synthetic retained endpoint",
                })
                .returning({ id: schema.transferReconciliations.id })
              if (reconciliation === undefined)
                return yield* Effect.die("Missing retained reconciliation")
              expectedReconciliations.push(reconciliation.id)
              expectedLinks.push(
                {
                  origin: "provider_transfer",
                  originId: provider.id,
                  sourceId: fixture.sourceId,
                  rawId: providerRaw.id,
                  externalRecordId: `provider-${status}`,
                },
                {
                  origin: "canonical_transfer",
                  originId: canonical.id,
                  sourceId: otherSource.id,
                  rawId: canonicalRaw.id,
                  externalRecordId: `canonical-${status}`,
                }
              )
            }
            // Same-source but unrelated, and a foreign source falsely pointing at the selected ID.
            for (const mode of ["unrelated", "foreign"] as const) {
              const sourceId = mode === "foreign" ? foreign.sourceId : fixture.sourceId
              const [raw] = yield* db
                .insert(schema.sourceRecordsRaw)
                .values({
                  sourceId,
                  provider: "synthetic",
                  recordType: "transfer",
                  externalRecordId: mode,
                  occurredAt: time,
                  payload: {},
                })
                .returning({ id: schema.sourceRecordsRaw.id })
              if (raw === undefined) return yield* Effect.die("Missing excluded evidence")
              yield* db.insert(schema.providerTransfers).values({
                sourceId,
                transactionId: mode === "unrelated" ? fixture.unresolvedId : fixture.transactionId,
                sourceRawRecordId: raw.id,
                externalId: mode,
                timestamp: time,
                direction: "outbound",
                processingMode: "evidence_only",
                amount: "3",
                fromAccountRef: "source",
                toAddress: "destination",
              })
              yield* db.insert(schema.transfers).values({
                sourceId,
                principalId: mode === "foreign" ? foreign.principalId : fixture.principalId,
                sourceRawRecordId: raw.id,
                externalId: mode,
                timestamp: time,
                type: "native",
                assetId: TEST_BTC_ASSET_ID,
                amount: "3",
                fromAddress: "source",
                toAddress: "destination",
              })
            }
            const [unrelatedRaw] = yield* db
              .insert(schema.sourceRecordsRaw)
              .values({
                sourceId: otherSource.id,
                provider: "synthetic",
                recordType: "transfer",
                externalRecordId: "wrong-source-origin",
                occurredAt: time,
                payload: {},
              })
              .returning({ id: schema.sourceRecordsRaw.id })
            if (unrelatedRaw === undefined)
              return yield* Effect.die("Missing wrong-source evidence")
            const [unrelatedProvider] = yield* db
              .insert(schema.providerTransfers)
              .values({
                sourceId: otherSource.id,
                transactionId: canonicalTransaction.id,
                sourceRawRecordId: unrelatedRaw.id,
                externalId: "wrong-source-provider",
                timestamp: time,
                direction: "outbound",
                processingMode: "evidence_only",
                amount: "3",
                fromAccountRef: "source",
                toAddress: "destination",
              })
              .returning({ id: schema.providerTransfers.id })
            const [unrelatedCanonical] = yield* db
              .insert(schema.transfers)
              .values({
                sourceId: otherSource.id,
                principalId: fixture.principalId,
                sourceRawRecordId: unrelatedRaw.id,
                externalId: "wrong-source-canonical",
                timestamp: time,
                type: "native",
                assetId: TEST_BTC_ASSET_ID,
                amount: "3",
                fromAddress: "source",
                toAddress: "destination",
              })
              .returning({ id: schema.transfers.id })
            if (unrelatedProvider === undefined || unrelatedCanonical === undefined)
              return yield* Effect.die("Missing wrong-source origins")
            yield* db.insert(schema.transferReconciliations).values({
              principalId: fixture.principalId,
              providerTransferId: unrelatedProvider.id,
              canonicalTransferId: unrelatedCanonical.id,
              canonicalTransactionId: canonicalTransaction.id,
              status: "pending",
              matchReason: "Unrelated source origins",
            })
            return {
              expectedLinks,
              expectedReconciliations,
              canonicalTransaction,
              unrelatedProvider,
              unrelatedCanonical,
            }
          })
        )
        const detail = Option.getOrThrow(yield* read(fixture.transactionId, fixture.principalId))
        expect(detail.movements).toHaveLength(2)
        expect(detail.movements.every((movement) => movement.originKind === "none")).toBe(true)
        expect(detail.reconciliations.map((row) => row.id)).toEqual(
          expected.expectedReconciliations.sort()
        )
        const transferEvidence = detail.sourceEvidence.filter(
          (link) => link.origin === "provider_transfer" || link.origin === "canonical_transfer"
        )
        expect(transferEvidence).toHaveLength(10)
        for (const link of expected.expectedLinks)
          expect(transferEvidence.find((row) => row.originId === link.originId)).toMatchObject({
            origin: link.origin,
            sourceId: link.sourceId,
            sourceRawRecordId: link.rawId,
            status: "available",
            evidence: {
              id: link.rawId,
              sourceId: link.sourceId,
              externalRecordId: link.externalRecordId,
            },
          })
        expect(
          detail.sourceEvidence.find(
            (link) =>
              link.origin === "transaction" && link.originId === expected.canonicalTransaction.id
          )?.status
        ).toBe("unavailable")
        yield* run(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [first, second] = fixture.inserted
            if (first === undefined || second === undefined)
              return yield* Effect.die("Missing original legs")
            yield* db
              .update(schema.transactionLegs)
              .set({
                originKind: "canonical_transfer",
                sourceTransferId: expected.unrelatedCanonical.id,
              })
              .where(eq(schema.transactionLegs.id, first.id))
            yield* db
              .update(schema.transactionLegs)
              .set({
                originKind: "provider_transfer",
                providerTransferId: expected.unrelatedProvider.id,
              })
              .where(eq(schema.transactionLegs.id, second.id))
          })
        )
        const guarded = Option.getOrThrow(yield* read(fixture.transactionId, fixture.principalId))
        expect(guarded.reconciliations.map((row) => row.id)).toEqual(
          expected.expectedReconciliations.sort()
        )
        expect(
          guarded.sourceEvidence.some(
            (link) =>
              link.originId === expected.unrelatedProvider.id ||
              link.originId === expected.unrelatedCanonical.id
          )
        ).toBe(false)
      })
  )
})
