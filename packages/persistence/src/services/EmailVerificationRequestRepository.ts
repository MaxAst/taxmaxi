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
