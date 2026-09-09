import { NodeServices } from "@effect/platform-node"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import {
  AccountingEventId,
  AccountingMethodId,
  AccountingQuantity,
  CustodyUnitId,
  JurisdictionCode,
  TaxYear,
} from "@my/core/accounting"
import { AuthUserId } from "@my/core/authentication"
import { CurrencyCode } from "@my/core/currency"
import { PrincipalId } from "@my/core/ownership"
import { and, asc, eq, sql } from "drizzle-orm"
import * as BigDecimal from "effect/BigDecimal"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { CalculationRunRepositoryLive } from "../../src/layers/CalculationRunRepositoryLive.ts"
import { UserRepositoryLive } from "../../src/layers/UserRepositoryLive.ts"
import { UserRepository } from "../../src/services/UserRepository.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  CalculationRunId,
  CalculationRunRepository,
  type CalculationRunResult,
  InputLedgerRevision,
  ValuationRevision,
} from "../../src/services/CalculationRunRepository.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_PRINCIPAL_ID,
  TEST_SOURCE_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const CALCULATION_RUN_ID = "00000000-0000-4000-8000-000000000701"
const OTHER_CALCULATION_RUN_ID = "00000000-0000-4000-8000-000000000702"
const ACQUISITION_EVENT_ID = "00000000-0000-4000-8000-000000000703"
const DISPOSITION_EVENT_ID = "00000000-0000-4000-8000-000000000704"
const CLAIMING_USER_ID = "00000000-0000-4000-8000-000000000705"
const CLAIMING_PRINCIPAL_ID = "00000000-0000-4000-8000-000000000706"
const GROUPED_CUSTODY_UNIT_ID = "00000000-0000-4000-8000-000000000707"
const MISSING_SOURCE_ID = "00000000-0000-4000-8000-000000000708"
const PROVIDER_ASSET_ROW_ID = "00000000-0000-4000-8000-000000000709"
const WRITER_USER_ID = "00000000-0000-4000-8000-000000000710"
const WRITER_PRINCIPAL_ID = "00000000-0000-4000-8000-000000000711"
const WRITER_SOURCE_ID = "00000000-0000-4000-8000-000000000712"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_calculation_runs_schema",
})

const runPg = context.runPg
const runRepository = <A, E>(effect: Effect.Effect<A, E, CalculationRunRepository>) =>
  context.runWithLayer({ effect, layer: CalculationRunRepositoryLive })

await Effect.runPromise(context.recreateTestDatabase())

beforeEach(() => Effect.runPromise(context.recreateTestDatabase()))

const insertRun = ({ id, taxYear = 2025 }: { readonly id: string; readonly taxYear?: number }) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db.insert(schema.calculationRuns).values({
      id,
      principalId: TEST_PRINCIPAL_ID,
      jurisdiction: "DE",
      taxYear,
      reportingCurrency: "EUR",
      engineVersion: "1",
      ruleSetVersion: "de-crypto-income-tax-v2025-03-06",
      inputLedgerRevision: "ledger-17",
      valuationRevision: "prices-9",
      status: "complete",
      accountingMethod: "fifo",
      inventoryScope: "per_custody_unit",
      appliedChoiceIds: [],
      appliedRules: ["de.private.section23.wallet-fifo-method"],
      processedEventIds: [ACQUISITION_EVENT_ID, DISPOSITION_EVENT_ID],
      completedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-31T08:00:00.000Z")),
    })
  })

describe("complete movement capture schema", () => {
  it.effect("checks a foreign movement owner at commit and rolls its capture back", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => runPg(seedSyncEngineRepositoryFixture()))
      yield* Effect.promise(() =>
        runPg(
          seedSyncEngineRepositoryFixture({
            userId: WRITER_USER_ID,
            principalId: WRITER_PRINCIPAL_ID,
            sourceId: WRITER_SOURCE_ID,
          })
        )
      )
      yield* Effect.promise(() => runPg(insertRun({ id: CALCULATION_RUN_ID })))
      const targetId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.calculationRuns)
              .set({ status: "running", completedAt: null })
              .where(eq(schema.calculationRuns.id, CALCULATION_RUN_ID))
            const [target] = yield* db
              .insert(schema.movementCorrectionTargets)
              .values({
                principalId: WRITER_PRINCIPAL_ID,
                sourceId: WRITER_SOURCE_ID,
                sourceRecordKey: "foreign-capture",
                componentKey: "principal",
              })
              .returning({ id: schema.movementCorrectionTargets.id })
            if (target === undefined) return yield* Effect.die("Missing synthetic foreign target")
            return target.id
          })
        )
      )
      let insertedBeforeCommit = false
      const outcome = yield* Effect.promise(() =>
        runPg(
          Effect.exit(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db.transaction((tx) =>
                Effect.gen(function* () {
                  yield* tx.insert(schema.calculationRunMovementInputs).values({
                    runId: CALCULATION_RUN_ID,
                    principalId: TEST_PRINCIPAL_ID,
                    sourceId: WRITER_SOURCE_ID,
                    targetId,
                    eventId: null,
                    transactionId: null,
                    captured: {
                      targetId,
                      current: null,
                      currentOutcome: "absent",
                      system: { event: null, valuationFacts: [] },
                      effective: { event: null, valuationFacts: [] },
                    },
                    valuation: { _tag: "not_evaluated" },
                  })
                  insertedBeforeCommit = true
                })
              )
            })
          )
        )
      )
      expect(insertedBeforeCommit).toBe(true)
      expect(outcome._tag).toBe("Failure")
      const captures = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ targetId: schema.calculationRunMovementInputs.targetId })
              .from(schema.calculationRunMovementInputs)
          })
        )
      )
      expect(captures).toEqual([])
    })
  )

  it.effect("rejects mutation and insertion after finalization of movement captures", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => runPg(seedSyncEngineRepositoryFixture()))
      yield* Effect.promise(() => runPg(insertRun({ id: CALCULATION_RUN_ID })))
      const row = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [target] = yield* db
              .insert(schema.movementCorrectionTargets)
              .values({
                principalId: TEST_PRINCIPAL_ID,
                sourceId: TEST_SOURCE_ID,
                sourceRecordKey: "synthetic-absent-capture",
                componentKey: "principal",
              })
              .returning({ id: schema.movementCorrectionTargets.id })
            if (target === undefined) return yield* Effect.die("Missing synthetic target")
            yield* db
              .update(schema.calculationRuns)
              .set({ status: "running", completedAt: null })
              .where(eq(schema.calculationRuns.id, CALCULATION_RUN_ID))
            const value = {
              runId: CALCULATION_RUN_ID,
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
              targetId: target.id,
              eventId: null,
              transactionId: null,
              captured: {
                targetId: target.id,
                current: null,
                currentOutcome: "absent",
                system: { event: null, valuationFacts: [] },
                effective: { event: null, valuationFacts: [] },
              },
              valuation: { _tag: "not_evaluated" },
            } satisfies typeof schema.calculationRunMovementInputs.$inferInsert
            yield* db.insert(schema.calculationRunMovementInputs).values(value)
            return value
          })
        )
      )
      const reject = (effect: Parameters<typeof runPg<unknown, unknown>>[0]) =>
        Effect.promise(() => runPg(Effect.exit(effect)))
      const updated = yield* reject(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.update(schema.calculationRunMovementInputs).set({ eventId: null })
        })
      )
      expect(updated._tag).toBe("Failure")
      const deleted = yield* reject(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.delete(schema.calculationRunMovementInputs)
        })
      )
      expect(deleted._tag).toBe("Failure")
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.calculationRuns)
              .set({ status: "complete", completedAt: new Date() })
              .where(eq(schema.calculationRuns.id, CALCULATION_RUN_ID))
          })
        )
      )
      const inserted = yield* reject(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.insert(schema.calculationRunMovementInputs).values(row).onConflictDoNothing()
        })
      )
      expect(inserted._tag).toBe("Failure")
    })
  )
})

describe("completed-sync coverage schema", () => {
  it.effect("user deletion cascades through coverage without deleting another owner's work", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(seedSyncEngineRepositoryFixture({ userId: CLAIMING_USER_ID }))
      )
      yield* Effect.promise(() =>
        runPg(
          seedSyncEngineRepositoryFixture({
            sourceId: WRITER_SOURCE_ID,
            userId: WRITER_USER_ID,
            principalId: WRITER_PRINCIPAL_ID,
          })
        )
      )
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            for (const [index, principalId, sourceId, runId] of [
              [0, TEST_PRINCIPAL_ID, TEST_SOURCE_ID, CALCULATION_RUN_ID],
              [1, WRITER_PRINCIPAL_ID, WRITER_SOURCE_ID, OTHER_CALCULATION_RUN_ID],
            ] as const) {
              const jobId = `00000000-0000-4000-8000-00000000076${index}`
              const requestId = `00000000-0000-4000-8000-00000000077${index}`
              const scope = {
                principalId,
                jurisdiction: "DE",
                taxYear: 2025,
                reportingCurrency: "EUR",
              }
              const completedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00Z"))
              yield* db
                .insert(schema.processingJobs)
                .values({ id: jobId, principalId, sourceId, status: "completed", completedAt })
              yield* db.insert(schema.calculationSyncRequests).values({
                ...scope,
                id: requestId,
                sourceId,
                sourceJobId: jobId,
                requestedAt: completedAt,
                status: "succeeded",
              })
              yield* insertRun({ id: runId })
              if (index === 1)
                yield* db
                  .update(schema.calculationRuns)
                  .set({ principalId })
                  .where(eq(schema.calculationRuns.id, runId))
              yield* db.insert(schema.calculationRunSyncCaptures).values({ ...scope, runId })
              yield* db
                .insert(schema.calculationRunSyncRequests)
                .values({ ...scope, runId, requestId })
              yield* db.insert(schema.calculationSyncAttempts).values({
                ...scope,
                runId,
                requestId,
                status: "succeeded",
                startedAt: completedAt,
                completedAt,
              })
            }
          })
        )
      )
      yield* context.runWithLayer({
        layer: UserRepositoryLive,
        effect: Effect.flatMap(UserRepository, (repository) =>
          repository.delete(AuthUserId.make(CLAIMING_USER_ID))
        ),
      })
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            for (const table of [
              schema.calculationSyncRequests,
              schema.calculationSyncAttempts,
              schema.calculationRunSyncCaptures,
              schema.calculationRunSyncRequests,
            ]) {
              const remaining = yield* db.select({ principalId: table.principalId }).from(table)
              expect(remaining).toEqual([{ principalId: WRITER_PRINCIPAL_ID }])
            }
          })
        )
      )
    })
  )

  it.effect(
    "completion_scope_and_ownership: rejects foreign jobs, sources, principals, scopes and runs",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => runPg(seedSyncEngineRepositoryFixture()))
        yield* Effect.promise(() =>
          runPg(
            seedSyncEngineRepositoryFixture({
              sourceId: WRITER_SOURCE_ID,
              userId: WRITER_USER_ID,
              principalId: WRITER_PRINCIPAL_ID,
            })
          )
        )
        const scope = {
          principalId: TEST_PRINCIPAL_ID,
          jurisdiction: "DE",
          taxYear: 2025,
          reportingCurrency: "EUR",
        }
        const requestId = "00000000-0000-4000-8000-000000000751"
        const jobId = "00000000-0000-4000-8000-000000000752"
        const foreignJobId = "00000000-0000-4000-8000-000000000753"
        const request = {
          ...scope,
          id: requestId,
          sourceId: TEST_SOURCE_ID,
          sourceJobId: jobId,
          requestedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00Z")),
        }
        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db.insert(schema.processingJobs).values([
                {
                  id: jobId,
                  sourceId: TEST_SOURCE_ID,
                  principalId: TEST_PRINCIPAL_ID,
                  status: "completed",
                },
                {
                  id: foreignJobId,
                  sourceId: WRITER_SOURCE_ID,
                  principalId: WRITER_PRINCIPAL_ID,
                  status: "completed",
                },
              ])
              yield* insertRun({ id: CALCULATION_RUN_ID })
              yield* insertRun({ id: OTHER_CALCULATION_RUN_ID, taxYear: 2024 })
            })
          )
        )
        for (const mismatch of [
          { sourceJobId: foreignJobId },
          { sourceId: WRITER_SOURCE_ID },
          { principalId: WRITER_PRINCIPAL_ID },
          { sourceId: WRITER_SOURCE_ID, sourceJobId: foreignJobId },
        ]) {
          yield* Effect.promise(() =>
            expect(
              runPg(
                Effect.flatMap(drizzle, (db) =>
                  db.insert(schema.calculationSyncRequests).values({ ...request, ...mismatch })
                )
              )
            ).rejects.toBeDefined()
          )
        }
        yield* Effect.promise(() =>
          runPg(
            Effect.flatMap(drizzle, (db) =>
              db.insert(schema.calculationSyncRequests).values(request)
            )
          )
        )
        yield* Effect.promise(() =>
          expect(
            runPg(
              Effect.flatMap(drizzle, (db) =>
                db
                  .insert(schema.calculationSyncRequests)
                  .values({ ...request, id: "00000000-0000-4000-8000-000000000754" })
              )
            )
          ).rejects.toBeDefined()
        )
        for (const mismatch of [
          { taxYear: 2024 },
          { principalId: WRITER_PRINCIPAL_ID },
          { reportingCurrency: "USD" },
          { jurisdiction: "US" },
        ]) {
          yield* Effect.promise(() =>
            expect(
              runPg(
                Effect.flatMap(drizzle, (db) =>
                  db
                    .insert(schema.calculationRunSyncCaptures)
                    .values({ ...scope, runId: CALCULATION_RUN_ID, ...mismatch })
                )
              )
            ).rejects.toBeDefined()
          )
        }
        yield* Effect.promise(() =>
          runPg(
            Effect.flatMap(drizzle, (db) =>
              db.insert(schema.calculationRunSyncCaptures).values([
                { ...scope, runId: CALCULATION_RUN_ID },
                { ...scope, taxYear: 2024, runId: OTHER_CALCULATION_RUN_ID },
              ])
            )
          )
        )
        for (const mismatch of [
          { taxYear: 2024 },
          { principalId: WRITER_PRINCIPAL_ID },
          { runId: OTHER_CALCULATION_RUN_ID, taxYear: 2024 },
        ]) {
          yield* Effect.promise(() =>
            expect(
              runPg(
                Effect.flatMap(drizzle, (db) =>
                  db
                    .insert(schema.calculationRunSyncRequests)
                    .values({ ...scope, runId: CALCULATION_RUN_ID, requestId, ...mismatch })
                )
              )
            ).rejects.toBeDefined()
          )
        }
        yield* Effect.promise(() =>
          runPg(
            Effect.flatMap(drizzle, (db) =>
              db
                .insert(schema.calculationRunSyncRequests)
                .values({ ...scope, runId: CALCULATION_RUN_ID, requestId })
            )
          )
        )
        for (const mismatch of [
          { taxYear: 2024 },
          { principalId: WRITER_PRINCIPAL_ID },
          { runId: OTHER_CALCULATION_RUN_ID },
        ]) {
          yield* Effect.promise(() =>
            expect(
              runPg(
                Effect.flatMap(drizzle, (db) =>
                  db.insert(schema.calculationSyncAttempts).values({
                    ...scope,
                    requestId,
                    runId: CALCULATION_RUN_ID,
                    status: "running",
                    ...mismatch,
                  })
                )
              )
            ).rejects.toBeDefined()
          )
        }
        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const rows = yield* db
                .select({ id: schema.calculationSyncRequests.id })
                .from(schema.calculationSyncRequests)
              const attempts = yield* db
                .select({ id: schema.calculationSyncAttempts.id })
                .from(schema.calculationSyncAttempts)
              const links = yield* db
                .select({ runId: schema.calculationRunSyncRequests.runId })
                .from(schema.calculationRunSyncRequests)
              expect(rows).toEqual([{ id: requestId }])
              expect(attempts).toEqual([])
              expect(links).toEqual([{ runId: CALCULATION_RUN_ID }])
              yield* db.insert(schema.calculationSyncAttempts).values({
                ...scope,
                requestId,
                status: "failed",
                failureCode: "price_fetch_failed",
                completedAt: yield* DateTime.nowAsDate,
              })
              yield* db
                .insert(schema.calculationSyncAttempts)
                .values({ ...scope, requestId, runId: CALCULATION_RUN_ID, status: "running" })
            })
          )
        )
        yield* Effect.promise(() =>
          expect(
            runPg(
              Effect.flatMap(drizzle, (db) =>
                db
                  .insert(schema.calculationSyncAttempts)
                  .values({ ...scope, requestId, runId: CALCULATION_RUN_ID, status: "running" })
              )
            )
          ).rejects.toBeDefined()
        )
      })
  )

  it.effect("legacy evidence stays absent while a new captured-empty marker is explicit", () =>
    Effect.promise(() =>
      runPg(
        Effect.gen(function* () {
          yield* seedSyncEngineRepositoryFixture()
          yield* insertRun({ id: CALCULATION_RUN_ID })
          yield* insertRun({ id: OTHER_CALCULATION_RUN_ID })
          const db = yield* drizzle
          yield* db.insert(schema.calculationRunSyncCaptures).values({
            runId: OTHER_CALCULATION_RUN_ID,
            principalId: TEST_PRINCIPAL_ID,
            jurisdiction: "DE",
            taxYear: 2025,
            reportingCurrency: "EUR",
          })
          const evidence = yield* db
            .select({
              runId: schema.calculationRuns.id,
              capturedRunId: schema.calculationRunSyncCaptures.runId,
            })
            .from(schema.calculationRuns)
            .leftJoin(
              schema.calculationRunSyncCaptures,
              eq(schema.calculationRunSyncCaptures.runId, schema.calculationRuns.id)
            )
            .orderBy(asc(schema.calculationRuns.id))
          expect(evidence).toEqual([
            { runId: CALCULATION_RUN_ID, capturedRunId: null },
            { runId: OTHER_CALCULATION_RUN_ID, capturedRunId: OTHER_CALCULATION_RUN_ID },
          ])
          expect(
            yield* db
              .select({ requestId: schema.calculationRunSyncRequests.requestId })
              .from(schema.calculationRunSyncRequests)
          ).toEqual([])
        })
      )
    )
  )
})

describe("calculation-runs schema", () => {
  it.effect("stores a complete run result under one immutable run key", () =>
    Effect.promise(() =>
      runPg(
        Effect.gen(function* () {
          const fixture = yield* seedSyncEngineRepositoryFixture()
          yield* seedSyncEngineAssets(fixture)

          const db = yield* drizzle
          yield* insertRun({ id: CALCULATION_RUN_ID })
          yield* db.insert(schema.calculationRunCustodyUnits).values({
            runId: CALCULATION_RUN_ID,
            principalId: TEST_PRINCIPAL_ID,
            custodyUnitId: TEST_SOURCE_ID,
          })
          yield* db.insert(schema.calculationRunCustodyUnitSources).values({
            runId: CALCULATION_RUN_ID,
            principalId: TEST_PRINCIPAL_ID,
            custodyUnitId: TEST_SOURCE_ID,
            sourceId: TEST_SOURCE_ID,
          })

          const acquiredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2024-01-01T10:00:00.000Z"))
          const disposedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T10:00:00.000Z"))

          yield* db.insert(schema.calculationRunAllocations).values({
            runId: CALCULATION_RUN_ID,
            principalId: TEST_PRINCIPAL_ID,
            sequence: 0,
            acquisitionEventId: ACQUISITION_EVENT_ID,
            dispositionEventId: DISPOSITION_EVENT_ID,
            assetId: TEST_BTC_ASSET_ID,
            custodyUnitId: TEST_SOURCE_ID,
            acquiredAt,
            disposedAt,
            quantity: "0.25",
            costBasis: "10000",
          })
          yield* db.insert(schema.calculationRunRealizedResults).values({
            runId: CALCULATION_RUN_ID,
            sequence: 0,
            sourceId: TEST_SOURCE_ID,
            allocationSequence: 0,
            acquisitionEventId: ACQUISITION_EVENT_ID,
            dispositionEventId: DISPOSITION_EVENT_ID,
            assetId: TEST_BTC_ASSET_ID,
            acquiredAt,
            disposedAt,
            quantity: "0.25",
            costBasis: "10000",
            proceeds: "15000",
            gainLoss: "5000",
            treatmentCodes: ["de.tax_free_holding_period"],
          })
          yield* db.insert(schema.calculationRunIncomeResults).values({
            runId: CALCULATION_RUN_ID,
            sequence: 0,
            sourceId: TEST_SOURCE_ID,
            eventId: ACQUISITION_EVENT_ID,
            assetId: TEST_BTC_ASSET_ID,
            occurredAt: acquiredAt,
            quantity: "0.01",
            value: "250",
            treatmentCodes: ["de.taxable_income_section22_3_staking"],
          })
          yield* db.insert(schema.calculationRunDerivedLots).values({
            runId: CALCULATION_RUN_ID,
            principalId: TEST_PRINCIPAL_ID,
            sequence: 0,
            acquisitionEventId: ACQUISITION_EVENT_ID,
            assetId: TEST_BTC_ASSET_ID,
            custodyUnitId: TEST_SOURCE_ID,
            acquiredAt,
            remainingQuantity: "0.75",
            costBasisPerUnit: "40000",
          })
          yield* db.insert(schema.calculationRunBlockers).values({
            runId: CALCULATION_RUN_ID,
            principalId: TEST_PRINCIPAL_ID,
            sequence: 0,
            code: "missing_valuation",
            eventId: DISPOSITION_EVENT_ID,
            assetId: TEST_BTC_ASSET_ID,
            custodyUnitId: TEST_SOURCE_ID,
            missingQuantity: null,
          })
          yield* db.insert(schema.calculationRunExplanationEntries).values({
            runId: CALCULATION_RUN_ID,
            sequence: 0,
            eventId: DISPOSITION_EVENT_ID,
            code: "fifo_matched",
            valuationKind: "observed_consideration",
            matches: [{ acquisitionEventId: ACQUISITION_EVENT_ID, quantity: "0.25" }],
          })
          yield* db.insert(schema.activeCalculationRuns).values({
            principalId: TEST_PRINCIPAL_ID,
            jurisdiction: "DE",
            taxYear: 2025,
            reportingCurrency: "EUR",
            runId: CALCULATION_RUN_ID,
          })

          const [storedRun] = yield* db
            .select({ status: schema.calculationRuns.status })
            .from(schema.calculationRuns)
            .where(eq(schema.calculationRuns.id, CALCULATION_RUN_ID))
          const [storedLot] = yield* db
            .select({ custodyUnitId: schema.calculationRunDerivedLots.custodyUnitId })
            .from(schema.calculationRunDerivedLots)
            .where(eq(schema.calculationRunDerivedLots.runId, CALCULATION_RUN_ID))
          const [activeRun] = yield* db
            .select({ runId: schema.activeCalculationRuns.runId })
            .from(schema.activeCalculationRuns)
            .where(
              and(
                eq(schema.activeCalculationRuns.principalId, TEST_PRINCIPAL_ID),
                eq(schema.activeCalculationRuns.taxYear, 2025)
              )
            )

          expect(storedRun?.status).toBe("complete")
          expect(storedLot?.custodyUnitId).toBe(TEST_SOURCE_ID)
          expect(activeRun?.runId).toBe(CALCULATION_RUN_ID)
        })
      )
    )
  )

  it.effect("stores existing engine blockers and provider-only fact blockers", () =>
    Effect.gen(function* () {
      const observedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T10:00:00.000Z"))

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const fixture = yield* seedSyncEngineRepositoryFixture({
              userId: WRITER_USER_ID,
              principalId: WRITER_PRINCIPAL_ID,
              sourceId: WRITER_SOURCE_ID,
            })
            yield* seedSyncEngineAssets(fixture)
            const db = yield* drizzle

            yield* db.insert(schema.providerAssets).values({
              id: PROVIDER_ASSET_ROW_ID,
              provider: "coinbase",
              providerAssetId: "unresolved-run-blocker",
              currencyCode: "UNKNOWN",
              providerType: "crypto",
              retrievedAt: observedAt,
            })
          })
        )
      )

      const result: CalculationRunResult = {
        eventValuations: [],
        status: "partial",
        jurisdiction: JurisdictionCode.make("DE"),
        taxYear: TaxYear.make(2025),
        engineVersion: "1",
        ruleSetVersion: "de-crypto-income-tax-v2025-03-06",
        accountingMethod: AccountingMethodId.make("fifo"),
        inventoryScope: "per_custody_unit",
        appliedChoiceIds: [],
        appliedRules: ["de.private.section23.wallet-fifo-method"],
        processedEventIds: [AccountingEventId.make(DISPOSITION_EVENT_ID)],
        allocations: [],
        realizedResults: [],
        incomeResults: [],
        derivedLots: [],
        blockers: [
          {
            code: "inventory_shortage",
            eventId: AccountingEventId.make(ACQUISITION_EVENT_ID),
            assetId: TEST_BTC_ASSET_ID,
            custodyUnitId: CustodyUnitId.make(WRITER_SOURCE_ID),
            missingQuantity: AccountingQuantity.make(BigDecimal.fromStringUnsafe("1")),
          },
          {
            code: "unresolved_identity",
            eventId: AccountingEventId.make(DISPOSITION_EVENT_ID),
            assetId: null,
            providerAssetRowId: PROVIDER_ASSET_ROW_ID,
            custodyUnitId: CustodyUnitId.make(WRITER_SOURCE_ID),
            missingQuantity: null,
          },
          {
            code: "missing_decimals",
            eventId: AccountingEventId.make(DISPOSITION_EVENT_ID),
            assetId: TEST_BTC_ASSET_ID,
            providerAssetRowId: PROVIDER_ASSET_ROW_ID,
            custodyUnitId: CustodyUnitId.make(WRITER_SOURCE_ID),
            missingQuantity: null,
          },
        ],
        explanationTrace: [],
      }

      yield* runRepository(
        Effect.flatMap(CalculationRunRepository, (repository) =>
          repository.persist({
            movements: new Map(),
            writeMode: "atomic",
            syncCapture: { requestIds: [] },
            correctionInputs: [],
            id: CalculationRunId.make(CALCULATION_RUN_ID),
            principalId: PrincipalId.make(WRITER_PRINCIPAL_ID),
            reportingCurrency: CurrencyCode.make("EUR"),
            inputLedgerRevision: InputLedgerRevision.make(`v2:1:1.2.:${"a".repeat(64)}`),
            valuationRevision: ValuationRevision.make(`sha256:${"b".repeat(64)}`),
            result,
          })
        )
      )

      const stored = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                code: schema.calculationRunBlockers.code,
                assetId: schema.calculationRunBlockers.assetId,
                providerAssetRowId: schema.calculationRunBlockers.providerAssetRowId,
              })
              .from(schema.calculationRunBlockers)
              .orderBy(asc(schema.calculationRunBlockers.sequence))
          })
        )
      )

      expect(stored).toEqual([
        {
          code: "inventory_shortage",
          assetId: TEST_BTC_ASSET_ID,
          providerAssetRowId: null,
        },
        {
          code: "unresolved_identity",
          assetId: null,
          providerAssetRowId: PROVIDER_ASSET_ROW_ID,
        },
        {
          code: "missing_decimals",
          assetId: TEST_BTC_ASSET_ID,
          providerAssetRowId: PROVIDER_ASSET_ROW_ID,
        },
      ])
    })
  )

  it.effect("requires at least one blocker target and permits both target links", () =>
    Effect.promise(() =>
      runPg(
        Effect.gen(function* () {
          const fixture = yield* seedSyncEngineRepositoryFixture()
          yield* seedSyncEngineAssets(fixture)
          const db = yield* drizzle
          const observedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T10:00:00.000Z"))

          yield* db.insert(schema.providerAssets).values({
            id: PROVIDER_ASSET_ROW_ID,
            provider: "coinbase",
            providerAssetId: "unresolved-run-blocker",
            currencyCode: "UNKNOWN",
            providerType: "crypto",
            retrievedAt: observedAt,
          })
          yield* insertRun({ id: CALCULATION_RUN_ID })
          yield* db.insert(schema.calculationRunCustodyUnits).values({
            runId: CALCULATION_RUN_ID,
            principalId: TEST_PRINCIPAL_ID,
            custodyUnitId: TEST_SOURCE_ID,
          })

          const missingTarget = yield* Effect.result(
            db.insert(schema.calculationRunBlockers).values({
              runId: CALCULATION_RUN_ID,
              principalId: TEST_PRINCIPAL_ID,
              sequence: 0,
              code: "unresolved_identity",
              eventId: DISPOSITION_EVENT_ID,
              assetId: null,
              providerAssetRowId: null,
              custodyUnitId: TEST_SOURCE_ID,
              missingQuantity: null,
            })
          )
          yield* db.insert(schema.calculationRunBlockers).values({
            runId: CALCULATION_RUN_ID,
            principalId: TEST_PRINCIPAL_ID,
            sequence: 1,
            code: "missing_decimals",
            eventId: DISPOSITION_EVENT_ID,
            assetId: TEST_BTC_ASSET_ID,
            providerAssetRowId: PROVIDER_ASSET_ROW_ID,
            custodyUnitId: TEST_SOURCE_ID,
            missingQuantity: null,
          })

          const [stored] = yield* db
            .select({
              assetId: schema.calculationRunBlockers.assetId,
              providerAssetRowId: schema.calculationRunBlockers.providerAssetRowId,
            })
            .from(schema.calculationRunBlockers)

          expect(missingTarget._tag).toBe("Failure")
          expect(stored).toEqual({
            assetId: TEST_BTC_ASSET_ID,
            providerAssetRowId: PROVIDER_ASSET_ROW_ID,
          })
        })
      )
    )
  )

  it.effect("rejects a blocker linked to an unknown provider asset row", () =>
    Effect.promise(() =>
      runPg(
        Effect.gen(function* () {
          yield* seedSyncEngineRepositoryFixture()
          const db = yield* drizzle
          yield* insertRun({ id: CALCULATION_RUN_ID })
          yield* db.insert(schema.calculationRunCustodyUnits).values({
            runId: CALCULATION_RUN_ID,
            principalId: TEST_PRINCIPAL_ID,
            custodyUnitId: TEST_SOURCE_ID,
          })

          const failure = yield* Effect.result(
            db.insert(schema.calculationRunBlockers).values({
              runId: CALCULATION_RUN_ID,
              principalId: TEST_PRINCIPAL_ID,
              sequence: 0,
              code: "unresolved_identity",
              eventId: DISPOSITION_EVENT_ID,
              assetId: null,
              providerAssetRowId: "00000000-0000-4000-8000-000000000799",
              custodyUnitId: TEST_SOURCE_ID,
              missingQuantity: null,
            })
          )

          expect(failure._tag).toBe("Failure")
        })
      )
    )
  )

  it.effect("rejects an active pointer whose scope differs from its run", () =>
    Effect.promise(() =>
      runPg(
        Effect.gen(function* () {
          yield* seedSyncEngineRepositoryFixture()
          yield* insertRun({ id: OTHER_CALCULATION_RUN_ID, taxYear: 2024 })
          const db = yield* drizzle

          const failure = yield* Effect.result(
            db.insert(schema.activeCalculationRuns).values({
              principalId: TEST_PRINCIPAL_ID,
              jurisdiction: "DE",
              taxYear: 2025,
              reportingCurrency: "EUR",
              runId: OTHER_CALCULATION_RUN_ID,
            })
          )

          expect(failure._tag).toBe("Failure")
        })
      )
    )
  )

  it.effect("requires result attribution to reference the frozen source and exact allocation", () =>
    Effect.promise(() =>
      runPg(
        Effect.gen(function* () {
          const fixture = yield* seedSyncEngineRepositoryFixture()
          yield* seedSyncEngineAssets(fixture)
          yield* insertRun({ id: CALCULATION_RUN_ID })
          const db = yield* drizzle
          const acquiredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2024-01-01T10:00:00.000Z"))
          const disposedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T10:00:00.000Z"))

          yield* db.insert(schema.calculationRunCustodyUnits).values({
            runId: CALCULATION_RUN_ID,
            principalId: TEST_PRINCIPAL_ID,
            custodyUnitId: TEST_SOURCE_ID,
          })
          yield* db.insert(schema.calculationRunCustodyUnitSources).values({
            runId: CALCULATION_RUN_ID,
            principalId: TEST_PRINCIPAL_ID,
            custodyUnitId: TEST_SOURCE_ID,
            sourceId: TEST_SOURCE_ID,
          })
          yield* db.insert(schema.calculationRunAllocations).values({
            runId: CALCULATION_RUN_ID,
            principalId: TEST_PRINCIPAL_ID,
            sequence: 0,
            acquisitionEventId: ACQUISITION_EVENT_ID,
            dispositionEventId: DISPOSITION_EVENT_ID,
            assetId: TEST_BTC_ASSET_ID,
            custodyUnitId: TEST_SOURCE_ID,
            acquiredAt,
            disposedAt,
            quantity: "0.25",
            costBasis: "10000",
          })

          const realizedBase = {
            runId: CALCULATION_RUN_ID,
            sequence: 0,
            sourceId: TEST_SOURCE_ID,
            allocationSequence: 0,
            acquisitionEventId: ACQUISITION_EVENT_ID,
            dispositionEventId: DISPOSITION_EVENT_ID,
            assetId: TEST_BTC_ASSET_ID,
            acquiredAt,
            disposedAt,
            quantity: "0.25",
            costBasis: "10000",
            proceeds: "15000",
            gainLoss: "5000",
            treatmentCodes: ["de.tax_free_holding_period"],
          }
          const missingAllocation = yield* Effect.result(
            db
              .insert(schema.calculationRunRealizedResults)
              .values({ ...realizedBase, allocationSequence: 7 })
          )
          const missingRealizedSource = yield* Effect.result(
            db
              .insert(schema.calculationRunRealizedResults)
              .values({ ...realizedBase, sourceId: MISSING_SOURCE_ID })
          )
          const missingIncomeSource = yield* Effect.result(
            db.insert(schema.calculationRunIncomeResults).values({
              runId: CALCULATION_RUN_ID,
              sequence: 0,
              sourceId: MISSING_SOURCE_ID,
              eventId: ACQUISITION_EVENT_ID,
              assetId: TEST_BTC_ASSET_ID,
              occurredAt: acquiredAt,
              quantity: "0.01",
              value: "250",
              treatmentCodes: ["de.taxable_income_section22_3_staking"],
            })
          )

          expect(missingAllocation._tag).toBe("Failure")
          expect(missingRealizedSource._tag).toBe("Failure")
          expect(missingIncomeSource._tag).toBe("Failure")
        })
      )
    )
  )

  it.effect("moves live custody ownership without rewriting a historical run snapshot", () =>
    Effect.promise(() =>
      runPg(
        Effect.gen(function* () {
          yield* seedSyncEngineRepositoryFixture()
          yield* insertRun({ id: CALCULATION_RUN_ID })
          const db = yield* drizzle

          yield* db.insert(schema.calculationRunCustodyUnits).values({
            runId: CALCULATION_RUN_ID,
            principalId: TEST_PRINCIPAL_ID,
            custodyUnitId: TEST_SOURCE_ID,
          })
          yield* db.insert(schema.calculationRunCustodyUnitSources).values({
            runId: CALCULATION_RUN_ID,
            principalId: TEST_PRINCIPAL_ID,
            custodyUnitId: TEST_SOURCE_ID,
            sourceId: TEST_SOURCE_ID,
          })
          yield* db.insert(schema.custodyUnits).values({
            id: GROUPED_CUSTODY_UNIT_ID,
            principalId: TEST_PRINCIPAL_ID,
          })
          yield* db
            .update(schema.custodyUnitSources)
            .set({ custodyUnitId: GROUPED_CUSTODY_UNIT_ID })
            .where(eq(schema.custodyUnitSources.sourceId, TEST_SOURCE_ID))
          yield* db.insert(schema.users).values({
            id: CLAIMING_USER_ID,
            email: "calculation-run-claim@taxmaxi.test",
            name: "Calculation Run Claim User",
          })
          yield* db.insert(schema.principals).values({
            id: CLAIMING_PRINCIPAL_ID,
            kind: "user",
            userId: CLAIMING_USER_ID,
          })
          yield* db
            .update(schema.sources)
            .set({ principalId: CLAIMING_PRINCIPAL_ID })
            .where(eq(schema.sources.id, TEST_SOURCE_ID))

          const [unit] = yield* db
            .select({ principalId: schema.custodyUnits.principalId })
            .from(schema.custodyUnits)
            .where(eq(schema.custodyUnits.id, GROUPED_CUSTODY_UNIT_ID))
          const [membership] = yield* db
            .select({ principalId: schema.custodyUnitSources.principalId })
            .from(schema.custodyUnitSources)
            .where(eq(schema.custodyUnitSources.sourceId, TEST_SOURCE_ID))
          const [snapshot] = yield* db
            .select({
              principalId: schema.calculationRunCustodyUnitSources.principalId,
              custodyUnitId: schema.calculationRunCustodyUnitSources.custodyUnitId,
              sourceId: schema.calculationRunCustodyUnitSources.sourceId,
            })
            .from(schema.calculationRunCustodyUnitSources)
            .where(eq(schema.calculationRunCustodyUnitSources.runId, CALCULATION_RUN_ID))

          expect(unit?.principalId).toBe(CLAIMING_PRINCIPAL_ID)
          expect(membership?.principalId).toBe(CLAIMING_PRINCIPAL_ID)
          expect(snapshot).toEqual({
            principalId: TEST_PRINCIPAL_ID,
            custodyUnitId: TEST_SOURCE_ID,
            sourceId: TEST_SOURCE_ID,
          })
        })
      )
    )
  )

  it.effect("backfills one custody unit per existing source", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const migrationPath = yield* path.fromFileUrl(
        new URL("../../drizzle/20260830232618_tidy_mystique/migration.sql", import.meta.url)
      )
      const migrationSql = yield* fileSystem.readFileString(migrationPath)

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.execute(sql`drop trigger sources_create_default_custody_unit on sources`)
            yield* db.execute(sql`drop function create_default_custody_unit_for_source`)
            yield* db.execute(sql`drop trigger sources_move_custody_unit_principal on sources`)
            yield* db.execute(sql`drop function move_custody_unit_with_source_principal`)
            yield* db.execute(sql`drop table calculation_sync_attempts`)
            yield* db.execute(sql`drop table calculation_run_sync_requests`)
            yield* db.execute(sql`drop table calculation_run_sync_captures`)
            yield* db.execute(sql`drop table calculation_sync_requests`)
            yield* db.execute(sql`drop table active_calculation_runs`)
            yield* db.execute(sql`drop table calculation_run_explanation_entries`)
            yield* db.execute(sql`drop table calculation_run_blockers`)
            yield* db.execute(sql`drop table calculation_run_derived_lots`)
            yield* db.execute(sql`drop table calculation_run_income_results`)
            yield* db.execute(sql`drop table calculation_run_realized_results`)
            yield* db.execute(sql`drop table calculation_run_allocations`)
            yield* db.execute(sql`drop table calculation_run_custody_unit_sources`)
            yield* db.execute(sql`drop table calculation_run_custody_units`)
            yield* db.execute(sql`drop table calculation_run_movement_inputs`)
            yield* db.execute(sql`drop table calculation_run_correction_inputs`)
            yield* db.execute(sql`drop table calculation_runs`)
            yield* db.execute(sql`drop table custody_unit_sources`)
            yield* db.execute(sql`drop table custody_units`)
            yield* db.execute(
              sql`alter table movement_correction_targets drop constraint movement_correction_targets_source_owner_fk`
            )
            yield* db.execute(sql`alter table sources drop constraint sources_id_principal_unique`)
            yield* db.execute(sql`drop type calculation_run_inventory_scope`)
            yield* db.execute(sql`drop type calculation_run_status`)
            yield* seedSyncEngineRepositoryFixture()

            for (const statement of migrationSql
              .split("--> statement-breakpoint")
              .map((part) => part.trim())
              .filter((part) => part.length > 0)) {
              yield* db.execute(sql.raw(statement))
            }

            const associations = yield* db
              .select({
                sourceId: schema.custodyUnitSources.sourceId,
                custodyUnitId: schema.custodyUnitSources.custodyUnitId,
              })
              .from(schema.custodyUnitSources)

            expect(associations).toEqual([
              { sourceId: TEST_SOURCE_ID, custodyUnitId: TEST_SOURCE_ID },
            ])
          })
        )
      )
    }).pipe(Effect.provide(NodeServices.layer))
  )
})
