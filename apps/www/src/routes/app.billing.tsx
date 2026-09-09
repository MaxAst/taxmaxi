import { useQueryClient } from "@tanstack/react-query"
import { createFileRoute, redirect } from "@tanstack/react-router"
import { CreditCard, Plus } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  isTaxMaxiUnauthorizedError,
  type Account,
  type BillingCatalog,
  type BillingPromiseResource,
  type BillingStatus,
} from "taxmaxi"
import { z } from "zod"

import { AppOverlay, useAppOverlayClose } from "#/components/app-overlay"
import { appPanelClassName } from "#/components/app-workspace"
import { Button } from "#/components/ui/button"
import { Text } from "#/components/ui/typography"
import { hasActiveSubscription } from "#/lib/first-sync-state"
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

/**
 * Whether `status` already shows the purchase the person returned from.
 * Stripe writes it into TaxMaxi through webhooks that can land after the
 * person is back on this page (#133 T09b). Stripe sends the subscription
 * event and the credit-grant event separately and in any order, so an annual
 * purchase shows only once the subscription is active or trialing and the
 * credits are in; an active plan with zero credits is still waiting for its
 * grant (#133, T09b note). A top-up only shows as a higher balance than the
 * one the overlay loaded with, so a loader status that already carries it
 * cannot be told apart from one that does not.
 */
export const statusShowsPurchase = ({
  initialStatus,
  kind,
  status,
}: {
  readonly initialStatus: BillingStatus
  readonly kind: CheckoutReturnKind
  readonly status: BillingStatus
}): boolean =>
  kind === "annual"
    ? hasActiveSubscription(status) && status.credits > 0
    : status.credits > initialStatus.credits

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
    if (statusShowsPurchase({ initialStatus, kind, status: latest })) {
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

  // Stable on purpose: the post-Checkout effect below lists it as a
  // dependency, and the search-stripping navigation above re-renders this
  // component; a new function per render would restart the poll.
  const onUnauthorized = useCallback(async () => {
    await clearAuthSessionCookie()
    await navigate({ to: "/login", replace: true })
  }, [navigate])

  return (
    <BillingPageContent
      assignLocation={(url) => window.location.assign(url)}
      billing={taxmaxi().billing}
      catalog={catalog}
      checkoutReturnKind={checkoutReturnKind}
      onClose={onClose}
      onUnauthorized={onUnauthorized}
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
  // The status on screen: the loader's `status` until a read below replaces
  // it. A new loader status (the route reloaded) replaces it too, so the poll
  // effect, which starts from `status`, and the confirming state, which reads
  // `liveStatus`, never disagree about where the wait began.
  const [liveStatus, setLiveStatus] = useState(status)
  useEffect(() => {
    setLiveStatus(status)
  }, [status])
  // False once the overlay unmounted: a status read that resolves after the
  // close must not write over the dashboard's own re-read, or send the app to
  // login from a component that is gone.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [pendingAction, setPendingAction] = useState<"annual" | "portal" | "topUp" | null>(null)
  const [error, setError] = useState<string | null>(null)
  // After a Checkout return the poll below reads status until it shows the
  // purchase. `pollGaveUp` is set when it stops without seeing it, so the
  // notice can offer a manual re-read; `checkingStatus` covers that re-read.
  const [pollGaveUp, setPollGaveUp] = useState(false)
  const [checkingStatus, setCheckingStatus] = useState(false)
  const subscribed =
    liveStatus.subscriptionStatus !== null &&
    liveStatus.subscriptionStatus !== "canceled" &&
    liveStatus.subscriptionStatus !== "incomplete_expired"
  const topUpEligible = hasActiveSubscription(liveStatus)
  // Stripe's webhooks can land after the person is back here, so the visible
  // status may still predate the purchase. While it does, the annual card
  // must not offer Subscribe again: a second annual Checkout is refused by
  // the API because Stripe already has the subscription (#133 T09b). A
  // top-up return gets no such notice: its status cannot say whether the
  // purchase is in yet, and a second top-up is a real purchase.
  const confirmingAnnual =
    checkoutReturnKind === "annual" &&
    !statusShowsPurchase({ initialStatus: status, kind: "annual", status: liveStatus })
  // The subscription event can land before the credit grant. Once the card
  // shows the plan, the wait for the credits is silent: no notice and nothing
  // disabled. The notice comes back only when the poll gave up, so the
  // person can ask for a re-read (#133, T09b note).
  const showConfirmingNotice = confirmingAnnual && (pollGaveUp || !subscribed)

  // The overlay renders above the mounted dashboard, whose first-sync wizard
  // reads billing through the `billingStatus` query. Every refreshed status is
  // written into that cache, so the wizard moves from `needs_credits` to
  // `ready`, or from `paused` to `resumable`, while the overlay is still open
  // (#108 D07).
  const applyRefreshedStatus = useCallback(
    (refreshed: BillingStatus, userId: string | undefined) => {
      setLiveStatus(refreshed)
      // The post-Checkout poll can run for tens of seconds and outlive a
      // logout; the write is dropped once the session's account entry is gone
      // or belongs to someone who signed in after the read started.
      setSessionQueryData({
        data: refreshed,
        queryClient,
        queryKey: queryKeys.billingStatus(),
        userId,
      })
    },
    [queryClient]
  )

  // The status response names no user, so the id the read started under is
  // the session's cached account at that moment (AGENTS.md rule 12).
  const readSessionUserId = useCallback(
    () => queryClient.getQueryData<Account>(queryKeys.account())?.account.id,
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

  // One status read outside the poll: the focus and visibility refreshes
  // while the poll runs, and Check again after it gave up. The result is
  // applied only while `shouldApply` says so, so a read that resolves after
  // the overlay closed does not write over the dashboard's own re-read. A
  // 401 leaves the app; any other failure keeps the visible status as it is.
  const readStatusOnce = useCallback(
    async (shouldApply: () => boolean) => {
      const userId = readSessionUserId()
      setCheckingStatus(true)
      try {
        const refreshed = await billing.status()
        if (shouldApply()) applyRefreshedStatus(refreshed, userId)
      } catch (cause) {
        if (shouldApply() && isTaxMaxiUnauthorizedError(cause)) await onUnauthorized()
      } finally {
        setCheckingStatus(false)
      }
    },
    [applyRefreshedStatus, billing, onUnauthorized, readSessionUserId]
  )

  useEffect(() => {
    if (checkoutReturnKind === null) return
    const purchaseShown = (latest: BillingStatus) =>
      statusShowsPurchase({ initialStatus: status, kind: checkoutReturnKind, status: latest })
    // The loader's status already shows the purchase (the webhook landed
    // before the redirect, or this is a revisit of the return URL): nothing
    // to wait for.
    if (purchaseShown(status)) return
    const userId = readSessionUserId()
    let active = true
    setPollGaveUp(false)

    const refreshOnFocus = () => void readStatusOnce(() => active)
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshOnFocus()
    }

    window.addEventListener("focus", refreshOnFocus)
    document.addEventListener("visibilitychange", refreshWhenVisible)

    void refreshBillingStatusAfterCheckout({
      initialStatus: status,
      kind: checkoutReturnKind,
      loadStatus: billing.status,
      shouldContinue: () => active,
      wait: (delayMs) => new Promise((resolve) => window.setTimeout(resolve, delayMs)),
    })
      .then((refreshed) => {
        if (!active) return
        // When every poll failed, `refreshed` is the loader-time `status`
        // itself, not a read; writing it would put a stale snapshot over a
        // fresher value the focus refresh or the dashboard may have cached.
        if (refreshed !== status) applyRefreshedStatus(refreshed, userId)
        if (!purchaseShown(refreshed)) setPollGaveUp(true)
      })
      .catch(async (cause: unknown) => {
        if (active && isTaxMaxiUnauthorizedError(cause)) await onUnauthorized()
      })
    return () => {
      active = false
      window.removeEventListener("focus", refreshOnFocus)
      document.removeEventListener("visibilitychange", refreshWhenVisible)
    }
  }, [
    applyRefreshedStatus,
    billing,
    checkoutReturnKind,
    onUnauthorized,
    readSessionUserId,
    readStatusOnce,
    status,
  ])

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

        {showConfirmingNotice ? (
          <div className="flex flex-wrap items-center gap-3" role="status">
            <Text size="bodySm" tone="muted">
              {pollGaveUp
                ? m["app.billing.checkoutReturn.unconfirmed"]()
                : m["app.billing.checkoutReturn.confirming"]()}
            </Text>
            {pollGaveUp ? (
              <Button
                disabled={checkingStatus}
                onClick={() => void readStatusOnce(() => mounted.current)}
                size="sm"
                variant="outline"
              >
                {checkingStatus
                  ? m["app.billing.checkoutReturn.checking"]()
                  : m["app.billing.checkoutReturn.checkAgain"]()}
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-2">
          <AnnualBillingCard
            catalog={catalog}
            confirming={confirmingAnnual}
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
  confirming,
  disabled,
  onAction,
  pending,
  locale,
  status,
  subscribed,
}: {
  readonly catalog: BillingCatalog | null
  /** True while a returned-from Checkout is not yet visible in `status`; hides Subscribe. */
  readonly confirming: boolean
  readonly disabled: boolean
  readonly onAction: () => void
  readonly pending: boolean
  readonly locale: Locale
  readonly status: BillingStatus
  readonly subscribed: boolean
}) {
  const price = catalog?.prices.find((item) => item.lookupKey === "taxmaxi_annual_10k_eur")
  const displayedPrice = price === undefined ? null : formatCatalogPrice(price, locale)
  const action =
    confirming && !subscribed ? (
      <Button disabled>
        <CreditCard data-icon="inline-start" />
        {m["app.billing.annual.confirming"]()}
      </Button>
    ) : (
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
    )
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
      <div>{action}</div>
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
