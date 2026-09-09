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
  const promise = new Promise<A>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
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
