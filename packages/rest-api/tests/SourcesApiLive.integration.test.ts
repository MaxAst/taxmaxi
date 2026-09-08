import { prepareMovementLegFixtures } from "../../persistence/tests/support/movement-leg-fixtures.ts"
import { nextTestUuid } from "./support/TestUuid.ts"
import { HttpApiClient } from "effect/unstable/httpapi"
import { Cookies, Headers, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { NodeHttpServer } from "@effect/platform-node"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import type { TaxAccountingResult } from "../../accounting/src/index.ts"
import { AccountingMethodId, CustodyUnitId, JurisdictionCode, TaxYear } from "@my/core/accounting"
import {
  AuthService,
  HashedPassword,
  PasswordHasher,
  type AuthServiceShape,
} from "@my/core/authentication"
import { CurrencyCode, EUR } from "@my/core/currency"
import { PrincipalId } from "@my/core/ownership"
import { SourceId } from "@my/core/source"
import { and, eq, sql } from "@my/persistence/query"
import * as ConfigProvider from "effect/ConfigProvider"
import {
  CalculationRecomputeQueue,
  CalculationRecomputeQueueError,
  SOURCE_SYNC_JOB_NAME,
  SOURCE_SYNC_QUEUE_NAME,
  SourceProviderRegistry,
  SourceSyncJobRepository,
  SourceSyncQueue,
  SourceSyncQueueError,
  SourceSyncRunService,
  TransferReconciliationService,
  type SourceSyncQueuePayload,
  type SourceSyncRunServiceShape,
  type CalculationRecomputeQueueShape,
  type SourceProviderModuleShape,
  type TransferReconciliationServiceShape,
} from "@my/sync-engine/services"
import { FetchProviderRawBatchResult, ProviderRawRecord } from "@my/sync-engine/shared"
import * as Chunk from "effect/Chunk"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as EffectSchema from "effect/Schema"
import { TestClock } from "effect/testing"
import { SourceSyncJobExecutorLive, SourceSyncServiceLive } from "@my/sync-engine/layers"
import {
  makeWorkerBullMqSourceSyncConsumerLive,
  type WorkerBullMqSourceSyncProcessor,
} from "../../../apps/worker/src/layers/WorkerBullMqSourceSyncConsumerLive.ts"
import { WorkerSourceSyncStartupRepair } from "../../../apps/worker/src/layers/WorkerSourceSyncStartupRepairLive.ts"
import {
  CalculationRunRepositoryLive,
  CalculationRunServiceLive,
  FactualLedgerRepositoryLive,
} from "../../persistence/src/layers/index.ts"
import { drizzle } from "../../persistence/src/layers/PgClientLive.ts"
import { RepositoriesLive } from "../../persistence/src/layers/RepositoriesLive.ts"
import { TaxCalculationServiceLive } from "../../persistence/src/layers/TaxCalculationServiceLive.ts"
import { schema } from "../../persistence/src/schema/index.ts"
import {
  CalculationRunId,
  CalculationRunRepository,
  CalculationRunService,
  InputLedgerRevision,
  TaxCalculationService,
  ValuationRevision,
} from "../../persistence/src/services/index.ts"
import { makeIntegrationTestDatabaseContext } from "../../persistence/tests/support/integration-test-kit.ts"
import {
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
  TEST_BTC_ASSET_ID,
  TEST_BTC_REPRESENTATION_ID,
} from "../../persistence/tests/support/integration-test-kit.ts"
import { TaxMaxiApi } from "../src/definitions/TaxMaxiApi.ts"
import { ANON_CHALLENGE_COOKIE_NAME, ANON_SESSION_COOKIE_NAME } from "../src/layers/AnonApiLive.ts"
import { SourceCreateResponse, SourcePaymentRequiredError } from "../src/definitions/SourcesApi.ts"
import { AnonSessionServiceLive } from "../src/layers/AnonSessionServiceLive.ts"
import { SimpleTokenValidatorLive } from "../src/layers/AuthMiddlewareLive.ts"
import { TaxMaxiApiLive } from "../src/layers/TaxMaxiApiLive.ts"
import { X402PaymentValidator } from "../src/services/X402PaymentValidator.ts"
import {
  makeX402PaymentValidatorTestLive,
  TEST_PAYER_WALLET,
} from "./support/X402PaymentValidatorTestLive.ts"
import {
  makeTestSiwxProof,
  SIWXProofVerifierTestLive,
} from "./support/SIWXProofVerifierTestLive.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_rest_api_sources",
})
const TestPgClientLive = context.TestPgClientLive

const queuedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"))
const queueEvents: Array<SourceSyncQueuePayload> = []
const calculationQueueEvents: Array<string> = []
const settlementEvents: Array<string> = []
const validX402PaymentHeader = "valid-test-x402-payment"
const REPORT_TEST_USER_ID = "00000000-0000-4000-8000-000000000181"
const REPORT_TEST_PRINCIPAL_ID = "00000000-0000-4000-8000-000000000183"
const REPORT_TEST_SOURCE_ID = "00000000-0000-4000-8000-000000000281"
const REPORT_TEST_FIXTURE = {
  userId: REPORT_TEST_USER_ID,
  principalId: REPORT_TEST_PRINCIPAL_ID,
  sourceId: REPORT_TEST_SOURCE_ID,
}
const ClaimTokenConfigProvider = ConfigProvider.fromEnvRecord({
  ANON_SESSION_SECRET: "test-anon-session-secret-32-bytes-long",
  CLAIM_TOKEN_PEPPER: "test-claim-token-pepper",
})
const AnonSessionServiceTestLive = AnonSessionServiceLive.pipe(
  Layer.provide(ConfigProvider.layer(ClaimTokenConfigProvider))
)
const X402PaymentValidatorTestLive = makeX402PaymentValidatorTestLive({
  validPaymentHeader: validX402PaymentHeader,
})
const X402PaymentValidatorSettlementFailureTestLive = makeX402PaymentValidatorTestLive({
  failSettlement: true,
  validPaymentHeader: validX402PaymentHeader,
})
const X402PaymentValidatorTrackingTestLive = makeX402PaymentValidatorTestLive({
  onSettle: (paymentHeader) => settlementEvents.push(paymentHeader),
  validPaymentHeader: validX402PaymentHeader,
})
const X402PaymentValidatorWithoutPayerIdentityTestLive = makeX402PaymentValidatorTestLive({
  includePayerIdentity: false,
  validPaymentHeader: validX402PaymentHeader,
})

const SourceSyncQueueTestLive = Layer.effect(
  SourceSyncQueue,
  Effect.gen(function* () {
    const sourceSyncJobRepository = yield* SourceSyncJobRepository

    return SourceSyncQueue.of({
      enqueueSourceSyncJob: (payload) =>
        Effect.gen(function* () {
          queueEvents.push(payload)
          yield* sourceSyncJobRepository
            .attachQueueMetadata({
              jobId: payload.jobId,
              queueName: SOURCE_SYNC_QUEUE_NAME,
              queueJobId: payload.jobId,
              queuedAt,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new SourceSyncQueueError({
                    operation: "test.attachQueueMetadata",
                    cause,
                  })
              )
            )
        }),
    })
  })
)

const SourceSyncQueueFailureTestLive = Layer.succeed(SourceSyncQueue, {
  enqueueSourceSyncJob: () =>
    Effect.fail(
      new SourceSyncQueueError({
        operation: "test.enqueueSourceSyncJob",
        cause: "queue unavailable",
      })
    ),
})

const CalculationRecomputeQueueTestLive = Layer.succeed(CalculationRecomputeQueue, {
  enqueuePrincipalRecompute: (principalId) =>
    Effect.sync(() => {
      calculationQueueEvents.push(principalId)
    }),
})

const CalculationRecomputeQueueFailureTestLive = Layer.succeed(CalculationRecomputeQueue, {
  enqueuePrincipalRecompute: () =>
    Effect.fail(
      new CalculationRecomputeQueueError({
        operation: "test.enqueuePrincipalRecompute",
        cause: "queue unavailable",
      })
    ),
})

const SourceSyncRunServiceTestLive = Layer.succeed(SourceSyncRunService, {
  startSyncRun: () => Effect.die("SourceSyncRunService test stub: startSyncRun not implemented"),
  getSyncRun: () => Effect.die("SourceSyncRunService test stub: getSyncRun not implemented"),
} satisfies SourceSyncRunServiceShape)

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

const TaxCalculationServiceTestLive = Layer.succeed(TaxCalculationService, {
  calculateTax: () => Effect.die("TaxCalculationService test stub: calculateTax"),
})

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

const makeSourceSyncServiceWithDepsTestLive = (
  sourceSyncQueueLayer: Layer.Layer<SourceSyncQueue, never, SourceSyncJobRepository>
) =>
  SourceSyncServiceLive.pipe(Layer.provide(sourceSyncQueueLayer), Layer.provide(RepositoriesLive))

const makePersistenceLayer = <R = never>(
  sourceSyncQueueLayer: Layer.Layer<SourceSyncQueue, never, SourceSyncJobRepository>,
  taxCalculationServiceLayer: Layer.Layer<
    TaxCalculationService,
    never,
    R
  > = TaxCalculationServiceTestLive,
  calculationRecomputeQueueLayer: Layer.Layer<CalculationRecomputeQueue> = CalculationRecomputeQueueTestLive
) =>
  Layer.mergeAll(
    RepositoriesLive,
    makeSourceSyncServiceWithDepsTestLive(sourceSyncQueueLayer),
    SourceSyncRunServiceTestLive,
    taxCalculationServiceLayer,
    calculationRecomputeQueueLayer,
    TransferReconciliationServiceTestLive,
    AuthServiceTestLive,
    PasswordHasherTestLive
  ).pipe(Layer.provideMerge(TestPgClientLive))

const makeHttpLive = <R = never>(
  sourceSyncQueueLayer: Layer.Layer<SourceSyncQueue, never, SourceSyncJobRepository>,
  x402PaymentValidatorLayer: Layer.Layer<X402PaymentValidator> = X402PaymentValidatorTestLive,
  taxCalculationServiceLayer: Layer.Layer<
    TaxCalculationService,
    never,
    R
  > = TaxCalculationServiceTestLive,
  calculationRecomputeQueueLayer: Layer.Layer<CalculationRecomputeQueue> = CalculationRecomputeQueueTestLive
) =>
  HttpRouter.serve(
    TaxMaxiApiLive.pipe(
      Layer.provide(sourceSyncQueueLayer),
      Layer.provide(AnonSessionServiceTestLive),
      Layer.provide(SIWXProofVerifierTestLive),
      Layer.provide(x402PaymentValidatorLayer),
      Layer.provide(SimpleTokenValidatorLive)
    )
  ).pipe(
    Layer.provideMerge(
      makePersistenceLayer(
        sourceSyncQueueLayer,
        taxCalculationServiceLayer,
        calculationRecomputeQueueLayer
      )
    ),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(ConfigProvider.layer(ClaimTokenConfigProvider))
  )

const HttpLive = makeHttpLive(SourceSyncQueueTestLive)
const QueueFailureHttpLive = makeHttpLive(SourceSyncQueueFailureTestLive)
const SettlementFailureHttpLive = makeHttpLive(
  SourceSyncQueueTestLive,
  X402PaymentValidatorSettlementFailureTestLive
)
const NoPayerIdentityHttpLive = makeHttpLive(
  SourceSyncQueueTestLive,
  X402PaymentValidatorWithoutPayerIdentityTestLive
)
const PaidQueueFailureHttpLive = makeHttpLive(
  SourceSyncQueueFailureTestLive,
  X402PaymentValidatorTrackingTestLive
)
const CalculationQueueFailureHttpLive = makeHttpLive(
  SourceSyncQueueTestLive,
  X402PaymentValidatorTestLive,
  TaxCalculationServiceTestLive,
  CalculationRecomputeQueueFailureTestLive
)
const TaxCalculationHttpLive = makeHttpLive(
  SourceSyncQueueTestLive,
  X402PaymentValidatorTestLive,
  TaxCalculationServiceLive
)

const CalculationRunServiceTestLive = CalculationRunServiceLive.pipe(
  Layer.provide(Layer.merge(CalculationRunRepositoryLive, FactualLedgerRepositoryLive)),
  Layer.provide(TestPgClientLive)
)

const makeAuthenticatedClient = ({ userId }: { readonly userId: string }) =>
  Effect.gen(function* () {
    const baseHttpClient = yield* HttpClient.HttpClient
    return yield* HttpApiClient.makeWith(TaxMaxiApi, {
      httpClient: baseHttpClient.pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(`user_${userId}_admin`))
      ),
    })
  })

const makeUnauthenticatedClientWithPayment = () =>
  Effect.gen(function* () {
    const baseHttpClient = yield* HttpClient.HttpClient
    return yield* HttpApiClient.makeWith(TaxMaxiApi, {
      httpClient: baseHttpClient.pipe(
        HttpClient.mapRequest(HttpClientRequest.setHeader("x-payment", validX402PaymentHeader))
      ),
    })
  })

const makeUnauthenticatedClient = () =>
  Effect.gen(function* () {
    const baseHttpClient = yield* HttpClient.HttpClient
    return yield* HttpApiClient.makeWith(TaxMaxiApi, {
      httpClient: baseHttpClient,
    })
  })

const makeUnauthenticatedClientWithInvalidPayment = () =>
  Effect.gen(function* () {
    const baseHttpClient = yield* HttpClient.HttpClient
    return yield* HttpApiClient.makeWith(TaxMaxiApi, {
      httpClient: baseHttpClient.pipe(
        HttpClient.mapRequest(HttpClientRequest.setHeader("x-payment", "invalid-test-x402-payment"))
      ),
    })
  })

const makeClientWithBearerToken = (token: string) =>
  Effect.gen(function* () {
    const baseHttpClient = yield* HttpClient.HttpClient
    return yield* HttpApiClient.makeWith(TaxMaxiApi, {
      httpClient: baseHttpClient.pipe(HttpClient.mapRequest(HttpClientRequest.bearerToken(token))),
    })
  })

const makeClientWithCookie = (cookieHeader: string) =>
  Effect.gen(function* () {
    const baseHttpClient = yield* HttpClient.HttpClient
    return yield* HttpApiClient.makeWith(TaxMaxiApi, {
      httpClient: baseHttpClient.pipe(
        HttpClient.mapRequest(HttpClientRequest.setHeader("cookie", cookieHeader))
      ),
    })
  })

const makeClientWithBearerTokenAndCookie = ({
  cookieHeader,
  token,
}: {
  readonly cookieHeader: string
  readonly token: string
}) =>
  Effect.gen(function* () {
    const baseHttpClient = yield* HttpClient.HttpClient
    return yield* HttpApiClient.makeWith(TaxMaxiApi, {
      httpClient: baseHttpClient.pipe(
        HttpClient.mapRequest((request) =>
          HttpClientRequest.bearerToken(token)(
            HttpClientRequest.setHeader("cookie", cookieHeader)(request)
          )
        )
      ),
    })
  })

const extractCookieValue = (headers: Headers.Headers, name: string): string => {
  const setCookie = Headers.get(headers, "set-cookie")
  if (Option.isNone(setCookie)) {
    throw new Error(`Missing ${name} cookie`)
  }

  const cookie = setCookie.value
    .split(",")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`))

  if (cookie === undefined) {
    throw new Error(`Missing ${name} cookie`)
  }

  return cookie.slice(name.length + 1).split(";", 1)[0] ?? ""
}

const AnonSessionChallengeBody = EffectSchema.Struct({
  nonce: EffectSchema.String,
  expiresAt: EffectSchema.String,
})

const createAnonSessionCookie = ({
  walletAddress = TEST_PAYER_WALLET,
}: {
  readonly walletAddress?: string
} = {}) =>
  Effect.gen(function* () {
    const challengeResponse = yield* HttpClient.execute(
      HttpClientRequest.post("/v1/anon/session/challenge")
    )
    const challengeCookie = extractCookieValue(
      challengeResponse.headers,
      ANON_CHALLENGE_COOKIE_NAME
    )
    const challengeJson = yield* challengeResponse.json
    const challenge =
      yield* EffectSchema.decodeUnknownEffect(AnonSessionChallengeBody)(challengeJson)
    const siwxProof = makeTestSiwxProof({
      chainType: "solana",
      walletAddress,
      nonce: challenge.nonce,
    })

    const sessionResponse = yield* HttpClient.execute(
      HttpClientRequest.post("/v1/anon/session").pipe(
        HttpClientRequest.setHeader("cookie", `${ANON_CHALLENGE_COOKIE_NAME}=${challengeCookie}`),
        HttpClientRequest.bodyJsonUnsafe({ siwxProof })
      )
    )
    const sessionCookie = Cookies.getValue(sessionResponse.cookies, ANON_SESSION_COOKIE_NAME)
    if (Option.isNone(sessionCookie)) {
      const body = yield* sessionResponse.text
      return yield* Effect.die(
        `Missing anon session cookie from status ${sessionResponse.status}: ${body}`
      )
    }
    return sessionCookie.value
  })

const postRawSourceCreate = ({
  payload,
  paymentHeader,
  paymentSignatureHeader,
}: {
  readonly payload: unknown
  readonly paymentHeader?: string | undefined
  readonly paymentSignatureHeader?: string | undefined
}) =>
  Effect.gen(function* () {
    const baseRequest = HttpClientRequest.post("/v1/sources").pipe(
      HttpClientRequest.bodyJsonUnsafe(payload)
    )
    const xPaymentRequest =
      paymentHeader === undefined
        ? baseRequest
        : baseRequest.pipe(HttpClientRequest.setHeader("x-payment", paymentHeader))
    const request =
      paymentSignatureHeader === undefined
        ? xPaymentRequest
        : xPaymentRequest.pipe(
            HttpClientRequest.setHeader("payment-signature", paymentSignatureHeader)
          )

    return yield* HttpClient.execute(request)
  })

const seedCoinbaseSource = ({
  userId,
  principalId,
  sourceId,
}: {
  readonly userId: string
  readonly principalId: string
  readonly sourceId: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db.insert(schema.users).values({
      id: userId,
      email: `${sourceId}@taxmaxi.test`,
      name: "Sources API Queue Test User",
    })
    yield* db.insert(schema.principals).values({
      id: principalId,
      kind: "user",
      userId,
    })

    const coinbaseCex = yield* db
      .select({ id: schema.cex.id, name: schema.cex.name })
      .from(schema.cex)
      .pipe(Effect.map((rows) => rows.find((row) => row.name === "coinbase")))

    if (coinbaseCex === undefined) {
      return yield* Effect.die("Missing seeded coinbase CEX fixture")
    }

    const [createdAccount] = yield* db
      .insert(schema.cexAccount)
      .values({
        cexId: coinbaseCex.id,
        principalId,
        providerUserId: `${sourceId}-provider-user`,
        providerAccountId: `${sourceId}-provider-account`,
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        expiresAt: DateTime.toDateUtc(DateTime.addDuration(yield* DateTime.now, "1 hour")),
        scopes: "wallet:accounts:read wallet:transactions:read",
      })
      .returning({ id: schema.cexAccount.id })

    if (createdAccount === undefined) {
      return yield* Effect.die("Failed to create cex account fixture")
    }

    yield* db.insert(schema.sources).values({
      id: sourceId,
      name: "Coinbase",
      providerKey: "coinbase",
      sourceableType: "cex",
      cexAccountId: createdAccount.id,
      principalId,
    })
  })

const seedUsableCredit = ({
  userId,
  amount = 1,
}: {
  readonly userId: string
  readonly amount?: number
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db.insert(schema.creditLedger).values({
      userId,
      delta: amount,
      kind: "top_up",
      reference: `test-credit-${userId}`,
    })
  })

const seedPrincipalUser = ({
  userId,
  principalId,
}: {
  readonly userId: string
  readonly principalId: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db.insert(schema.users).values({
      id: userId,
      email: `${userId}@taxmaxi.test`,
      name: "Sources API Test User",
    })
    yield* db.insert(schema.principals).values({
      id: principalId,
      kind: "user",
      userId,
    })
  })

const reportFixtureIds = {
  buyTransactionId: "00000000-0000-4000-8000-000000046101",
  sellTransactionId: "00000000-0000-4000-8000-000000046102",
  acquisitionLegId: "00000000-0000-4000-8000-000000046201",
  disposalLegId: "00000000-0000-4000-8000-000000046202",
  feeTransactionId: "00000000-0000-4000-8000-000000046203",
  feeLegId: "00000000-0000-4000-8000-000000046204",
  internalTransferTransactionId: "00000000-0000-4000-8000-000000046205",
  internalTransferLegId: "00000000-0000-4000-8000-000000046206",
  internalTransferInTransactionId: "00000000-0000-4000-8000-000000046207",
  internalTransferInLegId: "00000000-0000-4000-8000-000000046208",
  custodyProviderTransferId: "00000000-0000-4000-8000-000000046401",
  custodyMovementId: "00000000-0000-4000-8000-000000046402",
  activeCalculationRunId: "00000000-0000-4000-8000-000000046501",
  unvaluedDisposalEventId: "00000000-0000-4000-8000-000000046502",
  taxableLossEventId: "00000000-0000-4000-8000-000000046503",
  taxFreeLossEventId: "00000000-0000-4000-8000-000000046504",
  unknownTreatmentEventId: "00000000-0000-4000-8000-000000046505",
  incomeEventId: "00000000-0000-4000-8000-000000046506",
  otherSourceId: "00000000-0000-4000-8000-000000046507",
  incomeTransactionId: "00000000-0000-4000-8000-000000046508",
  otherAcquisitionEventId: "00000000-0000-4000-8000-000000046509",
  unvaluedDisposalTransactionId: "00000000-0000-4000-8000-000000046510",
  otherDisposalEventId: "00000000-0000-4000-8000-000000046511",
  otherDisposalTransactionId: "00000000-0000-4000-8000-000000046512",
} as const

const seedSourceReportRows = ({
  principalId,
  sourceId,
}: {
  readonly principalId: string
  readonly sourceId: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db.insert(schema.transactions).values([
      {
        id: reportFixtureIds.buyTransactionId,
        sourceId,
        principalId,
        externalId: "report-buy-1",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-10T12:00:00.000Z")),
        transactionType: "buy_fiat",
        providerTransactionType: "buy",
        providerStatus: "completed",
        providerDescription: "Buy BTC",
      },
      {
        id: reportFixtureIds.sellTransactionId,
        sourceId,
        principalId,
        externalId: "report-sell-1",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-10T12:00:00.000Z")),
        transactionType: "sell_fiat",
        providerTransactionType: "sell",
        providerStatus: "completed",
        providerDescription: "Sell BTC",
      },
    ])

    yield* db.insert(schema.transactionLegs).values(
      yield* prepareMovementLegFixtures([
        {
          movementIdentity: { sourceRecordKey: "report-buy-1:btc", componentKey: "movement" },
          id: reportFixtureIds.acquisitionLegId,
          sourceId,
          principalId,
          externalId: "report-buy-1:btc",
          timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-10T12:00:00.000Z")),
          assetId: TEST_BTC_ASSET_ID,
          amount: "1",
          kind: "acquisition",
          provenance: "deterministic",
          originKind: "none" as const,
          derivationRule: "test_fixture_buy",
          transactionId: reportFixtureIds.buyTransactionId,
          fiatAmount: "10000",
          fiatCurrency: "EUR",
        },
        {
          movementIdentity: { sourceRecordKey: "report-sell-1:btc", componentKey: "movement" },
          id: reportFixtureIds.disposalLegId,
          sourceId,
          principalId,
          externalId: "report-sell-1:btc",
          timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-10T12:00:00.000Z")),
          assetId: TEST_BTC_ASSET_ID,
          amount: "0.4",
          kind: "disposal",
          provenance: "deterministic",
          originKind: "none" as const,
          derivationRule: "test_fixture_sell",
          transactionId: reportFixtureIds.sellTransactionId,
          fiatAmount: "6000",
          fiatCurrency: "EUR",
        },
      ])
    )
  })

const seedSourceReportActiveRun = ({
  principalId,
  sourceId,
}: {
  readonly principalId: string
  readonly sourceId: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const completedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"))

    yield* db.insert(schema.calculationRuns).values({
      id: reportFixtureIds.activeCalculationRunId,
      principalId,
      jurisdiction: "DE",
      taxYear: 2025,
      reportingCurrency: "EUR",
      engineVersion: "test-engine-v1",
      ruleSetVersion: "de-crypto-income-tax-v2025-03-06",
      inputLedgerRevision: `v2:1:1.1.1:${"a".repeat(64)}`,
      valuationRevision: `sha256:${"b".repeat(64)}`,
      status: "complete",
      accountingMethod: "fifo",
      inventoryScope: "per_custody_unit",
      appliedChoiceIds: [],
      appliedRules: [],
      processedEventIds: [reportFixtureIds.acquisitionLegId, reportFixtureIds.disposalLegId],
      startedAt: completedAt,
      completedAt,
    })
    yield* db.insert(schema.calculationRunCustodyUnits).values({
      runId: reportFixtureIds.activeCalculationRunId,
      principalId,
      custodyUnitId: sourceId,
    })
    yield* db.insert(schema.calculationRunCustodyUnitSources).values({
      runId: reportFixtureIds.activeCalculationRunId,
      principalId,
      custodyUnitId: sourceId,
      sourceId,
    })
    yield* db.insert(schema.calculationRunAllocations).values([
      {
        runId: reportFixtureIds.activeCalculationRunId,
        principalId,
        sequence: 0,
        acquisitionEventId: reportFixtureIds.acquisitionLegId,
        dispositionEventId: reportFixtureIds.disposalLegId,
        assetId: TEST_BTC_ASSET_ID,
        custodyUnitId: sourceId,
        acquiredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2023-01-10T12:00:00.000Z")),
        disposedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-10T12:00:00.000Z")),
        quantity: "0.2",
        costBasis: "1000",
      },
      {
        runId: reportFixtureIds.activeCalculationRunId,
        principalId,
        sequence: 1,
        acquisitionEventId: reportFixtureIds.acquisitionLegId,
        dispositionEventId: reportFixtureIds.disposalLegId,
        assetId: TEST_BTC_ASSET_ID,
        custodyUnitId: sourceId,
        acquiredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-10T12:00:00.000Z")),
        disposedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-10T12:00:00.000Z")),
        quantity: "0.2",
        costBasis: "3000",
      },
    ])
    yield* db.insert(schema.calculationRunRealizedResults).values([
      {
        runId: reportFixtureIds.activeCalculationRunId,
        sequence: 0,
        sourceId,
        allocationSequence: 0,
        acquisitionEventId: reportFixtureIds.acquisitionLegId,
        dispositionEventId: reportFixtureIds.disposalLegId,
        assetId: TEST_BTC_ASSET_ID,
        acquiredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2023-01-10T12:00:00.000Z")),
        disposedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-10T12:00:00.000Z")),
        quantity: "0.2",
        costBasis: "1000",
        proceeds: "1500",
        gainLoss: "500",
        treatmentCodes: ["de.tax_free_holding_period"],
      },
      {
        runId: reportFixtureIds.activeCalculationRunId,
        sequence: 1,
        sourceId,
        allocationSequence: 1,
        acquisitionEventId: reportFixtureIds.acquisitionLegId,
        dispositionEventId: reportFixtureIds.disposalLegId,
        assetId: TEST_BTC_ASSET_ID,
        acquiredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-10T12:00:00.000Z")),
        disposedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-10T12:00:00.000Z")),
        quantity: "0.2",
        costBasis: "3000",
        proceeds: "3500",
        gainLoss: "500",
        treatmentCodes: ["de.taxable_private_disposal"],
      },
    ])
    yield* db.insert(schema.calculationRunDerivedLots).values({
      runId: reportFixtureIds.activeCalculationRunId,
      principalId,
      sequence: 0,
      acquisitionEventId: reportFixtureIds.acquisitionLegId,
      assetId: TEST_BTC_ASSET_ID,
      custodyUnitId: sourceId,
      acquiredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-10T12:00:00.000Z")),
      remainingQuantity: "0.6",
      costBasisPerUnit: "15000",
    })
    yield* db.insert(schema.activeCalculationRuns).values({
      principalId,
      jurisdiction: "DE",
      taxYear: 2025,
      reportingCurrency: "EUR",
      runId: reportFixtureIds.activeCalculationRunId,
      minimumActivationRevision: "0",
    })
  })

const seedOtherReportSource = ({
  principalId,
  referenceSourceId,
}: {
  readonly principalId: string
  readonly referenceSourceId: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [existingAccount] = yield* db
      .select({ cexId: schema.cexAccount.cexId })
      .from(schema.sources)
      .innerJoin(schema.cexAccount, eq(schema.sources.cexAccountId, schema.cexAccount.id))
      .where(eq(schema.sources.id, referenceSourceId))
      .limit(1)
    if (existingAccount === undefined) {
      return yield* Effect.die("Missing report fixture CEX account")
    }

    const [otherAccount] = yield* db
      .insert(schema.cexAccount)
      .values({
        cexId: existingAccount.cexId,
        principalId,
        providerAccountId: reportFixtureIds.otherSourceId,
      })
      .returning({ id: schema.cexAccount.id })
    if (otherAccount === undefined) {
      return yield* Effect.die("Failed to create second report source account")
    }

    yield* db.insert(schema.sources).values({
      id: reportFixtureIds.otherSourceId,
      name: "Other Coinbase source",
      providerKey: "coinbase",
      sourceableType: "cex",
      cexAccountId: otherAccount.id,
      principalId,
    })
  })

const seedClaimCalculationResultRows = ({
  runId,
  principalId,
  sourceId,
  assetId,
  acquisitionEventId,
  dispositionEventId,
  occurredAt,
}: {
  readonly runId: string
  readonly principalId: string
  readonly sourceId: string
  readonly assetId: string
  readonly acquisitionEventId: string
  readonly dispositionEventId: string
  readonly occurredAt: Date
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db.insert(schema.calculationRunCustodyUnits).values({
      runId,
      principalId,
      custodyUnitId: sourceId,
    })
    yield* db.insert(schema.calculationRunCustodyUnitSources).values({
      runId,
      principalId,
      custodyUnitId: sourceId,
      sourceId,
    })
    yield* db.insert(schema.calculationRunAllocations).values({
      runId,
      principalId,
      sequence: 0,
      acquisitionEventId,
      dispositionEventId,
      assetId,
      custodyUnitId: sourceId,
      acquiredAt: occurredAt,
      disposedAt: occurredAt,
      quantity: "0.25",
      costBasis: "25",
    })
    yield* db.insert(schema.calculationRunRealizedResults).values({
      runId,
      sequence: 0,
      sourceId,
      allocationSequence: 0,
      acquisitionEventId,
      dispositionEventId,
      assetId,
      acquiredAt: occurredAt,
      disposedAt: occurredAt,
      quantity: "0.25",
      costBasis: "25",
      proceeds: "30",
      gainLoss: "5",
      treatmentCodes: ["de.taxable_private_disposal"],
    })
    yield* db.insert(schema.calculationRunIncomeResults).values({
      runId,
      sequence: 0,
      sourceId,
      eventId: acquisitionEventId,
      assetId,
      occurredAt,
      quantity: "1",
      value: "100",
      treatmentCodes: ["de.taxable_income_section22_3_staking"],
    })
    yield* db.insert(schema.calculationRunDerivedLots).values({
      runId,
      principalId,
      sequence: 0,
      acquisitionEventId,
      assetId,
      custodyUnitId: sourceId,
      acquiredAt: occurredAt,
      remainingQuantity: "0.75",
      costBasisPerUnit: "100",
    })
    yield* db.insert(schema.calculationRunBlockers).values({
      runId,
      principalId,
      sequence: 0,
      code: "missing_valuation",
      eventId: acquisitionEventId,
      assetId,
      custodyUnitId: sourceId,
      missingQuantity: null,
    })
    yield* db.insert(schema.calculationRunExplanationEntries).values({
      runId,
      sequence: 0,
      eventId: acquisitionEventId,
      code: "valuation_selected",
      valuationKind: "observed_consideration",
      matches: [],
    })
  })

const CLAIM_REPORTING_CURRENCY = CurrencyCode.make("EUR")

const makeClaimRaceResult = (taxYear: number): TaxAccountingResult => ({
  status: "complete",
  jurisdiction: JurisdictionCode.make("DE"),
  taxYear: TaxYear.make(taxYear),
  engineVersion: "test-engine-v1",
  ruleSetVersion: "test-rules-v1",
  accountingMethod: AccountingMethodId.make("fifo"),
  inventoryScope: "per_custody_unit",
  appliedChoiceIds: [],
  appliedRules: [],
  processedEventIds: [],
  allocations: [],
  realizedResults: [],
  incomeResults: [],
  derivedLots: [],
  blockers: [],
  explanationTrace: [],
})

const captureClaimInputLedgerRevision = ({
  principalId,
  visibleTransactionId,
}: {
  readonly principalId: string
  readonly visibleTransactionId?: string
}) =>
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
          .where(eq(schema.principals.id, principalId))
          .limit(1)

        if (snapshot === undefined) {
          return yield* Effect.die("Failed to capture claim race snapshot")
        }

        if (visibleTransactionId !== undefined) {
          const [visibleFact] = yield* tx
            .select({ principalId: schema.transactions.principalId })
            .from(schema.transactions)
            .where(eq(schema.transactions.id, visibleTransactionId))

          if (visibleFact?.principalId !== principalId) {
            return yield* Effect.die("Claim overlap snapshot did not see the anonymous fact")
          }
        }

        return InputLedgerRevision.make(
          `v2:${snapshot.transactionId}:${snapshot.visibility}:${"a".repeat(64)}`
        )
      })
    )
  })

const installClaimPointerPause = Effect.gen(function* () {
  const db = yield* drizzle
  yield* db.execute(sql`
    create function pause_claim_pointer_fence() returns trigger as $$
    begin
      if new.run_id is null then
        perform pg_advisory_xact_lock(hashtextextended('test:claim-pointer', 0));
      end if;
      return new;
    end;
    $$ language plpgsql
  `)
  yield* db.execute(sql`
    create trigger pause_claim_pointer_fence
    before insert on active_calculation_runs
    for each row execute function pause_claim_pointer_fence()
  `)
})

const removeClaimPointerPause = Effect.gen(function* () {
  const db = yield* drizzle
  yield* db.execute(sql`drop trigger pause_claim_pointer_fence on active_calculation_runs`)
  yield* db.execute(sql`drop function pause_claim_pointer_fence()`)
})

const startClaimRaceRun = ({
  inputLedgerRevision,
  principalId,
  runId,
  sourceId,
  taxYear,
}: {
  readonly inputLedgerRevision: InputLedgerRevision
  readonly principalId: string
  readonly runId: string
  readonly sourceId: string | null
  readonly taxYear: number
}) =>
  Effect.flatMap(CalculationRunRepository, (repository) =>
    repository.start({
      correctionInputs: [],
      id: CalculationRunId.make(runId),
      principalId: PrincipalId.make(principalId),
      jurisdiction: JurisdictionCode.make("DE"),
      taxYear: TaxYear.make(taxYear),
      reportingCurrency: CLAIM_REPORTING_CURRENCY,
      engineVersion: "test-engine-v1",
      ruleSetVersion: "test-rules-v1",
      inputLedgerRevision,
      valuationRevision: ValuationRevision.make(`sha256:${"b".repeat(64)}`),
      custodyUnitMembership:
        sourceId === null
          ? []
          : [
              {
                sourceId: SourceId.make(sourceId),
                custodyUnitId: CustodyUnitId.make(sourceId),
              },
            ],
    })
  )

const persistClaimRaceRun = ({
  inputLedgerRevision,
  principalId,
  runId,
  taxYear,
}: {
  readonly inputLedgerRevision: InputLedgerRevision
  readonly principalId: string
  readonly runId: string
  readonly taxYear: number
}) =>
  Effect.flatMap(CalculationRunRepository, (repository) =>
    repository.persist({
      correctionInputs: [],
      id: CalculationRunId.make(runId),
      principalId: PrincipalId.make(principalId),
      reportingCurrency: CLAIM_REPORTING_CURRENCY,
      inputLedgerRevision,
      valuationRevision: ValuationRevision.make(`sha256:${"b".repeat(64)}`),
      result: makeClaimRaceResult(taxYear),
    })
  )

const assertClaimActivationFence = ({
  anonymousPrincipalId,
  fenceAtOrBelowInput = false,
  inputLedgerRevision,
  runId,
  taxYear,
}: {
  readonly anonymousPrincipalId: string
  readonly fenceAtOrBelowInput?: boolean
  readonly inputLedgerRevision: InputLedgerRevision
  readonly runId: string
  readonly taxYear: number
}) =>
  Effect.gen(function* () {
    const write = yield* persistClaimRaceRun({
      inputLedgerRevision,
      principalId: anonymousPrincipalId,
      runId,
      taxYear,
    })
    expect(write.activated).toBe(false)

    const db = yield* drizzle
    const [staleRun] = yield* db
      .select({ status: schema.calculationRuns.status })
      .from(schema.calculationRuns)
      .where(eq(schema.calculationRuns.id, runId))
    const [fencedPointer] = yield* db
      .select({
        runId: schema.activeCalculationRuns.runId,
        minimumActivationRevision: schema.activeCalculationRuns.minimumActivationRevision,
      })
      .from(schema.activeCalculationRuns)
      .where(
        and(
          eq(schema.activeCalculationRuns.principalId, anonymousPrincipalId),
          eq(schema.activeCalculationRuns.jurisdiction, "DE"),
          eq(schema.activeCalculationRuns.taxYear, taxYear),
          eq(schema.activeCalculationRuns.reportingCurrency, "EUR")
        )
      )

    expect(staleRun).toEqual({ status: "complete" })
    expect(fencedPointer?.runId).toBeNull()
    const fenceRevision = BigInt(fencedPointer?.minimumActivationRevision ?? "0")
    const inputRevision = BigInt(inputLedgerRevision.split(":")[1] ?? "0")
    if (fenceAtOrBelowInput) {
      expect(fenceRevision).toBeLessThanOrEqual(inputRevision)
    } else {
      expect(fenceRevision).toBeGreaterThan(inputRevision)
    }

    const postFenceRevision = yield* captureClaimInputLedgerRevision({
      principalId: anonymousPrincipalId,
    })
    const freshRunId = nextTestUuid()
    const freshWrite = yield* persistClaimRaceRun({
      inputLedgerRevision: postFenceRevision,
      principalId: anonymousPrincipalId,
      runId: freshRunId,
      taxYear,
    })
    expect(freshWrite.activated).toBe(true)

    const [activatedPointer] = yield* db
      .select({
        runId: schema.activeCalculationRuns.runId,
        minimumActivationRevision: schema.activeCalculationRuns.minimumActivationRevision,
      })
      .from(schema.activeCalculationRuns)
      .where(
        and(
          eq(schema.activeCalculationRuns.principalId, anonymousPrincipalId),
          eq(schema.activeCalculationRuns.jurisdiction, "DE"),
          eq(schema.activeCalculationRuns.taxYear, taxYear),
          eq(schema.activeCalculationRuns.reportingCurrency, "EUR")
        )
      )

    expect(activatedPointer).toEqual({
      runId: freshRunId,
      minimumActivationRevision: fencedPointer?.minimumActivationRevision,
    })
  })

const seedClaimFactualRows = ({
  acquisitionEventId,
  anonymousPrincipalId,
  assetId,
  occurredAt,
  sourceId,
  transactionId,
}: {
  readonly acquisitionEventId: string
  readonly anonymousPrincipalId: string
  readonly assetId: string
  readonly occurredAt: Date
  readonly sourceId: string
  readonly transactionId: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    yield* db.insert(schema.assets).values({
      id: assetId,
      name: "Claim graph asset",
      symbol: "CGA",
    })
    yield* db.insert(schema.transactions).values({
      id: transactionId,
      sourceId,
      principalId: anonymousPrincipalId,
      externalId: `claim-graph-${transactionId}`,
      timestamp: occurredAt,
      transactionType: "buy_fiat",
    })
    yield* db.insert(schema.transactionLegs).values(
      yield* prepareMovementLegFixtures([
        {
          movementIdentity: {
            sourceRecordKey: "claim-graph-record",
            componentKey: "movement",
          },
          id: acquisitionEventId,
          sourceId,
          principalId: anonymousPrincipalId,
          transactionId,
          externalId: `claim-graph-leg-${acquisitionEventId}`,
          timestamp: occurredAt,
          assetId,
          amount: "1",
          kind: "acquisition",
          provenance: "deterministic",
          originKind: "none" as const,
        },
      ])
    )
  })

const seedClaimRunHistory = ({
  acquisitionEventId,
  anonymousPrincipalId,
  anonymousRunIds,
  completedAt,
  targetPrincipalId,
  targetRunIds,
  taxYear,
}: {
  readonly acquisitionEventId: string
  readonly anonymousPrincipalId: string
  readonly anonymousRunIds: ReadonlyArray<string>
  readonly completedAt: Date
  readonly targetPrincipalId: string
  readonly targetRunIds: ReadonlyArray<string>
  readonly taxYear: number
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [firstAnonymousRunId, secondAnonymousRunId] = anonymousRunIds
    if (firstAnonymousRunId === undefined || secondAnonymousRunId === undefined) {
      return yield* Effect.die("Claim graph fixture requires two anonymous runs")
    }

    yield* db.insert(schema.calculationRuns).values([
      {
        id: firstAnonymousRunId,
        principalId: anonymousPrincipalId,
        jurisdiction: "DE",
        taxYear,
        reportingCurrency: "EUR",
        engineVersion: "test-engine-v1",
        ruleSetVersion: "test-rules-v1",
        inputLedgerRevision: `v2:1:1.0.:${"a".repeat(64)}`,
        valuationRevision: `sha256:${"b".repeat(64)}`,
        status: "complete" as const,
        accountingMethod: "fifo",
        inventoryScope: "per_custody_unit" as const,
        appliedChoiceIds: [],
        appliedRules: [],
        processedEventIds: [],
        startedAt: completedAt,
        completedAt,
      },
      {
        id: secondAnonymousRunId,
        principalId: anonymousPrincipalId,
        jurisdiction: "DE",
        taxYear,
        reportingCurrency: "EUR",
        engineVersion: "test-engine-v1",
        ruleSetVersion: "test-rules-v1",
        inputLedgerRevision: `v2:2:1.0.:${"c".repeat(64)}`,
        valuationRevision: `sha256:${"d".repeat(64)}`,
        status: "partial" as const,
        accountingMethod: "fifo",
        inventoryScope: "per_custody_unit" as const,
        appliedChoiceIds: [],
        appliedRules: [],
        processedEventIds: [acquisitionEventId],
        startedAt: completedAt,
        completedAt,
      },
      ...targetRunIds.map((id, index) => ({
        id,
        principalId: targetPrincipalId,
        jurisdiction: "DE",
        taxYear,
        reportingCurrency: "EUR",
        engineVersion: "test-engine-v1",
        ruleSetVersion: "test-rules-v1",
        inputLedgerRevision: `sha256:${index}:${"e".repeat(64)}`,
        valuationRevision: `sha256:${"f".repeat(64)}`,
        status: "complete" as const,
        accountingMethod: "fifo",
        inventoryScope: "per_custody_unit" as const,
        appliedChoiceIds: [],
        appliedRules: [],
        processedEventIds: [],
        startedAt: completedAt,
        completedAt,
      })),
    ])
  })

const seedClaimActivePointers = ({
  anonymousPrincipalId,
  anonymousRunId,
  targetPrincipalId,
  targetRunId,
  taxYear,
}: {
  readonly anonymousPrincipalId: string
  readonly anonymousRunId: string
  readonly targetPrincipalId: string
  readonly targetRunId: string
  readonly taxYear: number
}) =>
  Effect.flatMap(drizzle, (db) =>
    db.insert(schema.activeCalculationRuns).values([
      {
        principalId: anonymousPrincipalId,
        jurisdiction: "DE",
        taxYear,
        reportingCurrency: "EUR",
        runId: anonymousRunId,
      },
      {
        principalId: targetPrincipalId,
        jurisdiction: "DE",
        taxYear,
        reportingCurrency: "EUR",
        runId: targetRunId,
      },
    ])
  )

const loadClaimMovementLinks = (sourceId: string) =>
  Effect.flatMap(drizzle, (db) =>
    db
      .select({
        legId: schema.transactionLegs.id,
        targetId: schema.movementCorrectionTargets.id,
        sourceRecordKey: schema.movementCorrectionTargets.sourceRecordKey,
        componentKey: schema.movementCorrectionTargets.componentKey,
        legPrincipalId: schema.transactionLegs.principalId,
        targetPrincipalId: schema.movementCorrectionTargets.principalId,
        sourcePrincipalId: schema.sources.principalId,
      })
      .from(schema.transactionLegs)
      .innerJoin(
        schema.movementCorrectionTargets,
        eq(schema.movementCorrectionTargets.id, schema.transactionLegs.movementCorrectionTargetId)
      )
      .innerJoin(schema.sources, eq(schema.sources.id, schema.transactionLegs.sourceId))
      .where(eq(schema.transactionLegs.sourceId, sourceId))
      .orderBy(schema.transactionLegs.id)
  )

const assertClaimMovementOwnership = ({
  sourceId,
  anonymousPrincipalId,
  principalId,
  before,
}: {
  readonly sourceId: string
  readonly anonymousPrincipalId: string
  readonly principalId: string
  readonly before: Effect.Success<ReturnType<typeof loadClaimMovementLinks>>
}) =>
  Effect.gen(function* () {
    expect(before).toHaveLength(1)
    expect(before[0]).toMatchObject({
      legPrincipalId: anonymousPrincipalId,
      targetPrincipalId: anonymousPrincipalId,
      sourcePrincipalId: anonymousPrincipalId,
    })
    const after = yield* loadClaimMovementLinks(sourceId)
    expect(after).toEqual(
      before.map((link) => ({
        ...link,
        legPrincipalId: principalId,
        targetPrincipalId: principalId,
        sourcePrincipalId: principalId,
      }))
    )
    const db = yield* drizzle
    const oldPrincipalTargets = yield* db
      .select({ id: schema.movementCorrectionTargets.id })
      .from(schema.movementCorrectionTargets)
      .where(
        and(
          eq(schema.movementCorrectionTargets.sourceId, sourceId),
          eq(schema.movementCorrectionTargets.principalId, anonymousPrincipalId)
        )
      )
    const oldPrincipalLegs = yield* db
      .select({ id: schema.transactionLegs.id })
      .from(schema.transactionLegs)
      .where(
        and(
          eq(schema.transactionLegs.sourceId, sourceId),
          eq(schema.transactionLegs.principalId, anonymousPrincipalId)
        )
      )
    expect(oldPrincipalTargets).toEqual([])
    expect(oldPrincipalLegs).toEqual([])
  })

const seedClaimCalculationGraph = ({
  anonymousPrincipalId,
  sourceId,
  targetPrincipalId,
}: {
  readonly anonymousPrincipalId: string
  readonly sourceId: string
  readonly targetPrincipalId: string
}) =>
  Effect.gen(function* () {
    const anonymousRunIds = [nextTestUuid(), nextTestUuid()]
    const targetRunIds = [nextTestUuid(), nextTestUuid()]
    const [firstAnonymousRunId, secondAnonymousRunId] = anonymousRunIds
    const [, secondTargetRunId] = targetRunIds
    if (
      firstAnonymousRunId === undefined ||
      secondAnonymousRunId === undefined ||
      secondTargetRunId === undefined
    ) {
      return yield* Effect.die("Claim graph fixture requires two anonymous and target runs")
    }
    const assetId = nextTestUuid()
    const transactionId = nextTestUuid()
    const acquisitionEventId = nextTestUuid()
    const dispositionEventId = nextTestUuid()
    const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-01T12:00:00.000Z"))
    const completedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:10:00.000Z"))
    const taxYear = yield* DateTime.now.pipe(
      Effect.map(DateTime.setZoneNamedUnsafe("Europe/Berlin")),
      Effect.map(DateTime.toParts),
      Effect.map(({ year }) => year)
    )

    yield* seedClaimFactualRows({
      acquisitionEventId,
      anonymousPrincipalId,
      assetId,
      occurredAt,
      sourceId,
      transactionId,
    })
    yield* seedClaimRunHistory({
      acquisitionEventId,
      anonymousPrincipalId,
      anonymousRunIds,
      completedAt,
      targetPrincipalId,
      targetRunIds,
      taxYear,
    })
    yield* seedClaimActivePointers({
      anonymousPrincipalId,
      anonymousRunId: secondAnonymousRunId,
      targetPrincipalId,
      targetRunId: secondTargetRunId,
      taxYear,
    })

    yield* seedClaimCalculationResultRows({
      runId: secondAnonymousRunId,
      principalId: anonymousPrincipalId,
      sourceId,
      assetId,
      acquisitionEventId,
      dispositionEventId,
      occurredAt,
    })

    return {
      anonymousRunIds,
      targetRunIds,
      transactionId,
      acquisitionEventId,
      taxYear,
    }
  })

const assertAnonymousClaimRunRowsDeleted = ({
  anonymousRunIds,
}: {
  readonly anonymousRunIds: ReadonlyArray<string>
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [firstAnonymousRunId, secondAnonymousRunId] = anonymousRunIds
    if (firstAnonymousRunId === undefined || secondAnonymousRunId === undefined) {
      return yield* Effect.die("Claim graph fixture requires two anonymous runs")
    }
    type RunIdColumn =
      | typeof schema.calculationRuns.id
      | typeof schema.activeCalculationRuns.runId
      | typeof schema.calculationRunCustodyUnits.runId
      | typeof schema.calculationRunCustodyUnitSources.runId
      | typeof schema.calculationRunAllocations.runId
      | typeof schema.calculationRunRealizedResults.runId
      | typeof schema.calculationRunIncomeResults.runId
      | typeof schema.calculationRunDerivedLots.runId
      | typeof schema.calculationRunBlockers.runId
      | typeof schema.calculationRunExplanationEntries.runId
    const isAnonymousRun = (column: RunIdColumn) =>
      sql`${column} = ${firstAnonymousRunId} or ${column} = ${secondAnonymousRunId}`

    const [
      anonymousRuns,
      anonymousPointers,
      anonymousCustodyUnits,
      anonymousCustodySources,
      anonymousAllocations,
      anonymousRealized,
      anonymousIncome,
      anonymousLots,
      anonymousBlockers,
      anonymousExplanations,
    ] = yield* Effect.all([
      db
        .select({ runId: schema.calculationRuns.id })
        .from(schema.calculationRuns)
        .where(isAnonymousRun(schema.calculationRuns.id)),
      db
        .select({ runId: schema.activeCalculationRuns.runId })
        .from(schema.activeCalculationRuns)
        .where(isAnonymousRun(schema.activeCalculationRuns.runId)),
      db
        .select({ runId: schema.calculationRunCustodyUnits.runId })
        .from(schema.calculationRunCustodyUnits)
        .where(isAnonymousRun(schema.calculationRunCustodyUnits.runId)),
      db
        .select({ runId: schema.calculationRunCustodyUnitSources.runId })
        .from(schema.calculationRunCustodyUnitSources)
        .where(isAnonymousRun(schema.calculationRunCustodyUnitSources.runId)),
      db
        .select({ runId: schema.calculationRunAllocations.runId })
        .from(schema.calculationRunAllocations)
        .where(isAnonymousRun(schema.calculationRunAllocations.runId)),
      db
        .select({ runId: schema.calculationRunRealizedResults.runId })
        .from(schema.calculationRunRealizedResults)
        .where(isAnonymousRun(schema.calculationRunRealizedResults.runId)),
      db
        .select({ runId: schema.calculationRunIncomeResults.runId })
        .from(schema.calculationRunIncomeResults)
        .where(isAnonymousRun(schema.calculationRunIncomeResults.runId)),
      db
        .select({ runId: schema.calculationRunDerivedLots.runId })
        .from(schema.calculationRunDerivedLots)
        .where(isAnonymousRun(schema.calculationRunDerivedLots.runId)),
      db
        .select({ runId: schema.calculationRunBlockers.runId })
        .from(schema.calculationRunBlockers)
        .where(isAnonymousRun(schema.calculationRunBlockers.runId)),
      db
        .select({ runId: schema.calculationRunExplanationEntries.runId })
        .from(schema.calculationRunExplanationEntries)
        .where(isAnonymousRun(schema.calculationRunExplanationEntries.runId)),
    ])

    for (const rows of [
      anonymousRuns,
      anonymousPointers,
      anonymousCustodyUnits,
      anonymousCustodySources,
      anonymousAllocations,
      anonymousRealized,
      anonymousIncome,
      anonymousLots,
      anonymousBlockers,
      anonymousExplanations,
    ]) {
      expect(rows).toEqual([])
    }
  })

const assertClaimPointerFenced = ({
  anonymousPrincipalId,
  taxYear,
}: {
  readonly anonymousPrincipalId: string
  readonly taxYear: number
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [anonymousPointer] = yield* db
      .select({
        runId: schema.activeCalculationRuns.runId,
        minimumActivationRevision: schema.activeCalculationRuns.minimumActivationRevision,
      })
      .from(schema.activeCalculationRuns)
      .where(
        and(
          eq(schema.activeCalculationRuns.principalId, anonymousPrincipalId),
          eq(schema.activeCalculationRuns.jurisdiction, "DE"),
          eq(schema.activeCalculationRuns.taxYear, taxYear),
          eq(schema.activeCalculationRuns.reportingCurrency, "EUR")
        )
      )

    expect(anonymousPointer).toEqual({
      runId: null,
      minimumActivationRevision: expect.stringMatching(/^\d+$/),
    })
  })

const assertClaimTargetPreserved = ({
  acquisitionEventId,
  targetPrincipalId,
  targetRunIds,
  transactionId,
}: {
  readonly acquisitionEventId: string
  readonly targetPrincipalId: string
  readonly targetRunIds: ReadonlyArray<string>
  readonly transactionId: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [firstTargetRunId, secondTargetRunId] = targetRunIds
    if (firstTargetRunId === undefined || secondTargetRunId === undefined) {
      return yield* Effect.die("Claim graph fixture requires two target runs")
    }

    const targetRuns = yield* db
      .select({ id: schema.calculationRuns.id, principalId: schema.calculationRuns.principalId })
      .from(schema.calculationRuns)
      .where(
        sql`${schema.calculationRuns.id} = ${firstTargetRunId} or ${schema.calculationRuns.id} = ${secondTargetRunId}`
      )
    const [targetPointer] = yield* db
      .select({ runId: schema.activeCalculationRuns.runId })
      .from(schema.activeCalculationRuns)
      .where(eq(schema.activeCalculationRuns.principalId, targetPrincipalId))
    const [claimedTransaction] = yield* db
      .select({ principalId: schema.transactions.principalId })
      .from(schema.transactions)
      .where(eq(schema.transactions.id, transactionId))
    const [claimedLeg] = yield* db
      .select({ principalId: schema.transactionLegs.principalId })
      .from(schema.transactionLegs)
      .where(eq(schema.transactionLegs.id, acquisitionEventId))

    expect(targetRuns).toEqual(
      expect.arrayContaining(
        targetRunIds.map((id) => ({
          id,
          principalId: targetPrincipalId,
        }))
      )
    )
    expect(targetRuns).toHaveLength(targetRunIds.length)
    expect(targetPointer).toEqual({ runId: secondTargetRunId })
    expect(claimedTransaction).toEqual({ principalId: targetPrincipalId })
    expect(claimedLeg).toEqual({ principalId: targetPrincipalId })
  })

const assertClaimCalculationGraphDeleted = ({
  anonymousPrincipalId,
  anonymousRunIds,
  targetRunIds,
  targetPrincipalId,
  taxYear,
  transactionId,
  acquisitionEventId,
}: {
  readonly anonymousPrincipalId: string
  readonly anonymousRunIds: ReadonlyArray<string>
  readonly targetRunIds: ReadonlyArray<string>
  readonly targetPrincipalId: string
  readonly taxYear: number
  readonly transactionId: string
  readonly acquisitionEventId: string
}) =>
  Effect.all([
    assertAnonymousClaimRunRowsDeleted({ anonymousRunIds }),
    assertClaimPointerFenced({ anonymousPrincipalId, taxYear }),
    assertClaimTargetPreserved({
      acquisitionEventId,
      targetPrincipalId,
      targetRunIds,
      transactionId,
    }),
  ])

const seedSourceReportTaxTreatmentRows = ({
  principalId,
  sourceId,
}: {
  readonly principalId: string
  readonly sourceId: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db.insert(schema.transactions).values([
      {
        id: reportFixtureIds.feeTransactionId,
        sourceId,
        principalId,
        externalId: "report-fee-1",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T12:00:00.000Z")),
        transactionType: "gas_fee",
        providerTransactionType: "fee",
        providerStatus: "completed",
        providerDescription: "Network fee",
      },
      {
        id: reportFixtureIds.internalTransferTransactionId,
        sourceId,
        principalId,
        externalId: "report-transfer-1",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-11T12:00:00.000Z")),
        transactionType: "sell_fiat",
        providerTransactionType: "send",
        providerStatus: "completed",
        providerDescription: "Internal transfer out",
      },
      {
        id: reportFixtureIds.internalTransferInTransactionId,
        sourceId,
        principalId,
        externalId: "report-transfer-2",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-12T12:00:00.000Z")),
        transactionType: "buy_fiat",
        providerTransactionType: "receive",
        providerStatus: "completed",
        providerDescription: "Internal transfer in",
      },
    ])

    yield* db.insert(schema.transactionLegs).values(
      yield* prepareMovementLegFixtures([
        {
          movementIdentity: { sourceRecordKey: "report-fee-1:fee", componentKey: "movement" },
          id: reportFixtureIds.feeLegId,
          sourceId,
          principalId,
          externalId: "report-fee-1:fee",
          timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T12:00:00.000Z")),
          assetId: TEST_BTC_ASSET_ID,
          amount: "0.01",
          kind: "fee",
          provenance: "deterministic",
          originKind: "none" as const,
          derivationRule: "gas_fee",
          transactionId: reportFixtureIds.feeTransactionId,
          fiatAmount: "2",
          fiatCurrency: "EUR",
        },
        {
          movementIdentity: {
            sourceRecordKey: "report-transfer-1:internal_transfer_out",
            componentKey: "movement",
          },
          id: reportFixtureIds.internalTransferLegId,
          sourceId,
          principalId,
          externalId: "report-transfer-1:internal_transfer_out",
          timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-11T12:00:00.000Z")),
          assetId: TEST_BTC_ASSET_ID,
          amount: "0.1",
          kind: "disposal",
          provenance: "deterministic",
          originKind: "none" as const,
          derivationRule: "internal_transfer_out",
          transactionId: reportFixtureIds.internalTransferTransactionId,
          fiatAmount: "500",
          fiatCurrency: "EUR",
        },
        {
          movementIdentity: {
            sourceRecordKey: "report-transfer-2:internal_transfer_in",
            componentKey: "movement",
          },
          id: reportFixtureIds.internalTransferInLegId,
          sourceId,
          principalId,
          externalId: "report-transfer-2:internal_transfer_in",
          timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-12T12:00:00.000Z")),
          assetId: TEST_BTC_ASSET_ID,
          amount: "0.1",
          kind: "acquisition",
          provenance: "deterministic",
          originKind: "none" as const,
          derivationRule: "internal_transfer_in",
          transactionId: reportFixtureIds.internalTransferInTransactionId,
          fiatAmount: "500",
          fiatCurrency: "EUR",
        },
      ])
    )
  })

const seedDailyQuoteMonetaryRows = ({
  principalId,
  sourceId,
}: {
  readonly principalId: string
  readonly sourceId: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const acquisitionAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-10T10:00:00.000Z"))
    const dispositionAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T10:00:00.000Z"))
    const acquisitionTransactionId = nextTestUuid()
    const dispositionTransactionId = nextTestUuid()
    const acquisitionEventId = nextTestUuid()
    const dispositionEventId = nextTestUuid()
    const [representation] = yield* db
      .select({
        blockchainId: schema.assetRepresentations.blockchainId,
        representationType: schema.assetRepresentations.type,
        contractAddress: schema.assetRepresentations.contractAddress,
        mintAddress: schema.assetRepresentations.mintAddress,
      })
      .from(schema.assetRepresentations)
      .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
    if (representation === undefined) return yield* Effect.die("Missing BTC representation")
    const [sourceUse] = yield* db
      .insert(schema.sourceRepresentationUses)
      .values({ sourceId, ...representation })
      .returning({ id: schema.sourceRepresentationUses.id })
    if (sourceUse === undefined) return yield* Effect.die("Failed to record BTC source use")

    yield* db.insert(schema.transactions).values([
      {
        id: acquisitionTransactionId,
        sourceId,
        principalId,
        externalId: "daily-quote-acquisition",
        timestamp: acquisitionAt,
        transactionType: "buy_fiat",
      },
      {
        id: dispositionTransactionId,
        sourceId,
        principalId,
        externalId: "daily-quote-disposition",
        timestamp: dispositionAt,
        transactionType: "sell_fiat",
      },
    ])
    yield* db.insert(schema.transactionLegs).values(
      yield* prepareMovementLegFixtures([
        {
          movementIdentity: {
            sourceRecordKey: "daily-quote-acquisition-leg",
            componentKey: "movement",
          },
          id: acquisitionEventId,
          sourceId,
          principalId,
          transactionId: acquisitionTransactionId,
          externalId: "daily-quote-acquisition-leg",
          timestamp: acquisitionAt,
          assetId: TEST_BTC_ASSET_ID,
          assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
          sourceRepresentationUseId: sourceUse.id,
          amount: "1",
          kind: "acquisition",
          provenance: "deterministic",
          originKind: "none" as const,
        },
        {
          movementIdentity: {
            sourceRecordKey: "daily-quote-disposition-leg",
            componentKey: "movement",
          },
          id: dispositionEventId,
          sourceId,
          principalId,
          transactionId: dispositionTransactionId,
          externalId: "daily-quote-disposition-leg",
          timestamp: dispositionAt,
          assetId: TEST_BTC_ASSET_ID,
          assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
          sourceRepresentationUseId: sourceUse.id,
          amount: "0.4",
          kind: "disposal",
          provenance: "deterministic",
          originKind: "none" as const,
        },
      ])
    )
    yield* db.insert(schema.assetPrices).values([
      {
        assetId: TEST_BTC_ASSET_ID,
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-10T00:00:00.000Z")),
        price: "100",
        currency: "EUR",
        source: "coingecko",
      },
      {
        assetId: TEST_BTC_ASSET_ID,
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-10T09:00:00.000Z")),
        price: "1000",
        currency: "EUR",
        source: "intraday-feed",
      },
      {
        assetId: TEST_BTC_ASSET_ID,
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T00:00:00.000Z")),
        price: "200",
        currency: "EUR",
        source: "coingecko",
      },
      {
        assetId: TEST_BTC_ASSET_ID,
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T09:00:00.000Z")),
        price: "2000",
        currency: "EUR",
        source: "intraday-feed",
      },
    ])

    return dispositionEventId
  })

interface EndToEndProviderEvent {
  readonly externalRecordId: string
  readonly transactionType: "buy_fiat" | "sell_fiat" | "gas_fee"
  readonly inventoryEffect: "acquisition" | "disposal"
  readonly legKind: "acquisition" | "disposal" | "fee"
  readonly amount: string
  readonly occurredAt: Date
}

const makeEndToEndProviderEvents = (taxYear: number): ReadonlyArray<EndToEndProviderEvent> => [
  {
    externalRecordId: "end-to-end-acquisition",
    transactionType: "buy_fiat",
    inventoryEffect: "acquisition",
    legKind: "acquisition",
    amount: "1",
    occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe(`${taxYear}-01-10T10:00:00.000Z`)),
  },
  {
    externalRecordId: "end-to-end-disposition",
    transactionType: "sell_fiat",
    inventoryEffect: "disposal",
    legKind: "disposal",
    amount: "0.4",
    occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe(`${taxYear}-02-10T10:00:00.000Z`)),
  },
  {
    externalRecordId: "end-to-end-fee",
    transactionType: "gas_fee",
    inventoryEffect: "disposal",
    legKind: "fee",
    amount: "0.1",
    occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe(`${taxYear}-02-11T10:00:00.000Z`)),
  },
]

const seedEndToEndDailyQuotes = (taxYear: number) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db.insert(schema.assetPrices).values([
      {
        assetId: TEST_BTC_ASSET_ID,
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe(`${taxYear}-01-10T00:00:00.000Z`)),
        price: "100",
        currency: "EUR",
        source: "coingecko",
      },
      {
        assetId: TEST_BTC_ASSET_ID,
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe(`${taxYear}-02-10T00:00:00.000Z`)),
        price: "200",
        currency: "EUR",
        source: "coingecko",
      },
      {
        assetId: TEST_BTC_ASSET_ID,
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe(`${taxYear}-02-11T00:00:00.000Z`)),
        price: "200",
        currency: "EUR",
        source: "coingecko",
      },
    ])
  })

const makeEndToEndProviderRegistryLive = (taxYear: number) => {
  const events = makeEndToEndProviderEvents(taxYear)
  const providerModule: SourceProviderModuleShape = {
    fetchRawBatch: () =>
      Effect.succeed(
        FetchProviderRawBatchResult.make({
          records: events.map((event) =>
            ProviderRawRecord.make({
              recordType: "end_to_end_transaction",
              providerKey: "coinbase",
              externalRecordId: event.externalRecordId,
              externalAccountId: "end-to-end-account",
              externalParentId: null,
              occurredAt: event.occurredAt,
              payload: { externalRecordId: event.externalRecordId },
            })
          ),
          cursorPayload: null,
          highWatermark: null,
          done: true,
        })
      ),
    refreshReferenceData: Effect.succeed({
      transactionTypeCatalogCount: 0,
      providerAssetCatalogCount: 0,
      defaultTransactionMappingCount: 0,
      defaultProviderAssetMappingCount: 0,
    }),
    refreshDefaultMappings: Effect.succeed({
      defaultTransactionMappingCount: 0,
      defaultProviderAssetMappingCount: 0,
    }),
    makeRawRecordNormalizer: Effect.succeed(({ source, sourceRecord }) => {
      const event = events.find(
        ({ externalRecordId }) => externalRecordId === sourceRecord.externalRecordId
      )
      if (event === undefined) {
        return Effect.succeed({ kind: "skipped" } as const)
      }

      return Effect.succeed({
        kind: "prepared",
        providerAssetRowIds: [],
        transaction: {
          sourceId: source.id,
          sourceRawRecordId: sourceRecord.id,
          externalId: event.externalRecordId,
          externalGroupId: null,
          timestamp: event.occurredAt,
          transactionType: event.transactionType,
          providerTransactionType: event.transactionType,
          providerStatus: "completed",
          providerResourcePath: null,
          providerDescription: null,
          providerCreatedAt: event.occurredAt,
          providerUpdatedAt: event.occurredAt,
          metadata: null,
          providerFiatAmount: null,
          providerFiatCurrency: null,
          principalId: source.principalId,
        },
        venueContext: {
          venueType: "cex",
          cexAccountId: source.cexAccountId,
          externalAccountId: "end-to-end-account",
          externalOrderId: null,
          externalFillId: null,
          side: null,
          instrument: null,
          fillPrice: null,
          commissionAmount: null,
          commissionCurrency: null,
          metadata: null,
        },
        providerTransfers: [],
        canonicalTransfers: [],
        transactionReview: null,
        resolvedTransactionType: {
          providerTransactionType: event.transactionType,
          transactionType: event.transactionType,
          inventoryEffect: event.inventoryEffect,
          taxTreatment: "requires_additional_rule_logic",
          resolutionStrategy: "static",
          pairedRecordRequired: false,
          mappingStatus: "approved",
        },
        deriveLegs: ({ transaction }) =>
          Effect.succeed([
            {
              movementIdentity: {
                _tag: "identified" as const,
                sourceRecordKey: `${event.externalRecordId}-leg`,
                componentKey: "movement",
              },
              sourceId: source.id,
              sourceRawRecordId: sourceRecord.id,
              externalId: `${event.externalRecordId}-leg`,
              txHash: null,
              timestamp: event.occurredAt,
              principalId: source.principalId,
              addressId: null,
              assetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
              amount: event.amount,
              kind: event.legKind,
              provenance: "deterministic",
              originKind: "none" as const,
              derivationRule: "end_to_end_fixture",
              metadata: null,
              transactionId: transaction.id,
              sourceTransferId: null,
              fiatAmount: null,
              fiatCurrency: null,
              feeForTransactionId: null,
            },
          ]),
      } as const)
    }),
  }

  return Layer.succeed(SourceProviderRegistry, {
    resolveProviderModule: () => Effect.succeed(providerModule),
  })
}

const SourceSyncExecutorTransferReconciliationTestLive = Layer.succeed(
  TransferReconciliationService,
  {
    reconcileTransferCandidates: () =>
      Effect.succeed({ evaluatedProviderTransfers: 0, pending: 0, needsReview: 0, autoApplied: 0 }),
    rollbackReconciliationsForSourceReplay: () => Effect.void,
    applyDeterministicInternalTransferCanonicalization: () =>
      Effect.succeed({ canonicalizedPairs: 0 }),
  } satisfies TransferReconciliationServiceShape
)

const WorkerSourceSyncStartupRepairTestLive = Layer.succeed(WorkerSourceSyncStartupRepair, {
  repair: Effect.succeed({
    scannedJobs: 0,
    requeuedPending: 0,
    failedProcessing: 0,
    skippedJobs: 0,
    erroredJobs: 0,
    stoppedAfterErrors: false,
  }),
  dispatchPending: Effect.succeed({
    scannedJobs: 0,
    requeuedPending: 0,
    failedProcessing: 0,
    skippedJobs: 0,
    erroredJobs: 0,
    stoppedAfterErrors: false,
  }),
  dispatchFollowUp: () => Effect.void,
})

const EndToEndWorkerConfigProvider = ConfigProvider.fromEnvRecord({
  QUEUE_REDIS_URL: "redis://localhost:6379",
  SOURCE_SYNC_QUEUE_PREFIX: "end-to-end",
  SOURCE_SYNC_PENDING_DISPATCH_INTERVAL_MS: "60000",
  SYNC_WORKER_CONCURRENCY: "1",
  SYNC_WORKER_LOCK_DURATION_MS: "30000",
  SOURCE_SYNC_HEARTBEAT_INTERVAL_MS: "60000",
  WORKER_ID: "end-to-end-worker",
})

const runEndToEndSourceSync = ({
  calculationQueue,
  payload,
  taxYear,
}: {
  readonly calculationQueue: CalculationRecomputeQueueShape
  readonly payload: SourceSyncQueuePayload
  readonly taxYear: number
}) => {
  let processor: WorkerBullMqSourceSyncProcessor | null = null
  const executorLayer = SourceSyncJobExecutorLive.pipe(
    Layer.provide(makeEndToEndProviderRegistryLive(taxYear)),
    Layer.provide(SourceSyncExecutorTransferReconciliationTestLive),
    Layer.provide(RepositoriesLive),
    Layer.provide(TestPgClientLive),
    Layer.provide(ConfigProvider.layer(EndToEndWorkerConfigProvider))
  )
  const workerLayer = makeWorkerBullMqSourceSyncConsumerLive({
    acquireWorker: (_config, acquiredProcessor) =>
      Effect.sync(() => {
        processor = acquiredProcessor
        return { close: Effect.void }
      }),
  }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        executorLayer,
        WorkerSourceSyncStartupRepairTestLive,
        Layer.succeed(CalculationRecomputeQueue, calculationQueue)
      )
    ),
    Layer.provide(ConfigProvider.layer(EndToEndWorkerConfigProvider))
  )

  return Effect.scoped(
    Effect.gen(function* () {
      if (processor === null) {
        return yield* Effect.die("Source sync worker processor was not acquired")
      }
      const acquiredProcessor = processor

      return yield* Effect.promise(() =>
        acquiredProcessor({
          id: payload.jobId,
          name: SOURCE_SYNC_JOB_NAME,
          data: payload,
          attemptsMade: 0,
          opts: { attempts: 1, backoff: 1 },
        })
      )
    }).pipe(Effect.provide(workerLayer))
  )
}

await Effect.runPromise(context.recreateTestDatabase())

describe("SourcesApiLive", () => {
  beforeEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        queueEvents.length = 0
        calculationQueueEvents.length = 0
        settlementEvents.length = 0
        yield* context.recreateTestDatabase()
      })
    )
  )

  it.effect("serves monetary results from exact stored daily EUR quotes", () =>
    Effect.gen(function* () {
      const fixture = yield* seedSyncEngineRepositoryFixture({
        userId: nextTestUuid(),
        principalId: nextTestUuid(),
        sourceId: nextTestUuid(),
      })
      yield* seedSyncEngineAssets({
        baseBlockchainId: fixture.baseBlockchainId,
        bitcoinBlockchainId: fixture.bitcoinBlockchainId,
      })
      const dispositionEventId = yield* seedDailyQuoteMonetaryRows({
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
      })

      yield* Effect.flatMap(CalculationRunService, (service) =>
        service.recompute({
          id: CalculationRunId.make(nextTestUuid()),
          principalId: PrincipalId.make(fixture.principalId),
          jurisdiction: JurisdictionCode.make("DE"),
          taxYear: TaxYear.make(2025),
          reportingCurrency: EUR,
          accountingChoices: [],
        })
      ).pipe(Effect.provide(CalculationRunServiceTestLive))

      const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
      const tax = yield* client.sources.calculateTaxForSource({
        params: { sourceId: fixture.sourceId },
        payload: { year: 2025, jurisdiction: "germany" },
      })
      const taxEvents = yield* client.sources.listSourceTaxEvents({
        params: { sourceId: fixture.sourceId },
        query: { limit: 10 },
      })

      expect(tax).toMatchObject({ taxableGains: 40, taxableLosses: 0, incomeTotal: 0 })
      expect(taxEvents.taxEvents.find(({ legId }) => legId === dispositionEventId)).toMatchObject({
        legId: dispositionEventId,
        costBasis: "40",
        proceeds: "80",
        gainLoss: "40",
        treatmentCodes: ["de.taxable_private_disposal"],
      })
    }).pipe(Effect.provide(TaxCalculationHttpLive), Effect.scoped)
  )

  it.effect("serves one completed source sync through its partial calculation run", () =>
    Effect.gen(function* () {
      const fixture = yield* seedSyncEngineRepositoryFixture({
        userId: nextTestUuid(),
        principalId: nextTestUuid(),
        sourceId: nextTestUuid(),
      })
      yield* seedSyncEngineAssets({
        baseBlockchainId: fixture.baseBlockchainId,
        bitcoinBlockchainId: fixture.bitcoinBlockchainId,
      })

      const taxYear = yield* DateTime.now.pipe(
        Effect.map(DateTime.setZoneNamedUnsafe("Europe/Berlin")),
        Effect.map(DateTime.toParts),
        Effect.map(({ year }) => year)
      )
      yield* seedEndToEndDailyQuotes(taxYear)

      const db = yield* drizzle
      yield* db
        .update(schema.assets)
        .set({ coingeckoCoinId: null })
        .where(eq(schema.assets.id, TEST_BTC_ASSET_ID))

      const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
      const sync = yield* client.sources.startSourceSyncJob({
        params: { sourceId: fixture.sourceId },
      })
      const calculationRunId = CalculationRunId.make(nextTestUuid())
      const calculationQueue = CalculationRecomputeQueue.of({
        enqueuePrincipalRecompute: (principalId) =>
          Effect.gen(function* () {
            calculationQueueEvents.push(principalId)
            yield* Effect.flatMap(CalculationRunService, (service) =>
              service.recompute({
                id: calculationRunId,
                principalId: PrincipalId.make(principalId),
                jurisdiction: JurisdictionCode.make("DE"),
                taxYear: TaxYear.make(taxYear),
                reportingCurrency: EUR,
                accountingChoices: [],
              })
            ).pipe(Effect.provide(CalculationRunServiceTestLive))
          }).pipe(
            Effect.mapError(
              (cause) =>
                new CalculationRecomputeQueueError({
                  operation: "endToEndCalculationQueue.recompute",
                  cause,
                })
            )
          ),
      })
      const payload = queueEvents[0]
      if (payload === undefined) {
        return yield* Effect.die("Source sync was not queued")
      }
      const sourceResult = yield* runEndToEndSourceSync({
        calculationQueue,
        payload,
        taxYear,
      })

      const [dispositionEvent] = yield* db
        .select({ id: schema.transactionLegs.id })
        .from(schema.transactionLegs)
        .where(eq(schema.transactionLegs.externalId, "end-to-end-disposition-leg"))
        .limit(1)
      if (dispositionEvent === undefined) {
        return yield* Effect.die("Source sync did not persist the disposition event")
      }

      const syncStatus = yield* client.sources.getSourceSyncJobStatus({
        params: { sourceId: fixture.sourceId, jobId: sync.jobId },
      })
      const portfolioResponse = yield* HttpClientRequest.get("/v1/portfolio/assets").pipe(
        HttpClientRequest.bearerToken(`user_${fixture.userId}_admin`),
        HttpClient.execute
      )
      const portfolio = yield* portfolioResponse.json
      const report = yield* client.sources.listSourceTaxEvents({
        params: { sourceId: fixture.sourceId },
        query: { limit: 10 },
      })

      expect(syncStatus.status).toBe("completed")
      expect(sourceResult.status).toBe("completed")
      expect(calculationQueueEvents).toEqual([fixture.principalId])
      expect(portfolio).toMatchObject({
        activeRun: {
          runId: calculationRunId,
          status: "partial",
          blockerCounts: [{ code: "de.fee_allocation_required", count: 1 }],
        },
        assets: [{ assetId: TEST_BTC_ASSET_ID, amount: "0.5" }],
      })
      expect(report.calculationRunId).toBe(calculationRunId)
      expect(report.taxEvents.find(({ legId }) => legId === dispositionEvent.id)).toMatchObject({
        costBasis: "40",
        proceeds: "80",
        gainLoss: "40",
        treatmentCodes: ["de.taxable_private_disposal"],
      })
    }).pipe(Effect.provide(TaxCalculationHttpLive), Effect.scoped)
  )

  it.effect("reads tax and report results from one named active calculation run", () =>
    Effect.gen(function* () {
      const fixture = yield* seedSyncEngineRepositoryFixture(REPORT_TEST_FIXTURE)
      yield* seedSyncEngineAssets({
        baseBlockchainId: fixture.baseBlockchainId,
        bitcoinBlockchainId: fixture.bitcoinBlockchainId,
      })
      yield* seedSourceReportRows({
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
      })
      yield* seedSourceReportActiveRun({
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
      })

      const db = yield* drizzle
      yield* db.insert(schema.calculationRunAllocations).values([
        {
          runId: reportFixtureIds.activeCalculationRunId,
          principalId: fixture.principalId,
          sequence: 2,
          acquisitionEventId: reportFixtureIds.acquisitionLegId,
          dispositionEventId: reportFixtureIds.taxableLossEventId,
          assetId: TEST_BTC_ASSET_ID,
          custodyUnitId: fixture.sourceId,
          acquiredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-10T12:00:00.000Z")),
          disposedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-05-10T12:00:00.000Z")),
          quantity: "0.01",
          costBasis: "300",
        },
        {
          runId: reportFixtureIds.activeCalculationRunId,
          principalId: fixture.principalId,
          sequence: 3,
          acquisitionEventId: reportFixtureIds.acquisitionLegId,
          dispositionEventId: reportFixtureIds.taxFreeLossEventId,
          assetId: TEST_BTC_ASSET_ID,
          custodyUnitId: fixture.sourceId,
          acquiredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2023-01-10T12:00:00.000Z")),
          disposedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-05-10T12:00:00.000Z")),
          quantity: "0.01",
          costBasis: "400",
        },
        {
          runId: reportFixtureIds.activeCalculationRunId,
          principalId: fixture.principalId,
          sequence: 4,
          acquisitionEventId: reportFixtureIds.acquisitionLegId,
          dispositionEventId: reportFixtureIds.unknownTreatmentEventId,
          assetId: TEST_BTC_ASSET_ID,
          custodyUnitId: fixture.sourceId,
          acquiredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-10T12:00:00.000Z")),
          disposedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-05-10T12:00:00.000Z")),
          quantity: "0.01",
          costBasis: "100",
        },
      ])
      yield* db.insert(schema.calculationRunRealizedResults).values([
        {
          runId: reportFixtureIds.activeCalculationRunId,
          sequence: 2,
          sourceId: fixture.sourceId,
          allocationSequence: 2,
          acquisitionEventId: reportFixtureIds.acquisitionLegId,
          dispositionEventId: reportFixtureIds.taxableLossEventId,
          assetId: TEST_BTC_ASSET_ID,
          acquiredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-10T12:00:00.000Z")),
          disposedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-05-10T12:00:00.000Z")),
          quantity: "0.01",
          costBasis: "300",
          proceeds: "100",
          gainLoss: "-200",
          treatmentCodes: ["de.taxable_private_disposal"],
        },
        {
          runId: reportFixtureIds.activeCalculationRunId,
          sequence: 3,
          sourceId: fixture.sourceId,
          allocationSequence: 3,
          acquisitionEventId: reportFixtureIds.acquisitionLegId,
          dispositionEventId: reportFixtureIds.taxFreeLossEventId,
          assetId: TEST_BTC_ASSET_ID,
          acquiredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2023-01-10T12:00:00.000Z")),
          disposedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-05-10T12:00:00.000Z")),
          quantity: "0.01",
          costBasis: "400",
          proceeds: "100",
          gainLoss: "-300",
          treatmentCodes: ["de.tax_free_holding_period"],
        },
        {
          runId: reportFixtureIds.activeCalculationRunId,
          sequence: 4,
          sourceId: fixture.sourceId,
          allocationSequence: 4,
          acquisitionEventId: reportFixtureIds.acquisitionLegId,
          dispositionEventId: reportFixtureIds.unknownTreatmentEventId,
          assetId: TEST_BTC_ASSET_ID,
          acquiredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-10T12:00:00.000Z")),
          disposedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-05-10T12:00:00.000Z")),
          quantity: "0.01",
          costBasis: "100",
          proceeds: "1000",
          gainLoss: "900",
          treatmentCodes: ["de.review_only"],
        },
      ])
      yield* db.insert(schema.calculationRunIncomeResults).values({
        runId: reportFixtureIds.activeCalculationRunId,
        sequence: 0,
        sourceId: fixture.sourceId,
        eventId: reportFixtureIds.incomeEventId,
        assetId: TEST_BTC_ASSET_ID,
        occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-06-10T12:00:00.000Z")),
        quantity: "0.01",
        value: "700",
        treatmentCodes: ["de.taxable_income_section22_3_staking"],
      })
      yield* db
        .update(schema.transactionLegs)
        .set({ amount: "-0.4" })
        .where(eq(schema.transactionLegs.id, reportFixtureIds.disposalLegId))

      const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
      const tax = yield* client.sources.calculateTaxForSource({
        params: { sourceId: fixture.sourceId },
        payload: { year: 2025, jurisdiction: "germany" },
      })
      const taxEvents = yield* client.sources.listSourceTaxEvents({
        params: { sourceId: fixture.sourceId },
        query: { limit: 10 },
      })
      const explanation = yield* client.sources.explainSourceDisposal({
        params: { sourceId: fixture.sourceId, legId: reportFixtureIds.disposalLegId },
      })
      const unknownTreatmentExplanation = yield* client.sources.explainSourceDisposal({
        params: {
          sourceId: fixture.sourceId,
          legId: reportFixtureIds.unknownTreatmentEventId,
        },
      })

      expect(tax.calculationRunId).toBe(reportFixtureIds.activeCalculationRunId)
      expect(tax).toMatchObject({
        taxableGains: 500,
        taxableLosses: 200,
        taxFreeGains: 500,
        incomeTotal: 700,
      })
      expect(taxEvents.calculationRunId).toBe(reportFixtureIds.activeCalculationRunId)
      expect(taxEvents.taxEvents[0]).toMatchObject({
        legId: reportFixtureIds.disposalLegId,
        costBasis: "4000",
        proceeds: "5000",
        gainLoss: "1000",
        treatmentCodes: ["de.tax_free_holding_period", "de.taxable_private_disposal"],
      })
      expect(taxEvents.taxEvents[0]).not.toHaveProperty("taxableTreatment")
      expect(unknownTreatmentExplanation).toMatchObject({ treatmentCodes: ["de.review_only"] })
      expect(explanation).toMatchObject({
        amount: "-0.4",
        costBasis: "4000",
        proceeds: "5000",
        gainLoss: "1000",
        treatmentCodes: ["de.tax_free_holding_period", "de.taxable_private_disposal"],
      })
    }).pipe(Effect.provide(TaxCalculationHttpLive))
  )

  it.effect("keeps source-derived totals inside the run's recorded custody source", () =>
    Effect.gen(function* () {
      const fixture = yield* seedSyncEngineRepositoryFixture(REPORT_TEST_FIXTURE)
      yield* seedSyncEngineAssets({
        baseBlockchainId: fixture.baseBlockchainId,
        bitcoinBlockchainId: fixture.bitcoinBlockchainId,
      })
      yield* seedSourceReportRows({
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
      })
      yield* seedSourceReportActiveRun({
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
      })
      yield* seedOtherReportSource({
        principalId: fixture.principalId,
        referenceSourceId: fixture.sourceId,
      })

      const db = yield* drizzle
      yield* db.insert(schema.calculationRunCustodyUnits).values({
        runId: reportFixtureIds.activeCalculationRunId,
        principalId: fixture.principalId,
        custodyUnitId: reportFixtureIds.otherSourceId,
      })
      yield* db.insert(schema.calculationRunCustodyUnitSources).values({
        runId: reportFixtureIds.activeCalculationRunId,
        principalId: fixture.principalId,
        custodyUnitId: reportFixtureIds.otherSourceId,
        sourceId: reportFixtureIds.otherSourceId,
      })
      yield* db.insert(schema.calculationRunAllocations).values({
        runId: reportFixtureIds.activeCalculationRunId,
        principalId: fixture.principalId,
        sequence: 2,
        acquisitionEventId: reportFixtureIds.acquisitionLegId,
        dispositionEventId: reportFixtureIds.disposalLegId,
        assetId: TEST_BTC_ASSET_ID,
        custodyUnitId: reportFixtureIds.otherSourceId,
        acquiredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
        disposedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T00:00:00.000Z")),
        quantity: "1",
        costBasis: "1",
      })
      yield* db.insert(schema.calculationRunRealizedResults).values({
        runId: reportFixtureIds.activeCalculationRunId,
        sequence: 2,
        sourceId: reportFixtureIds.otherSourceId,
        allocationSequence: 2,
        acquisitionEventId: reportFixtureIds.acquisitionLegId,
        dispositionEventId: reportFixtureIds.disposalLegId,
        assetId: TEST_BTC_ASSET_ID,
        acquiredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
        disposedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T00:00:00.000Z")),
        quantity: "1",
        costBasis: "1",
        proceeds: "1000",
        gainLoss: "999",
        treatmentCodes: ["de.taxable_private_disposal"],
      })
      yield* db.insert(schema.calculationRunIncomeResults).values({
        runId: reportFixtureIds.activeCalculationRunId,
        sequence: 0,
        sourceId: reportFixtureIds.otherSourceId,
        eventId: reportFixtureIds.otherAcquisitionEventId,
        assetId: TEST_BTC_ASSET_ID,
        occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
        quantity: "1",
        value: "777",
        treatmentCodes: ["de.taxable_income_section22_3_staking"],
      })

      const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
      const tax = yield* client.sources.calculateTaxForSource({
        params: { sourceId: fixture.sourceId },
        payload: { year: 2025, jurisdiction: "germany" },
      })
      const overview = yield* client.sources.getSourceOverview({
        params: { sourceId: fixture.sourceId },
      })
      const assetPnl = yield* client.sources.listSourceAssetPnl({
        params: { sourceId: fixture.sourceId },
      })
      const fifoLots = yield* client.sources.listSourceFifoLots({
        params: { sourceId: fixture.sourceId },
        query: { limit: 10 },
      })

      expect(tax).toMatchObject({
        taxableGains: 500,
        taxFreeGains: 500,
        incomeTotal: 0,
      })
      expect(overview.totals).toMatchObject({ realizedGainLoss: "1000", incomeTotal: "0" })
      expect(assetPnl.assets[0]).toMatchObject({ proceeds: "5000", realizedGainLoss: "1000" })
      expect(fifoLots.fifoLots[0]?.disposalMatches).toEqual([
        {
          disposalLegId: reportFixtureIds.disposalLegId,
          matchedAmount: "0.4",
          proceeds: "5000",
          costBasis: "4000",
          gainLoss: "1000",
        },
      ])
    }).pipe(Effect.provide(TaxCalculationHttpLive))
  )

  it.effect("explains grouped-custody FIFO matches after the other source facts are replayed", () =>
    Effect.gen(function* () {
      const fixture = yield* seedSyncEngineRepositoryFixture(REPORT_TEST_FIXTURE)
      yield* seedSyncEngineAssets({
        baseBlockchainId: fixture.baseBlockchainId,
        bitcoinBlockchainId: fixture.bitcoinBlockchainId,
      })
      yield* seedSourceReportRows({
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
      })
      yield* seedSourceReportActiveRun({
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
      })
      yield* seedOtherReportSource({
        principalId: fixture.principalId,
        referenceSourceId: fixture.sourceId,
      })

      const db = yield* drizzle
      yield* db.insert(schema.calculationRunCustodyUnitSources).values({
        runId: reportFixtureIds.activeCalculationRunId,
        principalId: fixture.principalId,
        custodyUnitId: fixture.sourceId,
        sourceId: reportFixtureIds.otherSourceId,
      })
      yield* db.insert(schema.transactions).values({
        id: reportFixtureIds.otherDisposalTransactionId,
        sourceId: reportFixtureIds.otherSourceId,
        principalId: fixture.principalId,
        externalId: "report-other-source-disposal",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-15T12:00:00.000Z")),
        transactionType: "sell_fiat",
        providerTransactionType: "sell",
        providerStatus: "completed",
        providerDescription: "Grouped custody disposal",
      })
      yield* db.insert(schema.transactionLegs).values(
        yield* prepareMovementLegFixtures([
          {
            movementIdentity: {
              sourceRecordKey: "report-other-source-disposal:btc",
              componentKey: "movement",
            },
            id: reportFixtureIds.otherDisposalEventId,
            sourceId: reportFixtureIds.otherSourceId,
            principalId: fixture.principalId,
            externalId: "report-other-source-disposal:btc",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-15T12:00:00.000Z")),
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.1",
            kind: "disposal",
            provenance: "deterministic",
            originKind: "none" as const,
            derivationRule: "test_fixture_sell",
            transactionId: reportFixtureIds.otherDisposalTransactionId,
            fiatAmount: "1500",
            fiatCurrency: "EUR",
          },
        ])
      )
      yield* db.insert(schema.calculationRunAllocations).values({
        runId: reportFixtureIds.activeCalculationRunId,
        principalId: fixture.principalId,
        sequence: 2,
        acquisitionEventId: reportFixtureIds.acquisitionLegId,
        dispositionEventId: reportFixtureIds.otherDisposalEventId,
        assetId: TEST_BTC_ASSET_ID,
        custodyUnitId: fixture.sourceId,
        acquiredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-10T12:00:00.000Z")),
        disposedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-15T12:00:00.000Z")),
        quantity: "0.1",
        costBasis: "1000",
      })
      yield* db.insert(schema.calculationRunRealizedResults).values({
        runId: reportFixtureIds.activeCalculationRunId,
        sequence: 2,
        sourceId: reportFixtureIds.otherSourceId,
        allocationSequence: 2,
        acquisitionEventId: reportFixtureIds.acquisitionLegId,
        dispositionEventId: reportFixtureIds.otherDisposalEventId,
        assetId: TEST_BTC_ASSET_ID,
        acquiredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-10T12:00:00.000Z")),
        disposedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-15T12:00:00.000Z")),
        quantity: "0.1",
        costBasis: "1000",
        proceeds: "1500",
        gainLoss: "500",
        treatmentCodes: ["de.taxable_private_disposal"],
      })

      const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
      const fifoLots = yield* client.sources.listSourceFifoLots({
        params: { sourceId: fixture.sourceId },
        query: { limit: 10 },
      })
      const groupedMatch = fifoLots.fifoLots
        .flatMap((lot) => lot.disposalMatches)
        .find((match) => match.disposalLegId === reportFixtureIds.otherDisposalEventId)
      expect(groupedMatch).toMatchObject({
        matchedAmount: "0.1",
        proceeds: "1500",
        costBasis: "1000",
        gainLoss: "500",
      })

      const beforeReplay = yield* client.sources.explainSourceDisposal({
        params: {
          sourceId: fixture.sourceId,
          legId: reportFixtureIds.otherDisposalEventId,
        },
      })
      expect(beforeReplay).toMatchObject({
        calculationRunId: reportFixtureIds.activeCalculationRunId,
        disposalLegId: reportFixtureIds.otherDisposalEventId,
        transactionId: reportFixtureIds.otherDisposalTransactionId,
        amount: "0.1",
        proceeds: "1500",
        costBasis: "1000",
        gainLoss: "500",
        treatmentCodes: ["de.taxable_private_disposal"],
      })

      yield* db
        .delete(schema.transactionLegs)
        .where(eq(schema.transactionLegs.id, reportFixtureIds.otherDisposalEventId))
      yield* db
        .delete(schema.transactions)
        .where(eq(schema.transactions.id, reportFixtureIds.otherDisposalTransactionId))

      const afterReplay = yield* client.sources.explainSourceDisposal({
        params: {
          sourceId: fixture.sourceId,
          legId: reportFixtureIds.otherDisposalEventId,
        },
      })
      expect(afterReplay).toMatchObject({
        calculationRunId: reportFixtureIds.activeCalculationRunId,
        disposalLegId: reportFixtureIds.otherDisposalEventId,
        transactionId: null,
        amount: "0.1",
        proceeds: "1500",
        costBasis: "1000",
        gainLoss: "500",
        treatmentCodes: ["de.taxable_private_disposal"],
      })
      expect(afterReplay.matchedLots).toEqual(beforeReplay.matchedLots)
    }).pipe(Effect.provide(TaxCalculationHttpLive))
  )

  it.effect("keeps a partial active run readable after live facts reset", () =>
    Effect.gen(function* () {
      const fixture = yield* seedSyncEngineRepositoryFixture(REPORT_TEST_FIXTURE)
      yield* seedSyncEngineAssets({
        baseBlockchainId: fixture.baseBlockchainId,
        bitcoinBlockchainId: fixture.bitcoinBlockchainId,
      })
      yield* seedSourceReportRows({
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
      })
      yield* seedSourceReportActiveRun({
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
      })

      const db = yield* drizzle
      yield* db
        .update(schema.calculationRuns)
        .set({ status: "partial" })
        .where(eq(schema.calculationRuns.id, reportFixtureIds.activeCalculationRunId))
      yield* db.insert(schema.calculationRunAllocations).values({
        runId: reportFixtureIds.activeCalculationRunId,
        principalId: fixture.principalId,
        sequence: 2,
        acquisitionEventId: reportFixtureIds.acquisitionLegId,
        dispositionEventId: reportFixtureIds.unvaluedDisposalEventId,
        assetId: TEST_BTC_ASSET_ID,
        custodyUnitId: fixture.sourceId,
        acquiredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-10T12:00:00.000Z")),
        disposedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T12:00:00.000Z")),
        quantity: "0.1",
        costBasis: "1500",
      })
      yield* db
        .update(schema.calculationRunDerivedLots)
        .set({ remainingQuantity: "0.3" })
        .where(eq(schema.calculationRunDerivedLots.runId, reportFixtureIds.activeCalculationRunId))
      yield* db.insert(schema.calculationRunDerivedLots).values({
        runId: reportFixtureIds.activeCalculationRunId,
        principalId: fixture.principalId,
        sequence: 1,
        acquisitionEventId: reportFixtureIds.acquisitionLegId,
        assetId: TEST_BTC_ASSET_ID,
        custodyUnitId: fixture.sourceId,
        acquiredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-10T12:00:00.000Z")),
        remainingQuantity: "0.2",
        costBasisPerUnit: "15000",
      })

      const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
      const beforeReset = yield* client.sources.calculateTaxForSource({
        params: { sourceId: fixture.sourceId },
        payload: { year: 2025, jurisdiction: "germany" },
      })

      yield* db
        .delete(schema.transactionLegs)
        .where(eq(schema.transactionLegs.sourceId, fixture.sourceId))

      const afterReset = yield* client.sources.calculateTaxForSource({
        params: { sourceId: fixture.sourceId },
        payload: { year: 2025, jurisdiction: "germany" },
      })
      const overview = yield* client.sources.getSourceOverview({
        params: { sourceId: fixture.sourceId },
      })
      const fifoLots = yield* client.sources.listSourceFifoLots({
        params: { sourceId: fixture.sourceId },
        query: { limit: 1 },
      })

      expect(afterReset).toEqual(beforeReset)
      expect(afterReset.calculationRunId).toBe(reportFixtureIds.activeCalculationRunId)
      expect(overview.totals.fifoLotCount).toBe(1)
      expect(fifoLots.calculationRunId).toBe(reportFixtureIds.activeCalculationRunId)
      expect(fifoLots.fifoLots).toHaveLength(1)
      expect(fifoLots.page).toMatchObject({ hasMore: false, nextCursor: null })
      expect(fifoLots.fifoLots[0]).toMatchObject({
        lotId: reportFixtureIds.acquisitionLegId,
        originalAmount: "1",
        remainingAmount: "0.5",
      })
      expect(fifoLots.fifoLots[0]?.disposalMatches).toContainEqual({
        disposalLegId: reportFixtureIds.unvaluedDisposalEventId,
        matchedAmount: "0.1",
        proceeds: null,
        costBasis: "1500",
        gainLoss: null,
      })
    }).pipe(Effect.provide(TaxCalculationHttpLive))
  )

  it.effect("keeps omitted run values unavailable while factual income counts stay live", () =>
    Effect.gen(function* () {
      const fixture = yield* seedSyncEngineRepositoryFixture(REPORT_TEST_FIXTURE)
      yield* seedSyncEngineAssets({
        baseBlockchainId: fixture.baseBlockchainId,
        bitcoinBlockchainId: fixture.bitcoinBlockchainId,
      })
      yield* seedSourceReportRows({
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
      })
      yield* seedSourceReportActiveRun({
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
      })

      const db = yield* drizzle
      yield* db
        .update(schema.calculationRuns)
        .set({ status: "partial" })
        .where(eq(schema.calculationRuns.id, reportFixtureIds.activeCalculationRunId))
      yield* db
        .delete(schema.calculationRunRealizedResults)
        .where(
          and(
            eq(schema.calculationRunRealizedResults.runId, reportFixtureIds.activeCalculationRunId),
            eq(schema.calculationRunRealizedResults.sequence, 1)
          )
        )
      yield* db.insert(schema.transactions).values([
        {
          id: reportFixtureIds.incomeTransactionId,
          sourceId: fixture.sourceId,
          principalId: fixture.principalId,
          externalId: "report-income-unvalued",
          timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-09T12:00:00.000Z")),
          transactionType: "staking_reward",
          providerTransactionType: "reward",
          providerStatus: "completed",
          providerDescription: "Unvalued staking income",
        },
        {
          id: reportFixtureIds.unvaluedDisposalTransactionId,
          sourceId: fixture.sourceId,
          principalId: fixture.principalId,
          externalId: "report-disposal-unvalued",
          timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T12:00:00.000Z")),
          transactionType: "sell_fiat",
          providerTransactionType: "sell",
          providerStatus: "completed",
          providerDescription: "Unvalued disposal",
        },
      ])
      yield* db.insert(schema.transactionLegs).values(
        yield* prepareMovementLegFixtures([
          {
            movementIdentity: {
              sourceRecordKey: "report-income-unvalued:btc",
              componentKey: "movement",
            },
            id: reportFixtureIds.incomeEventId,
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            externalId: "report-income-unvalued:btc",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-09T12:00:00.000Z")),
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.01",
            kind: "income",
            provenance: "deterministic",
            originKind: "none" as const,
            derivationRule: "test_fixture_income",
            transactionId: reportFixtureIds.incomeTransactionId,
            fiatAmount: "777",
            fiatCurrency: "EUR",
          },
          {
            movementIdentity: {
              sourceRecordKey: "report-disposal-unvalued:btc",
              componentKey: "movement",
            },
            id: reportFixtureIds.unvaluedDisposalEventId,
            sourceId: fixture.sourceId,
            principalId: fixture.principalId,
            externalId: "report-disposal-unvalued:btc",
            timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T12:00:00.000Z")),
            assetId: TEST_BTC_ASSET_ID,
            amount: "0.2",
            kind: "disposal",
            provenance: "deterministic",
            originKind: "none" as const,
            derivationRule: "test_fixture_sell",
            transactionId: reportFixtureIds.unvaluedDisposalTransactionId,
            fiatAmount: "2000",
            fiatCurrency: "EUR",
          },
        ])
      )
      yield* db.insert(schema.calculationRunAllocations).values({
        runId: reportFixtureIds.activeCalculationRunId,
        principalId: fixture.principalId,
        sequence: 2,
        acquisitionEventId: reportFixtureIds.acquisitionLegId,
        dispositionEventId: reportFixtureIds.unvaluedDisposalEventId,
        assetId: TEST_BTC_ASSET_ID,
        custodyUnitId: fixture.sourceId,
        acquiredAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-10T12:00:00.000Z")),
        disposedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-10T12:00:00.000Z")),
        quantity: "0.1",
        costBasis: "1500",
      })
      yield* db.insert(schema.calculationRunBlockers).values({
        runId: reportFixtureIds.activeCalculationRunId,
        principalId: fixture.principalId,
        sequence: 0,
        code: "inventory_shortage",
        eventId: reportFixtureIds.unvaluedDisposalEventId,
        assetId: TEST_BTC_ASSET_ID,
        custodyUnitId: fixture.sourceId,
        missingQuantity: "0.1",
      })

      const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
      const beforeReplay = yield* client.sources.listSourceTaxEvents({
        params: { sourceId: fixture.sourceId },
        query: { limit: 10 },
      })
      const overview = yield* client.sources.getSourceOverview({
        params: { sourceId: fixture.sourceId },
      })
      const explanation = yield* client.sources.explainSourceDisposal({
        params: {
          sourceId: fixture.sourceId,
          legId: reportFixtureIds.unvaluedDisposalEventId,
        },
      })
      const partialExplanation = yield* client.sources.explainSourceDisposal({
        params: { sourceId: fixture.sourceId, legId: reportFixtureIds.disposalLegId },
      })

      expect
        .soft(
          beforeReplay.taxEvents.find((event) => event.legId === reportFixtureIds.incomeEventId)
        )
        .toMatchObject({
          fiatAmount: null,
          fiatCurrency: null,
          treatmentCodes: [],
        })
      expect.soft(overview.totals).toMatchObject({ incomeCount: 1, incomeTotal: "0" })
      expect
        .soft(
          beforeReplay.taxEvents.find((event) => event.legId === reportFixtureIds.disposalLegId)
        )
        .toMatchObject({
          costBasis: null,
          proceeds: null,
          gainLoss: null,
          treatmentCodes: ["de.tax_free_holding_period"],
        })
      expect.soft(explanation).toMatchObject({
        calculationRunId: reportFixtureIds.activeCalculationRunId,
        disposalLegId: reportFixtureIds.unvaluedDisposalEventId,
        amount: "0.2",
        proceeds: null,
        costBasis: null,
        gainLoss: null,
        matchedLots: [],
      })
      expect.soft(partialExplanation).toMatchObject({
        amount: "0.4",
        proceeds: null,
        costBasis: null,
        gainLoss: null,
        treatmentCodes: ["de.tax_free_holding_period"],
      })
      expect(partialExplanation.matchedLots).toHaveLength(1)

      yield* db
        .update(schema.transactionLegs)
        .set({ fiatAmount: "999", fiatCurrency: "USD" })
        .where(eq(schema.transactionLegs.id, reportFixtureIds.incomeEventId))
      yield* db
        .delete(schema.transactionLegs)
        .where(eq(schema.transactionLegs.id, reportFixtureIds.unvaluedDisposalEventId))

      const afterReplay = yield* client.sources.listSourceTaxEvents({
        params: { sourceId: fixture.sourceId },
        query: { limit: 10 },
      })
      const replayedExplanation = yield* client.sources.explainSourceDisposal({
        params: {
          sourceId: fixture.sourceId,
          legId: reportFixtureIds.unvaluedDisposalEventId,
        },
      })

      expect(
        afterReplay.taxEvents.find((event) => event.legId === reportFixtureIds.incomeEventId)
      ).toMatchObject({ fiatAmount: null, fiatCurrency: null })
      expect(replayedExplanation).toMatchObject({
        calculationRunId: reportFixtureIds.activeCalculationRunId,
        disposalLegId: reportFixtureIds.unvaluedDisposalEventId,
        amount: "0.2",
        proceeds: null,
        costBasis: null,
        gainLoss: null,
      })
    }).pipe(Effect.provide(TaxCalculationHttpLive))
  )

  it.effect("selects tax runs by jurisdiction, year, and frozen source membership", () =>
    Effect.gen(function* () {
      const fixture = yield* seedSyncEngineRepositoryFixture(REPORT_TEST_FIXTURE)
      yield* seedSyncEngineAssets({
        baseBlockchainId: fixture.baseBlockchainId,
        bitcoinBlockchainId: fixture.bitcoinBlockchainId,
      })
      yield* seedSourceReportRows({
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
      })
      yield* seedSourceReportActiveRun({
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
      })

      const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
      const unsupported = yield* client.sources
        .calculateTaxForSource({
          params: { sourceId: fixture.sourceId },
          payload: { year: 2025, jurisdiction: "united-states" },
        })
        .pipe(Effect.result)
      const wrongYear = yield* client.sources
        .calculateTaxForSource({
          params: { sourceId: fixture.sourceId },
          payload: { year: 2024, jurisdiction: "germany" },
        })
        .pipe(Effect.result)
      const unknownSource = yield* client.sources
        .calculateTaxForSource({
          params: { sourceId: "00000000-0000-4000-8000-000000049999" },
          payload: { year: 2025, jurisdiction: "germany" },
        })
        .pipe(Effect.result)

      const db = yield* drizzle
      yield* db
        .delete(schema.calculationRunCustodyUnitSources)
        .where(
          eq(schema.calculationRunCustodyUnitSources.runId, reportFixtureIds.activeCalculationRunId)
        )
      const missingMembership = yield* client.sources
        .calculateTaxForSource({
          params: { sourceId: fixture.sourceId },
          payload: { year: 2025, jurisdiction: "germany" },
        })
        .pipe(Effect.result)

      expect(unsupported._tag).toBe("Failure")
      expect(wrongYear._tag).toBe("Failure")
      expect(unknownSource._tag).toBe("Failure")
      expect(missingMembership._tag).toBe("Failure")
      if (
        unsupported._tag === "Failure" &&
        wrongYear._tag === "Failure" &&
        unknownSource._tag === "Failure" &&
        missingMembership._tag === "Failure"
      ) {
        expect(unsupported.failure._tag).toBe("SourceBadRequestError")
        expect(wrongYear.failure._tag).toBe("SourceBadRequestError")
        expect(unknownSource.failure._tag).toBe("SourceNotFoundError")
        expect(missingMembership.failure._tag).toBe("SourceBadRequestError")
      }
    }).pipe(Effect.provide(TaxCalculationHttpLive))
  )

  it.effect("returns source-generic report read projections for a populated source", () =>
    Effect.gen(function* () {
      const fixture = yield* seedSyncEngineRepositoryFixture(REPORT_TEST_FIXTURE)
      yield* seedSyncEngineAssets({
        baseBlockchainId: fixture.baseBlockchainId,
        bitcoinBlockchainId: fixture.bitcoinBlockchainId,
      })
      yield* seedSourceReportRows({
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
      })
      yield* seedSourceReportActiveRun({
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
      })
      const db = yield* drizzle
      yield* db.insert(schema.providerTransfers).values({
        id: reportFixtureIds.custodyProviderTransferId,
        sourceId: fixture.sourceId,
        transactionId: reportFixtureIds.sellTransactionId,
        externalId: "report-custody-outflow-1",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-10T12:00:00.000Z")),
        direction: "outbound",
        processingMode: "accounting_and_evidence",
        fromAccountRef: "coinbase-account-1",
        toAddress: "bc1qreportcustodydestination",
        amount: "0.1",
      })
      yield* db.insert(schema.inventoryMovements).values({
        id: reportFixtureIds.custodyMovementId,
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
        transactionId: reportFixtureIds.sellTransactionId,
        providerTransferId: reportFixtureIds.custodyProviderTransferId,
        assetId: TEST_BTC_ASSET_ID,
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-10T12:00:00.000Z")),
        direction: "outbound",
        purpose: "fee",
        taxTreatment: "pending_review",
        reconciliationStatus: "unmatched",
        amount: "0.1",
      })
      const client = yield* makeAuthenticatedClient({ userId: fixture.userId })

      const overview = yield* client.sources.getSourceOverview({
        params: { sourceId: fixture.sourceId },
      })
      expect(overview.source.id).toBe(fixture.sourceId)
      expect(overview.source.providerKey).toBe("coinbase")
      expect(overview.totals.transactionCount).toBe(2)
      expect(overview.totals.disposalCount).toBe(1)
      expect(overview.calculationRunId).toBe(reportFixtureIds.activeCalculationRunId)
      expect(overview.totals.realizedGainLoss).toBe("1000")

      const assetPnl = yield* client.sources.listSourceAssetPnl({
        params: { sourceId: fixture.sourceId },
      })
      expect(assetPnl.calculationRunId).toBe(reportFixtureIds.activeCalculationRunId)
      expect(assetPnl.assets).toHaveLength(1)
      expect(assetPnl.assets[0]).toMatchObject({
        acquiredAmount: "1",
        disposedAmount: "0.4",
        openAmount: "0.6",
        costBasis: "9000",
        proceeds: "5000",
        realizedGainLoss: "1000",
        currency: "EUR",
      })

      const transactions = yield* client.sources.listSourceTransactions({
        params: { sourceId: fixture.sourceId },
        query: { limit: 1 },
      })
      expect(transactions.transactions).toHaveLength(1)
      expect(transactions.transactions[0]?.transactionId).toBe(reportFixtureIds.sellTransactionId)
      expect(transactions.transactions[0]?.movements[0]?.kind).toBe("disposal")
      expect(transactions.page.hasMore).toBe(true)
      expect(transactions.page.nextCursor).not.toBeNull()

      const taxEvents = yield* client.sources.listSourceTaxEvents({
        params: { sourceId: fixture.sourceId },
        query: { limit: 10 },
      })
      expect(taxEvents.taxEvents.map((event) => event.kind)).toEqual(["disposal", "acquisition"])
      expect(taxEvents.taxEvents[0]).toMatchObject({
        legId: reportFixtureIds.disposalLegId,
        costBasis: "4000",
        proceeds: "5000",
        gainLoss: "1000",
        treatmentCodes: ["de.tax_free_holding_period", "de.taxable_private_disposal"],
      })

      const fifoLots = yield* client.sources.listSourceFifoLots({
        params: { sourceId: fixture.sourceId },
        query: { limit: 10 },
      })
      expect(fifoLots.calculationRunId).toBe(reportFixtureIds.activeCalculationRunId)
      expect(fifoLots.fifoLots).toHaveLength(1)
      expect(fifoLots.fifoLots[0]).toMatchObject({
        lotId: reportFixtureIds.acquisitionLegId,
        originalAmount: "1",
        remainingAmount: "0.6",
        costBasisStatus: "known",
      })
      expect(fifoLots.fifoLots[0]?.disposalMatches[0]).toMatchObject({
        disposalLegId: reportFixtureIds.disposalLegId,
        matchedAmount: "0.4",
        proceeds: "5000",
        costBasis: "4000",
        gainLoss: "1000",
      })

      const explanation = yield* client.sources.explainSourceDisposal({
        params: { sourceId: fixture.sourceId, legId: reportFixtureIds.disposalLegId },
      })
      expect(explanation.calculationRunId).toBe(reportFixtureIds.activeCalculationRunId)
      expect(explanation).toMatchObject({
        disposalLegId: reportFixtureIds.disposalLegId,
        amount: "0.4",
        proceeds: "5000",
        costBasis: "4000",
        gainLoss: "1000",
        treatmentCodes: ["de.tax_free_holding_period", "de.taxable_private_disposal"],
      })
      expect(explanation.matchedLots).toHaveLength(2)
      expect(explanation.matchedLots.map((lot) => lot.treatmentCodes)).toEqual([
        ["de.tax_free_holding_period"],
        ["de.taxable_private_disposal"],
      ])
    }).pipe(Effect.provide(HttpLive))
  )

  it.effect("surfaces factual review state for source disposals without an active run", () =>
    Effect.gen(function* () {
      const fixture = yield* seedSyncEngineRepositoryFixture(REPORT_TEST_FIXTURE)

      yield* seedSyncEngineAssets({
        baseBlockchainId: fixture.baseBlockchainId,
        bitcoinBlockchainId: fixture.bitcoinBlockchainId,
      })

      yield* seedSourceReportRows({
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
      })

      const db = yield* drizzle

      yield* db.insert(schema.transactionReviews).values({
        transactionId: reportFixtureIds.sellTransactionId,
        principalId: fixture.principalId,
        reviewStatus: "changed",
        originalTypeKey: "sell_fiat",
        currentTypeKey: "sell_fiat",
        categorizationReason:
          "provider_asset_mapping: Keep the approved provider mapping.\nfifo_inventory: Review required because source inventory is incomplete.",
        matchedLayer: "provider_asset_mapping,fifo_inventory",
        needsReview: true,
      })

      const client = yield* makeAuthenticatedClient({ userId: fixture.userId })

      const overview = yield* client.sources.getSourceOverview({
        params: { sourceId: fixture.sourceId },
      })

      expect(overview.totals.disposalCount).toBe(1)
      expect(overview.totals.realizedGainLoss).toBe("0")
      expect(overview.review).toMatchObject({
        status: "needs_review",
        needsReviewCount: 1,
        blockingIssueCount: 1,
        issues: [
          {
            code: "fifo_inventory_shortfall",
            count: 1,
            blocking: true,
            summary: "1 disposal cannot be matched to available FIFO inventory.",
          },
        ],
      })

      const assetPnl = yield* client.sources.listSourceAssetPnl({
        params: { sourceId: fixture.sourceId },
      })
      expect(assetPnl.assets[0]).toMatchObject({
        disposedAmount: "0.4",
        proceeds: "0",
        realizedGainLoss: "0",
        review: {
          status: "needs_review",
          needsReviewCount: 1,
          blockingIssueCount: 1,
          issues: [
            {
              code: "fifo_inventory_shortfall",
              count: 1,
              blocking: true,
            },
          ],
        },
      })
    }).pipe(Effect.provide(HttpLive))
  )

  it.effect("returns empty source report lists for a source with no canonical rows", () =>
    Effect.gen(function* () {
      const fixture = yield* seedSyncEngineRepositoryFixture(REPORT_TEST_FIXTURE)
      const client = yield* makeAuthenticatedClient({ userId: fixture.userId })

      const overview = yield* client.sources.getSourceOverview({
        params: { sourceId: fixture.sourceId },
      })
      expect(overview.calculationRunId).toBeNull()
      expect(overview.totals.transactionCount).toBe(0)
      expect(overview.totals.assetCount).toBe(0)

      const assetPnl = yield* client.sources.listSourceAssetPnl({
        params: { sourceId: fixture.sourceId },
      })
      expect(assetPnl.calculationRunId).toBeNull()
      expect(assetPnl.assets).toEqual([])

      const transactions = yield* client.sources.listSourceTransactions({
        params: { sourceId: fixture.sourceId },
        query: { limit: 10 },
      })
      expect(transactions.transactions).toEqual([])
      expect(transactions.page).toMatchObject({ hasMore: false, nextCursor: null })

      const taxEvents = yield* client.sources.listSourceTaxEvents({
        params: { sourceId: fixture.sourceId },
        query: { limit: 10 },
      })
      expect(taxEvents.calculationRunId).toBeNull()
      expect(taxEvents.taxEvents).toEqual([])

      const fifoLots = yield* client.sources.listSourceFifoLots({
        params: { sourceId: fixture.sourceId },
        query: { limit: 10 },
      })
      expect(fifoLots.calculationRunId).toBeNull()
      expect(fifoLots.fifoLots).toEqual([])
    }).pipe(Effect.provide(HttpLive))
  )

  it.effect("does not derive positions from provider transfers without an active run", () =>
    Effect.gen(function* () {
      const fixture = yield* seedSyncEngineRepositoryFixture(REPORT_TEST_FIXTURE)
      yield* seedSyncEngineAssets({
        baseBlockchainId: fixture.baseBlockchainId,
        bitcoinBlockchainId: fixture.bitcoinBlockchainId,
      })

      const transactionId = "00000000-0000-4000-8000-000000046501"
      const providerTransferId = "00000000-0000-4000-8000-000000046502"
      const db = yield* drizzle

      yield* db.insert(schema.transactions).values({
        id: transactionId,
        sourceId: fixture.sourceId,
        externalId: "provider-only-receive",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-11T12:00:00.000Z")),
        principalId: fixture.principalId,
      })
      yield* db.insert(schema.providerTransfers).values({
        id: providerTransferId,
        sourceId: fixture.sourceId,
        transactionId,
        externalId: "provider-only-receive:principal",
        timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-11T12:00:00.000Z")),
        direction: "inbound",
        processingMode: "accounting_and_evidence",
        fromAddress: "bc1qprovideronlysource",
        toAccountRef: "coinbase-account-1",
        amount: "0.25",
      })
      const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
      const overview = yield* client.sources.getSourceOverview({
        params: { sourceId: fixture.sourceId },
      })

      expect(overview.totals).toMatchObject({
        transactionCount: 1,
        legCount: 0,
        assetCount: 0,
        fifoLotCount: 0,
      })
    }).pipe(Effect.provide(HttpLive))
  )

  it.effect("marks open basis pending when the selected run has no asset evidence", () =>
    Effect.gen(function* () {
      const fixture = yield* seedSyncEngineRepositoryFixture(REPORT_TEST_FIXTURE)
      yield* seedSyncEngineAssets({
        baseBlockchainId: fixture.baseBlockchainId,
        bitcoinBlockchainId: fixture.bitcoinBlockchainId,
      })
      yield* seedSourceReportRows({
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
      })

      const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
      const withoutRun = yield* client.sources.listSourceAssetPnl({
        params: { sourceId: fixture.sourceId },
      })
      expect(withoutRun).toMatchObject({
        calculationRunId: null,
        assets: [
          {
            openAmount: "0",
            costBasis: null,
            costBasisStatus: "pending_review",
          },
        ],
      })

      yield* seedSourceReportActiveRun({
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
      })
      const db = yield* drizzle
      yield* db
        .update(schema.calculationRuns)
        .set({ status: "partial" })
        .where(eq(schema.calculationRuns.id, reportFixtureIds.activeCalculationRunId))
      yield* db
        .delete(schema.calculationRunDerivedLots)
        .where(eq(schema.calculationRunDerivedLots.runId, reportFixtureIds.activeCalculationRunId))
      yield* db
        .delete(schema.calculationRunRealizedResults)
        .where(
          eq(schema.calculationRunRealizedResults.runId, reportFixtureIds.activeCalculationRunId)
        )

      const omittedFromPartialRun = yield* client.sources.listSourceAssetPnl({
        params: { sourceId: fixture.sourceId },
      })
      expect(omittedFromPartialRun).toMatchObject({
        calculationRunId: reportFixtureIds.activeCalculationRunId,
        assets: [
          {
            openAmount: "0",
            costBasis: null,
            costBasisStatus: "pending_review",
          },
        ],
      })
    }).pipe(Effect.provide(HttpLive))
  )

  it.effect("keeps run-proven fully disposed open basis at known zero", () =>
    Effect.gen(function* () {
      const fixture = yield* seedSyncEngineRepositoryFixture(REPORT_TEST_FIXTURE)
      yield* seedSyncEngineAssets({
        baseBlockchainId: fixture.baseBlockchainId,
        bitcoinBlockchainId: fixture.bitcoinBlockchainId,
      })
      yield* seedSourceReportRows({
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
      })
      yield* seedSourceReportActiveRun({
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
      })

      const db = yield* drizzle
      yield* db
        .update(schema.transactionLegs)
        .set({ amount: "0.4" })
        .where(eq(schema.transactionLegs.id, reportFixtureIds.acquisitionLegId))
      yield* db
        .delete(schema.calculationRunDerivedLots)
        .where(eq(schema.calculationRunDerivedLots.runId, reportFixtureIds.activeCalculationRunId))

      const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
      const assetPnl = yield* client.sources.listSourceAssetPnl({
        params: { sourceId: fixture.sourceId },
      })
      expect(assetPnl).toMatchObject({
        calculationRunId: reportFixtureIds.activeCalculationRunId,
        assets: [
          {
            acquiredAmount: "0.4",
            disposedAmount: "0.4",
            openAmount: "0",
            costBasis: "0",
            costBasisStatus: "known",
          },
        ],
      })
    }).pipe(Effect.provide(HttpLive))
  )

  it.effect("uses grouped run evidence without leaking the disposing source totals", () =>
    Effect.gen(function* () {
      const fixture = yield* seedSyncEngineRepositoryFixture(REPORT_TEST_FIXTURE)
      yield* seedSyncEngineAssets({
        baseBlockchainId: fixture.baseBlockchainId,
        bitcoinBlockchainId: fixture.bitcoinBlockchainId,
      })
      yield* seedSourceReportRows({
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
      })
      yield* seedSourceReportActiveRun({
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
      })
      yield* seedOtherReportSource({
        principalId: fixture.principalId,
        referenceSourceId: fixture.sourceId,
      })

      const db = yield* drizzle
      yield* db.insert(schema.calculationRunCustodyUnitSources).values({
        runId: reportFixtureIds.activeCalculationRunId,
        principalId: fixture.principalId,
        custodyUnitId: fixture.sourceId,
        sourceId: reportFixtureIds.otherSourceId,
      })
      yield* db
        .update(schema.transactionLegs)
        .set({ amount: "0.4" })
        .where(eq(schema.transactionLegs.id, reportFixtureIds.acquisitionLegId))
      yield* db
        .update(schema.transactions)
        .set({ sourceId: reportFixtureIds.otherSourceId })
        .where(eq(schema.transactions.id, reportFixtureIds.sellTransactionId))
      const [disposalTarget] = yield* db
        .insert(schema.movementCorrectionTargets)
        .values({
          principalId: fixture.principalId,
          sourceId: reportFixtureIds.otherSourceId,
          sourceRecordKey: "grouped-report-disposal",
          componentKey: "principal",
        })
        .returning({ id: schema.movementCorrectionTargets.id })
      if (disposalTarget === undefined) return yield* Effect.die("Missing disposal movement target")
      yield* db
        .update(schema.transactionLegs)
        .set({
          sourceId: reportFixtureIds.otherSourceId,
          movementCorrectionTargetId: disposalTarget.id,
        })
        .where(eq(schema.transactionLegs.id, reportFixtureIds.disposalLegId))
      yield* db
        .update(schema.calculationRunRealizedResults)
        .set({ sourceId: reportFixtureIds.otherSourceId })
        .where(
          eq(schema.calculationRunRealizedResults.runId, reportFixtureIds.activeCalculationRunId)
        )
      yield* db
        .delete(schema.calculationRunDerivedLots)
        .where(eq(schema.calculationRunDerivedLots.runId, reportFixtureIds.activeCalculationRunId))

      const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
      const acquisitionSourcePnl = yield* client.sources.listSourceAssetPnl({
        params: { sourceId: fixture.sourceId },
      })
      expect(acquisitionSourcePnl.assets[0]).toMatchObject({
        acquiredAmount: "0.4",
        disposedAmount: "0",
        openAmount: "0",
        costBasis: "0",
        costBasisStatus: "known",
        proceeds: "0",
        realizedGainLoss: "0",
      })

      const dispositionSourcePnl = yield* client.sources.listSourceAssetPnl({
        params: { sourceId: reportFixtureIds.otherSourceId },
      })
      expect(dispositionSourcePnl.assets[0]).toMatchObject({
        acquiredAmount: "0",
        disposedAmount: "0.4",
        openAmount: "0",
        costBasis: "0",
        costBasisStatus: "known",
        proceeds: "5000",
        realizedGainLoss: "1000",
      })
    }).pipe(Effect.provide(HttpLive))
  )

  it.effect("does not infer fee or transfer treatments outside engine results", () =>
    Effect.gen(function* () {
      const fixture = yield* seedSyncEngineRepositoryFixture(REPORT_TEST_FIXTURE)
      yield* seedSyncEngineAssets({
        baseBlockchainId: fixture.baseBlockchainId,
        bitcoinBlockchainId: fixture.bitcoinBlockchainId,
      })
      yield* seedSourceReportRows({
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
      })
      yield* seedSourceReportTaxTreatmentRows({
        principalId: fixture.principalId,
        sourceId: fixture.sourceId,
      })

      const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
      const overview = yield* client.sources.getSourceOverview({
        params: { sourceId: fixture.sourceId },
      })
      const taxEvents = yield* client.sources.listSourceTaxEvents({
        params: { sourceId: fixture.sourceId },
        query: { limit: 10 },
      })
      const feeEvent = taxEvents.taxEvents.find(
        (event) => event.legId === reportFixtureIds.feeLegId
      )
      const internalTransferEvent = taxEvents.taxEvents.find(
        (event) => event.legId === reportFixtureIds.internalTransferLegId
      )
      const internalTransferInEvent = taxEvents.taxEvents.find(
        (event) => event.legId === reportFixtureIds.internalTransferInLegId
      )

      expect(feeEvent).toMatchObject({
        kind: "fee",
        treatmentCodes: [],
      })
      expect(internalTransferEvent).toMatchObject({
        kind: "disposal",
        derivationRule: "internal_transfer_out",
        treatmentCodes: [],
      })
      expect(internalTransferInEvent).toMatchObject({
        kind: "acquisition",
        derivationRule: "internal_transfer_in",
        treatmentCodes: [],
      })
      expect(overview.totals.disposalCount).toBe(1)
      const assetPnl = yield* client.sources.listSourceAssetPnl({
        params: { sourceId: fixture.sourceId },
      })
      expect(assetPnl.assets[0]).toMatchObject({
        acquiredAmount: "1",
        disposedAmount: "0.4",
        openAmount: "0",
        costBasis: null,
        costBasisStatus: "pending_review",
        proceeds: "0",
        realizedGainLoss: "0",
      })

      const explanation = yield* client.sources.explainSourceDisposal({
        params: {
          sourceId: fixture.sourceId,
          legId: reportFixtureIds.internalTransferLegId,
        },
      })
      expect(explanation).toMatchObject({
        disposalLegId: reportFixtureIds.internalTransferLegId,
        treatmentCodes: [],
      })
      expect(explanation.matchedLots).toEqual([])
    }).pipe(Effect.provide(HttpLive))
  )

  it.effect("creates an authenticated Solana source without starting sync", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      const walletAddress = "So11111111111111111111111111111111111111112"
      yield* seedPrincipalUser({ userId, principalId })

      const client = yield* makeAuthenticatedClient({ userId })
      const response = yield* client.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress,
          name: "Demo Solana wallet",
        },
      })

      expect(response.created).toBe(true)
      expect(response.syncJob).toBeNull()
      expect(response.claim).toBeNull()
      expect(response.source).toMatchObject({
        principalId,
        name: "Demo Solana wallet",
        providerKey: "helius-solana",
      })
      expect(response.source.sourceRef._tag).toBe("onchain")

      const db = yield* drizzle
      const [storedSource] = yield* db
        .select({
          providerKey: schema.sources.providerKey,
          providerMetadata: schema.sources.providerMetadata,
        })
        .from(schema.sources)

      expect(storedSource).toEqual({
        providerKey: "helius-solana",
        providerMetadata: { chainType: "solana", walletAddress },
      })

      const storedAddresses = yield* db
        .select({
          address: schema.addresses.address,
          type: schema.addresses.type,
          principalId: schema.addresses.principalId,
        })
        .from(schema.addresses)

      expect(storedAddresses).toEqual([
        {
          address: walletAddress,
          type: "solana",
          principalId,
        },
      ])
      const claims = yield* db
        .select({ claimType: schema.principalClaims.claimType })
        .from(schema.principalClaims)
      expect(claims).toEqual([])
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("creates an anonymous Solana source and starts sync without auth", () =>
    Effect.gen(function* () {
      const walletAddress = "So11111111111111111111111111111111111111112"

      const client = yield* makeUnauthenticatedClientWithPayment()
      const response = yield* client.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress,
          name: "Anonymous Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      expect(response.created).toBe(true)
      expect(response.syncJob).not.toBeNull()
      expect(response.claim).not.toBeNull()
      expect(response.source).toMatchObject({
        name: "Anonymous Solana wallet",
        providerKey: "helius-solana",
      })
      if (response.claim === null) {
        return yield* Effect.die("Anonymous source creation did not return claim metadata")
      }
      expect(response.claim.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      )
      expect(response.claim.claimToken.length).toBeGreaterThan(40)
      expect(
        DateTime.toDateUtc(DateTime.makeUnsafe(response.claim.expiresAt)).getTime()
      ).toBeGreaterThan(DateTime.toEpochMillis(yield* DateTime.now))

      const db = yield* drizzle
      const [principal] = yield* db
        .select({
          id: schema.principals.id,
          kind: schema.principals.kind,
          userId: schema.principals.userId,
        })
        .from(schema.principals)

      expect(principal).toEqual({
        id: response.source.principalId,
        kind: "anonymous_wallet",
        userId: null,
      })
      const claims = yield* db
        .select({
          requestId: schema.principalClaims.requestId,
          principalId: schema.principalClaims.principalId,
          sourceId: schema.principalClaims.sourceId,
          claimType: schema.principalClaims.claimType,
          claimValueHash: schema.principalClaims.claimValueHash,
          chainType: schema.principalClaims.chainType,
          walletAddress: schema.principalClaims.walletAddress,
          payerChainType: schema.principalClaims.payerChainType,
          payerWalletAddress: schema.principalClaims.payerWalletAddress,
          year: schema.principalClaims.year,
          jurisdiction: schema.principalClaims.jurisdiction,
          expiresAt: schema.principalClaims.expiresAt,
          consumedAt: schema.principalClaims.consumedAt,
        })
        .from(schema.principalClaims)

      expect(claims).toHaveLength(2)
      const cliClaim = claims.find((claim) => claim.claimType === "cli_claim_token")
      const receiptClaim = claims.find((claim) => claim.claimType === "x402_receipt")

      expect(cliClaim).toMatchObject({
        requestId: response.claim.requestId,
        principalId: response.source.principalId,
        sourceId: response.source.id,
        claimType: "cli_claim_token",
        chainType: "solana",
        walletAddress,
        payerChainType: null,
        payerWalletAddress: null,
        year: 2025,
        jurisdiction: "germany",
        consumedAt: null,
      })
      expect(cliClaim?.claimValueHash).not.toBe(response.claim.claimToken)
      expect(cliClaim?.claimValueHash).toMatch(/^[a-f0-9]{64}$/u)
      expect(cliClaim?.expiresAt?.toISOString()).toBe(response.claim.expiresAt)
      expect(receiptClaim).toMatchObject({
        requestId: response.claim.requestId,
        principalId: response.source.principalId,
        sourceId: response.source.id,
        claimType: "x402_receipt",
        chainType: "solana",
        walletAddress,
        payerChainType: "solana",
        payerWalletAddress: TEST_PAYER_WALLET,
        year: 2025,
        jurisdiction: "germany",
        expiresAt: null,
        consumedAt: null,
      })
      expect(receiptClaim?.claimValueHash).toMatch(/^[a-f0-9]{64}$/u)
      expect(receiptClaim?.claimValueHash).not.toBe(validX402PaymentHeader)
      expect(queueEvents).toHaveLength(1)
      expect(queueEvents[0]).toMatchObject({
        sourceId: response.source.id,
        principalId: response.source.principalId,
        mode: "sync",
      })
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect(
    "creates an anonymous paid source without anon session when payer identity is unavailable",
    () =>
      Effect.gen(function* () {
        const walletAddress = "So11111111111111111111111111111111111111112"

        const response = yield* postRawSourceCreate({
          paymentHeader: validX402PaymentHeader,
          payload: {
            type: "onchain",
            walletAddress,
            name: "Anonymous source without payer identity",
            year: 2025,
            jurisdiction: "germany",
          },
        })
        const body = yield* response.json
        const decodedBody = yield* EffectSchema.decodeUnknownEffect(SourceCreateResponse)(body)

        expect(response.status).toBe(200)
        expect(Headers.get(response.headers, "payment-response")).toEqual(
          Option.some("encoded-test-payment-response")
        )
        expect(Headers.get(response.headers, "set-cookie")).toEqual(Option.none())
        expect(decodedBody.created).toBe(true)
        expect(decodedBody.syncJob).not.toBeNull()
        expect(decodedBody.claim).not.toBeNull()

        if (decodedBody.claim === null) {
          return yield* Effect.die("Anonymous source creation did not return claim metadata")
        }

        const db = yield* drizzle
        const claims = yield* db
          .select({
            requestId: schema.principalClaims.requestId,
            claimType: schema.principalClaims.claimType,
            payerChainType: schema.principalClaims.payerChainType,
            payerWalletAddress: schema.principalClaims.payerWalletAddress,
          })
          .from(schema.principalClaims)
          .where(eq(schema.principalClaims.requestId, decodedBody.claim.requestId))

        expect(claims).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              claimType: "cli_claim_token",
              payerChainType: null,
              payerWalletAddress: null,
            }),
            expect.objectContaining({
              claimType: "x402_receipt",
              payerChainType: null,
              payerWalletAddress: null,
            }),
          ])
        )
        expect(queueEvents).toHaveLength(1)
      }).pipe(Effect.provide(NoPayerIdentityHttpLive), Effect.scoped)
  )

  it.effect("finds an anonymous source claim by authenticated CLI claim token", () =>
    Effect.gen(function* () {
      const walletAddress = "So11111111111111111111111111111111111111112"
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const created = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress,
          name: "Claimable anonymous Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      if (created.claim === null) {
        return yield* Effect.die("Anonymous source creation did not return claim metadata")
      }

      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      yield* seedPrincipalUser({ userId, principalId })
      const calculationGraph = yield* seedClaimCalculationGraph({
        anonymousPrincipalId: created.source.principalId,
        sourceId: created.source.id,
        targetPrincipalId: principalId,
      })
      const movementLinksBefore = yield* loadClaimMovementLinks(created.source.id)
      const preClaimRevision = yield* captureClaimInputLedgerRevision({
        principalId: created.source.principalId,
      })
      const lateRunId = nextTestUuid()

      const authenticatedClient = yield* makeAuthenticatedClient({ userId })
      const claimResponse = yield* authenticatedClient.principals.claimPrincipal({
        payload: {
          requestId: created.claim.requestId,
          claimToken: created.claim.claimToken,
          siwxProof: null,
        },
      })

      expect(claimResponse.sourceId).toBe(created.source.id)
      yield* assertClaimMovementOwnership({
        sourceId: created.source.id,
        anonymousPrincipalId: created.source.principalId,
        principalId,
        before: movementLinksBefore,
      })

      const sources = yield* authenticatedClient.sources.listSources()
      expect(sources.sources.map((source) => source.id)).toContain(created.source.id)

      const db = yield* drizzle
      const [storedSource] = yield* db
        .select({
          sourcePrincipalId: schema.sources.principalId,
          addressPrincipalId: schema.addresses.principalId,
        })
        .from(schema.sources)
        .innerJoin(schema.addresses, eq(schema.addresses.id, schema.sources.addressId))
        .where(eq(schema.sources.id, created.source.id))
        .limit(1)
      expect(storedSource).toEqual({
        sourcePrincipalId: principalId,
        addressPrincipalId: principalId,
      })

      const jobs = yield* db
        .select({ principalId: schema.processingJobs.principalId })
        .from(schema.processingJobs)
        .where(eq(schema.processingJobs.sourceId, created.source.id))
      expect(jobs).toEqual([{ principalId }])

      const claims = yield* db
        .select({
          claimType: schema.principalClaims.claimType,
          consumedAt: schema.principalClaims.consumedAt,
        })
        .from(schema.principalClaims)
        .where(eq(schema.principalClaims.requestId, created.claim.requestId))
      expect(claims).toHaveLength(2)
      expect(claims.every((claim) => claim.consumedAt instanceof Date)).toBe(true)
      yield* assertClaimCalculationGraphDeleted({
        ...calculationGraph,
        anonymousPrincipalId: created.source.principalId,
        targetPrincipalId: principalId,
      })
      yield* startClaimRaceRun({
        inputLedgerRevision: preClaimRevision,
        principalId: created.source.principalId,
        runId: lateRunId,
        sourceId: null,
        taxYear: calculationGraph.taxYear,
      })
      yield* assertClaimActivationFence({
        anonymousPrincipalId: created.source.principalId,
        inputLedgerRevision: preClaimRevision,
        runId: lateRunId,
        taxYear: calculationGraph.taxYear,
      })
      expect(calculationQueueEvents).toEqual([principalId])
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("keeps a committed claim successful when recompute enqueue fails", () =>
    Effect.gen(function* () {
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const created = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress: "So11111111111111111111111111111111111111112",
          name: "Claim survives calculation queue failure",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      if (created.claim === null || created.syncJob === null) {
        return yield* Effect.die("Anonymous source creation did not return claim metadata")
      }

      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      yield* seedPrincipalUser({ userId, principalId })
      const calculationGraph = yield* seedClaimCalculationGraph({
        anonymousPrincipalId: created.source.principalId,
        sourceId: created.source.id,
        targetPrincipalId: principalId,
      })
      const authenticatedClient = yield* makeAuthenticatedClient({ userId })
      const claimResponse = yield* authenticatedClient.principals.claimPrincipal({
        payload: {
          requestId: created.claim.requestId,
          claimToken: created.claim.claimToken,
          siwxProof: null,
        },
      })

      expect(claimResponse.sourceId).toBe(created.source.id)
      yield* assertClaimCalculationGraphDeleted({
        ...calculationGraph,
        anonymousPrincipalId: created.source.principalId,
        targetPrincipalId: principalId,
      })

      const db = yield* drizzle
      const completedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:20:00.000Z"))
      yield* db
        .update(schema.processingJobs)
        .set({ status: "completed", completedAt, updatedAt: completedAt })
        .where(eq(schema.processingJobs.id, created.syncJob.jobId))

      const calculationRunRepository = yield* CalculationRunRepository
      const maintenance = yield* calculationRunRepository.settleStaleAndFindRecomputePrincipals({
        staleBefore: completedAt,
        limit: 10,
      })

      expect(maintenance.principalIds).toContain(principalId)
    }).pipe(Effect.provide(CalculationQueueFailureHttpLive), Effect.scoped)
  )

  it.effect("lists anonymous paid source handles by payer-wallet SIWX", () =>
    Effect.gen(function* () {
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const first = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress: "So11111111111111111111111111111111111111112",
          name: "First payer entitlement",
          year: 2025,
          jurisdiction: "germany",
        },
      })
      const second = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress: "8aPo8eCUhqJ1sUaz8fQAKUSMNnj3YNd19gNMVq7gFi7E",
          name: "Second payer entitlement",
          year: 2024,
          jurisdiction: "germany",
        },
      })

      if (first.claim === null || second.claim === null) {
        return yield* Effect.die("Anonymous source creation did not return claim metadata")
      }

      const sessionCookie = yield* createAnonSessionCookie()
      const anonSessionClient = yield* makeClientWithCookie(
        `${ANON_SESSION_COOKIE_NAME}=${sessionCookie}`
      )
      const response = yield* anonSessionClient.anon.listAnonSources()

      expect(response.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceId: first.source.id,
            requestId: first.claim.requestId,
            chainType: "solana",
            walletAddress: "So11111111111111111111111111111111111111112",
            year: 2025,
            jurisdiction: "germany",
          }),
          expect.objectContaining({
            sourceId: second.source.id,
            requestId: second.claim.requestId,
            chainType: "solana",
            walletAddress: "8aPo8eCUhqJ1sUaz8fQAKUSMNnj3YNd19gNMVq7gFi7E",
            year: 2024,
            jurisdiction: "germany",
          }),
        ])
      )
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("lists and reads anonymous paid source sync jobs by payer-wallet SIWX", () =>
    Effect.gen(function* () {
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const created = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress: "So11111111111111111111111111111111111111112",
          name: "Anon sync status wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      if (created.claim === null || created.syncJob === null) {
        return yield* Effect.die(
          "Anonymous source creation did not return claim metadata and sync job"
        )
      }

      const sessionCookie = yield* createAnonSessionCookie()
      const anonSessionClient = yield* makeClientWithCookie(
        `${ANON_SESSION_COOKIE_NAME}=${sessionCookie}`
      )

      const listed = yield* anonSessionClient.anon.listAnonSourceJobs({
        params: { sourceId: created.source.id },
      })
      expect(listed.jobs).toEqual([
        expect.objectContaining({
          sourceId: created.source.id,
          jobId: created.syncJob.jobId,
          status: "queued",
          fetchedRecords: null,
          normalizedRecords: null,
          failedRecords: null,
        }),
      ])

      const job = yield* anonSessionClient.anon.getAnonSourceJob({
        params: {
          sourceId: created.source.id,
          jobId: created.syncJob.jobId,
        },
      })
      expect(job).toEqual(
        expect.objectContaining({
          sourceId: created.source.id,
          jobId: created.syncJob.jobId,
          status: "queued",
        })
      )
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("returns one anonymous paid source only for the matching payer wallet", () =>
    Effect.gen(function* () {
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const created = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress: "So11111111111111111111111111111111111111112",
          name: "Payer-scoped anonymous Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      if (created.claim === null || created.syncJob === null) {
        return yield* Effect.die(
          "Anonymous source creation did not return claim metadata and sync job"
        )
      }

      const matchingSessionCookie = yield* createAnonSessionCookie()
      const matchingPayerClient = yield* makeClientWithCookie(
        `${ANON_SESSION_COOKIE_NAME}=${matchingSessionCookie}`
      )
      const source = yield* matchingPayerClient.anon.getAnonSource({
        params: { sourceId: created.source.id },
      })
      expect(source).toMatchObject({
        sourceId: created.source.id,
        requestId: created.claim.requestId,
        walletAddress: "So11111111111111111111111111111111111111112",
      })

      const otherSessionCookie = yield* createAnonSessionCookie({
        walletAddress: "8aPo8eCUhqJ1sUaz8fQAKUSMNnj3YNd19gNMVq7gFi7E",
      })
      const otherPayerClient = yield* makeClientWithCookie(
        `${ANON_SESSION_COOKIE_NAME}=${otherSessionCookie}`
      )
      const otherList = yield* otherPayerClient.anon.listAnonSources()
      expect(otherList.sources.map((visibleSource) => visibleSource.sourceId)).not.toContain(
        created.source.id
      )

      const otherSourceResult = yield* otherPayerClient.anon
        .getAnonSource({ params: { sourceId: created.source.id } })
        .pipe(Effect.result)
      const otherJobsResult = yield* otherPayerClient.anon
        .listAnonSourceJobs({ params: { sourceId: created.source.id } })
        .pipe(Effect.result)
      const otherJobResult = yield* otherPayerClient.anon
        .getAnonSourceJob({
          params: { sourceId: created.source.id, jobId: created.syncJob.jobId },
        })
        .pipe(Effect.result)

      for (const result of [otherSourceResult, otherJobsResult, otherJobResult]) {
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure._tag).toBe("AnonNotFoundError")
        }
      }
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect(
    "keeps authenticated and anonymous source collections separate when both cookies exist",
    () =>
      Effect.gen(function* () {
        const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
        const anonymousCreated = yield* anonymousClient.sources.createSource({
          payload: {
            type: "onchain",
            walletAddress: "So11111111111111111111111111111111111111112",
            name: "Separated anonymous Solana wallet",
            year: 2025,
            jurisdiction: "germany",
          },
        })

        if (anonymousCreated.claim === null) {
          return yield* Effect.die("Anonymous source creation did not return claim metadata")
        }

        const userId = nextTestUuid()
        const principalId = nextTestUuid()
        yield* seedPrincipalUser({ userId, principalId })

        const authenticatedClient = yield* makeAuthenticatedClient({ userId })
        const authenticatedCreated = yield* authenticatedClient.sources.createSource({
          payload: {
            type: "onchain",
            walletAddress: "8aPo8eCUhqJ1sUaz8fQAKUSMNnj3YNd19gNMVq7gFi7E",
            name: "Separated authenticated Solana wallet",
          },
        })

        const sessionCookie = yield* createAnonSessionCookie()
        const combinedClient = yield* makeClientWithBearerTokenAndCookie({
          cookieHeader: `${ANON_SESSION_COOKIE_NAME}=${sessionCookie}`,
          token: `user_${userId}_admin`,
        })

        const authenticatedSources = yield* combinedClient.sources.listSources()
        expect(authenticatedSources.sources.map((source) => source.id)).toContain(
          authenticatedCreated.source.id
        )
        expect(authenticatedSources.sources.map((source) => source.id)).not.toContain(
          anonymousCreated.source.id
        )

        const anonymousSources = yield* combinedClient.anon.listAnonSources()
        expect(anonymousSources.sources.map((source) => source.sourceId)).toContain(
          anonymousCreated.source.id
        )
        expect(anonymousSources.sources.map((source) => source.sourceId)).not.toContain(
          authenticatedCreated.source.id
        )

        const anonOnlyClient = yield* makeClientWithCookie(
          `${ANON_SESSION_COOKIE_NAME}=${sessionCookie}`
        )
        const authenticatedApiResult = yield* anonOnlyClient.sources
          .listSources()
          .pipe(Effect.result)
        expect(authenticatedApiResult._tag).toBe("Failure")
        if (authenticatedApiResult._tag === "Failure") {
          expect(authenticatedApiResult.failure._tag).toBe("UnauthorizedError")
        }
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("removes claimed sources from anonymous payer-session access", () =>
    Effect.gen(function* () {
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const created = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress: "So11111111111111111111111111111111111111112",
          name: "Claim transfer removes anon access",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      if (created.claim === null) {
        return yield* Effect.die("Anonymous source creation did not return claim metadata")
      }

      const sessionCookie = yield* createAnonSessionCookie()
      const anonSessionClient = yield* makeClientWithCookie(
        `${ANON_SESSION_COOKIE_NAME}=${sessionCookie}`
      )
      const beforeClaim = yield* anonSessionClient.anon.listAnonSources()
      expect(beforeClaim.sources.map((source) => source.sourceId)).toContain(created.source.id)

      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      yield* seedPrincipalUser({ userId, principalId })

      const authenticatedClient = yield* makeAuthenticatedClient({ userId })
      const claimResponse = yield* authenticatedClient.principals.claimPrincipal({
        payload: {
          requestId: created.claim.requestId,
          claimToken: created.claim.claimToken,
          siwxProof: null,
        },
      })
      expect(claimResponse.sourceId).toBe(created.source.id)

      const authenticatedSources = yield* authenticatedClient.sources.listSources()
      expect(authenticatedSources.sources.map((source) => source.id)).toContain(created.source.id)

      const afterClaim = yield* anonSessionClient.anon.listAnonSources()
      expect(afterClaim.sources.map((source) => source.sourceId)).not.toContain(created.source.id)

      const sourceResult = yield* anonSessionClient.anon
        .getAnonSource({ params: { sourceId: created.source.id } })
        .pipe(Effect.result)
      expect(sourceResult._tag).toBe("Failure")
      if (sourceResult._tag === "Failure") {
        expect(sourceResult.failure._tag).toBe("AnonNotFoundError")
      }
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("reuses an existing anonymous paid source when the payer session is active", () =>
    Effect.gen(function* () {
      const walletAddress = "So11111111111111111111111111111111111111112"
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const created = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress,
          name: "Idempotent anonymous Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      const sessionCookie = yield* createAnonSessionCookie()
      const anonSessionClient = yield* makeClientWithCookie(
        `${ANON_SESSION_COOKIE_NAME}=${sessionCookie}`
      )
      const reused = yield* anonSessionClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress,
          name: "Idempotent anonymous Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      expect(reused.source.id).toBe(created.source.id)
      expect(reused.created).toBe(false)
      expect(reused.claim).toBeNull()
      expect(reused.syncJob).toBeNull()
      expect(queueEvents).toHaveLength(1)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("claims an anonymous paid source by payer-wallet SIWX without a claim token", () =>
    Effect.gen(function* () {
      const walletAddress = "So11111111111111111111111111111111111111112"
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const created = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress,
          name: "SIWX claimable anonymous Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      if (created.claim === null) {
        return yield* Effect.die("Anonymous source creation did not return claim metadata")
      }

      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      yield* seedPrincipalUser({ userId, principalId })
      const calculationGraph = yield* seedClaimCalculationGraph({
        anonymousPrincipalId: created.source.principalId,
        sourceId: created.source.id,
        targetPrincipalId: principalId,
      })
      const movementLinksBefore = yield* loadClaimMovementLinks(created.source.id)
      const preClaimRevision = yield* captureClaimInputLedgerRevision({
        principalId: created.source.principalId,
      })
      const lateRunId = nextTestUuid()
      yield* startClaimRaceRun({
        inputLedgerRevision: preClaimRevision,
        principalId: created.source.principalId,
        runId: lateRunId,
        sourceId: created.source.id,
        taxYear: calculationGraph.taxYear,
      })

      const authenticatedClient = yield* makeAuthenticatedClient({ userId })
      yield* installClaimPointerPause
      yield* Effect.addFinalizer(() => removeClaimPointerPause.pipe(Effect.orDie))
      const { release: releaseClaimPause } = yield* context.holdAdvisoryLock({
        key: "test:claim-pointer",
      })
      const claim = created.claim
      const { claimResponse, staleWrite, overlappingRevision, overlappingRunId } =
        yield* Effect.gen(function* () {
          const claimFiber = yield* Effect.forkChild(
            authenticatedClient.principals.claimPrincipal({
              payload: {
                requestId: claim.requestId,
                claimToken: null,
                siwxProof: makeTestSiwxProof({
                  chainType: "solana",
                  walletAddress: TEST_PAYER_WALLET,
                  nonce: claim.requestId,
                }),
              },
            })
          )
          yield* Effect.promise(() =>
            context.waitForQueryBlockedOnLock({
              queryIncludes: 'insert into "active_calculation_runs"',
            })
          )
          const overlappingRevision = yield* captureClaimInputLedgerRevision({
            principalId: created.source.principalId,
            visibleTransactionId: calculationGraph.transactionId,
          })
          const overlappingRunId = nextTestUuid()
          const persistFiber = yield* Effect.forkChild(
            persistClaimRaceRun({
              inputLedgerRevision: preClaimRevision,
              principalId: created.source.principalId,
              runId: lateRunId,
              taxYear: calculationGraph.taxYear,
            })
          )
          yield* Effect.promise(() =>
            context.waitForQueryBlockedOnLock({
              queryIncludes: "calculation_runs",
              minimumWaiters: 2,
            })
          )
          yield* releaseClaimPause
          const claimResponse = yield* Fiber.join(claimFiber)
          const staleWrite = yield* Fiber.join(persistFiber)

          return { claimResponse, staleWrite, overlappingRevision, overlappingRunId }
        }).pipe(Effect.ensuring(releaseClaimPause))

      expect(claimResponse.sourceId).toBe(created.source.id)
      yield* assertClaimMovementOwnership({
        sourceId: created.source.id,
        anonymousPrincipalId: created.source.principalId,
        principalId,
        before: movementLinksBefore,
      })

      const db = yield* drizzle
      const [storedSource] = yield* db
        .select({
          sourcePrincipalId: schema.sources.principalId,
          addressPrincipalId: schema.addresses.principalId,
        })
        .from(schema.sources)
        .innerJoin(schema.addresses, eq(schema.addresses.id, schema.sources.addressId))
        .where(eq(schema.sources.id, created.source.id))
        .limit(1)
      expect(storedSource).toEqual({
        sourcePrincipalId: principalId,
        addressPrincipalId: principalId,
      })
      yield* assertClaimCalculationGraphDeleted({
        ...calculationGraph,
        anonymousPrincipalId: created.source.principalId,
        targetPrincipalId: principalId,
      })
      const [lateRun] = yield* db
        .select({ status: schema.calculationRuns.status })
        .from(schema.calculationRuns)
        .where(eq(schema.calculationRuns.id, lateRunId))
      expect(staleWrite.activated).toBe(false)
      expect(lateRun).toEqual({ status: "complete" })
      yield* assertClaimActivationFence({
        anonymousPrincipalId: created.source.principalId,
        fenceAtOrBelowInput: true,
        inputLedgerRevision: overlappingRevision,
        runId: overlappingRunId,
        taxYear: calculationGraph.taxYear,
      })
      expect(calculationQueueEvents).toEqual([principalId])
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("rejects SIWX for the synced source wallet when it is not the payer wallet", () =>
    Effect.gen(function* () {
      const walletAddress = "So11111111111111111111111111111111111111112"
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const created = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress,
          name: "Source wallet SIWX mismatch",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      if (created.claim === null) {
        return yield* Effect.die("Anonymous source creation did not return claim metadata")
      }

      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      yield* seedPrincipalUser({ userId, principalId })

      const authenticatedClient = yield* makeAuthenticatedClient({ userId })
      const result = yield* authenticatedClient.principals
        .claimPrincipal({
          payload: {
            requestId: created.claim.requestId,
            claimToken: null,
            siwxProof: makeTestSiwxProof({
              chainType: "solana",
              walletAddress,
              nonce: created.claim.requestId,
            }),
          },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("PrincipalClaimNotFoundError")
      }
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("rejects payer-wallet SIWX with invalid domain, nonce, expiry, or chain", () =>
    Effect.gen(function* () {
      const requestId = nextTestUuid()
      const badProofs = [
        makeTestSiwxProof({
          chainType: "solana",
          walletAddress: TEST_PAYER_WALLET,
          domain: "evil.example",
          nonce: requestId,
        }),
        makeTestSiwxProof({
          chainType: "solana",
          walletAddress: TEST_PAYER_WALLET,
          nonce: "",
        }),
        makeTestSiwxProof({
          chainType: "solana",
          walletAddress: TEST_PAYER_WALLET,
          nonce: nextTestUuid(),
        }),
        makeTestSiwxProof({
          chainType: "solana",
          walletAddress: TEST_PAYER_WALLET,
          expirationTime: "2020-01-01T00:00:00.000Z",
          nonce: requestId,
        }),
        makeTestSiwxProof({
          chainType: "evm",
          walletAddress: TEST_PAYER_WALLET,
          nonce: requestId,
        }),
      ]

      const challengeResponse = yield* HttpClient.execute(
        HttpClientRequest.post("/v1/anon/session/challenge")
      )
      const challengeCookie = extractCookieValue(
        challengeResponse.headers,
        ANON_CHALLENGE_COOKIE_NAME
      )
      const anonChallengeClient = yield* makeClientWithCookie(
        `${ANON_CHALLENGE_COOKIE_NAME}=${challengeCookie}`
      )

      for (const siwxProof of badProofs) {
        const result = yield* anonChallengeClient.anon
          .createAnonSession({ payload: { siwxProof } })
          .pipe(Effect.result)

        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure._tag).toBe("AnonBadRequestError")
        }
      }
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("rejects replaying a CLI claim token after a successful ownership move", () =>
    Effect.gen(function* () {
      const walletAddress = "So11111111111111111111111111111111111111112"
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const created = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress,
          name: "Replay protected anonymous Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      if (created.claim === null) {
        return yield* Effect.die("Anonymous source creation did not return claim metadata")
      }

      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      yield* seedPrincipalUser({ userId, principalId })

      const authenticatedClient = yield* makeAuthenticatedClient({ userId })
      const claimPayload = {
        requestId: created.claim.requestId,
        claimToken: created.claim.claimToken,
        siwxProof: null,
      }

      const claimResponse = yield* authenticatedClient.principals.claimPrincipal({
        payload: claimPayload,
      })
      expect(claimResponse.sourceId).toBe(created.source.id)

      const replayResult = yield* authenticatedClient.principals
        .claimPrincipal({ payload: claimPayload })
        .pipe(Effect.result)

      expect(replayResult._tag).toBe("Failure")
      if (replayResult._tag === "Failure") {
        expect(replayResult.failure._tag).toBe("PrincipalClaimNotFoundError")
      }

      const db = yield* drizzle
      const [storedSource] = yield* db
        .select({ principalId: schema.sources.principalId })
        .from(schema.sources)
        .where(eq(schema.sources.id, created.source.id))
        .limit(1)
      expect(storedSource).toEqual({ principalId })

      const claims = yield* db
        .select({ consumedAt: schema.principalClaims.consumedAt })
        .from(schema.principalClaims)
        .where(eq(schema.principalClaims.requestId, created.claim.requestId))
      expect(claims).toHaveLength(2)
      expect(claims.every((claim) => claim.consumedAt instanceof Date)).toBe(true)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect(
    "prevents another user from claiming or reading an already-claimed anonymous source",
    () =>
      Effect.gen(function* () {
        const walletAddress = "So11111111111111111111111111111111111111112"
        const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
        const created = yield* anonymousClient.sources.createSource({
          payload: {
            type: "onchain",
            walletAddress,
            name: "Cross-user claimed anonymous Solana wallet",
            year: 2025,
            jurisdiction: "germany",
          },
        })

        if (created.claim === null) {
          return yield* Effect.die("Anonymous source creation did not return claim metadata")
        }

        const claimingUserId = nextTestUuid()
        const claimingPrincipalId = nextTestUuid()
        yield* seedPrincipalUser({ userId: claimingUserId, principalId: claimingPrincipalId })

        const claimingClient = yield* makeAuthenticatedClient({ userId: claimingUserId })
        const claimPayload = {
          requestId: created.claim.requestId,
          claimToken: created.claim.claimToken,
          siwxProof: null,
        }

        const claimResponse = yield* claimingClient.principals.claimPrincipal({
          payload: claimPayload,
        })
        expect(claimResponse.sourceId).toBe(created.source.id)

        const otherUserId = nextTestUuid()
        const otherPrincipalId = nextTestUuid()
        yield* seedPrincipalUser({ userId: otherUserId, principalId: otherPrincipalId })

        const otherClient = yield* makeAuthenticatedClient({ userId: otherUserId })
        const otherClaimResult = yield* otherClient.principals
          .claimPrincipal({ payload: claimPayload })
          .pipe(Effect.result)

        expect(otherClaimResult._tag).toBe("Failure")
        if (otherClaimResult._tag === "Failure") {
          expect(otherClaimResult.failure._tag).toBe("PrincipalClaimNotFoundError")
        }

        const claimingSources = yield* claimingClient.sources.listSources()
        const otherSources = yield* otherClient.sources.listSources()
        expect(claimingSources.sources.map((source) => source.id)).toContain(created.source.id)
        expect(otherSources.sources.map((source) => source.id)).not.toContain(created.source.id)

        const db = yield* drizzle
        const [storedSource] = yield* db
          .select({ principalId: schema.sources.principalId })
          .from(schema.sources)
          .where(eq(schema.sources.id, created.source.id))
          .limit(1)
        expect(storedSource).toEqual({ principalId: claimingPrincipalId })
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("rejects an expired authenticated CLI claim token", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(
        DateTime.toEpochMillis(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"))
      )
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const created = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress: "So11111111111111111111111111111111111111112",
          name: "Expired claim Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      if (created.claim === null) {
        return yield* Effect.die("Anonymous source creation did not return claim metadata")
      }

      const db = yield* drizzle
      yield* db
        .update(schema.principalClaims)
        .set({ expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")) })

      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      yield* seedPrincipalUser({ userId, principalId })

      const authenticatedClient = yield* makeAuthenticatedClient({ userId })
      const result = yield* authenticatedClient.principals
        .claimPrincipal({
          payload: {
            requestId: created.claim.requestId,
            claimToken: created.claim.claimToken,
            siwxProof: null,
          },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("PrincipalClaimNotFoundError")
      }
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("rejects an already consumed authenticated CLI claim token", () =>
    Effect.gen(function* () {
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const created = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress: "So11111111111111111111111111111111111111112",
          name: "Consumed claim Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      if (created.claim === null) {
        return yield* Effect.die("Anonymous source creation did not return claim metadata")
      }

      const db = yield* drizzle
      yield* db
        .update(schema.principalClaims)
        .set({ consumedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")) })
        .where(
          and(
            eq(schema.principalClaims.requestId, created.claim.requestId),
            eq(schema.principalClaims.claimType, "cli_claim_token")
          )
        )

      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      yield* seedPrincipalUser({ userId, principalId })

      const authenticatedClient = yield* makeAuthenticatedClient({ userId })
      const result = yield* authenticatedClient.principals
        .claimPrincipal({
          payload: {
            requestId: created.claim.requestId,
            claimToken: created.claim.claimToken,
            siwxProof: null,
          },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("PrincipalClaimNotFoundError")
      }
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("rejects a CLI claim token that is no longer owned by an anonymous principal", () =>
    Effect.gen(function* () {
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const created = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress: "So11111111111111111111111111111111111111112",
          name: "User principal claim Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      if (created.claim === null) {
        return yield* Effect.die("Anonymous source creation did not return claim metadata")
      }

      const claimedUserId = nextTestUuid()
      const db = yield* drizzle
      yield* db.insert(schema.users).values({
        id: claimedUserId,
        email: `${claimedUserId}@taxmaxi.test`,
        name: "Already Claimed Test User",
      })
      yield* db.update(schema.principals).set({ kind: "user", userId: claimedUserId })

      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      yield* seedPrincipalUser({ userId, principalId })

      const authenticatedClient = yield* makeAuthenticatedClient({ userId })
      const result = yield* authenticatedClient.principals
        .claimPrincipal({
          payload: {
            requestId: created.claim.requestId,
            claimToken: created.claim.claimToken,
            siwxProof: null,
          },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("PrincipalClaimNotFoundError")
      }
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("rejects a CLI claim token whose wallet context no longer matches its source", () =>
    Effect.gen(function* () {
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const created = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress: "So11111111111111111111111111111111111111112",
          name: "Mismatched wallet claim Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      if (created.claim === null) {
        return yield* Effect.die("Anonymous source creation did not return claim metadata")
      }

      const db = yield* drizzle
      yield* db
        .update(schema.addresses)
        .set({ address: "8aPo8eCUhqJ1sUaz8fQAKUSMNnj3YNd19gNMVq7gFi7E" })

      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      yield* seedPrincipalUser({ userId, principalId })

      const authenticatedClient = yield* makeAuthenticatedClient({ userId })
      const result = yield* authenticatedClient.principals
        .claimPrincipal({
          payload: {
            requestId: created.claim.requestId,
            claimToken: created.claim.claimToken,
            siwxProof: null,
          },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("PrincipalClaimNotFoundError")
      }
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("returns conflict when claiming a wallet the user already owns", () =>
    Effect.gen(function* () {
      const walletAddress = "So11111111111111111111111111111111111111112"
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const created = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress,
          name: "Conflicting anonymous Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      if (created.claim === null) {
        return yield* Effect.die("Anonymous source creation did not return claim metadata")
      }

      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      yield* seedPrincipalUser({ userId, principalId })

      const authenticatedClient = yield* makeAuthenticatedClient({ userId })
      const existing = yield* authenticatedClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress,
          name: "Existing user Solana wallet",
        },
      })

      const result = yield* authenticatedClient.principals
        .claimPrincipal({
          payload: {
            requestId: created.claim.requestId,
            claimToken: created.claim.claimToken,
            siwxProof: null,
          },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("PrincipalClaimConflictError")
      }

      const db = yield* drizzle
      const visibleSources = yield* authenticatedClient.sources.listSources()
      expect(visibleSources.sources.map((source) => source.id)).toContain(existing.source.id)
      expect(visibleSources.sources.map((source) => source.id)).not.toContain(created.source.id)

      const [anonymousOwnership] = yield* db
        .select({
          sourcePrincipalId: schema.sources.principalId,
          addressPrincipalId: schema.addresses.principalId,
        })
        .from(schema.sources)
        .innerJoin(schema.addresses, eq(schema.addresses.id, schema.sources.addressId))
        .where(eq(schema.sources.id, created.source.id))
        .limit(1)
      expect(anonymousOwnership).toEqual({
        sourcePrincipalId: created.source.principalId,
        addressPrincipalId: created.source.principalId,
      })

      const [existingOwnership] = yield* db
        .select({
          sourcePrincipalId: schema.sources.principalId,
          addressPrincipalId: schema.addresses.principalId,
        })
        .from(schema.sources)
        .innerJoin(schema.addresses, eq(schema.addresses.id, schema.sources.addressId))
        .where(eq(schema.sources.id, existing.source.id))
        .limit(1)
      expect(existingOwnership).toEqual({
        sourcePrincipalId: principalId,
        addressPrincipalId: principalId,
      })

      const claims = yield* db
        .select({ consumedAt: schema.principalClaims.consumedAt })
        .from(schema.principalClaims)
        .where(eq(schema.principalClaims.requestId, created.claim.requestId))
      expect(claims).toHaveLength(2)
      expect(claims.every((claim) => claim.consumedAt === null)).toBe(true)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("returns not found for an unknown authenticated CLI claim token", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      yield* seedPrincipalUser({ userId, principalId })

      const authenticatedClient = yield* makeAuthenticatedClient({ userId })
      const result = yield* authenticatedClient.principals
        .claimPrincipal({
          payload: {
            requestId: nextTestUuid(),
            claimToken: "unknown-claim-token",
            siwxProof: null,
          },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("PrincipalClaimNotFoundError")
      }
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("requires authentication for CLI claim token lookup", () =>
    Effect.gen(function* () {
      const client = yield* makeUnauthenticatedClient()
      const result = yield* client.principals
        .claimPrincipal({
          payload: {
            requestId: nextTestUuid(),
            claimToken: "unknown-claim-token",
            siwxProof: null,
          },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("UnauthorizedError")
      }
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("rejects anonymous source creation without x402 payment before side effects", () =>
    Effect.gen(function* () {
      const response = yield* postRawSourceCreate({
        payload: {
          type: "onchain",
          walletAddress: "So11111111111111111111111111111111111111112",
          name: "Unpaid anonymous Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })
      const body = yield* response.json
      const decodedBody = yield* EffectSchema.decodeUnknownEffect(SourcePaymentRequiredError)(body)
      const bodyRecord = yield* EffectSchema.decodeUnknownEffect(
        EffectSchema.Record(EffectSchema.String, EffectSchema.Unknown)
      )(body)

      expect(response.status).toBe(402)
      expect(Headers.get(response.headers, "payment-required")).toEqual(
        Option.some("encoded-test-payment-requirements")
      )
      expect(decodedBody._tag).toBe("SourcePaymentRequiredError")
      expect(Object.hasOwn(bodyRecord, "paymentRequiredHeader")).toBe(false)

      const db = yield* drizzle
      const principals = yield* db.select({ id: schema.principals.id }).from(schema.principals)
      const sources = yield* db.select({ id: schema.sources.id }).from(schema.sources)
      const claims = yield* db
        .select({ id: schema.principalClaims.id })
        .from(schema.principalClaims)
      const jobs = yield* db.select({ id: schema.processingJobs.id }).from(schema.processingJobs)

      expect(principals).toEqual([])
      expect(sources).toEqual([])
      expect(claims).toEqual([])
      expect(jobs).toEqual([])
      expect(queueEvents).toHaveLength(0)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("returns x402 settlement response header for paid anonymous source creation", () =>
    Effect.gen(function* () {
      const walletAddress = "So11111111111111111111111111111111111111112"
      const response = yield* postRawSourceCreate({
        paymentSignatureHeader: validX402PaymentHeader,
        payload: {
          type: "onchain",
          walletAddress,
          name: "Anonymous paid Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })
      const body = yield* response.json
      const decodedBody = yield* EffectSchema.decodeUnknownEffect(SourceCreateResponse)(body)

      expect(response.status).toBe(200)
      expect(Headers.get(response.headers, "payment-response")).toEqual(
        Option.some("encoded-test-payment-response")
      )
      const anonSessionCookie = extractCookieValue(response.headers, ANON_SESSION_COOKIE_NAME)
      expect(anonSessionCookie).not.toBe("")
      expect(decodedBody.created).toBe(true)
      expect(decodedBody.claim).not.toBeNull()
      expect(decodedBody.syncJob).not.toBeNull()
      expect(decodedBody.source).toMatchObject({
        name: "Anonymous paid Solana wallet",
        providerKey: "helius-solana",
      })
      expect(queueEvents).toHaveLength(1)
      expect(queueEvents[0]).toMatchObject({
        sourceId: decodedBody.source.id,
        principalId: decodedBody.source.principalId,
        mode: "sync",
      })
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("rejects anonymous source creation with invalid x402 payment before side effects", () =>
    Effect.gen(function* () {
      const client = yield* makeUnauthenticatedClientWithInvalidPayment()
      const result = yield* client.sources
        .createSource({
          payload: {
            type: "onchain",
            walletAddress: "So11111111111111111111111111111111111111112",
            name: "Invalid paid anonymous Solana wallet",
            year: 2025,
            jurisdiction: "germany",
          },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("SourcePaymentRequiredError")
      }

      const db = yield* drizzle
      const principals = yield* db.select({ id: schema.principals.id }).from(schema.principals)
      const sources = yield* db.select({ id: schema.sources.id }).from(schema.sources)
      const claims = yield* db
        .select({ id: schema.principalClaims.id })
        .from(schema.principalClaims)
      const jobs = yield* db.select({ id: schema.processingJobs.id }).from(schema.processingJobs)

      expect(principals).toEqual([])
      expect(sources).toEqual([])
      expect(claims).toEqual([])
      expect(jobs).toEqual([])
      expect(queueEvents).toHaveLength(0)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("does not persist anonymous source claims when x402 settlement fails", () =>
    Effect.gen(function* () {
      const response = yield* postRawSourceCreate({
        paymentHeader: validX402PaymentHeader,
        payload: {
          type: "onchain",
          walletAddress: "So11111111111111111111111111111111111111112",
          name: "Unsettled anonymous Solana wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })
      const body = yield* response.json
      const decodedBody = yield* EffectSchema.decodeUnknownEffect(SourcePaymentRequiredError)(body)
      const bodyRecord = yield* EffectSchema.decodeUnknownEffect(
        EffectSchema.Record(EffectSchema.String, EffectSchema.Unknown)
      )(body)

      expect(response.status).toBe(402)
      expect(decodedBody._tag).toBe("SourcePaymentRequiredError")
      expect(decodedBody.message).toBe("x402 payment settlement failed.")
      expect(Object.hasOwn(bodyRecord, "paymentRequiredHeader")).toBe(false)

      const db = yield* drizzle
      const claims = yield* db
        .select({ id: schema.principalClaims.id })
        .from(schema.principalClaims)
      const jobs = yield* db.select({ id: schema.processingJobs.id }).from(schema.processingJobs)

      expect(claims).toEqual([])
      expect(jobs).toHaveLength(1)
      expect(queueEvents).toHaveLength(1)
    }).pipe(Effect.provide(SettlementFailureHttpLive), Effect.scoped)
  )

  it.effect("does not settle x402 payment when paid anonymous sync enqueue fails", () =>
    Effect.gen(function* () {
      const client = yield* makeUnauthenticatedClientWithPayment()
      const result = yield* client.sources
        .createSource({
          payload: {
            type: "onchain",
            walletAddress: "So11111111111111111111111111111111111111112",
            name: "Queue failure anonymous Solana wallet",
            year: 2025,
            jurisdiction: "germany",
          },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("InternalServerError")
        expect(result.failure.message).toBe("Failed to enqueue source sync job.")
      }

      const db = yield* drizzle
      const claims = yield* db
        .select({ id: schema.principalClaims.id })
        .from(schema.principalClaims)

      expect(claims).toEqual([])
      expect(queueEvents).toHaveLength(0)
      expect(settlementEvents).toEqual([])
    }).pipe(Effect.provide(PaidQueueFailureHttpLive), Effect.scoped)
  )

  it.effect("rejects source creation when invalid auth credentials are present", () =>
    Effect.gen(function* () {
      const client = yield* makeClientWithBearerToken("not-a-valid-token")
      const result = yield* client.sources
        .createSource({
          payload: {
            type: "onchain",
            walletAddress: "So11111111111111111111111111111111111111112",
          },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("UnauthorizedError")
      }

      const db = yield* drizzle
      const principals = yield* db.select({ id: schema.principals.id }).from(schema.principals)
      expect(principals).toEqual([])
      expect(queueEvents).toHaveLength(0)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("rejects source creation when an invalid session cookie is present", () =>
    Effect.gen(function* () {
      const client = yield* makeClientWithCookie("taxmaxi_session=not-a-valid-session")
      const result = yield* client.sources
        .createSource({
          payload: {
            type: "onchain",
            walletAddress: "8aPo8eCUhqJ1sUaz8fQAKUSMNnj3YNd19gNMVq7gFi7E",
            name: "First",
          },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("UnauthorizedError")
      }

      const db = yield* drizzle
      const principals = yield* db.select({ id: schema.principals.id }).from(schema.principals)
      expect(principals).toEqual([])
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("reuses an authenticated Solana source for the same wallet", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      const walletAddress = "So11111111111111111111111111111111111111112"
      yield* seedPrincipalUser({ userId, principalId })

      const client = yield* makeAuthenticatedClient({ userId })
      const first = yield* client.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress,
          name: "Reusable wallet",
        },
      })
      const second = yield* client.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress,
          name: "Reusable wallet renamed",
        },
      })

      expect(first.created).toBe(true)
      expect(second.created).toBe(false)
      expect(second.source.id).toBe(first.source.id)
      expect(first.source.providerKey).toBe("helius-solana")
      expect(second.source.providerKey).toBe("helius-solana")
      expect(queueEvents).toHaveLength(0)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("infers chain type when creating an authenticated source", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      const walletAddress = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"
      yield* seedPrincipalUser({ userId, principalId })

      const client = yield* makeAuthenticatedClient({ userId })
      const response = yield* client.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress,
        },
      })

      expect(response.created).toBe(true)
      expect(response.source.providerKey).toBe("evm")

      const db = yield* drizzle
      const [storedAddress] = yield* db
        .select({
          address: schema.addresses.address,
          type: schema.addresses.type,
        })
        .from(schema.addresses)

      expect(storedAddress).toEqual({
        address: walletAddress,
        type: "evm",
      })
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("rejects source creation when wallet address chain type cannot be inferred", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      yield* seedPrincipalUser({ userId, principalId })

      const client = yield* makeAuthenticatedClient({ userId })
      const result = yield* client.sources
        .createSource({
          payload: {
            type: "onchain",
            walletAddress: "not-an-address",
          },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("SourceBadRequestError")
        expect(result.failure.message).toBe("Invalid crypto address or wallet name.")
      }
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("starts a source sync by creating a queued job without provider execution", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      const sourceId = nextTestUuid()
      yield* seedCoinbaseSource({ userId, principalId, sourceId })
      yield* seedUsableCredit({ userId })

      const client = yield* makeAuthenticatedClient({ userId })
      const job = yield* client.sources.startSourceSyncJob({
        params: { sourceId },
      })

      expect(job).toMatchObject({
        sourceId,
        status: "queued",
        message: null,
      })
      expect(queueEvents).toHaveLength(1)
      expect(queueEvents[0]).toMatchObject({
        jobId: job.jobId,
        sourceId,
        principalId,
        mode: "sync",
      })
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("reads queued status from Postgres after start", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      const sourceId = nextTestUuid()
      yield* seedCoinbaseSource({ userId, principalId, sourceId })
      yield* seedUsableCredit({ userId })

      const client = yield* makeAuthenticatedClient({ userId })
      const started = yield* client.sources.startSourceSyncJob({
        params: { sourceId },
      })
      const status = yield* client.sources.getSourceSyncJobStatus({
        params: { sourceId, jobId: started.jobId },
      })

      expect(status).toEqual({
        sourceId,
        jobId: started.jobId,
        status: "queued",
        phase: null,
        processedRecords: null,
        totalRecords: null,
        progressPercent: null,
        fetchedRecords: null,
        normalizedRecords: null,
        failedRecords: null,
        message: null,
        resumable: false,
        creditOutcome: null,
      })
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("names the latest job in the source overview", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      const sourceId = nextTestUuid()
      yield* seedCoinbaseSource({ userId, principalId, sourceId })
      yield* seedUsableCredit({ userId })

      const client = yield* makeAuthenticatedClient({ userId })
      const beforeStart = yield* client.sources.getSourceOverview({
        params: { sourceId },
      })

      expect(beforeStart.latestSync.jobId).toBeNull()
      expect(beforeStart.latestSync.status).toBeNull()

      const started = yield* client.sources.startSourceSyncJob({
        params: { sourceId },
      })
      const afterStart = yield* client.sources.getSourceOverview({
        params: { sourceId },
      })

      expect(afterStart.latestSync.jobId).toBe(started.jobId)
      expect(afterStart.latestSync.status).toBe("pending")
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect(
    "reads a resumable credit-required status with its credit outcome, and no internal detail, after a worker stops the job on credit exhaustion",
    () =>
      Effect.gen(function* () {
        const userId = nextTestUuid()
        const principalId = nextTestUuid()
        const sourceId = nextTestUuid()
        yield* seedCoinbaseSource({ userId, principalId, sourceId })
        yield* seedUsableCredit({ userId })

        const client = yield* makeAuthenticatedClient({ userId })
        const started = yield* client.sources.startSourceSyncJob({
          params: { sourceId },
        })

        const sourceSyncJobRepository = yield* SourceSyncJobRepository
        yield* sourceSyncJobRepository.claimJob({
          jobId: started.jobId,
          workerId: "worker-1",
          startedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:00:00.000Z")),
        })
        yield* sourceSyncJobRepository.failCreditRequiredJob({
          jobId: started.jobId,
          completedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:10:00.000Z")),
          reasonCode: "no_usable_credits",
          availableCredits: 0,
          creditsConsumed: 3,
          additionalCreditsRequired: 2,
        })

        const status = yield* client.sources.getSourceSyncJobStatus({
          params: { sourceId, jobId: started.jobId },
        })

        expect(status.status).toBe("credit_required")
        expect(status.resumable).toBe(true)
        expect(status.message).toBeNull()
        expect(status.creditOutcome).toEqual({
          reasonCode: "no_usable_credits",
          availableCredits: 0,
          creditsConsumed: 3,
          additionalCreditsRequired: 2,
        })
        const encodedStatus = yield* EffectSchema.encodeEffect(
          EffectSchema.fromJsonString(EffectSchema.Unknown)
        )(status)
        expect(encodedStatus).not.toMatch(
          /sourceNormalizationRepository|SyncEngineStorageError|SourceSyncCreditExhaustedError|SELECT |INSERT |consumeTransactionCredit/i
        )
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect(
    "starts a fresh job that continues a credit-required sync once credits are topped up",
    () =>
      Effect.gen(function* () {
        const userId = nextTestUuid()
        const principalId = nextTestUuid()
        const sourceId = nextTestUuid()
        yield* seedCoinbaseSource({ userId, principalId, sourceId })
        yield* seedUsableCredit({ userId })

        const client = yield* makeAuthenticatedClient({ userId })
        const pausedJob = yield* client.sources.startSourceSyncJob({
          params: { sourceId },
        })

        const sourceSyncJobRepository = yield* SourceSyncJobRepository
        yield* sourceSyncJobRepository.claimJob({
          jobId: pausedJob.jobId,
          workerId: "worker-1",
          startedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:00:00.000Z")),
        })
        yield* sourceSyncJobRepository.failCreditRequiredJob({
          jobId: pausedJob.jobId,
          completedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:10:00.000Z")),
          reasonCode: "no_usable_credits",
          availableCredits: 0,
          creditsConsumed: 1,
          additionalCreditsRequired: 1,
        })

        const db = yield* drizzle
        yield* db.insert(schema.creditLedger).values({
          userId,
          delta: 2,
          kind: "top_up",
          reference: `test-credit-continue-${userId}`,
        })

        const continuedJob = yield* client.sources.startSourceSyncJob({
          params: { sourceId },
        })
        const repeatedJob = yield* client.sources.startSourceSyncJob({
          params: { sourceId },
        })

        // The credit-required job does not block the continue; a fresh job is
        // queued and asking again reuses it instead of stacking more jobs.
        expect(continuedJob.jobId).not.toBe(pausedJob.jobId)
        expect(continuedJob.status).toBe("queued")
        expect(repeatedJob.jobId).toBe(continuedJob.jobId)
        expect(queueEvents).toHaveLength(2)
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("returns the same queued job for duplicate start requests", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      const sourceId = nextTestUuid()
      yield* seedCoinbaseSource({ userId, principalId, sourceId })
      yield* seedUsableCredit({ userId })

      const client = yield* makeAuthenticatedClient({ userId })
      const firstJob = yield* client.sources.startSourceSyncJob({
        params: { sourceId },
      })
      const secondJob = yield* client.sources.startSourceSyncJob({
        params: { sourceId },
      })

      expect(secondJob.jobId).toBe(firstJob.jobId)
      expect(secondJob.status).toBe("queued")
      expect(queueEvents).toHaveLength(1)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("replay enqueues a replay-mode job", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      const sourceId = nextTestUuid()
      yield* seedCoinbaseSource({ userId, principalId, sourceId })
      yield* seedUsableCredit({ userId })

      const client = yield* makeAuthenticatedClient({ userId })
      const replay = yield* client.sources.replaySourceSyncJob({
        params: { sourceId },
      })

      expect(replay.status).toBe("queued")
      expect(queueEvents).toHaveLength(1)
      expect(queueEvents[0]).toMatchObject({
        jobId: replay.jobId,
        mode: "replay",
      })
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("returns an internal server error when queue enqueue fails", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      const sourceId = nextTestUuid()
      yield* seedCoinbaseSource({ userId, principalId, sourceId })
      yield* seedUsableCredit({ userId })

      const client = yield* makeAuthenticatedClient({ userId })
      const result = yield* client.sources
        .startSourceSyncJob({
          params: { sourceId },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("InternalServerError")
        expect(result.failure.message).toBe("Failed to enqueue source sync job.")
      }
    }).pipe(Effect.provide(QueueFailureHttpLive), Effect.scoped)
  )

  it.effect("refuses to start a sync for a registered user with no usable credits", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      const sourceId = nextTestUuid()
      yield* seedCoinbaseSource({ userId, principalId, sourceId })

      const client = yield* makeAuthenticatedClient({ userId })
      const result = yield* client.sources
        .startSourceSyncJob({ params: { sourceId } })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure" && result.failure._tag === "SourceCreditRequiredError") {
        expect(result.failure.reasonCode).toBe("no_usable_credits")
        expect(result.failure.availableCredits).toBe(0)
        expect(result.failure).not.toHaveProperty("cause")
        expect(result.failure).not.toHaveProperty("operation")
      } else {
        return yield* Effect.die("Expected SourceCreditRequiredError")
      }

      expect(queueEvents).toHaveLength(0)

      const db = yield* drizzle
      const jobs = yield* db
        .select({ id: schema.processingJobs.id })
        .from(schema.processingJobs)
        .where(eq(schema.processingJobs.sourceId, sourceId))
      expect(jobs).toEqual([])
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("starts a sync for a registered user with at least one usable credit", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      const sourceId = nextTestUuid()
      yield* seedCoinbaseSource({ userId, principalId, sourceId })
      yield* seedUsableCredit({ userId })

      const client = yield* makeAuthenticatedClient({ userId })
      const started = yield* client.sources.startSourceSyncJob({ params: { sourceId } })

      expect(started.status).toBe("queued")
      expect(queueEvents).toHaveLength(1)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("refuses to replay a sync for a registered user with no usable credits", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      const sourceId = nextTestUuid()
      yield* seedCoinbaseSource({ userId, principalId, sourceId })

      const client = yield* makeAuthenticatedClient({ userId })
      const result = yield* client.sources
        .replaySourceSyncJob({ params: { sourceId } })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure" && result.failure._tag === "SourceCreditRequiredError") {
        expect(result.failure.reasonCode).toBe("no_usable_credits")
        expect(result.failure.availableCredits).toBe(0)
      } else {
        return yield* Effect.die("Expected SourceCreditRequiredError")
      }

      expect(queueEvents).toHaveLength(0)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect(
    "refuses to start sync during source creation for a registered user with no usable credits",
    () =>
      Effect.gen(function* () {
        const userId = nextTestUuid()
        const principalId = nextTestUuid()
        const walletAddress = "So11111111111111111111111111111111111111112"
        yield* seedPrincipalUser({ userId, principalId })

        const client = yield* makeAuthenticatedClient({ userId })
        const result = yield* client.sources
          .createSource({
            payload: {
              type: "onchain",
              walletAddress,
              name: "No credits wallet",
              sync: true,
            },
          })
          .pipe(Effect.result)

        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure" && result.failure._tag === "SourceCreditRequiredError") {
          expect(result.failure.reasonCode).toBe("no_usable_credits")
          expect(result.failure.availableCredits).toBe(0)
        } else {
          return yield* Effect.die("Expected SourceCreditRequiredError")
        }

        expect(queueEvents).toHaveLength(0)
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect(
    "starts sync during source creation for a registered user with at least one usable credit",
    () =>
      Effect.gen(function* () {
        const userId = nextTestUuid()
        const principalId = nextTestUuid()
        const walletAddress = "So11111111111111111111111111111111111111112"
        yield* seedPrincipalUser({ userId, principalId })
        yield* seedUsableCredit({ userId })

        const client = yield* makeAuthenticatedClient({ userId })
        const response = yield* client.sources.createSource({
          payload: {
            type: "onchain",
            walletAddress,
            name: "Has credits wallet",
            sync: true,
          },
        })

        expect(response.syncJob).not.toBeNull()
        expect(queueEvents).toHaveLength(1)
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("does not require credits to resync a source claimed through an x402 payment", () =>
    Effect.gen(function* () {
      const walletAddress = "So11111111111111111111111111111111111111112"
      const anonymousClient = yield* makeUnauthenticatedClientWithPayment()
      const created = yield* anonymousClient.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress,
          name: "X402 claimed wallet",
          year: 2025,
          jurisdiction: "germany",
        },
      })

      if (created.claim === null) {
        return yield* Effect.die("Anonymous source creation did not return claim metadata")
      }

      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      yield* seedPrincipalUser({ userId, principalId })

      const authenticatedClient = yield* makeAuthenticatedClient({ userId })
      yield* authenticatedClient.principals.claimPrincipal({
        payload: {
          requestId: created.claim.requestId,
          claimToken: created.claim.claimToken,
          siwxProof: null,
        },
      })

      const started = yield* authenticatedClient.sources.startSourceSyncJob({
        params: { sourceId: created.source.id },
      })

      expect(started.sourceId).toBe(created.source.id)
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("reports that tax is not ready when no active run exists", () =>
    Effect.gen(function* () {
      const userId = nextTestUuid()
      const principalId = nextTestUuid()
      const sourceId = nextTestUuid()
      yield* seedCoinbaseSource({ userId, principalId, sourceId })

      const db = yield* drizzle
      const [providerAsset] = yield* db
        .insert(schema.providerAssets)
        .values({
          provider: "coinbase",
          naturalKey: `unresolved-${sourceId}`,
          currencyCode: "XYZ",
          retrievedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
        })
        .returning({ id: schema.providerAssets.id })

      if (providerAsset === undefined) {
        return yield* Effect.die("Failed to create unresolved provider asset fixture")
      }

      yield* db.insert(schema.providerAssetSourceUses).values({
        providerAssetRowId: providerAsset.id,
        sourceId,
      })

      const client = yield* makeAuthenticatedClient({ userId })
      const result = yield* client.sources
        .calculateTaxForSource({
          params: { sourceId },
          payload: { year: 2025, jurisdiction: "germany" },
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const failure = result.failure
        expect(failure._tag).toBe("SourceBadRequestError")
      }
    }).pipe(Effect.provide(TaxCalculationHttpLive), Effect.scoped)
  )

  it.effect("resolves a cached wallet name through the resolve-name endpoint", () =>
    Effect.gen(function* () {
      const fixture = yield* seedSyncEngineRepositoryFixture(REPORT_TEST_FIXTURE)
      const db = yield* drizzle
      yield* db.insert(schema.walletNameCache).values({
        namespace: "sns",
        name: "bonfida.sol",
        resolvedAddress: "HKKp49qGWXd639QsuH7JiLijfVW5UtCVY4s1n2HANwEA",
        resolvedAt: yield* DateTime.nowAsDate,
        expiresAt: DateTime.toDateUtc(DateTime.addDuration(yield* DateTime.now, "1 hour")),
      })

      const client = yield* makeAuthenticatedClient({ userId: fixture.userId })
      const resolution = yield* client.sources.resolveSourceName({
        payload: { name: "bonfida.sol" },
      })

      expect(resolution).toEqual({
        name: "bonfida.sol",
        namespace: "sns",
        resolvedAddress: "HKKp49qGWXd639QsuH7JiLijfVW5UtCVY4s1n2HANwEA",
        chainType: "solana",
      })
    }).pipe(Effect.provide(HttpLive))
  )

  it.effect("returns a coded 400 when the resolve-name input is not a wallet name", () =>
    Effect.gen(function* () {
      const fixture = yield* seedSyncEngineRepositoryFixture(REPORT_TEST_FIXTURE)
      const client = yield* makeAuthenticatedClient({ userId: fixture.userId })

      const result = yield* client.sources
        .resolveSourceName({ payload: { name: "not-a-name" } })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const failure = result.failure
        expect(failure._tag).toBe("SourceNameResolutionError")
        if (failure._tag === "SourceNameResolutionError") {
          expect(failure.code).toBe("invalid_name")
          expect(failure.namespace).toBeNull()
        }
      }
    }).pipe(Effect.provide(HttpLive))
  )
})
