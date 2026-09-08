import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useRouteContext } from "@tanstack/react-router"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { Ellipsis, RotateCcw } from "lucide-react"
import {
  isTaxMaxiUnauthorizedError,
  type SourceSyncJob,
  type SourceSyncJobInput,
  type SourceSyncStart,
} from "taxmaxi"

import { appSurfaceClassName } from "#/components/app-workspace"
import { CalculationStatus } from "#/components/calculation-status"
// PROTOTYPE (#108 T04): dev-only preview of the never-synced body. Remove with
// first-sync-body-PROTOTYPE.tsx.
import {
  FIRST_SYNC_PROTOTYPE_ENABLED,
  FIRST_SYNC_PROTOTYPE_FALLBACK_SOURCE,
  FirstSyncBodyPrototype,
  getFirstSyncPrototypeMock,
  type FirstSyncPrototypeSearch,
} from "#/components/first-sync-body-PROTOTYPE"
import { AssetsTable } from "#/components/assets-table"
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

export function Dashboard({
  accounts = mockAccounts,
  createWalletSource,
  firstSyncPrototype,
  getSourceSyncJob,
  onSourceSyncCompleted,
  onUnauthorized,
  replaySourceSync,
  resolveName,
  sourceSyncSeeds,
  startSourceSync,
}: {
  accounts?: ReadonlyArray<Account>
  createWalletSource?: (walletAddress: string) => Promise<Account>
  /** PROTOTYPE (#108 T04): `?variant=` and `?state=` from the `/app` search. Dev only. */
  firstSyncPrototype?: FirstSyncPrototypeSearch
  getSourceSyncJob?: (input: SourceSyncJobInput) => Promise<SourceSyncJob>
  onSourceSyncCompleted?: (sourceId: AccountId) => void | Promise<void>
  onUnauthorized?: () => void | Promise<void>
  replaySourceSync?: (sourceId: AccountId) => Promise<SourceSyncStart>
  resolveName?: (name: string) => Promise<{ name: string; resolvedAddress: string }>
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
  const [isVisible, setIsVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden"
  )
  const [syncCompletedAt, setSyncCompletedAt] = useState<number | null>(null)
  const [fastRefresh, setFastRefresh] = useState(false)
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

  useEffect(() => {
    if (
      isTaxMaxiUnauthorizedError(portfolioQuery.error) ||
      isTaxMaxiUnauthorizedError(transactionQuery.error)
    ) {
      void handleUnauthorized()
    }
  }, [handleUnauthorized, portfolioQuery.error, transactionQuery.error])

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
      void queryClient.invalidateQueries({ queryKey: ["taxmaxi", "portfolio"] })
      await onSourceSyncCompleted?.(sourceId)
    },
    [onSourceSyncCompleted, queryClient]
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

  // PROTOTYPE (#108 T04): with `?variant=` set in a dev build, the island shows
  // mock items and the content sheet shows the variant instead of the tabs.
  // Real data loading above is untouched. Remove with first-sync-body-PROTOTYPE.tsx.
  const prototypeVariant = FIRST_SYNC_PROTOTYPE_ENABLED ? firstSyncPrototype?.variant : undefined
  const prototypeState = firstSyncPrototype?.state ?? "ready"
  const prototypeTarget = accounts[0] ?? FIRST_SYNC_PROTOTYPE_FALLBACK_SOURCE
  const prototypeMock =
    prototypeVariant === undefined
      ? undefined
      : getFirstSyncPrototypeMock(prototypeState, prototypeTarget)

  // PROTOTYPE (#108 T04): the source cards plus a sheet body. Passed to the
  // prototype so variants can render inside the sheet, replace it, or dim it.
  const renderSourceSheet = (sheet: ReactNode) => (
    <SourceCards
      contentClassName={appSurfaceClassName}
      onAddWallet={createWalletSource === undefined ? undefined : handleAddWallet}
      onResolveName={resolveName}
      onSelectedSourceIdChange={(sourceId) => onAccountScopeChange(sourceId ?? ALL_ACCOUNTS)}
      onSourceSync={onSourceSync}
      selectedSourceId={accountScope === ALL_ACCOUNTS ? undefined : accountScope}
      syncingSourceIds={prototypeMock?.syncingSourceIds ?? syncingSourceIds}
      sources={accounts}
    >
      {sheet}
    </SourceCards>
  )

  return (
    <div className="text-marketing-foreground flex min-h-screen flex-col pt-28 pb-8 sm:pt-32">
      <SourceSyncIsland
        items={prototypeMock?.islandItems ?? activeSyncs}
        onDismiss={prototypeMock ? undefined : onDismissSync}
        onRetry={prototypeMock ? undefined : onRetrySync}
      />
      {prototypeVariant !== undefined ? (
        <FirstSyncBodyPrototype
          renderDashboard={renderSourceSheet}
          state={prototypeState}
          targetSource={prototypeTarget}
          variant={prototypeVariant}
        />
      ) : (
        renderSourceSheet(
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
                <TransactionsTable
                  taxmaxi={taxmaxi}
                  disabled={authenticationLost}
                  onUnauthorized={handleUnauthorized}
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
              </TabsContent>
              <TabsContent value="taxes"></TabsContent>
            </Tabs>
          </div>
        )
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
