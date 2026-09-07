// @vitest-environment jsdom

import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { TaxMaxi, type PortfolioAssets, type TransactionListInput } from "taxmaxi"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { Dashboard } from "#/components/dashboard"
import { queryKeys } from "#/integrations/taxmaxi/queries"

const syncState = vi.hoisted(() => ({
  onCompleted: undefined as undefined | ((sourceId: string) => void | Promise<void>),
  onUnauthorized: undefined as undefined | (() => void | Promise<void>),
}))

let testTaxMaxi: TaxMaxi

type TransactionListResponse = Awaited<ReturnType<TaxMaxi["transactions"]["list"]>>

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>()
  return {
    ...actual,
    useRouteContext: ({ select }: { readonly select: (context: unknown) => unknown }) =>
      select({ taxmaxi: () => testTaxMaxi }),
  }
})

vi.mock("#/components/source-cards", () => ({
  SourceCards: ({
    children,
    onSelectedSourceIdChange,
    selectedSourceId,
  }: {
    readonly children: ReactNode
    readonly onSelectedSourceIdChange: (sourceId: string | undefined) => void
    readonly selectedSourceId?: string
  }) => (
    <div>
      <span>{selectedSourceId ?? "all sources"}</span>
      <button onClick={() => onSelectedSourceIdChange("00000000-0000-4000-8000-000000000201")}>
        Source A
      </button>
      <button onClick={() => onSelectedSourceIdChange("00000000-0000-4000-8000-000000000202")}>
        Source B
      </button>
      <button onClick={() => onSelectedSourceIdChange(undefined)}>All sources</button>
      {children}
    </div>
  ),
}))

vi.mock("#/components/source-sync-island", () => ({
  SourceSyncIsland: () => null,
}))

vi.mock("#/components/ui/tabs", () => ({
  Tabs: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { readonly children: ReactNode }) => <button>{children}</button>,
  TabsContent: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}))

vi.mock("#/hooks/use-source-syncs", () => ({
  useSourceSyncs: ({
    onCompleted,
    onUnauthorized,
  }: {
    readonly onCompleted?: (sourceId: string) => void | Promise<void>
    readonly onUnauthorized?: () => void | Promise<void>
  }) => {
    syncState.onCompleted = onCompleted
    syncState.onUnauthorized = onUnauthorized
    return {
      activeSyncs: [],
      onDismissSync: vi.fn(),
      onRetrySync: vi.fn(),
      onSourceSync: vi.fn(),
      syncingSourceIds: new Set<string>(),
    }
  },
}))

const transaction = (transactionId: string, description: string) => ({
  transactionId,
  timestamp: "2025-03-10T12:00:00.000Z",
  source: {
    sourceId: "00000000-0000-4000-8000-000000000201",
    name: "Coinbase",
    kind: "cex" as const,
  },
  transactionType: "sell_fiat",
  description,
  externalId: transactionId,
  movements: [{ amount: "0.1", assetSymbol: "BTC", kind: "disposal" as const }],
  realizedGainLoss: "100",
  fiatCurrency: "EUR",
  calculationState: "complete" as const,
  needsReview: false,
})

describe("Dashboard transaction pagination", () => {
  afterEach(() => {
    cleanup()
    syncState.onCompleted = undefined
    vi.clearAllMocks()
  })

  it("uses server cursors and returns to the first page after a completed sync", async () => {
    const requestedCursors: Array<string | null> = []
    const firstPage: TransactionListResponse = {
      transactions: [transaction("00000000-0000-4000-8000-000000000101", "First transaction page")],
      totalCount: 2,
      page: { hasMore: true, nextCursor: "page-2" },
    }
    const secondPage: TransactionListResponse = {
      transactions: [
        transaction("00000000-0000-4000-8000-000000000102", "Second transaction page"),
      ],
      totalCount: 2,
      page: { hasMore: false, nextCursor: null },
    }
    let resolveSecondPage: ((page: TransactionListResponse) => void) | undefined
    const pendingSecondPage = new Promise<TransactionListResponse>((resolve) => {
      resolveSecondPage = resolve
    })
    const listTransactions = vi.fn(async (input: TransactionListInput = {}) => {
      const cursor = input.cursor ?? null
      requestedCursors.push(cursor)
      return cursor === null ? firstPage : pendingSecondPage
    })
    testTaxMaxi = {
      portfolio: {
        listAssets: vi.fn(async () => ({ assets: [], summary: undefined })),
      },
      transactions: { list: listTransactions },
    } as unknown as TaxMaxi
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      <QueryClientProvider client={queryClient}>
        <Dashboard
          accounts={[]}
          onSourceSyncCompleted={async () => {
            await queryClient.invalidateQueries({ queryKey: queryKeys.transactions() })
          }}
        />
      </QueryClientProvider>
    )

    expect(await screen.findByText("First transaction page")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Next page" }))
    expect(await screen.findByText("Loading transactions…")).toBeTruthy()
    expect(screen.queryByText("First transaction page")).toBeNull()

    await act(async () => {
      resolveSecondPage?.(secondPage)
    })

    expect(await screen.findByText("Second transaction page")).toBeTruthy()
    expect(requestedCursors).toEqual([null, "page-2"])

    await act(async () => {
      await syncState.onCompleted?.("00000000-0000-4000-8000-000000000201")
    })

    await waitFor(() => expect(requestedCursors.at(-1)).toBeNull())
    expect(await screen.findByText("First transaction page")).toBeTruthy()
  })
})

const RUN_A = "00000000-0000-4000-8000-000000000301"
const RUN_B = "00000000-0000-4000-8000-000000000302"
const portfolio = (runId = RUN_A, amount = "1.25"): PortfolioAssets => ({
  currency: "EUR",
  activeRun: { runId, status: "complete", blockerCounts: [] },
  latestRun: { runId, status: "complete", failureCode: null },
  summary: { totalValue: amount, costBasis: amount, profitLoss: "0", profitLossPercentage: "0" },
  assets: [
    {
      assetId: "btc",
      symbol: "BTC",
      name: "Bitcoin",
      logoUrl: null,
      amount,
      currentPrice: "1",
      totalValue: amount,
      profitLoss: "0",
    },
  ],
})

const tick = async (milliseconds = 1) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds)
  })
  // React Query delivers observer notifications on a separate timer.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
}

describe("Dashboard calculation refresh", () => {
  let queryClient: QueryClient
  let currentPortfolio: PortfolioAssets
  let respond: (sourceId: string | null) => Promise<Response>
  let portfolioCalls: number
  let transactionCalls: number

  beforeEach(() => {
    vi.useFakeTimers()
    focusManager.setFocused(true)
    onlineManager.setOnline(true)
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    currentPortfolio = portfolio()
    portfolioCalls = 0
    transactionCalls = 0
    respond = async () => Response.json(currentPortfolio)
    testTaxMaxi = new TaxMaxi({
      apiKey: "",
      baseUrl: "https://dashboard.example.test",
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.pathname.endsWith("/portfolio/assets")) {
          portfolioCalls += 1
          return respond(url.searchParams.get("sourceId"))
        }
        if (url.pathname.endsWith("/transactions")) {
          transactionCalls += 1
          return Response.json({
            transactions: [],
            totalCount: 0,
            page: { hasMore: false, nextCursor: null },
          })
        }
        throw new Error(`Unexpected request: ${url.pathname}`)
      },
    })
  })

  afterEach(() => {
    cleanup()
    queryClient.clear()
    focusManager.setFocused(undefined)
    onlineManager.setOnline(true)
    vi.useRealTimers()
    syncState.onCompleted = undefined
    vi.restoreAllMocks()
  })

  const mount = (onUnauthorized?: () => void) =>
    render(
      <QueryClientProvider client={queryClient}>
        <Dashboard accounts={[]} onUnauthorized={onUnauthorized} />
      </QueryClientProvider>
    )

  it("refreshes delayed calculations independently of source completion and invalidates each changed active run once", async () => {
    let overviewCalls = 0
    let detailCalls = 0
    const overview = new QueryObserver(queryClient, {
      queryKey: queryKeys.sourceOverview("source-a"),
      queryFn: async () => ++overviewCalls,
      staleTime: Infinity,
    })
    const detail = new QueryObserver(queryClient, {
      queryKey: [...queryKeys.transactions(), "detail", "transaction-a", 2026],
      queryFn: async () => ++detailCalls,
      staleTime: Infinity,
    })
    const stopOverview = overview.subscribe(() => {})
    const stopDetail = detail.subscribe(() => {})
    mount()
    await tick()
    expect(screen.getByText("1,25")).toBeTruthy()
    expect([overviewCalls, transactionCalls, detailCalls]).toEqual([1, 1, 1])

    await act(async () => {
      await syncState.onCompleted?.("source-a")
    })
    await tick()
    expect(portfolioCalls).toBe(2)
    expect(screen.getByText("Checking for updated results…")).toBeTruthy()
    await tick(2_000)
    expect(screen.getByText("1,25")).toBeTruthy()
    expect([overviewCalls, transactionCalls, detailCalls]).toEqual([1, 1, 1])

    currentPortfolio = {
      ...portfolio(),
      latestRun: { runId: RUN_B, status: "running", failureCode: null },
    }
    await tick(2_000)
    expect(screen.getByText("1,25")).toBeTruthy()
    expect([overviewCalls, transactionCalls, detailCalls]).toEqual([1, 1, 1])

    currentPortfolio = portfolio(RUN_B, "2.50")
    await tick(2_000)
    expect(screen.getByText("2,50")).toBeTruthy()
    expect(screen.queryByText("1,25")).toBeNull()
    expect([overviewCalls, transactionCalls, detailCalls]).toEqual([2, 2, 2])
    await tick(2_000)
    expect([overviewCalls, transactionCalls, detailCalls]).toEqual([2, 2, 2])
    // A changed run cannot certify coverage of this source sync.
    await tick(60_000)
    expect(screen.getByText("Results for the recent sync are not yet confirmed.")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Refresh results" }))
    await tick()
    expect([overviewCalls, transactionCalls, detailCalls]).toEqual([2, 2, 2])
    stopOverview()
    stopDetail()
  })

  it("discovers a calculation after reload and a 90-second queue delay", async () => {
    const initial = mount()
    await tick()
    initial.unmount()
    mount()
    await tick()
    for (let elapsed = 30; elapsed < 90; elapsed += 30) {
      await tick(30_000)
      expect(screen.getByText("1,25")).toBeTruthy()
    }
    currentPortfolio = portfolio(RUN_B, "2.50")
    await tick(30_000)
    expect(screen.getByText("2,50")).toBeTruthy()
    expect(portfolioCalls).toBe(4)
    expect(screen.queryByText("Results for the recent sync are not yet confirmed.")).toBeNull()
  })

  it("ends the local fast window after 60 seconds and keeps ordinary refresh", async () => {
    mount()
    await tick()
    await act(async () => {
      await syncState.onCompleted?.("source-a")
    })
    await tick()
    await tick(60_000)
    expect(screen.getByText("Results for the recent sync are not yet confirmed.")).toBeTruthy()
    const callsAtExpiry = portfolioCalls
    await tick(2_000)
    expect(portfolioCalls).toBe(callsAtExpiry)
    await tick(28_000)
    expect(portfolioCalls).toBe(callsAtExpiry + 1)
  })

  it("keeps fast refresh while a running calculation outlasts the local window", async () => {
    currentPortfolio = {
      ...portfolio(),
      latestRun: { runId: RUN_B, status: "running", failureCode: null },
    }
    mount()
    await tick()
    await tick(60_000)
    const calls = portfolioCalls
    await tick(2_000)
    expect(portfolioCalls).toBe(calls + 1)
    expect(screen.getByText("1,25")).toBeTruthy()
  })

  it("pauses hidden intervals, refreshes on focus and reconnect, and cleans up on unmount", async () => {
    const view = mount()
    await tick()
    act(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
      document.dispatchEvent(new Event("visibilitychange"))
      focusManager.setFocused(false)
    })
    await tick(90_000)
    expect(portfolioCalls).toBe(1)
    act(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
      document.dispatchEvent(new Event("visibilitychange"))
      focusManager.setFocused(true)
    })
    await tick()
    expect(portfolioCalls).toBe(2)
    act(() => onlineManager.setOnline(false))
    act(() => onlineManager.setOnline(true))
    await tick()
    expect(portfolioCalls).toBe(3)
    view.unmount()
    await tick(90_000)
    expect(portfolioCalls).toBe(3)
  })

  it("stops requests on authentication loss without retrying the unauthorized response", async () => {
    const onUnauthorized = vi.fn()
    mount(onUnauthorized)
    await tick()
    respond = async () => Response.json({ _tag: "Unauthorized" }, { status: 401 })
    await tick(30_000)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    const calls = portfolioCalls
    await tick(90_000)
    act(() => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    await tick()
    expect(portfolioCalls).toBe(calls)
  })

  it("bounds request retries and returns to the slow cadence on failure", async () => {
    mount()
    await tick()
    respond = async () => Response.json({ message: "Unavailable" }, { status: 503 })
    await act(async () => {
      await syncState.onCompleted?.("source-a")
    })
    await tick(3_000)
    expect(portfolioCalls).toBe(4)
    await tick(20_000)
    expect(portfolioCalls).toBe(4)
  })

  it.each(["unmount", "authentication loss"] as const)(
    "cancels pending response delivery and retries on %s",
    async (stop) => {
      let deliver: ((response: Response) => void) | undefined
      respond = () =>
        new Promise<Response>((resolve) => {
          deliver = resolve
        })
      const view = mount()
      await tick()
      expect(portfolioCalls).toBe(1)
      if (stop === "unmount") view.unmount()
      else
        await act(async () => {
          await syncState.onUnauthorized?.()
        })
      await act(async () => {
        deliver?.(Response.json({ message: "Unavailable" }, { status: 503 }))
      })
      await tick(90_000)
      expect(portfolioCalls).toBe(1)
      expect(queryClient.getQueryState(queryKeys.portfolioAssets())?.fetchStatus).toBe("idle")
    }
  )

  it("refreshes dependent reads when an unavailable calculation gets its first active run", async () => {
    currentPortfolio = { ...portfolio(), activeRun: null, latestRun: null, assets: [] }
    mount()
    await tick()
    expect(transactionCalls).toBe(1)
    currentPortfolio = portfolio()
    await tick(30_000)
    expect(transactionCalls).toBe(2)
    expect(screen.getByText("1,25")).toBeTruthy()
  })

  it("does not label delayed source A positions as source B or invalidate on repeated cached run IDs", async () => {
    let deliverA: ((response: Response) => void) | undefined
    const delayedA = new Promise<Response>((resolve) => {
      deliverA = resolve
    })
    respond = async (sourceId) =>
      sourceId?.endsWith("201")
        ? delayedA
        : Response.json(sourceId === null ? portfolio() : portfolio(RUN_B, "2.50"))
    mount()
    await tick()
    fireEvent.click(screen.getByRole("button", { name: "Source A" }))
    await tick()
    expect(screen.queryByText("1,25")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Source B" }))
    await tick()
    expect(screen.getByText("2,50")).toBeTruthy()
    await act(async () => {
      deliverA?.(Response.json(portfolio(RUN_A, "9.99")))
    })
    await tick()
    expect(screen.queryByText("9,99")).toBeNull()
    expect(screen.getByText("2,50")).toBeTruthy()
    const calls = transactionCalls
    fireEvent.click(screen.getByRole("button", { name: "All sources" }))
    await tick()
    fireEvent.click(screen.getByRole("button", { name: "Source B" }))
    await tick()
    expect(transactionCalls).toBe(calls)
  })
})
