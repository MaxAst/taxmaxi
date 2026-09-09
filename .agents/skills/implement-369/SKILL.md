---
name: implement-369
description: "Implement one delivery task from accurate transaction rows and stable browsing (#369). Pass the task ID as the argument, e.g. /implement-369 T01."
disable-model-invocation: true
---

Implement exactly one task from the delivery checklist of issue #369 (feat(transactions): make rows accurate and browsing stable). The task ID is given as the argument. If no argument is given, ask which task to do, then stop.

## Allowed tasks

Run only the assigned T01–T09 after every dependency in the live #369 checklist is merged. T01 and T04 have only the agreed-decision dependency. T07/T08 require #370 T03; T09 requires #370 T05. T10 uses harvest and also waits for #370 T05. Refuse blocked assignments and name the missing capability. The maintainer merged ADR PR #368; no further arming approval is required. T05 must satisfy the generated-migration and deliberate recompute proof gates before dependent readers.

- The latest recorded decisions on #369 always govern over this file. If this file and a newer recorded decision disagree, follow the decision and say so in the PR.

## Reading at pickup

Read before coding; refresh tracker state at handoffs and decision changes, reusing unchanged reference docs.

1. `gh issue view 369 --comments` — the body is the plan; the newest recorded decision wins.
2. `AGENTS.md`, especially "Delivery PRs and Reviews".
3. ADRs 0011–0014 (principal identity, exact stored links, effective correction inputs, and completed-work coverage) and ADR 0016 (complete movement capture and coherent query scope). Read docs/agents/delivery-process.md and docs/agents/issue-tracker.md for delivery gates and public-data rules.
4. The glossary of the owning context (`CONTEXT.md`, via `CONTEXT-MAP.md`) — use its vocabulary for naming.

## Coordination rules

Refresh open PRs and the live #125 map before work. #370 owns structured filters across transaction/portfolio reads, SDK and dashboard query state; #371 owns inspector restoration and editing; #129 owns indexed search. #339 has frontend Atelier work in flight; #133 has harvest work in flight. Their checklist file cuts govern ownership. Coordinate overlapping files and serial merges through the lead. Preserve all local user changes in the primary checkout, including unrelated auth/config edits and apps/www/.staking-preview/. T01 and T02 split the existing income diff by responsibility; do not discard or commit unrelated changes.

- Rebase on latest `origin/main` before opening the PR, and again before merging.
- The cross-stream rules (one migration in flight, out-of-surface conflicts stop the worker) live in `docs/agents/delivery-process.md` ("Execution") — follow them from there, including "Worker ownership and handoff". Use "Pre-launch migration planning" for schema work and existing authorization.

## Scope fence

- Do only the one task.
- Every rule governing your PR — coherent sizing and cut review, the merged-main file-cut recheck, fixture alignment as a category, result classification with pasted decisions, facts recorded at the writer, values meaning what their type says — lives in `AGENTS.md` ("Delivery PRs and Reviews", "Critical Guidelines", Database) and `docs/agents/delivery-process.md` ("Delivery checklist rules"). Enforce them from those documents; when this file lags them, they win.
- The behaviors those rules demand of you mid-task: stop and say so when the task outgrows its cut; record a file-list correction on the issue before coding around it; stop when a fix starts matching, grouping, or counting stored rows to find which decision applies (ADR 0012 — a recorded fact is missing).

## Domain rules that bite

Keep income separate from disposal gain/loss and fees. Missing values stay unavailable; zero and signed tiny values remain exact. Never label market valuation or tax basis as provider consideration. Capture every movement including withheld and uncorrected movements with truthful exact links; reuse final combined correction facts and the engine valuation selector. Never infer original purchase values from remaining inventory or invent override/event IDs. Persist captures and run results atomically. Read selected page IDs only. Separate current corrections/work from the displayed completed run. No tax-rule changes, new price fetching, filters, editors or bulk writes in this epic.

## Seams for TDD

The live #369 Testing and seams table supplies exact cases and files. T01: TransactionsApiLive integration plus SDK/dashboard/CLI fixture alignment, writer-produced EUR2 income and separate EUR-0.25 disposal. T02/T08: transaction-display and transactions-table exact decimal/presentation tests. T03: API pagination and dashboard/table storage/reset tests. T04: TaxAccountingEngine and factual-ledger repository tests. T05: calculation-run repository/service/schema integration and deliberate recompute proof. T06/T07: real writer-to-list/detail/API/SDK tests for EUR20 purchase fully sold for EUR30 and EUR10 gain. T09: dashboard/table/query deferred, error, logout tests plus real browser geometry. Complete each task’s exact mapped proof, not only these summaries.

Apply "Grounding and proof" in `docs/agents/delivery-process.md`: complete this task's mapped proof as its seams become available.

## Done criteria

1. Apply `docs/agents/delivery-process.md` ("Validation and test reliability"): choose local checks by the change, retain explicit task/hosted gates, and rerun invalidated checks. AGENTS.md's red-gate rule still applies; an isolated pass is diagnostic, not replacement proof.
2. /code-review the work.
3. Run every check, test suite, and review helper in the foreground and wait for it. A worker that spawns a background child and ends its turn waiting for it stalls with its code unpushed (#133 T01, T04, T05 each needed a handoff worker). Push and open the PR in the same turn the checks finish.
4. Branch from latest `main`. Conventional commit with `Refs: #369` in the footer.
5. Hand off head/base, changed files, check evidence, remaining work and blockers per the process doc. Open a PR referencing #369 and the task ID, stating the result classification, with every relied-on decision pasted verbatim with its source.
