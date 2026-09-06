import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  MovementClassificationInput,
  MovementCorrectionFacts,
  MovementCorrectionInput,
  MovementPriceInput,
  movementCorrectionCompatibility,
  resolveMovementPrice,
  validateMovementClassification,
} from "../../src/accounting/index.ts"
import { EUR } from "../../src/currency/CurrencyCode.ts"

const decodeFacts = Schema.decodeUnknownSync(MovementCorrectionFacts)
const decodePrice = Schema.decodeUnknownSync(MovementPriceInput)
const decodeClassification = Schema.decodeUnknownSync(MovementClassificationInput)
const baseFacts = {
  target: {
    principalId: "11111111-1111-4111-8111-111111111111",
    sourceId: "22222222-2222-4222-8222-222222222222",
    sourceRecordKey: "synthetic-record-1",
    componentKey: "receipt",
  },
  systemRevision: "revision-1",
  quantity: "3",
  economicAssetId: "33333333-3333-4333-8333-333333333333",
  direction: "inbound",
  structure: "ownership_change",
}
const facts = decodeFacts(baseFacts)
const resolvePrice = (input: unknown, quantity = "3") =>
  Effect.runSync(
    resolveMovementPrice({
      input: decodePrice(input),
      facts: decodeFacts({ ...baseFacts, quantity }),
      reportingCurrency: EUR,
    })
  )

describe("MovementCorrection", () => {
  it("retains the entered total instead of round-tripping through a unit preview", () => {
    const result = resolvePrice({ _tag: "total_value", amount: "1", currency: "EUR" })
    expect(result.totalValue).toBe("1")
    expect(result.unitPrice).toEqual({ amount: "0.333333333333333333", rounded: true })
    expect(Schema.encodeSync(MovementPriceInput)(result.input)).toEqual({
      _tag: "total_value",
      amount: "1",
      currency: "EUR",
    })
  })

  it.each(["9007199254740993", "0.000000000000000001", "0", "1.2300"])(
    "preserves exact entered amount %s in both modes",
    (amount) => {
      for (const _tag of ["unit_price", "total_value"]) {
        const result = resolvePrice({ _tag, amount, currency: "EUR" }, "1")
        expect(result.input.amount).toBe(amount)
        expect(result.unitPrice.rounded).toBe(false)
        if (_tag === "total_value") expect(result.totalValue).toBe(amount)
      }
    }
  )

  it("multiplies unit entry exactly by the server quantity", () => {
    expect(
      resolvePrice({ _tag: "unit_price", amount: "2", currency: "EUR" }, "10").totalValue
    ).toBe("20")
    expect(
      resolvePrice({ _tag: "unit_price", amount: "9007199254740993", currency: "EUR" }, "10")
        .totalValue
    ).toBe("90071992547409930")
    expect(
      resolvePrice({ _tag: "unit_price", amount: "0.000000000000000001", currency: "EUR" }, "0.1")
        .totalValue
    ).toBe("0.0000000000000000001")
  })

  it("rounds repeating previews half away from zero and retains terminating precision", () => {
    expect(resolvePrice({ _tag: "total_value", amount: "2", currency: "EUR" }).unitPrice).toEqual({
      amount: "0.666666666666666667",
      rounded: true,
    })
    expect(
      resolvePrice({ _tag: "total_value", amount: "0.000000000000000001", currency: "EUR" }, "2")
        .unitPrice
    ).toEqual({ amount: "0.0000000000000000005", rounded: false })
    expect(
      resolvePrice({ _tag: "total_value", amount: "1", currency: "EUR" }, "0.25").unitPrice
    ).toEqual({ amount: "4", rounded: false })
  })

  it.each([null, "-1", "NaN", "Infinity", "1e3", "1,5", 2, ""])(
    "rejects invalid amount %s",
    (amount) => {
      expect(() => decodePrice({ _tag: "unit_price", amount, currency: "EUR" })).toThrow()
    }
  )

  it.each(["USDC", "BTC", "ZZZ", "eur"])("rejects invalid/non-fiat currency %s", (currency) => {
    expect(() => decodePrice({ _tag: "unit_price", amount: "1", currency })).toThrow()
  })

  it("rejects a supported currency different from the calculation context", () => {
    const result = Effect.runSync(
      Effect.flip(
        resolveMovementPrice({
          input: decodePrice({ _tag: "total_value", amount: "1", currency: "USD" }),
          facts,
          reportingCurrency: EUR,
        })
      )
    )
    expect(result.code).toBe("reporting_currency_mismatch")
  })

  it("rejects conflicting modes and forbidden payload additions", () => {
    expect(() =>
      decodePrice({ _tag: "unit_price", amount: "1", currency: "EUR", total_value: "2" })
    ).toThrow()
    expect(() => decodePrice({ unit_price: "1", total_value: "2", currency: "EUR" })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(MovementCorrectionInput)({
        _tag: "classification",
        input: { _tag: "inbound", cause: "purchase" },
        taxable: false,
      })
    ).toThrow()
    expect(() =>
      decodeClassification({ _tag: "inbound", cause: "purchase", treatmentCode: "de.exempt" })
    ).toThrow()
  })

  it.each(["0", "-1"])("requires a positive server quantity %s", (quantity) => {
    expect(() => decodeFacts({ ...baseFacts, quantity })).toThrow()
  })

  it.each([
    "purchase",
    "gift",
    "airdrop",
    "mining_reward",
    "staking_reward",
    "passive_staking_reward",
    "reward",
    "payment",
    "unknown",
  ])("accepts supported inbound assertion %s", (cause) => {
    const input = decodeClassification({ _tag: "inbound", cause })
    expect(Effect.runSync(validateMovementClassification({ input, facts }))).toBeUndefined()
  })

  it.each(["sale", "gift", "payment", "unknown"])(
    "accepts supported outbound assertion %s",
    (cause) => {
      expect(
        Effect.runSync(
          validateMovementClassification({
            input: decodeClassification({ _tag: "outbound", cause }),
            facts: decodeFacts({ ...baseFacts, direction: "outbound" }),
          })
        )
      ).toBeUndefined()
    }
  )

  it("rejects wrong-direction, fee, custody and direct treatment causes", () => {
    for (const input of [
      { _tag: "inbound", cause: "sale" },
      { _tag: "outbound", cause: "purchase" },
      { _tag: "outbound", cause: "fee" },
      { _tag: "inbound", cause: "custody_movement" },
      { _tag: "inbound", cause: "de.taxable_income_section22_3_staking" },
    ])
      expect(() => decodeClassification(input)).toThrow()
    const input = decodeClassification({ _tag: "outbound", cause: "sale" })
    expect(Effect.runSync(Effect.flip(validateMovementClassification({ input, facts }))).code).toBe(
      "classification_direction_mismatch"
    )
    for (const structure of ["fee", "custody"]) {
      const current = decodeFacts({ ...baseFacts, direction: "outbound", structure })
      expect(
        Effect.runSync(Effect.flip(validateMovementClassification({ input, facts: current }))).code
      ).toBe(structure === "fee" ? "fee_classification_forbidden" : "custody_correction_forbidden")
    }
  })

  it("allows fee prices but refuses custody replacement valuation", () => {
    const input = decodePrice({ _tag: "total_value", amount: "0", currency: "EUR" })
    expect(
      Effect.runSync(
        resolveMovementPrice({
          input,
          reportingCurrency: EUR,
          facts: decodeFacts({ ...baseFacts, direction: "outbound", structure: "fee" }),
        })
      ).totalValue
    ).toBe("0")
    expect(
      Effect.runSync(
        Effect.flip(
          resolveMovementPrice({
            input,
            reportingCurrency: EUR,
            facts: decodeFacts({ ...baseFacts, structure: "custody" }),
          })
        )
      ).code
    ).toBe("custody_correction_forbidden")
  })

  it("keeps ordinary system changes applicable and visibly stale", () => {
    expect(movementCorrectionCompatibility({ inspected: facts, current: facts })).toEqual({
      _tag: "applicable",
      stale: false,
    })
    expect(
      movementCorrectionCompatibility({
        inspected: facts,
        current: decodeFacts({ ...baseFacts, quantity: "3.00", systemRevision: "revision-2" }),
      })
    ).toEqual({ _tag: "applicable", stale: true })
  })

  it("withholds changed structures without retargeting equal-amount siblings", () => {
    for (const [patch, reason] of [
      [{ quantity: "4" }, "quantity_changed"],
      [{ economicAssetId: null }, "asset_changed"],
      [{ direction: "outbound" }, "structure_changed"],
      [{ structure: "custody" }, "structure_changed"],
      [{ target: { ...baseFacts.target, componentKey: "other-receipt" } }, "target_changed"],
      [{ target: { ...baseFacts.target, sourceRecordKey: "record-2" } }, "target_changed"],
      [
        { target: { ...baseFacts.target, principalId: "44444444-4444-4444-8444-444444444444" } },
        "target_changed",
      ],
      [
        { target: { ...baseFacts.target, sourceId: "55555555-5555-4555-8555-555555555555" } },
        "target_changed",
      ],
    ] as const) {
      expect(
        movementCorrectionCompatibility({
          inspected: facts,
          current: decodeFacts({ ...baseFacts, ...patch }),
        })
      ).toEqual({ _tag: "needs_attention", reason })
    }
    expect(movementCorrectionCompatibility({ inspected: facts, current: null })).toEqual({
      _tag: "needs_attention",
      reason: "target_disappeared",
    })
  })
})
