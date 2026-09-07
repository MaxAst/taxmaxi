/**
 * AuthErrors - Tagged error types for authentication failure scenarios
 *
 * Defines all authentication-related errors for multiple providers.
 * Each error extends Schema.TaggedError.
 *
 * HTTP Status Codes (for API layer reference):
 * - 400 Bad Request: PasswordTooWeakError, OAuthStateError
 * - 401 Unauthorized: InvalidCredentialsError, SessionExpiredError, SessionNotFoundError, ProviderAuthFailedError
 * - 404 Not Found: UserNotFoundError, ProviderNotEnabledError
 * - 409 Conflict: UserAlreadyExistsError, IdentityAlreadyLinkedError
 *
 * @module AuthErrors
 */

import { Chunk } from "effect"
import * as Schema from "effect/Schema"
import { AuthProviderType } from "./AuthProviderType.ts"
import { Email } from "./Email.ts"
import { AuthUserId } from "./AuthUserId.ts"
import { SessionId } from "./SessionId.ts"
import { ProviderId } from "./ProviderId.ts"
import { EmailVerificationRequestId } from "./EmailVerificationRequest.ts"

// =============================================================================
// 401 Unauthorized Errors - Authentication failures
// =============================================================================

/**
 * InvalidCredentialsError - Wrong username/password (local provider)
 *
 * Returned when local authentication fails due to incorrect credentials.
 * For security, this error is intentionally vague and does not specify
 * whether the email or password was incorrect.
 *
 * HTTP Status: 401 Unauthorized
 */
export class InvalidCredentialsError extends Schema.TaggedError<InvalidCredentialsError>()(
  "InvalidCredentialsError",
  {
    email: Email.annotate({
      description: "The email address that was used for authentication",
    }),
  },
  { httpApiStatus: 401 }
) {
  override get message(): string {
    return "Invalid email or password"
  }
}

/**
 * Type guard for InvalidCredentialsError
 */
export const isInvalidCredentialsError = Schema.is(InvalidCredentialsError)

/**
 * SessionExpiredError - Session has expired
 *
 * Returned when attempting to use a session that has exceeded its lifetime.
 *
 * HTTP Status: 401 Unauthorized
 */
export class SessionExpiredError extends Schema.TaggedError<SessionExpiredError>()(
  "SessionExpiredError",
  {
    sessionId: SessionId.annotate({
      description: "The expired session token",
    }),
  },
  { httpApiStatus: 401 }
) {
  override get message(): string {
    return "Session has expired"
  }
}

/**
 * Type guard for SessionExpiredError
 */
export const isSessionExpiredError = Schema.is(SessionExpiredError)

/**
 * SessionNotFoundError - Invalid session token
 *
 * Returned when the provided session token does not correspond to a valid session.
 *
 * HTTP Status: 401 Unauthorized
 */
export class SessionNotFoundError extends Schema.TaggedError<SessionNotFoundError>()(
  "SessionNotFoundError",
  {
    sessionId: SessionId.annotate({
      description: "The invalid session token",
    }),
  },
  { httpApiStatus: 401 }
) {
  override get message(): string {
    return "Session not found"
  }
}

/**
 * Type guard for SessionNotFoundError
 */
export const isSessionNotFoundError = Schema.is(SessionNotFoundError)

/**
 * ProviderAuthFailedError - External provider auth failed (WorkOS, OAuth)
 *
 * Returned when authentication with an external OAuth provider fails.
 *
 * HTTP Status: 401 Unauthorized
 */
export class ProviderAuthFailedError extends Schema.TaggedError<ProviderAuthFailedError>()(
  "ProviderAuthFailedError",
  {
    provider: AuthProviderType.annotate({
      description: "The authentication provider that failed",
    }),
    reason: Schema.String.annotate({
      description: "A description of why the authentication failed",
    }),
  },
  { httpApiStatus: 401 }
) {
  override get message(): string {
    return `Authentication with ${this.provider} failed: ${this.reason}`
  }
}

/**
 * Type guard for ProviderAuthFailedError
 */
export const isProviderAuthFailedError = Schema.is(ProviderAuthFailedError)

// =============================================================================
// 403 Forbidden Errors - Additional user action required
// =============================================================================

/**
 * UnverifiedEmailError - Local login blocked until email verification completes
 *
 * Returned when local credentials are valid but the account email address has
 * not yet been verified.
 *
 * HTTP Status: 403 Forbidden
 */
export class UnverifiedEmailError extends Schema.TaggedError<UnverifiedEmailError>()(
  "UnverifiedEmailError",
  {
    email: Email.annotate({
      description: "The email address that still requires verification",
    }),
  },
  { httpApiStatus: 403 }
) {
  override get message(): string {
    return `Email verification is required for ${this.email}`
  }
}

/**
 * Type guard for UnverifiedEmailError
 */
export const isUnverifiedEmailError = Schema.is(UnverifiedEmailError)

// =============================================================================
// 404 Not Found Errors - Resource does not exist
// =============================================================================

/**
 * UserNotFoundError - User does not exist
 *
 * Returned when attempting to authenticate or look up a user that does not exist.
 *
 * HTTP Status: 404 Not Found
 */
export class UserNotFoundError extends Schema.TaggedError<UserNotFoundError>()(
  "UserNotFoundError",
  {
    email: Email.annotate({
      description: "The email address that was not found",
    }),
  },
  { httpApiStatus: 404 }
) {
  override get message(): string {
    return `User not found: ${this.email}`
  }
}

/**
 * Type guard for UserNotFoundError
 */
export const isUserNotFoundError = Schema.is(UserNotFoundError)

/**
 * ProviderNotEnabledError - Auth provider not configured/enabled
 *
 * Returned when attempting to use an authentication provider that has not been
 * configured or enabled for the current context (organization/tenant).
 *
 * HTTP Status: 404 Not Found
 */
export class ProviderNotEnabledError extends Schema.TaggedError<ProviderNotEnabledError>()(
  "ProviderNotEnabledError",
  {
    provider: AuthProviderType.annotate({
      description: "The authentication provider that is not enabled",
    }),
  },
  { httpApiStatus: 404 }
) {
  override get message(): string {
    return `Authentication provider '${this.provider}' is not enabled`
  }
}

/**
 * Type guard for ProviderNotEnabledError
 */
export const isProviderNotEnabledError = Schema.is(ProviderNotEnabledError)

// =============================================================================
// 409 Conflict Errors - Resource already exists or is in conflict
// =============================================================================

/**
 * UserAlreadyExistsError - Duplicate registration (email already taken)
 *
 * Returned when attempting to register a new user with an email that is
 * already associated with an existing account.
 *
 * HTTP Status: 409 Conflict
 */
export class UserAlreadyExistsError extends Schema.TaggedError<UserAlreadyExistsError>()(
  "UserAlreadyExistsError",
  {
    email: Email.annotate({
      description: "The email address that is already registered",
    }),
  },
  { httpApiStatus: 409 }
) {
  override get message(): string {
    return `User with email '${this.email}' already exists`
  }
}

/**
 * Type guard for UserAlreadyExistsError
 */
export const isUserAlreadyExistsError = Schema.is(UserAlreadyExistsError)

/**
 * IdentityAlreadyLinkedError - Provider identity already linked to another user
 *
 * Returned when attempting to link an external provider identity (e.g., Google account)
 * that is already linked to a different user in the system.
 *
 * HTTP Status: 409 Conflict
 */
export class IdentityAlreadyLinkedError extends Schema.TaggedError<IdentityAlreadyLinkedError>()(
  "IdentityAlreadyLinkedError",
  {
    provider: AuthProviderType.annotate({
      description: "The authentication provider",
    }),
    providerId: ProviderId.annotate({
      description: "The external provider's user identifier",
    }),
    existingUserId: AuthUserId.annotate({
      description: "The user ID that the identity is already linked to",
    }),
  },
  { httpApiStatus: 409 }
) {
  override get message(): string {
    return `Identity from '${this.provider}' is already linked to another user`
  }
}

/**
 * Type guard for IdentityAlreadyLinkedError
 */
export const isIdentityAlreadyLinkedError = Schema.is(IdentityAlreadyLinkedError)

// =============================================================================
// 400 Bad Request Errors - Invalid request data
// =============================================================================

/**
 * PasswordRequirement - One password rule a submitted password did not meet
 *
 * Codes only, never display text. The web app maps each code to localized copy.
 */
export const PasswordRequirement = Schema.Literals([
  "min_length",
  "lowercase",
  "uppercase",
  "number",
  "special_char",
]).annotate({
  description: "Code of a password rule that was not met",
})

export type PasswordRequirement = typeof PasswordRequirement.Type

/**
 * PasswordTooWeakError - Password validation failed (local provider)
 *
 * Returned when a password does not meet the required strength criteria.
 * Carries the codes of the rules that were not met and the minimum length
 * the rules require, so a client can render the exact unmet rules.
 *
 * HTTP Status: 400 Bad Request
 */
export class PasswordTooWeakError extends Schema.TaggedError<PasswordTooWeakError>()(
  "PasswordTooWeakError",
  {
    requirements: Schema.Chunk(PasswordRequirement).annotate({
      description: "Codes of the password rules that were not met",
    }),
    minPasswordLength: Schema.Finite.pipe(
      Schema.check(Schema.isInt()),
      Schema.check(Schema.isGreaterThan(0))
    ).annotate({
      description: "Minimum password length the rules require",
    }),
  },
  { httpApiStatus: 400 }
) {
  override get message(): string {
    return `Password does not meet requirements: ${Chunk.toReadonlyArray(this.requirements).join(", ")}`
  }
}

/**
 * Type guard for PasswordTooWeakError
 */
export const isPasswordTooWeakError = Schema.is(PasswordTooWeakError)

/**
 * EmailVerificationRequestNotFoundError - Pending verification request is missing
 *
 * Returned when the requested email verification flow no longer exists or has
 * already been consumed.
 *
 * HTTP Status: 400 Bad Request
 */
export class EmailVerificationRequestNotFoundError extends Schema.TaggedError<EmailVerificationRequestNotFoundError>()(
  "EmailVerificationRequestNotFoundError",
  {
    requestId: EmailVerificationRequestId.annotate({
      description: "The verification request that could not be found",
    }),
  },
  { httpApiStatus: 400 }
) {
  override get message(): string {
    return "Email verification request is missing or no longer valid"
  }
}

/**
 * Type guard for EmailVerificationRequestNotFoundError
 */
export const isEmailVerificationRequestNotFoundError = Schema.is(
  EmailVerificationRequestNotFoundError
)

/**
 * EmailVerificationCodeMismatchError - Verification code does not match
 *
 * Returned when a user submits a code that does not match the active
 * verification request.
 *
 * HTTP Status: 400 Bad Request
 */
export class EmailVerificationCodeMismatchError extends Schema.TaggedError<EmailVerificationCodeMismatchError>()(
  "EmailVerificationCodeMismatchError",
  {
    requestId: EmailVerificationRequestId.annotate({
      description: "The verification request the code was checked against",
    }),
  },
  { httpApiStatus: 400 }
) {
  override get message(): string {
    return "Verification code is invalid"
  }
}

/**
 * Type guard for EmailVerificationCodeMismatchError
 */
export const isEmailVerificationCodeMismatchError = Schema.is(EmailVerificationCodeMismatchError)

/**
 * EmailVerificationRequestExpiredError - Verification request has expired
 *
 * Returned when the active verification code has expired and must be replaced.
 *
 * HTTP Status: 400 Bad Request
 */
export class EmailVerificationRequestExpiredError extends Schema.TaggedError<EmailVerificationRequestExpiredError>()(
  "EmailVerificationRequestExpiredError",
  {
    requestId: EmailVerificationRequestId.annotate({
      description: "The expired verification request",
    }),
  },
  { httpApiStatus: 400 }
) {
  override get message(): string {
    return "Verification code has expired"
  }
}

/**
 * Type guard for EmailVerificationRequestExpiredError
 */
export const isEmailVerificationRequestExpiredError = Schema.is(
  EmailVerificationRequestExpiredError
)

/**
 * OAuthStateError - OAuth state mismatch (CSRF protection)
 *
 * Returned when the OAuth state parameter does not match, indicating a potential
 * CSRF attack or session corruption. The OAuth flow should be restarted.
 *
 * HTTP Status: 400 Bad Request
 */
export class OAuthStateError extends Schema.TaggedError<OAuthStateError>()(
  "OAuthStateError",
  {
    provider: AuthProviderType.annotate({
      description: "The OAuth provider where the state mismatch occurred",
    }),
    reason: Schema.String.annotate({
      description: "Detailed reason for OAuth state validation failure",
    }),
  },
  { httpApiStatus: 400 }
) {
  override get message(): string {
    return `OAuth state validation failed for ${this.provider}: ${this.reason}. Please restart the authentication flow.`
  }
}

/**
 * Type guard for OAuthStateError
 */
export const isOAuthStateError = Schema.is(OAuthStateError)

// =============================================================================
// 500 Internal Server Errors - System failures
// =============================================================================

/**
 * SessionCleanupError - Failed to delete expired or old session
 *
 * Returned when the system fails to clean up an expired session during validation
 * or an old session during refresh. Session cleanup is critical for security
 * (prevents session hijacking) and database hygiene (prevents stale data accumulation).
 *
 * HTTP Status: 500 Internal Server Error
 */
export class SessionCleanupError extends Schema.TaggedError<SessionCleanupError>()(
  "SessionCleanupError",
  {
    sessionId: SessionId.annotate({
      description: "The session that could not be deleted",
    }),
    operation: Schema.String.annotate({
      description: "The cleanup operation that failed (e.g., 'expiry', 'refresh')",
    }),
    cause: Schema.Unknown.annotate({
      description: "The underlying error that caused the cleanup to fail",
    }),
  },
  { httpApiStatus: 500 }
) {
  override get message(): string {
    return `Failed to clean up session during ${this.operation}: ${String(this.cause)}`
  }
}

/**
 * Type guard for SessionCleanupError
 */
export const isSessionCleanupError = Schema.is(SessionCleanupError)

/**
 * AuthProcessingError - Internal auth workflow failure
 *
 * Returned when a non-user-correctable auth operation fails due to an
 * infrastructure or persistence issue.
 *
 * HTTP Status: 500 Internal Server Error
 */
export class AuthProcessingError extends Schema.TaggedError<AuthProcessingError>()(
  "AuthProcessingError",
  {
    operation: Schema.String.annotate({
      description: "The auth workflow operation that failed",
    }),
    cause: Schema.Unknown.annotate({
      description: "The underlying cause of the failure",
    }),
  },
  { httpApiStatus: 500 }
) {
  override get message(): string {
    return `Authentication operation failed during ${this.operation}`
  }
}

/**
 * Type guard for AuthProcessingError
 */
export const isAuthProcessingError = Schema.is(AuthProcessingError)

// =============================================================================
// Union Types
// =============================================================================

/**
 * Union type for all authentication errors
 */
export type AuthError =
  | InvalidCredentialsError
  | UnverifiedEmailError
  | UserNotFoundError
  | UserAlreadyExistsError
  | IdentityAlreadyLinkedError
  | ProviderNotEnabledError
  | ProviderAuthFailedError
  | SessionExpiredError
  | SessionNotFoundError
  | PasswordTooWeakError
  | EmailVerificationRequestNotFoundError
  | EmailVerificationCodeMismatchError
  | EmailVerificationRequestExpiredError
  | OAuthStateError
  | SessionCleanupError
  | AuthProcessingError

/**
 * HTTP status code mapping for API layer
 *
 * Use this map when applying HttpApiSchema.status in the API package:
 * ```typescript
 * import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema"
 * import { InvalidCredentialsError, AUTH_ERROR_STATUS_CODES } from "@my/core/authentication/errors"
 *
 * // In API definition:
 * .addError(
 *   InvalidCredentialsError.pipe(
 *     HttpApiSchema.status(AUTH_ERROR_STATUS_CODES.InvalidCredentialsError)
 *   )
 * )
 * ```
 */
export const AUTH_ERROR_STATUS_CODES = {
  // 401 Unauthorized
  InvalidCredentialsError: 401,
  SessionExpiredError: 401,
  SessionNotFoundError: 401,
  ProviderAuthFailedError: 401,
  // 403 Forbidden
  UnverifiedEmailError: 403,
  // 404 Not Found
  UserNotFoundError: 404,
  ProviderNotEnabledError: 404,
  // 409 Conflict
  UserAlreadyExistsError: 409,
  IdentityAlreadyLinkedError: 409,
  // 400 Bad Request
  PasswordTooWeakError: 400,
  EmailVerificationRequestNotFoundError: 400,
  EmailVerificationCodeMismatchError: 400,
  EmailVerificationRequestExpiredError: 400,
  OAuthStateError: 400,
  // 500 Internal Server Error
  SessionCleanupError: 500,
  AuthProcessingError: 500,
} as const
