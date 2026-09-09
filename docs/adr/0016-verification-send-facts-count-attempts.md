# Verification send facts count attempts and are written under one per-user lock

A local sign-up sends an eight-character code by email. The person can ask for a new code, and an unverified login sends one too. Before #133 nothing recorded when a code was last sent, so every call sent another email. #133 added `send_count` and `last_sent_at` to `email_verification_requests` and built the one-minute cooldown and the five-send cap on them. Three review rounds on PR #330 were the same defect class: register, resend, and unverified login each wrote the same user's request and raced each other, so one send could go unrecorded or a count could reset. This ADR records the two rules that closed that class, because later specs (#134 sign-in help and its rate limits, #136 add password with a fresh code) send codes the same way.

## Decision

- `send_count` and `last_sent_at` record delivery attempts, not accepted deliveries. The repository writes them in the same locked transaction that prepares the code, right before the code is handed to delivery. Every attempt sets `last_sent_at`, so every attempt starts the cooldown. Only two kinds of attempt advance `send_count`: the first send of a request sets it to 1 (`startOrReuse` when no active request exists), and an explicit resend adds 1 (`renew`). An unverified login that reuses an active request outside the cooldown updates only `last_sent_at`; it does not use one of the five sends. If delivery then fails, the endpoint returns an error and the recorded facts stand. (#133, D06 amendment.)
- The request-flow writers of one user's verification request (`create`, `startOrReuse`, `renew`, `consume`) run under one per-user lock inside the repository (`pg_advisory_xact_lock` keyed by the user ID, in `EmailVerificationRequestRepositoryLive`). Register and unverified login go through one reuse-or-create operation; resend goes through one renew operation; both read the previous send time and count under the lock and return a tagged outcome (`sent`, `cooldown`, `capped`, `missing`). The service never decides the rule from a row it read before the lock. The expiry cleanup (`deleteExpired`) runs without the lock: it only removes rows already past `expires_at`, which the locked reads treat as gone anyway.
- A task that adds a counter or a last-time column names, at cut time, who serializes its writers. "Facts only" is not a complete task.

## Consequences

The limits stay tight when the email provider is flaky: after a provider error the person always waits one minute, and the failed delivery uses one of the five sends when it was a first send or an explicit resend, because a login-triggered reuse of an active request does not advance `send_count`. That is the accepted cost; the limits guard against spam and brute force, and a provider error is rare.

Two concurrent resends for one user cannot both count as one send. An unverified login that loses a race against a resend reuses the resend's row instead of replacing it, so the count never resets inside a lineage.

Reading the rule from stored rows outside the lock is not allowed. A future endpoint that sends a code (sign-in help, add password, security verification) either goes through the same repository operations or brings its own lock and records its own attempt facts at the writer (ADR 0012).

## Considered options

Counting only accepted deliveries was rejected: the delivery result comes back after the transaction, so recording it would need a second write outside the lock and would let a flaky provider hand out unlimited codes.

Serializing in the service with an in-process mutex was rejected: several API instances share one database, so only the database can serialize the writers.
