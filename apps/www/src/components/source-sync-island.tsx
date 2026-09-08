import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { useEffect, useState } from "react"
import { useNavigate, useRouteContext } from "@tanstack/react-router"
import { RotateCcw, X } from "lucide-react"
import type { BillingStatus, SourceSyncJob } from "taxmaxi"

import { SourceSyncStatusOrb } from "#/components/source-sync-status-orb"
import { m } from "#/paraglide/messages"
import { getLocale } from "#/paraglide/runtime"
import {
  SOURCE_SYNC_MOCK_SCENARIOS,
  SOURCE_SYNC_MOCKS_ENABLED,
  SourceSyncMockControls,
  type SourceSyncMockScenario,
} from "#/components/source-sync-island-mocks"
import { Button } from "#/components/ui/button"
import { cn } from "#/lib/utils"

export type SourceSyncStatus = SourceSyncJob["status"]
export type SourceSyncPhase = NonNullable<SourceSyncJob["phase"]>

/**
 * How the job was started. The job status endpoint does not report this, so
 * the client stamps it from the call it made and carries it through polling.
 */
export type SourceSyncMode = "sync" | "replay"

export const SOURCE_SYNC_PROGRESS = {
  classificationStart: 50,
  completed: 100,
  discoveryTarget: 49.5,
  reconciliation: 100,
} as const

export function getSourceSyncDisplayProgress({
  phase,
  progressPercent,
  status,
}: {
  phase: SourceSyncPhase | null
  progressPercent: number | null
  status: SourceSyncStatus
}): number {
  if (status === "completed" || status === "failed" || status === "credit_required") {
    return SOURCE_SYNC_PROGRESS.completed
  }

  if (status === "queued") {
    return 0
  }

  switch (phase) {
    case "discovering":
      return SOURCE_SYNC_PROGRESS.discoveryTarget
    case "classifying": {
      const classificationProgress = Math.min(100, Math.max(0, progressPercent ?? 0))
      return (
        SOURCE_SYNC_PROGRESS.classificationStart +
        (classificationProgress / 100) *
          (SOURCE_SYNC_PROGRESS.completed - SOURCE_SYNC_PROGRESS.classificationStart)
      )
    }
    case "reconciling":
    case "completed":
      return SOURCE_SYNC_PROGRESS.reconciliation
    case null:
      return 0
  }
}

export type SourceSyncCreditOutcome = NonNullable<SourceSyncJob["creditOutcome"]>

export type SourceSyncIslandItem = {
  id: string
  sourceName: string
  status: SourceSyncStatus
  progress: number
  mode?: SourceSyncMode
  phase?: SourceSyncPhase
  processedRecords?: number
  totalRecords?: number
  fetchedRecords?: number
  normalizedRecords?: number
  failedRecords?: number
  message?: string
  creditOutcome?: SourceSyncCreditOutcome
}

type SourceSyncIslandProps = {
  items: ReadonlyArray<SourceSyncIslandItem>
  /**
   * Whether a failed item gets the Retry button. Defaults to yes for every
   * item; the dashboard says no for the source whose retry another control
   * already owns (#108 D06). Nothing else about the item changes.
   */
  canRetry?: (item: SourceSyncIslandItem) => boolean
  onDismiss?: (item: SourceSyncIslandItem) => void
  onRetry?: (item: SourceSyncIslandItem) => void
}

function isRetryOffered(
  item: SourceSyncIslandItem,
  canRetry: SourceSyncIslandProps["canRetry"]
): boolean {
  return item.status === "failed" && (canRetry?.(item) ?? true)
}

/**
 * Copy for a credit-required sync, built only from the structured credit outcome
 * so internal error text never reaches the screen.
 */
export function getCreditRequiredCopy(creditOutcome: SourceSyncCreditOutcome | undefined): string {
  if (!creditOutcome) {
    return m["app.syncIsland.creditRequired.pausedNoDetails"]()
  }

  // Nothing consumed and no known shortfall means the sync was refused before
  // it started (the shape the start-refusal path emits), so "ran out" wording
  // would be wrong for a user who never had credits.
  if (creditOutcome.creditsConsumed === 0 && creditOutcome.additionalCreditsRequired === null) {
    return m["app.syncIsland.creditRequired.notStarted"]()
  }

  const parts = [m["app.syncIsland.creditRequired.pausedIntro"]()]

  if (creditOutcome.creditsConsumed > 0) {
    const covered =
      creditOutcome.creditsConsumed === 1
        ? m["app.syncIsland.creditRequired.coveredOne"]
        : m["app.syncIsland.creditRequired.coveredMany"]
    parts.push(covered({ count: formatInteger(creditOutcome.creditsConsumed) }))
  }

  if (creditOutcome.additionalCreditsRequired === null) {
    parts.push(m["app.syncIsland.creditRequired.addUnknown"]())
  } else {
    const add =
      creditOutcome.additionalCreditsRequired === 1
        ? m["app.syncIsland.creditRequired.addOne"]
        : m["app.syncIsland.creditRequired.addMany"]
    parts.push(add({ count: formatInteger(creditOutcome.additionalCreditsRequired) }))
  }

  return parts.join(" ")
}

/**
 * Billing recovery for credit-required syncs, owned by the island so callers do
 * not have to thread billing state and navigation through their props.
 *
 * The billing status is loaded once, and only after a credit-required sync
 * appears; without it the island falls back to the plan action, which still
 * leads to billing.
 */
function useCreditRecovery(items: ReadonlyArray<SourceSyncIslandItem>) {
  const navigate = useNavigate()
  const taxmaxi = useRouteContext({
    from: "/app",
    select: (context) => context.taxmaxi(),
  })
  const [billingStatus, setBillingStatus] = useState<BillingStatus | null>(null)
  const needsBillingStatus = items.some((item) => item.status === "credit_required")

  useEffect(() => {
    if (!needsBillingStatus || billingStatus !== null) {
      return
    }

    let cancelled = false
    const load = async () => {
      try {
        const status = await taxmaxi.billing.status()
        if (!cancelled) {
          setBillingStatus(status)
        }
      } catch {
        // Ignored: the island then shows the plan action instead.
      }
    }
    void load()

    return () => {
      cancelled = true
    }
  }, [billingStatus, needsBillingStatus, taxmaxi])

  const hasActiveSubscription =
    billingStatus?.subscriptionStatus === "active" ||
    billingStatus?.subscriptionStatus === "trialing"

  return {
    billingActionLabel: hasActiveSubscription
      ? m["app.syncIsland.creditRequired.buyCredits"]()
      : m["app.syncIsland.creditRequired.choosePlan"](),
    onBillingAction: () => {
      void navigate({ to: "/app/billing" })
    },
  }
}

/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD
 *
 * Read top-to-bottom. Each value is ms after the trigger.
 *
 *    0ms   compact activity orb appears, scale 0.9 → 1
 *   80ms   shell unfolds to the content-owned 284px sync view
 *  180ms   a failed sync expands to reveal recovery details
 * on tap   shell morphs while its headline stays mounted and visually stable
 *  +0ms    detail content fades and moves 4px into the expanded shell
 * on sync  discovery progress advances clockwise 0% → 49.5% in continuously moving stages
 * on data  classification maps measured progress onto 50% → 100%
 * on done  ring finishes clockwise to 100% before the success state appears
 * +600ms   completed ring fades and the green check settles into place
 * ───────────────────────────────────────────────────────── */

const TIMING = {
  activeReveal: 80, // shell unfolds after the compact orb lands
  failureReveal: 180, // failed sync reveals its recovery details
  detailReveal: 180, // detail content settles into the expanded shell
  progressCompletion: 600, // terminal data waits for the ring to visibly reach 100%
}

const VIEW_STAGE = {
  compact: 0,
  active: 1,
  expanded: 2,
} as const

const ISLAND = {
  enterScale: 0.9,
  exitScale: 0.96,
  enterY: -8,
  exitY: -6,
  tapScale: 0.98,
  elementSpring: { type: "spring" as const, bounce: 0.22 },
  shellSpring: { type: "spring" as const, bounce: 0, visualDuration: 0.24 },
  reducedTransition: { duration: 0 },
}

const CONTENT = {
  offsetY: -4,
  easeOut: [0.22, 1, 0.36, 1] as const,
}

const PROGRESS = {
  flashOpacity: 0.24,
}

const CONTENT_VARIANTS = {
  animate: {
    opacity: 1,
    scale: 1,
    y: 0,
  },
  exit: {
    opacity: 0,
    scale: 0.98,
    y: CONTENT.offsetY,
  },
  initial: {
    opacity: 0,
    scale: 0.98,
    y: CONTENT.offsetY,
  },
}

const CONTENT_TRANSITION = {
  duration: toSeconds(TIMING.detailReveal),
  ease: CONTENT.easeOut,
}

// A function rather than a map so the localized labels follow the active
// locale instead of freezing at module load. Replay jobs get their own
// running/completed wording; the other states read the same for both modes.
function getStatusLabel({ mode, status }: Pick<SourceSyncIslandItem, "mode" | "status">): string {
  switch (status) {
    case "queued":
      return m["app.syncIsland.status.queued"]()
    case "running":
      return mode === "replay"
        ? m["app.syncIsland.replayStatus.running"]()
        : m["app.syncIsland.status.running"]()
    case "completed":
      return mode === "replay"
        ? m["app.syncIsland.replayStatus.completed"]()
        : m["app.syncIsland.status.completed"]()
    case "failed":
      return m["app.syncIsland.status.failed"]()
    case "credit_required":
      return m["app.syncIsland.creditRequired.statusLabel"]()
  }
}

const statusTone: Record<SourceSyncStatus, string> = {
  queued: "text-sync-island-muted",
  running: "text-sync-island-accent",
  completed: "text-sync-island-complete",
  failed: "text-sync-island-failed",
  credit_required: "text-sync-island-failed",
}

// Resolved per call so number grouping follows the active locale.
const formatInteger = (value: number): string =>
  new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 0 }).format(value)

export function SourceSyncIsland({ canRetry, items, onDismiss, onRetry }: SourceSyncIslandProps) {
  const reduceMotion = useReducedMotion()
  const { billingActionLabel, onBillingAction } = useCreditRecovery(items)
  const [mockScenario, setMockScenario] = useState<SourceSyncMockScenario>("live")
  const usingMockScenario = SOURCE_SYNC_MOCKS_ENABLED && mockScenario !== "live"
  const rawVisibleItems = usingMockScenario ? SOURCE_SYNC_MOCK_SCENARIOS[mockScenario] : items
  const rawPrimaryItem = rawVisibleItems[0]
  const [orchestratedPrimaryItem, setOrchestratedPrimaryItem] = useState<
    SourceSyncIslandItem | undefined
  >(rawPrimaryItem)
  const [stage, setStage] = useState<number>(VIEW_STAGE.compact)

  useEffect(() => {
    if (!rawPrimaryItem) {
      setOrchestratedPrimaryItem(undefined)
      return
    }

    if (rawPrimaryItem.status !== "completed") {
      setOrchestratedPrimaryItem(rawPrimaryItem)
      return
    }

    const completingItem: SourceSyncIslandItem = {
      ...rawPrimaryItem,
      phase: "completed",
      progress: SOURCE_SYNC_PROGRESS.completed,
      status: "running",
    }
    setOrchestratedPrimaryItem(completingItem)

    if (reduceMotion) {
      setOrchestratedPrimaryItem(rawPrimaryItem)
      return
    }

    const timerId = window.setTimeout(
      () => setOrchestratedPrimaryItem(rawPrimaryItem),
      TIMING.progressCompletion
    )

    return () => window.clearTimeout(timerId)
  }, [rawPrimaryItem, reduceMotion])

  const orchestratedMatchesPrimary = orchestratedPrimaryItem?.id === rawPrimaryItem?.id
  const awaitingCompletedRing =
    rawPrimaryItem?.status === "completed" &&
    (!orchestratedMatchesPrimary || orchestratedPrimaryItem?.status !== "completed")
  const primaryItem = awaitingCompletedRing
    ? orchestratedMatchesPrimary
      ? orchestratedPrimaryItem
      : {
          ...rawPrimaryItem,
          phase: "completed" as const,
          progress: SOURCE_SYNC_PROGRESS.completed,
          status: "running" as const,
        }
    : orchestratedMatchesPrimary
      ? orchestratedPrimaryItem
      : rawPrimaryItem
  const visibleItems = primaryItem ? [primaryItem, ...rawVisibleItems.slice(1)] : []

  useEffect(() => {
    if (!primaryItem) {
      setStage(VIEW_STAGE.compact)
      return
    }

    if (reduceMotion) {
      setStage(VIEW_STAGE.active)
      return
    }

    setStage(VIEW_STAGE.compact)
    const timerId = window.setTimeout(() => setStage(VIEW_STAGE.active), TIMING.activeReveal)

    return () => window.clearTimeout(timerId)
  }, [primaryItem?.id, reduceMotion])

  useEffect(() => {
    if (primaryItem?.status !== "failed" && primaryItem?.status !== "credit_required") {
      return
    }

    if (reduceMotion) {
      setStage(VIEW_STAGE.expanded)
      return
    }

    const timerId = window.setTimeout(() => setStage(VIEW_STAGE.expanded), TIMING.failureReveal)

    return () => window.clearTimeout(timerId)
  }, [primaryItem?.status, reduceMotion])

  const expanded = stage === VIEW_STAGE.expanded
  const compact = stage === VIEW_STAGE.compact

  const toggleDetails = () =>
    setStage((currentStage) =>
      currentStage === VIEW_STAGE.expanded ? VIEW_STAGE.active : VIEW_STAGE.expanded
    )

  const effectiveOnDismiss = usingMockScenario ? () => setMockScenario("live") : onDismiss
  const effectiveOnRetry = usingMockScenario ? () => setMockScenario("running") : onRetry

  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 top-[max(1rem,env(safe-area-inset-top))] z-50 flex justify-center px-4">
        <AnimatePresence mode="popLayout">
          {primaryItem ? (
            <motion.div
              animate={{ opacity: 1, scale: 1, y: 0 }}
              className="pointer-events-auto relative isolate w-fit min-w-14 overflow-hidden rounded-[2rem] bg-sync-island font-interface text-sync-island-foreground will-change-transform [--background:var(--sync-island)] [--border:var(--sync-island-border)] [--foreground:var(--sync-island-foreground)] [--muted:rgb(255_255_255_/_0.08)] [--muted-foreground:var(--sync-island-muted)] [--secondary:rgb(255_255_255_/_0.1)] [--secondary-foreground:var(--sync-island-foreground)]"
              exit={
                reduceMotion
                  ? { opacity: 0 }
                  : { opacity: 0, scale: ISLAND.exitScale, y: ISLAND.exitY }
              }
              initial={
                reduceMotion
                  ? { opacity: 1 }
                  : { opacity: 0, scale: ISLAND.enterScale, y: ISLAND.enterY }
              }
              layout
              transition={getShellTransition(Boolean(reduceMotion))}
            >
              <CompletionGlow reduceMotion={Boolean(reduceMotion)} status={primaryItem.status} />

              <AnimatePresence initial={false} mode="popLayout">
                <motion.div
                  animate="animate"
                  exit={reduceMotion ? { opacity: 0 } : "exit"}
                  initial={reduceMotion ? false : "initial"}
                  key={`${primaryItem.id}-${compact ? "compact" : "active"}`}
                  transition={reduceMotion ? ISLAND.reducedTransition : CONTENT_TRANSITION}
                  variants={CONTENT_VARIANTS}
                >
                  {compact ? (
                    <CompactIslandContent
                      item={primaryItem}
                      onOpen={toggleDetails}
                      reduceMotion={Boolean(reduceMotion)}
                    />
                  ) : (
                    <ActiveIslandContent
                      billingActionLabel={billingActionLabel}
                      canRetry={canRetry}
                      expanded={expanded}
                      item={primaryItem}
                      items={visibleItems}
                      onBillingAction={onBillingAction}
                      onDismiss={effectiveOnDismiss}
                      onOpen={toggleDetails}
                      onRetry={effectiveOnRetry}
                      reduceMotion={Boolean(reduceMotion)}
                    />
                  )}
                </motion.div>
              </AnimatePresence>

              <span aria-live="polite" className="sr-only" role="status">
                {getAnnouncement(visibleItems, canRetry)}
              </span>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      {SOURCE_SYNC_MOCKS_ENABLED ? (
        <SourceSyncMockControls scenario={mockScenario} onScenarioChange={setMockScenario} />
      ) : null}
    </>
  )
}

function CompactIslandContent({
  item,
  onOpen,
  reduceMotion,
}: {
  item: SourceSyncIslandItem
  onOpen: () => void
  reduceMotion: boolean
}) {
  return (
    <motion.button
      aria-label={m["app.syncIsland.aria.showDetails"]({ sourceName: item.sourceName })}
      className="grid size-11 touch-manipulation place-items-center rounded-[inherit] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/40"
      onClick={onOpen}
      type="button"
      whileTap={reduceMotion ? undefined : { scale: ISLAND.tapScale }}
    >
      <SourceSyncStatusOrb
        phase={item.phase}
        progress={item.progress}
        reduceMotion={reduceMotion}
        status={item.status}
      />
    </motion.button>
  )
}

function ActiveIslandContent({
  billingActionLabel,
  canRetry,
  expanded,
  item,
  items,
  onBillingAction,
  onDismiss,
  onOpen,
  onRetry,
  reduceMotion,
}: {
  billingActionLabel: string
  canRetry?: SourceSyncIslandProps["canRetry"]
  expanded: boolean
  item: SourceSyncIslandItem
  items: ReadonlyArray<SourceSyncIslandItem>
  onBillingAction: () => void
  onDismiss?: (item: SourceSyncIslandItem) => void
  onOpen: () => void
  onRetry?: (item: SourceSyncIslandItem) => void
  reduceMotion: boolean
}) {
  const headline = getIslandHeadline(items)
  const dismissible =
    item.status === "completed" || item.status === "failed" || item.status === "credit_required"

  return (
    <div
      className={cn(
        "max-w-[calc(100vw-2rem)]",
        expanded ? "w-[min(21rem,calc(100vw-2rem))]" : "w-fit"
      )}
    >
      <div className={cn("flex items-center gap-2", expanded ? "px-2 pt-2" : "p-0")}>
        <motion.button
          aria-controls={`source-sync-details-${item.id}`}
          aria-expanded={expanded}
          aria-label={
            expanded
              ? m["app.syncIsland.aria.hideDetails"]({ sourceName: item.sourceName })
              : m["app.syncIsland.aria.showDetailsHeadline"]({ headline })
          }
          className="flex min-h-9 min-w-0 flex-1 touch-manipulation items-center gap-2 rounded-[1.5rem] pl-3 pr-4 text-left outline-none transition-[background-color] duration-150 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/40 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-marketing-surface-hover-muted"
          layout="position"
          onClick={onOpen}
          type="button"
          whileTap={reduceMotion ? undefined : { scale: ISLAND.tapScale }}
        >
          <SyncHeadline item={item} items={items} reduceMotion={reduceMotion} />
        </motion.button>
        {expanded && dismissible && onDismiss ? (
          <div className="shrink-0 pr-2">
            <Button
              aria-label={m["app.syncIsland.aria.dismiss"]({ sourceName: item.sourceName })}
              className="shrink-0"
              onClick={() => onDismiss(item)}
              size="icon-xs"
              type="button"
              variant="secondary"
            >
              <X aria-hidden="true" strokeWidth={4} />
            </Button>
          </div>
        ) : null}
      </div>

      <AnimatePresence initial={false} mode="popLayout">
        {expanded ? (
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            className="px-5 pt-3 pb-4"
            exit={{ opacity: 0, y: CONTENT.offsetY }}
            id={`source-sync-details-${item.id}`}
            initial={reduceMotion ? false : { opacity: 0, y: CONTENT.offsetY }}
            key="details"
            transition={reduceMotion ? ISLAND.reducedTransition : CONTENT_TRANSITION}
          >
            <SyncMetrics item={item} />

            {item.status === "credit_required" ? (
              <p className="mt-3 text-xs leading-5 font-medium text-sync-island-failed">
                {getCreditRequiredCopy(item.creditOutcome)}
              </p>
            ) : item.message ? (
              <p
                className={cn(
                  "mt-3 text-xs leading-5 font-medium",
                  item.status === "failed" ? "text-sync-island-failed" : "text-sync-island-muted"
                )}
              >
                {item.message}
              </p>
            ) : null}

            {items.length > 1 ? <SyncQueue items={items.slice(1)} /> : null}

            {item.status === "failed" ||
            item.status === "completed" ||
            item.status === "credit_required" ? (
              <div className="mt-3 flex items-center justify-end gap-2">
                {item.status === "credit_required" ? (
                  <Button onClick={onBillingAction} size="sm" type="button" variant="secondary">
                    {billingActionLabel}
                  </Button>
                ) : null}
                {onRetry && isRetryOffered(item, canRetry) ? (
                  <Button onClick={() => onRetry(item)} size="sm" type="button" variant="secondary">
                    <RotateCcw aria-hidden="true" className="size-3.5" strokeWidth={2.5} />
                    {m["app.syncIsland.retry"]()}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

function SyncHeadline({
  item,
  items,
  reduceMotion,
}: {
  item: SourceSyncIslandItem
  items: ReadonlyArray<SourceSyncIslandItem>
  reduceMotion: boolean
}) {
  return (
    <>
      <SourceSyncStatusOrb
        phase={item.phase}
        progress={item.progress}
        reduceMotion={reduceMotion}
        status={item.status}
      />
      <span className="min-w-0 truncate text-[0.8125rem] font-medium tracking-[-0.012em]">
        {getIslandHeadline(items)}
      </span>
    </>
  )
}

function CompletionGlow({
  reduceMotion,
  status,
}: {
  reduceMotion: boolean
  status: SourceSyncStatus
}) {
  if (status !== "completed") {
    return null
  }

  return (
    <motion.span
      animate={reduceMotion ? { opacity: 0 } : { opacity: [0, PROGRESS.flashOpacity, 0] }}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_50%,var(--sync-island-complete),transparent_42%)]"
      initial={false}
      transition={getFlashTransition(reduceMotion)}
    />
  )
}

function SyncMetrics({ item }: { item: SourceSyncIslandItem }) {
  const metrics = [
    { label: m["app.syncIsland.metrics.fetched"](), value: item.fetchedRecords },
    { label: m["app.syncIsland.metrics.categorized"](), value: item.normalizedRecords },
    { label: m["app.syncIsland.metrics.failed"](), value: item.failedRecords },
  ]

  return (
    <dl className="grid grid-cols-3 gap-2">
      {metrics.map((metric) => (
        <div className="min-w-0" key={metric.label}>
          <dt className="truncate text-[0.625rem] font-medium uppercase tracking-[0.08em] text-sync-island-muted">
            {metric.label}
          </dt>
          <dd className="mt-1 truncate text-sm font-medium tabular-nums text-sync-island-foreground">
            {formatRecordCount(metric.value)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function SyncQueue({ items }: { items: ReadonlyArray<SourceSyncIslandItem> }) {
  const visibleItems = items.slice(0, 3)
  const hiddenCount = items.length - visibleItems.length

  return (
    <div className="mt-3 border-t border-sync-island-border pt-2.5">
      <p className="text-[0.625rem] font-medium uppercase tracking-[0.08em] text-sync-island-muted">
        {m["app.syncIsland.queue.title"]()}
      </p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {visibleItems.map((item) => (
          <li className="flex items-center justify-between gap-3 text-xs" key={item.id}>
            <span className="truncate text-sync-island-foreground">{item.sourceName}</span>
            <span className={cn("shrink-0", statusTone[item.status])}>{getStatusLabel(item)}</span>
          </li>
        ))}
      </ul>
      {hiddenCount > 0 ? (
        <p className="mt-2 text-xs tabular-nums text-sync-island-muted">
          {hiddenCount === 1
            ? m["app.syncIsland.queue.moreOne"]({ count: hiddenCount })
            : m["app.syncIsland.queue.moreMany"]({ count: hiddenCount })}
        </p>
      ) : null}
    </div>
  )
}

function getIslandHeadline(items: ReadonlyArray<SourceSyncIslandItem>): string {
  const primaryItem = items[0]
  const sourceNames = getSourceNames(items)
  const isReplay = primaryItem?.mode === "replay"

  switch (primaryItem?.status) {
    case "queued":
      return m["app.syncIsland.headline.queued"]({ sourceNames })
    case "running":
      return isReplay
        ? m["app.syncIsland.replayHeadline.running"]({ sourceNames })
        : m["app.syncIsland.headline.running"]({ sourceNames })
    case "completed":
      return isReplay
        ? m["app.syncIsland.replayHeadline.completed"]({ sourceNames })
        : m["app.syncIsland.headline.completed"]({ sourceNames })
    case "failed":
      return isReplay
        ? m["app.syncIsland.replayHeadline.failed"]({ sourceNames })
        : m["app.syncIsland.headline.failed"]({ sourceNames })
    case "credit_required":
      return m["app.syncIsland.creditRequired.headline"]({ sourceNames })
    default:
      return m["app.syncIsland.headline.fallback"]()
  }
}

function getSourceNames(items: ReadonlyArray<SourceSyncIslandItem>): string {
  const firstSource = items[0]?.sourceName ?? m["app.syncIsland.sourceNames.fallback"]()
  const secondSource = items[1]?.sourceName

  if (!secondSource) {
    return firstSource
  }

  if (items.length === 2) {
    return m["app.syncIsland.sourceNames.pair"]({ first: firstSource, second: secondSource })
  }

  return m["app.syncIsland.sourceNames.overflow"]({
    first: firstSource,
    second: secondSource,
    count: items.length - 2,
  })
}

function getAnnouncement(
  items: ReadonlyArray<SourceSyncIslandItem>,
  canRetry: SourceSyncIslandProps["canRetry"]
): string {
  const primaryItem = items[0]

  if (primaryItem?.status === "credit_required") {
    return `${getIslandHeadline(items)}. ${getCreditRequiredCopy(primaryItem.creditOutcome)}`
  }

  if (primaryItem?.status !== "failed") {
    return `${getIslandHeadline(items)}.`
  }

  // "Open details to retry" is only promised when the details offer Retry.
  const detail =
    primaryItem.message ??
    (isRetryOffered(primaryItem, canRetry) ? m["app.syncIsland.openDetailsToRetry"]() : undefined)
  return detail === undefined
    ? `${getIslandHeadline(items)}.`
    : `${getIslandHeadline(items)}. ${detail}`
}

function formatRecordCount(value: number | undefined): string {
  return value === undefined ? "—" : formatInteger(value)
}

function getShellTransition(reduceMotion: boolean) {
  return reduceMotion ? ISLAND.reducedTransition : ISLAND.shellSpring
}

function getFlashTransition(reduceMotion: boolean) {
  return reduceMotion
    ? ISLAND.reducedTransition
    : { duration: toSeconds(TIMING.detailReveal), ease: CONTENT.easeOut }
}

function toSeconds(milliseconds: number): number {
  return milliseconds / 1000
}
