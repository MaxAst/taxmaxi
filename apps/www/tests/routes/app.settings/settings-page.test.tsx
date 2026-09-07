// @vitest-environment jsdom

import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Account } from "taxmaxi"

import { SettingsPageContent } from "#/routes/app.settings"

const account: Account = {
  account: {
    id: "00000000-0000-4000-8000-000000000101",
    email: "account@taxmaxi.test",
    displayName: "Account Owner",
    role: "member",
    emailVerified: true,
    welcomeSeenAt: null,
    createdAt: "2026-08-18T12:00:00.000Z",
    updatedAt: "2026-08-18T12:30:00.000Z",
  },
  loginMethods: [
    {
      id: "00000000-0000-4000-8000-000000000102",
      provider: "coinbase",
      providerEmail: "provider@coinbase.test",
      linkedAt: "2026-08-18T12:00:00.000Z",
      isCurrentSession: true,
      isAvailable: false,
      unavailableReason: "provider_disabled",
      canRemove: true,
    },
    {
      id: "00000000-0000-4000-8000-000000000103",
      provider: "google",
      providerEmail: "person@gmail.test",
      linkedAt: "2026-08-18T12:15:00.000Z",
      isCurrentSession: false,
      isAvailable: true,
      unavailableReason: null,
      canRemove: true,
    },
    {
      id: "00000000-0000-4000-8000-000000000104",
      provider: "local",
      providerEmail: null,
      linkedAt: "2026-08-18T12:30:00.000Z",
      isCurrentSession: false,
      isAvailable: false,
      unavailableReason: "email_unverified",
      canRemove: true,
    },
  ],
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

afterEach(cleanup)

const renderSettingsPage = async (onClose = vi.fn()) => {
  const rootRoute = createRootRoute({
    component: () => <SettingsPageContent account={account} onClose={onClose} />,
  })
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute,
  })

  await router.load()
  render(<RouterProvider router={router} />)
  return { onClose }
}

describe("SettingsPageContent", () => {
  it("shows the account email and every linked login method", async () => {
    await renderSettingsPage()

    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy()
    expect(screen.getByText("account@taxmaxi.test")).toBeTruthy()
    expect(screen.getByRole("heading", { name: "Coinbase" })).toBeTruthy()
    expect(screen.getByText("provider@coinbase.test")).toBeTruthy()
    expect(screen.getByText("Current session")).toBeTruthy()
    expect(screen.getByRole("heading", { name: "Google" })).toBeTruthy()
    expect(screen.getByText("person@gmail.test")).toBeTruthy()
    expect(screen.getByRole("heading", { name: "Email and password" })).toBeTruthy()
    expect(screen.getByText("These methods are linked to your account.")).toBeTruthy()
    expect(screen.getAllByText("Unavailable")).toHaveLength(2)
    expect(screen.getByText("This provider is currently unavailable.")).toBeTruthy()
    expect(screen.getByText("Verify your account email before using this method.")).toBeTruthy()
    expect(document.querySelector("[data-page='app']")).toBeTruthy()
  })

  it("closes from the header button", async () => {
    const { onClose } = await renderSettingsPage()

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }))

    // The overlay plays its exit animation before calling onClose.
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it("closes on Escape", async () => {
    const { onClose } = await renderSettingsPage()

    fireEvent.keyDown(document, { key: "Escape" })

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })
})
