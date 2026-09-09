// @vitest-environment jsdom

import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AccountMenu } from "#/components/account-menu"
import { ASSET_CATALOG_OPENER_ID } from "#/lib/asset-catalog-focus"
import { logoutFromApp } from "#/lib/auth-session"
import { m } from "#/paraglide/messages"

beforeEach(() => {
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

afterEach(cleanup)

const renderAccountMenu = async (onLogout = vi.fn().mockResolvedValue(undefined)) => {
  const rootRoute = createRootRoute({ component: Outlet })
  const appRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/app",
    component: () => (
      <div>
        <AccountMenu onLogout={onLogout} />
        <p>App dashboard</p>
      </div>
    ),
  })
  const billingRoute = createRoute({
    getParentRoute: () => appRoute,
    path: "billing",
    component: () => <p>Billing page</p>,
  })
  const settingsRoute = createRoute({
    getParentRoute: () => appRoute,
    path: "settings",
    component: () => <p>Settings page</p>,
  })
  const assetsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/assets",
    component: () => <p>Assets page</p>,
  })
  const routeTree = rootRoute.addChildren([
    appRoute.addChildren([billingRoute, settingsRoute]),
    assetsRoute,
  ])
  const history = createMemoryHistory({ initialEntries: ["/app"] })
  const router = createRouter({ history, routeTree })

  await router.load()
  render(<RouterProvider router={router} />)

  return { history, onLogout }
}

const openAccountMenu = () => {
  fireEvent.pointerDown(screen.getByRole("button", { name: "Menu" }), {
    button: 0,
    ctrlKey: false,
  })
}

describe("AccountMenu", () => {
  it("provides the asset catalog return-focus target", async () => {
    await renderAccountMenu()

    expect(screen.getByRole("button", { name: "Menu" }).id).toBe(ASSET_CATALOG_OPENER_ID)
    expect(screen.getByRole("button", { name: "Menu" }).textContent).toContain("Menu")
    expect(m["app.accountMenu.label"]({}, { locale: "de" })).toBe("Menü")
  })

  it.each([
    { label: "Assets", path: "/assets" },
    { label: "Billing", path: "/app/billing" },
    { label: "Settings", path: "/app/settings" },
  ])("navigates to $label", async ({ label, path }) => {
    const { history } = await renderAccountMenu()

    openAccountMenu()
    fireEvent.click(await screen.findByRole("menuitem", { name: label }))

    await waitFor(() => expect(history.location.pathname).toBe(path))
  })

  it("runs the logout action from the account menu", async () => {
    const { onLogout } = await renderAccountMenu()

    openAccountMenu()
    fireEvent.click(await screen.findByRole("menuitem", { name: "Log out" }))

    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1))
  })
})

describe("logoutFromApp", () => {
  it("invalidates the backend session before clearing client state and returning to login", async () => {
    const calls: Array<string> = []

    await logoutFromApp({
      logout: async () => {
        calls.push("backend")
      },
      clearClientState: async () => {
        calls.push("client")
      },
      navigateToLogin: async () => {
        calls.push("login")
      },
    })

    expect(calls).toEqual(["backend", "client", "login"])
  })

  it("keeps client state when backend logout fails", async () => {
    const clearClientState = vi.fn()
    const navigateToLogin = vi.fn()

    await expect(
      logoutFromApp({
        logout: () => Promise.reject(new Error("API unavailable")),
        clearClientState,
        navigateToLogin,
      })
    ).rejects.toThrow("API unavailable")

    expect(clearClientState).not.toHaveBeenCalled()
    expect(navigateToLogin).not.toHaveBeenCalled()
  })
})
