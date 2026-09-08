/**
 * SourceSyncJobRepositoryLive - Processing job persistence for sync-engine orchestration.
 *
 * @module SourceSyncJobRepositoryLive
 */

import { SyncCreditReasonCode } from "@my/core/billing"
import { and, asc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { isActiveProcessingJobConflict } from "../errors/ProcessingJobConflict.ts"
import { PersistenceError, wrapSqlError } from "../errors/RepositoryError.ts"
import { drizzle } from "./PgClientLive.ts"
import { schema } from "../schema/index.ts"
import {
  type CreateOrReuseSourceSyncJobResult,
  type ActiveSourceSyncJobStatus,
  type SourceSyncExecutionJob,
  type SourceSyncJobMode,
  type SourceSyncJobStatus,
  getSourceSyncProgressPercent,
  SourceSyncJobExecutionRecordConflictError,
  SourceSyncJobExecutionRecordNotFoundError,
  SourceSyncJobPrerequisitesPendingError,
  SourceSyncJobRecordNotVisibleError,
  SourceSyncJobRepository,
  SyncEngineStorageError,
  toPublicSourceSyncJobStatus,
  type SourceSyncJobRepositoryShape,
  type SourceSyncPendingDispatchJob,
  type SourceSyncRepairableActiveJob,
  type SourceSyncStaleActiveJob,
} from "@my/sync-engine/services"
import {
  decodeSourceSyncJobProgressSnapshot,
  highWatermarkToIso,
  nowDate,
  toSyncEngineStorageError,
  wrapSyncEngineSqlError,
} from "./SyncEngineRepositorySupport.ts"

const ACTIVE_JOB_STATUSES = [
  "pending",
  "processing",
] as const satisfies ReadonlyArray<ActiveSourceSyncJobStatus>
const MAX_CREATE_OR_REUSE_RACE_ATTEMPTS = 3
const PREREQUISITE_FAILURE_MESSAGE = "Prerequisite processing job did not complete successfully."
const processingJobPrerequisitesSucceeded = sql<boolean>`not exists (
  select 1
  from processing_job_dependencies dependency
  inner join processing_jobs prerequisite
    on prerequisite.id = dependency.prerequisite_job_id
  where dependency.job_id = ${schema.processingJobs.id}
    and (
      prerequisite.status <> 'completed'
      or coalesce((prerequisite.progress_details ->> 'failedRecords')::integer, 0) <> 0
    )
)`

interface PersistedExecutionJobRow {
  readonly id: string
  readonly sourceId: string
  readonly principalId: string
  readonly mode: SourceSyncExecutionJob["mode"]
  readonly status: SourceSyncJobStatus
}

const decodeCreditReasonCode = Schema.decodeUnknownEffect(SyncCreditReasonCode)

/** Decode the persisted credit-outcome columns, falling back to null on any malformed row. */
const toCreditOutcome = (row: {
  readonly creditReasonCode: string | null
  readonly creditsAvailable: number | null
  readonly creditsConsumed: number | null
  readonly additionalCreditsRequired: number | null
}) => {
  const { creditReasonCode, creditsAvailable, creditsConsumed, additionalCreditsRequired } = row

  return creditReasonCode === null || creditsAvailable === null || creditsConsumed === null
    ? Effect.succeed(null)
    : decodeCreditReasonCode(creditReasonCode).pipe(
        Effect.map((reasonCode) => ({
          reasonCode,
          availableCredits: creditsAvailable,
          creditsConsumed,
          additionalCreditsRequired,
        })),
        Effect.orElseSucceed(() => null)
      )
}

const toExecutionJob = ({
  job,
  jobId,
}: {
  readonly job: PersistedExecutionJobRow
  readonly jobId: string
}): Effect.Effect<SourceSyncExecutionJob, SourceSyncJobExecutionRecordConflictError> =>
  Effect.gen(function* () {
    if (job.status !== "pending" && job.status !== "processing") {
      return yield* new SourceSyncJobExecutionRecordConflictError({
        jobId,
        reason: `Job status ${job.status} is not executable.`,
      })
    }

    return {
      id: job.id,
      sourceId: job.sourceId,
      principalId: job.principalId,
      mode: job.mode,
      status: job.status,
    } satisfies SourceSyncExecutionJob
  })

const make = Effect.gen(function* () {
  const db = yield* drizzle
  type SourceSyncJobExecutor = Pick<typeof db, "insert" | "select" | "update">

  const preserveExpectedExecutionError = (operation: string) =>
    Effect.mapError((error: unknown) =>
      Schema.is(SourceSyncJobExecutionRecordNotFoundError)(error) ||
      Schema.is(SourceSyncJobExecutionRecordConflictError)(error)
        ? error
        : toSyncEngineStorageError({ error, operation })
    )

  const preserveClaimExecutionError = (operation: string) =>
    Effect.mapError((error: unknown) =>
      Schema.is(SourceSyncJobExecutionRecordNotFoundError)(error) ||
      Schema.is(SourceSyncJobExecutionRecordConflictError)(error) ||
      Schema.is(SourceSyncJobPrerequisitesPendingError)(error)
        ? error
        : toSyncEngineStorageError({ error, operation })
    )

  const materializeFollowUpJob = ({
    executor,
    jobId,
    sourceId,
    principalId,
    followUpMode,
    createdAt,
  }: {
    readonly executor: SourceSyncJobExecutor
    readonly jobId: string
    readonly sourceId: string
    readonly principalId: string
    readonly followUpMode: SourceSyncJobMode | null
    readonly createdAt: Date
  }) =>
    Effect.gen(function* () {
      if (followUpMode === null) return

      const [followUpJob] = yield* executor
        .insert(schema.processingJobs)
        .values({
          sourceId,
          principalId,
          mode: followUpMode,
          status: "pending",
          attemptCount: 0,
          maxAttempts: 3,
          createdAt,
          updatedAt: createdAt,
        })
        .returning({ id: schema.processingJobs.id })
        .pipe(wrapSyncEngineSqlError("sourceSyncJobRepository.materializeFollowUpJob.insert"))

      if (followUpJob === undefined) {
        return yield* new SyncEngineStorageError({
          operation: "sourceSyncJobRepository.materializeFollowUpJob.insert",
          cause: { sourceId, jobId },
        })
      }

      yield* executor
        .update(schema.processingJobs)
        .set({ followUpJobId: followUpJob.id })
        .where(eq(schema.processingJobs.id, jobId))
        .pipe(
          Effect.asVoid,
          wrapSyncEngineSqlError("sourceSyncJobRepository.materializeFollowUpJob.link")
        )

      // The follow-up replay now owns every unfinished rebuild for this
      // source, including rows stuck at operator_attention from earlier
      // failures. Repointing keeps rebuild tracking on the job that will
      // actually run next.
      if (followUpMode === "replay") {
        yield* executor
          .update(schema.assetDecisionRematerializations)
          .set({
            processingJobId: followUpJob.id,
            status: "pending",
            failureCode: null,
            lastFailureAt: null,
            updatedAt: createdAt,
          })
          .where(
            and(
              eq(schema.assetDecisionRematerializations.sourceId, sourceId),
              ne(schema.assetDecisionRematerializations.status, "complete")
            )
          )
          .pipe(
            Effect.asVoid,
            wrapSyncEngineSqlError("sourceSyncJobRepository.materializeFollowUpJob.repointRebuilds")
          )
      }
    })

  /**
   * Record the outcome of a finished replay on every unfinished decision
   * rebuild for the source. A replay rebuilds the whole source from raw
   * records, so one clean replay completes every tracked rebuild, and any
   * failure parks them at operator_attention until a later replay succeeds.
   * Rebuild readers (tax readiness, exception status) trust this stored
   * status instead of re-deriving it from job chains.
   */
  const settleSourceRebuilds = ({
    executor,
    sourceId,
    outcome,
    at,
  }: {
    readonly executor: SourceSyncJobExecutor
    readonly sourceId: string
    readonly outcome:
      | { readonly _tag: "complete" }
      | { readonly _tag: "failed"; readonly failureCode: string }
    readonly at: Date
  }) =>
    executor
      .update(schema.assetDecisionRematerializations)
      .set(
        outcome._tag === "complete"
          ? {
              status: "complete",
              failureCode: null,
              lastFailureAt: null,
              updatedAt: at,
            }
          : {
              status: "operator_attention",
              failureCode: outcome.failureCode,
              lastFailureAt: at,
              updatedAt: at,
            }
      )
      .where(
        and(
          eq(schema.assetDecisionRematerializations.sourceId, sourceId),
          ne(schema.assetDecisionRematerializations.status, "complete")
        )
      )
      .pipe(Effect.asVoid, wrapSyncEngineSqlError("sourceSyncJobRepository.settleSourceRebuilds"))

  const failPendingDependentJobs = ({
    executor,
    prerequisiteJobId,
    failureCode,
    completedAt,
  }: {
    readonly executor: SourceSyncJobExecutor
    readonly prerequisiteJobId: string
    readonly failureCode: string
    readonly completedAt: Date
  }) =>
    Effect.gen(function* () {
      let frontierJobIds: ReadonlyArray<string> = [prerequisiteJobId]
      const replaySourceIds = new Set<string>()

      while (frontierJobIds.length > 0) {
        const dependentJobs = yield* executor
          .select({
            id: schema.processingJobs.id,
            sourceId: schema.processingJobs.sourceId,
            mode: schema.processingJobs.mode,
          })
          .from(schema.processingJobDependencies)
          .innerJoin(
            schema.processingJobs,
            eq(schema.processingJobs.id, schema.processingJobDependencies.jobId)
          )
          .where(
            and(
              inArray(schema.processingJobDependencies.prerequisiteJobId, frontierJobIds),
              eq(schema.processingJobs.status, "pending")
            )
          )
          .orderBy(asc(schema.processingJobs.id))
          .for("update")
          .pipe(
            wrapSyncEngineSqlError(
              "sourceSyncJobRepository.failPendingDependentJobs.lockDependents"
            )
          )

        const dependentJobIds = dependentJobs.map(({ id }) => id)
        if (dependentJobIds.length === 0) break

        const failedJobs = yield* executor
          .update(schema.processingJobs)
          .set({
            status: "failed",
            completedAt,
            errorMessage: PREREQUISITE_FAILURE_MESSAGE,
            progressDetails: { failureCode, prerequisiteJobId },
            workerId: null,
            updatedAt: completedAt,
          })
          .where(
            and(
              inArray(schema.processingJobs.id, dependentJobIds),
              eq(schema.processingJobs.status, "pending")
            )
          )
          .returning({
            id: schema.processingJobs.id,
            sourceId: schema.processingJobs.sourceId,
            mode: schema.processingJobs.mode,
          })
          .pipe(wrapSyncEngineSqlError("sourceSyncJobRepository.failPendingDependentJobs.update"))

        for (const failedJob of failedJobs) {
          if (failedJob.mode === "replay") replaySourceIds.add(failedJob.sourceId)
        }
        frontierJobIds = failedJobs.map(({ id }) => id)
      }

      yield* Effect.forEach(
        [...replaySourceIds].sort(),
        (sourceId) =>
          settleSourceRebuilds({
            executor,
            sourceId,
            outcome: { _tag: "failed", failureCode },
            at: completedAt,
          }),
        { concurrency: 1, discard: true }
      )
    })

  const selectActiveJobFields = {
    id: schema.processingJobs.id,
    sourceId: schema.processingJobs.sourceId,
    principalId: schema.processingJobs.principalId,
    mode: schema.processingJobs.mode,
    status: schema.processingJobs.status,
    updatedAt: schema.processingJobs.updatedAt,
    queueName: schema.processingJobs.queueName,
    queueJobId: schema.processingJobs.queueJobId,
  } as const

  const selectExecutionJobFields = {
    id: schema.processingJobs.id,
    sourceId: schema.processingJobs.sourceId,
    principalId: schema.processingJobs.principalId,
    mode: schema.processingJobs.mode,
    status: schema.processingJobs.status,
  } as const

  const loadExecutionJobById = ({
    jobId,
    operation,
  }: {
    readonly jobId: string
    readonly operation: string
  }) =>
    Effect.gen(function* () {
      const [job] = yield* db
        .select(selectExecutionJobFields)
        .from(schema.processingJobs)
        .where(eq(schema.processingJobs.id, jobId))
        .limit(1)
        .pipe(wrapSyncEngineSqlError(operation))

      if (job === undefined) {
        return yield* new SourceSyncJobExecutionRecordNotFoundError({ jobId })
      }

      return yield* toExecutionJob({ job, jobId })
    })

  const failExpectedState = ({
    jobId,
    operation,
    reason,
  }: {
    readonly jobId: string
    readonly operation: string
    readonly reason: string
  }) =>
    loadExecutionJobById({ jobId, operation }).pipe(
      Effect.flatMap(() =>
        Effect.fail(new SourceSyncJobExecutionRecordConflictError({ jobId, reason }))
      )
    )

  const jobPrerequisitesSucceeded = ({
    executor,
    jobId,
  }: {
    readonly executor: SourceSyncJobExecutor
    readonly jobId: string
  }) =>
    executor
      .select({ prerequisiteJobId: schema.processingJobDependencies.prerequisiteJobId })
      .from(schema.processingJobDependencies)
      .innerJoin(
        schema.processingJobs,
        eq(schema.processingJobs.id, schema.processingJobDependencies.prerequisiteJobId)
      )
      .where(
        and(
          eq(schema.processingJobDependencies.jobId, jobId),
          or(
            ne(schema.processingJobs.status, "completed"),
            sql`coalesce(
              (${schema.processingJobs.progressDetails} ->> 'failedRecords')::integer,
              0
            ) <> 0`
          )
        )
      )
      .limit(1)
      .pipe(
        wrapSyncEngineSqlError("sourceSyncJobRepository.jobPrerequisitesSucceeded"),
        Effect.map((blockedPrerequisites) => blockedPrerequisites.length === 0)
      )

  const findActiveJob: SourceSyncJobRepositoryShape["findActiveJob"] = ({
    sourceId,
    principalId,
  }) =>
    db
      .select(selectActiveJobFields)
      .from(schema.processingJobs)
      .where(
        and(
          eq(schema.processingJobs.sourceId, sourceId),
          eq(schema.processingJobs.principalId, principalId),
          inArray(schema.processingJobs.status, ACTIVE_JOB_STATUSES)
        )
      )
      .limit(1)
      .pipe(
        wrapSyncEngineSqlError("sourceSyncJobRepository.findActiveJob"),
        Effect.map((jobs) =>
          jobs.flatMap((job) => {
            if (job.status === "pending" || job.status === "processing") {
              return [
                {
                  id: job.id,
                  sourceId: job.sourceId,
                  principalId: job.principalId,
                  mode: job.mode,
                  status: job.status,
                  updatedAt: job.updatedAt,
                  queueName: job.queueName,
                  queueJobId: job.queueJobId,
                },
              ]
            }

            return []
          })
        )
      )

  const createProcessingJob = ({
    sourceId,
    principalId,
    mode,
    maxAttempts,
  }: {
    readonly sourceId: string
    readonly principalId: string
    readonly mode: "sync" | "replay"
    readonly maxAttempts: number
  }): Effect.Effect<string, PersistenceError> =>
    Effect.gen(function* () {
      const [job] = yield* db
        .insert(schema.processingJobs)
        .values({
          sourceId,
          principalId,
          mode,
          status: "pending",
          attemptCount: 0,
          maxAttempts,
          progressDetails: { mode },
        })
        .returning({ id: schema.processingJobs.id })
        .pipe(wrapSqlError("sourceSyncJobRepository.createProcessingJob.insert"))

      if (job === undefined) {
        return yield* new PersistenceError({
          operation: "sourceSyncJobRepository.createProcessingJob.insert",
          cause: "failed to create processing job",
        })
      }

      return job.id
    })

  const createOrReuseJob: SourceSyncJobRepositoryShape["createOrReuseJob"] = ({
    sourceId,
    principalId,
    mode,
    maxAttempts,
  }) => {
    const attemptCreateOrReuse = (
      attemptsRemaining: number
    ): Effect.Effect<CreateOrReuseSourceSyncJobResult, SyncEngineStorageError> =>
      createProcessingJob({ sourceId, principalId, mode, maxAttempts }).pipe(
        Effect.map(
          (jobId): CreateOrReuseSourceSyncJobResult => ({
            _tag: "CreatedSourceSyncJob",
            id: jobId,
          })
        ),
        Effect.catch((error) => {
          if (!isActiveProcessingJobConflict(error)) {
            return Effect.fail(toSyncEngineStorageError({ error }))
          }

          const retryAfterCompletionRace = () =>
            attemptsRemaining > 1
              ? Effect.suspend(() => attemptCreateOrReuse(attemptsRemaining - 1))
              : Effect.fail(toSyncEngineStorageError({ error }))

          return findActiveJob({ sourceId, principalId }).pipe(
            Effect.flatMap(([concurrentJob]) =>
              Effect.gen(function* () {
                // The conflicting job may finish before it can be read. Retry the
                // insert so this request can become the new active job.
                if (concurrentJob === undefined) {
                  return yield* retryAfterCompletionRace()
                }

                if (mode === "replay" && concurrentJob.mode !== "replay") {
                  const [updatedJob] = yield* db
                    .update(schema.processingJobs)
                    .set({ followUpMode: "replay" })
                    .where(
                      and(
                        eq(schema.processingJobs.id, concurrentJob.id),
                        inArray(schema.processingJobs.status, ACTIVE_JOB_STATUSES)
                      )
                    )
                    .returning({ id: schema.processingJobs.id })
                    .pipe(
                      wrapSyncEngineSqlError(
                        "sourceSyncJobRepository.createOrReuseJob.requestFollowUp"
                      )
                    )

                  // The job may finish between the read and conditional update.
                  // Retry against the active job that now owns the source.
                  if (updatedJob === undefined) {
                    return yield* retryAfterCompletionRace()
                  }
                }

                return {
                  _tag: "ReusedSourceSyncJob",
                  id: concurrentJob.id,
                  sourceId: concurrentJob.sourceId,
                  principalId: concurrentJob.principalId,
                  mode: concurrentJob.mode,
                  status: concurrentJob.status,
                  queueName: concurrentJob.queueName,
                  queueJobId: concurrentJob.queueJobId,
                } satisfies CreateOrReuseSourceSyncJobResult
              })
            )
          )
        })
      )

    return attemptCreateOrReuse(MAX_CREATE_OR_REUSE_RACE_ATTEMPTS)
  }

  const attachQueueMetadata: SourceSyncJobRepositoryShape["attachQueueMetadata"] = ({
    jobId,
    queueName,
    queueJobId,
    queuedAt,
  }) =>
    Effect.gen(function* () {
      const [job] = yield* db
        .update(schema.processingJobs)
        .set({
          queueName,
          queueJobId,
          queuedAt,
          updatedAt: queuedAt,
        })
        .where(
          and(
            eq(schema.processingJobs.id, jobId),
            inArray(schema.processingJobs.status, ACTIVE_JOB_STATUSES)
          )
        )
        .returning({ id: schema.processingJobs.id })
        .pipe(wrapSyncEngineSqlError("sourceSyncJobRepository.attachQueueMetadata.update"))

      if (job === undefined) {
        return yield* failExpectedState({
          jobId,
          operation: "sourceSyncJobRepository.attachQueueMetadata.select",
          reason: "Only active jobs can receive queue metadata.",
        })
      }
    })

  const claimJob: SourceSyncJobRepositoryShape["claimJob"] = ({ jobId, workerId, startedAt }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const [job] = yield* tx
            .select(selectExecutionJobFields)
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.id, jobId))
            .limit(1)
            .for("update")
            .pipe(wrapSyncEngineSqlError("sourceSyncJobRepository.claimJob.lock"))

          if (job === undefined) {
            return yield* new SourceSyncJobExecutionRecordNotFoundError({ jobId })
          }
          if (job.status !== "pending") {
            return yield* new SourceSyncJobExecutionRecordConflictError({
              jobId,
              reason: `Job status ${job.status} is not claimable.`,
            })
          }
          const prerequisitesSucceeded = yield* jobPrerequisitesSucceeded({ executor: tx, jobId })
          if (!prerequisitesSucceeded) {
            return yield* new SourceSyncJobPrerequisitesPendingError({
              jobId,
              sourceId: job.sourceId,
            })
          }

          const [claimedJob] = yield* tx
            .update(schema.processingJobs)
            .set({
              status: "processing",
              workerId,
              startedAt,
              heartbeatAt: startedAt,
              completedAt: null,
              nextRetryAt: null,
              errorMessage: null,
              updatedAt: startedAt,
            })
            .where(
              and(
                eq(schema.processingJobs.id, jobId),
                eq(schema.processingJobs.status, "pending"),
                isNotNull(schema.processingJobs.principalId),
                processingJobPrerequisitesSucceeded
              )
            )
            .returning(selectExecutionJobFields)
            .pipe(wrapSyncEngineSqlError("sourceSyncJobRepository.claimJob.update"))

          if (claimedJob === undefined) {
            return yield* new SourceSyncJobExecutionRecordConflictError({
              jobId,
              reason: "The pending job changed while it was being claimed.",
            })
          }

          return yield* toExecutionJob({ job: claimedJob, jobId })
        })
      )
      .pipe(preserveClaimExecutionError("sourceSyncJobRepository.claimJob"))

  const heartbeatJob: SourceSyncJobRepositoryShape["heartbeatJob"] = ({
    jobId,
    workerId,
    heartbeatAt,
  }) =>
    Effect.gen(function* () {
      const [job] = yield* db
        .update(schema.processingJobs)
        .set({ heartbeatAt, updatedAt: heartbeatAt })
        .where(
          and(
            eq(schema.processingJobs.id, jobId),
            eq(schema.processingJobs.status, "processing"),
            eq(schema.processingJobs.workerId, workerId)
          )
        )
        .returning({ id: schema.processingJobs.id })
        .pipe(wrapSyncEngineSqlError("sourceSyncJobRepository.heartbeatJob.update"))

      if (job === undefined) {
        return yield* failExpectedState({
          jobId,
          operation: "sourceSyncJobRepository.heartbeatJob.select",
          reason: "Only the worker that claimed a processing job can heartbeat it.",
        })
      }
    })

  const recordRetryableFailure: SourceSyncJobRepositoryShape["recordRetryableFailure"] = ({
    jobId,
    message,
    attemptCount,
    nextRetryAt,
  }) =>
    Effect.gen(function* () {
      const now = nowDate()
      const [job] = yield* db
        .update(schema.processingJobs)
        .set({
          status: "pending",
          attemptCount,
          startedAt: null,
          heartbeatAt: null,
          nextRetryAt,
          completedAt: null,
          errorMessage: message,
          workerId: null,
          updatedAt: now,
        })
        .where(
          and(eq(schema.processingJobs.id, jobId), eq(schema.processingJobs.status, "processing"))
        )
        .returning({ id: schema.processingJobs.id })
        .pipe(wrapSyncEngineSqlError("sourceSyncJobRepository.recordRetryableFailure.update"))

      if (job === undefined) {
        return yield* failExpectedState({
          jobId,
          operation: "sourceSyncJobRepository.recordRetryableFailure.select",
          reason: "Only processing jobs can record retryable failures.",
        })
      }
    })

  const recoverStaleActiveJob: SourceSyncJobRepositoryShape["recoverStaleActiveJob"] = ({
    sourceId,
    jobId,
    staleBefore,
    message,
    completedAt,
  }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const [job] = yield* tx
            .update(schema.processingJobs)
            .set({
              status: "failed",
              completedAt,
              errorMessage: message,
              workerId: null,
              updatedAt: completedAt,
            })
            .where(
              and(
                eq(schema.processingJobs.id, jobId),
                eq(schema.processingJobs.sourceId, sourceId),
                eq(schema.processingJobs.status, "processing"),
                or(
                  lt(schema.processingJobs.heartbeatAt, staleBefore),
                  and(
                    isNull(schema.processingJobs.heartbeatAt),
                    lt(schema.processingJobs.updatedAt, staleBefore)
                  )
                )
              )
            )
            .returning({
              id: schema.processingJobs.id,
              sourceId: schema.processingJobs.sourceId,
              principalId: schema.processingJobs.principalId,
              mode: schema.processingJobs.mode,
              followUpMode: schema.processingJobs.followUpMode,
            })
            .pipe(wrapSyncEngineSqlError("sourceSyncJobRepository.recoverStaleActiveJob.update"))

          if (job === undefined) {
            return yield* failExpectedState({
              jobId,
              operation: "sourceSyncJobRepository.recoverStaleActiveJob.select",
              reason: "Only processing jobs that are still stale can be recovered.",
            })
          }

          yield* tx
            .delete(schema.creditLedger)
            .where(eq(schema.creditLedger.replayReservationId, jobId))
            .pipe(
              wrapSyncEngineSqlError(
                "sourceSyncJobRepository.recoverStaleActiveJob.releaseReplayCredits"
              )
            )

          yield* materializeFollowUpJob({
            executor: tx,
            jobId: job.id,
            sourceId: job.sourceId,
            principalId: job.principalId,
            followUpMode: job.followUpMode,
            createdAt: completedAt,
          })

          if (job.mode === "replay" && job.followUpMode !== "replay") {
            yield* settleSourceRebuilds({
              executor: tx,
              sourceId: job.sourceId,
              outcome: { _tag: "failed", failureCode: "replay_interrupted" },
              at: completedAt,
            })
          }

          yield* failPendingDependentJobs({
            executor: tx,
            prerequisiteJobId: job.id,
            failureCode: "replay_prerequisite_interrupted",
            completedAt,
          })

          yield* Effect.logWarning(
            { sourceId, jobId, completedAt: completedAt.toISOString() },
            "source-sync:stale-active-job-recovered"
          )
        })
      )
      .pipe(preserveExpectedExecutionError("sourceSyncJobRepository.recoverStaleActiveJob"))

  const failJob: SourceSyncJobRepositoryShape["failJob"] = ({ jobId, message, completedAt }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const [job] = yield* tx
            .update(schema.processingJobs)
            .set({
              status: "failed",
              completedAt,
              errorMessage: message,
              updatedAt: completedAt,
            })
            .where(
              and(
                eq(schema.processingJobs.id, jobId),
                eq(schema.processingJobs.status, "processing")
              )
            )
            .returning({
              id: schema.processingJobs.id,
              sourceId: schema.processingJobs.sourceId,
              principalId: schema.processingJobs.principalId,
              mode: schema.processingJobs.mode,
              followUpMode: schema.processingJobs.followUpMode,
            })
            .pipe(wrapSyncEngineSqlError("sourceSyncJobRepository.failJob.update"))

          if (job === undefined) {
            return yield* failExpectedState({
              jobId,
              operation: "sourceSyncJobRepository.failJob.select",
              reason: "Only processing jobs can fail.",
            })
          }

          yield* materializeFollowUpJob({
            executor: tx,
            jobId: job.id,
            sourceId: job.sourceId,
            principalId: job.principalId,
            followUpMode: job.followUpMode,
            createdAt: completedAt,
          })

          if (job.mode === "replay" && job.followUpMode !== "replay") {
            yield* settleSourceRebuilds({
              executor: tx,
              sourceId: job.sourceId,
              outcome: { _tag: "failed", failureCode: "replay_failed" },
              at: completedAt,
            })
          }

          yield* failPendingDependentJobs({
            executor: tx,
            prerequisiteJobId: job.id,
            failureCode: "replay_prerequisite_failed",
            completedAt,
          })
        })
      )
      .pipe(preserveExpectedExecutionError("sourceSyncJobRepository.failJob"))

  const failCreditRequiredJob: SourceSyncJobRepositoryShape["failCreditRequiredJob"] = ({
    jobId,
    completedAt,
    reasonCode,
    availableCredits,
    creditsConsumed,
    additionalCreditsRequired,
  }) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const [job] = yield* tx
            .update(schema.processingJobs)
            .set({
              status: "credit_required",
              completedAt,
              // Clients derive localized copy from the status and the credit
              // fields; no server-authored message is stored.
              errorMessage: null,
              creditReasonCode: reasonCode,
              creditsAvailable: availableCredits,
              creditsConsumed,
              additionalCreditsRequired,
              updatedAt: completedAt,
            })
            .where(
              and(
                eq(schema.processingJobs.id, jobId),
                eq(schema.processingJobs.status, "processing")
              )
            )
            .returning({
              id: schema.processingJobs.id,
              sourceId: schema.processingJobs.sourceId,
              principalId: schema.processingJobs.principalId,
              mode: schema.processingJobs.mode,
              followUpMode: schema.processingJobs.followUpMode,
            })
            .pipe(wrapSyncEngineSqlError("sourceSyncJobRepository.failCreditRequiredJob.update"))

          if (job === undefined) {
            return yield* failExpectedState({
              jobId,
              operation: "sourceSyncJobRepository.failCreditRequiredJob.select",
              reason: "Only processing jobs can become credit-required.",
            })
          }

          yield* materializeFollowUpJob({
            executor: tx,
            jobId: job.id,
            sourceId: job.sourceId,
            principalId: job.principalId,
            followUpMode: job.followUpMode,
            createdAt: completedAt,
          })

          if (job.mode === "replay" && job.followUpMode !== "replay") {
            yield* settleSourceRebuilds({
              executor: tx,
              sourceId: job.sourceId,
              outcome: { _tag: "failed", failureCode: reasonCode },
              at: completedAt,
            })
          }

          yield* failPendingDependentJobs({
            executor: tx,
            prerequisiteJobId: job.id,
            failureCode: "replay_prerequisite_credit_required",
            completedAt,
          })
        })
      )
      .pipe(preserveExpectedExecutionError("sourceSyncJobRepository.failCreditRequiredJob"))

  const completeJob: SourceSyncJobRepositoryShape["completeJob"] = ({ jobId, state }) => {
    const completedAt = nowDate()
    return db
      .transaction((tx) =>
        Effect.gen(function* () {
          // Claims lock the source before changing job ownership; completion uses the same order.
          yield* tx
            .select({ id: schema.sources.id })
            .from(schema.sources)
            .innerJoin(schema.processingJobs, eq(schema.processingJobs.sourceId, schema.sources.id))
            .where(eq(schema.processingJobs.id, jobId))
            .for("update", { of: schema.sources })
            .pipe(wrapSyncEngineSqlError("sourceSyncJobRepository.completeJob.lockSource"))

          const [job] = yield* tx
            .update(schema.processingJobs)
            .set({
              status: "completed",
              completedAt,
              errorMessage: null,
              progressDetails: {
                phase: state.phase,
                processedRecords: state.processedRecords,
                totalRecords: state.totalRecords,
                fetchedRecords: state.fetchedRecords,
                normalizedRecords: state.normalizedRecords,
                failedRecords: state.failedRecords,
                cursorPayload: state.cursorPayload,
                highWatermark: highWatermarkToIso(state.highWatermark),
              },
              checkpointExternalId: state.checkpointExternalId,
              checkpointPayload: state.cursorPayload,
              updatedAt: completedAt,
            })
            .where(
              and(
                eq(schema.processingJobs.id, jobId),
                eq(schema.processingJobs.status, "processing")
              )
            )
            .returning({
              id: schema.processingJobs.id,
              sourceId: schema.processingJobs.sourceId,
              principalId: schema.processingJobs.principalId,
              mode: schema.processingJobs.mode,
              followUpMode: schema.processingJobs.followUpMode,
            })
            .pipe(wrapSyncEngineSqlError("sourceSyncJobRepository.completeJob.update"))

          if (job === undefined) {
            return yield* failExpectedState({
              jobId,
              operation: "sourceSyncJobRepository.completeJob.select",
              reason: "Only processing jobs can complete.",
            })
          }

          const currentYear = DateTime.toParts(
            DateTime.setZoneNamedUnsafe(DateTime.makeUnsafe(completedAt), "Europe/Berlin")
          ).year
          const activeScopes = yield* tx
            .select({ taxYear: schema.activeCalculationRuns.taxYear })
            .from(schema.activeCalculationRuns)
            .where(
              and(
                eq(schema.activeCalculationRuns.principalId, job.principalId),
                eq(schema.activeCalculationRuns.jurisdiction, "DE"),
                eq(schema.activeCalculationRuns.reportingCurrency, "EUR")
              )
            )
            .pipe(wrapSyncEngineSqlError("sourceSyncJobRepository.completeJob.scopes"))
          const taxYears = [
            ...new Set([currentYear, ...activeScopes.map(({ taxYear }) => taxYear)]),
          ]

          yield* tx
            .insert(schema.calculationSyncRequests)
            .values(
              taxYears.map((taxYear) => ({
                principalId: job.principalId,
                sourceId: job.sourceId,
                sourceJobId: job.id,
                jurisdiction: "DE",
                taxYear,
                reportingCurrency: "EUR",
                requestedAt: completedAt,
              }))
            )
            .pipe(wrapSyncEngineSqlError("sourceSyncJobRepository.completeJob.requests"))

          yield* materializeFollowUpJob({
            executor: tx,
            jobId: job.id,
            sourceId: job.sourceId,
            principalId: job.principalId,
            followUpMode: job.followUpMode,
            createdAt: completedAt,
          })

          // A replay that skipped rows left derived accounting incomplete
          // even though the job itself completed, so it must not count as a
          // finished rebuild.
          if (job.mode === "replay" && job.followUpMode !== "replay") {
            yield* settleSourceRebuilds({
              executor: tx,
              sourceId: job.sourceId,
              outcome:
                state.failedRecords === 0
                  ? { _tag: "complete" }
                  : { _tag: "failed", failureCode: "replay_failed_records" },
              at: completedAt,
            })
          }

          if (state.failedRecords > 0) {
            yield* failPendingDependentJobs({
              executor: tx,
              prerequisiteJobId: job.id,
              failureCode: "replay_prerequisite_failed_records",
              completedAt,
            })
          }
        })
      )
      .pipe(preserveExpectedExecutionError("sourceSyncJobRepository.completeJob"))
  }

  const getJob: SourceSyncJobRepositoryShape["getJob"] = ({ principalId, sourceId, jobId }) =>
    Effect.gen(function* () {
      const loadJobRecord = (recordJobId: string) =>
        db
          .select({
            id: schema.processingJobs.id,
            sourceId: schema.processingJobs.sourceId,
            status: schema.processingJobs.status,
            errorMessage: schema.processingJobs.errorMessage,
            creditReasonCode: schema.processingJobs.creditReasonCode,
            creditsAvailable: schema.processingJobs.creditsAvailable,
            creditsConsumed: schema.processingJobs.creditsConsumed,
            additionalCreditsRequired: schema.processingJobs.additionalCreditsRequired,
            progressDetails: schema.processingJobs.progressDetails,
            followUpJobId: schema.processingJobs.followUpJobId,
          })
          .from(schema.processingJobs)
          .where(
            and(
              eq(schema.processingJobs.id, recordJobId),
              eq(schema.processingJobs.sourceId, sourceId),
              eq(schema.processingJobs.principalId, principalId)
            )
          )
          .limit(1)
          .pipe(
            wrapSyncEngineSqlError("sourceSyncJobRepository.getJob.select"),
            Effect.flatMap(([job]) =>
              job === undefined
                ? Effect.fail(new SourceSyncJobRecordNotVisibleError({ sourceId, jobId }))
                : Effect.succeed(job)
            )
          )

      const requestedJob = yield* loadJobRecord(jobId)
      const visibleJob =
        requestedJob.followUpJobId === null
          ? requestedJob
          : yield* loadJobRecord(requestedJob.followUpJobId)
      const progress = yield* decodeSourceSyncJobProgressSnapshot(visibleJob.progressDetails)
      const creditOutcome = yield* toCreditOutcome(visibleJob)

      return {
        sourceId: visibleJob.sourceId,
        jobId: visibleJob.id,
        status: toPublicSourceSyncJobStatus(visibleJob.status),
        phase: progress?.phase ?? null,
        processedRecords: progress?.processedRecords ?? null,
        totalRecords: progress?.totalRecords ?? null,
        progressPercent: getSourceSyncProgressPercent({
          phase: progress?.phase ?? null,
          processedRecords: progress?.processedRecords ?? null,
          totalRecords: progress?.totalRecords ?? null,
        }),
        fetchedRecords: progress?.fetchedRecords ?? null,
        normalizedRecords: progress?.normalizedRecords ?? null,
        failedRecords: progress?.failedRecords ?? null,
        message: visibleJob.errorMessage,
        resumable: visibleJob.status === "credit_required",
        creditOutcome,
      }
    })

  const getExecutionJob: SourceSyncJobRepositoryShape["getExecutionJob"] = ({ jobId }) =>
    Effect.gen(function* () {
      const [job] = yield* db
        .select(selectExecutionJobFields)
        .from(schema.processingJobs)
        .where(eq(schema.processingJobs.id, jobId))
        .limit(1)
        .pipe(wrapSyncEngineSqlError("sourceSyncJobRepository.getExecutionJob.select"))

      if (job === undefined) {
        return yield* new SourceSyncJobExecutionRecordNotFoundError({ jobId })
      }

      const executionJob = yield* toExecutionJob({ job, jobId })
      const prerequisitesSucceeded = yield* jobPrerequisitesSucceeded({ executor: db, jobId })
      if (!prerequisitesSucceeded) {
        return yield* new SourceSyncJobPrerequisitesPendingError({
          jobId,
          sourceId: job.sourceId,
        })
      }

      return executionJob
    })

  const listStaleActiveJobs: SourceSyncJobRepositoryShape["listStaleActiveJobs"] = ({
    staleBefore,
    limit,
  }) =>
    db
      .select({
        id: schema.processingJobs.id,
        sourceId: schema.processingJobs.sourceId,
        principalId: schema.processingJobs.principalId,
        status: schema.processingJobs.status,
        startedAt: schema.processingJobs.startedAt,
        heartbeatAt: schema.processingJobs.heartbeatAt,
        updatedAt: schema.processingJobs.updatedAt,
        workerId: schema.processingJobs.workerId,
      })
      .from(schema.processingJobs)
      .where(
        and(
          isNotNull(schema.processingJobs.principalId),
          inArray(schema.processingJobs.status, ACTIVE_JOB_STATUSES),
          or(
            lt(schema.processingJobs.heartbeatAt, staleBefore),
            and(
              isNull(schema.processingJobs.heartbeatAt),
              lt(schema.processingJobs.updatedAt, staleBefore)
            )
          )
        )
      )
      .orderBy(asc(schema.processingJobs.updatedAt))
      .limit(limit)
      .pipe(
        wrapSyncEngineSqlError("sourceSyncJobRepository.listStaleActiveJobs"),
        Effect.map((jobs) =>
          jobs.flatMap((job) => {
            if (job.status !== "pending" && job.status !== "processing") {
              return []
            }

            return [
              {
                id: job.id,
                sourceId: job.sourceId,
                principalId: job.principalId,
                status: job.status,
                startedAt: job.startedAt,
                heartbeatAt: job.heartbeatAt,
                updatedAt: job.updatedAt,
                workerId: job.workerId,
              } satisfies SourceSyncStaleActiveJob,
            ]
          })
        )
      )

  const listRepairableActiveJobs: SourceSyncJobRepositoryShape["listRepairableActiveJobs"] = ({
    pendingStaleBefore,
    processingStaleBefore,
    limit,
  }) =>
    db
      .select({
        id: schema.processingJobs.id,
        sourceId: schema.processingJobs.sourceId,
        principalId: schema.processingJobs.principalId,
        mode: schema.processingJobs.mode,
        status: schema.processingJobs.status,
        startedAt: schema.processingJobs.startedAt,
        heartbeatAt: schema.processingJobs.heartbeatAt,
        updatedAt: schema.processingJobs.updatedAt,
        workerId: schema.processingJobs.workerId,
        queueName: schema.processingJobs.queueName,
        queueJobId: schema.processingJobs.queueJobId,
      })
      .from(schema.processingJobs)
      .where(
        and(
          isNotNull(schema.processingJobs.principalId),
          processingJobPrerequisitesSucceeded,
          or(
            and(
              eq(schema.processingJobs.status, "pending"),
              or(
                isNull(schema.processingJobs.queueName),
                isNull(schema.processingJobs.queueJobId),
                lt(schema.processingJobs.updatedAt, pendingStaleBefore)
              )
            ),
            and(
              eq(schema.processingJobs.status, "processing"),
              or(
                lt(schema.processingJobs.heartbeatAt, processingStaleBefore),
                and(
                  isNull(schema.processingJobs.heartbeatAt),
                  lt(schema.processingJobs.updatedAt, processingStaleBefore)
                )
              )
            )
          )
        )
      )
      .orderBy(asc(schema.processingJobs.updatedAt))
      .limit(limit)
      .pipe(
        wrapSyncEngineSqlError("sourceSyncJobRepository.listRepairableActiveJobs"),
        Effect.map((jobs) =>
          jobs.flatMap((job) => {
            if (job.status !== "pending" && job.status !== "processing") {
              return []
            }

            return [
              {
                id: job.id,
                sourceId: job.sourceId,
                principalId: job.principalId,
                mode: job.mode,
                status: job.status,
                startedAt: job.startedAt,
                heartbeatAt: job.heartbeatAt,
                updatedAt: job.updatedAt,
                workerId: job.workerId,
                queueName: job.queueName,
                queueJobId: job.queueJobId,
              } satisfies SourceSyncRepairableActiveJob,
            ]
          })
        )
      )

  const listPendingJobsNeedingDispatch: SourceSyncJobRepositoryShape["listPendingJobsNeedingDispatch"] =
    ({ staleBefore, limit }) =>
      db
        .select({
          id: schema.processingJobs.id,
          sourceId: schema.processingJobs.sourceId,
          principalId: schema.processingJobs.principalId,
          mode: schema.processingJobs.mode,
          startedAt: schema.processingJobs.startedAt,
          heartbeatAt: schema.processingJobs.heartbeatAt,
          updatedAt: schema.processingJobs.updatedAt,
          workerId: schema.processingJobs.workerId,
          queueName: schema.processingJobs.queueName,
          queueJobId: schema.processingJobs.queueJobId,
        })
        .from(schema.processingJobs)
        .where(
          and(
            isNotNull(schema.processingJobs.principalId),
            eq(schema.processingJobs.status, "pending"),
            processingJobPrerequisitesSucceeded,
            or(
              isNull(schema.processingJobs.queueName),
              isNull(schema.processingJobs.queueJobId),
              lt(schema.processingJobs.updatedAt, staleBefore)
            )
          )
        )
        .orderBy(asc(schema.processingJobs.updatedAt))
        .limit(limit)
        .pipe(
          wrapSyncEngineSqlError("sourceSyncJobRepository.listPendingJobsNeedingDispatch"),
          Effect.map((jobs) =>
            jobs.map(
              (job) =>
                ({
                  ...job,
                  status: "pending",
                }) satisfies SourceSyncPendingDispatchJob
            )
          )
        )

  return SourceSyncJobRepository.of({
    findActiveJob,
    createOrReuseJob,
    attachQueueMetadata,
    claimJob,
    heartbeatJob,
    recordRetryableFailure,
    recoverStaleActiveJob,
    failJob,
    failCreditRequiredJob,
    completeJob,
    getJob,
    getExecutionJob,
    listStaleActiveJobs,
    listRepairableActiveJobs,
    listPendingJobsNeedingDispatch,
  } satisfies SourceSyncJobRepositoryShape)
})

export const SourceSyncJobRepositoryLive = Layer.effect(SourceSyncJobRepository, make)
