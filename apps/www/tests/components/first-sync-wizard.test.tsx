// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { FirstSyncWizard } from "#/components/first-sync-wizard"
import type { FirstSyncBilling, FirstSyncState } from "#/lib/first-sync-state"
import { setLocale } from "#/paraglide/runtime"

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
  islandItemShown = false,
  sourceName = "Coinbase",
  state,
  welcomePending = false,
  welcomeVideoId = null,
}: {
  readonly billing?: FirstSyncBilling
  readonly billingRefreshing?: boolean
  readonly createWalletSource?: (walletAddress: string) => Promise<void>
  readonly islandItemShown?: boolean
  readonly sourceName?: string | null
  readonly state: FirstSyncState
  readonly welcomePending?: boolean
  readonly welcomeVideoId?: string | null
}) => {
  const onRetryBilling = vi.fn()
  const onStart = vi.fn()
  const onWelcomeFinish = vi.fn()
  const props = {
    billing: billingStatus,
    billingRefreshing,
    createWalletSource,
    islandItemShown,
    onRetryBilling,
    onStart,
    onWelcomeFinish,
    sourceName,
    state,
    welcomePending,
    welcomeVideoId,
  }
  const view = render(<FirstSyncWizard {...props} />)
  return {
    container: view.container,
    onRetryBilling,
    onStart,
    onWelcomeFinish,
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

  it("formats the credit count in the selected locale", async () => {
    const originalUrl = window.location.href
    window.history.replaceState(null, "", "/app")
    await setLocale("de", { reload: false })
    try {
      renderWizard({ billing: billing(10_000, "active"), state: "ready" })

      expect(screen.getByText("10.000 Credits verfügbar")).toBeTruthy()
    } finally {
      cleanup()
      await setLocale("en", { reload: false })
      window.history.replaceState(null, "", originalUrl)
    }
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

  it("paused with the island's item shown explains safely, points at the island, and offers no Start", () => {
    renderWizard({ billing: billing(0, "active"), islandItemShown: true, state: "paused" })

    expect(screen.getByRole("heading", { name: "Sync paused — more credits needed" })).toBeTruthy()
    expect(screen.getByText("Add credits from the notice at the top of the page.")).toBeTruthy()
    expect(buttons()).toEqual([])
    expect(screen.queryAllByRole("link")).toEqual([])
  })

  it("paused after the island's item is dismissed offers Choose a plan itself and no Start", () => {
    const { onStart } = renderWizard({
      billing: billing(0),
      islandItemShown: false,
      state: "paused",
    })

    expect(screen.getByRole("heading", { name: "Sync paused — more credits needed" })).toBeTruthy()
    expect(screen.queryByText("Add credits from the notice at the top of the page.")).toBeNull()
    expect(screen.getByRole("link", { name: "Choose a plan" }).getAttribute("href")).toBe(
      "/app/billing"
    )
    expect(buttons()).toEqual([])
    expect(onStart).not.toHaveBeenCalled()
  })

  it.each(["active", "trialing"])(
    "paused without an island item and a %s subscription offers Buy credits",
    (subscriptionStatus) => {
      renderWizard({
        billing: billing(0, subscriptionStatus),
        islandItemShown: false,
        state: "paused",
      })

      expect(screen.getByRole("link", { name: "Buy credits" }).getAttribute("href")).toBe(
        "/app/billing"
      )
      expect(screen.queryByRole("link", { name: "Choose a plan" })).toBeNull()
    }
  )

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

describe("FirstSyncWizard welcome step (#108 T07)", () => {
  const VIDEO_ID = "dQw4w9WgXcQ"

  const currentStep = () =>
    screen.getByRole("list", { name: "Setup steps" }).querySelector("[aria-current='step']")
      ?.textContent

  const next = () => fireEvent.click(screen.getByRole("button", { name: "Next" }))

  it("shows the letter ahead of the state step while the welcome is pending, and never otherwise", () => {
    const { onStart, onWelcomeFinish, rerender } = renderWizard({
      state: "ready",
      welcomePending: true,
    })

    expect(screen.getByRole("heading", { name: "Hi, I'm Max." })).toBeTruthy()
    expect(screen.queryByRole("heading", { name: "Ready when you are" })).toBeNull()
    expect(screen.queryByText("Coinbase connected")).toBeNull()
    expect(currentStep()).toBe("Step 1 of 5: Welcome")
    expect(onWelcomeFinish).not.toHaveBeenCalled()
    expect(onStart).not.toHaveBeenCalled()

    rerender({ welcomePending: false })

    expect(screen.queryByRole("heading", { name: "Hi, I'm Max." })).toBeNull()
    expect(screen.getByRole("heading", { name: "Ready when you are" })).toBeTruthy()
    expect(currentStep()).toBe("Step 4 of 5: First sync")
  })

  it("shows the letter over done, and nothing once the welcome is over", () => {
    const { container, rerender } = renderWizard({ state: "done", welcomePending: true })

    expect(screen.getByRole("heading", { name: "Hi, I'm Max." })).toBeTruthy()
    expect(currentStep()).toBe("Step 1 of 5: Welcome")

    rerender({ welcomePending: false })

    expect(container.innerHTML).toBe("")
  })

  it("walks three screens with Next, announcing each and moving focus to its heading, and Continue finishes once", () => {
    const { onWelcomeFinish } = renderWizard({
      billing: billing(0),
      state: "needs_credits",
      welcomePending: true,
    })
    const live = screen.getByRole("status", { name: "First sync updates" })

    expect(live.textContent).toBe("Hi, I'm Max.")
    expect(document.activeElement).toBe(document.body)
    expect(screen.getByText("1 of 3")).toBeTruthy()
    expect(buttons()).toEqual(["Skip", "Next"])

    next()

    expect(live.textContent).toBe("What TaxMaxi stands on")
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "What TaxMaxi stands on" })
    )
    expect(screen.getByText("2 of 3")).toBeTruthy()
    expect(screen.getByText("Users first.")).toBeTruthy()
    expect(screen.getByText("Open.")).toBeTruthy()
    expect(screen.getByText("Modular and extendible.")).toBeTruthy()

    next()

    expect(live.textContent).toBe("Thanks for being here")
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Thanks for being here" })
    )
    expect(screen.getByText("3 of 3")).toBeTruthy()
    expect(screen.getByText("— Max")).toBeTruthy()
    expect(buttons()).toEqual(["Continue"])
    expect(onWelcomeFinish).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Continue" }))

    expect(onWelcomeFinish).toHaveBeenCalledTimes(1)
  })

  it("Skip finishes once from any screen", () => {
    const { onWelcomeFinish } = renderWizard({ state: "ready", welcomePending: true })

    next()
    fireEvent.click(screen.getByRole("button", { name: "Skip" }))

    expect(onWelcomeFinish).toHaveBeenCalledTimes(1)
  })

  it("Escape skips the welcome once, from the page or from inside the wizard, and never once it is over", () => {
    const { onWelcomeFinish, rerender } = renderWizard({ state: "ready", welcomePending: true })

    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(onWelcomeFinish).toHaveBeenCalledTimes(1)

    const nextButton = screen.getByRole("button", { name: "Next" })
    nextButton.focus()
    fireEvent.keyDown(nextButton, { key: "Escape" })
    expect(onWelcomeFinish).toHaveBeenCalledTimes(2)

    rerender({ welcomePending: false })
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(onWelcomeFinish).toHaveBeenCalledTimes(2)
  })

  it("Escape skips from a header control outside the wizard, but not once an open surface handled it", () => {
    const { onWelcomeFinish } = renderWizard({ state: "ready", welcomePending: true })
    const headerButton = document.body.appendChild(document.createElement("button"))
    headerButton.focus()

    fireEvent.keyDown(headerButton, { key: "Escape" })
    expect(onWelcomeFinish).toHaveBeenCalledTimes(1)

    // An open overlay or menu (Radix) takes Escape in the capture phase and
    // prevents its default before the key reaches the wizard's listener.
    const handled = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" })
    handled.preventDefault()
    headerButton.dispatchEvent(handled)
    expect(onWelcomeFinish).toHaveBeenCalledTimes(1)

    headerButton.remove()
  })

  it("adds the video screen before the sign-off when the video id is set", () => {
    renderWizard({ state: "ready", welcomePending: true, welcomeVideoId: VIDEO_ID })

    expect(screen.getByText("1 of 4")).toBeTruthy()
    next()
    next()
    expect(screen.getByRole("heading", { name: "A short look around" })).toBeTruthy()
    const video = screen.getByTitle("TaxMaxi introduction video")
    expect(video.tagName).toBe("IFRAME")
    expect(video.getAttribute("src")).toBe(`https://www.youtube-nocookie.com/embed/${VIDEO_ID}`)
    next()
    expect(screen.getByRole("heading", { name: "Thanks for being here" })).toBeTruthy()
    expect(buttons()).toEqual(["Continue"])
  })

  it("leaves the video screen out while the video id is unset", () => {
    renderWizard({ state: "ready", welcomePending: true })

    expect(screen.getByText("1 of 3")).toBeTruthy()
    next()
    next()
    expect(screen.getByRole("heading", { name: "Thanks for being here" })).toBeTruthy()
    expect(screen.queryByTitle("TaxMaxi introduction video")).toBeNull()
    expect(document.querySelector("iframe")).toBeNull()
  })

  it("animates welcome screens only when motion is allowed", () => {
    renderWizard({ state: "ready", welcomePending: true })
    const region = screen.getByRole("region", { name: "Hi, I'm Max." })
    const card = region.querySelector("[data-initial]")

    expect(region.getAttribute("data-motion")).toBe("full")
    expect(card?.getAttribute("data-initial")).toBe("animated")
    expect(card?.getAttribute("data-transition-duration")).toBe("0.25")
  })

  it("honors reduced motion on welcome screens", () => {
    motionState.reduceMotion = true
    renderWizard({ state: "ready", welcomePending: true })
    const region = screen.getByRole("region", { name: "Hi, I'm Max." })
    const card = region.querySelector("[data-initial]")

    expect(region.getAttribute("data-motion")).toBe("reduced")
    expect(card?.getAttribute("data-initial")).toBe("none")
    expect(card?.getAttribute("data-transition-duration")).toBe("0")
  })
})
