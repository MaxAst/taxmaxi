// @vitest-environment jsdom

import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import type { TransactionFilters } from "#/lib/transaction-filters"
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query"
import { act, cleanup, render, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { TaxMaxi, type Transactions } from "taxmaxi"
import { afterEach, expect, it, vi } from "vitest"

import { queries, queryKeys } from "#/integrations/taxmaxi/queries"
import { Route } from "#/routes/app"
import { setLocale } from "#/paraglide/runtime"

const dashboard = vi.hoisted<{
  onSourceSyncCompleted: ((sourceId: string) => Promise<void>) | undefined
  filters?: TransactionFilters
  onFiltersChange?: (filters: TransactionFilters) => void
}>(() => ({ onSourceSyncCompleted: undefined }))

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Outlet: () => null,
}))
vi.mock("#/components/dashboard", () => ({
  Dashboard: (props: {
    onSourceSyncCompleted: (sourceId: string) => Promise<void>
    filters: TransactionFilters
    onFiltersChange: (filters: TransactionFilters) => void
  }) => {
    dashboard.filters = props.filters
    dashboard.onFiltersChange = props.onFiltersChange
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
  vi.spyOn(Route, "useSearch").mockReturnValue({})
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

it("restores filter sets and timezone through real router Back while retaining unrelated URL keys", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(queryKeys.sourceList(), { sources: [] })
  const taxmaxi = new TaxMaxi({ apiKey: "", baseUrl: "https://route.example.test" })
  const root = createRootRouteWithContext<{ queryClient: QueryClient; taxmaxi: () => TaxMaxi }>()()
  const route = createRoute({
    getParentRoute: () => root,
    path: "/app",
    validateSearch: Route.options.validateSearch,
    component: Route.options.component,
  })
  const history = createMemoryHistory({ initialEntries: ["/app?unrelated=keep"] })
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history,
    context: { queryClient, taxmaxi: () => taxmaxi },
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  await waitFor(() => expect(dashboard.filters).toEqual({}))
  const original: TransactionFilters = {
    sourceIds: ["00000000-0000-4000-8000-000000000001"],
    assetIds: ["00000000-0000-4000-8000-000000000002"],
    categories: ["staking"],
    from: "2026-03-29",
    to: "2026-03-29",
    timezone: "Europe/Berlin",
    order: "oldest",
    attention: true,
  }
  await act(async () => dashboard.onFiltersChange?.(original))
  await waitFor(() => expect(dashboard.filters).toEqual(original))
  expect(router.state.location.search).toMatchObject({ unrelated: "keep", ...original })
  await act(async () =>
    dashboard.onFiltersChange?.({ sourceIds: [], timezone: "America/New_York" })
  )
  await waitFor(() =>
    expect(dashboard.filters).toEqual({ sourceIds: [], timezone: "America/New_York" })
  )
  await act(async () => history.back())
  await waitFor(() => expect(dashboard.filters).toEqual(original))
  expect(router.state.location.search).toMatchObject({ unrelated: "keep", ...original })
  queryClient.clear()
})

it.each(["en", "de"] as const)(
  "shows localized filter validation errors through the router boundary in %s",
  async (locale) => {
    const originalUrl = window.location.href
    window.history.replaceState(null, "", "/app")
    await setLocale(locale, { reload: false })
    try {
      const invalidFilters =
        locale === "de"
          ? "Die Transaktionsfilter in diesem Link sind ungültig. Prüfe die Filter und versuche es erneut."
          : "The transaction filters in this link are invalid. Check the filters and try again."
      const reversedDates =
        locale === "de"
          ? "Das Enddatum muss am oder nach dem Startdatum liegen."
          : "The end date must be on or after the start date."
      for (const [search, expected] of [
        ["from=2026-03-02&to=2026-03-01", reversedDates],
        ["from=2026-02-30", invalidFilters],
        ["from=9999-12-31&to=9999-12-31&timezone=UTC", invalidFilters],
        ["from=0000-01-01&timezone=Etc%2FGMT-1", invalidFilters],
        ["from=2011-12-30&to=2011-12-30&timezone=Pacific%2FApia", invalidFilters],
        ["sourceIds=%5B%22invalid%22%5D", invalidFilters],
        ["categories=%5B%22invalid%22%5D", invalidFilters],
        ["timezone=invalid", invalidFilters],
      ]) {
        const root = createRootRouteWithContext<{
          queryClient: QueryClient
          taxmaxi: () => TaxMaxi
        }>()()
        const route = createRoute({
          getParentRoute: () => root,
          path: "/app",
          validateSearch: Route.options.validateSearch,
          errorComponent: ({ error }) => <p>{error.message}</p>,
        })
        const queryClient = new QueryClient()
        const taxmaxi = new TaxMaxi({ apiKey: "", baseUrl: "https://route.example.test" })
        const router = createRouter({
          routeTree: root.addChildren([route]),
          history: createMemoryHistory({ initialEntries: [`/app?${search}`] }),
          context: { queryClient, taxmaxi: () => taxmaxi },
        })
        const view = render(<RouterProvider router={router} />)
        await waitFor(() => expect(view.container.textContent).toBe(expected))
        view.unmount()
        queryClient.clear()
      }
    } finally {
      await setLocale("en", { reload: false })
      window.history.replaceState(null, "", originalUrl)
    }
  }
)
