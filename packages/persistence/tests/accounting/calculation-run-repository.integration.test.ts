import { prepareMovementLegFixtures } from "../support/movement-leg-fixtures.ts"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import type { TaxAccountingResult } from "@my/accounting"
import {
  AccountingChoiceId,
  AccountingEventId,
  AccountingMethodId,
  AccountingQuantity,
  CustodyUnitId,
  JurisdictionCode,
  TaxYear,
} from "@my/core/accounting"
import { CurrencyCode } from "@my/core/currency"
import { PrincipalId } from "@my/core/ownership"
import { MonetaryAmount } from "@my/core/shared/values/MonetaryAmount"
import { Timestamp } from "@my/core/shared/values/Timestamp"
import { SourceId } from "@my/core/source"
import { asc, eq, sql } from "drizzle-orm"
import * as BigDecimal from "effect/BigDecimal"
import * as Cause from "effect/Cause"
import * as DateTime from "effect/DateTime"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import { PersistenceError } from "../../src/errors/RepositoryError.ts"
import { CalculationRunRepositoryLive } from "../../src/layers/CalculationRunRepositoryLive.ts"
import { CalculationRunServiceLive } from "../../src/layers/CalculationRunServiceLive.ts"
import { FactualLedgerRepositoryLive } from "../../src/layers/FactualLedgerRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  CalculationRunAlreadyStoredError,
  CalculationRunCurrencyMismatchError,
  CalculationRunId,
  CalculationRunRepository,
  CalculationSyncRequestId,
  type CalculationRunRepositoryShape,
  InputLedgerRevision,
  ValuationRevision,
} from "../../src/services/CalculationRunRepository.ts"
import { CalculationRunService } from "../../src/services/CalculationRunService.ts"
import { FactualLedgerRepository } from "../../src/services/FactualLedgerRepository.ts"
import {
  TEST_BTC_ASSET_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const RUN_ID = CalculationRunId.make("00000000-0000-4000-8000-000000000801")
const SECOND_RUN_ID = CalculationRunId.make("00000000-0000-4000-8000-000000000805")
const THIRD_RUN_ID = CalculationRunId.make("00000000-0000-4000-8000-000000000806")
const FOURTH_RUN_ID = CalculationRunId.make("00000000-0000-4000-8000-000000000811")
const FIFTH_RUN_ID = CalculationRunId.make("00000000-0000-4000-8000-000000000813")
const SIXTH_RUN_ID = CalculationRunId.make("00000000-0000-4000-8000-000000000814")
const RECOMPUTE_RUN_ID = CalculationRunId.make("00000000-0000-4000-8000-000000000815")
const PARTIAL_RECOMPUTE_RUN_ID = CalculationRunId.make("00000000-0000-4000-8000-000000000816")
const OTHER_MAINTENANCE_RUN_ID = CalculationRunId.make("00000000-0000-4000-8000-000000000817")
const ACQUISITION_EVENT_ID = AccountingEventId.make("00000000-0000-4000-8000-000000000802")
const DISPOSITION_EVENT_ID = AccountingEventId.make("00000000-0000-4000-8000-000000000803")
const TEST_PRINCIPAL_ID = PrincipalId.make("00000000-0000-4000-8000-000000000183")
const TEST_SOURCE_ID = "00000000-0000-4000-8000-000000000281"
const TEST_CUSTODY_UNIT_ID = CustodyUnitId.make(TEST_SOURCE_ID)
const MISSING_CUSTODY_UNIT_ID = CustodyUnitId.make("00000000-0000-4000-8000-000000000807")
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000808"
const OTHER_PRINCIPAL_ID = PrincipalId.make("00000000-0000-4000-8000-000000000809")
const OTHER_SOURCE_ID = "00000000-0000-4000-8000-000000000810"
const OTHER_CUSTODY_UNIT_ID = CustodyUnitId.make(OTHER_SOURCE_ID)
const GROUPED_CUSTODY_UNIT_ID = "00000000-0000-4000-8000-000000000812"
const EUR = CurrencyCode.make("EUR")
const USD = CurrencyCode.make("USD")

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_calculation_run_repo",
})

const runPg = context.runPg

const runPgEffect = <A, E>(effect: Parameters<typeof runPg<A, E>>[0]) =>
  Effect.promise(() => runPg(effect))

const CalculationRunTestLive = CalculationRunRepositoryLive
const CalculationRunServiceTestLive = CalculationRunServiceLive.pipe(
  Layer.provide(Layer.merge(CalculationRunRepositoryLive, FactualLedgerRepositoryLive))
)

const calculationRunServiceWithPersist = (
  makePersist: (
    repository: CalculationRunRepositoryShape
  ) => CalculationRunRepositoryShape["persist"]
) => {
  const repositoryLive = Layer.effect(
    CalculationRunRepository,
    Effect.map(CalculationRunRepository, (repository) =>
      CalculationRunRepository.of({
        fail: repository.fail,
        getLatestStatus: repository.getLatestStatus,
        getSyncStatus: repository.getSyncStatus,
        observeSyncPreparation: repository.observeSyncPreparation,
        failSyncPreparation: repository.failSyncPreparation,
        listRequestedTaxYears: repository.listRequestedTaxYears,
        listActiveTaxYears: repository.listActiveTaxYears,
        settleStaleAndFindRecomputePrincipals: repository.settleStaleAndFindRecomputePrincipals,
        persist: makePersist(repository),
        start: repository.start,
      })
    )
  ).pipe(Layer.provide(CalculationRunRepositoryLive))

  return CalculationRunServiceLive.pipe(
    Layer.provide(Layer.merge(repositoryLive, FactualLedgerRepositoryLive))
  )
}

const runRepository = <A, E>(effect: Effect.Effect<A, E, CalculationRunRepository>) =>
  context.runWithLayer({ effect, layer: CalculationRunTestLive })

const runCalculationService = <A, E>(effect: Effect.Effect<A, E, CalculationRunService>) =>
  context.runWithLayer({ effect, layer: CalculationRunServiceTestLive })

const quantity = (value: string) => AccountingQuantity.make(BigDecimal.fromStringUnsafe(value))
const date = (value: string) => DateTime.toDateUtc(DateTime.makeUnsafe(value))

const captureInputLedgerRevision = () =>
  runPgEffect(
    Effect.gen(function* () {
      const db = yield* drizzle
      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.execute(sql`set transaction isolation level repeatable read`)
          const [snapshot] = yield* tx
            .select({
              transactionId: sql<string>`pg_current_xact_id()::text`,
              visibility: sql<string>`replace(pg_current_snapshot()::text, ':', '.')`,
            })
            .from(schema.principals)
            .where(eq(schema.principals.id, TEST_PRINCIPAL_ID))
            .limit(1)

          if (snapshot === undefined) return yield* Effect.die("Failed to capture test snapshot")

          return InputLedgerRevision.make(
            `v2:${snapshot.transactionId}:${snapshot.visibility}:${"a".repeat(64)}`
          )
        })
      )
    })
  )

const runningMaintenanceRun = ({
  id,
  principalId,
  inputLedgerRevision,
  startedAt,
}: {
  readonly id: CalculationRunId
  readonly principalId: PrincipalId
  readonly inputLedgerRevision: InputLedgerRevision
  readonly startedAt: Date
}) => ({
  id,
  principalId,
  jurisdiction: "DE",
  taxYear: 2026,
  reportingCurrency: "EUR",
  engineVersion: "1",
  ruleSetVersion: "de-crypto-income-tax-v2025-03-06",
  inputLedgerRevision,
  valuationRevision: `sha256:${"b".repeat(64)}`,
  status: "running" as const,
  accountingMethod: null,
  inventoryScope: null,
  appliedChoiceIds: [],
  appliedRules: [],
  processedEventIds: [],
  startedAt,
  createdAt: startedAt,
  updatedAt: startedAt,
})

const acquiredAt = Timestamp.make({ epochMillis: Date.parse("2024-01-01T10:00:00.000Z") })
const disposedAt = Timestamp.make({ epochMillis: Date.parse("2025-01-02T10:00:00.000Z") })

const completeResult = ({
  custodyUnitId = TEST_CUSTODY_UNIT_ID,
  custodySourceId = SourceId.make(TEST_SOURCE_ID),
  currency = "EUR",
  jurisdiction = "DE",
  taxYear = 2025,
}: {
  readonly custodyUnitId?: CustodyUnitId
  readonly custodySourceId?: SourceId
  readonly currency?: string
  readonly jurisdiction?: string
  readonly taxYear?: number
} = {}): TaxAccountingResult => ({
  eventValuations: [],
  status: "complete",
  jurisdiction: JurisdictionCode.make(jurisdiction),
  taxYear: TaxYear.make(taxYear),
  engineVersion: "1",
  ruleSetVersion: "de-crypto-income-tax-v2025-03-06",
  accountingMethod: AccountingMethodId.make("fifo"),
  inventoryScope: "per_custody_unit",
  appliedChoiceIds: [AccountingChoiceId.make("00000000-0000-4000-8000-000000000804")],
  appliedRules: ["de.private.section23.wallet-fifo-method"],
  processedEventIds: [ACQUISITION_EVENT_ID, DISPOSITION_EVENT_ID],
  allocations: [
    {
      acquisitionEventId: ACQUISITION_EVENT_ID,
      dispositionEventId: DISPOSITION_EVENT_ID,
      assetId: TEST_BTC_ASSET_ID,
      custodyUnitId,
      acquiredAt,
      disposedAt,
      quantity: quantity("0.25"),
      costBasis: MonetaryAmount.unsafeFromString("10000", currency),
    },
  ],
  realizedResults: [
    {
      acquisitionEventId: ACQUISITION_EVENT_ID,
      dispositionEventId: DISPOSITION_EVENT_ID,
      custodySourceId,
      allocationSequence: 0,
      assetId: TEST_BTC_ASSET_ID,
      acquiredAt,
      disposedAt,
      quantity: quantity("0.25"),
      costBasis: MonetaryAmount.unsafeFromString("10000", currency),
      proceeds: MonetaryAmount.unsafeFromString("15000", currency),
      gainLoss: MonetaryAmount.unsafeFromString("5000", currency),
      treatmentCodes: ["de.tax_free_holding_period"],
    },
  ],
  incomeResults: [
    {
      eventId: ACQUISITION_EVENT_ID,
      custodySourceId,
      assetId: TEST_BTC_ASSET_ID,
      occurredAt: acquiredAt,
      quantity: quantity("0.01"),
      value: MonetaryAmount.unsafeFromString("250", currency),
      treatmentCodes: ["de.taxable_income_section22_3_staking"],
    },
  ],
  derivedLots: [
    {
      acquisitionEventId: ACQUISITION_EVENT_ID,
      assetId: TEST_BTC_ASSET_ID,
      custodyUnitId,
      acquiredAt,
      remainingQuantity: quantity("0.75"),
      costBasisPerUnit: MonetaryAmount.unsafeFromString("40000", currency),
    },
  ],
  blockers: [],
  explanationTrace: [
    {
      sequence: 17,
      eventId: DISPOSITION_EVENT_ID,
      code: "fifo_matched",
      valuationKind: "observed_consideration",
      matches: [{ acquisitionEventId: ACQUISITION_EVENT_ID, quantity: quantity("0.25") }],
    },
  ],
})

const persistResult = ({
  id = RUN_ID,
  principalId = TEST_PRINCIPAL_ID,
  reportingCurrency = EUR,
  result = completeResult(),
  inputSequence,
}: {
  readonly id?: CalculationRunId
  readonly principalId?: PrincipalId
  readonly reportingCurrency?: CurrencyCode
  readonly result?: TaxAccountingResult
  readonly inputSequence?: string
} = {}) =>
  Effect.flatMap(CalculationRunRepository, (repository) => {
    const sequence = inputSequence ?? (id.slice(-12).replace(/^0+/, "") || "0")

    return repository.persist({
      movements: new Map(),
      writeMode: "atomic",
      syncCapture: { requestIds: [] },
      correctionInputs: [],
      id,
      principalId,
      reportingCurrency,
      inputLedgerRevision: InputLedgerRevision.make(`v2:${sequence}:1.2.:${"a".repeat(64)}`),
      valuationRevision: ValuationRevision.make(`sha256:${"b".repeat(64)}`),
      result,
    })
  })

const recomputeResult = ({
  id,
  jurisdiction = "DE",
}: {
  readonly id: CalculationRunId
  readonly jurisdiction?: string
}) =>
  Effect.flatMap(CalculationRunService, (service) =>
    service.recompute({
      id,
      principalId: TEST_PRINCIPAL_ID,
      jurisdiction: JurisdictionCode.make(jurisdiction),
      taxYear: TaxYear.make(2025),
      reportingCurrency: EUR,
      accountingChoices: [],
    })
  )

const readRunSettlement = (id: CalculationRunId) =>
  runPgEffect(
    Effect.gen(function* () {
      const db = yield* drizzle
      const [run] = yield* db
        .select({
          status: schema.calculationRuns.status,
          failureCode: schema.calculationRuns.failureCode,
        })
        .from(schema.calculationRuns)
        .where(eq(schema.calculationRuns.id, id))
      const [active] = yield* db
        .select({ runId: schema.activeCalculationRuns.runId })
        .from(schema.activeCalculationRuns)

      return { run, active }
    })
  )

const seedAcquisitionFact = ({
  eventId,
  externalId,
  providerFiatAmount,
}: {
  readonly eventId: string
  readonly externalId: string
  readonly providerFiatAmount: string | null
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-03T10:00:00.000Z"))
    const [transaction] = yield* db
      .insert(schema.transactions)
      .values({
        sourceId: TEST_SOURCE_ID,
        externalId,
        timestamp: occurredAt,
        transactionType: "buy_fiat",
        principalId: TEST_PRINCIPAL_ID,
        providerFiatAmount,
        providerFiatCurrency: providerFiatAmount === null ? null : "EUR",
      })
      .returning({ id: schema.transactions.id })

    if (transaction === undefined) {
      return yield* Effect.die("Failed to seed acquisition transaction")
    }

    yield* db.insert(schema.transactionLegs).values(
      yield* prepareMovementLegFixtures([
        {
          movementIdentity: { sourceRecordKey: `${externalId}-leg`, componentKey: "movement" },
          id: eventId,
          sourceId: TEST_SOURCE_ID,
          externalId: `${externalId}-leg`,
          timestamp: occurredAt,
          principalId: TEST_PRINCIPAL_ID,
          assetId: TEST_BTC_ASSET_ID,
          amount: "1",
          kind: "acquisition",
          provenance: "deterministic",
          originKind: "none" as const,
          transactionId: transaction.id,
        },
      ])
    )
  })

const seedCalculationRunFixture = ({
  includeOtherPrincipal = false,
}: {
  readonly includeOtherPrincipal?: boolean
} = {}) =>
  Effect.gen(function* () {
    const fixture = yield* seedSyncEngineRepositoryFixture({
      principalId: TEST_PRINCIPAL_ID,
      sourceId: TEST_SOURCE_ID,
    })
    yield* seedSyncEngineAssets(fixture)

    if (includeOtherPrincipal) {
      yield* seedSyncEngineRepositoryFixture({
        userId: OTHER_USER_ID,
        principalId: OTHER_PRINCIPAL_ID,
        sourceId: OTHER_SOURCE_ID,
      })
    }
  })

const seedCorrectionRunInput = Effect.gen(function* () {
  yield* seedCalculationRunFixture({ includeOtherPrincipal: true })
  yield* seedAcquisitionFact({
    eventId: ACQUISITION_EVENT_ID,
    externalId: "synthetic-run-correction",
    providerFiatAmount: "10",
  })
  const db = yield* drizzle
  const [leg] = yield* db
    .select({
      targetId: schema.transactionLegs.movementCorrectionTargetId,
      transactionId: schema.transactionLegs.transactionId,
    })
    .from(schema.transactionLegs)
    .where(eq(schema.transactionLegs.id, ACQUISITION_EVENT_ID))
  const [principal] = yield* db
    .select({ userId: schema.principals.userId })
    .from(schema.principals)
    .where(eq(schema.principals.id, TEST_PRINCIPAL_ID))
  if (
    leg === undefined ||
    leg.transactionId === null ||
    principal?.userId === null ||
    principal?.userId === undefined
  )
    return yield* Effect.die("Missing synthetic input owner")
  const draft = {
    principalId: TEST_PRINCIPAL_ID,
    sourceId: TEST_SOURCE_ID,
    targetId: leg.targetId,
    kind: "price",
    operation: "create",
    inspectedSystemRevision: "synthetic-inspected-revision",
    inspectedSourceRecordKey: "synthetic-run-correction-leg",
    inspectedComponentKey: "movement",
    inspectedQuantity: "1",
    inspectedEconomicAssetId: TEST_BTC_ASSET_ID,
    inspectedDirection: "inbound",
    inspectedStructure: "ownership_change",
    inspectedOccurredAt: date("2025-02-03T10:00:00Z"),
    inspectedLegKind: "acquisition",
    inspectedFiatAmount: null,
    inspectedFiatCurrency: null,
    inspectedValuationEvidence: {
      reportingCurrency: EUR,
      facts: [
        {
          _tag: "observed_consideration",
          eventId: ACQUISITION_EVENT_ID,
          amount: { amount: "10", currency: EUR },
          evidenceReference: `transaction:${leg.transactionId}`,
        },
      ],
    },
    inspectedTransactionType: "buy_fiat",
    inspectedProviderTransactionType: null,
    inspectedDerivationRule: null,
    inspectedFeeForSourceRecordKey: null,
    priceInput: { _tag: "total_value", amount: "0", currency: EUR },
    classificationInput: null,
    actorUserId: principal.userId,
    reason: "Synthetic run input",
    supersedesOverrideId: null,
  } satisfies typeof schema.principalTransactionOverrides.$inferInsert
  yield* db.insert(schema.principalTransactionOverrides).values(draft)
  return draft
})

const captureCorrectionInputs = () =>
  context.runWithLayer({
    layer: FactualLedgerRepositoryLive,
    effect: Effect.flatMap(FactualLedgerRepository, (repository) =>
      repository.load({ principalId: TEST_PRINCIPAL_ID, reportingCurrency: EUR })
    ).pipe(Effect.map((ledger) => ledger.correctionInputs)),
  })

const readLiveAndStoredMembership = (runId: CalculationRunId = RUN_ID) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [live] = yield* db
      .select({ custodyUnitId: schema.custodyUnitSources.custodyUnitId })
      .from(schema.custodyUnitSources)
      .where(eq(schema.custodyUnitSources.sourceId, TEST_SOURCE_ID))
    const [snapshot] = yield* db
      .select({
        custodyUnitId: schema.calculationRunCustodyUnitSources.custodyUnitId,
        sourceId: schema.calculationRunCustodyUnitSources.sourceId,
      })
      .from(schema.calculationRunCustodyUnitSources)
      .where(eq(schema.calculationRunCustodyUnitSources.runId, runId))

    return { live, snapshot }
  })

const currencyMismatchCases = (): ReadonlyArray<{
  readonly field: string
  readonly result: TaxAccountingResult
}> => {
  const base = completeResult()
  const usd = (value: string) => MonetaryAmount.unsafeFromString(value, "USD")

  return [
    {
      field: "allocation cost basis",
      result: {
        ...base,
        allocations: base.allocations.map((allocation) => ({
          ...allocation,
          costBasis: usd("10000"),
        })),
      },
    },
    {
      field: "realized cost basis",
      result: {
        ...base,
        realizedResults: base.realizedResults.map((realized) => ({
          ...realized,
          costBasis: usd("10000"),
        })),
      },
    },
    {
      field: "realized proceeds",
      result: {
        ...base,
        realizedResults: base.realizedResults.map((realized) => ({
          ...realized,
          proceeds: usd("15000"),
        })),
      },
    },
    {
      field: "realized gain or loss",
      result: {
        ...base,
        realizedResults: base.realizedResults.map((realized) => ({
          ...realized,
          gainLoss: usd("5000"),
        })),
      },
    },
    {
      field: "income value",
      result: {
        ...base,
        incomeResults: base.incomeResults.map((income) => ({
          ...income,
          value: usd("250"),
        })),
      },
    },
    {
      field: "derived-lot cost basis per unit",
      result: {
        ...base,
        derivedLots: base.derivedLots.map((lot) => ({
          ...lot,
          costBasisPerUnit: usd("40000"),
        })),
      },
    },
  ]
}

await Effect.runPromise(context.recreateTestDatabase())

const removeCalculationRunTestTriggers = () =>
  runPgEffect(
    Effect.gen(function* () {
      const db = yield* drizzle
      yield* db.execute(sql.raw("drop trigger if exists pause_test_older_run on calculation_runs"))
      yield* db.execute(sql.raw("drop function if exists pause_test_older_run()"))
    })
  )

const waitForCalculationRunLockWaiter = () =>
  Effect.promise(() =>
    context.waitForQueryBlockedOnLock({ queryIncludes: 'insert into "calculation_runs"' })
  )

beforeEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* context.recreateTestDatabase()
      yield* removeCalculationRunTestTriggers()
    })
  )
)

describe("CalculationRunRepositoryLive", () => {
  it.effect("rejects stale snapshot membership atomically and preserves a started capture", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())
      const result = completeResult()
      const params = {
        id: RUN_ID,
        principalId: TEST_PRINCIPAL_ID,
        reportingCurrency: EUR,
        jurisdiction: result.jurisdiction,
        taxYear: result.taxYear,
        engineVersion: result.engineVersion,
        ruleSetVersion: result.ruleSetVersion,
        inputLedgerRevision: InputLedgerRevision.make(`v2:801:1.2.:${"a".repeat(64)}`),
        valuationRevision: ValuationRevision.make(`sha256:${"b".repeat(64)}`),
        custodyUnitMembership: [
          { custodyUnitId: TEST_CUSTODY_UNIT_ID, sourceId: SourceId.make(TEST_SOURCE_ID) },
        ],
        correctionInputs: [],
        syncCapture: { requestIds: [] },
      }
      const missingRequest = CalculationSyncRequestId.make("00000000-0000-4000-8000-000000000899")
      const stale = yield* runRepository(
        Effect.flatMap(CalculationRunRepository, (repository) =>
          repository.start({ ...params, syncCapture: { requestIds: [missingRequest] } })
        )
      ).pipe(Effect.result)
      expect(stale).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "CalculationRunAlreadyStoredError" },
      })
      expect((yield* readRunSettlement(RUN_ID)).run).toBeUndefined()
      yield* runRepository(
        Effect.flatMap(CalculationRunRepository, (repository) => repository.start(params))
      )
      const changed = yield* runRepository(
        Effect.flatMap(CalculationRunRepository, (repository) =>
          repository.persist({
            movements: new Map(),
            writeMode: "finalize_started",
            ...params,
            result,
            syncCapture: { requestIds: [missingRequest] },
          })
        )
      ).pipe(Effect.result)
      expect(changed).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "CalculationRunAlreadyStoredError" },
      })
      expect((yield* readRunSettlement(RUN_ID)).run).toMatchObject({ status: "running" })
      yield* runRepository(
        Effect.flatMap(CalculationRunRepository, (repository) =>
          repository.persist({
            movements: new Map(),
            writeMode: "finalize_started",
            ...params,
            result,
          })
        )
      )
      expect((yield* readRunSettlement(RUN_ID)).run).toMatchObject({ status: "complete" })
    })
  )

  it.effect(
    "writes supplied correction inputs atomically and rejects a different snapshot on completion",
    () =>
      Effect.gen(function* () {
        yield* runPgEffect(seedCorrectionRunInput)
        const correctionInputs = yield* captureCorrectionInputs()
        const result = completeResult()
        const params = {
          id: RUN_ID,
          principalId: TEST_PRINCIPAL_ID,
          reportingCurrency: EUR,
          inputLedgerRevision: InputLedgerRevision.make(`v2:801:1.2.:${"a".repeat(64)}`),
          valuationRevision: ValuationRevision.make(`sha256:${"b".repeat(64)}`),
          syncCapture: { requestIds: [] },
          correctionInputs,
        }
        yield* runRepository(
          Effect.flatMap(CalculationRunRepository, (repository) =>
            repository.start({
              ...params,
              jurisdiction: result.jurisdiction,
              taxYear: result.taxYear,
              engineVersion: result.engineVersion,
              ruleSetVersion: result.ruleSetVersion,
              custodyUnitMembership: [
                { custodyUnitId: TEST_CUSTODY_UNIT_ID, sourceId: SourceId.make(TEST_SOURCE_ID) },
              ],
            })
          )
        )
        const storedBefore = yield* runPgEffect(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ captured: schema.calculationRunCorrectionInputs.captured })
              .from(schema.calculationRunCorrectionInputs)
              .where(eq(schema.calculationRunCorrectionInputs.runId, RUN_ID))
          })
        )
        expect(storedBefore).toEqual(correctionInputs.map((captured) => ({ captured })))
        const rejected = yield* runRepository(
          Effect.flatMap(CalculationRunRepository, (repository) =>
            repository.persist({
              movements: new Map(),
              writeMode: "finalize_started",
              ...params,
              correctionInputs: [],
              result,
            })
          )
        ).pipe(Effect.result)
        expect(rejected).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "CalculationRunAlreadyStoredError" },
        })
        expect((yield* readRunSettlement(RUN_ID)).run).toEqual({
          status: "running",
          failureCode: null,
        })
        yield* runRepository(
          Effect.flatMap(CalculationRunRepository, (repository) =>
            repository.persist({
              movements: new Map(),
              writeMode: "finalize_started",
              ...params,
              result,
            })
          )
        )
        expect((yield* readRunSettlement(RUN_ID)).run).toEqual({
          status: "complete",
          failureCode: null,
        })
        yield* runPgEffect(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [stored] = yield* db
              .select({ captured: schema.calculationRunCorrectionInputs.captured })
              .from(schema.calculationRunCorrectionInputs)
              .where(eq(schema.calculationRunCorrectionInputs.runId, RUN_ID))
            expect(stored?.captured).toEqual(correctionInputs[0])
            expect(
              (yield* db
                .update(schema.calculationRunCorrectionInputs)
                .set({ captured: sql`captured || '{"application":"applied"}'::jsonb` })
                .where(eq(schema.calculationRunCorrectionInputs.runId, RUN_ID))
                .pipe(Effect.result))._tag
            ).toBe("Failure")
            expect(
              (yield* db
                .delete(schema.calculationRunCorrectionInputs)
                .where(eq(schema.calculationRunCorrectionInputs.runId, RUN_ID))
                .pipe(Effect.result))._tag
            ).toBe("Failure")
            expect(
              (yield* db
                .delete(schema.calculationRuns)
                .where(eq(schema.calculationRuns.id, RUN_ID))
                .pipe(Effect.result))._tag
            ).toBe("Failure")
          })
        )
      })
  )

  it.effect(
    "rolls back invalid ownership or currency inputs and keeps failed-run inputs immutable",
    () =>
      Effect.gen(function* () {
        const draft = yield* runPgEffect(seedCorrectionRunInput)
        const correctionInputs = yield* captureCorrectionInputs()
        const result = completeResult()
        const first = correctionInputs[0]
        if (first === undefined) return yield* Effect.die("Missing captured input")
        const params = {
          id: RUN_ID,
          principalId: TEST_PRINCIPAL_ID,
          reportingCurrency: EUR,
          jurisdiction: result.jurisdiction,
          taxYear: result.taxYear,
          engineVersion: result.engineVersion,
          ruleSetVersion: result.ruleSetVersion,
          inputLedgerRevision: InputLedgerRevision.make(`v2:801:1.2.:${"a".repeat(64)}`),
          valuationRevision: ValuationRevision.make(`sha256:${"b".repeat(64)}`),
          custodyUnitMembership: [],
          syncCapture: { requestIds: [] },
          correctionInputs,
        }
        for (const invalid of [
          { ...params, principalId: OTHER_PRINCIPAL_ID },
          { ...params, correctionInputs: [{ ...first, reportingCurrency: USD }] },
          { ...params, correctionInputs: [first, first] },
        ]) {
          expect(
            (yield* runRepository(
              Effect.flatMap(CalculationRunRepository, (repository) => repository.start(invalid))
            ).pipe(Effect.result))._tag
          ).toBe("Failure")
          expect((yield* readRunSettlement(RUN_ID)).run).toBeUndefined()
        }
        yield* runPgEffect(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.principalTransactionOverrides).values({
              ...draft,
              kind: "classification",
              priceInput: null,
              classificationInput: { _tag: "inbound", cause: "gift" },
            })
          })
        )
        const laterInputs = yield* captureCorrectionInputs()
        const laterInput = laterInputs.find((input) => input.history.kind === "classification")
        if (laterInput === undefined) return yield* Effect.die("Missing later correction input")
        yield* runRepository(
          Effect.flatMap(CalculationRunRepository, (repository) => repository.start(params))
        )
        yield* runRepository(
          Effect.flatMap(CalculationRunRepository, (repository) =>
            repository.fail({
              id: RUN_ID,
              principalId: TEST_PRINCIPAL_ID,
              failureCode: "synthetic_failure",
            })
          )
        )
        yield* runPgEffect(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [stored] = yield* db
              .select({ captured: schema.calculationRunCorrectionInputs.captured })
              .from(schema.calculationRunCorrectionInputs)
              .where(eq(schema.calculationRunCorrectionInputs.runId, RUN_ID))
            expect(stored?.captured).toEqual(first)
            expect(
              (yield* db
                .delete(schema.calculationRunCorrectionInputs)
                .where(eq(schema.calculationRunCorrectionInputs.runId, RUN_ID))
                .pipe(Effect.result))._tag
            ).toBe("Failure")
            const row = {
              runId: RUN_ID,
              principalId: TEST_PRINCIPAL_ID,
              jurisdiction: result.jurisdiction,
              taxYear: result.taxYear,
              reportingCurrency: EUR,
              sourceId: laterInput.history.sourceId,
              targetId: laterInput.history.targetId,
              overrideId: laterInput.history.id,
              kind: laterInput.history.kind,
              captured: laterInput,
            }
            const late = yield* db
              .insert(schema.calculationRunCorrectionInputs)
              .values(row)
              .pipe(Effect.result)
            expect(late._tag).toBe("Failure")
          })
        )
      })
  )

  it.effect(
    "direct persistence saves the explicit capture without re-reading later correction history",
    () =>
      Effect.gen(function* () {
        const draft = yield* runPgEffect(seedCorrectionRunInput)
        const correctionInputs = yield* captureCorrectionInputs()
        const result = completeResult()
        const first = correctionInputs[0]
        if (first === undefined) return yield* Effect.die("Missing captured input")
        yield* runPgEffect(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.principalTransactionOverrides).values({
              ...draft,
              operation: "withdraw",
              supersedesOverrideId: first.history.id,
              priceInput: null,
            })
          })
        )
        yield* runRepository(
          Effect.flatMap(CalculationRunRepository, (repository) =>
            repository.persist({
              movements: new Map(),
              writeMode: "atomic",
              id: RUN_ID,
              principalId: TEST_PRINCIPAL_ID,
              reportingCurrency: EUR,
              inputLedgerRevision: InputLedgerRevision.make(`v2:801:1.2.:${"a".repeat(64)}`),
              valuationRevision: ValuationRevision.make(`sha256:${"b".repeat(64)}`),
              syncCapture: { requestIds: [] },
              correctionInputs,
              result,
            })
          )
        )
        const stored = yield* runPgEffect(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ captured: schema.calculationRunCorrectionInputs.captured })
              .from(schema.calculationRunCorrectionInputs)
              .where(eq(schema.calculationRunCorrectionInputs.runId, RUN_ID))
          })
        )
        expect(stored).toEqual(correctionInputs.map((captured) => ({ captured })))
      })
  )

  it.effect("fails stale runs once and leaves fresh runs running", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture({ includeOtherPrincipal: true }))
      const oldCompletion = date("2026-01-01T00:00:00.000Z")
      const staleStartedAt = date("2026-01-01T00:01:00.000Z")
      const freshStartedAt = date("2026-01-01T00:09:00.000Z")

      yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.insert(schema.processingJobs).values([
            {
              sourceId: TEST_SOURCE_ID,
              principalId: TEST_PRINCIPAL_ID,
              status: "completed",
              completedAt: oldCompletion,
            },
            {
              sourceId: OTHER_SOURCE_ID,
              principalId: OTHER_PRINCIPAL_ID,
              status: "completed",
              completedAt: oldCompletion,
            },
          ])
        })
      )
      const coveredRevision = yield* captureInputLedgerRevision()
      yield* runRepository(
        Effect.flatMap(CalculationRunRepository, (repository) =>
          Effect.gen(function* () {
            yield* repository.start({
              syncCapture: { requestIds: [] },
              correctionInputs: [],
              id: RECOMPUTE_RUN_ID,
              principalId: TEST_PRINCIPAL_ID,
              jurisdiction: JurisdictionCode.make("DE"),
              taxYear: TaxYear.make(2026),
              reportingCurrency: EUR,
              engineVersion: "1",
              ruleSetVersion: "de-crypto-income-tax-v2025-03-06",
              inputLedgerRevision: coveredRevision,
              valuationRevision: ValuationRevision.make(`sha256:${"b".repeat(64)}`),
              custodyUnitMembership: [
                {
                  sourceId: SourceId.make(TEST_SOURCE_ID),
                  custodyUnitId: TEST_CUSTODY_UNIT_ID,
                },
              ],
            })
            yield* repository.start({
              syncCapture: { requestIds: [] },
              correctionInputs: [],
              id: OTHER_MAINTENANCE_RUN_ID,
              principalId: OTHER_PRINCIPAL_ID,
              jurisdiction: JurisdictionCode.make("DE"),
              taxYear: TaxYear.make(2026),
              reportingCurrency: EUR,
              engineVersion: "1",
              ruleSetVersion: "de-crypto-income-tax-v2025-03-06",
              inputLedgerRevision: coveredRevision,
              valuationRevision: ValuationRevision.make(`sha256:${"b".repeat(64)}`),
              custodyUnitMembership: [
                {
                  sourceId: SourceId.make(OTHER_SOURCE_ID),
                  custodyUnitId: OTHER_CUSTODY_UNIT_ID,
                },
              ],
            })
          })
        )
      )
      yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .update(schema.calculationRuns)
            .set({ startedAt: staleStartedAt, updatedAt: staleStartedAt })
            .where(eq(schema.calculationRuns.id, RECOMPUTE_RUN_ID))
          yield* db
            .update(schema.calculationRuns)
            .set({ startedAt: freshStartedAt, updatedAt: freshStartedAt })
            .where(eq(schema.calculationRuns.id, OTHER_MAINTENANCE_RUN_ID))
        })
      )

      const maintenance = yield* runRepository(
        Effect.flatMap(CalculationRunRepository, (repository) =>
          repository.settleStaleAndFindRecomputePrincipals({
            staleBefore: date("2026-01-01T00:05:00.000Z"),
            limit: 100,
          })
        )
      )
      const retryAfterSettlement = yield* runRepository(
        Effect.flatMap(CalculationRunRepository, (repository) =>
          repository.settleStaleAndFindRecomputePrincipals({
            staleBefore: date("2026-01-01T00:05:00.000Z"),
            limit: 100,
          })
        )
      )
      yield* runRepository(
        Effect.flatMap(CalculationRunRepository, (repository) =>
          repository.start({
            syncCapture: { requestIds: [] },
            correctionInputs: [],
            id: FIFTH_RUN_ID,
            principalId: TEST_PRINCIPAL_ID,
            jurisdiction: JurisdictionCode.make("DE"),
            taxYear: TaxYear.make(2026),
            reportingCurrency: EUR,
            engineVersion: "1",
            ruleSetVersion: "de-crypto-income-tax-v2025-03-06",
            inputLedgerRevision: coveredRevision,
            valuationRevision: ValuationRevision.make(`sha256:${"b".repeat(64)}`),
            custodyUnitMembership: [
              {
                sourceId: SourceId.make(TEST_SOURCE_ID),
                custodyUnitId: TEST_CUSTODY_UNIT_ID,
              },
            ],
          })
        )
      )
      yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db
            .update(schema.calculationRuns)
            .set({ startedAt: freshStartedAt, updatedAt: freshStartedAt })
            .where(eq(schema.calculationRuns.id, FIFTH_RUN_ID))
        })
      )
      const settledAfterReplacement = yield* runRepository(
        Effect.flatMap(CalculationRunRepository, (repository) =>
          repository.settleStaleAndFindRecomputePrincipals({
            staleBefore: date("2026-01-01T00:05:00.000Z"),
            limit: 100,
          })
        )
      )
      const runs = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              id: schema.calculationRuns.id,
              status: schema.calculationRuns.status,
              failureCode: schema.calculationRuns.failureCode,
            })
            .from(schema.calculationRuns)
            .orderBy(asc(schema.calculationRuns.id))
        })
      )

      expect(maintenance).toEqual({
        failedStaleRuns: 1,
        nextAfterPrincipalId: null,
        principalIds: [TEST_PRINCIPAL_ID],
      })
      expect(retryAfterSettlement).toEqual({
        failedStaleRuns: 0,
        nextAfterPrincipalId: null,
        principalIds: [TEST_PRINCIPAL_ID],
      })
      expect(settledAfterReplacement).toEqual({
        failedStaleRuns: 0,
        nextAfterPrincipalId: null,
        principalIds: [],
      })
      expect(runs).toEqual([
        {
          id: FIFTH_RUN_ID,
          status: "running",
          failureCode: null,
        },
        {
          id: RECOMPUTE_RUN_ID,
          status: "failed",
          failureCode: "calculation_stale_recomputed",
        },
        {
          id: OTHER_MAINTENANCE_RUN_ID,
          status: "running",
          failureCode: null,
        },
      ])
    })
  )

  it.effect("retries when any completed source job was absent from the run snapshot", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture({ includeOtherPrincipal: true }))
      const sourceCompletedAt = date("2026-01-01T00:00:00.000Z")
      yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.insert(schema.processingJobs).values([
            {
              sourceId: TEST_SOURCE_ID,
              principalId: TEST_PRINCIPAL_ID,
              status: "completed",
              completedAt: date("2026-01-01T00:02:00.000Z"),
            },
            {
              sourceId: OTHER_SOURCE_ID,
              principalId: OTHER_PRINCIPAL_ID,
              status: "completed",
              completedAt: sourceCompletedAt,
            },
          ])
        })
      )
      const coveredRevision = yield* captureInputLedgerRevision()
      yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.insert(schema.processingJobs).values({
            sourceId: TEST_SOURCE_ID,
            principalId: TEST_PRINCIPAL_ID,
            status: "completed",
            completedAt: date("2026-01-01T00:01:00.000Z"),
          })
        })
      )
      yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          const startedAt = date("2026-01-01T00:03:00.000Z")
          yield* db.insert(schema.calculationRuns).values([
            runningMaintenanceRun({
              id: RECOMPUTE_RUN_ID,
              principalId: TEST_PRINCIPAL_ID,
              inputLedgerRevision: coveredRevision,
              startedAt,
            }),
            runningMaintenanceRun({
              id: OTHER_MAINTENANCE_RUN_ID,
              principalId: OTHER_PRINCIPAL_ID,
              inputLedgerRevision: coveredRevision,
              startedAt,
            }),
          ])
        })
      )
      const maintain = runRepository(
        Effect.flatMap(CalculationRunRepository, (repository) =>
          repository.settleStaleAndFindRecomputePrincipals({
            staleBefore: date("2025-12-31T23:59:00.000Z"),
            limit: 100,
          })
        )
      )

      const first = yield* maintain
      const retry = yield* maintain

      expect(first).toEqual({
        failedStaleRuns: 0,
        nextAfterPrincipalId: null,
        principalIds: [TEST_PRINCIPAL_ID],
      })
      expect(retry).toEqual(first)
    })
  )

  it.effect("rolls back stale settlement when its database update fails", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())
      const revision = yield* captureInputLedgerRevision()
      const staleStartedAt = date("2026-01-01T00:00:00.000Z")
      yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.insert(schema.calculationRuns).values(
            runningMaintenanceRun({
              id: RECOMPUTE_RUN_ID,
              principalId: TEST_PRINCIPAL_ID,
              inputLedgerRevision: revision,
              startedAt: staleStartedAt,
            })
          )
          yield* db.execute(
            sql.raw(`
              create function reject_test_stale_calculation() returns trigger as $$
              begin
                if new.failure_code = 'calculation_stale_recomputed' then
                  raise exception 'forced stale settlement failure';
                end if;
                return new;
              end;
              $$ language plpgsql
            `)
          )
          yield* db.execute(
            sql.raw(`
              create trigger reject_test_stale_calculation
              before update on calculation_runs
              for each row execute function reject_test_stale_calculation()
            `)
          )
        })
      )

      const error = yield* runRepository(
        Effect.flip(
          Effect.flatMap(CalculationRunRepository, (repository) =>
            repository.settleStaleAndFindRecomputePrincipals({
              staleBefore: date("2026-01-01T00:05:00.000Z"),
              limit: 100,
            })
          )
        )
      )
      const settlement = yield* readRunSettlement(RECOMPUTE_RUN_ID)

      expect(error).toBeInstanceOf(PersistenceError)
      expect(settlement.run).toEqual({ status: "running", failureCode: null })
      expect(settlement.active).toBeUndefined()
    })
  )

  it.effect("starts a visible run and settles it as failed without activation", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())

      const statuses = yield* runRepository(
        Effect.flatMap(CalculationRunRepository, (repository) =>
          Effect.gen(function* () {
            yield* repository.start({
              syncCapture: { requestIds: [] },
              correctionInputs: [],
              id: RECOMPUTE_RUN_ID,
              principalId: TEST_PRINCIPAL_ID,
              jurisdiction: JurisdictionCode.make("DE"),
              taxYear: TaxYear.make(2025),
              reportingCurrency: EUR,
              engineVersion: "1",
              ruleSetVersion: "de-crypto-income-tax-v2025-03-06",
              inputLedgerRevision: InputLedgerRevision.make(`v2:815:1.2.:${"a".repeat(64)}`),
              valuationRevision: ValuationRevision.make(`sha256:${"b".repeat(64)}`),
              custodyUnitMembership: [
                {
                  sourceId: SourceId.make(TEST_SOURCE_ID),
                  custodyUnitId: TEST_CUSTODY_UNIT_ID,
                },
              ],
            })

            const running = yield* repository.getLatestStatus({
              principalId: TEST_PRINCIPAL_ID,
              jurisdiction: JurisdictionCode.make("DE"),
              taxYear: TaxYear.make(2025),
              reportingCurrency: EUR,
            })
            yield* repository.fail({
              id: RECOMPUTE_RUN_ID,
              principalId: TEST_PRINCIPAL_ID,
              failureCode: "calculation_failed",
            })
            const failed = yield* repository.getLatestStatus({
              principalId: TEST_PRINCIPAL_ID,
              jurisdiction: JurisdictionCode.make("DE"),
              taxYear: TaxYear.make(2025),
              reportingCurrency: EUR,
            })

            return { running, failed }
          })
        )
      )

      const active = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({ runId: schema.activeCalculationRuns.runId })
            .from(schema.activeCalculationRuns)
        })
      )

      expect(statuses.running).toEqual({
        runId: RECOMPUTE_RUN_ID,
        status: "running",
        failureCode: null,
      })
      expect(statuses.failed).toEqual({
        runId: RECOMPUTE_RUN_ID,
        status: "failed",
        failureCode: "calculation_failed",
      })
      expect(active).toEqual([])
    })
  )

  it.effect("recomputes complete and partial runs from factual snapshots", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())
      yield* runPgEffect(
        seedAcquisitionFact({
          eventId: "00000000-0000-4000-8000-000000000817",
          externalId: "valued-acquisition",
          providerFiatAmount: "100",
        })
      )

      const complete = yield* runCalculationService(recomputeResult({ id: RECOMPUTE_RUN_ID }))

      yield* runPgEffect(
        seedAcquisitionFact({
          eventId: "00000000-0000-4000-8000-000000000818",
          externalId: "unvalued-acquisition",
          providerFiatAmount: null,
        })
      )

      const partial = yield* runCalculationService(
        recomputeResult({ id: PARTIAL_RECOMPUTE_RUN_ID })
      )
      const stored = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          const runs = yield* db
            .select({
              id: schema.calculationRuns.id,
              inputLedgerRevision: schema.calculationRuns.inputLedgerRevision,
              valuationRevision: schema.calculationRuns.valuationRevision,
              status: schema.calculationRuns.status,
            })
            .from(schema.calculationRuns)
            .orderBy(asc(schema.calculationRuns.id))
          const [active] = yield* db
            .select({ runId: schema.activeCalculationRuns.runId })
            .from(schema.activeCalculationRuns)
          const blockers = yield* db
            .select({ runId: schema.calculationRunBlockers.runId })
            .from(schema.calculationRunBlockers)

          return { runs, active, blockers }
        })
      )

      expect(complete).toMatchObject({ activated: true, status: "complete" })
      expect(partial).toMatchObject({ activated: true, status: "partial" })
      expect(complete.inputLedgerRevision).toMatch(
        /^v2:\d+:\d+\.\d+\.(?:\d+(?:,\d+)*)?:[0-9a-f]{64}$/
      )
      expect(complete.valuationRevision).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(partial.inputLedgerRevision).not.toBe(complete.inputLedgerRevision)
      expect(stored.runs).toEqual([
        expect.objectContaining({ id: RECOMPUTE_RUN_ID, status: "complete" }),
        expect.objectContaining({ id: PARTIAL_RECOMPUTE_RUN_ID, status: "partial" }),
      ])
      expect(stored.active).toEqual({ runId: PARTIAL_RECOMPUTE_RUN_ID })
      expect(stored.blockers).toEqual([{ runId: PARTIAL_RECOMPUTE_RUN_ID }])
    })
  )

  it.effect("keeps mid-calculation fact changes outside the repeatable-read snapshot", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())
      yield* runPgEffect(
        seedAcquisitionFact({
          eventId: "00000000-0000-4000-8000-000000000817",
          externalId: "valued-before-snapshot",
          providerFiatAmount: "100",
        })
      )
      const snapshotLoaded = yield* Deferred.make<void>()
      const releaseSnapshot = yield* Deferred.make<void>()
      const coordinatedFactualLedgerLive = Layer.effect(
        FactualLedgerRepository,
        Effect.map(FactualLedgerRepository, (repository) =>
          FactualLedgerRepository.of({
            load: (params) =>
              repository.load(params).pipe(
                Effect.tap(() => Deferred.succeed(snapshotLoaded, undefined)),
                Effect.tap(() => Deferred.await(releaseSnapshot))
              ),
          })
        )
      ).pipe(Layer.provide(FactualLedgerRepositoryLive))
      const coordinatedCalculationServiceLive = CalculationRunServiceLive.pipe(
        Layer.provide(Layer.merge(CalculationRunRepositoryLive, coordinatedFactualLedgerLive))
      )
      const recompute = yield* Effect.forkChild(
        context.runWithLayer({
          effect: recomputeResult({ id: RECOMPUTE_RUN_ID }),
          layer: coordinatedCalculationServiceLive,
        })
      )

      yield* Deferred.await(snapshotLoaded)
      yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* seedAcquisitionFact({
            eventId: "00000000-0000-4000-8000-000000000818",
            externalId: "unvalued-after-snapshot",
            providerFiatAmount: null,
          })
          yield* db
            .update(schema.transactions)
            .set({ providerFiatAmount: null, providerFiatCurrency: null })
            .where(eq(schema.transactions.externalId, "valued-before-snapshot"))
          yield* db.insert(schema.custodyUnits).values({
            id: GROUPED_CUSTODY_UNIT_ID,
            principalId: TEST_PRINCIPAL_ID,
          })
          yield* db
            .update(schema.custodyUnitSources)
            .set({ custodyUnitId: GROUPED_CUSTODY_UNIT_ID })
            .where(eq(schema.custodyUnitSources.sourceId, TEST_SOURCE_ID))
        })
      )
      yield* Deferred.succeed(releaseSnapshot, undefined)

      const outcome = yield* Fiber.join(recompute)
      const stored = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          const snapshots = yield* readLiveAndStoredMembership(RECOMPUTE_RUN_ID)
          const [run] = yield* db
            .select({ processedEventIds: schema.calculationRuns.processedEventIds })
            .from(schema.calculationRuns)
            .where(eq(schema.calculationRuns.id, RECOMPUTE_RUN_ID))

          return { ...snapshots, run }
        })
      )

      expect(outcome.status).toBe("complete")
      expect(stored).toEqual({
        live: { custodyUnitId: GROUPED_CUSTODY_UNIT_ID },
        snapshot: { custodyUnitId: TEST_SOURCE_ID, sourceId: TEST_SOURCE_ID },
        run: { processedEventIds: ["00000000-0000-4000-8000-000000000817"] },
      })
    })
  )

  it.effect("does not mutate the prior active result when calculation fails", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())
      yield* runRepository(persistResult())

      const error = yield* runCalculationService(
        Effect.flip(
          recomputeResult({ id: RECOMPUTE_RUN_ID, jurisdiction: "unsupported-jurisdiction" })
        )
      )
      const stored = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          const runs = yield* db
            .select({
              id: schema.calculationRuns.id,
              status: schema.calculationRuns.status,
              failureCode: schema.calculationRuns.failureCode,
            })
            .from(schema.calculationRuns)
            .orderBy(asc(schema.calculationRuns.id))
          const [active] = yield* db
            .select({ runId: schema.activeCalculationRuns.runId })
            .from(schema.activeCalculationRuns)

          return { runs, active }
        })
      )

      expect(error._tag).toBe("UnsupportedJurisdictionError")
      expect(stored).toEqual({
        runs: [
          { id: RUN_ID, status: "complete", failureCode: null },
          {
            id: RECOMPUTE_RUN_ID,
            status: "failed",
            failureCode: "calculation_failed",
          },
        ],
        active: { runId: RUN_ID },
      })
    })
  )

  it.effect("settles a running run when terminal persistence fails", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())
      yield* runRepository(persistResult())
      const serviceLive = calculationRunServiceWithPersist(
        () => () =>
          Effect.fail(
            new PersistenceError({
              operation: "calculationRunRepository.persist.test",
              cause: "forced terminal persistence failure",
            })
          )
      )

      const error = yield* context.runWithLayer({
        effect: Effect.flip(recomputeResult({ id: RECOMPUTE_RUN_ID })),
        layer: serviceLive,
      })
      const stored = yield* readRunSettlement(RECOMPUTE_RUN_ID)

      expect(error).toBeInstanceOf(PersistenceError)
      expect(stored).toEqual({
        run: { status: "failed", failureCode: "calculation_failed" },
        active: { runId: RUN_ID },
      })
    })
  )

  it.effect("settles a running run while preserving an engine-path defect", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())
      const serviceLive = calculationRunServiceWithPersist(
        () => () => Effect.die("forced calculation defect")
      )

      const exit = yield* context.runWithLayer({
        effect: Effect.exit(recomputeResult({ id: RECOMPUTE_RUN_ID })),
        layer: serviceLive,
      })
      const stored = yield* readRunSettlement(RECOMPUTE_RUN_ID)

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(stored).toEqual({
        run: { status: "failed", failureCode: "calculation_failed" },
        active: undefined,
      })
    })
  )

  it.effect("settles a running run while preserving interruption", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())
      const terminalWriteReached = yield* Deferred.make<void>()
      const serviceLive = calculationRunServiceWithPersist(
        () => () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(terminalWriteReached, undefined)
            return yield* Effect.never
          })
      )
      const calculation = yield* Effect.forkChild(
        context.runWithLayer({
          effect: recomputeResult({ id: RECOMPUTE_RUN_ID }),
          layer: serviceLive,
        })
      )

      yield* Deferred.await(terminalWriteReached)
      yield* Fiber.interrupt(calculation)
      const exit = yield* Fiber.await(calculation)
      const stored = yield* readRunSettlement(RECOMPUTE_RUN_ID)

      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(stored).toEqual({
        run: { status: "failed", failureCode: "calculation_failed" },
        active: undefined,
      })
    })
  )

  it.effect("writes one complete run and activates its complete result atomically", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())

      yield* runRepository(persistResult())

      const stored = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [run] = yield* db
            .select({
              id: schema.calculationRuns.id,
              principalId: schema.calculationRuns.principalId,
              jurisdiction: schema.calculationRuns.jurisdiction,
              taxYear: schema.calculationRuns.taxYear,
              reportingCurrency: schema.calculationRuns.reportingCurrency,
              status: schema.calculationRuns.status,
              accountingMethod: schema.calculationRuns.accountingMethod,
              inventoryScope: schema.calculationRuns.inventoryScope,
              appliedRules: schema.calculationRuns.appliedRules,
              processedEventIds: schema.calculationRuns.processedEventIds,
              startedAt: schema.calculationRuns.startedAt,
              completedAt: schema.calculationRuns.completedAt,
            })
            .from(schema.calculationRuns)
            .where(eq(schema.calculationRuns.id, RUN_ID))
          const [active] = yield* db
            .select({ runId: schema.activeCalculationRuns.runId })
            .from(schema.activeCalculationRuns)
            .where(eq(schema.activeCalculationRuns.principalId, TEST_PRINCIPAL_ID))
          const custodyUnits = yield* db
            .select({ custodyUnitId: schema.calculationRunCustodyUnits.custodyUnitId })
            .from(schema.calculationRunCustodyUnits)
            .where(eq(schema.calculationRunCustodyUnits.runId, RUN_ID))
          const custodySources = yield* db
            .select({ sourceId: schema.calculationRunCustodyUnitSources.sourceId })
            .from(schema.calculationRunCustodyUnitSources)
            .where(eq(schema.calculationRunCustodyUnitSources.runId, RUN_ID))
          const allocations = yield* db
            .select({
              sequence: schema.calculationRunAllocations.sequence,
              quantity: schema.calculationRunAllocations.quantity,
            })
            .from(schema.calculationRunAllocations)
            .where(eq(schema.calculationRunAllocations.runId, RUN_ID))
            .orderBy(asc(schema.calculationRunAllocations.sequence))
          const realizedResults = yield* db
            .select({
              sequence: schema.calculationRunRealizedResults.sequence,
              sourceId: schema.calculationRunRealizedResults.sourceId,
              allocationSequence: schema.calculationRunRealizedResults.allocationSequence,
              gainLoss: schema.calculationRunRealizedResults.gainLoss,
            })
            .from(schema.calculationRunRealizedResults)
            .where(eq(schema.calculationRunRealizedResults.runId, RUN_ID))
          const incomeResults = yield* db
            .select({
              sequence: schema.calculationRunIncomeResults.sequence,
              sourceId: schema.calculationRunIncomeResults.sourceId,
              value: schema.calculationRunIncomeResults.value,
            })
            .from(schema.calculationRunIncomeResults)
            .where(eq(schema.calculationRunIncomeResults.runId, RUN_ID))
          const derivedLots = yield* db
            .select({
              sequence: schema.calculationRunDerivedLots.sequence,
              remainingQuantity: schema.calculationRunDerivedLots.remainingQuantity,
            })
            .from(schema.calculationRunDerivedLots)
            .where(eq(schema.calculationRunDerivedLots.runId, RUN_ID))
          const explanations = yield* db
            .select({
              sequence: schema.calculationRunExplanationEntries.sequence,
              matches: schema.calculationRunExplanationEntries.matches,
            })
            .from(schema.calculationRunExplanationEntries)
            .where(eq(schema.calculationRunExplanationEntries.runId, RUN_ID))

          return {
            run,
            active,
            custodyUnits,
            custodySources,
            allocations,
            realizedResults,
            incomeResults,
            derivedLots,
            explanations,
          }
        })
      )

      expect(stored.run).toMatchObject({
        id: RUN_ID,
        principalId: TEST_PRINCIPAL_ID,
        jurisdiction: "DE",
        taxYear: 2025,
        reportingCurrency: "EUR",
        status: "complete",
        accountingMethod: "fifo",
        inventoryScope: "per_custody_unit",
        appliedRules: ["de.private.section23.wallet-fifo-method"],
        processedEventIds: [ACQUISITION_EVENT_ID, DISPOSITION_EVENT_ID],
      })
      expect(stored.run?.startedAt).toBeInstanceOf(Date)
      expect(stored.run?.completedAt).toBeInstanceOf(Date)
      expect(stored.active).toEqual({ runId: RUN_ID })
      expect(stored.custodyUnits).toHaveLength(1)
      expect(stored.custodySources).toHaveLength(1)
      const [allocation] = stored.allocations
      const [realized] = stored.realizedResults
      const [income] = stored.incomeResults
      const [derivedLot] = stored.derivedLots

      expect(allocation?.sequence).toBe(0)
      expect(
        allocation === undefined
          ? false
          : BigDecimal.equals(BigDecimal.fromStringUnsafe(allocation.quantity), quantity("0.25"))
      ).toBe(true)
      expect(realized?.sequence).toBe(0)
      expect(realized?.sourceId).toBe(TEST_SOURCE_ID)
      expect(realized?.allocationSequence).toBe(allocation?.sequence)
      expect(
        realized === undefined
          ? false
          : BigDecimal.equals(BigDecimal.fromStringUnsafe(realized.gainLoss), quantity("5000"))
      ).toBe(true)
      expect(income?.sequence).toBe(0)
      expect(income?.sourceId).toBe(TEST_SOURCE_ID)
      expect(
        income === undefined
          ? false
          : BigDecimal.equals(BigDecimal.fromStringUnsafe(income.value), quantity("250"))
      ).toBe(true)
      expect(derivedLot?.sequence).toBe(0)
      expect(
        derivedLot === undefined
          ? false
          : BigDecimal.equals(
              BigDecimal.fromStringUnsafe(derivedLot.remainingQuantity),
              quantity("0.75")
            )
      ).toBe(true)
      expect(stored.explanations).toEqual([
        expect.objectContaining({
          sequence: 17,
          matches: [{ acquisitionEventId: ACQUISITION_EVENT_ID, quantity: "0.25" }],
        }),
      ])
    })
  )

  it.effect("batches results beyond PostgreSQL's single-statement parameter limit", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())
      const base = completeResult()
      const allocation = base.allocations[0]

      if (allocation === undefined) {
        return yield* Effect.die("completeResult must contain one allocation")
      }

      const allocationCount = 6_000
      yield* runRepository(
        persistResult({
          result: {
            ...base,
            allocations: Array.from({ length: allocationCount }, () => allocation),
          },
        })
      )

      const stored = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [allocationSummary] = yield* db
            .select({
              count: sql<number>`count(*)::integer`,
              firstSequence: sql<number>`min(${schema.calculationRunAllocations.sequence})::integer`,
              lastSequence: sql<number>`max(${schema.calculationRunAllocations.sequence})::integer`,
            })
            .from(schema.calculationRunAllocations)
            .where(eq(schema.calculationRunAllocations.runId, RUN_ID))
          const [active] = yield* db
            .select({ runId: schema.activeCalculationRuns.runId })
            .from(schema.activeCalculationRuns)
            .where(eq(schema.activeCalculationRuns.runId, RUN_ID))

          return { allocationSummary, active }
        })
      )

      expect(stored).toEqual({
        allocationSummary: {
          count: allocationCount,
          firstSequence: 0,
          lastSequence: allocationCount - 1,
        },
        active: { runId: RUN_ID },
      })
    })
  )

  it.effect("keeps the claimed run pending until child rows are stored", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())
      yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.execute(
            sql.raw(`
              create function assert_test_run_pending() returns trigger as $$
              declare parent_status text;
              declare parent_completed_at timestamptz;
              begin
                select status::text, completed_at
                  into parent_status, parent_completed_at
                  from calculation_runs
                  where id = new.run_id;
                if parent_status <> 'pending' or parent_completed_at is not null then
                  raise exception 'run was finalized before child persistence';
                end if;
                return new;
              end;
              $$ language plpgsql
            `)
          )
          yield* db.execute(
            sql.raw(`
              create trigger assert_test_run_pending
              before insert on calculation_run_allocations
              for each row execute function assert_test_run_pending()
            `)
          )
          yield* db.execute(
            sql.raw(`
              create function assert_test_run_finalized() returns trigger as $$
              declare parent_status text;
              declare parent_started_at timestamptz;
              declare parent_completed_at timestamptz;
              begin
                select status::text, started_at, completed_at
                  into parent_status, parent_started_at, parent_completed_at
                  from calculation_runs
                  where id = new.run_id;
                if parent_status <> 'complete'
                  or parent_completed_at is null
                  or parent_completed_at < parent_started_at then
                  raise exception 'run was activated before finalization';
                end if;
                return new;
              end;
              $$ language plpgsql
            `)
          )
          yield* db.execute(
            sql.raw(`
              create trigger assert_test_run_finalized
              before insert on active_calculation_runs
              for each row execute function assert_test_run_finalized()
            `)
          )
        })
      )

      const removeLifecycleAssertions = runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.execute(
            sql.raw("drop trigger if exists assert_test_run_pending on calculation_run_allocations")
          )
          yield* db.execute(
            sql.raw("drop trigger if exists assert_test_run_finalized on active_calculation_runs")
          )
          yield* db.execute(sql.raw("drop function if exists assert_test_run_pending()"))
          yield* db.execute(sql.raw("drop function if exists assert_test_run_finalized()"))
        })
      )

      yield* runRepository(persistResult()).pipe(Effect.ensuring(removeLifecycleAssertions))

      const [stored] = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              status: schema.calculationRuns.status,
              accountingMethod: schema.calculationRuns.accountingMethod,
              inventoryScope: schema.calculationRuns.inventoryScope,
              startedAt: schema.calculationRuns.startedAt,
              completedAt: schema.calculationRuns.completedAt,
            })
            .from(schema.calculationRuns)
            .where(eq(schema.calculationRuns.id, RUN_ID))
        })
      )

      expect(stored).toMatchObject({
        status: "complete",
        accountingMethod: "fifo",
        inventoryScope: "per_custody_unit",
      })
      expect(stored?.startedAt).toBeInstanceOf(Date)
      expect(stored?.completedAt).toBeInstanceOf(Date)
      expect((stored?.completedAt?.getTime() ?? 0) >= (stored?.startedAt?.getTime() ?? 1)).toBe(
        true
      )
    })
  )

  it.effect("writes and activates a partial run with ordered blockers", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())

      const partialResult: TaxAccountingResult = {
        ...completeResult(),
        status: "partial",
        allocations: completeResult().allocations.map((allocation) => ({
          ...allocation,
          costBasis: null,
        })),
        realizedResults: [],
        incomeResults: [],
        derivedLots: completeResult().derivedLots.map((lot) => ({
          ...lot,
          costBasisPerUnit: null,
        })),
        blockers: [
          {
            code: "missing_valuation",
            eventId: ACQUISITION_EVENT_ID,
            assetId: TEST_BTC_ASSET_ID,
            custodyUnitId: TEST_CUSTODY_UNIT_ID,
            missingQuantity: null,
          },
          {
            code: "inventory_shortage",
            eventId: DISPOSITION_EVENT_ID,
            assetId: TEST_BTC_ASSET_ID,
            custodyUnitId: TEST_CUSTODY_UNIT_ID,
            missingQuantity: quantity("0.5"),
          },
        ],
      }

      yield* runRepository(persistResult({ result: partialResult }))

      const stored = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [run] = yield* db
            .select({ status: schema.calculationRuns.status })
            .from(schema.calculationRuns)
            .where(eq(schema.calculationRuns.id, RUN_ID))
          const [active] = yield* db
            .select({ runId: schema.activeCalculationRuns.runId })
            .from(schema.activeCalculationRuns)
            .where(eq(schema.activeCalculationRuns.principalId, TEST_PRINCIPAL_ID))
          const blockers = yield* db
            .select({
              sequence: schema.calculationRunBlockers.sequence,
              code: schema.calculationRunBlockers.code,
              missingQuantity: schema.calculationRunBlockers.missingQuantity,
            })
            .from(schema.calculationRunBlockers)
            .where(eq(schema.calculationRunBlockers.runId, RUN_ID))
            .orderBy(asc(schema.calculationRunBlockers.sequence))

          const [allocation] = yield* db
            .select({ costBasis: schema.calculationRunAllocations.costBasis })
            .from(schema.calculationRunAllocations)
            .where(eq(schema.calculationRunAllocations.runId, RUN_ID))
          const [derivedLot] = yield* db
            .select({ costBasisPerUnit: schema.calculationRunDerivedLots.costBasisPerUnit })
            .from(schema.calculationRunDerivedLots)
            .where(eq(schema.calculationRunDerivedLots.runId, RUN_ID))

          return { run, active, blockers, allocation, derivedLot }
        })
      )

      expect(stored.run).toEqual({ status: "partial" })
      expect(stored.active).toEqual({ runId: RUN_ID })
      expect(stored.allocation).toEqual({ costBasis: null })
      expect(stored.derivedLot).toEqual({ costBasisPerUnit: null })
      expect(stored.blockers.map(({ sequence, code }) => ({ sequence, code }))).toEqual([
        { sequence: 0, code: "missing_valuation" },
        { sequence: 1, code: "inventory_shortage" },
      ])
      const missingQuantity = stored.blockers[1]?.missingQuantity
      expect(
        missingQuantity === null || missingQuantity === undefined
          ? false
          : BigDecimal.equals(BigDecimal.fromStringUnsafe(missingQuantity), quantity("0.5"))
      ).toBe(true)
    })
  )

  it.effect("stores each result collection in its engine-provided order", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())

      const base = completeResult()
      const orderedResult: TaxAccountingResult = {
        ...base,
        allocations: base.allocations.flatMap((item) => [
          item,
          { ...item, quantity: quantity("0.5") },
        ]),
        realizedResults: base.realizedResults.flatMap((item) => [
          item,
          { ...item, treatmentCodes: ["second.realized"] },
        ]),
        incomeResults: base.incomeResults.flatMap((item) => [
          item,
          { ...item, treatmentCodes: ["second.income"] },
        ]),
        derivedLots: base.derivedLots.flatMap((item) => [
          item,
          { ...item, remainingQuantity: quantity("0.5") },
        ]),
        blockers: [
          {
            code: "missing_valuation",
            eventId: ACQUISITION_EVENT_ID,
            assetId: TEST_BTC_ASSET_ID,
            custodyUnitId: TEST_CUSTODY_UNIT_ID,
            missingQuantity: null,
          },
          {
            code: "inventory_shortage",
            eventId: DISPOSITION_EVENT_ID,
            assetId: TEST_BTC_ASSET_ID,
            custodyUnitId: TEST_CUSTODY_UNIT_ID,
            missingQuantity: quantity("0.5"),
          },
        ],
        explanationTrace: base.explanationTrace.flatMap((entry) => [
          entry,
          { ...entry, sequence: 23, code: "second.explanation" },
        ]),
      }

      yield* runRepository(persistResult({ result: orderedResult }))

      const stored = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          const allocations = yield* db
            .select({
              sequence: schema.calculationRunAllocations.sequence,
              quantity: schema.calculationRunAllocations.quantity,
            })
            .from(schema.calculationRunAllocations)
            .where(eq(schema.calculationRunAllocations.runId, RUN_ID))
            .orderBy(asc(schema.calculationRunAllocations.sequence))
          const realized = yield* db
            .select({
              sequence: schema.calculationRunRealizedResults.sequence,
              treatmentCodes: schema.calculationRunRealizedResults.treatmentCodes,
            })
            .from(schema.calculationRunRealizedResults)
            .where(eq(schema.calculationRunRealizedResults.runId, RUN_ID))
            .orderBy(asc(schema.calculationRunRealizedResults.sequence))
          const income = yield* db
            .select({
              sequence: schema.calculationRunIncomeResults.sequence,
              treatmentCodes: schema.calculationRunIncomeResults.treatmentCodes,
            })
            .from(schema.calculationRunIncomeResults)
            .where(eq(schema.calculationRunIncomeResults.runId, RUN_ID))
            .orderBy(asc(schema.calculationRunIncomeResults.sequence))
          const derivedLots = yield* db
            .select({
              sequence: schema.calculationRunDerivedLots.sequence,
              remainingQuantity: schema.calculationRunDerivedLots.remainingQuantity,
            })
            .from(schema.calculationRunDerivedLots)
            .where(eq(schema.calculationRunDerivedLots.runId, RUN_ID))
            .orderBy(asc(schema.calculationRunDerivedLots.sequence))
          const blockers = yield* db
            .select({
              sequence: schema.calculationRunBlockers.sequence,
              code: schema.calculationRunBlockers.code,
            })
            .from(schema.calculationRunBlockers)
            .where(eq(schema.calculationRunBlockers.runId, RUN_ID))
            .orderBy(asc(schema.calculationRunBlockers.sequence))
          const explanations = yield* db
            .select({
              sequence: schema.calculationRunExplanationEntries.sequence,
              code: schema.calculationRunExplanationEntries.code,
            })
            .from(schema.calculationRunExplanationEntries)
            .where(eq(schema.calculationRunExplanationEntries.runId, RUN_ID))
            .orderBy(asc(schema.calculationRunExplanationEntries.sequence))

          return { allocations, realized, income, derivedLots, blockers, explanations }
        })
      )

      expect(stored.allocations.map(({ sequence }) => sequence)).toEqual([0, 1])
      expect(
        stored.allocations.map(({ quantity: value }) =>
          BigDecimal.format(BigDecimal.normalize(BigDecimal.fromStringUnsafe(value)))
        )
      ).toEqual(["0.25", "0.5"])
      expect(stored.realized).toEqual([
        { sequence: 0, treatmentCodes: ["de.tax_free_holding_period"] },
        { sequence: 1, treatmentCodes: ["second.realized"] },
      ])
      expect(stored.income).toEqual([
        { sequence: 0, treatmentCodes: ["de.taxable_income_section22_3_staking"] },
        { sequence: 1, treatmentCodes: ["second.income"] },
      ])
      expect(stored.derivedLots.map(({ sequence }) => sequence)).toEqual([0, 1])
      expect(stored.blockers).toEqual([
        { sequence: 0, code: "missing_valuation" },
        { sequence: 1, code: "inventory_shortage" },
      ])
      expect(stored.explanations).toEqual([
        { sequence: 17, code: "fifo_matched" },
        { sequence: 23, code: "second.explanation" },
      ])
    })
  )

  it.effect("rejects reuse of a run ID for identical and different payloads", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture({ includeOtherPrincipal: true }))
      yield* runRepository(persistResult())

      const identicalError = yield* runRepository(Effect.flip(persistResult()))
      const differentError = yield* runRepository(
        Effect.flip(
          persistResult({
            result: { ...completeResult(), status: "partial", taxYear: TaxYear.make(2024) },
          })
        )
      )

      const otherOwnerError = yield* runRepository(
        Effect.flip(
          persistResult({
            principalId: OTHER_PRINCIPAL_ID,
            result: completeResult({
              custodyUnitId: OTHER_CUSTODY_UNIT_ID,
              custodySourceId: SourceId.make(OTHER_SOURCE_ID),
            }),
          })
        )
      )
      expect(otherOwnerError).toBeInstanceOf(CalculationRunAlreadyStoredError)
      const storedOwner = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              principalId: schema.calculationRuns.principalId,
              taxYear: schema.calculationRuns.taxYear,
            })
            .from(schema.calculationRuns)
        })
      )
      expect(storedOwner).toEqual([{ principalId: TEST_PRINCIPAL_ID, taxYear: 2025 }])
      expect(identicalError).toBeInstanceOf(CalculationRunAlreadyStoredError)
      expect(differentError).toBeInstanceOf(CalculationRunAlreadyStoredError)
    })
  )

  it.effect("lets a waiting claim succeed when the first transaction rolls back", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* runPgEffect(seedCalculationRunFixture())
        yield* runPgEffect(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.execute(
              sql.raw(`
          create function reject_test_partial_claim() returns trigger as $$
          begin
            if exists (select 1 from calculation_runs where id = new.run_id and status = 'partial') then
              perform pg_advisory_xact_lock(hashtextextended('calculation-claim-rollback-test', 0));
              raise exception 'forced partial claim rollback';
            end if;
            return new;
          end;
          $$ language plpgsql;
          create trigger reject_test_partial_claim before insert on active_calculation_runs
          for each row execute function reject_test_partial_claim();
        `)
            )
          })
        )
        yield* Effect.addFinalizer(() =>
          runPgEffect(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db.execute(
                sql`drop trigger if exists reject_test_partial_claim on active_calculation_runs`
              )
              yield* db.execute(sql`drop function if exists reject_test_partial_claim()`)
            })
          )
        )
        const held = yield* context.holdAdvisoryLock({ key: "calculation-claim-rollback-test" })
        const failed = yield* Effect.forkChild(
          runRepository(
            persistResult({
              result: {
                ...completeResult(),
                status: "partial",
                blockers: [
                  {
                    code: "missing_valuation",
                    eventId: DISPOSITION_EVENT_ID,
                    assetId: TEST_BTC_ASSET_ID,
                    custodyUnitId: TEST_CUSTODY_UNIT_ID,
                    missingQuantity: null,
                  },
                ],
              },
            })
          ).pipe(Effect.result)
        )
        yield* Effect.promise(() =>
          context.waitForQueryBlockedOnLock({
            queryIncludes: 'insert into "active_calculation_runs"',
          })
        )
        const waiting = yield* Effect.forkChild(runRepository(persistResult()))
        yield* waitForCalculationRunLockWaiter()
        yield* held.release
        expect(yield* Fiber.join(failed)).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "PersistenceError" },
        })
        expect(yield* Fiber.join(waiting)).toMatchObject({ status: "complete", activated: true })
        const stored = yield* runPgEffect(
          Effect.gen(function* () {
            const db = yield* drizzle
            const runs = yield* db
              .select({ id: schema.calculationRuns.id, status: schema.calculationRuns.status })
              .from(schema.calculationRuns)
            const active = yield* db
              .select({ runId: schema.activeCalculationRuns.runId })
              .from(schema.activeCalculationRuns)
            const blockers = yield* db
              .select({ runId: schema.calculationRunBlockers.runId })
              .from(schema.calculationRunBlockers)
            const realized = yield* db
              .select({ runId: schema.calculationRunRealizedResults.runId })
              .from(schema.calculationRunRealizedResults)
            return { runs, active, blockers, realized }
          })
        )
        expect(stored).toEqual({
          runs: [{ id: RUN_ID, status: "complete" }],
          active: [{ runId: RUN_ID }],
          blockers: [],
          realized: [{ runId: RUN_ID }],
        })
      })
    )
  )

  it.effect("classifies concurrent starts of the same run ID as single-use", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture({ includeOtherPrincipal: true }))
      const result = completeResult()
      for (let round = 0; round < 100; round++) {
        const id = CalculationRunId.make(
          `00000000-0000-4000-8000-${String(1000 + round).padStart(12, "0")}`
        )
        const outcomes = yield* runRepository(
          Effect.gen(function* () {
            const repository = yield* CalculationRunRepository
            const start = (
              overrides: { readonly principalId?: PrincipalId; readonly taxYear?: TaxYear } = {}
            ) =>
              repository
                .start({
                  id,
                  principalId: overrides.principalId ?? TEST_PRINCIPAL_ID,
                  reportingCurrency: EUR,
                  jurisdiction: result.jurisdiction,
                  taxYear: overrides.taxYear ?? result.taxYear,
                  engineVersion: result.engineVersion,
                  ruleSetVersion: result.ruleSetVersion,
                  inputLedgerRevision: InputLedgerRevision.make(`v2:801:1.2.:${"a".repeat(64)}`),
                  valuationRevision: ValuationRevision.make(`sha256:${"b".repeat(64)}`),
                  custodyUnitMembership: [
                    {
                      custodyUnitId: TEST_CUSTODY_UNIT_ID,
                      sourceId: SourceId.make(TEST_SOURCE_ID),
                    },
                  ],
                  correctionInputs: [],
                  syncCapture: { requestIds: [] },
                })
                .pipe(
                  Effect.match({
                    onFailure: (error) => error._tag,
                    onSuccess: () => "success" as const,
                  })
                )
            const outcomes = yield* Effect.all([start(), start()], { concurrency: 2 })
            if (round === 0) {
              expect(yield* start({ principalId: OTHER_PRINCIPAL_ID })).toBe(
                "CalculationRunAlreadyStoredError"
              )
              expect(yield* start({ taxYear: TaxYear.make(2024) })).toBe(
                "CalculationRunAlreadyStoredError"
              )
            }
            return outcomes
          })
        )
        expect([...outcomes].sort()).toEqual(["CalculationRunAlreadyStoredError", "success"])
      }
      const stored = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          const runs = yield* db
            .select({
              status: schema.calculationRuns.status,
              taxYear: schema.calculationRuns.taxYear,
              principalId: schema.calculationRuns.principalId,
            })
            .from(schema.calculationRuns)
          const memberships = yield* db
            .select({
              runId: schema.calculationRunCustodyUnitSources.runId,
              sourceId: schema.calculationRunCustodyUnitSources.sourceId,
            })
            .from(schema.calculationRunCustodyUnitSources)
          const captures = yield* db
            .select({
              runId: schema.calculationRunSyncCaptures.runId,
              principalId: schema.calculationRunSyncCaptures.principalId,
            })
            .from(schema.calculationRunSyncCaptures)
          return { runs, memberships, captures }
        })
      )
      expect(stored.runs).toHaveLength(100)
      expect(
        stored.runs.every(
          ({ status, principalId, taxYear }) =>
            status === "running" && principalId === TEST_PRINCIPAL_ID && taxYear === 2025
        )
      ).toBe(true)
      expect(stored.memberships).toHaveLength(100)
      expect(new Set(stored.memberships.map(({ runId }) => runId)).size).toBe(100)
      expect(stored.memberships.every(({ sourceId }) => sourceId === TEST_SOURCE_ID)).toBe(true)
      expect(stored.captures).toHaveLength(100)
      expect(stored.captures.every(({ principalId }) => principalId === TEST_PRINCIPAL_ID)).toBe(
        true
      )
    })
  )

  it.effect("classifies concurrent claims of the same run ID as single-use", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())
      // Repeat fresh claims: the speculative-index race needs both inserts
      // to pass their initial uniqueness check before either finishes.
      for (let round = 0; round < 100; round++) {
        const id = CalculationRunId.make(
          `00000000-0000-4000-8000-${String(1000 + round).padStart(12, "0")}`
        )
        const outcomes = yield* runRepository(
          Effect.all(
            [persistResult({ id }), persistResult({ id })].map((write) =>
              Effect.match(write, {
                onFailure: (error) => error._tag,
                onSuccess: () => "success" as const,
              })
            ),
            { concurrency: 2 }
          )
        )
        expect([...outcomes].sort()).toEqual(["CalculationRunAlreadyStoredError", "success"])
      }
      const stored = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          const runs = yield* db
            .select({ status: schema.calculationRuns.status })
            .from(schema.calculationRuns)
          const realized = yield* db
            .select({
              runId: schema.calculationRunRealizedResults.runId,
              quantity: schema.calculationRunRealizedResults.quantity,
              gainLoss: schema.calculationRunRealizedResults.gainLoss,
            })
            .from(schema.calculationRunRealizedResults)
          return { runs, realized }
        })
      )
      expect(stored.runs).toHaveLength(100)
      expect(stored.runs.every(({ status }) => status === "complete")).toBe(true)
      expect(stored.realized).toHaveLength(100)
      expect(new Set(stored.realized.map(({ runId }) => runId)).size).toBe(100)
      expect(
        stored.realized.every(
          ({ quantity: value, gainLoss }) =>
            BigDecimal.equals(
              BigDecimal.fromStringUnsafe(value),
              BigDecimal.fromStringUnsafe("0.25")
            ) &&
            BigDecimal.equals(
              BigDecimal.fromStringUnsafe(gainLoss),
              BigDecimal.fromStringUnsafe("5000")
            )
        )
      ).toBe(true)
    })
  )

  it.effect("rolls back every monetary field that differs from the reporting currency", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())

      for (const { field, result } of currencyMismatchCases()) {
        const error = yield* runRepository(Effect.flip(persistResult({ result })))
        expect(error, field).toBeInstanceOf(CalculationRunCurrencyMismatchError)
      }

      const stored = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          const runs = yield* db
            .select({ id: schema.calculationRuns.id })
            .from(schema.calculationRuns)
            .where(eq(schema.calculationRuns.id, RUN_ID))
          const active = yield* db
            .select({ runId: schema.activeCalculationRuns.runId })
            .from(schema.activeCalculationRuns)

          return { runs, active }
        })
      )

      expect(stored).toEqual({ runs: [], active: [] })
    })
  )

  it.effect(
    "rolls back missing and cross-principal custody snapshots without moving the pointer",
    () =>
      Effect.gen(function* () {
        yield* runPgEffect(seedCalculationRunFixture({ includeOtherPrincipal: true }))
        yield* runRepository(persistResult())

        const missingError = yield* runRepository(
          Effect.flip(
            persistResult({
              id: SECOND_RUN_ID,
              result: completeResult({ custodyUnitId: MISSING_CUSTODY_UNIT_ID }),
            })
          )
        )
        const crossPrincipalError = yield* runRepository(
          Effect.flip(
            persistResult({
              id: THIRD_RUN_ID,
              result: completeResult({ custodyUnitId: OTHER_CUSTODY_UNIT_ID }),
            })
          )
        )

        expect(missingError).toBeInstanceOf(PersistenceError)
        expect(crossPrincipalError).toBeInstanceOf(PersistenceError)

        const stored = yield* runPgEffect(
          Effect.gen(function* () {
            const db = yield* drizzle
            const runs = yield* db
              .select({ id: schema.calculationRuns.id })
              .from(schema.calculationRuns)
              .orderBy(asc(schema.calculationRuns.id))
            const active = yield* db
              .select({ runId: schema.activeCalculationRuns.runId })
              .from(schema.activeCalculationRuns)
            const realized = yield* db
              .select({ runId: schema.calculationRunRealizedResults.runId })
              .from(schema.calculationRunRealizedResults)

            return { runs, active, realized }
          })
        )

        expect(stored).toEqual({
          runs: [{ id: RUN_ID }],
          active: [{ runId: RUN_ID }],
          realized: [{ runId: RUN_ID }],
        })
      })
  )

  it.effect("moves the active pointer to a later run without changing historical rows", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())
      yield* runRepository(persistResult())
      yield* runRepository(
        persistResult({
          id: SECOND_RUN_ID,
          result: {
            ...completeResult(),
            status: "partial",
            blockers: [
              {
                code: "missing_valuation",
                eventId: DISPOSITION_EVENT_ID,
                assetId: TEST_BTC_ASSET_ID,
                custodyUnitId: TEST_CUSTODY_UNIT_ID,
                missingQuantity: null,
              },
            ],
          },
        })
      )

      const stored = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          const runs = yield* db
            .select({ id: schema.calculationRuns.id, status: schema.calculationRuns.status })
            .from(schema.calculationRuns)
            .orderBy(asc(schema.calculationRuns.id))
          const [active] = yield* db
            .select({ runId: schema.activeCalculationRuns.runId })
            .from(schema.activeCalculationRuns)
          const realized = yield* db
            .select({ runId: schema.calculationRunRealizedResults.runId })
            .from(schema.calculationRunRealizedResults)
            .orderBy(asc(schema.calculationRunRealizedResults.runId))
          const blockers = yield* db
            .select({ runId: schema.calculationRunBlockers.runId })
            .from(schema.calculationRunBlockers)

          return { runs, active, realized, blockers }
        })
      )

      expect(stored).toEqual({
        runs: [
          { id: RUN_ID, status: "complete" },
          { id: SECOND_RUN_ID, status: "partial" },
        ],
        active: { runId: SECOND_RUN_ID },
        realized: [{ runId: RUN_ID }, { runId: SECOND_RUN_ID }],
        blockers: [{ runId: SECOND_RUN_ID }],
      })
    })
  )

  it.effect("keeps a concurrently delayed older run durable but inactive", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture({ includeOtherPrincipal: true }))
      yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.execute(
            sql.raw(`
              create function pause_test_older_run() returns trigger as $$
              begin
                if new.id = '${RUN_ID}' then
                  perform 1
                  from principals
                  where id = '${OTHER_PRINCIPAL_ID}'
                  for update;
                end if;
                return new;
              end;
              $$ language plpgsql
            `)
          )
          yield* db.execute(
            sql.raw(`
              create trigger pause_test_older_run
              before insert on calculation_runs
              for each row execute function pause_test_older_run()
            `)
          )
        })
      )
      const lockAcquired = yield* Deferred.make<void>()
      const releaseLock = yield* Deferred.make<void>()
      const heldLock = runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .select({ id: schema.principals.id })
                .from(schema.principals)
                .where(eq(schema.principals.id, OTHER_PRINCIPAL_ID))
                .for("update")
              yield* Deferred.succeed(lockAcquired, undefined)
              yield* Deferred.await(releaseLock)
            })
          )
        })
      )

      yield* Deferred.await(lockAcquired)
      const { newer, older } = yield* Effect.gen(function* () {
        const olderRun = yield* Effect.forkChild(
          runRepository(persistResult({ id: RUN_ID, inputSequence: "10" }))
        )
        yield* waitForCalculationRunLockWaiter()
        const newer = yield* runRepository(
          persistResult({ id: SECOND_RUN_ID, inputSequence: "20" })
        )
        yield* Deferred.succeed(releaseLock, undefined)
        const older = yield* Fiber.join(olderRun)

        return { newer, older }
      }).pipe(Effect.ensuring(Deferred.succeed(releaseLock, undefined)))
      yield* Effect.promise(() => heldLock)
      yield* removeCalculationRunTestTriggers()

      const stored = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          const runs = yield* db
            .select({ id: schema.calculationRuns.id })
            .from(schema.calculationRuns)
            .orderBy(asc(schema.calculationRuns.id))
          const [active] = yield* db
            .select({ runId: schema.activeCalculationRuns.runId })
            .from(schema.activeCalculationRuns)

          return { runs, active }
        })
      )

      expect(newer.activated).toBe(true)
      expect(older.activated).toBe(false)
      expect(stored).toEqual({
        runs: [{ id: RUN_ID }, { id: SECOND_RUN_ID }],
        active: { runId: SECOND_RUN_ID },
      })
    })
  )

  it.effect("keeps active pointers isolated across tax-year and principal scopes", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture({ includeOtherPrincipal: true }))

      yield* runRepository(persistResult())
      yield* runRepository(
        persistResult({ id: SECOND_RUN_ID, result: completeResult({ taxYear: 2024 }) })
      )
      yield* runRepository(
        persistResult({
          id: THIRD_RUN_ID,
          principalId: OTHER_PRINCIPAL_ID,
          result: completeResult({
            custodyUnitId: OTHER_CUSTODY_UNIT_ID,
            custodySourceId: SourceId.make(OTHER_SOURCE_ID),
          }),
        })
      )
      yield* runRepository(
        persistResult({
          id: FIFTH_RUN_ID,
          result: completeResult({ jurisdiction: "US" }),
        })
      )
      yield* runRepository(
        persistResult({
          id: SIXTH_RUN_ID,
          reportingCurrency: USD,
          result: completeResult({ currency: "USD" }),
        })
      )

      const germanEurTaxYears = yield* runRepository(
        Effect.flatMap(CalculationRunRepository, (repository) =>
          repository.listActiveTaxYears({
            principalId: PrincipalId.make(TEST_PRINCIPAL_ID),
            jurisdiction: JurisdictionCode.make("DE"),
            reportingCurrency: EUR,
          })
        )
      )

      expect(germanEurTaxYears).toEqual([TaxYear.make(2024), TaxYear.make(2025)])

      const active = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              principalId: schema.activeCalculationRuns.principalId,
              jurisdiction: schema.activeCalculationRuns.jurisdiction,
              taxYear: schema.activeCalculationRuns.taxYear,
              reportingCurrency: schema.activeCalculationRuns.reportingCurrency,
              runId: schema.activeCalculationRuns.runId,
            })
            .from(schema.activeCalculationRuns)
            .orderBy(
              asc(schema.activeCalculationRuns.principalId),
              asc(schema.activeCalculationRuns.jurisdiction),
              asc(schema.activeCalculationRuns.taxYear),
              asc(schema.activeCalculationRuns.reportingCurrency)
            )
        })
      )

      expect(active).toEqual([
        {
          principalId: TEST_PRINCIPAL_ID,
          jurisdiction: "DE",
          taxYear: 2024,
          reportingCurrency: "EUR",
          runId: SECOND_RUN_ID,
        },
        {
          principalId: TEST_PRINCIPAL_ID,
          jurisdiction: "DE",
          taxYear: 2025,
          reportingCurrency: "EUR",
          runId: RUN_ID,
        },
        {
          principalId: TEST_PRINCIPAL_ID,
          jurisdiction: "DE",
          taxYear: 2025,
          reportingCurrency: "USD",
          runId: SIXTH_RUN_ID,
        },
        {
          principalId: TEST_PRINCIPAL_ID,
          jurisdiction: "US",
          taxYear: 2025,
          reportingCurrency: "EUR",
          runId: FIFTH_RUN_ID,
        },
        {
          principalId: OTHER_PRINCIPAL_ID,
          jurisdiction: "DE",
          taxYear: 2025,
          reportingCurrency: "EUR",
          runId: THIRD_RUN_ID,
        },
      ])
    })
  )

  it.effect("keeps a run's custody membership unchanged after live source regrouping", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())
      yield* runRepository(persistResult())

      const snapshots = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.insert(schema.custodyUnits).values({
            id: GROUPED_CUSTODY_UNIT_ID,
            principalId: TEST_PRINCIPAL_ID,
          })
          yield* db
            .update(schema.custodyUnitSources)
            .set({ custodyUnitId: GROUPED_CUSTODY_UNIT_ID })
            .where(eq(schema.custodyUnitSources.sourceId, TEST_SOURCE_ID))

          return yield* readLiveAndStoredMembership()
        })
      )

      expect(snapshots).toEqual({
        live: { custodyUnitId: GROUPED_CUSTODY_UNIT_ID },
        snapshot: { custodyUnitId: TEST_SOURCE_ID, sourceId: TEST_SOURCE_ID },
      })
    })
  )

  it.effect("stores committed membership while a concurrent regroup is uncommitted", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())
      const regroupReady = yield* Deferred.make<void>()
      const releaseRegroup = yield* Deferred.make<void>()
      const heldRegroup = runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.insert(schema.custodyUnits).values({
                id: GROUPED_CUSTODY_UNIT_ID,
                principalId: TEST_PRINCIPAL_ID,
              })
              yield* tx
                .update(schema.custodyUnitSources)
                .set({ custodyUnitId: GROUPED_CUSTODY_UNIT_ID })
                .where(eq(schema.custodyUnitSources.sourceId, TEST_SOURCE_ID))
              yield* Deferred.succeed(regroupReady, undefined)
              yield* Deferred.await(releaseRegroup)
            })
          )
        })
      )

      yield* Deferred.await(regroupReady)
      yield* runRepository(persistResult()).pipe(
        Effect.ensuring(Deferred.succeed(releaseRegroup, undefined))
      )
      yield* Effect.promise(() => heldRegroup)

      const snapshots = yield* runPgEffect(readLiveAndStoredMembership())

      expect(snapshots).toEqual({
        live: { custodyUnitId: GROUPED_CUSTODY_UNIT_ID },
        snapshot: { custodyUnitId: TEST_SOURCE_ID, sourceId: TEST_SOURCE_ID },
      })
    })
  )

  it.effect("rolls back movement captures and results when finalization fails", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())
      yield* runPgEffect(
        seedAcquisitionFact({
          eventId: ACQUISITION_EVENT_ID,
          externalId: "capture-rollback",
          providerFiatAmount: "20",
        })
      )
      yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.execute(
            sql.raw(`
          create or replace function reject_capture_finalization() returns trigger as $$
          begin raise exception 'forced capture finalization failure'; end;
          $$ language plpgsql;
          create trigger reject_capture_finalization before insert or update on active_calculation_runs
          for each row execute function reject_capture_finalization();
        `)
          )
        })
      )
      yield* runCalculationService(Effect.flip(recomputeResult({ id: FOURTH_RUN_ID })))
      const stored = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          const captures = yield* db
            .select({ runId: schema.calculationRunMovementInputs.runId })
            .from(schema.calculationRunMovementInputs)
          const lots = yield* db
            .select({ runId: schema.calculationRunDerivedLots.runId })
            .from(schema.calculationRunDerivedLots)
          const results = yield* db
            .select({ runId: schema.calculationRunRealizedResults.runId })
            .from(schema.calculationRunRealizedResults)
          return { captures, lots, results }
        })
      )
      expect(stored).toEqual({ captures: [], lots: [], results: [] })
      expect((yield* readRunSettlement(FOURTH_RUN_ID)).run?.status).toBe("failed")
      yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.execute(
            sql`drop trigger reject_capture_finalization on active_calculation_runs`
          )
        })
      )
    })
  )

  it.effect("rolls back result rows when the final pointer write fails", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())
      yield* runRepository(persistResult())

      yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.execute(
            sql.raw(`
            create function reject_test_calculation_pointer() returns trigger as $$
            begin
              if new.run_id = '${FOURTH_RUN_ID}' then
                raise exception 'forced active pointer failure';
              end if;
              return new;
            end;
            $$ language plpgsql
          `)
          )
          yield* db.execute(
            sql.raw(`
            create trigger reject_test_calculation_pointer
            before insert or update on active_calculation_runs
            for each row execute function reject_test_calculation_pointer()
          `)
          )
        })
      )

      const error = yield* runRepository(Effect.flip(persistResult({ id: FOURTH_RUN_ID })))
      expect(error).toBeInstanceOf(PersistenceError)

      const stored = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          const runs = yield* db
            .select({ id: schema.calculationRuns.id })
            .from(schema.calculationRuns)
          const active = yield* db
            .select({ runId: schema.activeCalculationRuns.runId })
            .from(schema.activeCalculationRuns)
          const realized = yield* db
            .select({ runId: schema.calculationRunRealizedResults.runId })
            .from(schema.calculationRunRealizedResults)

          return { runs, active, realized }
        })
      )

      expect(stored).toEqual({
        runs: [{ id: RUN_ID }],
        active: [{ runId: RUN_ID }],
        realized: [{ runId: RUN_ID }],
      })
    })
  )
})
