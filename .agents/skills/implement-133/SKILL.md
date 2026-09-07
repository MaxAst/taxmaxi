---
name: implement-133
description: "Implement one delivery task from verified email sign-up and login (#133). Pass the task ID as the argument, e.g. /implement-133 T01."
disable-model-invocation: true
---

Implement exactly one task from the delivery checklist of issue #133 (Add verified email and password sign-up and login to www). The task ID is given as the argument. If no argument is given, ask which task to do, then stop.

## Allowed tasks

Run only the task the orchestrator assigns, from the live checklist on #133. Tasks: T01 canonical account email (migration), T02 remove the optional-verification flags, T03 provider flags and password rule codes and `/app` redirect, T04 record verification send facts (migration), T05 enforce the resend rule, T06 SDK local auth, T07 provider-driven login and sign-up pages, T08 verify-email page, T09 maintainer gate on the deployed journey, T10 Harvest with the `harvest` skill.

Order and blocking:

- T01 and T04 each carry a Drizzle migration. Either may open only while no other PR with a migration is open (`gh pr list` at pickup; PR #320 from #108 was open at arming with a `users` migration). Refuse a migration task while another migration PR is open and say why.
- T02 and T03 carry no migration and may run before T01. T02 was assigned first at arming for that reason.
- T05 needs T04 merged (it reads `send_count` and `last_sent_at`).
- T06 needs T03 and T05 merged (the SDK maps the new error shapes).
- T07 needs T06 merged. T08 needs T06 and T05 merged.
- T09 is a gate. The maintainer runs the deployed journey and records the result. A worker does not implement T09; it may only prepare the exact steps as a comment if asked.
- T10 runs after T09 is recorded, with the `harvest` skill.
- T01 has an in-task gate: post the read-only counts from D07 (row counts only, never emails; see `docs/agents/issue-tracker.md`) on #133 and stop before merge until the maintainer approves the one-off deletion. The migration must not run on prod before that approval.
- T04 has a replay gate: the PR is incomplete until `email_verification_requests` has been cleared outside the migration on every environment the migration runs on and a fresh register shows both new columns written by the writer.
- Result classification per task is fixed in the checklist text: T01, T03, T05 are result-changing and paste the named decisions; T02, T04, T06, T07, T08 are result-preserving. Never mix the two in one PR.
- The latest recorded decisions on #133 always govern over this file. If this file and a newer recorded decision disagree, follow the decision and say so in the PR.

## Reading at pickup

Read before coding; refresh tracker state at handoffs and decision changes, reusing unchanged reference docs.

1. `gh issue view 133 --comments` — the body is the plan; the newest recorded decision wins. Read the parent #131 body once for the epic's Solution and Out of scope.
2. `AGENTS.md`, especially "Delivery PRs and Reviews", "Database", and "Critical Guidelines".
3. `docs/adr/0003-require-explicit-login-method-linking.md` — an email match is never proof of identity; canonicalizing emails must not change linking. `docs/adr/0004-dispatch-coinbase-oauth-by-stored-intent.md` — the Coinbase callback stays as it is; do not touch it. `docs/adr/0012-stored-facts-carry-their-links.md` — send facts are written by the writer, never inferred from rows; clearing happens outside the migration. `docs/agents/delivery-process.md` — "Validation and test reliability", "Pre-launch migration planning", "Grounding and proof". `docs/agents/issue-tracker.md` — real emails and user data never go on the public issue. PR #154 is the closing record of #132: it set the `account` and `loginMethods` contract on `GET /auth/me` that T03 and T06 extend.
4. The glossary of the owning context (`packages/core/CONTEXT.md`, "Account language", via `CONTEXT-MAP.md`) — use its vocabulary for naming: account, account email, login method, identity.

## Coordination rules

Refresh open PRs at pickup. Active streams at arming: #108 (PR #320 open, `feat/108-t01`) owns the `welcome_seen_at` migration and touches `UsersTable.ts`, `AuthUser.ts`, `UserRepository*.ts`, `AuthApi.ts`, `AuthApiLive.ts`, `AuthApiLive.integration.test.ts`, `oauth-orchestration.test.ts`, and `packages/sdk/src/auth/index.ts`; later #108 tasks touch `apps/www/src/routes/app.tsx`, `dashboard.tsx`, `app.billing.tsx`, and the messages files. #127 T04/T05 (transaction inspector) may open PRs touching `apps/www/src/components/transactions-table.tsx`, `dashboard.tsx`, `apps/www/src/integrations/taxmaxi/queries.ts`, and `apps/www/src/routes/app.tsx`. PR #210 (Postgres worker queue) is parked reference material with its own migration; it is not an active stream. PR #211 is an onboarding prototype draft. PRs #179 and #176 are docs drafts. None is authority to widen this task. Preserve others' edits in shared files, rebase rather than rewrite, and report out-of-surface conflicts instead of resolving them.

- Rebase on latest `origin/main` before opening the PR, and again before merging.
- The cross-stream rules (one migration in flight, out-of-surface conflicts stop the worker) live in `docs/agents/delivery-process.md` ("Execution") — follow them from there, including "Worker ownership and handoff". Use "Pre-launch migration planning" for schema work and existing authorization.

## Scope fence

- Do only the one task.
- Every rule governing your PR — coherent sizing and cut review, the merged-main file-cut recheck, fixture alignment as a category, result classification with pasted decisions, facts recorded at the writer, values meaning what their type says — lives in `AGENTS.md` ("Delivery PRs and Reviews", "Critical Guidelines", Database) and `docs/agents/delivery-process.md` ("Delivery checklist rules"). Enforce them from those documents; when this file lags them, they win.
- The behaviors those rules demand of you mid-task: stop and say so when the task outgrows its cut; record a file-list correction on the issue before coding around it; stop when a fix starts matching, grouping, or counting stored rows to find which decision applies (ADR 0012 — a recorded fact is missing).
- Out of scope for every task here (from #133): sign-in help and reset (#134), Google login and removal of `linkIdentitiesByEmail` / `AUTH_AUTO_LINK_BY_EMAIL` (#135), adding a first password (#136), changing or removing methods (#137), linking from Settings (#138, #139), hashing stored verification codes, a shared rate limiter, display-name editing, CLI email login, and any browser end-to-end framework. Leave the Coinbase path exactly as it is.

## Domain rules that bite

- **The email is canonical where it is written.** `AuthService` trims and lowercases before it stores an account email, a local identity's `provider_id`, or a verification request, and before it looks a local identity up for login. Doing it only in the HTTP handler or only in the web form is wrong: the service is the writer. The `lower(email)` unique index is a backstop, not the rule. An account created from an OAuth login stores the canonical form of the provider email; the provider payload stays as reported. (D01)
- **Canonical email changes no linking.** Registration with an existing email, in any casing, is a 409 conflict and creates nothing. Nothing in this spec links an identity to an account because emails match (ADR 0003). `linkIdentitiesByEmail` stays untouched until #135.
- **Verification is mandatory and has no flag.** After T02 no `requireEmailVerification` exists anywhere: not in core config, env readers, env examples, or tests. Do not add a replacement flag. (D02)
- **Responses carry codes, never display text.** `ProviderMetadata` has no `name`; the web app maps `type` to a paraglide label. Password requirements are the codes `min_length`, `lowercase`, `uppercase`, `number`, `special_char` plus `minPasswordLength`. If you find yourself writing an English sentence into a response schema, stop. (D03, D04; AGENTS.md rule 10)
- **Verification redirects to `/app`.** `/home` does not exist in `apps/www`. (D05)
- **Send facts are recorded by the writer.** `send_count` and `last_sent_at` are not null with no default that records a false fact. Register writes `send_count = 1`; resend copies the replaced row's count plus one. The rule in T05 reads these two columns and nothing else; it never counts rows or sent emails to work out the limit. (D06, ADR 0012)
- **The resend rule is a table, apply it exactly.** Inside 60 s: 429 `VerificationResendRateLimitedError { retryAfterSeconds }`, no row, no email. At five sends: 429 with `retryAfterSeconds` until the request expires. Unverified login inside the cooldown: 403 as today, cookie restored, no email. Unverified login outside it: 403, email sent, `last_sent_at` updated. Errors are tagged types; no string matching on messages. (D06)
- **Migrations are generated and schema-only.** `mise x -- pnpm --filter @my/persistence run migration:generate` only; never hand-edit or hand-write one. No DELETE, UPDATE, or INSERT in the chain. Rows that block the `lower(email)` index or the new not-null columns are removed in a one-off step outside the migration after the maintainer approves (T01) or as the replay gate (T04). (D07; AGENTS.md Database)
- **The browser talks to the API directly for local auth.** Sign-up, verify, resend, and login go through `TaxMaxi.fromBrowserSession` so the API sets and clears its own cookies. No www server function proxies these calls. The form asks for email and password only. (D08)
- **Every www string is a paraglide message** in both `en.json` and `de.json`. Error codes from the API map to messages; raw error text is never rendered.
- **Typed rejections are correct.** A weak password, a wrong code, or a rate-limited resend returns its typed error; the request fails and nothing is written. Do not widen accepted input to make a test pass.

## Seams for TDD

Use the issue's Testing and seams table as the exact proof map; the rows below name the task, the seam, and the prior art.

- **HTTP** `packages/rest-api/tests/AuthApiLive.integration.test.ts` (real Postgres, stubbed hasher, token generator, and `sentVerificationCodes`). T01: canonical email on register and `GET /auth/me`, case-variant login 200, case-variant re-register 409 with one `users` row and one `local` identity. T02: the existing unverified-login 403 with no flag in the test config. T03: `GET /auth/providers` exact shape with only `local`, weak password `["min_length", "number"]` with `minPasswordLength: 8`, verify body `{ redirectTo: "/app" }`. T04: `send_count = 1` after register, `2` after resend. T05: resend inside cooldown 429 with `retryAfterSeconds` in 1..60 and one sent code; resend after a SQL backdate of 61 s gives 200 and a new cookie; sixth resend 429 with `retryAfterSeconds` equal to seconds until `expires_at`; unverified login inside the cooldown keeps the cookie and sends nothing. Prior art: the register, resend, stale-code, verify, and unverified-login cases already in that file.
- **Service** `packages/persistence/tests/auth/oauth-orchestration.test.ts` (in-memory repositories around `AuthServiceLive`). T01: `completeOAuthLogin` with provider email `Person@Gmail.test` stores `person@gmail.test` and leaves `providerData` unchanged. T02–T05: mechanical fixture alignment (config shape, verification request rows).
- **Schema** `packages/persistence/tests/auth/*.integration.test.ts` with `makeIntegrationTestDatabaseContext`. T01: a new schema test inserts `a@x.test` then `A@x.test` directly and the second insert fails on the `lower(email)` index. T04: `email-verification-request-repository.integration.test.ts` builds rows with both new columns. Prior art: `email-verification-request-repository.integration.test.ts`, `principal-claim-repository.integration.test.ts`.
- **SDK** `packages/sdk/tests/auth.test.ts` (new) with the captured-fetch pattern from `packages/sdk/tests/index.test.ts`. T06: each method hits its endpoint with the right method and body; the three error helpers read the 400, 403, and 429 bodies.
- **Web** `apps/www/tests/components/auth-page.test.tsx` (new) and `apps/www/tests/routes/verify-email/verify-email.test.tsx` (new) with Testing Library and a faked `taxmaxi` router context, as in `apps/www/tests/routes/app.settings/settings-page.test.tsx` and `apps/www/tests/components/account-menu.test.tsx`. T07: provider-driven rendering for `[coinbase]`, `[local]`, `[local, coinbase]`; sign-up success navigates to `/verify-email` with the button disabled while pending; conflict and weak-password messages with `aria-invalid` and `aria-describedby`; login outcomes navigate to `/app`, show the generic message, or navigate to `/verify-email`. T08: verify outcomes; resend notice; 429 with `retryAfterSeconds: 42` disables the button with a 42 s countdown.
- **Deployed** T09: the maintainer's manual journey with Resend delivery.

Apply "Grounding and proof" in `docs/agents/delivery-process.md`: complete this task's mapped proof as its seams become available.

## Done criteria

1. Apply `docs/agents/delivery-process.md` ("Validation and test reliability"): choose local checks by the change, retain explicit task/hosted gates, and rerun invalidated checks. AGENTS.md's red-gate rule still applies; an isolated pass is diagnostic, not replacement proof.
2. /code-review the work.
3. Branch from latest `main`. Conventional commit with `Refs: #133` in the footer.
4. Hand off head/base, changed files, check evidence, remaining work and blockers per the process doc. Open a PR referencing #133 and the task ID, stating the result classification, with every relied-on decision pasted verbatim with its source.
