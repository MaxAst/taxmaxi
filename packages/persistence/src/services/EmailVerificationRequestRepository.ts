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
 * EmailVerificationRequestSend - Input to record that an existing request's code
 * was sent again.
 */
export interface EmailVerificationRequestSend {
  readonly id: EmailVerificationRequestId
  readonly sentAt: Timestamp
}

/**
 * EmailVerificationRequestRenewal - Input to replace a request with a fresh code.
 *
 * `id` names the request being replaced. The replacement keeps its user and
 * email, takes the replaced request's `sendCount` plus one, and records
 * `sentAt` as the time the new code is handed to delivery.
 */
export interface EmailVerificationRequestRenewal {
  readonly id: EmailVerificationRequestId
  readonly replacementId: EmailVerificationRequestId
  readonly code: EmailVerificationCode
  readonly expiresAt: Timestamp
  readonly sentAt: Timestamp
}

/**
 * EmailVerificationRequestRepositoryService - CRUD operations for verification requests.
 */
export interface EmailVerificationRequestRepositoryService {
  /**
   * Create a new verification request.
   *
   * Implementations may replace any existing request for the same user so that
   * only the most recent verification code remains active.
   */
  readonly create: (
    request: EmailVerificationRequestInsert
  ) => Effect.Effect<EmailVerificationRequest, PersistenceError>

  /**
   * Record that the existing request's code was sent again: sets `lastSentAt`
   * and leaves `sendCount` unchanged. Returns none when the request no longer
   * exists.
   */
  readonly recordSend: (
    send: EmailVerificationRequestSend
  ) => Effect.Effect<Option.Option<EmailVerificationRequest>, PersistenceError>

  /**
   * Replace a request with a fresh code in one transaction.
   *
   * Locks the replaced row, inserts the replacement with the locked row's
   * `sendCount` plus one, and deletes the locked row. Two concurrent renewals
   * of the same request therefore serialize: the second finds the row gone and
   * returns none.
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
   * Atomically read and delete a verification request.
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
