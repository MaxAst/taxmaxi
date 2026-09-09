import {
  AccountResponse,
  AuthorizeRedirectResponse,
  LocalLoginCredentials,
  LoginRequest,
  LoginResponse,
  LogoutResponse,
  OAuthSessionResponse,
  ProviderMetadata,
  ProvidersResponse,
  RegisterRequest,
  VerificationFlowResponse,
  VerifyEmailRequest,
  VerifyEmailResponse,
} from "@my/rest-api/contracts"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { TaxMaxiEffectClient } from "../client.ts"

type DecodedAccountResponse = AccountResponse

export type Account = {
  readonly account: {
    readonly id: string
    readonly email: string
    readonly displayName: string
    readonly role: DecodedAccountResponse["account"]["role"]
    readonly emailVerified: boolean
    /** ISO timestamp of the first welcome mark, or null while the welcome has not been seen. */
    readonly welcomeSeenAt: string | null
    readonly createdAt: string
    readonly updatedAt: string
  }
  readonly loginMethods: ReadonlyArray<{
    readonly id: string
    readonly provider: DecodedAccountResponse["loginMethods"][number]["provider"]
    readonly providerEmail: string | null
    readonly linkedAt: string
    readonly isCurrentSession: boolean
    readonly isAvailable: boolean
    readonly unavailableReason: DecodedAccountResponse["loginMethods"][number]["unavailableReason"]
    readonly canRemove: boolean
  }>
}
export type AuthLogoutResponse = Schema.Codec.Encoded<typeof LogoutResponse>
export type AuthAuthorizeRedirectResponse = AuthorizeRedirectResponse
export type AuthOAuthSessionResponse = OAuthSessionResponse

/** Capability flags of one enabled login provider; carries no display text. */
export type AuthProvider = Schema.Codec.Encoded<typeof ProviderMetadata>
/** The providers the API has enabled, in the order it lists them. */
export type AuthProviders = Schema.Codec.Encoded<typeof ProvidersResponse>
/** Email, password, and an optional display name for a new local account. */
export type AuthRegisterInput = Schema.Codec.Encoded<typeof RegisterRequest>
/** Where the browser goes next while a verification code is pending. */
export type AuthVerificationFlow = Schema.Codec.Encoded<typeof VerificationFlowResponse>
/** The emailed code, eight uppercase letters or digits, as the API expects it. */
export type AuthVerifyEmailInput = Schema.Codec.Encoded<typeof VerifyEmailRequest>
/** Where the browser goes after the session is created. */
export type AuthVerifyEmailResponse = Schema.Codec.Encoded<typeof VerifyEmailResponse>
/** Email and password for a local login. */
export type AuthLocalLoginInput = Schema.Codec.Encoded<typeof LocalLoginCredentials>
type EncodedLoginResponse = Schema.Codec.Encoded<typeof LoginResponse>
export type AuthLoginResponse = Omit<EncodedLoginResponse, "expiresAt"> & {
  /** ISO timestamp when the session expires. */
  readonly expiresAt: string
}

export type AuthEffectResource = {
  readonly account: () => Effect.Effect<Account, unknown, never>
  /**
   * Record that the current user finished or skipped the welcome.
   *
   * The server stamps `welcomeSeenAt` once; a second call keeps the first timestamp.
   */
  readonly markWelcomeSeen: () => Effect.Effect<Account, unknown, never>
  readonly logout: () => Effect.Effect<AuthLogoutResponse, unknown, never>
  /** List the login providers the API has enabled, with their capability flags. */
  readonly providers: () => Effect.Effect<AuthProviders, unknown, never>
  /**
   * Create a local account and start email verification.
   *
   * The API sets the verification cookie on its own origin; browser callers
   * need `credentials: "include"` (`TaxMaxi.fromBrowserSession`) so the cookie
   * reaches `verifyEmail` and `resendVerification`.
   */
  readonly register: (
    input: AuthRegisterInput
  ) => Effect.Effect<AuthVerificationFlow, unknown, never>
  /** Submit the emailed code; on success the API creates the session. */
  readonly verifyEmail: (
    input: AuthVerifyEmailInput
  ) => Effect.Effect<AuthVerifyEmailResponse, unknown, never>
  /** Ask for a fresh code; refused with 429 inside the cooldown or past the send cap. */
  readonly resendVerification: () => Effect.Effect<AuthVerificationFlow, unknown, never>
  /** Log in with email and password through the local provider. */
  readonly login: (input: AuthLocalLoginInput) => Effect.Effect<AuthLoginResponse, unknown, never>
}

export type AuthPromiseResource = {
  readonly account: () => Promise<Account>
  readonly markWelcomeSeen: () => Promise<Account>
  readonly logout: () => Promise<AuthLogoutResponse>
  readonly providers: () => Promise<AuthProviders>
  readonly register: (input: AuthRegisterInput) => Promise<AuthVerificationFlow>
  readonly verifyEmail: (input: AuthVerifyEmailInput) => Promise<AuthVerifyEmailResponse>
  readonly resendVerification: () => Promise<AuthVerificationFlow>
  readonly login: (input: AuthLocalLoginInput) => Promise<AuthLoginResponse>
}

const encodeAccount = (response: DecodedAccountResponse): Account => ({
  account: {
    ...response.account,
    welcomeSeenAt:
      response.account.welcomeSeenAt === null
        ? null
        : DateTime.formatIso(response.account.welcomeSeenAt),
    createdAt: DateTime.formatIso(response.account.createdAt),
    updatedAt: DateTime.formatIso(response.account.updatedAt),
  },
  loginMethods: response.loginMethods.map((loginMethod) => ({
    ...loginMethod,
    linkedAt: DateTime.formatIso(loginMethod.linkedAt),
  })),
})

const encodeLogout = Schema.encodeSync(LogoutResponse)
const encodeProviders = Schema.encodeSync(ProvidersResponse)
const encodeVerificationFlow = Schema.encodeSync(VerificationFlowResponse)
const encodeVerifyEmail = Schema.encodeSync(VerifyEmailResponse)
const encodeLoginResponse = Schema.encodeSync(LoginResponse)

const encodeLogin = (response: LoginResponse): AuthLoginResponse => ({
  ...encodeLoginResponse(response),
  expiresAt: DateTime.formatIso(response.expiresAt),
})

// The same payload schemas the endpoints declare, so a malformed email or code
// fails here with a schema error instead of reaching the API.
const decodeRegisterPayload = Schema.decodeEffect(Schema.Struct(RegisterRequest.fields))
const decodeVerifyEmailPayload = Schema.decodeEffect(Schema.Struct(VerifyEmailRequest.fields))
// The local member of the login union; the generated client takes one member at a time.
const decodeLocalLoginPayload = Schema.decodeEffect(LoginRequest.members[0])

export const makeAuthEffectResource = (
  client: Effect.Effect<TaxMaxiEffectClient, never>
): AuthEffectResource => ({
  account: () =>
    Effect.map(
      Effect.flatMap(client, (resolved) => resolved.authSession.me(undefined)),
      encodeAccount
    ),
  markWelcomeSeen: () =>
    Effect.map(
      Effect.flatMap(client, (resolved) => resolved.authSession.markWelcomeSeen(undefined)),
      encodeAccount
    ),
  logout: () =>
    Effect.map(
      Effect.flatMap(client, (resolved) => resolved.authSession.logout(undefined)),
      encodeLogout
    ),
  providers: () =>
    Effect.map(
      Effect.flatMap(client, (resolved) => resolved.auth.getProviders(undefined)),
      encodeProviders
    ),
  register: (input) =>
    Effect.gen(function* () {
      const payload = yield* decodeRegisterPayload(input)
      const resolved = yield* client
      return encodeVerificationFlow(yield* resolved.auth.register({ payload }))
    }),
  verifyEmail: (input) =>
    Effect.gen(function* () {
      const payload = yield* decodeVerifyEmailPayload(input)
      const resolved = yield* client
      return encodeVerifyEmail(yield* resolved.auth.verifyEmail({ payload }))
    }),
  resendVerification: () =>
    Effect.map(
      Effect.flatMap(client, (resolved) => resolved.auth.resendVerification(undefined)),
      encodeVerificationFlow
    ),
  login: (credentials) =>
    Effect.gen(function* () {
      const payload = yield* decodeLocalLoginPayload({ provider: "local", credentials })
      const resolved = yield* client
      return encodeLogin(yield* resolved.auth.login({ payload }))
    }),
})

export const makeAuthPromiseResource = (
  effect: AuthEffectResource,
  run: <A>(effect: Effect.Effect<A, unknown, never>) => Promise<A>
): AuthPromiseResource => ({
  account: () => run(effect.account()),
  markWelcomeSeen: () => run(effect.markWelcomeSeen()),
  logout: () => run(effect.logout()),
  providers: () => run(effect.providers()),
  register: (input) => run(effect.register(input)),
  verifyEmail: (input) => run(effect.verifyEmail(input)),
  resendVerification: () => run(effect.resendVerification()),
  login: (input) => run(effect.login(input)),
})
