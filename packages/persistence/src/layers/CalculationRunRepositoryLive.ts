/**
 * CalculationRunRepositoryLive - Drizzle-backed write-once calculation runs.
 *
 * @module CalculationRunRepositoryLive
 */

import { format as formatQuantity, TaxYear } from "@my/core/accounting"
import type { CurrencyCode } from "@my/core/currency"
import {
  aliasedTable,
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  ne,
  notExists,
  sql,
} from "drizzle-orm"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { PrincipalId } from "@my/core/ownership"
import { PersistenceError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import {
  CalculationRunAlreadyStoredError,
  CalculationRunCurrencyMismatchError,
  CalculationRunId,
  CalculationSyncRequestId,
  CalculationSyncAttemptId,
  CalculationSyncJobNotFoundError,
  type CalculationSyncWork,
  type CalculationSyncStatus,
  type CalculationSyncCoveringRun,
  CalculationRunRepository,
  type CalculationRunRepositoryShape,
  type CalculationRunResult,
  type ExposedCalculationRunStatus,
  type FailCalculationRunParams,
  type MaintainCalculationRunsParams,
  type PersistCalculationRunParams,
  type StartCalculationRunParams,
} from "../services/CalculationRunRepository.ts"
import { drizzle } from "./PgClientLive.ts"

const INSERT_BATCH_ROW_COUNT = 500
const CALCULATION_STALE_RECOMPUTED_CODE = "calculation_stale_recomputed"

const writeBatches = <Row, Error, Requirements>(
  rows: ReadonlyArray<Row>,
  writeBatch: (batch: [Row, ...Array<Row>]) => Effect.Effect<unknown, Error, Requirements>
): Effect.Effect<void, Error, Requirements> =>
  Effect.gen(function* () {
    for (let start = 0; start < rows.length; start += INSERT_BATCH_ROW_COUNT) {
      const first = rows[start]

      if (first !== undefined) {
        yield* writeBatch([first, ...rows.slice(start + 1, start + INSERT_BATCH_ROW_COUNT)])
      }
    }
  })

const resultCurrencies = (result: CalculationRunResult): ReadonlyArray<CurrencyCode> => [
  ...result.allocations.flatMap(({ costBasis }) =>
    costBasis === null ? [] : [costBasis.currency]
  ),
  ...result.realizedResults.flatMap(({ costBasis, proceeds, gainLoss }) => [
    costBasis.currency,
    proceeds.currency,
    gainLoss.currency,
  ]),
  ...result.incomeResults.map(({ value }) => value.currency),
  ...result.derivedLots.flatMap(({ costBasisPerUnit }) =>
    costBasisPerUnit === null ? [] : [costBasisPerUnit.currency]
  ),
]

const validateReportingCurrency = ({
  id,
  reportingCurrency,
  result,
}: Pick<PersistCalculationRunParams, "id" | "reportingCurrency" | "result">) => {
  const mismatchedCurrency = resultCurrencies(result).find(
    (currency) => currency !== reportingCurrency
  )

  return mismatchedCurrency === undefined
    ? Effect.void
    : Effect.fail(
        new CalculationRunCurrencyMismatchError({
          runId: id,
          expected: reportingCurrency,
          actual: mismatchedCurrency,
        })
      )
}

const make = Effect.gen(function* () {
  const db = yield* drizzle
  type CalculationTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
  interface WriteContext {
    readonly tx: CalculationTransaction
    readonly params: PersistCalculationRunParams
    readonly result: CalculationRunResult
    readonly startedAt: Date
  }
  interface CustodyMembershipRow {
    readonly custodyUnitId: string
    readonly principalId: string
    readonly sourceId: string | null
  }

  const toExposedStatus = (
    status: (typeof schema.calculationRuns.$inferSelect)["status"]
  ): ExposedCalculationRunStatus | null => {
    switch (status) {
      case "running":
      case "complete":
      case "partial":
      case "failed":
        return status
      case "pending":
        return null
    }
  }

  const getLatestStatus: CalculationRunRepositoryShape["getLatestStatus"] = (params) =>
    db
      .select({
        runId: schema.calculationRuns.id,
        status: schema.calculationRuns.status,
        failureCode: schema.calculationRuns.failureCode,
      })
      .from(schema.calculationRuns)
      .where(
        and(
          eq(schema.calculationRuns.principalId, params.principalId),
          eq(schema.calculationRuns.jurisdiction, params.jurisdiction),
          eq(schema.calculationRuns.taxYear, params.taxYear),
          eq(schema.calculationRuns.reportingCurrency, params.reportingCurrency),
          ne(schema.calculationRuns.status, "pending")
        )
      )
      .orderBy(
        desc(
          sql<number>`split_part(${schema.calculationRuns.inputLedgerRevision}, ':', 2)::numeric`
        ),
        desc(schema.calculationRuns.id)
      )
      .limit(1)
      .pipe(
        Effect.map((rows) => {
          const row = rows[0]
          if (row === undefined) return null

          const status = toExposedStatus(row.status)
          return status === null
            ? null
            : {
                runId: CalculationRunId.make(row.runId),
                status,
                failureCode: row.failureCode,
              }
        }),
        Effect.mapError(
          (cause) =>
            new PersistenceError({
              operation: "calculationRunRepository.getLatestStatus",
              cause,
            })
        )
      )

  const getSyncStatus: CalculationRunRepositoryShape["getSyncStatus"] = (params) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.execute(sql`set transaction isolation level repeatable read, read only`)
          const scope = {
            principalId: params.principalId,
            jurisdiction: params.jurisdiction,
            taxYear: params.taxYear,
            reportingCurrency: params.reportingCurrency,
          }
          const [active] = yield* tx
            .select({
              runId: schema.calculationRuns.id,
              status: schema.calculationRuns.status,
              captureRunId: schema.calculationRunSyncCaptures.runId,
            })
            .from(schema.activeCalculationRuns)
            .innerJoin(
              schema.calculationRuns,
              eq(schema.calculationRuns.id, schema.activeCalculationRuns.runId)
            )
            .leftJoin(
              schema.calculationRunSyncCaptures,
              eq(schema.calculationRunSyncCaptures.runId, schema.calculationRuns.id)
            )
            .where(
              and(
                eq(schema.activeCalculationRuns.principalId, params.principalId),
                eq(schema.activeCalculationRuns.jurisdiction, params.jurisdiction),
                eq(schema.activeCalculationRuns.taxYear, params.taxYear),
                eq(schema.activeCalculationRuns.reportingCurrency, params.reportingCurrency)
              )
            )
          const activeRun: CalculationSyncCoveringRun | null =
            active !== undefined && (active.status === "complete" || active.status === "partial")
              ? { runId: CalculationRunId.make(active.runId), status: active.status }
              : null
          const requests = yield* tx
            .select({
              id: schema.calculationSyncRequests.id,
              sourceId: schema.calculationSyncRequests.sourceId,
              sourceJobId: schema.calculationSyncRequests.sourceJobId,
              status: schema.calculationSyncRequests.status,
            })
            .from(schema.calculationSyncRequests)
            .where(
              and(
                eq(schema.calculationSyncRequests.principalId, params.principalId),
                eq(schema.calculationSyncRequests.jurisdiction, params.jurisdiction),
                eq(schema.calculationSyncRequests.taxYear, params.taxYear),
                eq(schema.calculationSyncRequests.reportingCurrency, params.reportingCurrency)
              )
            )
            .orderBy(asc(schema.calculationSyncRequests.id))
          const attempts = yield* tx
            .select({
              requestId: schema.calculationSyncAttempts.requestId,
              id: schema.calculationSyncAttempts.id,
              runId: schema.calculationSyncAttempts.runId,
              status: schema.calculationSyncAttempts.status,
              failureCode: schema.calculationSyncAttempts.failureCode,
            })
            .from(schema.calculationSyncAttempts)
            .where(
              and(
                eq(schema.calculationSyncAttempts.principalId, params.principalId),
                eq(schema.calculationSyncAttempts.jurisdiction, params.jurisdiction),
                eq(schema.calculationSyncAttempts.taxYear, params.taxYear),
                eq(schema.calculationSyncAttempts.reportingCurrency, params.reportingCurrency)
              )
            )
            .orderBy(
              asc(schema.calculationSyncAttempts.startedAt),
              asc(schema.calculationSyncAttempts.id)
            )
          const attemptsByRequest = new Map<string, CalculationSyncWork["attempts"][number][]>()
          for (const attempt of attempts) {
            const entries = attemptsByRequest.get(attempt.requestId) ?? []
            entries.push({
              attemptId: CalculationSyncAttemptId.make(attempt.id),
              runId: attempt.runId === null ? null : CalculationRunId.make(attempt.runId),
              status: attempt.status,
              failureCode: attempt.failureCode,
            })
            attemptsByRequest.set(attempt.requestId, entries)
          }
          const work: CalculationSyncWork[] = requests.map((request) => ({
            requestId: CalculationSyncRequestId.make(request.id),
            sourceId: request.sourceId,
            sourceJobId: request.sourceJobId,
            status: request.status,
            attempts: attemptsByRequest.get(request.id) ?? [],
          }))
          // Ordering chooses which proven covering run to display; only the stored link proves coverage.
          const covers = yield* tx
            .select({
              requestId: schema.calculationRunSyncRequests.requestId,
              runId: schema.calculationRuns.id,
              status: schema.calculationRuns.status,
            })
            .from(schema.calculationRunSyncRequests)
            .innerJoin(
              schema.calculationRuns,
              eq(schema.calculationRuns.id, schema.calculationRunSyncRequests.runId)
            )
            .where(
              and(
                eq(schema.calculationRunSyncRequests.principalId, params.principalId),
                eq(schema.calculationRunSyncRequests.jurisdiction, params.jurisdiction),
                eq(schema.calculationRunSyncRequests.taxYear, params.taxYear),
                eq(schema.calculationRunSyncRequests.reportingCurrency, params.reportingCurrency),
                inArray(schema.calculationRuns.status, ["complete", "partial"])
              )
            )
            .orderBy(desc(schema.calculationRuns.completedAt), desc(schema.calculationRuns.id))
          const coveringByRequest = new Map<string, CalculationSyncCoveringRun>()
          const activeRequests = new Set<string>()
          for (const cover of covers) {
            if (cover.runId === activeRun?.runId) activeRequests.add(cover.requestId)
            if (
              !coveringByRequest.has(cover.requestId) &&
              (cover.status === "complete" || cover.status === "partial")
            )
              coveringByRequest.set(cover.requestId, {
                runId: CalculationRunId.make(cover.runId),
                status: cover.status,
              })
          }
          const jobFields = {
            id: schema.processingJobs.id,
            sourceId: schema.processingJobs.sourceId,
            status: schema.processingJobs.status,
          }
          const jobs =
            params.sourceJobId === undefined
              ? yield* tx
                  .selectDistinctOn([schema.processingJobs.sourceId], jobFields)
                  .from(schema.processingJobs)
                  .where(
                    and(
                      eq(schema.processingJobs.principalId, params.principalId),
                      eq(schema.processingJobs.status, "completed")
                    )
                  )
                  .orderBy(
                    asc(schema.processingJobs.sourceId),
                    desc(schema.processingJobs.completedAt),
                    desc(schema.processingJobs.id)
                  )
              : yield* tx
                  .select(jobFields)
                  .from(schema.processingJobs)
                  .where(
                    and(
                      eq(schema.processingJobs.principalId, params.principalId),
                      eq(schema.processingJobs.id, params.sourceJobId)
                    )
                  )
          if (params.sourceJobId !== undefined && jobs.length === 0)
            return yield* new CalculationSyncJobNotFoundError({ sourceJobId: params.sourceJobId })
          const workByJob = new Map(work.map((request) => [request.sourceJobId, request]))
          const status: CalculationSyncStatus["work"]["status"] = work.some(
            (request) => request.status === "running"
          )
            ? "running"
            : work.some((request) => request.status === "queued")
              ? "queued"
              : work.some((request) => request.status === "failed")
                ? "failed"
                : work.length > 0
                  ? "succeeded"
                  : "not_requested"
          return {
            scope,
            activeRun,
            work: { status, requests: work.filter((request) => request.status !== "succeeded") },
            jobs: jobs.map((job) => {
              const request = workByJob.get(job.id) ?? null
              return {
                sourceJobId: job.id,
                sourceId: job.sourceId,
                sourceJobStatus: job.status,
                work: request,
                coveringRun:
                  request === null ? null : (coveringByRequest.get(request.requestId) ?? null),
                activeCoverage:
                  job.status !== "completed" || activeRun === null || active?.captureRunId == null
                    ? ("unknown" as const)
                    : request !== null && activeRequests.has(request.requestId)
                      ? ("covered" as const)
                      : ("not_covered" as const),
              }
            }),
          }
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          Schema.is(CalculationSyncJobNotFoundError)(cause)
            ? cause
            : new PersistenceError({ operation: "calculationRunRepository.getSyncStatus", cause })
        )
      )

  const listActiveTaxYears: CalculationRunRepositoryShape["listActiveTaxYears"] = (params) =>
    db
      .select({ taxYear: schema.activeCalculationRuns.taxYear })
      .from(schema.activeCalculationRuns)
      .where(
        and(
          eq(schema.activeCalculationRuns.principalId, params.principalId),
          eq(schema.activeCalculationRuns.jurisdiction, params.jurisdiction),
          eq(schema.activeCalculationRuns.reportingCurrency, params.reportingCurrency)
        )
      )
      .orderBy(asc(schema.activeCalculationRuns.taxYear))
      .pipe(
        Effect.map((rows) => rows.map(({ taxYear }) => TaxYear.make(taxYear))),
        Effect.mapError(
          (cause) =>
            new PersistenceError({
              operation: "calculationRunRepository.listActiveTaxYears",
              cause,
            })
        )
      )

  const failStaleRuns = ({
    tx,
    staleBefore,
    limit,
    completedAt,
  }: MaintainCalculationRunsParams & {
    readonly tx: CalculationTransaction
    readonly completedAt: Date
  }) =>
    Effect.gen(function* () {
      const staleRuns = yield* tx
        .select({ id: schema.calculationRuns.id })
        .from(schema.calculationRuns)
        .where(
          and(
            eq(schema.calculationRuns.status, "running"),
            lt(schema.calculationRuns.startedAt, staleBefore)
          )
        )
        .orderBy(asc(schema.calculationRuns.startedAt), asc(schema.calculationRuns.id))
        .limit(limit)

      if (staleRuns.length === 0) return []

      return yield* tx
        .update(schema.calculationRuns)
        .set({
          status: "failed",
          failureCode: CALCULATION_STALE_RECOMPUTED_CODE,
          failureMessage: null,
          completedAt,
          updatedAt: completedAt,
        })
        .where(
          and(
            inArray(
              schema.calculationRuns.id,
              staleRuns.map(({ id }) => id)
            ),
            eq(schema.calculationRuns.status, "running")
          )
        )
        .returning({ principalId: schema.calculationRuns.principalId })
    })

  const findRecomputePrincipals = ({
    tx,
    limit,
  }: {
    readonly tx: CalculationTransaction
    readonly limit: number
  }) => {
    // A run covers source work only when every completed job tuple currently
    // stored for the principal was visible to that run's repeatable-read
    // snapshot. Times and raw transaction-ID ordering cannot prove visibility.
    const principalsWithCompletedJobs = tx.$with("principals_with_completed_jobs").as(
      tx
        .selectDistinctOn([schema.processingJobs.principalId], {
          principalId: schema.processingJobs.principalId,
        })
        .from(schema.processingJobs)
        .where(
          and(
            eq(schema.processingJobs.status, "completed"),
            isNotNull(schema.processingJobs.completedAt)
          )
        )
        .orderBy(asc(schema.processingJobs.principalId))
    )

    return tx
      .with(principalsWithCompletedJobs)
      .select({ principalId: principalsWithCompletedJobs.principalId })
      .from(principalsWithCompletedJobs)
      .where(
        notExists(
          tx
            .select({ id: schema.calculationRuns.id })
            .from(schema.calculationRuns)
            .where(
              and(
                eq(schema.calculationRuns.principalId, principalsWithCompletedJobs.principalId),
                ne(schema.calculationRuns.status, "failed"),
                sql`split_part(${schema.calculationRuns.inputLedgerRevision}, ':', 1) = 'v2'`,
                notExists(
                  tx
                    .select({ id: schema.processingJobs.id })
                    .from(schema.processingJobs)
                    .where(
                      and(
                        eq(
                          schema.processingJobs.principalId,
                          principalsWithCompletedJobs.principalId
                        ),
                        eq(schema.processingJobs.status, "completed"),
                        isNotNull(schema.processingJobs.completedAt),
                        sql`not pg_visible_in_snapshot(
                          ${schema.processingJobs}.xmin::text::xid8,
                          replace(
                            split_part(${schema.calculationRuns.inputLedgerRevision}, ':', 3),
                            '.',
                            ':'
                          )::pg_snapshot
                        )`
                      )
                    )
                )
              )
            )
        )
      )
      .orderBy(asc(principalsWithCompletedJobs.principalId))
      .limit(limit)
  }

  const findPendingStaleRecomputePrincipals = ({
    tx,
    limit,
  }: {
    readonly tx: CalculationTransaction
    readonly limit: number
  }) => {
    const staleRun = aliasedTable(schema.calculationRuns, "stale_calculation_run")
    const replacementRun = aliasedTable(schema.calculationRuns, "replacement_calculation_run")

    return tx
      .selectDistinctOn([staleRun.principalId], { principalId: staleRun.principalId })
      .from(staleRun)
      .where(
        and(
          eq(staleRun.status, "failed"),
          eq(staleRun.failureCode, CALCULATION_STALE_RECOMPUTED_CODE),
          isNotNull(staleRun.completedAt),
          notExists(
            tx
              .select({ id: replacementRun.id })
              .from(replacementRun)
              .where(
                and(
                  eq(replacementRun.principalId, staleRun.principalId),
                  ne(replacementRun.status, "failed"),
                  gte(replacementRun.startedAt, staleRun.completedAt)
                )
              )
          )
        )
      )
      .orderBy(asc(staleRun.principalId))
      .limit(limit)
  }

  const settleStaleAndFindRecomputePrincipals: CalculationRunRepositoryShape["settleStaleAndFindRecomputePrincipals"] =
    (params: MaintainCalculationRunsParams) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const completedAt = yield* DateTime.nowAsDate
            const failedRuns = yield* failStaleRuns({ tx, completedAt, ...params })
            const pendingStalePrincipals = yield* findPendingStaleRecomputePrincipals({
              tx,
              limit: params.limit,
            })
            const uncoveredPrincipals = yield* findRecomputePrincipals({
              tx,
              limit: params.limit,
            })

            const principalIds = [
              ...new Set([
                ...failedRuns.map(({ principalId }) => principalId),
                ...pendingStalePrincipals.map(({ principalId }) => principalId),
                ...uncoveredPrincipals.map(({ principalId }) => principalId),
              ]),
            ]
              .sort()
              .slice(0, params.limit)
              .map((principalId) => PrincipalId.make(principalId))

            return { failedStaleRuns: failedRuns.length, principalIds }
          })
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new PersistenceError({
                operation: "calculationRunRepository.settleStaleAndFindRecomputePrincipals",
                cause,
              })
          )
        )

  const claimRun = ({ tx, params, result, startedAt }: WriteContext) =>
    Effect.gen(function* () {
      const claimedRuns =
        params.writeMode === "finalize_started"
          ? []
          : yield* tx
              .insert(schema.calculationRuns)
              .values({
                id: params.id,
                principalId: params.principalId,
                jurisdiction: result.jurisdiction,
                taxYear: result.taxYear,
                reportingCurrency: params.reportingCurrency,
                engineVersion: result.engineVersion,
                ruleSetVersion: result.ruleSetVersion,
                inputLedgerRevision: params.inputLedgerRevision,
                valuationRevision: params.valuationRevision,
                status: "pending",
                accountingMethod: null,
                inventoryScope: null,
                appliedChoiceIds: [],
                appliedRules: [],
                processedEventIds: [],
                startedAt,
                completedAt: null,
                createdAt: startedAt,
                updatedAt: startedAt,
              })
              .onConflictDoNothing({ target: schema.calculationRuns.id })
              .returning({ id: schema.calculationRuns.id })

      if (claimedRuns.length === 1) {
        yield* validateReportingCurrency(params)
        return true
      }

      if (params.writeMode === "atomic") {
        return yield* new CalculationRunAlreadyStoredError({ runId: params.id })
      }
      const [runningRun] = yield* tx
        .select({
          principalId: schema.calculationRuns.principalId,
          jurisdiction: schema.calculationRuns.jurisdiction,
          taxYear: schema.calculationRuns.taxYear,
          reportingCurrency: schema.calculationRuns.reportingCurrency,
          engineVersion: schema.calculationRuns.engineVersion,
          ruleSetVersion: schema.calculationRuns.ruleSetVersion,
          inputLedgerRevision: schema.calculationRuns.inputLedgerRevision,
          valuationRevision: schema.calculationRuns.valuationRevision,
          status: schema.calculationRuns.status,
        })
        .from(schema.calculationRuns)
        .where(eq(schema.calculationRuns.id, params.id))
        .for("update")

      if (
        runningRun === undefined ||
        runningRun.status !== "running" ||
        runningRun.principalId !== params.principalId ||
        runningRun.jurisdiction !== result.jurisdiction ||
        runningRun.taxYear !== result.taxYear ||
        runningRun.reportingCurrency !== params.reportingCurrency ||
        runningRun.engineVersion !== result.engineVersion ||
        runningRun.ruleSetVersion !== result.ruleSetVersion ||
        runningRun.inputLedgerRevision !== params.inputLedgerRevision ||
        runningRun.valuationRevision !== params.valuationRevision
      ) {
        return yield* new CalculationRunAlreadyStoredError({ runId: params.id })
      }

      yield* validateReportingCurrency(params)
      return false
    })

  const writeSyncCapture = ({
    tx,
    params,
    jurisdiction,
    taxYear,
  }: {
    readonly tx: CalculationTransaction
    readonly params: Pick<
      StartCalculationRunParams,
      "id" | "principalId" | "reportingCurrency" | "syncCapture"
    >
    readonly jurisdiction: string
    readonly taxYear: number
  }) =>
    Effect.gen(function* () {
      const scope = {
        principalId: params.principalId,
        jurisdiction,
        taxYear,
        reportingCurrency: params.reportingCurrency,
      }
      const ids = params.syncCapture.requestIds
      // Lock only the recorded snapshot members. Ownership changes must reject the
      // entire start instead of silently dropping a transferred request.
      const requests =
        ids.length === 0
          ? []
          : yield* tx
              .select({
                id: schema.calculationSyncRequests.id,
                status: schema.calculationSyncRequests.status,
              })
              .from(schema.calculationSyncRequests)
              .where(
                and(
                  inArray(schema.calculationSyncRequests.id, [...ids]),
                  eq(schema.calculationSyncRequests.principalId, scope.principalId),
                  eq(schema.calculationSyncRequests.jurisdiction, scope.jurisdiction),
                  eq(schema.calculationSyncRequests.taxYear, scope.taxYear),
                  eq(schema.calculationSyncRequests.reportingCurrency, scope.reportingCurrency)
                )
              )
              .orderBy(asc(schema.calculationSyncRequests.id))
              .for("update")
      if (requests.length !== ids.length) {
        return yield* new CalculationRunAlreadyStoredError({ runId: params.id })
      }
      yield* tx.insert(schema.calculationRunSyncCaptures).values({ runId: params.id, ...scope })
      yield* writeBatches(
        ids.map((requestId) => ({ runId: params.id, requestId, ...scope })),
        (batch) => tx.insert(schema.calculationRunSyncRequests).values(batch)
      )
      const claimed = requests.filter(({ status }) => status === "queued" || status === "failed")
      if (claimed.length === 0) return
      const startedAt = yield* DateTime.nowAsDate
      yield* writeBatches(
        claimed.map(({ id }) => ({
          requestId: id,
          runId: params.id,
          ...scope,
          status: "running" as const,
          startedAt,
        })),
        (batch) => tx.insert(schema.calculationSyncAttempts).values(batch)
      )
      yield* tx
        .update(schema.calculationSyncRequests)
        .set({ status: "running" })
        .where(
          inArray(
            schema.calculationSyncRequests.id,
            claimed.map(({ id }) => id)
          )
        )
    })

  const verifySyncCapture = ({ tx, params }: WriteContext) =>
    Effect.gen(function* () {
      const [capture] = yield* tx
        .select({ runId: schema.calculationRunSyncCaptures.runId })
        .from(schema.calculationRunSyncCaptures)
        .where(eq(schema.calculationRunSyncCaptures.runId, params.id))
      const links = yield* tx
        .select({ requestId: schema.calculationRunSyncRequests.requestId })
        .from(schema.calculationRunSyncRequests)
        .where(eq(schema.calculationRunSyncRequests.runId, params.id))
      const ids = new Set(params.syncCapture.requestIds)
      if (
        capture === undefined ||
        ids.size !== params.syncCapture.requestIds.length ||
        links.length !== ids.size ||
        links.some(({ requestId }) => !ids.has(CalculationSyncRequestId.make(requestId)))
      ) {
        return yield* new CalculationRunAlreadyStoredError({ runId: params.id })
      }
    })

  const settleSyncAttempts = ({
    tx,
    params,
    status,
    failureCode,
    completedAt,
  }: {
    readonly tx: CalculationTransaction
    readonly params: Pick<FailCalculationRunParams, "id" | "principalId">
    readonly status: "succeeded" | "failed"
    readonly failureCode: string | null
    readonly completedAt: Date
  }) =>
    Effect.gen(function* () {
      const attempts = yield* tx
        .update(schema.calculationSyncAttempts)
        .set({ status, failureCode, completedAt })
        .where(
          and(
            eq(schema.calculationSyncAttempts.runId, params.id),
            eq(schema.calculationSyncAttempts.principalId, params.principalId),
            eq(schema.calculationSyncAttempts.status, "running")
          )
        )
        .returning({ requestId: schema.calculationSyncAttempts.requestId })
      if (attempts.length > 0)
        yield* tx
          .update(schema.calculationSyncRequests)
          .set({ status })
          .where(
            and(
              inArray(
                schema.calculationSyncRequests.id,
                attempts.map(({ requestId }) => requestId)
              ),
              eq(schema.calculationSyncRequests.principalId, params.principalId),
              eq(schema.calculationSyncRequests.status, "running")
            )
          )
    })

  const writeCorrectionInputs = ({
    tx,
    params,
    jurisdiction,
    taxYear,
  }: {
    readonly tx: CalculationTransaction
    readonly params: Pick<
      StartCalculationRunParams,
      "id" | "principalId" | "reportingCurrency" | "correctionInputs"
    >
    readonly jurisdiction: string
    readonly taxYear: number
  }) =>
    writeBatches(
      params.correctionInputs.map((captured) => ({
        runId: params.id,
        principalId: params.principalId,
        jurisdiction,
        taxYear,
        reportingCurrency: params.reportingCurrency,
        sourceId: captured.history.sourceId,
        targetId: captured.history.targetId,
        overrideId: captured.history.id,
        kind: captured.history.kind,
        captured,
      })),
      (batch) => tx.insert(schema.calculationRunCorrectionInputs).values(batch)
    )

  // A started run has already committed its snapshot. Compare exact recorded keys and JSON,
  // never consult current correction history when the calculation returns later.
  const verifyCorrectionInputs = ({ tx, params }: WriteContext) =>
    Effect.gen(function* () {
      const capturedJson = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        params.correctionInputs
      )
      const [stored] = yield* tx
        .select({
          count: sql<number>`count(*)::integer`,
          matches: sql<number>`count(*) filter (where exists (
        select 1 from jsonb_array_elements(${capturedJson}::jsonb) as input
        where input->'history'->>'id' = ${schema.calculationRunCorrectionInputs.overrideId}::text
          and input = ${schema.calculationRunCorrectionInputs.captured}
      ))::integer`,
        })
        .from(schema.calculationRunCorrectionInputs)
        .where(eq(schema.calculationRunCorrectionInputs.runId, params.id))
      if (
        stored?.count !== params.correctionInputs.length ||
        stored.matches !== params.correctionInputs.length ||
        new Set(params.correctionInputs.map((input) => input.history.id)).size !==
          params.correctionInputs.length
      ) {
        return yield* new CalculationRunAlreadyStoredError({ runId: params.id })
      }
    })

  const writeCustodyMembership = ({
    tx,
    runId,
    membership,
  }: {
    readonly tx: CalculationTransaction
    readonly runId: CalculationRunId
    readonly membership: ReadonlyArray<CustodyMembershipRow>
  }) => {
    const custodyUnits = [
      ...new Map(
        membership.map(({ custodyUnitId, principalId }) => [
          custodyUnitId,
          { runId, principalId, custodyUnitId },
        ])
      ).values(),
    ]
    const custodyUnitSources = membership.flatMap(({ custodyUnitId, principalId, sourceId }) =>
      sourceId === null ? [] : [{ runId, principalId, custodyUnitId, sourceId }]
    )

    return Effect.gen(function* () {
      yield* writeBatches(custodyUnits, (batch) =>
        tx.insert(schema.calculationRunCustodyUnits).values(batch)
      )
      yield* writeBatches(custodyUnitSources, (batch) =>
        tx.insert(schema.calculationRunCustodyUnitSources).values(batch)
      )
    })
  }

  const snapshotCustodyMembership = ({ tx, params }: WriteContext) =>
    Effect.gen(function* () {
      const liveMembership = yield* tx
        .select({
          custodyUnitId: schema.custodyUnits.id,
          principalId: schema.custodyUnits.principalId,
          sourceId: schema.custodyUnitSources.sourceId,
        })
        .from(schema.custodyUnits)
        .leftJoin(
          schema.custodyUnitSources,
          and(
            eq(schema.custodyUnitSources.custodyUnitId, schema.custodyUnits.id),
            eq(schema.custodyUnitSources.principalId, schema.custodyUnits.principalId)
          )
        )
        .where(eq(schema.custodyUnits.principalId, params.principalId))
        .orderBy(asc(schema.custodyUnits.id), asc(schema.custodyUnitSources.sourceId))

      yield* writeCustodyMembership({ tx, runId: params.id, membership: liveMembership })
    })

  const writeAllocations = ({ tx, params, result }: WriteContext) => {
    const rows = result.allocations.map((allocation, sequence) => ({
      runId: params.id,
      principalId: params.principalId,
      sequence,
      acquisitionEventId: allocation.acquisitionEventId,
      dispositionEventId: allocation.dispositionEventId,
      assetId: allocation.assetId,
      custodyUnitId: allocation.custodyUnitId,
      acquiredAt: allocation.acquiredAt.toDate(),
      disposedAt: allocation.disposedAt.toDate(),
      quantity: formatQuantity(allocation.quantity),
      costBasis: allocation.costBasis?.format() ?? null,
    }))

    return writeBatches(rows, (batch) => tx.insert(schema.calculationRunAllocations).values(batch))
  }

  const writeRealizedResults = ({ tx, params, result }: WriteContext) => {
    const rows = result.realizedResults.map((realized, sequence) => ({
      runId: params.id,
      sequence,
      sourceId: realized.custodySourceId,
      allocationSequence: realized.allocationSequence,
      acquisitionEventId: realized.acquisitionEventId,
      dispositionEventId: realized.dispositionEventId,
      assetId: realized.assetId,
      acquiredAt: realized.acquiredAt.toDate(),
      disposedAt: realized.disposedAt.toDate(),
      quantity: formatQuantity(realized.quantity),
      costBasis: realized.costBasis.format(),
      proceeds: realized.proceeds.format(),
      gainLoss: realized.gainLoss.format(),
      treatmentCodes: realized.treatmentCodes,
    }))

    return writeBatches(rows, (batch) =>
      tx.insert(schema.calculationRunRealizedResults).values(batch)
    )
  }

  const writeIncomeResults = ({ tx, params, result }: WriteContext) => {
    const rows = result.incomeResults.map((income, sequence) => ({
      runId: params.id,
      sequence,
      sourceId: income.custodySourceId,
      eventId: income.eventId,
      assetId: income.assetId,
      occurredAt: income.occurredAt.toDate(),
      quantity: formatQuantity(income.quantity),
      value: income.value.format(),
      treatmentCodes: income.treatmentCodes,
    }))

    return writeBatches(rows, (batch) =>
      tx.insert(schema.calculationRunIncomeResults).values(batch)
    )
  }

  const writeDerivedLots = ({ tx, params, result }: WriteContext) => {
    const rows = result.derivedLots.map((lot, sequence) => ({
      runId: params.id,
      principalId: params.principalId,
      sequence,
      acquisitionEventId: lot.acquisitionEventId,
      assetId: lot.assetId,
      custodyUnitId: lot.custodyUnitId,
      acquiredAt: lot.acquiredAt.toDate(),
      remainingQuantity: formatQuantity(lot.remainingQuantity),
      costBasisPerUnit: lot.costBasisPerUnit?.format() ?? null,
    }))

    return writeBatches(rows, (batch) => tx.insert(schema.calculationRunDerivedLots).values(batch))
  }

  const writeBlockers = ({ tx, params, result }: WriteContext) => {
    const rows = result.blockers.map((blocker, sequence) => ({
      runId: params.id,
      principalId: params.principalId,
      sequence,
      code: blocker.code,
      eventId: blocker.eventId,
      assetId: blocker.assetId ?? null,
      providerAssetRowId:
        "providerAssetRowId" in blocker ? (blocker.providerAssetRowId ?? null) : null,
      custodyUnitId: blocker.custodyUnitId,
      missingQuantity:
        blocker.missingQuantity === null ? null : formatQuantity(blocker.missingQuantity),
    }))

    return writeBatches(rows, (batch) => tx.insert(schema.calculationRunBlockers).values(batch))
  }

  const writeExplanations = ({ tx, params, result }: WriteContext) => {
    const rows = result.explanationTrace.map((entry) => ({
      runId: params.id,
      sequence: entry.sequence,
      eventId: entry.eventId,
      code: entry.code,
      valuationKind: entry.valuationKind,
      matches: entry.matches.map((match) => ({
        acquisitionEventId: match.acquisitionEventId,
        quantity: formatQuantity(match.quantity),
      })),
    }))

    return writeBatches(rows, (batch) =>
      tx.insert(schema.calculationRunExplanationEntries).values(batch)
    )
  }

  const finalizeRun = ({ tx, params, result }: WriteContext) =>
    Effect.gen(function* () {
      const completedAt = yield* DateTime.nowAsDate

      yield* tx
        .update(schema.calculationRuns)
        .set({
          status: result.status,
          accountingMethod: result.accountingMethod,
          inventoryScope: result.inventoryScope,
          appliedChoiceIds: result.appliedChoiceIds,
          appliedRules: result.appliedRules,
          processedEventIds: result.processedEventIds,
          completedAt,
          updatedAt: completedAt,
        })
        .where(eq(schema.calculationRuns.id, params.id))

      return completedAt
    })

  const activateRun = ({
    tx,
    params,
    result,
    completedAt,
  }: WriteContext & { readonly completedAt: Date }) =>
    tx
      .insert(schema.activeCalculationRuns)
      .values({
        principalId: params.principalId,
        jurisdiction: result.jurisdiction,
        taxYear: result.taxYear,
        reportingCurrency: params.reportingCurrency,
        runId: params.id,
        updatedAt: completedAt,
      })
      .onConflictDoUpdate({
        target: [
          schema.activeCalculationRuns.principalId,
          schema.activeCalculationRuns.jurisdiction,
          schema.activeCalculationRuns.taxYear,
          schema.activeCalculationRuns.reportingCurrency,
        ],
        set: { runId: params.id, updatedAt: completedAt },
        setWhere: sql`
          split_part(${params.inputLedgerRevision}, ':', 2)::numeric >=
            ${schema.activeCalculationRuns.minimumActivationRevision}
          and pg_visible_in_snapshot(
            ${schema.activeCalculationRuns.minimumActivationRevision}::text::xid8,
            replace(split_part(${params.inputLedgerRevision}, ':', 3), '.', ':')::pg_snapshot
          )
          and (
            ${schema.activeCalculationRuns.runId} is null
            or split_part(${params.inputLedgerRevision}, ':', 2)::numeric > (
              select split_part(${schema.calculationRuns.inputLedgerRevision}, ':', 2)::numeric
              from ${schema.calculationRuns}
              where ${schema.calculationRuns.id} = ${schema.activeCalculationRuns.runId}
            )
          )
        `,
      })
      .returning({ runId: schema.activeCalculationRuns.runId })

  const persistWithTransaction = (context: WriteContext) =>
    Effect.gen(function* () {
      const isNewRun = yield* claimRun(context)
      if (isNewRun) {
        yield* writeSyncCapture({
          tx: context.tx,
          params: context.params,
          jurisdiction: context.result.jurisdiction,
          taxYear: context.result.taxYear,
        })
        yield* snapshotCustodyMembership(context)
        yield* writeCorrectionInputs({
          tx: context.tx,
          params: context.params,
          jurisdiction: context.result.jurisdiction,
          taxYear: context.result.taxYear,
        })
      } else {
        yield* verifyCorrectionInputs(context)
        yield* verifySyncCapture(context)
      }
      yield* writeAllocations(context)
      yield* writeRealizedResults(context)
      yield* writeIncomeResults(context)
      yield* writeDerivedLots(context)
      yield* writeBlockers(context)
      yield* writeExplanations(context)
      const completedAt = yield* finalizeRun(context)
      yield* settleSyncAttempts({
        tx: context.tx,
        params: { id: context.params.id, principalId: context.params.principalId },
        status: "succeeded",
        failureCode: null,
        completedAt,
      })
      const activatedRows = yield* activateRun({ ...context, completedAt })

      return {
        activated: activatedRows.length === 1,
        inputLedgerRevision: context.params.inputLedgerRevision,
        valuationRevision: context.params.valuationRevision,
        status: context.result.status,
      }
    })

  const persist: CalculationRunRepositoryShape["persist"] = (params) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const startedAt = yield* DateTime.nowAsDate
          const { result } = params
          const context = { tx, params, result, startedAt }

          return yield* persistWithTransaction(context)
        })
      )
      .pipe(
        Effect.mapError((error) =>
          Schema.is(CalculationRunAlreadyStoredError)(error) ||
          Schema.is(CalculationRunCurrencyMismatchError)(error)
            ? error
            : new PersistenceError({
                operation: "calculationRunRepository.persist",
                cause: error,
              })
        )
      )

  const start: CalculationRunRepositoryShape["start"] = (params: StartCalculationRunParams) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const startedAt = yield* DateTime.nowAsDate
          const startedRuns = yield* tx
            .insert(schema.calculationRuns)
            .values({
              id: params.id,
              principalId: params.principalId,
              jurisdiction: params.jurisdiction,
              taxYear: params.taxYear,
              reportingCurrency: params.reportingCurrency,
              engineVersion: params.engineVersion,
              ruleSetVersion: params.ruleSetVersion,
              inputLedgerRevision: params.inputLedgerRevision,
              valuationRevision: params.valuationRevision,
              status: "running",
              accountingMethod: null,
              inventoryScope: null,
              appliedChoiceIds: [],
              appliedRules: [],
              processedEventIds: [],
              startedAt,
              completedAt: null,
              createdAt: startedAt,
              updatedAt: startedAt,
            })
            .onConflictDoNothing({ target: schema.calculationRuns.id })
            .returning({ id: schema.calculationRuns.id })

          if (startedRuns.length === 0) {
            return yield* new CalculationRunAlreadyStoredError({ runId: params.id })
          }

          yield* writeSyncCapture({
            tx,
            params,
            jurisdiction: params.jurisdiction,
            taxYear: params.taxYear,
          })
          yield* writeCorrectionInputs({
            tx,
            params,
            jurisdiction: params.jurisdiction,
            taxYear: params.taxYear,
          })
          yield* writeCustodyMembership({
            tx,
            runId: params.id,
            membership: params.custodyUnitMembership.map(({ custodyUnitId, sourceId }) => ({
              principalId: params.principalId,
              custodyUnitId,
              sourceId,
            })),
          })
        })
      )
      .pipe(
        Effect.mapError((error) =>
          Schema.is(CalculationRunAlreadyStoredError)(error)
            ? error
            : new PersistenceError({
                operation: "calculationRunRepository.start",
                cause: error,
              })
        )
      )

  const fail: CalculationRunRepositoryShape["fail"] = (params: FailCalculationRunParams) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const completedAt = yield* DateTime.nowAsDate
          const failedRuns = yield* tx
            .update(schema.calculationRuns)
            .set({
              status: "failed",
              failureCode: params.failureCode,
              failureMessage: null,
              completedAt,
              updatedAt: completedAt,
            })
            .where(
              and(
                eq(schema.calculationRuns.id, params.id),
                eq(schema.calculationRuns.principalId, params.principalId),
                eq(schema.calculationRuns.status, "running")
              )
            )
            .returning({ id: schema.calculationRuns.id })

          if (failedRuns.length === 0) {
            return yield* new CalculationRunAlreadyStoredError({ runId: params.id })
          }
          yield* settleSyncAttempts({
            tx,
            params,
            status: "failed",
            failureCode: params.failureCode,
            completedAt,
          })
        })
      )
      .pipe(
        Effect.mapError((error) =>
          Schema.is(CalculationRunAlreadyStoredError)(error)
            ? error
            : new PersistenceError({
                operation: "calculationRunRepository.fail",
                cause: error,
              })
        )
      )

  return CalculationRunRepository.of({
    fail,
    getLatestStatus,
    getSyncStatus,
    listActiveTaxYears,
    persist,
    settleStaleAndFindRecomputePrincipals,
    start,
  })
})

/** Live calculation-run repository backed by PostgreSQL. */
export const CalculationRunRepositoryLive = Layer.effect(CalculationRunRepository, make)
