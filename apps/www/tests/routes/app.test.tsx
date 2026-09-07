// @vitest-environment jsdom

import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query"
import { act, cleanup, render, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { TaxMaxi, type Transactions } from "taxmaxi"
import { afterEach, expect, it, vi } from "vitest"

import { queries, queryKeys } from "#/integrations/taxmaxi/queries"
import { Route } from "#/routes/app"

const dashboard = vi.hoisted<{
  onSourceSyncCompleted: ((sourceId: string) => Promise<void>) | undefined
}>(() => ({ onSourceSyncCompleted: undefined }))

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Outlet: () => null,
}))
vi.mock("#/components/dashboard", () => ({
  Dashboard: (props: { onSourceSyncCompleted: (sourceId: string) => Promise<void> }) => {
    dashboard.onSourceSyncCompleted = props.onSourceSyncCompleted
    return null
  },
}))
vi.mock("#/components/app-workspace", () => ({
  AppWorkspace: ({ children }: { children: ReactNode }) => children,
}))
vi.mock("#/components/app-header", () => ({ AppHeader: () => null }))
vi.mock("#/components/account-menu", () => ({ AccountMenu: () => null }))
vi.mock("#/hooks/use-app-logout", () => ({ useAppLogout: () => vi.fn() }))
vi.mock("#/server-functions/auth", () => ({
  clearAuthSessionCookie: vi.fn(),
  getAuthStatus: vi.fn(),
}))

const deferred = <T,>() => {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

const list = (totalCount: number): Transactions => ({
  transactions: [],
  totalCount,
  page: { hasMore: false, nextCursor: null },
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  dashboard.onSourceSyncCompleted = undefined
})

it("cancels old transaction delivery while the source overview refresh is still pending", async () => {
  const oldList = deferred<Response>()
  const slowOverview = deferred<number>()
  let listRequests = 0
  const taxmaxi = TaxMaxi.fromBrowserSession({
    baseUrl: "https://route.example.test",
    fetch: async () => {
      listRequests += 1
      return listRequests === 1 ? oldList.promise : Response.json(list(2))
    },
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(queryKeys.sourceList(), { sources: [] })
  const overviewKey = queryKeys.sourceOverview("source-a")
  queryClient.setQueryData(overviewKey, 1)
  // Only the overview's scheduling matters here; transaction delivery uses the real SDK.
  const overview = new QueryObserver(queryClient, {
    queryKey: overviewKey,
    queryFn: () => slowOverview.promise,
    staleTime: Infinity,
  })
  const stopOverview = overview.subscribe(() => undefined)
  const options = queries.transactionList(taxmaxi, { cursor: "same-cursor", limit: 7 })
  const transactions = new QueryObserver(queryClient, options)
  const stopTransactions = transactions.subscribe(() => undefined)
  vi.spyOn(Route, "useRouteContext").mockReturnValue({ queryClient, taxmaxi: () => taxmaxi })
  vi.spyOn(Route, "useNavigate").mockReturnValue(vi.fn().mockResolvedValue(undefined))
  const Component = Route.options.component
  expect(Component).toBeDefined()
  if (Component === undefined) return

  try {
    render(
      <QueryClientProvider client={queryClient}>
        <Component />
      </QueryClientProvider>
    )
    await waitFor(() => expect(listRequests).toBe(1))
    let completion: Promise<void> | undefined
    act(() => {
      completion = dashboard.onSourceSyncCompleted?.("source-a")
    })
    await waitFor(() => expect(queryClient.getQueryData(options.queryKey)?.totalCount).toBe(2))
    expect(queryClient.getQueryState(overviewKey)?.fetchStatus).toBe("fetching")
    oldList.resolve(Response.json(list(1)))
    await act(async () => {
      await oldList.promise
    })
    expect(queryClient.getQueryData(options.queryKey)?.totalCount).toBe(2)
    expect(listRequests).toBe(2)
    slowOverview.resolve(2)
    await act(async () => {
      await completion
    })
  } finally {
    oldList.resolve(Response.json(list(1)))
    slowOverview.resolve(2)
    stopOverview()
    stopTransactions()
    queryClient.clear()
  }
})
