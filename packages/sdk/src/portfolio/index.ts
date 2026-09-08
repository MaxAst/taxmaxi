import {
  PortfolioAssetsResponse,
  PortfolioCalculationStatusQuery,
  PortfolioCalculationStatusResponse,
} from "@my/rest-api/contracts"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { TaxMaxiEffectClient } from "../client.ts"

export type PortfolioAssets = Schema.Codec.Encoded<typeof PortfolioAssetsResponse>

export interface PortfolioAssetsInput {
  readonly sourceId?: string
  readonly currency?: string
}

/** Selected-year work and coverage; compare active run IDs before joining other results. */
export type PortfolioCalculationStatus = Schema.Codec.Encoded<
  typeof PortfolioCalculationStatusResponse
>

export interface PortfolioCalculationStatusInput {
  readonly taxYear: number
  readonly sourceJobId?: string
}

/** Retains the route's typed failures in the Effect error channel. */
export type PortfolioCalculationStatusError = Effect.Error<
  ReturnType<TaxMaxiEffectClient["portfolio"]["getCalculationStatus"]>
>

export interface PortfolioEffectResource {
  readonly getCalculationStatus: (
    input: PortfolioCalculationStatusInput
  ) => Effect.Effect<PortfolioCalculationStatus, PortfolioCalculationStatusError>
  readonly listAssets: (
    input?: PortfolioAssetsInput
  ) => Effect.Effect<PortfolioAssets, unknown, never>
}

export interface PortfolioPromiseResource {
  readonly getCalculationStatus: (
    input: PortfolioCalculationStatusInput
  ) => Promise<PortfolioCalculationStatus>
  readonly listAssets: (input?: PortfolioAssetsInput) => Promise<PortfolioAssets>
}

const encodeCalculationStatus = Schema.encodeSync(PortfolioCalculationStatusResponse)

const encodePortfolioAssets = Schema.encodeSync(PortfolioAssetsResponse)

export const makePortfolioEffectResource = (
  client: Effect.Effect<TaxMaxiEffectClient, never>
): PortfolioEffectResource => ({
  getCalculationStatus: ({ taxYear, sourceJobId }) =>
    Effect.gen(function* () {
      const query = yield* Schema.decodeEffect(PortfolioCalculationStatusQuery)({
        taxYear: String(taxYear),
        sourceJobId,
      })
      const resolved = yield* client
      return encodeCalculationStatus(yield* resolved.portfolio.getCalculationStatus({ query }))
    }),
  listAssets: (input = {}) =>
    Effect.map(
      Effect.flatMap(client, (resolved) =>
        resolved.portfolio.listPortfolioAssets({
          query: {
            sourceId: input.sourceId,
            currency: input.currency?.toLowerCase(),
          },
        })
      ),
      encodePortfolioAssets
    ),
})

export const makePortfolioPromiseResource = (
  effect: PortfolioEffectResource,
  run: <A>(effect: Effect.Effect<A, unknown, never>) => Promise<A>
): PortfolioPromiseResource => ({
  getCalculationStatus: (input) => run(effect.getCalculationStatus(input)),
  listAssets: (input) => run(effect.listAssets(input)),
})
