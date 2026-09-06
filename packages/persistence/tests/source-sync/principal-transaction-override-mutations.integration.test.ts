import { beforeEach, describe, expect, it } from "@effect/vitest"
import type { MovementCorrectionInput } from "@my/core/accounting"
import { AuthUserId } from "@my/core/authentication"
import * as Result from "effect/Result"
import { CurrencyCode } from "@my/core/currency"
import { PrincipalId } from "@my/core/ownership"
import { eq, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import { SourceSyncJobRepository, type SourceSyncExecutionState } from "@my/sync-engine/services"
import { SourceSyncJobRepositoryLive } from "../../src/layers/SourceSyncJobRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { PrincipalTransactionOverrideRepositoryLive } from "../../src/layers/PrincipalTransactionOverrideRepositoryLive.ts"
import {
  PrincipalTransactionOverrideRepository,
  type PrincipalTransactionOverrideRepositoryShape,
  type PrincipalTransactionOverrideContext,
} from "../../src/services/PrincipalTransactionOverrideRepository.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_BTC_ASSET_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const TEST_PRINCIPAL_ID = "00000000-0000-4000-8000-000000008681"
const TEST_USER_ID = "00000000-0000-4000-8000-000000008682"
const SOURCE_ID = "00000000-0000-4000-8000-000000008683"
const TARGET_ID = "00000000-0000-4000-8000-000000008601"
const OTHER_ID = "00000000-0000-4000-8000-000000008602"
const time = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00Z"))
const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_movement_mutations",
})
const ownedPrincipal = PrincipalId.make(TEST_PRINCIPAL_ID)
const read = (targetId = TARGET_ID, principalId = ownedPrincipal) =>
  context.runWithLayer({
    layer: PrincipalTransactionOverrideRepositoryLive,
    effect: Effect.flatMap(PrincipalTransactionOverrideRepository, (repo) =>
      repo.findContext({ principalId, targetId, reportingCurrency: CurrencyCode.make("EUR") })
    ),
  })

const seed = Effect.gen(function* () {
  const fixture = yield* seedSyncEngineRepositoryFixture({
    principalId: TEST_PRINCIPAL_ID,
    userId: TEST_USER_ID,
    sourceId: SOURCE_ID,
  })
  yield* seedSyncEngineAssets(fixture)
  const db = yield* drizzle
  yield* db.insert(schema.movementCorrectionTargets).values({
    id: TARGET_ID,
    principalId: TEST_PRINCIPAL_ID,
    sourceId: fixture.sourceId,
    sourceRecordKey: "synthetic-record",
    componentKey: "amount",
  })
  const [transaction] = yield* db
    .insert(schema.transactions)
    .values({
      sourceId: fixture.sourceId,
      principalId: TEST_PRINCIPAL_ID,
      externalId: "synthetic-record",
      timestamp: time,
      transactionType: null,
      providerTransactionType: "synthetic-credit",
    })
    .returning({ id: schema.transactions.id })
  if (transaction === undefined) return yield* Effect.die("Missing synthetic transaction")
  const legValues = {
    sourceId: fixture.sourceId,
    principalId: TEST_PRINCIPAL_ID,
    externalId: "synthetic-record:main",
    timestamp: time,
    movementCorrectionTargetId: TARGET_ID,
    assetId: TEST_BTC_ASSET_ID,
    amount: "3",
    kind: "acquisition",
    provenance: "deterministic",
    originKind: "none",
    transactionId: transaction.id,
    fiatAmount: null,
    fiatCurrency: null,
  } satisfies typeof schema.transactionLegs.$inferInsert
  const [leg] = yield* db
    .insert(schema.transactionLegs)
    .values(legValues)
    .returning({ id: schema.transactionLegs.id })
  if (leg === undefined) return yield* Effect.die("Missing synthetic leg")
  return { ...fixture, legId: leg.id, transactionId: transaction.id, legValues }
})

await Effect.runPromise(context.recreateTestDatabase())
beforeEach(() => Effect.runPromise(context.recreateTestDatabase()))

const withRepository = <A, E>(
  use: (repository: PrincipalTransactionOverrideRepositoryShape) => Effect.Effect<A, E>
) =>
  context.runWithLayer({
    layer: PrincipalTransactionOverrideRepositoryLive,
    effect: Effect.flatMap(PrincipalTransactionOverrideRepository, use),
  })
const getContext = read().pipe(
  Effect.flatMap((value) =>
    Option.isSome(value) ? Effect.succeed(value.value) : Effect.die("Missing synthetic target")
  )
)
const price = {
  _tag: "price",
  input: {
    _tag: "total_value",
    amount: "20.00000000000000000001",
    currency: CurrencyCode.make("EUR"),
  },
} satisfies MovementCorrectionInput
const parameters = (
  current: PrincipalTransactionOverrideContext,
  kind: "price" | "classification" = "price"
) => ({
  principalId: ownedPrincipal,
  actorUserId: AuthUserId.make(TEST_USER_ID),
  targetId: TARGET_ID,
  expectedSystemRevision: current.current?.facts.systemRevision ?? "absent",
  expectedLeafId: current[kind].leaf?.id ?? null,
  reason: "Synthetic user evidence",
  reportingCurrency: CurrencyCode.make("EUR"),
  input: price,
})
const counts = () =>
  Effect.promise(() =>
    context.runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        return {
          history: (yield* db
            .select({ id: schema.principalTransactionOverrides.id })
            .from(schema.principalTransactionOverrides)).length,
          applications: (yield* db
            .select({ id: schema.principalTransactionOverrideApplications.overrideId })
            .from(schema.principalTransactionOverrideApplications)).length,
          jobs: (yield* db.select({ id: schema.processingJobs.id }).from(schema.processingJobs))
            .length,
        }
      })
    )
  )
const initialize = Effect.promise(() => context.runPg(seed))

describe("atomic movement correction mutations", () => {
  for (const kind of ["price", "classification"] as const) {
    for (const valuation of ["provider", "market"] as const) {
      for (const operation of ["create", "replace", "withdraw"] as const) {
        it.effect(
          `rejects stale ${valuation} inspection for ${kind} ${operation} without writes`,
          () =>
            Effect.gen(function* () {
              const fixture = yield* initialize
              const updateValuation = (amount: string) =>
                Effect.promise(() =>
                  context.runPg(
                    Effect.gen(function* () {
                      const db = yield* drizzle
                      if (valuation === "provider") {
                        yield* db
                          .update(schema.transactions)
                          .set({ providerFiatAmount: amount, providerFiatCurrency: "EUR" })
                          .where(eq(schema.transactions.id, fixture.transactionId))
                      } else {
                        yield* db.delete(schema.assetPrices)
                        yield* db.insert(schema.assetPrices).values({
                          assetId: TEST_BTC_ASSET_ID,
                          currency: "EUR",
                          price: amount,
                          timestamp: time,
                          source: "synthetic-market",
                        })
                      }
                    })
                  )
                )
              yield* updateValuation("20")
              const input: MovementCorrectionInput =
                kind === "price"
                  ? price
                  : { _tag: "classification", input: { _tag: "inbound", cause: "purchase" } }
              if (operation !== "create") {
                const initial = yield* getContext
                yield* withRepository((repo) =>
                  repo.create({ ...parameters(initial, kind), input })
                )
              }
              const inspected = yield* getContext
              expect(inspected.current?.valuationEvidence.facts).toHaveLength(1)
              yield* updateValuation("30")
              const current = yield* getContext
              expect(current.current?.facts.systemRevision).not.toBe(
                inspected.current?.facts.systemRevision
              )
              const before = yield* counts()
              const request = { ...parameters(inspected, kind), input }
              const result = yield* withRepository((repo) =>
                operation === "withdraw"
                  ? repo.withdraw({ ...request, kind })
                  : repo[operation](request)
              ).pipe(Effect.result)
              expect(Result.isFailure(result) ? result.failure._tag : null).toBe(
                "MovementCorrectionConflictError"
              )
              expect(yield* counts()).toEqual(before)
              if (operation !== "create") {
                expect(current[kind].active?.inspectedValuationEvidence).toEqual(
                  inspected.current?.valuationEvidence
                )
                expect(current[kind].active?.input).toEqual(input)
              }
            })
        )
      }
    }
  }

  it.effect(
    "retains exact current facts, actor, zero and independent streams with one pending replay",
    () =>
      Effect.gen(function* () {
        yield* initialize
        const initial = yield* getContext
        const created = yield* withRepository((repo) => repo.create(parameters(initial)))
        expect(Option.isSome(created)).toBe(true)
        const afterPrice = yield* getContext
        expect(afterPrice.price.active?.input).toEqual(price)
        expect(afterPrice.price.active?.inspectedFacts).toEqual(initial.current?.facts)
        expect(afterPrice.price.active?.inspectedSystem).toEqual(initial.current?.system)
        expect(afterPrice.price.active?.actorUserId).toBe(TEST_USER_ID)
        yield* withRepository((repo) =>
          repo.create({
            ...parameters(afterPrice, "classification"),
            input: { _tag: "classification", input: { _tag: "inbound", cause: "purchase" } },
          })
        )
        const beforeZero = yield* getContext
        yield* withRepository((repo) =>
          repo.replace({
            ...parameters(beforeZero),
            input: {
              _tag: "price",
              input: { _tag: "unit_price", amount: "0", currency: CurrencyCode.make("EUR") },
            },
          })
        )
        const final = yield* getContext
        expect(final.price.active?.input).toEqual({
          _tag: "price",
          input: { _tag: "unit_price", amount: "0", currency: "EUR" },
        })
        expect(final.classification.active?.id).toBe(beforeZero.classification.active?.id)
        expect(final.current?.system.recordedFiatAmount).toBeNull()
        expect(yield* counts()).toEqual({ history: 3, applications: 3, jobs: 1 })
        const links = yield* Effect.promise(() =>
          context.runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return yield* db
                .select({
                  overrideId: schema.principalTransactionOverrideApplications.overrideId,
                  sourceId: schema.principalTransactionOverrideApplications.sourceId,
                  jobId: schema.principalTransactionOverrideApplications.processingJobId,
                })
                .from(schema.principalTransactionOverrideApplications)
            })
          )
        )
        expect(links.map((link) => link.overrideId).sort()).toEqual(
          final.history.map((record) => record.id).sort()
        )
        expect(new Set(links.map((link) => link.jobId)).size).toBe(1)
        expect(links.every((link) => link.sourceId === SOURCE_ID)).toBe(true)
      })
  )

  it.effect("has one winner for concurrent replacements and no work for the stale loser", () =>
    Effect.gen(function* () {
      yield* initialize
      const initial = yield* getContext
      yield* withRepository((repo) => repo.create(parameters(initial)))
      const request = parameters(yield* getContext)
      const results = yield* Effect.all(
        [
          withRepository((repo) => repo.replace(request)).pipe(Effect.result),
          withRepository((repo) => repo.replace(request)).pipe(Effect.result),
        ],
        { concurrency: "unbounded" }
      )
      expect(results.filter(Result.isSuccess)).toHaveLength(1)
      const failures = results.filter(Result.isFailure)
      expect(failures).toHaveLength(1)
      expect(failures[0]?.failure).toMatchObject({
        _tag: "MovementCorrectionConflictError",
        conflictKinds: ["stream_leaf"],
      })
      expect(yield* counts()).toEqual({ history: 2, applications: 2, jobs: 1 })
    })
  )

  it.effect(
    "requires the actual withdrawal leaf for create-after-withdraw and preserves its chain",
    () =>
      Effect.gen(function* () {
        yield* initialize
        let current = yield* getContext
        yield* withRepository((repo) => repo.create(parameters(current)))
        current = yield* getContext
        yield* withRepository((repo) => repo.withdraw({ ...parameters(current), kind: "price" }))
        current = yield* getContext
        expect(current.price.active).toBeNull()
        const withdrawalId = current.price.leaf?.id
        const stale = yield* withRepository((repo) =>
          repo.create({ ...parameters(current), expectedLeafId: null })
        ).pipe(Effect.result)
        expect(stale).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "MovementCorrectionConflictError" },
        })
        expect(yield* counts()).toEqual({ history: 2, applications: 2, jobs: 1 })
        yield* withRepository((repo) => repo.create(parameters(current)))
        expect((yield* getContext).price.active?.supersedesOverrideId).toBe(withdrawalId)
      })
  )

  it.effect(
    "rejects stale revisions, invalid actor/reason/currency/direction and inactive operations without work",
    () =>
      Effect.gen(function* () {
        yield* initialize
        const request = parameters(yield* getContext)
        const usd = yield* withRepository((repo) =>
          repo.findContext({
            principalId: ownedPrincipal,
            targetId: TARGET_ID,
            reportingCurrency: CurrencyCode.make("USD"),
          })
        )
        if (Option.isNone(usd) || usd.value.current === null)
          return yield* Effect.die("Missing USD inspection")
        const usdRevision = usd.value.current.facts.systemRevision
        const attempts = [
          withRepository((repo) => repo.create({ ...request, expectedSystemRevision: "stale" })),
          withRepository((repo) =>
            repo.create({ ...request, actorUserId: AuthUserId.make(OTHER_ID) })
          ),
          withRepository((repo) => repo.create({ ...request, reason: " " })),
          withRepository((repo) =>
            repo.create({
              ...request,
              expectedSystemRevision: usdRevision,
              reportingCurrency: CurrencyCode.make("USD"),
            })
          ),
          withRepository((repo) =>
            repo.create({
              ...request,
              input: { _tag: "classification", input: { _tag: "outbound", cause: "sale" } },
            })
          ),
          withRepository((repo) => repo.replace(request)),
          withRepository((repo) => repo.withdraw({ ...request, kind: "price" })),
        ]
        const outcomes = yield* Effect.forEach(attempts, (attempt) => attempt.pipe(Effect.result))
        expect(outcomes.every(Result.isFailure)).toBe(true)
        expect(
          outcomes.map((outcome) => (Result.isFailure(outcome) ? outcome.failure._tag : null))
        ).toEqual([
          "MovementCorrectionConflictError",
          "MovementCorrectionValidationError",
          "MovementCorrectionValidationError",
          "MovementCorrectionInputError",
          "MovementCorrectionInputError",
          "MovementCorrectionValidationError",
          "MovementCorrectionValidationError",
        ])
        expect(yield* counts()).toEqual({ history: 0, applications: 0, jobs: 0 })
      })
  )

  it.effect(
    "keeps disappeared history readable but rejects all mutations without inventing current facts",
    () =>
      Effect.gen(function* () {
        yield* initialize
        let current = yield* getContext
        yield* withRepository((repo) => repo.create(parameters(current)))
        current = yield* getContext
        const request = parameters(current)
        yield* Effect.promise(() =>
          context.runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db
                .delete(schema.transactionLegs)
                .where(eq(schema.transactionLegs.movementCorrectionTargetId, TARGET_ID))
            })
          )
        )
        const disappeared = yield* getContext
        expect(disappeared.current).toBeNull()
        expect(disappeared.history).toEqual(current.history)
        for (const operation of ["create", "replace", "withdraw"] as const) {
          const result = yield* withRepository((repo) =>
            operation === "withdraw"
              ? repo.withdraw({ ...request, kind: "price" })
              : repo[operation](request)
          ).pipe(Effect.result)
          expect(result).toMatchObject({ _tag: "Failure", failure: { code: "target_unavailable" } })
        }
        expect(yield* counts()).toEqual({ history: 1, applications: 1, jobs: 1 })
      })
  )

  it.effect("returns the same not-found result for foreign and missing targets", () =>
    Effect.gen(function* () {
      yield* initialize
      const request = parameters(yield* getContext)
      const missing = yield* withRepository((repo) =>
        repo.create({ ...request, targetId: OTHER_ID })
      )
      const foreign = yield* withRepository((repo) =>
        repo.create({ ...request, principalId: PrincipalId.make(OTHER_ID) })
      )
      expect(missing).toEqual(Option.none())
      expect(foreign).toEqual(missing)
      expect(yield* counts()).toEqual({ history: 0, applications: 0, jobs: 0 })
    })
  )

  it.effect(
    "requests one follow-up for running work and records its exact durable job without queue availability",
    () =>
      Effect.gen(function* () {
        yield* initialize
        let current = yield* getContext
        yield* withRepository((repo) => repo.create(parameters(current)))
        yield* Effect.promise(() =>
          context.runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db
                .update(schema.processingJobs)
                .set({ status: "processing" })
                .where(eq(schema.processingJobs.sourceId, SOURCE_ID))
            })
          )
        )
        current = yield* getContext
        yield* withRepository((repo) => repo.replace(parameters(current)))
        current = yield* getContext
        yield* withRepository((repo) => repo.withdraw({ ...parameters(current), kind: "price" }))
        const jobs = yield* Effect.promise(() =>
          context.runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return yield* db
                .select({
                  id: schema.processingJobs.id,
                  followUpMode: schema.processingJobs.followUpMode,
                })
                .from(schema.processingJobs)
            })
          )
        )
        expect(jobs).toHaveLength(1)
        expect(jobs[0]?.followUpMode).toBe("replay")
        const job = jobs[0]
        if (job === undefined) return yield* Effect.die("Missing durable synthetic job")
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
        yield* context.runWithLayer({
          layer: SourceSyncJobRepositoryLive,
          effect: Effect.flatMap(SourceSyncJobRepository, (repository) =>
            repository.completeJob({ jobId: job.id, state })
          ),
        })
        const settled = yield* Effect.promise(() =>
          context.runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return yield* db
                .select({
                  id: schema.processingJobs.id,
                  status: schema.processingJobs.status,
                  mode: schema.processingJobs.mode,
                  followUpJobId: schema.processingJobs.followUpJobId,
                })
                .from(schema.processingJobs)
            })
          )
        )
        const completed = settled.find((row) => row.id === job.id)
        expect(completed?.status).toBe("completed")
        expect(settled.find((row) => row.id === completed?.followUpJobId)).toMatchObject({
          mode: "replay",
          status: "pending",
        })

        expect(yield* counts()).toEqual({ history: 3, applications: 3, jobs: 2 })
      })
  )
  it.effect("has one winner for simultaneous initial creates", () =>
    Effect.gen(function* () {
      yield* initialize
      const request = parameters(yield* getContext)
      const results = yield* Effect.all(
        [
          withRepository((repo) => repo.create(request)).pipe(Effect.result),
          withRepository((repo) => repo.create(request)).pipe(Effect.result),
        ],
        { concurrency: "unbounded" }
      )
      expect(results.filter(Result.isSuccess)).toHaveLength(1)
      expect(results.filter(Result.isFailure)[0]?.failure).toMatchObject({
        _tag: "MovementCorrectionConflictError",
        conflictKinds: ["stream_leaf"],
      })
      expect(yield* counts()).toEqual({ history: 1, applications: 1, jobs: 1 })
    })
  )

  it.effect("rechecks source ownership after inspection", () =>
    Effect.gen(function* () {
      yield* initialize
      const request = parameters(yield* getContext)
      yield* Effect.promise(() =>
        context.runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .insert(schema.users)
              .values({ id: OTHER_ID, email: "synthetic-new-owner@example.test" })
            yield* db
              .insert(schema.principals)
              .values({ id: OTHER_ID, kind: "user", userId: OTHER_ID })
            yield* db.transaction((tx) =>
              tx
                .update(schema.sources)
                .set({ principalId: OTHER_ID })
                .where(eq(schema.sources.id, SOURCE_ID))
            )
          })
        )
      )
      expect(yield* withRepository((repo) => repo.create(request))).toEqual(Option.none())
      expect(yield* read()).toEqual(Option.none())
      expect(Option.isSome(yield* read(TARGET_ID, PrincipalId.make(OTHER_ID)))).toBe(true)
      expect(yield* counts()).toEqual({ history: 0, applications: 0, jobs: 0 })
    })
  )

  it.effect("rolls back history and replay if the application link cannot persist", () =>
    Effect.gen(function* () {
      yield* initialize
      const request = parameters(yield* getContext)
      yield* Effect.promise(() =>
        context.runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.execute(
              sql`create function reject_test_movement_application() returns trigger language plpgsql as $$ begin raise exception 'synthetic application write failure'; end $$`
            )
            yield* db.execute(
              sql`create trigger reject_test_movement_application before insert on principal_transaction_override_applications for each row execute function reject_test_movement_application()`
            )
          })
        )
      )
      const result = yield* withRepository((repo) => repo.create(request)).pipe(Effect.result)
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "PersistenceError" } })
      expect(yield* counts()).toEqual({ history: 0, applications: 0, jobs: 0 })
      yield* Effect.promise(() =>
        context.runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.execute(
              sql`drop trigger reject_test_movement_application on principal_transaction_override_applications`
            )
            yield* db.execute(sql`drop function reject_test_movement_application()`)
          })
        )
      )
      yield* withRepository((repo) => repo.create(request))
      expect(yield* counts()).toEqual({ history: 1, applications: 1, jobs: 1 })
    })
  )

  it.effect(
    "confirms changed quantity before replacement and preserves the old inspected fact",
    () =>
      Effect.gen(function* () {
        yield* initialize
        let current = yield* getContext
        yield* withRepository((repo) => repo.create(parameters(current)))
        current = yield* getContext
        const oldRequest = parameters(current)
        yield* Effect.promise(() =>
          context.runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db
                .update(schema.transactionLegs)
                .set({ amount: "7" })
                .where(eq(schema.transactionLegs.movementCorrectionTargetId, TARGET_ID))
            })
          )
        )
        expect(
          yield* withRepository((repo) => repo.replace(oldRequest)).pipe(Effect.result)
        ).toMatchObject({ _tag: "Failure", failure: { conflictKinds: ["system_revision"] } })
        const changed = yield* getContext
        yield* withRepository((repo) => repo.replace(parameters(changed)))
        const final = yield* getContext
        expect(final.price.active?.inspectedFacts.quantity).toEqual(changed.current?.facts.quantity)
        expect(
          final.history.find((record) => record.operation === "create")?.inspectedFacts.quantity
        ).toEqual(current.current?.facts.quantity)
      })
  )

  it.effect("prices fees but rejects fee classification", () =>
    Effect.gen(function* () {
      yield* initialize
      yield* Effect.promise(() =>
        context.runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.transactionLegs)
              .set({ kind: "fee" })
              .where(eq(schema.transactionLegs.movementCorrectionTargetId, TARGET_ID))
          })
        )
      )
      let current = yield* getContext
      yield* withRepository((repo) => repo.create(parameters(current)))
      current = yield* getContext
      expect(current.price.active?.inspectedFacts.structure).toBe("fee")
      const result = yield* withRepository((repo) =>
        repo.create({
          ...parameters(current, "classification"),
          input: { _tag: "classification", input: { _tag: "outbound", cause: "payment" } },
        })
      ).pipe(Effect.result)
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { code: "fee_classification_forbidden" },
      })
      expect(yield* counts()).toEqual({ history: 1, applications: 1, jobs: 1 })
    })
  )
  for (const kind of ["price", "classification"] as const) {
    it.effect(`records effective identity and rejects stale asset CAS for the ${kind} stream`, () =>
      Effect.gen(function* () {
        const fixture = yield* initialize
        const before = yield* getContext
        const effectiveAssetId = "00000000-0000-4000-8000-000000008691"
        const nextAssetId = "00000000-0000-4000-8000-000000008692"
        const assetOverride = yield* Effect.promise(() =>
          context.runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db.insert(schema.assets).values([
                {
                  id: effectiveAssetId,
                  name: "Synthetic effective asset",
                  symbol: "SYN1",
                  type: "fungible",
                },
                {
                  id: nextAssetId,
                  name: "Synthetic changed asset",
                  symbol: "SYN2",
                  type: "fungible",
                },
              ])
              const [provider] = yield* db
                .insert(schema.providerAssets)
                .values({
                  provider: "coinbase",
                  providerAssetId: "synthetic-cas-provider",
                  currencyCode: "SYN",
                  name: "Synthetic provider",
                  exponent: 8,
                  providerType: "crypto",
                  rawProviderPayload: {},
                  evidenceRevision: 1,
                  discoveredAt: time,
                  retrievedAt: time,
                })
                .returning({ id: schema.providerAssets.id })
              if (provider === undefined) return yield* Effect.die("Missing provider fixture")
              yield* db.insert(schema.providerAssetMappings).values({
                providerAssetRowId: provider.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                mappingStatus: "approved",
              })
              yield* db
                .update(schema.transactionLegs)
                .set({ providerAssetRowId: provider.id })
                .where(eq(schema.transactionLegs.id, fixture.legId))
              const [target] = yield* db
                .insert(schema.principalAssetOverrideTargets)
                .values({
                  principalId: TEST_PRINCIPAL_ID,
                  targetKind: "provider_asset",
                  providerAssetRowId: provider.id,
                })
                .returning({ id: schema.principalAssetOverrideTargets.id })
              if (target === undefined) return yield* Effect.die("Missing asset target")
              const draft = {
                principalId: TEST_PRINCIPAL_ID,
                targetId: target.id,
                kind: "identity" as const,
                operation: "create" as const,
                inspectedSystemRevision: "synthetic-asset-revision",
                inspectedSystemIdentity: "resolved" as const,
                inspectedSystemAssetId: TEST_BTC_ASSET_ID,
                replacementAssetId: effectiveAssetId,
                actorUserId: TEST_USER_ID,
                reason: "Synthetic identity evidence",
              }
              const [row] = yield* db
                .insert(schema.principalAssetOverrides)
                .values(draft)
                .returning({ id: schema.principalAssetOverrides.id })
              if (row === undefined) return yield* Effect.die("Missing asset override")
              return { draft, id: row.id }
            })
          )
        )
        const input: MovementCorrectionInput =
          kind === "price"
            ? price
            : { _tag: "classification", input: { _tag: "inbound", cause: "purchase" } }
        const noWrites = yield* counts()
        const staleCreate = yield* withRepository((repo) =>
          repo.create({ ...parameters(before, kind), input })
        ).pipe(Effect.result)
        expect(staleCreate).toMatchObject({
          _tag: "Failure",
          failure: { conflictKinds: ["system_revision"] },
        })
        expect(yield* counts()).toEqual(noWrites)
        const current = yield* getContext
        expect(current.current?.facts.economicAssetId).toBe(effectiveAssetId)
        const accepted = yield* withRepository((repo) =>
          repo.create({ ...parameters(current, kind), input })
        )
        if (Option.isNone(accepted)) return yield* Effect.die("Missing accepted correction")
        expect(accepted.value.context[kind].active?.inspectedFacts.economicAssetId).toBe(
          effectiveAssetId
        )
        const inspected = accepted.value.context[kind].active?.inspectedFacts
        yield* Effect.promise(() =>
          context.runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db.insert(schema.principalAssetOverrides).values({
                ...assetOverride.draft,
                operation: "replace",
                supersedesOverrideId: assetOverride.id,
                replacementAssetId: nextAssetId,
              })
            })
          )
        )
        const beforeConflict = yield* counts()
        const staleReplace = yield* withRepository((repo) =>
          repo.replace({ ...parameters(accepted.value.context, kind), input })
        ).pipe(Effect.result)
        const staleWithdraw = yield* withRepository((repo) =>
          repo.withdraw({ ...parameters(accepted.value.context, kind), kind })
        ).pipe(Effect.result)
        expect(staleReplace).toMatchObject({
          _tag: "Failure",
          failure: { conflictKinds: ["system_revision"] },
        })
        expect(staleWithdraw).toMatchObject({
          _tag: "Failure",
          failure: { conflictKinds: ["system_revision"] },
        })
        expect(yield* counts()).toEqual(beforeConflict)
        const changed = yield* getContext
        expect(changed.current?.facts.economicAssetId).toBe(nextAssetId)
        expect(changed[kind].active?.inspectedFacts).toEqual(inspected)
        yield* withRepository((repo) => repo.replace({ ...parameters(changed, kind), input }))
        const replaced = yield* getContext
        expect(replaced[kind].active?.inspectedFacts.economicAssetId).toBe(nextAssetId)
        yield* withRepository((repo) => repo.withdraw({ ...parameters(replaced, kind), kind }))
        const withdrawn = yield* getContext
        expect(withdrawn[kind].leaf?.inspectedFacts.economicAssetId).toBe(nextAssetId)
        expect(
          withdrawn.history.find((row) => row.id === accepted.value.overrideId)?.inspectedFacts
        ).toEqual(inspected)
      })
    )
  }
})
