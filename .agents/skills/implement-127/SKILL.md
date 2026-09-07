---
name: implement-127
description: "Implement one delivery task from selected transaction inspector (#127). Pass the task ID as the argument, e.g. /implement-127 T01."
disable-model-invocation: true
---

Implement exactly one task from the delivery checklist of issue #127 (feat(transactions): load the selected transaction inspector). The task ID is given as the argument. If no argument is given, ask which task to do, then stop.

## Allowed tasks

Run only the assigned next unchecked task from the live checklist, sequentially from merged main: T01 factual detail; T02 run-backed calculation and audit projections; T03 REST and both SDKs; T04 responsive inspector; T05 refresh; T06 Harvest with the harvest skill.

T01–T03 may proceed in order. T04 requires #269's shared presentation seam to be merged and its actual paths recorded in the task before implementation. Refuse T04 while that prerequisite remains unmet; do not absorb #269. T05 follows T04. T06 follows completed proof and checks for T01–T05. #150 is delivered; the old hold is superseded. Report missing writer facts or needed result changes before coding. Every task is result-preserving for existing facts, outputs, lists, and writers.

- The latest recorded decisions on #127 always govern over this file. If this file and a newer recorded decision disagree, follow the decision and say so in the PR.

## Reading at pickup

Read before coding; refresh tracker state at handoffs and decision changes, reusing unchanged reference docs.

1. `gh issue view 127 --comments` — the body is the plan; the newest recorded decision wins.
2. `AGENTS.md`, especially "Delivery PRs and Reviews".
3. Read `docs/adr/0007-versioned-calculation-runs.md` for immutable run identity and snapshot scope; `0008-factual-results-with-treatment-codes.md` for exact facts and machine-readable treatment; `0011-principal-asset-overrides.md` for independent current asset projections; `0012-stored-facts-carry-their-links.md` for lookup-only evidence; and `0013-movement-corrections-feed-accounting-inputs.md` for stable targets, exact totals, retained history and captured inputs. These filenames are under `docs/adr/`. Read `docs/agents/delivery-process.md` and `docs/agents/issue-tracker.md` for proof, checks, ownership and public-data rules. The closing records of #126, #149 and #150 explain the delivered foundations; newer ADR decisions govern.
4. The glossary of the owning context (`CONTEXT.md`, via `CONTEXT-MAP.md`) — use its vocabulary for naming.

## Coordination rules

Refresh open PRs at pickup. At arming, PR #211 owns onboarding UI and `apps/www/src/routes/app.tsx`; #210 owns the proposed worker queue replacement, its server/worker/sync/persistence job files and CI; #179 and #176 own proposed core glossary/ADR work. None is authority to widen this task. #269 separately owns shared run-status/blocker/treatment presentation and blocks T04. Coordinate overlapping files with the orchestrator and stop for out-of-surface conflicts. Never revert another worker's changes.

- Rebase on latest `origin/main` before opening the PR, and again before merging.
- The cross-stream rules (one migration in flight, out-of-surface conflicts stop the worker) live in `docs/agents/delivery-process.md` ("Execution") — follow them from there, including "Worker ownership and handoff". Use "Pre-launch migration planning" for schema work and existing authorization.

## Scope fence

- Do only the one task.
- Every rule governing your PR — coherent sizing and cut review, the merged-main file-cut recheck, fixture alignment as a category, result classification with pasted decisions, facts recorded at the writer, values meaning what their type says — lives in `AGENTS.md` ("Delivery PRs and Reviews", "Critical Guidelines", Database) and `docs/agents/delivery-process.md` ("Delivery checklist rules"). Enforce them from those documents; when this file lags them, they win.
- The behaviors those rules demand of you mid-task: stop and say so when the task outgrows its cut; record a file-list correction on the issue before coding around it; stop when a fix starts matching, grouping, or counting stored rows to find which decision applies (ADR 0012 — a recorded fact is missing).

## Domain rules that bite

- D01: canonical ID plus explicit tax year, authenticated principal, DE/EUR; same owned-source and produced-leg boundary as the list. Missing, foreign and activity IDs share not-found behavior. Existing list is unchanged.
- D02: follow recorded raw/leg/origin/fee/transfer/reconciliation/target links. Return safe retained evidence and explicit unavailable history; no raw payloads or credentials. Reuse existing projection and target-discovery contracts. Never infer disappeared targets' old transaction links.
- D03: capture one active run and its metadata/results in a consistent snapshot. Read stored money and treatment only through recorded links. Keep exact decimal strings, unknown null, known zero; no active run has null reference. Partial known facts remain visible as partial. No recalculation or matching recreated legs to old events.
- D04: separate current system/user/effective facts, attention, replay work and actual covering-run facts. Captured inputs say what the displayed run consumed. Keep total-value input authoritative; rounded unit preview never reconstructs the total.
- D05: shared localized inspector content across desktop/mobile. Key detail by canonical ID/year, enabled only while selected; use jurisdiction calendar for initial year. Protect against stale responses, preserve scope/selection, show missing IDs explicitly, and stop pending-work polling on settlement/close/change. Invalidate list on observed run change.
- No accounting policy, writer, schema, migration, override editor, search, reconciliation approval, CLI inspector, or global status/job-system work. Read the issue's exact D-note wording and paste the applicable notes verbatim in the PR.

## Seams for TDD

The live issue's Testing and seams table is the exact answer key and file cut.

- T01: new transaction-detail repository integration suite proves ownership/activity exclusion, no writes, equal movements, exact fee/custody/evidence links and explicit unavailable evidence.
- T02: real correction acceptance and CalculationRunService recompute prove purchase 2 tokens / total 20 / disposal 30 gives basis 20, proceeds 30, gain 10; replacement total 30 gives basis 30 and gain 0 with old run unchanged. Prove current/captured distinction, withdrawal history, total 1 / quantity 3 / rounded preview 0.333333333333333333, zero/null, replay IDs and a race at the detail snapshot boundary.
- T03: TransactionsApiLive integration tests and both SDK styles reach actual T02 stored results through HTTP, with exact values, history and 200/404/400/auth behavior. Existing list remains unchanged.
- T04: dashboard/table/inspector/query tests prove on-demand ID/year, desktop/mobile parity, keyboard/touch/focus, retry/404/error and out-of-order responses.
- T05: real query invalidation through SDK fixtures proves delayed new run and gain 0, preserved scope/selection, missing detail, external corrections and polling termination.

Prior art: TransactionsApiLive.integration.test.ts, principal-transaction-override-repository.integration.test.ts, principal-transaction-override-application.integration.test.ts, SDK transaction-overrides.test.ts and web dashboard/query tests. Use synthetic fixtures and the existing database harness. No live providers or original database changes. Use mise for all Node/package commands and port 0 for listeners.

Apply "Grounding and proof" in `docs/agents/delivery-process.md`: complete this task's mapped proof as its seams become available.

## Done criteria

1. Apply `docs/agents/delivery-process.md` ("Validation and test reliability"): choose local checks by the change, retain explicit task/hosted gates, and rerun invalidated checks. AGENTS.md's red-gate rule still applies; an isolated pass is diagnostic, not replacement proof.
2. /code-review the work.
3. Branch from latest `main`. Conventional commit with `Refs: #127` in the footer.
4. Hand off head/base, changed files, check evidence, remaining work and blockers per the process doc. Open a PR referencing #127 and the task ID, stating the result classification, with every relied-on decision pasted verbatim with its source.
