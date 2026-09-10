import { vi } from "vitest"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { JurisdictionCode, TaxYear, type MovementPriceInput } from "@my/core/accounting"
import { AuthUserId } from "@my/core/authentication"
import { CurrencyCode } from "@my/core/currency"
import { PrincipalId } from "@my/core/ownership"
import { count, eq } from "drizzle-orm"
import * as BigDecimal from "effect/BigDecimal"
import * as Effect from "effect/Effect"
import * as DateTime from "effect/DateTime"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  SourceNormalizationRepository,
  SourceSyncJobRepository,
  type SourceSyncExecutionState,
} from "@my/sync-engine/services"
import { SourceNormalizationRepositoryLive } from "../../src/layers/SourceNormalizationRepositoryLive.ts"
import { SourceSyncJobRepositoryLive } from "../../src/layers/SourceSyncJobRepositoryLive.ts"
import { CalculationRunRepositoryLive } from "../../src/layers/CalculationRunRepositoryLive.ts"
import { CalculationRunServiceLive } from "../../src/layers/CalculationRunServiceLive.ts"
import { FactualLedgerRepositoryLive } from "../../src/layers/FactualLedgerRepositoryLive.ts"
import { CalculationRunId } from "../../src/services/CalculationRunRepository.ts"
import { CalculationRunService } from "../../src/services/CalculationRunService.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { PrincipalTransactionOverrideRepositoryLive } from "../../src/layers/PrincipalTransactionOverrideRepositoryLive.ts"
import { PrincipalTransactionOverrideRepository } from "../../src/services/PrincipalTransactionOverrideRepository.ts"
import { TransactionListRepositoryLive } from "../../src/layers/TransactionListRepositoryLive.ts"
import { TransactionListRepository } from "../../src/services/TransactionListRepository.ts"
import { TransactionDetailRepositoryLive } from "../../src/layers/TransactionDetailRepositoryLive.ts"
import { TransactionDetailRepository } from "../../src/services/TransactionDetailRepository.ts"
import { schema } from "../../src/schema/index.ts"
import { prepareMovementLegFixtures } from "../support/movement-leg-fixtures.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_BTC_REPRESENTATION_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

// Pause after detail has established its PostgreSQL snapshot, before its remaining reads.
const detailSnapshot = vi.hoisted(() => ({
  afterInitialRead: null as (() => Promise<void>) | null,
}))
vi.mock("../../src/layers/PrincipalTransactionOverrideRepositoryLive.ts", (importOriginal) =>
  Promise.all([
    importOriginal<
      typeof import("../../src/layers/PrincipalTransactionOverrideRepositoryLive.ts")
    >(),
    import("effect/Effect"),
    import("effect/Layer"),
    import("../../src/services/PrincipalTransactionOverrideRepository.ts"),
  ]).then(([original, effect, layer, services]) => ({
    ...original,
    PrincipalTransactionOverrideRepositoryLive: layer
      .effect(
        services.PrincipalTransactionOverrideRepository,
        effect.map(services.PrincipalTransactionOverrideRepository, (repository) => ({
          ...repository,
          findTransactionTargetsInSnapshot: (
            params: Parameters<typeof repository.findTransactionTargetsInSnapshot>[0]
          ) =>
            effect.gen(function* () {
              const hook = detailSnapshot.afterInitialRead
              detailSnapshot.afterInitialRead = null
              if (hook !== null) yield* effect.promise(hook)
              return yield* repository.findTransactionTargetsInSnapshot(params)
            }),
        }))
      )
      .pipe(layer.provide(original.PrincipalTransactionOverrideRepositoryLive)),
  }))
)

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
const PRINCIPAL_ID = PrincipalId.make("00000000-0000-4000-8000-000000007101")
const USER_ID = AuthUserId.make("00000000-0000-4000-8000-000000007102")
const SOURCE_ID = "00000000-0000-4000-8000-000000007103"
const EUR = CurrencyCode.make("EUR")
const runPg = run
const runId = (index: number) =>
  CalculationRunId.make(`00000000-0000-4000-8000-${String(7200 + index).padStart(12, "0")}`)
const runLayer = CalculationRunServiceLive.pipe(
  Layer.provide(Layer.merge(CalculationRunRepositoryLive, FactualLedgerRepositoryLive))
)
const recompute = (index: number) =>
  context.runWithLayer({
    layer: runLayer,
    effect: Effect.flatMap(CalculationRunService, (service) =>
      service.recompute({
        id: runId(index),
        principalId: PRINCIPAL_ID,
        ...scope,
        accountingChoices: [],
      })
    ),
  })
const moneyEquals = (actual: string | null | undefined, expected: string) =>
  actual != null &&
  BigDecimal.equals(BigDecimal.fromStringUnsafe(actual), BigDecimal.fromStringUnsafe(expected))
const seedCalculation = ({
  quantity = "2",
  principalId = PRINCIPAL_ID,
  userId = USER_ID,
  sourceId = SOURCE_ID,
  assets = true,
  systemPurchaseValue = null,
  transactionType = "buy_fiat",
}: {
  readonly quantity?: string
  readonly principalId?: PrincipalId
  readonly userId?: AuthUserId
  readonly sourceId?: string
  readonly assets?: boolean
  readonly transactionType?: string | null
  readonly systemPurchaseValue?: string | null
} = {}) =>
  Effect.gen(function* () {
    const fixture = yield* seedSyncEngineRepositoryFixture({ principalId, userId, sourceId })
    if (assets) yield* seedSyncEngineAssets(fixture)
    const db = yield* drizzle
    const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2026-02-01T00:00:00Z"))
    const saleTimestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2026-03-01T00:00:00Z"))
    const [purchase, sale] = yield* db
      .insert(schema.transactions)
      .values([
        {
          principalId,
          sourceId,
          externalId: "synthetic-purchase",
          timestamp,
          transactionType,
          providerFiatAmount: systemPurchaseValue,
          providerFiatCurrency: systemPurchaseValue === null ? null : "EUR",
        },
        {
          principalId,
          sourceId,
          externalId: "synthetic-sale",
          timestamp: saleTimestamp,
          transactionType: "sell_fiat",
          providerFiatAmount: "30",
          providerFiatCurrency: "EUR",
        },
      ])
      .returning({ id: schema.transactions.id })
    if (purchase === undefined || sale === undefined)
      return yield* Effect.die("Missing synthetic transactions")
    const legs = yield* prepareMovementLegFixtures([
      {
        movementIdentity: { sourceRecordKey: "synthetic-purchase", componentKey: "principal" },
        principalId,
        sourceId,
        externalId: "synthetic-purchase-leg",
        transactionId: purchase.id,
        timestamp,
        assetId: TEST_BTC_ASSET_ID,
        amount: quantity,
        kind: "acquisition",
        provenance: "deterministic",
        originKind: "none",
      },
      {
        movementIdentity: { sourceRecordKey: "synthetic-sale", componentKey: "principal" },
        principalId,
        sourceId,
        externalId: "synthetic-sale-leg",
        transactionId: sale.id,
        timestamp: saleTimestamp,
        assetId: TEST_BTC_ASSET_ID,
        amount: quantity,
        kind: "disposal",
        provenance: "deterministic",
        originKind: "none",
      },
    ])
    const [acquisition, disposition] = yield* db
      .insert(schema.transactionLegs)
      .values(legs)
      .returning({
        id: schema.transactionLegs.id,
        targetId: schema.transactionLegs.movementCorrectionTargetId,
      })
    if (acquisition === undefined || disposition === undefined)
      return yield* Effect.die("Missing synthetic movements")
    return {
      acquisition,
      disposition,
      purchaseId: purchase.id,
      saleId: sale.id,
      timestamp,
      cexAccountId: fixture.cexAccountId,
    }
  })

const changePrice = ({
  operation,
  targetId,
  input,
}: {
  readonly operation: "create" | "replace" | "withdraw"
  readonly targetId: string
  readonly input?: MovementPriceInput
}) =>
  context.runWithLayer({
    layer: PrincipalTransactionOverrideRepositoryLive,
    effect: Effect.flatMap(PrincipalTransactionOverrideRepository, (repository) =>
      Effect.gen(function* () {
        const found = yield* repository.findContext({
          principalId: PRINCIPAL_ID,
          targetId,
          reportingCurrency: EUR,
        })
        if (Option.isNone(found) || found.value.current === null)
          return yield* Effect.die("Missing current synthetic movement")
        const parameters = {
          principalId: PRINCIPAL_ID,
          actorUserId: USER_ID,
          targetId,
          expectedSystemRevision: found.value.current.facts.systemRevision,
          expectedLeafId: found.value.price.leaf?.id ?? null,
          reason: "Synthetic price evidence",
          reportingCurrency: EUR,
        }
        const result =
          operation === "withdraw"
            ? yield* repository.withdraw({ ...parameters, kind: "price" })
            : input === undefined
              ? yield* Effect.die("Missing synthetic price")
              : yield* repository[operation]({
                  ...parameters,
                  reportingCurrency: EUR,
                  input: { _tag: "price", input },
                })
        if (Option.isNone(result)) return yield* Effect.die("Synthetic correction was not accepted")
        return result.value
      })
    ),
  })

const completeReplay = (jobId: string) => {
  const state: SourceSyncExecutionState = {
    phase: "completed",
    processedRecords: 1,
    totalRecords: 1,
    fetchedRecords: 1,
    normalizedRecords: 1,
    failedRecords: 0,
    cursorPayload: null,
    highWatermark: null,
    checkpointExternalId: null,
    checkpointRawRecordId: null,
  }
  return context.runWithLayer({
    layer: SourceSyncJobRepositoryLive,
    effect: Effect.flatMap(SourceSyncJobRepository, (repo) =>
      Effect.gen(function* () {
        const job = yield* runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ status: schema.processingJobs.status })
              .from(schema.processingJobs)
              .where(eq(schema.processingJobs.id, jobId))
          })
        )
        if (job[0]?.status === "pending")
          yield* repo.claimJob({
            jobId,
            workerId: "synthetic-projection-worker",
            startedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00Z")),
          })
        return yield* repo.completeJob({ jobId, state })
      })
    ),
  })
}

await Effect.runPromise(context.recreateTestDatabase())
beforeEach(() => {
  detailSnapshot.afterInitialRead = null
  return Effect.runPromise(context.recreateTestDatabase())
})

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

const readCalculation = (transactionId: string) =>
  Effect.map(read(transactionId, PRINCIPAL_ID), Option.getOrThrow)

const storedRun = (index: number) =>
  run(
    Effect.gen(function* () {
      const db = yield* drizzle
      return {
        results: yield* db
          .select({
            acquisitionEventId: schema.calculationRunRealizedResults.acquisitionEventId,
            dispositionEventId: schema.calculationRunRealizedResults.dispositionEventId,
            costBasis: schema.calculationRunRealizedResults.costBasis,
            proceeds: schema.calculationRunRealizedResults.proceeds,
            gainLoss: schema.calculationRunRealizedResults.gainLoss,
            treatmentCodes: schema.calculationRunRealizedResults.treatmentCodes,
          })
          .from(schema.calculationRunRealizedResults)
          .where(eq(schema.calculationRunRealizedResults.runId, runId(index))),
        inputs: yield* db
          .select({ captured: schema.calculationRunCorrectionInputs.captured })
          .from(schema.calculationRunCorrectionInputs)
          .where(eq(schema.calculationRunCorrectionInputs.runId, runId(index))),
      }
    })
  )

const acceptTotal = (
  targetId: string,
  amount: string,
  operation: "create" | "replace" = "create"
) => changePrice({ targetId, operation, input: { _tag: "total_value", amount, currency: EUR } })

const expectResult = (
  calculation: import("../../src/services/TransactionDetailRepository.ts").TransactionDetail["calculation"],
  basis: string,
  gain: string
) => {
  expect(calculation.allocations).toHaveLength(1)
  const allocation = calculation.allocations[0]
  expect(moneyEquals(allocation?.costBasis, basis)).toBe(true)
  expect(moneyEquals(allocation?.proceeds, "30")).toBe(true)
  expect(moneyEquals(allocation?.gainLoss, gain)).toBe(true)
  expect(allocation?.treatmentCodes.length).toBeGreaterThan(0)
}

for (const parent of [
  "other_transaction",
  "no_transaction",
  "unrelated_only",
  "transaction_blocker",
] as const) {
  it.effect(`reads only the exact linked fee capture with ${parent}`, () =>
    Effect.gen(function* () {
      const fixture = yield* run(seedCalculation())
      const fees = yield* run(
        Effect.gen(function* () {
          const db = yield* drizzle
          const feeAssetId = "00000000-0000-4000-8000-000000007299"
          yield* db
            .insert(schema.assets)
            .values({ id: feeAssetId, name: "Unpriced fee", symbol: "FEE", type: "fungible" })
          const [other] = yield* db
            .insert(schema.transactions)
            .values({
              principalId: PRINCIPAL_ID,
              sourceId: SOURCE_ID,
              externalId: "fee-parent",
              timestamp: time,
            })
            .returning({ id: schema.transactions.id })
          if (other === undefined) return yield* Effect.die("Missing fee parent")
          if (parent === "transaction_blocker") {
            const [provider] = yield* db
              .insert(schema.providerAssets)
              .values({
                provider: "synthetic",
                providerAssetId: "unknown-fee-parent-asset",
                currencyCode: "UNKNOWN",
                name: "Unresolved parent asset",
                exponent: 8,
                providerType: "crypto",
                rawProviderPayload: {},
                evidenceRevision: 1,
                discoveredAt: time,
                retrievedAt: time,
              })
              .returning({ id: schema.providerAssets.id })
            if (provider === undefined) return yield* Effect.die("Missing parent provider asset")
            yield* db
              .insert(schema.providerAssetSourceUses)
              .values({ providerAssetRowId: provider.id, sourceId: SOURCE_ID })
            yield* db.insert(schema.providerAssetTransactionUses).values({
              providerAssetRowId: provider.id,
              sourceId: SOURCE_ID,
              transactionId: other.id,
            })
          }

          return yield* db
            .insert(schema.transactionLegs)
            .values(
              yield* prepareMovementLegFixtures(
                (parent === "unrelated_only" ? ["unrelated"] : ["linked", "unrelated"]).map(
                  (name) => ({
                    movementIdentity: { sourceRecordKey: `fee-${name}`, componentKey: "fee" },
                    principalId: PRINCIPAL_ID,
                    sourceId: SOURCE_ID,
                    externalId: `fee-${name}`,
                    transactionId:
                      name === "linked" && parent === "no_transaction" ? null : other.id,
                    feeForTransactionId: name === "linked" ? fixture.saleId : other.id,
                    timestamp: time,
                    assetId: feeAssetId,
                    amount: "0.1",
                    kind: "fee" as const,
                    provenance: "deterministic" as const,
                    originKind: "none" as const,
                  })
                )
              )
            )
            .returning({
              id: schema.transactionLegs.id,
              targetId: schema.transactionLegs.movementCorrectionTargetId,
              feeForTransactionId: schema.transactionLegs.feeForTransactionId,
              transactionId: schema.transactionLegs.transactionId,
            })
        })
      )
      yield* acceptTotal(fixture.acquisition.targetId, "20")
      yield* recompute(1)
      const linked = fees.find((fee) => fee.feeForTransactionId === fixture.saleId)
      const unrelated = fees.find((fee) => fee.feeForTransactionId !== fixture.saleId)
      if (unrelated === undefined) return yield* Effect.die("Missing unrelated fee")
      const detail = yield* readCalculation(fixture.saleId)
      const hasLinkedFee = parent !== "unrelated_only"
      const hasLinkedBlocker = hasLinkedFee
      expect(detail.attention).toBe(hasLinkedBlocker)
      expect(detail.movements).toHaveLength(hasLinkedFee ? 2 : 1)
      if (hasLinkedFee) {
        if (linked === undefined) return yield* Effect.die("Missing linked fee")
        expect(detail.movements.find((movement) => movement.id === linked.id)?.capture?.runId).toBe(
          runId(1)
        )
        if (hasLinkedBlocker && parent !== "transaction_blocker")
          expect(detail.calculation.blockers.map((blocker) => blocker.eventId)).toContain(linked.id)
      }
      if (parent === "transaction_blocker") {
        // The writer withholds both transactions connected by the explicit fee link.
        expect(detail.calculation.blockers.map((blocker) => blocker.eventId)).toContain(
          unrelated.transactionId
        )
        const writer = yield* run(
          Effect.gen(function* () {
            const db = yield* drizzle
            const captures = yield* db
              .select({
                targetId: schema.calculationRunMovementInputs.targetId,
                captured: schema.calculationRunMovementInputs.captured,
              })
              .from(schema.calculationRunMovementInputs)
              .where(eq(schema.calculationRunMovementInputs.runId, runId(1)))
            const allocations = yield* db
              .select({ eventId: schema.calculationRunAllocations.dispositionEventId })
              .from(schema.calculationRunAllocations)
              .where(eq(schema.calculationRunAllocations.runId, runId(1)))
            return {
              captures: captures.map((row) => ({
                ownSale: row.targetId === fixture.disposition.targetId,
                outcome: row.captured.currentOutcome,
                event: row.captured.effective.event?._tag,
              })),
              allocationCount: allocations.length,
            }
          })
        )
        expect(writer.allocationCount).toBe(0)
        expect(writer.captures.find((capture) => capture.ownSale)).toMatchObject({
          outcome: "withheld",
          event: undefined,
        })
        expect(detail.calculation.allocations).toEqual([])
        expect(
          detail.movements.find(
            (movement) => movement.movementCorrectionTargetId === fixture.disposition.targetId
          )?.capture
        ).toMatchObject({ outcome: "withheld", eventId: null })
      } else {
        expectResult(detail.calculation, "20", "10")
      }
      expect(detail.calculation.blockers.map((blocker) => blocker.eventId)).not.toContain(
        unrelated.id
      )
      const filtered = yield* context.runWithLayer({
        layer: TransactionListRepositoryLive,
        effect: Effect.flatMap(TransactionListRepository, (repository) =>
          repository.list({
            principalId: PRINCIPAL_ID,
            jurisdiction: scope.jurisdiction,
            reportingCurrency: EUR,
            sourceIds: [],
            from: null,
            to: null,
            order: "newest",
            attention: true,
            cursor: null,
            limit: 100,
          })
        ),
      })
      expect(filtered.items.some((row) => row.transactionId === fixture.saleId)).toBe(
        hasLinkedBlocker
      )
      expect(filtered.items.every((row) => row.attention)).toBe(true)
      expect(filtered.totalCount).toBe(hasLinkedBlocker ? 2 : 1)
      const stored = yield* run(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({ eventId: schema.calculationRunBlockers.eventId })
            .from(schema.calculationRunBlockers)
            .where(eq(schema.calculationRunBlockers.runId, runId(1)))
        })
      )
      expect(stored.map((blocker) => blocker.eventId)).toContain(
        parent === "transaction_blocker" ? unrelated.transactionId : unrelated.id
      )
    })
  )
}

describe("transaction detail calculation snapshot", () => {
  it.effect(
    "keeps accepted current input separate from the displayed run through replacement and withdrawal",
    () =>
      Effect.gen(function* () {
        const fixture = yield* run(seedCalculation())
        const accepted = yield* acceptTotal(fixture.acquisition.targetId, "20")
        yield* completeReplay(accepted.processingJobId)
        yield* recompute(1)
        const oldStored = yield* storedRun(1)
        const purchase = yield* readCalculation(fixture.purchaseId)
        const sale = yield* readCalculation(fixture.saleId)
        expect(purchase.movements[0]?.capture).toMatchObject({
          runId: runId(1),
          selectedValue: { amount: "20", kind: "user_valuation" },
          acquisitionCostBasis: null,
        })
        expect(sale.movements[0]?.capture).toMatchObject({
          realizedResults: [
            expect.objectContaining({ costBasis: "20", proceeds: "30", gainLoss: "10" }),
          ],
        })
        expectResult(sale.calculation, "20", "10")
        expect(sale.calculation.correctionInputs).toContainEqual(
          expect.objectContaining({
            history: expect.objectContaining({ id: accepted.overrideId }),
            application: "applied",
            resolvedPrice: expect.objectContaining({ totalValue: "20" }),
          })
        )
        expect(sale.calculation.run).toMatchObject({
          id: runId(1),
          status: "complete",
          taxYear: 2026,
          reportingCurrency: "EUR",
        })
        expect(sale.calculation.run?.inputLedgerRevision).toBeTruthy()
        expect(purchase.calculation.correctionInputs).toContainEqual(
          expect.objectContaining({
            history: expect.objectContaining({ id: accepted.overrideId }),
            application: "applied",
            resolvedPrice: expect.objectContaining({ totalValue: "20" }),
          })
        )
        const replacement = yield* acceptTotal(fixture.acquisition.targetId, "30", "replace")
        const pending = yield* readCalculation(fixture.purchaseId)
        expect(pending.calculation.run?.id).toBe(runId(1))
        expect(pending.movementOverrides[0]?.price).toMatchObject({
          active: { id: replacement.overrideId },
          coverage: null,
        })
        expect(
          pending.movementOverrides[0]?.inputs.corrections.find(
            (input) => input.application === "applied"
          )?.resolvedPrice?.totalValue
        ).toBe("30")
        expect(
          pending.calculation.correctionInputs.find(
            (input) => input.history.id === accepted.overrideId
          )?.resolvedPrice?.totalValue
        ).toBe("20")
        expect(
          pending.calculation.correctionInputs.some(
            (input) => input.history.id === replacement.overrideId
          )
        ).toBe(false)
        expectResult((yield* readCalculation(fixture.saleId)).calculation, "20", "10")
        yield* completeReplay(replacement.processingJobId)
        yield* recompute(2)
        expectResult((yield* readCalculation(fixture.saleId)).calculation, "30", "0")
        expect(yield* storedRun(1)).toEqual(oldStored)
        const replaced = yield* readCalculation(fixture.purchaseId)
        expect(replaced.movementOverrides[0]?.price.coverage).toMatchObject({
          runId: runId(2),
          overrideId: replacement.overrideId,
        })
        const withdrawal = yield* changePrice({
          targetId: fixture.acquisition.targetId,
          operation: "withdraw",
        })
        const withdrawn = yield* readCalculation(fixture.purchaseId)
        expect(withdrawn.movementOverrides[0]?.price.active).toBeNull()
        const history = withdrawn.movementOverrides[0]?.context.history ?? []
        expect(history).toHaveLength(3)
        for (const row of history) {
          expect(row.actorUserId).toBe(USER_ID)
          expect(row.reason).toBe("Synthetic price evidence")
          expect(row.recordedAt).toBeInstanceOf(Date)
          expect(Number.isNaN(row.recordedAt.getTime())).toBe(false)
        }
        expect(history.find((row) => row.id === accepted.overrideId)).toMatchObject({
          operation: "create",
          supersedesOverrideId: null,
        })
        expect(history.find((row) => row.id === replacement.overrideId)).toMatchObject({
          operation: "replace",
          supersedesOverrideId: accepted.overrideId,
        })
        expect(history.find((row) => row.id === withdrawal.overrideId)).toMatchObject({
          operation: "withdraw",
          supersedesOverrideId: replacement.overrideId,
          input: null,
        })
        expect(withdrawn.movementOverrides[0]?.context.history.map((row) => row.id)).toEqual(
          expect.arrayContaining([
            accepted.overrideId,
            replacement.overrideId,
            withdrawal.overrideId,
          ])
        )
        expect(
          withdrawn.calculation.correctionInputs.find(
            (input) => input.history.id === replacement.overrideId
          )?.application
        ).toBe("applied")
        yield* completeReplay(withdrawal.processingJobId)
        yield* recompute(3)
        const final = yield* readCalculation(fixture.purchaseId)
        expect(final.calculation.run?.status).toBe("partial")
        expect(final.calculation.run?.id).toBe(runId(3))
        expect(final.calculation.allocations).toHaveLength(1)
        expect(final.calculation.allocations[0]).toMatchObject({
          costBasis: null,
          proceeds: null,
          gainLoss: null,
        })
        expect(moneyEquals(final.calculation.allocations[0]?.quantity, "2")).toBe(true)
        expect(final.movementOverrides[0]?.price.coverage).toMatchObject({
          runId: runId(3),
          overrideId: withdrawal.overrideId,
          status: "partial",
        })
        expect(
          final.calculation.correctionInputs.find(
            (input) => input.history.id === withdrawal.overrideId
          )
        ).toMatchObject({ application: "inactive", streamState: "withdrawn", resolvedPrice: null })
        expect(yield* storedRun(1)).toEqual(oldStored)
      })
  )

  for (const precision of [
    { quantity: "3", total: "1", gain: "29" },
    { quantity: "2", total: "0", gain: "30" },
  ])
    it.effect(`preserves exact total ${precision.total} for ${precision.quantity} tokens`, () =>
      Effect.gen(function* () {
        const fixture = yield* run(seedCalculation({ quantity: precision.quantity }))
        yield* acceptTotal(fixture.acquisition.targetId, precision.total)
        yield* recompute(1)
        const purchase = yield* readCalculation(fixture.purchaseId)
        const sale = yield* readCalculation(fixture.saleId)
        expectResult(sale.calculation, precision.total, precision.gain)
        const captured = purchase.calculation.correctionInputs[0]
        expect(captured?.resolvedPrice?.totalValue).toBe(precision.total)
        expect(captured?.history.input).toMatchObject({
          input: { _tag: "total_value", amount: precision.total, currency: "EUR" },
        })
        if (precision.quantity === "3")
          expect(captured?.resolvedPrice?.unitPrice).toEqual({
            amount: "0.333333333333333333",
            rounded: true,
          })
      })
    )

  it.effect("reports no active run and missing valuation without manufacturing zero money", () =>
    Effect.gen(function* () {
      const fixture = yield* run(seedCalculation())
      const before = yield* readCalculation(fixture.saleId)
      expect(before.calculation.run).toBeNull()
      expect(before.calculation.state).toBe("partial")
      expect(before.calculation.allocations).toEqual([])
      yield* recompute(1)
      const after = yield* readCalculation(fixture.purchaseId)
      expect(after.calculation.run?.status).toBe("partial")
      expect(after.calculation.blockers).toContainEqual(
        expect.objectContaining({ code: "missing_valuation", eventId: fixture.acquisition.id })
      )
      expect(after.calculation.allocations).toHaveLength(1)
      expect(
        after.calculation.allocations.every(
          (allocation) => allocation.costBasis === null && allocation.gainLoss === null
        )
      ).toBe(true)
      expect(after.calculation.correctionInputs).toEqual([])
    })
  )

  it.effect(
    "retains captured result events through regenerated legs with the same stable target",
    () =>
      Effect.gen(function* () {
        const fixture = yield* run(seedCalculation())
        yield* acceptTotal(fixture.acquisition.targetId, "20")
        yield* recompute(1)
        const old = yield* storedRun(1)
        // Replay removes a derived row; the production writer records its stable target again.
        yield* run(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .delete(schema.transactionLegs)
              .where(eq(schema.transactionLegs.id, fixture.disposition.id))
          })
        )
        const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2026-03-01T00:00:00Z"))
        yield* context.runWithLayer({
          layer: SourceNormalizationRepositoryLive,
          effect: Effect.flatMap(SourceNormalizationRepository, (repository) =>
            repository.persistNormalizedArtifacts({
              transaction: {
                sourceId: SOURCE_ID,
                principalId: PRINCIPAL_ID,
                sourceRawRecordId: null,
                externalId: "synthetic-sale",
                externalGroupId: null,
                timestamp,
                transactionType: "sell_fiat",
                providerTransactionType: "sell",
                providerStatus: "completed",
                providerResourcePath: null,
                providerDescription: null,
                providerCreatedAt: timestamp,
                providerUpdatedAt: timestamp,
                metadata: {},
                providerFiatAmount: "30",
                providerFiatCurrency: "EUR",
              },
              venueContext: {
                venueType: "cex",
                cexAccountId: fixture.cexAccountId,
                externalAccountId: null,
                externalOrderId: null,
                externalFillId: null,
                side: "sell",
                instrument: "BTC-EUR",
                fillPrice: null,
                commissionAmount: null,
                commissionCurrency: null,
                metadata: {},
              },
              providerTransfers: [],
              canonicalTransfers: [],
              providerAssetRowIds: [],
              transactionReview: null,
              resolvedTransactionType: {
                providerTransactionType: "sell",
                transactionType: "sell_fiat",
                inventoryEffect: "disposal",
                taxTreatment: "taxable_by_default",
                resolutionStrategy: "static",
                pairedRecordRequired: false,
                mappingStatus: "approved",
              },
              legs: [
                {
                  movementIdentity: {
                    _tag: "identified",
                    sourceRecordKey: "synthetic-sale",
                    componentKey: "principal",
                  },
                  sourceId: SOURCE_ID,
                  principalId: PRINCIPAL_ID,
                  sourceRawRecordId: null,
                  externalId: "synthetic-sale-leg",
                  txHash: null,
                  timestamp,
                  addressId: null,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "2",
                  kind: "disposal",
                  provenance: "deterministic",
                  derivationRule: null,
                  metadata: {},
                  transactionId: fixture.saleId,
                  originKind: "none",
                  providerTransferId: null,
                  sourceTransferId: null,
                  fiatAmount: null,
                  fiatCurrency: null,
                  feeForTransactionId: null,
                },
              ],
            })
          ),
        })
        const replayed = yield* readCalculation(fixture.saleId)
        const newId = replayed.movements[0]?.id
        expect(newId).toBeDefined()
        expect(newId).not.toBe(fixture.disposition.id)
        expect(replayed.movements[0]?.movementCorrectionTargetId).toBe(fixture.disposition.targetId)
        expect(replayed.calculation.run?.id).toBe(runId(1))
        expect(replayed.calculation.state).toBe("complete")
        expectResult(replayed.calculation, "20", "10")
        expect(replayed.movements[0]?.capture).toMatchObject({
          runId: runId(1),
          eventId: fixture.disposition.id,
          realizedResults: [expect.objectContaining({ proceeds: "30", gainLoss: "10" })],
        })
        expect(yield* storedRun(1)).toEqual(old)
        yield* recompute(2)
        const recomputed = yield* readCalculation(fixture.saleId)
        expectResult(recomputed.calculation, "20", "10")
        expect(recomputed.calculation.allocations[0]?.dispositionEventId).toBe(newId)
      })
  )

  it.effect(
    "keeps one snapshot when correction acceptance and run activation race after initial detail lookup",
    () =>
      Effect.gen(function* () {
        const fixture = yield* run(seedCalculation())
        yield* acceptTotal(fixture.acquisition.targetId, "20")
        yield* recompute(1)
        const previous = yield* readCalculation(fixture.purchaseId)
        const services = yield* Effect.context<never>()
        detailSnapshot.afterInitialRead = () =>
          Effect.runPromiseWith(services)(
            Effect.gen(function* () {
              yield* acceptTotal(fixture.acquisition.targetId, "30", "replace")
              yield* recompute(2)
            })
          )
        const racing = yield* readCalculation(fixture.purchaseId)
        expect(racing.calculation.run).toEqual(previous.calculation.run)
        expect(racing.calculation.allocations).toEqual(previous.calculation.allocations)
        expect(racing.calculation.run?.id).toBe(runId(1))
        expect(
          racing.movementOverrides[0]?.inputs.corrections.find(
            (input) => input.application === "applied"
          )?.resolvedPrice?.totalValue
        ).toBe("20")
        expect(
          racing.calculation.correctionInputs
            .filter((input) => input.application === "applied")
            .map((input) => input.resolvedPrice?.totalValue)
        ).toEqual(["20"])
        const next = yield* readCalculation(fixture.purchaseId)
        expect(next.calculation.run?.id).toBe(runId(2))
        expect(next.calculation.run?.inputLedgerRevision).not.toBe(
          previous.calculation.run?.inputLedgerRevision
        )
        expect(
          next.movementOverrides[0]?.inputs.corrections.find(
            (input) => input.application === "applied"
          )?.resolvedPrice?.totalValue
        ).toBe("30")
        expectResult((yield* readCalculation(fixture.saleId)).calculation, "30", "0")
      })
  )
})

it.effect(
  "returns the independent current asset projection through the movement's recorded provider link",
  () =>
    Effect.gen(function* () {
      const fixture = yield* run(seedCalculation())
      const providerId = yield* run(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [provider] = yield* db
            .insert(schema.providerAssets)
            .values({
              provider: "synthetic",
              providerAssetId: "inspector-btc",
              currencyCode: "BTC",
              name: "Synthetic Bitcoin",
              exponent: 8,
              providerType: "crypto",
              rawProviderPayload: {},
              evidenceRevision: 1,
              discoveredAt: time,
              retrievedAt: time,
            })
            .returning({ id: schema.providerAssets.id })
          if (provider === undefined) return yield* Effect.die("Missing provider asset")
          yield* db
            .insert(schema.providerAssetSourceUses)
            .values({ providerAssetRowId: provider.id, sourceId: SOURCE_ID })
          yield* db.insert(schema.providerAssetMappings).values({
            providerAssetRowId: provider.id,
            mappingKind: "asset",
            canonicalAssetId: TEST_BTC_ASSET_ID,
            mappingStatus: "approved",
          })
          yield* db
            .update(schema.transactionLegs)
            .set({ providerAssetRowId: provider.id })
            .where(eq(schema.transactionLegs.id, fixture.acquisition.id))
          return provider.id
        })
      )
      const detail = yield* readCalculation(fixture.purchaseId)
      expect(detail.calculation.run).toBeNull()
      expect(detail.assetOverrides).toHaveLength(1)
      expect(detail.assetOverrides[0]).toMatchObject({
        movementId: fixture.acquisition.id,
        projection: {
          target: { _tag: "provider_asset", providerAssetRowId: providerId },
          activeIdentityOverride: null,
          activeInclusionOverride: null,
          history: [],
        },
      })
    })
)

for (const valuation of [
  { value: "20", unit: "10" },
  { value: null, unit: null },
]) {
  it.effect(
    `returns stored acquisition lot facts with ${valuation.value === null ? "unknown" : "known"} basis`,
    () =>
      Effect.gen(function* () {
        const fixture = yield* run(seedCalculation({ systemPurchaseValue: valuation.value }))
        yield* run(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .delete(schema.transactionLegs)
              .where(eq(schema.transactionLegs.id, fixture.disposition.id))
          })
        )
        yield* recompute(1)
        const detail = yield* readCalculation(fixture.purchaseId)
        expect(detail.calculation.state).toBe(valuation.value === null ? "partial" : "complete")
        expect(detail.calculation.monetaryStatus).toBe(
          valuation.value === null ? "unavailable" : "available"
        )
        expect(detail.calculation.derivedLots).toHaveLength(1)
        expect(detail.calculation.derivedLots[0]).toMatchObject({
          acquisitionEventId: fixture.acquisition.id,
          assetId: TEST_BTC_ASSET_ID,
          acquiredAt: fixture.timestamp,
        })
        expect(moneyEquals(detail.calculation.derivedLots[0]?.remainingQuantity, "2")).toBe(true)
        if (valuation.unit === null)
          expect(detail.calculation.derivedLots[0]?.costBasisPerUnit).toBeNull()
        else
          expect(
            moneyEquals(detail.calculation.derivedLots[0]?.costBasisPerUnit, valuation.unit)
          ).toBe(true)
        expect(detail.calculation.allocations).toEqual([])
        expect(detail.calculation.income).toEqual([])
      })
  )
}

it.effect("retains known allocations alongside a stored inventory shortage", () =>
  Effect.gen(function* () {
    const fixture = yield* run(seedCalculation())
    yield* acceptTotal(fixture.acquisition.targetId, "20")
    yield* run(
      Effect.gen(function* () {
        const db = yield* drizzle
        yield* db
          .update(schema.transactionLegs)
          .set({ amount: "3" })
          .where(eq(schema.transactionLegs.id, fixture.disposition.id))
      })
    )
    yield* recompute(1)
    const detail = yield* readCalculation(fixture.saleId)
    expect(detail.calculation.run?.status).toBe("partial")
    expect(detail.calculation.state).toBe("partial")
    expect(detail.calculation.monetaryStatus).toBe("partial")
    expect(detail.calculation.allocations).toHaveLength(1)
    expect(moneyEquals(detail.calculation.allocations[0]?.quantity, "2")).toBe(true)
    expect(moneyEquals(detail.calculation.allocations[0]?.costBasis, "20")).toBe(true)
    expect(moneyEquals(detail.calculation.allocations[0]?.proceeds, "20")).toBe(true)
    expect(moneyEquals(detail.calculation.allocations[0]?.gainLoss, "0")).toBe(true)
    expect(detail.calculation.blockers).toContainEqual(
      expect.objectContaining({
        eventId: fixture.disposition.id,
        code: "inventory_shortage",
        missingQuantity: "1",
      })
    )
  })
)

it.effect(
  "marks an approved processed custody transfer as having no applicable monetary result",
  () =>
    Effect.gen(function* () {
      const fixture = yield* run(seedCalculation({ systemPurchaseValue: "20" }))
      const reconciliationId = yield* run(
        Effect.gen(function* () {
          const db = yield* drizzle
          const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2026-03-01T00:00:00Z"))
          const [address] = yield* db
            .insert(schema.addresses)
            .values({
              principalId: PRINCIPAL_ID,
              address: "synthetic-inspector-custody",
              name: "Custody destination",
              type: "bitcoin",
            })
            .returning({ id: schema.addresses.id })
          if (address === undefined) return yield* Effect.die("Missing custody address")
          const [source] = yield* db
            .insert(schema.sources)
            .values({
              principalId: PRINCIPAL_ID,
              addressId: address.id,
              sourceableType: "onchain",
              name: "Custody destination",
            })
            .returning({ id: schema.sources.id })
          if (source === undefined) return yield* Effect.die("Missing custody source")
          const [representation] = yield* db
            .select({
              blockchainId: schema.assetRepresentations.blockchainId,
              representationType: schema.assetRepresentations.type,
              contractAddress: schema.assetRepresentations.contractAddress,
              mintAddress: schema.assetRepresentations.mintAddress,
            })
            .from(schema.assetRepresentations)
            .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
          if (representation === undefined)
            return yield* Effect.die("Missing custody representation")
          const [canonicalUse, providerUse] = yield* db
            .insert(schema.sourceRepresentationUses)
            .values([
              { sourceId: SOURCE_ID, ...representation },
              { sourceId: source.id, ...representation },
            ])
            .returning({ id: schema.sourceRepresentationUses.id })
          if (canonicalUse === undefined || providerUse === undefined)
            return yield* Effect.die("Missing custody uses")
          const [transaction] = yield* db
            .insert(schema.transactions)
            .values({
              sourceId: source.id,
              principalId: PRINCIPAL_ID,
              externalId: "custody-inbound",
              timestamp,
              transactionType: "internal_transfer",
            })
            .returning({ id: schema.transactions.id })
          if (transaction === undefined) return yield* Effect.die("Missing custody transaction")
          const [provider] = yield* db
            .insert(schema.providerTransfers)
            .values({
              sourceId: source.id,
              transactionId: transaction.id,
              externalId: "custody-provider",
              timestamp,
              direction: "inbound",
              processingMode: "accounting_only",
              fromAccountRef: "origin",
              toAccountRef: "destination",
              sourceRepresentationUseId: providerUse.id,
              amount: "2",
            })
            .returning({ id: schema.providerTransfers.id })
          const [canonical] = yield* db
            .insert(schema.transfers)
            .values({
              sourceId: SOURCE_ID,
              principalId: PRINCIPAL_ID,
              externalId: "custody-canonical",
              timestamp,
              type: "cex",
              fromAccountRef: "origin",
              toAccountRef: "destination",
              assetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
              sourceRepresentationUseId: canonicalUse.id,
              amount: "2",
            })
            .returning({ id: schema.transfers.id })
          if (provider === undefined || canonical === undefined)
            return yield* Effect.die("Missing custody transfers")
          yield* db.insert(schema.inventoryMovements).values({
            principalId: PRINCIPAL_ID,
            sourceId: source.id,
            transactionId: transaction.id,
            providerTransferId: provider.id,
            assetId: TEST_BTC_ASSET_ID,
            timestamp,
            direction: "inbound",
            purpose: "principal",
            taxTreatment: "non_taxable",
            reconciliationStatus: "matched",
            amount: "2",
          })
          yield* db.insert(schema.transactionLegs).values(
            yield* prepareMovementLegFixtures([
              {
                movementIdentity: { sourceRecordKey: "custody-inbound", componentKey: "principal" },
                sourceId: source.id,
                principalId: PRINCIPAL_ID,
                externalId: "custody-inbound-leg",
                transactionId: transaction.id,
                timestamp,
                assetId: TEST_BTC_ASSET_ID,
                amount: "2",
                kind: "acquisition",
                provenance: "deterministic",
                originKind: "provider_transfer",
                providerTransferId: provider.id,
                sourceRepresentationUseId: providerUse.id,
              },
            ])
          )
          yield* db
            .update(schema.transactions)
            .set({
              transactionType: "internal_transfer",
              providerFiatAmount: null,
              providerFiatCurrency: null,
            })
            .where(eq(schema.transactions.id, fixture.saleId))
          yield* db
            .update(schema.transactionLegs)
            .set({
              originKind: "canonical_transfer",
              sourceTransferId: canonical.id,
              sourceRepresentationUseId: canonicalUse.id,
            })
            .where(eq(schema.transactionLegs.id, fixture.disposition.id))
          const [reconciliation] = yield* db
            .insert(schema.transferReconciliations)
            .values({
              principalId: PRINCIPAL_ID,
              providerTransferId: provider.id,
              canonicalTransferId: canonical.id,
              canonicalTransactionId: fixture.saleId,
              status: "approved",
              matchReason: "Synthetic owned custody",
              confidence: "1",
              deterministic: true,
            })
            .returning({ id: schema.transferReconciliations.id })
          if (reconciliation === undefined)
            return yield* Effect.die("Missing custody reconciliation")
          return reconciliation.id
        })
      )
      yield* recompute(1)
      const detail = yield* readCalculation(fixture.saleId)
      expect(detail.calculation.run?.status).toBe("complete")
      expect(detail.calculation.state).toBe("complete")
      expect(detail.calculation.monetaryStatus).toBe("not_applicable")
      expect(detail.calculation.processedEventIds).toContain(reconciliationId)
      expect(detail.calculation.allocations).toEqual([])
      expect(detail.calculation.income).toEqual([])
      expect(detail.calculation.derivedLots).toEqual([])
      expect(detail.calculation.blockers).toEqual([])
    })
)
