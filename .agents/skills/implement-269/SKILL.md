---
name: implement-269
description: "Implement one delivery task from calculation status and treatment presentation (#269). Pass the task ID as the argument, e.g. /implement-269 T01."
disable-model-invocation: true
---

Implement exactly one task from the delivery checklist of issue #269 (feat(frontend): show calculation run status, blockers, and treatment codes in the app). The task ID is given as the argument. If no argument is given, ask which task to do, then stop.

## Allowed tasks

Run the assigned next unchecked task only: T01 refresh, T02 run status and blockers, T03 treatment disclosure, then T04 Harvest with the harvest skill. Tasks are sequential from merged main. No initial human approval gate. Refuse a task whose predecessor is unmerged. T01–T03 are result-changing presentation work; T04 is result-preserving cleanup. Read exact decisions from the live issue and paste the required D-notes verbatim into each PR.

- The latest recorded decisions on #269 always govern over this file. If this file and a newer recorded decision disagree, follow the decision and say so in the PR.

## Reading at pickup

Read before coding; refresh tracker state at handoffs and decision changes, reusing unchanged reference docs.

1. `gh issue view 269 --comments` — the body is the plan; the newest recorded decision wins.
2. `AGENTS.md`, especially "Delivery PRs and Reviews".
3. Read docs/adr/0007-versioned-calculation-runs.md for returned run identity; docs/adr/0008-factual-results-with-treatment-codes.md for per-result treatment; docs/adr/0012-stored-facts-carry-their-links.md for recorded associations. Read docs/agents/delivery-process.md and docs/agents/issue-tracker.md for validation, ownership, and public-data rules.
4. The glossary of the owning context (`CONTEXT.md`, via `CONTEXT-MAP.md`) — use its vocabulary for naming.

## Coordination rules

Refresh open PRs at pickup. At arming, #127 T01–T03 are merged; its T04 inspector is explicitly held until #269 shared presentation merges. Do not build that full inspector here. PR #211 overlaps apps/www/src/routes/app.tsx for onboarding; #210 proposes worker queue replacement; #179 and #176 own core glossary/ADR proposals. Preserve others’ edits and report out-of-surface conflicts. #196–#198 remain separate.

- Rebase on latest `origin/main` before opening the PR, and again before merging.
- The cross-stream rules (one migration in flight, out-of-surface conflicts stop the worker) live in `docs/agents/delivery-process.md` ("Execution") — follow them from there, including "Worker ownership and handoff". Use "Pre-launch migration planning" for schema work and existing authorization.

## Scope fence

- Do only the one task.
- Every rule governing your PR — coherent sizing and cut review, the merged-main file-cut recheck, fixture alignment as a category, result classification with pasted decisions, facts recorded at the writer, values meaning what their type says — lives in `AGENTS.md` ("Delivery PRs and Reviews", "Critical Guidelines", Database) and `docs/agents/delivery-process.md` ("Delivery checklist rules"). Enforce them from those documents; when this file lags them, they win.
- The behaviors those rules demand of you mid-task: stop and say so when the task outgrows its cut; record a file-list correction on the issue before coding around it; stop when a fix starts matching, grouping, or counting stored rows to find which decision applies (ADR 0012 — a recorded fact is missing).

## Domain rules that bite

- D01: preserve the source island design, motion, completion/dismissal, retry/replay and credit actions. Calculation refresh survives dismissal and never keeps source jobs running. No accounting changes.
- D02: positions stay paired with the returned activeRun, including partial runs. Null active run is unavailable, not zero. Latest running/failed runs do not erase active positions. Portfolio run scope is current-year DE/EUR; keep it separate from existing 2025 tax cards. Blockers remain whole-calculation counts under source filters.
- D03: visible 30-second refresh, focus/reconnect refresh, immediate source-completion refresh; 2 seconds while latest run is running or during the bounded 60-second locally observed sync window. Hidden/unmounted/unauthenticated stops intervals. Errors have bounded retries. Neither changed IDs nor elapsed time prove sync coverage. Preserve an explicit unconfirmed-results notice after the local window. Invalidate dependent source overviews, lists and open detail once per changed active run ID. Scope changes and delayed responses must not mislabel positions.
- D04: blocker sum is not affected transaction count; localize known codes, retain exact unknown codes. Partial active and failed/updating latest may coexist. Request failure differs from calculation failure. Refresh reads only.
- D05: lazy detail get by explicit ID/year; present returned run/year, individual allocations/income and their exact treatment codes. Localize the three specified codes, preserve unknown/empty and decimal/null semantics. No per-collapsed-row requests or browser accounting.
- No REST/SDK/schema/writer changes, source observability work, full inspector, new global status machinery, or tax-rule interpretation.

## Seams for TDD

Use the issue Testing and seams table as the exact proof map. T01: existing Dashboard tests with QueryClient/controlled SDK delivery prove A=1.25 → running B with A retained → active B=2.50, one dependent invalidation, reload discovery after 90 seconds, fast-window expiry, hidden/focus/unmount/auth cleanup and source response isolation. T02: extend for unavailable/complete/partial/failed/request-error matrix, counts 2+1=3, unknown codes, scope and meaningful live announcements. T03: table/query/Dashboard tests prove three known treatment codes, future.example, empty codes, 0.123456789012345678, null gain, lazy ID/year isolation and open-detail invalidation. Run existing source-sync hook/island tests and required browser checks. Keep existing test seams; no backend harness.

Apply "Grounding and proof" in `docs/agents/delivery-process.md`: complete this task's mapped proof as its seams become available.

## Done criteria

1. Apply `docs/agents/delivery-process.md` ("Validation and test reliability"): choose local checks by the change, retain explicit task/hosted gates, and rerun invalidated checks. AGENTS.md's red-gate rule still applies; an isolated pass is diagnostic, not replacement proof.
2. /code-review the work.
3. Branch from latest `main`. Conventional commit with `Refs: #269` in the footer.
4. Hand off head/base, changed files, check evidence, remaining work and blockers per the process doc. Open a PR referencing #269 and the task ID, stating the result classification, with every relied-on decision pasted verbatim with its source.
