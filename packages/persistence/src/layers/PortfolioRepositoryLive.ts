/**
 * PortfolioRepositoryLive - Drizzle-backed user portfolio projections.
 *
 * @module PortfolioRepositoryLive
 */

import { and, asc, count, eq, gt, inArray } from "drizzle-orm"
import * as BigDecimal from "effect/BigDecimal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { PersistenceError, wrapSqlError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import { CalculationRunId } from "../services/CalculationRunRepository.ts"
import {
  PortfolioRepository,
  PortfolioSourceNotFoundError,
  type PortfolioAssetPosition,
  type PortfolioRepositoryShape,
} from "../services/PortfolioRepository.ts"
import { drizzle } from "./PgClientLive.ts"

interface PositionAccumulator {
  readonly assetId: string
  readonly symbol: string
  readonly name: string
  readonly logoUrl: string | null
  readonly coingeckoCoinId: string | null
  amount: BigDecimal.BigDecimal
  costBasis: BigDecimal.BigDecimal
  costBasisCurrency: string | null
  hasPendingCostBasis: boolean
}

interface PositionRow {
  readonly assetId: string
  readonly symbol: string
  readonly name: string
  readonly logoUrl: string | null
  readonly coingeckoCoinId: string | null
  readonly remainingAmount: string
  readonly costBasisPerToken: string | null
  readonly costBasisCurrency: string | null
  readonly costBasisStatus: "known" | "pending_review"
}

const decodeDecimal = (value: string, operation: string) =>
  Effect.try({
    try: () => BigDecimal.fromStringUnsafe(value),
    catch: (cause) => ({ operation, cause }),
  })

const mergeCurrency = (current: string | null, next: string): string | null => {
  if (current === null) return next
  return current === next ? current : "mixed"
}

const aggregatePositions = ({
  rows,
  operation,
}: {
  readonly rows: ReadonlyArray<PositionRow>
  readonly operation: string
}) =>
  Effect.gen(function* () {
    const positions = new Map<string, PositionAccumulator>()

    for (const row of rows) {
      const amount = yield* decodeDecimal(row.remainingAmount, `${operation}.remainingAmount`).pipe(
        wrapSqlError(`${operation}.remainingAmount`)
      )
      const existing = positions.get(row.assetId) ?? {
        assetId: row.assetId,
        symbol: row.symbol,
        name: row.name,
        logoUrl: row.logoUrl,
        coingeckoCoinId: row.coingeckoCoinId,
        amount: BigDecimal.fromBigInt(0n),
        costBasis: BigDecimal.fromBigInt(0n),
        costBasisCurrency: null,
        hasPendingCostBasis: false,
      }

      existing.amount = BigDecimal.sum(existing.amount, amount)

      if (
        row.costBasisStatus === "pending_review" ||
        row.costBasisPerToken === null ||
        row.costBasisCurrency === null
      ) {
        existing.hasPendingCostBasis = true
      } else {
        const costBasisPerToken = yield* decodeDecimal(
          row.costBasisPerToken,
          `${operation}.costBasisPerToken`
        ).pipe(wrapSqlError(`${operation}.costBasisPerToken`))
        existing.costBasis = BigDecimal.sum(
          existing.costBasis,
          BigDecimal.multiply(amount, costBasisPerToken)
        )
        existing.costBasisCurrency = mergeCurrency(
          existing.costBasisCurrency,
          row.costBasisCurrency
        )
      }

      positions.set(row.assetId, existing)
    }

    return Array.from(positions.values()).map(
      (position): PortfolioAssetPosition => ({
        ...position,
        amount: BigDecimal.format(position.amount),
        costBasis: position.hasPendingCostBasis
          ? null
          : BigDecimal.format(BigDecimal.round(position.costBasis, { scale: 8 })),
        costBasisCurrency: position.hasPendingCostBasis ? null : position.costBasisCurrency,
        costBasisStatus: position.hasPendingCostBasis ? "pending_review" : "known",
      })
    )
  })

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const ensureOwnedSources = ({
    principalId,
    sourceIds,
  }: {
    readonly principalId: string
    readonly sourceIds: ReadonlyArray<string>
  }) =>
    Effect.gen(function* () {
      if (sourceIds.length === 0) return

      const ownedSources = yield* db
        .select({ id: schema.sources.id })
        .from(schema.sources)
        .where(
          and(inArray(schema.sources.id, sourceIds), eq(schema.sources.principalId, principalId))
        )
        .pipe(wrapSqlError("portfolioRepository.ownedSources"))

      const ownedIds = new Set(ownedSources.map(({ id }) => id))
      const missingId = sourceIds.find((id) => !ownedIds.has(id))
      if (missingId !== undefined) {
        return yield* new PortfolioSourceNotFoundError({ sourceId: missingId })
      }
    })

  const getActiveRunPortfolio: PortfolioRepositoryShape["getActiveRunPortfolio"] = (scope) =>
    Effect.gen(function* () {
      const sourceIds = [...new Set(scope.sourceIds.map((id) => id.toLowerCase()))].sort()
      yield* ensureOwnedSources({ principalId: scope.principalId, sourceIds })

      const [activeRunRow] = yield* db
        .select({
          runId: schema.calculationRuns.id,
          status: schema.calculationRuns.status,
        })
        .from(schema.activeCalculationRuns)
        .innerJoin(
          schema.calculationRuns,
          eq(schema.activeCalculationRuns.runId, schema.calculationRuns.id)
        )
        .where(
          and(
            eq(schema.activeCalculationRuns.principalId, scope.principalId),
            eq(schema.activeCalculationRuns.jurisdiction, scope.jurisdiction),
            eq(schema.activeCalculationRuns.taxYear, scope.taxYear),
            eq(schema.activeCalculationRuns.reportingCurrency, scope.reportingCurrency)
          )
        )
        .limit(1)
        .pipe(wrapSqlError("portfolioRepository.getActiveRunPortfolio.activeRun"))

      if (activeRunRow === undefined) {
        return { activeRun: null, positions: [] }
      }

      if (activeRunRow.status !== "complete" && activeRunRow.status !== "partial") {
        return yield* new PersistenceError({
          operation: "portfolioRepository.getActiveRunPortfolio.activeRunStatus",
          cause: `Active calculation run has non-readable status ${activeRunRow.status}`,
        })
      }

      const blockerCounts = yield* db
        .select({
          code: schema.calculationRunBlockers.code,
          count: count(schema.calculationRunBlockers.code),
        })
        .from(schema.calculationRunBlockers)
        .where(eq(schema.calculationRunBlockers.runId, activeRunRow.runId))
        .groupBy(schema.calculationRunBlockers.code)
        .orderBy(asc(schema.calculationRunBlockers.code))
        .pipe(wrapSqlError("portfolioRepository.getActiveRunPortfolio.blockerCounts"))

      const activeRun = {
        runId: CalculationRunId.make(activeRunRow.runId),
        status: activeRunRow.status,
        blockerCounts,
      } as const

      let custodyUnitIds: ReadonlyArray<string> | null = null
      if (sourceIds.length > 0) {
        const memberships = yield* db
          .select({ custodyUnitId: schema.calculationRunCustodyUnitSources.custodyUnitId })
          .from(schema.calculationRunCustodyUnitSources)
          .where(
            and(
              eq(schema.calculationRunCustodyUnitSources.runId, activeRun.runId),
              eq(schema.calculationRunCustodyUnitSources.principalId, scope.principalId),
              inArray(schema.calculationRunCustodyUnitSources.sourceId, sourceIds)
            )
          )
          .pipe(wrapSqlError("portfolioRepository.getActiveRunPortfolio.sourceMembership"))

        if (memberships.length === 0) {
          return { activeRun, positions: [] }
        }

        custodyUnitIds = [...new Set(memberships.map(({ custodyUnitId }) => custodyUnitId))]
      }

      const rows = yield* db
        .select({
          assetId: schema.assets.id,
          symbol: schema.assets.symbol,
          name: schema.assets.name,
          logoUrl: schema.assets.logoUrl,
          coingeckoCoinId: schema.assets.coingeckoCoinId,
          remainingAmount: schema.calculationRunDerivedLots.remainingQuantity,
          costBasisPerToken: schema.calculationRunDerivedLots.costBasisPerUnit,
        })
        .from(schema.calculationRunDerivedLots)
        .innerJoin(schema.assets, eq(schema.calculationRunDerivedLots.assetId, schema.assets.id))
        .where(
          and(
            eq(schema.calculationRunDerivedLots.runId, activeRun.runId),
            gt(schema.calculationRunDerivedLots.remainingQuantity, "0"),
            custodyUnitIds === null
              ? undefined
              : inArray(schema.calculationRunDerivedLots.custodyUnitId, custodyUnitIds)
          )
        )
        .orderBy(asc(schema.assets.symbol), asc(schema.assets.id))
        .pipe(wrapSqlError("portfolioRepository.getActiveRunPortfolio.lots"))

      const positions = yield* aggregatePositions({
        rows: rows.map((row) => ({
          ...row,
          costBasisCurrency: scope.reportingCurrency,
          costBasisStatus: row.costBasisPerToken === null ? "pending_review" : "known",
        })),
        operation: "portfolioRepository.getActiveRunPortfolio",
      })

      return {
        activeRun,
        positions,
      }
    })

  return PortfolioRepository.of({ getActiveRunPortfolio })
})

/** Live portfolio repository layer. */
export const PortfolioRepositoryLive = Layer.effect(PortfolioRepository, make)
