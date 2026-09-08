/**
 * AuthServiceLive - PostgreSQL implementation of AuthService
 *
 * Implements the AuthService interface from core, orchestrating authentication
 * across multiple providers. Handles user provisioning, identity linking,
 * and session management.
 *
 * Features:
 * - Routes authentication requests to appropriate provider by type
 * - Auto-provisions users for external provider authentication
 * - Links identities to existing users by email (configurable)
 * - Stores account emails, local provider IDs, and verification requests
 *   trimmed and lowercased, and looks local logins up the same way
 * - Creates and manages sessions via SessionRepository
 * - Configurable session duration per provider
 *
 * @module AuthServiceLive
 */

import * as Chunk from "effect/Chunk"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import {
  AuthService,
  AuthUserId,
  EmailVerificationCode,
  EmailVerificationRequestId,
  LocalAuthRequest,
  PasswordHasher,
  sanitizeEmail,
  inferDisplayNameFromEmail,
  isEmailVerificationRequestExpired,
  isLocalAuthRequest,
  type AuthProvider,
  type AuthProviderRegistry,
  type AuthRequest,
  type AuthServiceShape,
  type EmailVerificationRequest,
  type LocalAuthConfig,
  type LoginSuccess,
  type ValidatedSession,
  type AuthProviderType,
  type AuthResult,
  type AuthUser,
  type UserIdentity,
  SessionTokenGenerator,
  ProviderId,
  UserIdentityId,
} from "@my/core/authentication"

import * as Timestamp from "@my/core/shared/values/Timestamp"
import {
  AuthProcessingError,
  EmailVerificationCodeMismatchError,
  EmailVerificationRequestExpiredError,
  EmailVerificationRequestNotFoundError,
  ProviderNotEnabledError,
  ProviderAuthFailedError,
  UserNotFoundError,
  UserAlreadyExistsError,
  IdentityAlreadyLinkedError,
  SessionNotFoundError,
  SessionExpiredError,
  PasswordTooWeakError,
  type PasswordRequirement,
  SessionCleanupError,
  OAuthStateError,
  UnverifiedEmailError,
} from "@my/core/authentication/errors"
import { isPersistenceError } from "../errors/RepositoryError.ts"
import { UserRepository } from "../services/UserRepository.ts"
import { EmailVerificationDeliveryService } from "../services/EmailVerificationDeliveryService.ts"
import { EmailVerificationRequestRepository } from "../services/EmailVerificationRequestRepository.ts"
import { IdentityRepository } from "../services/IdentityRepository.ts"
import { SessionRepository } from "../services/SessionRepository.ts"
import { OAuthStateStore } from "../services/OAuthStateStore.ts"
import { AuthServiceConfig } from "../services/AuthServiceConfig.ts"
import { PrincipalRepository } from "../services/PrincipalRepository.ts"

const OAUTH_STATE_TTL_MILLIS = 10 * 60 * 1000
const EMAIL_VERIFICATION_TTL_MILLIS = 10 * 60 * 1000
const EMAIL_VERIFICATION_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

/**
 * Build a provider registry from the providers chunk
 */
const buildProviderRegistry = (providers: Chunk.Chunk<AuthProvider>): AuthProviderRegistry => {
  const entries = Chunk.toReadonlyArray(providers).map((p): [AuthProviderType, AuthProvider] => [
    p.type,
    p,
  ])
  return new Map(entries)
}

const hasUniqueConstraint = (error: unknown, constraintName: string): boolean => {
  if (!isPersistenceError(error)) {
    return false
  }

  const cause = String(error.cause)
  return cause.includes(constraintName)
}

const generateEmailVerificationCode = (bytes: Uint8Array): EmailVerificationCode => {
  const code = Array.from(
    bytes,
    (byte) => EMAIL_VERIFICATION_CODE_ALPHABET[byte % EMAIL_VERIFICATION_CODE_ALPHABET.length]
  ).join("")

  return EmailVerificationCode.make(code)
}

/**
 * Password validation. Returns the codes of the rules the password did not
 * meet, in rule order; empty when the password passes.
 */
const validatePassword = (
  password: string,
  localAuthConfig: LocalAuthConfig
): Chunk.Chunk<PasswordRequirement> => {
  const unmet: PasswordRequirement[] = []

  if (password.length < localAuthConfig.minPasswordLength) {
    unmet.push("min_length")
  }
  if (!/[a-z]/.test(password)) {
    unmet.push("lowercase")
  }
  if (localAuthConfig.requireUppercase && !/[A-Z]/.test(password)) {
    unmet.push("uppercase")
  }
  if (localAuthConfig.requireNumbers && !/[0-9]/.test(password)) {
    unmet.push("number")
  }
  if (localAuthConfig.requireSpecialChars && !/[^A-Za-z0-9]/.test(password)) {
    unmet.push("special_char")
  }

  return Chunk.fromIterable(unmet)
}

/**
 * Creates the AuthService implementation
 */
const make = Effect.gen(function* () {
  // Get dependencies
  const config = yield* AuthServiceConfig
  const userRepo = yield* UserRepository
  const emailVerificationDelivery = yield* EmailVerificationDeliveryService
  const emailVerificationRequestRepo = yield* EmailVerificationRequestRepository
  const identityRepo = yield* IdentityRepository
  const sessionRepo = yield* SessionRepository
  const oauthStateStore = yield* OAuthStateStore
  const principalRepository = yield* PrincipalRepository
  const tokenGenerator = yield* SessionTokenGenerator
  const passwordHasher = yield* PasswordHasher
  const crypto = yield* Crypto.Crypto

  // Build provider registry
  const providerRegistry = buildProviderRegistry(config.providers)
  const registeredProviders = Chunk.toReadonlyArray(config.providers).map(
    (provider) => provider.type
  )
  yield* Effect.logInfo(
    {
      registeredProviders,
    },
    "Auth provider registry initialized"
  )

  /**
   * Get a provider by type, failing if not enabled
   */
  const getProvider = (
    providerType: AuthProviderType
  ): Effect.Effect<AuthProvider, ProviderNotEnabledError> => {
    const provider = providerRegistry.get(providerType)
    if (provider === undefined) {
      return Effect.fail(new ProviderNotEnabledError({ provider: providerType }))
    }
    return Effect.succeed(provider)
  }

  /**
   * Create a new session for a user
   */
  const createSession = (
    userId: AuthUserId,
    provider: AuthProviderType,
    userAgent: Option.Option<string>
  ) =>
    Effect.gen(function* () {
      const sessionId = yield* tokenGenerator.generate
      const now = Timestamp.now()
      const duration = config.sessionDurations.getForProvider(provider)
      const expiresAt = Timestamp.addMillis(now, duration)

      const session = yield* sessionRepo
        .create({
          id: sessionId,
          userId,
          provider,
          expiresAt,
          userAgent: Option.map(userAgent, (ua) => ua.slice(0, 1024)),
        })
        .pipe(
          Effect.tapError((cause) =>
            Effect.logError(
              {
                cause,
                userId,
              },
              "Auth session persistence failed"
            )
          ),
          Effect.mapError(
            () =>
              new ProviderAuthFailedError({
                provider,
                reason: "Failed to create session",
              })
          )
        )

      yield* Effect.logInfo(
        {
          provider,
          userId,
          expiresAt: expiresAt.toDateTime().toString(),
        },
        "Auth session created"
      )

      return session
    })

  /**
   * Find or create a user based on authentication result
   *
   * If linkIdentitiesByEmail is enabled and a user with the same email exists,
   * returns that user. Otherwise creates a new user if autoProvisionUsers is enabled.
   */
  const findOrCreateUser = (
    authResult: AuthResult
  ): Effect.Effect<AuthUser, UserNotFoundError | ProviderAuthFailedError> =>
    Effect.gen(function* () {
      // First, check if identity already exists
      const existingIdentity = yield* identityRepo
        .findByProvider(authResult.provider, authResult.providerId)
        .pipe(
          Effect.mapError(
            () =>
              new ProviderAuthFailedError({
                provider: authResult.provider,
                reason: "Database error during identity lookup",
              })
          )
        )

      // If identity exists, return the associated user
      if (Option.isSome(existingIdentity)) {
        const identity = existingIdentity.value
        const maybeUser = yield* userRepo.findById(identity.userId).pipe(
          Effect.mapError(
            () =>
              new ProviderAuthFailedError({
                provider: authResult.provider,
                reason: "Database error during user lookup",
              })
          )
        )

        if (Option.isNone(maybeUser)) {
          return yield* new ProviderAuthFailedError({
            provider: authResult.provider,
            reason: "User not found for existing identity",
          })
        }

        yield* identityRepo.update(identity.id, { providerData: authResult.providerData }).pipe(
          Effect.mapError(
            () =>
              new ProviderAuthFailedError({
                provider: authResult.provider,
                reason: "Failed to refresh identity provider data",
              })
          )
        )

        return maybeUser.value
      }

      // Identity doesn't exist - try to link by email or create new user
      if (config.linkIdentitiesByEmail) {
        const maybeUserByEmail = yield* userRepo.findByEmail(authResult.email).pipe(
          Effect.mapError(
            () =>
              new ProviderAuthFailedError({
                provider: authResult.provider,
                reason: "Database error during email lookup",
              })
          )
        )

        if (Option.isSome(maybeUserByEmail)) {
          const existingUser = maybeUserByEmail.value

          // Link the identity to the existing user
          yield* createIdentityForUser(existingUser.id, authResult)

          return existingUser
        }
      }

      // No existing user found - create a new one if auto-provisioning is enabled
      if (!config.autoProvisionUsers) {
        return yield* new UserNotFoundError({ email: authResult.email })
      }

      // Create new user and identity
      const newUser = yield* createUserWithIdentity(authResult)
      return newUser
    })

  /**
   * Create a new identity for an existing user
   */
  const createIdentityForUser = (
    userId: AuthUserId,
    authResult: AuthResult
  ): Effect.Effect<UserIdentity, ProviderAuthFailedError> =>
    Effect.gen(function* () {
      const existingIdentityForUserProvider = yield* identityRepo
        .findByUserAndProvider(userId, authResult.provider)
        .pipe(
          Effect.mapError(
            () =>
              new ProviderAuthFailedError({
                provider: authResult.provider,
                reason: "Database error during identity lookup",
              })
          )
        )

      if (Option.isSome(existingIdentityForUserProvider)) {
        const existingIdentity = existingIdentityForUserProvider.value
        if (existingIdentity.providerId === authResult.providerId) {
          return yield* identityRepo
            .update(existingIdentity.id, { providerData: authResult.providerData })
            .pipe(
              Effect.mapError(
                () =>
                  new ProviderAuthFailedError({
                    provider: authResult.provider,
                    reason: "Failed to refresh identity provider data",
                  })
              )
            )
        }

        return yield* new ProviderAuthFailedError({
          provider: authResult.provider,
          reason: `A ${authResult.provider} identity is already linked to this account`,
        })
      }

      const existingIdentityForProviderId = yield* identityRepo
        .findByProvider(authResult.provider, authResult.providerId)
        .pipe(
          Effect.mapError(
            () =>
              new ProviderAuthFailedError({
                provider: authResult.provider,
                reason: "Database error during identity lookup",
              })
          )
        )

      if (Option.isSome(existingIdentityForProviderId)) {
        const existingIdentity = existingIdentityForProviderId.value
        if (existingIdentity.userId === userId) {
          return yield* identityRepo
            .update(existingIdentity.id, { providerData: authResult.providerData })
            .pipe(
              Effect.mapError(
                () =>
                  new ProviderAuthFailedError({
                    provider: authResult.provider,
                    reason: "Failed to refresh identity provider data",
                  })
              )
            )
        }

        return yield* new ProviderAuthFailedError({
          provider: authResult.provider,
          reason: "This provider identity is already linked to another account",
        })
      }

      const identityId = UserIdentityId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie))

      const identity = yield* identityRepo
        .create({
          id: identityId,
          userId,
          provider: authResult.provider,
          providerId: authResult.providerId,
          providerData: authResult.providerData,
        })
        .pipe(
          Effect.mapError((error) => {
            if (hasUniqueConstraint(error, "auth_identities_user_provider_uidx")) {
              return new ProviderAuthFailedError({
                provider: authResult.provider,
                reason: `A ${authResult.provider} identity is already linked to this account`,
              })
            }

            if (hasUniqueConstraint(error, "auth_identities_provider_provider_id_uidx")) {
              return new ProviderAuthFailedError({
                provider: authResult.provider,
                reason: "This provider identity is already linked to another account",
              })
            }

            return new ProviderAuthFailedError({
              provider: authResult.provider,
              reason: "Failed to create identity",
            })
          })
        )

      return identity
    })

  /**
   * Create a new user with an identity from auth result
   */
  const createUserWithIdentity = (
    authResult: AuthResult
  ): Effect.Effect<AuthUser, ProviderAuthFailedError> =>
    Effect.gen(function* () {
      const userId = AuthUserId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie))

      // Create the user. The account email is the provider-reported email,
      // trimmed and lowercased; the provider payload stays as reported.
      yield* userRepo
        .create({
          id: userId,
          email: sanitizeEmail(authResult.email),
          displayName: authResult.displayName,
          role: "member",
          primaryProvider: authResult.provider,
          emailVerified: authResult.emailVerified,
        })
        .pipe(
          Effect.mapError(
            () =>
              new ProviderAuthFailedError({
                provider: authResult.provider,
                reason: "Failed to create user",
              })
          )
        )

      yield* principalRepository.createUserPrincipal(userId).pipe(
        Effect.mapError(
          () =>
            new ProviderAuthFailedError({
              provider: authResult.provider,
              reason: "Failed to create user principal",
            })
        )
      )

      // Create the identity
      yield* createIdentityForUser(userId, authResult)

      const maybeCreatedUser = yield* userRepo.findById(userId).pipe(
        Effect.mapError(
          () =>
            new ProviderAuthFailedError({
              provider: authResult.provider,
              reason: "Failed to load user after identity creation",
            })
        )
      )

      if (Option.isNone(maybeCreatedUser)) {
        return yield* new ProviderAuthFailedError({
          provider: authResult.provider,
          reason: "User not found after identity creation",
        })
      }

      return maybeCreatedUser.value
    })

  /**
   * Generate URL-safe OAuth state token for CSRF protection
   */
  const generateOAuthState: Effect.Effect<string> = crypto.randomBytes(32).pipe(
    Effect.orDie,
    Effect.map((stateBytes) =>
      btoa(String.fromCharCode(...stateBytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "")
    )
  )

  /**
   * Extract redirect URI from provider authorization URL
   *
   * Redirect URI is persisted alongside state and reused during callback to
   * guarantee token exchange uses the same URI as authorization.
   */
  const extractRedirectUri = (
    provider: AuthProviderType,
    authorizationUrl: string
  ): Effect.Effect<string, ProviderAuthFailedError> =>
    Effect.try({
      try: () => new URL(authorizationUrl),
      catch: () =>
        new ProviderAuthFailedError({
          provider,
          reason: "Provider authorization URL is invalid",
        }),
    }).pipe(
      Effect.flatMap((url) => {
        const redirectUri = url.searchParams.get("redirect_uri")
        if (redirectUri === null || redirectUri.trim() === "") {
          return Effect.fail(
            new ProviderAuthFailedError({
              provider,
              reason: "Provider authorization URL is invalid (missing redirect_uri)",
            })
          )
        }

        return Effect.succeed(redirectUri)
      })
    )

  /**
   * Shared implementation for initiating OAuth login/link flows
   */
  const startOAuthFlow = (
    intent: "login" | "link",
    userId: Option.Option<AuthUserId>,
    providerType: AuthProviderType,
    redirectUri?: string
  ) =>
    Effect.gen(function* () {
      yield* Effect.logInfo(
        {
          hasUserId: Option.isSome(userId),
          redirectUri,
        },
        "OAuth flow start requested"
      )

      const provider = yield* getProvider(providerType)
      const state = yield* generateOAuthState
      const authorizationUrlOption = provider.getAuthorizationUrl(state, redirectUri)

      if (Option.isNone(authorizationUrlOption)) {
        return yield* new ProviderAuthFailedError({
          provider: providerType,
          reason: "Provider does not support OAuth authorization flow",
        })
      }

      const authorizationUrl = authorizationUrlOption.value
      const resolvedRedirectUri = yield* extractRedirectUri(providerType, authorizationUrl)
      const expiresAt = Timestamp.addMillis(Timestamp.now(), OAUTH_STATE_TTL_MILLIS)

      yield* Effect.logInfo(
        {
          resolvedRedirectUri,
          expiresAt: expiresAt.toDateTime().toString(),
        },
        "OAuth authorization URL created"
      )

      yield* oauthStateStore
        .create({
          state,
          intent,
          provider: providerType,
          userId,
          redirectUri: resolvedRedirectUri,
          expiresAt,
          status: "pending",
          sessionToken: Option.none(),
          statusMessage: Option.none(),
          completedAt: Option.none(),
          consumedAt: Option.none(),
        })
        .pipe(
          Effect.tapError((cause) =>
            Effect.logError(
              {
                cause,
                resolvedRedirectUri,
              },
              "OAuth state persistence failed"
            )
          ),
          Effect.mapError(
            () =>
              new ProviderAuthFailedError({
                provider: providerType,
                reason: "Failed to persist OAuth state",
              })
          )
        )

      yield* Effect.logInfo(
        {
          resolvedRedirectUri,
        },
        "OAuth state persisted"
      )

      return {
        authorizationUrl,
        state,
      } as const
    }).pipe(
      Effect.annotateLogs({
        authFlow: "oauth-start",
        intent,
        provider: providerType,
      })
    )

  /**
   * Consume and validate persisted OAuth state for a specific intent
   */
  const consumeOAuthStateForIntent = (
    providerType: AuthProviderType,
    state: string,
    intent: "login" | "link",
    expectedUserId: Option.Option<AuthUserId>
  ): Effect.Effect<
    {
      readonly redirectUri: string
    },
    OAuthStateError | ProviderAuthFailedError
  > =>
    Effect.gen(function* () {
      const maybeStoredState = yield* oauthStateStore.consume(state).pipe(
        Effect.tapError((cause) =>
          Effect.logError(
            {
              cause,
            },
            "OAuth state load failed"
          )
        ),
        Effect.mapError(
          () =>
            new ProviderAuthFailedError({
              provider: providerType,
              reason: "Failed to load OAuth state",
            })
        )
      )

      if (Option.isNone(maybeStoredState)) {
        yield* Effect.logError(
          {
            hasState: state.length > 0,
          },
          "OAuth state missing or expired"
        )

        return yield* new OAuthStateError({
          provider: providerType,
          reason: "State token not found or expired",
        })
      }

      const storedState = maybeStoredState.value
      if (storedState.provider !== providerType || storedState.intent !== intent) {
        yield* Effect.logError(
          {
            expectedProvider: providerType,
            storedProvider: storedState.provider,
            expectedIntent: intent,
            storedIntent: storedState.intent,
          },
          "OAuth state does not match callback"
        )

        return yield* new OAuthStateError({
          provider: providerType,
          reason: "State token does not match callback provider or intent",
        })
      }

      if (intent === "link") {
        if (Option.isNone(expectedUserId) || Option.isNone(storedState.userId)) {
          return yield* new OAuthStateError({
            provider: providerType,
            reason: "Link state is missing required user binding",
          })
        }

        if (storedState.userId.value !== expectedUserId.value) {
          return yield* new OAuthStateError({
            provider: providerType,
            reason: "Link state does not belong to the authenticated user",
          })
        }
      }

      return { redirectUri: storedState.redirectUri } as const
    }).pipe(
      Effect.annotateLogs({
        authFlow: "oauth-state-consume",
        intent,
        provider: providerType,
      })
    )

  const authProcessingError = (operation: string, cause: unknown) =>
    new AuthProcessingError({
      operation,
      cause,
    })

  /**
   * Write a fresh verification request and record its send facts. The caller
   * states `sendCount`: 1 for a first request, the replaced request's count
   * plus one for a resend. `lastSentAt` is now, because the caller hands the
   * code to delivery right after this returns.
   */
  const createEmailVerificationRequest = ({
    userId,
    email,
    sendCount,
  }: {
    readonly userId: AuthUserId
    readonly email: AuthUser["email"]
    readonly sendCount: EmailVerificationRequest["sendCount"]
  }): Effect.Effect<EmailVerificationRequest, AuthProcessingError> =>
    Effect.gen(function* () {
      const now = Timestamp.now()
      const requestId = EmailVerificationRequestId.make(
        yield* crypto.randomUUIDv4.pipe(Effect.orDie)
      )
      const verificationCodeBytes = yield* crypto.randomBytes(8).pipe(Effect.orDie)

      return yield* emailVerificationRequestRepo
        .create({
          id: requestId,
          userId,
          email: sanitizeEmail(email),
          code: generateEmailVerificationCode(verificationCodeBytes),
          expiresAt: Timestamp.addMillis(now, EMAIL_VERIFICATION_TTL_MILLIS),
          sendCount,
          lastSentAt: now,
        })
        .pipe(Effect.mapError((cause) => authProcessingError("create-email-verification", cause)))
    })

  const sendEmailVerificationRequest = ({
    request,
    operation,
  }: {
    readonly request: EmailVerificationRequest
    readonly operation: string
  }) =>
    emailVerificationDelivery
      .sendVerificationCode({
        email: request.email,
        code: request.code,
      })
      .pipe(Effect.mapError((cause) => authProcessingError(operation, cause)))

  /**
   * Rewrite a local login request so the provider looks the identity up by the
   * sanitized email. Other request kinds pass through unchanged.
   */
  const sanitizeLocalAuthRequest = (request: AuthRequest): AuthRequest =>
    isLocalAuthRequest(request)
      ? LocalAuthRequest.make({
          email: sanitizeEmail(request.email),
          password: request.password,
        })
      : request

  const consumeEmailVerificationRequestIfPresent = ({
    requestId,
    operation,
  }: {
    readonly requestId: EmailVerificationRequestId
    readonly operation: string
  }) =>
    emailVerificationRequestRepo.consume(requestId).pipe(
      // Verification cleanup should not block the user-facing flow after the
      // request has already been expired or completed, so failures are logged
      // and treated as best-effort cleanup.
      Effect.catch((cause) =>
        Effect.logError(
          {
            requestId,
            cause,
            operation,
          },
          "Failed to consume email verification request"
        )
      ),
      Effect.asVoid
    )

  /**
   * AuthService implementation
   */
  const service: AuthServiceShape = {
    /**
     * Login with the specified provider
     */
    login: (providerType, request) =>
      Effect.gen(function* () {
        // Get the provider
        const provider = yield* getProvider(providerType)

        // Authenticate with the provider. A local login is looked up by the
        // sanitized email, so the typed casing never matters.
        const authResult = yield* provider.authenticate(sanitizeLocalAuthRequest(request))

        if (providerType === "local" && !authResult.emailVerified) {
          return yield* new UnverifiedEmailError({ email: authResult.email })
        }

        // Find or create the user
        const user = yield* findOrCreateUser(authResult)

        // Create a session
        const session = yield* createSession(user.id, providerType, Option.none())

        return { user, session } satisfies LoginSuccess
      }),

    /**
     * Register a new user with local credentials
     */
    register: (submittedEmail, password, providedDisplayName) =>
      Effect.gen(function* () {
        // The account email, the local provider ID, and the conflict check all
        // use what was typed, trimmed and lowercased.
        const email = sanitizeEmail(submittedEmail)

        // Validate password strength
        const unmetRequirements = validatePassword(password, config.localAuth)
        if (!Chunk.isEmpty(unmetRequirements)) {
          return yield* new PasswordTooWeakError({
            requirements: unmetRequirements,
            minPasswordLength: config.localAuth.minPasswordLength,
          })
        }

        // Check if user already exists
        const existingUser = yield* userRepo
          .findByEmail(email)
          .pipe(Effect.mapError(() => new UserAlreadyExistsError({ email })))

        if (Option.isSome(existingUser)) {
          return yield* new UserAlreadyExistsError({ email })
        }

        // Hash the password
        const hashedPassword = yield* passwordHasher.hash(Redacted.make(password))

        // Create user. The fallback display name keeps its existing default:
        // it comes from the email as typed, so the casing stays as submitted.
        const userId = AuthUserId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie))
        const displayName = providedDisplayName ?? inferDisplayNameFromEmail(submittedEmail)

        const user = yield* userRepo
          .create({
            id: userId,
            email,
            displayName,
            role: "member",
            primaryProvider: "local",
            emailVerified: false,
          })
          .pipe(Effect.mapError(() => new UserAlreadyExistsError({ email })))

        yield* principalRepository
          .createUserPrincipal(userId)
          .pipe(Effect.mapError(() => new UserAlreadyExistsError({ email })))

        // Create local identity with password hash
        const identityId = UserIdentityId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie))
        const providerId = ProviderId.make(email)

        yield* identityRepo
          .create({
            id: identityId,
            userId,
            provider: "local",
            providerId,
            providerData: Option.none(),
            passwordHash: hashedPassword,
          })
          .pipe(Effect.mapError(() => new UserAlreadyExistsError({ email })))

        return user
      }),

    /**
     * Start or reuse an email verification flow for a local user
     */
    startEmailVerification: (user) =>
      Effect.gen(function* () {
        const maybeExistingRequest = yield* emailVerificationRequestRepo
          .findByUserId(user.id)
          .pipe(Effect.mapError((cause) => authProcessingError("find-email-verification", cause)))

        const verificationRequest = yield* Option.isSome(maybeExistingRequest) &&
        !isEmailVerificationRequestExpired({
          request: maybeExistingRequest.value,
          now: Timestamp.now(),
        })
          ? Effect.succeed(maybeExistingRequest.value)
          : createEmailVerificationRequest({
              userId: user.id,
              email: user.email,
              sendCount: 1,
            })

        yield* sendEmailVerificationRequest({
          request: verificationRequest,
          operation: "send-email-verification",
        })

        return verificationRequest
      }),

    /**
     * Replace the pending email verification flow with a fresh code
     */
    resendEmailVerification: (requestId) =>
      Effect.gen(function* () {
        const maybeExistingRequest = yield* emailVerificationRequestRepo
          .findById(requestId)
          .pipe(Effect.mapError((cause) => authProcessingError("find-email-verification", cause)))

        if (Option.isNone(maybeExistingRequest)) {
          return yield* new EmailVerificationRequestNotFoundError({ requestId })
        }

        const verificationRequest = yield* createEmailVerificationRequest({
          userId: maybeExistingRequest.value.userId,
          email: maybeExistingRequest.value.email,
          sendCount: maybeExistingRequest.value.sendCount + 1,
        })

        yield* sendEmailVerificationRequest({
          request: verificationRequest,
          operation: "resend-email-verification",
        })

        return verificationRequest
      }),

    /**
     * Complete email verification and create the first authenticated session
     */
    verifyEmail: (requestId, code) =>
      Effect.gen(function* () {
        const maybeRequest = yield* emailVerificationRequestRepo
          .findById(requestId)
          .pipe(Effect.mapError((cause) => authProcessingError("find-email-verification", cause)))

        if (Option.isNone(maybeRequest)) {
          return yield* new EmailVerificationRequestNotFoundError({ requestId })
        }

        const request = maybeRequest.value

        if (
          isEmailVerificationRequestExpired({
            request,
            now: Timestamp.now(),
          })
        ) {
          yield* consumeEmailVerificationRequestIfPresent({
            requestId,
            operation: "auth:consume-expired-email-verification-request-failed",
          })

          return yield* new EmailVerificationRequestExpiredError({ requestId })
        }

        if (request.code !== code) {
          return yield* new EmailVerificationCodeMismatchError({ requestId })
        }

        const maybeUser = yield* userRepo
          .findById(request.userId)
          .pipe(
            Effect.mapError((cause) => authProcessingError("find-user-for-verification", cause))
          )

        if (Option.isNone(maybeUser)) {
          return yield* new UserNotFoundError({ email: request.email })
        }

        const user = yield* userRepo.update(request.userId, { emailVerified: true }).pipe(
          Effect.mapError((cause) => {
            if (cause._tag === "EntityNotFoundError") {
              return new UserNotFoundError({ email: request.email })
            }

            return authProcessingError("mark-email-verified", cause)
          })
        )

        const session = yield* createSession(user.id, "local", Option.none()).pipe(
          Effect.mapError((cause) =>
            authProcessingError("create-session-after-email-verification", cause)
          )
        )

        yield* consumeEmailVerificationRequestIfPresent({
          requestId,
          operation: "auth:consume-email-verification-request-failed",
        })

        return { user, session } satisfies LoginSuccess
      }),

    /**
     * Start OAuth login flow
     */
    startOAuthLogin: (providerType, redirectUri) =>
      startOAuthFlow("login", Option.none(), providerType, redirectUri),

    /**
     * Complete OAuth login callback and create session
     */
    completeOAuthLogin: (providerType, code, state) =>
      Effect.gen(function* () {
        yield* Effect.logInfo(
          {
            hasCode: code.length > 0,
            hasState: state.length > 0,
          },
          "OAuth login callback received"
        )

        const { redirectUri } = yield* consumeOAuthStateForIntent(
          providerType,
          state,
          "login",
          Option.none()
        )

        const provider = yield* getProvider(providerType)

        yield* Effect.logInfo(
          {
            redirectUri,
          },
          "OAuth callback state validated"
        )

        const authResult = yield* provider.handleCallback(code, redirectUri).pipe(
          Effect.tapError((cause) =>
            Effect.logError(
              {
                cause,
                redirectUri,
              },
              "OAuth provider callback failed"
            )
          )
        )

        yield* Effect.logInfo(
          {
            providerUserId: authResult.providerId,
            emailVerified: authResult.emailVerified,
          },
          "OAuth provider callback handled"
        )

        // Find or create the user
        const user = yield* findOrCreateUser(authResult).pipe(
          Effect.mapError((err) => {
            if (err._tag === "UserNotFoundError") {
              return new ProviderAuthFailedError({
                provider: providerType,
                reason: "User not found and auto-provisioning is disabled",
              })
            }
            return err
          })
        )

        // Create a session
        const session = yield* createSession(user.id, providerType, Option.none())
        yield* Effect.logInfo(
          {
            userId: user.id,
          },
          "OAuth login completed"
        )

        return { user, session, providerResult: authResult }
      }).pipe(
        Effect.annotateLogs({
          authFlow: "oauth-login-callback",
          provider: providerType,
        })
      ),

    /**
     * Start OAuth identity linking flow for an authenticated user
     */
    startLink: (userId, providerType, redirectUri) =>
      startOAuthFlow("link", Option.some(userId), providerType, redirectUri),

    /**
     * Complete OAuth identity linking callback for an authenticated user
     */
    completeLink: (userId, providerType, code, state) =>
      Effect.gen(function* () {
        const { redirectUri } = yield* consumeOAuthStateForIntent(
          providerType,
          state,
          "link",
          Option.some(userId)
        )

        const provider = yield* getProvider(providerType)
        const providerResult = yield* provider.handleCallback(code, redirectUri)
        return yield* service.linkIdentity(userId, providerType, providerResult)
      }),

    /**
     * Logout and invalidate session
     */
    logout: (sessionId) =>
      Effect.gen(function* () {
        // Try to find the session first
        const maybeSession = yield* sessionRepo
          .findById(sessionId)
          .pipe(Effect.mapError(() => new SessionNotFoundError({ sessionId })))

        if (Option.isNone(maybeSession)) {
          return yield* new SessionNotFoundError({ sessionId })
        }

        // Delete the session
        yield* sessionRepo
          .delete(sessionId)
          .pipe(Effect.mapError(() => new SessionNotFoundError({ sessionId })))
      }),

    /**
     * Validate a session and retrieve the user
     */
    validateSession: (sessionId) =>
      Effect.gen(function* () {
        // Find the session
        const maybeSession = yield* sessionRepo
          .findById(sessionId)
          .pipe(Effect.mapError(() => new SessionNotFoundError({ sessionId })))

        if (Option.isNone(maybeSession)) {
          return yield* new SessionNotFoundError({ sessionId })
        }

        const session = maybeSession.value

        // Check if expired
        const now = Timestamp.now()
        if (session.isExpired(now)) {
          // Delete expired session - session cleanup is critical for security and
          // database hygiene. If deletion fails, the operation fails with SessionCleanupError.
          // Expired sessions accumulating in the database is a serious issue that
          // must be visible and not silently ignored.
          yield* sessionRepo.delete(sessionId).pipe(
            Effect.mapError(
              (cause) =>
                new SessionCleanupError({
                  sessionId,
                  operation: "expiry",
                  cause,
                })
            )
          )
          return yield* new SessionExpiredError({ sessionId })
        }

        // Get the user
        const maybeUser = yield* userRepo
          .findById(session.userId)
          .pipe(Effect.mapError(() => new SessionNotFoundError({ sessionId })))

        if (Option.isNone(maybeUser)) {
          return yield* new SessionNotFoundError({ sessionId })
        }

        return { user: maybeUser.value, session } satisfies ValidatedSession
      }),

    /**
     * Link an external identity to an existing user
     */
    linkIdentity: (userId, providerType, providerResult) =>
      Effect.gen(function* () {
        // Verify user exists
        const maybeUser = yield* userRepo.findById(userId).pipe(
          Effect.mapError(
            () =>
              new ProviderAuthFailedError({
                provider: providerType,
                reason: "Database error during user lookup",
              })
          )
        )

        if (Option.isNone(maybeUser)) {
          return yield* new UserNotFoundError({ email: providerResult.email })
        }

        // Check if identity already exists (linked to any user)
        const existingIdentity = yield* identityRepo
          .findByProvider(providerResult.provider, providerResult.providerId)
          .pipe(
            Effect.mapError(
              () =>
                new ProviderAuthFailedError({
                  provider: providerType,
                  reason: "Database error during identity lookup",
                })
            )
          )

        if (Option.isSome(existingIdentity)) {
          const identity = existingIdentity.value
          // Identity is already linked - check if it's to the same user
          if (identity.userId !== userId) {
            return yield* new IdentityAlreadyLinkedError({
              provider: providerResult.provider,
              providerId: providerResult.providerId,
              existingUserId: identity.userId,
            })
          }
          // Identity is already linked to this user - return it
          return identity
        }

        // Create the identity link
        const identityId = UserIdentityId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie))

        const identity = yield* identityRepo
          .create({
            id: identityId,
            userId,
            provider: providerResult.provider,
            providerId: providerResult.providerId,
            providerData: providerResult.providerData,
          })
          .pipe(
            Effect.mapError(
              () =>
                new ProviderAuthFailedError({
                  provider: providerType,
                  reason: "Failed to create identity link",
                })
            )
          )

        return identity
      }),

    /**
     * Get all enabled authentication providers
     */
    getEnabledProviders: Effect.succeed(Chunk.fromIterable(providerRegistry.keys())),
  }

  return service
})

/**
 * AuthServiceLive - Layer providing AuthService implementation
 *
 * Requires:
 * - AuthServiceConfig: Configuration including providers and settings
 * - UserRepository: For user CRUD operations
 * - EmailVerificationDeliveryService: For sending local verification codes
 * - EmailVerificationRequestRepository: For pending local verification codes
 * - IdentityRepository: For identity CRUD operations
 * - SessionRepository: For session CRUD operations
 * - OAuthStateStore: For persisted OAuth state intent validation
 * - SessionTokenGenerator: For generating secure session tokens
 * - PasswordHasher: For password hashing (registration)
 *
 * Usage:
 * ```typescript
 * import { AuthServiceLive } from "@my/persistence/layers"
 * import { AuthServiceConfig } from "@my/persistence/services"
 *
 * // Create config layer with providers
 * const ConfigLayer = AuthServiceConfig.layer(
 *   Chunk.make(localAuthProvider, googleAuthProvider)
 * )
 *
 * // Compose all layers
 * const AuthLayer = AuthServiceLive.pipe(
 *   Layer.provide(ConfigLayer),
 *   Layer.provide(UserRepositoryLive),
 *   Layer.provide(IdentityRepositoryLive),
 *   Layer.provide(SessionRepositoryLive),
 *   Layer.provide(SessionTokenGeneratorLive),
 *   Layer.provide(PasswordHasherLive)
 * )
 * ```
 */
export const AuthServiceLive: Layer.Layer<
  AuthService,
  never,
  | AuthServiceConfig
  | UserRepository
  | EmailVerificationDeliveryService
  | EmailVerificationRequestRepository
  | IdentityRepository
  | SessionRepository
  | OAuthStateStore
  | PrincipalRepository
  | SessionTokenGenerator
  | PasswordHasher
> = Layer.effect(AuthService, make).pipe(Layer.provide(NodeCrypto.layer))
