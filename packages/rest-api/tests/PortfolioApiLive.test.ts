import type * as BigDecimal from "effect/BigDecimal"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import {
  PortfolioCalculationStatusQuery,
  PortfolioAssetRow,
  PortfolioCurrency,
  PortfolioSummary,
} from "../src/definitions/PortfolioApi.ts"
import { makePortfolioAssetRow, makePortfolioSummary } from "../src/layers/PortfolioApiLive.ts"

const encodeSummary = Schema.encodeSync(PortfolioSummary)
const encodeAsset = Schema.encodeSync(PortfolioAssetRow)

const decodeDecimal = Schema.decodeSync(Schema.BigDecimalFromString)

const decodeNullableDecimal = (value: string | null): BigDecimal.BigDecimal | null =>
  value === null ? null : decodeDecimal(value)

const makeAsset = ({
  assetId,
  profitLoss,
  totalValue,
}: {
  readonly assetId: string
  readonly profitLoss: string | null
  readonly totalValue: string | null
}) =>
  PortfolioAssetRow.make({
    assetId,
    symbol: assetId,
    name: assetId,
    logoUrl: null,
    amount: decodeDecimal("1"),
    currentPrice: decodeNullableDecimal(totalValue),
    totalValue: decodeNullableDecimal(totalValue),
    profitLoss: decodeNullableDecimal(profitLoss),
  })

describe("makePortfolioSummary", () => {
  it("keeps aggregate values unavailable when an asset is unpriced", () => {
    const summary = makePortfolioSummary([
      makeAsset({ assetId: "one", totalValue: "100.1", profitLoss: "20.1" }),
      makeAsset({ assetId: "two", totalValue: "49.9", profitLoss: "-5.1" }),
      makeAsset({ assetId: "unpriced", totalValue: null, profitLoss: null }),
    ])

    expect(encodeSummary(summary)).toEqual({
      totalValue: null,
      costBasis: null,
      profitLoss: null,
      profitLossPercentage: null,
    })
  })

  it("aggregates decimal values without floating-point rounding", () => {
    const summary = makePortfolioSummary([
      makeAsset({ assetId: "one", totalValue: "100.1", profitLoss: "20.1" }),
      makeAsset({ assetId: "two", totalValue: "49.9", profitLoss: "-5.1" }),
    ])

    expect(encodeSummary(summary)).toEqual({
      totalValue: "150",
      costBasis: "135",
      profitLoss: "15",
      profitLossPercentage: "11.11111111",
    })
  })

  it("omits the percentage when cost basis is zero", () => {
    const summary = makePortfolioSummary([
      makeAsset({ assetId: "zero", totalValue: "0", profitLoss: "0" }),
    ])

    expect(summary.profitLossPercentage).toBeNull()
  })

  it("keeps aggregate profit and cost basis unavailable when a priced asset has no P/L", () => {
    const summary = makePortfolioSummary([
      makeAsset({ assetId: "known", totalValue: "100", profitLoss: "25" }),
      makeAsset({ assetId: "unknown", totalValue: "50", profitLoss: null }),
    ])

    expect(encodeSummary(summary)).toEqual({
      totalValue: "150",
      costBasis: null,
      profitLoss: null,
      profitLossPercentage: null,
    })
  })
})

describe("makePortfolioAssetRow", () => {
  it("keeps known zero basis and signed sub-cent values for combined positions", () => {
    const asset = makePortfolioAssetRow({
      position: {
        assetId: "btc",
        symbol: "BTC",
        name: "Bitcoin",
        logoUrl: null,
        coingeckoCoinId: "bitcoin",
        amount: "13",
        costBasis: "0",
        costBasisCurrency: "EUR",
        costBasisStatus: "known",
      },
      market: { price: "0.00001", logoUrl: "https://example.com/btc.png" },
      currency: "eur",
    })
    expect(encodeAsset(asset)).toMatchObject({
      amount: "13",
      totalValue: "0.00013",
      profitLoss: "0.00013",
    })
    expect(encodeSummary(makePortfolioSummary([asset]))).toEqual({
      totalValue: "0.00013",
      costBasis: "0",
      profitLoss: "0.00013",
      profitLossPercentage: null,
    })
  })

  it("suppresses unrealized profit when the position has pending cost basis", () => {
    const asset = makePortfolioAssetRow({
      position: {
        assetId: "btc",
        symbol: "BTC",
        name: "Bitcoin",
        logoUrl: null,
        coingeckoCoinId: "bitcoin",
        amount: "0.25",
        costBasis: null,
        costBasisCurrency: null,
        costBasisStatus: "pending_review",
      },
      market: { price: "50000", logoUrl: "https://example.com/btc.png" },
      currency: "eur",
    })

    expect(encodeAsset(asset)).toMatchObject({
      amount: "0.25",
      currentPrice: "50000",
      totalValue: "12500",
      profitLoss: null,
    })
  })
})

describe("PortfolioCurrency", () => {
  it("normalizes uppercase ISO currency codes", () => {
    expect(Schema.decodeSync(PortfolioCurrency)("EUR")).toBe("eur")
  })

  it("rejects values that are not three letters", () => {
    expect(() => Schema.decodeSync(PortfolioCurrency)("EURO")).toThrow()
  })
})

describe("PortfolioCalculationStatusQuery", () => {
  const decode = Schema.decodeUnknownSync(PortfolioCalculationStatusQuery)

  it("requires an explicit selected year and retains an optional exact job", () => {
    const sourceJobId = "00000000-0000-4000-8000-000000000001"
    expect(decode({ taxYear: "2024", sourceJobId })).toEqual({ taxYear: 2024, sourceJobId })
    expect(decode({ taxYear: "2025" })).toEqual({ taxYear: 2025 })
  })

  it.each([
    {},
    { taxYear: "no" },
    { taxYear: "2024.5" },
    { taxYear: "Infinity" },
    { taxYear: "2024", sourceJobId: "not-a-job-id" },
  ])("rejects malformed selection %j", (query) => {
    expect(() => decode(query)).toThrow()
  })
})
