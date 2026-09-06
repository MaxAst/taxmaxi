import { TaxMaxiApi } from "@my/rest-api/contracts"
import * as Effect from "effect/Effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"

export const DEFAULT_BASE_URL = "https://api.taxmaxi.com"

export type TaxMaxiHeaders = Readonly<Record<string, string>>

export type TaxMaxiHeadersProvider = TaxMaxiHeaders | (() => TaxMaxiHeaders)

export type TaxMaxiRequestCredentials = "include" | "omit" | "same-origin"

export interface TaxMaxiOptions {
  readonly apiKey: string
  readonly baseUrl?: string | URL
  readonly fetch?: typeof globalThis.fetch
  readonly headers?: TaxMaxiHeadersProvider
}

export interface TaxMaxiEffectClientOptions {
  readonly apiKey?: string
  readonly baseUrl?: string | URL
  readonly credentials?: TaxMaxiRequestCredentials
  readonly fetch?: typeof globalThis.fetch
  readonly headers?: TaxMaxiHeadersProvider
}

export interface TaxMaxiBrowserSessionOptions {
  readonly baseUrl?: string | URL
  readonly credentials?: TaxMaxiRequestCredentials
  readonly fetch?: typeof globalThis.fetch
  readonly headers?: TaxMaxiHeadersProvider
}

export interface TaxMaxiRequestOptions {
  readonly baseUrl?: string | URL
  readonly cookieHeader: string
  readonly fetch?: typeof globalThis.fetch
  readonly headers?: TaxMaxiHeadersProvider
}

export const normalizeBaseUrl = (baseUrl: string | URL = DEFAULT_BASE_URL): string => {
  const url = typeof baseUrl === "string" ? new URL(baseUrl) : new URL(baseUrl.href)
  url.hash = ""
  url.search = ""

  const value = url.toString()
  return value.endsWith("/") ? value.slice(0, -1) : value
}

export const resolveHeaders = (headers: TaxMaxiHeadersProvider | undefined): TaxMaxiHeaders =>
  typeof headers === "function" ? headers() : (headers ?? {})

export const makeTaxMaxiHttpClientTransform =
  ({ apiKey, headers }: Pick<TaxMaxiEffectClientOptions, "apiKey" | "headers"> = {}) =>
  (httpClient: HttpClient.HttpClient): HttpClient.HttpClient =>
    httpClient.pipe(
      HttpClient.mapRequest((request) => {
        const requestWithHeaders = HttpClientRequest.setHeaders(resolveHeaders(headers))(request)

        if (apiKey === undefined || apiKey === "") {
          return requestWithHeaders
        }

        return HttpClientRequest.bearerToken(apiKey)(requestWithHeaders)
      })
    )

type TaxMaxiApiFullClient = HttpApiClient.ForApi<typeof TaxMaxiApi>

type TaxMaxiPublicGroup =
  | "adminProtocolReview"
  | "anon"
  | "assetOverrides"
  | "assets"
  | "auth"
  | "authSession"
  | "billing"
  | "coinbaseCompat"
  | "health"
  | "legalReferences"
  | "portfolio"
  | "sources"
  | "transactions"
  | "transactionOverrides"

export type TaxMaxiEffectClient = Pick<
  TaxMaxiApiFullClient,
  Extract<keyof TaxMaxiApiFullClient, TaxMaxiPublicGroup>
>

const toTaxMaxiEffectClient = (client: TaxMaxiApiFullClient): TaxMaxiEffectClient => ({
  adminProtocolReview: client.adminProtocolReview,
  anon: client.anon,
  assetOverrides: client.assetOverrides,
  assets: client.assets,
  auth: client.auth,
  authSession: client.authSession,
  billing: client.billing,
  coinbaseCompat: client.coinbaseCompat,
  health: client.health,
  legalReferences: client.legalReferences,
  portfolio: client.portfolio,
  sources: client.sources,
  transactions: client.transactions,
  transactionOverrides: client.transactionOverrides,
})

export const makeTaxMaxiEffectClient = (
  options: TaxMaxiEffectClientOptions = {}
): Effect.Effect<TaxMaxiEffectClient, never> => {
  const client = HttpApiClient.make(TaxMaxiApi, {
    baseUrl: normalizeBaseUrl(options.baseUrl),
    transformClient: makeTaxMaxiHttpClientTransform(options),
  }).pipe(Effect.provide(FetchHttpClient.layer))

  const clientWithFetch =
    options.fetch === undefined
      ? client
      : client.pipe(Effect.provideService(FetchHttpClient.Fetch, options.fetch))

  const configuredClient =
    options.credentials === undefined
      ? clientWithFetch
      : clientWithFetch.pipe(
          Effect.provideService(FetchHttpClient.RequestInit, {
            credentials: options.credentials,
          })
        )

  return configuredClient.pipe(Effect.map(toTaxMaxiEffectClient))
}
