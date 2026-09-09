import { useQueryClient } from "@tanstack/react-query"
import { createFileRoute, redirect } from "@tanstack/react-router"
import { CreditCard, Plus } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import {
  isTaxMaxiUnauthorizedError,
  type BillingCatalog,
  type BillingPromiseResource,
  type BillingStatus,
} from "taxmaxi"
import { z } from "zod"

import { AppOverlay, useAppOverlayClose } from "#/components/app-overlay"
import { appPanelClassName } from "#/components/app-workspace"
import { Button } from "#/components/ui/button"
import { Text } from "#/components/ui/typography"
import { cn } from "#/lib/utils"
import { m } from "#/paraglide/messages"
import { getLocale, type Locale } from "#/paraglide/runtime"
import { queries, queryKeys, setSessionQueryData } from "#/integrations/taxmaxi/queries"
import { clearAuthSessionCookie } from "#/server-functions/auth"

const billingSearchSchema = z.object({
  checkout: z.literal("success").optional(),
  top_up: z.literal("success").optional(),
})

type CheckoutReturnKind = "annual" | "topUp"

const CHECKOUT_STATUS_POLL_ATTEMPTS = 15

const checkoutStatusPollDelayMs = (attempt: number): number => Math.min(500 * 2 ** attempt, 30_000)

// Twin of `settleReads` in `app.tsx`: every read settles, then a 401 from any of them wins.
const settleReads = async <T extends readonly unknown[] | []>(reads: T) => {
  const results = await Promise.allSettled(reads)

  const unauthorized = results.find(
    (result) => result.status === "rejected" && isTaxMaxiUnauthorizedError(result.reason)
  )
  if (unauthorized?.status === "rejected") throw unauthorized.reason

  return results
}

/**
 * Loads the catalog and the billing status for the overlay. A 401 from either
 * read is rethrown even when the other read failed first for another reason,
 * so the route redirects to login instead of rendering an error (#108, T06
 * note). A status failure is rethrown; a catalog failure only leaves the
 * catalog `null`, and the overlay shows its prices as unavailable.
 */
export const loadBillingPageData = async ({
  loadCatalog,
  loadStatus,
}: {
  readonly loadCatalog: () => Promise<BillingCatalog>
  readonly loadStatus: () => Promise<BillingStatus>
}): Promise<{ readonly catalog: BillingCatalog | null; readonly status: BillingStatus }> => {
  const [catalog, status] = await settleReads([loadCatalog(), loadStatus()])

  if (status.status === "rejected") throw status.reason

  return {
    catalog: catalog.status === "fulfilled" ? catalog.value : null,
    status: status.value,
  }
}

export const isTopUpActionDisabled = ({
  hasCatalogPrice,
  pendingAction,
}: {
  readonly hasCatalogPrice: boolean
  readonly pendingAction: boolean
}): boolean => !hasCatalogPrice || pendingAction

export const refreshBillingStatusAfterCheckout = async ({
  initialStatus,
  kind,
  loadStatus,
  shouldContinue = () => true,
  wait,
  attempts = CHECKOUT_STATUS_POLL_ATTEMPTS,
}: {
  readonly initialStatus: BillingStatus
  readonly kind: CheckoutReturnKind
  readonly loadStatus: () => Promise<BillingStatus>
  readonly shouldContinue?: () => boolean
  readonly wait: (delayMs: number) => Promise<void>
  readonly attempts?: number
}): Promise<BillingStatus> => {
  let latest = initialStatus
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!shouldContinue()) return latest
    await wait(checkoutStatusPollDelayMs(attempt))
    if (!shouldContinue()) return latest
    try {
      latest = await loadStatus()
    } catch (error) {
      if (isTaxMaxiUnauthorizedError(error)) throw error
      continue
    }
    if (
      (kind === "annual" &&
        (latest.subscriptionStatus === "active" || latest.subscriptionStatus === "trialing") &&
        latest.credits > initialStatus.credits) ||
      (kind === "topUp" && latest.credits > initialStatus.credits)
    ) {
      return latest
    }
  }
  return latest
}

export const Route = createFileRoute("/app/billing")({
  validateSearch: billingSearchSchema,
  // ensureQueryData keeps catalog and status cached, so hover preload and
  // reopens resolve instantly instead of refetching on every open. Status
  // revalidates in the background to stay fresh for the next open.
  loader: async ({ context }) => {
    try {
      const client = context.taxmaxi()
      return await loadBillingPageData({
        loadCatalog: () => context.queryClient.ensureQueryData(queries.billingCatalog(client)),
        loadStatus: () =>
          context.queryClient.ensureQueryData({
            ...queries.billingStatus(client),
            revalidateIfStale: true,
          }),
      })
    } catch (error) {
      if (!isTaxMaxiUnauthorizedError(error)) throw error
      await clearAuthSessionCookie()
      throw redirect({ to: "/login" })
    }
  },
  component: BillingPage,
})

function BillingPage() {
  const { catalog, status } = Route.useLoaderData()
  const search = Route.useSearch()
  const { taxmaxi } = Route.useRouteContext()
  const navigate = Route.useNavigate()
  const onClose = useAppOverlayClose()
  const [checkoutReturnKind] = useState<CheckoutReturnKind | null>(() =>
    search.checkout === "success" ? "annual" : search.top_up === "success" ? "topUp" : null
  )

  useEffect(() => {
    if (checkoutReturnKind === null) return
    void navigate({ to: "/app/billing", search: {}, replace: true })
  }, [checkoutReturnKind, navigate])

  return (
    <BillingPageContent
      assignLocation={(url) => window.location.assign(url)}
      billing={taxmaxi().billing}
      catalog={catalog}
      checkoutReturnKind={checkoutReturnKind}
      onClose={onClose}
      onUnauthorized={async () => {
        await clearAuthSessionCookie()
        await navigate({ to: "/login", replace: true })
      }}
      status={status}
    />
  )
}

export function BillingPageContent({
  assignLocation,
  billing,
  catalog,
  checkoutReturnKind,
  onClose,
  onUnauthorized,
  status,
}: {
  readonly assignLocation: (url: string) => void
  readonly billing: BillingPromiseResource
  readonly catalog: BillingCatalog | null
  readonly checkoutReturnKind: CheckoutReturnKind | null
  readonly onClose: () => void
  readonly onUnauthorized: () => Promise<void>
  readonly status: BillingStatus
}) {
  const locale = getLocale()
  const queryClient = useQueryClient()
  const [liveStatus, setLiveStatus] = useState(status)
  const [pendingAction, setPendingAction] = useState<"annual" | "portal" | "topUp" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const subscribed =
    liveStatus.subscriptionStatus !== null &&
    liveStatus.subscriptionStatus !== "canceled" &&
    liveStatus.subscriptionStatus !== "incomplete_expired"
  const topUpEligible =
    liveStatus.subscriptionStatus === "active" || liveStatus.subscriptionStatus === "trialing"

  // The overlay renders above the mounted dashboard, whose first-sync wizard
  // reads billing through the `billingStatus` query. Every refreshed status is
  // written into that cache, so the wizard moves from `needs_credits` to
  // `ready`, or from `paused` to `resumable`, while the overlay is still open
  // (#108 D07).
  const applyRefreshedStatus = useCallback(
    (refreshed: BillingStatus) => {
      setLiveStatus(refreshed)
      // The post-Checkout poll can run for tens of seconds and outlive a
      // logout; the write is dropped once the session's account entry is gone.
      setSessionQueryData({ data: refreshed, queryClient, queryKey: queryKeys.billingStatus() })
    },
    [queryClient]
  )

  // Closing invalidates the same query, so whatever changed behind Stripe's
  // portal, or a Checkout the poll gave up on, is re-read by the dashboard
  // underneath (#108 D07). Stable on purpose: the overlay's exit effect lists
  // `onClose` as a dependency, and a new function per render would restart
  // its exit timer.
  const closeOverlay = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.billingStatus() })
    onClose()
  }, [onClose, queryClient])

  useEffect(() => {
    if (checkoutReturnKind === null) return
    let active = true

    const handleRefreshError = async (cause: unknown) => {
      if (!active || !isTaxMaxiUnauthorizedError(cause)) return
      await onUnauthorized()
    }

    const refreshOnce = async () => {
      try {
        const refreshed = await billing.status()
        if (active) applyRefreshedStatus(refreshed)
      } catch (cause) {
        await handleRefreshError(cause)
      }
    }

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshOnce()
    }

    window.addEventListener("focus", refreshOnce)
    document.addEventListener("visibilitychange", refreshWhenVisible)

    void refreshBillingStatusAfterCheckout({
      initialStatus: status,
      kind: checkoutReturnKind,
      loadStatus: billing.status,
      shouldContinue: () => active,
      wait: (delayMs) => new Promise((resolve) => window.setTimeout(resolve, delayMs)),
    })
      .then((refreshed) => {
        // When every poll failed, `refreshed` is the loader-time `status`
        // itself, not a read; writing it would put a stale snapshot over a
        // fresher value the focus refresh or the dashboard may have cached.
        if (active && refreshed !== status) applyRefreshedStatus(refreshed)
      })
      .catch(handleRefreshError)
    return () => {
      active = false
      window.removeEventListener("focus", refreshOnce)
      document.removeEventListener("visibilitychange", refreshWhenVisible)
    }
  }, [applyRefreshedStatus, billing, checkoutReturnKind, onUnauthorized, status])

  const redirectToStripe = async (action: "annual" | "portal" | "topUp") => {
    setPendingAction(action)
    setError(null)
    try {
      const response =
        action === "annual"
          ? await billing.createAnnualCheckout()
          : action === "topUp"
            ? await billing.createTopUpCheckout()
            : await billing.createPortalSession()
      assignLocation(response.url)
    } catch (cause) {
      if (isTaxMaxiUnauthorizedError(cause)) {
        await onUnauthorized()
        return
      }
      setError(cause instanceof Error ? cause.message : m["app.billing.errors.unavailable"]())
      setPendingAction(null)
    }
  }

  return (
    <AppOverlay
      closeLabel={m["app.billing.close"]()}
      icon={<CreditCard aria-hidden="true" className="size-4" />}
      onClose={closeOverlay}
      subtitle={m["app.billing.title"]()}
      title={m["app.billing.eyebrow"]()}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-6 sm:px-5 sm:py-8">
        <Text className="max-w-[65ch]" size="bodySm" tone="muted">
          {m["app.billing.description"]()}
        </Text>

        {error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <AnnualBillingCard
            catalog={catalog}
            disabled={pendingAction !== null}
            onAction={() => void redirectToStripe(subscribed ? "portal" : "annual")}
            pending={pendingAction === (subscribed ? "portal" : "annual")}
            locale={locale}
            status={liveStatus}
            subscribed={subscribed}
          />
          <TopUpCard
            catalog={catalog}
            disabled={pendingAction !== null}
            onAction={() => void redirectToStripe("topUp")}
            pending={pendingAction === "topUp"}
            locale={locale}
            subscribed={topUpEligible}
          />
        </div>
      </div>
    </AppOverlay>
  )
}

function AnnualBillingCard({
  catalog,
  disabled,
  onAction,
  pending,
  locale,
  status,
  subscribed,
}: {
  readonly catalog: BillingCatalog | null
  readonly disabled: boolean
  readonly onAction: () => void
  readonly pending: boolean
  readonly locale: Locale
  readonly status: BillingStatus
  readonly subscribed: boolean
}) {
  const price = catalog?.prices.find((item) => item.lookupKey === "taxmaxi_annual_10k_eur")
  const displayedPrice = price === undefined ? null : formatCatalogPrice(price, locale)
  return (
    <section className={cn(appPanelClassName, "flex flex-col gap-4 p-5")}>
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">{m["app.billing.annual.title"]()}</h2>
        <p className="text-sm text-muted-foreground">{m["app.billing.annual.description"]()}</p>
      </div>
      <p className="text-2xl font-semibold tabular-nums tracking-tight">
        {displayedPrice ?? m["app.billing.priceUnavailable"]()}
        <span className="ml-2 text-sm font-normal text-muted-foreground">
          {m["app.billing.annual.priceSuffix"]({
            taxLabel: taxLabel(price?.taxBehavior),
          })}
        </span>
      </p>
      <p className="text-sm text-muted-foreground">
        {m["app.billing.availableCredits"]()}
        <span className="ml-2 font-medium tabular-nums text-foreground">
          {new Intl.NumberFormat(locale).format(status.credits)}
        </span>
      </p>
      <div>
        <Button disabled={disabled || (!subscribed && displayedPrice === null)} onClick={onAction}>
          <CreditCard data-icon="inline-start" />
          {pending
            ? m["app.billing.openingStripe"]()
            : subscribed
              ? m["app.billing.annual.manage"]()
              : displayedPrice === null
                ? m["app.billing.priceUnavailable"]()
                : m["app.billing.annual.subscribe"]({ price: displayedPrice })}
        </Button>
      </div>
    </section>
  )
}

function TopUpCard({
  catalog,
  disabled,
  onAction,
  pending,
  locale,
  subscribed,
}: {
  readonly catalog: BillingCatalog | null
  readonly disabled: boolean
  readonly onAction: () => void
  readonly pending: boolean
  readonly locale: Locale
  readonly subscribed: boolean
}) {
  const price = catalog?.prices.find((item) => item.lookupKey === "taxmaxi_topup_1k_eur")
  const displayedPrice = price === undefined ? null : formatCatalogPrice(price, locale)
  return (
    <section className={cn(appPanelClassName, "flex flex-col gap-4 p-5")}>
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">{m["app.billing.topUp.title"]()}</h2>
        <p className="text-sm text-muted-foreground">{m["app.billing.topUp.description"]()}</p>
      </div>
      <p className="text-2xl font-semibold tabular-nums tracking-tight">
        {displayedPrice ?? m["app.billing.priceUnavailable"]()}
        <span className="ml-2 text-sm font-normal text-muted-foreground">
          {taxLabel(price?.taxBehavior)}
        </span>
      </p>
      <div className="flex flex-col items-start gap-2">
        <Button
          disabled={isTopUpActionDisabled({
            hasCatalogPrice: displayedPrice !== null,
            pendingAction: disabled,
          })}
          onClick={onAction}
          variant="outline"
        >
          <Plus data-icon="inline-start" />
          {pending ? m["app.billing.openingStripe"]() : m["app.billing.topUp.buy"]()}
        </Button>
        {subscribed ? null : (
          <p className="text-xs text-muted-foreground">{m["app.billing.topUp.eligibility"]()}</p>
        )}
      </div>
    </section>
  )
}

export function formatCatalogPrice(
  price: {
    readonly amountMinor: number
    readonly currency: string
  },
  locale: Locale = getLocale()
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: price.currency.toUpperCase(),
  }).format(price.amountMinor / 100)
}

function taxLabel(taxBehavior: "exclusive" | "inclusive" | "unspecified" | undefined): string {
  switch (taxBehavior) {
    case "inclusive":
      return m["app.billing.tax.included"]()
    case "exclusive":
      return m["app.billing.tax.exclusive"]()
    default:
      return m["app.billing.tax.checkout"]()
  }
}
