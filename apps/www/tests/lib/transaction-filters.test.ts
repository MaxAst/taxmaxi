import { describe, expect, it } from "vitest"
import {
  transactionFilterInput,
  validateTransactionSearch,
  updateTransactionSearch,
} from "#/lib/transaction-filters"

const A = "00000000-0000-4000-8000-000000000001"
const B = "00000000-0000-4000-8000-000000000002"

describe("transaction filter URL state", () => {
  it.each([
    ["2026-03-29", "2026-03-28T23:00:00.000Z", "2026-03-29T22:00:00.000Z"],
    ["2026-10-25", "2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z"],
  ])("converts inclusive Berlin %s across DST", (date, from, to) => {
    expect(transactionFilterInput({ from: date, to: date, timezone: "Europe/Berlin" })).toEqual({
      from,
      to,
    })
  })

  it.each([
    ["0000-01-01", "0000-01-02"],
    ["0000-02-29", "0000-03-01"],
    ["0000-12-31", "0001-01-01"],
    ["0001-01-01", "0001-01-02"],
    ["0009-12-31", "0010-01-01"],
    ["0010-01-01", "0010-01-02"],
    ["0099-12-31", "0100-01-01"],
    ["0100-01-01", "0100-01-02"],
    ["0999-01-01", "0999-01-02"],
    ["0999-12-31", "1000-01-01"],
    ["1000-01-01", "1000-01-02"],
  ])("keeps exact UTC boundaries across Gregorian year/era widths: %s", (from, next) => {
    expect(
      transactionFilterInput(validateTransactionSearch({ from, to: from, timezone: "UTC" }))
    ).toEqual({ from: `${from}T00:00:00.000Z`, to: `${next}T00:00:00.000Z` })
  })

  it.each([
    ["0000-01-01", "0000-01-02"],
    ["0001-01-01", "0001-01-02"],
  ])("handles era-crossing search probes west of UTC for %s", (from, next) => {
    expect(
      transactionFilterInput(validateTransactionSearch({ from, to: from, timezone: "Etc/GMT+1" }))
    ).toEqual({ from: `${from}T01:00:00.000Z`, to: `${next}T01:00:00.000Z` })
  })

  it("rejects only unrepresentable converted endpoints, preserving earliest to-only dates", () => {
    expect(() => validateTransactionSearch({ from: "0000-01-01", timezone: "Etc/GMT-1" })).toThrow()
    expect(
      transactionFilterInput(
        validateTransactionSearch({ from: "0000-01-02", timezone: "Etc/GMT-1" })
      )
    ).toEqual({ from: "0000-01-01T23:00:00.000Z" })
    expect(
      transactionFilterInput(validateTransactionSearch({ to: "0000-01-01", timezone: "Etc/GMT-1" }))
    ).toEqual({ to: "0000-01-01T23:00:00.000Z" })
  })

  it.each([
    ["UTC", "9999-12-30T00:00:00.000Z", "9999-12-31T00:00:00.000Z"],
    ["America/New_York", "9999-12-30T05:00:00.000Z", "9999-12-31T05:00:00.000Z"],
  ])("preserves the last supported end and final-day start in %s", (timezone, from, to) => {
    expect(
      transactionFilterInput(
        validateTransactionSearch({ from: "9999-12-30", to: "9999-12-30", timezone })
      )
    ).toEqual({ from, to })
    expect(
      transactionFilterInput(validateTransactionSearch({ from: "9999-12-31", timezone }))
    ).toEqual({ from: to })
  })

  it("preserves the maximum local end when the next local year emits a supported UTC endpoint", () => {
    expect(
      transactionFilterInput(
        validateTransactionSearch({ from: "9999-12-31", to: "9999-12-31", timezone: "Etc/GMT-1" })
      )
    ).toEqual({ from: "9999-12-30T23:00:00.000Z", to: "9999-12-31T23:00:00.000Z" })
    expect(
      transactionFilterInput(validateTransactionSearch({ to: "9999-12-31", timezone: "Etc/GMT-1" }))
    ).toEqual({ to: "9999-12-31T23:00:00.000Z" })
  })

  it.each(["UTC", "Etc/GMT+1"])(
    "rejects the maximum local end only when its UTC endpoint exceeds the API year range in %s",
    (timezone) => {
      expect(() => validateTransactionSearch({ to: "9999-12-31", timezone })).toThrow()
    }
  )

  it("folds UUID case before deduplicating source and asset selections", () => {
    const id = "abcdef01-2345-4678-9abc-def012345678"
    expect(
      validateTransactionSearch({
        sourceIds: [id.toUpperCase(), id],
        assetIds: [id, id.toUpperCase()],
      })
    ).toEqual({ sourceIds: [id], assetIds: [id] })
  })

  it("rejects a skipped local day but preserves ranges with real days around it", () => {
    expect(() =>
      validateTransactionSearch({ from: "2011-12-30", to: "2011-12-30", timezone: "Pacific/Apia" })
    ).toThrow()
    expect(
      transactionFilterInput(
        validateTransactionSearch({
          from: "2011-12-29",
          to: "2011-12-31",
          timezone: "Pacific/Apia",
        })
      )
    ).toEqual({ from: "2011-12-29T10:00:00.000Z", to: "2011-12-31T10:00:00.000Z" })
  })

  it("keeps saved timezone independent of the browser timezone", () => {
    const filters = validateTransactionSearch({
      from: "2026-03-29",
      to: "2026-03-29",
      timezone: "Europe/Berlin",
    })
    expect(transactionFilterInput(filters)).toEqual({
      from: "2026-03-28T23:00:00.000Z",
      to: "2026-03-29T22:00:00.000Z",
    })
    expect(transactionFilterInput({ ...filters, timezone: "America/New_York" })).toEqual({
      from: "2026-03-29T04:00:00.000Z",
      to: "2026-03-30T04:00:00.000Z",
    })
  })

  it("round trips typed sets, dates, timezone, order, attention and unrelated keys", () => {
    const search = validateTransactionSearch({
      sourceIds: [B, A, A],
      assetIds: [B],
      categories: ["staking"],
      from: "2026-01-01",
      to: "2026-12-31",
      timezone: "Europe/Berlin",
      order: "oldest",
      attention: true,
      unrelated: "keep",
    })
    expect(search.sourceIds).toEqual([A, B])
    expect(transactionFilterInput(search)).toMatchObject({
      sourceIds: [A, B],
      assetIds: [B],
      categories: ["staking"],
      order: "oldest",
      attention: true,
    })
    expect(updateTransactionSearch(search, { attention: false })).toEqual({
      unrelated: "keep",
      attention: false,
    })
  })

  it.each([
    { sourceIds: ["not-an-id"] },
    { categories: ["made-up"] },
    { attention: "true" },
    { from: "2026-02-30" },
    { from: "9999-12-31", to: "9999-12-31", timezone: "UTC" },
    { to: "9999-12-31", timezone: "UTC" },
    { from: "2026-03-02", to: "2026-03-01" },
    { timezone: "not-a-timezone" },
  ])("rejects invalid external filter state %j", (search) => {
    expect(() => validateTransactionSearch(search)).toThrow()
  })
})
