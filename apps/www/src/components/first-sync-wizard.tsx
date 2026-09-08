import { useEffect, useRef, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { motion, useReducedMotion } from "motion/react"
import { Check, Loader2 } from "lucide-react"

import { AddWalletCard, type NameResolution } from "#/components/add-wallet-card"
import { appPanelClassName } from "#/components/app-workspace"
import { Button } from "#/components/ui/button"
import {
  hasActiveSubscription,
  hasUsableCredits,
  type FirstSyncBilling,
  type FirstSyncState,
} from "#/lib/first-sync-state"
import { cn } from "#/lib/utils"
import { m } from "#/paraglide/messages"
import { getLocale } from "#/paraglide/runtime"

/**
 * The first-sync wizard (#108, variant D): while no source has completed a
 * sync, onboarding owns the dashboard body. One centered card per step, stage
 * dots underneath. Each state from the D03 table shows what is true, one
 * sentence, and at most one action.
 *
 * The wizard owns Start, Continue, and Try again, all through the sync hook's
 * start function (D06). Progress, dismissal, and the credit-recovery billing
 * action stay in the island, so `syncing` and `paused` only point at it. The
 * wizard never renders `lastErrorMessage` or a job's `message` (D05): the
 * failed step has one generic sentence, and no such text reaches this
 * component.
 */

export type FirstSyncWizardState = Exclude<FirstSyncState, "done">

/**
 * Steps in D06 order. `welcome` is a stub until T07 adds the founder letter
 * (shown while `welcomeSeenAt` is null); `done` is the normal dashboard.
 */
const FIRST_SYNC_WIZARD_STEPS = ["welcome", "connect", "plan", "sync", "done"] as const
type FirstSyncWizardStep = (typeof FIRST_SYNC_WIZARD_STEPS)[number]

function getFirstSyncWizardStep(state: FirstSyncWizardState): FirstSyncWizardStep {
  switch (state) {
    case "needs_source":
      return "connect"
    case "needs_credits":
    case "billing_unknown":
      return "plan"
    case "ready":
    case "syncing":
    case "paused":
    case "resumable":
    case "failed":
      return "sync"
  }
}

const STEP_TRANSITION = { duration: 0.25, ease: [0.22, 1, 0.36, 1] as const }

export type FirstSyncWizardProps = {
  billing: FirstSyncBilling
  /** True while a billing retry is in flight; the retry button waits for it. */
  billingRefreshing?: boolean
  createWalletSource?: (walletAddress: string) => Promise<void>
  onRetryBilling: () => void
  /** Start, Continue, and Try again: one call to the hook's start function for the target source. */
  onStart: () => void
  resolveName?: (name: string) => Promise<NameResolution>
  /** Name of the target source, or null while there is none. */
  sourceName: string | null
  state: FirstSyncWizardState
}

export function FirstSyncWizard(props: FirstSyncWizardProps) {
  const { billing, sourceName, state } = props
  const reduceMotion = useReducedMotion() === true
  const step = getFirstSyncWizardStep(state)
  const stepIndex = FIRST_SYNC_WIZARD_STEPS.indexOf(step)
  const headline = getHeadline({ billing, sourceName, state })
  const headingRef = useRef<HTMLHeadingElement>(null)
  const seenStateRef = useRef<FirstSyncWizardState | null>(null)

  // Focus moves to the headline whenever the state changes, never on the
  // first render: the page load keeps its own focus, and a Start click that
  // removes the button must not drop focus on the body.
  useEffect(() => {
    if (seenStateRef.current !== null && seenStateRef.current !== state) {
      headingRef.current?.focus({ preventScroll: true })
    }

    seenStateRef.current = state
  }, [state])

  return (
    <section
      aria-labelledby="first-sync-wizard-heading"
      className="flex flex-1 flex-col items-center justify-center px-4 pb-20 sm:pb-24"
      data-motion={reduceMotion ? "reduced" : "full"}
      data-state={state}
    >
      <p aria-label={m["app.firstSync.announcements"]()} className="sr-only" role="status">
        {headline}
      </p>

      <motion.div
        animate={{ opacity: 1, y: 0 }}
        className={cn(appPanelClassName, "w-full max-w-xl p-8 sm:p-10")}
        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
        key={state}
        transition={reduceMotion ? { duration: 0 } : STEP_TRANSITION}
      >
        <div className="space-y-5">
          {sourceName === null ? null : (
            <p className="flex items-center gap-2 text-sm text-emerald-600">
              <Check aria-hidden="true" className="size-4" strokeWidth={3} />
              {m["app.firstSync.connected"]({ sourceName })}
            </p>
          )}
          <h2
            className="text-2xl font-semibold tracking-tight outline-none"
            id="first-sync-wizard-heading"
            ref={headingRef}
            tabIndex={-1}
          >
            {headline}
          </h2>
          <StepBody {...props} />
        </div>
      </motion.div>

      <ol aria-label={m["app.firstSync.stepsLabel"]()} className="mt-6 flex items-center gap-2">
        {FIRST_SYNC_WIZARD_STEPS.map((candidate, index) => (
          <li
            aria-current={index === stepIndex ? "step" : undefined}
            className={cn(
              "size-1.5 rounded-full",
              index === stepIndex ? "bg-foreground" : "bg-foreground/25"
            )}
            key={candidate}
          >
            <span className="sr-only">
              {m["app.firstSync.stepProgress"]({
                current: index + 1,
                label: getStepLabel(candidate),
                total: FIRST_SYNC_WIZARD_STEPS.length,
              })}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}

function getStepLabel(step: FirstSyncWizardStep): string {
  switch (step) {
    case "welcome":
      return m["app.firstSync.steps.welcome"]()
    case "connect":
      return m["app.firstSync.steps.connect"]()
    case "plan":
      return m["app.firstSync.steps.plan"]()
    case "sync":
      return m["app.firstSync.steps.sync"]()
    case "done":
      return m["app.firstSync.steps.done"]()
  }
}

function getHeadline({
  billing,
  sourceName,
  state,
}: {
  billing: FirstSyncBilling
  sourceName: string | null
  state: FirstSyncWizardState
}): string {
  switch (state) {
    case "needs_source":
      return m["app.firstSync.needsSource.headline"]()
    case "needs_credits":
      return hasActiveSubscription(billing)
        ? m["app.firstSync.needsCredits.headlineTopUp"]()
        : m["app.firstSync.needsCredits.headlinePlan"]()
    case "billing_unknown":
      return m["app.firstSync.billingUnknown.headline"]()
    case "ready":
      return m["app.firstSync.ready.headline"]()
    case "syncing":
      return m["app.firstSync.syncing.headline"]({ sourceName: sourceName ?? "" })
    case "paused":
      return m["app.firstSync.paused.headline"]()
    case "resumable":
      return m["app.firstSync.resumable.headline"]()
    case "failed":
      return m["app.firstSync.failed.headline"]()
  }
}

function formatCredits(credits: number): string {
  return credits === 1
    ? m["app.firstSync.credits.one"]()
    : m["app.firstSync.credits.many"]({ count: new Intl.NumberFormat(getLocale()).format(credits) })
}

function StepBody({
  billing,
  billingRefreshing = false,
  createWalletSource,
  onRetryBilling,
  onStart,
  resolveName,
  sourceName,
  state,
}: FirstSyncWizardProps) {
  switch (state) {
    case "needs_source":
      return (
        <div className="space-y-5">
          <Body>{m["app.firstSync.needsSource.body"]()}</Body>
          {createWalletSource === undefined ? null : (
            <div className="flex justify-center sm:justify-start">
              <AddWalletCard onResolveName={resolveName} onSubmit={createWalletSource} />
            </div>
          )}
        </div>
      )
    case "needs_credits": {
      const subscribed = hasActiveSubscription(billing)
      return (
        <div className="space-y-3">
          <Body>
            {m["app.firstSync.needsCredits.body"]()}{" "}
            {subscribed
              ? m["app.firstSync.needsCredits.noCredits"]()
              : m["app.firstSync.needsCredits.noPlan"]()}
          </Body>
          <Button asChild size="sm">
            <Link to="/app/billing">
              {subscribed
                ? m["app.firstSync.needsCredits.buyCredits"]()
                : m["app.firstSync.needsCredits.choosePlan"]()}
            </Link>
          </Button>
        </div>
      )
    }
    case "billing_unknown":
      return (
        <div className="space-y-3">
          <Body>{m["app.firstSync.billingUnknown.body"]()}</Body>
          <Button disabled={billingRefreshing} onClick={onRetryBilling} size="sm" type="button">
            {billingRefreshing
              ? m["app.firstSync.billingUnknown.retrying"]()
              : m["app.firstSync.billingUnknown.retry"]()}
          </Button>
        </div>
      )
    case "ready":
      return (
        <div className="space-y-3">
          <Body>
            <CreditsBadge billing={billing} />{" "}
            {m["app.firstSync.ready.body"]({ sourceName: sourceName ?? "" })}
          </Body>
          <Button onClick={onStart} size="sm" type="button">
            {m["app.firstSync.ready.start"]()}
          </Button>
        </div>
      )
    case "syncing":
      return (
        <Body className="flex items-center gap-2">
          <Loader2 aria-hidden="true" className="size-4 shrink-0 motion-safe:animate-spin" />
          {m["app.firstSync.syncing.body"]()}
        </Body>
      )
    case "paused":
      return (
        <div className="space-y-3">
          <Body>{m["app.firstSync.paused.body"]()}</Body>
          <p className="text-xs text-muted-foreground">{m["app.firstSync.paused.hint"]()}</p>
        </div>
      )
    case "resumable":
      return (
        <div className="space-y-3">
          <Body>
            <CreditsBadge billing={billing} /> {m["app.firstSync.resumable.body"]()}
          </Body>
          <Button onClick={onStart} size="sm" type="button">
            {m["app.firstSync.resumable.continue"]()}
          </Button>
        </div>
      )
    case "failed":
      return (
        <div className="space-y-3">
          {/* Generic on purpose (D05): never the job message or lastErrorMessage. */}
          <Body>{m["app.firstSync.failed.body"]()}</Body>
          <Button onClick={onStart} size="sm" type="button">
            {m["app.firstSync.failed.tryAgain"]()}
          </Button>
        </div>
      )
  }
}

function Body({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-sm text-muted-foreground", className)}>{children}</p>
}

function CreditsBadge({ billing }: { billing: FirstSyncBilling }) {
  if (billing === null || !hasUsableCredits(billing)) {
    return null
  }

  return (
    <span className="inline-flex items-center rounded-full bg-foreground/8 px-2.5 py-0.5 text-xs font-medium tabular-nums text-foreground">
      {formatCredits(billing.credits)}
    </span>
  )
}
