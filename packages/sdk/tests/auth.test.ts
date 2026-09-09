import { describe, expect, it } from "@effect/vitest"
import { AuthApi } from "@my/rest-api/contracts"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { resolveAt } from "effect/SchemaAST"
import {
  TaxMaxi,
  TaxMaxiError,
  getTaxMaxiPasswordRequirements,
  getTaxMaxiRetryAfterSeconds,
  isTaxMaxiEmailVerificationRequiredError,
  toTaxMaxiError,
  type AuthLoginResponse,
  type AuthProviders,
  type AuthVerificationFlow,
} from "../src/index.ts"

const BASE_URL = "https://sdk.example.test"

const PROVIDERS = {
  providers: [
    {
      type: "local",
      supportsRegistration: true,
      supportsPasswordLogin: true,
      oauthEnabled: false,
      supportsLinking: false,
    },
    {
      type: "coinbase",
      supportsRegistration: true,
      supportsPasswordLogin: false,
      oauthEnabled: true,
      supportsLinking: true,
    },
  ],
} as const satisfies AuthProviders

const VERIFICATION_FLOW = {
  email: "max@example.com",
  redirectTo: "/verify-email",
} as const satisfies AuthVerificationFlow

const LOGIN = {
  token: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEF",
  user: {
    id: "00000000-0000-4000-8000-000000000101",
    email: "max@example.com",
    displayName: "max",
    role: "member",
    primaryProvider: "local",
    emailVerified: true,
    welcomeSeenAt: null,
    createdAt: { epochMillis: 1_788_264_000_000 },
    updatedAt: { epochMillis: 1_788_264_000_000 },
  },
  provider: "local",
  expiresAt: "2026-09-08T12:00:00.000Z",
} as const satisfies AuthLoginResponse

const PASSWORD_WEAK_BODY = {
  _tag: "PasswordWeakError",
  message: "Password does not meet requirements",
  requirements: ["min_length", "number"],
  minPasswordLength: 8,
} as const

const VERIFICATION_REQUIRED_BODY = {
  _tag: "EmailVerificationRequiredError",
  email: "max@example.com",
  message: "Email verification is required before login",
} as const

const RESEND_LIMITED_BODY = {
  _tag: "VerificationResendRateLimitedError",
  retryAfterSeconds: 42,
} as const

const USER_EXISTS_BODY = {
  _tag: "UserExistsError",
  email: "max@example.com",
  message: "A user with this email already exists",
} as const

const CODE_EXPIRED_BODY = {
  _tag: "EmailVerificationCodeExpiredError",
  message: "Verification code has expired",
} as const

// One sample response per error the local-auth endpoints declare, as the API
// sends it. The declared-status test below walks the endpoint contracts, so
// an error added to one of them fails that test until a response is added.
const DECLARED_ERROR_RESPONSES: ReadonlyArray<{
  readonly status: number
  readonly body: { readonly _tag: string; readonly [field: string]: unknown }
}> = [
  { status: 400, body: { _tag: "AuthValidationError", message: "Invalid email", field: "email" } },
  { status: 400, body: PASSWORD_WEAK_BODY },
  { status: 409, body: USER_EXISTS_BODY },
  { status: 500, body: { _tag: "InternalServerError", message: "boom", requestId: null } },
  { status: 400, body: { _tag: "EmailVerificationFlowMissingError", message: "No flow" } },
  { status: 400, body: { _tag: "EmailVerificationCodeInvalidError", message: "Invalid code" } },
  { status: 400, body: CODE_EXPIRED_BODY },
  { status: 429, body: RESEND_LIMITED_BODY },
  { status: 401, body: { _tag: "AuthUnauthorizedError", message: "Invalid credentials" } },
  { status: 403, body: VERIFICATION_REQUIRED_BODY },
  { status: 401, body: { _tag: "ProviderAuthError", provider: "coinbase", reason: "refused" } },
  { status: 404, body: { _tag: "ProviderNotFoundError", provider: "coinbase", message: "Off" } },
  { status: 400, body: { _tag: "OAuthStateInvalidError", provider: "coinbase", message: "Bad" } },
]

const LOCAL_AUTH_INPUT = { email: "max@example.com", password: "kNmGP3sW_ygVLdcNVbxU" }

const LOCAL_AUTH_ENDPOINTS = [
  "getProviders",
  "register",
  "verifyEmail",
  "resendVerification",
  "login",
] as const

// The SDK method behind each local-auth endpoint, called through the Promise API.
const CALL_LOCAL_AUTH_ENDPOINT: Record<
  (typeof LOCAL_AUTH_ENDPOINTS)[number],
  (client: TaxMaxi) => Promise<unknown>
> = {
  getProviders: (client) => client.auth.providers(),
  register: (client) => client.auth.register(LOCAL_AUTH_INPUT),
  verifyEmail: (client) => client.auth.verifyEmail({ code: "ABCD1234" }),
  resendVerification: (client) => client.auth.resendVerification(),
  login: (client) => client.auth.login(LOCAL_AUTH_INPUT),
}

type CapturedRequest = {
  readonly method: string
  readonly url: string
  readonly body: unknown
  readonly credentials: string | undefined
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

const makeFetch =
  ({
    body,
    status = 200,
    requests,
  }: {
    readonly body: unknown
    readonly status?: number
    readonly requests: Array<CapturedRequest>
  }): typeof globalThis.fetch =>
  (input, init) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const rawBody =
          init?.body === undefined || init.body === null
            ? undefined
            : yield* Effect.promise(() => new Response(init.body).text())
        requests.push({
          method:
            typeof input === "string" || input instanceof URL
              ? (init?.method ?? "GET")
              : input.method,
          url: input instanceof Request ? input.url : String(input),
          body: rawBody === undefined || rawBody === "" ? undefined : decodeJson(rawBody),
          credentials: init?.credentials === undefined ? undefined : String(init.credentials),
        })

        return new Response(encodeJson(body), {
          status,
          headers: { "Content-Type": "application/json" },
        })
      })
    )

const makeBrowserClient = (options: {
  readonly body: unknown
  readonly status?: number
  readonly requests: Array<CapturedRequest>
}) => TaxMaxi.fromBrowserSession({ baseUrl: BASE_URL, fetch: makeFetch(options) })

const rejectionOf = (promise: Promise<unknown>): Effect.Effect<unknown> =>
  Effect.promise(() => promise.then(() => undefined).catch((error: unknown) => error))

describe("auth SDK local auth", () => {
  it.effect("lists providers with GET /auth/providers in both SDK styles", () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const client = makeBrowserClient({ body: PROVIDERS, requests })

      expect(yield* client.effect.auth.providers()).toEqual(PROVIDERS)
      expect(yield* Effect.promise(() => client.auth.providers())).toEqual(PROVIDERS)

      expect(requests).toEqual([
        {
          method: "GET",
          url: `${BASE_URL}/auth/providers`,
          body: undefined,
          credentials: "include",
        },
        {
          method: "GET",
          url: `${BASE_URL}/auth/providers`,
          body: undefined,
          credentials: "include",
        },
      ])
    })
  )

  it.effect("registers with POST /auth/register and a JSON body in both SDK styles", () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const client = makeBrowserClient({ body: VERIFICATION_FLOW, status: 201, requests })
      const input = { email: "Max@Example.com", password: "kNmGP3sW_ygVLdcNVbxU" }

      expect(yield* client.effect.auth.register(input)).toEqual(VERIFICATION_FLOW)
      expect(
        yield* Effect.promise(() => client.auth.register({ ...input, displayName: "Max" }))
      ).toEqual(VERIFICATION_FLOW)

      expect(requests).toEqual([
        {
          method: "POST",
          url: `${BASE_URL}/auth/register`,
          body: input,
          credentials: "include",
        },
        {
          method: "POST",
          url: `${BASE_URL}/auth/register`,
          body: { ...input, displayName: "Max" },
          credentials: "include",
        },
      ])
    })
  )

  it.effect("verifies with POST /auth/verify-email carrying the code in both SDK styles", () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const client = makeBrowserClient({ body: { redirectTo: "/app" }, requests })

      expect(yield* client.effect.auth.verifyEmail({ code: "ABCD1234" })).toEqual({
        redirectTo: "/app",
      })
      expect(yield* Effect.promise(() => client.auth.verifyEmail({ code: "ABCD1234" }))).toEqual({
        redirectTo: "/app",
      })

      expect(requests).toEqual([
        {
          method: "POST",
          url: `${BASE_URL}/auth/verify-email`,
          body: { code: "ABCD1234" },
          credentials: "include",
        },
        {
          method: "POST",
          url: `${BASE_URL}/auth/verify-email`,
          body: { code: "ABCD1234" },
          credentials: "include",
        },
      ])
    })
  )

  it.effect("resends with POST /auth/resend-verification and no body in both SDK styles", () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const client = makeBrowserClient({ body: VERIFICATION_FLOW, requests })

      expect(yield* client.effect.auth.resendVerification()).toEqual(VERIFICATION_FLOW)
      expect(yield* Effect.promise(() => client.auth.resendVerification())).toEqual(
        VERIFICATION_FLOW
      )

      expect(requests).toEqual([
        {
          method: "POST",
          url: `${BASE_URL}/auth/resend-verification`,
          body: undefined,
          credentials: "include",
        },
        {
          method: "POST",
          url: `${BASE_URL}/auth/resend-verification`,
          body: undefined,
          credentials: "include",
        },
      ])
    })
  )

  it.effect("logs in with POST /auth/login wrapping local credentials in both SDK styles", () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const client = makeBrowserClient({ body: LOGIN, requests })
      const credentials = { email: "max@example.com", password: "kNmGP3sW_ygVLdcNVbxU" }

      expect(yield* client.effect.auth.login(credentials)).toEqual(LOGIN)
      expect(yield* Effect.promise(() => client.auth.login(credentials))).toEqual(LOGIN)

      expect(requests).toEqual([
        {
          method: "POST",
          url: `${BASE_URL}/auth/login`,
          body: { provider: "local", credentials },
          credentials: "include",
        },
        {
          method: "POST",
          url: `${BASE_URL}/auth/login`,
          body: { provider: "local", credentials },
          credentials: "include",
        },
      ])
    })
  )

  it.effect("rejects a malformed email or code before sending a request", () =>
    Effect.gen(function* () {
      const requests: Array<CapturedRequest> = []
      const client = makeBrowserClient({ body: VERIFICATION_FLOW, requests })

      const registerError = yield* client.effect.auth
        .register({ email: "not-an-email", password: "kNmGP3sW_ygVLdcNVbxU" })
        .pipe(Effect.flip)
      expect(Schema.isSchemaError(registerError)).toBe(true)

      const loginError = yield* client.effect.auth
        .login({ email: "not-an-email", password: "kNmGP3sW_ygVLdcNVbxU" })
        .pipe(Effect.flip)
      expect(Schema.isSchemaError(loginError)).toBe(true)

      const verifyError = yield* client.effect.auth
        .verifyEmail({ code: "too-short" })
        .pipe(Effect.flip)
      expect(Schema.isSchemaError(verifyError)).toBe(true)

      expect(requests).toHaveLength(0)
    })
  )
})

describe("auth SDK error helpers", () => {
  it.effect("reads the password rule codes and minimum length from a 400 register refusal", () =>
    Effect.gen(function* () {
      const client = makeBrowserClient({ body: PASSWORD_WEAK_BODY, status: 400, requests: [] })
      const input = { email: "max@example.com", password: "short" }

      const effectError = yield* client.effect.auth.register(input).pipe(Effect.flip)
      expect(getTaxMaxiPasswordRequirements(effectError)).toEqual({
        requirements: ["min_length", "number"],
        minPasswordLength: 8,
      })

      const promiseError = yield* rejectionOf(client.auth.register(input))
      expect(Schema.is(TaxMaxiError)(promiseError)).toBe(true)
      expect(promiseError).toMatchObject({ status: 400, code: "PasswordWeakError" })
      expect(getTaxMaxiPasswordRequirements(promiseError)).toEqual({
        requirements: ["min_length", "number"],
        minPasswordLength: 8,
      })
    })
  )

  it.effect("recognizes the 403 verification-required login refusal", () =>
    Effect.gen(function* () {
      const client = makeBrowserClient({
        body: VERIFICATION_REQUIRED_BODY,
        status: 403,
        requests: [],
      })
      const credentials = { email: "max@example.com", password: "kNmGP3sW_ygVLdcNVbxU" }

      const effectError = yield* client.effect.auth.login(credentials).pipe(Effect.flip)
      expect(isTaxMaxiEmailVerificationRequiredError(effectError)).toBe(true)

      const promiseError = yield* rejectionOf(client.auth.login(credentials))
      expect(promiseError).toMatchObject({ status: 403, code: "EmailVerificationRequiredError" })
      expect(isTaxMaxiEmailVerificationRequiredError(promiseError)).toBe(true)
    })
  )

  it.effect("reads retryAfterSeconds from a 429 resend refusal", () =>
    Effect.gen(function* () {
      const client = makeBrowserClient({ body: RESEND_LIMITED_BODY, status: 429, requests: [] })

      const effectError = yield* client.effect.auth.resendVerification().pipe(Effect.flip)
      expect(getTaxMaxiRetryAfterSeconds(effectError)).toBe(42)

      const promiseError = yield* rejectionOf(client.auth.resendVerification())
      expect(promiseError).toMatchObject({
        status: 429,
        code: "VerificationResendRateLimitedError",
      })
      expect(getTaxMaxiRetryAfterSeconds(promiseError)).toBe(42)
    })
  )

  it.effect("rejects a 409 UserExistsError register refusal with its declared status", () =>
    Effect.gen(function* () {
      const client = makeBrowserClient({ body: USER_EXISTS_BODY, status: 409, requests: [] })
      const input = { email: "max@example.com", password: "kNmGP3sW_ygVLdcNVbxU" }

      const effectError = yield* client.effect.auth.register(input).pipe(Effect.flip)
      expect(effectError).toMatchObject({ _tag: "UserExistsError", email: "max@example.com" })

      const promiseError = yield* rejectionOf(client.auth.register(input))
      expect(Schema.is(TaxMaxiError)(promiseError)).toBe(true)
      expect(promiseError).toMatchObject({ status: 409, code: "UserExistsError" })
    })
  )

  it.effect(
    "rejects a 400 EmailVerificationCodeExpiredError verify refusal with its declared status",
    () =>
      Effect.gen(function* () {
        const client = makeBrowserClient({ body: CODE_EXPIRED_BODY, status: 400, requests: [] })

        const effectError = yield* client.effect.auth
          .verifyEmail({ code: "ABCD1234" })
          .pipe(Effect.flip)
        expect(effectError).toMatchObject({ _tag: "EmailVerificationCodeExpiredError" })

        const promiseError = yield* rejectionOf(client.auth.verifyEmail({ code: "ABCD1234" }))
        expect(Schema.is(TaxMaxiError)(promiseError)).toBe(true)
        expect(promiseError).toMatchObject({
          status: 400,
          code: "EmailVerificationCodeExpiredError",
        })
      })
  )

  it.effect("maps every error declared on the local-auth endpoints to its declared status", () =>
    Effect.gen(function* () {
      for (const name of LOCAL_AUTH_ENDPOINTS) {
        const call = CALL_LOCAL_AUTH_ENDPOINT[name]

        for (const errorSchema of AuthApi.endpoints[name].error) {
          const errorName = resolveAt<string>("identifier")(errorSchema.ast) ?? "unnamed error"
          const declaredStatus = resolveAt<number>("httpApiStatus")(errorSchema.ast)
          const matches: Array<{ readonly status: number; readonly code: string }> = []

          for (const response of DECLARED_ERROR_RESPONSES) {
            const client = makeBrowserClient({ ...response, requests: [] })
            const promiseError = yield* rejectionOf(call(client))

            // The generated client decodes the body into the declared class;
            // the Promise API keeps that instance as `cause`.
            if (
              Schema.is(TaxMaxiError)(promiseError) &&
              Schema.is(errorSchema)(promiseError.cause)
            ) {
              matches.push({ status: promiseError.status, code: promiseError.code ?? "" })
              expect(promiseError.status, `${name}: ${errorName}`).toBe(response.status)
              // A plain body, as a caller may hand it in, maps the same way.
              expect(toTaxMaxiError(response.body), `${name}: ${errorName}`).toMatchObject({
                status: response.status,
                code: response.body._tag,
              })
            }
          }

          // A declared error no sample response reaches is one these tests
          // do not know yet; the name says which response (and helper) to add.
          expect(matches, `${name}: no sample response for ${errorName}`).toHaveLength(1)
          expect(matches[0], `${name}: ${errorName}`).toEqual({
            status: declaredStatus,
            code: errorName,
          })
        }
      }
    })
  )

  it("reads the raw error bodies with and without the TaxMaxiError wrapper", () => {
    expect(getTaxMaxiPasswordRequirements(PASSWORD_WEAK_BODY)).toEqual({
      requirements: ["min_length", "number"],
      minPasswordLength: 8,
    })
    expect(getTaxMaxiPasswordRequirements(toTaxMaxiError(PASSWORD_WEAK_BODY))).toEqual({
      requirements: ["min_length", "number"],
      minPasswordLength: 8,
    })
    expect(isTaxMaxiEmailVerificationRequiredError(VERIFICATION_REQUIRED_BODY)).toBe(true)
    expect(
      isTaxMaxiEmailVerificationRequiredError(toTaxMaxiError(VERIFICATION_REQUIRED_BODY))
    ).toBe(true)
    expect(getTaxMaxiRetryAfterSeconds(RESEND_LIMITED_BODY)).toBe(42)
    expect(getTaxMaxiRetryAfterSeconds(toTaxMaxiError(RESEND_LIMITED_BODY))).toBe(42)
  })

  it("returns null or false for unrelated errors", () => {
    const unrelated = toTaxMaxiError({ _tag: "UserExistsError", email: "max@example.com" })

    expect(getTaxMaxiPasswordRequirements(unrelated)).toBeNull()
    expect(getTaxMaxiPasswordRequirements(new Error("boom"))).toBeNull()
    expect(getTaxMaxiPasswordRequirements(null)).toBeNull()
    expect(isTaxMaxiEmailVerificationRequiredError(unrelated)).toBe(false)
    expect(isTaxMaxiEmailVerificationRequiredError(new Error("boom"))).toBe(false)
    expect(isTaxMaxiEmailVerificationRequiredError(null)).toBe(false)
    expect(getTaxMaxiRetryAfterSeconds(unrelated)).toBeNull()
    expect(getTaxMaxiRetryAfterSeconds(new Error("boom"))).toBeNull()
    expect(getTaxMaxiRetryAfterSeconds(null)).toBeNull()
  })
})
