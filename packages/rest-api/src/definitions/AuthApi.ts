/**
 * AuthApi - HTTP API group for authentication
 *
 * Provides endpoints for:
 * - Provider discovery (public)
 * - User registration with local provider (public)
 * - Login with any enabled provider (public)
 * - OAuth/SAML authorization flows (public)
 * - Logout and session management (protected)
 * - Provider identity linking (protected)
 *
 * @module AuthApi
 */

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  AuthProviderType,
  OAuthProviderType,
  AuthUser,
  Email,
  EmailVerificationCode,
  SessionId,
  UserIdentityId,
} from "@my/core/authentication"
import { AuthMiddleware } from "./AuthMiddleware.ts"
import { InternalServerError } from "./ApiErrors.ts"

// =============================================================================
// Auth-Specific Error Schemas (with HTTP status codes)
// =============================================================================

/**
 * AuthValidationError - Request validation failed (400)
 */
export class AuthValidationError extends Schema.TaggedError<AuthValidationError>()(
  "AuthValidationError",
  {
    message: Schema.String.annotate({
      description: "A human-readable description of the validation error",
    }),
    field: Schema.OptionFromNullOr(Schema.String).annotate({
      description: "The field that failed validation, if applicable",
    }),
  },
  { httpApiStatus: 400 }
) {}

/**
 * PasswordWeakError - Password does not meet requirements (400)
 */
export class PasswordWeakError extends Schema.TaggedError<PasswordWeakError>()(
  "PasswordWeakError",
  {
    message: Schema.String.pipe(
      Schema.withConstructorDefault(Effect.succeed("Password does not meet requirements"))
    ),
    requirements: Schema.Array(Schema.String).annotate({
      description: "List of password requirements that were not met",
    }),
  },
  { httpApiStatus: 400 }
) {}

/**
 * OAuthStateInvalidError - OAuth state mismatch (400)
 */
export class OAuthStateInvalidError extends Schema.TaggedError<OAuthStateInvalidError>()(
  "OAuthStateInvalidError",
  {
    message: Schema.String.pipe(
      Schema.withConstructorDefault(
        Effect.succeed("OAuth state mismatch. Please restart the authentication flow.")
      )
    ),
    provider: AuthProviderType,
  },
  { httpApiStatus: 400 }
) {}

/**
 * AuthUnauthorizedError - Authentication required or invalid credentials (401)
 */
export class AuthUnauthorizedError extends Schema.TaggedError<AuthUnauthorizedError>()(
  "AuthUnauthorizedError",
  {
    message: Schema.String.pipe(
      Schema.withConstructorDefault(
        Effect.succeed("Invalid credentials or authentication required")
      )
    ),
  },
  { httpApiStatus: 401 }
) {}

/**
 * EmailVerificationRequiredError - Local credentials are valid but email verification is pending (403)
 */
export class EmailVerificationRequiredError extends Schema.TaggedError<EmailVerificationRequiredError>()(
  "EmailVerificationRequiredError",
  {
    email: Email,
    message: Schema.String.pipe(
      Schema.withConstructorDefault(Effect.succeed("Email verification is required before login"))
    ),
  },
  { httpApiStatus: 403 }
) {}

/**
 * EmailVerificationFlowMissingError - Verification flow cookie or request is missing (400)
 */
export class EmailVerificationFlowMissingError extends Schema.TaggedError<EmailVerificationFlowMissingError>()(
  "EmailVerificationFlowMissingError",
  {
    message: Schema.String.pipe(
      Schema.withConstructorDefault(
        Effect.succeed("Verification session is missing or expired. Start sign-up or login again.")
      )
    ),
  },
  { httpApiStatus: 400 }
) {}

/**
 * EmailVerificationCodeInvalidError - Submitted verification code is invalid (400)
 */
export class EmailVerificationCodeInvalidError extends Schema.TaggedError<EmailVerificationCodeInvalidError>()(
  "EmailVerificationCodeInvalidError",
  {
    message: Schema.String.pipe(
      Schema.withConstructorDefault(Effect.succeed("Verification code is invalid"))
    ),
  },
  { httpApiStatus: 400 }
) {}

/**
 * EmailVerificationCodeExpiredError - Submitted verification code has expired (400)
 */
export class EmailVerificationCodeExpiredError extends Schema.TaggedError<EmailVerificationCodeExpiredError>()(
  "EmailVerificationCodeExpiredError",
  {
    message: Schema.String.pipe(
      Schema.withConstructorDefault(Effect.succeed("Verification code has expired"))
    ),
  },
  { httpApiStatus: 400 }
) {}

/**
 * ProviderAuthError - External provider authentication failed (401)
 */
export class ProviderAuthError extends Schema.TaggedError<ProviderAuthError>()(
  "ProviderAuthError",
  {
    provider: AuthProviderType,
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
 * SessionInvalidError - Session expired or not found (401)
 */
export class SessionInvalidError extends Schema.TaggedError<SessionInvalidError>()(
  "SessionInvalidError",
  {
    message: Schema.String.pipe(
      Schema.withConstructorDefault(Effect.succeed("Session is invalid or expired"))
    ),
  },
  { httpApiStatus: 401 }
) {}

/**
 * ProviderNotFoundError - Auth provider not enabled (404)
 */
export class ProviderNotFoundError extends Schema.TaggedError<ProviderNotFoundError>()(
  "ProviderNotFoundError",
  {
    provider: AuthProviderType,
    message: Schema.String.pipe(
      Schema.withConstructorDefault(
        Effect.succeed("Authentication provider not found or not enabled")
      )
    ),
  },
  { httpApiStatus: 404 }
) {}

/**
 * UserNotFoundError - User does not exist (404)
 */
export class AuthUserNotFoundError extends Schema.TaggedError<AuthUserNotFoundError>()(
  "AuthUserNotFoundError",
  {
    message: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("User not found"))),
  },
  { httpApiStatus: 404 }
) {}

/**
 * IdentityNotFoundError - Identity does not exist (404)
 */
export class IdentityNotFoundError extends Schema.TaggedError<IdentityNotFoundError>()(
  "IdentityNotFoundError",
  {
    identityId: UserIdentityId,
    message: Schema.String.pipe(
      Schema.withConstructorDefault(Effect.succeed("Identity not found"))
    ),
  },
  { httpApiStatus: 404 }
) {}

/**
 * UserExistsError - Email already registered (409)
 */
export class UserExistsError extends Schema.TaggedError<UserExistsError>()(
  "UserExistsError",
  {
    email: Email,
    message: Schema.String.pipe(
      Schema.withConstructorDefault(Effect.succeed("A user with this email already exists"))
    ),
  },
  { httpApiStatus: 409 }
) {}

/**
 * IdentityAlreadyLinkedError - Provider identity already linked to another user (409)
 */
export class IdentityLinkedError extends Schema.TaggedError<IdentityLinkedError>()(
  "IdentityLinkedError",
  {
    provider: AuthProviderType,
    message: Schema.String.pipe(
      Schema.withConstructorDefault(
        Effect.succeed("This identity is already linked to another account")
      )
    ),
  },
  { httpApiStatus: 409 }
) {}

/**
 * CannotUnlinkLastIdentityError - Cannot remove the last identity (409)
 */
export class CannotUnlinkLastIdentityError extends Schema.TaggedError<CannotUnlinkLastIdentityError>()(
  "CannotUnlinkLastIdentityError",
  {
    message: Schema.String.pipe(
      Schema.withConstructorDefault(
        Effect.succeed(
          "Cannot unlink the last identity. User must have at least one linked provider."
        )
      )
    ),
  },
  { httpApiStatus: 409 }
) {}

// =============================================================================
// Request/Response Schemas
// =============================================================================

/**
 * ProviderMetadata - Information about an enabled auth provider
 */
export class ProviderMetadata extends Schema.Class<ProviderMetadata>("ProviderMetadata")({
  type: AuthProviderType,
  name: Schema.String.annotate({
    description: "Display name for the provider",
  }),
  supportsRegistration: Schema.Boolean.annotate({
    description: "Whether this provider supports user registration",
  }),
  supportsPasswordLogin: Schema.Boolean.annotate({
    description: "Whether this provider uses password-based authentication",
  }),
  oauthEnabled: Schema.Boolean.annotate({
    description: "Whether this provider uses OAuth/SAML flow",
  }),
}) {}

/**
 * ProvidersResponse - List of enabled authentication providers
 */
export class ProvidersResponse extends Schema.Class<ProvidersResponse>("ProvidersResponse")({
  providers: Schema.Array(ProviderMetadata),
}) {}

/**
 * RegisterRequest - Request body for local user registration
 */
export class RegisterRequest extends Schema.Class<RegisterRequest>("RegisterRequest")({
  email: Email,
  password: Schema.String.check(Schema.isMinLength(8)).annotate({
    description: "User's password (min 8 characters)",
    examples: ["kNmGP3sW_ygVLdcNVbxU"],
  }),
  displayName: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty())).annotate({
    description: "User's display name",
    examples: ["Max Mustermann"],
  }),
}) {}

/**
 * VerificationFlowResponse - Response for register/resend verification flows
 */
export class VerificationFlowResponse extends Schema.Class<VerificationFlowResponse>(
  "VerificationFlowResponse"
)({
  email: Email,
  redirectTo: Schema.String.annotate({
    description: "Frontend route to continue the email verification flow",
    examples: ["/verify-email"],
  }),
}) {}

/**
 * VerifyEmailRequest - Request body for completing email verification
 */
export class VerifyEmailRequest extends Schema.Class<VerifyEmailRequest>("VerifyEmailRequest")({
  code: EmailVerificationCode,
}) {}

/**
 * VerifyEmailResponse - Response after successful email verification
 */
export class VerifyEmailResponse extends Schema.Class<VerifyEmailResponse>("VerifyEmailResponse")({
  redirectTo: Schema.String.annotate({
    description: "Frontend route to navigate to after verification succeeds",
    examples: ["/home"],
  }),
}) {}

/**
 * LocalLoginCredentials - Credentials for local provider login
 */
export class LocalLoginCredentials extends Schema.Class<LocalLoginCredentials>(
  "LocalLoginCredentials"
)({
  email: Email,
  password: Schema.String.annotate({
    description: "User's password",
  }),
}) {}

/**
 * OAuthLoginCredentials - Credentials for OAuth provider login (authorization code)
 */
export class OAuthLoginCredentials extends Schema.Class<OAuthLoginCredentials>(
  "OAuthLoginCredentials"
)({
  code: Schema.String.annotate({
    description: "Authorization code from OAuth provider",
  }),
  state: Schema.String.annotate({
    description: "State parameter for CSRF validation",
  }),
}) {}

/**
 * LoginRequest - Request body for login
 *
 * The credentials field varies based on provider:
 * - local: LocalLoginCredentials (email/password)
 * - oauth providers: OAuthLoginCredentials (code/state)
 */
export const LoginRequest = Schema.Union([
  Schema.Struct({
    provider: Schema.Literal("local"),
    credentials: LocalLoginCredentials,
  }),
  Schema.Struct({
    provider: OAuthProviderType,
    credentials: OAuthLoginCredentials,
  }),
]).annotate({
  identifier: "LoginRequest",
  title: "Login Request",
  description:
    "Login payload where credentials are validated based on the selected authentication provider",
})

export type LoginRequest = typeof LoginRequest.Type

/**
 * LoginResponse - Successful login response
 */
export class LoginResponse extends Schema.Class<LoginResponse>("LoginResponse")({
  token: SessionId.annotate({
    description: "Session token to use for authenticated requests",
  }),
  user: AuthUser,
  provider: AuthProviderType.annotate({
    description: "The provider used for authentication",
  }),
  expiresAt: Schema.DateTimeUtc.annotate({
    description: "When the session expires",
  }),
}) {}

/**
 * AccountDetails - User-facing account information.
 */
export const AccountDetails = Schema.Struct({
  id: AuthUser.fields.id,
  email: AuthUser.fields.email,
  displayName: AuthUser.fields.displayName,
  role: AuthUser.fields.role,
  emailVerified: AuthUser.fields.emailVerified,
  welcomeSeenAt: Schema.NullOr(Schema.DateTimeUtc).annotate({
    description:
      "When the user first finished or skipped the welcome, encoded as an ISO 8601 string, or null if not yet seen",
  }),
  createdAt: Schema.DateTimeUtc.annotate({
    description: "When the user account was created, encoded as an ISO 8601 string",
  }),
  updatedAt: Schema.DateTimeUtc.annotate({
    description: "When the user account was last updated, encoded as an ISO 8601 string",
  }),
}).annotate({
  identifier: "AccountDetails",
  title: "Account Details",
})

export type AccountDetails = typeof AccountDetails.Type

/**
 * LoginMethodUnavailableReason - Why a linked login method cannot currently authenticate.
 */
export const LoginMethodUnavailableReason = Schema.Literals([
  "provider_disabled",
  "email_unverified",
]).annotate({
  identifier: "LoginMethodUnavailableReason",
  title: "Login Method Unavailable Reason",
})

export type LoginMethodUnavailableReason = typeof LoginMethodUnavailableReason.Type

/**
 * LoginMethod - A user-facing way to access an account.
 */
export const LoginMethod = Schema.Struct({
  id: UserIdentityId,
  provider: AuthProviderType,
  providerEmail: Schema.NullOr(Email).annotate({
    description: "The email reported by the login provider, when available",
  }),
  linkedAt: Schema.DateTimeUtc.annotate({
    description: "When this login method was linked, encoded as an ISO 8601 string",
  }),
  isCurrentSession: Schema.Boolean.annotate({
    description: "Whether this login method authenticated the current session",
  }),
  isAvailable: Schema.Boolean.annotate({
    description: "Whether this login method can currently authenticate the account",
  }),
  unavailableReason: Schema.NullOr(LoginMethodUnavailableReason).annotate({
    description: "Why this login method cannot currently authenticate, when unavailable",
  }),
  canRemove: Schema.Boolean.annotate({
    description: "Whether this login method can be removed without locking the account",
  }),
}).annotate({
  identifier: "LoginMethod",
  title: "Login Method",
})

export type LoginMethod = typeof LoginMethod.Type

/**
 * AccountResponse - Authenticated account details and linked login methods.
 */
export const AccountResponse = Schema.Struct({
  account: AccountDetails,
  loginMethods: Schema.Array(LoginMethod).annotate({
    description: "All login methods linked to the account",
  }),
}).annotate({
  identifier: "AccountResponse",
  title: "Account Response",
  description: "Response containing account details and linked login methods",
})

export type AccountResponse = typeof AccountResponse.Type

/**
 * RefreshResponse - Response from session refresh
 */
export class RefreshResponse extends Schema.Class<RefreshResponse>("RefreshResponse")({
  token: SessionId.annotate({
    description: "New session token",
  }),
  expiresAt: Schema.DateTimeUtc.annotate({
    description: "When the new session expires",
  }),
}) {}

/**
 * UpdateProfileRequest - Request body for updating user profile
 */
export class UpdateProfileRequest extends Schema.Class<UpdateProfileRequest>(
  "UpdateProfileRequest"
)({
  displayName: Schema.OptionFromNullOr(Schema.Trimmed.check(Schema.isNonEmpty())).annotate({
    description: "The user's display name (optional - only provided fields are updated)",
  }),
}) {}

/**
 * OAuthCallbackParams - Query parameters for OAuth callback
 */
export const OAuthCallbackParams = Schema.Struct({
  code: Schema.String.annotate({
    description: "Authorization code from OAuth provider",
  }),
  state: Schema.String.annotate({
    description: "State parameter for CSRF validation",
  }),
  error: Schema.optional(Schema.String).annotate({
    description: "Error code if authorization failed",
  }),
  error_description: Schema.optional(Schema.String).annotate({
    description: "Human-readable error description",
  }),
})

/**
 * Type for OAuthCallbackParams
 */
export type OAuthCallbackParams = typeof OAuthCallbackParams.Type

/**
 * OAuthAuthorizeParams - Query parameters for browser-based OAuth authorize flows
 */
export const OAuthAuthorizeParams = Schema.Struct({
  redirectTo: Schema.optional(Schema.String).annotate({
    description:
      "Optional frontend-relative path to redirect to after browser-based OAuth completion",
  }),
})

/**
 * Type for OAuthAuthorizeParams
 */
export type OAuthAuthorizeParams = typeof OAuthAuthorizeParams.Type

/**
 * AuthorizeRedirectResponse - Response for authorize endpoint (redirect URL)
 */
export class AuthorizeRedirectResponse extends Schema.Class<AuthorizeRedirectResponse>(
  "AuthorizeRedirectResponse"
)({
  redirectUrl: Schema.String.annotate({
    description: "URL to redirect the user to for OAuth authorization",
  }),
  state: Schema.String.annotate({
    description: "State parameter for CSRF validation",
  }),
}) {}

/**
 * LinkInitiateResponse - Response when initiating provider linking
 */
export class LinkInitiateResponse extends Schema.Class<LinkInitiateResponse>(
  "LinkInitiateResponse"
)({
  redirectUrl: Schema.String.annotate({
    description: "URL to redirect the user to for OAuth authorization",
  }),
  state: Schema.String.annotate({
    description: "State parameter for CSRF validation",
  }),
}) {}

/**
 * OAuthSessionStatus - Status values for pollable OAuth flow
 */
export const OAuthSessionStatus = Schema.Literals(["pending", "completed", "failed", "expired"])

/**
 * OAuthSessionResponse - Pollable OAuth session resource
 */
export class OAuthSessionResponse extends Schema.Class<OAuthSessionResponse>(
  "OAuthSessionResponse"
)({
  id: Schema.String,
  provider: OAuthProviderType,
  status: OAuthSessionStatus,
  authorizationUrl: Schema.OptionFromNullOr(Schema.String),
  sessionToken: Schema.OptionFromNullOr(Schema.String),
  userId: Schema.OptionFromNullOr(Schema.String),
  message: Schema.OptionFromNullOr(Schema.String),
  expiresAt: Schema.DateTimeUtc,
}) {}

// =============================================================================
// Public API Endpoints
// =============================================================================

/**
 * GET /auth/providers - List enabled authentication providers
 */
const getProviders = HttpApiEndpoint.get("getProviders", "/providers", {
  success: ProvidersResponse,
}).annotateMerge(
  OpenApi.annotations({
    summary: "List authentication providers",
    description: "Returns a list of enabled authentication providers with their metadata",
  })
)

/**
 * POST /auth/register - Register a new user (local provider only)
 */
const register = HttpApiEndpoint.post("register", "/register", {
  payload: Schema.Struct(RegisterRequest.fields),
  success: VerificationFlowResponse.pipe(HttpApiSchema.status(201)),
  error: [AuthValidationError, PasswordWeakError, UserExistsError, InternalServerError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "Register new user",
    description:
      "Create a new local user account, start the email verification flow, and route the user to verification.",
  })
)

/**
 * POST /auth/verify-email - Verify a local email and create the session
 */
const verifyEmail = HttpApiEndpoint.post("verifyEmail", "/verify-email", {
  payload: Schema.Struct(VerifyEmailRequest.fields),
  success: VerifyEmailResponse,
  error: [
    EmailVerificationFlowMissingError,
    EmailVerificationCodeInvalidError,
    EmailVerificationCodeExpiredError,
    InternalServerError,
  ],
}).annotateMerge(
  OpenApi.annotations({
    summary: "Verify email",
    description:
      "Validate the pending verification code, mark the local user as verified, and create the session.",
  })
)

/**
 * POST /auth/resend-verification - Replace the pending verification code
 */
const resendVerification = HttpApiEndpoint.post("resendVerification", "/resend-verification", {
  success: VerificationFlowResponse,
  error: [EmailVerificationFlowMissingError, InternalServerError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "Resend verification code",
    description:
      "Replace the pending local email verification code and continue the verification flow.",
  })
)

/**
 * POST /auth/login - Login with any provider
 */
const login = HttpApiEndpoint.post("login", "/login", {
  payload: LoginRequest,
  success: LoginResponse,
  error: [
    AuthValidationError,
    AuthUnauthorizedError,
    EmailVerificationRequiredError,
    ProviderAuthError,
    ProviderNotFoundError,
    OAuthStateInvalidError,
    InternalServerError,
  ],
}).annotateMerge(
  OpenApi.annotations({
    summary: "Login",
    description:
      "Authenticate with any enabled provider. For local provider, provide email/password. For OAuth providers, provide authorization code and state.",
  })
)

/**
 * GET /auth/authorize/:provider - Get OAuth authorization URL
 */
const authorize = HttpApiEndpoint.get("authorize", "/authorize/:provider", {
  params: Schema.Struct({ provider: AuthProviderType }),
  query: OAuthAuthorizeParams,
  success: AuthorizeRedirectResponse,
  error: [ProviderNotFoundError, ProviderAuthError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "Get authorization URL",
    description:
      "Get the OAuth/SAML authorization URL for the specified provider. Redirect the user to this URL to initiate the OAuth flow.",
  })
)

/**
 * GET /auth/callback/:provider - Handle OAuth callback
 */
const callback = HttpApiEndpoint.get("callback", "/callback/:provider", {
  params: Schema.Struct({ provider: AuthProviderType }),
  query: OAuthCallbackParams,
  success: LoginResponse,
  error: [ProviderNotFoundError, ProviderAuthError, OAuthStateInvalidError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "OAuth callback",
    description:
      "Handle the OAuth/SAML callback from the provider. Exchanges the authorization code for tokens and creates a session.",
  })
)

/**
 * GET /auth/oauth/:id - Poll OAuth flow status
 */
const getOAuthSession = HttpApiEndpoint.get("getOAuthSession", "/oauth/:id", {
  params: Schema.Struct({
    id: Schema.String,
  }),
  success: OAuthSessionResponse,
  error: ProviderAuthError,
}).annotateMerge(
  OpenApi.annotations({
    summary: "Get OAuth session",
    description: "Returns current status and completion details for an OAuth session.",
  })
)

/**
 * GET /cdp/callback - Handle Coinbase OAuth callback (legacy client compatibility)
 */
const cdpCallback = HttpApiEndpoint.get("cdpCallback", "/callback", {
  query: OAuthCallbackParams,
  success: LoginResponse,
  error: [ProviderNotFoundError, ProviderAuthError, OAuthStateInvalidError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "Coinbase OAuth callback",
    description:
      "Handle Coinbase OAuth callback using the legacy /cdp/callback path for existing OAuth clients.",
  })
)

// =============================================================================
// Protected API Endpoints
// =============================================================================

/**
 * LogoutResponse - Successful logout response
 */
export class LogoutResponse extends Schema.Class<LogoutResponse>("LogoutResponse")({
  success: Schema.Boolean.annotate({
    description: "Whether the logout was successful",
  }),
}) {}

/**
 * POST /auth/logout - Logout and invalidate session
 */
const logout = HttpApiEndpoint.post("logout", "/logout", {
  success: LogoutResponse,
  error: SessionInvalidError,
}).annotateMerge(
  OpenApi.annotations({
    summary: "Logout",
    description: "Invalidate the current session and logout the user",
  })
)

/**
 * GET /auth/me - Get current user details
 */
const me = HttpApiEndpoint.get("me", "/me", {
  success: AccountResponse,
  error: AuthUserNotFoundError,
}).annotateMerge(
  OpenApi.annotations({
    summary: "Get current user",
    description: "Get the authenticated account and its linked login methods",
  })
)

/**
 * PUT /auth/me - Update current user profile
 */
const updateMe = HttpApiEndpoint.put("updateMe", "/me", {
  payload: Schema.Struct(UpdateProfileRequest.fields),
  success: AccountResponse,
  error: [AuthValidationError, AuthUserNotFoundError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "Update current user profile",
    description: "Update the authenticated user's profile information (display name)",
  })
)

/**
 * POST /auth/me/welcome - Record that the current user has seen the welcome
 *
 * Stamps `welcomeSeenAt` with server time on the first call. Later calls keep
 * the first timestamp and return the account unchanged.
 */
const markWelcomeSeen = HttpApiEndpoint.post("markWelcomeSeen", "/me/welcome", {
  success: AccountResponse,
  error: AuthUserNotFoundError,
}).annotateMerge(
  OpenApi.annotations({
    summary: "Mark the welcome as seen",
    description:
      "Record server time as the moment the authenticated user finished or skipped the welcome. A second call keeps the first timestamp.",
  })
)

/**
 * POST /auth/refresh - Refresh session token
 */
const refresh = HttpApiEndpoint.post("refresh", "/refresh", {
  success: RefreshResponse,
  error: SessionInvalidError,
}).annotateMerge(
  OpenApi.annotations({
    summary: "Refresh session",
    description: "Refresh the current session and get a new token with extended expiration",
  })
)

/**
 * POST /auth/link/:provider - Initiate linking additional provider
 */
const linkProvider = HttpApiEndpoint.post("linkProvider", "/link/:provider", {
  params: Schema.Struct({ provider: AuthProviderType }),
  success: LinkInitiateResponse,
  error: [ProviderNotFoundError, ProviderAuthError, IdentityLinkedError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "Link provider",
    description:
      "Initiate linking an additional authentication provider to the current user account. Returns an OAuth authorization URL.",
  })
)

/**
 * GET /auth/link/callback/:provider - Complete provider linking
 */
const linkCallback = HttpApiEndpoint.get("linkCallback", "/link/callback/:provider", {
  params: Schema.Struct({ provider: AuthProviderType }),
  query: OAuthCallbackParams,
  success: AccountResponse,
  error: [ProviderNotFoundError, ProviderAuthError, OAuthStateInvalidError, IdentityLinkedError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "Link provider callback",
    description:
      "Complete the provider linking flow after OAuth authorization. Links the provider identity to the current user account.",
  })
)

/**
 * DELETE /auth/identities/:identityId - Unlink provider from account
 */
const unlinkIdentity = HttpApiEndpoint.delete("unlinkIdentity", "/identities/:identityId", {
  params: Schema.Struct({ identityId: UserIdentityId }),
  success: HttpApiSchema.NoContent,
  error: [IdentityNotFoundError, CannotUnlinkLastIdentityError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "Unlink identity",
    description:
      "Remove a linked provider identity from the current user account. Users must maintain at least one linked identity.",
  })
)

/**
 * ChangePasswordRequest - Request body for changing password
 */
export class ChangePasswordRequest extends Schema.Class<ChangePasswordRequest>(
  "ChangePasswordRequest"
)({
  currentPassword: Schema.String.annotate({
    description: "The user's current password for verification",
  }),
  newPassword: Schema.String.check(Schema.isMinLength(8)).annotate({
    description: "The new password (min 8 characters)",
  }),
}) {}

/**
 * ChangePasswordError - Current password is incorrect (401)
 */
export class ChangePasswordError extends Schema.TaggedError<ChangePasswordError>()(
  "ChangePasswordError",
  {
    message: Schema.String.pipe(
      Schema.withConstructorDefault(Effect.succeed("Current password is incorrect"))
    ),
  },
  { httpApiStatus: 401 }
) {}

/**
 * NoLocalIdentityError - User has no local provider linked (400)
 */
export class NoLocalIdentityError extends Schema.TaggedError<NoLocalIdentityError>()(
  "NoLocalIdentityError",
  {
    message: Schema.String.pipe(
      Schema.withConstructorDefault(
        Effect.succeed(
          "No local identity linked. Password change is only available for accounts with local authentication."
        )
      )
    ),
  },
  { httpApiStatus: 400 }
) {}

/**
 * POST /auth/change-password - Change user's password
 */
const changePassword = HttpApiEndpoint.post("changePassword", "/change-password", {
  payload: Schema.Struct(ChangePasswordRequest.fields),
  success: HttpApiSchema.NoContent,
  error: [ChangePasswordError, NoLocalIdentityError, PasswordWeakError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "Change password",
    description:
      "Change the current user's password. Requires the current password for verification. Only available for users with local authentication.",
  })
)

// =============================================================================
// API Groups
// =============================================================================

/**
 * AuthApi - Public authentication API group
 *
 * Base path: /auth
 *
 * Public endpoints (no authentication required):
 * - GET /providers - List enabled providers
 * - POST /register - Register new user
 * - POST /login - Login
 * - GET /authorize/:provider - Get OAuth authorization URL
 * - GET /callback/:provider - OAuth callback
 */
export class AuthApi extends HttpApiGroup.make("auth")
  .add(getProviders)
  .add(register)
  .add(verifyEmail)
  .add(resendVerification)
  .add(login)
  .add(authorize)
  .add(callback)
  .add(getOAuthSession)
  .prefix("/auth")
  .annotateMerge(
    OpenApi.annotations({
      title: "Authentication",
      description:
        "Public authentication endpoints for provider discovery, registration, and login",
    })
  ) {}

/**
 * AuthSessionApi - Protected authentication API group
 *
 * Base path: /auth
 *
 * Protected endpoints (require authentication):
 * - POST /logout - Logout
 * - GET /me - Get current user
 * - PUT /me - Update current user profile
 * - POST /me/welcome - Mark the welcome as seen
 * - POST /refresh - Refresh session
 * - POST /link/:provider - Initiate provider linking
 * - GET /link/callback/:provider - Complete provider linking
 * - DELETE /identities/:identityId - Unlink provider
 * - POST /change-password - Change password
 */
export class AuthSessionApi extends HttpApiGroup.make("authSession")
  .add(logout)
  .add(me)
  .add(updateMe)
  .add(markWelcomeSeen)
  .add(refresh)
  .add(linkProvider)
  .add(linkCallback)
  .add(unlinkIdentity)
  .add(changePassword)
  .middleware(AuthMiddleware)
  .prefix("/auth")
  .annotateMerge(
    OpenApi.annotations({
      title: "Authentication (Session)",
      description: "Protected authentication endpoints for session management and identity linking",
    })
  ) {}

/**
 * CoinbaseCompatApi - Coinbase OAuth compatibility callback group
 *
 * Base path: /cdp
 *
 * Public endpoints:
 * - GET /callback - Coinbase OAuth callback for existing OAuth clients
 */
export class CoinbaseCompatApi extends HttpApiGroup.make("coinbaseCompat")
  .add(cdpCallback)
  .prefix("/cdp")
  .annotateMerge(
    OpenApi.annotations({
      title: "Coinbase OAuth Compatibility",
      description:
        "Compatibility callback endpoint for existing Coinbase OAuth clients that are locked to /cdp/callback.",
    })
  ) {}
