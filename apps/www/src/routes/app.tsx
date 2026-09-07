import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"
import { useSuspenseQueries, useSuspenseQuery } from "@tanstack/react-query"
import { useCallback, useMemo } from "react"
import {
  isTaxMaxiUnauthorizedError,
  type Source as TaxMaxiSource,
  type SourceOverview,
} from "taxmaxi"

import { AppHeader } from "#/components/app-header"
import { AccountMenu } from "#/components/account-menu"
import { AppWorkspace } from "#/components/app-workspace"
import { Dashboard } from "#/components/dashboard"
import { useAppLogout } from "#/hooks/use-app-logout"
import type { Account } from "#/lib/dashboard-types"
import { m } from "#/paraglide/messages"
import { getLocale } from "#/paraglide/runtime"
import { clearAuthSessionCookie, getAuthStatus } from "#/server-functions/auth"
import { queries, queryKeys } from "#/integrations/taxmaxi/queries"

export const Route = createFileRoute("/app")({
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
      const sourceList = await taxmaxi.sources.list()
      context.queryClient.setQueryData(queryKeys.sourceList(), sourceList)
      await Promise.all(
        sourceList.sources.map((source) =>
          context.queryClient.ensureQueryData(queries.sourceOverview(taxmaxi, source.id))
        )
      )
      return sourceList
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
      await queryClient.invalidateQueries({
        exact: true,
        queryKey: queryKeys.sourceOverview(sourceId),
      })
      await queryClient.invalidateQueries({ queryKey: queryKeys.transactions() })
    },
    [queryClient]
  )

  return (
    <AppWorkspace>
      <AppHeader>
        <AccountMenu onLogout={onLogout} />
      </AppHeader>
      <Dashboard
        accounts={sourceAccounts}
        createWalletSource={createWalletSource}
        getSourceSyncJob={getSourceSyncJob}
        onSourceSyncCompleted={onSourceSyncCompleted}
        onUnauthorized={onUnauthorized}
        replaySourceSync={replaySourceSync}
        resolveName={resolveName}
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
