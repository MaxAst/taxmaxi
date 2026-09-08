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

import { appSurfaceClassName } from "#/components/app-workspace"
import { CalculationStatus } from "#/components/calculation-status"
import { AssetsTable } from "#/components/assets-table"
import { FirstSyncWizard } from "#/components/first-sync-wizard"
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
import { queries, queryKeys } from "#/integrations/taxmaxi/queries"
import { TRANSACTION_PAGE_SIZE, TransactionsTable } from "./transactions-table"
import { TransactionInspector } from "./transaction-inspector"
import { SourceSyncIsland } from "./source-sync-island"

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
 * `credit_required`: the sync ran out of credits, or a start was refused. A
 * new item that arrives as `credit_required` (the reload seed) is not a move;
 * the loader read billing right before it.
 */
function movedIntoCreditRequired(previous: ItemStatuses, next: ItemStatuses): boolean {
  return [...next].some(([sourceId, status]) => {
    const before = previous.get(sourceId)
    return status === "credit_required" && before !== undefined && before !== "credit_required"
  })
}

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
}: {
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
  const transactionOpenerRef = useRef<HTMLElement | null>(null)
  const transactionListRef = useRef<HTMLDivElement | null>(null)

  const selectTransaction = (transaction: TransactionListItem, trigger: HTMLElement) => {
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

  useEffect(() => {
    dependentReadsAllowed.current = true
    return () => {
      dependentReadsAllowed.current = false
    }
  }, [])

  const handleUnauthorized = useCallback(async () => {
    dependentReadsAllowed.current = false
    setAuthenticationLost(true)
    await queryClient.cancelQueries({ queryKey: queryKeys.all })
    await onUnauthorized?.()
  }, [onUnauthorized, queryClient])

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

  const [accountScope, setAccountScope] = useState<AccountScope>(ALL_ACCOUNTS)
  const [taxYear] = useState<TaxYear>(2025)
  const [transactionCursors, setTransactionCursors] = useState<ReadonlyArray<string | null>>([null])

  const accountsById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts]
  )

  const activeAccounts = useMemo(
    () =>
      accountScope === ALL_ACCOUNTS
        ? accounts
        : accounts.filter((account) => account.id === accountScope),
    [accountScope, accounts]
  )

  const activeAccountIds = useMemo(
    () => new Set(activeAccounts.map((account) => account.id)),
    [activeAccounts]
  )

  const selectedSourceId = accountScope === ALL_ACCOUNTS ? undefined : accountScope
  const portfolioQuery = useQuery({
    ...queries.portfolioAssets(taxmaxi, selectedSourceId),
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
  const transactionCursor = transactionCursors.at(-1) ?? null
  const transactionQuery = useQuery({
    ...queries.transactionList(taxmaxi, {
      cursor: transactionCursor,
      limit: TRANSACTION_PAGE_SIZE,
    }),
    enabled: !authenticationLost,
  })

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
  }, [activeRunId, authenticationLost, hasPortfolio, queryClient])

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

  useEffect(() => {
    if (
      isTaxMaxiUnauthorizedError(portfolioQuery.error) ||
      isTaxMaxiUnauthorizedError(transactionQuery.error) ||
      isTaxMaxiUnauthorizedError(billingQuery.error)
    ) {
      void handleUnauthorized()
    }
  }, [billingQuery.error, handleUnauthorized, portfolioQuery.error, transactionQuery.error])

  const goToNextTransactionPage = () => {
    const nextCursor = transactionQuery.data?.page.nextCursor
    if (nextCursor === null || nextCursor === undefined) return
    setTransactionCursors((current) => [...current, nextCursor])
  }

  const goToPreviousTransactionPage = () => {
    setTransactionCursors((current) => (current.length > 1 ? current.slice(0, -1) : current))
  }

  const handleSourceSyncCompleted = useCallback(
    async (sourceId: AccountId) => {
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
    [onSourceSyncCompleted, queryClient]
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
    setAccountScope(scope)
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

  // A move into `credit_required` means the sync spent the balance the cache
  // still shows. Billing is re-read before the wizard may offer Continue, and
  // the move is caught during render so no frame derives `resumable` from the
  // old balance (#108 D03, T05 review). React re-runs the render right away
  // when state is set here, before anything is shown.
  const [seenItemStatuses, setSeenItemStatuses] = useState(NO_ITEM_STATUSES)
  const [billingRefreshPending, setBillingRefreshPending] = useState(false)
  const itemStatuses = useMemo(() => toItemStatuses(activeSyncs), [activeSyncs])
  if (!sameItemStatuses(seenItemStatuses, itemStatuses)) {
    setSeenItemStatuses(itemStatuses)
    if (movedIntoCreditRequired(seenItemStatuses, itemStatuses)) {
      setBillingRefreshPending(true)
    }
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
  const body =
    firstSync.state === "done" ? null : (
      <FirstSyncWizard
        billing={billing}
        billingRefreshing={billingQuery.isFetching}
        createWalletSource={createWalletSource === undefined ? undefined : connectWalletSource}
        islandItemShown={islandShowsTarget}
        onRetryBilling={() => void billingQuery.refetch()}
        onStart={startFirstSync}
        resolveName={resolveName}
        sourceName={firstSyncTarget?.name ?? null}
        state={firstSync.state}
      />
    )

  return (
    <div className="text-marketing-foreground flex min-h-screen flex-col pt-28 pb-8 sm:pt-32">
      <SourceSyncIsland items={activeSyncs} onDismiss={onDismissSync} onRetry={onRetrySync} />
      {body ?? (
        <>
          <SourceCards
            contentClassName={appSurfaceClassName}
            onAddWallet={createWalletSource === undefined ? undefined : handleAddWallet}
            onResolveName={resolveName}
            onSelectedSourceIdChange={(sourceId) => onAccountScopeChange(sourceId ?? ALL_ACCOUNTS)}
            onSourceSync={onSourceSync}
            selectedSourceId={accountScope === ALL_ACCOUNTS ? undefined : accountScope}
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
                  <TabsTrigger value="assets">{m["app.dashboard.tabs.assets"]()}</TabsTrigger>
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
                  <div
                    ref={transactionListRef}
                    tabIndex={-1}
                    role="region"
                    aria-label={m["app.dashboard.tabs.transactions"]()}
                  >
                    <TransactionsTable
                      disabled={authenticationLost}
                      onSelect={selectTransaction}
                      selectedTransactionId={selectedTransaction?.transactionId ?? null}
                      error={transactionQuery.isError}
                      hasNextPage={transactionQuery.data?.page.hasMore ?? false}
                      loading={transactionQuery.isFetching}
                      onNextPage={goToNextTransactionPage}
                      onPreviousPage={goToPreviousTransactionPage}
                      onRetry={() => void transactionQuery.refetch()}
                      pageIndex={transactionCursors.length - 1}
                      totalCount={transactionQuery.data?.totalCount ?? 0}
                      transactions={transactionQuery.data?.transactions ?? []}
                    />
                  </div>
                </TabsContent>
                <TabsContent value="taxes"></TabsContent>
              </Tabs>
            </div>
          </SourceCards>
          <TransactionInspector
            selection={selectedTransaction}
            taxmaxi={taxmaxi}
            disabled={authenticationLost}
            onUnauthorized={handleUnauthorized}
            onClose={() => setSelectedTransaction(null)}
            returnFocusRef={transactionOpenerRef}
            fallbackFocusRef={transactionListRef}
          />
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
