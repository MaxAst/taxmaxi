---
name: implement-150
description: "Implement one delivery task from audited movement corrections (#150). Pass the task ID as the argument, e.g. /implement-150 T01."
disable-model-invocation: true
---

Implement exactly one task from the delivery checklist of issue #150 (feat(tax): apply audited user overrides to transaction calculations). The task ID is given as the argument. If no argument is given, ask which task to do, then stop.

## Allowed tasks

T01–T13 are sequential: run only the assigned unchecked task after all predecessors merge. T01 publishes the prepared ADR 0013, ADR 0011 clarification, and core glossary from the originating working copy before any later task. T02 is incomplete until the implementer verifies local source replay and the orchestrator reviews proof that every regenerated leg carries its exact target, including equal-amount and same-token fee cases. T12 requires all gates and review green; T13 runs harvest. Any newly proposed deletion requires a comparison gate approved by Max first. Refuse tasks whose prerequisites or approval gates are unmet. #277 stays paused; this skill does not authorize its implementation.

- The latest recorded decisions on #150 always govern over this file. If this file and a newer recorded decision disagree, follow the decision and say so in the PR.

## Fixed reading list (always, before any code)

1. `gh issue view 150 --comments` — the body is the plan; the newest recorded decision wins.
2. `AGENTS.md`, especially "Delivery PRs and Reviews".
3. `docs/adr/0005-stateless-accounting-engine.md` (pure engine), `0006-accounting-events-record-facts.md` (facts versus tax meaning), `0007-versioned-calculation-runs.md` (immutable runs), `0008-factual-results-with-treatment-codes.md` (computed treatment), `0010-append-only-accounting-choices.md` (elections remain separate), `0011-principal-asset-overrides.md` (existing history/replay/coverage), `0012-stored-facts-carry-their-links.md` (writer-recorded identity), and `0013-movement-corrections-feed-accounting-inputs.md` (movement correction boundary; T01 publishes the prepared draft). All listed ADRs are under `docs/adr/`. Read `docs/agents/delivery-process.md` and `docs/agents/issue-tracker.md` for delivery and privacy rules.
4. The glossary of the owning context (`CONTEXT.md`, via `CONTEXT-MAP.md`) — use its vocabulary for naming.

## Coordination rules

Read open PRs and the live tracker before pickup; this file is not a stream registry. At arming, open PRs are #211 (frontend onboarding prototype), #210 (Postgres worker queue proposal), #179 (core glossary/ADR proposal), and #176 (report glossary/ADR proposal). Do not adopt their unmerged designs. Check their current changed files before touching a shared surface, especially migrations and core docs. #150 preserves the existing queue transport. Keep #268 ownership approval, #267 automatic pricing, #270 general recomputation triggers, #151 reports, #127 inspector UI, and #153 tasks outside this delivery.

- Rebase on latest `origin/main` before opening the PR, and again before merging.
- The cross-stream rules (one migration in flight, out-of-surface conflicts stop the worker) live in `docs/agents/delivery-process.md` ("Execution") — follow them from there.

## Scope fence

- Do only the one task.
- Every rule governing your PR — sizing and the ~15-file tripwire, the merged-main file-cut recheck, fixture alignment as a category, result classification with pasted decisions, facts recorded at the writer, values meaning what their type says — lives in `AGENTS.md` ("Delivery PRs and Reviews", "Critical Guidelines", Database) and `docs/agents/delivery-process.md` ("Delivery checklist rules"). Enforce them from those documents; when this file lags them, they win.
- The behaviors those rules demand of you mid-task: stop and say so when the task outgrows its cut; record a file-list correction on the issue before coding around it; stop when a fix starts matching, grouping, or counting stored rows to find which decision applies (ADR 0012 — a recorded fact is missing).

## Domain rules that bite

- D01: one principal-owned source movement, with stable producer evidence/component identity recorded by the writer. No generated leg UUID, list-position target, or stored-row shape matching. Missing/ambiguous identity blocks affected activity while unrelated records continue.
- D02: exact tagged unit-price or total-value decimal input in calculation reporting currency. Preserve explicit zero and unknown separately. Preserve authoritative entered totals; a non-terminating unit preview is rounded half away from zero to 18 fractional places and never multiplied back. No JavaScript numbers or legacy eight-decimal fiat storage. User valuation wins only when applicable and stays labelled user evidence.
- D03: only the recorded supported inbound/outbound causes; validate direction and structure. Fees retain their fee relationship. Approved custody structure, asset overrides, quantities, ownership, and tax rules are unchanged. Treatment is derived by the engine; passive staking asserted by a user is never provider-confirmed evidence.
- D04: independent append-only price/classification streams. Actor, time, reason, inspected facts/revision, payload, and supersession links survive. Atomic revision and stream-leaf checks; conflicts create neither history nor jobs. Missing and foreign targets share not-found. Structural changes withhold application and require attention; ordinary system changes leave active corrections visibly stale. Never erase or retarget history.
- D05: apply once at the factual-ledger loader after asset/technical eligibility in the repeatable-read snapshot. Reuse atomic durable replay scheduling and follow-ups; no queue calls inside SQL transactions or second scheduler. Record exact correction inputs and snapshot coverage in immutable runs. Equal-valued history changes still change revisions. Include later-year disposals in existing principal recomputation.
- D06: use the issue's exact synthetic acceptance values and blockers. Preserve original unknown facts, earlier partial runs, and other principals. Keep real user financial data out of public issues and PRs.
- Migrations are generated and schema-only. Required fact links ship with their writers; deliberate clearing is outside migrations and replay is verified. Stop if generated SQL needs manual correction.

## Seams for TDD

- T01: core schema and pure validation tests, with existing accounting values/contracts as prior art.
- T02: source-normalization and source-replay integration tests, including Coinbase and Helius producer identities.
- T03–T04: PostgreSQL repository/constraints and atomic replay scheduling; mirror principal-asset-override mutation tests.
- T05: ValuationFact schema and TaxAccountingEngine tests.
- T06–T09: FactualLedgerRepository.load through CalculationRunService.recompute and stored immutable results; use factual-ledger, calculation-run-service, and principal-asset-override-application integration tests as prior art.
- T10: native REST integration, following AssetOverridesApiLive.integration.test.ts.
- T11: Effect/Promise SDK request-response tests, following asset-overrides.test.ts.
- T12: complete synthetic REST/SDK-to-run proof, replay identity, concurrency, isolation, precision, later-year effects, job/follow-up counts, failure/recovery, and exact D06 results.
- T13: harvest only; any discovered production fix needs a separately classified task. All commands use mise, tests run from repo root, and hosted build/format/lint/unit/integration/production-and-test type-check gates plus review must pass.

## Done criteria

1. `mise x -- pnpm run type-check`, lint, and the full test suite pass. A failure that also exists on untouched `origin/main` is noted explicitly with file and line (AGENTS.md: a red gate on main is a task, never carried past one PR).
2. /code-review the work.
3. Branch from latest `main`. Conventional commit with `Refs: #150` in the footer.
4. Open a PR referencing #150 and the task ID, stating the result classification, with every relied-on decision pasted verbatim with its source.
