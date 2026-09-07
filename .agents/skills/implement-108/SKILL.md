---
name: implement-108
description: "Implement one delivery task from first-sync onboarding (#108). Pass the task ID as the argument, e.g. /implement-108 T01."
disable-model-invocation: true
---

Implement exactly one task from the delivery checklist of issue #108 (feat(www): onboard new users with a welcome and guided first sync). The task ID is given as the argument. If no argument is given, ask which task to do, then stop.

## Allowed tasks

Run the assigned next unchecked task only. Order: T01 welcome fact, T02 overview `jobId`, T03 reload reconnect, T04 prototype gate, T05 state and panel, T06 billing return, T07 welcome sequence, T08 browser verification, T09 Harvest with the `harvest` skill. Tasks are sequential from merged `main`; refuse a task whose predecessor is unmerged and say why.

- T04 is a gate. Run the `prototype` skill on its UI branch, commit to a throwaway branch, link it from #108 with a verdict comment, and stop. No production files change. Draft PR #211 (branch `claude/issue-108-discussion-696170`) is an older three-variant prototype of the same question; read it as reference material, do not merge it.
- T05 is blocked until the maintainer has recorded the approved variant on #108. Refuse T05 without that comment.
- T08 changes no code. It records redacted results on #108 and files gaps or fix PRs.
- Every task is result-preserving. Say so in the PR and paste the D-notes the task names verbatim from the live issue body.
- The latest recorded decisions on #108 always govern over this file. If this file and a newer recorded decision disagree, follow the decision and say so in the PR.

## Reading at pickup

Read before coding; refresh tracker state at handoffs and decision changes, reusing unchanged reference docs.

1. `gh issue view 108 --comments` — the body is the plan; the newest recorded decision wins.
2. `AGENTS.md`, especially "Delivery PRs and Reviews".
3. `docs/adr/0004-dispatch-coinbase-oauth-by-stored-intent.md` — the callback provisions the Coinbase source and never starts a sync; the panel keeps sync an explicit click. `docs/adr/0012-stored-facts-carry-their-links.md` — the welcome fact is written by its own endpoint and `jobId` is read from the stored job row, never inferred. `docs/agents/delivery-process.md` for validation, ownership, and migration rules. `docs/agents/issue-tracker.md` for what T08 may post publicly.
4. The glossary of the owning context (`apps/www/CONTEXT.md`, via `CONTEXT-MAP.md`) — use its vocabulary for naming.

## Coordination rules

Refresh open PRs at pickup. Active streams at arming: #127 T04/T05 (transaction inspector) may open PRs touching `apps/www/src/components/transactions-table.tsx`, `apps/www/src/components/dashboard.tsx`, `apps/www/src/integrations/taxmaxi/queries.ts`, and `apps/www/src/routes/app.tsx`; #269 T04 is a harvest with no code. Preserve others' edits in shared files and report out-of-surface conflicts. PR #210 (Postgres worker queue) is parked reference material with its own migration; it is not an active stream. PRs #179 and #176 are docs drafts. T01 carries this spec's only migration.

- Rebase on latest `origin/main` before opening the PR, and again before merging.
- The cross-stream rules (one migration in flight, out-of-surface conflicts stop the worker) live in `docs/agents/delivery-process.md` ("Execution") — follow them from there, including "Worker ownership and handoff". Use "Pre-launch migration planning" for schema work and existing authorization.

## Scope fence

- Do only the one task.
- Every rule governing your PR — coherent sizing and cut review, the merged-main file-cut recheck, fixture alignment as a category, result classification with pasted decisions, facts recorded at the writer, values meaning what their type says — lives in `AGENTS.md` ("Delivery PRs and Reviews", "Critical Guidelines", Database) and `docs/agents/delivery-process.md` ("Delivery checklist rules"). Enforce them from those documents; when this file lags them, they win.
- The behaviors those rules demand of you mid-task: stop and say so when the task outgrows its cut; record a file-list correction on the issue before coding around it; stop when a fix starts matching, grouping, or counting stored rows to find which decision applies (ADR 0012 — a recorded fact is missing).

## Domain rules that bite

- D01: the welcome gate is one server fact, `welcome_seen_at`, nullable, stamped with server time by `POST /auth/me/welcome`. A second call keeps the first timestamp. No local-storage flag. Finish and Skip both call it.
- D02: `latestSync.jobId` comes from `processing_jobs.id` in the same query that reads the job status. Reload seeds only from `pending`, `processing`, or `credit_required` jobs with a `jobId`. Never re-seed `failed` or `completed`.
- D03: first-sync state is a pure function of overviews, billing status, and the hook's in-memory items. Never stored. The panel shows only while at least one source exists and none has `lastSyncedAt`. Zero sources behaves as today. Use the exact state names from the D03 table.
- D04: "usable credits" means `credits` ≥ 1, mirroring `assertHasSyncCredits`. The panel only picks which action to show; the server stays the enforcer. Buy credits when `subscriptionStatus` is `active` or `trialing`, otherwise Choose a plan.
- D05: the panel never renders `lastErrorMessage` or a job's `message`. Failed states use one generic localized message. Island text is unchanged (#160 owns it).
- D06: the island owns progress, dismissal, its retry, and the billing action. The panel owns Start, Continue, and Try again, all through the hook's existing start function. No second floating surface, no island motion changes.
- D07: the billing overlay writes refreshed status into the `billingStatus` query cache and invalidates it on close. The panel reads that cache through `useQuery`.
- D08: the `/app` loader loads account and billing next to sources and overviews. Any 401 redirects to login. A non-401 billing failure does not block; the panel shows `billing_unknown` with a retry.
- D09: welcome has three to four short steps and a founder sign-off. The video step renders only when the video id constant is set; it ships empty.
- Sync never starts without an explicit click. No accounting changes. No REST or schema changes beyond D01 and D02. Every user-visible string is a paraglide message in `en.json` and `de.json`.

## Seams for TDD

Use the issue's Testing and seams table as the exact proof map. T01: `AuthApiLive.integration.test.ts` proves `welcomeSeenAt: null`, then an ISO timestamp, then the same timestamp after a second mark. T02: `SourcesApiLive.integration.test.ts` proves `latestSync.jobId` equals the started job and `null` for a source without jobs. T03: `use-source-syncs.test.tsx` proves a `queued` seed fetches the job once and keeps polling, a `failed` seed creates no item, and a `credit_required` seed carries `additionalCreditsRequired: 22` from the job read. T05: `first-sync-state.test.ts` has one case per D03 row; `first-sync-panel.test.tsx` proves copy and actions per state, single explicit Start, and no raw error text; `dashboard.test.tsx` proves the body swap and the joined completion transition; `app-loader.test.ts` proves account and billing loading with `billing: null` on non-401 failure. T06: `billing-page.test.tsx` and `dashboard.test.tsx` prove the cache write of `credits: 5` and the `needs_credits` → `ready` and `paused` → `resumable` moves without remount; Continue calls start once for the same source. T07: `welcome-sequence.test.tsx` proves render once, Skip and Finish each mark once, focus trap and restore, Escape skips, reduced motion. Prior art: `dashboard.test.tsx`, `use-source-syncs.test.tsx`, `source-sync-island.test.tsx`, `billing-page.test.tsx`.

Apply "Grounding and proof" in `docs/agents/delivery-process.md`: complete this task's mapped proof as its seams become available.

## Done criteria

1. Apply `docs/agents/delivery-process.md` ("Validation and test reliability"): choose local checks by the change, retain explicit task/hosted gates, and rerun invalidated checks. AGENTS.md's red-gate rule still applies; an isolated pass is diagnostic, not replacement proof.
2. /code-review the work.
3. Branch from latest `main`. Conventional commit with `Refs: #108` in the footer.
4. Hand off head/base, changed files, check evidence, remaining work and blockers per the process doc. Open a PR referencing #108 and the task ID, stating the result classification, with every relied-on decision pasted verbatim with its source.
