import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { Link } from "@tanstack/react-router"
import { motion, useReducedMotion } from "motion/react"
import { ArrowRight, Check, Loader2 } from "lucide-react"

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
 * The welcome is the wizard's first step (D09), shown while the account's
 * `welcomeSeenAt` is null (D01): a short letter from the founder over three
 * screens, plus a video screen only when {@link FIRST_SYNC_WELCOME_VIDEO_ID}
 * is set. Continue on the last screen, Skip, and Escape finish it; the
 * dashboard then records the fact on the server. The welcome shows ahead of
 * the state-derived step and also over `done`, so a user whose sources already
 * synced sees it once and then the normal dashboard.
 *
 * The wizard owns Start, Continue, and Try again, all through the sync hook's
 * start function (D06). Progress and dismissal stay in the island, so
 * `syncing` only points at it. In `paused` the island owns the billing action
 * while it shows its `credit_required` item; once that item is dismissed, or
 * before one exists, the wizard offers Choose a plan or Buy credits itself
 * (D03, T05 review). The wizard never renders `lastErrorMessage` or a job's
 * `message` (D05): the failed step has one generic sentence, and no such text
 * reaches this component.
 */

/**
 * YouTube video id for the optional welcome video screen (#108 D09). Ships as
 * `null`, which leaves the screen out. Set it to add the screen between the
 * values and the sign-off.
 */
export const FIRST_SYNC_WELCOME_VIDEO_ID: string | null = null

/** The states the wizard has a step body for; `done` is the normal dashboard. */
type FirstSyncWizardState = Exclude<FirstSyncState, "done">

/**
 * Steps in D06 order. `welcome` shows while `welcomeSeenAt` is null; `done`
 * is the normal dashboard.
 */
const FIRST_SYNC_WIZARD_STEPS = ["welcome", "connect", "plan", "sync", "done"] as const
type FirstSyncWizardStep = (typeof FIRST_SYNC_WIZARD_STEPS)[number]

function getFirstSyncWizardStep(state: FirstSyncState): FirstSyncWizardStep {
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
    case "done":
      return "done"
  }
}

/** The welcome screens in order (#108 D09); `video` only when a video id is set. */
const WELCOME_SCREENS = ["promise", "values", "video", "signoff"] as const
type WelcomeScreen = (typeof WELCOME_SCREENS)[number]

function getWelcomeScreens(videoId: string | null): ReadonlyArray<WelcomeScreen> {
  return videoId === null ? WELCOME_SCREENS.filter((screen) => screen !== "video") : WELCOME_SCREENS
}

const STEP_TRANSITION = { duration: 0.25, ease: [0.22, 1, 0.36, 1] as const }

export type FirstSyncWizardProps = {
  billing: FirstSyncBilling
  /** True while a billing retry is in flight; the retry button waits for it. */
  billingRefreshing?: boolean
  createWalletSource?: (walletAddress: string) => Promise<void>
  /**
   * True while the island shows an item for the target source. In `paused`
   * the island then owns the billing action; otherwise the wizard offers it.
   */
  islandItemShown: boolean
  onRetryBilling: () => void
  /** Start, Continue, and Try again: one call to the hook's start function for the target source. */
  onStart: () => void
  /**
   * Continue on the last welcome screen, Skip, and Escape: one call, after
   * which the dashboard records the welcome as seen (#108 D01, D09).
   */
  onWelcomeFinish: () => void
  resolveName?: (name: string) => Promise<NameResolution>
  /** Name of the target source, or null while there is none. */
  sourceName: string | null
  state: FirstSyncState
  /** True while `welcomeSeenAt` is null and the user has not continued or skipped yet. */
  welcomePending: boolean
  /** YouTube video id for the optional welcome video screen; null leaves it out. */
  welcomeVideoId: string | null
}

export function FirstSyncWizard(props: FirstSyncWizardProps) {
  const { billing, onWelcomeFinish, sourceName, state, welcomePending, welcomeVideoId } = props
  const reduceMotion = useReducedMotion() === true
  const [welcomeScreenIndex, setWelcomeScreenIndex] = useState(0)
  const welcomeScreens = getWelcomeScreens(welcomeVideoId)
  const welcomeScreen = welcomePending
    ? welcomeScreens[Math.min(welcomeScreenIndex, welcomeScreens.length - 1)]
    : null
  const step = welcomeScreen === null ? getFirstSyncWizardStep(state) : "welcome"
  const stepIndex = FIRST_SYNC_WIZARD_STEPS.indexOf(step)
  // One key per screen the user can be on: a welcome screen or a D03 state.
  const screenKey = welcomeScreen === null ? state : `welcome:${welcomeScreen}`
  const headline = getScreenHeadline({ billing, sourceName, state, welcomeScreen })
  const headingRef = useRef<HTMLHeadingElement>(null)
  const seenScreenRef = useRef<string | null>(null)

  // Focus moves to the headline whenever the screen changes, never on the
  // first render: the page load keeps its own focus, and a Start click that
  // removes the button must not drop focus on the body.
  useEffect(() => {
    if (seenScreenRef.current !== null && seenScreenRef.current !== screenKey) {
      headingRef.current?.focus({ preventScroll: true })
    }

    seenScreenRef.current = screenKey
  }, [screenKey])

  // Escape skips the welcome (#108 T07). Only while the welcome shows, and
  // only when no other surface took the key first: an open overlay or menu
  // (Radix) handles Escape in the capture phase and prevents its default, so
  // the key reaches this listener untouched only while nothing else is open.
  // Where focus sits does not matter: Escape on a header button skips too.
  useEffect(() => {
    if (welcomeScreen === null) {
      return
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return
      }

      event.preventDefault()
      onWelcomeFinish()
    }

    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [onWelcomeFinish, welcomeScreen])

  // Unreachable from the dashboard, which swaps to the tabs in `done` once
  // the welcome is over; typed so the welcome can show over `done`.
  if (welcomeScreen === null && state === "done") {
    return null
  }

  return (
    <section
      aria-labelledby="first-sync-wizard-heading"
      className="flex flex-1 flex-col items-center justify-center px-4 pb-20 sm:pb-24"
      data-motion={reduceMotion ? "reduced" : "full"}
      data-state={welcomeScreen === null ? state : "welcome"}
    >
      <p aria-label={m["app.firstSync.announcements"]()} className="sr-only" role="status">
        {headline}
      </p>

      <motion.div
        animate={{ opacity: 1, y: 0 }}
        className={cn(appPanelClassName, "w-full max-w-xl p-8 sm:p-10")}
        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
        key={screenKey}
        transition={reduceMotion ? { duration: 0 } : STEP_TRANSITION}
      >
        {welcomeScreen === null ? (
          <div className="space-y-5">
            {sourceName === null ? null : (
              <p className="flex items-center gap-2 text-sm text-emerald-600">
                <Check aria-hidden="true" className="size-4" strokeWidth={3} />
                {m["app.firstSync.connected"]({ sourceName })}
              </p>
            )}
            <WizardHeading className="text-2xl" headingRef={headingRef}>
              {headline}
            </WizardHeading>
            <StepBody {...props} />
          </div>
        ) : (
          <WelcomeStep
            headingRef={headingRef}
            headline={headline}
            onFinish={onWelcomeFinish}
            onNext={() => setWelcomeScreenIndex((index) => index + 1)}
            screen={welcomeScreen}
            screenNumber={welcomeScreens.indexOf(welcomeScreen) + 1}
            screenTotal={welcomeScreens.length}
            videoId={welcomeVideoId}
          />
        )}
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

/**
 * The heading of the screen the user is on. Empty for `done` without a
 * welcome, which the dashboard never renders.
 */
function getScreenHeadline({
  billing,
  sourceName,
  state,
  welcomeScreen,
}: {
  billing: FirstSyncBilling
  sourceName: string | null
  state: FirstSyncState
  welcomeScreen: WelcomeScreen | null
}): string {
  if (welcomeScreen !== null) {
    return getWelcomeHeadline(welcomeScreen)
  }

  return state === "done" ? "" : getHeadline({ billing, sourceName, state })
}

/**
 * The one heading the section is labelled by and focus moves to on each
 * screen change. Both the welcome and the state steps render it.
 */
function WizardHeading({
  children,
  className,
  headingRef,
}: {
  children: string
  className: string
  headingRef: RefObject<HTMLHeadingElement | null>
}) {
  return (
    <h2
      className={cn("font-semibold tracking-tight outline-none", className)}
      id="first-sync-wizard-heading"
      ref={headingRef}
      tabIndex={-1}
    >
      {children}
    </h2>
  )
}

function getWelcomeHeadline(screen: WelcomeScreen): string {
  switch (screen) {
    case "promise":
      return m["app.firstSync.welcome.promise.headline"]()
    case "values":
      return m["app.firstSync.welcome.values.headline"]()
    case "video":
      return m["app.firstSync.welcome.video.headline"]()
    case "signoff":
      return m["app.firstSync.welcome.signoff.headline"]()
  }
}

/**
 * One welcome screen: the founder letter's heading, its text, and a row with
 * Skip and Next, or Continue on the last screen (#108 D09).
 */
function WelcomeStep({
  headingRef,
  headline,
  onFinish,
  onNext,
  screen,
  screenNumber,
  screenTotal,
  videoId,
}: {
  headingRef: RefObject<HTMLHeadingElement | null>
  headline: string
  onFinish: () => void
  onNext: () => void
  screen: WelcomeScreen
  screenNumber: number
  screenTotal: number
  videoId: string | null
}) {
  const last = screenNumber === screenTotal

  return (
    <div className="space-y-5">
      <WizardHeading className="text-3xl" headingRef={headingRef}>
        {headline}
      </WizardHeading>
      <WelcomeScreenBody screen={screen} videoId={videoId} />
      <div className="flex items-center justify-between gap-3 pt-2">
        <p className="text-xs text-muted-foreground tabular-nums">
          {m["app.firstSync.welcome.screenProgress"]({
            current: screenNumber,
            total: screenTotal,
          })}
        </p>
        <div className="flex items-center gap-2">
          {last ? null : (
            <Button onClick={onFinish} size="sm" type="button" variant="ghost">
              {m["app.firstSync.welcome.skip"]()}
            </Button>
          )}
          <Button onClick={last ? onFinish : onNext} size="sm" type="button">
            {last ? m["app.firstSync.welcome.continue"]() : m["app.firstSync.welcome.next"]()}
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}

function WelcomeScreenBody({ screen, videoId }: { screen: WelcomeScreen; videoId: string | null }) {
  switch (screen) {
    case "promise":
      return (
        <Letter>
          <p>{m["app.firstSync.welcome.promise.thanks"]()}</p>
          <p>{m["app.firstSync.welcome.promise.next"]()}</p>
        </Letter>
      )
    case "values":
      return (
        <Letter>
          <p>{m["app.firstSync.welcome.values.intro"]()}</p>
          <ul className="space-y-3">
            <WelcomeValue
              body={m["app.firstSync.welcome.values.usersFirst.body"]()}
              title={m["app.firstSync.welcome.values.usersFirst.title"]()}
            />
            <WelcomeValue
              body={m["app.firstSync.welcome.values.open.body"]()}
              title={m["app.firstSync.welcome.values.open.title"]()}
            />
            <WelcomeValue
              body={m["app.firstSync.welcome.values.modular.body"]()}
              title={m["app.firstSync.welcome.values.modular.title"]()}
            />
          </ul>
        </Letter>
      )
    case "video":
      return (
        <Letter>
          <p>{m["app.firstSync.welcome.video.body"]()}</p>
          {videoId === null ? null : (
            <div className="aspect-video overflow-hidden rounded-xl bg-foreground/5">
              <iframe
                allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
                className="size-full border-0"
                loading="lazy"
                referrerPolicy="strict-origin-when-cross-origin"
                src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}`}
                title={m["app.firstSync.welcome.video.title"]()}
              />
            </div>
          )}
        </Letter>
      )
    case "signoff":
      return (
        <Letter>
          <p>{m["app.firstSync.welcome.signoff.yourCall"]()}</p>
          <p>{m["app.firstSync.welcome.signoff.writeToMe"]()}</p>
          <div className="pt-1">
            <p className="font-handwriting text-3xl leading-none">
              {m["app.firstSync.welcome.signoff.signature"]()}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {m["app.firstSync.welcome.signoff.founder"]()}
            </p>
          </div>
        </Letter>
      )
  }
}

function Letter({ children }: { children: ReactNode }) {
  return <div className="space-y-3 text-base leading-relaxed">{children}</div>
}

function WelcomeValue({ body, title }: { body: string; title: string }) {
  return (
    <li className="flex gap-3">
      <Check
        aria-hidden="true"
        className="mt-1.5 size-4 shrink-0 text-emerald-600"
        strokeWidth={3}
      />
      <p>
        <span className="font-semibold">{title}</span>{" "}
        <span className="text-muted-foreground">{body}</span>
      </p>
    </li>
  )
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
  islandItemShown,
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
          <BillingLink billing={billing} />
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
      // The island owns the billing action only while its item is shown. After
      // a dismissal, or before the reconnect seed has produced an item, the
      // wizard offers the same action itself (#108 D03, T05 review; D04).
      return (
        <div className="space-y-3">
          <Body>{m["app.firstSync.paused.body"]()}</Body>
          {islandItemShown ? (
            <p className="text-xs text-muted-foreground">{m["app.firstSync.paused.hint"]()}</p>
          ) : (
            <BillingLink billing={billing} />
          )}
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
    case "done":
      // The dashboard shows the tabs instead of the wizard in `done`.
      return null
  }
}

function Body({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-sm text-muted-foreground", className)}>{children}</p>
}

/** Choose a plan, or Buy credits with an active or trialing subscription (#108 D04). */
function BillingLink({ billing }: { billing: FirstSyncBilling }) {
  return (
    <Button asChild size="sm">
      <Link to="/app/billing">
        {hasActiveSubscription(billing)
          ? m["app.firstSync.needsCredits.buyCredits"]()
          : m["app.firstSync.needsCredits.choosePlan"]()}
      </Link>
    </Button>
  )
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
