import { prepareMovementLegFixtures } from "../support/movement-leg-fixtures.ts"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { JurisdictionCode, TaxYear } from "@my/core/accounting"
import { CurrencyCode } from "@my/core/currency"
import { PrincipalId } from "@my/core/ownership"
import { asc, eq } from "drizzle-orm"
import * as BigDecimal from "effect/BigDecimal"
import * as DateTime from "effect/DateTime"
import * as Deferred from "effect/Deferred"
import * as Fiber from "effect/Fiber"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { CalculationRunRepositoryLive } from "../../src/layers/CalculationRunRepositoryLive.ts"
import { CalculationRunServiceLive } from "../../src/layers/CalculationRunServiceLive.ts"
import { FactualLedgerRepositoryLive } from "../../src/layers/FactualLedgerRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import { CalculationRunId } from "../../src/services/CalculationRunRepository.ts"
import { CalculationRunService } from "../../src/services/CalculationRunService.ts"
import { FactualLedgerRepository } from "../../src/services/FactualLedgerRepository.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_BTC_REPRESENTATION_ID,
  TEST_EUR_REPRESENTATION_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const FIRST_RUN_ID = CalculationRunId.make("00000000-0000-4000-8000-000000000901")
const SECOND_RUN_ID = CalculationRunId.make("00000000-0000-4000-8000-000000000902")
const PRINCIPAL_ID = PrincipalId.make("00000000-0000-4000-8000-000000000183")
const SOURCE_ID = "00000000-0000-4000-8000-000000000281"
const PROVIDER_ASSET_ROW_ID = "00000000-0000-4000-8000-000000000701"
const EUR = CurrencyCode.make("EUR")

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_calculation_run_service",
})
const runPg = context.runPg

const CalculationRunServiceTestLive = CalculationRunServiceLive.pipe(
  Layer.provide(Layer.merge(CalculationRunRepositoryLive, FactualLedgerRepositoryLive))
)

const runCalculationService = <A, E>(effect: Effect.Effect<A, E, CalculationRunService>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: CalculationRunServiceTestLive }))

const runFactualLedger = <A, E>(effect: Effect.Effect<A, E, FactualLedgerRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: FactualLedgerRepositoryLive }))

const loadLedger = () =>
  runFactualLedger(
    Effect.flatMap(FactualLedgerRepository, (repository) =>
      repository.load({ principalId: PRINCIPAL_ID, reportingCurrency: EUR })
    )
  )

const recompute = (id: CalculationRunId) =>
  runCalculationService(
    Effect.flatMap(CalculationRunService, (service) =>
      service.recompute({
        id,
        principalId: PRINCIPAL_ID,
        jurisdiction: JurisdictionCode.make("DE"),
        taxYear: TaxYear.make(2025),
        reportingCurrency: EUR,
        accountingChoices: [],
      })
    )
  )

const factualContentHash = (inputLedgerRevision: string): string | undefined =>
  inputLedgerRevision.split(":").at(-1)

const storedDecimalEquals = (value: string | null | undefined, expected: string): boolean =>
  value !== null &&
  value !== undefined &&
  BigDecimal.equals(BigDecimal.fromStringUnsafe(value), BigDecimal.fromStringUnsafe(expected))

const seedCorrectionMovement = Effect.gen(function* () {
  const db = yield* drizzle
  const [transaction] = yield* db
    .insert(schema.transactions)
    .values({
      sourceId: SOURCE_ID,
      principalId: PRINCIPAL_ID,
      externalId: "synthetic-corrected-purchase",
      timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T00:00:00Z")),
      transactionType: "buy_fiat",
      providerFiatAmount: "10",
      providerFiatCurrency: "EUR",
    })
    .returning({ id: schema.transactions.id })
  const [principal] = yield* db
    .select({ userId: schema.principals.userId })
    .from(schema.principals)
    .where(eq(schema.principals.id, PRINCIPAL_ID))
  if (transaction === undefined || principal?.userId === null || principal?.userId === undefined)
    return yield* Effect.die("Missing synthetic correction owner")
  const [leg] = yield* db
    .insert(schema.transactionLegs)
    .values(
      yield* prepareMovementLegFixtures([
        {
          movementIdentity: {
            sourceRecordKey: "synthetic-corrected-purchase",
            componentKey: "principal",
          },
          sourceId: SOURCE_ID,
          principalId: PRINCIPAL_ID,
          externalId: "synthetic-corrected-leg",
          timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T00:00:00Z")),
          assetId: TEST_BTC_ASSET_ID,
          amount: "3",
          kind: "acquisition",
          provenance: "deterministic",
          originKind: "none",
          transactionId: transaction.id,
        },
      ])
    )
    .returning({
      id: schema.transactionLegs.id,
      targetId: schema.transactionLegs.movementCorrectionTargetId,
    })
  if (leg === undefined) return yield* Effect.die("Missing synthetic correction movement")
  const draft = {
    principalId: PRINCIPAL_ID,
    sourceId: SOURCE_ID,
    targetId: leg.targetId,
    kind: "price",
    operation: "create",
    inspectedSystemRevision: "synthetic-revision",
    inspectedSourceRecordKey: "synthetic-corrected-purchase",
    inspectedComponentKey: "principal",
    inspectedQuantity: "3",
    inspectedEconomicAssetId: TEST_BTC_ASSET_ID,
    inspectedDirection: "inbound",
    inspectedStructure: "ownership_change",
    inspectedOccurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T00:00:00Z")),
    inspectedLegKind: "acquisition",
    inspectedFiatAmount: null,
    inspectedFiatCurrency: null,
    inspectedValuationEvidence: {
      reportingCurrency: EUR,
      facts: [
        {
          _tag: "observed_consideration",
          eventId: leg.id,
          amount: { amount: "10", currency: EUR },
          evidenceReference: `transaction:${transaction.id}`,
        },
      ],
    },
    inspectedTransactionType: "buy_fiat",
    inspectedProviderTransactionType: null,
    inspectedDerivationRule: null,
    inspectedFeeForSourceRecordKey: null,
    priceInput: { _tag: "total_value", amount: "0.0000000000000000000000001", currency: EUR },
    classificationInput: null,
    actorUserId: principal.userId,
    reason: "Synthetic correction evidence",
    supersedesOverrideId: null,
  } satisfies typeof schema.principalTransactionOverrides.$inferInsert
  const [history] = yield* db
    .insert(schema.principalTransactionOverrides)
    .values(draft)
    .returning({ id: schema.principalTransactionOverrides.id })
  if (history === undefined) return yield* Effect.die("Missing synthetic correction history")
  return {
    legId: leg.id,
    targetId: leg.targetId,
    transactionId: transaction.id,
    draft,
    historyId: history.id,
  }
})

const readCorrectionInputs = (runId: CalculationRunId) =>
  runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      return yield* db
        .select({ captured: schema.calculationRunCorrectionInputs.captured })
        .from(schema.calculationRunCorrectionInputs)
        .where(eq(schema.calculationRunCorrectionInputs.runId, runId))
        .orderBy(asc(schema.calculationRunCorrectionInputs.overrideId))
    })
  )

await Effect.runPromise(context.recreateTestDatabase())

beforeEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* context.recreateTestDatabase()
      const fixture = yield* Effect.promise(() =>
        runPg(seedSyncEngineRepositoryFixture({ principalId: PRINCIPAL_ID, sourceId: SOURCE_ID }))
      )
      yield* Effect.promise(() => runPg(seedSyncEngineAssets(fixture)))
    })
  )
)

describe("CalculationRunServiceLive", () => {
  it.effect("persists corrected and uncorrected captures during deliberate recomputation", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => runPg(seedCorrectionMovement))
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [transaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: SOURCE_ID,
                principalId: PRINCIPAL_ID,
                externalId: "synthetic-uncorrected-purchase",
                timestamp: new Date("2025-02-02T00:00:00Z"),
                transactionType: "buy_fiat",
                providerFiatAmount: "20",
                providerFiatCurrency: "EUR",
              })
              .returning({ id: schema.transactions.id })
            if (transaction === undefined) return yield* Effect.die("Missing synthetic transaction")
            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures([
                {
                  movementIdentity: {
                    sourceRecordKey: "synthetic-uncorrected-purchase",
                    componentKey: "principal",
                  },
                  sourceId: SOURCE_ID,
                  principalId: PRINCIPAL_ID,
                  externalId: "synthetic-uncorrected-leg",
                  timestamp: new Date("2025-02-02T00:00:00Z"),
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "10",
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
      yield* Effect.promise(() => recompute(FIRST_RUN_ID))
      const captures = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                runId: schema.calculationRunMovementInputs.runId,
                principalId: schema.calculationRunMovementInputs.principalId,
                targetId: schema.calculationRunMovementInputs.targetId,
                captured: schema.calculationRunMovementInputs.captured,
                valuation: schema.calculationRunMovementInputs.valuation,
              })
              .from(schema.calculationRunMovementInputs)
              .where(eq(schema.calculationRunMovementInputs.runId, FIRST_RUN_ID))
          })
        )
      )
      expect(captures).toHaveLength(2)
      expect(
        captures.every(
          (capture) => capture.runId === FIRST_RUN_ID && capture.principalId === PRINCIPAL_ID
        )
      ).toBe(true)
      const corrected = captures.find((capture) => capture.targetId === fixture.targetId)
      expect(corrected?.valuation).toEqual({
        _tag: "selected",
        kind: "user_valuation",
        total: { amount: "1e-25", currency: "EUR" },
      })
      const uncorrected = captures.find((capture) => capture.targetId !== fixture.targetId)
      expect(storedDecimalEquals(uncorrected?.captured.current?.quantity, "10")).toBe(true)
      expect(uncorrected?.valuation).toEqual({
        _tag: "selected",
        kind: "observed_consideration",
        total: { amount: "20", currency: "EUR" },
      })
      expect(uncorrected?.captured).not.toHaveProperty("history")
      expect(uncorrected?.captured).not.toHaveProperty("corrections")
      expect(yield* Effect.promise(() => readCorrectionInputs(FIRST_RUN_ID))).toHaveLength(1)
    })
  )

  it.effect("records explicit empty sync capture for a new accounting snapshot", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => recompute(FIRST_RUN_ID))
      const stored = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const markers = yield* db
              .select({ runId: schema.calculationRunSyncCaptures.runId })
              .from(schema.calculationRunSyncCaptures)
              .where(eq(schema.calculationRunSyncCaptures.runId, FIRST_RUN_ID))
            const links = yield* db
              .select({ requestId: schema.calculationRunSyncRequests.requestId })
              .from(schema.calculationRunSyncRequests)
              .where(eq(schema.calculationRunSyncRequests.runId, FIRST_RUN_ID))
            return { markers, links }
          })
        )
      )
      expect(stored).toEqual({ markers: [{ runId: FIRST_RUN_ID }], links: [] })
    })
  )

  it.effect("retains post-cutoff replace and withdrawal records in a relevant audited stream", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => runPg(seedCorrectionMovement))
      const laterTime = DateTime.toDateUtc(DateTime.makeUnsafe("2026-03-01T00:00:00Z"))
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.transactionLegs)
              .set({ timestamp: laterTime })
              .where(eq(schema.transactionLegs.id, fixture.legId))
            yield* db
              .update(schema.transactions)
              .set({ timestamp: laterTime })
              .where(eq(schema.transactions.id, fixture.transactionId))
          })
        )
      )
      const first = yield* Effect.promise(() => recompute(FIRST_RUN_ID))
      const replacement = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [record] = yield* db
              .insert(schema.principalTransactionOverrides)
              .values({
                ...fixture.draft,
                operation: "replace",
                supersedesOverrideId: fixture.historyId,
                inspectedOccurredAt: laterTime,
              })
              .returning({ id: schema.principalTransactionOverrides.id })
            if (record === undefined) return yield* Effect.die("Missing replacement")
            return record
          })
        )
      )
      const second = yield* Effect.promise(() => recompute(SECOND_RUN_ID))
      const replaced = yield* Effect.promise(() => readCorrectionInputs(SECOND_RUN_ID))
      expect(replaced).toHaveLength(2)
      expect(
        replaced.find(({ captured }) => captured.history.id === replacement.id)?.captured
      ).toMatchObject({
        currentOutcome: "outside_period",
        streamState: "active",
        history: { supersedesOverrideId: fixture.historyId },
      })
      const thirdId = CalculationRunId.make("00000000-0000-4000-8000-000000000903")
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.principalTransactionOverrides).values({
              ...fixture.draft,
              operation: "withdraw",
              supersedesOverrideId: replacement.id,
              inspectedOccurredAt: laterTime,
              priceInput: null,
            })
          })
        )
      )
      const third = yield* Effect.promise(() => recompute(thirdId))
      const withdrawn = yield* Effect.promise(() => readCorrectionInputs(thirdId))
      expect(withdrawn).toHaveLength(3)
      expect(
        withdrawn.filter(({ captured }) => captured.streamState === "superseded")
      ).toHaveLength(2)
      expect(
        withdrawn.find(({ captured }) => captured.streamState === "withdrawn")?.captured.history
          .supersedesOverrideId
      ).toBe(replacement.id)
      expect(factualContentHash(second.inputLedgerRevision)).not.toBe(
        factualContentHash(first.inputLedgerRevision)
      )
      expect(factualContentHash(third.inputLedgerRevision)).not.toBe(
        factualContentHash(second.inputLedgerRevision)
      )
      expect(yield* Effect.promise(() => readCorrectionInputs(SECOND_RUN_ID))).toEqual(replaced)
    })
  )

  for (const custodyCase of [
    "included",
    "outside_period",
    "technical_withholding",
    "excluded",
    "invalid_quantity",
    "asset_mismatch",
    "whole_transaction_withholding",
  ] as const) {
    it.effect(
      `captures selected custody context for ${custodyCase} through both exact origin links`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* Effect.promise(() => runPg(seedCorrectionMovement))
          const classification = yield* Effect.promise(() =>
            runPg(
              Effect.gen(function* () {
                const db = yield* drizzle
                const [record] = yield* db
                  .insert(schema.principalTransactionOverrides)
                  .values({
                    ...fixture.draft,
                    kind: "classification",
                    priceInput: null,
                    classificationInput: { _tag: "inbound", cause: "purchase" },
                  })
                  .returning({ id: schema.principalTransactionOverrides.id })
                if (record === undefined)
                  return yield* Effect.die("Missing synthetic custody classification")
                return record
              })
            )
          )
          yield* Effect.promise(() => recompute(FIRST_RUN_ID))
          const before = yield* Effect.promise(() => readCorrectionInputs(FIRST_RUN_ID))
          const reconciliationId = "00000000-0000-4000-8000-000000000987"
          const selected = yield* Effect.promise(() =>
            runPg(
              Effect.gen(function* () {
                const db = yield* drizzle
                const otherSourceId = "00000000-0000-4000-8000-000000000988"
                const canonicalUseId = "00000000-0000-4000-8000-000000000989"
                const providerUseId = "00000000-0000-4000-8000-000000000990"
                const [address] = yield* db
                  .insert(schema.addresses)
                  .values({
                    principalId: PRINCIPAL_ID,
                    address: "synthetic-custody-address",
                    name: "Synthetic custody source",
                    type: "bitcoin",
                  })
                  .returning({ id: schema.addresses.id })
                if (address === undefined) return yield* Effect.die("Missing synthetic address")
                yield* db.insert(schema.sources).values({
                  id: otherSourceId,
                  principalId: PRINCIPAL_ID,
                  name: "Synthetic custody source",
                  sourceableType: "onchain",
                  addressId: address.id,
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
                if (representation === undefined)
                  return yield* Effect.die("Missing synthetic representation")
                yield* db.insert(schema.sourceRepresentationUses).values([
                  { id: canonicalUseId, sourceId: SOURCE_ID, ...representation },
                  { id: providerUseId, sourceId: otherSourceId, ...representation },
                ])
                const [transaction] = yield* db
                  .insert(schema.transactions)
                  .values({
                    sourceId: otherSourceId,
                    principalId: PRINCIPAL_ID,
                    externalId: "synthetic-custody-provider",
                    timestamp: fixture.draft.inspectedOccurredAt,
                    transactionType: "internal_transfer",
                  })
                  .returning({ id: schema.transactions.id })
                if (transaction === undefined)
                  return yield* Effect.die("Missing synthetic custody transaction")
                const [provider] = yield* db
                  .insert(schema.providerTransfers)
                  .values({
                    sourceId: otherSourceId,
                    transactionId: transaction.id,
                    externalId: "synthetic-custody-provider-transfer",
                    timestamp: fixture.draft.inspectedOccurredAt,
                    direction: "inbound",
                    processingMode: "accounting_only",
                    fromAccountRef: "synthetic-origin",
                    toAccountRef: "synthetic-destination",
                    sourceRepresentationUseId: providerUseId,
                    amount: "3",
                  })
                  .returning({ id: schema.providerTransfers.id })
                const [canonical] = yield* db
                  .insert(schema.transfers)
                  .values({
                    sourceId: SOURCE_ID,
                    principalId: PRINCIPAL_ID,
                    externalId: "synthetic-custody-canonical-transfer",
                    timestamp: fixture.draft.inspectedOccurredAt,
                    type: "cex",
                    fromAccountRef: "synthetic-origin",
                    toAccountRef: "synthetic-destination",
                    assetId: TEST_BTC_ASSET_ID,
                    assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
                    sourceRepresentationUseId: canonicalUseId,
                    amount: "3",
                  })
                  .returning({ id: schema.transfers.id })
                if (provider === undefined || canonical === undefined)
                  return yield* Effect.die("Missing synthetic custody transfers")
                yield* db.insert(schema.inventoryMovements).values({
                  principalId: PRINCIPAL_ID,
                  sourceId: otherSourceId,
                  transactionId: transaction.id,
                  providerTransferId: provider.id,
                  assetId: TEST_BTC_ASSET_ID,
                  timestamp: fixture.draft.inspectedOccurredAt,
                  direction: "inbound",
                  purpose: "principal",
                  taxTreatment: "non_taxable",
                  reconciliationStatus: "matched",
                  amount: "3",
                })
                const laterProviderTime = DateTime.toDateUtc(
                  DateTime.makeUnsafe(
                    custodyCase === "included" ? "2026-01-01T00:00:00Z" : "2025-02-01T00:00:00Z"
                  )
                )
                const [providerLeg] = yield* db
                  .insert(schema.transactionLegs)
                  .values(
                    yield* prepareMovementLegFixtures([
                      {
                        movementIdentity: {
                          sourceRecordKey: "synthetic-custody-provider",
                          componentKey: "principal",
                        },
                        sourceId: otherSourceId,
                        principalId: PRINCIPAL_ID,
                        externalId: "synthetic-custody-provider-leg",
                        transactionId: transaction.id,
                        timestamp: laterProviderTime,
                        assetId: TEST_BTC_ASSET_ID,
                        amount: "3",
                        kind: "acquisition",
                        provenance: "deterministic",
                        originKind: "provider_transfer",
                        providerTransferId: provider.id,
                        sourceRepresentationUseId: providerUseId,
                      },
                    ])
                  )
                  .returning({ targetId: schema.transactionLegs.movementCorrectionTargetId })
                if (providerLeg === undefined)
                  return yield* Effect.die("Missing synthetic provider leg")
                yield* db.insert(schema.principalTransactionOverrides).values({
                  ...fixture.draft,
                  sourceId: otherSourceId,
                  targetId: providerLeg.targetId,
                  inspectedValuationEvidence: { reportingCurrency: EUR, facts: [] },
                  inspectedSourceRecordKey: "synthetic-custody-provider",
                  inspectedOccurredAt: laterProviderTime,
                })
                yield* db.insert(schema.transferReconciliations).values({
                  id: reconciliationId,
                  principalId: PRINCIPAL_ID,
                  providerTransferId: provider.id,
                  canonicalTransferId: canonical.id,
                  canonicalTransactionId: fixture.transactionId,
                  status: "approved",
                  matchReason: "Synthetic approved custody",
                  confidence: "1",
                  deterministic: true,
                })
                yield* db
                  .update(schema.transactionLegs)
                  .set({
                    originKind: "canonical_transfer",
                    sourceTransferId: canonical.id,
                    sourceRepresentationUseId: canonicalUseId,
                  })
                  .where(eq(schema.transactionLegs.id, fixture.legId))
                if (custodyCase === "included") {
                  const [fee] = yield* db
                    .insert(schema.transactionLegs)
                    .values(
                      yield* prepareMovementLegFixtures([
                        {
                          movementIdentity: {
                            sourceRecordKey: "synthetic-corrected-purchase",
                            componentKey: "fee",
                          },
                          sourceId: SOURCE_ID,
                          principalId: PRINCIPAL_ID,
                          externalId: "synthetic-custody-fee",
                          transactionId: fixture.transactionId,
                          feeForTransactionId: fixture.transactionId,
                          timestamp: fixture.draft.inspectedOccurredAt,
                          assetId: TEST_BTC_ASSET_ID,
                          amount: "0.1",
                          kind: "fee",
                          provenance: "deterministic",
                          originKind: "canonical_transfer",
                          sourceTransferId: canonical.id,
                          sourceRepresentationUseId: canonicalUseId,
                        },
                      ])
                    )
                    .returning({ targetId: schema.transactionLegs.movementCorrectionTargetId })
                  if (fee === undefined) return yield* Effect.die("Missing synthetic fee")
                  yield* db.insert(schema.principalTransactionOverrides).values({
                    ...fixture.draft,
                    targetId: fee.targetId,
                    inspectedValuationEvidence: { reportingCurrency: EUR, facts: [] },
                    inspectedComponentKey: "fee",
                    inspectedQuantity: "0.1",
                    inspectedDirection: "outbound",
                    inspectedStructure: "fee",
                    inspectedLegKind: "fee",
                    inspectedFeeForSourceRecordKey: "synthetic-corrected-purchase",
                  })
                }
                if (custodyCase === "outside_period") {
                  const laterCanonicalTime = DateTime.toDateUtc(
                    DateTime.makeUnsafe("2026-02-01T00:00:00Z")
                  )
                  yield* db
                    .update(schema.transactions)
                    .set({ timestamp: laterCanonicalTime })
                    .where(eq(schema.transactions.id, fixture.transactionId))
                  yield* db
                    .update(schema.transfers)
                    .set({ timestamp: laterCanonicalTime })
                    .where(eq(schema.transfers.id, canonical.id))
                } else if (custodyCase === "technical_withholding") {
                  yield* db
                    .update(schema.providerTransfers)
                    .set({ sourceRepresentationUseId: null })
                    .where(eq(schema.providerTransfers.id, provider.id))
                } else if (custodyCase === "excluded") {
                  const [target] = yield* db
                    .insert(schema.principalAssetOverrideTargets)
                    .values({
                      principalId: PRINCIPAL_ID,
                      targetKind: "representation",
                      ...representation,
                    })
                    .returning({ id: schema.principalAssetOverrideTargets.id })
                  if (target === undefined) return yield* Effect.die("Missing inclusion target")
                  yield* db.insert(schema.principalAssetOverrides).values({
                    principalId: PRINCIPAL_ID,
                    targetId: target.id,
                    kind: "inclusion",
                    operation: "create",
                    inspectedSystemRevision: "synthetic-inclusion",
                    inspectedSystemInclusion: "included",
                    replacementInclusion: "excluded",
                    actorUserId: fixture.draft.actorUserId,
                    reason: "Synthetic excluded asset",
                  })
                } else if (custodyCase === "invalid_quantity") {
                  yield* db
                    .update(schema.transfers)
                    .set({ amount: "0" })
                    .where(eq(schema.transfers.id, canonical.id))
                } else if (custodyCase === "asset_mismatch") {
                  const [otherRepresentation] = yield* db
                    .select({
                      blockchainId: schema.assetRepresentations.blockchainId,
                      representationType: schema.assetRepresentations.type,
                      contractAddress: schema.assetRepresentations.contractAddress,
                      mintAddress: schema.assetRepresentations.mintAddress,
                    })
                    .from(schema.assetRepresentations)
                    .where(eq(schema.assetRepresentations.id, TEST_EUR_REPRESENTATION_ID))
                  if (otherRepresentation === undefined)
                    return yield* Effect.die("Missing alternate representation")
                  const [otherUse] = yield* db
                    .insert(schema.sourceRepresentationUses)
                    .values({ sourceId: otherSourceId, ...otherRepresentation })
                    .returning({ id: schema.sourceRepresentationUses.id })
                  if (otherUse === undefined)
                    return yield* Effect.die("Missing alternate source use")
                  yield* db
                    .update(schema.providerTransfers)
                    .set({ sourceRepresentationUseId: otherUse.id })
                    .where(eq(schema.providerTransfers.id, provider.id))
                } else if (custodyCase === "whole_transaction_withholding") {
                  yield* db.insert(schema.transactionLegs).values(
                    yield* prepareMovementLegFixtures([
                      {
                        movementIdentity: {
                          sourceRecordKey: "synthetic-corrected-purchase",
                          componentKey: "unusable-sibling",
                        },
                        sourceId: SOURCE_ID,
                        principalId: PRINCIPAL_ID,
                        externalId: "synthetic-unusable-sibling",
                        transactionId: fixture.transactionId,
                        timestamp: fixture.draft.inspectedOccurredAt,
                        assetId: TEST_BTC_ASSET_ID,
                        assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
                        amount: "1",
                        kind: "acquisition",
                        provenance: "deterministic",
                        originKind: "none",
                      },
                    ])
                  )
                }
                return {
                  canonicalTransferId: canonical.id,
                  providerTransferId: provider.id,
                  providerTransactionId: transaction.id,
                }
              })
            )
          )
          yield* Effect.promise(() => recompute(SECOND_RUN_ID))
          const inputs = yield* Effect.promise(() => readCorrectionInputs(SECOND_RUN_ID))
          expect(inputs).toHaveLength(custodyCase === "included" ? 4 : 3)
          const after = inputs.find(({ captured }) => captured.history.id === fixture.historyId)
          const providerCapture = inputs.find(
            ({ captured }) => captured.current?.originKind === "provider_transfer"
          )
          const expectedOutcome =
            custodyCase === "included"
              ? "included"
              : custodyCase === "outside_period"
                ? "outside_period"
                : "withheld"
          for (const input of [
            after,
            providerCapture,
            inputs.find(({ captured }) => captured.history.id === classification.id),
          ]) {
            expect(input?.captured).toMatchObject({
              currentOutcome: expectedOutcome,
              application: custodyCase === "outside_period" ? "not_applied" : "needs_attention",
              applicationProblem:
                custodyCase === "outside_period"
                  ? null
                  : custodyCase === "included"
                    ? "structure_changed"
                    : "target_ineligible",
              resolvedPrice: null,
              current: {
                structure: "custody",
                custody: [
                  {
                    reconciliationId,
                    outcome: expectedOutcome,
                    canonicalTransactionId: fixture.transactionId,
                    canonicalSourceId: SOURCE_ID,
                    providerSourceId: "00000000-0000-4000-8000-000000000988",
                    occurredAt:
                      custodyCase === "outside_period"
                        ? "2026-02-01T00:00:00.000Z"
                        : "2025-02-01T00:00:00.000Z",
                  },
                ],
              },
            })
            expect(input?.captured.effective.classificationEvidence).toBeUndefined()
            const custody = input?.captured.current?.custody[0]
            expect(custody?.canonicalTransferId).toBe(selected.canonicalTransferId)
            expect(custody?.providerTransferId).toBe(selected.providerTransferId)
            expect(custody?.providerTransactionId).toBe(selected.providerTransactionId)
            if (custodyCase === "included") {
              expect(input?.captured.current?.effectiveAssetId).toBe(TEST_BTC_ASSET_ID)
              expect(input?.captured.system.event).toMatchObject({
                _tag: "custody_movement",
                id: reconciliationId,
                assetId: TEST_BTC_ASSET_ID,
              })
              expect(storedDecimalEquals(input?.captured.system.event?.quantity, "3")).toBe(true)
            } else expect(input?.captured.system).toEqual({ event: null, valuationFacts: [] })
          }
          if (custodyCase === "included") {
            const fee = inputs.find(({ captured }) => captured.current?.legKind === "fee")
            expect(fee?.captured).toMatchObject({
              currentOutcome: "included",
              application: "applied",
              applicationProblem: null,
              effective: { valuationFacts: [{ _tag: "user_valuation" }] },
              current: {
                custody: [],
                structure: "fee",
                feeForSourceRecordKey: "synthetic-corrected-purchase",
              },
              system: { event: { _tag: "disposition", cause: "fee" } },
            })
            expect(fee?.captured.system.event?.id).not.toBe(reconciliationId)
          }
          if (
            custodyCase === "invalid_quantity" ||
            custodyCase === "asset_mismatch" ||
            custodyCase === "technical_withholding" ||
            custodyCase === "whole_transaction_withholding"
          ) {
            const blockers = yield* Effect.promise(() =>
              runPg(
                Effect.gen(function* () {
                  const db = yield* drizzle
                  return yield* db
                    .select({ eventId: schema.calculationRunBlockers.eventId })
                    .from(schema.calculationRunBlockers)
                    .where(eq(schema.calculationRunBlockers.runId, SECOND_RUN_ID))
                })
              )
            )
            expect(blockers.length).toBeGreaterThan(0)
            if (custodyCase === "technical_withholding")
              expect(blockers).toContainEqual({ eventId: reconciliationId })
          }
          expect(after?.captured.effective).toEqual(after?.captured.system)
          expect(yield* Effect.promise(() => readCorrectionInputs(FIRST_RUN_ID))).toEqual(before)
        })
    )
  }

  it.effect(
    "captures independent inactive history and changes revision for equal-valued replacement",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() => runPg(seedCorrectionMovement))
        const classification = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const [row] = yield* db
                .insert(schema.principalTransactionOverrides)
                .values({
                  ...fixture.draft,
                  kind: "classification",
                  priceInput: null,
                  classificationInput: { _tag: "inbound", cause: "gift" },
                })
                .returning({ id: schema.principalTransactionOverrides.id })
              if (row === undefined) return yield* Effect.die("Missing synthetic classification")
              return row
            })
          )
        )
        const first = yield* Effect.promise(() => recompute(FIRST_RUN_ID))
        const original = yield* Effect.promise(() => readCorrectionInputs(FIRST_RUN_ID))
        expect(original).toHaveLength(2)
        for (const { captured } of original) {
          expect(captured).toMatchObject({
            currentOutcome: "included",
            streamState: "active",
            application: "applied",
            reportingCurrency: "EUR",
            current: { legId: fixture.legId, targetId: fixture.targetId },
            system: {
              event: { _tag: "acquisition", id: fixture.legId, cause: "purchase" },
              valuationFacts: [
                { _tag: "observed_consideration", amount: { currency: "EUR", amount: "10" } },
              ],
            },
          })
          expect(storedDecimalEquals(captured.current?.quantity, "3")).toBe(true)
          expect(captured.effective.event).toEqual({ ...captured.system.event, cause: "gift" })
          expect(captured.effective.classificationEvidence).toEqual({
            _tag: "user_assertion",
            overrideId: classification.id,
          })
          expect(captured.effective.valuationFacts).toContainEqual(
            expect.objectContaining({ _tag: "user_valuation" })
          )
          expect(captured.history.actorUserId).toBe(fixture.draft.actorUserId)
          expect(captured.history.inspectedFacts.quantity).toBe("3")
        }
        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db.insert(schema.principalTransactionOverrides).values({
                ...fixture.draft,
                operation: "replace",
                supersedesOverrideId: fixture.historyId,
              })
              yield* db.insert(schema.principalTransactionOverrides).values({
                ...fixture.draft,
                kind: "classification",
                operation: "withdraw",
                priceInput: null,
                classificationInput: null,
                supersedesOverrideId: classification.id,
              })
            })
          )
        )
        const second = yield* Effect.promise(() => recompute(SECOND_RUN_ID))
        const updated = yield* Effect.promise(() => readCorrectionInputs(SECOND_RUN_ID))
        expect(updated).toHaveLength(4)
        expect(
          updated.filter(({ captured }) => captured.streamState === "superseded")
        ).toHaveLength(2)
        expect(updated.filter(({ captured }) => captured.application === "inactive")).toHaveLength(
          3
        )
        expect(
          updated.find(({ captured }) => captured.streamState === "withdrawn")?.captured.history
            .input
        ).toBeNull()
        expect(
          updated.find(({ captured }) => captured.streamState === "active")?.captured.history.input
        ).toEqual({ _tag: "price", input: fixture.draft.priceInput })
        expect(factualContentHash(second.inputLedgerRevision)).not.toBe(
          factualContentHash(first.inputLedgerRevision)
        )
        expect(second.valuationRevision).not.toBe(first.valuationRevision)
        expect(yield* Effect.promise(() => readCorrectionInputs(FIRST_RUN_ID))).toEqual(original)
      })
  )

  it.effect(
    "retains corrected movement history when technical withholding or a missing current leg prevents application",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() => runPg(seedCorrectionMovement))
        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db
                .update(schema.transactionLegs)
                .set({ assetRepresentationId: TEST_BTC_REPRESENTATION_ID })
                .where(eq(schema.transactionLegs.id, fixture.legId))
            })
          )
        )
        const readMovementInputs = (runId: CalculationRunId) =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return yield* db
                .select({
                  runId: schema.calculationRunMovementInputs.runId,
                  principalId: schema.calculationRunMovementInputs.principalId,
                  sourceId: schema.calculationRunMovementInputs.sourceId,
                  targetId: schema.calculationRunMovementInputs.targetId,
                  transactionId: schema.calculationRunMovementInputs.transactionId,
                  eventId: schema.calculationRunMovementInputs.eventId,
                  captured: schema.calculationRunMovementInputs.captured,
                  valuation: schema.calculationRunMovementInputs.valuation,
                })
                .from(schema.calculationRunMovementInputs)
                .where(eq(schema.calculationRunMovementInputs.runId, runId))
            })
          )
        const withheld = yield* Effect.promise(() => recompute(FIRST_RUN_ID))
        const withheldMovements = yield* Effect.promise(() => readMovementInputs(FIRST_RUN_ID))
        expect(withheldMovements).toEqual([
          expect.objectContaining({
            runId: FIRST_RUN_ID,
            principalId: PRINCIPAL_ID,
            sourceId: SOURCE_ID,
            targetId: fixture.targetId,
            transactionId: fixture.transactionId,
            eventId: null,
            captured: expect.objectContaining({
              targetId: fixture.targetId,
              currentOutcome: "withheld",
              current: expect.objectContaining({ legId: fixture.legId }),
              effective: expect.objectContaining({ event: null, valuationFacts: [] }),
            }),
            valuation: { _tag: "not_evaluated" },
          }),
        ])
        const [captured] = yield* Effect.promise(() => readCorrectionInputs(FIRST_RUN_ID))
        expect(withheld.status).toBe("partial")
        expect(captured?.captured).toMatchObject({
          application: "needs_attention",
          currentOutcome: "withheld",
          current: { legId: fixture.legId },
          system: { event: null, valuationFacts: [] },
          effective: { event: null, valuationFacts: [] },
        })
        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db
                .delete(schema.transactionLegs)
                .where(eq(schema.transactionLegs.id, fixture.legId))
            })
          )
        )
        yield* Effect.promise(() => recompute(SECOND_RUN_ID))
        const [absent] = yield* Effect.promise(() => readCorrectionInputs(SECOND_RUN_ID))
        expect(yield* Effect.promise(() => readMovementInputs(SECOND_RUN_ID))).toEqual([
          expect.objectContaining({
            runId: SECOND_RUN_ID,
            principalId: PRINCIPAL_ID,
            sourceId: SOURCE_ID,
            targetId: fixture.targetId,
            transactionId: null,
            eventId: null,
            captured: expect.objectContaining({
              targetId: fixture.targetId,
              current: null,
              currentOutcome: "absent",
              effective: expect.objectContaining({ event: null }),
            }),
            valuation: { _tag: "not_evaluated" },
          }),
        ])
        expect(yield* Effect.promise(() => readMovementInputs(FIRST_RUN_ID))).toEqual(
          withheldMovements
        )
        expect(absent?.captured).toMatchObject({
          current: null,
          currentOutcome: "absent",
          application: "needs_attention",
          history: { id: fixture.historyId, targetId: fixture.targetId },
        })
        expect(yield* Effect.promise(() => readCorrectionInputs(FIRST_RUN_ID))).toEqual([captured])
      })
  )

  it.effect("keeps racing history and system changes out of an earlier repeatable-read run", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => runPg(seedCorrectionMovement))
      const snapshotLoaded = yield* Deferred.make<void>()
      const releaseSnapshot = yield* Deferred.make<void>()
      const coordinatedLedger = Layer.effect(
        FactualLedgerRepository,
        Effect.map(FactualLedgerRepository, (repository) =>
          FactualLedgerRepository.of({
            load: (params) =>
              repository.load(params).pipe(
                Effect.tap(() => Deferred.succeed(snapshotLoaded, undefined)),
                Effect.tap(() => Deferred.await(releaseSnapshot))
              ),
          })
        )
      ).pipe(Layer.provide(FactualLedgerRepositoryLive))
      const layer = CalculationRunServiceLive.pipe(
        Layer.provide(Layer.merge(CalculationRunRepositoryLive, coordinatedLedger))
      )
      const running = yield* Effect.forkChild(
        context.runWithLayer({
          layer,
          effect: Effect.flatMap(CalculationRunService, (service) =>
            service.recompute({
              id: FIRST_RUN_ID,
              principalId: PRINCIPAL_ID,
              jurisdiction: JurisdictionCode.make("DE"),
              taxYear: TaxYear.make(2025),
              reportingCurrency: EUR,
              accountingChoices: [],
            })
          ),
        })
      )
      yield* Deferred.await(snapshotLoaded)
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.principalTransactionOverrides).values({
              ...fixture.draft,
              operation: "replace",
              supersedesOverrideId: fixture.historyId,
            })
            yield* db
              .update(schema.transactions)
              .set({ providerFiatAmount: "20" })
              .where(eq(schema.transactions.id, fixture.transactionId))
          })
        )
      )
      yield* Deferred.succeed(releaseSnapshot, undefined)
      const first = yield* Fiber.join(running)
      const second = yield* Effect.promise(() => recompute(SECOND_RUN_ID))
      const earlier = yield* Effect.promise(() => readCorrectionInputs(FIRST_RUN_ID))
      const later = yield* Effect.promise(() => readCorrectionInputs(SECOND_RUN_ID))
      expect(earlier).toHaveLength(1)
      expect(earlier[0]?.captured).toMatchObject({
        history: { id: fixture.historyId },
        streamState: "active",
        system: { valuationFacts: [{ amount: { amount: "10" } }] },
      })
      expect(later).toHaveLength(2)
      expect(
        later.find(({ captured }) => captured.history.id === fixture.historyId)?.captured
          .streamState
      ).toBe("superseded")
      expect(later[0]?.captured.system.valuationFacts).toMatchObject([{ amount: { amount: "20" } }])
      expect(first.inputLedgerRevision).not.toBe(second.inputLedgerRevision)
    })
  )

  it.effect("calculates Coinbase passive staking income and valued FIFO results", () =>
    Effect.gen(function* () {
      const stakingEventId = "10000000-0000-4000-8000-000000000021"
      const saleEventId = "10000000-0000-4000-8000-000000000022"
      const missingValueEventId = "10000000-0000-4000-8000-000000000023"

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const transactionInputs = [
              {
                externalId: "coinbase-staking-payout",
                timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-03T10:00:00.000Z")),
                transactionType: "staking_reward",
                providerTransactionType: "earn_payout",
                providerFiatAmount: "25",
                providerFiatCurrency: "EUR",
              },
              {
                externalId: "coinbase-staking-sale",
                timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-06-03T10:00:00.000Z")),
                transactionType: "sell_fiat",
                providerTransactionType: "sell",
                providerFiatAmount: "20",
                providerFiatCurrency: "EUR",
              },
              {
                externalId: "coinbase-interest-without-value",
                timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-07-03T10:00:00.000Z")),
                transactionType: "interest_received",
                providerTransactionType: "interest",
                providerFiatAmount: null,
                providerFiatCurrency: null,
              },
            ] as const
            const transactions = yield* db
              .insert(schema.transactions)
              .values(
                transactionInputs.map((transaction) => ({
                  ...transaction,
                  sourceId: SOURCE_ID,
                  principalId: PRINCIPAL_ID,
                }))
              )
              .returning({ id: schema.transactions.id, externalId: schema.transactions.externalId })
            const transactionByExternalId = new Map(
              transactions.map((transaction) => [transaction.externalId, transaction.id])
            )
            const stakingTransactionId = transactionByExternalId.get("coinbase-staking-payout")
            const saleTransactionId = transactionByExternalId.get("coinbase-staking-sale")
            const missingValueTransactionId = transactionByExternalId.get(
              "coinbase-interest-without-value"
            )
            if (
              stakingTransactionId === undefined ||
              saleTransactionId === undefined ||
              missingValueTransactionId === undefined
            ) {
              return yield* Effect.die("Failed to create staking calculation transactions")
            }

            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures([
                {
                  movementIdentity: {
                    sourceRecordKey: "coinbase-staking-payout-leg",
                    componentKey: "movement",
                  },
                  id: stakingEventId,
                  sourceId: SOURCE_ID,
                  externalId: "coinbase-staking-payout-leg",
                  timestamp: transactionInputs[0].timestamp,
                  principalId: PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "1",
                  kind: "income",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  transactionId: stakingTransactionId,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "coinbase-staking-sale-leg",
                    componentKey: "movement",
                  },
                  id: saleEventId,
                  sourceId: SOURCE_ID,
                  externalId: "coinbase-staking-sale-leg",
                  timestamp: transactionInputs[1].timestamp,
                  principalId: PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "0.5",
                  kind: "disposal",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  transactionId: saleTransactionId,
                },
                {
                  movementIdentity: {
                    sourceRecordKey: "coinbase-interest-without-value-leg",
                    componentKey: "movement",
                  },
                  id: missingValueEventId,
                  sourceId: SOURCE_ID,
                  externalId: "coinbase-interest-without-value-leg",
                  timestamp: transactionInputs[2].timestamp,
                  principalId: PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  amount: "0.25",
                  kind: "income",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  transactionId: missingValueTransactionId,
                },
              ])
            )
          })
        )
      )

      const result = yield* Effect.promise(() => recompute(FIRST_RUN_ID))
      const stored = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const income = yield* db
              .select({
                eventId: schema.calculationRunIncomeResults.eventId,
                value: schema.calculationRunIncomeResults.value,
                treatmentCodes: schema.calculationRunIncomeResults.treatmentCodes,
              })
              .from(schema.calculationRunIncomeResults)
              .where(eq(schema.calculationRunIncomeResults.runId, FIRST_RUN_ID))
              .orderBy(asc(schema.calculationRunIncomeResults.sequence))
            const realized = yield* db
              .select({
                dispositionEventId: schema.calculationRunRealizedResults.dispositionEventId,
                costBasis: schema.calculationRunRealizedResults.costBasis,
                proceeds: schema.calculationRunRealizedResults.proceeds,
              })
              .from(schema.calculationRunRealizedResults)
              .where(eq(schema.calculationRunRealizedResults.runId, FIRST_RUN_ID))
              .orderBy(asc(schema.calculationRunRealizedResults.sequence))
            const lots = yield* db
              .select({
                acquisitionEventId: schema.calculationRunDerivedLots.acquisitionEventId,
                remainingQuantity: schema.calculationRunDerivedLots.remainingQuantity,
                costBasisPerUnit: schema.calculationRunDerivedLots.costBasisPerUnit,
              })
              .from(schema.calculationRunDerivedLots)
              .where(eq(schema.calculationRunDerivedLots.runId, FIRST_RUN_ID))
              .orderBy(asc(schema.calculationRunDerivedLots.sequence))
            const blockers = yield* db
              .select({
                eventId: schema.calculationRunBlockers.eventId,
                code: schema.calculationRunBlockers.code,
              })
              .from(schema.calculationRunBlockers)
              .where(eq(schema.calculationRunBlockers.runId, FIRST_RUN_ID))
              .orderBy(asc(schema.calculationRunBlockers.sequence))

            return { income, realized, lots, blockers }
          })
        )
      )

      expect(result.status).toBe("partial")
      expect(stored.income).toHaveLength(1)
      expect(stored.income[0]).toMatchObject({
        eventId: stakingEventId,
        treatmentCodes: ["de.taxable_income_section22_3_staking"],
      })
      expect(storedDecimalEquals(stored.income[0]?.value, "25")).toBe(true)

      expect(stored.realized).toHaveLength(1)
      expect(stored.realized[0]).toMatchObject({ dispositionEventId: saleEventId })
      expect(storedDecimalEquals(stored.realized[0]?.costBasis, "12.5")).toBe(true)
      expect(storedDecimalEquals(stored.realized[0]?.proceeds, "20")).toBe(true)

      expect(stored.lots).toHaveLength(2)
      expect(stored.lots[0]).toMatchObject({ acquisitionEventId: stakingEventId })
      expect(storedDecimalEquals(stored.lots[0]?.remainingQuantity, "0.5")).toBe(true)
      expect(storedDecimalEquals(stored.lots[0]?.costBasisPerUnit, "25")).toBe(true)
      expect(stored.lots[1]).toMatchObject({
        acquisitionEventId: missingValueEventId,
        costBasisPerUnit: null,
      })
      expect(storedDecimalEquals(stored.lots[1]?.remainingQuantity, "0.25")).toBe(true)
      expect(stored.blockers).toEqual([{ eventId: missingValueEventId, code: "missing_valuation" }])
    })
  )

  it.effect("commits the exact override history position to the factual content hash", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-03T10:00:00.000Z"))
      const { firstOverrideId, targetId } = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [principal] = yield* db
              .select({ userId: schema.principals.userId })
              .from(schema.principals)
              .where(eq(schema.principals.id, PRINCIPAL_ID))
            const [representation] = yield* db
              .select({
                blockchainId: schema.assetRepresentations.blockchainId,
                type: schema.assetRepresentations.type,
                contractAddress: schema.assetRepresentations.contractAddress,
                mintAddress: schema.assetRepresentations.mintAddress,
              })
              .from(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
            if (principal?.userId === null || principal?.userId === undefined) {
              return yield* Effect.die("Missing principal actor")
            }
            if (representation === undefined) {
              return yield* Effect.die("Missing representation fixture")
            }

            const [transaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: SOURCE_ID,
                externalId: "override-revision-input",
                timestamp: occurredAt,
                transactionType: "buy_fiat",
                principalId: PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            if (transaction === undefined) return yield* Effect.die("Failed to create fact")

            yield* db.insert(schema.transactionLegs).values(
              yield* prepareMovementLegFixtures([
                {
                  movementIdentity: {
                    sourceRecordKey: "override-revision-input-leg",
                    componentKey: "movement",
                  },
                  sourceId: SOURCE_ID,
                  externalId: "override-revision-input-leg",
                  timestamp: occurredAt,
                  principalId: PRINCIPAL_ID,
                  assetId: TEST_BTC_ASSET_ID,
                  assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
                  amount: "1",
                  kind: "acquisition",
                  provenance: "deterministic",
                  originKind: "none" as const,
                  transactionId: transaction.id,
                },
              ])
            )

            const [target] = yield* db
              .insert(schema.principalAssetOverrideTargets)
              .values({
                principalId: PRINCIPAL_ID,
                targetKind: "representation",
                blockchainId: representation.blockchainId,
                representationType: representation.type,
                contractAddress: representation.contractAddress,
                mintAddress: representation.mintAddress,
              })
              .returning({ id: schema.principalAssetOverrideTargets.id })
            if (target === undefined) return yield* Effect.die("Failed to create override target")

            const [firstOverride] = yield* db
              .insert(schema.principalAssetOverrides)
              .values({
                principalId: PRINCIPAL_ID,
                targetId: target.id,
                kind: "identity",
                operation: "create",
                inspectedSystemRevision: "run-input-system-v1",
                inspectedSystemIdentity: "resolved",
                inspectedSystemAssetId: TEST_BTC_ASSET_ID,
                replacementAssetId: TEST_BTC_ASSET_ID,
                actorUserId: principal.userId,
                reason: "Record the first history position",
              })
              .returning({ id: schema.principalAssetOverrides.id })
            if (firstOverride === undefined) {
              return yield* Effect.die("Failed to create first override")
            }

            return { targetId: target.id, firstOverrideId: firstOverride.id }
          })
        )
      )

      const firstRead = yield* Effect.promise(loadLedger)
      const repeatedFirstRead = yield* Effect.promise(loadLedger)
      expect(repeatedFirstRead.events).toEqual(firstRead.events)
      expect(repeatedFirstRead.principalAssetOverrideRevision).toEqual(
        firstRead.principalAssetOverrideRevision
      )

      yield* Effect.promise(() => recompute(FIRST_RUN_ID))

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [principal] = yield* db
              .select({ userId: schema.principals.userId })
              .from(schema.principals)
              .where(eq(schema.principals.id, PRINCIPAL_ID))
            if (principal?.userId === null || principal?.userId === undefined) {
              return yield* Effect.die("Missing principal actor")
            }
            yield* db.insert(schema.principalAssetOverrides).values({
              principalId: PRINCIPAL_ID,
              targetId,
              kind: "identity",
              operation: "replace",
              inspectedSystemRevision: "run-input-system-v1",
              inspectedSystemIdentity: "resolved",
              inspectedSystemAssetId: TEST_BTC_ASSET_ID,
              replacementAssetId: TEST_BTC_ASSET_ID,
              actorUserId: principal.userId,
              reason: "Record a different history position with the same decision",
              supersedesOverrideId: firstOverrideId,
            })
          })
        )
      )

      const secondRead = yield* Effect.promise(loadLedger)
      const repeatedSecondRead = yield* Effect.promise(loadLedger)
      expect(secondRead.events).toEqual(firstRead.events)
      expect(secondRead.principalAssetOverrideRevision).not.toEqual(
        firstRead.principalAssetOverrideRevision
      )
      expect(repeatedSecondRead.principalAssetOverrideRevision).toEqual(
        secondRead.principalAssetOverrideRevision
      )

      yield* Effect.promise(() => recompute(SECOND_RUN_ID))

      const revisions = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                id: schema.calculationRuns.id,
                inputLedgerRevision: schema.calculationRuns.inputLedgerRevision,
              })
              .from(schema.calculationRuns)
              .where(eq(schema.calculationRuns.principalId, PRINCIPAL_ID))
          })
        )
      )
      const firstRevision = revisions.find(({ id }) => id === FIRST_RUN_ID)?.inputLedgerRevision
      const secondRevision = revisions.find(({ id }) => id === SECOND_RUN_ID)?.inputLedgerRevision

      expect(firstRevision).toBeDefined()
      expect(secondRevision).toBeDefined()
      expect(factualContentHash(firstRevision ?? "")).not.toBe(
        factualContentHash(secondRevision ?? "")
      )
    })
  )

  it.effect(
    "commits the provider-asset override history position to the factual content hash",
    () =>
      Effect.gen(function* () {
        const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-04T10:00:00.000Z"))
        const { firstOverrideId, targetId } = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const [principal] = yield* db
                .select({ userId: schema.principals.userId })
                .from(schema.principals)
                .where(eq(schema.principals.id, PRINCIPAL_ID))
              if (principal?.userId === null || principal?.userId === undefined) {
                return yield* Effect.die("Missing principal actor")
              }

              yield* db.insert(schema.providerAssets).values({
                id: PROVIDER_ASSET_ROW_ID,
                provider: "coinbase",
                providerAssetId: "provider-revision-btc",
                currencyCode: "BTC",
                name: "Bitcoin",
                providerType: "crypto",
                rawProviderPayload: { asset_id: "provider-revision-btc" },
                evidenceRevision: 1,
                discoveredAt: occurredAt,
                retrievedAt: occurredAt,
              })
              yield* db.insert(schema.providerAssetMappings).values({
                providerAssetRowId: PROVIDER_ASSET_ROW_ID,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                mappingStatus: "approved",
              })

              const [transaction] = yield* db
                .insert(schema.transactions)
                .values({
                  sourceId: SOURCE_ID,
                  externalId: "provider-override-revision-input",
                  timestamp: occurredAt,
                  transactionType: "buy_fiat",
                  principalId: PRINCIPAL_ID,
                })
                .returning({ id: schema.transactions.id })
              if (transaction === undefined) return yield* Effect.die("Failed to create fact")

              yield* db.insert(schema.transactionLegs).values(
                yield* prepareMovementLegFixtures([
                  {
                    movementIdentity: {
                      sourceRecordKey: "provider-override-revision-input-leg",
                      componentKey: "movement",
                    },
                    sourceId: SOURCE_ID,
                    externalId: "provider-override-revision-input-leg",
                    timestamp: occurredAt,
                    principalId: PRINCIPAL_ID,
                    assetId: TEST_BTC_ASSET_ID,
                    amount: "1",
                    kind: "acquisition",
                    provenance: "deterministic",
                    originKind: "none" as const,
                    metadata: { providerAssetRowId: PROVIDER_ASSET_ROW_ID },
                    transactionId: transaction.id,
                  },
                ])
              )

              const [target] = yield* db
                .insert(schema.principalAssetOverrideTargets)
                .values({
                  principalId: PRINCIPAL_ID,
                  targetKind: "provider_asset",
                  providerAssetRowId: PROVIDER_ASSET_ROW_ID,
                })
                .returning({ id: schema.principalAssetOverrideTargets.id })
              if (target === undefined) return yield* Effect.die("Failed to create override target")

              const [firstOverride] = yield* db
                .insert(schema.principalAssetOverrides)
                .values({
                  principalId: PRINCIPAL_ID,
                  targetId: target.id,
                  kind: "identity",
                  operation: "create",
                  inspectedSystemRevision: "provider-run-input-system-v1",
                  inspectedSystemIdentity: "resolved",
                  inspectedSystemAssetId: TEST_BTC_ASSET_ID,
                  replacementAssetId: TEST_BTC_ASSET_ID,
                  actorUserId: principal.userId,
                  reason: "Record the first provider-asset history position",
                })
                .returning({ id: schema.principalAssetOverrides.id })
              if (firstOverride === undefined) {
                return yield* Effect.die("Failed to create first provider-asset override")
              }

              return { targetId: target.id, firstOverrideId: firstOverride.id }
            })
          )
        )

        const firstRead = yield* Effect.promise(loadLedger)
        const repeatedFirstRead = yield* Effect.promise(loadLedger)
        expect(repeatedFirstRead.events).toEqual(firstRead.events)
        expect(repeatedFirstRead.principalAssetOverrideRevision).toEqual(
          firstRead.principalAssetOverrideRevision
        )

        yield* Effect.promise(() => recompute(FIRST_RUN_ID))

        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const [principal] = yield* db
                .select({ userId: schema.principals.userId })
                .from(schema.principals)
                .where(eq(schema.principals.id, PRINCIPAL_ID))
              if (principal?.userId === null || principal?.userId === undefined) {
                return yield* Effect.die("Missing principal actor")
              }
              yield* db.insert(schema.principalAssetOverrides).values({
                principalId: PRINCIPAL_ID,
                targetId,
                kind: "identity",
                operation: "replace",
                inspectedSystemRevision: "provider-run-input-system-v1",
                inspectedSystemIdentity: "resolved",
                inspectedSystemAssetId: TEST_BTC_ASSET_ID,
                replacementAssetId: TEST_BTC_ASSET_ID,
                actorUserId: principal.userId,
                reason: "Record another provider-asset history position with the same decision",
                supersedesOverrideId: firstOverrideId,
              })
            })
          )
        )

        const secondRead = yield* Effect.promise(loadLedger)
        const repeatedSecondRead = yield* Effect.promise(loadLedger)
        expect(secondRead.events).toEqual(firstRead.events)
        expect(secondRead.principalAssetOverrideRevision).not.toEqual(
          firstRead.principalAssetOverrideRevision
        )
        expect(repeatedSecondRead.principalAssetOverrideRevision).toEqual(
          secondRead.principalAssetOverrideRevision
        )

        yield* Effect.promise(() => recompute(SECOND_RUN_ID))

        const revisions = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return yield* db
                .select({
                  id: schema.calculationRuns.id,
                  inputLedgerRevision: schema.calculationRuns.inputLedgerRevision,
                })
                .from(schema.calculationRuns)
                .where(eq(schema.calculationRuns.principalId, PRINCIPAL_ID))
            })
          )
        )
        const firstRevision = revisions.find(({ id }) => id === FIRST_RUN_ID)?.inputLedgerRevision
        const secondRevision = revisions.find(({ id }) => id === SECOND_RUN_ID)?.inputLedgerRevision

        expect(firstRevision).toBeDefined()
        expect(secondRevision).toBeDefined()
        expect(factualContentHash(firstRevision ?? "")).not.toBe(
          factualContentHash(secondRevision ?? "")
        )
      })
  )
})
