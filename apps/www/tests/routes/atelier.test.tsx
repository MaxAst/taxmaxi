// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query"
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"

import { m } from "#/paraglide/messages"
import { Route } from "#/routes/atelier"

// Keep the actual shared components and route. Any attempted API access fails.
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it("opens outside app authentication and reveals synthetic details without requesting data", async () => {
  const fetch = vi.fn(() => Promise.reject(new Error("Unexpected network request")))
  const taxmaxi = vi.fn(() => {
    throw new Error("Unexpected API access")
  })
  vi.stubGlobal("fetch", fetch)
  const context = { queryClient: new QueryClient(), taxmaxi }
  const root = createRootRouteWithContext<ReturnType<typeof Route.useRouteContext>>()()
  const route = createRoute({ ...Route.options, path: "/atelier", getParentRoute: () => root })
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/atelier"] }),
    context,
  })
  render(<RouterProvider router={router} />)

  const toggle = await screen.findByRole("button", { name: m["atelier.show_details"]() })
  expect(screen.getByRole("heading", { name: m["atelier.title"]() })).toBeDefined()
  expect(toggle.dataset.slot).toBe("button")
  expect(toggle.getAttribute("aria-expanded")).toBe("false")
  fireEvent.click(toggle)
  expect(toggle.getAttribute("aria-expanded")).toBe("true")
  expect(screen.getByText(m["atelier.example_details"]()).closest("[hidden]")).toBeNull()

  const experiments = screen.getByRole("tab", { name: m["atelier.experiments"]() })
  fireEvent.mouseDown(experiments, { button: 0, ctrlKey: false })
  await waitFor(() => expect(experiments.getAttribute("aria-selected")).toBe("true"))
  expect(screen.queryByRole("button", { name: m["atelier.hide_details"]() })).toBeNull()
  expect(screen.getByText(m["atelier.experiments_empty"]())).toBeDefined()
  expect(fetch).not.toHaveBeenCalled()
  expect(taxmaxi).not.toHaveBeenCalled()
})
