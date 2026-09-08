// @vitest-environment jsdom

import {
  TaxMaxiError,
  type Account,
  type BillingStatus,
  type SourceList,
  type SourceOverview,
} from "taxmaxi"
import { describe, expect, it, vi } from "vitest"

import { loadAppPageData } from "#/routes/app"

vi.mock("#/server-functions/auth", () => ({
  clearAuthSessionCookie: vi.fn(),
  getAuthStatus: vi.fn(),
}))

const SOURCE_A = "00000000-0000-4000-8000-000000000201"
const SOURCE_B = "00000000-0000-4000-8000-000000000202"

const account: Account = {
  account: {
    id: "00000000-0000-4000-8000-000000000001",
    email: "user@example.test",
    displayName: "User",
    role: "member",
    emailVerified: true,
    welcomeSeenAt: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  },
  loginMethods: [],
}

const billing: BillingStatus = {
  credits: 1,
  subscriptionStatus: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
}

const source = (id: string): SourceList["sources"][number] => ({
  id,
  principalId: "00000000-0000-4000-8000-000000000002",
  name: `Source ${id.slice(-1)}`,
  providerKey: "evm",
  sourceRef: { _tag: "onchain", addressId: `00000000-0000-4000-8000-00000000030${id.slice(-1)}` },
  createdAt: { epochMillis: 1_735_689_600_000 },
})

const sourceList: SourceList = { sources: [source(SOURCE_A), source(SOURCE_B)] }

const overview = (sourceId: string): SourceOverview => ({
  calculationRunId: null,
  source: source(sourceId),
  latestSync: {
    jobId: null,
    status: null,
    mode: null,
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    lastSyncedAt: null,
    lastErrorMessage: null,
    fetchedRecords: null,
    normalizedRecords: null,
    failedRecords: null,
  },
  totals: {
    transactionCount: 0,
    legCount: 0,
    assetCount: 0,
    fifoLotCount: 0,
    disposalCount: 0,
    incomeCount: 0,
    feeCount: 0,
    realizedGainLoss: "0",
    incomeTotal: "0",
    currency: null,
  },
  review: { status: "ok", needsReviewCount: 0, blockingIssueCount: 0, issues: [] },
})

const unauthorized = () => new TaxMaxiError({ message: "Sign in again.", status: 401 })
const unavailable = () => new TaxMaxiError({ message: "Unavailable.", status: 500 })

const rejectLater = <T>(error: unknown): Promise<T> =>
  new Promise((_, reject) => {
    setTimeout(() => reject(error), 0)
  })

const loaders = (overrides: Partial<Parameters<typeof loadAppPageData>[0]> = {}) => ({
  loadAccount: vi.fn().mockResolvedValue(account),
  loadBilling: vi.fn().mockResolvedValue(billing),
  loadSourceOverview: vi.fn(async (sourceId: string) => overview(sourceId)),
  loadSources: vi.fn().mockResolvedValue(sourceList),
  ...overrides,
})

describe("loadAppPageData (#108 D08)", () => {
  it("loads sources, one overview per source, the account, and billing", async () => {
    const input = loaders()

    const result = await loadAppPageData(input)

    expect(result.sourceList).toBe(sourceList)
    expect(result.overviews.map((item) => item.source.id)).toEqual([SOURCE_A, SOURCE_B])
    expect(result.account).toBe(account)
    expect(result.billing).toBe(billing)
    expect(input.loadSourceOverview).toHaveBeenCalledTimes(2)
    expect(input.loadAccount).toHaveBeenCalledTimes(1)
    expect(input.loadBilling).toHaveBeenCalledTimes(1)
  })

  it("returns billing: null when billing fails for a non-401 reason", async () => {
    const result = await loadAppPageData(
      loaders({ loadBilling: vi.fn().mockRejectedValue(new Error("Stripe is unavailable")) })
    )

    expect(result.billing).toBeNull()
    expect(result.account).toBe(account)
    expect(result.overviews).toHaveLength(2)
  })

  it("rethrows a 401 from billing", async () => {
    const error = unauthorized()

    await expect(
      loadAppPageData(loaders({ loadBilling: vi.fn().mockRejectedValue(error) }))
    ).rejects.toBe(error)
  })

  it("rethrows a 401 from the account read", async () => {
    const error = unauthorized()

    await expect(
      loadAppPageData(loaders({ loadAccount: vi.fn().mockRejectedValue(error) }))
    ).rejects.toBe(error)
  })

  it("rethrows a 401 from the sources read once a slower billing read has settled", async () => {
    const error = unauthorized()
    let releaseBilling: (status: BillingStatus) => void = () => undefined
    const pendingBilling = new Promise<BillingStatus>((resolve) => {
      releaseBilling = resolve
    })

    const pending = loadAppPageData(
      loaders({
        loadBilling: vi.fn().mockReturnValue(pendingBilling),
        loadSources: vi.fn().mockRejectedValue(error),
      })
    )

    releaseBilling(billing)
    await expect(pending).rejects.toBe(error)
  })

  it("prefers a later 401 from billing over an earlier 500 from the sources read", async () => {
    const error = unauthorized()

    await expect(
      loadAppPageData(
        loaders({
          loadBilling: vi.fn().mockReturnValue(rejectLater<BillingStatus>(error)),
          loadSources: vi.fn().mockRejectedValue(unavailable()),
        })
      )
    ).rejects.toBe(error)
  })

  it("rethrows a non-401 sources failure, not the billing failure, when both fail", async () => {
    const error = unavailable()

    await expect(
      loadAppPageData(
        loaders({
          loadBilling: vi.fn().mockRejectedValue(new Error("Stripe is unavailable")),
          loadSources: vi.fn().mockRejectedValue(error),
        })
      )
    ).rejects.toBe(error)
  })
})
