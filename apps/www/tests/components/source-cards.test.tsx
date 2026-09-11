// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { SourceCards } from "#/components/source-cards"
import type { Source } from "#/components/source-card"

const sources: Source[] = ["A", "B"].map((name) => ({
  id: name,
  name,
  kind: "wallet",
  network: "Solana",
  importedTransactions: 25,
  unresolvedItems: 0,
  lastSync: "Today",
}))

beforeEach(() => {
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
    act(() => b.focus())
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
    expect(select).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Sync A" }))
    expect(sync).toHaveBeenCalledExactlyOnceWith(sources[0])
    act(() => a.focus())
    await waitFor(() => expect(a.style.transform).not.toBe(before))
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
