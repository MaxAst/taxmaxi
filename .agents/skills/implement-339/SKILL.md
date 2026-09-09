---
name: implement-339
description: "Implement one delivery task from Atelier (#339). Pass the task ID as the argument, e.g. /implement-339 T01."
disable-model-invocation: true
---

Implement exactly one task from the delivery checklist of issue #339 (Atelier: delivery spec). The task ID is given as the argument. If no argument is given, ask which task to do, then stop.

## Allowed tasks

Follow the live checklist in order, T01 through T09. T04 and T07 require Max to record exact primitive choices and dashboard/removal choices before their documentation PRs or dependent implementation. Refuse blocked assignments and explain the missing approval.

- The latest recorded decisions on #339 always govern over this file. If this file and a newer recorded decision disagree, follow the decision and say so in the PR.

## Reading at pickup

Read before coding; refresh tracker state at handoffs and decision changes, reusing unchanged reference docs.

1. `gh issue view 339 --comments` — the body is the plan; the newest recorded decision wins.
2. `AGENTS.md`, especially "Delivery PRs and Reviews".
3. Read docs/adr/0012-stored-facts-carry-their-links.md for recorded links, docs/adr/0014-completed-sync-calculation-coverage.md for captured coverage, docs/adr/0015-sync-timestamps-record-completion.md for completion timestamps, docs/agents/delivery-process.md for proof, and docs/agents/issue-tracker.md for public data boundaries. Read applicable UI skills.
4. The glossary of the owning context (`CONTEXT.md`, via `CONTEXT-MAP.md`) — use its vocabulary for naming.

## Coordination rules

Refresh open PRs at pickup. At arming #133 has email-verification PR #361; inspect its translation overlaps. PR #210 and drafts #211/#179/#176 also exist. Current tracker state governs. Root checkout has unrelated transaction/staking and translation edits: use an isolated worktree from merged main, never copy or revert those edits.

- Rebase on latest `origin/main` before opening the PR, and again before merging.
- The cross-stream rules (one migration in flight, out-of-surface conflicts stop the worker) live in `docs/agents/delivery-process.md` ("Execution") — follow them from there, including "Worker ownership and handoff". Use "Pre-launch migration planning" for schema work and existing authorization.

## Scope fence

- Do only the one task.
- Every rule governing your PR — coherent sizing and cut review, the merged-main file-cut recheck, fixture alignment as a category, result classification with pasted decisions, facts recorded at the writer, values meaning what their type says — lives in `AGENTS.md` ("Delivery PRs and Reviews", "Critical Guidelines", Database) and `docs/agents/delivery-process.md` ("Delivery checklist rules"). Enforce them from those documents; when this file lags them, they win.
- The behaviors those rules demand of you mid-task: stop and say so when the task outgrows its cut; record a file-list correction on the issue before coding around it; stop when a fix starts matching, grouping, or counting stored rows to find which decision applies (ADR 0012 — a recorded fact is missing).

## Domain rules that bite

- Preserve accounting results, contracts, facts, scheduling, sync and callback ownership. Paste exact task decisions in the PR.
- Atelier is development-only at /atelier outside authenticated loaders. Use synthetic examples and real shared components. Prove workshop code, tools and styles are absent from both production artifact graphs.
- Keep Approved and Experiments separate. A preset is not promotion. No embedded AI, custom annotations, or gallery framework.
- Preserve app character and screen composition. Max selects primitive values at T04 and dashboard interaction/removals at T07. Never choose for him.
- Sync stays in SourceSyncIsland; CalculationStatus presents status; Dashboard owns placement/callbacks. Unknown coverage stays unknown. Blocker counts are not supported correction actions.
- All app-owned visible strings and synthetic guidance use both Paraglide message files.

## Seams for TDD

- T01: route/build boundary, real primitives, route tests, development browser, production build/preview and client/server artifact exclusion.
- T02: extend exclusion to tools/styles; verify installed APIs, tuning isolation/reset and copied feedback.
- T03 through T05: identical content/states in context, both themes/locales at actual 390px/1280px widths, keyboard, actual touch and relevant reduced motion. Shared styles change only after approval.
- T06 through T08: current typed synthetic scenarios and CalculationStatus/Dashboard tests. Preserve cached active A when B fails, source isolation, refresh, onboarding and inspector. Missing result differs from complete; failed reads differ from failed calculations. Use exact proof values from #339.
- T09: approved removals, retained examples/prompts, instruction links, boundary proof if imports/build change. Prose-only gates need scoped formatting/reference checks.

Apply "Grounding and proof" in `docs/agents/delivery-process.md`: complete this task's mapped proof as its seams become available.

## Done criteria

1. Apply `docs/agents/delivery-process.md` ("Validation and test reliability"): choose local checks by the change, retain explicit task/hosted gates, and rerun invalidated checks. AGENTS.md's red-gate rule still applies; an isolated pass is diagnostic, not replacement proof.
2. /code-review the work.
3. Run every check, test suite, and review helper in the foreground and wait for it. A worker that spawns a background child and ends its turn waiting for it stalls with its code unpushed (#133 T01, T04, T05 each needed a handoff worker). Push and open the PR in the same turn the checks finish.
4. Branch from latest `main`. Conventional commit with `Refs: #339` in the footer.
5. Hand off head/base, changed files, check evidence, remaining work and blockers per the process doc. Open a PR referencing #339 and the task ID, stating the result classification, with every relied-on decision pasted verbatim with its source.
