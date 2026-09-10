import {
  validateTransactionSearch,
  updateTransactionSearch,
  parseTransactionFilters,
  type TransactionFilters,
} from "#/lib/transaction-filters"
import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"
import { useSuspenseQueries, useSuspenseQuery } from "@tanstack/react-query"
import { useCallback, useMemo } from "react"
import {
  isTaxMaxiUnauthorizedError,
  type Account as TaxMaxiAccount,
  type BillingStatus,
  type Source as TaxMaxiSource,
  type SourceOverview,
  type SourceList,
} from "taxmaxi"

import { AppHeader } from "#/components/app-header"
import { AccountMenu } from "#/components/account-menu"
import { AppWorkspace } from "#/components/app-workspace"
import { Dashboard } from "#/components/dashboard"
import { useAppLogout } from "#/hooks/use-app-logout"
import type { Account, SourceSyncSeed } from "#/lib/dashboard-types"
import { m } from "#/paraglide/messages"
import { getLocale } from "#/paraglide/runtime"
import { clearAuthSessionCookie, getAuthStatus } from "#/server-functions/auth"
import { queries, queryKeys, refreshTransactionQueries } from "#/integrations/taxmaxi/queries"

/**
 * Waits for every read to settle, then rethrows the first 401 among them.
 * Nothing in the loader may race SDK reads with a fail-fast `Promise.all`:
 * a 500 that settles before a 401 would hide the 401, and the route would
 * render an error instead of redirecting to login. What any other failure
 * means is up to the caller.
 */
const settleReads = async <T extends readonly unknown[] | []>(reads: T) => {
  const results = await Promise.allSettled(reads)

  const unauthorized = results.find(
    (result) => result.status === "rejected" && isTaxMaxiUnauthorizedError(result.reason)
  )
  if (unauthorized?.status === "rejected") throw unauthorized.reason

  return results
}

/**
 * Loads everything the `/app` page needs before it renders: the sources with
 * their overviews, the account (for `welcomeSeenAt`), and the billing status
 * (#108 D08). All reads, including one overview per source, go through
 * `settleReads`, so a 401 from any of them is rethrown (the route redirects
 * to login) even when another read failed first for a different reason. A
 * non-401 billing failure does not block the page: `billing` is `null` and
 * the first-sync wizard shows `billing_unknown` with a retry. Any other
 * failure is rethrown, the first one in read order when several fail.
 * The route wires every read through the query client, so a session change
 * (`clearSessionQueries`) cancels them and a cancelled read writes nothing.
 */
export const loadAppPageData = async ({
  loadAccount,
  loadBilling,
  loadSourceOverview,
  loadSources,
}: {
  readonly loadAccount: () => Promise<TaxMaxiAccount>
  readonly loadBilling: () => Promise<BillingStatus>
  readonly loadSourceOverview: (sourceId: string) => Promise<SourceOverview>
  readonly loadSources: () => Promise<SourceList>
}): Promise<{
  readonly account: TaxMaxiAccount
  readonly billing: BillingStatus | null
  readonly overviews: ReadonlyArray<SourceOverview>
  readonly sourceList: SourceList
}> => {
  const loadOverviews = async (sourceList: SourceList) => {
    const overviews = await settleReads(
      sourceList.sources.map((source) => loadSourceOverview(source.id))
    )

    const failed = overviews.find((result) => result.status === "rejected")
    if (failed?.status === "rejected") throw failed.reason

    return overviews.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
  }

  const [sources, account, billing] = await settleReads([
    loadSources().then(async (sourceList) => ({
      overviews: await loadOverviews(sourceList),
      sourceList,
    })),
    loadAccount(),
    loadBilling(),
  ])

  if (sources.status === "rejected") throw sources.reason
  if (account.status === "rejected") throw account.reason

  return {
    account: account.value,
    billing: billing.status === "fulfilled" ? billing.value : null,
    overviews: sources.value.overviews,
    sourceList: sources.value.sourceList,
  }
}

export const Route = createFileRoute("/app")({
  validateSearch: validateTransactionSearch,
  beforeLoad: async () => {
    const { isAuthenticated } = await getAuthStatus()

    if (!isAuthenticated) {
      throw redirect({
        to: "/login",
      })
    }
  },
  loader: async ({ context }) => {
    const taxmaxi = context.taxmaxi()
    try {
      return await loadAppPageData({
        loadAccount: () => context.queryClient.ensureQueryData(queries.account(taxmaxi)),
        loadBilling: () =>
          context.queryClient.ensureQueryData({
            ...queries.billingStatus(taxmaxi),
            revalidateIfStale: true,
          }),
        loadSourceOverview: (sourceId) =>
          context.queryClient.ensureQueryData(queries.sourceOverview(taxmaxi, sourceId)),
        // Fetched through the query client, not with a direct SDK call, so
        // `clearSessionQueries` can cancel it when the session changes hands
        // and a late response cannot write the previous person's sources.
        // `staleTime: 0` keeps the loader fetching a fresh list on every load.
        loadSources: () =>
          context.queryClient.fetchQuery({ ...queries.sourceList(taxmaxi), staleTime: 0 }),
      })
    } catch (error) {
      if (!isTaxMaxiUnauthorizedError(error)) {
        throw error
      }

      await clearAuthSessionCookie()
      throw redirect({
        to: "/login",
      })
    }
  },
  component: RouteComponent,
})

function RouteComponent() {
  const { queryClient, taxmaxi } = Route.useRouteContext()

  const navigate = Route.useNavigate()
  const search = Route.useSearch()
  const filters = useMemo(() => parseTransactionFilters(search), [search])
  const onFiltersChange = useCallback(
    (next: TransactionFilters) => {
      void navigate({ search: (previous) => updateTransactionSearch(previous, next) })
    },
    [navigate]
  )
  const onLogout = useAppLogout()

  const {
    data: { sources },
  } = useSuspenseQuery(queries.sourceList(taxmaxi()))

  const sourceOverviews = useSuspenseQueries({
    queries: sources.map((source) => queries.sourceOverview(taxmaxi(), source.id)),
    combine: (results) => results.map((result) => result.data),
  })

  const sourceAccounts = useMemo(() => {
    const overviewsBySourceId = new Map(
      sourceOverviews.map((overview) => [overview.source.id, overview])
    )
    return sources.map((source) => toDashboardAccount(source, overviewsBySourceId.get(source.id)))
  }, [sourceOverviews, sources])

  const sourceSyncSeeds = useMemo(
    () => sourceOverviews.flatMap((overview) => toSourceSyncSeeds(overview)),
    [sourceOverviews]
  )

  const startSourceSync = useCallback(
    async (sourceId: string) => taxmaxi().sources.startSync({ sourceId }),
    [taxmaxi]
  )

  const replaySourceSync = useCallback(
    async (sourceId: string) => taxmaxi().sources.replaySync({ sourceId }),
    [taxmaxi]
  )

  const resolveName = useCallback(
    async (name: string) => taxmaxi().sources.resolveName({ name }),
    [taxmaxi]
  )

  const createWalletSource = useCallback(
    async (walletAddress: string): Promise<Account> => {
      const client = taxmaxi()
      const created = await client.sources.create({ type: "onchain", walletAddress })

      // Cache the overview before the source list refetches, so the suspense
      // queries for the new source resolve without unmounting the dashboard.
      const overview = await queryClient.ensureQueryData(
        queries.sourceOverview(client, created.source.id)
      )
      await queryClient.invalidateQueries({ exact: true, queryKey: queryKeys.sourceList() })

      return toDashboardAccount(created.source, overview)
    },
    [queryClient, taxmaxi]
  )

  const getSourceSyncJob = useCallback(
    async ({ jobId, sourceId }: { sourceId: string; jobId: string }) =>
      taxmaxi().sources.getSyncJob({ jobId, sourceId }),
    [taxmaxi]
  )

  const onUnauthorized = useCallback(async () => {
    queryClient.removeQueries({ queryKey: queryKeys.all })
    await clearAuthSessionCookie()
    await navigate({ to: "/login", replace: true })
  }, [navigate, queryClient])

  const onSourceSyncCompleted = useCallback(
    async (sourceId: string) => {
      await Promise.all([
        queryClient.invalidateQueries({
          exact: true,
          queryKey: queryKeys.sourceOverview(sourceId),
        }),
        refreshTransactionQueries(queryClient),
      ])
    },
    [queryClient]
  )

  return (
    <AppWorkspace>
      <AppHeader>
        <AccountMenu onLogout={onLogout} />
      </AppHeader>
      <Dashboard
        filters={filters}
        onFiltersChange={onFiltersChange}
        accounts={sourceAccounts}
        createWalletSource={createWalletSource}
        getSourceSyncJob={getSourceSyncJob}
        onSourceSyncCompleted={onSourceSyncCompleted}
        onUnauthorized={onUnauthorized}
        replaySourceSync={replaySourceSync}
        resolveName={resolveName}
        sourceOverviews={sourceOverviews}
        sourceSyncSeeds={sourceSyncSeeds}
        startSourceSync={startSourceSync}
      />
      <Outlet />
    </AppWorkspace>
  )
}

function toDashboardAccount(source: TaxMaxiSource, overview: SourceOverview | undefined): Account {
  const network = source.sourceRef._tag === "cex" ? undefined : formatProviderNetwork(source)
  const lastSyncedAt = overview?.latestSync.lastSyncedAt ?? null

  return {
    id: source.id,
    name: source.name,
    kind: source.sourceRef._tag === "cex" ? "exchange" : "wallet",
    ...(network === undefined ? {} : { network }),
    ...(source.providerKey === null ? {} : { providerKey: source.providerKey }),
    importedTransactions: overview?.totals.transactionCount ?? 0,
    unresolvedItems: overview?.review.needsReviewCount ?? 0,
    lastSync: formatLastSync(lastSyncedAt),
    ...(lastSyncedAt === null ? {} : { lastSyncedAt }),
  }
}

/**
 * A source whose latest job is still queued, running, or waiting for credits
 * gives the island one job to reconnect to after a page load. A completed or
 * failed job is history and yields nothing, so it never pops the island again.
 * The status is translated into the job endpoint's words the same way the
 * server does (`pending` is `queued`, `processing` is `running`).
 */
function toSourceSyncSeeds(overview: SourceOverview): ReadonlyArray<SourceSyncSeed> {
  const { jobId, mode } = overview.latestSync
  const status = toReconnectableJobStatus(overview.latestSync.status)

  if (jobId === null || mode === null || status === undefined) {
    return []
  }

  return [{ sourceId: overview.source.id, jobId, mode, status }]
}

function toReconnectableJobStatus(
  status: SourceOverview["latestSync"]["status"]
): SourceSyncSeed["status"] | undefined {
  switch (status) {
    case "pending":
      return "queued"
    case "processing":
      return "running"
    case "credit_required":
      return "credit_required"
    case "completed":
    case "failed":
    case null:
      return undefined
  }
}

function formatProviderNetwork(source: TaxMaxiSource): string | undefined {
  switch (source.providerKey) {
    case "helius-solana":
      return "Solana"
    case "bitcoin":
    case "bitcoin-rpc":
      return "Bitcoin"
    case "evm":
    case "etherscan":
      return "EVM"
    default:
      return source.providerKey ?? undefined
  }
}

function formatLastSync(lastSyncedAt: string | null): string {
  if (lastSyncedAt === null) {
    return m["app.dashboard.neverSynced"]()
  }

  return new Intl.DateTimeFormat(getLocale(), {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(lastSyncedAt))
}
