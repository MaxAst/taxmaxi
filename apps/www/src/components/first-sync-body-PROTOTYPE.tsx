/*
 * PROTOTYPE — THROWAWAY CODE (#108 T04 gate). Do not ship, polish, or reuse.
 *
 * Question this answers: what form should the never-synced dashboard body take?
 *
 * Three structurally different variants of the never-synced body, mounted on
 * the existing `/app` route (real header, real source cards, real sync island)
 * and switched via `?variant=`. A second param, `?state=`, drives the D03
 * first-sync state from mock facts so every state can be judged. Dev builds
 * only: `FIRST_SYNC_PROTOTYPE_ENABLED` is false in production and in tests.
 *
 *   a — Guided panel: the content sheet becomes one panel. No tabs.
 *   b — Stepped empty state: the tabs stay; the assets tab holds a checklist.
 *   c — Guide rail beside a greyed preview of the dashboard the user is
 *       working toward. Two columns, no tabs until the first sync lands.
 *
 * Variants d–f are ported from draft PR #211 (`onboarding-prototype.tsx` on
 * `claude/issue-108-discussion-696170`), kept as close to that file as the
 * current app allows. Its layout, copy, spacing, and motion are unchanged;
 * only the mounting changed (it now sits in the real dashboard shell with
 * the real source cards and the real island) and its steps were mapped onto
 * the D03 state names. Two pieces were dropped on purpose because the real
 * island now owns them (D06): #211 drew its own progress bar in `syncing`
 * and `paused`, and offered a "Buy N credits" button in `paused`. Both
 * places now show a quiet line that points at the island instead.
 *
 *   d — Full-screen letter wizard (#211 "a"): onboarding owns the page. A
 *       founder letter first, then plan → first sync as single-card steps
 *       with stage dots underneath. No source cards, no sheet.
 *   e — Stepped empty state (#211 "b"): the real dashboard chrome stays; the
 *       sheet holds a greyed portfolio number, a compact founder note, and a
 *       three-step setup checklist.
 *   f — Docked letter panel (#211 "c"): the real dashboard renders dimmed and
 *       blurred behind a fixed panel on the right that carries the letter and
 *       the current step's action.
 *
 * `?state=welcome` is the D09 welcome step, not a D03 state. Its mock facts
 * equal `needs_credits`. Only d and f have a distinct welcome screen; e shows
 * the founder note in every state, so welcome renders like `needs_credits`
 * there (as in #211), and a–c ignore it the same way.
 *
 * Copy is hardcoded English on purpose (placeholder to be judged and
 * rewritten). The real panel uses paraglide. Actions are stubs that move the
 * mock state through the URL; nothing here calls the API. Per D05 the panel
 * never shows raw error text; the mock failed island item carries a raw
 * message so the difference is visible. Per D03/D04 the panel offers
 * Choose a plan / Buy credits only in `needs_credits`, Start in `ready`,
 * Continue in `resumable`, Try again in `failed`, and Retry in
 * `billing_unknown`. Progress and the credit-recovery billing action stay in
 * the island (D06).
 */
import { useEffect, useState, type ReactNode } from "react"
import { useNavigate } from "@tanstack/react-router"
import { ArrowLeft, ArrowRight, Check, CircleDashed, Loader2, X } from "lucide-react"
import { z } from "zod"

import { appPanelClassName } from "#/components/app-workspace"
import type { SourceSyncIslandItem } from "#/components/source-sync-island"
import { Badge } from "#/components/ui/badge"
import { Button } from "#/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs"
import { Eyebrow, Heading, Text } from "#/components/ui/typography"
import type { Account } from "#/lib/dashboard-types"
import { cn } from "#/lib/utils"
import { m } from "#/paraglide/messages"

export const FIRST_SYNC_PROTOTYPE_ENABLED = import.meta.env.DEV && import.meta.env.MODE !== "test"

export const FIRST_SYNC_PROTOTYPE_VARIANTS = ["a", "b", "c", "d", "e", "f"] as const
export type FirstSyncPrototypeVariant = (typeof FIRST_SYNC_PROTOTYPE_VARIANTS)[number]

/** Exact state names from the D03 table (minus `done`, which is the normal dashboard). */
export const FIRST_SYNC_PROTOTYPE_STATES = [
  "needs_credits",
  "ready",
  "syncing",
  "paused",
  "resumable",
  "failed",
  "billing_unknown",
] as const
export type FirstSyncPrototypeState = (typeof FIRST_SYNC_PROTOTYPE_STATES)[number]

/** The D03 states plus the D09 welcome step, which comes first in d and f. */
export const FIRST_SYNC_PROTOTYPE_STEPS = ["welcome", ...FIRST_SYNC_PROTOTYPE_STATES] as const
export type FirstSyncPrototypeStep = (typeof FIRST_SYNC_PROTOTYPE_STEPS)[number]

/** Variants with a distinct welcome screen before the first D03 state. */
const VARIANTS_WITH_WELCOME: ReadonlySet<FirstSyncPrototypeVariant> = new Set(["d", "f"])

function hasWelcomeStep(variant: FirstSyncPrototypeVariant): boolean {
  return VARIANTS_WITH_WELCOME.has(variant)
}

/** Welcome carries the facts of `needs_credits`: a fresh user with no plan yet. */
function toD03State(step: FirstSyncPrototypeStep): FirstSyncPrototypeState {
  return step === "welcome" ? "needs_credits" : step
}

export const firstSyncPrototypeSearchSchema = z.object({
  variant: z.enum(FIRST_SYNC_PROTOTYPE_VARIANTS).optional().catch(undefined),
  state: z.enum(FIRST_SYNC_PROTOTYPE_STEPS).optional().catch(undefined),
})
export type FirstSyncPrototypeSearch = z.infer<typeof firstSyncPrototypeSearchSchema>

const VARIANT_NAMES: Record<FirstSyncPrototypeVariant, string> = {
  a: "Guided panel",
  b: "Stepped empty state",
  c: "Guide rail + preview",
  d: "Full-screen letter · from PR #211",
  e: "Stepped empty state · from PR #211",
  f: "Docked letter panel · from PR #211",
}

const STATE_LABELS: Record<FirstSyncPrototypeStep, string> = {
  welcome: "Welcome",
  needs_credits: "Needs credits",
  ready: "Ready",
  syncing: "Syncing",
  paused: "Paused",
  resumable: "Resumable",
  failed: "Failed",
  billing_unknown: "Billing unknown",
}

/** Used when the signed-in user has no source yet, so the variants still render. */
export const FIRST_SYNC_PROTOTYPE_FALLBACK_SOURCE: Account = {
  id: "prototype-coinbase",
  name: "Coinbase",
  kind: "exchange",
  importedTransactions: 0,
  unresolvedItems: 0,
  lastSync: "Never synced",
}

/* ─────────────────────────────────────────────────────────
 * Mock facts. In the real panel these come from the billing query, the
 * source overviews, and the sync hook's items (D03). Here each state maps
 * to one fixed set of facts.
 * ───────────────────────────────────────────────────────── */

type MockBilling = { credits: number; subscriptionStatus: string | null }

export type FirstSyncPrototypeMock = {
  /** `null` stands for a billing status that failed to load (non-401). */
  billing: MockBilling | null
  islandItems: ReadonlyArray<SourceSyncIslandItem>
  syncingSourceIds: ReadonlySet<string>
}

export function getFirstSyncPrototypeMock(
  step: FirstSyncPrototypeStep,
  target: Account
): FirstSyncPrototypeMock {
  const base = { id: target.id, sourceName: target.name, mode: "sync" as const }

  switch (toD03State(step)) {
    case "needs_credits":
      return {
        billing: { credits: 0, subscriptionStatus: null },
        islandItems: [],
        syncingSourceIds: new Set(),
      }
    case "ready":
      return {
        billing: { credits: 500, subscriptionStatus: "active" },
        islandItems: [],
        syncingSourceIds: new Set(),
      }
    case "syncing":
      return {
        billing: { credits: 500, subscriptionStatus: "active" },
        islandItems: [
          {
            ...base,
            fetchedRecords: 24,
            normalizedRecords: 21,
            phase: "discovering",
            progress: 18,
            status: "running",
          },
        ],
        syncingSourceIds: new Set([target.id]),
      }
    case "paused":
      return {
        billing: { credits: 0, subscriptionStatus: "active" },
        islandItems: [
          {
            ...base,
            creditOutcome: {
              additionalCreditsRequired: 22,
              availableCredits: 0,
              creditsConsumed: 82,
              reasonCode: "no_usable_credits",
            },
            failedRecords: 0,
            fetchedRecords: 104,
            normalizedRecords: 82,
            progress: 100,
            status: "credit_required",
          },
        ],
        syncingSourceIds: new Set(),
      }
    case "resumable":
      return {
        billing: { credits: 40, subscriptionStatus: "active" },
        islandItems: [
          {
            ...base,
            creditOutcome: {
              additionalCreditsRequired: 22,
              availableCredits: 40,
              creditsConsumed: 82,
              reasonCode: "no_usable_credits",
            },
            failedRecords: 0,
            fetchedRecords: 104,
            normalizedRecords: 82,
            progress: 100,
            status: "credit_required",
          },
        ],
        syncingSourceIds: new Set(),
      }
    case "failed":
      return {
        billing: { credits: 500, subscriptionStatus: "active" },
        islandItems: [
          {
            ...base,
            failedRecords: 5,
            fetchedRecords: 104,
            // Raw provider text on purpose: the island may show it (#160 owns
            // that), the panel below must not (D05).
            message: "HTTP 502 from provider: upstream connect error (job 8f3c-…)",
            normalizedRecords: 99,
            progress: 100,
            status: "failed",
          },
        ],
        syncingSourceIds: new Set(),
      }
    case "billing_unknown":
      return { billing: null, islandItems: [], syncingSourceIds: new Set() }
  }
}

/* ─────────────────────────────────────────────────────────
 * Content model shared by the variants. Only words and the single action
 * are shared; every variant owns its own layout.
 * ───────────────────────────────────────────────────────── */

type PanelAction = { label: string; next: FirstSyncPrototypeState }

type PanelContent = {
  chip: string
  chipVariant: "default" | "secondary" | "destructive" | "outline"
  headline: string
  body: string
  action: PanelAction | null
  hint: string
}

function hasActiveSubscription(billing: MockBilling | null): boolean {
  return billing?.subscriptionStatus === "active" || billing?.subscriptionStatus === "trialing"
}

function getPanelContent({
  billing,
  sourceName,
  state,
}: {
  billing: MockBilling | null
  sourceName: string
  state: FirstSyncPrototypeState
}): PanelContent {
  const connected = `${sourceName} is connected. Nothing is imported yet.`
  const credits = billing?.credits ?? 0

  switch (state) {
    case "needs_credits":
      return {
        chip: "Needs credits",
        chipVariant: "secondary",
        headline: connected,
        body: hasActiveSubscription(billing)
          ? "Your plan is active but has no credits left. Importing uses one credit per transaction, so buy credits before the first sync."
          : "Importing your history uses transaction credits, one per transaction. You don't have any yet, so pick a plan first.",
        action: {
          label: hasActiveSubscription(billing) ? "Buy credits" : "Choose a plan",
          next: "ready",
        },
        hint: "Nothing is imported before you have credits.",
      }
    case "ready":
      return {
        chip: "Ready",
        chipVariant: "outline",
        headline: connected,
        body: `You have ${credits} credits. That's enough to start importing ${sourceName}.`,
        action: { label: "Start first sync", next: "syncing" },
        hint: "Nothing starts until you click.",
      }
    case "syncing":
      return {
        chip: "Syncing",
        chipVariant: "default",
        headline: "Your first sync is underway.",
        body: "TaxMaxi is fetching and sorting your transactions. Your dashboard fills in when it finishes.",
        action: null,
        hint: "Progress shows at the top of the page. You can leave and come back.",
      }
    case "paused":
      return {
        chip: "Paused",
        chipVariant: "destructive",
        headline: "Your first sync paused safely.",
        body: "It ran out of credits part-way. Everything fetched so far is kept, and it continues where it stopped once you add credits.",
        action: null,
        hint: "Add credits from the notice at the top of the page.",
      }
    case "resumable":
      return {
        chip: "Ready to continue",
        chipVariant: "outline",
        headline: "Credits are available again.",
        body: `${credits} credits are available. Continue and the sync picks up where it stopped.`,
        action: { label: "Continue first sync", next: "syncing" },
        hint: "Nothing is charged twice.",
      }
    case "failed":
      return {
        chip: "Didn't finish",
        chipVariant: "destructive",
        headline: "Your first sync didn't finish.",
        // Generic on purpose (D05): never the job message or lastErrorMessage.
        body: "Something went wrong on our side while importing. Nothing was lost, and you can try again now.",
        action: { label: "Try again", next: "syncing" },
        hint: "If it keeps failing, we're on it.",
      }
    case "billing_unknown":
      return {
        chip: "Plan status unknown",
        chipVariant: "secondary",
        headline: connected,
        body: "We couldn't load your plan status, so we can't tell yet whether a sync can start.",
        action: { label: "Retry", next: "ready" },
        hint: "Starting is unavailable until plan status loads.",
      }
  }
}

type Fact = { label: string; value: string }

function getFacts({
  billing,
  sourceName,
  state,
}: {
  billing: MockBilling | null
  sourceName: string
  state: FirstSyncPrototypeState
}): ReadonlyArray<Fact> {
  const plan =
    billing === null
      ? "Unknown"
      : billing.subscriptionStatus === null
        ? "None"
        : billing.subscriptionStatus === "trialing"
          ? "Trial"
          : "Annual"
  const credits = billing === null ? "—" : String(billing.credits)
  const importStatus =
    state === "syncing"
      ? "In progress"
      : state === "paused" || state === "resumable"
        ? "Paused"
        : state === "failed"
          ? "Stopped"
          : "Not started"

  return [
    { label: "Source", value: `${sourceName} · connected` },
    { label: "Plan", value: plan },
    { label: "Credits", value: credits },
    { label: "Import", value: importStatus },
  ]
}

type StepStatus = "done" | "active" | "upcoming"
type Step = {
  key: "connect" | "credits" | "import"
  title: string
  detail: string
  status: StepStatus
}

function getSteps({
  billing,
  sourceName,
  state,
}: {
  billing: MockBilling | null
  sourceName: string
  state: FirstSyncPrototypeState
}): ReadonlyArray<Step> {
  const credits = billing?.credits ?? 0
  const creditsStep: Step = (() => {
    switch (state) {
      case "needs_credits":
        return {
          key: "credits",
          title: "Get transaction credits",
          detail: "Importing uses one credit per transaction. You have none yet.",
          status: "active",
        }
      case "billing_unknown":
        return {
          key: "credits",
          title: "Get transaction credits",
          detail: "Plan status couldn't be loaded.",
          status: "active",
        }
      case "paused":
        return {
          key: "credits",
          title: "Add credits",
          detail:
            "The import ran out of credits part-way. Add credits from the notice at the top of the page.",
          status: "active",
        }
      default:
        return {
          key: "credits",
          title: "Transaction credits",
          detail: `${credits} credits available.`,
          status: "done",
        }
    }
  })()
  const importStep: Step = (() => {
    switch (state) {
      case "needs_credits":
      case "billing_unknown":
        return {
          key: "import",
          title: "Import your history",
          detail: "One explicit click starts the first sync.",
          status: "upcoming",
        }
      case "paused":
        return {
          key: "import",
          title: "Import your history",
          detail: "Paused. Continues where it stopped once credits are added.",
          status: "upcoming",
        }
      case "ready":
        return {
          key: "import",
          title: "Import your history",
          detail: "Start it when you are ready.",
          status: "active",
        }
      case "syncing":
        return {
          key: "import",
          title: "Importing your history",
          detail: "Underway. Progress shows at the top of the page.",
          status: "active",
        }
      case "resumable":
        return {
          key: "import",
          title: "Continue the import",
          detail: "Continues where it stopped. Nothing is charged twice.",
          status: "active",
        }
      case "failed":
        return {
          key: "import",
          title: "Import your history",
          detail: "The first attempt didn't finish. Nothing was lost.",
          status: "active",
        }
    }
  })()

  return [
    {
      key: "connect",
      title: `Connect ${sourceName}`,
      detail: "Done. TaxMaxi created the source; nothing is imported yet.",
      status: "done",
    },
    creditsStep,
    importStep,
  ]
}

/* ─────────────────────────────────────────────────────────
 * Entry point rendered by the dashboard. `renderDashboard` wraps a sheet body
 * in the real source cards; a–c and e render inside it, d replaces it, and f
 * dims it behind a docked panel.
 * ───────────────────────────────────────────────────────── */

export function FirstSyncBodyPrototype({
  renderDashboard,
  state: step,
  targetSource,
  variant,
}: {
  renderDashboard: (sheet: ReactNode) => ReactNode
  state: FirstSyncPrototypeStep
  targetSource: Account
  variant: FirstSyncPrototypeVariant
}) {
  const navigate = useNavigate({ from: "/app" })
  const mock = getFirstSyncPrototypeMock(step, targetSource)
  const d03State = toD03State(step)
  const model = { billing: mock.billing, sourceName: targetSource.name, state: d03State }
  const content = getPanelContent(model)
  const facts = getFacts(model)
  const steps = getSteps(model)

  const setSearch = (updates: FirstSyncPrototypeSearch) => {
    void navigate({
      replace: true,
      to: ".",
      search: (previous) => ({ ...previous, ...updates }),
    })
  }

  const onAction = (action: PanelAction) => setSearch({ state: action.next })
  const variantProps = { content, facts, onAction, steps }
  const letterProps: LetterProps = {
    additionalCreditsRequired: mock.islandItems[0]?.creditOutcome?.additionalCreditsRequired ?? 0,
    billing: mock.billing,
    onGoTo: (next) => setSearch({ state: next }),
    sourceName: targetSource.name,
    step: hasWelcomeStep(variant) ? step : d03State,
  }

  return (
    <>
      {variant === "a" ? renderDashboard(<VariantGuidedPanel {...variantProps} />) : null}
      {variant === "b" ? renderDashboard(<VariantSteppedEmptyState {...variantProps} />) : null}
      {variant === "c" ? renderDashboard(<VariantGuideRailPreview {...variantProps} />) : null}
      {variant === "d" ? <VariantFullScreenLetter {...letterProps} /> : null}
      {variant === "e" ? renderDashboard(<VariantLetterChecklist {...letterProps} />) : null}
      {variant === "f" ? (
        <VariantDockedLetterPanel {...letterProps} renderDashboard={renderDashboard} />
      ) : null}
      <PrototypeSwitcher
        mock={mock}
        onExit={() => setSearch({ state: undefined, variant: undefined })}
        onSelectState={(next) => setSearch({ state: next })}
        onSelectVariant={(next) =>
          setSearch({
            variant: next,
            // Leaving d or f while on the welcome step: the target has no
            // welcome screen, so land on the state that shares its facts.
            ...(step === "welcome" && !hasWelcomeStep(next) ? { state: "needs_credits" } : {}),
          })
        }
        step={step}
        variant={variant}
      />
    </>
  )
}

type VariantProps = {
  content: PanelContent
  facts: ReadonlyArray<Fact>
  onAction: (action: PanelAction) => void
  steps: ReadonlyArray<Step>
}

/** The one action block. Renders the single action or, without one, only the hint. */
function ActionRow({
  align = "start",
  content,
  onAction,
  size = "lg",
}: {
  align?: "start" | "center"
  content: PanelContent
  onAction: (action: PanelAction) => void
  size?: "sm" | "default" | "lg"
}) {
  return (
    <div className={cn("flex flex-col gap-3", align === "center" ? "items-center" : "items-start")}>
      {content.action ? (
        <Button onClick={() => onAction(content.action as PanelAction)} size={size} type="button">
          {content.action.label}
          <ArrowRight aria-hidden="true" data-icon="inline-end" />
        </Button>
      ) : (
        <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          {content.chip === "Syncing" ? (
            <Loader2 aria-hidden="true" className="size-4 motion-safe:animate-spin" />
          ) : null}
          {content.chip === "Syncing" ? "Sync in progress" : "Waiting for credits"}
        </span>
      )}
      <Text size="bodySm" tone="muted" align={align === "center" ? "center" : "left"}>
        {content.hint}
      </Text>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────
 * Variant A — guided panel.
 * The content sheet is the panel. No tabs, no portfolio number: before the
 * first sync there is nothing to tabulate, so the sheet says what is true
 * (connected, not imported), shows the facts that decide the next step, and
 * offers exactly one action. Reads top to bottom like a short letter.
 * ───────────────────────────────────────────────────────── */

function VariantGuidedPanel({ content, facts, onAction }: VariantProps) {
  return (
    <div className="flex min-w-0 flex-col gap-8 py-8 sm:py-10">
      <div className="max-w-2xl space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Eyebrow tone="muted">First sync</Eyebrow>
          <Badge variant={content.chipVariant}>{content.chip}</Badge>
        </div>
        <Heading as="h2" size="page">
          {content.headline}
        </Heading>
        <Text size="bodyLg" tone="muted">
          {content.body}
        </Text>
      </div>

      <dl className="grid grid-cols-2 gap-x-8 gap-y-5 border-y border-border/60 py-5 sm:grid-cols-4">
        {facts.map((fact) => (
          <div className="min-w-0" key={fact.label}>
            <dt className="text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-muted-foreground">
              {fact.label}
            </dt>
            <dd className="mt-1 truncate text-sm font-medium tabular-nums">{fact.value}</dd>
          </div>
        ))}
      </dl>

      <ActionRow content={content} onAction={onAction} />
    </div>
  )
}

/* ─────────────────────────────────────────────────────────
 * Variant B — stepped empty state inside the tabs.
 * The dashboard keeps its shape: the greyed portfolio number, the three
 * tabs. The assets tab carries a three-step checklist (connect, credits,
 * import) with the action on the active step. The other tabs say they are
 * empty and point back to the checklist, so there is only one Start.
 * ───────────────────────────────────────────────────────── */

function VariantSteppedEmptyState({ content, onAction, steps }: VariantProps) {
  const [tab, setTab] = useState("assets")

  return (
    <div className="flex min-w-0 flex-col gap-8 py-6 sm:py-8">
      <div className="space-y-1">
        <p className="text-3xl font-semibold tabular-nums text-muted-foreground/40 sm:text-5xl">
          —
        </p>
        <Text size="bodySm" tone="muted">
          Your portfolio value appears after the first sync.
        </Text>
      </div>

      <Tabs className="gap-y-8" onValueChange={setTab} value={tab}>
        <TabsList>
          <TabsTrigger value="assets">{m["app.dashboard.tabs.assets"]()}</TabsTrigger>
          <TabsTrigger value="transactions">{m["app.dashboard.tabs.transactions"]()}</TabsTrigger>
          <TabsTrigger value="taxes">{m["app.dashboard.tabs.taxes"]()}</TabsTrigger>
        </TabsList>
        <TabsContent value="assets">
          <ol className="flex flex-col gap-7 rounded-lg border border-border p-6 sm:p-8">
            {steps.map((step) => (
              <li className="flex gap-4" key={step.key}>
                <StepIcon status={step.status} />
                <div className="min-w-0 flex-1 pt-0.5">
                  <p
                    className={cn(
                      "text-sm font-medium",
                      step.status === "upcoming" ? "text-muted-foreground" : undefined
                    )}
                  >
                    {step.title}
                  </p>
                  <Text className="mt-1" size="bodySm" tone="muted">
                    {step.detail}
                  </Text>
                  {step.status === "active" ? (
                    <div className="mt-4 max-w-md">
                      <Text className="mb-4" size="bodySm">
                        {content.body}
                      </Text>
                      <ActionRow content={content} onAction={onAction} size="default" />
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </TabsContent>
        <TabsContent value="transactions">
          <TabEmptyNote
            onGoToSetup={() => setTab("assets")}
            title="No transactions imported yet."
            body="Your transactions appear here after the first sync."
          />
        </TabsContent>
        <TabsContent value="taxes">
          <TabEmptyNote
            onGoToSetup={() => setTab("assets")}
            title="No tax report yet."
            body="A report needs imported transactions first."
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function TabEmptyNote({
  body,
  onGoToSetup,
  title,
}: {
  body: string
  onGoToSetup: () => void
  title: string
}) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-border p-6">
      <p className="text-sm font-medium">{title}</p>
      <Text size="bodySm" tone="muted">
        {body}
      </Text>
      <Button onClick={onGoToSetup} size="sm" type="button" variant="outline">
        Go to setup
      </Button>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────
 * Variant C — guide rail beside a preview.
 * Two columns. Left: a vertical three-step rail with the action on the
 * active step. Right: a greyed, non-interactive preview of the dashboard
 * (portfolio number, tab strip, table rows) so the user sees what the first
 * sync unlocks. Stacks on small screens with the rail first.
 * ───────────────────────────────────────────────────────── */

function VariantGuideRailPreview({ content, onAction, steps }: VariantProps) {
  return (
    <div className="grid min-w-0 gap-10 py-6 sm:py-8 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] md:gap-12">
      <aside className="flex min-w-0 flex-col gap-6">
        <div className="flex flex-wrap items-center gap-3">
          <Eyebrow tone="muted">First sync</Eyebrow>
          <Badge variant={content.chipVariant}>{content.chip}</Badge>
        </div>
        <ol className="flex flex-col">
          {steps.map((step, index) => (
            <li className="relative flex gap-4 pb-7 last:pb-0" key={step.key}>
              {index < steps.length - 1 ? (
                <span
                  aria-hidden="true"
                  className="absolute top-7 bottom-0 left-3 w-px bg-border"
                />
              ) : null}
              <StepIcon status={step.status} />
              <div className="min-w-0 flex-1 pt-0.5">
                <p
                  className={cn(
                    "text-sm font-medium",
                    step.status === "upcoming" ? "text-muted-foreground" : undefined
                  )}
                >
                  {step.title}
                </p>
                <Text className="mt-1" size="bodySm" tone="muted">
                  {step.detail}
                </Text>
                {step.status === "active" ? (
                  <div className="mt-4">
                    <ActionRow content={content} onAction={onAction} size="default" />
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      </aside>

      <div aria-hidden="true" className="relative min-w-0 select-none">
        <div className="pointer-events-none opacity-70 [mask-image:linear-gradient(180deg,black_30%,transparent_100%)]">
          <p className="text-3xl font-semibold tabular-nums text-muted-foreground/40 sm:text-5xl">
            —
          </p>
          <div className="mt-8 inline-flex h-9 items-center gap-1 rounded-full bg-muted p-1 text-sm text-muted-foreground">
            <span className="rounded-full bg-background px-3 py-1 text-foreground/60">
              {m["app.dashboard.tabs.assets"]()}
            </span>
            <span className="px-3 py-1">{m["app.dashboard.tabs.transactions"]()}</span>
            <span className="px-3 py-1">{m["app.dashboard.tabs.taxes"]()}</span>
          </div>
          <div className="mt-8 space-y-3">
            {[0, 1, 2, 3, 4, 5].map((row) => (
              <div className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-4" key={row}>
                <span className="h-4 rounded bg-foreground/8" />
                <span className="h-4 rounded bg-foreground/6" />
                <span className="h-4 rounded bg-foreground/6" />
                <span className="h-4 rounded bg-foreground/6" />
              </div>
            ))}
          </div>
        </div>
        <div className="absolute inset-x-0 top-[55%] flex justify-center">
          <span className="rounded-full bg-background/80 px-3 py-1 text-xs text-muted-foreground ring-1 ring-border backdrop-blur-sm">
            Fills in after your first sync
          </span>
        </div>
      </div>
    </div>
  )
}

function StepIcon({ status }: { status: StepStatus }) {
  if (status === "done") {
    return (
      <span className="relative z-10 grid size-6 shrink-0 place-items-center rounded-full bg-primary/15 text-primary">
        <Check aria-hidden="true" className="size-3.5" strokeWidth={3} />
      </span>
    )
  }

  if (status === "active") {
    return (
      <span className="relative z-10 grid size-6 shrink-0 place-items-center rounded-full bg-foreground text-background">
        <ArrowRight aria-hidden="true" className="size-3.5" strokeWidth={2.5} />
      </span>
    )
  }

  return (
    <span className="relative z-10 grid size-6 shrink-0 place-items-center rounded-full bg-background text-muted-foreground ring-1 ring-border">
      <CircleDashed aria-hidden="true" className="size-3.5" />
    </span>
  )
}

/* ─────────────────────────────────────────────────────────
 * PR #211 port — shared copy atoms. Only copy and tiny value blocks are
 * shared; d, e, and f each own their layout. Copy is #211's, with the source
 * name in place of "Coinbase" because the real shell names the real source.
 * ───────────────────────────────────────────────────────── */

type LetterProps = {
  additionalCreditsRequired: number
  billing: MockBilling | null
  onGoTo: (next: FirstSyncPrototypeStep) => void
  sourceName: string
  step: FirstSyncPrototypeStep
}

function FounderLetterBody({
  compact = false,
  sourceName,
}: {
  compact?: boolean
  sourceName: string
}) {
  return (
    <div className={cn("space-y-3 leading-relaxed", compact ? "text-sm" : "text-base")}>
      <p>
        Thanks for trying TaxMaxi. I&rsquo;m building it to be the last crypto tax tool you&rsquo;ll
        ever need.
      </p>
      <p>
        That&rsquo;s a big promise, so here is what it stands on: we put you first, we are open
        &mdash; literally, the code is public &mdash; and everything is modular, so TaxMaxi grows
        with whatever you do on-chain.
      </p>
      <p>
        {sourceName} is connected and TaxMaxi has created a source for it. Nothing has been imported
        yet &mdash; you decide when that happens.
      </p>
    </div>
  )
}

function FounderSignature() {
  return (
    <p className="font-serif text-xl italic" style={{ fontFamily: "cursive" }}>
      &mdash; Max
    </p>
  )
}

function CreditBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-foreground/8 px-2.5 py-0.5 text-xs font-medium tabular-nums">
      {children}
    </span>
  )
}

/**
 * #211's `StepActionBlock` mapped onto the D03 states. `syncing` and `paused`
 * point at the island instead of drawing a second progress bar or a billing
 * button (D06); `resumable`, `failed`, and `billing_unknown` did not exist in
 * #211 and follow its phrasing.
 */
function LetterActionBlock({
  additionalCreditsRequired,
  billing,
  onGoTo,
  sourceName,
  step,
}: LetterProps) {
  const credits = billing?.credits ?? 0

  switch (step) {
    case "welcome":
      return (
        <Button onClick={() => onGoTo("needs_credits")} size="sm" type="button">
          Set up my first import
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Button>
      )
    case "needs_credits":
      return (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Importing your history uses transaction credits &mdash; one credit per transaction.{" "}
            {hasActiveSubscription(billing)
              ? "Your plan is active but has no credits left, so top up before the first sync."
              : "You don’t have a plan yet, so there are no credits to spend."}
          </p>
          <Button onClick={() => onGoTo("ready")} size="sm" type="button">
            {hasActiveSubscription(billing) ? "Buy credits" : "Choose a plan"}
          </Button>
        </div>
      )
    case "ready":
      return (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            You have <CreditBadge>{credits} credits</CreditBadge> &mdash; enough to import your{" "}
            {sourceName} history. Nothing starts until you say so.
          </p>
          <Button onClick={() => onGoTo("syncing")} size="sm" type="button">
            Start my first sync
          </Button>
        </div>
      )
    case "syncing":
      return (
        <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 aria-hidden="true" className="size-4 shrink-0 motion-safe:animate-spin" />
          Importing your {sourceName} history. Progress shows at the top of the page.
        </p>
      )
    case "paused":
      return (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Your credits ran out mid-import. {additionalCreditsRequired} more credits cover the rest
            &mdash; everything fetched so far is kept, and the sync continues where it stopped.
          </p>
          <p className="text-xs text-muted-foreground">
            Add credits from the notice at the top of the page.
          </p>
        </div>
      )
    case "resumable":
      return (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            You have <CreditBadge>{credits} credits</CreditBadge> again &mdash; enough to finish the
            import. It continues where it stopped, and nothing is charged twice.
          </p>
          <Button onClick={() => onGoTo("syncing")} size="sm" type="button">
            Continue my first sync
          </Button>
        </div>
      )
    case "failed":
      return (
        <div className="space-y-3">
          {/* Generic on purpose (D05): never the job message or lastErrorMessage. */}
          <p className="text-sm text-muted-foreground">
            Something went wrong on our side while importing. Nothing was lost, and you can try
            again now.
          </p>
          <Button onClick={() => onGoTo("syncing")} size="sm" type="button">
            Try again
          </Button>
        </div>
      )
    case "billing_unknown":
      return (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            We couldn&rsquo;t load your plan status, so we can&rsquo;t tell yet whether a sync can
            start.
          </p>
          <Button onClick={() => onGoTo("ready")} size="sm" type="button">
            Retry
          </Button>
        </div>
      )
  }
}

/* ─────────────────────────────────────────────────────────
 * Variant D — full-screen letter wizard (#211 "a").
 * Onboarding takes over the page; the dashboard does not exist until setup
 * is done. Personal, focused, zero distraction. One card, stage dots below.
 * Sits inside the dashboard's page wrapper (top padding, min height), so the
 * card centers in the space under the header.
 * ───────────────────────────────────────────────────────── */

const WIZARD_STAGES = ["Welcome", "Plan", "First sync", "Done"] as const

function wizardStageIndex(step: FirstSyncPrototypeStep): number {
  switch (step) {
    case "welcome":
      return 0
    case "needs_credits":
    case "billing_unknown":
    case "ready":
      return 1
    case "syncing":
    case "paused":
    case "resumable":
    case "failed":
      return 2
  }
}

function wizardHeadline({
  billing,
  sourceName,
  step,
}: Pick<LetterProps, "billing" | "sourceName" | "step">): string {
  switch (step) {
    case "welcome":
      return ""
    case "needs_credits":
      return hasActiveSubscription(billing)
        ? "Top up credits to unlock your import"
        : "Pick a plan to unlock your import"
    case "billing_unknown":
      return "We couldn’t check your plan"
    case "ready":
      return "Ready when you are"
    case "syncing":
      return `Importing your ${sourceName} history`
    case "paused":
      return "Sync paused — more credits needed"
    case "resumable":
      return "Ready to continue"
    case "failed":
      return "Your first sync didn’t finish"
  }
}

function VariantFullScreenLetter(props: LetterProps) {
  const { sourceName, step } = props
  const stageIndex = wizardStageIndex(step)

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 pb-20 sm:pb-24">
      <div className={cn(appPanelClassName, "w-full max-w-xl p-8 sm:p-10")}>
        {step === "welcome" ? (
          <div className="space-y-5">
            <p className="text-3xl font-semibold tracking-tight">Hi, I&rsquo;m Max.</p>
            <FounderLetterBody sourceName={sourceName} />
            <FounderSignature />
            <div className="pt-2">
              <LetterActionBlock {...props} />
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex items-center gap-2 text-sm text-emerald-600">
              <Check aria-hidden="true" className="size-4" strokeWidth={3} />
              {sourceName} connected
            </div>
            <p className="text-2xl font-semibold tracking-tight">{wizardHeadline(props)}</p>
            <LetterActionBlock {...props} />
          </div>
        )}
      </div>

      <div aria-hidden="true" className="mt-6 flex items-center gap-2">
        {WIZARD_STAGES.map((stage, index) => (
          <span
            className={cn(
              "size-1.5 rounded-full",
              index === stageIndex ? "bg-foreground" : "bg-foreground/25"
            )}
            key={stage}
            title={stage}
          />
        ))}
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────
 * Variant E — stepped empty state with a founder note (#211 "b").
 * The real dashboard chrome stays: the source card sits in the fan, and the
 * content sheet (where the tabs normally live) becomes a setup checklist with
 * a compact founder note on top. The welcome step is not distinct here: the
 * note is always visible and welcome renders like `needs_credits`.
 * ───────────────────────────────────────────────────────── */

type ChecklistState = "done" | "active" | "upcoming"

function checklistStates(
  step: FirstSyncPrototypeStep
): [ChecklistState, ChecklistState, ChecklistState] {
  switch (step) {
    case "welcome":
    case "needs_credits":
    case "billing_unknown":
      return ["done", "active", "upcoming"]
    case "ready":
    case "syncing":
    case "paused":
    case "resumable":
    case "failed":
      return ["done", "done", "active"]
  }
}

function ChecklistIcon({ state }: { state: ChecklistState }) {
  if (state === "done") {
    return (
      <span className="grid size-6 place-items-center rounded-full bg-emerald-500/15 text-emerald-600">
        <Check aria-hidden="true" className="size-3.5" strokeWidth={3} />
      </span>
    )
  }

  if (state === "active") {
    return (
      <span className="grid size-6 place-items-center rounded-full bg-foreground text-background">
        <Loader2 aria-hidden="true" className="size-3.5" />
      </span>
    )
  }

  return (
    <span className="grid size-6 place-items-center rounded-full text-muted-foreground">
      <CircleDashed aria-hidden="true" className="size-4" />
    </span>
  )
}

function VariantLetterChecklist(props: LetterProps) {
  const { billing, sourceName, step } = props
  const [connectState, planState, syncState] = checklistStates(step)
  const credits = billing?.credits ?? 0

  return (
    <div className="flex min-w-0 flex-col gap-8 py-6 sm:py-8">
      <div className="flex flex-col gap-1">
        <p className="text-3xl font-semibold tabular-nums text-muted-foreground/60 sm:text-5xl">
          &mdash;
        </p>
        <p className="text-sm text-muted-foreground">
          No data yet. Finish the setup below to fill this in.
        </p>
      </div>

      <div className="rounded-xl border border-border/60 bg-background/40 p-4">
        <p className="text-sm font-medium">A note from Max</p>
        <div className="mt-2 text-muted-foreground">
          <FounderLetterBody compact sourceName={sourceName} />
        </div>
        <div className="mt-3">
          <FounderSignature />
        </div>
      </div>

      <ol className="flex flex-col gap-6">
        <li className="flex gap-3">
          <ChecklistIcon state={connectState} />
          <div className="min-w-0 flex-1 pt-0.5">
            <p className="text-sm font-medium">Connect {sourceName}</p>
            <p className="text-xs text-muted-foreground">
              Done &mdash; TaxMaxi created your {sourceName} source.
            </p>
          </div>
        </li>
        <li className="flex gap-3">
          <ChecklistIcon state={planState} />
          <div className="min-w-0 flex-1 pt-0.5">
            <p className="text-sm font-medium">Get transaction credits</p>
            {planState === "active" ? (
              <div className="mt-2 max-w-md">
                <LetterActionBlock {...props} step={toD03State(step)} />
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {step === "paused"
                  ? "Used up mid-import. Add credits from the notice at the top of the page."
                  : `Covered — ${credits} credits available.`}
              </p>
            )}
          </div>
        </li>
        <li className="flex gap-3">
          <ChecklistIcon state={syncState} />
          <div className="min-w-0 flex-1 pt-0.5">
            <p className="text-sm font-medium">Import your history</p>
            {syncState === "active" ? (
              <div className="mt-2 max-w-md">
                <LetterActionBlock {...props} />
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                One explicit click starts your first sync.
              </p>
            )}
          </div>
        </li>
      </ol>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────
 * Variant F — docked letter panel over a dimmed dashboard (#211 "c").
 * The real dashboard renders as a dimmed, blurred, non-interactive preview so
 * the user can see what they are working toward; a fixed panel on the right
 * carries the letter and the current step's action. #211 sharpened the
 * dashboard on `done`; here `done` is the normal dashboard, so the prototype
 * simply exits.
 * ───────────────────────────────────────────────────────── */

function VariantDockedLetterPanel({
  renderDashboard,
  ...props
}: LetterProps & { renderDashboard: (sheet: ReactNode) => ReactNode }) {
  const { sourceName, step } = props

  return (
    <>
      <div
        aria-hidden="true"
        className="pointer-events-none select-none opacity-50 blur-[2px] transition-[filter,opacity] duration-500"
      >
        {renderDashboard(
          <div className="flex min-w-0 flex-col gap-8 py-6 sm:py-8">
            <p className="text-3xl font-semibold tabular-nums text-muted-foreground/50 sm:text-5xl">
              &euro;&thinsp;&mdash;
            </p>
            <div className="space-y-3">
              {[0, 1, 2, 3, 4].map((row) => (
                <div
                  className="h-10 animate-pulse rounded-lg bg-foreground/6"
                  key={row}
                  style={{ animationDelay: `${row * 120}ms` }}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <aside
        aria-label="Setup"
        className={cn(
          appPanelClassName,
          "fixed top-24 right-4 bottom-8 z-40 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-5 overflow-y-auto p-6"
        )}
      >
        <div>
          <p className="text-xl font-semibold tracking-tight">Hi, I&rsquo;m Max.</p>
          <div className="mt-3 text-muted-foreground">
            <FounderLetterBody compact sourceName={sourceName} />
          </div>
          <div className="mt-3">
            <FounderSignature />
          </div>
        </div>

        <div className="border-t border-border/60 pt-4">
          <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
            {STATE_LABELS[step]}
          </p>
          <div className="mt-3">
            <LetterActionBlock {...props} />
          </div>
        </div>
      </aside>
    </>
  )
}

/* ─────────────────────────────────────────────────────────
 * Floating switcher — obviously not part of the design under review.
 * Arrows (and ← →) cycle variants; chips pick the state; the last line
 * surfaces the mock facts behind the current state.
 * ───────────────────────────────────────────────────────── */

function PrototypeSwitcher({
  mock,
  onExit,
  onSelectState,
  onSelectVariant,
  step,
  variant,
}: {
  mock: FirstSyncPrototypeMock
  onExit: () => void
  onSelectState: (step: FirstSyncPrototypeStep) => void
  onSelectVariant: (variant: FirstSyncPrototypeVariant) => void
  step: FirstSyncPrototypeStep
  variant: FirstSyncPrototypeVariant
}) {
  const chips: ReadonlyArray<FirstSyncPrototypeStep> = hasWelcomeStep(variant)
    ? FIRST_SYNC_PROTOTYPE_STEPS
    : FIRST_SYNC_PROTOTYPE_STATES

  const cycle = (direction: 1 | -1) => {
    const index = FIRST_SYNC_PROTOTYPE_VARIANTS.indexOf(variant)
    const count = FIRST_SYNC_PROTOTYPE_VARIANTS.length
    const next = FIRST_SYNC_PROTOTYPE_VARIANTS[(index + direction + count) % count]

    if (next !== undefined) {
      onSelectVariant(next)
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return
      }

      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return
      }

      cycle(event.key === "ArrowRight" ? 1 : -1)
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  })

  const islandStatus = mock.islandItems[0]?.status ?? "none"
  const factsLine =
    mock.billing === null
      ? `billing: failed to load · island: ${islandStatus}`
      : `credits: ${mock.billing.credits} · plan: ${mock.billing.subscriptionStatus ?? "none"} · island: ${islandStatus}`

  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-1.5 rounded-2xl bg-zinc-950 px-3 py-2 font-interface text-white shadow-xl ring-1 ring-white/10">
      <div className="flex items-center gap-2">
        <button
          aria-label="Previous variant"
          className="grid size-7 place-items-center rounded-full hover:bg-white/10"
          onClick={() => cycle(-1)}
          type="button"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
        </button>
        <span className="min-w-64 text-center text-xs font-medium">
          {variant.toUpperCase()} · {VARIANT_NAMES[variant]}
        </span>
        <button
          aria-label="Next variant"
          className="grid size-7 place-items-center rounded-full hover:bg-white/10"
          onClick={() => cycle(1)}
          type="button"
        >
          <ArrowRight aria-hidden="true" className="size-4" />
        </button>
        <button
          aria-label="Exit prototype"
          className="grid size-7 place-items-center rounded-full text-white/60 hover:bg-white/10"
          onClick={onExit}
          type="button"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-1">
        {chips.map((candidate) => (
          <button
            aria-pressed={candidate === step}
            className={cn(
              "rounded-full px-2 py-0.5 text-[0.625rem] font-medium",
              candidate === step ? "bg-white text-zinc-950" : "text-white/60 hover:bg-white/10"
            )}
            key={candidate}
            onClick={() => onSelectState(candidate)}
            type="button"
          >
            {STATE_LABELS[candidate]}
          </button>
        ))}
      </div>
      <p className="text-[0.625rem] tabular-nums text-white/45">PROTOTYPE · {factsLine}</p>
    </div>
  )
}
