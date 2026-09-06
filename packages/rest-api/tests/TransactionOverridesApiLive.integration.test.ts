import { JurisdictionCode, TaxYear } from "@my/core/accounting"
import { EUR } from "@my/core/currency"
import { PrincipalId } from "@my/core/ownership"
import {
  SourceSyncJobRepository,
  type SourceSyncExecutionState,
  SourceSyncQueue,
  SourceSyncQueueError,
  SourceSyncQueuePayload,
} from "@my/sync-engine/services"
import { CalculationRunServiceLive } from "../../persistence/src/layers/CalculationRunServiceLive.ts"
import { CalculationRunRepositoryLive } from "../../persistence/src/layers/CalculationRunRepositoryLive.ts"
import { FactualLedgerRepositoryLive } from "../../persistence/src/layers/FactualLedgerRepositoryLive.ts"
import { CalculationRunService } from "../../persistence/src/services/CalculationRunService.ts"
import { CalculationRunId } from "../../persistence/src/services/CalculationRunRepository.ts"
import { prepareMovementLegFixtures } from "../../persistence/tests/support/movement-leg-fixtures.ts"
import * as BigDecimal from "effect/BigDecimal"
import * as DateTime from "effect/DateTime"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { NodeHttpServer } from "@effect/platform-node"
import {
  AuthService,
  HashedPassword,
  PasswordHasher,
  type AuthServiceShape,
} from "@my/core/authentication"
import {
  SourceSyncRunService,
  SourceSyncService,
  TransferReconciliationService,
  type SourceSyncRunServiceShape,
  type SourceSyncServiceShape,
  type TransferReconciliationServiceShape,
} from "@my/sync-engine/services"
import * as Chunk from "effect/Chunk"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { drizzle } from "../../persistence/src/layers/PgClientLive.ts"
import { RepositoriesLive } from "../../persistence/src/layers/RepositoriesLive.ts"
import { eq } from "../../persistence/src/query/index.ts"
import { schema } from "../../persistence/src/schema/index.ts"
import {
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
  TEST_BTC_ASSET_ID,
} from "../../persistence/tests/support/integration-test-kit.ts"
import { TaxMaxiApi } from "../src/definitions/TaxMaxiApi.ts"
import { AnonSessionServiceLive } from "../src/layers/AnonSessionServiceLive.ts"
import { SimpleTokenValidatorLive } from "../src/layers/AuthMiddlewareLive.ts"
import { TaxMaxiApiLive } from "../src/layers/TaxMaxiApiLive.ts"
import { makeX402PaymentValidatorTestLive } from "./support/X402PaymentValidatorTestLive.ts"
import { SIWXProofVerifierTestLive } from "./support/SIWXProofVerifierTestLive.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_rest_api_movement_overrides",
})

const TestPgClientLive = context.TestPgClientLive

const TestConfigProvider = ConfigProvider.fromEnvRecord({
  ANON_SESSION_SECRET: "test-anon-session-secret-32-bytes-long",
})

const AnonSessionServiceTestLive = AnonSessionServiceLive.pipe(
  Layer.provide(ConfigProvider.layer(TestConfigProvider))
)

const X402PaymentValidatorTestLive = makeX402PaymentValidatorTestLive({
  validPaymentHeader: "valid-test-x402-payment",
})

const SourceSyncServiceTestLive = Layer.succeed(SourceSyncService, {
  startSourceSyncJob: () =>
    Effect.die("SourceSyncService test stub: startSourceSyncJob not implemented"),
  replaySourceSyncJob: () =>
    Effect.die("SourceSyncService test stub: replaySourceSyncJob not implemented"),
  getSourceSyncJob: () =>
    Effect.die("SourceSyncService test stub: getSourceSyncJob not implemented"),
} satisfies SourceSyncServiceShape)

const SourceSyncRunServiceTestLive = Layer.succeed(SourceSyncRunService, {
  startSyncRun: () => Effect.die("SourceSyncRunService test stub: startSyncRun not implemented"),
  getSyncRun: () => Effect.die("SourceSyncRunService test stub: getSyncRun not implemented"),
} satisfies SourceSyncRunServiceShape)

const TransferReconciliationServiceTestLive = Layer.succeed(TransferReconciliationService, {
  reconcileTransferCandidates: () =>
    Effect.die(
      "TransferReconciliationService test stub: reconcileTransferCandidates not implemented"
    ),
  rollbackReconciliationsForSourceReplay: () => Effect.void,
  applyDeterministicInternalTransferCanonicalization: () =>
    Effect.die(
      "TransferReconciliationService test stub: applyDeterministicInternalTransferCanonicalization not implemented"
    ),
} satisfies TransferReconciliationServiceShape)

const AuthServiceTestLive = Layer.succeed(AuthService, {
  login: () => Effect.die("AuthService test stub: login not implemented"),
  register: () => Effect.die("AuthService test stub: register not implemented"),
  startEmailVerification: () =>
    Effect.die("AuthService test stub: startEmailVerification not implemented"),
  resendEmailVerification: () =>
    Effect.die("AuthService test stub: resendEmailVerification not implemented"),
  verifyEmail: () => Effect.die("AuthService test stub: verifyEmail not implemented"),
  startOAuthLogin: () => Effect.die("AuthService test stub: startOAuthLogin not implemented"),
  completeOAuthLogin: () => Effect.die("AuthService test stub: completeOAuthLogin not implemented"),
  startLink: () => Effect.die("AuthService test stub: startLink not implemented"),
  completeLink: () => Effect.die("AuthService test stub: completeLink not implemented"),
  logout: () => Effect.die("AuthService test stub: logout not implemented"),
  validateSession: () => Effect.die("AuthService test stub: validateSession not implemented"),
  linkIdentity: () => Effect.die("AuthService test stub: linkIdentity not implemented"),
  getEnabledProviders: Effect.succeed(Chunk.fromIterable(["local", "coinbase"] as const)),
} satisfies AuthServiceShape)

const PasswordHasherTestLive = Layer.succeed(PasswordHasher, {
  hash: () => Effect.succeed(HashedPassword.make("test-password-hash")),
  verify: () => Effect.succeed(true),
})

const PersistenceLayer = Layer.mergeAll(
  RepositoriesLive,
  SourceSyncServiceTestLive,
  SourceSyncRunServiceTestLive,
  TransferReconciliationServiceTestLive,
  AuthServiceTestLive,
  PasswordHasherTestLive
).pipe(Layer.provideMerge(TestPgClientLive))

const delivered: SourceSyncQueuePayload[] = []
let rejectDelivery = false

const SourceSyncQueueTestLive = Layer.succeed(SourceSyncQueue, {
  enqueueSourceSyncJob: (payload: SourceSyncQueuePayload) =>
    Effect.gen(function* () {
      const committedHistory = yield* Effect.tryPromise({
        try: () =>
          context.runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return yield* db
                .select({ id: schema.principalTransactionOverrides.id })
                .from(schema.principalTransactionOverrides)
            })
          ),
        catch: (cause) =>
          new SourceSyncQueueError({ operation: "test.dispatch.visibility", cause }),
      })
      expect(committedHistory.length).toBeGreaterThan(0)
      delivered.push(payload)
      if (rejectDelivery)
        return yield* new SourceSyncQueueError({
          operation: "synthetic-dispatch",
          cause: "Synthetic unavailable queue",
        })
    }),
})

const HttpLive = HttpRouter.serve(
  TaxMaxiApiLive.pipe(
    Layer.provide(SourceSyncQueueTestLive),
    Layer.provide(AnonSessionServiceTestLive),
    Layer.provide(SIWXProofVerifierTestLive),
    Layer.provide(X402PaymentValidatorTestLive),
    Layer.provide(SimpleTokenValidatorLive)
  )
).pipe(Layer.provideMerge(PersistenceLayer), Layer.provideMerge(NodeHttpServer.layerTest))

const USER_ID = "00000000-0000-4000-8000-000000009101"

const PRINCIPAL_ID = "00000000-0000-4000-8000-000000009102"

const SOURCE_ID = "00000000-0000-4000-8000-000000009103"

const OTHER_USER_ID = "00000000-0000-4000-8000-000000009104"

const OTHER_PRINCIPAL_ID = "00000000-0000-4000-8000-000000009105"

const OTHER_SOURCE_ID = "00000000-0000-4000-8000-000000009106"

const UNKNOWN_ID = "00000000-0000-4000-8000-000000009107"

const decimal = (value: string | null | undefined) =>
  value == null ? null : BigDecimal.format(BigDecimal.fromStringUnsafe(value))

const YEAR = TaxYear.make(2025)

const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T00:00:00Z"))

const fixture = Effect.gen(function* () {
  const owned = yield* seedSyncEngineRepositoryFixture({
    userId: USER_ID,
    principalId: PRINCIPAL_ID,
    sourceId: SOURCE_ID,
  })
  yield* seedSyncEngineAssets(owned)
  yield* seedSyncEngineRepositoryFixture({
    userId: OTHER_USER_ID,
    principalId: OTHER_PRINCIPAL_ID,
    sourceId: OTHER_SOURCE_ID,
  })
  const db = yield* drizzle
  const [buy, sell, empty] = yield* db
    .insert(schema.transactions)
    .values([
      {
        principalId: PRINCIPAL_ID,
        sourceId: SOURCE_ID,
        externalId: "synthetic-buy",
        transactionType: "buy_fiat",
        timestamp,
      },
      {
        principalId: PRINCIPAL_ID,
        sourceId: SOURCE_ID,
        externalId: "synthetic-sell",
        transactionType: "sell_fiat",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-01T00:00:00Z")),
        providerFiatAmount: "30",
        providerFiatCurrency: "EUR",
      },
      {
        principalId: PRINCIPAL_ID,
        sourceId: SOURCE_ID,
        externalId: "synthetic-empty",
        transactionType: null,
        timestamp,
      },
    ])
    .returning({ id: schema.transactions.id })
  if (buy === undefined || sell === undefined || empty === undefined)
    return yield* Effect.die("Missing synthetic transactions")
  const legs = yield* prepareMovementLegFixtures([
    {
      movementIdentity: { sourceRecordKey: "synthetic-buy", componentKey: "amount" },
      principalId: PRINCIPAL_ID,
      sourceId: SOURCE_ID,
      externalId: "synthetic-buy-amount",
      transactionId: buy.id,
      timestamp,
      assetId: TEST_BTC_ASSET_ID,
      amount: "10",
      kind: "acquisition",
      provenance: "deterministic",
      originKind: "none",
    },
    {
      movementIdentity: { sourceRecordKey: "synthetic-sell", componentKey: "amount" },
      principalId: PRINCIPAL_ID,
      sourceId: SOURCE_ID,
      externalId: "synthetic-sell-amount",
      transactionId: sell.id,
      timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-01T00:00:00Z")),
      assetId: TEST_BTC_ASSET_ID,
      amount: "10",
      kind: "disposal",
      provenance: "deterministic",
      originKind: "none",
    },
    {
      movementIdentity: { sourceRecordKey: "synthetic-buy", componentKey: "fee" },
      principalId: PRINCIPAL_ID,
      sourceId: SOURCE_ID,
      externalId: "synthetic-buy-fee",
      feeForTransactionId: buy.id,
      timestamp,
      assetId: TEST_BTC_ASSET_ID,
      amount: "1",
      kind: "fee",
      provenance: "deterministic",
      originKind: "none",
    },
  ])
  const [acquisition, disposal, fee] = yield* db
    .insert(schema.transactionLegs)
    .values(legs)
    .returning({
      id: schema.transactionLegs.id,
      targetId: schema.transactionLegs.movementCorrectionTargetId,
    })
  if (acquisition === undefined || disposal === undefined || fee === undefined)
    return yield* Effect.die("Missing synthetic movements")
  return { buy, sell, empty, acquisition, disposal, fee }
})

const client = (userId = USER_ID, role = "admin") =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    return yield* HttpApiClient.makeWith(TaxMaxiApi, {
      httpClient: httpClient.pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(`user_${userId}_${role}`))
      ),
    })
  })

const inspect = (targetId: string) =>
  Effect.gen(function* () {
    const api = yield* client()
    return yield* api.transactionOverrides.getTransactionOverrideCurrent({
      params: { targetId },
      query: { taxYear: YEAR },
    })
  })

const request = ({
  path,
  payload,
  userId = USER_ID,
  role = "admin",
}: {
  readonly path: string
  readonly payload?: unknown
  readonly userId?: string | null
  readonly role?: string
}) =>
  Effect.gen(function* () {
    let req =
      payload === undefined
        ? HttpClientRequest.get(path)
        : yield* HttpClientRequest.post(path).pipe(HttpClientRequest.bodyJson(payload))
    if (userId !== null) req = req.pipe(HttpClientRequest.bearerToken(`user_${userId}_${role}`))
    const response = yield* HttpClient.execute(req)
    return { status: response.status, body: yield* response.json }
  })

const priceRequest = (
  current: Awaited<Effect.Success<ReturnType<typeof inspect>>>,
  amount = "20"
) => ({
  expectedLeafId: current.context.price.leaf?.id ?? null,
  expectedSystemRevision: current.context.current?.facts.systemRevision ?? "absent",
  reason: "Synthetic purchase evidence",
  input: { _tag: "price" as const, input: { _tag: "total_value" as const, amount, currency: EUR } },
})

const counts = Effect.gen(function* () {
  const db = yield* drizzle
  return {
    history: (yield* db
      .select({ id: schema.principalTransactionOverrides.id })
      .from(schema.principalTransactionOverrides)).length,
    applications: (yield* db
      .select({ id: schema.principalTransactionOverrideApplications.overrideId })
      .from(schema.principalTransactionOverrideApplications)).length,
    jobs: (yield* db.select({ id: schema.processingJobs.id }).from(schema.processingJobs)).length,
  }
})

const runId = (index: number) =>
  CalculationRunId.make(`00000000-0000-4000-8000-${String(9200 + index).padStart(12, "0")}`)

const completeReplay = (jobId: string) =>
  Effect.gen(function* () {
    const jobs = yield* SourceSyncJobRepository
    yield* jobs.claimJob({
      jobId,
      workerId: "synthetic-api-worker",
      startedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00Z")),
    })
    const state: SourceSyncExecutionState = {
      phase: "completed",
      processedRecords: 1,
      totalRecords: 1,
      fetchedRecords: 1,
      normalizedRecords: 1,
      failedRecords: 0,
      cursorPayload: null,
      highWatermark: null,
      checkpointExternalId: null,
      checkpointRawRecordId: null,
    }
    yield* jobs.completeJob({ jobId, state })
  })

const readRun = (index: number) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    return {
      results: yield* db
        .select({
          basis: schema.calculationRunRealizedResults.costBasis,
          gain: schema.calculationRunRealizedResults.gainLoss,
        })
        .from(schema.calculationRunRealizedResults)
        .where(eq(schema.calculationRunRealizedResults.runId, runId(index))),
      inputs: yield* db
        .select({ captured: schema.calculationRunCorrectionInputs.captured })
        .from(schema.calculationRunCorrectionInputs)
        .where(eq(schema.calculationRunCorrectionInputs.runId, runId(index))),
    }
  })

const recompute = (index: number) =>
  Effect.gen(function* () {
    const service = yield* CalculationRunService
    return yield* service.recompute({
      id: runId(index),
      principalId: PrincipalId.make(PRINCIPAL_ID),
      jurisdiction: JurisdictionCode.make("DE"),
      taxYear: YEAR,
      reportingCurrency: EUR,
      accountingChoices: [],
    })
  }).pipe(
    Effect.provide(
      CalculationRunServiceLive.pipe(
        Layer.provide(Layer.merge(CalculationRunRepositoryLive, FactualLedgerRepositoryLive))
      )
    )
  )

await Effect.runPromise(context.recreateTestDatabase())
beforeEach(() => {
  delivered.length = 0
  rejectDelivery = false
  return Effect.runPromise(context.recreateTestDatabase())
})

describe("TransactionOverridesApiLive", () => {
  it.effect(
    "discovers exact owned movement and fee targets with truthful JSON and classification choices",
    () =>
      Effect.gen(function* () {
        const seeded = yield* fixture
        const api = yield* client()
        const targets = yield* api.transactionOverrides.getTransactionOverrideTargets({
          params: { transactionId: seeded.buy.id },
          query: { taxYear: YEAR },
        })
        expect(targets.targets.map((target) => target.context.targetId).sort()).toEqual(
          [seeded.acquisition.targetId, seeded.fee.targetId].sort()
        )
        const acquisition = targets.targets.find(
          (target) => target.context.targetId === seeded.acquisition.targetId
        )
        expect(decimal(acquisition?.context.current?.facts.quantity)).toBe("10")
        expect(acquisition?.scope).toEqual({
          jurisdiction: "DE",
          taxYear: 2025,
          reportingCurrency: "EUR",
        })
        expect(acquisition?.validClassificationInputs).toContainEqual({
          _tag: "inbound",
          cause: "passive_staking_reward",
        })
        expect(acquisition?.validClassificationInputs).toHaveLength(9)
        expect(
          targets.targets.find((target) => target.context.targetId === seeded.fee.targetId)
            ?.validClassificationInputs
        ).toEqual([])
        expect((yield* inspect(seeded.disposal.targetId)).validClassificationInputs).toEqual([
          { _tag: "outbound", cause: "sale" },
          { _tag: "outbound", cause: "gift" },
          { _tag: "outbound", cause: "payment" },
          { _tag: "outbound", cause: "unknown" },
        ])
        expect(
          (yield* api.transactionOverrides.getTransactionOverrideTargets({
            params: { transactionId: seeded.empty.id },
            query: { taxYear: YEAR },
          })).targets
        ).toEqual([])
        expect(
          (yield* request({
            path: `/v1/transaction-overrides/${seeded.acquisition.targetId}/current`,
          })).status
        ).toBe(400)
        expect(
          (yield* request({
            path: `/v1/transaction-overrides/${seeded.acquisition.targetId}/current?taxYear=2025`,
            userId: OTHER_USER_ID,
          })).status
        ).toBe(404)
        expect(
          (yield* request({ path: `/v1/transaction-overrides/${UNKNOWN_ID}/current?taxYear=2025` }))
            .status
        ).toBe(404)
        expect(
          (yield* request({
            path: `/v1/transaction-overrides/transactions/${seeded.buy.id}/targets?taxYear=2025`,
            userId: OTHER_USER_ID,
          })).status
        ).toBe(404)
        expect(
          (yield* request({
            path: `/v1/transaction-overrides/${seeded.acquisition.targetId}/current?taxYear=2025`,
            userId: null,
          })).status
        ).toBe(401)
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect(
    "accepts exact immutable results, dispatches only committed work, and preserves both CAS checks",
    () =>
      Effect.gen(function* () {
        const seeded = yield* fixture
        const api = yield* client()
        const initial = yield* inspect(seeded.acquisition.targetId)
        const payload = priceRequest(initial, "20.00000000000000000001")
        const accepted = yield* api.transactionOverrides.createTransactionOverride({
          params: { targetId: seeded.acquisition.targetId },
          payload,
        })
        expect(accepted.context.price.active?.input).toEqual(payload.input)
        expect(accepted.context.price.active?.actorUserId).toBe(USER_ID)
        expect(accepted.context.price.active?.inspectedValuationEvidence).toEqual({
          reportingCurrency: "EUR",
          facts: [],
        })
        expect(delivered).toEqual([
          SourceSyncQueuePayload.make({
            jobId: accepted.processingJobId,
            sourceId: SOURCE_ID,
            principalId: PRINCIPAL_ID,
            mode: "replay",
          }),
        ])
        const before = yield* counts
        const stale = yield* request({
          path: `/v1/transaction-overrides/${seeded.acquisition.targetId}/create`,
          payload,
        })
        expect(stale).toMatchObject({
          status: 409,
          body: {
            code: "override_conflict",
            conflictKinds: ["stream_leaf"],
            currentContext: { price: { leaf: { id: accepted.overrideId } } },
          },
        })
        expect(yield* counts).toEqual(before)
        const current = yield* inspect(seeded.acquisition.targetId)
        const invalid = yield* request({
          path: `/v1/transaction-overrides/${seeded.acquisition.targetId}/replace`,
          payload: { ...priceRequest(current), expectedSystemRevision: "old" },
        })
        expect(invalid).toMatchObject({ status: 409, body: { conflictKinds: ["system_revision"] } })
        expect(yield* counts).toEqual(before)
        expect(
          (yield* request({
            path: `/v1/transaction-overrides/${seeded.acquisition.targetId}/replace`,
            role: "readonly",
            payload: priceRequest(current),
          })).status
        ).toBe(403)
        expect(
          (yield* request({
            path: `/v1/transaction-overrides/${seeded.acquisition.targetId}/replace`,
            payload: {
              ...priceRequest(current),
              input: { _tag: "price", input: { _tag: "unit_price", amount: "3", currency: "USD" } },
            },
          })).status
        ).toBe(422)
        expect(
          (yield* request({
            path: `/v1/transaction-overrides/${seeded.acquisition.targetId}/replace`,
            payload: {
              ...priceRequest(current),
              input: { _tag: "price", input: { _tag: "unit_price", amount: 3, currency: "EUR" } },
            },
          })).status
        ).toBe(400)
        expect(yield* counts).toEqual(before)
        expect(delivered).toHaveLength(1)
        const withdrawn = yield* api.transactionOverrides.withdrawTransactionOverride({
          params: { targetId: seeded.acquisition.targetId },
          payload: {
            expectedLeafId: accepted.overrideId,
            expectedSystemRevision: current.context.current?.facts.systemRevision ?? "absent",
            reason: "Synthetic withdrawal",
            kind: "price",
          },
        })
        expect(withdrawn.context.price.active).toBeNull()
        expect(withdrawn.context.price.leaf?.id).toBe(withdrawn.overrideId)
        const recreated = yield* api.transactionOverrides.createTransactionOverride({
          params: { targetId: seeded.acquisition.targetId },
          payload: { ...payload, expectedLeafId: withdrawn.overrideId },
        })
        expect(recreated.context.price.active?.supersedesOverrideId).toBe(withdrawn.overrideId)
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("retains accepted history and pending work when queue delivery fails", () =>
    Effect.gen(function* () {
      const seeded = yield* fixture
      rejectDelivery = true
      const current = yield* inspect(seeded.acquisition.targetId)
      const api = yield* client()
      const accepted = yield* api.transactionOverrides.createTransactionOverride({
        params: { targetId: seeded.acquisition.targetId },
        payload: priceRequest(current, "0"),
      })
      expect(accepted.context.price.active?.input).toMatchObject({ input: { amount: "0" } })
      expect(yield* counts).toEqual({ history: 1, applications: 1, jobs: 1 })
      expect((yield* inspect(seeded.acquisition.targetId)).price).toMatchObject({
        coverageStatus: "updating",
        replay: { processingJobId: accepted.processingJobId },
      })
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )
  it.effect(
    "exposes exact real-run coverage through create, replace and withdrawal without rewriting earlier runs",
    () =>
      Effect.gen(function* () {
        const seeded = yield* fixture
        const db = yield* drizzle
        yield* db.delete(schema.transactionLegs).where(eq(schema.transactionLegs.id, seeded.fee.id))
        const api = yield* client()
        expect((yield* recompute(1)).status).toBe("partial")
        const oldRun = yield* readRun(1)
        const initial = yield* inspect(seeded.acquisition.targetId)
        const price = yield* api.transactionOverrides.createTransactionOverride({
          params: { targetId: seeded.acquisition.targetId },
          payload: priceRequest(initial),
        })
        const classification = yield* api.transactionOverrides.createTransactionOverride({
          params: { targetId: seeded.acquisition.targetId },
          payload: {
            expectedLeafId: null,
            expectedSystemRevision: initial.context.current?.facts.systemRevision ?? "absent",
            reason: "Synthetic purchase assertion",
            input: { _tag: "classification", input: { _tag: "inbound", cause: "purchase" } },
          },
        })
        expect(classification.context.price.active?.id).toBe(price.overrideId)
        expect(classification.context.classification.active?.id).toBe(classification.overrideId)
        expect((yield* recompute(2)).status).toBe("complete")
        expect(
          (yield* readRun(2)).results.map((row) => ({
            basis: decimal(row.basis),
            gain: decimal(row.gain),
          }))
        ).toEqual([{ basis: "20", gain: "10" }])
        expect((yield* inspect(seeded.acquisition.targetId)).price.coverageStatus).toBe("updating")
        yield* completeReplay(price.processingJobId)
        expect((yield* inspect(seeded.acquisition.targetId)).price.coverage).toBeNull()
        yield* recompute(3)
        const covered = yield* api.transactionOverrides.getTransactionOverrideHistory({
          params: { targetId: seeded.acquisition.targetId },
          query: { taxYear: YEAR },
        })
        expect(covered.price).toMatchObject({
          coverageStatus: "covered",
          coverage: {
            runId: runId(3),
            overrideId: price.overrideId,
            input: { application: "applied", resolvedPrice: { totalValue: "20" } },
          },
        })
        expect(covered.classification.coverage).toMatchObject({
          runId: runId(3),
          overrideId: classification.overrideId,
          input: { application: "applied" },
        })
        expect(covered.context.history[0]?.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
        expect(covered.inputs.system.valuationFacts).toEqual([])
        expect(covered.inputs.effective.valuationFacts).toContainEqual(
          expect.objectContaining({
            _tag: "user_valuation",
            evidenceReference: `movement-price:${price.overrideId}`,
          })
        )
        const replacement = yield* api.transactionOverrides.replaceTransactionOverride({
          params: { targetId: seeded.acquisition.targetId },
          payload: priceRequest(covered, "30"),
        })
        expect(replacement.context.classification.active?.id).toBe(classification.overrideId)
        expect((yield* recompute(4)).status).toBe("complete")
        expect(
          (yield* readRun(4)).results.map((row) => ({
            basis: decimal(row.basis),
            gain: decimal(row.gain),
          }))
        ).toEqual([{ basis: "30", gain: "0" }])
        const current = yield* inspect(seeded.acquisition.targetId)
        const withdrawal = yield* api.transactionOverrides.withdrawTransactionOverride({
          params: { targetId: seeded.acquisition.targetId },
          payload: {
            expectedLeafId: replacement.overrideId,
            expectedSystemRevision: current.context.current?.facts.systemRevision ?? "absent",
            reason: "Synthetic correction removed",
            kind: "price",
          },
        })
        expect(withdrawal.context.classification.active?.id).toBe(classification.overrideId)
        expect((yield* recompute(5)).status).toBe("partial")
        expect(
          (yield* readRun(5)).inputs
            .filter((row) => row.captured.history.kind === "price")
            .every((row) => row.captured.application === "inactive")
        ).toBe(true)
        expect(yield* readRun(1)).toEqual(oldRun)
        expect(
          yield* db
            .select({ amount: schema.transactionLegs.fiatAmount })
            .from(schema.transactionLegs)
            .where(eq(schema.transactionLegs.id, seeded.acquisition.id))
        ).toEqual([{ amount: null }])
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  for (const status of ["pending", "processing"] as const) {
    it.effect(`uses the existing ${status} sync job and one durable follow-up request`, () =>
      Effect.gen(function* () {
        const seeded = yield* fixture
        const db = yield* drizzle
        const [job] = yield* db
          .insert(schema.processingJobs)
          .values({ principalId: PRINCIPAL_ID, sourceId: SOURCE_ID, mode: "sync", status })
          .returning({ id: schema.processingJobs.id })
        if (job === undefined) return yield* Effect.die("Missing synthetic sync job")
        const api = yield* client()
        const accepted = yield* api.transactionOverrides.createTransactionOverride({
          params: { targetId: seeded.acquisition.targetId },
          payload: priceRequest(yield* inspect(seeded.acquisition.targetId)),
        })
        expect(accepted.processingJobId).toBe(job.id)
        expect(delivered).toEqual(
          status === "pending"
            ? [
                SourceSyncQueuePayload.make({
                  jobId: job.id,
                  sourceId: SOURCE_ID,
                  principalId: PRINCIPAL_ID,
                  mode: "sync",
                }),
              ]
            : []
        )
        expect(
          yield* db
            .select({
              id: schema.processingJobs.id,
              mode: schema.processingJobs.mode,
              followUpMode: schema.processingJobs.followUpMode,
              followUpJobId: schema.processingJobs.followUpJobId,
            })
            .from(schema.processingJobs)
        ).toEqual([{ id: job.id, mode: "sync", followUpMode: "replay", followUpJobId: null }])
        yield* api.transactionOverrides.replaceTransactionOverride({
          params: { targetId: seeded.acquisition.targetId },
          payload: priceRequest(yield* inspect(seeded.acquisition.targetId), "30"),
        })
        expect((yield* counts).jobs).toBe(1)
        if (status === "processing") expect(delivered).toEqual([])
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    )
  }

  it.effect("leaves jobs with unmet prerequisites for existing recovery", () =>
    Effect.gen(function* () {
      const seeded = yield* fixture
      const db = yield* drizzle
      const [job, prerequisite] = yield* db
        .insert(schema.processingJobs)
        .values([
          { principalId: PRINCIPAL_ID, sourceId: SOURCE_ID, mode: "replay", status: "pending" },
          {
            principalId: OTHER_PRINCIPAL_ID,
            sourceId: OTHER_SOURCE_ID,
            mode: "sync",
            status: "pending",
          },
        ])
        .returning({ id: schema.processingJobs.id })
      if (job === undefined || prerequisite === undefined)
        return yield* Effect.die("Missing synthetic job dependency")
      yield* db
        .insert(schema.processingJobDependencies)
        .values({ jobId: job.id, prerequisiteJobId: prerequisite.id })
      const api = yield* client()
      const accepted = yield* api.transactionOverrides.createTransactionOverride({
        params: { targetId: seeded.acquisition.targetId },
        payload: priceRequest(yield* inspect(seeded.acquisition.targetId)),
      })
      expect(accepted.processingJobId).toBe(job.id)
      expect(delivered).toEqual([])
      expect(yield* counts).toEqual({ history: 1, applications: 1, jobs: 2 })
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect(
    "keeps disappeared history readable and malformed inspections distinct, with no rejected writes",
    () =>
      Effect.gen(function* () {
        const seeded = yield* fixture
        const db = yield* drizzle
        const api = yield* client()
        const before = yield* inspect(seeded.acquisition.targetId)
        const base = priceRequest(before)
        const path = `/v1/transaction-overrides/${seeded.acquisition.targetId}/create`
        expect((yield* request({ path, payload: base, userId: OTHER_USER_ID })).status).toBe(404)
        expect(
          (yield* request({
            path,
            payload: {
              expectedSystemRevision: base.expectedSystemRevision,
              reason: base.reason,
              input: base.input,
            },
          })).status
        ).toBe(400)
        expect(
          (yield* request({ path, payload: { ...base, actorUserId: OTHER_USER_ID } })).status
        ).toBe(400)
        expect(
          (yield* request({
            path,
            payload: {
              ...base,
              input: { _tag: "classification", input: { _tag: "outbound", cause: "sale" } },
            },
          })).status
        ).toBe(422)
        const fee = yield* inspect(seeded.fee.targetId)
        expect(
          (yield* request({
            path: `/v1/transaction-overrides/${seeded.fee.targetId}/create`,
            payload: {
              ...priceRequest(fee),
              input: { _tag: "classification", input: { _tag: "outbound", cause: "sale" } },
            },
          })).status
        ).toBe(422)
        expect(yield* counts).toEqual({ history: 0, applications: 0, jobs: 0 })
        const accepted = yield* api.transactionOverrides.createTransactionOverride({
          params: { targetId: seeded.acquisition.targetId },
          payload: base,
        })
        yield* db
          .delete(schema.transactionLegs)
          .where(eq(schema.transactionLegs.id, seeded.acquisition.id))
        const absent = yield* inspect(seeded.acquisition.targetId)
        expect(absent.context.current).toBeNull()
        expect(absent.inputs).toMatchObject({ current: null, currentOutcome: "absent" })
        expect(absent.context.price.active?.id).toBe(accepted.overrideId)
        expect(absent.price).toMatchObject({
          application: "needs_attention",
          applicationProblem: "target_unavailable",
        })
        expect(absent.validClassificationInputs).toEqual([])
        const count = yield* counts
        expect(
          yield* request({
            path: `/v1/transaction-overrides/${seeded.acquisition.targetId}/withdraw`,
            payload: {
              expectedLeafId: accepted.overrideId,
              expectedSystemRevision: base.expectedSystemRevision,
              reason: "Synthetic absent withdrawal",
              kind: "price",
            },
          })
        ).toMatchObject({ status: 422, body: { code: "target_unavailable" } })
        expect(yield* counts).toEqual(count)
        yield* db
          .update(schema.transactionLegs)
          .set({ amount: "0" })
          .where(eq(schema.transactionLegs.id, seeded.disposal.id))
        const malformed = yield* inspect(seeded.disposal.targetId)
        expect(malformed.context.current).toBeNull()
        expect(malformed.inputs.currentOutcome).toBe("withheld")
        expect(decimal(malformed.inputs.current?.quantity)).toBe("0")
        expect(malformed.validClassificationInputs).toEqual([])
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )
  it.effect("keeps the authoritative total separate from a rounded unit preview", () =>
    Effect.gen(function* () {
      const seeded = yield* fixture
      const db = yield* drizzle
      yield* db
        .update(schema.transactionLegs)
        .set({ amount: "3" })
        .where(eq(schema.transactionLegs.id, seeded.acquisition.id))
      const api = yield* client()
      const accepted = yield* api.transactionOverrides.createTransactionOverride({
        params: { targetId: seeded.acquisition.targetId },
        payload: priceRequest(yield* inspect(seeded.acquisition.targetId), "1"),
      })
      const current = yield* inspect(seeded.acquisition.targetId)
      expect(current.context.price.active?.input).toMatchObject({ input: { amount: "1" } })
      expect(current.price.resolvedPrice).toEqual({
        totalValue: "1",
        currency: "EUR",
        unitPrice: { amount: "0.333333333333333333", rounded: true },
      })
      expect(
        current.inputs.corrections.find((row) => row.history.id === accepted.overrideId)
          ?.resolvedPrice
      ).toEqual(current.price.resolvedPrice)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect(
    "keeps approved custody uneditable and exposes its exact reconciliation beside the separate fee",
    () =>
      Effect.gen(function* () {
        const seeded = yield* fixture
        const db = yield* drizzle
        const [provider] = yield* db
          .insert(schema.providerTransfers)
          .values({
            sourceId: SOURCE_ID,
            transactionId: seeded.buy.id,
            externalId: "synthetic-custody-provider",
            fromAccountRef: "synthetic-source",
            toAddress: "synthetic-destination",
            timestamp,
            direction: "outbound",
            processingMode: "accounting_and_evidence",
            amount: "10",
          })
          .returning({ id: schema.providerTransfers.id })
        const [transfer] = yield* db
          .insert(schema.transfers)
          .values({
            sourceId: SOURCE_ID,
            principalId: PRINCIPAL_ID,
            externalId: "synthetic-custody-canonical",
            fromAddress: "synthetic-source",
            toAddress: "synthetic-destination",
            timestamp,
            type: "native",
            assetId: TEST_BTC_ASSET_ID,
            amount: "10",
          })
          .returning({ id: schema.transfers.id })
        if (provider === undefined || transfer === undefined)
          return yield* Effect.die("Missing synthetic custody links")
        yield* db.insert(schema.inventoryMovements).values({
          sourceId: SOURCE_ID,
          principalId: PRINCIPAL_ID,
          transactionId: seeded.buy.id,
          providerTransferId: provider.id,
          assetId: TEST_BTC_ASSET_ID,
          timestamp,
          direction: "outbound",
          purpose: "principal",
          taxTreatment: "non_taxable",
          reconciliationStatus: "matched",
          amount: "10",
        })
        const [reconciliation] = yield* db
          .insert(schema.transferReconciliations)
          .values({
            principalId: PRINCIPAL_ID,
            providerTransferId: provider.id,
            canonicalTransferId: transfer.id,
            canonicalTransactionId: seeded.buy.id,
            status: "approved",
            matchReason: "Synthetic custody evidence",
            confidence: "1",
            deterministic: true,
          })
          .returning({ id: schema.transferReconciliations.id })
        if (reconciliation === undefined)
          return yield* Effect.die("Missing synthetic reconciliation")
        yield* db
          .update(schema.transactionLegs)
          .set({ originKind: "canonical_transfer", sourceTransferId: transfer.id })
          .where(eq(schema.transactionLegs.id, seeded.acquisition.id))
        const current = yield* inspect(seeded.acquisition.targetId)
        expect(current.context.current?.facts.structure).toBe("custody")
        expect(current.validClassificationInputs).toEqual([])
        expect(current.inputs.current?.custody).toContainEqual(
          expect.objectContaining({
            reconciliationId: reconciliation.id,
            canonicalTransferId: transfer.id,
            providerTransferId: provider.id,
          })
        )
        const fee = yield* inspect(seeded.fee.targetId)
        expect(fee.context.current?.facts.structure).toBe("fee")
        expect(fee.inputs.current?.custody).toEqual([])
        expect(
          yield* request({
            path: `/v1/transaction-overrides/${seeded.acquisition.targetId}/create`,
            payload: priceRequest(current),
          })
        ).toMatchObject({ status: 422, body: { code: "custody_correction_forbidden" } })
        expect(yield* counts).toEqual({ history: 0, applications: 0, jobs: 0 })
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )
})
