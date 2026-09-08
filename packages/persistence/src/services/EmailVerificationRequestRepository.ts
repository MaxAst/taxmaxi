/**
 * EmailVerificationRequestRepository - Repository contract for verification requests
 *
 * Stores short-lived local email verification codes before a user can complete
 * session creation.
 *
 * @module EmailVerificationRequestRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import type {
  AuthUserId,
  EmailVerificationCode,
  EmailVerificationRequest,
  EmailVerificationRequestId,
  Email,
} from "@my/core/authentication"
import type { Timestamp } from "@my/core/shared/values/Timestamp"
import type { PersistenceError } from "../errors/RepositoryError.ts"

/**
 * EmailVerificationRequestInsert - Input required to create a verification request.
 *
 * The writer states the send facts: `sendCount` is 1 for a first request and
 * the replaced request's count plus one for a resend; `lastSentAt` is when the
 * code is handed to delivery.
 */
export interface EmailVerificationRequestInsert {
  readonly id: EmailVerificationRequestId
  readonly userId: AuthUserId
  readonly email: Email
  readonly code: EmailVerificationCode
  readonly expiresAt: Timestamp
  readonly sendCount: EmailVerificationRequest["sendCount"]
  readonly lastSentAt: Timestamp
}

/**
 * EmailVerificationRequestStart - Input to send a code to a user who may
 * already have an active request.
 *
 * `id`, `code`, and `lifetimeMillis` are used only when no active request
 * exists and a fresh one is inserted. The send time is taken by the repository
 * inside the user's write lock; it decides which existing request still counts
 * as active, and the fresh request expires `lifetimeMillis` after it, so a
 * wait on the lock does not shorten the code's life. `cooldownMillis` is the
 * least time between two sends of the same request: an active request whose
 * last send is younger than that is returned without a send.
 */
export interface EmailVerificationRequestStart {
  readonly id: EmailVerificationRequestId
  readonly userId: AuthUserId
  readonly email: Email
  readonly code: EmailVerificationCode
  readonly lifetimeMillis: number
  readonly cooldownMillis: number
}

/**
 * EmailVerificationRequestRenewal - Input to replace a request with a fresh code.
 *
 * `id` names the request being replaced. The replacement keeps its user and
 * email, takes the replaced request's `sendCount` plus one, records the send
 * time taken by the repository inside the user's write lock, and expires
 * `lifetimeMillis` after that time. `cooldownMillis` is the least time since
 * the replaced request's last send, and `maxSendCount` the most sends one
 * request lineage may have; both are checked under the lock before anything
 * is written.
 */
export interface EmailVerificationRequestRenewal {
  readonly id: EmailVerificationRequestId
  readonly replacementId: EmailVerificationRequestId
  readonly code: EmailVerificationCode
  readonly lifetimeMillis: number
  readonly cooldownMillis: number
  readonly maxSendCount: number
}

/**
 * EmailVerificationSent - The send facts were written; the caller hands
 * `request.code` to delivery.
 */
export interface EmailVerificationSent {
  readonly _tag: "sent"
  readonly request: EmailVerificationRequest
}

/**
 * EmailVerificationCooldown - The last send of `request` is younger than the
 * cooldown. Nothing was written and nothing is sent; `retryAfterMillis` is the
 * rest of the cooldown.
 */
export interface EmailVerificationCooldown {
  readonly _tag: "cooldown"
  readonly request: EmailVerificationRequest
  readonly retryAfterMillis: number
}

/**
 * EmailVerificationCapped - `request` has used all sends of its lineage.
 * Nothing was written and nothing is sent; `retryAfterMillis` is the time
 * until the request expires.
 */
export interface EmailVerificationCapped {
  readonly _tag: "capped"
  readonly request: EmailVerificationRequest
  readonly retryAfterMillis: number
}

/**
 * EmailVerificationMissing - The request is gone or has expired.
 */
export interface EmailVerificationMissing {
  readonly _tag: "missing"
}

/**
 * EmailVerificationRequestStartOutcome - What `startOrReuse` decided under
 * the user's write lock.
 */
export type EmailVerificationRequestStartOutcome = EmailVerificationSent | EmailVerificationCooldown

/**
 * EmailVerificationRequestRenewalOutcome - What `renew` decided under the
 * user's write lock.
 */
export type EmailVerificationRequestRenewalOutcome =
  | EmailVerificationSent
  | EmailVerificationCooldown
  | EmailVerificationCapped
  | EmailVerificationMissing

/**
 * EmailVerificationRequestRepositoryService - CRUD operations for verification requests.
 */
export interface EmailVerificationRequestRepositoryService {
  /**
   * Create a new verification request.
   *
   * Replaces any existing request for the same user so that only the most
   * recent verification code remains active. Runs under the user's write lock.
   */
  readonly create: (
    request: EmailVerificationRequestInsert
  ) => Effect.Effect<EmailVerificationRequest, PersistenceError>

  /**
   * Reuse the user's active request or start a fresh one, in one transaction
   * under the user's write lock.
   *
   * The send time is taken once inside the lock and decides which request is
   * still active, whether the cooldown has passed, the written `lastSentAt`,
   * and the fresh request's `expiresAt`. When an unexpired request exists and
   * its last send is older than `cooldownMillis`, its `lastSentAt` moves to
   * the send time while `sendCount` and `expiresAt` stay, and the outcome is
   * `sent` with the existing id and code. When its last send is younger, the
   * outcome is `cooldown` with the stored request and nothing is written.
   * Otherwise the user's expired rows are deleted and a fresh request is
   * inserted with `sendCount` 1 and `expiresAt` set to the send time plus
   * `lifetimeMillis`, outcome `sent`. The caller sends the code only on
   * `sent`.
   */
  readonly startOrReuse: (
    start: EmailVerificationRequestStart
  ) => Effect.Effect<EmailVerificationRequestStartOutcome, PersistenceError>

  /**
   * Replace a request with a fresh code in one transaction under the user's
   * write lock, after checking the resend rule under the same lock.
   *
   * In order: a request that is gone, or whose `expiresAt` is at or before
   * the send time taken inside the lock, gives `missing` (the second of two
   * concurrent renewals sees this too). A `sendCount` at or above
   * `maxSendCount` gives `capped`, even when the last send is still inside
   * the cooldown, because the wait until expiry is the one that matters. A
   * last send younger than `cooldownMillis` gives `cooldown`. Otherwise the
   * replacement is inserted with
   * the replaced row's `sendCount` plus one, the send time as `lastSentAt`,
   * and that time plus `lifetimeMillis` as `expiresAt`, the replaced row is
   * deleted, and the outcome is `sent`. Only `sent` writes anything.
   */
  readonly renew: (
    renewal: EmailVerificationRequestRenewal
  ) => Effect.Effect<EmailVerificationRequestRenewalOutcome, PersistenceError>

  /**
   * Find a verification request by its unique identifier.
   */
  readonly findById: (
    id: EmailVerificationRequestId
  ) => Effect.Effect<Option.Option<EmailVerificationRequest>, PersistenceError>

  /**
   * Find the latest verification request for a user.
   */
  readonly findByUserId: (
    userId: AuthUserId
  ) => Effect.Effect<Option.Option<EmailVerificationRequest>, PersistenceError>

  /**
   * Atomically read and delete a verification request, in one transaction
   * under the owning user's write lock, so no other writer of that user's
   * rows loses a row it has already selected.
   */
  readonly consume: (
    id: EmailVerificationRequestId
  ) => Effect.Effect<Option.Option<EmailVerificationRequest>, PersistenceError>

  /**
   * Delete all verification requests expired at or before the provided timestamp.
   */
  readonly deleteExpired: (now: Timestamp) => Effect.Effect<number, PersistenceError>
}

/**
 * EmailVerificationRequestRepository - Context.Tag for dependency injection.
 */
export class EmailVerificationRequestRepository extends Context.Service<
  EmailVerificationRequestRepository,
  EmailVerificationRequestRepositoryService
>()("EmailVerificationRequestRepository") {}
