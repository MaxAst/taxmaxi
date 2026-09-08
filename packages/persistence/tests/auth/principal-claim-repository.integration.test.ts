import * as DateTime from "effect/DateTime"
import { asc, eq, inArray, sql } from "drizzle-orm"
import { PrincipalId } from "@my/core/ownership"
import { SourceId } from "@my/core/source"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { SourceSyncJobRepository } from "@my/sync-engine/services"
import { SourceSyncJobRepositoryLive } from "../../src/layers/SourceSyncJobRepositoryLive.ts"
import { PrincipalClaimRepositoryLive } from "../../src/layers/PrincipalClaimRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import { PrincipalClaimRepository } from "../../src/services/PrincipalClaimRepository.ts"
import { makeIntegrationTestDatabaseContext } from "../support/integration-test-kit.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_principal_claim_repo",
})

const runPg = context.runPg

const runPrincipalClaim = <A, E>(effect: Effect.Effect<A, E, PrincipalClaimRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: PrincipalClaimRepositoryLive }))

const ANONYMOUS_PRINCIPAL_ID = PrincipalId.make("00000000-4000-4000-8000-000000001101")
const USER_ID = "00000000-0000-0000-0000-000000001102"
const USER_PRINCIPAL_ID = PrincipalId.make("00000000-4000-4000-8000-000000001103")
const ADDRESS_ID = "00000000-0000-0000-0000-000000001104"
const SOURCE_ID = SourceId.make("00000000-4000-4000-8000-000000001105")
const REQUEST_ID = "00000000-0000-0000-0000-000000001106"
const WALLET_ADDRESS = "bc1qprincipalclaimlockorder000000000000000000"
const CLAIM_VALUE_HASH = "claim-lock-order-hash"

await Effect.runPromise(context.recreateTestDatabase())

describe("PrincipalClaimRepositoryLive", () => {
  beforeEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* context.recreateTestDatabase()
        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle

              yield* db.insert(schema.users).values({
                id: USER_ID,
                email: "principal-claim-lock-order@taxmaxi.test",
                name: "Principal claim lock test",
              })
              yield* db.insert(schema.principals).values([
                {
                  id: ANONYMOUS_PRINCIPAL_ID,
                  kind: "anonymous_wallet",
                  userId: null,
                },
                {
                  id: USER_PRINCIPAL_ID,
                  kind: "user",
                  userId: USER_ID,
                },
              ])
              yield* db.insert(schema.addresses).values({
                id: ADDRESS_ID,
                address: WALLET_ADDRESS,
                type: "bitcoin",
                name: "Claimed wallet",
                principalId: ANONYMOUS_PRINCIPAL_ID,
              })
              yield* db.insert(schema.sources).values({
                id: SOURCE_ID,
                principalId: ANONYMOUS_PRINCIPAL_ID,
                name: "Claimed source",
                providerKey: "bitcoin",
                sourceableType: "onchain",
                addressId: ADDRESS_ID,
                cexAccountId: null,
              })
              yield* db.insert(schema.principalClaims).values([
                {
                  principalId: ANONYMOUS_PRINCIPAL_ID,
                  sourceId: SOURCE_ID,
                  requestId: REQUEST_ID,
                  claimType: "cli_claim_token",
                  claimValueHash: CLAIM_VALUE_HASH,
                  chainType: "bitcoin",
                  walletAddress: WALLET_ADDRESS,
                  year: 2025,
                  jurisdiction: "germany",
                },
                {
                  principalId: ANONYMOUS_PRINCIPAL_ID,
                  sourceId: SOURCE_ID,
                  requestId: REQUEST_ID,
                  claimType: "x402_receipt",
                  claimValueHash: "receipt-lock-order-hash",
                  payerChainType: "bitcoin",
                  payerWalletAddress: WALLET_ADDRESS,
                  chainType: "bitcoin",
                  walletAddress: WALLET_ADDRESS,
                  year: 2025,
                  jurisdiction: "germany",
                },
              ])
            })
          )
        )
      })
    )
  )

  it.effect("locks the source before either ownership principal", () =>
    Effect.gen(function* () {
      // Given another transaction owns the source row lock.
      const sourceLockAcquired = yield* Deferred.make<void>()
      const releaseSourceLock = yield* Deferred.make<void>()
      const heldSourceLock = runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .select({ id: schema.sources.id })
                .from(schema.sources)
                .where(eq(schema.sources.id, SOURCE_ID))
                .for("update")
              yield* Deferred.succeed(sourceLockAcquired, undefined)
              yield* Deferred.await(releaseSourceLock)
            })
          )
        })
      )

      yield* Deferred.await(sourceLockAcquired)

      // When a claim starts, it must wait for the source before locking either principal.
      const claimWaitingForSource = runPrincipalClaim(
        Effect.flatMap(PrincipalClaimRepository, (repository) =>
          repository.claimAnonymousSourceForUser({
            anonymousPrincipalId: ANONYMOUS_PRINCIPAL_ID,
            userPrincipalId: USER_PRINCIPAL_ID,
            sourceId: SOURCE_ID,
            requestId: REQUEST_ID,
            claimValueHash: CLAIM_VALUE_HASH,
          })
        )
      )

      yield* Effect.promise(() => context.waitForQueryBlockedOnLock({ queryIncludes: "sources" }))

      // The claim should be waiting on the source row without holding either
      // principal row, so this independent principal lock must complete.
      const principalLockProbe = runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.transaction((tx) =>
            tx
              .select({ id: schema.principals.id })
              .from(schema.principals)
              .where(inArray(schema.principals.id, [ANONYMOUS_PRINCIPAL_ID, USER_PRINCIPAL_ID]))
              .orderBy(asc(schema.principals.id))
              .for("update", { noWait: true })
          )
        })
      ).then(() => "completed" as const)
      const principalLockProbeOutcome = yield* Effect.promise(() => principalLockProbe)

      // Then the principal rows remain lockable while the claim waits.
      expect(principalLockProbeOutcome).toBe("completed")

      // And the claim finishes successfully after the source lock is released.
      yield* Deferred.succeed(releaseSourceLock, undefined)
      const [, claimedSourceId] = yield* Effect.promise(() =>
        Promise.all([heldSourceLock, claimWaitingForSource])
      )

      expect(claimedSourceId).toBe(SOURCE_ID)
    })
  )
  for (const path of ["token", "payer"] as const) {
    it.effect(
      `claim transfers exact work as queued through ${path}, discarding anonymous evidence`,
      () =>
        Effect.gen(function* () {
          yield* Effect.promise(() => seedCalculationWork())
          const before = yield* Effect.promise(() => readClaimCalculationState())
          yield* Effect.promise(() => claimSource(path))
          const after = yield* Effect.promise(() => readClaimCalculationState())
          expect(after.requests).toEqual(
            before.requests.map((request) => ({
              ...request,
              principalId:
                request.sourceId === SOURCE_ID ? USER_PRINCIPAL_ID : ANONYMOUS_PRINCIPAL_ID,
              status: "queued",
            }))
          )
          expect(after.attempts).toEqual([])
          expect(after.captures).toEqual([])
          expect(after.links).toEqual([])
          expect(after.runs).toEqual(
            before.runs.filter(({ principalId }) => principalId === USER_PRINCIPAL_ID)
          )
          expect(
            after.active.filter(({ principalId }) => principalId === USER_PRINCIPAL_ID)
          ).toEqual(before.active.filter(({ principalId }) => principalId === USER_PRINCIPAL_ID))
          expect(after.raw).toEqual(before.raw)
          expect(after.jobs).toEqual(
            before.jobs.map((job) => ({
              ...job,
              principalId: job.sourceId === SOURCE_ID ? USER_PRINCIPAL_ID : ANONYMOUS_PRINCIPAL_ID,
            }))
          )
          expect(after.sourceOwner).toEqual([{ principalId: USER_PRINCIPAL_ID }])
          yield* Effect.promise(() =>
            expect(
              runPg(
                Effect.flatMap(drizzle, (db) =>
                  db.insert(schema.calculationSyncRequests).values({
                    id: "00000000-0000-4000-8000-000000001999",
                    principalId: ANONYMOUS_PRINCIPAL_ID,
                    sourceId: SOURCE_ID,
                    sourceJobId: workJobId(0),
                    jurisdiction: "DE",
                    taxYear: 2023,
                    reportingCurrency: "EUR",
                    requestedAt: WORK_TIME,
                  })
                )
              )
            ).rejects.toBeDefined()
          )
        })
    )

    it.effect(`claim ${path} rollback restores removed attempts, capture links and ownership`, () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => seedCalculationWork())
        const before = yield* Effect.promise(() => readClaimCalculationState())
        // This rejects reinsertion, after deletion cascades and all direct owner changes.
        yield* Effect.promise(() =>
          runPg(
            Effect.flatMap(drizzle, (db) =>
              db.execute(sql`
        ALTER TABLE calculation_sync_requests ADD CONSTRAINT test_reject_transferred_work
        CHECK (principal_id <> '00000000-4000-4000-8000-000000001103'::uuid)
      `)
            )
          )
        )
        yield* Effect.promise(() => expect(claimSource(path)).rejects.toBeDefined())
        expect(yield* Effect.promise(readClaimCalculationState)).toEqual(before)
        yield* Effect.promise(() =>
          runPg(
            Effect.flatMap(drizzle, (db) =>
              db.execute(
                sql`ALTER TABLE calculation_sync_requests DROP CONSTRAINT test_reject_transferred_work`
              )
            )
          )
        )
      })
    )
  }

  it.effect("completion waits for a concurrent claim and records the committed owner", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.processingJobs).values({
              id: workJobId(0),
              sourceId: SOURCE_ID,
              principalId: ANONYMOUS_PRINCIPAL_ID,
              status: "processing",
            })
            yield* db.execute(
              sql.raw(`CREATE FUNCTION test_pause_source_claim() RETURNS trigger AS $$
          BEGIN PERFORM pg_advisory_xact_lock(318002); RETURN NEW; END; $$ LANGUAGE plpgsql`)
            )
            yield* db.execute(
              sql.raw(`CREATE TRIGGER test_pause_source_claim BEFORE UPDATE OF principal_id
          ON sources FOR EACH ROW EXECUTE FUNCTION test_pause_source_claim()`)
            )
          })
        )
      )
      const barrierHeld = yield* Deferred.make<void>()
      const releaseBarrier = yield* Deferred.make<void>()
      const barrier = runPg(
        Effect.flatMap(drizzle, (db) =>
          db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.execute(sql`SELECT pg_advisory_xact_lock(318002)`)
              yield* Deferred.succeed(barrierHeld, undefined)
              yield* Deferred.await(releaseBarrier)
            })
          )
        )
      )
      yield* Deferred.await(barrierHeld)
      const claim = claimSource("token")
      yield* Effect.promise(() =>
        context.waitForQueryBlockedOnLock({ queryIncludes: 'update "sources"' })
      )
      const completion = Effect.runPromise(
        context.runWithLayer({
          layer: SourceSyncJobRepositoryLive,
          effect: Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.completeJob({
              jobId: workJobId(0),
              state: {
                phase: "completed",
                processedRecords: 0,
                totalRecords: 0,
                fetchedRecords: 0,
                normalizedRecords: 0,
                failedRecords: 0,
                cursorPayload: null,
                highWatermark: null,
                checkpointExternalId: null,
                checkpointRawRecordId: null,
              },
            })
          ),
        })
      )
      try {
        yield* Effect.promise(() =>
          context.waitForQueryBlockedOnLock({ queryIncludes: 'inner join "processing_jobs"' })
        )
      } finally {
        yield* Deferred.succeed(releaseBarrier, undefined)
      }
      yield* Effect.promise(() => Promise.all([barrier, claim, completion]))
      const state = yield* Effect.promise(readClaimCalculationState)
      expect(state.requests).toHaveLength(1)
      expect(state.requests[0]).toMatchObject({
        sourceJobId: workJobId(0),
        principalId: USER_PRINCIPAL_ID,
        status: "queued",
      })
      expect(state.sourceOwner).toEqual([{ principalId: USER_PRINCIPAL_ID }])
    })
  )
})

const WORK_TIME = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-02T00:00:00Z"))
const OTHER_SOURCE_ID = "00000000-0000-4000-8000-000000001120"
const ANONYMOUS_RUN_2024 = "00000000-0000-4000-8000-000000001121"
const ANONYMOUS_RUN_2026 = "00000000-0000-4000-8000-000000001122"
const TARGET_RUN = "00000000-0000-4000-8000-000000001123"
const workJobId = (index: number) => `00000000-0000-4000-8000-00000000120${index}`
const workRequestId = (index: number) => `00000000-0000-4000-8000-00000000121${index}`

const claimSource = (path: "token" | "payer") =>
  runPrincipalClaim(
    Effect.flatMap(PrincipalClaimRepository, (repository) => {
      const params = {
        anonymousPrincipalId: ANONYMOUS_PRINCIPAL_ID,
        userPrincipalId: USER_PRINCIPAL_ID,
        sourceId: SOURCE_ID,
        requestId: REQUEST_ID,
      }
      return path === "token"
        ? repository.claimAnonymousSourceForUser({ ...params, claimValueHash: CLAIM_VALUE_HASH })
        : repository.claimAnonymousSourceForUserByPayer({
            ...params,
            payerChainType: "bitcoin",
            payerWalletAddress: WALLET_ADDRESS,
          })
    })
  )

const seedCalculationWork = () =>
  runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const otherAddressId = "00000000-0000-4000-8000-000000001124"
      yield* db.insert(schema.addresses).values({
        id: otherAddressId,
        address: "bc1qother-claim-test",
        name: "Retained source",
        type: "bitcoin",
        principalId: ANONYMOUS_PRINCIPAL_ID,
      })
      yield* db.insert(schema.sources).values({
        id: OTHER_SOURCE_ID,
        principalId: ANONYMOUS_PRINCIPAL_ID,
        name: "Retained anonymous source",
        providerKey: "bitcoin",
        sourceableType: "onchain",
        addressId: otherAddressId,
      })
      yield* db.insert(schema.sourceRecordsRaw).values({
        sourceId: SOURCE_ID,
        provider: "bitcoin",
        recordType: "transaction",
        externalRecordId: "claim-fact",
        occurredAt: WORK_TIME,
        payload: { txid: "claim-fact" },
      })
      const scope = {
        principalId: ANONYMOUS_PRINCIPAL_ID,
        jurisdiction: "DE",
        reportingCurrency: "EUR",
      }
      const states = ["queued", "running", "succeeded", "failed", "succeeded"] as const
      yield* db.insert(schema.processingJobs).values(
        states.map((_, index) => ({
          id: workJobId(index),
          principalId: ANONYMOUS_PRINCIPAL_ID,
          sourceId: index === 4 ? OTHER_SOURCE_ID : SOURCE_ID,
          status: "completed" as const,
          completedAt: WORK_TIME,
        }))
      )
      yield* db.insert(schema.calculationSyncRequests).values(
        states.map((status, index) => ({
          ...scope,
          id: workRequestId(index),
          sourceJobId: workJobId(index),
          sourceId: index === 4 ? OTHER_SOURCE_ID : SOURCE_ID,
          taxYear: index % 2 === 0 ? 2024 : 2026,
          status,
          requestedAt: WORK_TIME,
        }))
      )
      const runDefaults = {
        ...scope,
        engineVersion: "test",
        ruleSetVersion: "test",
        inputLedgerRevision: "test",
        valuationRevision: "test",
        appliedChoiceIds: [],
        appliedRules: [],
        processedEventIds: [],
        startedAt: WORK_TIME,
      }
      yield* db.insert(schema.calculationRuns).values([
        {
          ...runDefaults,
          id: ANONYMOUS_RUN_2024,
          taxYear: 2024,
          status: "complete",
          accountingMethod: "fifo",
          inventoryScope: "per_custody_unit",
          completedAt: WORK_TIME,
        },
        { ...runDefaults, id: ANONYMOUS_RUN_2026, taxYear: 2026, status: "running" },
        {
          ...runDefaults,
          id: TARGET_RUN,
          principalId: USER_PRINCIPAL_ID,
          taxYear: 2024,
          status: "complete",
          accountingMethod: "fifo",
          inventoryScope: "per_custody_unit",
          completedAt: WORK_TIME,
        },
      ])
      yield* db.insert(schema.activeCalculationRuns).values([
        { ...scope, taxYear: 2024, runId: ANONYMOUS_RUN_2024 },
        { ...scope, principalId: USER_PRINCIPAL_ID, taxYear: 2024, runId: TARGET_RUN },
      ])
      yield* db.insert(schema.calculationRunSyncCaptures).values([
        { ...scope, taxYear: 2024, runId: ANONYMOUS_RUN_2024 },
        { ...scope, taxYear: 2026, runId: ANONYMOUS_RUN_2026 },
      ])
      for (const index of [1, 2, 4]) {
        const taxYear = index === 1 ? 2026 : 2024
        const runId = index === 1 ? ANONYMOUS_RUN_2026 : ANONYMOUS_RUN_2024
        yield* db
          .insert(schema.calculationRunSyncRequests)
          .values({ ...scope, taxYear, runId, requestId: workRequestId(index) })
        yield* db.insert(schema.calculationSyncAttempts).values({
          ...scope,
          taxYear,
          runId,
          requestId: workRequestId(index),
          status: index === 1 ? "running" : "succeeded",
          startedAt: WORK_TIME,
          completedAt: index === 1 ? null : WORK_TIME,
        })
      }
      yield* db.insert(schema.calculationSyncAttempts).values({
        ...scope,
        taxYear: 2026,
        requestId: workRequestId(3),
        status: "failed",
        failureCode: "price_fetch_failed",
        startedAt: WORK_TIME,
        completedAt: WORK_TIME,
      })
    })
  )

const readClaimCalculationState = () =>
  runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const requests = yield* db
        .select({
          id: schema.calculationSyncRequests.id,
          sourceId: schema.calculationSyncRequests.sourceId,
          sourceJobId: schema.calculationSyncRequests.sourceJobId,
          principalId: schema.calculationSyncRequests.principalId,
          jurisdiction: schema.calculationSyncRequests.jurisdiction,
          taxYear: schema.calculationSyncRequests.taxYear,
          reportingCurrency: schema.calculationSyncRequests.reportingCurrency,
          requestedAt: schema.calculationSyncRequests.requestedAt,
          status: schema.calculationSyncRequests.status,
        })
        .from(schema.calculationSyncRequests)
        .orderBy(asc(schema.calculationSyncRequests.id))
      const attempts = yield* db
        .select({
          id: schema.calculationSyncAttempts.id,
          requestId: schema.calculationSyncAttempts.requestId,
          status: schema.calculationSyncAttempts.status,
          runId: schema.calculationSyncAttempts.runId,
          failureCode: schema.calculationSyncAttempts.failureCode,
        })
        .from(schema.calculationSyncAttempts)
        .orderBy(asc(schema.calculationSyncAttempts.id))
      const captures = yield* db
        .select({ runId: schema.calculationRunSyncCaptures.runId })
        .from(schema.calculationRunSyncCaptures)
        .orderBy(asc(schema.calculationRunSyncCaptures.runId))
      const links = yield* db
        .select({
          runId: schema.calculationRunSyncRequests.runId,
          requestId: schema.calculationRunSyncRequests.requestId,
        })
        .from(schema.calculationRunSyncRequests)
        .orderBy(asc(schema.calculationRunSyncRequests.requestId))
      const runs = yield* db
        .select({
          id: schema.calculationRuns.id,
          principalId: schema.calculationRuns.principalId,
          status: schema.calculationRuns.status,
        })
        .from(schema.calculationRuns)
        .orderBy(asc(schema.calculationRuns.id))
      const active = yield* db
        .select({
          principalId: schema.activeCalculationRuns.principalId,
          taxYear: schema.activeCalculationRuns.taxYear,
          runId: schema.activeCalculationRuns.runId,
          minimumActivationRevision: schema.activeCalculationRuns.minimumActivationRevision,
          updatedAt: schema.activeCalculationRuns.updatedAt,
        })
        .from(schema.activeCalculationRuns)
        .orderBy(
          asc(schema.activeCalculationRuns.principalId),
          asc(schema.activeCalculationRuns.taxYear)
        )
      const raw = yield* db
        .select({
          id: schema.sourceRecordsRaw.id,
          sourceId: schema.sourceRecordsRaw.sourceId,
          payload: schema.sourceRecordsRaw.payload,
        })
        .from(schema.sourceRecordsRaw)
      const jobs = yield* db
        .select({
          id: schema.processingJobs.id,
          sourceId: schema.processingJobs.sourceId,
          principalId: schema.processingJobs.principalId,
          status: schema.processingJobs.status,
        })
        .from(schema.processingJobs)
        .orderBy(asc(schema.processingJobs.id))
      const sourceOwner = yield* db
        .select({ principalId: schema.sources.principalId })
        .from(schema.sources)
        .where(eq(schema.sources.id, SOURCE_ID))
      return { requests, attempts, captures, links, runs, active, raw, jobs, sourceOwner }
    })
  )
