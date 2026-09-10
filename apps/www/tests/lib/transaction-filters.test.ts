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
    { from: "2026-03-02", to: "2026-03-01" },
    { timezone: "not-a-timezone" },
  ])("rejects invalid external filter state %j", (search) => {
    expect(() => validateTransactionSearch(search)).toThrow()
  })
})
