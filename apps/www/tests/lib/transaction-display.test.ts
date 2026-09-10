import { describe, expect, it } from "vitest"
import * as BigDecimal from "effect/BigDecimal"
import { formatTransactionAmount, transactionMovementFacts } from "#/lib/transaction-display"

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

describe("captured movement presentation", () => {
  const movement = {
    targetId: "target",
    amount: "1",
    assetSymbol: "BTC",
    kind: "acquisition" as const,
    capture: {
      runId: "run",
      eventId: "event",
      outcome: "included" as const,
      quantity: "1",
      assetId: "btc",
      assetSymbol: "BTC",
      eventKind: "acquisition" as const,
      cause: "purchase",
      valuationState: "selected" as const,
      selectedValue: { kind: "market_quote" as const, amount: "22", currency: "EUR" },
      providerConsiderations: [{ amount: "20", currency: "USD" }],
      acquisitionCostBasis: null,
      realizedResults: [],
    },
  }

  it("keeps provider paid currency apart from selected market valuation and absent basis", () => {
    const result = transactionMovementFacts(movement)
    expect(result).toContainEqual({ label: "Paid", amount: "+$20.00" })
    expect(result).toContainEqual({ label: "Market valuation", amount: "+€22.00" })
    expect(result.some((fact) => fact.label === "Cost basis")).toBe(false)
  })

  it("keeps custody provider amounts neutral", () => {
    const result = transactionMovementFacts({
      ...movement,
      capture: {
        ...movement.capture,
        cause: null,
        eventKind: "custody_movement",
        selectedValue: null,
      },
    })
    expect(result).toContainEqual({ label: "Provider amount", amount: "+$20.00" })
    expect(result.some((fact) => fact.label === "Paid" || fact.label === "Received")).toBe(false)
  })

  it("sums only recorded disposal allocations and keeps proceeds separate from gain", () => {
    const result = transactionMovementFacts({
      ...movement,
      kind: "disposal",
      capture: {
        ...movement.capture,
        cause: "sale",
        eventKind: "disposition",
        providerConsiderations: [{ amount: "30", currency: "EUR" }],
        selectedValue: { kind: "observed_consideration", amount: "30", currency: "EUR" },
        realizedResults: [
          {
            acquisitionEventId: "a",
            quantity: "0.5",
            costBasis: "8",
            proceeds: "12",
            gainLoss: "4",
            currency: "EUR",
          },
          {
            acquisitionEventId: "b",
            quantity: "0.5",
            costBasis: "12",
            proceeds: "18",
            gainLoss: "6",
            currency: "EUR",
          },
        ],
      },
    })
    expect(result).toContainEqual({ label: "Proceeds", amount: "+€30.00" })
    expect(result).toContainEqual({ label: "Cost basis", amount: "+€20.00" })
    // Gain remains the separately supplied row total, not another copy of proceeds.
    expect(result.some((fact) => fact.label === "Gain/loss")).toBe(false)
  })

  it.each([
    null,
    {
      ...movement.capture,
      outcome: "withheld" as const,
      eventKind: null,
      cause: null,
      selectedValue: null,
      valuationState: "not_evaluated" as const,
      providerConsiderations: [],
    },
  ])("keeps uncaptured or withheld value unavailable", (capture) => {
    expect(transactionMovementFacts({ ...movement, capture })).toContainEqual({
      label: "Value",
      amount: "Unavailable",
    })
  })

  it("sums scientific allocation strings exactly", () => {
    const tiny = BigDecimal.format(BigDecimal.fromStringUnsafe("0.000000000000000001"))
    const result = transactionMovementFacts({
      ...movement,
      kind: "disposal",
      capture: {
        ...movement.capture,
        eventKind: "disposition",
        cause: "sale",
        providerConsiderations: [],
        selectedValue: null,
        realizedResults: [
          {
            acquisitionEventId: "a",
            quantity: "0.5",
            costBasis: "0",
            proceeds: tiny,
            gainLoss: tiny,
            currency: "EUR",
          },
          {
            acquisitionEventId: "b",
            quantity: "0.5",
            costBasis: "0",
            proceeds: tiny,
            gainLoss: tiny,
            currency: "EUR",
          },
        ],
      },
    })
    expect(result).toContainEqual({ label: "Proceeds", amount: "+<€0.01" })
    expect(result).toContainEqual({ label: "Cost basis", amount: "€0.00" })
  })

  it("preserves zero fee value and leaves missing fee value unavailable", () => {
    expect(
      transactionMovementFacts({
        ...movement,
        kind: "fee",
        capture: {
          ...movement.capture,
          cause: "fee",
          eventKind: "disposition",
          providerConsiderations: [],
          selectedValue: { kind: "market_quote", amount: "0", currency: "EUR" },
        },
      })
    ).toContainEqual({ label: "Fee valuation", amount: "€0.00" })
    expect(transactionMovementFacts({ ...movement, kind: "fee", capture: null })).toContainEqual({
      label: "Fee value",
      amount: "Unavailable",
    })
  })
})
