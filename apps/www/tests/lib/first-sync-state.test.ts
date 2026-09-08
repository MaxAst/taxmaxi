import { describe, expect, it } from "vitest"

import {
  getFirstSyncState,
  hasActiveSubscription,
  type FirstSyncBilling,
  type FirstSyncItem,
  type FirstSyncSourceOverview,
} from "#/lib/first-sync-state"

const SOURCE_A = "00000000-0000-4000-8000-000000000201"
const SOURCE_B = "00000000-0000-4000-8000-000000000202"

const overview = (
  sourceId: string,
  latestSync: Partial<FirstSyncSourceOverview["latestSync"]> = {}
): FirstSyncSourceOverview => ({
  source: { id: sourceId },
  latestSync: { jobId: null, lastSyncedAt: null, status: null, ...latestSync },
})

const billing = (credits: number, subscriptionStatus: string | null = null): FirstSyncBilling => ({
  credits,
  subscriptionStatus,
})

const item = (status: FirstSyncItem["status"], id = SOURCE_A): FirstSyncItem => ({ id, status })

describe("getFirstSyncState (#108 D03, one case per row)", () => {
  it("no source → needs_source", () => {
    expect(getFirstSyncState({ billing: billing(5), items: [], overviews: [] })).toEqual({
      state: "needs_source",
      targetSourceId: null,
    })
  })

  it("no active item, credits 0 → needs_credits", () => {
    expect(
      getFirstSyncState({ billing: billing(0), items: [], overviews: [overview(SOURCE_A)] })
    ).toEqual({ state: "needs_credits", targetSourceId: SOURCE_A })
  })

  it("no active item, credits ≥ 1 → ready", () => {
    expect(
      getFirstSyncState({ billing: billing(1), items: [], overviews: [overview(SOURCE_A)] })
    ).toEqual({ state: "ready", targetSourceId: SOURCE_A })
  })

  it.each(["queued", "running"] as const)("active item %s → syncing", (status) => {
    expect(
      getFirstSyncState({
        billing: billing(5),
        items: [item(status)],
        overviews: [overview(SOURCE_A)],
      })
    ).toEqual({ state: "syncing", targetSourceId: SOURCE_A })
  })

  it("active item credit_required, credits 0 → paused", () => {
    expect(
      getFirstSyncState({
        billing: billing(0, "active"),
        items: [item("credit_required")],
        overviews: [overview(SOURCE_A)],
      })
    ).toEqual({ state: "paused", targetSourceId: SOURCE_A })
  })

  it("active item credit_required, credits ≥ 1 → resumable", () => {
    expect(
      getFirstSyncState({
        billing: billing(40, "active"),
        items: [item("credit_required")],
        overviews: [overview(SOURCE_A)],
      })
    ).toEqual({ state: "resumable", targetSourceId: SOURCE_A })
  })

  it("item failed → failed", () => {
    expect(
      getFirstSyncState({
        billing: billing(5),
        items: [item("failed")],
        overviews: [overview(SOURCE_A)],
      })
    ).toEqual({ state: "failed", targetSourceId: SOURCE_A })
  })

  it("latestSync.status failed with no active item → failed", () => {
    expect(
      getFirstSyncState({
        billing: billing(5),
        items: [],
        overviews: [overview(SOURCE_A, { status: "failed" })],
      })
    ).toEqual({ state: "failed", targetSourceId: SOURCE_A })
  })

  it("any source has lastSyncedAt → done", () => {
    expect(
      getFirstSyncState({
        billing: billing(0),
        items: [item("failed")],
        overviews: [
          overview(SOURCE_A, { status: "failed" }),
          overview(SOURCE_B, { lastSyncedAt: "2025-03-10T12:00:00.000Z", status: "completed" }),
        ],
      })
    ).toEqual({ state: "done", targetSourceId: null })
  })

  it("billing failed to load (non-401) → billing_unknown", () => {
    expect(
      getFirstSyncState({ billing: null, items: [], overviews: [overview(SOURCE_A)] })
    ).toEqual({ state: "billing_unknown", targetSourceId: SOURCE_A })
  })

  it.each(["pending", "processing"] as const)(
    "no active item yet, latestSync.status %s with a jobId → syncing",
    (status) => {
      expect(
        getFirstSyncState({
          billing: billing(5),
          items: [],
          overviews: [overview(SOURCE_A, { jobId: "job-1", status })],
        })
      ).toEqual({ state: "syncing", targetSourceId: SOURCE_A })
    }
  )

  it("no active item yet, latestSync.status credit_required with a jobId, credits 0 → paused", () => {
    expect(
      getFirstSyncState({
        billing: billing(0),
        items: [],
        overviews: [overview(SOURCE_A, { jobId: "job-1", status: "credit_required" })],
      })
    ).toEqual({ state: "paused", targetSourceId: SOURCE_A })
  })

  it("no active item yet, latestSync.status credit_required with a jobId, credits ≥ 1 → resumable", () => {
    expect(
      getFirstSyncState({
        billing: billing(1),
        items: [],
        overviews: [overview(SOURCE_A, { jobId: "job-1", status: "credit_required" })],
      })
    ).toEqual({ state: "resumable", targetSourceId: SOURCE_A })
  })
})

describe("getFirstSyncState overview job before the hook has an item (#108 D03, T05 review rows)", () => {
  it("ignores an overview job without a jobId, like the reload seed", () => {
    expect(
      getFirstSyncState({
        billing: billing(5),
        items: [],
        overviews: [overview(SOURCE_A, { jobId: null, status: "processing" })],
      }).state
    ).toBe("ready")
  })

  it("lets the hook's item take over once it exists", () => {
    expect(
      getFirstSyncState({
        billing: billing(5),
        items: [item("failed")],
        overviews: [overview(SOURCE_A, { jobId: "job-1", status: "processing" })],
      }).state
    ).toBe("failed")
  })

  it("reports billing_unknown for a credit_required overview job while billing is unknown", () => {
    expect(
      getFirstSyncState({
        billing: null,
        items: [],
        overviews: [overview(SOURCE_A, { jobId: "job-1", status: "credit_required" })],
      }).state
    ).toBe("billing_unknown")
  })

  it("treats a completed overview job as history", () => {
    expect(
      getFirstSyncState({
        billing: billing(0),
        items: [],
        overviews: [overview(SOURCE_A, { jobId: "job-1", status: "completed" })],
      }).state
    ).toBe("needs_credits")
  })
})

describe("getFirstSyncState pending completion", () => {
  it("stays syncing after the completed item is gone until the overview refetch confirms it", () => {
    expect(
      getFirstSyncState({
        billing: billing(5),
        items: [],
        overviews: [overview(SOURCE_A)],
        pendingCompletionSourceIds: new Set([SOURCE_A]),
      }).state
    ).toBe("syncing")
  })

  it("outranks an unknown billing status", () => {
    expect(
      getFirstSyncState({
        billing: null,
        items: [],
        overviews: [overview(SOURCE_A)],
        pendingCompletionSourceIds: new Set([SOURCE_A]),
      }).state
    ).toBe("syncing")
  })

  it("gives way to done once the overview carries lastSyncedAt", () => {
    expect(
      getFirstSyncState({
        billing: billing(5),
        items: [],
        overviews: [overview(SOURCE_A, { lastSyncedAt: "2025-03-10T12:00:00.000Z" })],
        pendingCompletionSourceIds: new Set([SOURCE_A]),
      }).state
    ).toBe("done")
  })

  it("only applies to the target source", () => {
    expect(
      getFirstSyncState({
        billing: billing(5),
        items: [],
        overviews: [overview(SOURCE_A), overview(SOURCE_B)],
        pendingCompletionSourceIds: new Set([SOURCE_B]),
      }).state
    ).toBe("ready")
  })
})

describe("getFirstSyncState precedence", () => {
  it("targets the first source in the list and ignores items of other sources", () => {
    expect(
      getFirstSyncState({
        billing: billing(5),
        items: [item("running", SOURCE_B)],
        overviews: [overview(SOURCE_A), overview(SOURCE_B)],
      })
    ).toEqual({ state: "ready", targetSourceId: SOURCE_A })
  })

  it("keeps syncing while a completed item waits for the overview to confirm it", () => {
    expect(
      getFirstSyncState({
        billing: billing(5),
        items: [item("completed")],
        overviews: [overview(SOURCE_A)],
      }).state
    ).toBe("syncing")
  })

  it("reports a sync underway even when billing is unknown", () => {
    expect(
      getFirstSyncState({
        billing: null,
        items: [item("running")],
        overviews: [overview(SOURCE_A)],
      }).state
    ).toBe("syncing")
  })

  it("does not offer Try again while billing is unknown", () => {
    expect(
      getFirstSyncState({ billing: null, items: [item("failed")], overviews: [overview(SOURCE_A)] })
        .state
    ).toBe("billing_unknown")
  })

  it("lets a failed item outrank a stale failed overview only after billing is known", () => {
    expect(
      getFirstSyncState({
        billing: billing(0),
        items: [],
        overviews: [overview(SOURCE_A, { status: "failed" })],
      }).state
    ).toBe("failed")
  })
})

describe("getFirstSyncState while billing is re-read after a credit stop (#108 D03, T05 review)", () => {
  it("keeps a credit_required item paused although the cached balance still shows credits", () => {
    expect(
      getFirstSyncState({
        billing: billing(1, "active"),
        billingRefreshPending: true,
        items: [item("credit_required")],
        overviews: [overview(SOURCE_A)],
      }).state
    ).toBe("paused")
  })

  it("keeps a credit_required overview job paused as well", () => {
    expect(
      getFirstSyncState({
        billing: billing(1),
        billingRefreshPending: true,
        items: [],
        overviews: [overview(SOURCE_A, { jobId: "job-1", status: "credit_required" })],
      }).state
    ).toBe("paused")
  })

  it("offers resumable again once the re-read has settled with credits", () => {
    expect(
      getFirstSyncState({
        billing: billing(3, "active"),
        billingRefreshPending: false,
        items: [item("credit_required")],
        overviews: [overview(SOURCE_A)],
      }).state
    ).toBe("resumable")
  })

  it("does not change other rows", () => {
    expect(
      getFirstSyncState({
        billing: billing(3),
        billingRefreshPending: true,
        items: [],
        overviews: [overview(SOURCE_A)],
      }).state
    ).toBe("ready")
    expect(
      getFirstSyncState({
        billing: null,
        billingRefreshPending: true,
        items: [item("credit_required")],
        overviews: [overview(SOURCE_A)],
      }).state
    ).toBe("billing_unknown")
  })
})

describe("hasActiveSubscription (#108 D04)", () => {
  it.each([
    ["active", true],
    ["trialing", true],
    ["canceled", false],
    ["incomplete_expired", false],
    [null, false],
  ] as const)("subscriptionStatus %s → %s", (subscriptionStatus, expected) => {
    expect(hasActiveSubscription(billing(0, subscriptionStatus))).toBe(expected)
  })

  it("is false when billing failed to load", () => {
    expect(hasActiveSubscription(null)).toBe(false)
  })
})
