import { describe, expect, it } from "vitest"
import * as BigDecimal from "effect/BigDecimal"
import { formatTransactionAmount } from "#/lib/transaction-display"

describe("transaction amount display", () => {
  it.each([
    ["0", "€0.00"],
    ["-0.000", "€0.00"],
    ["0.004", "+<€0.01"],
    ["-0.004", "−<€0.01"],
    ["0.000000000000000000001", "+<€0.01"],
    ["-0.009999999999999999999", "−<€0.01"],
    ["0.01", "+€0.01"],
    ["9007199254740993.125", "+€9,007,199,254,740,993.13"],
  ])("formats %s exactly enough to preserve its meaning", (value, expected) => {
    expect(formatTransactionAmount({ value, currency: "EUR", locale: "en" })).toBe(expected)
  })

  // TransactionListRepositoryLive uses this serializer for all decimal fields.
  it.each([
    ["0", "€0.00"],
    ["-0.000", "€0.00"],
    ["0.000000000000000001", "+<€0.01"],
    ["-0.000000000000000001", "−<€0.01"],
    ["0.004", "+<€0.01"],
    ["-0.004", "−<€0.01"],
    ["100000000000000000000", "+€100,000,000,000,000,000,000.00"],
    ["-100000000000000000000", "−€100,000,000,000,000,000,000.00"],
  ])("accepts the server serializer's encoding of %s", (value, expected) => {
    const encoded = BigDecimal.format(BigDecimal.fromStringUnsafe(value))
    expect(formatTransactionAmount({ value: encoded, currency: "EUR", locale: "en" })).toBe(
      expected
    )
  })

  it("uses the requested locale without converting the amount to a number", () => {
    expect(formatTransactionAmount({ value: "-0.004", currency: "EUR", locale: "de" })).toBe(
      "−<0,01 €"
    )
  })

  it.each([null, "", "NaN", "Infinity", "1e", "1e999999999999999999999999"])(
    "keeps missing or invalid %s unavailable",
    (value) => {
      expect(formatTransactionAmount({ value, currency: "EUR", locale: "en" })).toBe("Unavailable")
    }
  )

  it("does not invent a missing currency", () => {
    expect(formatTransactionAmount({ value: "2", currency: null, locale: "en" })).toBe(
      "Unavailable"
    )
  })
})
