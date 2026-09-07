// @vitest-environment jsdom

import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ReactNode } from "react"
import {
  TaxMaxi,
  type PortfolioAssets,
  type TransactionDetail,
  type TransactionListInput,
} from "taxmaxi"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { Dashboard } from "#/components/dashboard"
import { queryKeys } from "#/integrations/taxmaxi/queries"
import type { SourceSyncSeed } from "#/lib/dashboard-types"

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi
      .fn()
      .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  })
})

const syncState = vi.hoisted(() => ({
  onCompleted: undefined as undefined | ((sourceId: string) => void | Promise<void>),
  onUnauthorized: undefined as undefined | (() => void | Promise<void>),
  seeds: undefined as undefined | ReadonlyArray<SourceSyncSeed>,
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
    seeds,
  }: {
    readonly onCompleted?: (sourceId: string) => void | Promise<void>
    readonly onUnauthorized?: () => void | Promise<void>
    readonly seeds?: ReadonlyArray<SourceSyncSeed>
  }) => {
    syncState.onCompleted = onCompleted
    syncState.onUnauthorized = onUnauthorized
    syncState.seeds = seeds
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

describe("Dashboard sync reconnect", () => {
  afterEach(() => {
    cleanup()
    syncState.seeds = undefined
    vi.clearAllMocks()
  })

  it("hands the page's sync seeds to the sync hook", async () => {
    testTaxMaxi = {
      portfolio: {
        listAssets: vi.fn(async () => ({ assets: [], summary: undefined })),
      },
      transactions: {
        list: vi.fn(async () => ({
          transactions: [],
          totalCount: 0,
          page: { hasMore: false, nextCursor: null },
        })),
      },
    } as unknown as TaxMaxi
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const seeds: ReadonlyArray<SourceSyncSeed> = [
      {
        sourceId: "00000000-0000-4000-8000-000000000201",
        jobId: "job-1",
        mode: "sync",
        status: "running",
      },
    ]

    render(
      <QueryClientProvider client={queryClient}>
        <Dashboard accounts={[]} sourceSyncSeeds={seeds} />
      </QueryClientProvider>
    )

    expect(await screen.findByText("No transactions yet.")).toBeTruthy()
    expect(syncState.seeds).toBe(seeds)
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

  it("follows a surviving transaction across the Berlin year boundary and keeps its last year when removed", async () => {
    const row = {
      ...transaction("00000000-0000-4000-8000-000000000101", "Boundary transaction"),
      timestamp: "2024-12-31T22:30:00.000Z",
    }
    let rows = [row]
    vi.spyOn(testTaxMaxi.transactions, "list").mockImplementation(async () => ({
      transactions: rows,
      totalCount: rows.length,
      page: { hasMore: false, nextCursor: null },
    }))
    const get = vi
      .spyOn(testTaxMaxi.transactions, "get")
      .mockImplementation(() => new Promise(() => undefined))
    mount()
    await tick()
    fireEvent.click(screen.getByRole("button", { name: /Open transaction/ }))
    await tick()
    expect(get).toHaveBeenLastCalledWith({ transactionId: row.transactionId, taxYear: 2024 })
    rows = [{ ...row, timestamp: "2024-12-31T23:30:00.000Z" }]
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.transactionList({ cursor: null, limit: 7 }),
        exact: true,
      })
    })
    await tick()
    expect(get).toHaveBeenLastCalledWith({ transactionId: row.transactionId, taxYear: 2025 })
    expect(get).toHaveBeenCalledTimes(2)
    rows = []
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.transactionList({ cursor: null, limit: 7 }),
        exact: true,
      })
    })
    await tick()
    expect(get).toHaveBeenCalledTimes(2)
    expect(screen.getByText("Boundary transaction")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Close transaction" }))
    await tick(500)
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Transactions" }))
  })

  it.each(["loaded", "pending", "failed refresh"] as const)(
    "refreshes an open %s treatment detail when the actual active run changes",
    async (scenario) => {
      const row = transaction("00000000-0000-4000-8000-000000000101", "Treatment transaction")
      vi.spyOn(testTaxMaxi.transactions, "list").mockResolvedValue({
        transactions: [row],
        totalCount: 1,
        page: { hasMore: false, nextCursor: null },
      })
      const response = (): TransactionDetail => ({
        transactionId: row.transactionId,
        timestamp: row.timestamp,
        source: row.source,
        transactionType: row.transactionType,
        description: row.description,
        externalId: row.externalId,
        sourceRawRecordId: null,
        providerTransactionType: null,
        classificationHistoryStatus: "unavailable",
        sourceEvidence: [],
        movements: [],
        reconciliations: [],
        movementOverrides: [],
        assetOverrides: [],
        calculation: {
          run: {
            id: currentPortfolio.activeRun?.runId ?? "unavailable",
            taxYear: 2025,
            jurisdiction: "DE",
            reportingCurrency: "EUR",
            status: "complete",
            engineVersion: "test",
            ruleSetVersion: "test",
            inputLedgerRevision: "1",
            valuationRevision: "1",
            failureCode: null,
          },
          state: "complete",
          monetaryStatus: "not_applicable",
          derivedLots: [],
          allocations: [],
          income: [],
          blockers: [],
          processedEventIds: [],
          correctionInputs: [],
        },
      })
      const oldResponse = response()
      let finishInitial: ((value: TransactionDetail) => void) | undefined
      let failRefresh = scenario === "failed refresh"
      const get = vi
        .spyOn(testTaxMaxi.transactions, "get")
        .mockImplementationOnce(() =>
          scenario === "pending"
            ? new Promise((resolve) => {
                finishInitial = resolve
              })
            : Promise.resolve(oldResponse)
        )
        .mockImplementation(async () => {
          if (failRefresh) throw new Error("fixture read failure")
          return response()
        })
      mount()
      await tick()
      expect(get).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole("button", { name: /Open transaction/ }))
      await tick()
      expect(get).toHaveBeenCalledExactlyOnceWith({
        transactionId: row.transactionId,
        taxYear: 2025,
      })
      if (scenario === "pending")
        expect(screen.getByText("Loading treatment results…")).toBeTruthy()
      else expect(screen.getByText(`Returned run: ${RUN_A} · 2025 · DE · EUR`)).toBeTruthy()
      currentPortfolio = portfolio("run-b", "2.50")
      await tick(30_000)
      expect(get).toHaveBeenCalledTimes(2)
      if (scenario === "failed refresh") {
        expect(screen.getByText("Could not load treatment results. Try again.")).toBeTruthy()
        expect(screen.queryByText(`Returned run: ${RUN_A} · 2025 · DE · EUR`)).toBeNull()
        expect(screen.getAllByText("Treatment transaction").length).toBeGreaterThan(0)
        failRefresh = false
        fireEvent.click(screen.getByRole("button", { name: "Retry results" }))
        await tick()
      }
      await act(async () => {
        finishInitial?.(oldResponse)
      })
      await tick()
      expect(screen.getByText("Returned run: run-b · 2025 · DE · EUR")).toBeTruthy()
      expect(screen.queryByText(`Returned run: ${RUN_A} · 2025 · DE · EUR`)).toBeNull()
      const expectedCalls = scenario === "failed refresh" ? 3 : 2
      await tick(30_000)
      expect(get).toHaveBeenCalledTimes(expectedCalls)
      fireEvent.click(screen.getByRole("button", { name: "Close transaction" }))
      currentPortfolio = portfolio("run-c", "3.75")
      await tick(30_000)
      expect(get).toHaveBeenCalledTimes(expectedCalls)
    }
  )

  it.each(["list", "overview"] as const)(
    "restarts pending source %s and transaction list reads on a changed run",
    async (scope) => {
      let finishSource: ((value: string) => void) | undefined
      let finishList: ((value: TransactionListResponse) => void) | undefined
      const oldPage: TransactionListResponse = {
        transactions: [transaction("old", "Old result")],
        totalCount: 1,
        page: { hasMore: false, nextCursor: null },
      }
      const newPage: TransactionListResponse = {
        ...oldPage,
        transactions: [transaction("new", "New result")],
      }
      const sourceKey =
        scope === "list" ? queryKeys.sourceList() : queryKeys.sourceOverview("source-a")
      const sourceRead = vi
        .fn<() => Promise<string>>()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishSource = resolve
            })
        )
        .mockResolvedValue("new source")
      const source = new QueryObserver(queryClient, { queryKey: sourceKey, queryFn: sourceRead })
      const stop = source.subscribe(() => {})
      const list = vi
        .spyOn(testTaxMaxi.transactions, "list")
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishList = resolve
            })
        )
        .mockResolvedValue(newPage)
      mount()
      await tick()
      currentPortfolio = portfolio(RUN_B, "2.50")
      await tick(30_000)
      expect(list).toHaveBeenCalledTimes(2)
      expect(sourceRead).toHaveBeenCalledTimes(2)
      await act(async () => {
        finishSource?.("old source")
        finishList?.(oldPage)
      })
      await tick()
      expect(queryClient.getQueryData(sourceKey)).toBe("new source")
      expect(screen.getByText("New result")).toBeTruthy()
      expect(screen.queryByText("Old result")).toBeNull()
      stop()
    }
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

  it.each(["unmount", "authentication loss"] as const)(
    "stops a suspended dependent refresh after %s",
    async (stopReason) => {
      const sourceRead = vi.fn(async () => "source data")
      const source = new QueryObserver(queryClient, {
        queryKey: queryKeys.sourceList(),
        queryFn: sourceRead,
      })
      const stopSource = source.subscribe(() => {})
      let release: (() => void) | undefined
      const cancellationBarrier = new Promise<void>((resolve) => {
        release = resolve
      })
      const cancel = queryClient.cancelQueries.bind(queryClient)
      vi.spyOn(queryClient, "cancelQueries").mockImplementation(async (filters, options) => {
        await cancel(filters, options)
        if (filters?.queryKey?.[1] === "sources") await cancellationBarrier
      })
      const view = mount()
      await tick()
      currentPortfolio = portfolio(RUN_B, "2.50")
      await tick(30_000)
      expect(sourceRead).toHaveBeenCalledTimes(1)
      if (stopReason === "unmount") view.unmount()
      else
        await act(async () => {
          await syncState.onUnauthorized?.()
        })
      await act(async () => {
        release?.()
      })
      await tick()
      expect(sourceRead).toHaveBeenCalledTimes(1)
      expect(transactionCalls).toBe(1)
      stopSource()
    }
  )

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

  it("shows unavailable positions instead of the API's empty zero summary when no active run exists", async () => {
    currentPortfolio = {
      ...portfolio(),
      activeRun: null,
      latestRun: null,
      assets: [],
      summary: { totalValue: "0", costBasis: "0", profitLoss: "0", profitLossPercentage: null },
    }
    mount()
    await tick()
    const status = screen.getByRole("region", { name: "Portfolio calculation" })
    expect(status.textContent).toContain("No calculation available.")
    expect(
      screen.getByText(
        "Positions are unavailable until a calculation is available. This does not confirm a zero balance."
      )
    ).toBeTruthy()
    expect(screen.queryByText("No assets yet.")).toBeNull()
    expect(screen.queryByText("0,00 EUR")).toBeNull()
  })

  it.each(["running", "failed"] as const)(
    "keeps partial active A and its whole-calculation blockers visible with latest B %s",
    async (latestStatus) => {
      currentPortfolio = {
        ...portfolio(),
        activeRun: {
          runId: RUN_A,
          status: "partial",
          blockerCounts: [
            { code: "missing_valuation", count: 2 },
            { code: "future.example", count: 1 },
          ],
        },
        latestRun: {
          runId: RUN_B,
          status: latestStatus,
          failureCode: latestStatus === "failed" ? "engine_unavailable" : null,
        },
      }
      mount()
      await tick()
      const status = screen.getByRole("region", { name: "Portfolio calculation" })
      expect(within(status).getByText("Partial calculation available.")).toBeTruthy()
      expect(within(status).getByText("Blockers in the whole calculation: 3")).toBeTruthy()
      expect(status.textContent).toContain(
        latestStatus === "failed"
          ? "The latest calculation failed."
          : "The latest calculation is running."
      )
      expect(screen.getByText("1,25")).toBeTruthy()
      fireEvent.click(within(status).getByText("Run and blocker details"))
      expect(within(status).getByText(`Active run: ${RUN_A}`)).toBeTruthy()
      expect(within(status).getByText(`Latest run: ${RUN_B}`)).toBeTruthy()
      expect(within(status).getByText("Valuation missing")).toBeTruthy()
      expect(within(status).getByText("missing_valuation")).toBeTruthy()
      expect(within(status).getByText("Unknown blocker")).toBeTruthy()
      expect(within(status).getByText("future.example")).toBeTruthy()
      expect(within(status).getByText("2")).toBeTruthy()
      expect(within(status).getByText("1")).toBeTruthy()
      if (latestStatus === "failed")
        expect(within(status).getByText("Failure code: engine_unavailable")).toBeTruthy()

      fireEvent.click(screen.getByRole("button", { name: "Source B" }))
      await tick()
      expect(within(status).getByText("Blockers in the whole calculation: 3")).toBeTruthy()
      expect(
        within(status).getByText(
          "Counts cover the whole calculation across all sources. One transaction can have multiple blockers."
        )
      ).toBeTruthy()
      expect(within(status).getByText("Current-year portfolio · Germany (DE) · EUR")).toBeTruthy()
      expect(status.textContent).not.toContain("2025")
    }
  )

  it("identifies complete active A without using terminal non-active B to relabel positions", async () => {
    currentPortfolio = {
      ...portfolio(),
      latestRun: { runId: RUN_B, status: "partial", failureCode: null },
    }
    mount()
    await tick()
    const status = screen.getByRole("region", { name: "Portfolio calculation" })
    expect(within(status).getByText("Available calculation complete.")).toBeTruthy()
    expect(within(status).getByText(`Active run: ${RUN_A}`)).toBeTruthy()
    expect(within(status).getByText(`Latest run: ${RUN_B}`)).toBeTruthy()
    expect(screen.getByText("1,25")).toBeTruthy()
    expect(within(status).queryByText("Partial calculation available.")).toBeNull()
  })

  it("distinguishes failed requests from failed calculations while retaining cached positions and allowing read refresh", async () => {
    mount()
    await tick()
    respond = async () => Response.json({ message: "Unavailable" }, { status: 503 })
    await tick(33_000)
    const status = screen.getByRole("region", { name: "Portfolio calculation" })
    expect(within(status).getByText("Could not load calculation status. Try again.")).toBeTruthy()
    expect(within(status).queryByText(/The latest calculation failed/)).toBeNull()
    expect(screen.getByText("1,25")).toBeTruthy()
    const calls = portfolioCalls
    respond = async () => Response.json(currentPortfolio)
    fireEvent.click(within(status).getByRole("button", { name: "Refresh results" }))
    await tick()
    expect(portfolioCalls).toBe(calls + 1)
    expect(transactionCalls).toBe(1)
    expect(within(status).queryByText(/Could not load calculation status/)).toBeNull()
  })

  it("does not claim there is no calculation when the first request fails", async () => {
    respond = async () => Response.json({ message: "Unavailable" }, { status: 503 })
    mount()
    await tick(3_000)
    const status = screen.getByRole("region", { name: "Portfolio calculation" })
    expect(status.textContent).toContain("Could not load calculation status.")
    expect(status.textContent).not.toContain("No calculation available.")
    expect(status.textContent).not.toContain("Previously loaded")
  })

  it("announces changed calculation facts once, not identical polls or manual refresh state", async () => {
    mount()
    await tick()
    const live = screen.getByRole("status", { name: "Calculation updates" })
    const updates: string[] = []
    const observer = new MutationObserver(() => updates.push(live.textContent ?? ""))
    observer.observe(live, { characterData: true, childList: true, subtree: true })
    await tick(30_000)
    expect(updates).toEqual([])
    currentPortfolio = {
      ...portfolio(),
      activeRun: {
        runId: RUN_A,
        status: "partial",
        blockerCounts: [{ code: "inventory_shortage", count: 3 }],
      },
    }
    await tick(30_000)
    expect(updates).toHaveLength(1)
    expect(updates[0]).toContain("Partial calculation available.")
    expect(updates[0]).toContain("Blockers in the whole calculation: 3")
    await tick(30_000)
    fireEvent.click(screen.getByRole("button", { name: "Refresh results" }))
    await tick()
    expect(updates).toHaveLength(1)
    observer.disconnect()
  })
})
