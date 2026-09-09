// @vitest-environment jsdom

import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
  QueryObserver,
  useQuery,
} from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ReactNode, Ref } from "react"
import {
  TaxMaxi,
  type Account as TaxMaxiAccount,
  type BillingStatus,
  type PortfolioAssets,
  type PortfolioCalculationStatus,
  type SourceOverview,
  type TransactionDetail,
  type TransactionListInput,
} from "taxmaxi"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { Dashboard } from "#/components/dashboard"
import type { SourceSyncIslandItem } from "#/components/source-sync-island"
import { queryKeys, queries, refreshTransactionQueries } from "#/integrations/taxmaxi/queries"
import type { Account, SourceSyncSeed } from "#/lib/dashboard-types"

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi
      .fn()
      .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  })
})

const syncState = vi.hoisted(() => ({
  activeSyncs: [] as ReadonlyArray<SourceSyncIslandItem & { jobId?: string }>,
  onCompleted: undefined as undefined | ((sourceId: string) => void | Promise<void>),
  onSourceSync: vi.fn(),
  onUnauthorized: undefined as undefined | (() => void | Promise<void>),
  seeds: undefined as undefined | ReadonlyArray<SourceSyncSeed>,
}))

let testTaxMaxi: TaxMaxi

type TransactionListResponse = Awaited<ReturnType<TaxMaxi["transactions"]["list"]>>

const SOURCE_A = "00000000-0000-4000-8000-000000000201"

const sourceOverview = (
  latestSync: Partial<SourceOverview["latestSync"]> = {},
  sourceId = SOURCE_A
): SourceOverview => ({
  calculationRunId: null,
  source: {
    id: sourceId,
    principalId: "00000000-0000-4000-8000-000000000002",
    name: "Coinbase",
    providerKey: "coinbase",
    sourceRef: { _tag: "cex", cexAccountId: "00000000-0000-4000-8000-000000000003" },
    createdAt: { epochMillis: 1_735_689_600_000 },
  },
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
    ...latestSync,
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

/** A source that has completed a sync: the normal dashboard, no wizard. */
const syncedOverviews: ReadonlyArray<SourceOverview> = [
  sourceOverview({ lastSyncedAt: "2025-03-10T12:00:00.000Z", status: "completed" }),
]

const toAccount = (overview: SourceOverview): Account => ({
  id: overview.source.id,
  name: overview.source.name,
  kind: "exchange",
  importedTransactions: 0,
  unresolvedItems: 0,
  lastSync: overview.latestSync.lastSyncedAt ?? "Never synced",
  ...(overview.latestSync.lastSyncedAt === null
    ? {}
    : { lastSyncedAt: overview.latestSync.lastSyncedAt }),
})

const billingStatus = (
  credits: number,
  subscriptionStatus: string | null = null
): BillingStatus => ({
  credits,
  subscriptionStatus,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
})

const WELCOME_SEEN_AT = "2025-03-01T09:00:00.000Z"

/**
 * The account the `/app` loader puts into the cache before the dashboard
 * renders. The welcome shows only while `welcomeSeenAt` is null (#108 D01).
 */
const sdkAccount = (welcomeSeenAt: string | null): TaxMaxiAccount => ({
  account: {
    id: "00000000-0000-4000-8000-000000000001",
    email: "user@example.test",
    displayName: "User",
    role: "member",
    emailVerified: true,
    welcomeSeenAt,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  },
  loginMethods: [],
})

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>()
  return {
    ...actual,
    Link: ({ children, to }: { readonly children: ReactNode; readonly to: string }) => (
      <a href={to}>{children}</a>
    ),
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

// Mirrors the real island's Retry rule: a failed item offers Retry when a
// handler exists and `canRetry` (default yes) allows it.
vi.mock("#/components/source-sync-island", () => ({
  SourceSyncIsland: ({
    canRetry,
    items,
    onRetry,
  }: {
    readonly canRetry?: (item: SourceSyncIslandItem) => boolean
    readonly items: ReadonlyArray<SourceSyncIslandItem>
    readonly onRetry?: (item: SourceSyncIslandItem) => void
  }) => (
    <div data-testid="sync-island">
      {items.map((item) => (
        <span key={item.id}>
          {item.status}
          {item.status === "failed" && onRetry && (canRetry?.(item) ?? true) ? (
            <button onClick={() => onRetry(item)} type="button">
              Retry
            </button>
          ) : null}
        </span>
      ))}
    </div>
  ),
}))

vi.mock("#/components/ui/tabs", () => ({
  Tabs: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({
    children,
    ref,
  }: {
    readonly children: ReactNode
    readonly ref?: Ref<HTMLButtonElement>
  }) => <button ref={ref}>{children}</button>,
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
      activeSyncs: syncState.activeSyncs,
      onDismissSync: vi.fn(),
      onRetrySync: vi.fn(),
      onSourceSync: syncState.onSourceSync,
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
    queryClient.setQueryData(queryKeys.account(), sdkAccount(WELCOME_SEEN_AT))

    render(
      <QueryClientProvider client={queryClient}>
        <Dashboard
          accounts={[]}
          onSourceSyncCompleted={async () => {
            await queryClient.invalidateQueries({ queryKey: queryKeys.transactions() })
          }}
          sourceOverviews={syncedOverviews}
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
    queryClient.setQueryData(queryKeys.account(), sdkAccount(WELCOME_SEEN_AT))
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
        <Dashboard accounts={[]} sourceOverviews={syncedOverviews} sourceSyncSeeds={seeds} />
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
    queryClient.setQueryData(queryKeys.account(), sdkAccount(WELCOME_SEEN_AT))
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
        <Dashboard
          accounts={[]}
          onUnauthorized={onUnauthorized}
          sourceOverviews={syncedOverviews}
        />
      </QueryClientProvider>
    )

  it("refreshes an older selected year after sync while preserving source and canonical selection", async () => {
    const row = {
      ...transaction("00000000-0000-4000-8000-000000000101", "Older-year transaction"),
      timestamp: "2024-06-01T12:00:00.000Z",
    }
    const runA = "00000000-0000-4000-8000-000000000701"
    const runB = "00000000-0000-4000-8000-000000000702"
    let completed = false
    let disappeared = false
    const requests: URL[] = []
    const detail = (): TransactionDetail => ({
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
          id: completed ? runB : runA,
          taxYear: 2024,
          jurisdiction: "DE",
          reportingCurrency: "EUR",
          status: "complete",
          engineVersion: "fixture",
          ruleSetVersion: "fixture",
          inputLedgerRevision: completed ? "2" : "1",
          valuationRevision: completed ? "2" : "1",
          failureCode: null,
        },
        state: "complete",
        monetaryStatus: "available",
        derivedLots: [],
        income: [],
        blockers: [],
        processedEventIds: [],
        correctionInputs: [],
        allocations: [
          {
            sequence: 0,
            acquisitionEventId: "00000000-0000-4000-8000-000000000703",
            dispositionEventId: "00000000-0000-4000-8000-000000000704",
            assetId: "00000000-0000-4000-8000-000000000705",
            custodyUnitId: row.source.sourceId,
            acquiredAt: "2024-01-01T00:00:00.000Z",
            disposedAt: row.timestamp,
            quantity: "2",
            costBasis: completed ? "30" : "20",
            proceeds: "30",
            gainLoss: completed ? "0" : "10",
            treatmentCodes: [],
          },
        ],
      },
    })
    let work: PortfolioCalculationStatus["work"]["status"] = "not_requested"
    const selectedStatus = (): PortfolioCalculationStatus => {
      const status = completed ? "succeeded" : work
      const request = {
        requestId: "selected-year-request",
        sourceId: row.source.sourceId,
        sourceJobId: "00000000-0000-4000-8000-000000000706",
        status: status === "not_requested" ? "queued" : status,
        attempts:
          status === "running" || status === "succeeded"
            ? [
                {
                  attemptId: "selected-year-attempt",
                  runId: runB,
                  status,
                  failureCode: null,
                },
              ]
            : [],
      } satisfies PortfolioCalculationStatus["work"]["requests"][number]
      return {
        scope: { taxYear: 2024, jurisdiction: "DE", reportingCurrency: "EUR" },
        activeRun: { runId: completed ? runB : runA, status: "complete" },
        work: { status, requests: status === "not_requested" ? [] : [request] },
        jobs:
          status === "not_requested"
            ? []
            : [
                {
                  sourceId: request.sourceId,
                  sourceJobId: request.sourceJobId,
                  sourceJobStatus: "completed",
                  work: request,
                  coveringRun: completed ? { runId: runB, status: "complete" } : null,
                  activeCoverage: completed ? "covered" : "not_covered",
                },
              ],
      }
    }
    testTaxMaxi = TaxMaxi.fromBrowserSession({
      baseUrl: "https://dashboard.example.test",
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        requests.push(url)
        if (url.pathname.endsWith("/portfolio/calculation-status"))
          return Response.json(selectedStatus())
        if (url.pathname.endsWith("/portfolio/assets")) return Response.json(currentPortfolio)
        if (url.pathname.endsWith("/transactions"))
          return Response.json({
            transactions: disappeared ? [] : [{ ...row, realizedGainLoss: completed ? "0" : "10" }],
            totalCount: disappeared ? 0 : 1,
            page: { hasMore: false, nextCursor: null },
          })
        if (url.pathname.endsWith(row.transactionId))
          return disappeared
            ? Response.json({ _tag: "TransactionNotFoundError" }, { status: 404 })
            : Response.json(detail())
        throw new Error(`Unexpected fixture URL: ${url}`)
      },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <Dashboard
          accounts={[]}
          sourceOverviews={syncedOverviews}
          onSourceSyncCompleted={() => refreshTransactionQueries(queryClient)}
        />
      </QueryClientProvider>
    )
    await tick()
    fireEvent.click(screen.getByRole("button", { name: "Source A" }))
    await tick()
    fireEvent.click(screen.getByRole("button", { name: /Open transaction/ }))
    await tick()
    expect(screen.getByText(`Returned run: ${runA} · 2024 · DE · EUR`)).toBeTruthy()
    expect(screen.getByText("Not requested")).toBeTruthy()
    work = "queued"
    await act(async () => {
      await syncState.onCompleted?.(row.source.sourceId)
    })
    await tick()
    expect(screen.getByText("Queued")).toBeTruthy()
    expect(screen.getByText(`Returned run: ${runA} · 2024 · DE · EUR`)).toBeTruthy()
    work = "running"
    await tick(2_000)
    expect(screen.getByText("Running")).toBeTruthy()
    completed = true
    await tick(2_000)
    expect(screen.getByText(`Returned run: ${runB} · 2024 · DE · EUR`)).toBeTruthy()
    expect(
      within(screen.getByRole("region", { name: "Disposal allocation 1" })).getByText("0 EUR")
    ).toBeTruthy()
    expect(screen.getAllByText(row.source.sourceId).length).toBeGreaterThan(0)
    expect(
      requests
        .filter((url) => url.pathname.endsWith(row.transactionId))
        .every((url) => url.searchParams.get("taxYear") === "2024")
    ).toBe(true)
    const listRequests = requests.filter((url) => url.pathname.endsWith("/transactions"))
    expect(listRequests).toHaveLength(4)
    expect(new Set(listRequests.map((url) => url.search)).size).toBe(1)
    const settledReads = requests.filter((url) => url.pathname.endsWith(row.transactionId)).length
    await tick(4_000)
    expect(requests.filter((url) => url.pathname.endsWith(row.transactionId))).toHaveLength(
      settledReads
    )
    expect(currentPortfolio.activeRun?.runId).toBe(RUN_A)
    disappeared = true
    await act(async () => {
      await refreshTransactionQueries(queryClient)
    })
    await tick()
    expect(
      screen.getByText("This transaction is no longer available. Your selection has been kept.")
    ).toBeTruthy()
    expect(screen.getByText("Older-year transaction")).toBeTruthy()
    expect(
      requests
        .filter((url) => url.pathname.endsWith(row.transactionId))
        .every((url) => url.searchParams.get("taxYear") === "2024")
    ).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Close transaction" }))
    await tick(500)
    expect(screen.getByText(row.source.sourceId)).toBeTruthy()
  })

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

describe("Dashboard first-sync body (#108 T05, T06, T07)", () => {
  let queryClient: QueryClient
  let billingReads: number
  let respondBilling: () => Promise<BillingStatus>
  let welcomeMarks: number
  let respondWelcomeMark: () => Promise<TaxMaxiAccount>
  let accountReads: number
  let respondAccountRead: () => Promise<TaxMaxiAccount>

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(queryKeys.account(), sdkAccount(WELCOME_SEEN_AT))
    billingReads = 0
    respondBilling = async () => billingStatus(1)
    welcomeMarks = 0
    respondWelcomeMark = async () => sdkAccount(WELCOME_SEEN_AT)
    accountReads = 0
    respondAccountRead = async () => sdkAccount(null)
    syncState.activeSyncs = []
    testTaxMaxi = {
      auth: {
        account: vi.fn(async () => {
          accountReads += 1
          return respondAccountRead()
        }),
        markWelcomeSeen: vi.fn(async () => {
          welcomeMarks += 1
          return respondWelcomeMark()
        }),
      },
      billing: {
        status: vi.fn(async () => {
          billingReads += 1
          return respondBilling()
        }),
      },
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
  })

  afterEach(() => {
    cleanup()
    queryClient.clear()
    syncState.activeSyncs = []
    syncState.onCompleted = undefined
    vi.clearAllMocks()
  })

  const mount = (overviews: ReadonlyArray<SourceOverview>) =>
    render(
      <QueryClientProvider client={queryClient}>
        <Dashboard
          accounts={overviews.map(toAccount)}
          createWalletSource={vi.fn()}
          sourceOverviews={overviews}
        />
      </QueryClientProvider>
    )

  const assetsTab = () => screen.queryByRole("button", { name: "Assets" })

  describe("welcome step (#108 T07)", () => {
    const welcomeHeading = () => screen.queryByRole("heading", { name: "Hi, I'm Max." })
    const cachedWelcomeSeenAt = () =>
      queryClient.getQueryData<TaxMaxiAccount>(queryKeys.account())?.account.welcomeSeenAt
    const seedWelcomeUnseen = () => queryClient.setQueryData(queryKeys.account(), sdkAccount(null))
    // This describe runs on real timers; let a resolved promise chain and React Query's
    // notifications run to completion.
    const settle = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

    it("shows the welcome ahead of the state step while welcomeSeenAt is null; Continue marks it seen once and writes the account back", async () => {
      seedWelcomeUnseen()
      mount([sourceOverview()])

      expect(await screen.findByRole("heading", { name: "Hi, I'm Max." })).toBeTruthy()
      expect(screen.queryByRole("heading", { name: "Ready when you are" })).toBeNull()
      expect(welcomeMarks).toBe(0)

      fireEvent.click(screen.getByRole("button", { name: "Next" }))
      fireEvent.click(screen.getByRole("button", { name: "Next" }))
      fireEvent.click(screen.getByRole("button", { name: "Continue" }))

      expect(welcomeMarks).toBe(1)
      const ready = await screen.findByRole("heading", { name: "Ready when you are" })
      expect(document.activeElement).toBe(ready)
      expect(welcomeHeading()).toBeNull()
      await waitFor(() => expect(cachedWelcomeSeenAt()).toBe(WELCOME_SEEN_AT))
      expect(welcomeMarks).toBe(1)
    })

    it("shows the welcome once over a synced dashboard, then the tabs after Skip", async () => {
      seedWelcomeUnseen()
      mount(syncedOverviews)

      expect(await screen.findByRole("heading", { name: "Hi, I'm Max." })).toBeTruthy()
      expect(assetsTab()).toBeNull()

      fireEvent.click(screen.getByRole("button", { name: "Skip" }))

      expect(welcomeMarks).toBe(1)
      expect(await screen.findByText("No transactions yet.")).toBeTruthy()
      expect(assetsTab()).toBeTruthy()
      expect(welcomeHeading()).toBeNull()
      expect(screen.queryByRole("status", { name: "First sync updates" })).toBeNull()
      expect(billingReads).toBe(0)
      await waitFor(() => expect(cachedWelcomeSeenAt()).toBe(WELCOME_SEEN_AT))
    })

    it("never shows the welcome once welcomeSeenAt is set, and calls nothing on mount", async () => {
      mount([sourceOverview()])

      expect(await screen.findByRole("heading", { name: "Ready when you are" })).toBeTruthy()
      expect(welcomeHeading()).toBeNull()
      expect(welcomeMarks).toBe(0)
    })

    it("still advances when the mark fails, leaving the cached fact null for a retry on the next visit", async () => {
      seedWelcomeUnseen()
      respondWelcomeMark = async () => {
        throw new Error("offline")
      }
      mount([sourceOverview()])

      expect(await screen.findByRole("heading", { name: "Hi, I'm Max." })).toBeTruthy()

      fireEvent.click(screen.getByRole("button", { name: "Skip" }))

      expect(welcomeMarks).toBe(1)
      expect(await screen.findByRole("heading", { name: "Ready when you are" })).toBeTruthy()
      await act(async () => {
        await Promise.resolve()
      })
      expect(cachedWelcomeSeenAt()).toBeNull()
      expect(welcomeHeading()).toBeNull()
    })

    it("moves focus to the first tab when finishing the welcome shows the tabs", async () => {
      seedWelcomeUnseen()
      mount(syncedOverviews)

      expect(await screen.findByRole("heading", { name: "Hi, I'm Max." })).toBeTruthy()

      fireEvent.click(screen.getByRole("button", { name: "Next" }))
      fireEvent.click(screen.getByRole("button", { name: "Next" }))
      fireEvent.click(screen.getByRole("button", { name: "Continue" }))

      await waitFor(() => expect(assetsTab()).toBeTruthy())
      expect(document.activeElement).toBe(assetsTab())
      expect(welcomeHeading()).toBeNull()
    })

    it("drops a mark that resolves after logout removed the client state", async () => {
      let resolveWelcomeMark: (account: TaxMaxiAccount) => void = () => {}
      respondWelcomeMark = () =>
        new Promise((resolve) => {
          resolveWelcomeMark = resolve
        })
      seedWelcomeUnseen()
      const { unmount } = mount(syncedOverviews)

      expect(await screen.findByRole("heading", { name: "Hi, I'm Max." })).toBeTruthy()
      fireEvent.click(screen.getByRole("button", { name: "Skip" }))
      expect(welcomeMarks).toBe(1)

      // Logout: the dashboard unmounts and the taxmaxi queries are removed.
      unmount()
      queryClient.removeQueries({ queryKey: queryKeys.all })

      resolveWelcomeMark(sdkAccount(WELCOME_SEEN_AT))
      await settle()

      expect(queryClient.getQueryData(queryKeys.account())).toBeUndefined()
    })

    it("never writes a late mark over another user's cached account", async () => {
      let resolveWelcomeMark: (account: TaxMaxiAccount) => void = () => {}
      respondWelcomeMark = () =>
        new Promise((resolve) => {
          resolveWelcomeMark = resolve
        })
      seedWelcomeUnseen()
      mount(syncedOverviews)

      expect(await screen.findByRole("heading", { name: "Hi, I'm Max." })).toBeTruthy()
      fireEvent.click(screen.getByRole("button", { name: "Skip" }))
      expect(welcomeMarks).toBe(1)

      // Another user logs in in the same tab before the first user's mark resolves.
      const unseen = sdkAccount(null)
      const otherUser: TaxMaxiAccount = {
        ...unseen,
        account: {
          ...unseen.account,
          email: "other@example.test",
          id: "00000000-0000-4000-8000-000000000002",
        },
      }
      queryClient.removeQueries({ queryKey: queryKeys.all })
      queryClient.setQueryData(queryKeys.account(), otherUser)

      resolveWelcomeMark(sdkAccount(WELCOME_SEEN_AT))
      await settle()

      expect(queryClient.getQueryData(queryKeys.account())).toEqual(otherUser)
    })

    it("keeps the mark when an account read that started earlier resolves later with the old fact", async () => {
      let resolveAccountRead: (account: TaxMaxiAccount) => void = () => {}
      respondAccountRead = () =>
        new Promise((resolve) => {
          resolveAccountRead = resolve
        })
      // A stale cached account starts a background read when the query mounts.
      queryClient.setQueryData(queryKeys.account(), sdkAccount(null), {
        updatedAt: Date.now() - 6 * 60 * 1000,
      })
      mount([sourceOverview()])

      expect(await screen.findByRole("heading", { name: "Hi, I'm Max." })).toBeTruthy()
      await waitFor(() => expect(accountReads).toBe(1))

      fireEvent.click(screen.getByRole("button", { name: "Skip" }))
      expect(welcomeMarks).toBe(1)
      await waitFor(() => expect(cachedWelcomeSeenAt()).toBe(WELCOME_SEEN_AT))

      resolveAccountRead(sdkAccount(null))
      await settle()

      expect(cachedWelcomeSeenAt()).toBe(WELCOME_SEEN_AT)
      expect(accountReads).toBe(1)
    })
  })

  it("shows the wizard instead of the tabs while no source has synced", async () => {
    mount([sourceOverview()])

    expect(await screen.findByRole("heading", { name: "Ready when you are" })).toBeTruthy()
    expect(assetsTab()).toBeNull()
    expect(screen.queryByRole("region", { name: "Portfolio calculation" })).toBeNull()
    expect(billingReads).toBe(1)
  })

  it("shows the tabs and no wizard once a source has synced, without reading billing", async () => {
    mount(syncedOverviews)

    expect(await screen.findByText("No transactions yet.")).toBeTruthy()
    expect(assetsTab()).toBeTruthy()
    expect(screen.queryByRole("status", { name: "First sync updates" })).toBeNull()
    expect(billingReads).toBe(0)
  })

  it("asks for a source when there is none", async () => {
    mount([])

    expect(await screen.findByRole("heading", { name: "Connect your first source" })).toBeTruthy()
    expect(screen.getByRole("textbox", { name: "Crypto wallet address" })).toBeTruthy()
    expect(assetsTab()).toBeNull()
  })

  it("keeps the island mounted above the wizard while the first sync runs", async () => {
    syncState.activeSyncs = [
      { id: SOURCE_A, sourceName: "Coinbase", status: "running", progress: 18 },
    ]
    mount([sourceOverview()])

    const heading = await screen.findByRole("heading", { name: "Importing your Coinbase history" })
    const island = screen.getByTestId("sync-island")
    expect(island.textContent).toBe("running")
    expect(island.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryAllByRole("button")).toEqual([])
  })

  it("never renders lastErrorMessage or a job message after a failed first sync", async () => {
    const overviewError = "HTTP 502 from provider: upstream connect error (job 8f3c)"
    const jobMessage = "ECONNRESET while fetching page 4"
    syncState.activeSyncs = [
      {
        id: SOURCE_A,
        sourceName: "Coinbase",
        status: "failed",
        progress: 100,
        message: jobMessage,
      },
    ]
    mount([sourceOverview({ status: "failed", lastErrorMessage: overviewError })])

    expect(
      await screen.findByRole("heading", { name: "Your first sync didn't finish" })
    ).toBeTruthy()
    expect(document.body.textContent).not.toContain(overviewError)
    expect(document.body.textContent).not.toContain(jobMessage)
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(syncState.onSourceSync).toHaveBeenCalledTimes(1)
    expect(syncState.onSourceSync.mock.calls[0]?.[0]).toMatchObject({ id: SOURCE_A })
  })

  it("leaves Try again as the only retry for the wizard's source while the island keeps Retry for others", async () => {
    const SOURCE_B = "00000000-0000-4000-8000-000000000202"
    syncState.activeSyncs = [
      { id: SOURCE_A, sourceName: "Coinbase", status: "failed", progress: 100 },
      { id: SOURCE_B, sourceName: "Kraken", status: "failed", progress: 100 },
    ]
    mount([sourceOverview({ status: "failed" }), sourceOverview({ status: "failed" }, SOURCE_B)])

    expect(
      await screen.findByRole("heading", { name: "Your first sync didn't finish" })
    ).toBeTruthy()
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy()
    const island = screen.getByTestId("sync-island")
    expect(within(island).getAllByRole("button", { name: "Retry" })).toHaveLength(1)
    // Source A (the wizard's target) shows no Retry; source B keeps it.
    expect(island.children[0]?.textContent).toBe("failed")
    expect(island.children[1]?.textContent).toBe("failedRetry")
  })

  it("lets the island offer Retry for a failed sync once the wizard is gone", async () => {
    syncState.activeSyncs = [
      { id: SOURCE_A, sourceName: "Coinbase", status: "failed", progress: 100 },
    ]
    mount(syncedOverviews)

    expect(await screen.findByRole("button", { name: "Assets" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull()
    const island = screen.getByTestId("sync-island")
    expect(within(island).getByRole("button", { name: "Retry" })).toBeTruthy()
  })

  it("shows billing_unknown with a retry when billing fails, then recovers", async () => {
    respondBilling = async () => {
      throw new Error("Stripe is unavailable")
    }
    mount([sourceOverview()])

    expect(await screen.findByRole("heading", { name: "We couldn't check your plan" })).toBeTruthy()
    // While the read is still in flight the retry waits as "Checking…"; the
    // enabled Retry appears once the failure has landed.
    const retry = await screen.findByRole("button", { name: "Retry" })
    expect(screen.queryByRole("button", { name: "Start my first sync" })).toBeNull()
    expect(document.body.textContent).not.toContain("Stripe is unavailable")

    respondBilling = async () => billingStatus(1)
    fireEvent.click(retry)

    expect(await screen.findByRole("heading", { name: "Ready when you are" })).toBeTruthy()
    expect(billingReads).toBe(2)
  })

  it("shows billing_unknown when a billing refresh fails even though older credits are cached", async () => {
    respondBilling = async () => billingStatus(5)
    mount([sourceOverview()])

    expect(await screen.findByRole("heading", { name: "Ready when you are" })).toBeTruthy()
    expect(screen.getByText("5 credits available")).toBeTruthy()

    respondBilling = async () => {
      throw new Error("Stripe is unavailable")
    }
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: queries.billingStatus(testTaxMaxi).queryKey })
    })

    expect(await screen.findByRole("heading", { name: "We couldn't check your plan" })).toBeTruthy()
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Start my first sync" })).toBeNull()
    expect(screen.queryByText("5 credits available")).toBeNull()
    expect(queryClient.getQueryData(queries.billingStatus(testTaxMaxi).queryKey)).toMatchObject({
      credits: 5,
    })
    expect(billingReads).toBe(2)
  })

  // A fresh element per render, so React re-renders the dashboard and the
  // hook mock hands over the changed items.
  const dashboardTree = (overviews: ReadonlyArray<SourceOverview>) => (
    <QueryClientProvider client={queryClient}>
      <Dashboard
        accounts={overviews.map(toAccount)}
        createWalletSource={vi.fn()}
        sourceOverviews={overviews}
      />
    </QueryClientProvider>
  )

  const billingKey = () => queries.billingStatus(testTaxMaxi).queryKey
  const pausedHeading = () =>
    screen.queryByRole("heading", { name: "Sync paused — more credits needed" })
  const continueButton = () => screen.queryByRole("button", { name: "Continue my first sync" })

  /** Runs a first sync that stops for credits while the cache still says `credits: 1`. */
  const stopForCredits = async (creditsAfterStop: number) => {
    const overviews = [sourceOverview()]
    const view = render(dashboardTree(overviews))
    expect(await screen.findByRole("heading", { name: "Ready when you are" })).toBeTruthy()
    expect(queryClient.getQueryData(billingKey())).toMatchObject({ credits: 1 })

    syncState.activeSyncs = [
      { id: SOURCE_A, sourceName: "Coinbase", status: "running", progress: 40 },
    ]
    view.rerender(dashboardTree(overviews))
    expect(screen.getByRole("heading", { name: "Importing your Coinbase history" })).toBeTruthy()

    // The sync spends the last credit; the server pauses the job.
    respondBilling = async () => billingStatus(creditsAfterStop)
    syncState.activeSyncs = [
      { id: SOURCE_A, sourceName: "Coinbase", status: "credit_required", progress: 100 },
    ]
    view.rerender(dashboardTree(overviews))

    // The cache still says 1 credit, but the wizard does not offer Continue
    // from it: billing is re-read first.
    expect(pausedHeading()).toBeTruthy()
    expect(continueButton()).toBeNull()
    expect(screen.getByText("Add credits from the notice at the top of the page.")).toBeTruthy()
    await waitFor(() => expect(billingReads).toBe(2))
    await waitFor(() =>
      expect(queryClient.getQueryData(billingKey())).toMatchObject({ credits: creditsAfterStop })
    )
    return view
  }

  it("re-reads billing when the sync stops for credits and stays paused when none are left", async () => {
    await stopForCredits(0)

    await waitFor(() => expect(queryClient.getQueryState(billingKey())?.fetchStatus).toBe("idle"))
    expect(pausedHeading()).toBeTruthy()
    expect(continueButton()).toBeNull()
    expect(screen.queryByRole("button", { name: "Start my first sync" })).toBeNull()
  })

  it("offers Continue only after the re-read billing shows credits", async () => {
    await stopForCredits(3)

    expect(await screen.findByRole("heading", { name: "Ready to continue" })).toBeTruthy()
    expect(screen.getByText("3 credits available")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Continue my first sync" }))
    expect(syncState.onSourceSync).toHaveBeenCalledTimes(1)
    expect(syncState.onSourceSync.mock.calls[0]?.[0]).toMatchObject({ id: SOURCE_A })
  })

  it("offers the billing action itself once the island's credit_required item is dismissed", async () => {
    queryClient.setQueryData(billingKey(), billingStatus(0))
    respondBilling = async () => billingStatus(0)
    const overviews = [sourceOverview({ jobId: "job-1", status: "credit_required" })]
    syncState.activeSyncs = [
      {
        id: SOURCE_A,
        jobId: "job-1",
        sourceName: "Coinbase",
        status: "credit_required",
        progress: 100,
      },
    ]
    const view = render(dashboardTree(overviews))

    expect(await screen.findByRole("heading", { name: "Sync paused — more credits needed" }))
    expect(screen.getByText("Add credits from the notice at the top of the page.")).toBeTruthy()
    expect(screen.queryByRole("link", { name: "Choose a plan" })).toBeNull()
    await waitFor(() => expect(billingReads).toBe(1))

    // The user dismisses the island's notice; the hook drops the item.
    syncState.activeSyncs = []
    view.rerender(dashboardTree(overviews))

    expect(pausedHeading()).toBeTruthy()
    expect(screen.getByRole("link", { name: "Choose a plan" }).getAttribute("href")).toBe(
      "/app/billing"
    )
    expect(screen.queryByText("Add credits from the notice at the top of the page.")).toBeNull()
    expect(screen.queryAllByRole("button")).toEqual([])
    // The seeded stop re-read billing once for job-1; the dismissal and the
    // overview naming the same job add no second read.
    await waitFor(() => expect(queryClient.getQueryState(billingKey())?.fetchStatus).toBe("idle"))
    expect(billingReads).toBe(1)
  })

  /**
   * Reloads onto a job already paused for credits while the cache still says
   * `credits: 3`, holding the re-read open until the test releases it.
   */
  const reloadOntoCreditStop = () => {
    queryClient.setQueryData(billingKey(), billingStatus(3))
    let release: ((billing: BillingStatus) => void) | undefined
    respondBilling = () =>
      new Promise<BillingStatus>((resolve) => {
        release = resolve
      })
    const overviews = [sourceOverview({ jobId: "job-1", status: "credit_required" })]
    syncState.activeSyncs = [
      {
        id: SOURCE_A,
        jobId: "job-1",
        sourceName: "Coinbase",
        status: "credit_required",
        progress: 100,
      },
    ]
    const view = render(dashboardTree(overviews))

    // The cached 3 credits are fresh but predate the stop: paused, no Continue.
    expect(pausedHeading()).toBeTruthy()
    expect(continueButton()).toBeNull()
    return {
      view,
      overviews,
      release: (billing: BillingStatus) => {
        if (release === undefined) throw new Error("billing re-read has not started")
        release(billing)
      },
    }
  }

  it("re-reads billing once for a seeded credit_required job and stays paused until it settles", async () => {
    const { overviews, release, view } = reloadOntoCreditStop()

    await waitFor(() => expect(billingReads).toBe(1))
    view.rerender(dashboardTree(overviews))
    expect(pausedHeading()).toBeTruthy()
    expect(continueButton()).toBeNull()

    release(billingStatus(3))
    expect(await screen.findByRole("heading", { name: "Ready to continue" })).toBeTruthy()
    expect(screen.getByText("3 credits available")).toBeTruthy()
    view.rerender(dashboardTree(overviews))
    await waitFor(() => expect(queryClient.getQueryState(billingKey())?.fetchStatus).toBe("idle"))
    expect(billingReads).toBe(1)
  })

  it("keeps a seeded credit_required job paused when the re-read shows no credits", async () => {
    const { release } = reloadOntoCreditStop()

    await waitFor(() => expect(billingReads).toBe(1))
    release(billingStatus(0))
    await waitFor(() =>
      expect(queryClient.getQueryData(billingKey())).toMatchObject({ credits: 0 })
    )
    await waitFor(() => expect(queryClient.getQueryState(billingKey())?.fetchStatus).toBe("idle"))
    expect(pausedHeading()).toBeTruthy()
    expect(continueButton()).toBeNull()
    expect(screen.queryByRole("button", { name: "Start my first sync" })).toBeNull()
    expect(billingReads).toBe(1)
  })

  it("derives syncing from a processing overview job on the first render, before the hook has an item", () => {
    queryClient.setQueryData(queries.billingStatus(testTaxMaxi).queryKey, billingStatus(5))

    mount([sourceOverview({ jobId: "job-1", status: "processing" })])

    expect(screen.getByRole("heading", { name: "Importing your Coinbase history" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Start my first sync" })).toBeNull()
    expect(screen.queryAllByRole("button")).toEqual([])
    expect(assetsTab()).toBeNull()
  })

  // Mirrors the `/app` route: accounts and overviews come from the overview
  // query, and a completed sync invalidates that query.
  const OverviewHarness = ({ readOverview }: { readOverview: () => Promise<SourceOverview> }) => {
    const overview = useQuery({
      queryKey: queryKeys.sourceOverview(SOURCE_A),
      queryFn: readOverview,
      staleTime: Infinity,
    }).data
    if (overview === undefined) return null
    return (
      <Dashboard
        accounts={[toAccount(overview)]}
        onSourceSyncCompleted={async (sourceId) => {
          await queryClient.invalidateQueries({
            exact: true,
            queryKey: queryKeys.sourceOverview(sourceId),
          })
        }}
        sourceOverviews={[overview]}
      />
    )
  }

  it("keeps syncing after the completed item is gone until the overview refetch confirms it", async () => {
    let overviewReads = 0
    let releaseOverview: ((overview: SourceOverview) => void) | undefined
    const readOverview = async () => {
      overviewReads += 1
      if (overviewReads === 1) return sourceOverview()
      return new Promise<SourceOverview>((resolve) => {
        releaseOverview = resolve
      })
    }
    // A fresh element per render, so React re-renders the dashboard and the
    // hook mock hands over the changed items.
    const tree = () => (
      <QueryClientProvider client={queryClient}>
        <OverviewHarness readOverview={readOverview} />
      </QueryClientProvider>
    )

    const view = render(tree())
    expect(await screen.findByRole("heading", { name: "Ready when you are" })).toBeTruthy()

    syncState.activeSyncs = [
      { id: SOURCE_A, sourceName: "Coinbase", status: "completed", progress: 100 },
    ]
    view.rerender(tree())
    expect(screen.getByRole("heading", { name: "Importing your Coinbase history" })).toBeTruthy()

    // The job completes: the refetch starts but has not resolved yet, and the
    // hook drops its completed item in the meantime.
    await act(async () => {
      void syncState.onCompleted?.(SOURCE_A)
    })
    expect(overviewReads).toBe(2)
    syncState.activeSyncs = []
    view.rerender(tree())

    expect(screen.getByRole("heading", { name: "Importing your Coinbase history" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Start my first sync" })).toBeNull()
    expect(assetsTab()).toBeNull()

    await act(async () => {
      releaseOverview?.(
        sourceOverview({ lastSyncedAt: "2025-03-10T12:00:00.000Z", status: "completed" })
      )
    })

    expect(await screen.findByRole("button", { name: "Assets" })).toBeTruthy()
    expect(screen.queryByRole("heading", { name: "Importing your Coinbase history" })).toBeNull()
  })

  it("moves from the wizard to the tabs when the completed sync refreshes the overview", async () => {
    let overviewReads = 0
    const readOverview = async () => {
      overviewReads += 1
      return overviewReads === 1
        ? sourceOverview()
        : sourceOverview({ lastSyncedAt: "2025-03-10T12:00:00.000Z", status: "completed" })
    }

    render(
      <QueryClientProvider client={queryClient}>
        <OverviewHarness readOverview={readOverview} />
      </QueryClientProvider>
    )

    expect(await screen.findByRole("heading", { name: "Ready when you are" })).toBeTruthy()
    expect(assetsTab()).toBeNull()
    expect(syncState.onSourceSync).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Start my first sync" }))
    expect(syncState.onSourceSync).toHaveBeenCalledTimes(1)
    expect(syncState.onSourceSync.mock.calls[0]?.[0]).toMatchObject({ id: SOURCE_A })

    await act(async () => {
      await syncState.onCompleted?.(SOURCE_A)
    })

    expect(await screen.findByRole("button", { name: "Assets" })).toBeTruthy()
    expect(screen.queryByRole("heading", { name: "Ready when you are" })).toBeNull()
    expect(screen.queryByRole("status", { name: "First sync updates" })).toBeNull()
    expect(overviewReads).toBe(2)
    expect(queryClient.getQueryData(queries.billingStatus(testTaxMaxi).queryKey)).toBeDefined()
    // The completed sync spent credits, so the completion re-reads billing.
    await waitFor(() => expect(billingReads).toBe(2))
  })

  // #108 T06 (D07): after a Checkout return the billing overlay writes the
  // refreshed status into the `billingStatus` cache. The dashboard stays
  // mounted underneath and its wizard follows the cache: no reload, no
  // remount, no extra billing read.
  const writeBillingToCache = async (billing: BillingStatus) => {
    await act(async () => {
      queryClient.setQueryData(billingKey(), billing)
      // React Query delivers observer notifications on a separate timer.
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  it("moves from needs_credits to ready when the billing overlay writes credits into the cache, without remount", async () => {
    respondBilling = async () => billingStatus(0)
    mount([sourceOverview()])

    expect(
      await screen.findByRole("heading", { name: "Pick a plan to unlock your import" })
    ).toBeTruthy()
    expect(screen.getByRole("link", { name: "Choose a plan" })).toBeTruthy()
    await waitFor(() => expect(queryClient.getQueryState(billingKey())?.fetchStatus).toBe("idle"))
    const liveRegion = screen.getByRole("status", { name: "First sync updates" })

    await writeBillingToCache(billingStatus(5))

    expect(screen.getByRole("heading", { name: "Ready when you are" })).toBeTruthy()
    expect(screen.getByText("5 credits available")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Start my first sync" })).toBeTruthy()
    expect(screen.queryByRole("link", { name: "Choose a plan" })).toBeNull()
    // The same wizard instance moved: its live region is the same DOM node.
    expect(screen.getByRole("status", { name: "First sync updates" })).toBe(liveRegion)
    expect(billingReads).toBe(1)
  })

  // #133 T09b: closing the overlay invalidates `billingStatus` (D07). When the
  // status the API now returns carries the subscription, the wizard moves to
  // `ready` from that re-read alone, with no reload.
  it("moves from needs_credits to ready when the overlay closes and the re-read status carries credits", async () => {
    respondBilling = async () => billingStatus(0)
    mount([sourceOverview()])

    expect(
      await screen.findByRole("heading", { name: "Pick a plan to unlock your import" })
    ).toBeTruthy()
    await waitFor(() => expect(queryClient.getQueryState(billingKey())?.fetchStatus).toBe("idle"))
    expect(billingReads).toBe(1)
    const liveRegion = screen.getByRole("status", { name: "First sync updates" })

    // Stripe's webhook landed while the overlay was open; closing it
    // invalidates the query exactly as `closeOverlay` in app.billing.tsx does.
    respondBilling = async () => billingStatus(10_000, "active")
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: billingKey() })
    })

    expect(await screen.findByRole("heading", { name: "Ready when you are" })).toBeTruthy()
    expect(screen.getByText("10,000 credits available")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Start my first sync" })).toBeTruthy()
    expect(screen.queryByRole("link", { name: "Choose a plan" })).toBeNull()
    expect(screen.getByRole("status", { name: "First sync updates" })).toBe(liveRegion)
    expect(billingReads).toBe(2)
  })

  it("moves from paused to resumable when the billing overlay writes credits into the cache, and Continue restarts the same source", async () => {
    queryClient.setQueryData(billingKey(), billingStatus(0))
    respondBilling = async () => billingStatus(0)
    const overviews = [sourceOverview({ jobId: "job-1", status: "credit_required" })]
    syncState.activeSyncs = [
      {
        id: SOURCE_A,
        jobId: "job-1",
        sourceName: "Coinbase",
        status: "credit_required",
        progress: 100,
      },
    ]
    const view = render(dashboardTree(overviews))

    expect(
      await screen.findByRole("heading", { name: "Sync paused — more credits needed" })
    ).toBeTruthy()
    // The stop's one-time billing re-read settles with no credits: still paused.
    await waitFor(() => expect(billingReads).toBe(1))
    await waitFor(() => expect(queryClient.getQueryState(billingKey())?.fetchStatus).toBe("idle"))
    expect(continueButton()).toBeNull()
    const liveRegion = screen.getByRole("status", { name: "First sync updates" })

    // The user bought credits; the overlay wrote the refreshed status (D07).
    await writeBillingToCache(billingStatus(5))

    expect(screen.getByRole("heading", { name: "Ready to continue" })).toBeTruthy()
    expect(screen.getByText("5 credits available")).toBeTruthy()
    expect(screen.getByRole("status", { name: "First sync updates" })).toBe(liveRegion)
    expect(screen.getByTestId("sync-island").textContent).toBe("credit_required")
    expect(billingReads).toBe(1)

    fireEvent.click(screen.getByRole("button", { name: "Continue my first sync" }))
    expect(syncState.onSourceSync).toHaveBeenCalledTimes(1)
    expect(syncState.onSourceSync.mock.calls[0]?.[0]).toMatchObject({ id: SOURCE_A })

    // The hook replaces the island's credit_required item with the new queued
    // job (use-source-syncs.test.tsx proves that replacement itself).
    syncState.activeSyncs = [
      { id: SOURCE_A, jobId: "job-2", sourceName: "Coinbase", status: "queued", progress: 0 },
    ]
    view.rerender(dashboardTree(overviews))

    expect(screen.getByTestId("sync-island").textContent).toBe("queued")
    expect(screen.getByRole("heading", { name: "Importing your Coinbase history" })).toBeTruthy()
    expect(continueButton()).toBeNull()
    expect(screen.queryAllByRole("button")).toEqual([])
    // A queued job is not a credit stop, so billing is not read again.
    await waitFor(() => expect(queryClient.getQueryState(billingKey())?.fetchStatus).toBe("idle"))
    expect(billingReads).toBe(1)
  })
})
