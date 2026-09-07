import { SourceSyncQueueUnexpectedTestLive } from "./support/SourceSyncQueueUnexpectedTestLive.ts"
import { nextTestUuid } from "./support/TestUuid.ts"
import { Etag, HttpRouter } from "effect/unstable/http"
import { NodeHttpPlatform, NodeServices } from "@effect/platform-node"
import {
  HashedPassword,
  PasswordHasher,
  SessionId,
  SessionTokenGenerator,
  localAuthDefaults,
} from "@my/core/authentication"
import * as Chunk from "effect/Chunk"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import {
  SourceSyncRunService,
  type SourceSyncRunServiceShape,
  SourceSyncService,
  TransferReconciliationService,
  type SourceSyncServiceShape,
  type TransferReconciliationServiceShape,
} from "@my/sync-engine/services"
import { AuthServiceLive } from "../../persistence/src/layers/AuthServiceLive.ts"
import { LocalAuthProviderLive } from "../../persistence/src/layers/LocalAuthProviderLive.ts"
import { drizzle, runSqlUnsafe } from "../../persistence/src/layers/PgClientLive.ts"
import { RepositoriesLive } from "../../persistence/src/layers/RepositoriesLive.ts"
import { schema } from "../../persistence/src/schema/index.ts"
import {
  AuthServiceConfig,
  SessionDurationConfig,
} from "../../persistence/src/services/AuthServiceConfig.ts"
import { EmailVerificationDeliveryService } from "../../persistence/src/services/EmailVerificationDeliveryService.ts"
import { LocalAuthProvider } from "../../persistence/src/services/LocalAuthProvider.ts"
import { makeIntegrationTestDatabaseContext } from "../../persistence/tests/support/integration-test-kit.ts"
import { AnonSessionServiceLive } from "../src/layers/AnonSessionServiceLive.ts"
import { TaxMaxiApiLive } from "../src/layers/TaxMaxiApiLive.ts"
import {
  invalidSessionCookieCleanup,
  SessionTokenValidatorLive,
} from "../src/layers/AuthMiddlewareLive.ts"
import { makeX402PaymentValidatorTestLive } from "./support/X402PaymentValidatorTestLive.ts"
import { SIWXProofVerifierTestLive } from "./support/SIWXProofVerifierTestLive.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_rest_api_auth",
})
const TestPgClientLive = context.TestPgClientLive
const X402PaymentValidatorTestLive = makeX402PaymentValidatorTestLive({
  validPaymentHeader: "valid-test-x402-payment",
})
const TestConfigProvider = ConfigProvider.fromEnvRecord({
  ANON_SESSION_SECRET: "test-anon-session-secret-32-bytes-long",
})
const AnonSessionServiceTestLive = AnonSessionServiceLive.pipe(
  Layer.provide(ConfigProvider.layer(TestConfigProvider))
)

const runTestSql = ({ statement }: { readonly statement: string }) =>
  runSqlUnsafe({ statement }).pipe(Effect.provide(TestPgClientLive), Effect.asVoid, Effect.scoped)

const readStoredAccountEmails = () =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const rows = yield* db.select({ email: schema.users.email }).from(schema.users)
    return rows.map((row) => row.email)
  }).pipe(Effect.provide(TestPgClientLive), Effect.scoped)

const readStoredLocalProviderIds = () =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const rows = yield* db
      .select({ provider: schema.identities.provider, providerId: schema.identities.providerId })
      .from(schema.identities)
    return rows.filter((row) => row.provider === "local").map((row) => row.providerId)
  }).pipe(Effect.provide(TestPgClientLive), Effect.scoped)

const clearAuthTables = () =>
  runTestSql({
    statement: `
      TRUNCATE TABLE
        email_verification_requests,
        sessions,
        oauth_states,
        auth_identities,
        users
      RESTART IDENTITY CASCADE
    `,
  })

const COINBASE_USER_ID = "00000000-0000-4000-8000-000000000101"
const COINBASE_IDENTITY_ID = "00000000-0000-4000-8000-000000000102"
const COINBASE_SESSION_ID = "coinbase_session_000000000000000000000001"
const COINBASE_ACCOUNT_EMAIL = "account@taxmaxi.test"
const COINBASE_PROVIDER_EMAIL = "provider@coinbase.test"
const MIXED_PROVIDER_USER_ID = "00000000-0000-4000-8000-000000000201"
const MIXED_PROVIDER_LOCAL_IDENTITY_ID = "00000000-0000-4000-8000-000000000202"
const MIXED_PROVIDER_COINBASE_IDENTITY_ID = "00000000-0000-4000-8000-000000000203"
const MIXED_PROVIDER_SESSION_ID = "mixed_provider_session_000000000000000000001"
const MIXED_PROVIDER_EMAIL = "mixed-provider@taxmaxi.test"

const seedCoinbaseSession = () =>
  runTestSql({
    statement: `
      INSERT INTO users (id, email, email_verified, name, role)
      VALUES ('${COINBASE_USER_ID}', '${COINBASE_ACCOUNT_EMAIL}', true, 'Coinbase Owner', 'user');

      INSERT INTO auth_identities (id, user_id, provider, provider_id, provider_data)
      VALUES (
        '${COINBASE_IDENTITY_ID}',
        '${COINBASE_USER_ID}',
        'coinbase',
        'raw-coinbase-provider-id',
        '{"profile":{"email":"${COINBASE_PROVIDER_EMAIL}","username":"private-handle"},"metadata":{"access":"private"}}'::jsonb
      );

      INSERT INTO sessions (id, user_id, provider, expires_at)
      VALUES (
        '${COINBASE_SESSION_ID}',
        '${COINBASE_USER_ID}',
        'coinbase',
        NOW() + INTERVAL '1 day'
      );
    `,
  })

const seedMixedProviderSession = () =>
  runTestSql({
    statement: `
      INSERT INTO users (id, email, email_verified, name, role)
      VALUES ('${MIXED_PROVIDER_USER_ID}', '${MIXED_PROVIDER_EMAIL}', false, 'Mixed Provider', 'user');

      INSERT INTO auth_identities (id, user_id, provider, provider_id, password_hash)
      VALUES (
        '${MIXED_PROVIDER_LOCAL_IDENTITY_ID}',
        '${MIXED_PROVIDER_USER_ID}',
        'local',
        '${MIXED_PROVIDER_EMAIL}',
        'hash:password123'
      );

      INSERT INTO auth_identities (id, user_id, provider, provider_id, provider_data)
      VALUES (
        '${MIXED_PROVIDER_COINBASE_IDENTITY_ID}',
        '${MIXED_PROVIDER_USER_ID}',
        'coinbase',
        'disabled-coinbase-provider-id',
        '{"profile":{"email":"disabled@coinbase.test"}}'::jsonb
      );

      INSERT INTO sessions (id, user_id, provider, expires_at)
      VALUES (
        '${MIXED_PROVIDER_SESSION_ID}',
        '${MIXED_PROVIDER_USER_ID}',
        'local',
        NOW() + INTERVAL '1 day'
      );
    `,
  })

const SourceSyncServiceTestLive = Layer.succeed(SourceSyncService, {
  startSourceSyncJob: () =>
    Effect.die("SourceSyncService test stub: startSourceSyncJob not implemented"),
  replaySourceSyncJob: () =>
    Effect.die("SourceSyncService test stub: replaySourceSyncJob not implemented"),
  getSourceSyncJob: () =>
    Effect.die("SourceSyncService test stub: getSourceSyncJob not implemented"),
} satisfies SourceSyncServiceShape)

const SourceSyncRunServiceTestLive = Layer.succeed(SourceSyncRunService, {
  startSyncRun: () => Effect.die("SourceSyncRunService test stub: startSyncRun not implemented"),
  getSyncRun: () => Effect.die("SourceSyncRunService test stub: getSyncRun not implemented"),
} satisfies SourceSyncRunServiceShape)

const TransferReconciliationServiceTestLive = Layer.succeed(TransferReconciliationService, {
  reconcileTransferCandidates: () =>
    Effect.die(
      "TransferReconciliationService test stub: reconcileTransferCandidates not implemented"
    ),
  rollbackReconciliationsForSourceReplay: () => Effect.void,
  applyDeterministicInternalTransferCanonicalization: () =>
    Effect.die(
      "TransferReconciliationService test stub: applyDeterministicInternalTransferCanonicalization not implemented"
    ),
} satisfies TransferReconciliationServiceShape)

interface SentVerificationCode {
  readonly email: string
  readonly code: string
}

interface AuthHandlerRuntime {
  readonly handler: (request: Request) => Promise<Response>
  readonly dispose: () => Promise<void>
  readonly sentVerificationCodes: SentVerificationCode[]
}

const makeAuthHandler = () => {
  const sentVerificationCodes: SentVerificationCode[] = []
  let sessionCounter = 0

  const PasswordHasherTestLive = Layer.succeed(PasswordHasher, {
    hash: (password) => Effect.succeed(HashedPassword.make(`hash:${Redacted.value(password)}`)),
    verify: (password, hash) =>
      Effect.succeed(hash === HashedPassword.make(`hash:${Redacted.value(password)}`)),
  })

  const SessionTokenGeneratorTestLive = Layer.succeed(SessionTokenGenerator, {
    generate: Effect.sync(() => {
      sessionCounter += 1
      return SessionId.make(`sess_${String(sessionCounter).padStart(40, "0")}`)
    }),
  })

  const EmailVerificationDeliveryServiceTestLive = Layer.succeed(EmailVerificationDeliveryService, {
    sendVerificationCode: ({ email, code }) =>
      Effect.sync(() => {
        sentVerificationCodes.push({ email, code })
      }),
  })

  const InfrastructureLive = Layer.mergeAll(
    RepositoriesLive,
    PasswordHasherTestLive,
    SessionTokenGeneratorTestLive,
    EmailVerificationDeliveryServiceTestLive,
    SourceSyncServiceTestLive,
    SourceSyncRunServiceTestLive,
    TransferReconciliationServiceTestLive
  ).pipe(Layer.provideMerge(TestPgClientLive))

  const LocalAuthProviderTestLive = LocalAuthProviderLive.pipe(
    Layer.provideMerge(InfrastructureLive)
  )

  const AuthServiceConfigTestLive = Layer.effect(
    AuthServiceConfig,
    Effect.gen(function* () {
      const localProvider = yield* LocalAuthProvider

      return {
        providers: Chunk.of(localProvider),
        sessionDurations: SessionDurationConfig.Default,
        localAuth: localAuthDefaults,
        autoProvisionUsers: true,
        linkIdentitiesByEmail: true,
      }
    })
  ).pipe(Layer.provide(LocalAuthProviderTestLive))

  const AuthServiceTestLive = AuthServiceLive.pipe(
    Layer.provide(AuthServiceConfigTestLive),
    Layer.provideMerge(InfrastructureLive)
  )

  const { handler, dispose } = HttpRouter.toWebHandler(
    TaxMaxiApiLive.pipe(
      Layer.provide(SourceSyncQueueUnexpectedTestLive),
      Layer.provide(AnonSessionServiceTestLive),
      Layer.provide(SIWXProofVerifierTestLive),
      Layer.provide(X402PaymentValidatorTestLive),
      Layer.provide(SessionTokenValidatorLive),
      Layer.provide(AuthServiceTestLive),
      Layer.provideMerge(InfrastructureLive),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeHttpPlatform.layer, Etag.layer))
    ),
    { middleware: invalidSessionCookieCleanup }
  )

  return {
    handler: (request: Request) => handler(request, Context.empty()),
    dispose,
    sentVerificationCodes,
  }
}

const makeAuthHandlerScoped: Effect.Effect<AuthHandlerRuntime, never, Scope.Scope> =
  Effect.acquireRelease(
    Effect.sync(() => makeAuthHandler()),
    ({ dispose }) =>
      Effect.tryPromise({
        try: () => dispose(),
        catch: (cause) => String(cause),
      }).pipe(Effect.orDie)
  )

const getSetCookies = (response: Response): ReadonlyArray<string> => {
  const headers = response.headers as Headers & {
    readonly getSetCookie?: () => ReadonlyArray<string>
  }

  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie()
  }

  const setCookie = response.headers.get("set-cookie")
  return setCookie === null ? [] : [setCookie]
}

const getCookieValue = ({
  setCookies,
  name,
}: {
  readonly setCookies: ReadonlyArray<string>
  readonly name: string
}): string => {
  const cookie = setCookies.find((value) => value.startsWith(`${name}=`))

  if (cookie === undefined) {
    throw new Error(`Missing ${name} cookie`)
  }

  return cookie.slice(name.length + 1).split(";", 1)[0] ?? ""
}

const makeCookieHeader = (cookies: Readonly<Record<string, string>>): string =>
  Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ")

const postJson = ({
  handler,
  path,
  payload,
  cookie,
}: {
  readonly handler: (request: Request) => Promise<Response>
  readonly path: string
  readonly payload: unknown
  readonly cookie?: string
}) =>
  Effect.gen(function* () {
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(payload)
    return yield* Effect.tryPromise({
      try: () => {
        const headers = new Headers({
          "content-type": "application/json",
        })

        if (cookie !== undefined) {
          headers.set("cookie", cookie)
        }

        return handler(
          new Request(`http://taxmaxi.test${path}`, {
            method: "POST",
            headers,
            body,
          })
        )
      },
      catch: (cause) => String(cause),
    }).pipe(Effect.orDie)
  })

const postRequest = ({
  handler,
  path,
  cookie,
}: {
  readonly handler: (request: Request) => Promise<Response>
  readonly path: string
  readonly cookie?: string
}) =>
  Effect.tryPromise({
    try: () => {
      const headers = new Headers()

      if (cookie !== undefined) {
        headers.set("cookie", cookie)
      }

      return handler(
        new Request(`http://taxmaxi.test${path}`, {
          method: "POST",
          headers,
        })
      )
    },
    catch: (cause) => String(cause),
  }).pipe(Effect.orDie)

const deleteRequest = ({
  handler,
  path,
  cookie,
}: {
  readonly handler: (request: Request) => Promise<Response>
  readonly path: string
  readonly cookie?: string
}) =>
  Effect.tryPromise({
    try: () => {
      const headers = new Headers()

      if (cookie !== undefined) {
        headers.set("cookie", cookie)
      }

      return handler(
        new Request(`http://taxmaxi.test${path}`, {
          method: "DELETE",
          headers,
        })
      )
    },
    catch: (cause) => String(cause),
  }).pipe(Effect.orDie)

const getRequest = ({
  handler,
  path,
  cookie,
}: {
  readonly handler: (request: Request) => Promise<Response>
  readonly path: string
  readonly cookie?: string
}) =>
  Effect.tryPromise({
    try: () => {
      const headers = new Headers()

      if (cookie !== undefined) {
        headers.set("cookie", cookie)
      }

      return handler(
        new Request(`http://taxmaxi.test${path}`, {
          method: "GET",
          headers,
        })
      )
    },
    catch: (cause) => String(cause),
  }).pipe(Effect.orDie)

interface AccountResponseBody {
  readonly account: { readonly welcomeSeenAt: string | null; readonly updatedAt: string }
  readonly loginMethods: ReadonlyArray<unknown>
}

const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/

const jsonBody = <A = unknown>(response: Response) =>
  Effect.tryPromise({
    try: () => response.json() as Promise<A>,
    catch: (cause) => String(cause),
  }).pipe(Effect.orDie)

await Effect.runPromise(context.recreateTestDatabase())

describe("AuthApiLive integration", () => {
  beforeEach(() => Effect.runPromise(clearAuthTables()))

  it.effect("clears an invalid session cookie on an unauthorized response", () =>
    Effect.gen(function* () {
      const { handler } = yield* makeAuthHandlerScoped

      const response = yield* getRequest({
        handler,
        path: "/auth/me",
        cookie: "taxmaxi_session=invalid-session",
      })

      expect(response.status).toBe(401)
      const clearedSessionCookie = getSetCookies(response).find((cookie) =>
        cookie.startsWith("taxmaxi_session=")
      )
      expect(clearedSessionCookie).toContain("taxmaxi_session=;")
      expect(clearedSessionCookie).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT")
      expect(clearedSessionCookie).toContain("HttpOnly")
      expect(clearedSessionCookie).toContain("Path=/")
    }).pipe(Effect.scoped)
  )

  it.effect("shows an existing Coinbase login method without exposing provider identity data", () =>
    Effect.gen(function* () {
      const { handler } = yield* makeAuthHandlerScoped
      yield* seedCoinbaseSession()

      const response = yield* getRequest({
        handler,
        path: "/auth/me",
        cookie: makeCookieHeader({ taxmaxi_session: COINBASE_SESSION_ID }),
      })

      expect(response.status).toBe(200)
      expect(yield* jsonBody(response)).toEqual({
        account: {
          id: COINBASE_USER_ID,
          email: COINBASE_ACCOUNT_EMAIL,
          displayName: "Coinbase Owner",
          role: "member",
          emailVerified: true,
          welcomeSeenAt: null,
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
        loginMethods: [
          {
            id: COINBASE_IDENTITY_ID,
            provider: "coinbase",
            providerEmail: COINBASE_PROVIDER_EMAIL,
            linkedAt: expect.any(String),
            isCurrentSession: true,
            isAvailable: false,
            unavailableReason: "provider_disabled",
            canRemove: false,
          },
        ],
      })
    }).pipe(Effect.scoped)
  )

  // it.live: the handler stamps from the live clock, so the wait below must be real time too.
  it.live("records the welcome-seen fact once and keeps the first timestamp", () =>
    Effect.gen(function* () {
      const { handler } = yield* makeAuthHandlerScoped
      yield* seedCoinbaseSession()
      const cookie = makeCookieHeader({ taxmaxi_session: COINBASE_SESSION_ID })

      const beforeResponse = yield* getRequest({ handler, path: "/auth/me", cookie })

      expect(beforeResponse.status).toBe(200)
      expect(yield* jsonBody(beforeResponse)).toMatchObject({
        account: { id: COINBASE_USER_ID, welcomeSeenAt: null },
      })

      const firstMarkResponse = yield* postRequest({ handler, path: "/auth/me/welcome", cookie })

      expect(firstMarkResponse.status).toBe(200)
      const firstMark = yield* jsonBody<AccountResponseBody>(firstMarkResponse)
      const { welcomeSeenAt, updatedAt } = firstMark.account

      expect(welcomeSeenAt).toEqual(expect.any(String))
      expect(welcomeSeenAt).toMatch(ISO_TIMESTAMP_PATTERN)
      expect(updatedAt).toBe(welcomeSeenAt)
      expect(firstMark.loginMethods).toHaveLength(1)

      // Let time move so a rewritten updatedAt would show up as a different value.
      yield* Effect.sleep("5 millis")

      const secondMarkResponse = yield* postRequest({ handler, path: "/auth/me/welcome", cookie })

      expect(secondMarkResponse.status).toBe(200)
      expect(yield* jsonBody(secondMarkResponse)).toMatchObject({
        account: { id: COINBASE_USER_ID, welcomeSeenAt, updatedAt },
      })

      const afterResponse = yield* getRequest({ handler, path: "/auth/me", cookie })

      expect(afterResponse.status).toBe(200)
      expect(yield* jsonBody(afterResponse)).toMatchObject({
        account: { id: COINBASE_USER_ID, welcomeSeenAt, updatedAt },
      })
    }).pipe(Effect.scoped)
  )

  it.effect("does not count unavailable identities as fallback login methods", () =>
    Effect.gen(function* () {
      const { handler } = yield* makeAuthHandlerScoped
      yield* seedMixedProviderSession()
      const cookie = makeCookieHeader({ taxmaxi_session: MIXED_PROVIDER_SESSION_ID })

      const accountResponse = yield* getRequest({
        handler,
        path: "/auth/me",
        cookie,
      })

      expect(accountResponse.status).toBe(200)
      expect(yield* jsonBody(accountResponse)).toMatchObject({
        loginMethods: expect.arrayContaining([
          expect.objectContaining({
            id: MIXED_PROVIDER_LOCAL_IDENTITY_ID,
            provider: "local",
            isCurrentSession: true,
            isAvailable: false,
            unavailableReason: "email_unverified",
            canRemove: false,
          }),
          expect.objectContaining({
            id: MIXED_PROVIDER_COINBASE_IDENTITY_ID,
            provider: "coinbase",
            isCurrentSession: false,
            isAvailable: false,
            unavailableReason: "provider_disabled",
            canRemove: false,
          }),
        ]),
      })

      const unlinkResponse = yield* deleteRequest({
        handler,
        path: `/auth/identities/${MIXED_PROVIDER_LOCAL_IDENTITY_ID}`,
        cookie,
      })

      expect(unlinkResponse.status).toBe(409)
      expect(yield* jsonBody(unlinkResponse)).toMatchObject({
        _tag: "CannotUnlinkLastIdentityError",
      })

      const unlinkCoinbaseResponse = yield* deleteRequest({
        handler,
        path: `/auth/identities/${MIXED_PROVIDER_COINBASE_IDENTITY_ID}`,
        cookie,
      })

      expect(unlinkCoinbaseResponse.status).toBe(409)
      expect(yield* jsonBody(unlinkCoinbaseResponse)).toMatchObject({
        _tag: "CannotUnlinkLastIdentityError",
      })
    }).pipe(Effect.scoped)
  )

  it.effect("invalidates the backend session and clears the session cookie on logout", () =>
    Effect.gen(function* () {
      const { handler } = yield* makeAuthHandlerScoped
      yield* seedCoinbaseSession()
      const cookie = makeCookieHeader({ taxmaxi_session: COINBASE_SESSION_ID })

      const logoutResponse = yield* postRequest({
        handler,
        path: "/auth/logout",
        cookie,
      })

      expect(logoutResponse.status).toBe(200)
      expect(yield* jsonBody(logoutResponse)).toEqual({ success: true })
      const clearedSessionCookie = getSetCookies(logoutResponse).find((setCookie) =>
        setCookie.startsWith("taxmaxi_session=")
      )
      expect(clearedSessionCookie).toContain("taxmaxi_session=;")
      expect(clearedSessionCookie).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT")
      expect(clearedSessionCookie).toContain("HttpOnly")
      expect(clearedSessionCookie).toContain("Path=/")

      const accountResponse = yield* getRequest({
        handler,
        path: "/auth/me",
        cookie,
      })

      expect(accountResponse.status).toBe(401)
    }).pipe(Effect.scoped)
  )

  it.effect(
    "registers, rotates the verification cookie on resend, rejects stale codes, and authenticates with the issued session cookie",
    () =>
      Effect.gen(function* () {
        const { handler, sentVerificationCodes } = yield* makeAuthHandlerScoped

        const email = `owner-${nextTestUuid()}@taxmaxi.test`
        const password = "password123"

        const registerResponse = yield* postJson({
          handler,
          path: "/auth/register",
          payload: {
            email,
            password,
            displayName: "Owner",
          },
        })

        expect(registerResponse.status).toBe(201)
        expect(yield* jsonBody(registerResponse)).toMatchObject({
          email,
          redirectTo: "/verify-email",
        })

        const firstSetCookies = getSetCookies(registerResponse)
        const firstVerificationRequestId = yield* Effect.sync(() =>
          getCookieValue({
            setCookies: firstSetCookies,
            name: "taxmaxi_verification",
          })
        )
        const firstCode = sentVerificationCodes[0]?.code

        expect(firstCode).toBeDefined()

        const resendResponse = yield* postJson({
          handler,
          path: "/auth/resend-verification",
          payload: {},
          cookie: makeCookieHeader({
            taxmaxi_verification: firstVerificationRequestId,
          }),
        })

        expect(resendResponse.status).toBe(200)
        expect(yield* jsonBody(resendResponse)).toMatchObject({
          email,
          redirectTo: "/verify-email",
        })

        const resendSetCookies = getSetCookies(resendResponse)
        const secondVerificationRequestId = yield* Effect.sync(() =>
          getCookieValue({
            setCookies: resendSetCookies,
            name: "taxmaxi_verification",
          })
        )
        const secondCode = sentVerificationCodes[1]?.code

        expect(secondVerificationRequestId).not.toBe(firstVerificationRequestId)
        expect(secondCode).toBeDefined()
        expect(secondCode).not.toBe(firstCode)

        const invalidVerifyResponse = yield* postJson({
          handler,
          path: "/auth/verify-email",
          payload: {
            code: firstCode,
          },
          cookie: makeCookieHeader({
            taxmaxi_verification: secondVerificationRequestId,
          }),
        })

        expect(invalidVerifyResponse.status).toBe(400)
        expect(yield* jsonBody(invalidVerifyResponse)).toMatchObject({
          message: "Verification code is invalid",
        })

        const verifyResponse = yield* postJson({
          handler,
          path: "/auth/verify-email",
          payload: {
            code: secondCode,
          },
          cookie: makeCookieHeader({
            taxmaxi_verification: secondVerificationRequestId,
          }),
        })

        expect(verifyResponse.status).toBe(200)
        expect(yield* jsonBody(verifyResponse)).toMatchObject({
          redirectTo: "/home",
        })

        const verifySetCookies = getSetCookies(verifyResponse)
        const sessionToken = yield* Effect.sync(() =>
          getCookieValue({
            setCookies: verifySetCookies,
            name: "taxmaxi_session",
          })
        )
        const clearedVerificationCookie = yield* Effect.sync(() =>
          getCookieValue({
            setCookies: verifySetCookies,
            name: "taxmaxi_verification",
          })
        )

        expect(sessionToken.length).toBeGreaterThanOrEqual(32)
        expect(clearedVerificationCookie).toBe("")

        const meResponse = yield* getRequest({
          handler,
          path: "/auth/me",
          cookie: makeCookieHeader({
            taxmaxi_session: sessionToken,
          }),
        })

        expect(meResponse.status).toBe(200)
        expect(yield* jsonBody(meResponse)).toEqual({
          account: {
            id: expect.any(String),
            email,
            displayName: "Owner",
            role: "member",
            emailVerified: true,
            welcomeSeenAt: null,
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
          },
          loginMethods: [
            {
              id: expect.any(String),
              provider: "local",
              providerEmail: null,
              linkedAt: expect.any(String),
              isCurrentSession: true,
              isAvailable: true,
              unavailableReason: null,
              canRemove: false,
            },
          ],
        })
      }).pipe(Effect.scoped)
  )

  it.effect("stores the canonical account email and accepts any casing of it for login", () =>
    Effect.gen(function* () {
      const { handler, sentVerificationCodes } = yield* makeAuthHandlerScoped

      const canonicalEmail = "max+tax@example.com"
      const password = "password123"

      const registerResponse = yield* postJson({
        handler,
        path: "/auth/register",
        payload: {
          email: "Max+Tax@Example.com ",
          password,
          displayName: "Max",
        },
      })

      expect(registerResponse.status).toBe(201)
      expect(yield* jsonBody(registerResponse)).toMatchObject({
        email: canonicalEmail,
        redirectTo: "/verify-email",
      })
      expect(sentVerificationCodes[0]?.email).toBe(canonicalEmail)

      const verificationRequestId = yield* Effect.sync(() =>
        getCookieValue({
          setCookies: getSetCookies(registerResponse),
          name: "taxmaxi_verification",
        })
      )

      const verifyResponse = yield* postJson({
        handler,
        path: "/auth/verify-email",
        payload: {
          code: sentVerificationCodes[0]?.code,
        },
        cookie: makeCookieHeader({
          taxmaxi_verification: verificationRequestId,
        }),
      })

      expect(verifyResponse.status).toBe(200)

      const verifiedSessionToken = yield* Effect.sync(() =>
        getCookieValue({
          setCookies: getSetCookies(verifyResponse),
          name: "taxmaxi_session",
        })
      )

      const meResponse = yield* getRequest({
        handler,
        path: "/auth/me",
        cookie: makeCookieHeader({
          taxmaxi_session: verifiedSessionToken,
        }),
      })

      expect(meResponse.status).toBe(200)
      expect(yield* jsonBody(meResponse)).toMatchObject({
        account: {
          email: canonicalEmail,
        },
      })
      expect(yield* readStoredAccountEmails()).toEqual([canonicalEmail])
      expect(yield* readStoredLocalProviderIds()).toEqual([canonicalEmail])

      const loginResponse = yield* postJson({
        handler,
        path: "/auth/login",
        payload: {
          provider: "local",
          credentials: {
            email: "MAX+TAX@EXAMPLE.COM",
            password,
          },
        },
      })

      expect(loginResponse.status).toBe(200)
      expect(yield* jsonBody(loginResponse)).toMatchObject({
        user: {
          email: canonicalEmail,
        },
      })

      const loginSessionToken = yield* Effect.sync(() =>
        getCookieValue({
          setCookies: getSetCookies(loginResponse),
          name: "taxmaxi_session",
        })
      )

      expect(loginSessionToken.length).toBeGreaterThanOrEqual(32)
      expect(loginSessionToken).not.toBe(verifiedSessionToken)
    }).pipe(Effect.scoped)
  )

  it.effect(
    "rejects a casing variant of a registered email as a conflict and creates nothing",
    () =>
      Effect.gen(function* () {
        const { handler } = yield* makeAuthHandlerScoped

        const canonicalEmail = "taken@taxmaxi.test"
        const password = "password123"

        const firstRegisterResponse = yield* postJson({
          handler,
          path: "/auth/register",
          payload: {
            email: canonicalEmail,
            password,
            displayName: "First",
          },
        })

        expect(firstRegisterResponse.status).toBe(201)

        const secondRegisterResponse = yield* postJson({
          handler,
          path: "/auth/register",
          payload: {
            email: "Taken@TaxMaxi.test",
            password,
            displayName: "Second",
          },
        })

        expect(secondRegisterResponse.status).toBe(409)
        expect(yield* jsonBody(secondRegisterResponse)).toMatchObject({
          _tag: "UserExistsError",
          email: canonicalEmail,
        })
        expect(yield* readStoredAccountEmails()).toEqual([canonicalEmail])
        expect(yield* readStoredLocalProviderIds()).toEqual([canonicalEmail])
      }).pipe(Effect.scoped)
  )

  it.effect(
    "returns EmailVerificationRequiredError on local login for an unverified user and restores the verification cookie",
    () =>
      Effect.gen(function* () {
        const { handler, sentVerificationCodes } = yield* makeAuthHandlerScoped

        const email = `pending-${nextTestUuid()}@taxmaxi.test`
        const password = "password123"

        const registerResponse = yield* postJson({
          handler,
          path: "/auth/register",
          payload: {
            email,
            password,
            displayName: "Pending User",
          },
        })

        expect(registerResponse.status).toBe(201)

        const registerVerificationRequestId = yield* Effect.sync(() =>
          getCookieValue({
            setCookies: getSetCookies(registerResponse),
            name: "taxmaxi_verification",
          })
        )
        const originalCode = sentVerificationCodes[0]?.code

        expect(originalCode).toBeDefined()

        sentVerificationCodes.length = 0

        const loginResponse = yield* postJson({
          handler,
          path: "/auth/login",
          payload: {
            provider: "local",
            credentials: {
              email,
              password,
            },
          },
        })

        expect(loginResponse.status).toBe(403)
        expect(yield* jsonBody(loginResponse)).toMatchObject({
          email,
          message: "Email verification is required before login",
        })

        const loginVerificationRequestId = yield* Effect.sync(() =>
          getCookieValue({
            setCookies: getSetCookies(loginResponse),
            name: "taxmaxi_verification",
          })
        )

        expect(loginVerificationRequestId).toBe(registerVerificationRequestId)
        expect(sentVerificationCodes).toHaveLength(1)
        expect(sentVerificationCodes[0]?.code).toBe(originalCode)
      }).pipe(Effect.scoped)
  )
})
