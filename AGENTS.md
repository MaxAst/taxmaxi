TaxMaxi is an open-source crypto tax API. The API follows RESTful principles and its docs can be found under https://api.taxmaxi.com/openapi.json. You can also install the CLI with `npm i -g tax`, via which you can calculate crypto taxes right from your terminal. The first supported jurisdiction is Germany.

The public product surface is CLI/API first with a web app that shows off the API's capabilities. Do not add a CMS, billing system, admin console, or marketing site unless explicitly requested.

## Communication

Use simple, concrete words when talking to the maintainer, writing plans, writing docs, or adding comments. Do not overcomplicate wording. Examples of words to avoid when there is a better, simpler word: materialize, normalize, canonical, canonicalize, invariant, provenance

## Launch Status

The product is pre-launch and pre-revenue. Prefer clean code and clean schema over compatibility bridges. Hard migrations are acceptable when they simplify the system.

## Vendored Repositories

This project vendors external repositories under repos/

- Use vendored repositories as read-only reference material when working with related libraries
- Prefer examples and patterns from the vendored source code over generated guesses or web search results
- Do not edit files under repos/ unless explicitly asked
- Do not import from repos/ - application code should continue importing from normal package dependencies

When writing Effect code, inspect repos/effect/ for examples of idiomatic usage, tests, module structure, and API design. Treat it as the source of truth for Effect patterns.

## Repository Scope

Keep these production-shaped surfaces intact:

- `apps/cli` - installable `tax` CLI and future TUI entrypoint
- `apps/server` - hosted REST API used by the CLI
- `apps/worker` - BullMQ/Redis worker for sync and classification jobs
- `packages/core` - domain contracts and framework-light core types
- `packages/persistence` - schema, SQL, repository contracts, and live layers
- `packages/rest-api` - HTTP API definitions and handlers
- `packages/sync-engine` - provider sync, Solana classification, Helius integration, replay/resume logic
- `packages/sdk` - JS SDK API client

## Build/Lint/Test Commands

### Toolchain

Use `mise` for all Node/package-manager commands in this repo.

- Run package scripts as `mise x -- pnpm ...`
- Do not call `pnpm`, `npm`, `node`, `oxlint`, `oxfmt`, `vitest`, or `tsc` directly unless explicitly requested.
- This avoids PATH drift and native binding/code-signature failures from tools launched outside the mise environment.

### Development

Use turbo CLI for running dev servers and builds. Default to scripts in package.json of the given package, for example `mise x -- pnpm --filter @my/rest-api run type-check` or `mise x -- pnpm --filter server run dev`. Avoid custom one-off commands when a package script exists. Use line breaks between variable and function definitions, unless they are one line only and it makes sense to group them.

### Testing

```bash
mise x -- pnpm run test                                    # Run all tests
mise x -- pnpm run test transactions.test.ts               # Run single test file
mise x -- pnpm run test packages/rest-api                  # Run one package
mise x -- pnpm run test apps/www                           # Run one app
mise x -- pnpm run test --project=unit                     # Run only unit tests
mise x -- pnpm run test --project=integration              # Run only integration tests
mise x -- pnpm run test -t "test name"                     # Run tests matching name
```

Run tests from the repo root. Packages and apps do not have their own test scripts.

Test files use naming conventions:

- `*.test.ts` - Unit tests
- `*.integration.test.ts` - Integration tests, usually requiring DB setup

### Code Quality

```bash
mise x -- pnpm run lint              # Run oxlint across all packages
mise x -- pnpm run format            # Run oxfmt across all packages
mise x -- pnpm run type-check        # TypeScript type checking
mise x -- pnpm run type-check:tests  # TypeScript type checking for test files
```

### Database

```bash
mise x -- pnpm --filter @my/persistence run build
mise x -- pnpm --filter @my/persistence run migration:generate
mise x -- pnpm --filter @my/persistence run migration:run
```

Preserve useful seed data by rewriting it into clean new seed migrations instead of restoring the old migration chain.

Pre Launch Only (i.e. until we stop using vX.X.X-beta.X git tags):
Migrations change schema only. They must never touch stored data: no DELETE, no TRUNCATE, no UPDATE backfills, no INSERT-from-SELECT transformations. A migration runs whenever the chain runs, in contexts nobody can predict, so a destructive statement in the chain is a permanent landmine.

When a schema change needs existing rows gone or in a new shape (for example, adding a required column to a populated table), the clearing happens outside the migration: a one-off script or manual step, run deliberately, once, documented in the PR. Then replay or reseeding regenerates the rows through the normal writers. Pre-launch, clearing any table this way, including on prod, is fine — the data is disposable. The migration itself stays clean either way.

Migration files come from Drizzle generation only: `mise x -- pnpm --filter @my/persistence run migration:generate`. Never edit a generated migration file by hand, and never write a migration file from scratch, without the maintainer's explicit approval for that specific file. If generation produces SQL that seems wrong or incomplete, stop and report — do not correct the file manually.

## Commit Messages

Use Conventional Commits 1.0.0 for hand-written commit messages:

```text
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

- Use lowercase types and concise imperative descriptions, for example `feat(sync-engine): add provider module registry`.
- Prefer scopes that match repo surfaces or established areas, such as `cli`, `server`, `worker`, `core`, `persistence`, `rest-api`, `sync-engine`, `sdk`, `frontend`, `docs`, `repo`, and `skills`.
- Use `feat` for user-facing or API capability additions and `fix` for bug fixes.
- Use supporting types when appropriate: `test`, `docs`, `chore`, `refactor`, `perf`, `build`, and `ci`.
- Mark breaking API, CLI, schema, or contract changes with `!` after the type/scope or a `BREAKING CHANGE:` footer, even while pre-launch.
- Add a body after a blank line when the commit needs rationale, migration notes, or non-obvious context. Use footer trailers such as `Refs: #123` when useful.
- Avoid untyped summaries such as `update stuff` or `use new flow` for hand-written commits. Merge commits generated by GitHub are acceptable.

## Naming Conventions

- Files: Services use `PascalCaseService.ts`
- Classes/Services: PascalCase (`TransactionService`)
- Functions: camelCase (`getTransactionsForAddress`)
- Constants: UPPER_SNAKE_CASE (`ZERO_ADDRESS`)
- Types: PascalCase (`TransactionInsert`)

## Repository Consistency

- Follow existing file placement and naming patterns before creating new files.
- Prefer colocated private helpers inside an existing module when they are only used there.
- Create new files only when there is clear reuse or an existing repo pattern for that separation.
- When in doubt, mirror adjacent files in the same package/layer for structure and naming.

## Architecture Invariants

### Core Boundaries

- `packages/core/**` must not import from adapter or infrastructure packages such as `@my/persistence`, `@my/rest-api`, or app packages.
- Keep core domain-focused and framework-light where possible: schemas, value objects, contracts, and tagged errors.

### Persistence Boundaries

- In `packages/persistence/src/services/**`, keep files implementation-free:
  - Allowed: interfaces, `Context.Tag` declarations, shared type aliases, tagged errors.
  - Not allowed: provider logic, SQL queries, HTTP calls, `Layer.effect(...)`, or `Effect.gen(...)` implementations.
- Put concrete implementations in `packages/persistence/src/layers/**` and export them via layer barrels only when actually imported externally.
- If adding a new provider capability, follow this shape:
  - `services/FooService.ts` -> contract/tag/types only
  - `layers/FooServiceLive.ts` -> implementation

### REST API Boundaries

- Keep API contracts and schemas in `packages/rest-api/src/definitions/**`.
- Keep runtime handler implementations in `packages/rest-api/src/layers/**`.

### Sync Engine Boundaries

- Keep provider-specific fetch/normalization logic in `packages/sync-engine/src/providers/**`.
- Keep source sync orchestration, replay/resume, Helius integration, Solana classification, and queue payload contracts in `packages/sync-engine/src/services/**` and `packages/sync-engine/src/layers/**`.
- Persistence repositories should expose durable storage operations; sync orchestration should not reach into table details directly.

## Documentation Requirements

- For new files in `packages/persistence/src/services/**` and `packages/persistence/src/layers/**`, add top-level module JSDoc with `@module`.
- Add JSDoc on exported service contracts/layers and non-obvious exported types.
- Preserve useful existing docs/comments when refactoring; do not drop high-signal API documentation.
- When replacing or removing a documented method, add equivalent JSDoc to the new method(s).

## Barrel Files

Only add an export for a service/layer to a barrel file if it is actually imported from other packages/apps. Do not add it if only sibling files import it.

## Function Arguments

Favor a single object parameter over multiple positional args when there are more than two params:

```typescript
// Preferred
function createTransaction({ hash, amount, timestamp }: CreateTxParams) {}

// Avoid
function createTransaction(hash: string, amount: number, timestamp: Date) {}
```

## Database Queries

Select only needed columns. Do not use `SELECT *`.

## Critical Guidelines

1. No type shortcuts: never use `any` or non-null assertion `!`.
2. Internal dependencies must use `workspace:*`.
3. Keep functions small and composable.
4. Use `Effect.logInfo` and `Effect.logError` for logging. Always pass structured data as the first argument and a static message string as the second, for example `Effect.logInfo({ sourceId, jobId, count }, "Batch processed")`.
5. In Effect flows, use `Effect.fail` / `Effect.try` error mapping. Avoid throwing raw `Error` manually.
6. For external or unknown payloads such as OAuth metadata, HTTP bodies, JSONB, provider payloads, and query params, use the schema library established by that package instead of manual `typeof` parsing or `as` casts. Effect-based packages use `effect/Schema`; `apps/www` uses Zod.
7. Only commit when explicitly requested by the user.
8. In Effect-based packages, load environment variables with Effect Config instead of `process.env` directly. `apps/www` uses its generated Cloudflare environment types and must not add Effect only for configuration loading.
9. Keep `.env` files local. They are intentionally present for this working copy but must not be committed.
10. In `apps/www`, every user-visible string must come from paraglide messages (`m["..."]()` with keys in `apps/www/messages/en.json` and `de.json`). Do not hardcode English copy in components. Backend responses carry machine-readable codes, not display text; the frontend maps codes to localized copy.

## Delivery PRs and Reviews

Delivery work is one PR per checklist task on a spec issue.

After a rebase, check whether the new base or conflict resolution affects the PR's changes or behavior. If neither is affected, carry the existing automated Codex approval forward and do not request another review only because commit IDs changed. Request a new review when the PR's changes or behavior are affected.

Sometimes new code must give a different result than the old code for the same input, because the old result was wrong. We allow this only when the change is written down first, as a task note on the spec issue or in an ADR.

Implementers:

- State in the PR description whether the PR changes any results. One PR must not mix result-changing work with result-preserving work.
- For each result the PR changes on purpose, paste the written-down decision into the PR description and name its source, for example "#212, T04 note". A link alone is not enough, because reviewers cannot always open GitHub issues.
- If you discover during the work that a result must change, write the decision on the spec issue first, then paste it.
- Record facts where they are created; never infer them later from stored rows (ADR 0012). If a fix needs matching, grouping, or counting over stored rows to find which decision applies to a fact, stop: a recorded fact is missing. Name it and record it at the writer.
- A value must mean what its type says. Never put one kind of ID in a field for another kind, never give a required new column a default that records a false fact, and never stage a required fact as a nullable column. No file count justifies a false value.
- Before coding, recheck the task's file cut against merged `main`. Record a file-list correction on the spec issue before touching code. A third correction on one task means the task was cut wrong: stop and recut.
- When a schema or contract change forces test fixtures to state a fact they already have, those test-only files are a category, not a count. List production artifacts separately from fixture files in the PR description so review can treat the fixtures as mechanical.
- A PR may note a failure that already exists on untouched `main`, but that note is a task for the orchestrator, not a footnote. A red gate is fixed before the next feature PR opens; it is never carried across more than one PR.

Reviewers:

- When a PR description pastes a decision, check that the pasted text really exists at the named source. If it exists, accept that result change. Do not report it as a finding. Do not report further examples of the same change. If you think the decision itself is wrong, comment on the spec issue.
- Do not treat the old code as correct by default. Before launch, we replace known defects of the old code on purpose.
- Use P0 and P1 only when code writes wrong data, leaves half-updated state, has a security problem, or loses data. "This belongs in a later task" is P3.
- Some inputs are junk, for example a leg whose fiat currency field says "USDC". The old code often accepted junk and wrote wrong numbers. New code may reject junk; the rejection is correct. Check only what happens after the rejection. Correct: the affected transaction becomes a review item and the rest of the sync continues. Wrong: the error stops the whole sync job. Report the second case only. Do not ask to accept the junk again.

## Agent skills

### Delivery process

Work moves through capture, triage, definition, execution, and harvest. The issue body is the plan; comments are events. See `docs/agents/delivery-process.md`.

### Issue tracker

Durable product work is tracked in GitHub Issues and is public by default. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default Matt Pocock triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Use a multi-context layout for TaxMaxi's apps and packages. See `docs/agents/domain.md`.
