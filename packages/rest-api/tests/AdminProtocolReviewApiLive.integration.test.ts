import { SourceSyncQueueUnexpectedTestLive } from "./support/SourceSyncQueueUnexpectedTestLive.ts"
import { nextTestUuid } from "./support/TestUuid.ts"
import * as DateTime from "effect/DateTime"
import { HttpApiClient } from "effect/unstable/httpapi"
import { Headers, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpServerTestLive } from "./support/http-server.ts"
import { beforeEach, describe, expect, it } from "@effect/vitest"
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
import * as Option from "effect/Option"
import { eq } from "../../persistence/src/query/index.ts"
import { drizzle } from "../../persistence/src/layers/PgClientLive.ts"
import { RepositoriesLive } from "../../persistence/src/layers/RepositoriesLive.ts"
import { schema } from "../../persistence/src/schema/index.ts"
import { makeIntegrationTestDatabaseContext } from "../../persistence/tests/support/integration-test-kit.ts"
import { TaxMaxiApi } from "../src/definitions/TaxMaxiApi.ts"
import { AnonSessionServiceLive } from "../src/layers/AnonSessionServiceLive.ts"
import {
  invalidSessionCookieCleanup,
  SimpleTokenValidatorLive,
} from "../src/layers/AuthMiddlewareLive.ts"
import { TaxMaxiApiLive } from "../src/layers/TaxMaxiApiLive.ts"
import { makeX402PaymentValidatorTestLive } from "./support/X402PaymentValidatorTestLive.ts"
import { SIWXProofVerifierTestLive } from "./support/SIWXProofVerifierTestLive.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_rest_api_protocol_review",
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

const SourceSyncRunServiceTestLive = Layer.succeed(SourceSyncRunService, {
  startSyncRun: () => Effect.die("SourceSyncRunService test stub: startSyncRun not implemented"),
  getSyncRun: () => Effect.die("SourceSyncRunService test stub: getSyncRun not implemented"),
} satisfies SourceSyncRunServiceShape)

const SourceSyncServiceTestLive = Layer.succeed(SourceSyncService, {
  startSourceSyncJob: () =>
    Effect.die("SourceSyncService test stub: startSourceSyncJob not implemented"),
  replaySourceSyncJob: () =>
    Effect.die("SourceSyncService test stub: replaySourceSyncJob not implemented"),
  getSourceSyncJob: () =>
    Effect.die("SourceSyncService test stub: getSourceSyncJob not implemented"),
} satisfies SourceSyncServiceShape)

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

const PersistenceLayer = Layer.mergeAll(
  RepositoriesLive,
  AuthServiceTestLive,
  PasswordHasherTestLive,
  SourceSyncRunServiceTestLive,
  SourceSyncServiceTestLive,
  TransferReconciliationServiceTestLive
).pipe(Layer.provideMerge(TestPgClientLive))

const HttpLive = HttpRouter.serve(
  TaxMaxiApiLive.pipe(
    Layer.provide(SourceSyncQueueUnexpectedTestLive),
    Layer.provide(AnonSessionServiceTestLive),
    Layer.provide(SIWXProofVerifierTestLive),
    Layer.provide(X402PaymentValidatorTestLive),
    Layer.provide(SimpleTokenValidatorLive)
  ),
  { middleware: invalidSessionCookieCleanup }
).pipe(Layer.provideMerge(PersistenceLayer), Layer.provideMerge(HttpServerTestLive))

const makeClient = ({
  role,
  userId,
}: {
  readonly role: "admin" | "user"
  readonly userId: string
}) =>
  Effect.gen(function* () {
    const baseHttpClient = yield* HttpClient.HttpClient
    return yield* HttpApiClient.makeWith(TaxMaxiApi, {
      httpClient: baseHttpClient.pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(`user_${userId}_${role}`))
      ),
    })
  })

const seedProtocolCandidate = Effect.gen(function* () {
  const db = yield* drizzle
  const [blockchain] = yield* db
    .select({ id: schema.blockchains.id })
    .from(schema.blockchains)
    .where(eq(schema.blockchains.name, "solana"))

  if (blockchain === undefined) {
    return yield* Effect.die("Missing solana blockchain seed")
  }

  const candidateId = nextTestUuid()
  const rejectedCandidateId = nextTestUuid()
  const observationId = nextTestUuid()
  const olderObservationId = nextTestUuid()
  const retrievedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"))

  yield* db.insert(schema.protocolCandidates).values([
    {
      id: candidateId,
      blockchainId: blockchain.id,
      subjectKind: "program",
      subjectIdentifier: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
      protocolNameHint: "Jupiter",
      categoryHint: "dex",
      mappingStatus: "pending_review",
      firstSeenAt: retrievedAt,
      lastSeenAt: retrievedAt,
    },
    {
      id: rejectedCandidateId,
      blockchainId: blockchain.id,
      subjectKind: "program",
      subjectIdentifier: "RejectedProgram11111111111111111111111111111",
      protocolNameHint: "Rejected",
      categoryHint: "dex",
      mappingStatus: "rejected",
      firstSeenAt: retrievedAt,
      lastSeenAt: retrievedAt,
    },
  ])
  yield* db.insert(schema.protocolCandidateObservations).values([
    {
      id: observationId,
      candidateId,
      onchainDataSource: "dune",
      onchainDataSourceObservationKey: "dune:jupiter:2026-01",
      observedWindowStart: DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")),
      observedWindowEnd: DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-02T00:00:00.000Z")),
      interactionCount: "12",
      transactionCount: "7",
      uniqueActorCount: "5",
      relatedSubjectIdentifiers: ["JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB"],
      sampleTransactionHashes: ["5qJupiterSampleSignature"],
      retrievedAt,
      rawPayload: { project: "jupiter", chain: "solana" },
    },
    {
      id: olderObservationId,
      candidateId,
      onchainDataSource: "dune",
      onchainDataSourceObservationKey: "dune:jupiter:2025-12",
      observedWindowStart: DateTime.toDateUtc(DateTime.makeUnsafe("2025-12-01T00:00:00.000Z")),
      observedWindowEnd: DateTime.toDateUtc(DateTime.makeUnsafe("2025-12-02T00:00:00.000Z")),
      interactionCount: "3",
      transactionCount: "2",
      uniqueActorCount: "1",
      relatedSubjectIdentifiers: [],
      sampleTransactionHashes: ["olderSampleSignature"],
      retrievedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-12-02T00:00:00.000Z")),
      rawPayload: { project: "jupiter", chain: "solana", period: "older" },
    },
  ])
  yield* db.insert(schema.duneProtocolCandidateObservations).values([
    {
      observationId,
      queryId: 7648079,
      queryName: "Solana DEX protocol candidates",
      queryVersion: 1,
    },
    {
      observationId: olderObservationId,
      queryId: 7648079,
      queryName: "Solana DEX protocol candidates",
      queryVersion: 1,
    },
  ])

  return { candidateId, observationId, olderObservationId }
})

const seedOlderPendingProtocolCandidate = Effect.gen(function* () {
  const db = yield* drizzle
  const [blockchain] = yield* db
    .select({ id: schema.blockchains.id })
    .from(schema.blockchains)
    .where(eq(schema.blockchains.name, "solana"))

  if (blockchain === undefined) {
    return yield* Effect.die("Missing solana blockchain seed")
  }

  const candidateId = nextTestUuid()
  yield* db.insert(schema.protocolCandidates).values({
    id: candidateId,
    blockchainId: blockchain.id,
    subjectKind: "program",
    subjectIdentifier: "OlderProgram111111111111111111111111111111",
    protocolNameHint: "Older Protocol",
    categoryHint: "dex",
    mappingStatus: "pending_review",
    firstSeenAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-12-01T00:00:00.000Z")),
    lastSeenAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-12-01T00:00:00.000Z")),
  })

  return { candidateId }
})

await Effect.runPromise(context.recreateTestDatabase())

describe("AdminProtocolReviewApiLive", () => {
  beforeEach(() => Effect.runPromise(Effect.asVoid(context.recreateTestDatabase())))

  it.effect("lists pending protocol candidates for admins", () =>
    Effect.gen(function* () {
      const { candidateId } = yield* seedProtocolCandidate
      const client = yield* makeClient({ userId: nextTestUuid(), role: "admin" })

      const response = yield* client.adminProtocolReview.listProtocolCandidates({
        query: {},
      })

      expect(response.candidates).toHaveLength(1)
      expect(response.candidates[0]?.id).toBe(candidateId)
      expect(response.candidates[0]?.mappingStatus).toBe("pending_review")
      expect(response.candidates[0]?.observationCount).toBe(2)
      expect(response.page).toEqual({
        nextCursor: null,
        hasMore: false,
      })
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("returns candidate detail and TaxMaxi transaction types for admins", () =>
    Effect.gen(function* () {
      const { candidateId, observationId } = yield* seedProtocolCandidate
      const client = yield* makeClient({ userId: nextTestUuid(), role: "admin" })

      const detail = yield* client.adminProtocolReview.getProtocolCandidate({
        params: { candidateId },
        query: {
          observationLimit: 1,
        },
      })
      const transactionTypes =
        yield* client.adminProtocolReview.listTaxMaxiTransactionTypes(undefined)

      expect(detail.candidate.id).toBe(candidateId)
      expect(detail.candidate.protocolNameHint).toBe("Jupiter")
      expect(detail.observations).toHaveLength(1)
      expect(detail.observationsPage).toEqual({
        nextCursor: expect.any(String),
        hasMore: true,
      })
      expect(detail.observationsPage.nextCursor).not.toBe(observationId)
      expect(detail.observations[0]?.relatedSubjectIdentifiers).toEqual([
        "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB",
      ])
      expect(detail.observations[0]?.sampleTransactionHashes).toEqual(["5qJupiterSampleSignature"])
      expect(detail.observations[0]?.sourceMetadata).toMatchObject({
        source: "dune",
        queryId: 7648079,
        queryName: "Solana DEX protocol candidates",
        queryVersion: 1,
      })
      expect(transactionTypes.transactionTypes.length).toBeGreaterThan(0)
      expect(transactionTypes.transactionTypes[0]?.typeKey).toBeDefined()
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("uses self-contained cursors for pending protocol candidates", () =>
    Effect.gen(function* () {
      const db = yield* drizzle
      const { candidateId } = yield* seedProtocolCandidate
      const { candidateId: olderCandidateId } = yield* seedOlderPendingProtocolCandidate
      const client = yield* makeClient({ userId: nextTestUuid(), role: "admin" })

      const firstPage = yield* client.adminProtocolReview.listProtocolCandidates({
        query: {
          limit: 1,
        },
      })
      expect(firstPage.candidates.map((candidate) => candidate.id)).toEqual([candidateId])
      expect(firstPage.page.nextCursor).not.toBe(candidateId)

      const cursor = firstPage.page.nextCursor
      if (cursor === null) {
        return yield* Effect.die("Expected protocol candidate cursor")
      }

      yield* db
        .update(schema.protocolCandidates)
        .set({ lastSeenAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-11-01T00:00:00.000Z")) })
        .where(eq(schema.protocolCandidates.id, candidateId))

      const secondPage = yield* client.adminProtocolReview.listProtocolCandidates({
        query: {
          cursor,
          limit: 1,
        },
      })

      expect(secondPage.candidates.map((candidate) => candidate.id)).toEqual([olderCandidateId])
      expect(secondPage.page).toEqual({
        nextCursor: null,
        hasMore: false,
      })
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("uses self-contained cursors for protocol candidate observations", () =>
    Effect.gen(function* () {
      const db = yield* drizzle
      const { candidateId, observationId, olderObservationId } = yield* seedProtocolCandidate
      const client = yield* makeClient({ userId: nextTestUuid(), role: "admin" })

      const firstPage = yield* client.adminProtocolReview.getProtocolCandidate({
        params: { candidateId },
        query: {
          observationLimit: 1,
        },
      })
      expect(firstPage.observations.map((observation) => observation.id)).toEqual([observationId])
      expect(firstPage.observationsPage.nextCursor).not.toBe(observationId)

      const cursor = firstPage.observationsPage.nextCursor
      if (cursor === null) {
        return yield* Effect.die("Expected protocol candidate observation cursor")
      }

      yield* db
        .update(schema.protocolCandidateObservations)
        .set({ retrievedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-11-01T00:00:00.000Z")) })
        .where(eq(schema.protocolCandidateObservations.id, observationId))

      const secondPage = yield* client.adminProtocolReview.getProtocolCandidate({
        params: { candidateId },
        query: {
          observationCursor: cursor,
          observationLimit: 1,
        },
      })

      expect(secondPage.observations.map((observation) => observation.id)).toEqual([
        olderObservationId,
      ])
      expect(secondPage.observationsPage).toEqual({
        nextCursor: null,
        hasMore: false,
      })
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("rejects non-admin sessions", () =>
    Effect.gen(function* () {
      yield* seedProtocolCandidate
      const client = yield* makeClient({ userId: nextTestUuid(), role: "user" })

      const result = yield* client.adminProtocolReview
        .listProtocolCandidates({
          query: {},
        })
        .pipe(Effect.result)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("ForbiddenError")
      }
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("preserves a valid non-admin session cookie after a forbidden response", () =>
    Effect.gen(function* () {
      const baseHttpClient = yield* HttpClient.HttpClient
      const userId = nextTestUuid()
      const response = yield* HttpClientRequest.get("/v1/admin/protocol-review/candidates").pipe(
        HttpClientRequest.setHeader("cookie", `taxmaxi_session=user_${userId}_user`),
        baseHttpClient.execute
      )

      expect(response.status).toBe(403)
      expect(Headers.get(response.headers, "set-cookie")).toEqual(Option.none())
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )

  it.effect("clears an invalid admin session cookie after an unauthorized response", () =>
    Effect.gen(function* () {
      const baseHttpClient = yield* HttpClient.HttpClient
      const response = yield* HttpClientRequest.get("/v1/admin/protocol-review/candidates").pipe(
        HttpClientRequest.setHeader("cookie", "taxmaxi_session=invalid-session"),
        baseHttpClient.execute
      )

      expect(response.status).toBe(401)
      const setCookie = Headers.get(response.headers, "set-cookie")
      expect(Option.isSome(setCookie)).toBe(true)
      if (Option.isSome(setCookie)) {
        expect(setCookie.value).toContain("taxmaxi_session=;")
      }
    }).pipe(Effect.provide(HttpLive), Effect.scoped)
  )
})
