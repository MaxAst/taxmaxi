// @vitest-environment jsdom

import type { AgentationProps } from "agentation"
import { QueryClient } from "@tanstack/react-query"
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { m } from "#/paraglide/messages"
import { Route } from "#/routes/atelier"

const feedback = vi.hoisted<{ onCopy?: (markdown: string) => void }>(() => ({}))

// Browser proof covers selecting and copying real Agentation annotations.
vi.mock("agentation", () => ({
  Agentation: ({ onCopy }: AgentationProps) => {
    feedback.onCopy = onCopy
    return null
  },
}))

const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView")

beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() })
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
  )
})

// Keep the actual shared components and route. Any attempted API access fails.
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  if (originalScrollIntoView)
    Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView)
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView")
})

function renderAtelier() {
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
  const result = render(<RouterProvider router={router} />)
  return { ...result, fetch, taxmaxi }
}

it("opens outside app authentication and reveals synthetic details without requesting data", async () => {
  const { fetch, taxmaxi } = renderAtelier()

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
  expect(screen.getByText(m["atelier.tuning_guidance"]())).toBeDefined()
  expect(fetch).not.toHaveBeenCalled()
  expect(taxmaxi).not.toHaveBeenCalled()
})

it("tunes and resets only the experiment through real DialKit controls", async () => {
  renderAtelier()
  const approved = await screen.findByRole("tab", { name: m["atelier.approved"]() })
  const approvedSurface = screen
    .getByRole("heading", { name: m["atelier.example_title"]() })
    .closest('[data-slot="card"]')
  const initialStyle = approvedSurface?.getAttribute("style")
  fireEvent.mouseDown(screen.getByRole("tab", { name: m["atelier.experiments"]() }), {
    button: 0,
    ctrlKey: false,
  })
  const sample = await screen.findByRole("region", { name: m["atelier.tuning_example"]() })
  const slider = await screen.findByRole("slider", { name: m["atelier.corner_radius"]() })
  expect(sample.style.borderRadius).toBe("24px")
  fireEvent.keyDown(slider, { key: "ArrowRight" })
  await waitFor(() => expect(sample.style.borderRadius).toBe("25px"))
  fireEvent.click(screen.getByRole("button", { name: m["atelier.reset_tuning"]() }))
  await waitFor(() => expect(sample.style.borderRadius).toBe("24px"))
  fireEvent.mouseDown(approved, { button: 0, ctrlKey: false })
  expect(
    screen
      .getByRole("heading", { name: m["atelier.example_title"]() })
      .closest('[data-slot="card"]')
      ?.getAttribute("style")
  ).toBe(initialStyle)
})

it("keeps generated feedback available when clipboard access fails", async () => {
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard")
  const writeText = vi.fn().mockRejectedValue(new Error("Clipboard denied"))
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
  try {
    renderAtelier()
    await screen.findByRole("heading", { name: m["atelier.title"]() })
    const markdown = "## Feedback\n**Location:** #atelier-tuning-example\nMake the spacing clearer."
    act(() => feedback.onCopy?.(markdown))
    expect(
      screen.getByRole("textbox", { name: m["atelier.feedback_output"]() }).getAttribute("readonly")
    ).not.toBeNull()
    fireEvent.click(screen.getByRole("button", { name: m["atelier.copy_feedback"]() }))
    await screen.findByText(m["atelier.feedback_copy_failed"]())
    expect(writeText).toHaveBeenCalledWith(markdown)
    writeText.mockResolvedValue(undefined)
    fireEvent.click(screen.getByRole("button", { name: m["atelier.copy_feedback"]() }))
    await screen.findByText(m["atelier.feedback_copied"]())
  } finally {
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard)
    else Reflect.deleteProperty(navigator, "clipboard")
  }
})

it("applies the theme to portalled controls and restores the previous document theme on exit", async () => {
  document.documentElement.className = "light"
  document.documentElement.setAttribute("data-theme", "auto")
  document.documentElement.style.colorScheme = "light"
  const { unmount } = renderAtelier()
  const trigger = await screen.findByRole("combobox", { name: m["atelier.theme"]() })
  fireEvent.keyDown(trigger, { key: "Enter" })
  const dark = await screen.findByRole("option", { name: m["atelier.dark"]() })
  fireEvent.keyDown(dark, { key: "Enter" })
  await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(true))
  fireEvent.keyDown(trigger, { key: "Enter" })
  const light = await screen.findByRole("option", { name: m["atelier.light"]() })
  expect(light.closest("html")?.classList.contains("dark")).toBe(true)
  unmount()
  expect(document.documentElement.classList.contains("light")).toBe(true)
  expect(document.documentElement.getAttribute("data-theme")).toBe("auto")
  expect(document.documentElement.style.colorScheme).toBe("light")
})
