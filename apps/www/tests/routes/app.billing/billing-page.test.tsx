// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  TaxMaxiError,
  type Account,
  type BillingCatalog,
  type BillingPromiseResource,
  type BillingStatus,
} from "taxmaxi"

import { queryKeys } from "#/integrations/taxmaxi/queries"
import { BillingPageContent, loadBillingPageData } from "#/routes/app.billing"

const catalog: BillingCatalog = {
  prices: [
    {
      lookupKey: "taxmaxi_annual_10k_eur",
      amountMinor: 15_900,
      currency: "eur",
      taxBehavior: "inclusive",
      recurringInterval: "year",
    },
    {
      lookupKey: "taxmaxi_topup_1k_eur",
      amountMinor: 2_000,
      currency: "eur",
      taxBehavior: "inclusive",
      recurringInterval: null,
    },
  ],
}

const status = (subscriptionStatus: BillingStatus["subscriptionStatus"] = null): BillingStatus => ({
  credits: 10_000,
  subscriptionStatus,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
})

const sessionAccount: Account = {
  account: {
    id: "00000000-0000-4000-8000-000000000001",
    email: "user@example.test",
    displayName: "User",
    role: "member",
    emailVerified: true,
    welcomeSeenAt: "2025-01-01T00:00:00.000Z",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  },
  loginMethods: [],
}

const deferred = <A,>() => {
  let resolve: (value: A) => void = () => undefined
  let reject: (reason: unknown) => void = () => undefined
  const promise = new Promise<A>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  return { promise, reject, resolve }
}

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      clear: vi.fn(),
      getItem: vi.fn(() => null),
      key: vi.fn(() => null),
      length: 0,
      removeItem: vi.fn(),
      setItem: vi.fn(),
    } satisfies Storage,
  })
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(
      (query: string): MediaQueryList => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        dispatchEvent: vi.fn(() => true),
        matches: false,
        media: query,
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      })
    ),
  })
})

const renderBillingPage = async ({
  annualCheckout = vi.fn().mockResolvedValue({ url: "https://stripe.test/annual" }),
  assignLocation = vi.fn(),
  checkoutReturnKind = null,
  initialStatus,
  loadStatus,
  onClose = vi.fn(),
  onUnauthorized = vi.fn().mockResolvedValue(undefined),
  portal = vi.fn().mockResolvedValue({ url: "https://stripe.test/portal" }),
  subscriptionStatus = null,
  topUpCheckout = vi.fn().mockResolvedValue({ url: "https://stripe.test/top-up" }),
}: {
  readonly annualCheckout?: BillingPromiseResource["createAnnualCheckout"]
  readonly assignLocation?: (url: string) => void
  readonly checkoutReturnKind?: "annual" | "topUp" | null
  /** The status the loader handed over; defaults to 10,000 credits with `subscriptionStatus`. */
  readonly initialStatus?: BillingStatus
  readonly loadStatus?: BillingPromiseResource["status"]
  readonly onClose?: () => void
  readonly onUnauthorized?: () => Promise<void>
  readonly portal?: BillingPromiseResource["createPortalSession"]
  readonly subscriptionStatus?: BillingStatus["subscriptionStatus"]
  readonly topUpCheckout?: BillingPromiseResource["createTopUpCheckout"]
} = {}) => {
  const loadedStatus = initialStatus ?? status(subscriptionStatus)
  const billing: BillingPromiseResource = {
    catalog: () => Promise.resolve(catalog),
    status: loadStatus ?? (() => Promise.resolve(loadedStatus)),
    createAnnualCheckout: annualCheckout,
    createTopUpCheckout: topUpCheckout,
    createPortalSession: portal,
  }
  // The `/app` loader leaves the session's account and the loaded status in
  // the cache the dashboard's first-sync wizard reads (#108 D07, D08).
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(queryKeys.account(), sessionAccount)
  queryClient.setQueryData(queryKeys.billingStatus(), loadedStatus)
  const rootRoute = createRootRoute({
    component: () => (
      <BillingPageContent
        assignLocation={assignLocation}
        billing={billing}
        catalog={catalog}
        checkoutReturnKind={checkoutReturnKind}
        onClose={onClose}
        onUnauthorized={onUnauthorized}
        status={loadedStatus}
      />
    ),
  })
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute,
  })
  await router.load()
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  expect(document.querySelector("[data-page='app']")).toBeTruthy()
  return { assignLocation, onClose, onUnauthorized, queryClient }
}

afterEach(cleanup)

describe("BillingPageContent", () => {
  it("closes from the header button", async () => {
    const { onClose } = await renderBillingPage()

    fireEvent.click(screen.getByRole("button", { name: "Close billing" }))

    // The overlay plays its exit animation before calling onClose.
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it.each([
    {
      expectedUrl: "https://stripe.test/annual",
      label: /Subscribe for €159.00/,
      method: "annual" as const,
      subscriptionStatus: null,
    },
    {
      expectedUrl: "https://stripe.test/portal",
      label: "Manage subscription",
      method: "portal" as const,
      subscriptionStatus: "active",
    },
    {
      expectedUrl: "https://stripe.test/top-up",
      label: "Buy 1,000 credits",
      method: "topUp" as const,
      subscriptionStatus: "active",
    },
  ] satisfies ReadonlyArray<{
    readonly expectedUrl: string
    readonly label: string | RegExp
    readonly method: "annual" | "portal" | "topUp"
    readonly subscriptionStatus: BillingStatus["subscriptionStatus"]
  }>)(
    "opens Stripe from the $method action",
    async ({ expectedUrl, label, method, subscriptionStatus }) => {
      const annualCheckout = vi.fn().mockResolvedValue({ url: "https://stripe.test/annual" })
      const portal = vi.fn().mockResolvedValue({ url: "https://stripe.test/portal" })
      const topUpCheckout = vi.fn().mockResolvedValue({ url: "https://stripe.test/top-up" })
      const { assignLocation } = await renderBillingPage({
        annualCheckout,
        portal,
        subscriptionStatus,
        topUpCheckout,
      })

      fireEvent.click(screen.getByRole("button", { name: label }))

      await waitFor(() => expect(assignLocation).toHaveBeenCalledWith(expectedUrl))
      expect(annualCheckout).toHaveBeenCalledTimes(method === "annual" ? 1 : 0)
      expect(portal).toHaveBeenCalledTimes(method === "portal" ? 1 : 0)
      expect(topUpCheckout).toHaveBeenCalledTimes(method === "topUp" ? 1 : 0)
    }
  )

  it("disables purchase actions while Stripe Checkout is opening", async () => {
    const checkout = deferred<{ readonly url: string }>()
    const { assignLocation } = await renderBillingPage({
      annualCheckout: () => checkout.promise,
    })

    fireEvent.click(screen.getByRole("button", { name: /Subscribe for €159.00/ }))

    expect(screen.getByRole("button", { name: "Opening Stripe…" }).hasAttribute("disabled")).toBe(
      true
    )
    expect(screen.getByRole("button", { name: "Buy 1,000 credits" }).hasAttribute("disabled")).toBe(
      true
    )
    checkout.resolve({ url: "https://stripe.test/annual" })
    await waitFor(() => expect(assignLocation).toHaveBeenCalledWith("https://stripe.test/annual"))
  })

  it("shows a Checkout failure and lets the user try again", async () => {
    const annualCheckout = vi.fn().mockRejectedValue(new Error("Stripe is unavailable"))
    await renderBillingPage({ annualCheckout })
    const subscribe = screen.getByRole("button", { name: /Subscribe for €159.00/ })

    fireEvent.click(subscribe)

    expect((await screen.findByRole("alert")).textContent).toContain("Stripe is unavailable")
    expect(subscribe.hasAttribute("disabled")).toBe(false)
    fireEvent.click(subscribe)
    await waitFor(() => expect(annualCheckout).toHaveBeenCalledTimes(2))
  })

  it.each([
    {
      checkoutReturnKind: "annual" as const,
      initialSubscriptionStatus: null,
      refreshedStatus: { ...status("active"), credits: 20_000 },
    },
    {
      checkoutReturnKind: "topUp" as const,
      initialSubscriptionStatus: "active" as const,
      refreshedStatus: { ...status("active"), credits: 11_000 },
    },
  ])(
    "refreshes the visible status after a $checkoutReturnKind Checkout return",
    async ({ checkoutReturnKind, initialSubscriptionStatus, refreshedStatus }) => {
      vi.useFakeTimers()
      const loadStatus = vi.fn().mockResolvedValue(refreshedStatus)
      try {
        await renderBillingPage({
          checkoutReturnKind,
          loadStatus,
          subscriptionStatus: initialSubscriptionStatus,
        })

        await act(async () => {
          await vi.advanceTimersByTimeAsync(500)
        })

        expect(loadStatus).toHaveBeenCalledTimes(1)
        expect(
          screen.getByText(new Intl.NumberFormat().format(refreshedStatus.credits))
        ).toBeTruthy()
        expect(screen.getByRole("button", { name: "Manage subscription" })).toBeTruthy()
      } finally {
        vi.useRealTimers()
      }
    }
  )

  // #133 T09b: after a Stripe return the overlay only reads status. Until the
  // status shows the purchase (the webhook that records it can land after the
  // person is back), the annual card offers no second Subscribe, because that
  // asks the API for a new Checkout and the API refuses it: Stripe already has
  // the subscription. The page says it is confirming instead of showing an error.
  it("waits for Stripe on an annual return without offering a second Subscribe", async () => {
    vi.useFakeTimers()
    const initialStatus = { ...status(null), credits: 0 }
    const confirmedStatus = { ...status("active"), credits: 10_000 }
    const annualCheckout = vi.fn().mockResolvedValue({ url: "https://stripe.test/annual" })
    const loadStatus = vi
      .fn<() => Promise<BillingStatus>>()
      .mockResolvedValueOnce(initialStatus)
      .mockResolvedValueOnce(initialStatus)
      .mockResolvedValue(confirmedStatus)
    try {
      const { queryClient } = await renderBillingPage({
        annualCheckout,
        checkoutReturnKind: "annual",
        initialStatus,
        loadStatus,
      })

      const confirming = () =>
        screen.queryByText(
          "Stripe is confirming your payment. Your plan and credits appear here in a moment."
        )
      expect(confirming()).toBeTruthy()
      expect(screen.queryByRole("button", { name: /Subscribe for/ })).toBeNull()
      expect(
        screen.getByRole("button", { name: "Confirming subscription…" }).hasAttribute("disabled")
      ).toBe(true)
      expect(screen.queryByRole("alert")).toBeNull()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(loadStatus).toHaveBeenCalledTimes(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(loadStatus).toHaveBeenCalledTimes(2)
      expect(confirming()).toBeTruthy()
      expect(screen.queryByRole("button", { name: /Subscribe for/ })).toBeNull()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000)
      })

      expect(loadStatus).toHaveBeenCalledTimes(3)
      expect(confirming()).toBeNull()
      expect(screen.getByRole("button", { name: "Manage subscription" })).toBeTruthy()
      expect(screen.getByText(new Intl.NumberFormat().format(10_000))).toBeTruthy()
      expect(queryClient.getQueryData(queryKeys.billingStatus())).toEqual(confirmedStatus)
      expect(screen.queryByRole("alert")).toBeNull()
      expect(annualCheckout).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  // The loader reads status fresh on the full-page return, so when Stripe's
  // webhooks landed before the redirect (the common case) the subscription
  // and its credits are already visible. Nothing is left to wait for.
  it("shows the plan right away when the loader already carries the annual subscription and its credits", async () => {
    vi.useFakeTimers()
    const loadStatus = vi.fn<() => Promise<BillingStatus>>()
    try {
      await renderBillingPage({
        checkoutReturnKind: "annual",
        initialStatus: { ...status("active"), credits: 10_000 },
        loadStatus,
      })

      expect(screen.getByRole("button", { name: "Manage subscription" })).toBeTruthy()
      expect(screen.queryByRole("status")).toBeNull()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })

      // Nothing is left to wait for, so the poll does not run.
      expect(loadStatus).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  // #133, T09b note: Stripe delivers the subscription event and the
  // credit-grant event separately and in any order, so an annual return can
  // show an active plan with zero credits. That is not confirmed yet: the
  // card already shows the plan, so the wait is silent, and the poll keeps
  // reading until the credits arrive.
  it("keeps polling silently on an annual return until an active plan also has credits", async () => {
    vi.useFakeTimers()
    const initialStatus = { ...status("active"), credits: 0 }
    const confirmedStatus = { ...status("active"), credits: 10_000 }
    const loadStatus = vi
      .fn<() => Promise<BillingStatus>>()
      .mockResolvedValueOnce(initialStatus)
      .mockResolvedValue(confirmedStatus)
    try {
      const { queryClient } = await renderBillingPage({
        checkoutReturnKind: "annual",
        initialStatus,
        loadStatus,
      })

      const manage = () => screen.getByRole("button", { name: "Manage subscription" })
      expect(manage().hasAttribute("disabled")).toBe(false)
      expect(screen.queryByRole("status")).toBeNull()
      expect(screen.queryByRole("button", { name: /Confirming subscription/ })).toBeNull()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(loadStatus).toHaveBeenCalledTimes(1)
      expect(manage().hasAttribute("disabled")).toBe(false)
      expect(screen.queryByRole("status")).toBeNull()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })

      expect(loadStatus).toHaveBeenCalledTimes(2)
      expect(screen.getByText(new Intl.NumberFormat().format(10_000))).toBeTruthy()
      expect(queryClient.getQueryData(queryKeys.billingStatus())).toEqual(confirmedStatus)
      expect(screen.queryByRole("status")).toBeNull()

      // Confirmed: the poll stops.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(loadStatus).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("offers Check again when the credits never arrive behind an active plan", async () => {
    vi.useFakeTimers()
    const initialStatus = { ...status("active"), credits: 0 }
    const loadStatus = vi.fn<() => Promise<BillingStatus>>().mockResolvedValue(initialStatus)
    try {
      await renderBillingPage({ checkoutReturnKind: "annual", initialStatus, loadStatus })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(6 * 60_000)
      })

      expect(loadStatus).toHaveBeenCalledTimes(15)
      expect(
        screen.getByText("Stripe has not confirmed your payment yet. Check again in a moment.")
      ).toBeTruthy()
      expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy()
      expect(
        screen.getByRole("button", { name: "Manage subscription" }).hasAttribute("disabled")
      ).toBe(false)
      expect(screen.queryByRole("button", { name: /Subscribe for/ })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  // A plain visit to the billing page is not a checkout return, so an active
  // plan with zero credits (the credits were spent) has nothing to wait for.
  it("does not poll on a plain visit that shows an active plan with zero credits", async () => {
    vi.useFakeTimers()
    const loadStatus = vi.fn<() => Promise<BillingStatus>>()
    try {
      await renderBillingPage({
        checkoutReturnKind: null,
        initialStatus: { ...status("active"), credits: 0 },
        loadStatus,
      })

      expect(screen.getByRole("button", { name: "Manage subscription" })).toBeTruthy()
      expect(screen.queryByRole("status")).toBeNull()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(6 * 60_000)
      })

      expect(loadStatus).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  // A top-up only shows as a higher balance, and the loader may already carry
  // it, so the overlay cannot tell "not in yet" from "already in". It keeps
  // the silent poll and leaves Buy credits available: a second top-up is a
  // real purchase, unlike a second annual Checkout.
  it("shows no confirming notice on a top-up return and keeps Buy credits available", async () => {
    vi.useFakeTimers()
    const initialStatus = { ...status("active"), credits: 11_000 }
    const loadStatus = vi.fn<() => Promise<BillingStatus>>().mockResolvedValue(initialStatus)
    try {
      await renderBillingPage({ checkoutReturnKind: "topUp", initialStatus, loadStatus })

      expect(screen.queryByRole("status")).toBeNull()
      expect(
        screen.getByRole("button", { name: "Buy 1,000 credits" }).hasAttribute("disabled")
      ).toBe(false)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(6 * 60_000)
      })

      expect(loadStatus).toHaveBeenCalledTimes(15)
      expect(screen.queryByRole("status")).toBeNull()
      expect(screen.queryByRole("button", { name: "Check again" })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  // AGENTS.md rule 12: the poll carries the user id it started under, so its
  // result does not land in the cache of a user who signed in meanwhile.
  it("drops the poll's cache write when another user signed in before it resolved", async () => {
    vi.useFakeTimers()
    const initialStatus = { ...status(null), credits: 0 }
    const pending = deferred<BillingStatus>()
    const loadStatus = vi.fn(() => pending.promise)
    try {
      const { queryClient } = await renderBillingPage({
        checkoutReturnKind: "annual",
        initialStatus,
        loadStatus,
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(loadStatus).toHaveBeenCalledTimes(1)

      const otherAccount: Account = {
        ...sessionAccount,
        account: { ...sessionAccount.account, id: "00000000-0000-4000-8000-000000000002" },
      }
      queryClient.setQueryData(queryKeys.account(), otherAccount)
      queryClient.setQueryData(queryKeys.billingStatus(), { ...status("active"), credits: 3 })
      pending.resolve({ ...status("active"), credits: 10_000 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(queryClient.getQueryData(queryKeys.billingStatus())).toEqual({
        ...status("active"),
        credits: 3,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("offers Check again once the poll gives up without a confirmation", async () => {
    vi.useFakeTimers()
    const initialStatus = { ...status(null), credits: 0 }
    const confirmedStatus = { ...status("active"), credits: 10_000 }
    const loadStatus = vi.fn<() => Promise<BillingStatus>>().mockResolvedValue(initialStatus)
    try {
      await renderBillingPage({ checkoutReturnKind: "annual", initialStatus, loadStatus })

      // Fifteen attempts with the capped backoff take about five minutes.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6 * 60_000)
      })

      expect(loadStatus).toHaveBeenCalledTimes(15)
      expect(
        screen.getByText("Stripe has not confirmed your payment yet. Check again in a moment.")
      ).toBeTruthy()
      expect(screen.queryByRole("button", { name: /Subscribe for/ })).toBeNull()
      expect(screen.queryByRole("alert")).toBeNull()

      loadStatus.mockResolvedValue(confirmedStatus)
      fireEvent.click(screen.getByRole("button", { name: "Check again" }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(loadStatus).toHaveBeenCalledTimes(16)
      expect(screen.getByRole("button", { name: "Manage subscription" })).toBeTruthy()
      expect(screen.queryByText(/Stripe has not confirmed/)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  // Check again passes the same after-close guard as the focus refresh: a
  // read that resolves after the overlay closed is dropped, so it neither
  // writes over the dashboard's fresher re-read nor leaves the app from a
  // component that is gone.
  it("drops a Check again read that resolves after the overlay closed", async () => {
    vi.useFakeTimers()
    const initialStatus = { ...status(null), credits: 0 }
    const loadStatus = vi.fn<() => Promise<BillingStatus>>().mockResolvedValue(initialStatus)
    try {
      const { queryClient } = await renderBillingPage({
        checkoutReturnKind: "annual",
        initialStatus,
        loadStatus,
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6 * 60_000)
      })
      expect(loadStatus).toHaveBeenCalledTimes(15)

      const pending = deferred<BillingStatus>()
      loadStatus.mockImplementation(() => pending.promise)
      fireEvent.click(screen.getByRole("button", { name: "Check again" }))
      expect(loadStatus).toHaveBeenCalledTimes(16)

      cleanup()
      // The six minutes above passed the cache's gc time for queries nobody
      // observes; the dashboard underneath keeps both alive, so restore them.
      const dashboardRead = { ...status("active"), credits: 9_000 }
      queryClient.setQueryData(queryKeys.account(), sessionAccount)
      queryClient.setQueryData(queryKeys.billingStatus(), dashboardRead)
      pending.resolve({ ...status("active"), credits: 10_000 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(queryClient.getQueryData(queryKeys.billingStatus())).toEqual(dashboardRead)
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not leave the app from a Check again 401 that resolves after the overlay closed", async () => {
    vi.useFakeTimers()
    const initialStatus = { ...status(null), credits: 0 }
    const loadStatus = vi.fn<() => Promise<BillingStatus>>().mockResolvedValue(initialStatus)
    const onUnauthorized = vi.fn().mockResolvedValue(undefined)
    try {
      await renderBillingPage({
        checkoutReturnKind: "annual",
        initialStatus,
        loadStatus,
        onUnauthorized,
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6 * 60_000)
      })
      expect(loadStatus).toHaveBeenCalledTimes(15)

      const pending = deferred<BillingStatus>()
      loadStatus.mockImplementation(() => pending.promise)
      fireEvent.click(screen.getByRole("button", { name: "Check again" }))
      expect(loadStatus).toHaveBeenCalledTimes(16)

      cleanup()
      pending.reject(new TaxMaxiError({ message: "Sign in again.", status: 401 }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(onUnauthorized).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("handles an unauthorized status refresh after Checkout", async () => {
    vi.useFakeTimers()
    const onUnauthorized = vi.fn().mockResolvedValue(undefined)
    const loadStatus = vi.fn().mockRejectedValue(
      new TaxMaxiError({
        message: "Sign in again.",
        status: 401,
      })
    )
    try {
      await renderBillingPage({ checkoutReturnKind: "annual", loadStatus, onUnauthorized })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })

      expect(onUnauthorized).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("refreshes a delayed Checkout return when the page regains focus", async () => {
    vi.useFakeTimers()
    const refreshedStatus = { ...status("active"), credits: 11_000 }
    const loadStatus = vi.fn().mockResolvedValue(refreshedStatus)
    try {
      await renderBillingPage({
        checkoutReturnKind: "topUp",
        loadStatus,
        subscriptionStatus: "active",
      })

      window.dispatchEvent(new Event("focus"))

      await act(async () => {
        await Promise.resolve()
      })

      expect(loadStatus).toHaveBeenCalledTimes(1)
      expect(screen.getByText(new Intl.NumberFormat().format(11_000))).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  // #108 D07: the wizard underneath reads the `billingStatus` query, so the
  // overlay hands every refreshed status to that cache and invalidates it on close.
  it("writes the refreshed status into the billingStatus query cache after a Checkout return", async () => {
    vi.useFakeTimers()
    const initialStatus = { ...status("active"), credits: 0 }
    const refreshedStatus = { ...status("active"), credits: 5 }
    const loadStatus = vi.fn().mockResolvedValue(refreshedStatus)
    try {
      const { queryClient } = await renderBillingPage({
        checkoutReturnKind: "topUp",
        initialStatus,
        loadStatus,
      })
      expect(queryClient.getQueryData(queryKeys.billingStatus())).toEqual(initialStatus)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })

      expect(loadStatus).toHaveBeenCalledTimes(1)
      expect(queryClient.getQueryData(queryKeys.billingStatus())).toEqual(refreshedStatus)
      expect(screen.getByText("5")).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  // A logout while the post-Checkout poll is still running removes every
  // `taxmaxi` query; the poll's late result must not repopulate the cache for
  // the next login in the same tab.
  it("leaves billingStatus unset when the poll resolves after logout", async () => {
    vi.useFakeTimers()
    const initialStatus = { ...status("active"), credits: 0 }
    const pending = deferred<BillingStatus>()
    const loadStatus = vi.fn(() => pending.promise)
    try {
      const { queryClient } = await renderBillingPage({
        checkoutReturnKind: "topUp",
        initialStatus,
        loadStatus,
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
      expect(loadStatus).toHaveBeenCalledTimes(1)

      queryClient.removeQueries({ queryKey: queryKeys.all })
      pending.resolve({ ...status("active"), credits: 5 })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(queryClient.getQueryData(queryKeys.billingStatus())).toBeUndefined()
      expect(queryClient.getQueryData(queryKeys.account())).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it("invalidates the billingStatus query when the overlay closes", async () => {
    const { onClose, queryClient } = await renderBillingPage()
    expect(queryClient.getQueryState(queryKeys.billingStatus())?.isInvalidated).toBe(false)

    fireEvent.click(screen.getByRole("button", { name: "Close billing" }))

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(queryClient.getQueryState(queryKeys.billingStatus())?.isInvalidated).toBe(true)
  })
})

describe("loadBillingPageData (#108, T06 note)", () => {
  const unauthorized = new TaxMaxiError({ message: "Sign in again.", status: 401 })
  const catalogUnavailable = new TaxMaxiError({ message: "Catalog unavailable.", status: 500 })
  const statusUnavailable = new TaxMaxiError({ message: "Status unavailable.", status: 500 })

  const rejectLater = <T,>(error: unknown): Promise<T> =>
    new Promise((_, reject) => {
      setTimeout(() => reject(error), 0)
    })

  it("lets a status 401 win over a catalog failure that settles first", async () => {
    await expect(
      loadBillingPageData({
        loadCatalog: () => Promise.reject(catalogUnavailable),
        loadStatus: () => rejectLater(unauthorized),
      })
    ).rejects.toBe(unauthorized)
  })

  it("lets a catalog 401 win over a status failure that settles first", async () => {
    await expect(
      loadBillingPageData({
        loadCatalog: () => rejectLater(unauthorized),
        loadStatus: () => Promise.reject(statusUnavailable),
      })
    ).rejects.toBe(unauthorized)
  })

  it("throws the status failure and drops the catalog when both fail for other reasons", async () => {
    await expect(
      loadBillingPageData({
        loadCatalog: () => Promise.reject(catalogUnavailable),
        loadStatus: () => rejectLater(statusUnavailable),
      })
    ).rejects.toBe(statusUnavailable)
  })
})
