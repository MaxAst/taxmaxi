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
  readonly latestSync: Pick<SourceOverview["latestSync"], "jobId" | "lastSyncedAt" | "status">
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

const NO_PENDING_COMPLETIONS: ReadonlySet<string> = new Set()

/**
 * Derives the first-sync state from server facts plus the sync hook's
 * in-memory items (#108 D03). Never stored; reload recomputes it from the
 * same facts.
 *
 * Precedence, top to bottom:
 * 1. any source has `lastSyncedAt` → `done`
 * 2. no source → `needs_source`
 * 3. the target's item is queued, running, or completed, or its completion
 *    still waits for the overview refetch → `syncing` (the wizard never
 *    flashes a second Start during the hand-off)
 * 4. no item yet and the overview's latest job is pending or processing → `syncing`
 *    (after a reload the hook seeds its items in an effect; the overview's
 *    job status decides the first paint)
 * 5. billing failed to load → `billing_unknown`
 * 6. the target's item is `credit_required`, or no item yet and the overview's
 *    latest job is `credit_required` → `paused` or `resumable`; while billing
 *    is being re-read after that stop, always `paused`
 * 7. the target's item failed, or the latest sync failed with no item → `failed`
 * 8. otherwise `ready` or `needs_credits`
 */
export function getFirstSyncState({
  billing,
  billingRefreshPending = false,
  items,
  overviews,
  pendingCompletionSourceIds = NO_PENDING_COMPLETIONS,
}: {
  readonly billing: FirstSyncBilling
  /**
   * True while billing is being re-read because a sync stopped for credits.
   * The cached balance predates that stop, so a `credit_required` job reads
   * as `paused`, never `resumable`, until the read settles (#108 D03, T05
   * review). Other rows are not affected.
   */
  readonly billingRefreshPending?: boolean
  readonly items: ReadonlyArray<FirstSyncItem>
  readonly overviews: ReadonlyArray<FirstSyncSourceOverview>
  /**
   * Sources whose sync completed but whose overview refetch has not resolved
   * successfully yet. The hook drops a completed item after a short delay,
   * so this keeps `syncing` until the overview can confirm `lastSyncedAt`.
   */
  readonly pendingCompletionSourceIds?: ReadonlySet<string>
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
    state: getTargetState({
      billing,
      billingRefreshPending,
      completionPending: pendingCompletionSourceIds.has(targetSourceId),
      item,
      latestSync: target.latestSync,
    }),
    targetSourceId,
  }
}

function getTargetState({
  billing,
  billingRefreshPending,
  completionPending,
  item,
  latestSync,
}: {
  readonly billing: FirstSyncBilling
  readonly billingRefreshPending: boolean
  readonly completionPending: boolean
  readonly item: FirstSyncItem | undefined
  readonly latestSync: FirstSyncSourceOverview["latestSync"]
}): FirstSyncState {
  // When the hook has an item for the source, the item decides. Before it has
  // one (the reconnect seed runs in an effect), the overview's latest job
  // stands in for it (#108 D03, T05 review rows).
  const jobStatus = item?.status ?? toSeedJobStatus(latestSync)

  if (
    completionPending ||
    jobStatus === "queued" ||
    jobStatus === "running" ||
    jobStatus === "completed"
  ) {
    return "syncing"
  }

  if (billing === null) {
    return "billing_unknown"
  }

  if (jobStatus === "credit_required") {
    return !billingRefreshPending && hasUsableCredits(billing) ? "resumable" : "paused"
  }

  if (item?.status === "failed" || latestSync.status === "failed") {
    return "failed"
  }

  return hasUsableCredits(billing) ? "ready" : "needs_credits"
}

/**
 * The overview job the reload seed would reconnect to, in the job endpoint's
 * words (`pending` is `queued`, `processing` is `running`). Only jobs with a
 * `jobId` count, mirroring the seed (#108 D02); a completed or failed job is
 * history and yields nothing.
 */
function toSeedJobStatus(
  latestSync: FirstSyncSourceOverview["latestSync"]
): FirstSyncItem["status"] | undefined {
  if (latestSync.jobId === null) {
    return undefined
  }

  switch (latestSync.status) {
    case "pending":
      return "queued"
    case "processing":
      return "running"
    case "credit_required":
      return "credit_required"
    case "completed":
    case "failed":
    case null:
      return undefined
  }
}
