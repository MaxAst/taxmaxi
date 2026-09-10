/** PortfolioApiLive - Current user portfolio handlers. */

import { HttpApiBuilder } from "effect/unstable/httpapi"
import { JurisdictionCode, TaxYear } from "@my/core/accounting"
import { EUR } from "@my/core/currency"
import { SourceId } from "@my/core/source"
import {
  CalculationRunRepository,
  PortfolioRepository,
  type PortfolioAssetPosition,
} from "@my/persistence/services"
import * as BigDecimal from "effect/BigDecimal"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { InternalServerError } from "../definitions/ApiErrors.ts"
import {
  PortfolioCalculationStatusResponse,
  PortfolioBadRequestResponse,
  PortfolioCalculationJobNotFoundResponse,
  PortfolioAssetRow,
  PortfolioActiveRunResponse,
  PortfolioAssetsResponse,
  PortfolioLatestRunResponse,
  PortfolioSourceNotFoundResponse,
  PortfolioSummary,
} from "../definitions/PortfolioApi.ts"
import { TaxMaxiApi } from "../definitions/TaxMaxiApi.ts"
import {
  CoinGeckoPriceService,
  type CoinGeckoMarketData,
} from "../services/CoinGeckoPriceService.ts"
import { PrincipalResolutionService } from "../services/PrincipalResolutionService.ts"

const internalError = (message: string) =>
  new InternalServerError({ requestId: Option.none(), message })

const GERMAN_TIME_ZONE = "Europe/Berlin"
const GERMAN_JURISDICTION = JurisdictionCode.make("DE")

const currentGermanTaxYear = DateTime.now.pipe(
  Effect.map(DateTime.setZoneNamedUnsafe(GERMAN_TIME_ZONE)),
  Effect.map(DateTime.toParts),
  Effect.map(({ year }) => TaxYear.make(year))
)

/** Build one valued portfolio row while preserving unavailable cost-basis state. */
export const makePortfolioAssetRow = ({
  position,
  market,
  currency,
}: {
  readonly position: PortfolioAssetPosition
  readonly market: CoinGeckoMarketData | undefined
  readonly currency: string
}): PortfolioAssetRow => {
  const amount = BigDecimal.fromStringUnsafe(position.amount)

  if (market === undefined) {
    return PortfolioAssetRow.make({
      assetId: position.assetId,
      symbol: position.symbol,
      name: position.name,
      logoUrl: position.logoUrl,
      amount,
      currentPrice: null,
      totalValue: null,
      profitLoss: null,
    })
  }

  const currentPrice = BigDecimal.fromStringUnsafe(market.price)
  const totalValue = BigDecimal.multiply(amount, currentPrice)
  const canCalculateProfitLoss =
    position.costBasisStatus === "known" &&
    position.costBasis !== null &&
    position.costBasisCurrency?.toLowerCase() === currency
  const profitLoss = canCalculateProfitLoss
    ? BigDecimal.subtract(totalValue, BigDecimal.fromStringUnsafe(position.costBasis))
    : null

  return PortfolioAssetRow.make({
    assetId: position.assetId,
    symbol: position.symbol,
    name: position.name,
    logoUrl: market.logoUrl,
    amount,
    currentPrice,
    totalValue: roundPortfolioDecimal(totalValue),
    profitLoss: profitLoss === null ? null : roundPortfolioDecimal(profitLoss),
  })
}

export const PortfolioApiLive = HttpApiBuilder.group(TaxMaxiApi, "portfolio", (handlers) =>
  Effect.gen(function* () {
    const calculationRunRepository = yield* CalculationRunRepository
    const portfolioRepository = yield* PortfolioRepository
    const priceService = yield* CoinGeckoPriceService
    const principalResolutionService = yield* PrincipalResolutionService

    return handlers
      .handle("getCalculationStatus", ({ query }) =>
        Effect.gen(function* () {
          const { principal } = yield* principalResolutionService.resolveCurrentUserPrincipal.pipe(
            Effect.mapError(() => internalError("principal_resolution_failed"))
          )
          const status = yield* calculationRunRepository
            .getSyncStatus({
              principalId: principal.id,
              jurisdiction: GERMAN_JURISDICTION,
              reportingCurrency: EUR,
              taxYear: query.taxYear,
              ...(query.sourceJobId === undefined ? {} : { sourceJobId: query.sourceJobId }),
            })
            .pipe(
              Effect.mapError((error) =>
                error._tag === "CalculationSyncJobNotFoundError"
                  ? new PortfolioCalculationJobNotFoundResponse({ code: "source_job_not_found" })
                  : internalError("calculation_status_read_failed")
              )
            )

          return PortfolioCalculationStatusResponse.make({
            scope: { jurisdiction: "DE", taxYear: status.scope.taxYear, reportingCurrency: "EUR" },
            activeRun: status.activeRun,
            work: status.work,
            jobs: status.jobs,
          })
        })
      )
      .handle("listPortfolioAssets", ({ query: urlParams }) =>
        Effect.gen(function* () {
          if (urlParams.sourceId !== undefined && urlParams.sourceIds !== undefined) {
            return yield* new PortfolioBadRequestResponse({ code: "conflicting_source_filters" })
          }
          const { principal } = yield* principalResolutionService.resolveCurrentUserPrincipal.pipe(
            Effect.mapError(() => internalError("Failed to resolve the current user."))
          )

          const currency = urlParams.currency ?? "eur"
          const taxYear = yield* currentGermanTaxYear

          const portfolio = yield* portfolioRepository
            .getActiveRunPortfolio({
              principalId: principal.id,
              sourceIds: (
                urlParams.sourceIds ??
                (urlParams.sourceId === undefined ? [] : [urlParams.sourceId])
              ).map((id) => SourceId.make(id)),
              jurisdiction: GERMAN_JURISDICTION,
              taxYear,
              reportingCurrency: EUR,
            })
            .pipe(
              Effect.catchTag("PortfolioSourceNotFoundError", () =>
                Effect.fail(new PortfolioSourceNotFoundResponse({ message: "Source not found." }))
              ),
              Effect.mapError((error) =>
                error._tag === "PortfolioSourceNotFoundResponse"
                  ? error
                  : internalError("Failed to load portfolio assets.")
              )
            )

          const latestRun = yield* calculationRunRepository
            .getLatestStatus({
              principalId: principal.id,
              jurisdiction: GERMAN_JURISDICTION,
              taxYear,
              reportingCurrency: EUR,
            })
            .pipe(Effect.mapError(() => internalError("Failed to load calculation run status.")))

          const positions = portfolio.positions

          const coinIds = Array.from(
            new Set(
              positions.flatMap((position) =>
                position.coingeckoCoinId === null ? [] : [position.coingeckoCoinId]
              )
            )
          )

          const prices = yield* priceService
            .getCurrentPrices({ coinIds, currency })
            .pipe(Effect.mapError(() => internalError("Failed to load current asset prices.")))

          const assets = positions
            .map((position) =>
              makePortfolioAssetRow({
                position,
                market:
                  position.coingeckoCoinId === null
                    ? undefined
                    : prices.get(position.coingeckoCoinId),
                currency,
              })
            )
            .sort(comparePortfolioAssets)
          const summary = makePortfolioSummary(assets)

          return PortfolioAssetsResponse.make({
            currency: currency.toUpperCase(),
            activeRun:
              portfolio.activeRun === null
                ? null
                : PortfolioActiveRunResponse.make({
                    runId: portfolio.activeRun.runId,
                    status: portfolio.activeRun.status,
                    blockerCounts: portfolio.activeRun.blockerCounts,
                  }),
            latestRun:
              latestRun === null
                ? null
                : PortfolioLatestRunResponse.make({
                    runId: latestRun.runId,
                    status: latestRun.status,
                    failureCode: latestRun.failureCode,
                  }),
            summary,
            assets,
          })
        })
      )
  })
)

/** Calculate exact aggregate portfolio values from the API asset rows. */
export const makePortfolioSummary = (
  assets: ReadonlyArray<PortfolioAssetRow>
): PortfolioSummary => {
  const hasUnavailableTotalValue = assets.some((asset) => asset.totalValue === null)
  const totalValue = hasUnavailableTotalValue
    ? null
    : sumDecimals(assets.map((asset) => asset.totalValue))
  const hasUnavailableProfitLoss = assets.some((asset) => asset.profitLoss === null)
  const profitLoss = hasUnavailableProfitLoss
    ? null
    : sumDecimals(assets.map((asset) => asset.profitLoss))
  const costBasis =
    totalValue === null || profitLoss === null ? null : BigDecimal.subtract(totalValue, profitLoss)
  const profitLossPercentage =
    profitLoss === null || costBasis === null || BigDecimal.isZero(costBasis)
      ? null
      : BigDecimal.multiply(
          BigDecimal.divideUnsafe(profitLoss, costBasis),
          BigDecimal.fromBigInt(100n)
        )

  return PortfolioSummary.make({
    totalValue: totalValue === null ? null : roundPortfolioDecimal(totalValue),
    costBasis: costBasis === null ? null : roundPortfolioDecimal(costBasis),
    profitLoss: profitLoss === null ? null : roundPortfolioDecimal(profitLoss),
    profitLossPercentage:
      profitLossPercentage === null ? null : roundPortfolioDecimal(profitLossPercentage),
  })
}

const sumDecimals = (values: ReadonlyArray<BigDecimal.BigDecimal | null>): BigDecimal.BigDecimal =>
  BigDecimal.sumAll(values.flatMap((value) => (value === null ? [] : [value])))

const roundPortfolioDecimal = (value: BigDecimal.BigDecimal): BigDecimal.BigDecimal =>
  BigDecimal.round(value, { scale: 8 })

const comparePortfolioAssets = (left: PortfolioAssetRow, right: PortfolioAssetRow): number => {
  if (left.totalValue === null) {
    return right.totalValue === null ? left.symbol.localeCompare(right.symbol) : 1
  }
  if (right.totalValue === null) return -1

  return (
    BigDecimal.Order(right.totalValue, left.totalValue) || left.symbol.localeCompare(right.symbol)
  )
}
