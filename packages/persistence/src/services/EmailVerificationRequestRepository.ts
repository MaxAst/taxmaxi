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
 * `id`, `code`, and `expiresAt` are used only when no active request exists
 * and a fresh one is inserted. The send time is taken by the repository inside
 * the user's write lock; it also decides which existing request still counts
 * as active.
 */
export interface EmailVerificationRequestStart {
  readonly id: EmailVerificationRequestId
  readonly userId: AuthUserId
  readonly email: Email
  readonly code: EmailVerificationCode
  readonly expiresAt: Timestamp
}

/**
 * EmailVerificationRequestRenewal - Input to replace a request with a fresh code.
 *
 * `id` names the request being replaced. The replacement keeps its user and
 * email, takes the replaced request's `sendCount` plus one, and records the
 * send time taken by the repository inside the user's write lock.
 */
export interface EmailVerificationRequestRenewal {
  readonly id: EmailVerificationRequestId
  readonly replacementId: EmailVerificationRequestId
  readonly code: EmailVerificationCode
  readonly expiresAt: Timestamp
}

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
   * The send time is taken once inside the lock and decides both which
   * request is still active and the written `lastSentAt`. When an unexpired
   * request exists, its `lastSentAt` moves to that time and `sendCount` stays;
   * the returned request carries the existing id and code. Otherwise the
   * user's expired rows are deleted and a fresh request is inserted with
   * `sendCount` 1. The caller sends the returned request's code.
   */
  readonly startOrReuse: (
    start: EmailVerificationRequestStart
  ) => Effect.Effect<EmailVerificationRequest, PersistenceError>

  /**
   * Replace a request with a fresh code in one transaction under the user's
   * write lock.
   *
   * Inserts the replacement with the replaced row's `sendCount` plus one and
   * the send time taken inside the lock as `lastSentAt`, then deletes the
   * replaced row. Returns none when the request is gone, which is also what
   * the second of two concurrent renewals sees.
   */
  readonly renew: (
    renewal: EmailVerificationRequestRenewal
  ) => Effect.Effect<Option.Option<EmailVerificationRequest>, PersistenceError>

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
