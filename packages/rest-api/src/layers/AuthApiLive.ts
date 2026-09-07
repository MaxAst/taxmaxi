/**
 * AuthApiLive - Live implementation of authentication API handlers
 *
 * Implements the AuthApi (public) and AuthSessionApi (protected) endpoints
 * by delegating to AuthService from the persistence package.
 *
 * Features:
 * - Provider discovery with UI metadata
 * - Local registration with password validation and email verification bootstrap
 * - Verification code resend and email verification completion
 * - Multi-provider login (local + OAuth)
 * - Cookie-backed pending verification and authenticated session flows
 * - OAuth authorization URL generation
 * - OAuth callback handling with session creation and polling
 * - Session management (logout, refresh)
 * - Provider identity linking/unlinking
 * - Proper error mapping to API error types
 *
 * @module AuthApiLive
 */

import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as Chunk from "effect/Chunk"
import * as Config from "effect/Config"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { TaxMaxiApi } from "../definitions/TaxMaxiApi.ts"
import {
  CurrentUser,
  TokenValidator,
  User,
  type TokenValidatorService,
} from "../definitions/AuthMiddleware.ts"
import {
  ProvidersResponse,
  ProviderMetadata,
  LoginResponse,
  LogoutResponse,
  type AccountResponse,
  VerificationFlowResponse,
  VerifyEmailResponse,
  RefreshResponse,
  AuthorizeRedirectResponse,
  LinkInitiateResponse,
  OAuthSessionResponse,
  AuthValidationError,
  PasswordWeakError,
  OAuthStateInvalidError,
  ProviderAuthError,
  ProviderNotFoundError,
  AuthUnauthorizedError,
  EmailVerificationFlowMissingError,
  EmailVerificationCodeInvalidError,
  EmailVerificationCodeExpiredError,
  EmailVerificationRequiredError,
  UserExistsError,
  SessionInvalidError,
  IdentityLinkedError,
  CannotUnlinkLastIdentityError,
  IdentityNotFoundError,
  ChangePasswordError,
  NoLocalIdentityError,
  AuthUserNotFoundError,
} from "../definitions/AuthApi.ts"
import { InternalServerError, UnauthorizedError } from "../definitions/ApiErrors.ts"
import {
  type AuthProviderType,
  AuthService,
  type AuthServiceShape,
  type AuthUser,
  Email,
  EmailVerificationRequestId,
  LocalAuthRequest,
  PasswordHasher,
  ProviderId,
  SessionId,
  type UserIdentity,
} from "@my/core/authentication"
import {
  type InvalidCredentialsError as CoreInvalidCredentialsError,
  type OAuthStateError as CoreOAuthStateError,
  type ProviderAuthFailedError as CoreProviderAuthFailedError,
  type ProviderNotEnabledError as CoreProviderNotEnabledError,
  type UserNotFoundError as CoreUserNotFoundError,
  isEmailVerificationCodeMismatchError,
  isEmailVerificationRequestExpiredError,
  isEmailVerificationRequestNotFoundError,
  isPasswordTooWeakError,
  isUserAlreadyExistsError,
  isProviderNotEnabledError,
  isInvalidCredentialsError,
  isProviderAuthFailedError,
  isOAuthStateError,
  isIdentityAlreadyLinkedError,
  isSessionNotFoundError,
  isSessionExpiredError,
  isUserNotFoundError,
} from "@my/core/authentication/errors"
import { CexSourceRef, SourceId } from "@my/core/source"
import {
  CexAccountRepository,
  IdentityRepository,
  OAuthStateStore,
  PrincipalRepository,
  SessionRepository,
  SourceRepository,
  UserRepository,
} from "@my/persistence/services"
import { withObservedOperation } from "@my/core/shared/observability/ObservedOperation"
import { Timestamp } from "@my/core/shared/values/Timestamp"

// =============================================================================
// Constants
// =============================================================================

const SESSION_COOKIE_NAME = "taxmaxi_session"
const VERIFICATION_COOKIE_NAME = "taxmaxi_verification"
const OAUTH_REDIRECT_COOKIE_NAME = "taxmaxi_oauth_redirect"
const SESSION_COOKIE_MAX_AGE = Duration.days(30)
const OAUTH_REDIRECT_COOKIE_MAX_AGE = Duration.minutes(10)
const AUTH_PUBLIC_BASE_URL_DEFAULT = "http://localhost:4000"
const FRONTEND_URL_DEFAULT = "http://localhost:3000"
const VERIFY_EMAIL_REDIRECT = "/verify-email"
const POST_AUTH_REDIRECT = "/home"

const randomUuid = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.provide(NodeCrypto.layer),
  Effect.orDie
)

const randomBytes = (size: number): Effect.Effect<Uint8Array> =>
  Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.randomBytes(size)),
    Effect.provide(NodeCrypto.layer),
    Effect.orDie
  )

const cookieOptionsForEnv = (environment: string, path = "/", domain?: string) => ({
  httpOnly: true,
  secure: environment === "production",
  sameSite: "lax" as const,
  path,
  ...(environment === "production" && domain !== undefined ? { domain } : {}),
})

const sessionCookieDomain = Config.option(Config.string("COOKIE_DOMAIN")).pipe(
  Config.map(Option.getOrUndefined)
)

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Normalize a public base URL by trimming whitespace and trailing slash.
 */
const normalizeBaseUrl = (baseUrl: string): string => {
  const trimmed = baseUrl.trim()
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed
}

const isSafeRedirectPath = (redirectTo: string | undefined): redirectTo is `/${string}` =>
  typeof redirectTo === "string" && redirectTo.startsWith("/") && !redirectTo.startsWith("//")

/**
 * Build an absolute OAuth callback URL from base URL and callback path.
 */
const buildOAuthCallbackUrl = (authPublicBaseUrl: string, callbackPath: `/${string}`): string =>
  `${authPublicBaseUrl}${callbackPath}`

/**
 * Resolve the login callback path for a provider.
 *
 * Coinbase temporarily uses the legacy `/cdp/callback` path for compatibility
 * with existing OAuth clients. Other providers use `/auth/callback/:provider`.
 */
const getOAuthLoginCallbackPath = (provider: AuthProviderType): `/${string}` =>
  provider === "coinbase" ? "/cdp/callback" : `/auth/callback/${provider}`

const buildFrontendRedirectUrl = (frontendUrl: string, redirectTo: `/${string}`): string =>
  `${frontendUrl}${redirectTo}`

/**
 * Complete OAuth login and map domain errors to API error schemas.
 */
const completeOAuthLoginWithErrorMapping = ({
  authService,
  provider,
  code,
  state,
}: {
  authService: AuthServiceShape
  provider: AuthProviderType
  code: string
  state: string
}) =>
  authService.completeOAuthLogin(provider, code, state).pipe(
    Effect.mapError((error) => {
      if (isProviderNotEnabledError(error)) {
        return new ProviderNotFoundError({ provider })
      }
      if (isProviderAuthFailedError(error)) {
        return new ProviderAuthError({
          provider,
          reason: error.reason,
        })
      }
      if (isOAuthStateError(error)) {
        return new OAuthStateInvalidError({ provider })
      }
      return new ProviderAuthError({
        provider,
        reason: "OAuth callback failed",
      })
    })
  )

const mapOAuthStartError = ({
  provider,
  error,
}: {
  readonly provider: AuthProviderType
  readonly error: CoreProviderNotEnabledError | CoreProviderAuthFailedError
}) => {
  if (isProviderNotEnabledError(error)) {
    return new ProviderNotFoundError({ provider })
  }
  if (isProviderAuthFailedError(error)) {
    return new ProviderAuthError({
      provider,
      reason: error.reason,
    })
  }
  return new ProviderAuthError({
    provider,
    reason: "OAuth authorization failed",
  })
}

const mapPersistenceError = (provider: AuthProviderType, error: { readonly message: string }) =>
  new ProviderAuthError({
    provider,
    reason: `OAuth session persistence failed: ${error.message}`,
  })

const epochTimestamp = Timestamp.make({ epochMillis: 0 })

const nowTimestamp = Effect.map(
  Effect.clockWith((clock) => clock.currentTimeMillis),
  (currentTimeMillis) => Timestamp.make({ epochMillis: Number(currentTimeMillis) })
)

const addDaysToTimestamp = (timestamp: Timestamp, days: number): Timestamp =>
  Timestamp.make({
    epochMillis: timestamp.epochMillis + Duration.toMillis(Duration.days(days)),
  })

const authRouteSpan = ({
  name,
  attributes,
}: {
  readonly name: string
  readonly attributes?: Record<string, unknown>
}) =>
  withObservedOperation({
    name: `rest-api.auth.${name}`,
    attributes,
    kind: "server",
  })

const ProviderProfileEmail = Schema.Struct({
  email: Schema.optional(Email),
})

const providerEmailFromIdentity = (identity: UserIdentity): Email | null => {
  if (identity.provider === "local") {
    return null
  }

  return Option.match(identity.providerData, {
    onNone: () => null,
    onSome: ({ profile }) =>
      Option.match(Schema.decodeUnknownOption(ProviderProfileEmail)(profile), {
        onNone: () => null,
        onSome: ({ email }) => email ?? null,
      }),
  })
}

const getEnabledProviderSet = (authService: AuthServiceShape) =>
  authService.getEnabledProviders.pipe(
    Effect.map((providers) => new Set(Chunk.toReadonlyArray(providers)))
  )

const getLoginMethodAvailability = ({
  user,
  identity,
  enabledProviders,
}: {
  readonly user: AuthUser
  readonly identity: UserIdentity
  readonly enabledProviders: ReadonlySet<AuthProviderType>
}) => {
  if (!enabledProviders.has(identity.provider)) {
    return {
      isAvailable: false,
      unavailableReason: "provider_disabled" as const,
    }
  }

  if (identity.provider === "local" && !user.emailVerified) {
    return {
      isAvailable: false,
      unavailableReason: "email_unverified" as const,
    }
  }

  return {
    isAvailable: true,
    unavailableReason: null,
  }
}

const hasAvailableIdentityOtherThan = ({
  user,
  identities,
  enabledProviders,
  identityId,
}: {
  readonly user: AuthUser
  readonly identities: Iterable<UserIdentity>
  readonly enabledProviders: ReadonlySet<AuthProviderType>
  readonly identityId: UserIdentity["id"]
}): boolean => {
  for (const identity of identities) {
    if (
      identity.id !== identityId &&
      getLoginMethodAvailability({ user, identity, enabledProviders }).isAvailable
    ) {
      return true
    }
  }

  return false
}

const toAccountResponse = ({
  user,
  identities,
  enabledProviders,
  currentSessionProvider,
}: {
  readonly user: AuthUser
  readonly identities: ReadonlyArray<UserIdentity>
  readonly enabledProviders: ReadonlySet<AuthProviderType>
  readonly currentSessionProvider: AuthProviderType | undefined
}): AccountResponse => ({
  account: {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    emailVerified: user.emailVerified,
    welcomeSeenAt: user.welcomeSeenAt === null ? null : user.welcomeSeenAt.toDateTime(),
    createdAt: user.createdAt.toDateTime(),
    updatedAt: user.updatedAt.toDateTime(),
  },
  loginMethods: identities.map((identity) => {
    const availability = getLoginMethodAvailability({ user, identity, enabledProviders })

    return {
      id: identity.id,
      provider: identity.provider,
      providerEmail: providerEmailFromIdentity(identity),
      linkedAt: identity.createdAt.toDateTime(),
      isCurrentSession: identity.provider === currentSessionProvider,
      ...availability,
      canRemove: hasAvailableIdentityOtherThan({
        user,
        identities,
        enabledProviders,
        identityId: identity.id,
      }),
    }
  }),
})

/**
 * Set httpOnly session cookie via pre-response handler
 */
const setSessionCookie = (
  token: string,
  baseCookieOptions: ReturnType<typeof cookieOptionsForEnv>
): Effect.Effect<void, never, HttpServerRequest.HttpServerRequest> => {
  return HttpEffect.appendPreResponseHandler((_req, response) =>
    Effect.orDie(
      HttpServerResponse.setCookie(response, SESSION_COOKIE_NAME, token, {
        ...baseCookieOptions,
        maxAge: SESSION_COOKIE_MAX_AGE,
      })
    )
  )
}

/**
 * Clear the session cookie by expiring it with a past date
 */
const clearSessionCookie = (
  baseCookieOptions: ReturnType<typeof cookieOptionsForEnv>
): Effect.Effect<void, never, HttpServerRequest.HttpServerRequest> => {
  return HttpEffect.appendPreResponseHandler((_req, response) =>
    Effect.orDie(
      HttpServerResponse.setCookie(response, SESSION_COOKIE_NAME, "", {
        ...baseCookieOptions,
        expires: DateTime.toDateUtc(DateTime.makeUnsafe(0)), // Expire in the past
      })
    )
  )
}

/**
 * Set the pending verification flow cookie used by verify/resend endpoints.
 */
const setVerificationCookie = ({
  requestId,
  expiresAt,
  baseCookieOptions,
}: {
  readonly requestId: EmailVerificationRequestId
  readonly expiresAt: Date
  readonly baseCookieOptions: ReturnType<typeof cookieOptionsForEnv>
}): Effect.Effect<void, never, HttpServerRequest.HttpServerRequest> =>
  HttpEffect.appendPreResponseHandler((_req, response) =>
    Effect.orDie(
      HttpServerResponse.setCookie(response, VERIFICATION_COOKIE_NAME, requestId, {
        ...baseCookieOptions,
        expires: expiresAt,
      })
    )
  )

/**
 * Clear the pending verification flow cookie.
 */
const clearVerificationCookie = (
  baseCookieOptions: ReturnType<typeof cookieOptionsForEnv>
): Effect.Effect<void, never, HttpServerRequest.HttpServerRequest> =>
  HttpEffect.appendPreResponseHandler((_req, response) =>
    Effect.orDie(
      HttpServerResponse.setCookie(response, VERIFICATION_COOKIE_NAME, "", {
        ...baseCookieOptions,
        expires: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
      })
    )
  )

const setOAuthRedirectCookie = ({
  provider,
  redirectTo,
  baseCookieOptions,
}: {
  readonly provider: AuthProviderType
  readonly redirectTo: `/${string}`
  readonly baseCookieOptions: ReturnType<typeof cookieOptionsForEnv>
}): Effect.Effect<void, never, HttpServerRequest.HttpServerRequest> =>
  HttpEffect.appendPreResponseHandler((_req, response) =>
    Effect.orDie(
      HttpServerResponse.setCookie(response, OAUTH_REDIRECT_COOKIE_NAME, redirectTo, {
        ...baseCookieOptions,
        maxAge: OAUTH_REDIRECT_COOKIE_MAX_AGE,
        path: getOAuthLoginCallbackPath(provider),
      })
    )
  )

const clearOAuthRedirectCookie = ({
  provider,
  baseCookieOptions,
}: {
  readonly provider: AuthProviderType
  readonly baseCookieOptions: ReturnType<typeof cookieOptionsForEnv>
}): Effect.Effect<void, never, HttpServerRequest.HttpServerRequest> =>
  HttpEffect.appendPreResponseHandler((_req, response) =>
    Effect.orDie(
      HttpServerResponse.setCookie(response, OAUTH_REDIRECT_COOKIE_NAME, "", {
        ...baseCookieOptions,
        expires: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
        path: getOAuthLoginCallbackPath(provider),
      })
    )
  )

const decodeVerificationRequestId = (
  rawRequestId: string | undefined
): Effect.Effect<EmailVerificationRequestId, EmailVerificationFlowMissingError> => {
  if (rawRequestId === undefined) {
    return Effect.fail(new EmailVerificationFlowMissingError({}))
  }

  return Schema.decodeEffect(EmailVerificationRequestId)(rawRequestId).pipe(
    Effect.mapError(() => new EmailVerificationFlowMissingError({}))
  )
}

const internalAuthError = (message: string) =>
  new InternalServerError({
    message,
    requestId: Option.none(),
  })

const logAuthHandlerError = ({
  message,
  error,
  attributes,
}: {
  readonly message: string
  readonly error: unknown
  readonly attributes?: Record<string, unknown>
}) =>
  Effect.logError(
    {
      ...attributes,
      cause: error,
    },
    message
  )

const logCoinbaseCallbackCause = ({
  message,
  state,
  step,
  cause,
  attributes,
}: {
  readonly message: string
  readonly state: string
  readonly step: string
  readonly cause: unknown
  readonly attributes?: Record<string, unknown>
}) =>
  Effect.logError(
    {
      provider: "coinbase",
      state,
      step,
      cause,
      ...attributes,
    },
    message
  )

/**
 * Get provider metadata based on provider type
 */
const getProviderMetadata = (providerType: AuthProviderType): ProviderMetadata => {
  switch (providerType) {
    case "local":
      return ProviderMetadata.make({
        type: "local",
        name: "Email & Password",
        supportsRegistration: true,
        supportsPasswordLogin: true,
        oauthEnabled: false,
      })
    case "google":
      return ProviderMetadata.make({
        type: "google",
        name: "Google",
        supportsRegistration: false,
        supportsPasswordLogin: false,
        oauthEnabled: true,
      })
    case "coinbase":
      return ProviderMetadata.make({
        type: "coinbase",
        name: "Coinbase",
        supportsRegistration: false,
        supportsPasswordLogin: false,
        oauthEnabled: true,
      })
  }
}

/**
 * Map core UserRole to API User role
 */
const mapUserRoleToApiRole = (role: AuthUser["role"]): "admin" | "user" | "readonly" => {
  switch (role) {
    case "admin":
      return "admin"
    case "member":
      return "user"
    case "viewer":
      return "readonly"
    default:
      return "user"
  }
}

// =============================================================================
// Public Auth API Implementation
// =============================================================================

/**
 * AuthApiLive - Layer providing public AuthApi handlers
 *
 * Implements public authentication endpoints:
 * - GET /providers - List enabled providers
 * - POST /register - Register new user and start email verification
 * - POST /verify-email - Complete email verification and create a session
 * - POST /resend-verification - Rotate the pending verification code
 * - POST /login - Login with any provider
 * - GET /authorize/:provider - Get OAuth authorization URL
 * - GET /callback/:provider - OAuth callback
 * - GET /oauth/:id - Poll OAuth session status
 *
 * Dependencies:
 * - AuthService
 * - OAuthStateStore
 * - UserRepository
 * - Config
 */
export const AuthApiLive = HttpApiBuilder.group(TaxMaxiApi, "auth", (handlers) =>
  Effect.gen(function* () {
    const authService = yield* AuthService
    const oauthStateStore = yield* OAuthStateStore
    const userRepo = yield* UserRepository
    const authPublicBaseUrl = yield* Config.string("AUTH_PUBLIC_BASE_URL").pipe(
      Config.withDefault(AUTH_PUBLIC_BASE_URL_DEFAULT),
      Config.map(normalizeBaseUrl)
    )
    const frontendUrl = yield* Config.string("FRONTEND_URL").pipe(
      Config.withDefault(FRONTEND_URL_DEFAULT),
      Config.map(normalizeBaseUrl)
    )
    const environment = yield* Config.string("ENVIRONMENT").pipe(Config.withDefault("development"))
    const cookieDomain = yield* sessionCookieDomain
    const sessionCookieOptions = cookieOptionsForEnv(environment, "/", cookieDomain)
    const verificationCookieOptions = cookieOptionsForEnv(environment, "/auth")

    const failWithPendingEmailVerification = (email: AuthUser["email"]) =>
      Effect.gen(function* () {
        const maybeUser = yield* userRepo.findByEmail(email).pipe(
          Effect.tapError((error) =>
            logAuthHandlerError({
              message: "Failed to load the pending verification user",
              error,
              attributes: { email },
            })
          ),
          Effect.mapError(() => internalAuthError("Failed to load the pending verification user"))
        )

        if (Option.isSome(maybeUser)) {
          const verificationRequest = yield* authService
            .startEmailVerification(maybeUser.value)
            .pipe(
              Effect.tapError((error) =>
                logAuthHandlerError({
                  message: "Failed to prepare the email verification flow",
                  error,
                  attributes: {
                    email,
                    userId: maybeUser.value.id,
                  },
                })
              ),
              Effect.mapError(() =>
                internalAuthError("Failed to prepare the email verification flow")
              )
            )

          yield* setVerificationCookie({
            requestId: verificationRequest.id,
            expiresAt: verificationRequest.expiresAt.toDate(),
            baseCookieOptions: verificationCookieOptions,
          })
        }

        return yield* new EmailVerificationRequiredError({
          email,
        })
      })

    const mapLocalLoginError = ({
      provider,
      error,
    }: {
      readonly provider: AuthProviderType
      readonly error:
        | CoreProviderNotEnabledError
        | CoreInvalidCredentialsError
        | CoreProviderAuthFailedError
        | CoreUserNotFoundError
        | CoreOAuthStateError
        | EmailVerificationRequiredError
        | InternalServerError
    }) => {
      if (error._tag === "EmailVerificationRequiredError" || error._tag === "InternalServerError") {
        return error
      }

      if (isProviderNotEnabledError(error)) {
        return new ProviderNotFoundError({ provider })
      }
      if (isInvalidCredentialsError(error) || isUserNotFoundError(error)) {
        return new AuthUnauthorizedError({
          message: "Invalid email or password",
        })
      }
      if (isProviderAuthFailedError(error)) {
        return new ProviderAuthError({
          provider,
          reason: error.reason,
        })
      }
      if (isOAuthStateError(error)) {
        return new OAuthStateInvalidError({ provider })
      }

      return internalAuthError("Login failed")
    }

    return handlers
      .handle("getProviders", () =>
        Effect.gen(function* () {
          const enabledProviders = yield* authService.getEnabledProviders
          const providers = Chunk.toReadonlyArray(enabledProviders).map(getProviderMetadata)
          return ProvidersResponse.make({ providers })
        })
      )
      .handle("register", (_) =>
        Effect.gen(function* () {
          const { email, password, displayName } = _.payload

          const user = yield* authService.register(email, password, displayName).pipe(
            Effect.tapError((error) =>
              isPasswordTooWeakError(error) || isUserAlreadyExistsError(error)
                ? Effect.void
                : logAuthHandlerError({
                    message: "Registration failed",
                    error,
                    attributes: { email },
                  })
            ),
            Effect.mapError((error) => {
              if (isPasswordTooWeakError(error)) {
                return new PasswordWeakError({
                  requirements: Chunk.toReadonlyArray(error.requirements),
                })
              }
              if (isUserAlreadyExistsError(error)) {
                return new UserExistsError({ email })
              }
              return internalAuthError("Registration failed")
            })
          )

          const verificationRequest = yield* authService.startEmailVerification(user).pipe(
            Effect.tapError((error) =>
              logAuthHandlerError({
                message: "Failed to start the email verification flow",
                error,
                attributes: {
                  email,
                  userId: user.id,
                },
              })
            ),
            Effect.mapError(() => internalAuthError("Failed to start the email verification flow"))
          )

          yield* setVerificationCookie({
            requestId: verificationRequest.id,
            expiresAt: verificationRequest.expiresAt.toDate(),
            baseCookieOptions: verificationCookieOptions,
          })

          return VerificationFlowResponse.make({
            email: verificationRequest.email,
            redirectTo: VERIFY_EMAIL_REDIRECT,
          })
        })
      )
      .handle("verifyEmail", (_) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const requestId = yield* decodeVerificationRequestId(
            request.cookies[VERIFICATION_COOKIE_NAME]
          )

          const { session } = yield* authService.verifyEmail(requestId, _.payload.code).pipe(
            Effect.tapError((error) =>
              isEmailVerificationRequestNotFoundError(error) ||
              isEmailVerificationCodeMismatchError(error) ||
              isEmailVerificationRequestExpiredError(error) ||
              isUserNotFoundError(error)
                ? Effect.void
                : logAuthHandlerError({
                    message: "Failed to complete email verification",
                    error,
                    attributes: { requestId },
                  })
            ),
            Effect.mapError((error) => {
              if (isEmailVerificationRequestNotFoundError(error)) {
                return new EmailVerificationFlowMissingError({})
              }
              if (isEmailVerificationCodeMismatchError(error)) {
                return new EmailVerificationCodeInvalidError({})
              }
              if (isEmailVerificationRequestExpiredError(error)) {
                return new EmailVerificationCodeExpiredError({})
              }
              if (isUserNotFoundError(error)) {
                return new EmailVerificationFlowMissingError({})
              }

              return internalAuthError("Failed to complete email verification")
            })
          )

          yield* setSessionCookie(session.id, sessionCookieOptions)
          yield* clearVerificationCookie(verificationCookieOptions)

          return VerifyEmailResponse.make({
            redirectTo: POST_AUTH_REDIRECT,
          })
        })
      )
      .handle("resendVerification", () =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const requestId = yield* decodeVerificationRequestId(
            request.cookies[VERIFICATION_COOKIE_NAME]
          )

          const verificationRequest = yield* authService.resendEmailVerification(requestId).pipe(
            Effect.tapError((error) =>
              isEmailVerificationRequestNotFoundError(error)
                ? Effect.void
                : logAuthHandlerError({
                    message: "Failed to resend the verification code",
                    error,
                    attributes: { requestId },
                  })
            ),
            Effect.mapError((error) => {
              if (isEmailVerificationRequestNotFoundError(error)) {
                return new EmailVerificationFlowMissingError({})
              }

              return internalAuthError("Failed to resend the verification code")
            })
          )

          yield* setVerificationCookie({
            requestId: verificationRequest.id,
            expiresAt: verificationRequest.expiresAt.toDate(),
            baseCookieOptions: verificationCookieOptions,
          })

          return VerificationFlowResponse.make({
            email: verificationRequest.email,
            redirectTo: VERIFY_EMAIL_REDIRECT,
          })
        })
      )
      .handle("login", (_) =>
        Effect.gen(function* () {
          const payload = _.payload

          if (payload.provider !== "local") {
            const { provider, credentials } = payload
            const { user, session } = yield* authService
              .completeOAuthLogin(provider, credentials.code, credentials.state)
              .pipe(
                Effect.tapError((error) =>
                  isProviderNotEnabledError(error) ||
                  isProviderAuthFailedError(error) ||
                  isOAuthStateError(error)
                    ? Effect.void
                    : logAuthHandlerError({
                        message: "Authentication failed",
                        error,
                        attributes: { provider },
                      })
                ),
                Effect.mapError((error) => {
                  if (isProviderNotEnabledError(error)) {
                    return new ProviderNotFoundError({ provider })
                  }
                  if (isProviderAuthFailedError(error)) {
                    return new ProviderAuthError({
                      provider,
                      reason: error.reason,
                    })
                  }
                  if (isOAuthStateError(error)) {
                    return new OAuthStateInvalidError({ provider })
                  }
                  return internalAuthError("Authentication failed")
                })
              )

            yield* setSessionCookie(session.id, sessionCookieOptions)
            yield* clearVerificationCookie(verificationCookieOptions)

            return LoginResponse.make({
              token: session.id,
              user,
              provider,
              expiresAt: session.expiresAt.toDateTime(),
            })
          }

          const { provider, credentials } = payload

          // Build LocalAuthRequest for local provider
          const authRequest = LocalAuthRequest.make({
            email: credentials.email,
            password: Redacted.make(credentials.password),
          })

          const { user, session } = yield* authService.login(provider, authRequest).pipe(
            Effect.catchTag("UnverifiedEmailError", (error) =>
              failWithPendingEmailVerification(error.email)
            ),
            Effect.mapError((error) =>
              mapLocalLoginError({
                provider,
                error,
              })
            )
          )

          yield* setSessionCookie(session.id, sessionCookieOptions)
          yield* clearVerificationCookie(verificationCookieOptions)

          return LoginResponse.make({
            token: session.id,
            user,
            provider,
            expiresAt: session.expiresAt.toDateTime(),
          })
        })
      )
      .handle("authorize", (_) =>
        Effect.gen(function* () {
          const { provider } = _.params
          return yield* Effect.gen(function* () {
            const redirectTo = _.query.redirectTo

            // Local provider doesn't support OAuth flow
            if (provider === "local") {
              return yield* new ProviderNotFoundError({ provider })
            }

            const loginCallbackUrl = buildOAuthCallbackUrl(
              authPublicBaseUrl,
              getOAuthLoginCallbackPath(provider)
            )
            yield* Effect.logInfo(
              {
                loginCallbackUrl,
                redirectTo,
              },
              "OAuth authorize requested"
            )
            const { authorizationUrl, state } = yield* authService
              .startOAuthLogin(provider, loginCallbackUrl)
              .pipe(
                Effect.tapError((error) =>
                  Effect.logError(
                    {
                      cause: error,
                    },
                    "OAuth authorize failed"
                  )
                ),
                Effect.mapError((error) => mapOAuthStartError({ provider, error }))
              )

            if (isSafeRedirectPath(redirectTo)) {
              yield* setOAuthRedirectCookie({
                provider,
                redirectTo,
                baseCookieOptions: sessionCookieOptions,
              })

              yield* Effect.logInfo(
                {
                  redirectTo,
                },
                "OAuth authorize redirect prepared"
              )

              return HttpServerResponse.redirect(authorizationUrl)
            }

            yield* Effect.logInfo(
              {
                hasRedirectTo: redirectTo !== undefined,
              },
              "OAuth authorize URL returned"
            )

            return AuthorizeRedirectResponse.make({
              redirectUrl: authorizationUrl,
              state,
            })
          }).pipe(
            Effect.annotateLogs({
              authRoute: "authorize",
              provider,
            })
          )
        })
      )
      .handle("callback", (_) =>
        Effect.gen(function* () {
          const { provider } = _.params
          const { code, state, error, error_description } = _.query
          const request = yield* HttpServerRequest.HttpServerRequest
          const redirectTo = isSafeRedirectPath(request.cookies[OAUTH_REDIRECT_COOKIE_NAME])
            ? request.cookies[OAUTH_REDIRECT_COOKIE_NAME]
            : undefined

          // Check for OAuth error from provider
          if (error !== undefined) {
            if (redirectTo !== undefined) {
              yield* clearOAuthRedirectCookie({
                provider,
                baseCookieOptions: sessionCookieOptions,
              })
            }

            const completedAt = yield* nowTimestamp

            yield* oauthStateStore
              .markFailed({
                state,
                statusMessage: error_description ?? error,
                completedAt,
              })
              .pipe(Effect.mapError((storeError) => mapPersistenceError(provider, storeError)))

            return yield* new ProviderAuthError({
              provider,
              reason: error_description ?? error,
            })
          }

          // Complete OAuth login callback flow
          const { user, session } = yield* completeOAuthLoginWithErrorMapping({
            authService,
            provider,
            code,
            state,
          })

          yield* setSessionCookie(session.id, sessionCookieOptions)
          yield* clearVerificationCookie(verificationCookieOptions)
          if (redirectTo !== undefined) {
            yield* clearOAuthRedirectCookie({
              provider,
              baseCookieOptions: sessionCookieOptions,
            })
          }

          const completedAt = yield* nowTimestamp

          yield* oauthStateStore
            .markCompleted({
              state,
              sessionToken: session.id,
              userId: user.id,
              statusMessage: Option.some("OAuth session completed successfully."),
              completedAt,
            })
            .pipe(Effect.mapError((storeError) => mapPersistenceError(provider, storeError)))

          if (redirectTo !== undefined) {
            return HttpServerResponse.redirect(buildFrontendRedirectUrl(frontendUrl, redirectTo))
          }

          return LoginResponse.make({
            token: session.id,
            user,
            provider,
            expiresAt: session.expiresAt.toDateTime(),
          })
        })
      )
      .handle("getOAuthSession", ({ params: path }) =>
        Effect.gen(function* () {
          const maybeState = yield* oauthStateStore
            .get(path.id)
            .pipe(Effect.mapError((error) => mapPersistenceError("coinbase", error)))

          if (Option.isNone(maybeState)) {
            return OAuthSessionResponse.make({
              id: path.id,
              provider: "coinbase",
              status: "expired",
              authorizationUrl: Option.none(),
              sessionToken: Option.none(),
              userId: Option.none(),
              message: Option.some("OAuth session not found or expired."),
              expiresAt: epochTimestamp.toDateTime(),
            })
          }

          const provider =
            maybeState.value.provider === "local" ? "coinbase" : maybeState.value.provider
          const currentTimestamp = yield* nowTimestamp

          return OAuthSessionResponse.make({
            id: maybeState.value.state,
            provider,
            status:
              maybeState.value.expiresAt.epochMillis <= currentTimestamp.epochMillis
                ? "expired"
                : maybeState.value.status,
            authorizationUrl: Option.some(maybeState.value.redirectUri),
            sessionToken: maybeState.value.sessionToken,
            userId: maybeState.value.userId,
            message: maybeState.value.statusMessage,
            expiresAt: maybeState.value.expiresAt.toDateTime(),
          })
        })
      )
  })
)

/**
 * CoinbaseCompatApiLive - Legacy Coinbase callback endpoint for existing OAuth clients
 */
export const CoinbaseCompatApiLive = HttpApiBuilder.group(
  TaxMaxiApi,
  "coinbaseCompat",
  (handlers) =>
    Effect.gen(function* () {
      const authService = yield* AuthService
      const oauthStateStore = yield* OAuthStateStore
      const cexAccountRepo = yield* CexAccountRepository
      const principalRepository = yield* PrincipalRepository
      const sourceRepo = yield* SourceRepository
      const frontendUrl = yield* Config.string("FRONTEND_URL").pipe(
        Config.withDefault(FRONTEND_URL_DEFAULT),
        Config.map(normalizeBaseUrl)
      )
      const environment = yield* Config.string("ENVIRONMENT").pipe(
        Config.withDefault("development")
      )
      const cookieDomain = yield* sessionCookieDomain
      const baseCookieOptions = cookieOptionsForEnv(environment, "/", cookieDomain)

      return handlers.handle("cdpCallback", (_) =>
        Effect.gen(function* () {
          const provider: AuthProviderType = "coinbase"
          const { code, state, error, error_description } = _.query
          const request = yield* HttpServerRequest.HttpServerRequest
          const redirectTo = isSafeRedirectPath(request.cookies[OAUTH_REDIRECT_COOKIE_NAME])
            ? request.cookies[OAUTH_REDIRECT_COOKIE_NAME]
            : undefined

          if (error !== undefined) {
            if (redirectTo !== undefined) {
              yield* clearOAuthRedirectCookie({
                provider,
                baseCookieOptions,
              })
            }

            const completedAt = yield* nowTimestamp

            yield* oauthStateStore
              .markFailed({
                state,
                statusMessage: error_description ?? error,
                completedAt,
              })
              .pipe(
                Effect.tapCause((cause) =>
                  logCoinbaseCallbackCause({
                    message: "Failed to mark Coinbase OAuth state as failed",
                    state,
                    step: "mark-oauth-state-failed",
                    cause,
                    attributes: {
                      redirectTo,
                    },
                  })
                ),
                Effect.mapError((storeError) => mapPersistenceError(provider, storeError))
              )

            return yield* new ProviderAuthError({
              provider,
              reason: error_description ?? error,
            })
          }

          const { user, session, providerResult } = yield* completeOAuthLoginWithErrorMapping({
            authService,
            provider,
            code,
            state,
          }).pipe(
            Effect.tapCause((cause) =>
              logCoinbaseCallbackCause({
                message: "Coinbase OAuth login completion failed",
                state,
                step: "complete-oauth-login",
                cause,
                attributes: {
                  redirectTo,
                },
              })
            )
          )

          if (Option.isNone(providerResult.oauthCredentials)) {
            return yield* new ProviderAuthError({
              provider,
              reason: "Coinbase OAuth callback did not return credential artifacts",
            })
          }

          const maybePrincipal = yield* principalRepository
            .findUserPrincipal(user.id)
            .pipe(Effect.mapError((error) => mapPersistenceError(provider, error)))

          if (Option.isNone(maybePrincipal)) {
            return yield* new ProviderAuthError({
              provider,
              reason: "Missing user principal",
            })
          }

          const principal = maybePrincipal.value

          const cexAccount = yield* cexAccountRepo
            .ensureForProviderWithOAuthCredentials({
              principalId: principal.id,
              cexName: "coinbase",
              providerUserId: providerResult.providerId,
              oauthCredentials: providerResult.oauthCredentials.value,
            })
            .pipe(
              Effect.tapCause((cause) =>
                logCoinbaseCallbackCause({
                  message: "Failed to persist Coinbase OAuth credentials",
                  state,
                  step: "ensure-cex-account",
                  cause,
                  attributes: {
                    userId: user.id,
                    providerUserId: providerResult.providerId,
                  },
                })
              ),
              Effect.mapError((error) => mapPersistenceError(provider, error))
            )

          const sourceRef = CexSourceRef.make({ cexAccountId: cexAccount.id })

          const maybeCoinbaseSource = yield* sourceRepo
            .findByPrincipalAndSourceRef({
              principalId: principal.id,
              sourceRef,
            })
            .pipe(
              Effect.tapCause((cause) =>
                logCoinbaseCallbackCause({
                  message: "Failed to load Coinbase source after OAuth callback",
                  state,
                  step: "find-source",
                  cause,
                  attributes: {
                    userId: user.id,
                    cexAccountId: cexAccount.id,
                  },
                })
              ),
              Effect.mapError((error) => mapPersistenceError(provider, error))
            )

          if (Option.isNone(maybeCoinbaseSource)) {
            yield* sourceRepo
              .create({
                id: SourceId.make(yield* randomUuid),
                principalId: principal.id,
                name: "Coinbase",
                providerKey: "coinbase",
                sourceRef,
              })
              .pipe(
                Effect.tapCause((cause) =>
                  logCoinbaseCallbackCause({
                    message: "Failed to provision Coinbase source after OAuth callback",
                    state,
                    step: "create-source",
                    cause,
                    attributes: {
                      userId: user.id,
                      cexAccountId: cexAccount.id,
                    },
                  })
                ),
                Effect.mapError((error) => mapPersistenceError(provider, error))
              )

            yield* Effect.logInfo(
              { userId: user.id, cexAccountId: cexAccount.id },
              "Provisioned Coinbase source after OAuth callback"
            )
          }

          const completedAt = yield* nowTimestamp

          yield* oauthStateStore
            .markCompleted({
              state,
              sessionToken: session.id,
              userId: user.id,
              statusMessage: Option.some("OAuth session completed successfully."),
              completedAt,
            })
            .pipe(
              Effect.tapCause((cause) =>
                logCoinbaseCallbackCause({
                  message: "Failed to mark Coinbase OAuth state as completed",
                  state,
                  step: "mark-oauth-state-completed",
                  cause,
                  attributes: {
                    userId: user.id,
                    sessionId: session.id,
                    cexAccountId: cexAccount.id,
                  },
                })
              ),
              Effect.mapError((storeError) => mapPersistenceError(provider, storeError))
            )

          yield* setSessionCookie(session.id, baseCookieOptions).pipe(
            Effect.tapCause((cause) =>
              logCoinbaseCallbackCause({
                message: "Failed to set Coinbase OAuth session cookie",
                state,
                step: "set-session-cookie",
                cause,
                attributes: {
                  userId: user.id,
                  sessionId: session.id,
                },
              })
            )
          )
          if (redirectTo !== undefined) {
            yield* clearOAuthRedirectCookie({
              provider,
              baseCookieOptions,
            }).pipe(
              Effect.tapCause((cause) =>
                logCoinbaseCallbackCause({
                  message: "Failed to clear Coinbase OAuth redirect cookie",
                  state,
                  step: "clear-redirect-cookie",
                  cause,
                  attributes: {
                    userId: user.id,
                    sessionId: session.id,
                    redirectTo,
                  },
                })
              )
            )

            return HttpServerResponse.redirect(buildFrontendRedirectUrl(frontendUrl, redirectTo))
          }

          return HttpServerResponse.html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>TaxMaxi - Connected</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: linear-gradient(to bottom, #1e4d40, #1a1f1d); color: #e6efe9; }
      .wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
      .card { width: 100%; max-width: 560px; background: rgba(10, 18, 16, 0.56); border: 1px solid rgba(163, 196, 181, 0.28); border-radius: 14px; padding: 24px; box-shadow: 0 8px 24px rgba(5, 10, 9, 0.28); backdrop-filter: blur(2px); }
      .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; font-weight: 700; letter-spacing: 0.02em; }
      .brand-mark { width: 22px; height: 22px; border-radius: 999px; background: #a3c4b5; box-shadow: inset 0 0 0 3px #1e4d40; }
      h1 { margin: 0 0 8px; font-size: 24px; color: #f5faf7; }
      p { margin: 0; line-height: 1.5; color: #c3d8cc; }
      .meta { margin-top: 12px; font-size: 13px; color: #a3c4b5; }
    </style>
  </head>
  <body>
    <main class="wrap">
      <section class="card">
        <div class="brand"><span class="brand-mark" aria-hidden="true"></span><span>TaxMaxi</span></div>
        <h1>Coinbase connected</h1>
        <p>You can now return to your terminal. TaxMaxi CLI will continue automatically.</p>
        <p class="meta">You can close this tab now.</p>
      </section>
    </main>
  </body>
</html>`)
        }).pipe(
          Effect.tapCause((cause) =>
            logCoinbaseCallbackCause({
              message: "Coinbase callback handler failed",
              state: _.query.state,
              step: "handler",
              cause,
            })
          )
        )
      )
    })
)

// =============================================================================
// Protected Auth Session API Implementation
// =============================================================================

/**
 * AuthSessionApiLive - Layer providing protected AuthSessionApi handlers
 *
 * Implements protected authentication endpoints:
 * - POST /logout - Logout and invalidate session
 * - GET /me - Get current user with identities
 * - POST /refresh - Refresh session token
 * - POST /link/:provider - Initiate provider linking
 * - GET /link/callback/:provider - Complete provider linking
 * - DELETE /identities/:identityId - Unlink provider identity
 *
 * All endpoints require authentication via AuthMiddleware.
 *
 * Dependencies:
 * - AuthService
 * - UserRepository
 * - IdentityRepository
 * - SessionContext (provided via middleware)
 */
export const AuthSessionApiLive = HttpApiBuilder.group(TaxMaxiApi, "authSession", (handlers) =>
  Effect.gen(function* () {
    const authService = yield* AuthService
    const authPublicBaseUrl = yield* Config.string("AUTH_PUBLIC_BASE_URL").pipe(
      Config.withDefault(AUTH_PUBLIC_BASE_URL_DEFAULT),
      Config.map(normalizeBaseUrl)
    )
    const userRepo = yield* UserRepository
    const identityRepo = yield* IdentityRepository
    const sessionRepo = yield* SessionRepository
    const environment = yield* Config.string("ENVIRONMENT").pipe(Config.withDefault("development"))
    const cookieDomain = yield* sessionCookieDomain
    const baseCookieOptions = cookieOptionsForEnv(environment, "/", cookieDomain)

    const internalServerResponse = (message: string) =>
      HttpServerResponse.json(
        {
          message,
        },
        {
          status: 500,
        }
      ).pipe(Effect.orDie)

    return handlers
      .handle("logout", () =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser

          // Ensure we have a session ID
          if (currentUser.sessionId === undefined) {
            return yield* new SessionInvalidError({
              message: "Session token not available",
            })
          }

          // Logout using the session ID from CurrentUser (already typed as SessionId)
          yield* authService.logout(currentUser.sessionId).pipe(
            Effect.mapError(
              () =>
                new SessionInvalidError({
                  message: "Session is invalid or already logged out",
                })
            )
          )

          // Clear the session cookie
          yield* clearSessionCookie(baseCookieOptions)

          // Return success response
          return LogoutResponse.make({ success: true })
        })
      )
      .handle("me", () =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser

          yield* Effect.annotateCurrentSpan({
            userId: currentUser.userId,
          })

          const maybeUserResult = yield* userRepo.findById(currentUser.userId).pipe(Effect.result)

          if (maybeUserResult._tag === "Failure") {
            yield* Effect.logError(
              {
                userId: currentUser.userId,
                error: maybeUserResult.failure,
              },
              "auth:failed-to-load-current-user"
            )

            return yield* internalServerResponse("Failed to load current user")
          }

          const maybeUser = maybeUserResult.success

          if (Option.isNone(maybeUser)) {
            return yield* new AuthUserNotFoundError({})
          }

          const user = maybeUser.value

          const identitiesResult = yield* identityRepo
            .findByUserId(currentUser.userId)
            .pipe(Effect.result)

          if (identitiesResult._tag === "Failure") {
            yield* Effect.logError(
              {
                userId: currentUser.userId,
                error: identitiesResult.failure,
              },
              "auth:failed-to-load-linked-identities"
            )

            return yield* internalServerResponse("Failed to load linked identities")
          }

          const identitiesChunk = identitiesResult.success

          const identities = Chunk.toReadonlyArray(identitiesChunk)
          const enabledProviders = yield* getEnabledProviderSet(authService)

          yield* Effect.logInfo(
            {
              userId: currentUser.userId,
              identityCount: identities.length,
            },
            "auth:me-succeeded"
          )

          return toAccountResponse({
            user,
            identities,
            enabledProviders,
            currentSessionProvider: currentUser.provider,
          })
        }).pipe(
          authRouteSpan({
            name: "session.me",
          })
        )
      )
      .handle("updateMe", (_) =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser
          const { displayName } = _.payload

          yield* Effect.annotateCurrentSpan({
            userId: currentUser.userId,
          })

          const maybeUserResult = yield* userRepo.findById(currentUser.userId).pipe(Effect.result)

          if (maybeUserResult._tag === "Failure") {
            yield* Effect.logError(
              {
                userId: currentUser.userId,
                error: maybeUserResult.failure,
              },
              "auth:failed-to-load-current-user"
            )

            return yield* internalServerResponse("Failed to load current user")
          }

          const maybeUser = maybeUserResult.success

          if (Option.isNone(maybeUser)) {
            return yield* new AuthUserNotFoundError({})
          }

          // Build update data - only update fields that were provided
          const updateData: { displayName?: string } = {}
          if (Option.isSome(displayName)) {
            updateData.displayName = displayName.value
          }

          // Update user if there are changes
          let updatedUser: AuthUser
          if (Object.keys(updateData).length > 0) {
            updatedUser = yield* userRepo.update(currentUser.userId, updateData).pipe(
              Effect.mapError(
                () =>
                  new AuthValidationError({
                    message: "Failed to update profile",
                    field: Option.none(),
                  })
              )
            )
          } else {
            // No changes, return current user
            updatedUser = maybeUser.value
          }

          const identitiesResult = yield* identityRepo
            .findByUserId(currentUser.userId)
            .pipe(Effect.result)

          if (identitiesResult._tag === "Failure") {
            yield* Effect.logError(
              {
                userId: currentUser.userId,
                error: identitiesResult.failure,
              },
              "auth:failed-to-load-linked-identities"
            )

            return yield* internalServerResponse("Failed to load linked identities")
          }

          const identitiesChunk = identitiesResult.success

          const identities = Chunk.toReadonlyArray(identitiesChunk)
          const enabledProviders = yield* getEnabledProviderSet(authService)

          yield* Effect.logInfo(
            {
              userId: currentUser.userId,
              updatedDisplayName: Object.keys(updateData).length > 0,
              identityCount: identities.length,
            },
            "auth:update-me-succeeded"
          )

          return toAccountResponse({
            user: updatedUser,
            identities,
            enabledProviders,
            currentSessionProvider: currentUser.provider,
          })
        }).pipe(
          authRouteSpan({
            name: "session.update-me",
          })
        )
      )
      .handle("markWelcomeSeen", () =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser

          yield* Effect.annotateCurrentSpan({
            userId: currentUser.userId,
          })

          // The writer keeps an existing stamp, so a second mark returns the first timestamp.
          const welcomeSeenAt = yield* nowTimestamp
          const updateResult = yield* userRepo
            .update(currentUser.userId, { welcomeSeenAt })
            .pipe(Effect.result)

          if (updateResult._tag === "Failure") {
            if (updateResult.failure._tag === "EntityNotFoundError") {
              return yield* new AuthUserNotFoundError({})
            }

            yield* Effect.logError(
              {
                userId: currentUser.userId,
                error: updateResult.failure,
              },
              "auth:failed-to-mark-welcome-seen"
            )

            return yield* internalServerResponse("Failed to mark the welcome as seen")
          }

          const user = updateResult.success

          const identitiesResult = yield* identityRepo
            .findByUserId(currentUser.userId)
            .pipe(Effect.result)

          if (identitiesResult._tag === "Failure") {
            yield* Effect.logError(
              {
                userId: currentUser.userId,
                error: identitiesResult.failure,
              },
              "auth:failed-to-load-linked-identities"
            )

            return yield* internalServerResponse("Failed to load linked identities")
          }

          const identities = Chunk.toReadonlyArray(identitiesResult.success)
          const enabledProviders = yield* getEnabledProviderSet(authService)

          yield* Effect.logInfo(
            {
              userId: currentUser.userId,
              welcomeSeenAt: user.welcomeSeenAt?.toISOString() ?? null,
            },
            "auth:mark-welcome-seen-succeeded"
          )

          return toAccountResponse({
            user,
            identities,
            enabledProviders,
            currentSessionProvider: currentUser.provider,
          })
        }).pipe(
          authRouteSpan({
            name: "session.mark-welcome-seen",
          })
        )
      )
      .handle("refresh", () =>
        Effect.gen(function* () {
          const currentUser = yield* CurrentUser

          yield* Effect.annotateCurrentSpan({
            userId: currentUser.userId,
          })

          // Ensure we have a session ID
          if (currentUser.sessionId === undefined) {
            return yield* new SessionInvalidError({
              message: "Session token not available",
            })
          }

          // Validate current session (sessionId is already typed as SessionId)
          yield* authService.validateSession(currentUser.sessionId).pipe(
            Effect.mapError((error) => {
              if (isSessionNotFoundError(error) || isSessionExpiredError(error)) {
                return new SessionInvalidError({
                  message: "Session is invalid or expired",
                })
              }
              return new SessionInvalidError({})
            })
          )

          // Logout old session - session cleanup is critical for security.
          // If logout fails, multiple active sessions could exist for the same user,
          // creating a session hijacking risk. Refresh should fail if we can't
          // clean up the old session.
          yield* authService.logout(currentUser.sessionId).pipe(
            Effect.mapError(
              () =>
                new SessionInvalidError({
                  message: "Failed to clean up old session during refresh",
                })
            )
          )

          // Generate new session token
          // Note: In a real implementation, this would create a new session in SessionRepository
          const sessionIdBytes = yield* randomBytes(32)
          const newSessionId = SessionId.make(
            Array.from(sessionIdBytes)
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("")
          )

          // Session duration is typically 7 days
          const currentTimestamp = yield* nowTimestamp
          const expiresAt = addDaysToTimestamp(currentTimestamp, 7).toDateTime()

          yield* Effect.logInfo(
            {
              userId: currentUser.userId,
              expiresAt: expiresAt.toString(),
            },
            "auth:refresh-succeeded"
          )

          return RefreshResponse.make({
            token: newSessionId,
            expiresAt,
          })
        }).pipe(
          authRouteSpan({
            name: "session.refresh",
          })
        )
      )
      .handle("linkProvider", (_) =>
        Effect.gen(function* () {
          const { provider } = _.params
          const currentUser = yield* CurrentUser

          // Local provider cannot be linked as an additional identity
          if (provider === "local") {
            return yield* new ProviderNotFoundError({ provider })
          }

          // Temporary compatibility mode: existing Coinbase OAuth clients are
          // limited to the legacy /cdp/callback login flow.
          if (provider === "coinbase") {
            return yield* new ProviderNotFoundError({
              provider,
              message:
                "Coinbase linking is temporarily unavailable. Only use /authorize/coinbase for now.",
            })
          }

          const linkCallbackUrl = buildOAuthCallbackUrl(
            authPublicBaseUrl,
            `/auth/link/callback/${provider}`
          )

          const { authorizationUrl, state } = yield* authService
            .startLink(currentUser.userId, provider, linkCallbackUrl)
            .pipe(Effect.mapError((error) => mapOAuthStartError({ provider, error })))

          return LinkInitiateResponse.make({
            redirectUrl: authorizationUrl,
            state,
          })
        })
      )
      .handle("linkCallback", (_) =>
        Effect.gen(function* () {
          const { provider } = _.params
          const { code, state, error, error_description } = _.query
          const currentUser = yield* CurrentUser

          if (provider === "coinbase") {
            return yield* new ProviderNotFoundError({
              provider,
              message:
                "Coinbase linking is temporarily unavailable. Only use /authorize/coinbase for now.",
            })
          }

          // Check for OAuth error
          if (error !== undefined) {
            return yield* new ProviderAuthError({
              provider,
              reason: error_description ?? error,
            })
          }

          yield* authService.completeLink(currentUser.userId, provider, code, state).pipe(
            Effect.mapError((error) => {
              if (isProviderNotEnabledError(error)) {
                return new ProviderNotFoundError({ provider })
              }
              if (isOAuthStateError(error)) {
                return new OAuthStateInvalidError({ provider })
              }
              if (isIdentityAlreadyLinkedError(error)) {
                return new IdentityLinkedError({ provider })
              }
              if (isUserNotFoundError(error)) {
                return new IdentityLinkedError({ provider })
              }
              if (isProviderAuthFailedError(error)) {
                return new ProviderAuthError({
                  provider,
                  reason: error.reason,
                })
              }
              return new ProviderAuthError({
                provider,
                reason: "Link callback failed",
              })
            })
          )

          // Return the current user with their identities (userId is already typed as AuthUserId)
          const maybeUser = yield* userRepo
            .findById(currentUser.userId)
            .pipe(Effect.mapError(() => new IdentityLinkedError({ provider })))

          if (Option.isNone(maybeUser)) {
            return yield* new IdentityLinkedError({ provider })
          }

          const user = maybeUser.value
          const identitiesChunk = yield* identityRepo
            .findByUserId(currentUser.userId)
            .pipe(Effect.mapError(() => new IdentityLinkedError({ provider })))
          const identities = Chunk.toReadonlyArray(identitiesChunk)
          const enabledProviders = yield* getEnabledProviderSet(authService)

          return toAccountResponse({
            user,
            identities,
            enabledProviders,
            currentSessionProvider: currentUser.provider,
          })
        })
      )
      .handle("unlinkIdentity", (_) =>
        Effect.gen(function* () {
          const { identityId } = _.params
          const currentUser = yield* CurrentUser

          // Get the identity to verify ownership
          const maybeIdentity = yield* identityRepo
            .findById(identityId)
            .pipe(Effect.mapError(() => new IdentityNotFoundError({ identityId })))

          if (Option.isNone(maybeIdentity)) {
            return yield* new IdentityNotFoundError({ identityId })
          }

          const identity = maybeIdentity.value

          // Verify the identity belongs to the current user (userId is already typed as AuthUserId)
          if (identity.userId !== currentUser.userId) {
            return yield* new IdentityNotFoundError({ identityId })
          }

          // Keep at least one identity that can currently authenticate the account
          const allIdentities = yield* identityRepo
            .findByUserId(currentUser.userId)
            .pipe(Effect.mapError(() => new CannotUnlinkLastIdentityError({})))
          const maybeUser = yield* userRepo
            .findById(currentUser.userId)
            .pipe(Effect.mapError(() => new CannotUnlinkLastIdentityError({})))

          if (Option.isNone(maybeUser)) {
            return yield* new CannotUnlinkLastIdentityError({})
          }

          const enabledProviders = yield* getEnabledProviderSet(authService)
          const hasOtherAvailableIdentity = hasAvailableIdentityOtherThan({
            user: maybeUser.value,
            identities: allIdentities,
            enabledProviders,
            identityId: identity.id,
          })

          if (!hasOtherAvailableIdentity) {
            return yield* new CannotUnlinkLastIdentityError({})
          }

          // Delete the identity
          yield* identityRepo
            .delete(identityId)
            .pipe(Effect.mapError(() => new IdentityNotFoundError({ identityId })))
        })
      )
      .handle("changePassword", (_) =>
        Effect.gen(function* () {
          const { currentPassword, newPassword } = _.payload
          const currentUser = yield* CurrentUser
          const passwordHasher = yield* PasswordHasher

          // Get the user to find their email (userId is already typed as AuthUserId)
          const maybeUser = yield* userRepo
            .findById(currentUser.userId)
            .pipe(Effect.mapError(() => new NoLocalIdentityError({})))

          if (Option.isNone(maybeUser)) {
            return yield* new NoLocalIdentityError({})
          }

          const user = maybeUser.value

          // Check if user has a local identity
          const providerId = ProviderId.make(user.email)
          const maybeLocalIdentity = yield* identityRepo
            .findByUserAndProvider(currentUser.userId, "local")
            .pipe(Effect.mapError(() => new NoLocalIdentityError({})))

          if (Option.isNone(maybeLocalIdentity)) {
            return yield* new NoLocalIdentityError({})
          }

          // Get the current password hash to verify
          const maybeHash = yield* identityRepo
            .getPasswordHash("local", providerId)
            .pipe(Effect.mapError(() => new NoLocalIdentityError({})))

          if (Option.isNone(maybeHash)) {
            return yield* new NoLocalIdentityError({})
          }

          // Verify current password
          const isValid = yield* passwordHasher.verify(
            Redacted.make(currentPassword),
            maybeHash.value
          )

          if (!isValid) {
            return yield* new ChangePasswordError({})
          }

          // Validate new password strength (minimum 8 characters from Schema)
          if (newPassword.length < 8) {
            return yield* new PasswordWeakError({
              requirements: ["Password must be at least 8 characters"],
            })
          }

          // Hash the new password
          const newHash = yield* passwordHasher.hash(Redacted.make(newPassword))

          // Update the password hash
          yield* identityRepo
            .updatePasswordHash("local", providerId, newHash)
            .pipe(Effect.mapError(() => new NoLocalIdentityError({})))

          // SECURITY: Invalidate all sessions after password change
          // This ensures the user must re-login with the new password
          yield* sessionRepo.deleteByUserId(currentUser.userId).pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                {
                  userId: currentUser.userId,
                  error,
                },
                "auth:session-cleanup-skipped-after-password-change"
              ).pipe(Effect.as(0))
            )
          )
        })
      )
  })
)

// =============================================================================
// Session-Based Token Validator
// =============================================================================

/**
 * SessionTokenValidatorLive - Token validator that uses AuthService.validateSession
 *
 * Validates bearer tokens by looking them up as session IDs in the database.
 * Also provides SessionContext to downstream handlers.
 *
 * Dependencies:
 * - AuthService
 */
export const SessionTokenValidatorLive: Layer.Layer<TokenValidator, never, AuthService> =
  Layer.effect(
    TokenValidator,
    Effect.gen(function* () {
      const authService = yield* AuthService

      return {
        validate: (token) =>
          Effect.gen(function* () {
            const tokenValue = Redacted.value(token)

            // Check for valid token
            if (!tokenValue || tokenValue.trim() === "") {
              return yield* new UnauthorizedError({ message: "Bearer token is required" })
            }

            // Parse and validate SessionId format
            const sessionId = yield* Schema.decodeEffect(SessionId)(tokenValue).pipe(
              Effect.mapError(
                () => new UnauthorizedError({ message: "Invalid session token format" })
              )
            )

            // Validate session with AuthService
            const { session, user } = yield* authService.validateSession(sessionId).pipe(
              Effect.mapError((error) => {
                if (isSessionNotFoundError(error)) {
                  return new UnauthorizedError({ message: "Invalid session token" })
                }
                if (isSessionExpiredError(error)) {
                  return new UnauthorizedError({ message: "Session has expired" })
                }
                return new UnauthorizedError({ message: "Authentication failed" })
              })
            )

            // Map to API User type
            const apiRole = mapUserRoleToApiRole(user.role)

            return User.make({
              userId: user.id,
              role: apiRole,
              provider: session.provider,
              sessionId, // Include the session ID for logout/refresh
            })
          }),
      } satisfies TokenValidatorService
    })
  )

/**
 * makeSessionTokenValidator - Factory function for creating a token validator
 *
 * This is useful when you need to create the validator outside of the Layer system.
 */
export const makeSessionTokenValidator = (
  authService: AuthServiceShape
): TokenValidatorService => ({
  validate: (token: Redacted.Redacted<string>): Effect.Effect<User, UnauthorizedError> =>
    Effect.gen(function* () {
      const tokenValue = Redacted.value(token)

      if (!tokenValue || tokenValue.trim() === "") {
        return yield* new UnauthorizedError({ message: "Bearer token is required" })
      }

      const sessionId = yield* Schema.decodeEffect(SessionId)(tokenValue).pipe(
        Effect.mapError(() => new UnauthorizedError({ message: "Invalid session token format" }))
      )

      const { session, user } = yield* authService.validateSession(sessionId).pipe(
        Effect.mapError((error) => {
          if (isSessionNotFoundError(error)) {
            return new UnauthorizedError({ message: "Invalid session token" })
          }
          if (isSessionExpiredError(error)) {
            return new UnauthorizedError({ message: "Session has expired" })
          }
          return new UnauthorizedError({ message: "Authentication failed" })
        })
      )

      const apiRole = mapUserRoleToApiRole(user.role)

      return User.make({
        userId: user.id,
        role: apiRole,
        provider: session.provider,
        sessionId, // Include session ID for logout/refresh
      })
    }),
})
