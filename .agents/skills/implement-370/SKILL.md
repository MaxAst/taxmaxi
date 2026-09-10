---
name: implement-370
description: "Implement one delivery task from structured filters and shared source selection (#370). Pass the task ID as the argument, e.g. /implement-370 T01."
disable-model-invocation: true
---

Implement exactly one task from the delivery checklist of issue #370 (feat(transactions): add structured filters and shared source selection). The task ID is given as the argument. If no argument is given, ask which task to do, then stop.

## Allowed tasks

Run only the task explicitly assigned by the orchestrator, in an isolated worktree. Never pick the next task or start another issue yourself. Refuse an unassigned task or one whose dependencies are not merged, state the unmet gate, and hand back to the orchestrator.

The ADR arming gate was satisfied by Maximilian merging PR #368. Refresh the current issue body/comments and merged main to verify dependencies; a satisfied gate does not authorize another task.

| Task | Required merged capabilities |
| --- | --- |
| T01 | Agreed ADR decisions; no implementation dependency |
| T02 | #370 T01 and #369 T06 |
| T03 | #370 T01 |
| T04 | #370 T01 |
| T05 | #370 T01–T04 and #371 T01 |
| T06 | #370 T04 and T05 |
| T07 | #370 T03, T05 and T06 |
| T08 | #370 T07 |
| T09 | #370 T01–T08; harvest only |

The initial assigned batch is T01 followed by T03 only. T02 is deliberately deferred even though #369 T06 has merged. After T03, hand off for #369 T07/T08 and stop until the coordinator explicitly assigns another batch. A planned batch boundary is a handoff, not an unexpected blocker. Later assignments still require the current tracker gates. If tracker decisions conflict with the coordinator's order, report the conflict rather than bypassing a gate.

- The latest recorded decisions on #370 always govern over this file. If this file and a newer recorded decision disagree, follow the decision and say so in the PR.

## Reading at pickup

Read before coding; refresh tracker state at handoffs and decision changes, reusing unchanged reference docs.

1. `gh issue view 370 --comments` — the body is the plan; the newest recorded decision wins.
2. `AGENTS.md`, especially "Delivery PRs and Reviews".
3. Read these durable references:
   - `docs/adr/0011-principal-asset-overrides.md` — effective economic asset identity and principal isolation.
   - `docs/adr/0012-stored-facts-carry-their-links.md` — readers follow writer-recorded links and never infer missing links.
   - `docs/adr/0013-movement-corrections-feed-accounting-inputs.md` — effective movement facts, valuation meaning and correction coverage.
   - `docs/adr/0014-completed-sync-calculation-coverage.md` — distinguish scope work, covering runs and active results.
   - `docs/adr/0016-transaction-read-facts-and-query-scope.md` — shared completed projection, movement capture and filter scope.
   - `docs/agents/delivery-process.md` — task cuts, proof, ownership, validation and harvest.
   - `packages/core/CONTEXT.md` and, for T05–T08, `apps/www/CONTEXT.md` — financial display terms and web behavior.
4. The glossary of the owning context (`CONTEXT.md`, via `CONTEXT-MAP.md`) — use its vocabulary for naming.

## Coordination rules

The coordinator serially interleaves #369, #370 and #371, then #129. Their issue bodies own current file cuts; read the relevant body and comments before touching a shared file. Do not implement another stream's capability to unblock yourself.

- #369 owns captured row/detail facts and stable browsing: transaction list/detail persistence contracts and layers, TransactionsApi definitions/handlers and API/SDK proofs; web `transaction-display.ts`, `transactions-table.tsx`, dashboard, query integration, their tests and locale messages. Its calculation capture work also owns accounting and calculation-run persistence surfaces. #370 T03 enables #369 T07/T08; #370 T05 enables #369 T09/T10.
- #371 owns inspector restoration, summaries, correction editors/history and their tests, plus dashboard/table integration and locale messages in `apps/www`. #371 T01 enables #370 T05. #369 T07 plus #371 T01 enables #371 T02.
- #129 owns later indexed search in transaction list persistence/API/SDK, search indexes in transaction/source/leg/raw-record/asset/provider-asset/override/calculation schema files and generated migrations, query-plan fixtures/tests, and web filter/search controls. Search is outside this skill's work.
- #370 owns only the assigned checklist cut: transaction predicates/choices, portfolio multi-source reads, URL state and structured filter/source controls. Shared filenames do not transfer another task's ownership.

Keep primary-checkout local changes untouched. Use one PR per task and hand off to the orchestrator for serial merges after required checks/reviews. Never advance beyond the assigned batch.

- Rebase on latest `origin/main` before opening the PR, and again before merging.
- The cross-stream rules (one migration in flight, out-of-surface conflicts stop the worker) live in `docs/agents/delivery-process.md` ("Execution") — follow them from there, including "Worker ownership and handoff". Use "Pre-launch migration planning" for schema work and existing authorization.

## Scope fence

- Do only the one task.
- Every rule governing your PR — coherent sizing and cut review, the merged-main file-cut recheck, fixture alignment as a category, result classification with pasted decisions, facts recorded at the writer, values meaning what their type says — lives in `AGENTS.md` ("Delivery PRs and Reviews", "Critical Guidelines", Database) and `docs/agents/delivery-process.md` ("Delivery checklist rules"). Enforce them from those documents; when this file lags them, they win.
- The behaviors those rules demand of you mid-task: stop and say so when the task outgrows its cut; record a file-list correction on the issue before coding around it; stop when a fix starts matching, grouping, or counting stored rows to find which decision applies (ADR 0012 — a recorded fact is missing).

## Domain rules that bite

- T01–T04 and T09 preserve results for unchanged inputs; T05–T08 change user-visible behavior and must paste their exact C-T05/C-T06/C-T07/C-T08 decision from #370 into the PR. Never mix result-changing and result-preserving work.
- Transactions use exact owned source IDs. Keep `sourceId` as the single-source shorthand, add `sourceIds`, reject both together, and decode them into one source set. Duplicate IDs do not duplicate rows. Every selected source passes ownership validation.
- Portfolio scope is the union of selected sources' custody units, counted once from the same active snapshot. Never sum single-source responses in the browser. Other filters affect transactions only.
- OR within each source/asset/category group; AND across groups. Rows and exact count share a predicate. One stored transaction remains one row even when several movements match. Use deterministic timestamp/ID ordering and query-bound cursors; changed source/date/order cannot reuse an old cursor. Dates use UTC half-open boundaries.
- Asset choices use economic IDs and disambiguating metadata, including owned historical assets with zero holdings. Source choices reuse the sources API. Effective nonfee movement facts determine category; broad Staking includes passive and unspecified staking. Personal remapping/category changes switch with the same completed projection used by displayed calculated facts.
- Attention comes only from owned, explicitly linked transaction/movement review and blocker records. A scope-level queued/failed job or partial run must not flag every row. Keep known values when another movement is blocked. Provider-only unresolved/excluded activity without accounting rows remains #153's scope.
- Old rows remain visible with captured facts explicitly unavailable until deliberate recomputation. Never backfill immutable runs or invent missing IDs, values or associations. Preserve exact absent/zero meanings and signed nonzero sub-cent values; provider consideration, market value, income, proceeds, basis and gain stay distinct.
- URL state round-trips filters and timezone, preserves unrelated keys, restores on browser Back, resets cursor/selection, and integrates with the restored inspector shell. Inclusive local date ranges convert correctly across DST. Inspector navigation uses page offset, row index and exact API total.
- Source-card click selects that source alone. Multi-select may choose several and highlight exactly those cards; portfolio and transactions receive the same source set. Card focus/lift and source-specific actions keep their own meanings.
- Use existing UI primitives, localized messages, keyboard/pointer support and reduced motion. Existing chips survive failed choice loading. Manual controls work without AI. No new table/filter framework, natural-language model, arbitrary query language, facet counts, indexed free-text search or provider-task search.

## Seams for TDD

Use writer-produced fixtures across actual boundaries. The issue's current Testing and seams table owns the exact proof; these task mappings identify its prior art.

- T01–T03: `packages/rest-api/tests/TransactionsApiLive.integration.test.ts` and `packages/sdk/tests/index.test.ts`, exercising TransactionListRepositoryLive through the actual API/SDK contracts. T01 proves A/B/C counts 2/1/1 yield three rows for A+B and A+A+B, foreign-source rejection, inclusive start/exclusive end, timestamp ties and changed-query cursor rejection. T02 proves two matching movements count once, equal symbols retain distinct economic IDs, and corrected staking appears once only after completed projection switches. T03 proves three rows yield two attention matches for an explicit review and linked blocker, zero additional matches for scope-only failure, historical zero-holding choices, and no provider-only rows.
- T04: `packages/rest-api/tests/PortfolioApiLive.integration.test.ts`, `packages/rest-api/tests/PortfolioApiLive.test.ts` and `packages/sdk/tests/index.test.ts`. A/B sharing custody unit U with 10 tokens return 10 for A, A+B and A+A+B; adding C's separate 3-token unit returns 13. Foreign sources expose no portfolio data.
- T05: `apps/www/tests/lib/transaction-filters.test.ts`, `apps/www/tests/routes/app.test.tsx` and `apps/www/tests/components/dashboard.test.tsx`. Europe/Berlin 2026-03-29 maps to [2026-03-28T23:00:00Z, 2026-03-29T22:00:00Z); Back restores filter sets/timezone and unrelated keys while resetting page and inspector selection.
- T06: dashboard, source-cards and query-integration tests under `apps/www/tests/components/` and `apps/www/tests/integrations/taxmaxi/queries.test.ts`. Exercise real source cards rather than the existing dashboard mock: click A from A+B selects A alone; selecting A+B sends exactly A/B to both readers and highlights two cards. Source actions do not silently choose A.
- T07: `apps/www/tests/components/transaction-filters.test.tsx`, dashboard tests and query-integration tests. Select source A, assets X/Y and category staking, then remove Y without losing X; Enter applies once, Escape closes, and failed choice loading preserves existing chips.
- T08: transaction-filter component and library tests. At reference date 2026-09-09, This year selects all of 2026 and Last year all of 2025; oldest toggles once, attention stays enabled, and a saved Europe/Berlin date keeps its UTC boundaries in another browser timezone.
- T09: use the harvest skill and the process document's fresh/schema-qualified blocker audit. Promote demonstrated durable findings and remove this skill; no deferred correctness proof or new feature work.

Apply "Grounding and proof" in `docs/agents/delivery-process.md`: complete this task's mapped proof as its seams become available.

## Done criteria

1. Apply `docs/agents/delivery-process.md` ("Validation and test reliability"): choose local checks by the change, retain explicit task/hosted gates, and rerun invalidated checks. AGENTS.md's red-gate rule still applies; an isolated pass is diagnostic, not replacement proof.
2. /code-review the work.
3. Run every check, test suite, and review helper in the foreground and wait for it. A worker that spawns a background child and ends its turn waiting for it stalls with its code unpushed (#133 T01, T04, T05 each needed a handoff worker). Push and open the PR in the same turn the checks finish.
4. Branch from latest `main`. Conventional commit with `Refs: #370` in the footer.
5. Hand off head/base, changed files, check evidence, remaining work and blockers per the process doc. Open a PR referencing #370 and the task ID, stating the result classification, with every relied-on decision pasted verbatim with its source.
