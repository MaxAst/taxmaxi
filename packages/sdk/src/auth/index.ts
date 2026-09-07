import {
  AccountResponse,
  AuthorizeRedirectResponse,
  LogoutResponse,
  OAuthSessionResponse,
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

export type AuthEffectResource = {
  readonly account: () => Effect.Effect<Account, unknown, never>
  /**
   * Record that the current user finished or skipped the welcome.
   *
   * The server stamps `welcomeSeenAt` once; a second call keeps the first timestamp.
   */
  readonly markWelcomeSeen: () => Effect.Effect<Account, unknown, never>
  readonly logout: () => Effect.Effect<AuthLogoutResponse, unknown, never>
}

export type AuthPromiseResource = {
  readonly account: () => Promise<Account>
  readonly markWelcomeSeen: () => Promise<Account>
  readonly logout: () => Promise<AuthLogoutResponse>
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
})

export const makeAuthPromiseResource = (
  effect: AuthEffectResource,
  run: <A>(effect: Effect.Effect<A, unknown, never>) => Promise<A>
): AuthPromiseResource => ({
  account: () => run(effect.account()),
  markWelcomeSeen: () => run(effect.markWelcomeSeen()),
  logout: () => run(effect.logout()),
})
