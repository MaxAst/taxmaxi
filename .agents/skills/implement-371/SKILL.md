---
name: implement-371
description: "Implement one delivery task from inspection restoration and individual corrections (#371). Pass the task ID as the argument, e.g. /implement-371 T01."
disable-model-invocation: true
---

Implement exactly one task from the delivery checklist of issue #371 (feat(transactions): restore inspection and add individual corrections). The task ID is given as the argument. If no argument is given, ask which task to do, then stop.

## Allowed tasks

Run only the task explicitly assigned by the orchestrator, in an isolated worktree. Never pick the next task or start another issue yourself. Refuse an unassigned task or one whose dependencies are not merged, state the unmet gate, and hand back to the orchestrator.

| Task | Required merged capabilities |
| --- | --- |
| T01 | #369 T03: remembered 25/50/100/500 page sizes |
| T02 | #371 T01 and #369 T07: captured summary in transaction detail |
| T03 | #371 T02 |
| T04 | #371 T03 |
| T05 | #371 T03 |
| T06 | #371 T04 and T05 |
| T07 | #371 T01–T06; harvest only |

The assigned batch is T01 only. T02 and later require a new coordinator assignment even when their dependencies have merged. The shared ADR gate and #369 T03/T07, #370 T03 and #369 T08/#392 were merged at pickup base `527a541dab0005adf0ef8e38c97caca05ddeb18e`; refresh the current tracker and main before relying on those facts. T08's table/tests/messages hold has been released.

The maintainer explicitly authorized commits for the rest of this session: “you are allowed to commit for the rest of the session”. The release is recorded in #371 comment https://github.com/taxmaxi/taxmaxi/issues/371#issuecomment-5625156718. Proceed with the assigned commit/push and PR workflow. Orchestrate requires this worker skill committed and pushed before product-worker pickup. Merging separately requires the coordinator's explicit grant for the PR and head; commit permission does not grant a merge.

- The latest recorded decisions on #371 always govern over this file. If this file and a newer recorded decision disagree, follow the decision and say so in the PR. If tracker gates and coordinator order conflict, report the conflict rather than bypassing a gate.

## Reading at pickup

Read before coding; refresh tracker state at handoffs and decision changes, reusing unchanged reference docs.

1. `gh issue view 371 --comments` — the body is the plan; the newest recorded decision wins.
2. `AGENTS.md`, especially "Delivery PRs and Reviews".
3. Read these durable references:
   - `docs/adr/0011-principal-asset-overrides.md` — exact principal-owned identity scope and override history.
   - `docs/adr/0012-stored-facts-carry-their-links.md` — follow writer-recorded links; never infer missing facts.
   - `docs/adr/0013-movement-corrections-feed-accounting-inputs.md` — factual movement corrections and valuation meaning.
   - `docs/adr/0014-completed-sync-calculation-coverage.md` — saved correction, covering calculation and active result are distinct.
   - `docs/adr/0016-transaction-read-facts-and-query-scope.md` — coherent captured facts and active query sequence.
   - `docs/agents/delivery-process.md` — task cuts, ownership, proof, validation and harvest.
4. The glossary of the owning context (`apps/www/CONTEXT.md`, via `CONTEXT-MAP.md`) and relevant financial terms in `packages/core/CONTEXT.md`.
5. For T01, inspect `e7cfa660a5` / `ea445497a8^:apps/www/src/components/transactions-table.tsx` as the restoration reference, then current dashboard cursor/page-size state, inspector reads/polling and `apps/www/src/components/bottom-sheet.tsx`. Use the existing animation and measurement packages. Read the applicable motion, accessibility and frontend skills before implementing their behavior.

## Coordination rules

The coordinator interleaves #369, #370 and #371, then #129. Current issue bodies own the file cuts. Read the relevant body/comments before touching shared files; shared filenames do not transfer another task's ownership.

- #369 owns captured row/detail facts and stable browsing, including persistence, API/SDK proofs and web row display. Its merged T08 table facts and attention display must survive restoration. Later #369 T09/T10 waits for #370 T05.
- #370 T02/T04 completed backend transaction predicates/choices and portfolio multi-source reads, API/SDK surfaces and their proofs; both are merged at refreshed base `53f75eca996fe06a5bb8c4ead319cfd8429d7df3`. Their heavy slots are released. Do not edit these surfaces. #370 T05 later owns URL/query state and filter/source integration with dashboard/table/messages; #371 T01 unlocks it. T01 adds no URL or source-filter implementation and must not wait for T05.
- #371 owns the assigned inspector shell/summary/editor/history cut, dashboard/table integration and locale messages. T01's eight product/proof files remain the issue's cut. File-cut correction 1 adds only this skill as delivery scaffolding. Shared bottom-sheet primitive and landing header remain outside the cut.
- #129 owns later indexed search and related persistence/API/SDK, migrations, query-plan proofs and web search controls; no search work belongs here.

Keep primary-checkout local edits untouched. All code edits go through isolated workers. Coordinate any expansion into another active stream's files before editing. Coordinate heavy full-suite/build slots with #370 through the orchestrator; task-local tests may run independently. One PR per task, no automatic cross-issue merges. Hand off a ready PR/head and await an explicit merge grant. After T01, stop at the batch boundary.

- Rebase on latest `origin/main` before opening the PR, and again before merging.
- The cross-stream rules (one migration in flight, out-of-surface conflicts stop the worker) live in `docs/agents/delivery-process.md` ("Execution") — follow them, including "Worker ownership and handoff". Use "Pre-launch migration planning" for schema work and existing authorization.

## Scope fence

- Do only the one task. No wholesale inspector rewrite, mock-data behavior, new rank or reverse-cursor API, quantity/date edits, custom asset names, bulk/batch correction UI or changed tax law.
- Every rule governing your PR — coherent sizing and cut review, merged-main file-cut recheck, fixture alignment as a category, result classification with pasted decisions, facts recorded at the writer, values meaning what their type says — lives in `AGENTS.md` ("Delivery PRs and Reviews", "Critical Guidelines", Database) and `docs/agents/delivery-process.md` ("Delivery checklist rules"). Enforce them from those documents; when this file lags them, they win.
- Stop when the task outgrows its cut; record a file-list correction on the issue before coding around it. Stop when a fix starts matching, grouping or counting stored rows to find which decision applies (ADR 0012 — a recorded fact is missing).

## Domain rules that bite

- T01–T06 change user-visible results and must paste their exact E-T01/E-T02/E-T03/E-T04/E-T05/E-T06 decision from #371 into the PR. T07 preserves results. Never mix result-changing and result-preserving product work; identify required delivery scaffolding separately.
- T01 restores the desktop side pane beside the table and mobile vaul bottom sheet, sticky overview counter with ArrowUp/ArrowDown/X, sub-view Back header, capped scroll area and safe-area spacing. Restore measured height using 0.24s and easing `[0.25, 1, 0.5, 1]`; reduced motion sets height directly. Reuse the existing bottom-sheet primitive with transaction-local styles and preserve the landing header. The former mobile sheet supersedes the earlier full-screen proposal. Old mock data, hardcoded English and array paging are not restoration targets.
- Keep #127's real-data inspector sections, reads, polling, accessibility and error handling. Keep existing detail visible when appropriate after a refetch loses the selected row; never invent its position or enable navigation based on a missing row. Preserve T08's captured row values and attention display.
- Navigate within the active page using adjacent rows. At boundaries fetch the neighbouring cursor page using dashboard history and page-size state, selecting its first/last row and moving the table page only on success. Position is loaded page offset + row index + 1 over API exact totalCount, never loaded-row count. Disable arrows at the first/last row.
- While a neighbour loads, retain current content/counter, prevent duplicate navigation, ignore superseded responses and offer retry on failure. Changed filter/page size resets page/selection. If sync invalidates the page sequence, reset/refetch before presenting a new position. T01 supplies the restoration against existing state; #370 T05 later wires URL scope changes.
- T02 uses the shared financial display helper and captured meanings/precision: principal movements and separate fees, known values retained while updating, explicit missing-input actions, evidence/history reachable. Mobile overview links into the same shell's detail sub-views; desktop puts the summary atop the pane. Changing transaction returns to overview; refresh of the same transaction preserves the sub-view. Do not add a second navigation stack.
- T03 edits exact EUR unit/total values with a prefilled editable factual reason and the correct target/current revision. Reuse existing correction APIs and session refresh. Prevent double submission and account-switch late writes; explicit query-cache writes use `setSessionQueryData` with the request's starting user ID. Failed save keeps draft/input/focus. Saved is separate from recalculated.
- Dirty Back, swipe, Escape, close, row change, previous/next and source/filter/page changes share one keep-editing/discard guard. Successful save returns to overview. Measured shell height responds to validation/editor changes and long forms scroll.
- T04 exposes backend-supported factual movement choices only, never tax-treatment codes. One Staking reward label asks for passive clarification once per edit when evidence is insufficient; otherwise record unspecified staking. Outgoing/fee movements cannot become incoming staking. Do not promise unrelated blockers disappear.
- T05 selects existing economic assets with disambiguating metadata and states the exact principal-owned historical/future scope. Create/replace/withdraw uses the current leaf. Do not rename assets, create local assets, mutate global identity or change existing incompatible-correction behavior.
- T06 keeps original/system/user values, reasons and ordered create/replace/withdraw history accessible. Only a covering run capturing the exact current history leaf marks it applied; a later timestamp is insufficient. Old history is never a current write target.
- Every user-visible string comes from en/de Paraglide messages. Preserve existing keyboard/pointer support, focus behavior, reduced motion and error states.

## Seams for TDD

Use writer-produced fixtures across actual boundaries for read assertions. The issue's current Testing section owns the exact proof; these mappings identify existing test seams.

- T01: `apps/www/tests/components/dashboard.test.tsx`, `transaction-inspector.test.tsx` and `transactions-table.test.tsx`. Row 2 on page 2 at size 25 shows 27 of 1,204. Crossing 25 to 26 moves page/counter only on successful fetch; failure retains 25 of 1,204 and offers retry. Prove both boundaries, duplicate/superseded navigation, first/last disabled arrows, page-size/filter reset, sync invalidation and empty/missing selection without a fabricated position. Preserve existing missing-row/year detail lifecycle tests. Browser proof covers desktop pane, narrow sheet, overflow, unequal content heights, 0.24s easing/direct reduced-motion height, loading/error, keyboard and focus restoration.
- T02: `apps/www/tests/components/transaction-summary.test.tsx` and `transaction-inspector.test.tsx`. Purchase paid 20 and fee 1 remain separate; sale proceeds 30/gain 10 match the row. Detail→Back returns to overview, a new transaction resets the sub-view, same-transaction refresh preserves it.
- T03: `apps/www/tests/components/transaction-editor.test.tsx`, `use-transaction-editor.test.tsx`, `transaction-inspector.test.tsx` and `dashboard.test.tsx`. Quantity 2 with unit 12.50 or total 25.00 submits value 25.00. One save appends one correction; double-click does not append another. Failed save retains draft. Dirty exits including direct row/source/filter changes use the shared guard. Show saved before covering calculation and reject late account-switch writes.
- T04: editor/hook tests above. Unsupported staking evidence records unspecified staking; explicit passive clarification records passive staking. One save appends one correction; controls never write tax-treatment codes.
- T05: `apps/www/tests/components/transaction-asset-editor.test.tsx` and `transaction-editor.test.tsx`. Mapping representation R from X to Y affects only this principal's two existing and one future uses of R; another principal and a different representation sharing the symbol remain X. Global names stay unchanged.
- T06: `apps/www/tests/components/transaction-correction-history.test.tsx` and `transaction-editor.test.tsx`. Create/replace/withdraw yields three ordered entries with values/reasons. Save before covering run remains calculation pending; an unrelated later run does not mark applied.
- T07: use harvest and the process document's fresh/schema-qualified blocker audit. Promote demonstrated durable findings and remove this skill. Record the loss/restoration before harvest; promote the rule that rewrite PR descriptions state removed UI/interactions and why. Never claim #141 approved removal. No deferred correctness proof or new feature work.

Apply "Grounding and proof" in `docs/agents/delivery-process.md`: complete this task's mapped proof as its seams become available.

## Done criteria

1. Apply `docs/agents/delivery-process.md` ("Validation and test reliability"): choose local checks by the change, retain explicit task/hosted gates, and rerun invalidated checks. AGENTS.md's red-gate rule still applies; an isolated pass is diagnostic, not replacement proof. Use mise for all Node/package-manager commands.
2. /code-review the work and complete required independent/hosted reviews from the delivery process.
3. Run every check, test suite and review helper in the foreground and wait for it. Coordinate heavy slots before starting them. Once checks finish and explicit authorization permits, push and open the PR in the same turn; if authorization is missing, hand off the exact boundary instead.
4. Branch from latest `main`. Commit only with explicit authorization, using Conventional Commits and `Refs: #371` in the footer.
5. Hand off head/base, changed files, check evidence, remaining work and blockers per the process doc. When authorized, open a PR referencing #371 and the task ID, stating the result classification with every relied-on decision pasted verbatim and its source. Report ready-to-merge and wait for the coordinator's explicit grant for that PR/head. Stop after the assigned task.
