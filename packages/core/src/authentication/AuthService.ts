/**
 * AuthService - Main authentication service orchestrating multiple providers
 *
 * Provides a unified authentication API that routes requests to the appropriate
 * provider based on AuthProviderType. Manages user sessions, identity linking,
 * and provider registration.
 *
 * Architecture:
 * - Uses the registry pattern to hold multiple AuthProvider implementations
 * - AuthProviderType determines which provider handles a request
 * - Supports concurrent use of multiple authentication methods
 *
 * @module AuthService
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Chunk from "effect/Chunk"
import type { AuthProviderType } from "./AuthProviderType.ts"
import type { AuthRequest } from "./AuthRequest.ts"
import type { AuthResult } from "./AuthResult.ts"
import type { AuthUser } from "./AuthUser.ts"
import type { Session } from "./Session.ts"
import type { UserIdentity } from "./UserIdentity.ts"
import type { AuthUserId } from "./AuthUserId.ts"
import type { SessionId } from "./SessionId.ts"
import type { Email } from "./Email.ts"
import type {
  EmailVerificationCode,
  EmailVerificationRequest,
  EmailVerificationRequestId,
} from "./EmailVerificationRequest.ts"
import type {
  AuthError,
  AuthProcessingError,
  EmailVerificationCodeMismatchError,
  EmailVerificationRequestExpiredError,
  EmailVerificationRequestNotFoundError,
  EmailVerificationResendLimitedError,
  InvalidCredentialsError,
  UnverifiedEmailError,
  UserNotFoundError,
  UserAlreadyExistsError,
  ProviderNotEnabledError,
  ProviderAuthFailedError,
  SessionExpiredError,
  SessionNotFoundError,
  SessionCleanupError,
  IdentityAlreadyLinkedError,
  PasswordTooWeakError,
  OAuthStateError,
} from "./AuthErrors.ts"

// =============================================================================
// Session Validation Result
// =============================================================================

/**
 * ValidatedSession - Result of successful session validation
 *
 * Contains both the authenticated user and the valid session.
 */
export interface ValidatedSession {
  readonly user: AuthUser
  readonly session: Session
}

/**
 * LoginSuccess - Result of successful login
 *
 * Contains both the authenticated user and the created session.
 */
export interface LoginSuccess {
  readonly user: AuthUser
  readonly session: Session
}

/**
 * OAuthLoginSuccess - Result of OAuth login completion.
 *
 * Extends LoginSuccess with the provider callback payload so callers can
 * persist provider-specific artifacts (for example OAuth credentials)
 */
export interface OAuthLoginSuccess extends LoginSuccess {
  readonly providerResult: AuthResult
}

/**
 * OAuthStartSuccess - Result of successfully starting an OAuth flow
 */
export interface OAuthStartSuccess {
  readonly authorizationUrl: string
  readonly state: string
}

// =============================================================================
// Service Interface
// =============================================================================

/**
 * AuthServiceShape - The shape of the authentication service
 *
 * Provides all authentication operations including:
 * - Login with any enabled provider
 * - Registration (local provider only)
 * - OAuth flow support
 * - Session management
 * - Identity linking
 */
export interface AuthServiceShape {
  /**
   * Login with the specified provider
   *
   * Routes the authentication request to the appropriate provider and creates
   * a session on success. If the user doesn't exist but the provider supports
   * registration, a new user account may be created (auto-registration).
   *
   * @param provider - The provider to authenticate with
   * @param request - The authentication request
   * @returns Effect containing the user and session
   * @errors ProviderNotEnabledError - Provider is not enabled
   * @errors InvalidCredentialsError - Wrong credentials (local)
   * @errors UnverifiedEmailError - Local credentials are valid but email verification is pending
   * @errors ProviderAuthFailedError - Provider authentication failed
   * @errors UserNotFoundError - User not found and auto-registration disabled
   */
  readonly login: (
    provider: AuthProviderType,
    request: AuthRequest
  ) => Effect.Effect<
    LoginSuccess,
    | ProviderNotEnabledError
    | InvalidCredentialsError
    | UnverifiedEmailError
    | ProviderAuthFailedError
    | UserNotFoundError
    | OAuthStateError
  >

  /**
   * Register a new user with local credentials
   *
   * Creates a new user account with email/password authentication.
   * Only available for the 'local' provider.
   *
   * @param email - The user's email address
   * @param password - The user's password (as Redacted string)
   * @param displayName - The user's display name
   * @returns Effect containing the created user
   * @errors UserAlreadyExistsError - Email already registered
   * @errors PasswordTooWeakError - Password doesn't meet requirements
   */
  readonly register: (
    email: Email,
    password: string,
    displayName?: string
  ) => Effect.Effect<AuthUser, UserAlreadyExistsError | PasswordTooWeakError>

  /**
   * Start or reuse a pending email verification flow for a local user
   *
   * Creates a verification request when none exists, or reuses the latest
   * still-active request for the user. The code is sent again unless the
   * last send was inside the resend cooldown; inside it, the request is
   * returned and nothing is sent.
   *
   * @param user - The local user who must verify their email
   * @returns Effect containing the active verification request
   * @errors AuthProcessingError - Failed to create or load the verification request
   */
  readonly startEmailVerification: (
    user: AuthUser
  ) => Effect.Effect<EmailVerificationRequest, AuthProcessingError>

  /**
   * Replace an existing pending verification request with a fresh code
   *
   * @param requestId - The existing verification request identifier
   * @returns Effect containing the refreshed verification request
   * @errors EmailVerificationRequestNotFoundError - Verification flow no longer exists or has expired
   * @errors EmailVerificationResendLimitedError - Resend is inside the cooldown or the lineage has used all its sends
   * @errors AuthProcessingError - Failed to create the refreshed verification request
   */
  readonly resendEmailVerification: (
    requestId: EmailVerificationRequestId
  ) => Effect.Effect<
    EmailVerificationRequest,
    | EmailVerificationRequestNotFoundError
    | EmailVerificationResendLimitedError
    | AuthProcessingError
  >

  /**
   * Complete a pending email verification flow and create a session
   *
   * @param requestId - The active verification request identifier
   * @param code - The one-time verification code
   * @returns Effect containing the verified user and newly created session
   * @errors EmailVerificationRequestNotFoundError - Verification flow no longer exists
   * @errors EmailVerificationCodeMismatchError - Verification code does not match
   * @errors EmailVerificationRequestExpiredError - Verification request has expired
   * @errors UserNotFoundError - User associated with the request no longer exists
   * @errors AuthProcessingError - Failed to persist verification or create the session
   */
  readonly verifyEmail: (
    requestId: EmailVerificationRequestId,
    code: EmailVerificationCode
  ) => Effect.Effect<
    LoginSuccess,
    | EmailVerificationRequestNotFoundError
    | EmailVerificationCodeMismatchError
    | EmailVerificationRequestExpiredError
    | UserNotFoundError
    | AuthProcessingError
  >

  /**
   * Start OAuth login flow
   *
   * Generates a provider authorization URL and persists OAuth state metadata
   * for deterministic callback validation.
   *
   * The stored state tracks intent/provider/redirect URI/expiry so callbacks
   * can be validated without relying on URL path conventions.
   *
   * @param provider - The OAuth provider to initiate login with
   * @param redirectUri - Optional custom callback URI
   * @returns Effect containing authorization URL and generated state
   * @errors ProviderNotEnabledError - Provider is not enabled
   * @errors ProviderAuthFailedError - Provider cannot start OAuth flow
   */
  readonly startOAuthLogin: (
    provider: AuthProviderType,
    redirectUri?: string
  ) => Effect.Effect<OAuthStartSuccess, ProviderNotEnabledError | ProviderAuthFailedError>

  /**
   * Complete OAuth login flow
   *
   * Consumes persisted OAuth state, validates state/provider/intent, exchanges
   * authorization code for provider identity, then signs in (or provisions)
   * the user and creates a session.
   *
   * @param provider - The OAuth provider handling the callback
   * @param code - Authorization code returned by the provider
   * @param state - State token generated by startOAuthLogin
   * @returns Effect containing authenticated user and created session
   * @errors ProviderNotEnabledError - Provider is not enabled
   * @errors ProviderAuthFailedError - Provider callback or user/session flow failed
   * @errors OAuthStateError - State is missing, expired, or does not match intent/provider
   */
  readonly completeOAuthLogin: (
    provider: AuthProviderType,
    code: string,
    state: string
  ) => Effect.Effect<
    OAuthLoginSuccess,
    ProviderNotEnabledError | ProviderAuthFailedError | OAuthStateError
  >

  /**
   * Start OAuth link flow for an authenticated user
   *
   * Generates provider authorization URL and persists OAuth state metadata
   * scoped to the given user and link intent.
   *
   * @param userId - Authenticated user requesting identity linking
   * @param provider - External provider to link
   * @param redirectUri - Optional custom callback URI
   * @returns Effect containing authorization URL and generated state
   * @errors ProviderNotEnabledError - Provider is not enabled
   * @errors ProviderAuthFailedError - Provider cannot start OAuth flow
   */
  readonly startLink: (
    userId: AuthUserId,
    provider: AuthProviderType,
    redirectUri?: string
  ) => Effect.Effect<OAuthStartSuccess, ProviderNotEnabledError | ProviderAuthFailedError>

  /**
   * Complete OAuth link flow for an authenticated user
   *
   * Consumes the persisted OAuth state, validates intent/user ownership, then
   * links the provider identity to the existing user account.
   *
   * This flow must never create a new user.
   *
   * @param userId - Authenticated user completing the link flow
   * @param provider - External provider being linked
   * @param code - Authorization code returned by the provider
   * @param state - State token generated by startLink
   * @returns Effect containing created identity link
   * @errors ProviderNotEnabledError - Provider is not enabled
   * @errors ProviderAuthFailedError - Provider callback failed
   * @errors OAuthStateError - State is missing, expired, or does not belong to this user/intent
   * @errors IdentityAlreadyLinkedError - Provider identity is already linked
   * @errors UserNotFoundError - Target user does not exist
   */
  readonly completeLink: (
    userId: AuthUserId,
    provider: AuthProviderType,
    code: string,
    state: string
  ) => Effect.Effect<
    UserIdentity,
    | ProviderNotEnabledError
    | ProviderAuthFailedError
    | OAuthStateError
    | IdentityAlreadyLinkedError
    | UserNotFoundError
  >

  /**
   * Logout and invalidate a session
   *
   * Destroys the specified session, preventing further use of that session token.
   *
   * @param sessionId - The session to invalidate
   * @returns Effect completing successfully on logout
   * @errors SessionNotFoundError - Session does not exist
   */
  readonly logout: (sessionId: SessionId) => Effect.Effect<void, SessionNotFoundError>

  /**
   * Validate a session and retrieve the associated user
   *
   * Checks if the session is valid (exists and not expired) and returns
   * both the session and the authenticated user.
   *
   * @param sessionId - The session token to validate
   * @returns Effect containing the user and session
   * @errors SessionNotFoundError - Session does not exist
   * @errors SessionExpiredError - Session has expired
   * @errors SessionCleanupError - Failed to delete expired session
   */
  readonly validateSession: (
    sessionId: SessionId
  ) => Effect.Effect<
    ValidatedSession,
    SessionNotFoundError | SessionExpiredError | SessionCleanupError
  >

  /**
   * Link an external identity to an existing user
   *
   * Associates an external provider identity (e.g., Google account) with
   * an existing user. This allows users to login with multiple providers.
   *
   * @param userId - The user to link the identity to
   * @param provider - The provider type
   * @param providerResult - The authentication result from the provider
   * @returns Effect containing the created identity link
   * @errors IdentityAlreadyLinkedError - Identity is linked to another user
   * @errors UserNotFoundError - User does not exist
   */
  readonly linkIdentity: (
    userId: AuthUserId,
    provider: AuthProviderType,
    providerResult: AuthResult
  ) => Effect.Effect<
    UserIdentity,
    IdentityAlreadyLinkedError | UserNotFoundError | ProviderAuthFailedError
  >

  /**
   * Get all enabled authentication providers
   *
   * Returns the list of providers that are currently enabled and available
   * for authentication.
   *
   * @returns Effect containing the list of enabled provider types
   */
  readonly getEnabledProviders: Effect.Effect<Chunk.Chunk<AuthProviderType>>
}

/**
 * AuthService - Context.Service for the authentication service
 *
 * Usage:
 * ```typescript
 * const program = Effect.gen(function* () {
 *   const auth = yield* AuthService
 *   const { user, session } = yield* auth.login("local", LocalAuthRequest.make({
 *     email: Email.make("user@example.com"),
 *     password: Redacted.make("password123")
 *   }))
 *   return user
 * })
 *
 * // Provide the implementation
 * program.pipe(Effect.provide(AuthServiceLive))
 * ```
 */
export class AuthService extends Context.Service<AuthService, AuthServiceShape>()("AuthService") {}

// =============================================================================
// Session Error Union
// =============================================================================

/**
 * SessionError - Union of session-related errors
 */
export type SessionError = SessionNotFoundError | SessionExpiredError

/**
 * LoginError - Union of login-related errors
 */
export type LoginError =
  | ProviderNotEnabledError
  | InvalidCredentialsError
  | UnverifiedEmailError
  | ProviderAuthFailedError
  | UserNotFoundError
  | OAuthStateError

/**
 * RegistrationError - Union of registration-related errors
 */
export type RegistrationError = UserAlreadyExistsError | PasswordTooWeakError

/**
 * EmailVerificationError - Union of email verification-related errors
 */
export type EmailVerificationError =
  | EmailVerificationRequestNotFoundError
  | EmailVerificationCodeMismatchError
  | EmailVerificationRequestExpiredError
  | EmailVerificationResendLimitedError
  | UserNotFoundError
  | AuthProcessingError

/**
 * IdentityLinkError - Union of identity linking errors
 */
export type IdentityLinkError =
  | IdentityAlreadyLinkedError
  | UserNotFoundError
  | ProviderAuthFailedError

/**
 * Re-export AuthError for convenience
 */
export type { AuthError }
