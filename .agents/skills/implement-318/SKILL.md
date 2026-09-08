---
name: implement-318
description: "Implement one delivery task from completed-sync calculation coverage (#318). Pass the task ID as the argument, e.g. /implement-318 T01."
disable-model-invocation: true
---

Implement exactly one task from the delivery checklist of issue #318 (feat(rest-api): completed syncs lack calculation coverage status). The task ID is given as the argument. If no argument is given, ask which task to do, then stop.

## Allowed tasks

Run only the task assigned by the orchestrator from the live checklist: T01 publish the exact prepared ADR/glossary; T02 atomic completion requests and storage; T03 accounting-snapshot capture, settlement and shared projection; T04 existing worker dispatch/recovery; T05 selected-year REST read; T06 both SDK styles and #127 handoff; T07 Harvest with the `harvest` skill.

- Run T01–T07 sequentially, one PR per checkbox from merged main after the preceding task merges. Refuse downstream work while its predecessor is unmerged and say why.
- T01 must publish the exact definition artifacts `docs/adr/0014-completed-sync-calculation-coverage.md` and `packages/core/CONTEXT.md` before implementation or #127 quotes the ADR. Recover missing artifacts from the defining task; never reconstruct them from a downstream spec. Verify the ADR main link after merge.
- T02 carries a Drizzle migration. Check open PRs before starting: only one unmerged migration PR may be in flight. If generation cannot express the required protections, stop and report the exact missing constraint; never hand-edit generated SQL.
- D04 authorizes no historical fill, original-database clearing, or replay. If schema design needs a new required fact on populated derived rows, stop and recut with a deliberate clearing/replay gate before coding. Newly completed normal jobs establish new evidence.
- T01 and T05–T07 are result-preserving; T02–T04 are result-changing persisted work/coverage facts. Never mix classes. Paste live D01 and each task's named decisions and ADR paragraphs verbatim into its PR.
- T06 hands off the delivered route, SDK method and proof to #127; it neither implements nor marks #127 T05 complete. T07 preserves production code and ADR 0014. No old-system deletion is authorized; adding it requires a recut and maintainer answer-key approval.

- The latest recorded decisions on #318 always govern over this file. If this file and a newer recorded decision disagree, follow the decision and say so in the PR.

## Reading at pickup

Read before coding; refresh tracker state at handoffs and decision changes, reusing unchanged reference docs.

1. `gh issue view 318 --comments` — the body is the plan; the newest recorded decision wins.
2. `AGENTS.md`, especially "Delivery PRs and Reviews".
3. `docs/adr/0007-versioned-calculation-runs.md` — immutable results, activation guards and full recompute; `docs/adr/0012-stored-facts-carry-their-links.md` — exact links recorded by writers, never inferred; `docs/adr/0013-movement-corrections-feed-accounting-inputs.md` — correction inputs and completed-replay coverage remain separate; `docs/adr/0014-completed-sync-calculation-coverage.md` — completion, snapshot, coverage and active-result semantics (T01 publishes the prepared artifact). Read `docs/agents/delivery-process.md` for execution, proof, validation and migration rules, and `docs/agents/issue-tracker.md` for public-tracker privacy. Read the closing records of #269, #315 and #317 for the gap's origin; #127 T05 is the downstream consumer, not authority to redefine shared policy.
4. The glossary of the owning context (`CONTEXT.md`, via `CONTEXT-MAP.md`) — use its vocabulary for naming.

## Coordination rules

Refresh open PRs and issue decisions at pickup. At arming, #133 T03 (PR #328) owns auth contracts/handlers and auth tests, following its merged T01 email work; inspect the current PR file list for overlaps. #127 T05 (draft PR #327) owns the inspector/web consumer and is blocked on this shared seam. Its UI is outside #318. PR #211 is a prototype; #210 is parked Postgres-queue reference material, not permission to replace BullMQ; #179/#176 are docs drafts. Check these statuses live rather than treating this snapshot as current. Preserve other workers' edits and stop on conflicts outside your assigned surface.

- Rebase on latest `origin/main` before opening the PR, and again before merging.
- The cross-stream rules (one migration in flight, out-of-surface conflicts stop the worker) live in `docs/agents/delivery-process.md` ("Execution") — follow them from there, including "Worker ownership and handoff". Use "Pre-launch migration planning" for schema work and existing authorization.

## Scope fence

- Do only the one task.
- Every rule governing your PR — coherent sizing and cut review, the merged-main file-cut recheck, fixture alignment as a category, result classification with pasted decisions, facts recorded at the writer, values meaning what their type says — lives in `AGENTS.md` ("Delivery PRs and Reviews", "Critical Guidelines", Database) and `docs/agents/delivery-process.md` ("Delivery checklist rules"). Enforce them from those documents; when this file lags them, they win.
- The behaviors those rules demand of you mid-task: stop and say so when the task outgrows its cut; record a file-list correction on the issue before coding around it; stop when a fix starts matching, grouping, or counting stored rows to find which decision applies (ADR 0012 — a recorded fact is missing).

## Domain rules that bite

- **D01 — Result classification:** T02–T04 change requested-work and captured-coverage facts only. Identical accounting inputs retain identical money, valuation selection, FIFO and tax treatment. T05 cannot reopen writers to fix them.
- **D02 — Recorded scopes:** completion records the current Berlin calendar year plus existing active DE/EUR years. The consumer processes their union with its existing scopes, including work accepted before a year rollover. A year with no request is `not_requested`; reading it never requests calculation. Follow-up jobs remain distinct. Non-sync callers never invent source-job IDs.
- **D03 — Exact read contract:** authenticated `GET /v1/portfolio/calculation-status?taxYear=YYYY&sourceJobId=UUID`, optional sourceJobId, with `portfolio.getCalculationStatus({ taxYear, sourceJobId? })` in both SDK styles. Resolve principal from auth; malformed inputs return 400, missing/foreign explicit jobs share 404. Return DE/EUR scope, active run and all outstanding scope work separately from the selected job's covering run. A job filter must not hide other requests. Without a filter discover the newest completed job per owned source, not general job history. Explicit queued/failed source jobs have unavailable coverage and no fabricated request.
- **D03 — Truthful states:** work is `not_requested | queued | running | succeeded | failed`, retaining exact request/attempt/run IDs and machine-readable failure codes. Active coverage is `covered | not_covered | unknown`; legacy evidence is unknown, a new empty capture is distinct, and partial stays partial. Clients compare active run IDs before attaching separately fetched coverage. Existing assets/detail responses keep their meaning. Reads never write or enqueue.
- **D04 — Ownership and rollout:** use explicit ownership/scope keys, uniqueness and foreign keys rejecting cross-principal/job/run links. Explicitly mark new-run capture capability without falsely asserting evidence for legacy runs. Only Drizzle-generated schema-only migrations; no historical inference, fills, original-database clearing or replay is authorized.
- **ADR 0014 — Atomic acceptance:** `SourceSyncJobRepositoryLive.completeJob` records requests inside the same transaction as completion. Recording them later in the producer leaves a crash gap. Requests and attempts have their own IDs, never fake run revisions/versions.
- **ADR 0014 — Snapshot boundary:** capture exact committed links inside `CalculationRunServiceLive.loadSnapshot`'s accounting repeatable-read transaction alongside factual inputs. An earlier source replay read or later finalization query proves nothing. Retain capture immutably and settle only captured requests. Complete/partial runs can cover; running/failed runs cannot; non-activated runs cannot certify the active result.
- **ADR 0014 — Durable recovery:** use existing principal coalescing and `WorkerCalculationMaintenanceLive`, not a second scheduler. Lost dispatch leaves discoverable queued work; duplicate/concurrent dispatch never loses requests. Work arriving during an attempt gets another attempt; one failing year cannot starve another. Failure remains observable.
- **Full history:** annual calculations load all available factual history through the selected year's end without saved prior-year results or a lower-year cutoff. Raw provider fields are not substitutes for effective assets, valuations or captured corrections. Completed replay with failed records does not prove successful correction rebuild under ADR 0013.
- Keep #270 non-sync triggers, #193 job history, source progress/recovery redesign, historical on-demand calculation, other jurisdictions/currencies, tax policy, and inspector/dashboard UI out of scope.

## Seams for TDD

The live Testing and seams table is the exact proof map. Test names describe acceptance, not new services. Use synthetic data and real database boundaries; controlled queue adapters inject dispatch faults, never invent persisted pending states.

- **T01:** document contract and ADR 0007/0012/0013 references, full history and separation of work/coverage/active results. Scoped formatting and reference checks; no runtime change.
- **T02:** `completion_records_calculation_requests` and `completion_scope_and_ownership`, real completeJob/schema, using `source-sync-job-repository.integration.test.ts` and `calculation-runs-schema.integration.test.ts`. J creates exactly current 2026/active 2024 requests, never 2025; rollback leaves neither completion nor request; repeat completion has no duplicate; foreign links write nothing; J2 remains separate.
- **T03:** `sync_snapshot_covers_exact_job`, real completion → accounting snapshot → start/persist → read; use `calculation-run-service.integration.test.ts`, `calculation-run-repository.integration.test.ts` and new `calculation-sync-coverage.integration.test.ts`. Visible J stays on R, old R0 remains unchanged, complete/partial can cover and running/failed cannot, non-activated R never certifies R0. `sync_after_snapshot_requires_next_run` uses two DB connections and a barrier immediately after accounting snapshot establishment: later J2 is never captured/settled by R1; R2 captures it. `coverage_preserves_full_history`: 2024 acquisition of 3 units for EUR 1 and 2026 disposal for EUR 2 yield basis `1`, proceeds `2`, gain `1`, remaining quantity `0`, without saved 2024/2025 runs.
- **T04:** `completion_dispatch_recovers` and `coalesced_scopes_do_not_lose_requests`, real DB plus controlled dispatch, using the joined coverage suite and `WorkerBullMqCalculationConsumerLive.test.ts` / `WorkerBullMqSourceSyncConsumerLive.test.ts`. Crash after completion/before enqueue is recovered; duplicate/coalesced delivery loses zero requests; failed attempts remain visible/recoverable; retry settles only captures. Two consumers plus maintenance preserve later accepted work, 2024/2026 isolation, fair recovery, rollover and zero fabricated links for non-sync jobs.
- **T05:** `selected_year_calculation_status` and `calculation_status_access_and_legacy`, authenticated HTTP through real completion/capture writers, using `PortfolioApiLive.integration.test.ts` and `PortfolioApiLive.test.ts`. With current 2026 and active 2024 R0, discover queued/running J in 2024 while R0 remains active; after R1 activates return R1/covered J, identically after fresh-client reload. 2025 is not_requested with no invented result. Verify scope-wide work despite filtering, identical missing/foreign 404, malformed 400, auth rejection, legacy unknown, captured-empty, partial and failed states, and no read writes/enqueues.
- **T06:** `portfolio_calculation_status`, both SDK styles through HTTP, using new `packages/sdk/tests/portfolio.test.ts`, existing SDK index tests and REST integration proof. Preserve every ID/tag/null/failure and typed 400/404, with selected year and optional exact job in the URL.
- **T07:** harvest verifies the accumulated evidence and fresh-run blocker/schema-compatibility sweep. Joined proof starts at T03, extends through T04/T05/T06, and is never deferred to harvest.

Apply "Grounding and proof" in `docs/agents/delivery-process.md`: complete this task's mapped proof as its seams become available.

## Done criteria

1. Apply `docs/agents/delivery-process.md` ("Validation and test reliability"): choose local checks by the change, retain explicit task/hosted gates, and rerun invalidated checks. AGENTS.md's red-gate rule still applies; an isolated pass is diagnostic, not replacement proof.
2. /code-review the work.
3. Branch from latest `main`. Conventional commit with `Refs: #318` in the footer.
4. Hand off head/base, changed files, check evidence, remaining work and blockers per the process doc. Open a PR referencing #318 and the task ID, stating the result classification, with every relied-on decision pasted verbatim with its source.
