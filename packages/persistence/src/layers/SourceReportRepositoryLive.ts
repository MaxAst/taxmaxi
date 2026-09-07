/**
 * SourceReportRepositoryLive - Drizzle-backed source report read projections.
 *
 * @module SourceReportRepositoryLive
 */

import { and, asc, count, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm"
import { PrincipalId } from "@my/core/ownership"
import { REPORT_REVIEW_REASON_CODES, type ReportReviewReasonCode } from "@my/core/report"
import { Timestamp } from "@my/core/shared/values/Timestamp"
import {
  CexSourceRef,
  DexSourceRef,
  OnchainSourceRef,
  Source,
  SourceId,
  type SourceRef,
} from "@my/core/source"
import * as BigDecimal from "effect/BigDecimal"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { PersistenceError, wrapSqlError } from "../errors/RepositoryError.ts"
import { schema, type SourceRow } from "../schema/index.ts"
import { decodeSourceSyncJobProgressSnapshot } from "./SyncEngineRepositorySupport.ts"
import {
  SourceReportInvalidCursorError,
  SourceReportRepository,
  SourceReportSourceNotFoundError,
  type SourceAssetPnlRow,
  type SourceDisposalExplanation,
  type SourceDisposalMatchedLot,
  type SourceFifoLotDisposalSummary,
  type SourceFifoLotRow,
  type SourceReportAsset,
  type SourceReportPage,
  type SourceReportRepositoryService,
  type SourceReportReviewIssue,
  type SourceReportReviewSummary,
  type SourceReportScope,
  type SourceReportSyncStatus,
  type SourceReportTotals,
  type SourceTaxEventRow,
  type SourceTransactionMovement,
  type SourceTransactionRow,
} from "../services/SourceReportRepository.ts"
import { drizzle } from "./PgClientLive.ts"

type SelectedSourceRow = Pick<
  SourceRow,
  | "id"
  | "principalId"
  | "name"
  | "providerKey"
  | "sourceableType"
  | "addressId"
  | "cexAccountId"
  | "createdAt"
>

interface CursorParts {
  readonly timestamp: Date
  readonly id: string
}

interface AssetAccumulator {
  readonly asset: SourceReportAsset
  acquiredAmount: BigDecimal.BigDecimal
  disposedAmount: BigDecimal.BigDecimal
  openAmount: BigDecimal.BigDecimal
  openCostBasis: BigDecimal.BigDecimal
  proceeds: BigDecimal.BigDecimal
  realizedGainLoss: BigDecimal.BigDecimal
  currency: string | null
  hasRunCostBasisEvidence: boolean
  hasPendingCostBasis: boolean
}

interface ReviewProjectionRow {
  readonly reviewId: string
  readonly matchedLayer: string | null
  readonly assetId: string | null
}

interface ActiveSourceReportRun {
  readonly runId: string
  readonly custodyUnitId: string
  readonly reportingCurrency: string
}

const RUN_JURISDICTION = "DE"
const RUN_REPORTING_CURRENCY = "EUR"
const zeroDecimal = (): BigDecimal.BigDecimal => BigDecimal.fromBigInt(0n)
const formatDecimal = (value: BigDecimal.BigDecimal): string => BigDecimal.format(value)
const isoOrNull = (value: Date | null): string | null =>
  value === null ? null : value.toISOString()
const uniqueTreatmentCodes = (
  codeGroups: ReadonlyArray<ReadonlyArray<string>>
): ReadonlyArray<string> => Array.from(new Set(codeGroups.flat()))

const pluralize = (count: number, singular: string, plural: string): string =>
  count === 1 ? singular : plural

type SourceReportReviewIssueDefinition = {
  readonly matchedLayer: string
  readonly blocking: boolean
  readonly summary: (count: number) => string
}

const sourceReportReviewIssueDefinitions: Record<
  ReportReviewReasonCode,
  SourceReportReviewIssueDefinition
> = {
  fifo_inventory_shortfall: {
    matchedLayer: "fifo_inventory",
    blocking: true,
    summary: (count: number) =>
      `${count} ${pluralize(
        count,
        "disposal",
        "disposals"
      )} cannot be matched to available FIFO inventory.`,
  },
} as const

const summarizeReviewRows = (
  rows: ReadonlyArray<ReviewProjectionRow>
): SourceReportReviewSummary => {
  const reviewIds = new Set(rows.map((row) => row.reviewId))
  const issues = REPORT_REVIEW_REASON_CODES.flatMap(
    (code): ReadonlyArray<SourceReportReviewIssue> => {
      const definition = sourceReportReviewIssueDefinitions[code]
      const issueReviewIds = new Set(
        rows
          .filter((row) =>
            (row.matchedLayer ?? "")
              .split(",")
              .some((layer) => layer.trim() === definition.matchedLayer)
          )
          .map((row) => row.reviewId)
      )
      const count = issueReviewIds.size
      if (count === 0) {
        return []
      }
      return [
        {
          code,
          count,
          blocking: definition.blocking,
          summary: definition.summary(count),
        },
      ]
    }
  )
  const needsReviewCount = reviewIds.size
  const blockingIssueCount = issues
    .filter((issue) => issue.blocking)
    .reduce((count, issue) => count + issue.count, 0)

  if (needsReviewCount === 0) {
    return {
      status: "ok",
      needsReviewCount: 0,
      blockingIssueCount: 0,
      issues: [],
    }
  }

  return {
    status: "needs_review",
    needsReviewCount,
    blockingIssueCount,
    issues,
  }
}

const makeCursor = ({ timestamp, id }: CursorParts): string => `${timestamp.toISOString()}|${id}`
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const isUuid = (value: string): boolean => uuidPattern.test(value)

const parseCursor = (cursor: string | null) =>
  Effect.gen(function* () {
    if (cursor === null) {
      return Option.none<CursorParts>()
    }

    const parts = cursor.split("|")
    const timestampPart = parts[0]
    const idPart = parts[1]
    if (parts.length !== 2 || timestampPart === undefined || idPart === undefined) {
      return yield* new SourceReportInvalidCursorError({ cursor })
    }

    const timestamp = DateTime.make(timestampPart)
    if (Option.isNone(timestamp) || !isUuid(idPart)) {
      return yield* new SourceReportInvalidCursorError({ cursor })
    }

    return Option.some({ timestamp: DateTime.toDateUtc(timestamp.value), id: idPart })
  })

const decodeDecimal = ({
  operation,
  value,
}: {
  readonly operation: string
  readonly value: unknown
}) =>
  Schema.decodeUnknownEffect(Schema.BigDecimalFromString)(value).pipe(
    Effect.mapError(
      () =>
        new PersistenceError({
          operation,
          cause: `Invalid decimal value: ${String(value)}`,
        })
    )
  )

const optionalDecimal = ({
  operation,
  value,
}: {
  readonly operation: string
  readonly value: unknown
}) =>
  value === null
    ? Effect.succeed<Option.Option<BigDecimal.BigDecimal>>(Option.none())
    : decodeDecimal({ operation, value }).pipe(Effect.map(Option.some))

const makePage = <T>({
  cursorFor,
  limit,
  rows,
}: {
  readonly rows: ReadonlyArray<T>
  readonly limit: number
  readonly cursorFor: (row: T) => string
}): SourceReportPage<T> => {
  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const last = items.at(-1)
  return {
    items,
    nextCursor: hasMore && last !== undefined ? cursorFor(last) : null,
    hasMore,
  }
}

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const selectSourceFields = {
    id: schema.sources.id,
    principalId: schema.sources.principalId,
    name: schema.sources.name,
    providerKey: schema.sources.providerKey,
    sourceableType: schema.sources.sourceableType,
    addressId: schema.sources.addressId,
    cexAccountId: schema.sources.cexAccountId,
    createdAt: schema.sources.createdAt,
  } as const

  const rowToSourceRef = (row: SelectedSourceRow): Effect.Effect<SourceRef> => {
    switch (row.sourceableType) {
      case "onchain":
        if (row.addressId === null) {
          return Effect.die(`Source ${row.id} is onchain but has no addressId`)
        }
        return Effect.succeed(OnchainSourceRef.make({ addressId: row.addressId }))
      case "cex":
        if (row.cexAccountId === null) {
          return Effect.die(`Source ${row.id} is cex but has no cexAccountId`)
        }
        return Effect.succeed(CexSourceRef.make({ cexAccountId: row.cexAccountId }))
      case "dex":
        if (row.addressId === null) {
          return Effect.die(`Source ${row.id} is dex but has no addressId`)
        }
        return Effect.succeed(DexSourceRef.make({ addressId: row.addressId }))
    }
  }

  const rowToSource = (row: SelectedSourceRow): Effect.Effect<Source> =>
    Effect.gen(function* () {
      const sourceRef = yield* rowToSourceRef(row)
      return Source.make({
        id: SourceId.make(row.id),
        principalId: PrincipalId.make(row.principalId),
        name: row.name,
        providerKey: row.providerKey,
        sourceRef,
        createdAt: Timestamp.make({ epochMillis: row.createdAt.getTime() }),
      })
    })

  const loadOwnedSource = ({ principalId, sourceId }: SourceReportScope) =>
    Effect.gen(function* () {
      const [row] = yield* db
        .select(selectSourceFields)
        .from(schema.sources)
        .where(and(eq(schema.sources.id, sourceId), eq(schema.sources.principalId, principalId)))
        .limit(1)
        .pipe(wrapSqlError("sourceReportRepository.loadOwnedSource"))

      if (row === undefined) {
        return yield* new SourceReportSourceNotFoundError({ sourceId })
      }

      return yield* rowToSource(row)
    })

  const loadActiveRun = ({
    principalId,
    sourceId,
  }: SourceReportScope): Effect.Effect<ActiveSourceReportRun | null, PersistenceError> =>
    Effect.gen(function* () {
      const [row] = yield* db
        .select({
          runId: schema.calculationRuns.id,
          status: schema.calculationRuns.status,
          reportingCurrency: schema.calculationRuns.reportingCurrency,
          custodyUnitId: schema.calculationRunCustodyUnitSources.custodyUnitId,
        })
        .from(schema.activeCalculationRuns)
        .innerJoin(
          schema.calculationRuns,
          eq(schema.activeCalculationRuns.runId, schema.calculationRuns.id)
        )
        .innerJoin(
          schema.calculationRunCustodyUnitSources,
          and(
            eq(schema.calculationRunCustodyUnitSources.runId, schema.calculationRuns.id),
            eq(schema.calculationRunCustodyUnitSources.principalId, principalId),
            eq(schema.calculationRunCustodyUnitSources.sourceId, sourceId)
          )
        )
        .where(
          and(
            eq(schema.activeCalculationRuns.principalId, principalId),
            eq(schema.activeCalculationRuns.jurisdiction, RUN_JURISDICTION),
            eq(schema.activeCalculationRuns.reportingCurrency, RUN_REPORTING_CURRENCY)
          )
        )
        .orderBy(desc(schema.activeCalculationRuns.taxYear))
        .limit(1)
        .pipe(wrapSqlError("sourceReportRepository.loadActiveRun"))

      if (row === undefined) return null
      if (row.status !== "complete" && row.status !== "partial") {
        return yield* new PersistenceError({
          operation: "sourceReportRepository.loadActiveRun.status",
          cause: `Active calculation run has non-readable status ${row.status}`,
        })
      }
      return {
        runId: row.runId,
        custodyUnitId: row.custodyUnitId,
        reportingCurrency: row.reportingCurrency,
      }
    })

  const assetFromRow = (row: {
    readonly assetId: string
    readonly symbol: string
    readonly name: string
  }): SourceReportAsset => ({
    assetId: row.assetId,
    symbol: row.symbol,
    name: row.name,
  })

  const loadLatestSync = ({ sourceId }: { readonly sourceId: string }) =>
    Effect.gen(function* () {
      const [job] = yield* db
        .select({
          id: schema.processingJobs.id,
          status: schema.processingJobs.status,
          mode: schema.processingJobs.mode,
          queuedAt: schema.processingJobs.queuedAt,
          startedAt: schema.processingJobs.startedAt,
          completedAt: schema.processingJobs.completedAt,
          progressDetails: schema.processingJobs.progressDetails,
        })
        .from(schema.processingJobs)
        .where(eq(schema.processingJobs.sourceId, sourceId))
        .orderBy(desc(schema.processingJobs.createdAt), desc(schema.processingJobs.id))
        .limit(1)
        .pipe(wrapSqlError("sourceReportRepository.loadLatestSync.job"))

      const [state] = yield* db
        .select({
          lastSyncedAt: schema.sourceSyncState.lastSyncedAt,
          lastErrorMessage: schema.sourceSyncState.lastErrorMessage,
        })
        .from(schema.sourceSyncState)
        .where(eq(schema.sourceSyncState.sourceId, sourceId))
        .limit(1)
        .pipe(wrapSqlError("sourceReportRepository.loadLatestSync.state"))

      const progress = yield* decodeSourceSyncJobProgressSnapshot(job?.progressDetails ?? null)

      return {
        jobId: job?.id ?? null,
        status: job?.status ?? null,
        mode: job?.mode ?? null,
        queuedAt: isoOrNull(job?.queuedAt ?? null),
        startedAt: isoOrNull(job?.startedAt ?? null),
        completedAt: isoOrNull(job?.completedAt ?? null),
        lastSyncedAt: isoOrNull(state?.lastSyncedAt ?? null),
        lastErrorMessage: state?.lastErrorMessage ?? null,
        fetchedRecords: progress?.fetchedRecords ?? null,
        normalizedRecords: progress?.normalizedRecords ?? null,
        failedRecords: progress?.failedRecords ?? null,
      } satisfies SourceReportSyncStatus
    })

  const loadReportReviewRows = ({ sourceId }: { readonly sourceId: string }) =>
    db
      .select({
        reviewId: schema.transactionReviews.id,
        matchedLayer: schema.transactionReviews.matchedLayer,
        assetId: schema.transactionLegs.assetId,
      })
      .from(schema.transactionReviews)
      .innerJoin(
        schema.transactions,
        eq(schema.transactionReviews.transactionId, schema.transactions.id)
      )
      .leftJoin(
        schema.transactionLegs,
        and(
          eq(schema.transactionLegs.transactionId, schema.transactions.id),
          eq(schema.transactionLegs.kind, "disposal")
        )
      )
      .where(
        and(
          eq(schema.transactions.sourceId, sourceId),
          eq(schema.transactionReviews.needsReview, true)
        )
      )
      .pipe(wrapSqlError("sourceReportRepository.loadReportReviewRows"))

  const getOverview: SourceReportRepositoryService["getOverview"] = (params) =>
    Effect.gen(function* () {
      const source = yield* loadOwnedSource(params)
      const activeRun = yield* loadActiveRun(params)
      const latestSync = yield* loadLatestSync({ sourceId: params.sourceId })
      const reviewRows = yield* loadReportReviewRows({ sourceId: params.sourceId })
      const [transactionCount] = yield* db
        .select({ count: count(schema.transactions.id) })
        .from(schema.transactions)
        .where(eq(schema.transactions.sourceId, params.sourceId))
        .pipe(wrapSqlError("sourceReportRepository.getOverview.transactionCount"))
      const legRows = yield* db
        .select({
          assetId: schema.transactionLegs.assetId,
          kind: schema.transactionLegs.kind,
          derivationRule: schema.transactionLegs.derivationRule,
        })
        .from(schema.transactionLegs)
        .where(eq(schema.transactionLegs.sourceId, params.sourceId))
        .pipe(wrapSqlError("sourceReportRepository.getOverview.legs"))
      const fifoLotRows =
        activeRun === null
          ? []
          : yield* db
              .selectDistinct({
                acquisitionEventId: schema.calculationRunDerivedLots.acquisitionEventId,
                assetId: schema.calculationRunDerivedLots.assetId,
              })
              .from(schema.calculationRunDerivedLots)
              .where(
                and(
                  eq(schema.calculationRunDerivedLots.runId, activeRun.runId),
                  eq(schema.calculationRunDerivedLots.custodyUnitId, activeRun.custodyUnitId)
                )
              )
              .pipe(wrapSqlError("sourceReportRepository.getOverview.derivedLots"))
      const matchRows =
        activeRun === null
          ? []
          : yield* db
              .select({ gainLoss: schema.calculationRunRealizedResults.gainLoss })
              .from(schema.calculationRunRealizedResults)
              .where(
                and(
                  eq(schema.calculationRunRealizedResults.runId, activeRun.runId),
                  eq(schema.calculationRunRealizedResults.sourceId, params.sourceId)
                )
              )
              .pipe(wrapSqlError("sourceReportRepository.getOverview.realized"))
      const incomeRows =
        activeRun === null
          ? []
          : yield* db
              .select({ value: schema.calculationRunIncomeResults.value })
              .from(schema.calculationRunIncomeResults)
              .where(
                and(
                  eq(schema.calculationRunIncomeResults.runId, activeRun.runId),
                  eq(schema.calculationRunIncomeResults.sourceId, params.sourceId)
                )
              )
              .pipe(wrapSqlError("sourceReportRepository.getOverview.income"))

      let realizedGainLoss = zeroDecimal()
      const currency = activeRun?.reportingCurrency ?? null
      for (const row of matchRows) {
        const amount = yield* decodeDecimal({
          operation: "sourceReportRepository.getOverview.gainLoss",
          value: row.gainLoss,
        })
        realizedGainLoss = BigDecimal.sum(realizedGainLoss, amount)
      }

      let incomeTotal = zeroDecimal()
      const assetIds = new Set<string>()
      let disposalCount = 0
      let feeCount = 0
      let incomeCount = 0
      for (const row of legRows) {
        assetIds.add(row.assetId)
        if (row.kind === "disposal" && row.derivationRule !== "internal_transfer_out") {
          disposalCount += 1
        }
        if (row.kind === "fee") {
          feeCount += 1
        }
        if (row.kind === "income") {
          incomeCount += 1
        }
      }
      for (const row of fifoLotRows) {
        assetIds.add(row.assetId)
      }
      for (const row of incomeRows) {
        const value = yield* decodeDecimal({
          operation: "sourceReportRepository.getOverview.incomeValue",
          value: row.value,
        })
        incomeTotal = BigDecimal.sum(incomeTotal, value)
      }

      const totals = {
        transactionCount: transactionCount?.count ?? 0,
        legCount: legRows.length,
        assetCount: assetIds.size,
        fifoLotCount: fifoLotRows.length,
        disposalCount,
        incomeCount,
        feeCount,
        realizedGainLoss: formatDecimal(realizedGainLoss),
        incomeTotal: formatDecimal(incomeTotal),
        currency,
      } satisfies SourceReportTotals

      return {
        calculationRunId: activeRun?.runId ?? null,
        source,
        latestSync,
        totals,
        review: summarizeReviewRows(reviewRows),
      }
    })

  const listAssetPnl: SourceReportRepositoryService["listAssetPnl"] = (params) =>
    Effect.gen(function* () {
      yield* loadOwnedSource(params)
      const activeRun = yield* loadActiveRun(params)
      const reviewRows = yield* loadReportReviewRows({ sourceId: params.sourceId })
      const legRows = yield* db
        .select({
          assetId: schema.transactionLegs.assetId,
          symbol: schema.assets.symbol,
          name: schema.assets.name,
          kind: schema.transactionLegs.kind,
          amount: schema.transactionLegs.amount,
          derivationRule: schema.transactionLegs.derivationRule,
        })
        .from(schema.transactionLegs)
        .innerJoin(schema.assets, eq(schema.transactionLegs.assetId, schema.assets.id))
        .where(eq(schema.transactionLegs.sourceId, params.sourceId))
        .orderBy(asc(schema.assets.symbol), asc(schema.assets.id))
        .pipe(wrapSqlError("sourceReportRepository.listAssetPnl.legs"))

      const lotRows =
        activeRun === null
          ? []
          : yield* db
              .select({
                assetId: schema.calculationRunDerivedLots.assetId,
                symbol: schema.assets.symbol,
                name: schema.assets.name,
                remainingAmount: schema.calculationRunDerivedLots.remainingQuantity,
                costBasisPerToken: schema.calculationRunDerivedLots.costBasisPerUnit,
              })
              .from(schema.calculationRunDerivedLots)
              .innerJoin(
                schema.assets,
                eq(schema.calculationRunDerivedLots.assetId, schema.assets.id)
              )
              .where(
                and(
                  eq(schema.calculationRunDerivedLots.runId, activeRun.runId),
                  eq(schema.calculationRunDerivedLots.custodyUnitId, activeRun.custodyUnitId)
                )
              )
              .pipe(wrapSqlError("sourceReportRepository.listAssetPnl.derivedLots"))

      const matchRows =
        activeRun === null
          ? []
          : yield* db
              .select({
                assetId: schema.calculationRunRealizedResults.assetId,
                symbol: schema.assets.symbol,
                name: schema.assets.name,
                proceeds: schema.calculationRunRealizedResults.proceeds,
                gainLoss: schema.calculationRunRealizedResults.gainLoss,
              })
              .from(schema.calculationRunRealizedResults)
              .innerJoin(
                schema.assets,
                eq(schema.calculationRunRealizedResults.assetId, schema.assets.id)
              )
              .where(
                and(
                  eq(schema.calculationRunRealizedResults.runId, activeRun.runId),
                  eq(schema.calculationRunRealizedResults.sourceId, params.sourceId)
                )
              )
              .pipe(wrapSqlError("sourceReportRepository.listAssetPnl.realized"))

      const basisEvidenceRows =
        activeRun === null
          ? []
          : yield* db
              .select({ assetId: schema.calculationRunAllocations.assetId })
              .from(schema.calculationRunAllocations)
              .innerJoin(
                schema.calculationRunRealizedResults,
                and(
                  eq(
                    schema.calculationRunRealizedResults.runId,
                    schema.calculationRunAllocations.runId
                  ),
                  eq(
                    schema.calculationRunRealizedResults.allocationSequence,
                    schema.calculationRunAllocations.sequence
                  )
                )
              )
              .where(
                and(
                  eq(schema.calculationRunAllocations.runId, activeRun.runId),
                  eq(schema.calculationRunAllocations.custodyUnitId, activeRun.custodyUnitId)
                )
              )
              .pipe(wrapSqlError("sourceReportRepository.listAssetPnl.basisEvidence"))

      const basisEvidenceAssetIds = new Set(basisEvidenceRows.map((row) => row.assetId))
      const accumulators = new Map<string, AssetAccumulator>()
      const getAccumulator = (asset: SourceReportAsset): AssetAccumulator => {
        const existing = accumulators.get(asset.assetId)
        if (existing !== undefined) {
          return existing
        }
        const created: AssetAccumulator = {
          asset,
          acquiredAmount: zeroDecimal(),
          disposedAmount: zeroDecimal(),
          openAmount: zeroDecimal(),
          openCostBasis: zeroDecimal(),
          proceeds: zeroDecimal(),
          realizedGainLoss: zeroDecimal(),
          currency: null,
          hasRunCostBasisEvidence: basisEvidenceAssetIds.has(asset.assetId),
          hasPendingCostBasis: false,
        }
        accumulators.set(asset.assetId, created)
        return created
      }

      for (const row of legRows) {
        const accumulator = getAccumulator(assetFromRow(row))
        const amount = yield* decodeDecimal({
          operation: "sourceReportRepository.listAssetPnl.legAmount",
          value: row.amount,
        })
        if (
          (row.kind === "acquisition" || row.kind === "income") &&
          row.derivationRule !== "internal_transfer_in"
        ) {
          accumulator.acquiredAmount = BigDecimal.sum(accumulator.acquiredAmount, amount)
        }
        if (row.kind === "disposal" && row.derivationRule !== "internal_transfer_out") {
          accumulator.disposedAmount = BigDecimal.sum(
            accumulator.disposedAmount,
            BigDecimal.abs(amount)
          )
        }
      }

      for (const row of lotRows) {
        const accumulator = getAccumulator(assetFromRow(row))
        accumulator.hasRunCostBasisEvidence = true
        const remainingAmount = yield* decodeDecimal({
          operation: "sourceReportRepository.listAssetPnl.remainingAmount",
          value: row.remainingAmount,
        })
        if (
          row.costBasisPerToken === null &&
          BigDecimal.isGreaterThan(remainingAmount, zeroDecimal())
        ) {
          accumulator.hasPendingCostBasis = true
        } else if (row.costBasisPerToken !== null) {
          const costBasisPerToken = yield* decodeDecimal({
            operation: "sourceReportRepository.listAssetPnl.costBasisPerToken",
            value: row.costBasisPerToken,
          })
          accumulator.openCostBasis = BigDecimal.sum(
            accumulator.openCostBasis,
            BigDecimal.round(BigDecimal.multiply(remainingAmount, costBasisPerToken), { scale: 8 })
          )
        }
        accumulator.openAmount = BigDecimal.sum(accumulator.openAmount, remainingAmount)
        accumulator.currency = activeRun?.reportingCurrency ?? null
      }

      for (const row of matchRows) {
        const accumulator = getAccumulator(assetFromRow(row))
        const proceeds = yield* decodeDecimal({
          operation: "sourceReportRepository.listAssetPnl.proceeds",
          value: row.proceeds,
        })
        const gainLoss = yield* decodeDecimal({
          operation: "sourceReportRepository.listAssetPnl.gainLoss",
          value: row.gainLoss,
        })
        accumulator.proceeds = BigDecimal.sum(accumulator.proceeds, proceeds)
        accumulator.realizedGainLoss = BigDecimal.sum(accumulator.realizedGainLoss, gainLoss)
        accumulator.currency = activeRun?.reportingCurrency ?? null
      }

      const reviewRowsByAssetId = new Map<string, ReadonlyArray<ReviewProjectionRow>>()
      for (const row of reviewRows) {
        if (row.assetId === null) {
          continue
        }
        const existing = reviewRowsByAssetId.get(row.assetId) ?? []
        reviewRowsByAssetId.set(row.assetId, [...existing, row])
      }

      return {
        calculationRunId: activeRun?.runId ?? null,
        assets: Array.from(accumulators.values())
          .sort((left, right) => left.asset.symbol.localeCompare(right.asset.symbol))
          .map((row): SourceAssetPnlRow => {
            const hasKnownCostBasis = row.hasRunCostBasisEvidence && !row.hasPendingCostBasis

            return {
              asset: row.asset,
              acquiredAmount: formatDecimal(row.acquiredAmount),
              disposedAmount: formatDecimal(row.disposedAmount),
              openAmount: formatDecimal(row.openAmount),
              costBasis: hasKnownCostBasis ? formatDecimal(row.openCostBasis) : null,
              costBasisStatus: hasKnownCostBasis ? "known" : "pending_review",
              proceeds: formatDecimal(row.proceeds),
              realizedGainLoss: formatDecimal(row.realizedGainLoss),
              currency: row.currency,
              review: summarizeReviewRows(reviewRowsByAssetId.get(row.asset.assetId) ?? []),
            }
          }),
      }
    })

  const listTransactions: SourceReportRepositoryService["listTransactions"] = (params) =>
    Effect.gen(function* () {
      yield* loadOwnedSource(params)

      const cursor = yield* parseCursor(params.cursor)
      const cursorPredicate = Option.match(cursor, {
        onNone: () => undefined,
        onSome: (value) =>
          or(
            lt(schema.transactions.timestamp, value.timestamp),
            and(
              eq(schema.transactions.timestamp, value.timestamp),
              lt(schema.transactions.id, value.id)
            )
          ),
      })

      const rows = yield* db
        .select({
          transactionId: schema.transactions.id,
          timestamp: schema.transactions.timestamp,
          externalId: schema.transactions.externalId,
          externalGroupId: schema.transactions.externalGroupId,
          transactionType: schema.transactions.transactionType,
          providerTransactionType: schema.transactions.providerTransactionType,
          providerStatus: schema.transactions.providerStatus,
          providerDescription: schema.transactions.providerDescription,
        })
        .from(schema.transactions)
        .where(
          cursorPredicate === undefined
            ? eq(schema.transactions.sourceId, params.sourceId)
            : and(eq(schema.transactions.sourceId, params.sourceId), cursorPredicate)
        )
        .orderBy(desc(schema.transactions.timestamp), desc(schema.transactions.id))
        .limit(params.limit + 1)
        .pipe(wrapSqlError("sourceReportRepository.listTransactions.transactions"))

      const transactionIds = rows.map((row) => row.transactionId)

      const movementRows =
        transactionIds.length === 0
          ? []
          : yield* db
              .select({
                transactionId: schema.transactionLegs.transactionId,
                legId: schema.transactionLegs.id,
                assetId: schema.assets.id,
                symbol: schema.assets.symbol,
                name: schema.assets.name,
                kind: schema.transactionLegs.kind,
                amount: schema.transactionLegs.amount,
                fiatAmount: schema.transactionLegs.fiatAmount,
                fiatCurrency: schema.transactionLegs.fiatCurrency,
                provenance: schema.transactionLegs.provenance,
                derivationRule: schema.transactionLegs.derivationRule,
              })
              .from(schema.transactionLegs)
              .innerJoin(schema.assets, eq(schema.transactionLegs.assetId, schema.assets.id))
              .where(inArray(schema.transactionLegs.transactionId, transactionIds))
              .orderBy(asc(schema.transactionLegs.timestamp), asc(schema.transactionLegs.id))
              .pipe(wrapSqlError("sourceReportRepository.listTransactions.movements"))

      const movementsByTransaction = new Map<string, ReadonlyArray<SourceTransactionMovement>>()

      for (const transactionId of transactionIds) {
        const movements = movementRows
          .filter((row) => row.transactionId === transactionId)
          .map(
            (row): SourceTransactionMovement => ({
              legId: row.legId,
              asset: assetFromRow(row),
              kind: row.kind,
              amount: String(row.amount),
              fiatAmount: row.fiatAmount === null ? null : String(row.fiatAmount),
              fiatCurrency: row.fiatCurrency,
              provenance: row.provenance,
              derivationRule: row.derivationRule,
            })
          )
        movementsByTransaction.set(transactionId, movements)
      }

      const items = rows.map(
        (row): SourceTransactionRow => ({
          transactionId: row.transactionId,
          timestamp: row.timestamp.toISOString(),
          externalId: row.externalId,
          externalGroupId: row.externalGroupId,
          transactionType: row.transactionType,
          providerTransactionType: row.providerTransactionType,
          providerStatus: row.providerStatus,
          providerDescription: row.providerDescription,
          movements: movementsByTransaction.get(row.transactionId) ?? [],
        })
      )

      return makePage({
        rows: items,
        limit: params.limit,
        cursorFor: (row) =>
          makeCursor({
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe(row.timestamp)),
            id: row.transactionId,
          }),
      })
    })

  const listTaxEvents: SourceReportRepositoryService["listTaxEvents"] = (params) =>
    Effect.gen(function* () {
      yield* loadOwnedSource(params)
      const activeRun = yield* loadActiveRun(params)

      const cursor = yield* parseCursor(params.cursor)
      const cursorPredicate = Option.match(cursor, {
        onNone: () => undefined,
        onSome: (value) =>
          or(
            lt(schema.transactionLegs.timestamp, value.timestamp),
            and(
              eq(schema.transactionLegs.timestamp, value.timestamp),
              lt(schema.transactionLegs.id, value.id)
            )
          ),
      })

      const rows = yield* db
        .select({
          legId: schema.transactionLegs.id,
          transactionId: schema.transactionLegs.transactionId,
          timestamp: schema.transactionLegs.timestamp,
          kind: schema.transactionLegs.kind,
          assetId: schema.assets.id,
          symbol: schema.assets.symbol,
          name: schema.assets.name,
          amount: schema.transactionLegs.amount,
          fiatAmount: schema.transactionLegs.fiatAmount,
          fiatCurrency: schema.transactionLegs.fiatCurrency,
          provenance: schema.transactionLegs.provenance,
          derivationRule: schema.transactionLegs.derivationRule,
        })
        .from(schema.transactionLegs)
        .innerJoin(schema.assets, eq(schema.transactionLegs.assetId, schema.assets.id))
        .where(
          cursorPredicate === undefined
            ? eq(schema.transactionLegs.sourceId, params.sourceId)
            : and(eq(schema.transactionLegs.sourceId, params.sourceId), cursorPredicate)
        )
        .orderBy(desc(schema.transactionLegs.timestamp), desc(schema.transactionLegs.id))
        .limit(params.limit + 1)
        .pipe(wrapSqlError("sourceReportRepository.listTaxEvents"))

      const legIds = rows.map((row) => row.legId)

      const matchRows =
        legIds.length === 0 || activeRun === null
          ? []
          : yield* db
              .select({
                disposalLegId: schema.calculationRunRealizedResults.dispositionEventId,
                quantity: schema.calculationRunRealizedResults.quantity,
                costBasis: schema.calculationRunRealizedResults.costBasis,
                proceeds: schema.calculationRunRealizedResults.proceeds,
                gainLoss: schema.calculationRunRealizedResults.gainLoss,
                treatmentCodes: schema.calculationRunRealizedResults.treatmentCodes,
              })
              .from(schema.calculationRunRealizedResults)
              .where(
                and(
                  eq(schema.calculationRunRealizedResults.runId, activeRun.runId),
                  eq(schema.calculationRunRealizedResults.sourceId, params.sourceId),
                  inArray(schema.calculationRunRealizedResults.dispositionEventId, legIds)
                )
              )
              .orderBy(asc(schema.calculationRunRealizedResults.sequence))
              .pipe(wrapSqlError("sourceReportRepository.listTaxEvents.realized"))
      const incomeRows =
        legIds.length === 0 || activeRun === null
          ? []
          : yield* db
              .select({
                eventId: schema.calculationRunIncomeResults.eventId,
                value: schema.calculationRunIncomeResults.value,
                treatmentCodes: schema.calculationRunIncomeResults.treatmentCodes,
              })
              .from(schema.calculationRunIncomeResults)
              .where(
                and(
                  eq(schema.calculationRunIncomeResults.runId, activeRun.runId),
                  eq(schema.calculationRunIncomeResults.sourceId, params.sourceId),
                  inArray(schema.calculationRunIncomeResults.eventId, legIds)
                )
              )
              .pipe(wrapSqlError("sourceReportRepository.listTaxEvents.income"))

      const items = yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          let costBasis = zeroDecimal()
          let proceeds = zeroDecimal()
          let gainLoss = zeroDecimal()
          let realizedQuantity = zeroDecimal()

          const treatmentCodeGroups: Array<ReadonlyArray<string>> = []
          const matches = matchRows.filter((match) => match.disposalLegId === row.legId)

          for (const match of matches) {
            const matchCostBasis = yield* decodeDecimal({
              operation: "sourceReportRepository.listTaxEvents.costBasis",
              value: match.costBasis,
            })
            const matchProceeds = yield* decodeDecimal({
              operation: "sourceReportRepository.listTaxEvents.proceeds",
              value: match.proceeds,
            })
            const matchGainLoss = yield* decodeDecimal({
              operation: "sourceReportRepository.listTaxEvents.gainLoss",
              value: match.gainLoss,
            })
            const matchQuantity = yield* decodeDecimal({
              operation: "sourceReportRepository.listTaxEvents.realizedQuantity",
              value: match.quantity,
            })
            costBasis = BigDecimal.sum(costBasis, matchCostBasis)
            proceeds = BigDecimal.sum(proceeds, matchProceeds)
            gainLoss = BigDecimal.sum(gainLoss, matchGainLoss)
            realizedQuantity = BigDecimal.sum(realizedQuantity, matchQuantity)
            treatmentCodeGroups.push(match.treatmentCodes)
          }

          const eventAmount = yield* decodeDecimal({
            operation: "sourceReportRepository.listTaxEvents.eventAmount",
            value: row.amount,
          })
          const hasCompleteRealizedResult =
            row.kind === "disposal" &&
            matches.length > 0 &&
            BigDecimal.equals(realizedQuantity, BigDecimal.abs(eventAmount))

          const income = incomeRows.find((result) => result.eventId === row.legId)
          const incomeValue =
            income === undefined
              ? null
              : yield* decodeDecimal({
                  operation: "sourceReportRepository.listTaxEvents.incomeValue",
                  value: income.value,
                })

          return {
            legId: row.legId,
            transactionId: row.transactionId,
            timestamp: row.timestamp.toISOString(),
            kind: row.kind,
            asset: assetFromRow(row),
            amount: String(row.amount),
            fiatAmount:
              row.kind === "income"
                ? incomeValue === null
                  ? null
                  : formatDecimal(incomeValue)
                : row.fiatAmount === null
                  ? null
                  : String(row.fiatAmount),
            fiatCurrency:
              row.kind === "income"
                ? incomeValue === null
                  ? null
                  : (activeRun?.reportingCurrency ?? null)
                : row.fiatCurrency,
            costBasis: hasCompleteRealizedResult ? formatDecimal(costBasis) : null,
            proceeds: hasCompleteRealizedResult ? formatDecimal(proceeds) : null,
            gainLoss: hasCompleteRealizedResult ? formatDecimal(gainLoss) : null,
            treatmentCodes:
              row.kind === "disposal"
                ? uniqueTreatmentCodes(treatmentCodeGroups)
                : income === undefined
                  ? []
                  : income.treatmentCodes,
            provenance: row.provenance,
            derivationRule: row.derivationRule,
          } satisfies SourceTaxEventRow
        })
      )

      return {
        ...makePage({
          rows: items,
          limit: params.limit,
          cursorFor: (row) =>
            makeCursor({
              timestamp: DateTime.toDateUtc(DateTime.makeUnsafe(row.timestamp)),
              id: row.legId,
            }),
        }),
        calculationRunId: activeRun?.runId ?? null,
      }
    })

  const listFifoLots: SourceReportRepositoryService["listFifoLots"] = (params) =>
    Effect.gen(function* () {
      yield* loadOwnedSource(params)
      const activeRun = yield* loadActiveRun(params)

      const cursor = yield* parseCursor(params.cursor)
      const cursorPredicate = Option.match(cursor, {
        onNone: () => undefined,
        onSome: (value) =>
          or(
            gt(schema.calculationRunDerivedLots.acquiredAt, value.timestamp),
            and(
              eq(schema.calculationRunDerivedLots.acquiredAt, value.timestamp),
              gt(schema.calculationRunDerivedLots.acquisitionEventId, value.id)
            )
          ),
      })

      const rows =
        activeRun === null
          ? []
          : yield* db
              .select({
                lotId: schema.calculationRunDerivedLots.acquisitionEventId,
                assetId: schema.assets.id,
                symbol: schema.assets.symbol,
                name: schema.assets.name,
                acquiredAt: schema.calculationRunDerivedLots.acquiredAt,
                remainingAmount: sql<string>`sum(${schema.calculationRunDerivedLots.remainingQuantity})`,
                costBasisPerToken: schema.calculationRunDerivedLots.costBasisPerUnit,
              })
              .from(schema.calculationRunDerivedLots)
              .innerJoin(
                schema.assets,
                eq(schema.calculationRunDerivedLots.assetId, schema.assets.id)
              )
              .where(
                and(
                  eq(schema.calculationRunDerivedLots.runId, activeRun.runId),
                  eq(schema.calculationRunDerivedLots.custodyUnitId, activeRun.custodyUnitId),
                  cursorPredicate
                )
              )
              .groupBy(
                schema.calculationRunDerivedLots.acquisitionEventId,
                schema.calculationRunDerivedLots.assetId,
                schema.assets.id,
                schema.assets.symbol,
                schema.assets.name,
                schema.calculationRunDerivedLots.acquiredAt,
                schema.calculationRunDerivedLots.costBasisPerUnit
              )
              .orderBy(
                asc(schema.calculationRunDerivedLots.acquiredAt),
                asc(schema.calculationRunDerivedLots.acquisitionEventId)
              )
              .limit(params.limit + 1)
              .pipe(wrapSqlError("sourceReportRepository.listFifoLots.derivedLots"))

      const lotIds = rows.map((row) => row.lotId)

      const allocationRows =
        lotIds.length === 0 || activeRun === null
          ? []
          : yield* db
              .select({
                sequence: schema.calculationRunAllocations.sequence,
                lotId: schema.calculationRunAllocations.acquisitionEventId,
                disposalLegId: schema.calculationRunAllocations.dispositionEventId,
                matchedAmount: schema.calculationRunAllocations.quantity,
                costBasis: schema.calculationRunAllocations.costBasis,
              })
              .from(schema.calculationRunAllocations)
              .where(
                and(
                  eq(schema.calculationRunAllocations.runId, activeRun.runId),
                  eq(schema.calculationRunAllocations.custodyUnitId, activeRun.custodyUnitId),
                  inArray(schema.calculationRunAllocations.acquisitionEventId, lotIds)
                )
              )
              .orderBy(asc(schema.calculationRunAllocations.sequence))
              .pipe(wrapSqlError("sourceReportRepository.listFifoLots.allocations"))

      const allocationSequences = allocationRows.map((row) => row.sequence)
      const realizedRows =
        allocationSequences.length === 0 || activeRun === null
          ? []
          : yield* db
              .select({
                allocationSequence: schema.calculationRunRealizedResults.allocationSequence,
                quantity: schema.calculationRunRealizedResults.quantity,
                proceeds: schema.calculationRunRealizedResults.proceeds,
                costBasis: schema.calculationRunRealizedResults.costBasis,
                gainLoss: schema.calculationRunRealizedResults.gainLoss,
              })
              .from(schema.calculationRunRealizedResults)
              .where(
                and(
                  eq(schema.calculationRunRealizedResults.runId, activeRun.runId),
                  inArray(
                    schema.calculationRunRealizedResults.allocationSequence,
                    allocationSequences
                  )
                )
              )
              .orderBy(asc(schema.calculationRunRealizedResults.sequence))
              .pipe(wrapSqlError("sourceReportRepository.listFifoLots.realized"))

      const matchesByLot = new Map<string, ReadonlyArray<SourceFifoLotDisposalSummary>>()
      const allocationAmounts = new Map<
        string,
        {
          readonly quantity: BigDecimal.BigDecimal
          readonly costBasis: BigDecimal.BigDecimal
          readonly costBasisComplete: boolean
        }
      >()
      const allocationOrder: Array<{
        readonly key: string
        readonly lotId: string
        readonly disposalLegId: string
      }> = []
      const allocationKeyBySequence = new Map<number, string>()

      for (const row of allocationRows) {
        const key = `${row.lotId}:${row.disposalLegId}`
        allocationKeyBySequence.set(row.sequence, key)
        const amount = yield* decodeDecimal({
          operation: "sourceReportRepository.listFifoLots.matchedAmount",
          value: row.matchedAmount,
        })
        const costBasis = yield* optionalDecimal({
          operation: "sourceReportRepository.listFifoLots.allocationCostBasis",
          value: row.costBasis,
        })
        const current = allocationAmounts.get(key)
        if (current === undefined) {
          allocationOrder.push({ key, lotId: row.lotId, disposalLegId: row.disposalLegId })
          allocationAmounts.set(key, {
            quantity: amount,
            costBasis: Option.getOrElse(costBasis, zeroDecimal),
            costBasisComplete: Option.isSome(costBasis),
          })
        } else {
          allocationAmounts.set(key, {
            quantity: BigDecimal.sum(current.quantity, amount),
            costBasis: Option.match(costBasis, {
              onNone: () => current.costBasis,
              onSome: (value) => BigDecimal.sum(current.costBasis, value),
            }),
            costBasisComplete: current.costBasisComplete && Option.isSome(costBasis),
          })
        }
      }

      const realizedAmounts = new Map<
        string,
        {
          readonly proceeds: BigDecimal.BigDecimal
          readonly costBasis: BigDecimal.BigDecimal
          readonly gainLoss: BigDecimal.BigDecimal
          readonly quantity: BigDecimal.BigDecimal
        }
      >()

      for (const row of realizedRows) {
        const key = allocationKeyBySequence.get(row.allocationSequence)
        if (key === undefined) continue

        const proceeds = yield* decodeDecimal({
          operation: "sourceReportRepository.listFifoLots.proceeds",
          value: row.proceeds,
        })
        const costBasis = yield* decodeDecimal({
          operation: "sourceReportRepository.listFifoLots.costBasis",
          value: row.costBasis,
        })
        const gainLoss = yield* decodeDecimal({
          operation: "sourceReportRepository.listFifoLots.gainLoss",
          value: row.gainLoss,
        })
        const quantity = yield* decodeDecimal({
          operation: "sourceReportRepository.listFifoLots.realizedQuantity",
          value: row.quantity,
        })
        const current = realizedAmounts.get(key)
        realizedAmounts.set(
          key,
          current === undefined
            ? { proceeds, costBasis, gainLoss, quantity }
            : {
                proceeds: BigDecimal.sum(current.proceeds, proceeds),
                costBasis: BigDecimal.sum(current.costBasis, costBasis),
                gainLoss: BigDecimal.sum(current.gainLoss, gainLoss),
                quantity: BigDecimal.sum(current.quantity, quantity),
              }
        )
      }

      for (const lotId of lotIds) {
        const disposalMatches = allocationOrder
          .filter((row) => row.lotId === lotId)
          .map((row): SourceFifoLotDisposalSummary => {
            const allocation = allocationAmounts.get(row.key)
            const matchedAmount = allocation?.quantity ?? zeroDecimal()
            const realized = realizedAmounts.get(row.key)
            const fullyValued =
              realized !== undefined && BigDecimal.equals(realized.quantity, matchedAmount)
            return {
              disposalLegId: row.disposalLegId,
              matchedAmount: formatDecimal(matchedAmount),
              proceeds: fullyValued ? formatDecimal(realized.proceeds) : null,
              costBasis:
                allocation?.costBasisComplete === true
                  ? formatDecimal(allocation.costBasis)
                  : fullyValued
                    ? formatDecimal(realized.costBasis)
                    : null,
              gainLoss: fullyValued ? formatDecimal(realized.gainLoss) : null,
            }
          })

        matchesByLot.set(lotId, disposalMatches)
      }

      const items = yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const remainingAmount = yield* decodeDecimal({
            operation: "sourceReportRepository.listFifoLots.remainingAmount",
            value: row.remainingAmount,
          })
          let originalAmount = remainingAmount
          for (const allocation of allocationOrder.filter(
            (allocation) => allocation.lotId === row.lotId
          )) {
            const matchedAmount = allocationAmounts.get(allocation.key)?.quantity ?? zeroDecimal()
            originalAmount = BigDecimal.sum(originalAmount, matchedAmount)
          }
          const costBasisPerToken = yield* optionalDecimal({
            operation: "sourceReportRepository.listFifoLots.costBasisPerToken",
            value: row.costBasisPerToken,
          })

          return {
            lotId: row.lotId,
            asset: assetFromRow(row),
            acquiredAt: row.acquiredAt.toISOString(),
            originalAmount: formatDecimal(originalAmount),
            remainingAmount: formatDecimal(remainingAmount),
            costBasisPerToken: Option.match(costBasisPerToken, {
              onNone: () => null,
              onSome: formatDecimal,
            }),
            costBasisCurrency: Option.isSome(costBasisPerToken)
              ? (activeRun?.reportingCurrency ?? null)
              : null,
            costBasisStatus: Option.isSome(costBasisPerToken) ? "known" : "pending_review",
            sourceLegId: row.lotId,
            sourceProviderTransferId: null,
            disposalMatches: matchesByLot.get(row.lotId) ?? [],
          } satisfies SourceFifoLotRow
        })
      )
      return {
        ...makePage({
          rows: items,
          limit: params.limit,
          cursorFor: (row) =>
            makeCursor({
              timestamp: DateTime.toDateUtc(DateTime.makeUnsafe(row.acquiredAt)),
              id: row.lotId,
            }),
        }),
        calculationRunId: activeRun?.runId ?? null,
      }
    })

  const explainDisposal: SourceReportRepositoryService["explainDisposal"] = (params) =>
    Effect.gen(function* () {
      if (!isUuid(params.legId)) {
        return yield* new SourceReportInvalidCursorError({ cursor: params.legId })
      }

      yield* loadOwnedSource(params)
      const activeRun = yield* loadActiveRun(params)

      const [liveLeg] = yield* db
        .select({
          sourceId: schema.transactionLegs.sourceId,
          transactionId: schema.transactionLegs.transactionId,
          assetId: schema.assets.id,
          symbol: schema.assets.symbol,
          name: schema.assets.name,
          amount: schema.transactionLegs.amount,
          timestamp: schema.transactionLegs.timestamp,
          provenance: schema.transactionLegs.provenance,
          derivationRule: schema.transactionLegs.derivationRule,
        })
        .from(schema.transactionLegs)
        .innerJoin(schema.assets, eq(schema.transactionLegs.assetId, schema.assets.id))
        .where(
          and(
            eq(schema.transactionLegs.id, params.legId),
            eq(schema.transactionLegs.principalId, params.principalId),
            eq(schema.transactionLegs.kind, "disposal")
          )
        )
        .limit(1)
        .pipe(wrapSqlError("sourceReportRepository.explainDisposal.leg"))

      const allocations =
        activeRun === null
          ? []
          : yield* db
              .select({
                sequence: schema.calculationRunAllocations.sequence,
                assetId: schema.assets.id,
                symbol: schema.assets.symbol,
                name: schema.assets.name,
                acquiredAt: schema.calculationRunAllocations.acquiredAt,
                disposedAt: schema.calculationRunAllocations.disposedAt,
                matchedAmount: schema.calculationRunAllocations.quantity,
              })
              .from(schema.calculationRunAllocations)
              .innerJoin(
                schema.assets,
                eq(schema.calculationRunAllocations.assetId, schema.assets.id)
              )
              .where(
                and(
                  eq(schema.calculationRunAllocations.runId, activeRun.runId),
                  eq(schema.calculationRunAllocations.custodyUnitId, activeRun.custodyUnitId),
                  eq(schema.calculationRunAllocations.dispositionEventId, params.legId)
                )
              )
              .orderBy(asc(schema.calculationRunAllocations.sequence))
              .pipe(wrapSqlError("sourceReportRepository.explainDisposal.allocations"))

      const firstAllocation = allocations[0]
      const routeLiveLeg = liveLeg?.sourceId === params.sourceId ? liveLeg : null
      if (firstAllocation === undefined && routeLiveLeg === null) {
        return yield* new SourceReportSourceNotFoundError({ sourceId: params.sourceId })
      }

      const allocationSequences = allocations.map((row) => row.sequence)
      const blockers =
        activeRun === null
          ? []
          : yield* db
              .select({ missingQuantity: schema.calculationRunBlockers.missingQuantity })
              .from(schema.calculationRunBlockers)
              .where(
                and(
                  eq(schema.calculationRunBlockers.runId, activeRun.runId),
                  eq(schema.calculationRunBlockers.custodyUnitId, activeRun.custodyUnitId),
                  eq(schema.calculationRunBlockers.eventId, params.legId)
                )
              )
              .pipe(wrapSqlError("sourceReportRepository.explainDisposal.blockers"))
      const realizedRows =
        activeRun === null || allocationSequences.length === 0
          ? []
          : yield* db
              .select({
                lotId: schema.calculationRunRealizedResults.acquisitionEventId,
                assetId: schema.assets.id,
                symbol: schema.assets.symbol,
                name: schema.assets.name,
                acquiredAt: schema.calculationRunRealizedResults.acquiredAt,
                matchedAmount: schema.calculationRunRealizedResults.quantity,
                proceeds: schema.calculationRunRealizedResults.proceeds,
                costBasis: schema.calculationRunRealizedResults.costBasis,
                gainLoss: schema.calculationRunRealizedResults.gainLoss,
                treatmentCodes: schema.calculationRunRealizedResults.treatmentCodes,
              })
              .from(schema.calculationRunRealizedResults)
              .innerJoin(
                schema.assets,
                eq(schema.calculationRunRealizedResults.assetId, schema.assets.id)
              )
              .where(
                and(
                  eq(schema.calculationRunRealizedResults.runId, activeRun.runId),
                  inArray(
                    schema.calculationRunRealizedResults.allocationSequence,
                    allocationSequences
                  )
                )
              )
              .orderBy(asc(schema.calculationRunRealizedResults.sequence))
              .pipe(wrapSqlError("sourceReportRepository.explainDisposal.realized"))

      let allocatedAmount = zeroDecimal()
      let missingAmount = zeroDecimal()
      let firstAcquiredAt: Date | null = null
      for (const row of allocations) {
        const matchedAmount = yield* decodeDecimal({
          operation: "sourceReportRepository.explainDisposal.allocatedAmount",
          value: row.matchedAmount,
        })
        allocatedAmount = BigDecimal.sum(allocatedAmount, matchedAmount)
        firstAcquiredAt =
          firstAcquiredAt === null || row.acquiredAt.getTime() < firstAcquiredAt.getTime()
            ? row.acquiredAt
            : firstAcquiredAt
      }
      for (const row of blockers) {
        const missingQuantity = yield* optionalDecimal({
          operation: "sourceReportRepository.explainDisposal.missingQuantity",
          value: row.missingQuantity,
        })
        if (Option.isSome(missingQuantity)) {
          missingAmount = BigDecimal.sum(missingAmount, missingQuantity.value)
        }
      }

      let costBasis = zeroDecimal()
      let proceeds = zeroDecimal()
      let gainLoss = zeroDecimal()
      let valuedAmount = zeroDecimal()

      const matchedLots: Array<SourceDisposalMatchedLot> = []

      for (const row of realizedRows) {
        const rowCostBasis = yield* decodeDecimal({
          operation: "sourceReportRepository.explainDisposal.costBasis",
          value: row.costBasis,
        })
        const rowProceeds = yield* decodeDecimal({
          operation: "sourceReportRepository.explainDisposal.proceeds",
          value: row.proceeds,
        })
        const rowGainLoss = yield* decodeDecimal({
          operation: "sourceReportRepository.explainDisposal.gainLoss",
          value: row.gainLoss,
        })
        const matchedAmount = yield* decodeDecimal({
          operation: "sourceReportRepository.explainDisposal.matchedAmount",
          value: row.matchedAmount,
        })

        costBasis = BigDecimal.sum(costBasis, rowCostBasis)
        proceeds = BigDecimal.sum(proceeds, rowProceeds)
        gainLoss = BigDecimal.sum(gainLoss, rowGainLoss)
        valuedAmount = BigDecimal.sum(valuedAmount, matchedAmount)

        matchedLots.push({
          lotId: row.lotId,
          asset: assetFromRow(row),
          acquiredAt: row.acquiredAt.toISOString(),
          matchedAmount: formatDecimal(matchedAmount),
          costBasis: formatDecimal(rowCostBasis),
          proceeds: formatDecimal(rowProceeds),
          gainLoss: formatDecimal(rowGainLoss),
          treatmentCodes: row.treatmentCodes,
        })
      }

      const amount =
        liveLeg !== undefined
          ? yield* decodeDecimal({
              operation: "sourceReportRepository.explainDisposal.amount",
              value: liveLeg.amount,
            })
          : BigDecimal.sum(allocatedAmount, missingAmount)
      const fullyValued =
        allocations.length > 0 &&
        blockers.length === 0 &&
        BigDecimal.equals(valuedAmount, BigDecimal.abs(amount))
      const factualRow = firstAllocation ?? liveLeg
      if (factualRow === undefined) {
        return yield* new SourceReportSourceNotFoundError({ sourceId: params.sourceId })
      }
      const disposedAt = firstAllocation?.disposedAt ?? liveLeg?.timestamp
      if (disposedAt === undefined) {
        return yield* new SourceReportSourceNotFoundError({ sourceId: params.sourceId })
      }

      return {
        calculationRunId: activeRun?.runId ?? null,
        disposalLegId: params.legId,
        transactionId: liveLeg?.transactionId ?? null,
        asset: assetFromRow(factualRow),
        amount: formatDecimal(amount),
        proceeds: fullyValued ? formatDecimal(proceeds) : null,
        costBasis: fullyValued ? formatDecimal(costBasis) : null,
        gainLoss: fullyValued ? formatDecimal(gainLoss) : null,
        acquiredAt: isoOrNull(firstAcquiredAt),
        disposedAt: disposedAt.toISOString(),
        treatmentCodes: uniqueTreatmentCodes(matchedLots.map((lot) => lot.treatmentCodes)),
        provenance: liveLeg?.provenance ?? "deterministic",
        derivationRule: liveLeg?.derivationRule ?? null,
        matchedLots,
      } satisfies SourceDisposalExplanation
    })

  return {
    getOverview,
    listAssetPnl,
    listTransactions,
    listTaxEvents,
    listFifoLots,
    explainDisposal,
  } satisfies SourceReportRepositoryService
})

/**
 * SourceReportRepositoryLive - Live layer for source report read projections.
 */
export const SourceReportRepositoryLive = Layer.effect(SourceReportRepository, make)
