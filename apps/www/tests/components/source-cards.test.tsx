// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { SourceCards } from "#/components/source-cards"
import type { Source } from "#/components/source-card"

const motionPreference = vi.hoisted(() => ({ reduced: true }))

vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => motionPreference.reduced,
}))

const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollIntoView"
)

const sources: Source[] = ["A", "B"].map((name) => ({
  id: name,
  name,
  kind: "wallet",
  network: "Solana",
  importedTransactions: 25,
  unresolvedItems: 0,
  lastSync: "Today",
}))

// jsdom does not track input modality. Browser proof checks the real keyboard-to-pointer transition.
function keyboardFocus(card: HTMLElement) {
  const matches = card.matches.bind(card)
  vi.spyOn(card, "matches").mockImplementation(
    (selector) => selector === ":focus-visible" || matches(selector)
  )
  act(() => card.focus())
}

beforeEach(() => {
  motionPreference.reduced = true
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  })
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  )
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  )
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 900, 344)
  )
})

afterEach(() => {
  cleanup()
  if (originalScrollIntoView)
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView)
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView")
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("SourceCards shared selection", () => {
  it("highlights the selected set while focus and Escape leave it unchanged", () => {
    const select = vi.fn()
    const view = render(
      <SourceCards sources={sources} selectedSourceIds={["A", "B"]} onSourceSelect={select} />
    )
    const a = screen.getByRole("button", { name: "Show A" })
    const b = screen.getByRole("button", { name: "Show B" })
    expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(2)
    keyboardFocus(b)
    expect(select).not.toHaveBeenCalled()
    fireEvent.keyDown(b, { key: "Escape" })
    expect(select).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(b)
    expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(2)
    fireEvent.click(a)
    expect(select).toHaveBeenLastCalledWith("A")
    view.rerender(
      <SourceCards sources={sources} selectedSourceIds={["A"]} onSourceSelect={select} />
    )
    fireEvent.click(a)
    expect(select).toHaveBeenLastCalledWith("A")
    expect(a.getAttribute("aria-pressed")).toBe("true")
    expect(b.getAttribute("aria-pressed")).toBe("false")
    view.rerender(
      <SourceCards sources={sources} selectedSourceIds={["A", "B"]} onSourceSelect={select} />
    )
    expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(2)
  })

  it("does not move a card when its nested sync button receives focus", async () => {
    motionPreference.reduced = false
    const select = vi.fn()
    const sync = vi.fn()
    render(
      <SourceCards
        sources={sources}
        selectedSourceIds={["A", "B"]}
        onSourceSelect={select}
        onSourceSync={sync}
      />
    )
    const a = screen.getByRole("button", { name: "Show A" })
    const before = a.style.transform
    act(() => screen.getByRole("button", { name: "Sync A" }).focus())
    // Let Motion apply the focus-triggered target; a bubbled focus must not lift the card.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })
    expect(a.style.transform).toBe(before)
    expect(a.scrollIntoView).not.toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Sync A" }))
    expect(sync).toHaveBeenCalledExactlyOnceWith(sources[0])
    keyboardFocus(a)
    await waitFor(() => expect(a.style.transform).not.toBe(before))
  })

  it("does not scroll a reduced-motion sync target on pointer focus", () => {
    const select = vi.fn()
    const sync = vi.fn()
    render(<SourceCards sources={sources} onSourceSelect={select} onSourceSync={sync} />)
    const button = screen.getByRole("button", { name: "Sync A" })
    vi.spyOn(button, "matches").mockReturnValue(false)
    act(() => button.focus())
    expect(button.scrollIntoView).not.toHaveBeenCalled()
    fireEvent.click(button)
    expect(sync).toHaveBeenCalledExactlyOnceWith(sources[0])
    expect(select).not.toHaveBeenCalled()
  })

  it("keeps reduced-motion placements fixed through focus and source selection", async () => {
    const select = vi.fn()
    const view = render(
      <SourceCards sources={sources} selectedSourceIds={["A", "B"]} onSourceSelect={select} />
    )
    const cards = [
      screen.getByRole("button", { name: "Show A" }),
      screen.getByRole("button", { name: "Show B" }),
    ]
    const placements = cards.map((card) => card.style.transform)
    const first = cards[0]
    keyboardFocus(first)
    expect(first.scrollIntoView).toHaveBeenLastCalledWith({
      block: "nearest",
      inline: "nearest",
      behavior: "instant",
    })
    fireEvent.keyDown(first, { key: "Enter" })
    view.rerender(
      <SourceCards sources={sources} selectedSourceIds={["A"]} onSourceSelect={select} />
    )
    fireEvent.keyDown(first, { key: "Escape" })
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })
    expect(cards.map((card) => card.style.transform)).toEqual(placements)
    expect(first.getAttribute("aria-pressed")).toBe("true")
    expect(cards[1].getAttribute("aria-pressed")).toBe("false")
  })

  it.each(["Enter", " "])("selects a singleton with %s and keeps nested sync separate", (key) => {
    const select = vi.fn()
    const sync = vi.fn()
    render(
      <SourceCards
        sources={sources}
        selectedSourceIds={["A", "B"]}
        onSourceSelect={select}
        onSourceSync={sync}
      />
    )
    const b = screen.getByRole("button", { name: "Show B" })
    fireEvent.keyDown(b, { key })
    expect(select).toHaveBeenCalledExactlyOnceWith("B")
    const syncA = screen.getByRole("button", { name: "Sync A" })
    act(() => syncA.focus())
    fireEvent.keyDown(syncA, { key })
    fireEvent.click(syncA)
    expect(select).toHaveBeenCalledTimes(1)
    expect(sync).toHaveBeenCalledExactlyOnceWith(sources[0])
    expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(2)
  })
})
