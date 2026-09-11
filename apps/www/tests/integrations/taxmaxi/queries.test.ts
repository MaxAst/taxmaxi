// @vitest-environment jsdom

import { QueryClient, QueryObserver } from "@tanstack/react-query"
import { TaxMaxi, type Account } from "taxmaxi"
import { describe, expect, it, vi } from "vitest"

import {
  queries,
  clearSessionQueries,
  prefetchTransactionPage,
  queryKeys,
  refreshTransactionQueries,
  setSessionQueryData,
} from "#/integrations/taxmaxi/queries"

const getRequestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") {
    return input
  }

  return input instanceof URL ? input.toString() : input.url
}

describe("asset catalog infinite queries", () => {
  it("forwards the approved page cursor returned by the previous response", async () => {
    const requestedUrls: Array<string> = []
    const responseBodies = [
      { assets: [], page: { hasMore: true, nextCursor: "approved-page-2" } },
      { assets: [], page: { hasMore: false, nextCursor: null } },
    ]
    const taxmaxi = new TaxMaxi({
      apiKey: "",
      baseUrl: "https://catalog.example.test",
      fetch: async (input) => {
        requestedUrls.push(getRequestUrl(input))
        return Response.json(responseBodies.shift(), { status: 200 })
      },
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    const result = await queryClient.fetchInfiniteQuery({
      ...queries.assetList(taxmaxi, { limit: 1, query: "btc" }),
      pages: 2,
    })

    expect(result.pages).toHaveLength(2)
    expect(result.pageParams).toEqual([null, "approved-page-2"])
    expect(requestedUrls).toEqual([
      "https://catalog.example.test/v1/assets?q=btc&limit=1",
      "https://catalog.example.test/v1/assets?q=btc&cursor=approved-page-2&limit=1",
    ])
  })

  it("forwards the pending page cursor returned by the previous response", async () => {
    const requestedUrls: Array<string> = []
    const responseBodies = [
      { pendingAssets: [], page: { hasMore: true, nextCursor: "pending-page-2" } },
      { pendingAssets: [], page: { hasMore: false, nextCursor: null } },
    ]
    const taxmaxi = new TaxMaxi({
      apiKey: "",
      baseUrl: "https://catalog.example.test",
      fetch: async (input) => {
        requestedUrls.push(getRequestUrl(input))
        return Response.json(responseBodies.shift(), { status: 200 })
      },
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    const result = await queryClient.fetchInfiniteQuery({
      ...queries.pendingAssetList(taxmaxi, {
        limit: 1,
        provider: "coinbase",
        query: "eth",
      }),
      pages: 2,
    })

    expect(result.pages).toHaveLength(2)
    expect(result.pageParams).toEqual([null, "pending-page-2"])
    expect(requestedUrls).toEqual([
      "https://catalog.example.test/v1/assets/pending?q=eth&provider=coinbase&limit=1",
      "https://catalog.example.test/v1/assets/pending?q=eth&provider=coinbase&cursor=pending-page-2&limit=1",
    ])
  })

  it.each(["approved", "pending"] as const)(
    "aborts the %s asset request when React Query cancels it",
    async (feed) => {
      let requestSignal: AbortSignal | undefined
      const taxmaxi = new TaxMaxi({
        apiKey: "",
        baseUrl: "https://catalog.example.test",
        fetch: async (input, init) => {
          requestSignal = input instanceof Request ? input.signal : (init?.signal ?? undefined)
          return new Promise<Response>((_resolve, reject) => {
            requestSignal?.addEventListener(
              "abort",
              () => reject(new DOMException("Request aborted", "AbortError")),
              { once: true }
            )
          })
        },
      })
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      const controller = new AbortController()
      const runQuery = () => {
        if (feed === "approved") {
          const options = queries.assetList(taxmaxi)
          const queryFn = options.queryFn
          expect(queryFn).toBeTypeOf("function")
          if (typeof queryFn !== "function") {
            return Promise.resolve(undefined)
          }
          return Promise.resolve(
            queryFn({
              client: queryClient,
              direction: "forward",
              meta: undefined,
              pageParam: null,
              queryKey: options.queryKey,
              signal: controller.signal,
            })
          )
        }

        const options = queries.pendingAssetList(taxmaxi)
        const queryFn = options.queryFn
        expect(queryFn).toBeTypeOf("function")
        if (typeof queryFn !== "function") {
          return Promise.resolve(undefined)
        }
        return Promise.resolve(
          queryFn({
            client: queryClient,
            direction: "forward",
            meta: undefined,
            pageParam: null,
            queryKey: options.queryKey,
            signal: controller.signal,
          })
        )
      }
      const request = runQuery().catch((error: unknown) => error)

      await vi.waitFor(() => expect(requestSignal).toBeDefined())
      controller.abort()

      await vi.waitFor(() => expect(requestSignal?.aborted).toBe(true))
      expect(await request).toBeDefined()
    }
  )
})

describe("transaction list queries", () => {
  it("shows a loading state instead of labeling the previous page as the requested page", () => {
    const taxmaxi = new TaxMaxi({ apiKey: "", baseUrl: "https://transactions.example.test" })

    expect(queries.transactionList(taxmaxi).placeholderData).toBeUndefined()
  })

  it("forwards the selected transaction cursor", async () => {
    const requestedUrls: Array<string> = []
    const taxmaxi = new TaxMaxi({
      apiKey: "",
      baseUrl: "https://transactions.example.test",
      fetch: async (input) => {
        requestedUrls.push(getRequestUrl(input))
        return Response.json(
          { transactions: [], totalCount: 0, page: { hasMore: false, nextCursor: null } },
          { status: 200 }
        )
      },
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    await queryClient.fetchQuery(
      queries.transactionList(taxmaxi, { cursor: "transaction-page-2", limit: 7 })
    )

    expect(requestedUrls).toEqual([
      "https://transactions.example.test/v1/transactions?cursor=transaction-page-2&limit=7",
    ])
  })
})

describe("portfolio queries", () => {
  it("keeps source scopes separate and refreshes on focus and reconnect", () => {
    const taxmaxi = new TaxMaxi({ apiKey: "", baseUrl: "https://portfolio.example.test" })
    const sourceA = queries.portfolioAssets(taxmaxi, "source-a")
    const sourceB = queries.portfolioAssets(taxmaxi, "source-b")
    expect(sourceA.queryKey).not.toEqual(sourceB.queryKey)
    expect(sourceA.placeholderData).toBeUndefined()
    expect(sourceA.refetchOnWindowFocus).toBe("always")
    expect(sourceA.refetchOnReconnect).toBe("always")
  })
})

describe("transaction detail queries", () => {
  it("isolates explicit transaction and year keys without placeholder data", async () => {
    const taxmaxi = new TaxMaxi({ apiKey: "", baseUrl: "https://detail.example.test" })
    const get = vi.spyOn(taxmaxi.transactions, "get").mockRejectedValue(new Error("fixture"))
    const client = new QueryClient()
    const first = queries.transactionDetail(taxmaxi, { transactionId: "a", taxYear: 2025 })
    const nextYear = queries.transactionDetail(taxmaxi, { transactionId: "a", taxYear: 2026 })
    const nextRow = queries.transactionDetail(taxmaxi, { transactionId: "b", taxYear: 2025 })
    expect(first.queryKey).not.toEqual(nextYear.queryKey)
    expect(first.queryKey).not.toEqual(nextRow.queryKey)
    expect(first.placeholderData).toBeUndefined()
    await client.fetchQuery(first).catch(() => undefined)
    await client.fetchQuery(nextYear).catch(() => undefined)
    await client.fetchQuery(nextRow).catch(() => undefined)
    expect(get.mock.calls).toEqual([
      [{ transactionId: "a", taxYear: 2025 }],
      [{ transactionId: "a", taxYear: 2026 }],
      [{ transactionId: "b", taxYear: 2025 }],
    ])
    client.clear()
  })
})

describe("transaction writer-signal refresh", () => {
  it("cancels pending list delivery and refetches the identical list scope", async () => {
    let completeFirst: ((response: Response) => void) | undefined
    const urls: string[] = []
    const taxmaxi = TaxMaxi.fromBrowserSession({
      baseUrl: "https://signal.example.test",
      fetch: async (input) => {
        urls.push(getRequestUrl(input))
        if (urls.length === 1)
          return new Promise((resolve) => {
            completeFirst = resolve
          })
        return Response.json({
          transactions: [],
          totalCount: 2,
          page: { hasMore: false, nextCursor: null },
        })
      },
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const options = queries.transactionList(taxmaxi, { cursor: "same-cursor", limit: 7 })
    const observer = new QueryObserver(client, options)
    const unsubscribe = observer.subscribe(() => undefined)
    try {
      await vi.waitFor(() => expect(urls).toHaveLength(1))
      await refreshTransactionQueries(client)
      expect(client.getQueryData(options.queryKey)?.totalCount).toBe(2)
      completeFirst?.(
        Response.json({
          transactions: [],
          totalCount: 1,
          page: { hasMore: false, nextCursor: null },
        })
      )
      await Promise.resolve()
      expect(client.getQueryData(options.queryKey)?.totalCount).toBe(2)
      expect(urls).toEqual([
        "https://signal.example.test/v1/transactions?cursor=same-cursor&limit=7",
        "https://signal.example.test/v1/transactions?cursor=same-cursor&limit=7",
      ])
    } finally {
      unsubscribe()
      client.clear()
    }
  })
})

// Logout removes every `taxmaxi` query. A response that resolves after that
// must not write the previous session's data back into the cache (#108 T07).
const account = (id: string): Account => ({
  account: {
    id,
    email: `${id}@example.test`,
    displayName: "User",
    role: "member",
    emailVerified: true,
    welcomeSeenAt: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  },
  loginMethods: [],
})

describe("session-scoped query writes", () => {
  const userId = "00000000-0000-4000-8000-000000000001"
  const otherUserId = "00000000-0000-4000-8000-000000000002"
  const refreshed = {
    credits: 5,
    subscriptionStatus: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
  }

  it("writes while the cache holds the account of the same session", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.account(), account(userId))

    setSessionQueryData({
      data: refreshed,
      queryClient,
      queryKey: queryKeys.billingStatus(),
      userId,
    })

    expect(queryClient.getQueryData(queryKeys.billingStatus())).toEqual(refreshed)
  })

  it("writes without a user id as long as an account entry exists", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.account(), account(userId))

    setSessionQueryData({ data: refreshed, queryClient, queryKey: queryKeys.billingStatus() })

    expect(queryClient.getQueryData(queryKeys.billingStatus())).toEqual(refreshed)
  })

  it("skips the write once logout removed the account entry", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.account(), account(userId))
    queryClient.removeQueries({ queryKey: queryKeys.all })

    setSessionQueryData({ data: refreshed, queryClient, queryKey: queryKeys.billingStatus() })
    setSessionQueryData({
      data: refreshed,
      queryClient,
      queryKey: queryKeys.billingStatus(),
      userId,
    })

    expect(queryClient.getQueryData(queryKeys.billingStatus())).toBeUndefined()
  })

  it("skips the write when another user is cached", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.account(), account(otherUserId))

    setSessionQueryData({
      data: refreshed,
      queryClient,
      queryKey: queryKeys.billingStatus(),
      userId,
    })

    expect(queryClient.getQueryData(queryKeys.billingStatus())).toBeUndefined()
  })
})

describe("transaction page prefetch", () => {
  it.each(["logout", "replacement"])(
    "drops late page delivery after account %s",
    async (change) => {
      let finish: ((response: Response) => void) | undefined
      const taxmaxi = new TaxMaxi({
        apiKey: "",
        baseUrl: "https://prefetch.example.test",
        fetch: () =>
          new Promise<Response>((resolve) => {
            finish = resolve
          }),
      })
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      client.setQueryData(queryKeys.account(), account("user-a"))
      const pending = prefetchTransactionPage({
        userId: "user-a",
        queryClient: client,
        taxmaxi,
        input: { cursor: "next", limit: 25 },
      })
      await vi.waitFor(() => expect(finish).toBeDefined())
      if (change === "logout") await clearSessionQueries(client)
      else client.setQueryData(queryKeys.account(), account("user-b"))
      finish?.(
        Response.json({
          transactions: [],
          page: { hasMore: false, nextCursor: null },
          totalCount: 0,
        })
      )
      await pending
      expect(
        client.getQueryCache().findAll({ queryKey: queryKeys.transactionLists() })
      ).toHaveLength(0)
      if (change === "logout")
        expect(client.getQueryCache().findAll({ queryKey: queryKeys.all })).toHaveLength(0)
      else expect(client.getQueryData<Account>(queryKeys.account())?.account.id).toBe("user-b")
    }
  )
})
