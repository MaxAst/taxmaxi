# Integration test database review

Scope: all 57 first-party `*.integration.test.ts` files (37 persistence, 13 REST API, six sync engine, one worker), their database helpers, Vitest configuration, and test Postgres configuration. Vendored tests are reference material, not part of this suite. The original audit is preserved below; the follow-up implementation is described first.

## Follow-up implementation

### Controlled comparison

Same machine (M1 Pro, 16 GiB, heavy swap), same Postgres container, runs back to back, `--project=integration`. Vitest wall time is start to last file end; summed test time includes `beforeEach` resets.

| Run | Wall | Summed test time | Failures |
| --- | ---: | ---: | ---: |
| `main` as-is (1b0036115b) | 138 s | 1070 s | 7 five-second timeouts |
| pool reuse, 4 workers, lock-based race tests (tmpfs) | 99 s | 306 s | 0 |
| same, disk-backed Postgres instead of tmpfs | 116 s | 380 s | 0 |
| plus DELETE-based per-test reset (tmpfs) | 38 s | 97 s | 0 |

tmpfs saved about 15% but held about 1.4 GiB in the container versus 200 MiB on disk; on a machine that already swaps it is the wrong trade, and the reset change below removes most of the file churn it was hiding. It was dropped before commit.

The reset was the largest remaining cost. One full-schema `TRUNCATE ... RESTART IDENTITY CASCADE` over 70 mutable tables and 306 indexes cost 110-230 ms on an idle server even when every table was empty, because TRUNCATE gives every table and index a new file. 814 of 975 tests ran it in `beforeEach`. The replacement checks each mutable table with `EXISTS` and runs `DELETE` only on those holding rows, under `session_replication_role = replica` for that transaction so append-only triggers and FK checks are skipped, as TRUNCATE already skipped them. The schema has no sequences, so `RESTART IDENTITY` did nothing. Idle cost fell to 9-19 ms. Two prototype attempts failed first: `ON DELETE RESTRICT` raises `restrict_violation`, not `foreign_key_violation`, and four append-only triggers reject DELETE outright; replica mode resolves both.

### Resource measurement after the initial validation

A later full-suite run on the maintainer's M1 Pro / 16 GiB machine took **231.34 seconds in Vitest**, with 2,069 tests passing and one API test failing. The entire observed command, including startup, cleanup, and the last sampling interval, took 242.59 seconds. The cached package build took 177 ms. This supersedes any interpretation of the earlier 78-second run as a dependable local runtime or proof of stability under load.

The configuration was unchanged. A temporary Python observer sampled the test process tree, Docker statistics, and aggregate `pg_stat_activity` counts about every four seconds. Host swap counters were captured before and after. Sampling adds overhead; this is a diagnostic observation, not a controlled before/after benchmark.

| Observation | Measurement |
| --- | --- |
| Test process CPU, highest sample | 675% (about 6.75 cores; macOS `ps` estimate) |
| Test process resident memory, highest summed sample | 2,022.5 MiB; summed RSS can double-count shared pages |
| Postgres CPU, highest sample | 522% (about 5.22 cores) |
| Postgres CPU, mean of samples after the first 30 seconds | 309% |
| Postgres container memory, highest sample | 2.206 GiB |
| Docker memory allocation | 7.818 GiB |
| Host swap used before / after | 14,663 MiB / 16,017 MiB |
| Host swap-in / swap-out counter increases | 2,676,380 / 2,833,346 pages; host-wide, not attributable solely to tests |
| Active database connection observations in reset statements | 97 of 139, across 59 samples |

The host was already under substantial memory pressure before tests began. Cursor was using about 76% CPU in the pre-run snapshot. The swap counters increased heavily during the run; this is stronger evidence of active pressure than existing swap allocation alone. PostgreSQL continued consuming several cores during the database phase. Reset observations point to broad per-test truncation as a candidate for phase-level measurement, but do not establish an exact percentage of time spent resetting.

The single failure was `AssetOverridesApiLive` / `returns canonical current and append-only history reads with stale state`: a history request received a 401 text response (`auth required`) where JSON was expected. It was not a timeout. A focused rerun passed (one test, 22 skipped); the cause remains unresolved, and this run must not be described as a clean stability pass.

Do not infer CPU temperature, fan speed, or thermal throttling from these samples; none was measured. The controlled comparison above followed this measurement.

### Earlier validation

Final validation on this checkout:

- The complete default test command passed **2,070 tests across 143 files in 78.11 seconds**, using the normal test database service after competing tasks stopped.
- A separate integration-only run passed **975 tests across 58 files in 108.98 seconds**. These timings came from different load conditions; they are not a controlled speedup comparison. Both runs used the normal test deadlines.
- Two simultaneous integration commands on a dedicated test server verified the run slot: the second waited in global setup, then passed after the first released its lock.

The initial audit below had incomplete API test collection, so its timings are not a complete-suite baseline. The new pool-lifetime regression test accounts for the additional integration file. No changes were committed or pushed.

- Test commands now run the cached Turbo package build before Vitest, preventing stale package exports from silently excluding API tests.
- The database test context owns one lazy Postgres pool per file and one admin connection. Existing fixture, repository, and HTTP layers reuse that pool. Pools close before recreation and at file teardown. The default pool limit is four; transfer reconciliation explicitly uses five for its holder, three contenders, and observer.
- The test client no longer evicts idle connections after 1 ms; it uses the driver default of 10 seconds, with explicit scope cleanup at file teardown. A real-database regression test checks reuse across helper calls and zero remaining connections after teardown. Database recreation was verified in a focused run; it is not performed inside the regular regression test because `DROP DATABASE` forces a server-wide checkpoint.
- A reserved admin connection holds a server-wide advisory lock for the entire database run, including cleanup. Separate test invocations on the same Postgres server wait in setup instead of multiplying the worker load; reserving the connection keeps idle eviction from releasing the slot. The run scope closes on setup or teardown failure as well as success.
- The integration project has four workers and runs after the unit project instead of alongside it. A separate project for the single HTTP-only worker health test was tried and dropped as not worth the extra command-line surface.
- A tmpfs mount for the `db-test` data directory was tried and dropped; see the controlled comparison above.
- All 11 individual 10/15-second integration-test extensions were removed. The normal five-second test deadline remains.
- Three fixed SQL sleep barriers were replaced with explicitly released advisory locks. The claim trigger now pauses only the intended insert, not an earlier cascading update. Lock observers match the current database and query, support an exact minimum number of waiters, and have a two-second live-clock deadline. Cleanup releases gates when an assertion or wait fails.

The default-service repeat exposed two concurrent run IDs, eight active database workers, and about 750% Postgres CPU usage. That contaminated run was interrupted without affecting the other run. This observed contention prompted the server-wide run slot. A dedicated verification observed one granted advisory lock and one waiting lock for two concurrent test commands.

The existing per-file databases, committed transactions, and schema tests remain, and each reset still leaves every mutable table empty. Broad rollback wrappers and fixture rewrites were deferred: they change isolation or test starting data, and are not necessary to take these improvements. No assertions of product behavior were weakened.

Run all integration tests with:

```sh
mise x -- pnpm run test --project=integration
```

The build prerequisite also applies to unit, watch, and coverage commands; watch mode still needs package builds refreshed when editing compiled workspace dependencies.

## Recommendation

Keep real Postgres. First restore API test collection and confirm a measured worker cap; the four-worker trial below was promising. Then fix connection ownership and measure reset cost. Use several explicit test setups instead of forcing every test through one isolation strategy.

`PgClientLive` provides two service tags for the same configured SQL client; that does not mean two pools. The repeated *building* of a layer is the concern. Multiple implementations are appropriate, with labels explaining purpose, infrastructure, isolation, and lifetime. An inline service implementation is not inherently a problem, and replacing database repositories with fakes would not address this review's goal.

## Findings

### 1. Reuse an explicitly scoped pool

`packages/persistence/tests/support/integration-test-kit.ts:222` builds `TestPgClientLive` for every `runPg` invocation. `runWithLayer` does the same at line 256. Reusing a layer value does not share its built services across independent runs. The vendored driver creates a pool, runs `SELECT 1`, and closes the pool at scope exit (`repos/effect/packages/sql/pg/src/PgClient.ts:153`).

For example, the first asset repository test runs three separate repository calls, each with a fresh pool. Its setup also runs the common fixture and asset fixture separately. Across the integration files there are 1,002 textual `runPg(...)` call sites and 470 `runRepository(...)` call sites. These are source counts, not measured runtime pool counts.

Build the database layer once after the file's database is created, reuse that built context for setup, operations, and assertions, and close it explicitly after the file. Keep stateful service layers scoped to each test where required. Effect's test `layer` helper or an explicitly owned scope can provide this lifetime. Existing promise wrappers must route through that same context; merely adding an outer shared layer will not fix independently provided inner layers.

Start with one pool per file and a small measured maximum. Lock tests need enough connections for the holder, contender, and observer. Do not set every pool to one connection. Close the pool before any database drop/recreation and after all test fibers and HTTP servers have stopped.

### 2. Stop evicting idle connections after 1 ms

`packages/persistence/src/layers/PgClientLive.ts:83` configures `idleTimeout: "1 millis"` as a process-exit safety net. The driver passes this to `pg.Pool.idleTimeoutMillis`, so a short pause between queries can discard a reusable connection even within one scoped operation. The scope already has a pool finalizer.

After explicit ownership is in place, use an idle lifetime long enough to reuse connections. Measure this separately from sharing the pool. Validate process exit and connection cleanup; do not hide a leaked scope behind a tiny idle timeout. Admin create/drop operations also currently open separate short-lived pools and can share one scoped admin client.

### 3. Avoid resetting the whole mutable schema for every ordinary test

`integration-test-kit.ts:163` discovers public tables and truncates almost every non-reference table with `RESTART IDENTITY CASCADE`. This rewrites table/index storage and takes locks regardless of how little data a test used. The compose comments document a previous large filesystem cost from these resets. Disabling durability on the dedicated test server already addresses the historical fsync problem; it does not eliminate reset work.

Use rollback isolation selectively for tests whose entire setup, operation, and assertions can execute through one transaction context. Both fixture writes and repository calls must use that context. Independent `Effect.runPromise`/`Effect.provide` calls and HTTP request fibers do not automatically inherit it. An outer rollback transaction changes a repository's own transaction into a nested transaction/savepoint, so keep explicit tests of real commit, rollback, lock ordering, and independent connection visibility outside this wrapper.

For committed-data tests, benchmark small ordered deletes or targeted resets against the current truncate. Follow actual foreign-key dependencies; `CASCADE` can reach much more than the named table. Avoid replacing the shared helper with dozens of unrelated cleanup implementations. The wallet cache tests already demonstrate a small table-specific delete.

Also remove the redundant first reset: 55 files clone at module evaluation, then most immediately truncate again in their first `beforeEach`. Keep the semantics explicit: a fresh clone contains seeded assets, while the current reset removes assets. Skipping the first reset without reconciling that difference would change fixtures.

### 4. Tune workers and pools together

`vitest.config.ts:45` puts every integration file in one project without a project-specific worker cap. More workers means more simultaneous template clones, truncations, pool creation, and queries. Default ten-connection pools are maxima, not ten eagerly opened connections; nevertheless independently built pools can multiply the total.

Benchmark a few worker caps against the same full suite, using the same Postgres server configuration. Record wall time, failures, slowest tests, peak connections, and database waits. Select from repeated results, not CPU count alone. Keep file isolation enabled: mutable module-level fixtures and fixed IDs make blanket `--no-isolate` or concurrent tests unsafe.

Per-worker database reuse is a later experiment. The current per-file database isolates schema mutations and reference-table changes well. Reusing a worker database requires restoring schema and reference data as well as deleting rows; a blanket truncate is insufficient.

### 5. Make race synchronization precise before shrinking timeouts

`packages/persistence/tests/accounting/calculation-run-repository.integration.test.ts:580` polls `pg_locks` for *any* ungranted lock across the server. Under a parallel suite, another database's waiter can satisfy it prematurely. Match the current database and the intended blocked statement/backend. The shared `waitForQueryBlockedOnLock` is already closer to the needed behavior; use a more specific query identifier where multiple contenders exist.

`SourcesApiLive.integration.test.ts:1023` and `AssetOverridesApiLive.integration.test.ts:1350` hold trigger execution with `pg_sleep(0.5)`. `principal-asset-override-mutations.integration.test.ts:735` uses `pg_sleep(0.25)`. These impose fixed latency and create a window that can expire before the intended contender runs under load. Prefer an explicitly released database lock for tests of SQL locking, or a deferred signal at an existing service seam when that is what the test exercises. Release barriers in finalizers, including on assertion failure.

Polling helpers should have a wall-clock deadline and useful diagnostics, not only an attempt count: 500 attempts with 10 ms sleeps can exceed five seconds once query and scheduling time are included. Deliberate short negative waits in concurrency tests are not all removable; preserve what each assertion proves.

There are 11 explicit timeout override sites, including parameterized tests:

| File | Overrides |
| --- | --- |
| persistence/accounting/calculation-run-repository | One 10 s override |
| persistence/source-sync/source-normalization-repository | One 15 s override |
| sync-engine/source-sync/asset-resolution-attach | Three 15 s overrides |
| sync-engine/source-sync/coinbase-normalization | Six 15 s overrides |

Several Coinbase cases exercise normal sync behavior, while the attach overrides cover in-flight races. They need different investigation. Vitest's installed default test timeout is 5 s and hook timeout is 10 s. Removing a test timeout override does not constrain setup to 5 s. Measure setup and test bodies separately, and only remove overrides after repeated full-suite passes on the intended CI resources.

### 6. Separate non-database integration work from Postgres bootstrap

`apps/worker/tests/WorkerHealthServerLive.integration.test.ts` uses real TCP HTTP and no database, but selecting it still runs the integration project's Postgres template setup. Give non-database integration tests a project without that setup. Preserve real HTTP coverage. This mostly improves focused test runs; a full database suite still needs its template.

### 7. Right-size fixture work after the shared costs

45 integration files import `seedSyncEngineRepositoryFixture`. That helper creates a user, principal, billing account, credit ledger entry, Coinbase account, and source, and looks up two blockchains. Some narrow repository tests need less. Use a few composable fixture builders and combine sequential fixture stages within the shared database context. Keep fixtures honest and realistic rather than bypassing constraints.

Do not remove intentional large-input coverage: `TransactionsApiLive.integration.test.ts:1259` builds 20,000 entries as a boundary case. Likewise, the asset repository tests that run `seedData` repeatedly include checks of seed behavior; repeated seeding there is not automatically waste.

## Suggested test setup labels

| Purpose | Infrastructure | Isolation and lifetime |
| --- | --- | --- |
| Ordinary repository behavior | Real Postgres | File-scoped pool; rollback per eligible test |
| Commit, concurrency, and lock behavior | Real Postgres, multiple connections | Isolated database; committed setup; reset between tests |
| Migration and schema behavior | Real Postgres | Disposable database with explicitly chosen starting schema |
| API behavior | Real HTTP and Postgres | File-scoped DB pool; server/service lifetime chosen per fixture state |
| Worker health | Real TCP HTTP | Scoped server; no Postgres bootstrap |
| Provider/queue collaborator | Inline deterministic service | Per-test state; label it as a fake, alongside the real system pieces |

Labels describe a small set of helpers, not a requirement to introduce a general-purpose test framework. API tests that compare seeded reference behavior and tests that deliberately alter schema need explicit fixture choices.

## Validation plan

1. Establish the full-suite baseline with existing configuration and overrides.
2. Compare worker caps with no source changes.
3. Change pool ownership alone; compare timing and connection counts, verify cleanup.
4. Change idle timeout alone; repeat the comparison.
5. Measure reset and fixture phases; trial rollback on a narrow repository file and retain real transaction/concurrency coverage separately.
6. Correct race barriers, then remove overrides incrementally and repeat under full-suite contention.

No speedup should be claimed from static code findings. Report median and tail behavior over repeated runs on local and CI machines before choosing final defaults.

## Measured baseline

Command: `mise x -- pnpm run test --project=integration --reporter=json --outputFile=/tmp/taxmaxi-integration-baseline-network.json`. The first sandboxed attempt could not access localhost and was interrupted; this measurement used permitted local network access.

The default run reached the last file at **181.08 s** after the JSON report start timestamp. This is not full process wall time: final teardown/report writing may follow. **750 passed, four failed**, out of 754 collected tests. **11 REST API files failed collection** with `Cannot read properties of undefined (reading 'ast')`; their tests are absent from those counts. This is not a green or complete-suite baseline.

The calculation repository concurrent-claim test returned `PersistenceError` where `CalculationRunAlreadyStoredError` was expected. The other three failures took 5.02–6.08 s and had only `STACK_TRACE_ERROR` in the JSON output; they are consistent with the 5 s test deadline, but this reporter did not preserve an explicit timeout message. They were the movement correction application coverage test, transaction-detail replacement/withdrawal test, and Coinbase retry/follow-up replay test. Investigate the unexpected error separately from timeout tuning.

The slowest file spans were movement correction application (120.45 s), source normalization (113.74 s), provider assets (80.93 s), and asset resolution attach (67.01 s). File spans include setup between tests and are not sums of test body time. One aggregate Postgres snapshot observed four active and one idle test-database connections; this is not a peak connection measurement.

The API collection failure was reproduced independently with `mise x -- pnpm run test --project=integration packages/rest-api/tests/LegalReferenceApiLive.integration.test.ts --maxWorkers=1 --reporter=default`. The stack points to `packages/rest-api/src/definitions/AuthApi.ts:63`, where `Schema.Array(PasswordRequirement)` receives an undefined schema. This fails before any test executes. Resolve the imported schema/build issue before claiming complete API coverage; this review did not change it.

## Worker comparison

With `--maxWorkers=4` and otherwise unchanged source/configuration, all **754 collected tests passed**. The same **11 API collection failures** remained, so the process still exited with failure.

| Measurement | Default workers | Four workers |
| --- | ---: | ---: |
| Start timestamp to last file end | 181.08 s | 136.64 s |
| Passed / failed collected tests | 750 / 4 | 754 / 0 |
| API files failing collection | 11 | 11 |
| Slowest reported test duration | 6.08 s | 2.74 s |

The second run was about **24.5% shorter**. This supports testing an explicit integration worker cap before invasive fixture changes. It is one sequential comparison: caches, file scheduling, and other machine activity were not controlled, and the missing API tests change the load. Four workers is a promising candidate, not an established optimum. Keep existing overrides until the complete suite can collect and repeated runs confirm the chosen limit.

Command: `mise x -- pnpm run test --project=integration --maxWorkers=4 --reporter=json --outputFile=/tmp/taxmaxi-integration-workers4.json`.

Vitest's reported test durations include hooks and cleanup; they do not isolate database reset cost or test-body time. Add phase timing before attributing the savings to a particular database operation. JSON reports remain in `/tmp`; the durable measurements and per-file baseline are recorded here.

## File inventory

All first-party integration files are listed below. “Reset” means the file calls the common reset from hooks; “own cleanup” uses narrower cleanup; “initial clone” has no common per-test reset. Flags identify cases requiring individual review before changing isolation, not blanket eligibility for rollback. Baseline counts include parameterized cases.

| File | Cleanup/setup | Special isolation evidence | Passed / failed | File span, s |
| --- | --- | --- | --- | --- |
| `apps/worker/tests/WorkerHealthServerLive.integration.test.ts` | No database | Concurrent operations, HTTP | 2 / 0 | 0.05 |
| `packages/persistence/tests/accounting/calculation-run-repository.integration.test.ts` | Reset | Concurrent operations, Schema changes | 27 / 1 | 38.27 |
| `packages/persistence/tests/accounting/calculation-run-service.integration.test.ts` | Reset | Concurrent operations | 14 / 0 | 28.7 |
| `packages/persistence/tests/accounting/calculation-runs-schema.integration.test.ts` | Reset | Schema changes | 8 / 0 | 9.56 |
| `packages/persistence/tests/accounting/factual-ledger-repository.integration.test.ts` | Reset | — | 21 / 0 | 36.33 |
| `packages/persistence/tests/accounting/historical-asset-price-repository.integration.test.ts` | Reset | — | 3 / 0 | 3.39 |
| `packages/persistence/tests/accounting/principal-asset-override-application.integration.test.ts` | Reset | — | 21 / 0 | 37.56 |
| `packages/persistence/tests/accounting/principal-transaction-override-application.integration.test.ts` | Reset | — | 41 / 1 | 120.45 |
| `packages/persistence/tests/accounting/transaction-detail-repository.integration.test.ts` | Reset | — | 17 / 1 | 46.17 |
| `packages/persistence/tests/auth/email-verification-request-repository.integration.test.ts` | Reset | — | 2 / 0 | 2.18 |
| `packages/persistence/tests/auth/principal-claim-repository.integration.test.ts` | Reset | Concurrent operations | 1 / 0 | 2.18 |
| `packages/persistence/tests/auth/users-email-lower-index.integration.test.ts` | Initial clone | — | 1 / 0 | 0.05 |
| `packages/persistence/tests/billing-repository.integration.test.ts` | Reset | Concurrent operations | 25 / 0 | 29.59 |
| `packages/persistence/tests/source-sync/asset-exception-repository.integration.test.ts` | Reset | Concurrent operations, Schema changes | 38 / 0 | 59.63 |
| `packages/persistence/tests/source-sync/asset-repository.integration.test.ts` | Reset | Concurrent operations | 24 / 0 | 31.38 |
| `packages/persistence/tests/source-sync/asset-resolution-job-repository.integration.test.ts` | Reset | — | 13 / 0 | 18.28 |
| `packages/persistence/tests/source-sync/fact-target-links-schema.integration.test.ts` | Reset | — | 3 / 0 | 3.38 |
| `packages/persistence/tests/source-sync/principal-asset-override-fact-pairs.integration.test.ts` | Reset | — | 4 / 0 | 4.99 |
| `packages/persistence/tests/source-sync/principal-asset-override-mutations.integration.test.ts` | Reset | Concurrent operations, Schema changes | 21 / 0 | 31.46 |
| `packages/persistence/tests/source-sync/principal-asset-override-repository.integration.test.ts` | Reset | — | 8 / 0 | 10.38 |
| `packages/persistence/tests/source-sync/principal-asset-overrides-schema.integration.test.ts` | Reset | — | 12 / 0 | 8.55 |
| `packages/persistence/tests/source-sync/principal-transaction-override-mutations.integration.test.ts` | Reset | Concurrent operations, Schema changes | 26 / 0 | 65.09 |
| `packages/persistence/tests/source-sync/principal-transaction-override-repository.integration.test.ts` | Reset | — | 34 / 0 | 63.63 |
| `packages/persistence/tests/source-sync/principal-transaction-overrides-schema.integration.test.ts` | Reset | — | 9 / 0 | 8.26 |
| `packages/persistence/tests/source-sync/protocol-candidate-repository.integration.test.ts` | Reset | — | 9 / 0 | 10.2 |
| `packages/persistence/tests/source-sync/protocol-transaction-type-mapping-repository.integration.test.ts` | Reset | — | 18 / 0 | 24.26 |
| `packages/persistence/tests/source-sync/provider-asset-repository.integration.test.ts` | Reset | Concurrent operations, Schema changes | 57 / 0 | 80.93 |
| `packages/persistence/tests/source-sync/provider-asset-source-uses-migration.integration.test.ts` | Initial clone | Schema changes | 1 / 0 | 0.23 |
| `packages/persistence/tests/source-sync/provider-reference-repository.integration.test.ts` | Reset | — | 1 / 0 | 0.87 |
| `packages/persistence/tests/source-sync/source-normalization-repository.integration.test.ts` | Reset | Concurrent operations, Schema changes | 61 / 0 | 113.74 |
| `packages/persistence/tests/source-sync/source-raw-record-repository.integration.test.ts` | Reset | — | 2 / 0 | 2.08 |
| `packages/persistence/tests/source-sync/source-replay-repository.integration.test.ts` | Reset | — | 1 / 0 | 2.33 |
| `packages/persistence/tests/source-sync/source-repository.integration.test.ts` | Reset | — | 3 / 0 | 3.69 |
| `packages/persistence/tests/source-sync/source-sync-job-repository.integration.test.ts` | Reset | Schema changes | 33 / 0 | 47.47 |
| `packages/persistence/tests/source-sync/source-sync-run-repository.integration.test.ts` | Reset | — | 14 / 0 | 17.85 |
| `packages/persistence/tests/source-sync/source-sync-state-repository.integration.test.ts` | Reset | — | 2 / 0 | 1.69 |
| `packages/persistence/tests/source-sync/transfer-reconciliation.integration.test.ts` | Reset | Concurrent operations | 33 / 0 | 56.75 |
| `packages/persistence/tests/wallet-name-cache.integration.test.ts` | Own cleanup | — | 5 / 0 | 0.57 |
| `packages/rest-api/tests/AdminProtocolReviewApiLive.integration.test.ts` | Reset | HTTP | Collection failed | — |
| `packages/rest-api/tests/AssetCanonicalizationServiceLive.integration.test.ts` | Reset | Concurrent operations, Schema changes | 18 / 0 | 25.09 |
| `packages/rest-api/tests/AssetOverridesApiLive.integration.test.ts` | Reset | Concurrent operations, HTTP, Schema changes | Collection failed | — |
| `packages/rest-api/tests/AssetsApiLive.integration.test.ts` | Initial clone | HTTP | Collection failed | — |
| `packages/rest-api/tests/AuthApiLive.integration.test.ts` | Own cleanup | HTTP | Collection failed | — |
| `packages/rest-api/tests/BillingApiLive.integration.test.ts` | Initial clone | HTTP | Collection failed | — |
| `packages/rest-api/tests/LegalReferenceApiLive.integration.test.ts` | Initial clone | HTTP | Collection failed | — |
| `packages/rest-api/tests/PortfolioApiLive.integration.test.ts` | Reset | HTTP | Collection failed | — |
| `packages/rest-api/tests/SourcesApiLive.integration.test.ts` | Reset | Concurrent operations, HTTP, Schema changes | Collection failed | — |
| `packages/rest-api/tests/SyncRunsApiLive.integration.test.ts` | Reset | Concurrent operations, HTTP | Collection failed | — |
| `packages/rest-api/tests/TransactionOverridesApiLive.integration.test.ts` | Reset | Concurrent operations, HTTP | Collection failed | — |
| `packages/rest-api/tests/TransactionsApiLive.integration.test.ts` | Reset | HTTP | Collection failed | — |
| `packages/rest-api/tests/WalletNameResolutionServiceLive.integration.test.ts` | Own cleanup | — | 5 / 0 | 0.35 |
| `packages/sync-engine/tests/source-sync/asset-resolution-attach.integration.test.ts` | Reset | Concurrent operations | 28 / 0 | 67.01 |
| `packages/sync-engine/tests/source-sync/asset-resolution-job.integration.test.ts` | Reset | — | 8 / 0 | 18.47 |
| `packages/sync-engine/tests/source-sync/coinbase-normalization.integration.test.ts` | Reset | — | 22 / 0 | 58.79 |
| `packages/sync-engine/tests/source-sync/coinbase-reference-mapping.integration.test.ts` | Reset | — | 27 / 0 | 58.38 |
| `packages/sync-engine/tests/source-sync/coinbase-reference-replay.integration.test.ts` | Reset | Concurrent operations | 1 / 1 | 7.54 |
| `packages/sync-engine/tests/source-sync/helius-solana-asset-resolution.integration.test.ts` | Reset | — | 26 / 0 | 45.84 |
