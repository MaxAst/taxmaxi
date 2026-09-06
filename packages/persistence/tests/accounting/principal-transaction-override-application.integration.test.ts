import { beforeEach, describe, expect, it } from "@effect/vitest"
import { JurisdictionCode, TaxYear, type MovementPriceInput } from "@my/core/accounting"
import { AuthUserId } from "@my/core/authentication"
import { CurrencyCode } from "@my/core/currency"
import { PrincipalId } from "@my/core/ownership"
import { asc, eq } from "drizzle-orm"
import * as BigDecimal from "effect/BigDecimal"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { CalculationRunRepositoryLive } from "../../src/layers/CalculationRunRepositoryLive.ts"
import { CalculationRunServiceLive } from "../../src/layers/CalculationRunServiceLive.ts"
import { FactualLedgerRepositoryLive } from "../../src/layers/FactualLedgerRepositoryLive.ts"
import { PrincipalTransactionOverrideRepositoryLive } from "../../src/layers/PrincipalTransactionOverrideRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import { CalculationRunId } from "../../src/services/CalculationRunRepository.ts"
import { CalculationRunService } from "../../src/services/CalculationRunService.ts"
import { FactualLedgerRepository } from "../../src/services/FactualLedgerRepository.ts"
import { PrincipalTransactionOverrideRepository } from "../../src/services/PrincipalTransactionOverrideRepository.ts"
import { prepareMovementLegFixtures } from "../support/movement-leg-fixtures.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_BTC_REPRESENTATION_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const PRINCIPAL_ID = PrincipalId.make("00000000-0000-4000-8000-000000007101")
const USER_ID = AuthUserId.make("00000000-0000-4000-8000-000000007102")
const SOURCE_ID = "00000000-0000-4000-8000-000000007103"
const OTHER_PRINCIPAL_ID = PrincipalId.make("00000000-0000-4000-8000-000000007104")
const OTHER_USER_ID = AuthUserId.make("00000000-0000-4000-8000-000000007105")
const OTHER_SOURCE_ID = "00000000-0000-4000-8000-000000007106"
const CHANGED_ASSET_ID = "00000000-0000-4000-8000-000000007107"
const EUR = CurrencyCode.make("EUR")
const USD = CurrencyCode.make("USD")
const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_movement_price_application",
})
const runPg = <A, E>(effect: Parameters<typeof context.runPg<A, E>>[0]) =>
  Effect.promise(() => context.runPg(effect))
const runId = (index: number) =>
  CalculationRunId.make(`00000000-0000-4000-8000-${String(7200 + index).padStart(12, "0")}`)
const runLayer = CalculationRunServiceLive.pipe(
  Layer.provide(Layer.merge(CalculationRunRepositoryLive, FactualLedgerRepositoryLive))
)
const recompute = (index: number, principalId = PRINCIPAL_ID, reportingCurrency = EUR) =>
  context.runWithLayer({
    layer: runLayer,
    effect: Effect.flatMap(CalculationRunService, (service) =>
      service.recompute({
        id: runId(index),
        principalId,
        jurisdiction: JurisdictionCode.make("DE"),
        taxYear: TaxYear.make(2025),
        reportingCurrency,
        accountingChoices: [],
      })
    ),
  })
const loadLedger = (reportingCurrency = EUR) =>
  context.runWithLayer({
    layer: FactualLedgerRepositoryLive,
    effect: Effect.flatMap(FactualLedgerRepository, (repo) =>
      repo.load({ principalId: PRINCIPAL_ID, reportingCurrency })
    ),
  })
const moneyEquals = (actual: string | null | undefined, expected: string) =>
  actual != null &&
  BigDecimal.equals(BigDecimal.fromStringUnsafe(actual), BigDecimal.fromStringUnsafe(expected))

const seed = ({
  quantity = "10",
  principalId = PRINCIPAL_ID,
  userId = USER_ID,
  sourceId = SOURCE_ID,
  assets = true,
  systemPurchaseValue = null,
}: {
  readonly quantity?: string
  readonly principalId?: PrincipalId
  readonly userId?: AuthUserId
  readonly sourceId?: string
  readonly assets?: boolean
  readonly systemPurchaseValue?: string | null
} = {}) =>
  Effect.gen(function* () {
    const fixture = yield* seedSyncEngineRepositoryFixture({ principalId, userId, sourceId })
    if (assets) yield* seedSyncEngineAssets(fixture)
    const db = yield* drizzle
    const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T00:00:00Z"))
    const saleTimestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-01T00:00:00Z"))
    const [purchase, sale] = yield* db
      .insert(schema.transactions)
      .values([
        {
          principalId,
          sourceId,
          externalId: "synthetic-purchase",
          timestamp,
          transactionType: "buy_fiat",
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
    return { acquisition, disposition, purchaseId: purchase.id, saleId: sale.id, timestamp }
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
        const found = yield* repository.findContext({ principalId: PRINCIPAL_ID, targetId })
        if (Option.isNone(found) || found.value.current === null)
          return yield* Effect.die("Missing current synthetic movement")
        const parameters = {
          principalId: PRINCIPAL_ID,
          actorUserId: USER_ID,
          targetId,
          expectedSystemRevision: found.value.current.facts.systemRevision,
          expectedLeafId: found.value.price.leaf?.id ?? null,
          reason: "Synthetic price evidence",
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

const readRun = (index: number) =>
  runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const results = yield* db
        .select({
          basis: schema.calculationRunRealizedResults.costBasis,
          gain: schema.calculationRunRealizedResults.gainLoss,
        })
        .from(schema.calculationRunRealizedResults)
        .where(eq(schema.calculationRunRealizedResults.runId, runId(index)))
      const blockers = yield* db
        .select({
          code: schema.calculationRunBlockers.code,
          eventId: schema.calculationRunBlockers.eventId,
        })
        .from(schema.calculationRunBlockers)
        .where(eq(schema.calculationRunBlockers.runId, runId(index)))
      const inputs = yield* db
        .select({ captured: schema.calculationRunCorrectionInputs.captured })
        .from(schema.calculationRunCorrectionInputs)
        .where(eq(schema.calculationRunCorrectionInputs.runId, runId(index)))
        .orderBy(asc(schema.calculationRunCorrectionInputs.overrideId))
      return { results, blockers, inputs }
    })
  )

await Effect.runPromise(context.recreateTestDatabase())
beforeEach(() => Effect.runPromise(context.recreateTestDatabase()))

describe("effective movement price application", () => {
  for (const mode of ["unit_price", "total_value"] as const) {
    it.effect(
      `applies ${mode}, replaces and withdraws without changing original evidence or another principal`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* runPg(seed())
          yield* runPg(
            seed({
              principalId: OTHER_PRINCIPAL_ID,
              userId: OTHER_USER_ID,
              sourceId: OTHER_SOURCE_ID,
              assets: false,
            })
          )
          const original = yield* recompute(1)
          expect(original.status).toBe("partial")
          const before = yield* readRun(1)
          const accepted = yield* changePrice({
            operation: "create",
            targetId: fixture.acquisition.targetId,
            input: { _tag: mode, amount: mode === "unit_price" ? "2" : "20", currency: EUR },
          })
          expect((yield* recompute(2)).status).toBe("complete")
          const priced = yield* readRun(2)
          expect(moneyEquals(priced.results[0]?.basis, "20")).toBe(true)
          expect(moneyEquals(priced.results[0]?.gain, "10")).toBe(true)
          const capture = priced.inputs.find(
            ({ captured }) => captured.history.id === accepted.overrideId
          )?.captured
          expect(capture).toMatchObject({
            application: "applied",
            applicationProblem: null,
            resolvedPrice: { currency: "EUR" },
            system: { valuationFacts: [] },
            effective: {
              valuationFacts: [
                {
                  _tag: "user_valuation",
                  evidenceReference: `movement-price:${accepted.overrideId}`,
                },
              ],
            },
          })
          expect(moneyEquals(capture?.resolvedPrice?.totalValue, "20")).toBe(true)
          const replacement = yield* changePrice({
            operation: "replace",
            targetId: fixture.acquisition.targetId,
            input: { _tag: "unit_price", amount: "3", currency: EUR },
          })
          expect((yield* recompute(3)).status).toBe("complete")
          const replaced = yield* readRun(3)
          expect(moneyEquals(replaced.results[0]?.basis, "30")).toBe(true)
          expect(moneyEquals(replaced.results[0]?.gain, "0")).toBe(true)
          expect(
            replaced.inputs.find(({ captured }) => captured.history.id === replacement.overrideId)
              ?.captured.application
          ).toBe("applied")
          yield* changePrice({ operation: "withdraw", targetId: fixture.acquisition.targetId })
          expect((yield* recompute(4)).status).toBe("partial")
          expect(
            (yield* readRun(4)).inputs.every(({ captured }) => captured.application === "inactive")
          ).toBe(true)
          expect((yield* recompute(5, OTHER_PRINCIPAL_ID)).status).toBe("partial")
          expect((yield* readRun(5)).inputs).toEqual([])
          expect(yield* readRun(1)).toEqual(before)
          const raw = yield* runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return yield* db
                .select({ amount: schema.transactionLegs.fiatAmount })
                .from(schema.transactionLegs)
                .where(eq(schema.transactionLegs.id, fixture.acquisition.id))
            })
          )
          expect(raw).toEqual([{ amount: null }])
        })
    )
  }

  for (const precision of [
    { quantity: "3", input: "1", mode: "total_value", basis: "1", gain: "29" },
    { quantity: "10", input: "0", mode: "total_value", basis: "0", gain: "30" },
    {
      quantity: "10",
      input: "9007199254740993",
      mode: "total_value",
      basis: "9007199254740993",
      gain: "-9007199254740963",
    },
    {
      quantity: "10",
      input: "0.000000000000000001",
      mode: "total_value",
      basis: "0.000000000000000001",
      gain: "29.999999999999999999",
    },
    {
      quantity: "3",
      input: "0.000000000000000001",
      mode: "unit_price",
      basis: "0.000000000000000003",
      gain: "29.999999999999999997",
    },
  ] as const) {
    it.effect(
      `retains exact ${precision.mode} ${precision.input} through a full sale of ${precision.quantity} tokens`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* runPg(seed({ quantity: precision.quantity }))
          yield* changePrice({
            operation: "create",
            targetId: fixture.acquisition.targetId,
            input: { _tag: precision.mode, amount: precision.input, currency: EUR },
          })
          expect((yield* recompute(1)).status).toBe("complete")
          const run = yield* readRun(1)
          expect(moneyEquals(run.results[0]?.basis, precision.basis)).toBe(true)
          expect(moneyEquals(run.results[0]?.gain, precision.gain)).toBe(true)
          const capture = run.inputs[0]?.captured
          expect(capture?.history.input).toMatchObject({
            input: { _tag: precision.mode, amount: precision.input, currency: "EUR" },
          })
          expect(moneyEquals(capture?.resolvedPrice?.totalValue, precision.basis)).toBe(true)
          if (precision.quantity === "3" && precision.mode === "total_value")
            expect(capture?.resolvedPrice?.unitPrice).toEqual({
              amount: "0.333333333333333333",
              rounded: true,
            })
        })
    )
  }

  it.effect("applies a disposition price to proceeds while retaining the acquisition price", () =>
    Effect.gen(function* () {
      const fixture = yield* runPg(seed())
      yield* changePrice({
        operation: "create",
        targetId: fixture.acquisition.targetId,
        input: { _tag: "total_value", amount: "20", currency: EUR },
      })
      const dispositionPrice = yield* changePrice({
        operation: "create",
        targetId: fixture.disposition.targetId,
        input: { _tag: "total_value", amount: "40", currency: EUR },
      })
      expect((yield* recompute(1)).status).toBe("complete")
      const run = yield* readRun(1)
      expect(moneyEquals(run.results[0]?.basis, "20")).toBe(true)
      expect(moneyEquals(run.results[0]?.gain, "20")).toBe(true)
      const capture = run.inputs.find(
        ({ captured }) => captured.history.id === dispositionPrice.overrideId
      )?.captured
      expect(capture?.application).toBe("applied")
      expect(capture?.system.valuationFacts).toHaveLength(1)
      expect(capture?.effective.valuationFacts).toHaveLength(2)
      expect(moneyEquals(capture?.resolvedPrice?.totalValue, "40")).toBe(true)
    })
  )

  it.effect("refuses foreign entry and never relabels an accepted EUR value for a USD run", () =>
    Effect.gen(function* () {
      const fixture = yield* runPg(seed())
      const refused = yield* changePrice({
        operation: "create",
        targetId: fixture.acquisition.targetId,
        input: { _tag: "total_value", amount: "20", currency: USD },
      }).pipe(Effect.result)
      expect(refused).toMatchObject({
        _tag: "Failure",
        failure: { code: "reporting_currency_mismatch" },
      })
      const rows = yield* runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({ id: schema.principalTransactionOverrides.id })
            .from(schema.principalTransactionOverrides)
        })
      )
      expect(rows).toEqual([])
      yield* changePrice({
        operation: "create",
        targetId: fixture.acquisition.targetId,
        input: { _tag: "total_value", amount: "20", currency: EUR },
      })
      const ledger = yield* loadLedger(USD)
      expect(ledger.valuationFacts.some((fact) => fact._tag === "user_valuation")).toBe(false)
      expect(ledger.inputBlockers).toContainEqual(
        expect.objectContaining({
          code: "movement_price_currency_mismatch",
          eventId: fixture.acquisition.id,
        })
      )
      expect(ledger.correctionInputs[0]).toMatchObject({
        application: "needs_attention",
        applicationProblem: "reporting_currency_mismatch",
        reportingCurrency: "USD",
      })
      expect((yield* recompute(1, PRINCIPAL_ID, USD)).status).toBe("partial")
    })
  )
  for (const mismatch of ["quantity", "asset", "direction", "fee", "withheld", "absent"] as const) {
    it.effect(`retains system inputs and truthful attention after ${mismatch} changes`, () =>
      Effect.gen(function* () {
        const fixture = yield* runPg(seed({ systemPurchaseValue: "5" }))
        yield* changePrice({
          operation: "create",
          targetId: fixture.acquisition.targetId,
          input: { _tag: "total_value", amount: "20", currency: EUR },
        })
        yield* runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            if (mismatch === "asset")
              yield* db.insert(schema.assets).values({
                id: CHANGED_ASSET_ID,
                name: "Synthetic changed asset",
                symbol: "OTHER",
                type: "fungible",
              })
            if (mismatch === "absent")
              yield* db
                .delete(schema.transactionLegs)
                .where(eq(schema.transactionLegs.id, fixture.acquisition.id))
            else
              yield* db
                .update(schema.transactionLegs)
                .set(
                  mismatch === "quantity"
                    ? { amount: "11" }
                    : mismatch === "asset"
                      ? { assetId: CHANGED_ASSET_ID }
                      : mismatch === "direction"
                        ? { kind: "disposal" }
                        : mismatch === "fee"
                          ? { kind: "fee" }
                          : { assetRepresentationId: TEST_BTC_REPRESENTATION_ID }
                )
                .where(eq(schema.transactionLegs.id, fixture.acquisition.id))
          })
        )
        const ledger = yield* loadLedger()
        expect(ledger.valuationFacts.some((fact) => fact._tag === "user_valuation")).toBe(false)
        const capture = ledger.correctionInputs[0]
        expect(capture).toMatchObject({
          application: "needs_attention",
          applicationProblem:
            mismatch === "quantity"
              ? "quantity_changed"
              : mismatch === "asset"
                ? "asset_changed"
                : mismatch === "absent"
                  ? "target_unavailable"
                  : mismatch === "withheld"
                    ? "target_ineligible"
                    : "structure_changed",
          resolvedPrice: null,
        })
        expect(capture?.effective).toEqual(capture?.system)
        if (mismatch === "absent" || mismatch === "withheld") {
          expect(capture?.system.event).toBeNull()
          expect(
            ledger.inputBlockers.some(
              (blocker) => blocker.code === "movement_correction_needs_attention"
            )
          ).toBe(false)
        } else {
          expect(ledger.inputBlockers).toContainEqual(
            expect.objectContaining({
              code: "movement_correction_needs_attention",
              eventId: fixture.acquisition.id,
            })
          )
          if (mismatch !== "fee")
            expect(ledger.valuationFacts).toContainEqual(
              expect.objectContaining({
                _tag: "observed_consideration",
                eventId: fixture.acquisition.id,
              })
            )
        }
        expect((yield* recompute(1)).status).toBe("partial")
        const run = yield* readRun(1)
        expect(run.inputs[0]?.captured.applicationProblem).toBe(capture?.applicationProblem)
        expect(ledger.events.some((event) => event.id === fixture.disposition.id)).toBe(true)
      })
    )
  }

  it.effect(
    "keeps provider and market evidence and leaves classification independent while user price wins",
    () =>
      Effect.gen(function* () {
        const fixture = yield* runPg(seed({ systemPurchaseValue: "5" }))
        const accepted = yield* changePrice({
          operation: "create",
          targetId: fixture.acquisition.targetId,
          input: { _tag: "total_value", amount: "20", currency: EUR },
        })
        yield* context.runWithLayer({
          layer: PrincipalTransactionOverrideRepositoryLive,
          effect: Effect.flatMap(PrincipalTransactionOverrideRepository, (repo) =>
            Effect.gen(function* () {
              const found = yield* repo.findContext({
                principalId: PRINCIPAL_ID,
                targetId: fixture.acquisition.targetId,
              })
              if (Option.isNone(found) || found.value.current === null)
                return yield* Effect.die("Missing classification context")
              yield* repo.create({
                principalId: PRINCIPAL_ID,
                actorUserId: USER_ID,
                targetId: fixture.acquisition.targetId,
                expectedSystemRevision: found.value.current.facts.systemRevision,
                expectedLeafId: null,
                reason: "Synthetic independent cause",
                reportingCurrency: EUR,
                input: { _tag: "classification", input: { _tag: "inbound", cause: "gift" } },
              })
            })
          ),
        })
        yield* runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.assetPrices).values({
              assetId: TEST_BTC_ASSET_ID,
              currency: "EUR",
              price: "9",
              timestamp: fixture.timestamp,
              source: "synthetic-market",
            })
          })
        )
        const ledger = yield* loadLedger()
        expect(
          ledger.valuationFacts
            .filter((fact) => fact.eventId === fixture.acquisition.id)
            .map((fact) => fact._tag)
            .sort()
        ).toEqual(["market_quote", "observed_consideration", "user_valuation"])
        expect(ledger.events.find((event) => event.id === fixture.acquisition.id)).toMatchObject({
          _tag: "acquisition",
          cause: "purchase",
        })
        expect((yield* recompute(1)).status).toBe("complete")
        const run = yield* readRun(1)
        expect(moneyEquals(run.results[0]?.basis, "20")).toBe(true)
        const price = run.inputs.find(
          ({ captured }) => captured.history.id === accepted.overrideId
        )?.captured
        const classification = run.inputs.find(
          ({ captured }) => captured.history.kind === "classification"
        )?.captured
        expect(classification?.application).toBe("not_applied")
        expect(classification?.effective).toEqual(price?.effective)
        expect(price?.system.valuationFacts.map((fact) => fact._tag).sort()).toEqual([
          "market_quote",
          "observed_consideration",
        ])
        yield* changePrice({ operation: "withdraw", targetId: fixture.acquisition.targetId })
        expect((yield* recompute(2)).status).toBe("complete")
        expect(moneyEquals((yield* readRun(2)).results[0]?.basis, "5")).toBe(true)
      })
  )
})
