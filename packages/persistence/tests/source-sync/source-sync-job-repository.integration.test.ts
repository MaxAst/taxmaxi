import { vi } from "vitest"
import * as DateTime from "effect/DateTime"
import { asc, eq, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { SourceSyncJobRepositoryLive } from "../../src/layers/SourceSyncJobRepositoryLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_SOURCE_ID,
  TEST_PRINCIPAL_ID,
  TEST_USER_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"
import {
  SourceSyncJobRepository,
  type SourceSyncExecutionState,
  type SourceSyncJobMode,
} from "@my/sync-engine/services"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_source_sync_job_repo",
})

const runPg = context.runPg

await Effect.runPromise(context.recreateTestDatabase())

const runRepository = <A, E>(effect: Effect.Effect<A, E, SourceSyncJobRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: SourceSyncJobRepositoryLive }))

const completedState: SourceSyncExecutionState = {
  phase: "completed",
  processedRecords: 4,
  totalRecords: 4,
  fetchedRecords: 4,
  normalizedRecords: 3,
  failedRecords: 1,
  cursorPayload: { page: "done" },
  highWatermark: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-03T00:00:00.000Z")),
  checkpointExternalId: "tx-4",
  checkpointRawRecordId: "00000000-0000-0000-0000-000000000999",
}

const createJob = ({
  mode = "sync",
  maxAttempts = 3,
  sourceId = TEST_SOURCE_ID,
  principalId = TEST_PRINCIPAL_ID,
}: {
  readonly mode?: SourceSyncJobMode
  readonly maxAttempts?: number
  readonly sourceId?: string
  readonly principalId?: string
} = {}) =>
  runRepository(
    Effect.flatMap(SourceSyncJobRepository, (repository) =>
      repository.createOrReuseJob({
        sourceId,
        principalId,
        mode,
        maxAttempts,
      })
    )
  )

const seedSourceFixture = ({
  sourceId,
  principalId,
}: {
  readonly sourceId: string
  readonly principalId: string
}) => runPg(seedSyncEngineRepositoryFixture({ sourceId, userId: sourceId, principalId }))

const seedOwnedSource = ({
  sourceId,
  address,
}: {
  readonly sourceId: string
  readonly address: string
}) =>
  runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const [addressRow] = yield* db
        .insert(schema.addresses)
        .values({
          address,
          type: "bitcoin",
          name: address,
          principalId: TEST_PRINCIPAL_ID,
        })
        .returning({ id: schema.addresses.id })

      if (addressRow === undefined) return yield* Effect.die("Failed to create source address")

      yield* db.insert(schema.sources).values({
        id: sourceId,
        principalId: TEST_PRINCIPAL_ID,
        name: address,
        providerKey: "bitcoin-rpc",
        sourceableType: "onchain",
        addressId: addressRow.id,
      })
    })
  )

const recordJobDependency = ({
  jobId,
  prerequisiteJobId,
}: {
  readonly jobId: string
  readonly prerequisiteJobId: string
}) =>
  runPg(
    Effect.flatMap(drizzle, (db) =>
      db.insert(schema.processingJobDependencies).values({ jobId, prerequisiteJobId })
    )
  )

const selectProcessingJob = ({ jobId }: { readonly jobId: string }) =>
  runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const [job] = yield* db
        .select()
        .from(schema.processingJobs)
        .where(eq(schema.processingJobs.id, jobId))
        .limit(1)

      if (job === undefined) {
        return yield* Effect.die(`Missing processing job ${jobId}`)
      }

      return job
    })
  )

const claimJob = ({
  jobId,
  workerId = "worker-1",
}: {
  readonly jobId: string
  readonly workerId?: string
}) =>
  runRepository(
    Effect.flatMap(SourceSyncJobRepository, (repository) =>
      repository.claimJob({
        jobId,
        workerId,
        startedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:00:00.000Z")),
      })
    )
  )

const updateProcessingJobStaleTimestamps = ({
  jobId,
  heartbeatAt,
  updatedAt,
}: {
  readonly jobId: string
  readonly heartbeatAt: Date | null
  readonly updatedAt: Date
}) =>
  runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      yield* db
        .update(schema.processingJobs)
        .set({ heartbeatAt, updatedAt })
        .where(eq(schema.processingJobs.id, jobId))
    })
  )

const attachQueueMetadata = ({
  jobId,
  queueJobId,
  queuedAt,
}: {
  readonly jobId: string
  readonly queueJobId: string
  readonly queuedAt: Date
}) =>
  runRepository(
    Effect.flatMap(SourceSyncJobRepository, (repository) =>
      repository.attachQueueMetadata({
        jobId,
        queueName: "source-sync",
        queueJobId,
        queuedAt,
      })
    )
  )

describe("SourceSyncJobRepositoryLive", () => {
  beforeEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* context.recreateTestDatabase()
        yield* Effect.promise(() => runPg(seedSyncEngineRepositoryFixture()))
      })
    )
  )

  it.effect("creates a sync job as pending with sync mode", () =>
    Effect.gen(function* () {
      const created = yield* Effect.promise(() => createJob({ mode: "sync" }))

      expect(created._tag).toBe("CreatedSourceSyncJob")

      const job = yield* Effect.promise(() => selectProcessingJob({ jobId: created.id }))

      expect(job.mode).toBe("sync")
      expect(job.status).toBe("pending")
      expect(job.attemptCount).toBe(0)
      expect(job.maxAttempts).toBe(3)
    })
  )

  it.effect("creates a replay job as pending with replay mode", () =>
    Effect.gen(function* () {
      const created = yield* Effect.promise(() => createJob({ mode: "replay", maxAttempts: 5 }))

      expect(created._tag).toBe("CreatedSourceSyncJob")

      const job = yield* Effect.promise(() => selectProcessingJob({ jobId: created.id }))

      expect(job.mode).toBe("replay")
      expect(job.status).toBe("pending")
      expect(job.maxAttempts).toBe(5)
    })
  )

  it.effect("reuses the active job for a second create on the same source", () =>
    Effect.gen(function* () {
      const created = yield* Effect.promise(() => createJob({ mode: "sync" }))
      const reused = yield* Effect.promise(() => createJob({ mode: "sync" }))

      expect(reused).toEqual({
        _tag: "ReusedSourceSyncJob",
        id: created.id,
        sourceId: TEST_SOURCE_ID,
        principalId: TEST_PRINCIPAL_ID,
        mode: "sync",
        status: "pending",
        queueName: null,
        queueJobId: null,
      })
    })
  )

  it.effect.each(["failed", "credit_required", "completed_with_failed_records"] as const)(
    "fails pending dependents when their prerequisite becomes %s and frees the active slot",
    (terminalState) =>
      Effect.gen(function* () {
        const dependentSourceId = "00000000-0000-0000-0000-000000009901"
        yield* Effect.promise(() =>
          seedOwnedSource({
            sourceId: dependentSourceId,
            address: "bc1qfailed-prerequisite-dependent",
          })
        )

        const prerequisite = yield* Effect.promise(() => createJob({ mode: "replay" }))
        yield* Effect.promise(() => claimJob({ jobId: prerequisite.id }))
        const dependent = yield* Effect.promise(() =>
          createJob({ mode: "replay", sourceId: dependentSourceId })
        )
        yield* Effect.promise(() =>
          recordJobDependency({ jobId: dependent.id, prerequisiteJobId: prerequisite.id })
        )

        yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(SourceSyncJobRepository, (repository) => {
              switch (terminalState) {
                case "failed":
                  return repository.failJob({
                    jobId: prerequisite.id,
                    message: "prerequisite failed",
                    completedAt: DateTime.toDateUtc(
                      DateTime.makeUnsafe("2025-01-02T00:00:00.000Z")
                    ),
                  })
                case "credit_required":
                  return repository.failCreditRequiredJob({
                    jobId: prerequisite.id,
                    completedAt: DateTime.toDateUtc(
                      DateTime.makeUnsafe("2025-01-02T00:00:00.000Z")
                    ),
                    reasonCode: "no_usable_credits",
                    availableCredits: 0,
                    creditsConsumed: 1,
                    additionalCreditsRequired: 1,
                  })
                case "completed_with_failed_records":
                  return repository.completeJob({ jobId: prerequisite.id, state: completedState })
              }
            })
          )
        )

        expect(
          yield* Effect.promise(() => selectProcessingJob({ jobId: dependent.id }))
        ).toMatchObject({
          status: "failed",
          errorMessage: "Prerequisite processing job did not complete successfully.",
        })
        expect(
          (yield* Effect.promise(() => createJob({ mode: "replay", sourceId: dependentSourceId })))
            ._tag
        ).toBe("CreatedSourceSyncJob")
      })
  )

  it.effect("fails the full pending dependency chain when an upstream prerequisite fails", () =>
    Effect.gen(function* () {
      const middleSourceId = "00000000-0000-0000-0000-000000009902"
      const downstreamSourceId = "00000000-0000-0000-0000-000000009903"
      yield* Effect.promise(() =>
        seedOwnedSource({ sourceId: middleSourceId, address: "bc1qdependency-middle" })
      )
      yield* Effect.promise(() =>
        seedOwnedSource({ sourceId: downstreamSourceId, address: "bc1qdependency-downstream" })
      )

      const prerequisite = yield* Effect.promise(() => createJob({ mode: "replay" }))
      yield* Effect.promise(() => claimJob({ jobId: prerequisite.id }))
      const middle = yield* Effect.promise(() =>
        createJob({ mode: "replay", sourceId: middleSourceId })
      )
      const downstream = yield* Effect.promise(() =>
        createJob({ mode: "replay", sourceId: downstreamSourceId })
      )
      yield* Effect.promise(() =>
        recordJobDependency({ jobId: middle.id, prerequisiteJobId: prerequisite.id })
      )
      yield* Effect.promise(() =>
        recordJobDependency({ jobId: downstream.id, prerequisiteJobId: middle.id })
      )

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.failJob({
              jobId: prerequisite.id,
              message: "upstream replay failed",
              completedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:00:00.000Z")),
            })
          )
        )
      )

      expect(yield* Effect.promise(() => selectProcessingJob({ jobId: middle.id }))).toMatchObject({
        status: "failed",
      })
      expect(
        yield* Effect.promise(() => selectProcessingJob({ jobId: downstream.id }))
      ).toMatchObject({ status: "failed" })
    })
  )

  it.effect(
    "does not create a second active row when replay is requested while sync is active",
    () =>
      Effect.gen(function* () {
        const created = yield* Effect.promise(() => createJob({ mode: "sync" }))
        const replay = yield* Effect.promise(() => createJob({ mode: "replay" }))

        expect(replay).toEqual({
          _tag: "ReusedSourceSyncJob",
          id: created.id,
          sourceId: TEST_SOURCE_ID,
          principalId: TEST_PRINCIPAL_ID,
          mode: "sync",
          status: "pending",
          queueName: null,
          queueJobId: null,
        })

        const activeJobs = yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(SourceSyncJobRepository, (repository) =>
              repository.findActiveJob({
                sourceId: TEST_SOURCE_ID,
                principalId: TEST_PRINCIPAL_ID,
              })
            )
          )
        )

        expect(activeJobs).toHaveLength(1)
        expect(activeJobs[0]?.id).toBe(created.id)
        expect(activeJobs[0]?.mode).toBe("sync")

        const activeJob = yield* Effect.promise(() => selectProcessingJob({ jobId: created.id }))
        expect(activeJob.followUpMode).toBe("replay")
      })
  )

  it.effect("retries replay intent when the active-row update loses a completion race", () =>
    Effect.gen(function* () {
      const created = yield* Effect.promise(() => createJob({ mode: "sync" }))

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle

            yield* db.execute(sql.raw("CREATE SEQUENCE test_follow_up_update_attempt_seq"))
            yield* db.execute(
              sql.raw(`
            CREATE FUNCTION test_skip_first_follow_up_update()
            RETURNS trigger AS $$
            BEGIN
              IF nextval('test_follow_up_update_attempt_seq') = 1 THEN
                RETURN NULL;
              END IF;
              RETURN NEW;
            END;
            $$ LANGUAGE plpgsql
          `)
            )
            yield* db.execute(
              sql.raw(`
            CREATE TRIGGER test_skip_first_follow_up_update
            BEFORE UPDATE OF follow_up_mode ON processing_jobs
            FOR EACH ROW
            EXECUTE FUNCTION test_skip_first_follow_up_update()
          `)
            )
          })
        )
      )

      try {
        const replay = yield* Effect.promise(() => createJob({ mode: "replay" }))

        expect(replay).toMatchObject({
          _tag: "ReusedSourceSyncJob",
          id: created.id,
        })

        const activeJob = yield* Effect.promise(() => selectProcessingJob({ jobId: created.id }))
        expect(activeJob.followUpMode).toBe("replay")
      } finally {
        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle

              yield* db.execute(
                sql.raw(
                  "DROP TRIGGER IF EXISTS test_skip_first_follow_up_update ON processing_jobs"
                )
              )
              yield* db.execute(
                sql.raw("DROP FUNCTION IF EXISTS test_skip_first_follow_up_update()")
              )
              yield* db.execute(
                sql.raw("DROP SEQUENCE IF EXISTS test_follow_up_update_attempt_seq")
              )
            })
          )
        )
      }
    })
  )

  it.effect("attaches queue metadata to a pending job", () =>
    Effect.gen(function* () {
      const created = yield* Effect.promise(() => createJob())
      const queuedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:00:00.000Z"))

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.attachQueueMetadata({
              jobId: created.id,
              queueName: "source-sync",
              queueJobId: "bull-job-1",
              queuedAt,
            })
          )
        )
      )

      const job = yield* Effect.promise(() => selectProcessingJob({ jobId: created.id }))

      expect(job.queueName).toBe("source-sync")
      expect(job.queueJobId).toBe("bull-job-1")
      expect(job.queuedAt?.toISOString()).toBe(queuedAt.toISOString())
    })
  )

  it.effect("attaches queue metadata after a worker has claimed the job", () =>
    Effect.gen(function* () {
      const created = yield* Effect.promise(() => createJob())
      const queuedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:00:01.000Z"))
      yield* Effect.promise(() => claimJob({ jobId: created.id, workerId: "worker-1" }))

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.attachQueueMetadata({
              jobId: created.id,
              queueName: "source-sync",
              queueJobId: "bull-job-1",
              queuedAt,
            })
          )
        )
      )

      const job = yield* Effect.promise(() => selectProcessingJob({ jobId: created.id }))

      expect(job.status).toBe("processing")
      expect(job.queueName).toBe("source-sync")
      expect(job.queueJobId).toBe("bull-job-1")
      expect(job.queuedAt?.toISOString()).toBe(queuedAt.toISOString())
    })
  )

  it.effect("claims a pending job for worker execution", () =>
    Effect.gen(function* () {
      const created = yield* Effect.promise(() => createJob())
      const claimed = yield* Effect.promise(() =>
        claimJob({ jobId: created.id, workerId: "worker-1" })
      )

      expect(claimed).toMatchObject({
        id: created.id,
        sourceId: TEST_SOURCE_ID,
        principalId: TEST_PRINCIPAL_ID,
        mode: "sync",
        status: "processing",
      })

      const job = yield* Effect.promise(() => selectProcessingJob({ jobId: created.id }))

      expect(job.status).toBe("processing")
      expect(job.workerId).toBe("worker-1")
      expect(job.startedAt?.toISOString()).toBe("2025-01-02T00:00:00.000Z")
      expect(job.heartbeatAt?.toISOString()).toBe("2025-01-02T00:00:00.000Z")
    })
  )

  it.effect("returns a typed waiting result when a pending job has active prerequisites", () =>
    Effect.gen(function* () {
      const dependentSourceId = "00000000-0000-0000-0000-000000009911"
      yield* Effect.promise(() =>
        seedOwnedSource({
          sourceId: dependentSourceId,
          address: "bc1qwaiting-prerequisite-dependent",
        })
      )

      const prerequisite = yield* Effect.promise(() => createJob({ mode: "replay" }))
      const dependent = yield* Effect.promise(() =>
        createJob({ mode: "replay", sourceId: dependentSourceId })
      )
      yield* Effect.promise(() =>
        recordJobDependency({ jobId: dependent.id, prerequisiteJobId: prerequisite.id })
      )

      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository
              .claimJob({
                jobId: dependent.id,
                workerId: "worker-1",
                startedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:00:00.000Z")),
              })
              .pipe(Effect.result)
          )
        )
      )

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "SourceSyncJobPrerequisitesPendingError",
          jobId: dependent.id,
          sourceId: dependentSourceId,
        },
      })
      expect(
        yield* Effect.promise(() => selectProcessingJob({ jobId: dependent.id }))
      ).toMatchObject({
        status: "pending",
        workerId: null,
      })
    })
  )

  it.effect("returns a typed conflict when a second worker claims the same job", () =>
    Effect.gen(function* () {
      const created = yield* Effect.promise(() => createJob())
      yield* Effect.promise(() => claimJob({ jobId: created.id, workerId: "worker-1" }))

      const secondClaim = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository
              .claimJob({
                jobId: created.id,
                workerId: "worker-2",
                startedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:01:00.000Z")),
              })
              .pipe(Effect.result)
          )
        )
      )

      expect(secondClaim._tag).toBe("Failure")
      if (secondClaim._tag === "Failure") {
        expect(secondClaim.failure._tag).toBe("SourceSyncJobExecutionRecordConflictError")
      }
    })
  )

  it.effect("heartbeats only when the worker id matches", () =>
    Effect.gen(function* () {
      const created = yield* Effect.promise(() => createJob())
      yield* Effect.promise(() => claimJob({ jobId: created.id, workerId: "worker-1" }))

      const rejectedHeartbeat = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository
              .heartbeatJob({
                jobId: created.id,
                workerId: "worker-2",
                heartbeatAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:02:00.000Z")),
              })
              .pipe(Effect.result)
          )
        )
      )

      expect(rejectedHeartbeat._tag).toBe("Failure")

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.heartbeatJob({
              jobId: created.id,
              workerId: "worker-1",
              heartbeatAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:03:00.000Z")),
            })
          )
        )
      )

      const job = yield* Effect.promise(() => selectProcessingJob({ jobId: created.id }))

      expect(job.heartbeatAt?.toISOString()).toBe("2025-01-02T00:03:00.000Z")
    })
  )

  it.effect("records retryable failure metadata without terminally failing the job", () =>
    Effect.gen(function* () {
      const created = yield* Effect.promise(() => createJob())
      yield* Effect.promise(() => claimJob({ jobId: created.id, workerId: "worker-1" }))

      const nextRetryAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:05:00.000Z"))

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.recordRetryableFailure({
              jobId: created.id,
              message: "Coinbase API timeout",
              attemptCount: 1,
              nextRetryAt,
            })
          )
        )
      )

      const job = yield* Effect.promise(() => selectProcessingJob({ jobId: created.id }))

      expect(job.status).toBe("pending")
      expect(job.attemptCount).toBe(1)
      expect(job.errorMessage).toBe("Coinbase API timeout")
      expect(job.nextRetryAt?.toISOString()).toBe(nextRetryAt.toISOString())
      expect(job.workerId).toBeNull()
    })
  )

  it.effect("reclaims the same job after a retryable failure and preserves attempts", () =>
    Effect.gen(function* () {
      const created = yield* Effect.promise(() => createJob())
      yield* Effect.promise(() => claimJob({ jobId: created.id, workerId: "worker-1" }))

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.recordRetryableFailure({
              jobId: created.id,
              message: "Retry after provider timeout",
              attemptCount: 1,
              nextRetryAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:05:00.000Z")),
            })
          )
        )
      )

      const reclaimed = yield* Effect.promise(() =>
        claimJob({ jobId: created.id, workerId: "worker-2" })
      )
      const job = yield* Effect.promise(() => selectProcessingJob({ jobId: created.id }))

      expect(reclaimed).toMatchObject({
        id: created.id,
        status: "processing",
      })
      expect(job.attemptCount).toBe(1)
      expect(job.workerId).toBe("worker-2")
      expect(job.status).toBe("processing")
    })
  )

  it.effect("terminally fails a processing job", () =>
    Effect.gen(function* () {
      const created = yield* Effect.promise(() => createJob())
      yield* Effect.promise(() => claimJob({ jobId: created.id, workerId: "worker-1" }))

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.failJob({
              jobId: created.id,
              message: "Final failure",
              completedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:10:00.000Z")),
            })
          )
        )
      )

      const job = yield* Effect.promise(() => selectProcessingJob({ jobId: created.id }))

      expect(job.status).toBe("failed")
      expect(job.errorMessage).toBe("Final failure")
      expect(job.completedAt?.toISOString()).toBe("2025-01-02T00:10:00.000Z")
    })
  )

  it.effect("completes a processing job with final counters and checkpoint payload", () =>
    Effect.gen(function* () {
      const created = yield* Effect.promise(() => createJob())
      yield* Effect.promise(() => claimJob({ jobId: created.id, workerId: "worker-1" }))

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.completeJob({
              jobId: created.id,
              state: completedState,
            })
          )
        )
      )

      const job = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.getJob({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
              jobId: created.id,
            })
          )
        )
      )
      const persisted = yield* Effect.promise(() => selectProcessingJob({ jobId: created.id }))

      expect(job).toEqual({
        sourceId: TEST_SOURCE_ID,
        jobId: created.id,
        status: "completed",
        phase: "completed",
        processedRecords: 4,
        totalRecords: 4,
        progressPercent: 100,
        fetchedRecords: 4,
        normalizedRecords: 3,
        failedRecords: 1,
        message: null,
        resumable: false,
        creditOutcome: null,
      })
      expect(persisted.checkpointExternalId).toBe("tx-4")
      expect(persisted.checkpointPayload).toEqual({ page: "done" })
    })
  )

  it.effect("lists stale active jobs by old heartbeat or old updated timestamp", () =>
    Effect.gen(function* () {
      const staleBefore = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:10:00.000Z"))
      const oldTimestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:00:00.000Z"))
      const recentTimestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:20:00.000Z"))

      const heartbeatJob = yield* Effect.promise(() => createJob())
      yield* Effect.promise(() => claimJob({ jobId: heartbeatJob.id, workerId: "worker-1" }))
      yield* Effect.promise(() =>
        updateProcessingJobStaleTimestamps({
          jobId: heartbeatJob.id,
          heartbeatAt: oldTimestamp,
          updatedAt: recentTimestamp,
        })
      )

      const staleByHeartbeat = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.listStaleActiveJobs({ staleBefore, limit: 10 })
          )
        )
      )

      expect(staleByHeartbeat.map((job) => job.id)).toContain(heartbeatJob.id)

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.recoverStaleActiveJob({
              sourceId: TEST_SOURCE_ID,
              jobId: heartbeatJob.id,
              staleBefore,
              message: "Recovered stale heartbeat",
              completedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:30:00.000Z")),
            })
          )
        )
      )

      const pendingJob = yield* Effect.promise(() => createJob())
      yield* Effect.promise(() =>
        updateProcessingJobStaleTimestamps({
          jobId: pendingJob.id,
          heartbeatAt: null,
          updatedAt: oldTimestamp,
        })
      )

      const staleByUpdatedAt = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.listStaleActiveJobs({ staleBefore, limit: 10 })
          )
        )
      )

      expect(staleByUpdatedAt.map((job) => job.id)).toContain(pendingJob.id)
    })
  )

  it.effect("does not recover a processing job that heartbeated after stale selection", () =>
    Effect.gen(function* () {
      const staleBefore = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:10:00.000Z"))
      const staleHeartbeatAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:00:00.000Z"))
      const freshHeartbeatAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:20:00.000Z"))
      const created = yield* Effect.promise(() => createJob())

      yield* Effect.promise(() => claimJob({ jobId: created.id, workerId: "worker-1" }))
      yield* Effect.promise(() =>
        updateProcessingJobStaleTimestamps({
          jobId: created.id,
          heartbeatAt: staleHeartbeatAt,
          updatedAt: staleHeartbeatAt,
        })
      )

      const selected = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.listStaleActiveJobs({ staleBefore, limit: 10 })
          )
        )
      )
      expect(selected.map((job) => job.id)).toContain(created.id)

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.heartbeatJob({
              jobId: created.id,
              workerId: "worker-1",
              heartbeatAt: freshHeartbeatAt,
            })
          )
        )
      )

      const recovery = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository
              .recoverStaleActiveJob({
                sourceId: TEST_SOURCE_ID,
                jobId: created.id,
                staleBefore,
                message: "Recovered stale source sync job after timeout.",
                completedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:30:00.000Z")),
              })
              .pipe(Effect.result)
          )
        )
      )

      expect(recovery._tag).toBe("Failure")
      if (recovery._tag === "Failure") {
        expect(recovery.failure._tag).toBe("SourceSyncJobExecutionRecordConflictError")
      }
      expect(yield* Effect.promise(() => selectProcessingJob({ jobId: created.id }))).toMatchObject(
        {
          status: "processing",
          heartbeatAt: freshHeartbeatAt,
          workerId: "worker-1",
        }
      )
    })
  )

  it.effect("releases replay credits owned by a recovered stale job", () =>
    Effect.gen(function* () {
      const staleBefore = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:10:00.000Z"))
      const staleAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:00:00.000Z"))
      const created = yield* Effect.promise(() => createJob({ mode: "replay" }))

      yield* Effect.promise(() => claimJob({ jobId: created.id, workerId: "worker-1" }))
      yield* Effect.promise(() =>
        updateProcessingJobStaleTimestamps({
          jobId: created.id,
          heartbeatAt: staleAt,
          updatedAt: staleAt,
        })
      )
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.creditLedger).values([
              {
                userId: TEST_USER_ID,
                delta: -1,
                kind: "transaction_usage",
                reference: "test:stale-replay-owned",
                paymentReference: null,
                replayReservationId: created.id,
                expiresAt: null,
              },
              {
                userId: TEST_USER_ID,
                delta: -1,
                kind: "transaction_usage",
                reference: "test:stale-replay-adopted",
                paymentReference: null,
                replayReservationId: "successor-job",
                expiresAt: null,
              },
            ])
          })
        )
      )

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.recoverStaleActiveJob({
              sourceId: TEST_SOURCE_ID,
              jobId: created.id,
              staleBefore,
              message: "Recovered stale replay job.",
              completedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:30:00.000Z")),
            })
          )
        )
      )

      const usage = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                reference: schema.creditLedger.reference,
                replayReservationId: schema.creditLedger.replayReservationId,
              })
              .from(schema.creditLedger)
              .where(eq(schema.creditLedger.kind, "transaction_usage"))
          })
        )
      )

      expect(usage).toEqual([
        {
          reference: "test:stale-replay-adopted",
          replayReservationId: "successor-job",
        },
      ])
    })
  )

  it.effect("lists repairable active jobs by queue metadata and stale execution predicates", () =>
    Effect.gen(function* () {
      const staleBefore = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:10:00.000Z"))
      const oldTimestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:00:00.000Z"))
      const recentTimestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:20:00.000Z"))
      const fixtures = {
        freshPending: {
          sourceId: "00000000-0000-0000-0000-000000000291",
          principalId: "00000000-0000-0000-0000-000000000191",
        },
        stalePending: {
          sourceId: "00000000-0000-0000-0000-000000000292",
          principalId: "00000000-0000-0000-0000-000000000192",
        },
        staleHeartbeat: {
          sourceId: "00000000-0000-0000-0000-000000000293",
          principalId: "00000000-0000-0000-0000-000000000193",
        },
        recentHeartbeat: {
          sourceId: "00000000-0000-0000-0000-000000000294",
          principalId: "00000000-0000-0000-0000-000000000194",
        },
        nullHeartbeat: {
          sourceId: "00000000-0000-0000-0000-000000000295",
          principalId: "00000000-0000-0000-0000-000000000195",
        },
        completed: {
          sourceId: "00000000-0000-0000-0000-000000000296",
          principalId: "00000000-0000-0000-0000-000000000196",
        },
        failed: {
          sourceId: "00000000-0000-0000-0000-000000000297",
          principalId: "00000000-0000-0000-0000-000000000197",
        },
      } as const

      yield* Effect.promise(() => Promise.all(Object.values(fixtures).map(seedSourceFixture)))

      const pendingMissingMetadata = yield* Effect.promise(() => createJob())
      const freshPending = yield* Effect.promise(() => createJob(fixtures.freshPending))
      yield* Effect.promise(() =>
        attachQueueMetadata({
          jobId: freshPending.id,
          queueJobId: "fresh-pending",
          queuedAt: recentTimestamp,
        })
      )

      const stalePending = yield* Effect.promise(() => createJob(fixtures.stalePending))
      yield* Effect.promise(() =>
        attachQueueMetadata({
          jobId: stalePending.id,
          queueJobId: "stale-pending",
          queuedAt: oldTimestamp,
        })
      )

      const staleHeartbeat = yield* Effect.promise(() => createJob(fixtures.staleHeartbeat))
      yield* Effect.promise(() => claimJob({ jobId: staleHeartbeat.id, workerId: "worker-stale" }))
      yield* Effect.promise(() =>
        updateProcessingJobStaleTimestamps({
          jobId: staleHeartbeat.id,
          heartbeatAt: oldTimestamp,
          updatedAt: recentTimestamp,
        })
      )

      const recentHeartbeat = yield* Effect.promise(() => createJob(fixtures.recentHeartbeat))
      yield* Effect.promise(() =>
        claimJob({ jobId: recentHeartbeat.id, workerId: "worker-recent" })
      )
      yield* Effect.promise(() =>
        updateProcessingJobStaleTimestamps({
          jobId: recentHeartbeat.id,
          heartbeatAt: recentTimestamp,
          updatedAt: oldTimestamp,
        })
      )

      const nullHeartbeat = yield* Effect.promise(() => createJob(fixtures.nullHeartbeat))
      yield* Effect.promise(() =>
        claimJob({ jobId: nullHeartbeat.id, workerId: "worker-null-heartbeat" })
      )
      yield* Effect.promise(() =>
        updateProcessingJobStaleTimestamps({
          jobId: nullHeartbeat.id,
          heartbeatAt: null,
          updatedAt: oldTimestamp,
        })
      )

      const completed = yield* Effect.promise(() => createJob(fixtures.completed))
      yield* Effect.promise(() => claimJob({ jobId: completed.id, workerId: "worker-completed" }))
      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.completeJob({ jobId: completed.id, state: completedState })
          )
        )
      )

      const failed = yield* Effect.promise(() => createJob(fixtures.failed))
      yield* Effect.promise(() => claimJob({ jobId: failed.id, workerId: "worker-failed" }))
      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.failJob({
              jobId: failed.id,
              message: "Failed terminally",
              completedAt: recentTimestamp,
            })
          )
        )
      )

      const repairableJobs = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.listRepairableActiveJobs({
              pendingStaleBefore: staleBefore,
              processingStaleBefore: staleBefore,
              limit: 20,
            })
          )
        )
      )
      const repairableJobIds = repairableJobs.map((job) => job.id)

      expect(repairableJobIds).toContain(pendingMissingMetadata.id)
      expect(repairableJobIds).toContain(stalePending.id)
      expect(repairableJobIds).toContain(staleHeartbeat.id)
      expect(repairableJobIds).toContain(nullHeartbeat.id)
      expect(repairableJobIds).not.toContain(freshPending.id)
      expect(repairableJobIds).not.toContain(recentHeartbeat.id)
      expect(repairableJobIds).not.toContain(completed.id)
      expect(repairableJobIds).not.toContain(failed.id)

      const pendingJobsNeedingDispatch = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.listPendingJobsNeedingDispatch({ staleBefore, limit: 20 })
          )
        )
      )
      const pendingJobIds = pendingJobsNeedingDispatch.map((job) => job.id)

      expect(pendingJobIds).toContain(pendingMissingMetadata.id)
      expect(pendingJobIds).toContain(stalePending.id)
      expect(pendingJobIds).not.toContain(freshPending.id)
      expect(pendingJobIds).not.toContain(staleHeartbeat.id)
      expect(pendingJobIds).not.toContain(nullHeartbeat.id)
    })
  )

  it.effect("recovers a stale active job and allows a fresh job to start", () =>
    Effect.gen(function* () {
      const staleBefore = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-03T00:00:00.000Z"))
      const staleHeartbeatAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:00:00.000Z"))
      const created = yield* Effect.promise(() => createJob())

      yield* Effect.promise(() => claimJob({ jobId: created.id }))
      yield* Effect.promise(() =>
        updateProcessingJobStaleTimestamps({
          jobId: created.id,
          heartbeatAt: staleHeartbeatAt,
          updatedAt: staleHeartbeatAt,
        })
      )

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.recoverStaleActiveJob({
              sourceId: TEST_SOURCE_ID,
              jobId: created.id,
              staleBefore,
              message: "Recovered stale source sync job after timeout.",
              completedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-04T00:00:00.000Z")),
            })
          )
        )
      )

      const activeJobs = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.findActiveJob({
              sourceId: TEST_SOURCE_ID,
              principalId: TEST_PRINCIPAL_ID,
            })
          )
        )
      )

      expect(activeJobs).toHaveLength(0)

      const nextJob = yield* Effect.promise(() => createJob())

      expect(nextJob._tag).toBe("CreatedSourceSyncJob")
      expect(nextJob.id).not.toBe(created.id)
    })
  )

  it.effect(
    "maps a credit-required job to a resumable public status with its credit outcome, not a generic failure",
    () =>
      Effect.gen(function* () {
        const created = yield* Effect.promise(() => createJob())
        yield* Effect.promise(() => claimJob({ jobId: created.id, workerId: "worker-1" }))

        yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(SourceSyncJobRepository, (repository) =>
              repository.failCreditRequiredJob({
                jobId: created.id,
                completedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:10:00.000Z")),
                reasonCode: "no_usable_credits",
                availableCredits: 0,
                creditsConsumed: 3,
                additionalCreditsRequired: 2,
              })
            )
          )
        )

        const job = yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(SourceSyncJobRepository, (repository) =>
              repository.getJob({
                principalId: TEST_PRINCIPAL_ID,
                sourceId: TEST_SOURCE_ID,
                jobId: created.id,
              })
            )
          )
        )
        const persisted = yield* Effect.promise(() => selectProcessingJob({ jobId: created.id }))

        expect(job.status).toBe("credit_required")
        expect(job.resumable).toBe(true)
        expect(job.creditOutcome).toEqual({
          reasonCode: "no_usable_credits",
          availableCredits: 0,
          creditsConsumed: 3,
          additionalCreditsRequired: 2,
        })
        // No server-authored message: clients build localized copy from the
        // status and credit outcome instead.
        expect(job.message).toBeNull()
        expect(persisted.status).toBe("credit_required")
      })
  )

  it.effect(
    "maps persisted job states to API-visible queued, running, completed, and failed statuses",
    () =>
      Effect.gen(function* () {
        const queued = yield* Effect.promise(() => createJob())
        const queuedStatus = yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(SourceSyncJobRepository, (repository) =>
              repository.getJob({
                principalId: TEST_PRINCIPAL_ID,
                sourceId: TEST_SOURCE_ID,
                jobId: queued.id,
              })
            )
          )
        )

        expect(queuedStatus.status).toBe("queued")

        yield* Effect.promise(() => claimJob({ jobId: queued.id, workerId: "worker-1" }))

        const runningStatus = yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(SourceSyncJobRepository, (repository) =>
              repository.getJob({
                principalId: TEST_PRINCIPAL_ID,
                sourceId: TEST_SOURCE_ID,
                jobId: queued.id,
              })
            )
          )
        )

        expect(runningStatus.status).toBe("running")

        yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(SourceSyncJobRepository, (repository) =>
              repository.completeJob({ jobId: queued.id, state: completedState })
            )
          )
        )

        const completedStatus = yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(SourceSyncJobRepository, (repository) =>
              repository.getJob({
                principalId: TEST_PRINCIPAL_ID,
                sourceId: TEST_SOURCE_ID,
                jobId: queued.id,
              })
            )
          )
        )

        expect(completedStatus.status).toBe("completed")

        const failed = yield* Effect.promise(() => createJob())
        yield* Effect.promise(() => claimJob({ jobId: failed.id, workerId: "worker-1" }))
        yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(SourceSyncJobRepository, (repository) =>
              repository.failJob({
                jobId: failed.id,
                message: "Failed terminally",
                completedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-04T00:00:00.000Z")),
              })
            )
          )
        )

        const failedStatus = yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(SourceSyncJobRepository, (repository) =>
              repository.getJob({
                principalId: TEST_PRINCIPAL_ID,
                sourceId: TEST_SOURCE_ID,
                jobId: failed.id,
              })
            )
          )
        )

        expect(failedStatus.status).toBe("failed")
        expect(failedStatus.message).toBe("Failed terminally")
      })
  )

  it.effect(
    "uses the schema default sync mode when a processing job is inserted without a mode",
    () =>
      Effect.gen(function* () {
        const jobId = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const [job] = yield* db
                .insert(schema.processingJobs)
                .values({
                  sourceId: TEST_SOURCE_ID,
                  principalId: TEST_PRINCIPAL_ID,
                  status: "pending",
                })
                .returning({ id: schema.processingJobs.id })

              if (job === undefined) {
                return yield* Effect.die("Failed to insert processing job without mode")
              }

              return job.id
            })
          )
        )

        const executionJob = yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(SourceSyncJobRepository, (repository) =>
              repository.getExecutionJob({ jobId })
            )
          )
        )

        expect(executionJob.mode).toBe("sync")
      })
  )

  it.effect("materializes a durable replay follow-up when an active job completes", () =>
    Effect.gen(function* () {
      const activeJobId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [job] = yield* db
              .insert(schema.processingJobs)
              .values({
                sourceId: TEST_SOURCE_ID,
                principalId: TEST_PRINCIPAL_ID,
                mode: "sync",
                status: "processing",
                followUpMode: "replay",
              })
              .returning({ id: schema.processingJobs.id })

            if (job === undefined) return yield* Effect.die("Failed to create active sync job")
            return job.id
          })
        )
      )

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.completeJob({ jobId: activeJobId, state: completedState })
          )
        )
      )

      const jobs = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                id: schema.processingJobs.id,
                mode: schema.processingJobs.mode,
                status: schema.processingJobs.status,
                followUpJobId: schema.processingJobs.followUpJobId,
              })
              .from(schema.processingJobs)
              .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
          })
        )
      )

      const followUpJob = jobs.find((job) => job.mode === "replay")
      expect(followUpJob).toMatchObject({ mode: "replay", status: "pending" })
      expect(jobs.find((job) => job.id === activeJobId)).toEqual({
        id: activeJobId,
        mode: "sync",
        status: "completed",
        followUpJobId: followUpJob?.id,
      })

      const visibleJob = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.getJob({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
              jobId: activeJobId,
            })
          )
        )
      )

      expect(visibleJob).toMatchObject({ jobId: followUpJob?.id, status: "queued" })
    })
  )

  const seedRebuildTracking = ({
    processingJobId,
    status = "pending",
    failureCode = null,
  }: {
    readonly processingJobId: string | null
    readonly status?: "pending" | "operator_attention"
    readonly failureCode?: string | null
  }) =>
    runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [providerAsset] = yield* db
          .insert(schema.providerAssets)
          .values({
            provider: "coinbase",
            providerAssetId: "rebuild-tracking-asset",
            currencyCode: "RBT",
            retrievedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
          })
          .returning({ id: schema.providerAssets.id })
        if (providerAsset === undefined) {
          return yield* Effect.die("Failed to create provider asset fixture")
        }
        const [decision] = yield* db
          .insert(schema.assetResolutionDecisions)
          .values({
            providerAssetRowId: providerAsset.id,
            evidenceRevision: 1,
            policyRevision: "test:rebuild-tracking",
            outcome: "excluded",
            actor: TEST_USER_ID,
          })
          .returning({ id: schema.assetResolutionDecisions.id })
        if (decision === undefined) {
          return yield* Effect.die("Failed to create decision fixture")
        }
        yield* db.insert(schema.assetDecisionRematerializations).values({
          decisionId: decision.id,
          sourceId: TEST_SOURCE_ID,
          processingJobId,
          status,
          failureCode,
          lastFailureAt:
            failureCode === null
              ? null
              : DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
        })
        return decision.id
      })
    )

  const selectRebuildRow = (decisionId: string) =>
    runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [row] = yield* db
          .select({
            processingJobId: schema.assetDecisionRematerializations.processingJobId,
            status: schema.assetDecisionRematerializations.status,
            failureCode: schema.assetDecisionRematerializations.failureCode,
            lastFailureAt: schema.assetDecisionRematerializations.lastFailureAt,
          })
          .from(schema.assetDecisionRematerializations)
          .where(eq(schema.assetDecisionRematerializations.decisionId, decisionId))
        if (row === undefined) {
          return yield* Effect.die("Missing rematerialization row")
        }
        return row
      })
    )

  const insertProcessingReplayJob = () =>
    runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const [job] = yield* db
          .insert(schema.processingJobs)
          .values({
            sourceId: TEST_SOURCE_ID,
            principalId: TEST_PRINCIPAL_ID,
            mode: "replay",
            status: "processing",
          })
          .returning({ id: schema.processingJobs.id })
        if (job === undefined) return yield* Effect.die("Failed to create replay job")
        return job.id
      })
    )

  it.effect("completes source rebuilds when a replay finishes without failed records", () =>
    Effect.gen(function* () {
      const jobId = yield* Effect.promise(() => insertProcessingReplayJob())
      const decisionId = yield* Effect.promise(() =>
        seedRebuildTracking({ processingJobId: jobId })
      )

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.completeJob({ jobId, state: { ...completedState, failedRecords: 0 } })
          )
        )
      )

      expect(yield* Effect.promise(() => selectRebuildRow(decisionId))).toMatchObject({
        status: "complete",
        failureCode: null,
        lastFailureAt: null,
      })
    })
  )

  it.effect("parks source rebuilds when a completed replay skipped records", () =>
    Effect.gen(function* () {
      const jobId = yield* Effect.promise(() => insertProcessingReplayJob())
      const decisionId = yield* Effect.promise(() =>
        seedRebuildTracking({ processingJobId: jobId })
      )

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.completeJob({ jobId, state: completedState })
          )
        )
      )

      expect(yield* Effect.promise(() => selectRebuildRow(decisionId))).toMatchObject({
        status: "operator_attention",
        failureCode: "replay_failed_records",
        lastFailureAt: expect.any(Date),
      })
    })
  )

  it.effect("parks source rebuilds when a replay fails terminally", () =>
    Effect.gen(function* () {
      const jobId = yield* Effect.promise(() => insertProcessingReplayJob())
      const decisionId = yield* Effect.promise(() =>
        seedRebuildTracking({ processingJobId: jobId })
      )

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.failJob({
              jobId,
              message: "replay exploded",
              completedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:00:00.000Z")),
            })
          )
        )
      )

      expect(yield* Effect.promise(() => selectRebuildRow(decisionId))).toMatchObject({
        status: "operator_attention",
        failureCode: "replay_failed",
      })
    })
  )

  it.effect("repoints unfinished rebuilds to the materialized follow-up replay", () =>
    Effect.gen(function* () {
      const activeJobId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [job] = yield* db
              .insert(schema.processingJobs)
              .values({
                sourceId: TEST_SOURCE_ID,
                principalId: TEST_PRINCIPAL_ID,
                mode: "sync",
                status: "processing",
                followUpMode: "replay",
              })
              .returning({ id: schema.processingJobs.id })
            if (job === undefined) return yield* Effect.die("Failed to create active sync job")
            return job.id
          })
        )
      )
      const decisionId = yield* Effect.promise(() =>
        seedRebuildTracking({
          processingJobId: activeJobId,
          status: "operator_attention",
          failureCode: "replay_failed",
        })
      )

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.completeJob({ jobId: activeJobId, state: completedState })
          )
        )
      )

      const followUpJobId = (yield* Effect.promise(() =>
        selectProcessingJob({ jobId: activeJobId })
      )).followUpJobId
      expect(followUpJobId).toEqual(expect.any(String))
      expect(yield* Effect.promise(() => selectRebuildRow(decisionId))).toEqual({
        processingJobId: followUpJobId,
        status: "pending",
        failureCode: null,
        lastFailureAt: null,
      })
    })
  )

  it.effect("completes rebuilds parked at operator_attention when a later replay succeeds", () =>
    Effect.gen(function* () {
      const decisionId = yield* Effect.promise(() =>
        seedRebuildTracking({
          processingJobId: null,
          status: "operator_attention",
          failureCode: "replay_failed",
        })
      )

      const recoveryJobId = yield* Effect.promise(() => insertProcessingReplayJob())
      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.completeJob({
              jobId: recoveryJobId,
              state: { ...completedState, failedRecords: 0 },
            })
          )
        )
      )

      expect(yield* Effect.promise(() => selectRebuildRow(decisionId))).toMatchObject({
        status: "complete",
        failureCode: null,
        lastFailureAt: null,
      })
    })
  )
})

const completeInBerlin2026 = (jobId: string) =>
  runRepository(
    Effect.flatMap(SourceSyncJobRepository, (repository) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2025-12-31T23:30:00.000Z"))
      try {
        return repository.completeJob({ jobId, state: completedState })
      } finally {
        clock.mockRestore()
      }
    })
  )

const selectCalculationRequests = () =>
  runPg(
    Effect.flatMap(drizzle, (db) =>
      db
        .select({
          id: schema.calculationSyncRequests.id,
          sourceJobId: schema.calculationSyncRequests.sourceJobId,
          sourceId: schema.calculationSyncRequests.sourceId,
          principalId: schema.calculationSyncRequests.principalId,
          taxYear: schema.calculationSyncRequests.taxYear,
          jurisdiction: schema.calculationSyncRequests.jurisdiction,
          reportingCurrency: schema.calculationSyncRequests.reportingCurrency,
          status: schema.calculationSyncRequests.status,
          requestedAt: schema.calculationSyncRequests.requestedAt,
        })
        .from(schema.calculationSyncRequests)
        .orderBy(asc(schema.calculationSyncRequests.taxYear))
    )
  )

const seedActive2024 = () =>
  runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const [run] = yield* db
        .insert(schema.calculationRuns)
        .values({
          principalId: TEST_PRINCIPAL_ID,
          jurisdiction: "DE",
          taxYear: 2024,
          reportingCurrency: "EUR",
          engineVersion: "test",
          ruleSetVersion: "test",
          inputLedgerRevision: "test",
          valuationRevision: "test",
          status: "complete",
          accountingMethod: "fifo",
          inventoryScope: "per_custody_unit",
          appliedChoiceIds: [],
          appliedRules: [],
          processedEventIds: [],
          completedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2024-12-31T00:00:00Z")),
        })
        .returning({ id: schema.calculationRuns.id })
      if (run === undefined) return yield* Effect.die("Missing active fixture run")
      yield* db.insert(schema.activeCalculationRuns).values([
        {
          principalId: TEST_PRINCIPAL_ID,
          jurisdiction: "DE",
          taxYear: 2024,
          reportingCurrency: "EUR",
          runId: run.id,
        },
        {
          principalId: TEST_PRINCIPAL_ID,
          jurisdiction: "DE",
          taxYear: 2025,
          reportingCurrency: "EUR",
          runId: null,
        },
      ])
    })
  )

describe("completed-sync calculation requests", () => {
  beforeEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* context.recreateTestDatabase()
        yield* Effect.promise(() => runPg(seedSyncEngineRepositoryFixture()))
        yield* Effect.promise(() => seedActive2024())
      })
    )
  )

  it.effect(
    "completion_records_calculation_requests: current Berlin year and active years commit once",
    () =>
      Effect.gen(function* () {
        const job = yield* Effect.promise(() => createJob())
        yield* Effect.promise(() => claimJob({ jobId: job.id }))
        yield* Effect.promise(() => completeInBerlin2026(job.id))
        const requests = yield* Effect.promise(() => selectCalculationRequests())
        expect(requests.map(({ taxYear }) => taxYear)).toEqual([2024, 2026])
        expect(requests).toEqual(
          [2024, 2026].map((taxYear) => ({
            id: expect.any(String),
            sourceJobId: job.id,
            sourceId: TEST_SOURCE_ID,
            principalId: TEST_PRINCIPAL_ID,
            jurisdiction: "DE",
            taxYear,
            reportingCurrency: "EUR",
            status: "queued",
            requestedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-12-31T23:30:00.000Z")),
          }))
        )
        expect((yield* Effect.promise(() => selectProcessingJob({ jobId: job.id }))).status).toBe(
          "completed"
        )
        yield* Effect.promise(() => expect(completeInBerlin2026(job.id)).rejects.toBeDefined())
        expect(yield* Effect.promise(selectCalculationRequests)).toEqual(requests)
      })
  )

  it.effect(
    "completion_records_calculation_requests: failed request insertion rolls back completion",
    () =>
      Effect.gen(function* () {
        const job = yield* Effect.promise(() => createJob())
        yield* Effect.promise(() => claimJob({ jobId: job.id }))
        yield* Effect.promise(() =>
          runPg(
            Effect.flatMap(drizzle, (db) =>
              db.execute(sql`
      ALTER TABLE calculation_sync_requests ADD CONSTRAINT test_reject_request CHECK (tax_year <> 2024)
    `)
            )
          )
        )
        yield* Effect.promise(() => expect(completeInBerlin2026(job.id)).rejects.toBeDefined())
        expect(yield* Effect.promise(selectCalculationRequests)).toEqual([])
        expect(yield* Effect.promise(() => selectProcessingJob({ jobId: job.id }))).toMatchObject({
          status: "processing",
          completedAt: null,
        })
        yield* Effect.promise(() =>
          runPg(
            Effect.flatMap(drizzle, (db) =>
              db.execute(
                sql`ALTER TABLE calculation_sync_requests DROP CONSTRAINT test_reject_request`
              )
            )
          )
        )
      })
  )

  it.effect(
    "completion_scope_and_ownership: follow-up completion accepts distinct exact requests",
    () =>
      Effect.gen(function* () {
        const first = yield* Effect.promise(() => createJob())
        yield* Effect.promise(() => claimJob({ jobId: first.id }))
        yield* Effect.promise(() => createJob({ mode: "replay" }))
        yield* Effect.promise(() => completeInBerlin2026(first.id))
        const firstRequests = yield* Effect.promise(() => selectCalculationRequests())
        const { followUpJobId } = yield* Effect.promise(() =>
          selectProcessingJob({ jobId: first.id })
        )
        expect(followUpJobId).not.toBeNull()
        if (followUpJobId === null) return
        expect(firstRequests).toHaveLength(2)
        yield* Effect.promise(() => claimJob({ jobId: followUpJobId }))
        yield* Effect.promise(() => completeInBerlin2026(followUpJobId))
        const requests = yield* Effect.promise(() => selectCalculationRequests())
        expect(requests).toHaveLength(4)
        expect(requests.filter(({ sourceJobId }) => sourceJobId === first.id)).toEqual(
          firstRequests
        )
        expect(
          requests
            .filter(({ sourceJobId }) => sourceJobId === followUpJobId)
            .map(({ taxYear }) => taxYear)
        ).toEqual([2024, 2026])
        expect(new Set(requests.map(({ id }) => id)).size).toBe(4)
      })
  )
})
