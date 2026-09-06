import * as DateTime from "effect/DateTime"
import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Latch from "effect/Latch"
import * as Fiber from "effect/Fiber"
import * as BigDecimal from "effect/BigDecimal"
import { PrincipalId } from "@my/core/ownership"
import { AuthUserId } from "@my/core/authentication"
import { EUR } from "@my/core/currency"
import { JurisdictionCode, TaxYear } from "@my/core/accounting"
import { PrincipalTransactionOverrideRepository } from "../../../persistence/src/services/PrincipalTransactionOverrideRepository.ts"
import { FactualLedgerRepository } from "../../../persistence/src/services/FactualLedgerRepository.ts"
import { CalculationRunService } from "../../../persistence/src/services/CalculationRunService.ts"
import { CalculationRunId } from "../../../persistence/src/services/CalculationRunRepository.ts"
import { CalculationRunServiceLive } from "../../../persistence/src/layers/CalculationRunServiceLive.ts"
import { CalculationRunRepositoryLive } from "../../../persistence/src/layers/CalculationRunRepositoryLive.ts"
import { FactualLedgerRepositoryLive } from "../../../persistence/src/layers/FactualLedgerRepositoryLive.ts"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { SourceSyncServiceLive, TransferReconciliationServiceLive } from "@my/sync-engine/layers"
import { SourceSyncJobExecutorLive } from "../../src/layers/SourceSyncJobExecutorLive.ts"
import { SourceProviderRegistryLive } from "../../src/layers/SourceProviderRegistryLive.ts"
import { HeliusSolanaSourceSyncProviderLive } from "../../src/providers/helius-solana/layers/HeliusSolanaSourceSyncProviderLive.ts"
import { CoinbaseLegDerivationServiceLive } from "../../src/providers/coinbase/layers/CoinbaseLegDerivationServiceLive.ts"
import { CoinbaseRecordNormalizerLive } from "../../src/providers/coinbase/layers/CoinbaseRecordNormalizerLive.ts"
import { CoinbaseReferenceDataServiceLive } from "../../src/providers/coinbase/layers/CoinbaseReferenceDataServiceLive.ts"
import { CoinbaseReferenceMappingServiceLive } from "../../src/providers/coinbase/layers/CoinbaseReferenceMappingServiceLive.ts"
import { CoinbaseSourceSyncProviderLive } from "../../src/providers/coinbase/layers/CoinbaseSourceSyncProviderLive.ts"
import { CoinbaseSyncClient } from "../../src/providers/coinbase/services/CoinbaseSyncClient.ts"
import {
  SourceSyncService,
  SourceSyncJobExecutor,
  SourceProviderRegistry,
  SourceRawRecordRepository,
} from "@my/sync-engine/services"
import { AssetRepositoryLive } from "../../../persistence/src/layers/AssetRepositoryLive.ts"
import { ProviderAssetRepositoryLive } from "../../../persistence/src/layers/ProviderAssetRepositoryLive.ts"
import { ProviderReferenceRepositoryLive } from "../../../persistence/src/layers/ProviderReferenceRepositoryLive.ts"
import { RepositoriesLive } from "../../../persistence/src/layers/RepositoriesLive.ts"
import { drizzle } from "../../../persistence/src/layers/PgClientLive.ts"
import { schema } from "../../../persistence/src/schema/index.ts"
import {
  makeIntegrationTestDatabaseContext,
  seedSyncEngineRepositoryFixture,
} from "../../../persistence/tests/support/integration-test-kit.ts"
import {
  ProviderRawRecord,
  SourceSyncProviderFailureError,
} from "../../src/shared/SourceProviderRawBatch.ts"
import { SourceSyncQueueInlineExecutorTestLive } from "../support/SourceSyncQueueInlineExecutorTestLive.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_sync_engine_coinbase_replay_pr04",
})
const TestPgClientLive = context.TestPgClientLive

const userId = "00000000-0000-4000-8000-000000000151"
const principalId = "00000000-0000-4000-8000-000000000152"
const sourceId = "00000000-0000-4000-8000-000000000251"
const TAO_ASSET_ID = "00000000-0000-0000-0000-000000000551"
const PROOF_BTC_ASSET_ID = "00000000-0000-4000-8000-000000000551"

const makeCoinbaseRecord = ({
  externalRecordId,
  occurredAt,
  payload,
  recordType = "coinbase_transaction",
}: {
  readonly externalRecordId: string
  readonly occurredAt: Date
  readonly payload: unknown
  readonly recordType?: "coinbase_account" | "coinbase_transaction"
}): ProviderRawRecord =>
  ProviderRawRecord.make({
    providerKey: "coinbase",
    recordType,
    externalRecordId,
    externalAccountId: "coinbase-account-1",
    externalParentId: null,
    occurredAt,
    payload,
  })

const initialSyncRecords = [
  makeCoinbaseRecord({
    recordType: "coinbase_account",
    externalRecordId: "coinbase-account-1",
    occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
    payload: {
      id: "coinbase-account-1",
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-01T00:00:00.000Z",
    },
  }),
  makeCoinbaseRecord({
    externalRecordId: "tx-tao-receive-1",
    occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T12:00:00.000Z")),
    payload: {
      id: "tx-tao-receive-1",
      type: "receive",
      status: "completed",
      amount: { amount: "2.50000000", currency: "TAO" },
      native_amount: { amount: "900.00", currency: "EUR" },
      created_at: "2025-01-02T12:00:00.000Z",
      resource_path: "/v2/accounts/coinbase-account-1/transactions/tx-tao-receive-1",
      description: "TAO receive",
    },
  }),
] as const

let providerFetchCount = 0
let correctionProof = false
const correctionRecords = [
  ...initialSyncRecords.filter((record) => record.recordType === "coinbase_account"),
  ...(["buy", "sell"] as const).map((kind) =>
    makeCoinbaseRecord({
      externalRecordId: `correction-${kind}`,
      occurredAt: DateTime.toDateUtc(
        DateTime.makeUnsafe(kind === "buy" ? "2025-01-02T12:00:00Z" : "2025-02-02T12:00:00Z")
      ),
      payload: {
        id: `correction-${kind}`,
        type: kind,
        status: "completed",
        amount: { amount: kind === "buy" ? "10" : "-10", currency: "BTC" },
        native_amount: { amount: kind === "buy" ? "1" : "30", currency: "EUR" },
        created_at: kind === "buy" ? "2025-01-02T12:00:00Z" : "2025-02-02T12:00:00Z",
        resource_path: `/v2/accounts/coinbase-account-1/transactions/correction-${kind}`,
      },
    })
  ),
]
const syncRecords = () => (correctionProof ? correctionRecords : initialSyncRecords)

const CoinbaseSyncClientTestLive = Layer.succeed(CoinbaseSyncClient, {
  fetchAccountsPage: () =>
    Effect.sync(() => ({
      records:
        providerFetchCount === 0
          ? syncRecords()
              .filter((record) => record.recordType === "coinbase_account")
              .map((record) => ({
                id: record.externalRecordId,
                occurredAt: record.occurredAt,
                payload: record.payload,
              }))
          : [],
      nextCursor: null,
    })),
  fetchTransactionsPage: ({ accountId }) =>
    Effect.sync(() => {
      const records =
        providerFetchCount === 0
          ? syncRecords()
              .filter((record) => record.recordType === "coinbase_transaction")
              .map((record) => ({
                id: record.externalRecordId,
                accountId: record.externalAccountId ?? accountId,
                parentId: record.externalParentId,
                occurredAt: record.occurredAt,
                payload: record.payload,
              }))
          : []

      providerFetchCount += 1

      return {
        records,
        nextCursor: null,
      }
    }),
  fetchFiatCurrencies: Effect.succeed([
    {
      currencyCode: "EUR",
      name: "Euro",
      minSize: "0.01",
      payload: { id: "EUR", name: "Euro", min_size: "0.01" },
    },
  ] as const),
  fetchCryptoCurrencies: Effect.sync(() =>
    correctionProof
      ? [
          {
            currencyCode: "BTC",
            name: "Bitcoin",
            providerAssetId: "btc-provider-asset",
            exponent: 8,
            providerType: "crypto",
            payload: {
              code: "BTC",
              name: "Bitcoin",
              exponent: 8,
              type: "crypto",
              asset_id: "btc-provider-asset",
            },
          },
        ]
      : ([
          {
            currencyCode: "TAO",
            name: "Bittensor",
            providerAssetId: "tao-provider-asset",
            exponent: 8,
            providerType: "crypto",
            payload: {
              code: "TAO",
              name: "Bittensor",
              exponent: 8,
              type: "crypto",
              asset_id: "tao-provider-asset",
            },
          },
        ] as const)
  ),
})

const CoinbaseReferenceMappingWithDepsLive = CoinbaseReferenceMappingServiceLive.pipe(
  Layer.provide(ProviderAssetRepositoryLive),
  Layer.provide(ProviderReferenceRepositoryLive),
  Layer.provide(AssetRepositoryLive)
)

const CoinbaseReferenceDataWithDepsLive = CoinbaseReferenceDataServiceLive.pipe(
  Layer.provideMerge(CoinbaseSyncClientTestLive),
  Layer.provide(CoinbaseReferenceMappingWithDepsLive),
  Layer.provide(ProviderAssetRepositoryLive),
  Layer.provide(ProviderReferenceRepositoryLive)
)

const CoinbaseSourceSyncProviderWithDepsLive = CoinbaseSourceSyncProviderLive.pipe(
  Layer.provide(CoinbaseRecordNormalizerLive),
  Layer.provide(CoinbaseLegDerivationServiceLive),
  Layer.provide(CoinbaseReferenceDataWithDepsLive),
  Layer.provide(CoinbaseReferenceMappingWithDepsLive),
  Layer.provide(CoinbaseSyncClientTestLive),
  Layer.provide(AssetRepositoryLive)
)

const SourceSyncJobExecutorTestLive = SourceSyncJobExecutorLive.pipe(
  Layer.provide(TransferReconciliationServiceLive),
  Layer.provide(
    SourceProviderRegistryLive.pipe(
      Layer.provide(CoinbaseSourceSyncProviderWithDepsLive),
      Layer.provide(HeliusSolanaSourceSyncProviderLive)
    )
  ),
  Layer.provide(CoinbaseSourceSyncProviderWithDepsLive)
)

const SourceSyncLayer = SourceSyncServiceLive.pipe(
  Layer.provide(SourceSyncQueueInlineExecutorTestLive),
  Layer.provide(SourceSyncJobExecutorTestLive)
)

const TestLayer = SourceSyncLayer.pipe(
  Layer.provideMerge(CoinbaseSourceSyncProviderWithDepsLive),
  Layer.provideMerge(RepositoriesLive),
  Layer.provideMerge(TestPgClientLive)
)

const seedCoinbaseSource = () =>
  seedSyncEngineRepositoryFixture({ userId, principalId, sourceId }).pipe(
    Effect.asVoid,
    Effect.provide(TestPgClientLive)
  )

const insertTaoAsset = () =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db.insert(schema.assets).values({
      id: TAO_ASSET_ID,
      name: "Bittensor",
      symbol: "TAO",
      coingeckoCoinId: "bittensor",
      type: "fungible",
    })
  }).pipe(Effect.provide(TestPgClientLive))

const runSync = () =>
  Effect.gen(function* () {
    const sourceSync = yield* SourceSyncService
    return yield* sourceSync.startSourceSyncJob({
      principalId,
      sourceId,
    })
  }).pipe(Effect.provide(TestLayer))

const fetchReplayState = () =>
  Effect.gen(function* () {
    const db = yield* drizzle

    const rawRows = yield* db
      .select({
        externalRecordId: schema.sourceRecordsRaw.externalRecordId,
        normalizedAt: schema.sourceRecordsRaw.normalizedAt,
        normalizationError: schema.sourceRecordsRaw.normalizationError,
      })
      .from(schema.sourceRecordsRaw)
      .where(eq(schema.sourceRecordsRaw.sourceId, sourceId))

    const transactions = yield* db
      .select({
        externalId: schema.transactions.externalId,
        transactionType: schema.transactions.transactionType,
      })
      .from(schema.transactions)
      .where(eq(schema.transactions.sourceId, sourceId))

    const legs = yield* db
      .select({
        externalId: schema.transactionLegs.externalId,
        kind: schema.transactionLegs.kind,
      })
      .from(schema.transactionLegs)
      .where(eq(schema.transactionLegs.sourceId, sourceId))

    const [taoMapping] = yield* db
      .select({
        mappingStatus: schema.providerAssetMappings.mappingStatus,
        assetRepresentationId: schema.providerAssetMappings.assetRepresentationId,
        canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
      })
      .from(schema.providerAssetMappings)
      .innerJoin(
        schema.providerAssets,
        eq(schema.providerAssetMappings.providerAssetRowId, schema.providerAssets.id)
      )
      .where(eq(schema.providerAssets.currencyCode, "TAO"))
      .limit(1)

    return {
      rawRows,
      transactions,
      legs,
      taoMapping,
    }
  }).pipe(Effect.provide(TestPgClientLive))

await Effect.runPromise(context.recreateTestDatabase())

describe("coinbase reference-data replay", () => {
  beforeEach(() =>
    Effect.gen(function* () {
      providerFetchCount = 0
      correctionProof = false
      yield* context.recreateTestDatabase()
      yield* seedCoinbaseSource()
    }).pipe(Effect.runPromise)
  )

  it.effect("keeps missing Coinbase asset bindings reviewable until explicitly approved", () =>
    Effect.asVoid(
      Effect.gen(function* () {
        yield* runSync()
        const firstRun = yield* fetchReplayState()

        expect(firstRun.rawRows).toHaveLength(2)
        expect(
          firstRun.rawRows.find((row) => row.externalRecordId === "tx-tao-receive-1")?.normalizedAt
        ).not.toBeNull()
        expect(
          firstRun.rawRows.find((row) => row.externalRecordId === "tx-tao-receive-1")
            ?.normalizationError
        ).toBeNull()
        expect(firstRun.transactions).toEqual([
          {
            externalId: "tx-tao-receive-1",
            transactionType: "internal_transfer",
          },
        ])
        expect(firstRun.legs).toHaveLength(0)
        expect(firstRun.taoMapping?.mappingStatus).toBe("pending_review")
        expect(firstRun.taoMapping?.assetRepresentationId).toBeNull()

        yield* insertTaoAsset()
        yield* runSync()
        const secondRun = yield* fetchReplayState()

        expect(
          secondRun.rawRows.find((row) => row.externalRecordId === "tx-tao-receive-1")?.normalizedAt
        ).not.toBeNull()
        expect(
          secondRun.rawRows.find((row) => row.externalRecordId === "tx-tao-receive-1")
            ?.normalizationError
        ).toBeNull()
        expect(secondRun.transactions).toEqual([
          {
            externalId: "tx-tao-receive-1",
            transactionType: "internal_transfer",
          },
        ])
        expect(secondRun.legs).toHaveLength(0)
        expect(secondRun.taoMapping?.mappingStatus).toBe("pending_review")
        expect(secondRun.taoMapping?.canonicalAssetId).toBeNull()
      })
    )
  )
})

const proofRepositories = RepositoriesLive.pipe(Layer.provideMerge(TestPgClientLive))
const value = (amount: string | null | undefined) =>
  amount == null ? null : BigDecimal.format(BigDecimal.fromStringUnsafe(amount))
const proofRunId = (index: number) =>
  CalculationRunId.make(`00000000-0000-4000-8000-${String(9800 + index).padStart(12, "0")}`)

const acceptProofPrice = (targetId: string, amount: string) =>
  Effect.gen(function* () {
    const repository = yield* PrincipalTransactionOverrideRepository
    const current = yield* repository.findContext({
      principalId: PrincipalId.make(principalId),
      targetId,
      reportingCurrency: EUR,
    })
    if (Option.isNone(current) || current.value.current === null)
      return yield* Effect.die("Missing Coinbase inspection")
    const input = { _tag: "price", input: { _tag: "total_value", amount, currency: EUR } } as const
    const params = {
      principalId: PrincipalId.make(principalId),
      actorUserId: AuthUserId.make(userId),
      targetId,
      reportingCurrency: EUR,
      expectedSystemRevision: current.value.current.facts.systemRevision,
      expectedLeafId: current.value.price.leaf?.id ?? null,
      reason: "Synthetic cached Coinbase evidence",
      input,
    }
    const accepted = yield* current.value.price.leaf === null
      ? repository.create(params)
      : repository.replace(params)
    if (Option.isNone(accepted)) return yield* Effect.die("Missing accepted Coinbase correction")
    return accepted.value
  }).pipe(Effect.provide(proofRepositories))

const readProof = (index: number) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    return {
      links: yield* db
        .select({
          id: schema.transactionLegs.id,
          targetId: schema.transactionLegs.movementCorrectionTargetId,
          amount: schema.transactionLegs.amount,
          kind: schema.transactionLegs.kind,
          fiat: schema.transactionLegs.fiatAmount,
        })
        .from(schema.transactionLegs)
        .where(eq(schema.transactionLegs.sourceId, sourceId))
        .orderBy(schema.transactionLegs.kind),
      history: yield* db
        .select({
          id: schema.principalTransactionOverrides.id,
          input: schema.principalTransactionOverrides.priceInput,
          quantity: schema.principalTransactionOverrides.inspectedQuantity,
          asset: schema.principalTransactionOverrides.inspectedEconomicAssetId,
          record: schema.principalTransactionOverrides.inspectedSourceRecordKey,
          component: schema.principalTransactionOverrides.inspectedComponentKey,
          revision: schema.principalTransactionOverrides.inspectedSystemRevision,
          evidence: schema.principalTransactionOverrides.inspectedValuationEvidence,
          actor: schema.principalTransactionOverrides.actorUserId,
          reason: schema.principalTransactionOverrides.reason,
          recordedAt: schema.principalTransactionOverrides.recordedAt,
          supersedes: schema.principalTransactionOverrides.supersedesOverrideId,
        })
        .from(schema.principalTransactionOverrides)
        .where(eq(schema.principalTransactionOverrides.sourceId, sourceId))
        .orderBy(schema.principalTransactionOverrides.recordedAt),
      inputs: yield* db
        .select({ captured: schema.calculationRunCorrectionInputs.captured })
        .from(schema.calculationRunCorrectionInputs)
        .where(eq(schema.calculationRunCorrectionInputs.runId, proofRunId(index))),
      blockers: yield* db
        .select({
          code: schema.calculationRunBlockers.code,
          eventId: schema.calculationRunBlockers.eventId,
        })
        .from(schema.calculationRunBlockers)
        .where(eq(schema.calculationRunBlockers.runId, proofRunId(index))),
      results: yield* db
        .select({
          basis: schema.calculationRunRealizedResults.costBasis,
          gain: schema.calculationRunRealizedResults.gainLoss,
        })
        .from(schema.calculationRunRealizedResults)
        .where(eq(schema.calculationRunRealizedResults.runId, proofRunId(index))),
      jobs: yield* db
        .select({
          id: schema.processingJobs.id,
          mode: schema.processingJobs.mode,
          status: schema.processingJobs.status,
          recordedAttemptCount: schema.processingJobs.attemptCount,
          followUpMode: schema.processingJobs.followUpMode,
          followUpJobId: schema.processingJobs.followUpJobId,
        })
        .from(schema.processingJobs)
        .where(eq(schema.processingJobs.sourceId, sourceId))
        .orderBy(schema.processingJobs.createdAt),
      raw: yield* db
        .select({
          key: schema.sourceRecordsRaw.externalRecordId,
          payload: schema.sourceRecordsRaw.payload,
        })
        .from(schema.sourceRecordsRaw)
        .where(eq(schema.sourceRecordsRaw.sourceId, sourceId))
        .orderBy(schema.sourceRecordsRaw.externalRecordId),
      applications: yield* db
        .select({
          id: schema.principalTransactionOverrideApplications.overrideId,
          jobId: schema.principalTransactionOverrideApplications.processingJobId,
        })
        .from(schema.principalTransactionOverrideApplications)
        .where(eq(schema.principalTransactionOverrideApplications.sourceId, sourceId)),
    }
  }).pipe(Effect.provide(TestPgClientLive))

const proofCalculation = (index: number, afterSnapshot: Effect.Effect<void> = Effect.void) => {
  const ledger = Layer.effect(
    FactualLedgerRepository,
    Effect.gen(function* () {
      const real = yield* FactualLedgerRepository
      return FactualLedgerRepository.of({
        load: (params) => real.load(params).pipe(Effect.tap(() => afterSnapshot)),
      })
    })
  ).pipe(Layer.provide(FactualLedgerRepositoryLive))
  return Effect.flatMap(CalculationRunService, (service) =>
    service.recompute({
      id: proofRunId(index),
      principalId: PrincipalId.make(principalId),
      jurisdiction: JurisdictionCode.make("DE"),
      taxYear: TaxYear.make(2025),
      reportingCurrency: EUR,
      accountingChoices: [],
    })
  ).pipe(
    Effect.provide(
      CalculationRunServiceLive.pipe(
        Layer.provide(ledger),
        Layer.provide(CalculationRunRepositoryLive),
        Layer.provide(TestPgClientLive)
      )
    )
  )
}

const proofExecutor = ({
  afterRawRows,
  beforeNormalizer,
}: {
  readonly afterRawRows: Effect.Effect<void>
  readonly beforeNormalizer: Effect.Effect<void, SourceSyncProviderFailureError>
}) => {
  const registry = Layer.effect(
    SourceProviderRegistry,
    Effect.gen(function* () {
      const real = yield* SourceProviderRegistry
      return SourceProviderRegistry.of({
        resolveProviderModule: (params) =>
          real.resolveProviderModule(params).pipe(
            Effect.map((module) => ({
              ...module,
              makeRawRecordNormalizer: beforeNormalizer.pipe(
                Effect.andThen(module.makeRawRecordNormalizer)
              ),
            }))
          ),
      })
    })
  ).pipe(
    Layer.provide(
      SourceProviderRegistryLive.pipe(
        Layer.provide(CoinbaseSourceSyncProviderWithDepsLive),
        Layer.provide(HeliusSolanaSourceSyncProviderLive)
      )
    )
  )
  const raw = Layer.effect(
    SourceRawRecordRepository,
    Effect.gen(function* () {
      const real = yield* SourceRawRecordRepository
      return SourceRawRecordRepository.of({
        ...real,
        listAllRawRowsForReplay: (params) =>
          real.listAllRawRowsForReplay(params).pipe(Effect.tap(() => afterRawRows)),
      })
    })
  ).pipe(Layer.provide(RepositoriesLive))
  return SourceSyncJobExecutorLive.pipe(
    Layer.provide(TransferReconciliationServiceLive),
    Layer.provide(registry),
    Layer.provide(raw),
    Layer.provide(RepositoriesLive),
    Layer.provide(TestPgClientLive)
  )
}

it.effect(
  "retains cached Coinbase targets and exact correction snapshots through retry and one follow-up replay",
  () =>
    Effect.gen(function* () {
      yield* context.recreateTestDatabase()
      providerFetchCount = 0
      yield* seedCoinbaseSource()
      correctionProof = true
      yield* Effect.gen(function* () {
        const db = yield* drizzle
        yield* db.insert(schema.assets).values({
          id: PROOF_BTC_ASSET_ID,
          symbol: "BTC",
          name: "Synthetic Bitcoin",
          coingeckoCoinId: "bitcoin",
          type: "fungible",
        })
      }).pipe(Effect.provide(TestPgClientLive))
      yield* runSync()
      const seedState = yield* readProof(1)
      const acquisition = seedState.links.find((leg) => leg.kind === "acquisition")
      if (acquisition === undefined)
        return yield* Effect.die("Missing normalized Coinbase acquisition")
      expect(seedState.links).toHaveLength(2)
      const accepted = yield* acceptProofPrice(acquisition.targetId, "20")
      const initialRun = yield* proofCalculation(1)
      const oldRun = yield* readProof(1)
      expect(oldRun.blockers).toEqual([])
      expect(initialRun.status).toBe("complete")
      expect(
        oldRun.results.map((row) => ({ basis: value(row.basis), gain: value(row.gain) }))
      ).toEqual([{ basis: "20", gain: "10" }])
      const failOnce = yield* Ref.make(true)
      const rawCaptured = yield* Latch.make()
      const releaseRaw = yield* Latch.make()
      const snapshotCaptured = yield* Latch.make()
      const releaseSnapshot = yield* Latch.make()
      const executorLayer = proofExecutor({
        beforeNormalizer: Effect.gen(function* () {
          if (yield* Ref.getAndSet(failOnce, false))
            return yield* new SourceSyncProviderFailureError({
              providerKey: "coinbase",
              message: "Synthetic transient replay preparation failure",
              retryable: true,
            })
        }),
        afterRawRows: rawCaptured.open.pipe(Effect.andThen(releaseRaw.await)),
      })
      const execute = (jobId: string, attemptNumber: number) =>
        Effect.flatMap(SourceSyncJobExecutor, (executor) =>
          executor.execute({
            jobId,
            workerId: "synthetic-correction-worker",
            retryPolicy: {
              attemptNumber,
              maxAttempts: 3,
              nextRetryAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00Z")),
            },
          })
        ).pipe(Effect.provide(executorLayer))
      const failed = yield* execute(accepted.processingJobId, 1).pipe(Effect.flip)
      expect(failed).toMatchObject({
        _tag: "SourceSyncJobRetryableExecutionError",
        attemptNumber: 1,
        maxAttempts: 3,
      })
      const waiting = yield* readProof(1)
      expect(waiting.jobs.find((job) => job.id === accepted.processingJobId)).toMatchObject({
        status: "pending",
        recordedAttemptCount: 1,
        followUpJobId: null,
      })
      expect(waiting.links).toEqual(oldRun.links)
      expect(waiting.history).toEqual(oldRun.history)
      const fetches = providerFetchCount
      const replay = yield* execute(accepted.processingJobId, 2).pipe(Effect.forkScoped)
      yield* rawCaptured.await
      const capturedRun = yield* proofCalculation(
        2,
        snapshotCaptured.open.pipe(Effect.andThen(releaseSnapshot.await))
      ).pipe(Effect.forkScoped)
      yield* snapshotCaptured.await
      const replacement = yield* acceptProofPrice(acquisition.targetId, "30")
      expect(replacement.processingJobId).toBe(accepted.processingJobId)
      const during = yield* readProof(1)
      expect(during.jobs).toHaveLength(2) // Initial sync plus the still-active replay.
      expect(during.jobs.find((job) => job.id === accepted.processingJobId)).toMatchObject({
        status: "processing",
        followUpMode: "replay",
        followUpJobId: null,
      })
      yield* releaseSnapshot.open
      expect((yield* Fiber.join(capturedRun)).status).toBe("complete")
      const snapshotRun = yield* readProof(2)
      expect(snapshotRun.inputs.map((row) => row.captured.history.id)).toEqual([
        accepted.overrideId,
      ])
      expect(
        snapshotRun.results.map((row) => ({ basis: value(row.basis), gain: value(row.gain) }))
      ).toEqual([{ basis: "20", gain: "10" }])
      yield* releaseRaw.open
      expect((yield* Fiber.join(replay)).status).toBe("completed")
      const completed = yield* readProof(2)
      const firstJob = completed.jobs.find((job) => job.id === accepted.processingJobId)
      if (firstJob?.followUpJobId == null) return yield* Effect.die("Missing exact follow-up job")
      expect(completed.jobs).toHaveLength(3)
      expect(completed.links.map((leg) => leg.targetId)).toEqual(
        oldRun.links.map((leg) => leg.targetId)
      )
      expect(completed.links.every((leg) => oldRun.links.every((old) => old.id !== leg.id))).toBe(
        true
      )
      expect((yield* execute(firstJob.followUpJobId, 1)).status).toBe("completed")
      const duplicate = yield* execute(firstJob.followUpJobId, 2).pipe(Effect.flip)
      expect(duplicate._tag).toBe("SourceSyncJobExecutionConflictError")
      expect((yield* proofCalculation(3)).status).toBe("complete")
      const final = yield* readProof(3)
      expect(final.jobs).toHaveLength(3)
      expect(final.jobs.every((job) => job.status === "completed")).toBe(true)
      // Successful executor calls do not rewrite the stored intermediate retry metadata.
      expect(
        final.jobs.find((job) => job.id === accepted.processingJobId)?.recordedAttemptCount
      ).toBe(1)
      expect(
        final.jobs.find((job) => job.id === firstJob.followUpJobId)?.recordedAttemptCount
      ).toBe(0)
      expect(final.applications).toHaveLength(2)
      expect(
        final.applications.every((application) => application.jobId === accepted.processingJobId)
      ).toBe(true)
      expect(
        final.results.map((row) => ({ basis: value(row.basis), gain: value(row.gain) }))
      ).toEqual([{ basis: "30", gain: "0" }])
      expect(
        final.inputs.find((row) => row.captured.history.id === replacement.overrideId)?.captured
      ).toMatchObject({
        application: "applied",
        resolvedPrice: { totalValue: "30", currency: "EUR" },
      })
      expect(final.raw).toEqual(oldRun.raw)
      expect(final.history[0]).toEqual(oldRun.history[0])
      expect(final.history.map((row) => row.id)).toEqual([
        accepted.overrideId,
        replacement.overrideId,
      ])
      expect(
        final.links.map(({ targetId, amount, kind, fiat }) => ({ targetId, amount, kind, fiat }))
      ).toEqual(
        oldRun.links.map(({ targetId, amount, kind, fiat }) => ({ targetId, amount, kind, fiat }))
      )
      expect((yield* readProof(1)).inputs).toEqual(oldRun.inputs)
      expect((yield* readProof(1)).results).toEqual(oldRun.results)
      expect((yield* readProof(2)).inputs).toEqual(snapshotRun.inputs)
      expect(providerFetchCount).toBe(fetches)
      const projection = yield* Effect.flatMap(
        PrincipalTransactionOverrideRepository,
        (repository) =>
          repository.findProjection({
            principalId: PrincipalId.make(principalId),
            targetId: acquisition.targetId,
            scope: {
              jurisdiction: JurisdictionCode.make("DE"),
              taxYear: TaxYear.make(2025),
              reportingCurrency: EUR,
            },
          })
      ).pipe(Effect.provide(proofRepositories))
      if (Option.isNone(projection)) return yield* Effect.die("Missing replay projection")
      expect(projection.value.price).toMatchObject({
        coverageStatus: "covered",
        replay: {
          processingJobId: accepted.processingJobId,
          followUpJobId: firstJob.followUpJobId,
          status: "complete",
        },
        coverage: { runId: proofRunId(3), overrideId: replacement.overrideId },
      })
    }).pipe(Effect.scoped)
)
