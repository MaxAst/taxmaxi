import { describe, expect, it } from "@effect/vitest"
import * as BigDecimal from "effect/BigDecimal"
import * as Schema from "effect/Schema"
import {
  MarketQuoteFact,
  ObservedConsiderationFact,
  UserValuationFact,
  ValuationFact,
} from "../../src/accounting/index.ts"

const decodeObservedConsideration = Schema.decodeUnknownSync(ObservedConsiderationFact)
const decodeMarketQuote = Schema.decodeUnknownSync(MarketQuoteFact)

describe("ValuationFact", () => {
  it("keeps observed consideration distinct from a market quote", () => {
    const observed = decodeObservedConsideration({
      _tag: "observed_consideration",
      eventId: "11111111-1111-4111-8111-111111111111",
      amount: { amount: "30000", currency: "EUR" },
      evidenceReference: "coinbase-transaction-42",
    })
    const quote = decodeMarketQuote({
      _tag: "market_quote",
      eventId: "22222222-2222-4222-8222-222222222222",
      unitPrice: { amount: "30100", currency: "EUR" },
      quotedAt: { epochMillis: 1_700_000_000_000 },
      source: "coingecko",
    })

    expect(observed.amount.toString()).toBe("30000 EUR")
    expect(quote.unitPrice.toString()).toBe("30100 EUR")
  })

  it("rejects crypto asset codes as fiat valuation currency", () => {
    expect(() =>
      decodeObservedConsideration({
        _tag: "observed_consideration",
        eventId: "11111111-1111-4111-8111-111111111111",
        amount: { amount: "1", currency: "BTC" },
        evidenceReference: "coinbase-transaction-42",
      })
    ).toThrow()
  })

  it("rejects negative observed consideration", () => {
    expect(() =>
      decodeObservedConsideration({
        _tag: "observed_consideration",
        eventId: "11111111-1111-4111-8111-111111111111",
        amount: { amount: "-0.01", currency: "EUR" },
        evidenceReference: "coinbase-transaction-42",
      })
    ).toThrow()
  })

  it("accepts zero observed consideration", () => {
    const observed = decodeObservedConsideration({
      _tag: "observed_consideration",
      eventId: "11111111-1111-4111-8111-111111111111",
      amount: { amount: "0", currency: "EUR" },
      evidenceReference: "coinbase-transaction-42",
    })

    expect(observed.amount.toString()).toBe("0 EUR")
  })

  it("rejects a negative market quote", () => {
    expect(() =>
      decodeMarketQuote({
        _tag: "market_quote",
        eventId: "22222222-2222-4222-8222-222222222222",
        unitPrice: { amount: "-0.01", currency: "EUR" },
        quotedAt: { epochMillis: 1_700_000_000_000 },
        source: "coingecko",
      })
    ).toThrow()
  })

  it("rejects a zero market quote", () => {
    expect(() =>
      decodeMarketQuote({
        _tag: "market_quote",
        eventId: "22222222-2222-4222-8222-222222222222",
        unitPrice: { amount: "0", currency: "EUR" },
        quotedAt: { epochMillis: 1_700_000_000_000 },
        source: "coingecko",
      })
    ).toThrow()
  })
  it("preserves exact resolved user totals and their own evidence kind", () => {
    for (const amount of ["0", "1", "9007199254740993", "0.000000000000000001"]) {
      const value = Schema.decodeUnknownSync(ValuationFact)({
        _tag: "user_valuation",
        eventId: "11111111-1111-4111-8111-111111111111",
        amount: { amount, currency: "EUR" },
        evidenceReference: "synthetic-correction:1",
      })
      expect(value._tag).toBe("user_valuation")
      if (value._tag !== "user_valuation") return
      expect(BigDecimal.equals(value.amount.amount, BigDecimal.fromStringUnsafe(amount))).toBe(true)
      expect(value.evidenceReference).toBe("synthetic-correction:1")
      expect(Schema.encodeSync(ValuationFact)(value)).toMatchObject({
        _tag: "user_valuation",
        amount: { amount: BigDecimal.format(BigDecimal.fromStringUnsafe(amount)), currency: "EUR" },
      })
    }
  })

  it("rejects negative or non-fiat user amounts and missing references", () => {
    const valid = {
      _tag: "user_valuation",
      eventId: "11111111-1111-4111-8111-111111111111",
      amount: { amount: "1", currency: "EUR" },
      evidenceReference: "synthetic-correction:1",
    }
    const decode = Schema.decodeUnknownSync(UserValuationFact)
    for (const invalid of [
      { ...valid, amount: { amount: "-1", currency: "EUR" } },
      { ...valid, amount: { amount: "1", currency: "BTC" } },
      { ...valid, amount: { amount: "NaN", currency: "EUR" } },
      { ...valid, evidenceReference: "" },
    ])
      expect(() => decode(invalid)).toThrow()
  })
})
