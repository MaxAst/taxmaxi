/**
 * PortfolioRepository - User portfolio read projections.
 *
 * @module PortfolioRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { JurisdictionCode, TaxYear } from "@my/core/accounting"
import type { CurrencyCode } from "@my/core/currency"
import type { PrincipalId } from "@my/core/ownership"
import type { SourceId } from "@my/core/source"
import type { PersistenceError } from "../errors/RepositoryError.ts"
import type { CalculationRunId } from "./CalculationRunRepository.ts"

/** A requested source is absent or does not belong to the principal. */
export class PortfolioSourceNotFoundError extends Schema.TaggedError<PortfolioSourceNotFoundError>()(
  "PortfolioSourceNotFoundError",
  { sourceId: Schema.String }
) {}

/** Active calculation scope and source-set view requested by the portfolio reader. */
export interface ActiveRunPortfolioScope {
  readonly principalId: PrincipalId
  /** Empty selects all sources; selected sources include their captured custody units once. */
  readonly sourceIds: ReadonlyArray<SourceId>
  readonly jurisdiction: JurisdictionCode
  readonly taxYear: TaxYear
  readonly reportingCurrency: CurrencyCode
}

/** Count of one machine-readable blocker code in the active run. */
export interface CalculationRunBlockerCount {
  readonly code: string
  readonly count: number
}

/** Successful run whose immutable lots back one portfolio response. */
export interface PortfolioActiveRun {
  readonly runId: CalculationRunId
  readonly status: "complete" | "partial"
  readonly blockerCounts: ReadonlyArray<CalculationRunBlockerCount>
}

/** Open asset position before current market valuation. */
export interface PortfolioAssetPosition {
  readonly assetId: string
  readonly symbol: string
  readonly name: string
  readonly logoUrl: string | null
  readonly coingeckoCoinId: string | null
  readonly amount: string
  readonly costBasis: string | null
  readonly costBasisCurrency: string | null
  readonly costBasisStatus: "known" | "pending_review"
}

/** Run identity and open positions read from one active result snapshot. */
export interface ActiveRunPortfolio {
  readonly activeRun: PortfolioActiveRun | null
  readonly positions: ReadonlyArray<PortfolioAssetPosition>
}

export interface PortfolioRepositoryShape {
  /** Read positions from the active immutable calculation run for one scope. */
  readonly getActiveRunPortfolio: (
    scope: ActiveRunPortfolioScope
  ) => Effect.Effect<ActiveRunPortfolio, PortfolioSourceNotFoundError | PersistenceError>
}

export class PortfolioRepository extends Context.Service<
  PortfolioRepository,
  PortfolioRepositoryShape
>()("PortfolioRepository") {}
