import type { BillingStatus, SourceOverview, SourceSyncJob } from "taxmaxi"

/**
 * The first-sync states from the #108 D03 table. `done` means a source has
 * completed a sync and the normal dashboard shows; every other state is a
 * step of the first-sync wizard.
 */
export type FirstSyncState =
  | "needs_source"
  | "needs_credits"
  | "ready"
  | "syncing"
  | "paused"
  | "resumable"
  | "failed"
  | "done"
  | "billing_unknown"

/** The part of a source overview the state reads. */
export type FirstSyncSourceOverview = {
  readonly source: { readonly id: SourceOverview["source"]["id"] }
  readonly latestSync: Pick<SourceOverview["latestSync"], "lastSyncedAt" | "status">
}

/** The part of billing status the state reads; `null` when the load failed (non-401). */
export type FirstSyncBilling = Pick<BillingStatus, "credits" | "subscriptionStatus"> | null

/** The part of a sync-hook item the state reads. Its `id` is the source id. */
export type FirstSyncItem = {
  readonly id: string
  readonly status: SourceSyncJob["status"]
}

export type FirstSyncStateResult = {
  readonly state: FirstSyncState
  /** The source the wizard talks about and starts: the first one in the list. */
  readonly targetSourceId: string | null
}

/**
 * "Usable credits" mirrors the server's `assertHasSyncCredits`: at least one
 * credit. The server stays the enforcer; this only picks which action to show
 * (#108 D04).
 */
export const MIN_USABLE_CREDITS = 1

export function hasUsableCredits(billing: NonNullable<FirstSyncBilling>): boolean {
  return billing.credits >= MIN_USABLE_CREDITS
}

/**
 * Plan versus top-up follows the island's rule: an active or trialing
 * subscription buys credits, anything else picks a plan (#108 D04).
 */
export function hasActiveSubscription(billing: FirstSyncBilling): boolean {
  return billing?.subscriptionStatus === "active" || billing?.subscriptionStatus === "trialing"
}

/**
 * Derives the first-sync state from server facts plus the sync hook's
 * in-memory items (#108 D03). Never stored; reload recomputes it from the
 * same facts.
 *
 * Precedence, top to bottom:
 * 1. any source has `lastSyncedAt` → `done`
 * 2. no source → `needs_source`
 * 3. the target's item is queued, running, or completed → `syncing`
 *    (a completed item stays "underway" until the overview confirms it)
 * 4. billing failed to load → `billing_unknown`
 * 5. the target's item is `credit_required` → `paused` or `resumable`
 * 6. the target's item failed, or the latest sync failed with no item → `failed`
 * 7. otherwise `ready` or `needs_credits`
 */
export function getFirstSyncState({
  billing,
  items,
  overviews,
}: {
  readonly billing: FirstSyncBilling
  readonly items: ReadonlyArray<FirstSyncItem>
  readonly overviews: ReadonlyArray<FirstSyncSourceOverview>
}): FirstSyncStateResult {
  if (overviews.some((overview) => overview.latestSync.lastSyncedAt !== null)) {
    return { state: "done", targetSourceId: null }
  }

  const target = overviews[0]

  if (target === undefined) {
    return { state: "needs_source", targetSourceId: null }
  }

  const targetSourceId = target.source.id
  const item = items.find((candidate) => candidate.id === targetSourceId)

  return {
    state: getTargetState({ billing, item, latestStatus: target.latestSync.status }),
    targetSourceId,
  }
}

function getTargetState({
  billing,
  item,
  latestStatus,
}: {
  readonly billing: FirstSyncBilling
  readonly item: FirstSyncItem | undefined
  readonly latestStatus: FirstSyncSourceOverview["latestSync"]["status"]
}): FirstSyncState {
  if (item?.status === "queued" || item?.status === "running" || item?.status === "completed") {
    return "syncing"
  }

  if (billing === null) {
    return "billing_unknown"
  }

  if (item?.status === "credit_required") {
    return hasUsableCredits(billing) ? "resumable" : "paused"
  }

  if (item?.status === "failed" || latestStatus === "failed") {
    return "failed"
  }

  return hasUsableCredits(billing) ? "ready" : "needs_credits"
}
