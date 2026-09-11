import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import { useRouteContext } from "@tanstack/react-router"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { Ellipsis, RotateCcw } from "lucide-react"
import {
  isTaxMaxiUnauthorizedError,
  type SourceOverview,
  type SourceSyncJob,
  type SourceSyncJobInput,
  type SourceSyncStart,
  type TransactionListItem,
} from "taxmaxi"

import {
  EMPTY_TRANSACTION_FILTERS,
  transactionFilterInput,
  type TransactionFilters,
} from "#/lib/transaction-filters"

import { appSurfaceClassName } from "#/components/app-workspace"
import { CalculationStatus } from "#/components/calculation-status"
import { AssetsTable } from "#/components/assets-table"
import { FIRST_SYNC_WELCOME_VIDEO_ID, FirstSyncWizard } from "#/components/first-sync-wizard"
import { TransactionFilterControls } from "#/components/transaction-filters"
import { SourceCards } from "#/components/source-cards"
import { Button } from "#/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs"
import { ValueTone } from "#/components/value-tone"
import { useSourceSyncs } from "#/hooks/use-source-syncs"
import { m } from "#/paraglide/messages"

import { accounts as mockAccounts, taxYearAccountSummaries } from "#/fixtures/dashboard-data"
import { formatCurrency, formatPercent, formatSignedCurrency } from "#/lib/dashboard-format"
import { getFirstSyncState } from "#/lib/first-sync-state"
import {
  ALL_ACCOUNTS,
  type Account,
  type AccountId,
  type AccountScope,
  type SourceSyncSeed,
  type TaxYear,
} from "#/lib/dashboard-types"
import {
  queries,
  queryKeys,
  setSessionQueryData,
  prefetchTransactionPage,
} from "#/integrations/taxmaxi/queries"
import {
  TRANSACTION_PAGE_SIZE,
  TransactionsTable,
  parseTransactionPageSize,
  type TransactionPageSize,
} from "./transactions-table"
import { TransactionInspector } from "./transaction-inspector"
import { SourceSyncIsland, type SourceSyncIslandItem } from "./source-sync-island"

type DashboardSummary = {
  currentBalance: string | null
  unrealizedProfitLoss: string | null
  unrealizedProfitLossPercentage: string | null
  realizedProfitLoss: number
  taxesPayable: number
  taxesReceivable: number
  taxableEvents: number
  missingClassifications: number
  importedTransactions: number
  unresolvedItems: number
}

const NO_OVERVIEWS: ReadonlyArray<SourceOverview> = []

/**
 * A source whose sync completed while its overview refetch has not resolved
 * successfully yet. `dataUpdateCount` is the overview query's count at the
 * moment of completion; a later successful fetch raises it.
 */
type PendingCompletion = {
  readonly sourceId: AccountId
  readonly dataUpdateCount: number
}

function getOverviewDataUpdateCount(queryClient: QueryClient, sourceId: AccountId): number {
  return queryClient.getQueryState(queryKeys.sourceOverview(sourceId))?.dataUpdateCount ?? 0
}

function isCompletionConfirmed(queryClient: QueryClient, pending: PendingCompletion): boolean {
  const state = queryClient.getQueryState(queryKeys.sourceOverview(pending.sourceId))
  return state?.status === "success" && state.dataUpdateCount > pending.dataUpdateCount
}

/** The sync hook's item statuses by source id, as one render saw them. */
type ItemStatuses = ReadonlyMap<string, SourceSyncJob["status"]>

const NO_ITEM_STATUSES: ItemStatuses = new Map()

function toItemStatuses(items: ReadonlyArray<{ id: string; status: SourceSyncJob["status"] }>) {
  return new Map(items.map((item) => [item.id, item.status]))
}

function sameItemStatuses(previous: ItemStatuses, next: ItemStatuses): boolean {
  return (
    previous.size === next.size &&
    [...previous].every(([sourceId, status]) => next.get(sourceId) === status)
  )
}

/**
 * True when an item the previous render showed in another status is now
 * `credit_required`: the sync ran out of credits, or a start was refused
 * before any job existed. This catches every live stop, including one
 * without a job id.
 */
function movedIntoCreditRequired(previous: ItemStatuses, next: ItemStatuses): boolean {
  return [...next].some(([sourceId, status]) => {
    const before = previous.get(sourceId)
    return status === "credit_required" && before !== undefined && before !== "credit_required"
  })
}

const NO_JOB_IDS: ReadonlySet<string> = new Set()

/**
 * The job ids of `credit_required` jobs whose billing re-read has not been
 * triggered yet. A live stop, a reload seed that arrives already paused, and
 * the overview's paused job before the seed lands all name the same job, so
 * one id means one re-read however the stop reached the page (#108 D03, T05
 * review). A fresh-but-stale cached balance never decides `resumable`.
 */
function findUnreadCreditStops({
  items,
  overviews,
  readJobIds,
}: {
  items: ReadonlyArray<{ status: SourceSyncJob["status"]; jobId?: string }>
  overviews: ReadonlyArray<SourceOverview>
  readJobIds: ReadonlySet<string>
}): ReadonlyArray<string> {
  const jobIds = new Set<string>()
  for (const item of items) {
    if (item.status === "credit_required" && item.jobId !== undefined) jobIds.add(item.jobId)
  }
  for (const { latestSync } of overviews) {
    if (latestSync.status === "credit_required" && latestSync.jobId !== null) {
      jobIds.add(latestSync.jobId)
    }
  }
  return [...jobIds].filter((jobId) => !readJobIds.has(jobId))
}

const TRANSACTION_PAGE_SIZE_STORAGE_KEY = "taxmaxi.transactions.page-size.v1"

export function Dashboard({
  accounts = mockAccounts,
  createWalletSource,
  getSourceSyncJob,
  onSourceSyncCompleted,
  onUnauthorized,
  replaySourceSync,
  resolveName,
  sourceOverviews = NO_OVERVIEWS,
  sourceSyncSeeds,
  startSourceSync,
  filters: controlledFilters,
  onFiltersChange,
}: {
  filters?: TransactionFilters
  onFiltersChange?: (filters: TransactionFilters) => void
  accounts?: ReadonlyArray<Account>
  createWalletSource?: (walletAddress: string) => Promise<Account>
  getSourceSyncJob?: (input: SourceSyncJobInput) => Promise<SourceSyncJob>
  onSourceSyncCompleted?: (sourceId: AccountId) => void | Promise<void>
  onUnauthorized?: () => void | Promise<void>
  replaySourceSync?: (sourceId: AccountId) => Promise<SourceSyncStart>
  resolveName?: (name: string) => Promise<{ name: string; resolvedAddress: string }>
  /**
   * The source overviews the page loaded, in source order. The first-sync
   * state reads `latestSync` from them (#108 D03); the wizard owns the body
   * until one of them reports a `lastSyncedAt`.
   */
  sourceOverviews?: ReadonlyArray<SourceOverview>
  /** Jobs still running or paused on the server when the page loaded; the island reconnects to them. */
  sourceSyncSeeds?: ReadonlyArray<SourceSyncSeed>
  startSourceSync?: (sourceId: AccountId) => Promise<SourceSyncStart>
}) {
  const taxmaxi = useRouteContext({
    from: "/app",
    select: (context) => context.taxmaxi(),
  })

  const queryClient = useQueryClient()
  const [authenticationLost, setAuthenticationLost] = useState(false)
  const [selectedTransaction, setSelectedTransaction] = useState<{
    transactionId: string
    taxYear: number
    description: string
  } | null>(null)
  const speculativePage = useRef<{
    key: string
    userId: string
    controller: AbortController
    promise: ReturnType<typeof prefetchTransactionPage>
  } | null>(null)
  const pageRequest = useRef<AbortController | null>(null)
  const navigationRequest = useRef(0)
  const navigating = useRef(false)
  const [sequenceRefreshVersion, setSequenceRefreshVersion] = useState<number | null>(null)
  const [navigationPending, setNavigationPending] = useState(false)
  const [navigationFailure, setNavigationFailure] = useState<-1 | 1 | null>(null)
  const [pagePending, setPagePending] = useState(false)
  const [pageFailure, setPageFailure] = useState<-1 | 1 | null>(null)
  const cancelNavigation = useCallback(() => {
    navigationRequest.current += 1
    pageRequest.current?.abort()
    pageRequest.current = null
    navigating.current = false
    setNavigationPending(false)
    setNavigationFailure(null)
    setPagePending(false)
    setPageFailure(null)
  }, [])
  const closeInspector = () => {
    cancelNavigation()
    setSelectedTransaction(null)
  }
  useEffect(
    () => () => {
      navigationRequest.current += 1
      pageRequest.current?.abort()
      speculativePage.current?.controller.abort()
    },
    []
  )
  const transactionOpenerRef = useRef<HTMLElement | null>(null)
  const transactionListRef = useRef<HTMLDivElement | null>(null)

  const selectTransaction = (transaction: TransactionListItem, trigger: HTMLElement) => {
    cancelNavigation()
    transactionOpenerRef.current = trigger
    setSelectedTransaction({
      transactionId: transaction.transactionId,
      taxYear: Number(
        new Intl.DateTimeFormat("en", { timeZone: "Europe/Berlin", year: "numeric" }).format(
          new Date(transaction.timestamp)
        )
      ),
      description: transaction.description ?? m["app.treatment.transaction"](),
    })
  }
  const [isVisible, setIsVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden"
  )
  const [syncCompletedAt, setSyncCompletedAt] = useState<number | null>(null)
  const [fastRefresh, setFastRefresh] = useState(false)
  const [pendingCompletions, setPendingCompletions] = useState<ReadonlyArray<PendingCompletion>>([])
  const observedRunIds = useRef(new Set<string | null>())
  const dependentReadsAllowed = useRef(false)
  const assetsTabRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    dependentReadsAllowed.current = true
    return () => {
      dependentReadsAllowed.current = false
    }
  }, [])

  const handleUnauthorized = useCallback(async () => {
    dependentReadsAllowed.current = false
    cancelNavigation()
    setAuthenticationLost(true)
    await queryClient.cancelQueries({ queryKey: queryKeys.all })
    await onUnauthorized?.()
  }, [cancelNavigation, onUnauthorized, queryClient])

  useEffect(() => {
    const onVisibilityChange = () => setIsVisible(document.visibilityState !== "hidden")
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => document.removeEventListener("visibilitychange", onVisibilityChange)
  }, [])

  useEffect(() => {
    if (syncCompletedAt === null || authenticationLost) return
    const timeout = window.setTimeout(
      () => setFastRefresh(false),
      Math.max(0, syncCompletedAt + 60_000 - Date.now())
    )
    return () => window.clearTimeout(timeout)
  }, [authenticationLost, syncCompletedAt])

  const [localFilters, setLocalFilters] = useState(EMPTY_TRANSACTION_FILTERS)
  const filters = controlledFilters ?? localFilters
  const filterScope = JSON.stringify(filters)
  const transactionScope = useMemo(() => transactionFilterInput(filters), [filters])
  const sourceIds = filters.sourceIds ?? []
  const selectedSourceId = sourceIds.length === 1 ? sourceIds[0] : undefined
  const accountScope = selectedSourceId ?? ALL_ACCOUNTS
  const portfolioScope = sourceIds.length > 1 ? sourceIds : selectedSourceId
  const [observedFilterScope, setObservedFilterScope] = useState(filterScope)
  const [taxYear] = useState<TaxYear>(2025)
  const [transactionCursors, setTransactionCursors] = useState<ReadonlyArray<string | null>>([null])
  const [transactionPageSize, setTransactionPageSize] =
    useState<TransactionPageSize>(TRANSACTION_PAGE_SIZE)
  const [pageSizeLoaded, setPageSizeLoaded] = useState(false)

  useEffect(() => {
    try {
      setTransactionPageSize(
        parseTransactionPageSize(window.localStorage.getItem(TRANSACTION_PAGE_SIZE_STORAGE_KEY))
      )
    } catch {
      // Browsing works when privacy settings make storage unavailable.
      setTransactionPageSize(TRANSACTION_PAGE_SIZE)
    }
    setPageSizeLoaded(true)
  }, [])

  const changeTransactionPageSize = (size: TransactionPageSize) => {
    if (size === transactionPageSize) return
    cancelNavigation()
    setSequenceRefreshVersion(null)
    setTransactionPageSize(size)
    setTransactionCursors([null])
    setSelectedTransaction(null)
    transactionOpenerRef.current = null
    try {
      window.localStorage.setItem(TRANSACTION_PAGE_SIZE_STORAGE_KEY, String(size))
    } catch {
      // The current session keeps the chosen size even if saving is blocked.
    }
  }

  // Reset before committing a new URL scope, including browser Back. An old
  // cursor/selection must never render or navigate against the new query.
  if (observedFilterScope !== filterScope) {
    setObservedFilterScope(filterScope)
    cancelNavigation()
    setTransactionCursors([null])
    setSequenceRefreshVersion(null)
    setSelectedTransaction(null)
    transactionOpenerRef.current = null
  }

  const resetTransactionSequence = useCallback(() => {
    cancelNavigation()
    setTransactionCursors([null])
    setSequenceRefreshVersion(
      queryClient.getQueryState(
        queryKeys.transactionList({ ...transactionScope, cursor: null, limit: transactionPageSize })
      )?.dataUpdateCount ?? 0
    )
  }, [cancelNavigation, queryClient, transactionPageSize, transactionScope])

  const accountsById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts]
  )

  const activeAccounts = useMemo(
    () =>
      filters.sourceIds?.length
        ? accounts.filter((account) => filters.sourceIds?.includes(account.id))
        : accounts,
    [filters.sourceIds, accounts]
  )

  const activeAccountIds = useMemo(
    () => new Set(activeAccounts.map((account) => account.id)),
    [activeAccounts]
  )

  const portfolioQuery = useQuery({
    ...queries.portfolioAssets(taxmaxi, portfolioScope),
    enabled: !authenticationLost,
    refetchInterval: (query) => {
      if (!isVisible || authenticationLost || isTaxMaxiUnauthorizedError(query.state.error))
        return false
      // After bounded retries, use the ordinary cadence even during a local fast window.
      if (query.state.status === "error") return 30_000
      return fastRefresh || query.state.data?.latestRun?.status === "running" ? 2_000 : 30_000
    },
  })
  const activeHoldings = portfolioQuery.data?.assets ?? []
  const isSwitchingPortfolio = portfolioQuery.isPending
  const transactionCursor =
    observedFilterScope === filterScope ? (transactionCursors.at(-1) ?? null) : null
  const filterChoicesQuery = useQuery({
    ...queries.transactionFilterChoices(taxmaxi),
    enabled: !authenticationLost,
  })
  const transactionQuery = useQuery({
    ...queries.transactionList(taxmaxi, {
      ...transactionScope,
      cursor: transactionCursor,
      limit: transactionPageSize,
    }),
    enabled: !authenticationLost && pageSizeLoaded,
  })

  useEffect(() => {
    const cursor = transactionQuery.data?.page.nextCursor
    if (
      authenticationLost ||
      !pageSizeLoaded ||
      transactionQuery.isFetching ||
      cursor === null ||
      cursor === undefined
    )
      return
    const userId = queryClient.getQueryData(queries.account(taxmaxi).queryKey)?.account.id
    if (userId === undefined) return
    const input = { ...transactionScope, cursor, limit: transactionPageSize }
    const controller = new AbortController()
    const runId = portfolioQuery.data?.activeRun?.runId
    const promise = prefetchTransactionPage({
      queryClient,
      taxmaxi,
      input,
      userId,
      signal: controller.signal,
      isCurrent: () =>
        queryClient.getQueryData(queries.portfolioAssets(taxmaxi, portfolioScope).queryKey)
          ?.activeRun?.runId === runId,
    })
    const read = {
      key: JSON.stringify(queryKeys.transactionList(input)),
      userId,
      controller,
      promise,
    }
    speculativePage.current = read
    // Prefetch errors are shown only if navigation actually consumes this request.
    void promise.catch(() => {
      if (speculativePage.current === read) speculativePage.current = null
    })
    return () => {
      controller.abort()
      if (speculativePage.current === read) speculativePage.current = null
    }
  }, [
    authenticationLost,
    pageSizeLoaded,
    queryClient,
    taxmaxi,
    transactionPageSize,
    transactionScope,
    transactionQuery.data?.page.nextCursor,
    transactionQuery.dataUpdatedAt,
    transactionQuery.isFetching,
    portfolioQuery.data?.activeRun?.runId,
    portfolioScope,
  ])

  // Refetching the current page supersedes a speculative neighbour request.
  // The SDK may still finish after cancellation, so selection has its own token.
  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        if (
          event.type !== "updated" ||
          (event.action.type !== "invalidate" && event.action.type !== "fetch")
        )
          return
        const key = queryKeys.transactionList({
          ...transactionScope,
          cursor: transactionCursor,
          limit: transactionPageSize,
        })
        if (JSON.stringify(event.query.queryKey) === JSON.stringify(key)) {
          cancelNavigation()
          const read = speculativePage.current
          read?.controller.abort()
          speculativePage.current = null
          if (read && read.key !== JSON.stringify(key)) {
            queryClient.removeQueries({
              predicate: (query) => JSON.stringify(query.queryKey) === read.key,
            })
          }
        }
      }),
    [cancelNavigation, queryClient, transactionCursor, transactionPageSize, transactionScope]
  )
  const pageShape = transactionQuery.data
    ? JSON.stringify([
        transactionQuery.data.totalCount,
        transactionQuery.data.transactions.map((row) => row.transactionId),
      ])
    : null
  const [observedPage, setObservedPage] = useState({ cursor: transactionCursor, shape: pageShape })
  if (observedPage.cursor !== transactionCursor || observedPage.shape !== pageShape) {
    setObservedPage({ cursor: transactionCursor, shape: pageShape })
    if (
      transactionCursor !== null &&
      observedPage.cursor === transactionCursor &&
      observedPage.shape !== null &&
      pageShape !== null
    ) {
      setTransactionCursors([null])
      setSequenceRefreshVersion(
        queryClient.getQueryState(
          queryKeys.transactionList({
            ...transactionScope,
            cursor: null,
            limit: transactionPageSize,
          })
        )?.dataUpdateCount ?? 0
      )
    }
  }
  useEffect(() => {
    if (sequenceRefreshVersion !== null && transactionCursor === null)
      void queryClient.invalidateQueries({
        queryKey: queryKeys.transactionList({
          ...transactionScope,
          cursor: null,
          limit: transactionPageSize,
        }),
        exact: true,
      })
  }, [
    queryClient,
    sequenceRefreshVersion,
    transactionCursor,
    transactionPageSize,
    transactionScope,
  ])

  const survivingRow = transactionQuery.data?.transactions.find(
    (row) => row.transactionId === selectedTransaction?.transactionId
  )
  if (selectedTransaction && survivingRow) {
    const taxYear = Number(
      new Intl.DateTimeFormat("en", { timeZone: "Europe/Berlin", year: "numeric" }).format(
        new Date(survivingRow.timestamp)
      )
    )
    const description = survivingRow.description ?? m["app.treatment.transaction"]()
    if (
      taxYear !== selectedTransaction.taxYear ||
      description !== selectedTransaction.description
    ) {
      setSelectedTransaction({ ...selectedTransaction, taxYear, description })
    }
  }

  const activeRunId = portfolioQuery.data?.activeRun?.runId
  const hasPortfolio = portfolioQuery.data !== undefined
  useEffect(() => {
    if (!hasPortfolio || authenticationLost) return
    const runId = activeRunId ?? null
    if (observedRunIds.current.has(runId)) return
    const isFirstResponse = observedRunIds.current.size === 0
    observedRunIds.current.add(runId)
    if (isFirstResponse) return
    // A new run may follow a remote sync. Equal visible rows/count cannot
    // establish that the prefix before this cursor stayed unchanged.
    cancelNavigation()
    if (transactionCursor !== null) resetTransactionSequence()
    const refreshDependentReads = async () => {
      // Invalidation alone reuses initial pending reads. Cancel their delivery
      // first so a response started before this run cannot replace its results.
      await Promise.all([
        queryClient.cancelQueries({ queryKey: queryKeys.sources() }),
        queryClient.cancelQueries({ queryKey: queryKeys.transactions() }),
      ])
      if (!dependentReadsAllowed.current) return
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.sources() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.transactions() }),
      ])
    }
    void refreshDependentReads()
  }, [
    activeRunId,
    authenticationLost,
    cancelNavigation,
    hasPortfolio,
    queryClient,
    resetTransactionSequence,
    transactionCursor,
  ])

  // Billing is only needed while the first-sync wizard can show. It is read
  // through the query cache so a billing overlay refresh moves the wizard
  // without a reload (#108 D07); the `/app` loader seeds it when it can.
  const anySourceSynced = sourceOverviews.some(
    (overview) => overview.latestSync.lastSyncedAt !== null
  )
  const billingQuery = useQuery({
    ...queries.billingStatus(taxmaxi),
    enabled: !authenticationLost && !anySourceSynced,
  })

  // The welcome is gated by one server fact, `welcomeSeenAt` (#108 D01). The
  // `/app` loader seeds the account into the cache; Continue and Skip on the
  // welcome mark it seen and write the returned account back. The step leaves
  // as soon as the user clicks, even when the mark fails: the server fact is
  // the gate, and the next visit shows the welcome again for a retry.
  const accountQuery = useQuery({
    ...queries.account(taxmaxi),
    enabled: !authenticationLost,
  })
  const [welcomeDismissed, setWelcomeDismissed] = useState(false)
  const welcomePending = accountQuery.data?.account.welcomeSeenAt === null && !welcomeDismissed
  const focusTabsAfterWelcome = useRef(false)
  const finishWelcome = useCallback(() => {
    focusTabsAfterWelcome.current = true
    setWelcomeDismissed(true)

    const writeMarkedAccount = async () => {
      const marked = await taxmaxi.auth.markWelcomeSeen()
      // An account read that started before the mark would answer with the
      // older `welcomeSeenAt: null`; cancel it so it cannot replace the mark.
      await queryClient.cancelQueries({ queryKey: queryKeys.account() })
      // Unmount drops the write; `setSessionQueryData` drops it when logout
      // removed the account entry or another user logged in in the same tab.
      if (!dependentReadsAllowed.current) return

      setSessionQueryData({
        data: marked,
        queryClient,
        queryKey: queryKeys.account(),
        userId: marked.account.id,
      })
    }

    writeMarkedAccount().catch((error: unknown) => {
      if (isTaxMaxiUnauthorizedError(error)) {
        void handleUnauthorized()
      }
    })
  }, [handleUnauthorized, queryClient, taxmaxi])

  useEffect(() => {
    if (
      isTaxMaxiUnauthorizedError(filterChoicesQuery.error) ||
      isTaxMaxiUnauthorizedError(portfolioQuery.error) ||
      isTaxMaxiUnauthorizedError(transactionQuery.error) ||
      isTaxMaxiUnauthorizedError(billingQuery.error) ||
      isTaxMaxiUnauthorizedError(accountQuery.error)
    ) {
      void handleUnauthorized()
    }
  }, [
    accountQuery.error,
    filterChoicesQuery.error,
    billingQuery.error,
    handleUnauthorized,
    portfolioQuery.error,
    transactionQuery.error,
  ])

  const selectedRowIndex =
    transactionQuery.data?.transactions.findIndex(
      (row) => row.transactionId === selectedTransaction?.transactionId
    ) ?? -1
  const sequenceReady =
    sequenceRefreshVersion === null ||
    (queryClient.getQueryState(
      queryKeys.transactionList({ ...transactionScope, cursor: null, limit: transactionPageSize })
    )?.dataUpdateCount ?? 0) > sequenceRefreshVersion
  if (sequenceRefreshVersion !== null && sequenceReady) setSequenceRefreshVersion(null)
  const position =
    transactionQuery.isError ||
    transactionQuery.isFetching ||
    !sequenceReady ||
    selectedRowIndex < 0
      ? null
      : (transactionCursors.length - 1) * transactionPageSize + selectedRowIndex + 1
  const totalTransactions = transactionQuery.data?.totalCount ?? 0
  const navigateTransaction = async (direction: -1 | 1) => {
    if (navigating.current || authenticationLost || selectedRowIndex < 0 || position === null)
      return
    if (direction === -1 ? position <= 1 : position >= totalTransactions) return
    const rows = transactionQuery.data?.transactions ?? []
    const adjacent = rows[selectedRowIndex + direction]
    if (adjacent) {
      selectTransaction(
        adjacent,
        transactionOpenerRef.current ?? transactionListRef.current ?? document.body
      )
      return
    }
    const cursors =
      direction === -1
        ? transactionCursors.slice(0, -1)
        : [...transactionCursors, transactionQuery.data?.page.nextCursor ?? null]
    if (!cursors.length || (direction === 1 && cursors.at(-1) === null)) return
    const request = ++navigationRequest.current
    const userId = queryClient.getQueryData(queries.account(taxmaxi).queryKey)?.account.id
    navigating.current = true
    setNavigationPending(true)
    setNavigationFailure(null)
    const input = {
      ...transactionScope,
      cursor: cursors.at(-1) ?? null,
      limit: transactionPageSize,
    }
    try {
      // A neighbour is speculative until it succeeds. Do not move the visible
      // query or write a late response into another session's cache.
      const page = await taxmaxi.transactions.list(input)
      if (
        request !== navigationRequest.current ||
        !dependentReadsAllowed.current ||
        userId !== queryClient.getQueryData(queries.account(taxmaxi).queryKey)?.account.id
      )
        return
      // Query cache delivery precedes React's run-change effect. Compare the
      // producer here too so a response cannot slip through that interval.
      const currentRunId = queryClient.getQueryData(
        queries.portfolioAssets(taxmaxi, portfolioScope).queryKey
      )?.activeRun?.runId
      if (currentRunId !== activeRunId || page.totalCount !== totalTransactions) {
        resetTransactionSequence()
        return
      }
      const row = direction === 1 ? page.transactions[0] : page.transactions.at(-1)
      if (!row) {
        setNavigationFailure(direction)
        return
      }
      if (userId === undefined) return
      setSessionQueryData({
        queryClient,
        queryKey: queryKeys.transactionList(input),
        userId,
        data: page,
      })
      setTransactionCursors(cursors)
      selectTransaction(
        row,
        transactionOpenerRef.current ?? transactionListRef.current ?? document.body
      )
    } catch (error) {
      if (
        request !== navigationRequest.current ||
        !dependentReadsAllowed.current ||
        userId !== queryClient.getQueryData(queries.account(taxmaxi).queryKey)?.account.id
      )
        return
      if (isTaxMaxiUnauthorizedError(error)) void handleUnauthorized()
      else setNavigationFailure(direction)
    } finally {
      if (request === navigationRequest.current) {
        navigating.current = false
        setNavigationPending(false)
      }
    }
  }

  const goToTransactionPage = async (direction: -1 | 1) => {
    if (navigating.current || authenticationLost || transactionQuery.isFetching) return
    const nextCursor = transactionQuery.data?.page.nextCursor
    const cursors =
      direction === -1
        ? transactionCursors.slice(0, -1)
        : [...transactionCursors, nextCursor ?? null]
    if (!cursors.length || (direction === 1 && (nextCursor === null || nextCursor === undefined)))
      return
    cancelNavigation()
    const request = navigationRequest.current
    const userId = queryClient.getQueryData(queries.account(taxmaxi).queryKey)?.account.id
    navigating.current = true
    setPagePending(true)
    const input = {
      ...transactionScope,
      cursor: cursors.at(-1) ?? null,
      limit: transactionPageSize,
    }
    try {
      if (userId === undefined) return
      const key = JSON.stringify(queryKeys.transactionList(input))
      const ownedRead = speculativePage.current
      const read =
        ownedRead?.controller.signal.aborted || ownedRead?.userId !== userId ? null : ownedRead
      const controller = read?.key === key ? read.controller : new AbortController()
      pageRequest.current = controller
      const page = await (read?.key === key
        ? read.promise
        : prefetchTransactionPage({
            queryClient,
            taxmaxi,
            input,
            userId,
            signal: controller.signal,
            isCurrent: () =>
              request === navigationRequest.current &&
              dependentReadsAllowed.current &&
              queryClient.getQueryData(queries.portfolioAssets(taxmaxi, portfolioScope).queryKey)
                ?.activeRun?.runId === activeRunId,
          }))
      if (!page) return
      if (
        request !== navigationRequest.current ||
        !dependentReadsAllowed.current ||
        userId !== queryClient.getQueryData(queries.account(taxmaxi).queryKey)?.account.id
      )
        return
      const currentRunId = queryClient.getQueryData(
        queries.portfolioAssets(taxmaxi, portfolioScope).queryKey
      )?.activeRun?.runId
      if (currentRunId !== activeRunId || page.totalCount !== totalTransactions) {
        resetTransactionSequence()
        return
      }
      setSelectedTransaction(null)
      setTransactionCursors(cursors)
    } catch (error: unknown) {
      if (
        request !== navigationRequest.current ||
        !dependentReadsAllowed.current ||
        userId !== queryClient.getQueryData(queries.account(taxmaxi).queryKey)?.account.id
      )
        return
      if (isTaxMaxiUnauthorizedError(error)) void handleUnauthorized()
      else setPageFailure(direction)
    } finally {
      if (request === navigationRequest.current) {
        navigating.current = false
        setPagePending(false)
        pageRequest.current = null
      }
    }
  }
  const goToNextTransactionPage = () => void goToTransactionPage(1)
  const goToPreviousTransactionPage = () => void goToTransactionPage(-1)

  const handleSourceSyncCompleted = useCallback(
    async (sourceId: AccountId) => {
      cancelNavigation()
      if (selectedTransaction !== null || transactionCursor !== null)
        setSequenceRefreshVersion(
          queryClient.getQueryState(
            queryKeys.transactionList({
              ...transactionScope,
              cursor: null,
              limit: transactionPageSize,
            })
          )?.dataUpdateCount ?? 0
        )
      setTransactionCursors([null])
      setSyncCompletedAt(Date.now())
      setFastRefresh(true)
      // The hook drops the completed item after a short delay. The wizard
      // keeps saying "underway" until the overview refetch below has resolved
      // successfully, so it never falls through to a second Start (#108 D03).
      setPendingCompletions((current) => [
        ...current.filter((pending) => pending.sourceId !== sourceId),
        { sourceId, dataUpdateCount: getOverviewDataUpdateCount(queryClient, sourceId) },
      ])
      void queryClient.invalidateQueries({ queryKey: ["taxmaxi", "portfolio"] })
      // The sync spent credits; the cached balance is behind (#108 D03, T05 review).
      void queryClient.invalidateQueries({ queryKey: queryKeys.billingStatus() })
      await onSourceSyncCompleted?.(sourceId)
    },
    [
      cancelNavigation,
      onSourceSyncCompleted,
      queryClient,
      transactionPageSize,
      selectedTransaction,
      transactionCursor,
      transactionScope,
    ]
  )

  // A pending completion clears once its overview query has fetched
  // successfully after the completion. A failed refetch keeps it pending; the
  // calculation refresh above invalidates the overview again on a changed run.
  useEffect(() => {
    if (pendingCompletions.length === 0) return
    const clearConfirmed = () => {
      const confirmed = pendingCompletions.filter((pending) =>
        isCompletionConfirmed(queryClient, pending)
      )
      if (confirmed.length === 0) return
      setPendingCompletions((current) => current.filter((pending) => !confirmed.includes(pending)))
    }
    clearConfirmed()
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "success") clearConfirmed()
    })
  }, [pendingCompletions, queryClient])

  const pendingCompletionSourceIds = useMemo(
    () => new Set(pendingCompletions.map((pending) => pending.sourceId)),
    [pendingCompletions]
  )

  const summary = useMemo<DashboardSummary>(() => {
    const taxSummaries = taxYearAccountSummaries.filter(
      (yearSummary) =>
        yearSummary.taxYear === taxYear && activeAccountIds.has(yearSummary.accountId)
    )

    const portfolioSummary =
      portfolioQuery.data?.activeRun == null ? undefined : portfolioQuery.data.summary

    return {
      currentBalance: portfolioSummary?.totalValue == null ? null : portfolioSummary.totalValue,
      unrealizedProfitLoss:
        portfolioSummary?.profitLoss == null ? null : portfolioSummary.profitLoss,
      unrealizedProfitLossPercentage:
        portfolioSummary?.profitLossPercentage == null
          ? null
          : portfolioSummary.profitLossPercentage,
      realizedProfitLoss: taxSummaries.reduce(
        (total, yearSummary) => total + yearSummary.realizedProfitLoss,
        0
      ),
      taxesPayable: taxSummaries.reduce(
        (total, yearSummary) => total + yearSummary.taxesPayable,
        0
      ),
      taxesReceivable: taxSummaries.reduce(
        (total, yearSummary) => total + yearSummary.taxesReceivable,
        0
      ),
      taxableEvents: taxSummaries.reduce(
        (total, yearSummary) => total + yearSummary.taxableEvents,
        0
      ),
      missingClassifications: taxSummaries.reduce(
        (total, yearSummary) => total + yearSummary.missingClassifications,
        0
      ),
      importedTransactions: activeAccounts.reduce(
        (total, account) => total + account.importedTransactions,
        0
      ),
      unresolvedItems: activeAccounts.reduce(
        (total, account) => total + account.unresolvedItems,
        0
      ),
    }
  }, [activeAccountIds, activeAccounts, portfolioQuery.data, taxYear])

  const onAccountScopeChange = (scope: AccountScope) => {
    if (scope === accountScope && sourceIds.length <= 1) return
    cancelNavigation()
    setTransactionCursors([null])
    setSelectedTransaction(null)
    const next = { ...filters, sourceIds: scope === ALL_ACCOUNTS ? [] : [scope] }
    if (onFiltersChange) onFiltersChange(next)
    else setLocalFilters(next)
  }

  const {
    activeSyncs,
    onDismissSync,
    onRetrySync,
    onSourceReplay,
    onSourceSync,
    syncingSourceIds,
  } = useSourceSyncs({
    accountsById,
    getSourceSyncJob,
    onCompleted: handleSourceSyncCompleted,
    onUnauthorized: handleUnauthorized,
    seeds: sourceSyncSeeds,
    startSourceReplay: replaySourceSync,
    startSourceSync,
  })

  // A `credit_required` job means the sync spent the balance the cache still
  // shows, whether the stop happened live or before this page loaded. Billing
  // is re-read once per such job before the wizard may offer Continue, and the
  // stop is caught during render so no frame derives `resumable` from the old
  // balance (#108 D03, T05 review). React re-runs the render right away when
  // state is set here, before anything is shown.
  const [seenItemStatuses, setSeenItemStatuses] = useState(NO_ITEM_STATUSES)
  const [readCreditStopJobIds, setReadCreditStopJobIds] = useState(NO_JOB_IDS)
  const [billingRefreshPending, setBillingRefreshPending] = useState(false)
  const itemStatuses = useMemo(() => toItemStatuses(activeSyncs), [activeSyncs])
  if (!sameItemStatuses(seenItemStatuses, itemStatuses)) {
    setSeenItemStatuses(itemStatuses)
    if (movedIntoCreditRequired(seenItemStatuses, itemStatuses)) {
      setBillingRefreshPending(true)
    }
  }
  const unreadCreditStops = anySourceSynced
    ? []
    : findUnreadCreditStops({
        items: activeSyncs,
        overviews: sourceOverviews,
        readJobIds: readCreditStopJobIds,
      })
  if (unreadCreditStops.length > 0) {
    setReadCreditStopJobIds(new Set([...readCreditStopJobIds, ...unreadCreditStops]))
    setBillingRefreshPending(true)
  }

  useEffect(() => {
    if (!billingRefreshPending) return
    let subscribed = true
    // Resolves once the refetch has settled, with a result or a failure; a
    // failure then shows as `billing_unknown` through the error state below.
    void queryClient.invalidateQueries({ queryKey: queryKeys.billingStatus() }).then(() => {
      if (subscribed) setBillingRefreshPending(false)
    })
    return () => {
      subscribed = false
    }
  }, [billingRefreshPending, queryClient])

  // The replay block only makes sense for a selected source that has synced
  // at least once; before that there is no cached raw data to replay.
  const replayAccount = useMemo(() => {
    if (replaySourceSync === undefined || selectedSourceId === undefined) {
      return undefined
    }

    const account = accountsById.get(selectedSourceId)
    return account?.lastSyncedAt === undefined ? undefined : account
  }, [accountsById, replaySourceSync, selectedSourceId])

  const handleAddWallet = useCallback(
    async (walletAddress: string) => {
      if (!createWalletSource) {
        return
      }

      const account = await createWalletSource(walletAddress)
      void onSourceSync(account)
    },
    [createWalletSource, onSourceSync]
  )

  // A billing read that is still pending, or whose latest attempt failed for
  // a non-401 reason, counts as not loaded even when an older result is still
  // cached: the wizard then shows `billing_unknown` with a retry instead of
  // guessing at credits (#108 D03, D08). A 401 is handled above.
  const billingFailed = billingQuery.isError && !isTaxMaxiUnauthorizedError(billingQuery.error)
  const billing = billingFailed ? null : (billingQuery.data ?? null)
  const firstSync = useMemo(
    () =>
      getFirstSyncState({
        billing,
        billingRefreshPending,
        items: activeSyncs,
        overviews: sourceOverviews,
        pendingCompletionSourceIds,
      }),
    [activeSyncs, billing, billingRefreshPending, pendingCompletionSourceIds, sourceOverviews]
  )
  const firstSyncTarget =
    firstSync.targetSourceId === null ? undefined : accountsById.get(firstSync.targetSourceId)
  // While the island shows an item for the target, it owns the billing action
  // in `paused`; after a dismissal the wizard offers it (#108 D06, D03 T05 review).
  const islandShowsTarget =
    firstSync.targetSourceId !== null && itemStatuses.has(firstSync.targetSourceId)

  // Start, Continue, and Try again all go through the hook's start function
  // for the target source (#108 D06); the hook ignores a second click while
  // that source is already syncing.
  const startFirstSync = useCallback(() => {
    if (firstSyncTarget !== undefined) {
      void onSourceSync(firstSyncTarget)
    }
  }, [firstSyncTarget, onSourceSync])

  // While the wizard shows, its Try again is the single retry control for the
  // target source; the island keeps Retry for every other source and for the
  // target once the wizard is gone (#108 D06, T05 review).
  const canRetryFromIsland = useCallback(
    (item: SourceSyncIslandItem) =>
      firstSync.state === "done" || item.id !== firstSync.targetSourceId,
    [firstSync.state, firstSync.targetSourceId]
  )

  // Connecting a wallet from the wizard only creates the source. The first
  // sync stays an explicit click on the next step (#108 D03).
  const connectWalletSource = useCallback(
    async (walletAddress: string) => {
      await createWalletSource?.(walletAddress)
    },
    [createWalletSource]
  )

  // The island stays mounted above whichever body shows, so a first sync's
  // progress is visible over the wizard and over the tabs alike (#108 D06).
  // An unseen welcome shows even in `done`, so a user whose sources synced
  // before the welcome existed sees it once and then the tabs (#108 D01, D09).
  const wizardShown = firstSync.state !== "done" || welcomePending

  // The wizard moves focus to its next heading on every screen change, but
  // when finishing the welcome removes the wizard itself (the dashboard was
  // already synced) that heading is gone and focus would drop to the body.
  // The first tab takes it instead, once, right after the finish.
  useEffect(() => {
    if (welcomePending || !focusTabsAfterWelcome.current) {
      return
    }

    focusTabsAfterWelcome.current = false
    if (!wizardShown) {
      assetsTabRef.current?.focus({ preventScroll: true })
    }
  }, [welcomePending, wizardShown])

  const body = !wizardShown ? null : (
    <FirstSyncWizard
      billing={billing}
      billingRefreshing={billingQuery.isFetching}
      createWalletSource={createWalletSource === undefined ? undefined : connectWalletSource}
      islandItemShown={islandShowsTarget}
      onRetryBilling={() => void billingQuery.refetch()}
      onStart={startFirstSync}
      onWelcomeFinish={finishWelcome}
      resolveName={resolveName}
      sourceName={firstSyncTarget?.name ?? null}
      state={firstSync.state}
      welcomePending={welcomePending}
      welcomeVideoId={FIRST_SYNC_WELCOME_VIDEO_ID}
    />
  )

  return (
    <div className="text-marketing-foreground flex min-h-screen flex-col pt-28 pb-8 sm:pt-32">
      <SourceSyncIsland
        canRetry={canRetryFromIsland}
        items={activeSyncs}
        onDismiss={onDismissSync}
        onRetry={onRetrySync}
      />
      {body ?? (
        <>
          <SourceCards
            contentClassName={appSurfaceClassName}
            onAddWallet={createWalletSource === undefined ? undefined : handleAddWallet}
            onResolveName={resolveName}
            onSourceSelect={onAccountScopeChange}
            onSourceSync={onSourceSync}
            selectedSourceIds={sourceIds}
            syncingSourceIds={syncingSourceIds}
            sources={accounts}
          >
            <div
              aria-busy={isSwitchingPortfolio}
              className="flex min-w-0 flex-col gap-8 py-6 sm:py-8"
            >
              <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
                <div className="min-w-0 space-y-3">
                  <PortfolioOverview key={selectedSourceId ?? ALL_ACCOUNTS} summary={summary} />
                  <CalculationStatus
                    portfolio={portfolioQuery.data}
                    requestFailed={portfolioQuery.isError}
                    refreshing={portfolioQuery.isFetching}
                    disabled={authenticationLost}
                    onRefresh={() => void portfolioQuery.refetch()}
                    postSyncNotice={
                      syncCompletedAt === null ? null : fastRefresh ? "checking" : "unconfirmed"
                    }
                  />
                </div>
                <SelectedSourceMenu
                  account={replayAccount}
                  isSyncing={replayAccount !== undefined && syncingSourceIds.has(replayAccount.id)}
                  onReplay={onSourceReplay}
                />
              </div>

              <Tabs defaultValue="assets" className="gap-y-8">
                <TabsList>
                  <TabsTrigger ref={assetsTabRef} value="assets">
                    {m["app.dashboard.tabs.assets"]()}
                  </TabsTrigger>
                  <TabsTrigger value="transactions">
                    {m["app.dashboard.tabs.transactions"]()}
                  </TabsTrigger>
                  <TabsTrigger value="taxes">{m["app.dashboard.tabs.taxes"]()}</TabsTrigger>
                </TabsList>
                <TabsContent value="assets">
                  {portfolioQuery.data?.activeRun === null ? (
                    <p className="rounded-lg border border-border p-6 text-sm text-muted-foreground">
                      {m["app.calculation.positionsUnavailable"]()}
                    </p>
                  ) : (
                    <AssetsTable
                      currency={portfolioQuery.data?.currency ?? "EUR"}
                      error={portfolioQuery.isError && portfolioQuery.data === undefined}
                      holdings={activeHoldings}
                      loading={portfolioQuery.isPending && portfolioQuery.data === undefined}
                    />
                  )}
                </TabsContent>
                <TabsContent value="transactions">
                  <div className="flex items-start gap-5">
                    <div
                      className="min-w-0 flex-1"
                      ref={transactionListRef}
                      tabIndex={-1}
                      role="region"
                      aria-label={m["app.dashboard.tabs.transactions"]()}
                    >
                      <TransactionFilterControls
                        filters={filters}
                        onChange={(next) => {
                          cancelNavigation()
                          setTransactionCursors([null])
                          setSelectedTransaction(null)
                          if (onFiltersChange) onFiltersChange(next)
                          else setLocalFilters(next)
                        }}
                        sources={accounts}
                        assets={filterChoicesQuery.data?.assets}
                        loading={filterChoicesQuery.isPending}
                        failed={filterChoicesQuery.isError}
                        onRetry={() => void filterChoicesQuery.refetch()}
                        disabled={authenticationLost}
                      />
                      <TransactionsTable
                        disabled={authenticationLost}
                        onSelect={selectTransaction}
                        selectedTransactionId={selectedTransaction?.transactionId ?? null}
                        error={transactionQuery.isError || pageFailure !== null}
                        hasNextPage={transactionQuery.data?.page.hasMore ?? false}
                        loading={transactionQuery.isFetching || pagePending}
                        scopeKey={filterScope}
                        onNextPage={goToNextTransactionPage}
                        onPreviousPage={goToPreviousTransactionPage}
                        onRetry={() =>
                          pageFailure === null
                            ? void transactionQuery.refetch()
                            : void goToTransactionPage(pageFailure)
                        }
                        pageIndex={transactionCursors.length - 1}
                        pageSize={transactionPageSize}
                        onPageSizeChange={changeTransactionPageSize}
                        totalCount={transactionQuery.data?.totalCount ?? 0}
                        transactions={transactionQuery.data?.transactions ?? []}
                      />
                    </div>
                    <TransactionInspector
                      navigation={{
                        position,
                        total: totalTransactions,
                        canPrevious: position !== null && position > 1,
                        canNext: position !== null && position < totalTransactions,
                        pending: navigationPending || pagePending,
                        failed: navigationFailure !== null,
                        onNavigate: (direction) => void navigateTransaction(direction),
                        onRetry: () => {
                          if (navigationFailure !== null)
                            void navigateTransaction(navigationFailure)
                        },
                      }}
                      selection={selectedTransaction}
                      taxmaxi={taxmaxi}
                      disabled={authenticationLost}
                      onUnauthorized={handleUnauthorized}
                      onClose={closeInspector}
                      returnFocusRef={transactionOpenerRef}
                      fallbackFocusRef={transactionListRef}
                    />
                  </div>
                </TabsContent>
                <TabsContent value="taxes"></TabsContent>
              </Tabs>
            </div>
          </SourceCards>
        </>
      )}
    </div>
  )
}

/**
 * Round context-menu button in the top-right of the content sheet. Appears
 * when a synced source is selected and holds source-level actions. Replay
 * re-runs the source from the raw data already imported, without fetching
 * from the provider again; the menu item carries that explanation as a
 * subtitle so the action is understood before it is chosen.
 */
function SelectedSourceMenu({
  account,
  isSyncing,
  onReplay,
}: {
  account: Account | undefined
  isSyncing: boolean
  onReplay: (source: Account) => void | Promise<void>
}) {
  const reduceMotion = useReducedMotion()

  return (
    <AnimatePresence initial={false}>
      {account === undefined ? null : (
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          className="shrink-0"
          exit={{ opacity: 0, y: -8 }}
          initial={{ opacity: 0, y: -8 }}
          key={account.id}
          transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label={m["app.sourceMenu.label"]()}
                className="rounded-full"
                size="icon-sm"
                title={m["app.sourceMenu.label"]()}
                variant="outline"
              >
                <Ellipsis aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuItem
                className="items-start"
                disabled={isSyncing}
                onSelect={() => void onReplay(account)}
              >
                <RotateCcw className="mt-0.5" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>{m["app.sourceMenu.replay"]()}</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {m["app.sourceMenu.replayDescription"]()}
                  </span>
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function PortfolioOverview({ summary }: { summary: DashboardSummary }) {
  const balance = summary.currentBalance === null ? "—" : formatCurrency(summary.currentBalance)
  const profitLoss =
    summary.unrealizedProfitLoss === null ? "—" : formatSignedCurrency(summary.unrealizedProfitLoss)
  const profitLossPercentage =
    summary.unrealizedProfitLossPercentage === null
      ? "—"
      : formatPercent(summary.unrealizedProfitLossPercentage)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6">
        <p className="text-3xl sm:text-5xl font-semibold tabular-nums tracking-normal">
          <SlidingValue value={balance} />
        </p>

        <div className="flex flex-col">
          <ValueTone
            tone={
              summary.unrealizedProfitLoss === null
                ? "neutral"
                : summary.unrealizedProfitLoss.startsWith("-")
                  ? "negative"
                  : "positive"
            }
          >
            <SlidingValue value={profitLoss} />
          </ValueTone>

          <ValueTone
            tone={
              summary.unrealizedProfitLossPercentage === null
                ? "neutral"
                : summary.unrealizedProfitLossPercentage.startsWith("-")
                  ? "negative"
                  : "positive"
            }
          >
            <SlidingValue value={profitLossPercentage} />
          </ValueTone>
        </div>
      </div>
    </div>
  )
}

function SlidingValue({ value }: { value: string }) {
  const reduceMotion = useReducedMotion()

  if (reduceMotion) {
    return <>{value}</>
  }

  return (
    <span className="relative inline-grid overflow-hidden align-bottom">
      <span className="invisible col-start-1 row-start-1" aria-hidden="true">
        {value}
      </span>
      <span className="sr-only">{value}</span>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          aria-hidden="true"
          className="col-start-1 row-start-1"
          key={value}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: "-45%" }}
          initial={{ opacity: 0, y: "45%" }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}
