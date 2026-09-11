// @vitest-environment jsdom
import { useState } from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TransactionFilterControls } from "#/components/transaction-filters"
import type { TransactionFilters } from "#/lib/transaction-filters"

const A = "00000000-0000-4000-8000-000000000001"
const X = "00000000-0000-4000-8000-000000000011"
const Y = "00000000-0000-4000-8000-000000000012"
const assets = [X, Y].map((assetId) => ({
  assetId,
  symbol: "SAME",
  name: "Same token",
  type: "fungible" as const,
  coingeckoCoinId: null,
  logoUrl: null,
}))
const source = {
  id: A,
  name: "Wallet A",
  kind: "wallet" as const,
  network: "Solana",
  importedTransactions: 1,
  unresolvedItems: 0,
  lastSync: "Today",
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  HTMLElement.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function mount(initial: TransactionFilters = {}, failed = false) {
  const onChange = vi.fn()
  function Controlled() {
    const [filters, setFilters] = useState(initial)
    return (
      <TransactionFilterControls
        filters={filters}
        sources={[source]}
        assets={assets}
        failed={failed}
        onRetry={vi.fn()}
        onChange={(next) => {
          onChange(next)
          setFilters(next)
        }}
      />
    )
  }
  render(<Controlled />)
  return onChange
}

async function open(label: string) {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^Filter ${label}`) }))
  return screen.findByRole("combobox")
}

async function close(input: HTMLElement) {
  fireEvent.keyDown(input, { key: "Escape" })
  await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull())
}

describe("structured filter controls", () => {
  it("applies source, distinct equal-symbol assets and category once, removes only Y", async () => {
    const change = mount({
      attention: true,
      order: "oldest",
      from: "2026-03-29",
      timezone: "Europe/Berlin",
    })
    let input = await open("Sources")
    fireEvent.click(screen.getByRole("option", { name: /Wallet A/ }))
    await close(input)
    input = await open("Assets")
    fireEvent.change(input, { target: { value: "Same token" } })
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2))
    fireEvent.click(screen.getByRole("option", { name: new RegExp(X) }))
    fireEvent.click(screen.getByRole("option", { name: new RegExp(Y) }))
    await close(input)
    fireEvent.click(screen.getByRole("button", { name: "Staking" }))
    expect(change).toHaveBeenCalledTimes(4)
    expect(change).toHaveBeenLastCalledWith({
      sourceIds: [A],
      assetIds: [X, Y],
      categories: ["staking"],
      attention: true,
      order: "oldest",
      from: "2026-03-29",
      timezone: "Europe/Berlin",
    })
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`Remove.*${Y}`) }))
    expect(change).toHaveBeenLastCalledWith({
      sourceIds: [A],
      assetIds: [X],
      categories: ["staking"],
      attention: true,
      order: "oldest",
      from: "2026-03-29",
      timezone: "Europe/Berlin",
    })
    fireEvent.click(screen.getByRole("button", { name: "Clear all filters" }))
    expect(change).toHaveBeenLastCalledWith({})
  })

  it("searches by name, Arrow/Enter selects once and Escape returns focus", async () => {
    const change = mount()
    const input = await open("Categories")
    fireEvent.change(input, { target: { value: "Purchase" } })
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1))
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(change).toHaveBeenCalledExactlyOnceWith({ categories: ["purchase"] })
    await close(input)
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: /^Filter Categories/ })
      )
    )
  })

  it("retry keyboard events do not select cmdk options or change filters", async () => {
    const change = vi.fn()
    const retry = vi.fn()
    render(
      <TransactionFilterControls
        filters={{ sourceIds: [A], assetIds: [Y], categories: ["staking"] }}
        sources={[source]}
        assets={assets}
        failed
        onRetry={retry}
        onChange={change}
      />
    )
    const input = await open("Assets")
    fireEvent.keyDown(input, { key: "ArrowDown" })
    const button = screen.getByRole("button", { name: "Try again" })
    button.focus()
    for (const key of ["Enter", " "]) {
      fireEvent.keyDown(button, { key })
      fireEvent.keyUp(button, { key })
      fireEvent.click(button, { detail: 0 })
    }
    expect(retry).toHaveBeenCalledTimes(2)
    expect(change).not.toHaveBeenCalled()
    await close(button)
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Filter Assets" }))
    )
  })

  it("retains readable selected assets on failure and keeps manual categories usable", async () => {
    const change = mount({ assetIds: [X] }, true)
    const input = await open("Assets")
    expect(
      screen.getByRole("button", { name: new RegExp(`Remove.*Same token.*${X}`) })
    ).toBeTruthy()
    expect(screen.getByText(/Assets could not be loaded/)).toBeTruthy()
    await close(input)
    fireEvent.click(screen.getByRole("button", { name: "Staking" }))
    expect(change).toHaveBeenLastCalledWith({ assetIds: [X], categories: ["staking"] })
  })

  it("keeps keyboard focus on surviving controls after chip removal, suggestions and reset", () => {
    mount({ assetIds: [X] })
    const chip = screen.getByRole("button", { name: new RegExp(`Remove.*${X}`) })
    chip.focus()
    fireEvent.click(chip, { detail: 0 })
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Filter Assets" }))
    const suggestion = screen.getByRole("button", { name: "Staking" })
    suggestion.focus()
    fireEvent.click(suggestion, { detail: 0 })
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Filter Categories" }))
    const reset = screen.getByRole("button", { name: "Clear all filters" })
    reset.focus()
    fireEvent.click(reset, { detail: 0 })
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Filter Sources" }))
  })

  it("shows removable identity fallback on a saved URL without loaded options", () => {
    const change = vi.fn()
    render(
      <TransactionFilterControls
        filters={{ assetIds: [X] }}
        sources={[]}
        failed
        onRetry={vi.fn()}
        onChange={change}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: `Remove Assets · ${X}` }))
    expect(change).toHaveBeenCalledWith({ assetIds: [] })
  })
})
