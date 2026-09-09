// @vitest-environment jsdom

import { CancelledError, QueryClient } from "@tanstack/react-query"
import {
  TaxMaxi,
  TaxMaxiError,
  type Account,
  type BillingStatus,
  type SourceList,
  type SourceOverview,
} from "taxmaxi"
import { describe, expect, it, vi } from "vitest"

import { clearSessionQueries, queryKeys } from "#/integrations/taxmaxi/queries"
import { Route, loadAppPageData } from "#/routes/app"

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

  it("prefers a later 401 from one overview over an earlier 500 from another", async () => {
    const error = unauthorized()

    await expect(
      loadAppPageData(
        loaders({
          loadSourceOverview: vi.fn((sourceId: string) =>
            sourceId === SOURCE_A
              ? Promise.reject(unavailable())
              : rejectLater<SourceOverview>(error)
          ),
        })
      )
    ).rejects.toBe(error)
  })

  it("rethrows the first overview failure in source order when none is a 401", async () => {
    const error = unavailable()

    await expect(
      loadAppPageData(
        loaders({
          loadSourceOverview: vi.fn((sourceId: string) =>
            sourceId === SOURCE_A
              ? rejectLater<SourceOverview>(error)
              : Promise.reject(new Error("Overview B is unavailable"))
          ),
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

// A session change (`clearSessionQueries`) must cancel the loader's reads, so
// a response that resolves after the clear cannot refill the cache with the
// previous person's data (#133, PR #360 review finding 3967706889).
describe("the /app route loader across a session change", () => {
  it("does not write a source list whose request was cancelled by clearSessionQueries", async () => {
    let releaseSources: () => void = () => undefined
    const sourcesReleased = new Promise<void>((resolve) => {
      releaseSources = resolve
    })
    const requestedPaths: Array<string> = []
    const taxmaxi = TaxMaxi.fromBrowserSession({
      baseUrl: "https://loader.example.test",
      fetch: async (input) => {
        const path = new URL(input instanceof Request ? input.url : input.toString()).pathname
        requestedPaths.push(path)
        if (path === "/v1/sources") return sourcesReleased.then(() => Response.json(sourceList))
        return Response.json(overview(path.split("/")[3] ?? ""))
      },
    })
    const queryClient = new QueryClient()
    // Account and billing are cached and fresh, so the source list is the only read.
    queryClient.setQueryData(queryKeys.account(), account)
    queryClient.setQueryData(queryKeys.billingStatus(), billing)
    const loader = Route.options.loader
    expect(loader).toBeTypeOf("function")
    if (typeof loader !== "function") return

    const load = Promise.resolve(
      loader({
        abortController: new AbortController(),
        cause: "enter",
        context: { queryClient, taxmaxi: () => taxmaxi },
        deps: {},
        location: {
          external: false,
          hash: "",
          href: "/app",
          pathname: "/app",
          publicHref: "/app",
          search: {},
          searchStr: "",
          state: { __TSR_index: 0 },
        },
        navigate: () => Promise.resolve(),
        params: {},
        parentMatchPromise: new Promise<never>(() => undefined),
        preload: false,
        route: Route,
      })
    )
    await vi.waitFor(() => expect(requestedPaths).toEqual(["/v1/sources"]))

    // Person A's load is abandoned and person B's login clears the session.
    await clearSessionQueries(queryClient)
    // A's source list arrives after the clear.
    releaseSources()
    const outcome = await load.then(
      () => "resolved",
      (error: unknown) => error
    )

    expect(queryClient.getQueryData(queryKeys.sourceList())).toBeUndefined()
    expect(queryClient.getQueryCache().findAll({ queryKey: queryKeys.all })).toHaveLength(0)
    expect(outcome).toBeInstanceOf(CancelledError)
    expect(requestedPaths).toEqual(["/v1/sources"])
    queryClient.clear()
  })
})
