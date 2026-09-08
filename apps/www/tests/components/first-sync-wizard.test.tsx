// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { FirstSyncWizard, type FirstSyncWizardState } from "#/components/first-sync-wizard"
import type { FirstSyncBilling } from "#/lib/first-sync-state"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { readonly children: ReactNode; readonly to: string }) => (
    <a href={to}>{children}</a>
  ),
}))

const motionState = vi.hoisted(() => ({ reduceMotion: false }))

// Motion caches the reduced-motion media query for the whole process, so the
// preference is controlled here and the props the wizard hands to motion are
// surfaced as data attributes for assertions.
vi.mock("motion/react", () => {
  const motionDiv = ({
    animate: _animate,
    initial,
    transition,
    ...rest
  }: {
    readonly animate?: unknown
    readonly initial?: false | Record<string, unknown>
    readonly transition?: { readonly duration?: number }
  } & Record<string, unknown>) =>
    createElement("div", {
      ...rest,
      "data-initial": initial === false ? "none" : "animated",
      "data-transition-duration": transition?.duration,
    })

  return {
    motion: { div: motionDiv },
    useReducedMotion: () => motionState.reduceMotion,
  }
})

beforeEach(() => {
  motionState.reduceMotion = false
})

afterEach(cleanup)

const EVM_ADDRESS = "0x24a9db9c9c6bcbba1a1ea88d9769cd48eb0efb1a"

const billing = (credits: number, subscriptionStatus: string | null = null): FirstSyncBilling => ({
  credits,
  subscriptionStatus,
})

const renderWizard = ({
  billing: billingStatus = billing(1),
  billingRefreshing = false,
  createWalletSource,
  sourceName = "Coinbase",
  state,
}: {
  readonly billing?: FirstSyncBilling
  readonly billingRefreshing?: boolean
  readonly createWalletSource?: (walletAddress: string) => Promise<void>
  readonly sourceName?: string | null
  readonly state: FirstSyncWizardState
}) => {
  const onRetryBilling = vi.fn()
  const onStart = vi.fn()
  const props = {
    billing: billingStatus,
    billingRefreshing,
    createWalletSource,
    onRetryBilling,
    onStart,
    sourceName,
    state,
  }
  const view = render(<FirstSyncWizard {...props} />)
  return {
    onRetryBilling,
    onStart,
    rerender: (next: Partial<typeof props>) =>
      view.rerender(<FirstSyncWizard {...props} {...next} />),
  }
}

const buttons = () => screen.queryAllByRole("button").map((button) => button.textContent)

describe("FirstSyncWizard copy and actions per state", () => {
  it("needs_source hosts the wallet-address form and only creates the source", async () => {
    const createWalletSource = vi.fn().mockResolvedValue(undefined)
    const { onStart } = renderWizard({
      createWalletSource,
      sourceName: null,
      state: "needs_source",
    })

    expect(screen.getByRole("heading", { name: "Connect your first source" })).toBeTruthy()
    expect(screen.queryByText(/connected$/)).toBeNull()
    fireEvent.change(screen.getByRole("textbox", { name: "Crypto wallet address" }), {
      target: { value: EVM_ADDRESS },
    })
    fireEvent.submit(screen.getByRole("button", { name: "Add wallet" }))
    await act(async () => {
      await Promise.resolve()
    })

    expect(createWalletSource).toHaveBeenCalledExactlyOnceWith(EVM_ADDRESS)
    expect(onStart).not.toHaveBeenCalled()
  })

  it("needs_credits without a plan offers Choose a plan and no Start", () => {
    const { onStart } = renderWizard({ billing: billing(0), state: "needs_credits" })

    expect(screen.getByRole("heading", { name: "Pick a plan to unlock your import" })).toBeTruthy()
    expect(screen.getByText("Coinbase connected")).toBeTruthy()
    const link = screen.getByRole("link", { name: "Choose a plan" })
    expect(link.getAttribute("href")).toBe("/app/billing")
    expect(buttons()).toEqual([])
    expect(onStart).not.toHaveBeenCalled()
  })

  it.each(["active", "trialing"])(
    "needs_credits with a %s subscription offers Buy credits",
    (subscriptionStatus) => {
      renderWizard({ billing: billing(0, subscriptionStatus), state: "needs_credits" })

      expect(
        screen.getByRole("heading", { name: "Top up credits to unlock your import" })
      ).toBeTruthy()
      expect(screen.getByRole("link", { name: "Buy credits" }).getAttribute("href")).toBe(
        "/app/billing"
      )
      expect(screen.queryByRole("link", { name: "Choose a plan" })).toBeNull()
    }
  )

  it("billing_unknown offers a billing retry and no Start", () => {
    const { onRetryBilling, onStart, rerender } = renderWizard({
      billing: null,
      state: "billing_unknown",
    })

    expect(screen.getByRole("heading", { name: "We couldn't check your plan" })).toBeTruthy()
    expect(buttons()).toEqual(["Retry"])
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(onRetryBilling).toHaveBeenCalledTimes(1)
    expect(onStart).not.toHaveBeenCalled()

    rerender({ billingRefreshing: true })
    expect(screen.getByRole("button", { name: "Checking…" }).hasAttribute("disabled")).toBe(true)
  })

  it("ready shows the credit count and starts once on an explicit click", () => {
    const { onStart } = renderWizard({ billing: billing(1), state: "ready" })

    expect(screen.getByRole("heading", { name: "Ready when you are" })).toBeTruthy()
    expect(screen.getByText("1 credit available")).toBeTruthy()
    expect(onStart).not.toHaveBeenCalled()
    expect(buttons()).toEqual(["Start my first sync"])

    fireEvent.click(screen.getByRole("button", { name: "Start my first sync" }))
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it("ready pluralizes the credit count", () => {
    renderWizard({ billing: billing(500, "active"), state: "ready" })

    expect(screen.getByText("500 credits available")).toBeTruthy()
  })

  it("syncing says the sync is underway and offers no action", () => {
    renderWizard({ state: "syncing" })

    expect(screen.getByRole("heading", { name: "Importing your Coinbase history" })).toBeTruthy()
    expect(
      screen.getByText("Progress shows at the top of the page. You can leave and come back.")
    ).toBeTruthy()
    expect(buttons()).toEqual([])
    expect(screen.queryAllByRole("link")).toEqual([])
  })

  it("paused explains safely, points at the island, and offers no Start", () => {
    renderWizard({ billing: billing(0, "active"), state: "paused" })

    expect(screen.getByRole("heading", { name: "Sync paused — more credits needed" })).toBeTruthy()
    expect(screen.getByText("Add credits from the notice at the top of the page.")).toBeTruthy()
    expect(buttons()).toEqual([])
    expect(screen.queryAllByRole("link")).toEqual([])
  })

  it("resumable offers Continue, which starts once", () => {
    const { onStart } = renderWizard({ billing: billing(40, "active"), state: "resumable" })

    expect(screen.getByRole("heading", { name: "Ready to continue" })).toBeTruthy()
    expect(screen.getByText("40 credits available")).toBeTruthy()
    expect(buttons()).toEqual(["Continue my first sync"])

    fireEvent.click(screen.getByRole("button", { name: "Continue my first sync" }))
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it("failed shows one generic message and Try again, which starts once", () => {
    const { onStart } = renderWizard({ state: "failed" })

    expect(screen.getByRole("heading", { name: "Your first sync didn't finish" })).toBeTruthy()
    expect(
      screen.getByText(
        "Something went wrong on our side while importing. Nothing was lost, and you can try again now."
      )
    ).toBeTruthy()
    expect(buttons()).toEqual(["Try again"])

    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(onStart).toHaveBeenCalledTimes(1)
  })
})

describe("FirstSyncWizard steps and accessibility", () => {
  it.each([
    ["needs_source", "Step 2 of 5: Connect a source"],
    ["needs_credits", "Step 3 of 5: Plan and credits"],
    ["billing_unknown", "Step 3 of 5: Plan and credits"],
    ["ready", "Step 4 of 5: First sync"],
    ["syncing", "Step 4 of 5: First sync"],
    ["failed", "Step 4 of 5: First sync"],
  ] as const)("%s marks the current step in the stage dots", (state, label) => {
    renderWizard({ state })

    const current = screen
      .getByRole("list", { name: "Setup steps" })
      .querySelector("[aria-current='step']")
    expect(current?.textContent).toBe(label)
  })

  it("announces state changes in a polite live region and moves focus to the new headline", () => {
    const { rerender } = renderWizard({ state: "ready" })
    const live = screen.getByRole("status", { name: "First sync updates" })

    expect(live.textContent).toBe("Ready when you are")
    expect(document.activeElement).toBe(document.body)

    rerender({ state: "syncing" })

    expect(live.textContent).toBe("Importing your Coinbase history")
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Importing your Coinbase history" })
    )
  })

  it("moves focus to the headline when the step changes", () => {
    const { rerender } = renderWizard({ billing: billing(0), state: "needs_credits" })
    expect(document.activeElement).toBe(document.body)

    rerender({ billing: billing(1), state: "ready" })

    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Ready when you are" }))
    expect(
      screen.getByRole("list", { name: "Setup steps" }).querySelector("[aria-current='step']")
        ?.textContent
    ).toBe("Step 4 of 5: First sync")
  })

  it("keeps the wizard keyboard operable through native buttons", () => {
    const { onStart } = renderWizard({ state: "ready" })
    const start = screen.getByRole("button", { name: "Start my first sync" })

    start.focus()
    expect(document.activeElement).toBe(start)
    fireEvent.click(start)
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it("animates step entry only when motion is allowed", () => {
    renderWizard({ state: "ready" })
    const region = screen.getByRole("region", { name: "Ready when you are" })
    const card = region.querySelector("[data-initial]")

    expect(region.getAttribute("data-motion")).toBe("full")
    expect(card?.getAttribute("data-initial")).toBe("animated")
    expect(card?.getAttribute("data-transition-duration")).toBe("0.25")
  })

  it("honors reduced motion by skipping the step transition", () => {
    motionState.reduceMotion = true
    renderWizard({ state: "ready" })
    const region = screen.getByRole("region", { name: "Ready when you are" })
    const card = region.querySelector("[data-initial]")

    expect(region.getAttribute("data-motion")).toBe("reduced")
    expect(card?.getAttribute("data-initial")).toBe("none")
    expect(card?.getAttribute("data-transition-duration")).toBe("0")
  })
})
