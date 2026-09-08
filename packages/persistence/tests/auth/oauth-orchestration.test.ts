import { describe, expect, it } from "@effect/vitest"
import * as Chunk from "effect/Chunk"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Timestamp from "@my/core/shared/values/Timestamp"
import { Principal, PrincipalId } from "@my/core/ownership"
import {
  AuthResult,
  AuthService,
  AuthUser,
  Email,
  EmailVerificationRequestId,
  EmailVerificationRequest,
  HashedPassword,
  PasswordHasher,
  ProviderData,
  ProviderId,
  Session,
  SessionId,
  SessionTokenGenerator,
  UserIdentity,
  LocalAuthRequest,
  isLocalAuthRequest,
  localAuthDefaults,
  type AuthProvider,
  type AuthServiceShape,
} from "@my/core/authentication"
import { AuthServiceLive } from "../../src/layers/AuthServiceLive.ts"
import { AuthServiceConfig, SessionDurationConfig } from "../../src/services/AuthServiceConfig.ts"
import {
  EmailVerificationDeliveryService,
  type EmailVerificationDeliveryServiceShape,
} from "../../src/services/EmailVerificationDeliveryService.ts"
import {
  EmailVerificationRequestRepository,
  type EmailVerificationRequestRepositoryService,
} from "../../src/services/EmailVerificationRequestRepository.ts"
import {
  IdentityRepository,
  type IdentityRepositoryService,
} from "../../src/services/IdentityRepository.ts"
import { OAuthStateStore, type OAuthStateStoreService } from "../../src/services/OAuthStateStore.ts"
import {
  PrincipalRepository,
  type PrincipalRepositoryService,
} from "../../src/services/PrincipalRepository.ts"
import {
  SessionRepository,
  type SessionRepositoryService,
} from "../../src/services/SessionRepository.ts"
import { UserRepository, type UserRepositoryService } from "../../src/services/UserRepository.ts"
import {
  EmailVerificationCodeMismatchError,
  EmailVerificationRequestExpiredError,
  EmailVerificationRequestNotFoundError,
  ProviderAuthFailedError,
} from "@my/core/authentication/errors"

interface HarnessState {
  readonly users: Map<string, AuthUser>
  readonly identities: Map<string, UserIdentity>
  readonly principals: Map<string, Principal>
  readonly verificationRequests: Map<string, EmailVerificationRequest>
}

interface Harness {
  readonly state: HarnessState
  readonly runWithAuth: <A, E>(f: (auth: AuthServiceShape) => Effect.Effect<A, E>) => Promise<A>
  // Effect's Either is typed as Either<Right, Left>, so this is Either<Success, Error>
  readonly runWithAuthEither: <A, E>(
    f: (auth: AuthServiceShape) => Effect.Effect<A, E>
  ) => Promise<Result.Result<A, E>>
}

const unsupported = <A>(): Effect.Effect<A> => Effect.die("unsupported in test")

const makeOAuthProvider = (type: "google" | "coinbase"): AuthProvider => ({
  type,
  supportsRegistration: false,
  authenticate: () => unsupported(),
  getAuthorizationUrl: (state, redirectUri) => {
    const authUrl =
      type === "google"
        ? "https://accounts.google.com/o/oauth2/v2/auth"
        : "https://www.coinbase.com/oauth/authorize"

    const defaultRedirectUri =
      type === "google"
        ? "http://localhost:3000/auth/callback/google"
        : "http://localhost:3000/auth/callback/coinbase"

    const url = new URL(authUrl)
    url.searchParams.set("state", state)
    url.searchParams.set("redirect_uri", redirectUri ?? defaultRedirectUri)
    return Option.some(url.toString())
  },
  handleCallback: (code) =>
    Effect.succeed(
      AuthResult.make({
        provider: type,
        providerId: ProviderId.make(`${type}-${code}`),
        email: Email.make(`${code}@example.com`),
        displayName: `${code} User`,
        emailVerified: true,
        providerData: Option.none(),
        oauthCredentials: Option.none(),
      })
    ),
})

const makeGoogleProvider = (): AuthProvider => makeOAuthProvider("google")
const makeCoinbaseProvider = (): AuthProvider => makeOAuthProvider("coinbase")

const makeRefreshingGoogleProvider = (): AuthProvider => ({
  ...makeGoogleProvider(),
  handleCallback: (code) =>
    Effect.succeed(
      AuthResult.make({
        provider: "google",
        providerId: ProviderId.make("returning-google-user"),
        email: Email.make("returning@example.com"),
        displayName: "Returning User",
        emailVerified: true,
        providerData: Option.some(
          ProviderData.make({
            profile: { email: `${code}@example.com` },
          })
        ),
        oauthCredentials: Option.none(),
      })
    ),
})

const MIXED_CASE_PROVIDER_EMAIL = "Person@Gmail.test"

const makeMixedCaseEmailGoogleProvider = (): AuthProvider => ({
  ...makeGoogleProvider(),
  handleCallback: () =>
    Effect.succeed(
      AuthResult.make({
        provider: "google",
        providerId: ProviderId.make("mixed-case-google-user"),
        email: Email.make(MIXED_CASE_PROVIDER_EMAIL),
        displayName: "Person",
        emailVerified: true,
        providerData: Option.some(
          ProviderData.make({
            profile: { email: MIXED_CASE_PROVIDER_EMAIL },
          })
        ),
        oauthCredentials: Option.none(),
      })
    ),
})

const makeLocalProvider = ({
  emailVerified,
}: {
  readonly emailVerified: boolean
}): AuthProvider => ({
  type: "local",
  supportsRegistration: true,
  authenticate: (request) => {
    if (!isLocalAuthRequest(request)) {
      return Effect.fail(
        new ProviderAuthFailedError({
          provider: "local",
          reason: "Invalid request type for local authentication test provider",
        })
      )
    }

    return Effect.succeed(
      AuthResult.make({
        provider: "local",
        providerId: ProviderId.make(request.email),
        email: request.email,
        displayName: request.email.split("@")[0] ?? "user",
        emailVerified,
        providerData: Option.none(),
        oauthCredentials: Option.none(),
      })
    )
  },
  getAuthorizationUrl: () => Option.none(),
  handleCallback: () => unsupported(),
})

const makeUserRepo = (state: HarnessState): UserRepositoryService => ({
  findById: (id) => Effect.succeed(Option.fromNullishOr(state.users.get(id))),
  findByEmail: (email) =>
    Effect.succeed(
      Option.fromNullishOr(Array.from(state.users.values()).find((user) => user.email === email))
    ),
  create: (insert) => {
    const timestamp = Timestamp.now()
    const user = AuthUser.make({
      ...insert,
      createdAt: timestamp,
      emailVerified: insert.emailVerified,
      welcomeSeenAt: null,
      updatedAt: timestamp,
    })
    state.users.set(user.id, user)
    return Effect.succeed(user)
  },
  update: (id, patch) => {
    const existing = state.users.get(id)
    if (existing === undefined) {
      return unsupported()
    }

    const updated = AuthUser.make({
      ...existing,
      ...patch,
      updatedAt: Timestamp.now(),
    })
    state.users.set(id, updated)
    return Effect.succeed(updated)
  },
  markWelcomeSeen: ({ userId }) => {
    const existing = state.users.get(userId)
    if (existing === undefined) {
      return unsupported()
    }
    if (existing.welcomeSeenAt !== null) {
      return Effect.succeed(existing)
    }

    const timestamp = Timestamp.now()
    const marked = AuthUser.make({ ...existing, welcomeSeenAt: timestamp, updatedAt: timestamp })
    state.users.set(userId, marked)
    return Effect.succeed(marked)
  },
  delete: (id) => {
    state.users.delete(id)
    return Effect.void
  },
  findPlatformAdmins: Effect.succeed(
    Array.from(state.users.values()).filter((user) => user.role === "admin")
  ),
  isPlatformAdmin: (id) => Effect.succeed(state.users.get(id)?.role === "admin"),
})

const makeEmailVerificationRequestRepo = (
  state: HarnessState
): EmailVerificationRequestRepositoryService => ({
  create: (request) => {
    for (const [existingId, existingRequest] of state.verificationRequests) {
      if (existingRequest.userId === request.userId) {
        state.verificationRequests.delete(existingId)
      }
    }

    const now = Timestamp.now()
    const verificationRequest = EmailVerificationRequest.make({
      ...request,
      createdAt: now,
      updatedAt: now,
    })

    state.verificationRequests.set(verificationRequest.id, verificationRequest)
    return Effect.succeed(verificationRequest)
  },
  recordSend: ({ id, sentAt }) => {
    const existing = state.verificationRequests.get(id)
    if (existing === undefined) {
      return Effect.succeed(Option.none())
    }

    const updated = EmailVerificationRequest.make({
      ...existing,
      lastSentAt: sentAt,
      updatedAt: Timestamp.now(),
    })

    state.verificationRequests.set(id, updated)
    return Effect.succeed(Option.some(updated))
  },
  renew: ({ id, replacementId, code, expiresAt, sentAt }) => {
    const existing = state.verificationRequests.get(id)
    if (existing === undefined) {
      return Effect.succeed(Option.none())
    }

    const now = Timestamp.now()
    const replacement = EmailVerificationRequest.make({
      id: replacementId,
      userId: existing.userId,
      email: existing.email,
      code,
      expiresAt,
      sendCount: existing.sendCount + 1,
      lastSentAt: sentAt,
      createdAt: now,
      updatedAt: now,
    })

    state.verificationRequests.delete(id)
    state.verificationRequests.set(replacementId, replacement)
    return Effect.succeed(Option.some(replacement))
  },
  findById: (id) => Effect.succeed(Option.fromNullishOr(state.verificationRequests.get(id))),
  findByUserId: (userId) =>
    Effect.succeed(
      Option.fromNullishOr(
        Array.from(state.verificationRequests.values())
          .filter((request) => request.userId === userId)
          .sort((left, right) => right.createdAt.epochMillis - left.createdAt.epochMillis)[0]
      )
    ),
  consume: (id) => {
    const existing = state.verificationRequests.get(id)
    if (existing === undefined) {
      return Effect.succeed(Option.none())
    }

    state.verificationRequests.delete(id)
    return Effect.succeed(Option.some(existing))
  },
  deleteExpired: (now) => {
    let deleted = 0
    for (const [id, request] of state.verificationRequests) {
      if (request.expiresAt.epochMillis <= now.epochMillis) {
        state.verificationRequests.delete(id)
        deleted += 1
      }
    }
    return Effect.succeed(deleted)
  },
})

const makeEmailVerificationDeliveryService = (): EmailVerificationDeliveryServiceShape => ({
  sendVerificationCode: () => Effect.void,
})

const makeIdentityRepo = (state: HarnessState): IdentityRepositoryService => {
  const passwordHashes = new Map<string, HashedPassword>()
  const passwordKey = (provider: string, providerId: string) => `${provider}:${providerId}`

  return {
    findById: (id) => Effect.succeed(Option.fromNullishOr(state.identities.get(id))),
    findByUserId: (userId) =>
      Effect.succeed(
        Chunk.fromIterable(
          Array.from(state.identities.values()).filter((identity) => identity.userId === userId)
        )
      ),
    findByProvider: (provider, providerId) =>
      Effect.succeed(
        Option.fromNullishOr(
          Array.from(state.identities.values()).find(
            (identity) => identity.provider === provider && identity.providerId === providerId
          )
        )
      ),
    findByUserAndProvider: (userId, provider) =>
      Effect.succeed(
        Option.fromNullishOr(
          Array.from(state.identities.values()).find(
            (identity) => identity.userId === userId && identity.provider === provider
          )
        )
      ),
    create: (insert) => {
      const identity = UserIdentity.make({
        id: insert.id,
        userId: insert.userId,
        provider: insert.provider,
        providerId: insert.providerId,
        providerData: insert.providerData,
        createdAt: Timestamp.now(),
      })

      state.identities.set(identity.id, identity)
      if (insert.passwordHash !== undefined) {
        passwordHashes.set(passwordKey(insert.provider, insert.providerId), insert.passwordHash)
      }

      return Effect.succeed(identity)
    },
    update: (id, patch) => {
      const existing = state.identities.get(id)
      if (existing === undefined) {
        return unsupported()
      }

      const updated = UserIdentity.make({
        ...existing,
        providerData: patch.providerData ?? existing.providerData,
      })
      state.identities.set(id, updated)
      return Effect.succeed(updated)
    },
    delete: (id) => {
      state.identities.delete(id)
      return Effect.void
    },
    deleteByUserId: (userId) => {
      const userIdentityIds = Array.from(state.identities.values())
        .filter((identity) => identity.userId === userId)
        .map((identity) => identity.id)
      for (const identityId of userIdentityIds) {
        state.identities.delete(identityId)
      }
      return Effect.succeed(userIdentityIds.length)
    },
    getPasswordHash: (provider, providerId) =>
      Effect.succeed(Option.fromNullishOr(passwordHashes.get(passwordKey(provider, providerId)))),
    updatePasswordHash: (provider, providerId, newPasswordHash) => {
      passwordHashes.set(passwordKey(provider, providerId), newPasswordHash)
      return Effect.void
    },
  }
}

const makePrincipalRepository = (state: HarnessState): PrincipalRepositoryService => {
  let principalSequence = 0
  const nextPrincipalId = () => {
    principalSequence += 1
    return PrincipalId.make(
      `00000000-0000-4000-8000-${principalSequence.toString().padStart(12, "0")}`
    )
  }

  return {
    findUserPrincipal: (userId) =>
      Effect.succeed(
        Option.fromNullishOr(
          Array.from(state.principals.values()).find((principal) => principal.userId === userId)
        )
      ),
    createUserPrincipal: (userId) => {
      const existing = Array.from(state.principals.values()).find(
        (principal) => principal.userId === userId
      )
      if (existing !== undefined) {
        return Effect.succeed(existing)
      }

      const principal = Principal.make({
        id: nextPrincipalId(),
        kind: "user",
        userId,
      })
      state.principals.set(principal.id, principal)
      return Effect.succeed(principal)
    },
    createAnonymousWalletPrincipal: Effect.suspend(() => {
      const principal = Principal.make({
        id: nextPrincipalId(),
        kind: "anonymous_wallet",
        userId: null,
      })
      state.principals.set(principal.id, principal)
      return Effect.succeed(principal)
    }),
  }
}

const makeSessionRepo = (): SessionRepositoryService => {
  const sessions = new Map<string, Session>()

  return {
    findById: (id) => Effect.succeed(Option.fromNullishOr(sessions.get(id))),
    findByUserId: (userId) =>
      Effect.succeed(
        Chunk.fromIterable(
          Array.from(sessions.values()).filter((session) => session.userId === userId)
        )
      ),
    create: (insert) => {
      const session = Session.make({
        ...insert,
        createdAt: Timestamp.now(),
      })
      sessions.set(session.id, session)
      return Effect.succeed(session)
    },
    delete: (id) => {
      sessions.delete(id)
      return Effect.void
    },
    deleteExpired: Effect.suspend(() => {
      const current = Timestamp.now().epochMillis
      let deleted = 0
      for (const [id, session] of sessions) {
        if (session.expiresAt.epochMillis <= current) {
          sessions.delete(id)
          deleted += 1
        }
      }
      return Effect.succeed(deleted)
    }),
    deleteByUserId: (userId) => {
      let deleted = 0
      for (const [id, session] of sessions) {
        if (session.userId === userId) {
          sessions.delete(id)
          deleted += 1
        }
      }
      return Effect.succeed(deleted)
    },
    updateExpiry: (id, expiresAt) => {
      const existing = sessions.get(id)
      if (existing === undefined) {
        return unsupported()
      }

      const updated = Session.make({
        ...existing,
        expiresAt,
      })
      sessions.set(id, updated)
      return Effect.succeed(updated)
    },
  }
}

const makeOAuthStateStore = (): OAuthStateStoreService => {
  const states = new Map<string, Parameters<OAuthStateStoreService["create"]>[0]>()

  return {
    create: (record) => {
      states.set(record.state, record)
      return Effect.void
    },
    consume: (state) => {
      const record = states.get(state)
      if (record === undefined) {
        return Effect.succeed(Option.none())
      }

      if (Option.isSome(record.consumedAt)) {
        return Effect.succeed(Option.none())
      }

      if (record.expiresAt.epochMillis <= Timestamp.now().epochMillis) {
        return Effect.succeed(Option.none())
      }

      const consumedAt = Timestamp.now()

      states.set(state, {
        ...record,
        consumedAt: Option.some(consumedAt),
      })

      return Effect.succeed(
        Option.some({
          ...record,
          consumedAt: Option.some(consumedAt),
        })
      )
    },
    get: (state) => Effect.succeed(Option.fromNullishOr(states.get(state))),
    markCompleted: ({ state, sessionToken, userId, statusMessage, completedAt }) => {
      const existing = states.get(state)
      if (existing === undefined) {
        return Effect.void
      }

      states.set(state, {
        ...existing,
        status: "completed",
        sessionToken: Option.some(sessionToken),
        userId: Option.some(userId),
        statusMessage,
        completedAt: Option.some(completedAt),
      })
      return Effect.void
    },
    markFailed: ({ state, statusMessage, completedAt }) => {
      const existing = states.get(state)
      if (existing === undefined) {
        return Effect.void
      }

      states.set(state, {
        ...existing,
        status: "failed",
        statusMessage: Option.some(statusMessage),
        completedAt: Option.some(completedAt),
      })
      return Effect.void
    },
    deleteExpired: Effect.suspend(() => {
      let deleted = 0
      for (const [state, record] of states) {
        if (record.expiresAt.epochMillis <= Timestamp.now().epochMillis) {
          states.delete(state)
          deleted += 1
        }
      }
      return Effect.succeed(deleted)
    }),
  }
}

const makeHarness = (providers: ReadonlyArray<AuthProvider>): Harness => {
  const state: HarnessState = {
    users: new Map(),
    identities: new Map(),
    principals: new Map(),
    verificationRequests: new Map(),
  }

  let sessionCounter = 0

  const deps = Layer.mergeAll(
    Layer.succeed(AuthServiceConfig, {
      providers: Chunk.fromIterable(providers),
      sessionDurations: SessionDurationConfig.Default,
      localAuth: localAuthDefaults,
      autoProvisionUsers: true,
      linkIdentitiesByEmail: true,
    }),
    Layer.succeed(UserRepository, makeUserRepo(state)),
    Layer.succeed(EmailVerificationDeliveryService, makeEmailVerificationDeliveryService()),
    Layer.succeed(EmailVerificationRequestRepository, makeEmailVerificationRequestRepo(state)),
    Layer.succeed(IdentityRepository, makeIdentityRepo(state)),
    Layer.succeed(PrincipalRepository, makePrincipalRepository(state)),
    Layer.succeed(SessionRepository, makeSessionRepo()),
    Layer.succeed(OAuthStateStore, makeOAuthStateStore()),
    Layer.succeed(SessionTokenGenerator, {
      generate: Effect.sync(() => {
        sessionCounter += 1
        const token = `sess_${String(sessionCounter).padStart(40, "0")}`
        return SessionId.make(token)
      }),
    }),
    Layer.succeed(PasswordHasher, {
      hash: (plaintext) => Effect.succeed(HashedPassword.make(`hash:${Redacted.value(plaintext)}`)),
      verify: (plaintext, hash) =>
        Effect.succeed(hash === HashedPassword.make(`hash:${Redacted.value(plaintext)}`)),
    })
  )

  const run = <A, E>(effect: Effect.Effect<A, E, AuthService>) =>
    Effect.runPromise(effect.pipe(Effect.provide(AuthServiceLive.pipe(Layer.provide(deps)))))

  return {
    state,
    runWithAuth: (f) =>
      run(
        Effect.gen(function* () {
          const auth = yield* AuthService
          return yield* f(auth)
        })
      ),
    runWithAuthEither: (f) =>
      run(
        Effect.gen(function* () {
          const auth = yield* AuthService
          return yield* f(auth)
        }).pipe(Effect.result)
      ),
  }
}

describe("AuthServiceLive OAuth orchestration", () => {
  it.effect("authorize -> callback creates user and session", () =>
    Effect.gen(function* () {
      const harness = makeHarness([makeGoogleProvider()])

      const started = yield* Effect.promise(() =>
        harness.runWithAuth((auth) => auth.startOAuthLogin("google"))
      )
      const authorizationUrl = new URL(started.authorizationUrl)
      expect(authorizationUrl.searchParams.get("state")).toBe(started.state)
      expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
        "http://localhost:3000/auth/callback/google"
      )

      const login = yield* Effect.promise(() =>
        harness.runWithAuth((auth) => auth.completeOAuthLogin("google", "alice", started.state))
      )

      expect(login.user.email).toBe(Email.make("alice@example.com"))
      expect(login.user.emailVerified).toBe(true)
      expect(login.session.id.startsWith("sess_")).toBe(true)
      expect(harness.state.users.size).toBe(1)
      expect(harness.state.principals.size).toBe(1)
      expect(Array.from(harness.state.principals.values())[0]?.userId).toBe(login.user.id)
      const createdGoogleIdentities = Array.from(harness.state.identities.values()).filter(
        (identity) => identity.provider === "google"
      )
      expect(createdGoogleIdentities.length).toBe(1)
      expect(createdGoogleIdentities[0]?.userId).toBe(login.user.id)

      const reusedState = yield* Effect.promise(() =>
        harness.runWithAuthEither((auth) =>
          auth.completeOAuthLogin("google", "alice", started.state)
        )
      )

      expect(Result.isFailure(reusedState)).toBe(true)
      if (Result.isFailure(reusedState)) {
        expect(reusedState.failure._tag).toBe("OAuthStateError")
      }
    })
  )

  it.effect(
    "stores an OAuth-created account's email trimmed and lowercased and keeps the provider payload as reported",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness([makeMixedCaseEmailGoogleProvider()])

        const started = yield* Effect.promise(() =>
          harness.runWithAuth((auth) => auth.startOAuthLogin("google"))
        )
        const login = yield* Effect.promise(() =>
          harness.runWithAuth((auth) => auth.completeOAuthLogin("google", "person", started.state))
        )

        expect(login.user.email).toBe(Email.make("person@gmail.test"))

        const identities = Array.from(harness.state.identities.values())
        expect(identities).toHaveLength(1)
        expect(identities[0]?.providerData).toEqual(
          Option.some(
            ProviderData.make({
              profile: { email: MIXED_CASE_PROVIDER_EMAIL },
            })
          )
        )
      })
  )

  it.effect("refreshes provider metadata when an OAuth identity returns", () =>
    Effect.gen(function* () {
      const harness = makeHarness([makeRefreshingGoogleProvider()])

      const firstLogin = yield* Effect.promise(() =>
        harness.runWithAuth((auth) => auth.startOAuthLogin("google"))
      )
      yield* Effect.promise(() =>
        harness.runWithAuth((auth) =>
          auth.completeOAuthLogin("google", "old-profile", firstLogin.state)
        )
      )

      const returningLogin = yield* Effect.promise(() =>
        harness.runWithAuth((auth) => auth.startOAuthLogin("google"))
      )
      yield* Effect.promise(() =>
        harness.runWithAuth((auth) =>
          auth.completeOAuthLogin("google", "fresh-profile", returningLogin.state)
        )
      )

      const identities = Array.from(harness.state.identities.values())
      expect(identities).toHaveLength(1)
      expect(identities[0]?.providerData).toEqual(
        Option.some(
          ProviderData.make({
            profile: { email: "fresh-profile@example.com" },
          })
        )
      )
    })
  )

  it.effect("link -> callback links identity and does not create a new user", () =>
    Effect.gen(function* () {
      const harness = makeHarness([makeGoogleProvider()])

      const user = yield* Effect.promise(() =>
        harness.runWithAuth((auth) =>
          auth.register(Email.make("owner@example.com"), "password123", "Owner")
        )
      )

      const started = yield* Effect.promise(() =>
        harness.runWithAuth((auth) => auth.startLink(user.id, "google"))
      )
      yield* Effect.promise(() =>
        harness.runWithAuth((auth) =>
          auth.completeLink(user.id, "google", "owner-google", started.state)
        )
      )

      expect(harness.state.users.size).toBe(1)
      expect(harness.state.principals.size).toBe(1)
      const linkedIdentityCount = Array.from(harness.state.identities.values()).filter(
        (identity) => identity.userId === user.id && identity.provider === "google"
      ).length
      expect(linkedIdentityCount).toBe(1)
    })
  )

  it.effect(
    "register stores the email trimmed and lowercased, rejects a casing variant, and logs in with any casing",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness([makeLocalProvider({ emailVerified: true })])

        const user = yield* Effect.promise(() =>
          harness.runWithAuth((auth) =>
            auth.register(Email.make("Owner@Example.com"), "password123", "Owner")
          )
        )

        expect(user.email).toBe(Email.make("owner@example.com"))
        const localIdentities = Array.from(harness.state.identities.values()).filter(
          (identity) => identity.provider === "local"
        )
        expect(localIdentities.map((identity) => identity.providerId)).toEqual([
          ProviderId.make("owner@example.com"),
        ])

        const conflict = yield* Effect.promise(() =>
          harness.runWithAuthEither((auth) =>
            auth.register(Email.make("OWNER@example.com"), "password123", "Owner Again")
          )
        )

        expect(Result.isFailure(conflict)).toBe(true)
        if (Result.isFailure(conflict)) {
          expect(conflict.failure._tag).toBe("UserAlreadyExistsError")
          if (conflict.failure._tag === "UserAlreadyExistsError") {
            expect(conflict.failure.email).toBe(Email.make("owner@example.com"))
          }
        }
        expect(harness.state.users.size).toBe(1)

        const login = yield* Effect.promise(() =>
          harness.runWithAuth((auth) =>
            auth.login(
              "local",
              LocalAuthRequest.make({
                email: Email.make("OWNER@Example.com"),
                password: Redacted.make("password123"),
              })
            )
          )
        )

        expect(login.user.id).toBe(user.id)
        expect(harness.state.users.size).toBe(1)
      })
  )

  it.effect("register preserves an explicitly provided display name", () =>
    Effect.gen(function* () {
      const harness = makeHarness([])

      const user = yield* Effect.promise(() =>
        harness.runWithAuth((auth) =>
          auth.register(Email.make("max.mustermann@example.com"), "password123", "Provided Name")
        )
      )

      expect(user.displayName).toBe("Provided Name")
      expect(user.emailVerified).toBe(false)
      expect(harness.state.principals.size).toBe(1)
      expect(Array.from(harness.state.principals.values())[0]?.userId).toBe(user.id)
    })
  )

  it.effect(
    "register infers the display name from the email local part when none is provided",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness([])

        const user = yield* Effect.promise(() =>
          harness.runWithAuth((auth) =>
            auth.register(Email.make("max.mustermann@example.com"), "password123")
          )
        )

        expect(user.displayName).toBe("max.mustermann")
        expect(user.emailVerified).toBe(false)
      })
  )

  it.effect("startEmailVerification reuses the latest active verification request", () =>
    Effect.gen(function* () {
      const harness = makeHarness([])

      const user = yield* Effect.promise(() =>
        harness.runWithAuth((auth) =>
          auth.register(Email.make("owner@example.com"), "password123", "Owner")
        )
      )

      const firstRequest = yield* Effect.promise(() =>
        harness.runWithAuth((auth) => auth.startEmailVerification(user))
      )
      const secondRequest = yield* Effect.promise(() =>
        harness.runWithAuth((auth) => auth.startEmailVerification(user))
      )

      expect(firstRequest.id).toBe(secondRequest.id)
      expect(firstRequest.code).toBe(secondRequest.code)
      expect(harness.state.verificationRequests.size).toBe(1)
    })
  )

  it.effect("resendEmailVerification replaces the active request with a fresh code", () =>
    Effect.gen(function* () {
      const harness = makeHarness([])

      const user = yield* Effect.promise(() =>
        harness.runWithAuth((auth) =>
          auth.register(Email.make("owner@example.com"), "password123", "Owner")
        )
      )

      const originalRequest = yield* Effect.promise(() =>
        harness.runWithAuth((auth) => auth.startEmailVerification(user))
      )
      const refreshedRequest = yield* Effect.promise(() =>
        harness.runWithAuth((auth) => auth.resendEmailVerification(originalRequest.id))
      )

      expect(refreshedRequest.id).not.toBe(originalRequest.id)
      expect(refreshedRequest.code).not.toBe(originalRequest.code)
      expect(harness.state.verificationRequests.has(originalRequest.id)).toBe(false)
      expect(harness.state.verificationRequests.has(refreshedRequest.id)).toBe(true)
    })
  )

  it.effect(
    "verifyEmail marks the user verified, consumes the request, and creates a session",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness([])

        const user = yield* Effect.promise(() =>
          harness.runWithAuth((auth) =>
            auth.register(Email.make("owner@example.com"), "password123", "Owner")
          )
        )

        const verificationRequest = yield* Effect.promise(() =>
          harness.runWithAuth((auth) => auth.startEmailVerification(user))
        )

        const verified = yield* Effect.promise(() =>
          harness.runWithAuth((auth) =>
            auth.verifyEmail(verificationRequest.id, verificationRequest.code)
          )
        )

        expect(verified.user.emailVerified).toBe(true)
        expect(harness.state.users.get(user.id)?.emailVerified).toBe(true)
        expect(harness.state.verificationRequests.size).toBe(0)
        expect(verified.session.id.startsWith("sess_")).toBe(true)
      })
  )

  it.effect("verifyEmail rejects an incorrect verification code", () =>
    Effect.gen(function* () {
      const harness = makeHarness([])

      const user = yield* Effect.promise(() =>
        harness.runWithAuth((auth) =>
          auth.register(Email.make("owner@example.com"), "password123", "Owner")
        )
      )

      const verificationRequest = yield* Effect.promise(() =>
        harness.runWithAuth((auth) => auth.startEmailVerification(user))
      )

      const result = yield* Effect.promise(() =>
        harness.runWithAuthEither((auth) => auth.verifyEmail(verificationRequest.id, "ZZZZZZZZ"))
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(EmailVerificationCodeMismatchError)
      }
      expect(harness.state.verificationRequests.has(verificationRequest.id)).toBe(true)
    })
  )

  it.effect("verifyEmail rejects an expired verification request", () =>
    Effect.gen(function* () {
      const harness = makeHarness([])

      const user = yield* Effect.promise(() =>
        harness.runWithAuth((auth) =>
          auth.register(Email.make("owner@example.com"), "password123", "Owner")
        )
      )

      const verificationRequest = yield* Effect.promise(() =>
        harness.runWithAuth((auth) => auth.startEmailVerification(user))
      )

      harness.state.verificationRequests.set(
        verificationRequest.id,
        EmailVerificationRequest.make({
          ...verificationRequest,
          expiresAt: Timestamp.Timestamp.make({ epochMillis: 0 }),
        })
      )

      const result = yield* Effect.promise(() =>
        harness.runWithAuthEither((auth) =>
          auth.verifyEmail(verificationRequest.id, verificationRequest.code)
        )
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(EmailVerificationRequestExpiredError)
      }
      expect(harness.state.verificationRequests.has(verificationRequest.id)).toBe(false)
    })
  )

  it.effect("resendEmailVerification rejects a missing request id", () =>
    Effect.gen(function* () {
      const harness = makeHarness([])

      const result = yield* Effect.promise(() =>
        harness.runWithAuthEither((auth) =>
          auth.resendEmailVerification(
            EmailVerificationRequestId.make("00000000-4000-4000-8000-000000000999")
          )
        )
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(EmailVerificationRequestNotFoundError)
      }
    })
  )

  it.effect("rejects local login when the email is still unverified", () =>
    Effect.gen(function* () {
      const harness = makeHarness([makeLocalProvider({ emailVerified: false })])

      yield* Effect.promise(() =>
        harness.runWithAuth((auth) =>
          auth.register(Email.make("owner@example.com"), "password123", "Owner")
        )
      )

      const result = yield* Effect.promise(() =>
        harness.runWithAuthEither((auth) =>
          auth.login(
            "local",
            LocalAuthRequest.make({
              email: Email.make("owner@example.com"),
              password: Redacted.make("password123"),
            })
          )
        )
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("UnverifiedEmailError")
      }
    })
  )

  it.effect("fails callback when state is invalid", () =>
    Effect.gen(function* () {
      const harness = makeHarness([makeGoogleProvider()])

      const result = yield* Effect.promise(() =>
        harness.runWithAuthEither((auth) =>
          auth.completeOAuthLogin("google", "alice", "missing-state")
        )
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("OAuthStateError")
      }
    })
  )

  it.effect("fails callback when oauth state intent does not match callback flow", () =>
    Effect.gen(function* () {
      const harness = makeHarness([makeGoogleProvider()])

      const user = yield* Effect.promise(() =>
        harness.runWithAuth((auth) =>
          auth.register(Email.make("owner@example.com"), "password123", "Owner")
        )
      )

      const loginState = yield* Effect.promise(() =>
        harness.runWithAuth((auth) => auth.startOAuthLogin("google"))
      )
      const linkWithLoginState = yield* Effect.promise(() =>
        harness.runWithAuthEither((auth) =>
          auth.completeLink(user.id, "google", "owner-google", loginState.state)
        )
      )

      expect(Result.isFailure(linkWithLoginState)).toBe(true)
      if (Result.isFailure(linkWithLoginState)) {
        expect(linkWithLoginState.failure._tag).toBe("OAuthStateError")
      }

      const linkState = yield* Effect.promise(() =>
        harness.runWithAuth((auth) => auth.startLink(user.id, "google"))
      )
      const loginWithLinkState = yield* Effect.promise(() =>
        harness.runWithAuthEither((auth) =>
          auth.completeOAuthLogin("google", "owner-google", linkState.state)
        )
      )

      expect(Result.isFailure(loginWithLinkState)).toBe(true)
      if (Result.isFailure(loginWithLinkState)) {
        expect(loginWithLinkState.failure._tag).toBe("OAuthStateError")
      }
    })
  )

  it.effect("fails link callback when state belongs to a different user", () =>
    Effect.gen(function* () {
      const harness = makeHarness([makeGoogleProvider()])

      const firstUser = yield* Effect.promise(() =>
        harness.runWithAuth((auth) =>
          auth.register(Email.make("first@example.com"), "password123", "First")
        )
      )
      const secondUser = yield* Effect.promise(() =>
        harness.runWithAuth((auth) =>
          auth.register(Email.make("second@example.com"), "password123", "Second")
        )
      )

      const started = yield* Effect.promise(() =>
        harness.runWithAuth((auth) => auth.startLink(firstUser.id, "google"))
      )
      const result = yield* Effect.promise(() =>
        harness.runWithAuthEither((auth) =>
          auth.completeLink(secondUser.id, "google", "shared-google", started.state)
        )
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("OAuthStateError")
      }
    })
  )

  it.effect("returns ProviderNotEnabledError when provider is disabled", () =>
    Effect.gen(function* () {
      const harness = makeHarness([])

      const result = yield* Effect.promise(() =>
        harness.runWithAuthEither((auth) => auth.startOAuthLogin("google"))
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("ProviderNotEnabledError")
      }
    })
  )

  it.effect("fails callback when oauth state provider does not match callback provider", () =>
    Effect.gen(function* () {
      const harness = makeHarness([makeGoogleProvider(), makeCoinbaseProvider()])

      const started = yield* Effect.promise(() =>
        harness.runWithAuth((auth) => auth.startOAuthLogin("google"))
      )
      const result = yield* Effect.promise(() =>
        harness.runWithAuthEither((auth) =>
          auth.completeOAuthLogin("coinbase", "alice", started.state)
        )
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("OAuthStateError")
      }
    })
  )

  it.effect("returns IdentityAlreadyLinkedError when identity is already linked", () =>
    Effect.gen(function* () {
      const harness = makeHarness([makeGoogleProvider()])

      const firstUser = yield* Effect.promise(() =>
        harness.runWithAuth((auth) =>
          auth.register(Email.make("first@example.com"), "password123", "First")
        )
      )
      const secondUser = yield* Effect.promise(() =>
        harness.runWithAuth((auth) =>
          auth.register(Email.make("second@example.com"), "password123", "Second")
        )
      )

      const firstLink = yield* Effect.promise(() =>
        harness.runWithAuth((auth) => auth.startLink(firstUser.id, "google"))
      )
      yield* Effect.promise(() =>
        harness.runWithAuth((auth) =>
          auth.completeLink(firstUser.id, "google", "shared-google", firstLink.state)
        )
      )

      const secondLink = yield* Effect.promise(() =>
        harness.runWithAuth((auth) => auth.startLink(secondUser.id, "google"))
      )
      const result = yield* Effect.promise(() =>
        harness.runWithAuthEither((auth) =>
          auth.completeLink(secondUser.id, "google", "shared-google", secondLink.state)
        )
      )

      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("IdentityAlreadyLinkedError")
      }
    })
  )
})
