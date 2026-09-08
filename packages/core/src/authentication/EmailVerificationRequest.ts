/**
 * EmailVerificationRequest - Core model for pending local email verification
 *
 * Represents the one-time verification code issued during local sign-up or
 * resend flows before a session is created.
 *
 * @module EmailVerificationRequest
 */

import * as Schema from "effect/Schema"
import { AuthUserId } from "./AuthUserId.ts"
import { Email } from "./Email.ts"
import { Timestamp } from "../shared/values/Timestamp.ts"

/**
 * Unique identifier for a persisted email verification request.
 */
export const EmailVerificationRequestId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("EmailVerificationRequestId"))
  .annotate({
    identifier: "EmailVerificationRequestId",
    title: "Email Verification Request ID",
    description: "Unique identifier for an email verification request",
  })

/**
 * The EmailVerificationRequestId type.
 */
export type EmailVerificationRequestId = typeof EmailVerificationRequestId.Type

/**
 * Type guard for EmailVerificationRequestId using Schema.is.
 */
export const isEmailVerificationRequestId = Schema.is(EmailVerificationRequestId)

/**
 * One-time verification code sent to the user.
 */
export const EmailVerificationCode = Schema.Trimmed.check(Schema.isNonEmpty())
  .annotate({
    identifier: "EmailVerificationCode",
    title: "Email Verification Code",
    description: "One-time code used to verify a pending local email address",
    examples: ["ABCD1234"],
  })
  .pipe(Schema.check(Schema.isPattern(/^[A-Z0-9]{8}$/)))

/**
 * The EmailVerificationCode type.
 */
export type EmailVerificationCode = typeof EmailVerificationCode.Type

/**
 * Type guard for EmailVerificationCode using Schema.is.
 */
export const isEmailVerificationCode = Schema.is(EmailVerificationCode)

/**
 * EmailVerificationRequest - Pending verification request for a local account.
 */
export class EmailVerificationRequest extends Schema.Class<EmailVerificationRequest>(
  "EmailVerificationRequest"
)({
  /**
   * Unique identifier for the verification request
   */
  id: EmailVerificationRequestId,

  /**
   * User who must complete the verification step
   */
  userId: AuthUserId,

  /**
   * Email address being verified
   */
  email: Email,

  /**
   * One-time verification code
   */
  code: EmailVerificationCode,

  /**
   * Absolute expiration timestamp for the verification code
   */
  expiresAt: Timestamp,

  /**
   * How many codes have been sent for this verification flow. Register writes
   * 1; a resend copies the replaced request's count plus one.
   */
  sendCount: Schema.Finite.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThan(0))
  ),

  /**
   * When the current code was handed to delivery
   */
  lastSentAt: Timestamp,

  /**
   * When the verification request was created
   */
  createdAt: Timestamp,

  /**
   * When the verification request was last updated
   */
  updatedAt: Timestamp,
}) {}

/**
 * Type guard for EmailVerificationRequest using Schema.is.
 */
export const isEmailVerificationRequest = Schema.is(EmailVerificationRequest)

/**
 * Check whether the verification request has expired.
 */
export const isEmailVerificationRequestExpired = ({
  request,
  now,
}: {
  readonly request: EmailVerificationRequest
  readonly now: Timestamp
}): boolean => request.expiresAt.epochMillis <= now.epochMillis
