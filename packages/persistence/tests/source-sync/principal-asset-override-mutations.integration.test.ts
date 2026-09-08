import { beforeEach, describe, expect, it } from "@effect/vitest"
import { AuthUserId } from "@my/core/authentication"
import type { PrincipalAssetOverrideTarget } from "@my/core/assets"
import { PrincipalId } from "@my/core/ownership"
import { eq, sql } from "drizzle-orm"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import { PrincipalAssetOverrideRepositoryLive } from "../../src/layers/PrincipalAssetOverrideRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  PrincipalAssetOverrideConflictError,
  PrincipalAssetOverrideReplacementValidationError,
  PrincipalAssetOverrideRepository,
  type PrincipalAssetOverrideProjection,
} from "../../src/services/PrincipalAssetOverrideRepository.ts"
import {
  TEST_BTC_ASSET_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const USER_ID = "00000000-0000-4000-8000-000000000801"
const PRINCIPAL_ID = "00000000-0000-4000-8000-000000000802"
const SOURCE_ID = "00000000-0000-4000-8000-000000000803"
const CURRENT_ASSET_ID = "00000000-0000-4000-8000-000000000804"
const CURRENT_REPRESENTATION_ID = "00000000-0000-4000-8000-000000000805"
const TARGET_ID = "00000000-0000-4000-8000-000000000806"
const IDENTITY_OVERRIDE_ID = "00000000-0000-4000-8000-000000000807"
const INCLUSION_OVERRIDE_ID = "00000000-0000-4000-8000-000000000808"
const NFT_ASSET_ID = "00000000-0000-4000-8000-000000000809"
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000810"
const OTHER_PRINCIPAL_ID = "00000000-0000-4000-8000-000000000811"
const OTHER_SOURCE_ID = "00000000-0000-4000-8000-000000000812"
const SECOND_SOURCE_ID = "00000000-0000-4000-8000-000000000813"
const PROVIDER_ASSET_ID = "00000000-0000-4000-8000-000000000814"
const OTHER_PROVIDER_ASSET_ID = "00000000-0000-4000-8000-000000000823"
const SECOND_REPRESENTATION_ID = "00000000-0000-4000-8000-000000000824"
const PRE_OVERRIDE_RUN_ID = "00000000-0000-4000-8000-000000000825"
const PRE_COMPLETION_RUN_ID = "00000000-0000-4000-8000-000000000826"
const OTHER_PRINCIPAL_RUN_ID = "00000000-0000-4000-8000-000000000827"
const RUNNING_RUN_ID = "00000000-0000-4000-8000-000000000828"
const COMPLETE_RUN_ID = "00000000-0000-4000-8000-000000000829"
const PARTIAL_RUN_ID = "00000000-0000-4000-8000-000000000830"
const FAILED_RUN_ID = "00000000-0000-4000-8000-000000000831"
const PRE_FOLLOW_UP_COMPLETION_RUN_ID = "00000000-0000-4000-8000-000000000832"
const FOLLOW_UP_COVERING_RUN_ID = "00000000-0000-4000-8000-000000000833"
const CHAINLESS_TRANSACTION_ID = "00000000-0000-4000-8000-000000000815"
const EXACT_TRANSACTION_ID = "00000000-0000-4000-8000-000000000816"
const SECOND_CEX_ACCOUNT_ID = "00000000-0000-4000-8000-000000000817"
const CONTRACT_ADDRESS = "0xabcd000000000000000000000000000000000109"
const SECOND_CONTRACT_ADDRESS = "0xabcd000000000000000000000000000000000110"
const REVISION_HASH = "0".repeat(64)
const date = (value: string) => DateTime.toDateUtc(DateTime.makeUnsafe(value))

const target: PrincipalAssetOverrideTarget = {
  _tag: "representation",
  blockchain: "base",
  type: "token",
  contractAddress: CONTRACT_ADDRESS,
  mintAddress: null,
}

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_principal_asset_override_mutations",
})

const runPg = context.runPg

await Effect.runPromise(context.recreateTestDatabase())

beforeEach(() => Effect.runPromise(context.recreateTestDatabase()))

const runRepository = <A, E>(effect: Effect.Effect<A, E, PrincipalAssetOverrideRepository>) =>
  context.runWithLayer({ effect, layer: PrincipalAssetOverrideRepositoryLive })

const expectProjection = (
  projection: Option.Option<PrincipalAssetOverrideProjection>
): PrincipalAssetOverrideProjection => {
  expect(Option.isSome(projection)).toBe(true)
  return Option.getOrThrow(projection)
}

const create = (params: {
  readonly expectedSystemRevision: string
  readonly principalId?: string
  readonly replacement:
    | { readonly _tag: "identity"; readonly assetId: string }
    | { readonly _tag: "inclusion"; readonly inclusion: "included" | "excluded" }
  readonly target?: PrincipalAssetOverrideTarget
}) =>
  runRepository(
    Effect.flatMap(PrincipalAssetOverrideRepository, (repository) =>
      repository.create({
        actorUserId: AuthUserId.make(USER_ID),
        expectedSystemRevision: params.expectedSystemRevision,
        principalId: PrincipalId.make(params.principalId ?? PRINCIPAL_ID),
        reason: "Create my override.",
        replacement: params.replacement,
        target: params.target ?? target,
      })
    )
  )

const findProjection = (
  params: {
    readonly principalId?: string
    readonly target?: PrincipalAssetOverrideTarget
  } = {}
) =>
  runRepository(
    Effect.flatMap(PrincipalAssetOverrideRepository, (repository) =>
      repository.findProjection({
        principalId: PrincipalId.make(params.principalId ?? PRINCIPAL_ID),
        target: params.target ?? target,
      })
    )
  )

const captureV2Revision = (principalId: string = PRINCIPAL_ID) =>
  Effect.promise(() =>
    runPg(
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
            if (snapshot === undefined) return yield* Effect.die("Missing principal snapshot")
            return `v2:${snapshot.transactionId}:${snapshot.visibility}:${REVISION_HASH}`
          })
        )
      })
    )
  )

const insertCalculationRun = ({
  id,
  inputLedgerRevision,
  principalId = PRINCIPAL_ID,
  status,
}: {
  readonly id: string
  readonly inputLedgerRevision: string
  readonly principalId?: string
  readonly status: "running" | "complete" | "partial" | "failed"
}) =>
  Effect.promise(() =>
    runPg(
      Effect.gen(function* () {
        const db = yield* drizzle
        const isResult = status === "complete" || status === "partial"
        const isTerminal = status !== "running"
        yield* db.insert(schema.calculationRuns).values({
          id,
          principalId,
          jurisdiction: "de",
          taxYear: 2026,
          reportingCurrency: "eur",
          engineVersion: "t13-test-engine",
          ruleSetVersion: "t13-test-rules",
          inputLedgerRevision,
          valuationRevision: `sha256:${REVISION_HASH}`,
          status,
          accountingMethod: isResult ? "fifo" : null,
          inventoryScope: isResult ? "per_custody_unit" : null,
          appliedChoiceIds: [],
          appliedRules: [],
          processedEventIds: [],
          failureCode: status === "failed" ? "calculation_stale_recomputed" : null,
          failureMessage: status === "failed" ? "A newer fact revision replaced this run." : null,
          startedAt: date("2026-09-05T08:00:00.000Z"),
          completedAt: isTerminal ? date("2026-09-05T08:01:00.000Z") : null,
        })
      })
    )
  )

const seedActiveOverrides = ({
  withActiveOverrides = true,
}: { withActiveOverrides?: boolean } = {}) =>
  Effect.promise(() =>
    runPg(
      Effect.gen(function* () {
        const fixture = yield* seedSyncEngineRepositoryFixture({
          userId: USER_ID,
          principalId: PRINCIPAL_ID,
          sourceId: SOURCE_ID,
        })
        yield* seedSyncEngineAssets(fixture)
        const db = yield* drizzle
        yield* db.insert(schema.assets).values([
          {
            id: CURRENT_ASSET_ID,
            name: "USD Coin",
            symbol: "USDC",
            type: "fungible",
          },
          {
            id: NFT_ASSET_ID,
            name: "Test NFT",
            symbol: "NFT",
            type: "nft",
          },
        ])
        yield* db.insert(schema.assetRepresentations).values({
          id: CURRENT_REPRESENTATION_ID,
          assetId: CURRENT_ASSET_ID,
          blockchainId: fixture.baseBlockchainId,
          type: "token",
          contractAddress: CONTRACT_ADDRESS,
          mintAddress: null,
          decimals: 6,
          isSpam: false,
        })
        yield* db.insert(schema.sourceRepresentationUses).values({
          sourceId: SOURCE_ID,
          blockchainId: fixture.baseBlockchainId,
          representationType: "token",
          contractAddress: CONTRACT_ADDRESS,
          mintAddress: null,
        })

        const initial = yield* Effect.provide(
          Effect.flatMap(PrincipalAssetOverrideRepository, (repository) =>
            repository.findProjection({
              principalId: PrincipalId.make(PRINCIPAL_ID),
              target,
            })
          ),
          PrincipalAssetOverrideRepositoryLive
        )
        const projection = expectProjection(initial)

        if (withActiveOverrides) {
          yield* db.insert(schema.principalAssetOverrideTargets).values({
            id: TARGET_ID,
            principalId: PRINCIPAL_ID,
            targetKind: "representation",
            blockchainId: fixture.baseBlockchainId,
            representationType: "token",
            contractAddress: CONTRACT_ADDRESS,
            mintAddress: null,
            providerAssetRowId: null,
          })
          yield* db.insert(schema.principalAssetOverrides).values([
            {
              id: IDENTITY_OVERRIDE_ID,
              principalId: PRINCIPAL_ID,
              targetId: TARGET_ID,
              kind: "identity",
              operation: "create",
              inspectedSystemRevision: projection.system.identityRevision,
              inspectedSystemIdentity: "resolved",
              inspectedSystemAssetId: CURRENT_ASSET_ID,
              inspectedSystemInclusion: null,
              replacementAssetId: TEST_BTC_ASSET_ID,
              replacementInclusion: null,
              actorUserId: USER_ID,
              reason: "Use the existing BTC asset.",
              supersedesOverrideId: null,
            },
            {
              id: INCLUSION_OVERRIDE_ID,
              principalId: PRINCIPAL_ID,
              targetId: TARGET_ID,
              kind: "inclusion",
              operation: "create",
              inspectedSystemRevision: projection.system.inclusionRevision,
              inspectedSystemIdentity: null,
              inspectedSystemAssetId: null,
              inspectedSystemInclusion: "included",
              replacementAssetId: null,
              replacementInclusion: "excluded",
              actorUserId: USER_ID,
              reason: "Exclude this asset from my calculation.",
              supersedesOverrideId: null,
            },
          ])
        }

        return projection
      })
    )
  )

const replace = (params: {
  readonly expectedActiveOverrideId: string
  readonly expectedSystemRevision: string
  readonly replacement:
    | { readonly _tag: "identity"; readonly assetId: string }
    | { readonly _tag: "inclusion"; readonly inclusion: "included" | "excluded" }
  readonly principalId?: string
}) =>
  runRepository(
    Effect.flatMap(PrincipalAssetOverrideRepository, (repository) =>
      repository.replace({
        actorUserId: AuthUserId.make(USER_ID),
        expectedActiveOverrideId: params.expectedActiveOverrideId,
        expectedSystemRevision: params.expectedSystemRevision,
        principalId: PrincipalId.make(params.principalId ?? PRINCIPAL_ID),
        reason: "Update my active override.",
        replacement: params.replacement,
        target,
      })
    )
  )

const withdraw = (params: {
  readonly expectedActiveOverrideId: string
  readonly expectedSystemRevision: string
  readonly kind: "identity" | "inclusion"
}) =>
  runRepository(
    Effect.flatMap(PrincipalAssetOverrideRepository, (repository) =>
      repository.withdraw({
        actorUserId: AuthUserId.make(USER_ID),
        expectedActiveOverrideId: params.expectedActiveOverrideId,
        expectedSystemRevision: params.expectedSystemRevision,
        kind: params.kind,
        principalId: PrincipalId.make(PRINCIPAL_ID),
        reason: "Return to TaxMaxi's current conclusion.",
        target,
      })
    )
  )

describe("PrincipalAssetOverrideRepository mutations", () => {
  it.effect("atomically creates an override and durable replay work", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveOverrides({ withActiveOverrides: false })
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const other = yield* seedSyncEngineRepositoryFixture({
              userId: OTHER_USER_ID,
              principalId: OTHER_PRINCIPAL_ID,
              sourceId: OTHER_SOURCE_ID,
            })
            const db = yield* drizzle
            const [coinbase] = yield* db
              .select({ id: schema.cex.id })
              .from(schema.cex)
              .where(eq(schema.cex.name, "coinbase"))
            if (coinbase === undefined) return yield* Effect.die("Missing Coinbase fixture")
            yield* db.insert(schema.cexAccount).values({
              id: SECOND_CEX_ACCOUNT_ID,
              cexId: coinbase.id,
              principalId: PRINCIPAL_ID,
              providerUserId: "second-exact-source-user",
              providerAccountId: "second-exact-source-account",
            })
            yield* db.insert(schema.sources).values({
              id: SECOND_SOURCE_ID,
              principalId: PRINCIPAL_ID,
              name: "Second exact observation source",
              providerKey: "coinbase",
              sourceableType: "cex",
              cexAccountId: SECOND_CEX_ACCOUNT_ID,
              addressId: null,
            })
            yield* db.insert(schema.sourceRepresentationUses).values([
              {
                sourceId: SECOND_SOURCE_ID,
                blockchainId: other.baseBlockchainId,
                representationType: "token",
                contractAddress: CONTRACT_ADDRESS,
                mintAddress: null,
              },
              {
                sourceId: OTHER_SOURCE_ID,
                blockchainId: other.baseBlockchainId,
                representationType: "token",
                contractAddress: CONTRACT_ADDRESS,
                mintAddress: null,
              },
            ])
          })
        )
      )

      const created = expectProjection(
        yield* create({
          expectedSystemRevision: initial.system.identityRevision,
          replacement: { _tag: "identity", assetId: CURRENT_ASSET_ID },
        })
      )

      expect(created.activeIdentityOverride).toMatchObject({
        kind: "identity",
        operation: "create",
        replacementIdentity: { _tag: "resolved", assetId: CURRENT_ASSET_ID },
        supersedesOverrideId: null,
      })
      expect(created.recomputation).toMatchObject({
        status: "updating",
        overrideIds: [created.activeIdentityOverride?.id],
        sourceJobs: [
          { sourceId: SOURCE_ID, status: "pending", failureCode: null },
          { sourceId: SECOND_SOURCE_ID, status: "pending", failureCode: null },
        ],
      })

      const stored = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* Effect.all({
              applications: db
                .select({
                  overrideId: schema.principalAssetOverrideApplications.overrideId,
                  sourceId: schema.principalAssetOverrideApplications.sourceId,
                })
                .from(schema.principalAssetOverrideApplications),
              jobs: db
                .select({
                  sourceId: schema.processingJobs.sourceId,
                  principalId: schema.processingJobs.principalId,
                  mode: schema.processingJobs.mode,
                  status: schema.processingJobs.status,
                  progressDetails: schema.processingJobs.progressDetails,
                })
                .from(schema.processingJobs),
              targets: db
                .select({ id: schema.principalAssetOverrideTargets.id })
                .from(schema.principalAssetOverrideTargets),
            })
          })
        )
      )
      expect(stored.targets).toHaveLength(1)
      expect(stored.applications).toHaveLength(2)
      expect(stored.applications).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            overrideId: created.activeIdentityOverride?.id,
            sourceId: SOURCE_ID,
          }),
          expect.objectContaining({
            overrideId: created.activeIdentityOverride?.id,
            sourceId: SECOND_SOURCE_ID,
          }),
        ])
      )
      expect(stored.jobs).toHaveLength(2)
      expect(stored.jobs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceId: SOURCE_ID,
            principalId: PRINCIPAL_ID,
            mode: "replay",
            status: "pending",
            progressDetails: expect.objectContaining({
              mode: "replay",
              reason: "principal_asset_override",
              overrideId: created.activeIdentityOverride?.id,
            }),
          }),
          expect.objectContaining({ sourceId: SECOND_SOURCE_ID }),
        ])
      )
    })
  )

  it.effect("appends identity replacements and withdrawals without editing history", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveOverrides()

      const replaced = expectProjection(
        yield* replace({
          expectedActiveOverrideId: IDENTITY_OVERRIDE_ID,
          expectedSystemRevision: initial.system.identityRevision,
          replacement: { _tag: "identity", assetId: CURRENT_ASSET_ID },
        })
      )
      const replacement = replaced.activeIdentityOverride
      expect(replacement).toMatchObject({
        kind: "identity",
        operation: "replace",
        inspectedSystemRevision: initial.system.identityRevision,
        inspectedSystemIdentity: { _tag: "resolved", assetId: CURRENT_ASSET_ID },
        replacementIdentity: { _tag: "resolved", assetId: CURRENT_ASSET_ID },
        supersedesOverrideId: IDENTITY_OVERRIDE_ID,
      })
      expect(replaced.effectiveDecision).toEqual({
        _tag: "excluded",
        identity: replacement?.replacementIdentity,
      })
      expect(replaced.recomputation).toMatchObject({
        status: "updating",
        sourceJobs: [{ sourceId: SOURCE_ID, status: "pending" }],
      })

      const withdrawn = expectProjection(
        yield* withdraw({
          expectedActiveOverrideId: replacement?.id ?? "missing",
          expectedSystemRevision: initial.system.identityRevision,
          kind: "identity",
        })
      )
      expect(withdrawn.activeIdentityOverride).toBeNull()
      expect(withdrawn.history.filter(({ kind }) => kind === "identity")).toHaveLength(3)
      expect(withdrawn.history.find(({ operation }) => operation === "withdraw")).toMatchObject({
        kind: "identity",
        operation: "withdraw",
        replacementIdentity: null,
        supersedesOverrideId: replacement?.id,
      })
      expect(withdrawn.recomputation).toMatchObject({
        status: "updating",
        sourceJobs: [{ sourceId: SOURCE_ID, status: "pending" }],
      })

      const storedRoot = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [row] = yield* db
              .select({
                operation: schema.principalAssetOverrides.operation,
                replacementAssetId: schema.principalAssetOverrides.replacementAssetId,
                supersedesOverrideId: schema.principalAssetOverrides.supersedesOverrideId,
              })
              .from(schema.principalAssetOverrides)
              .where(eq(schema.principalAssetOverrides.id, IDENTITY_OVERRIDE_ID))
            const applications = yield* db
              .select({
                overrideId: schema.principalAssetOverrideApplications.overrideId,
                processingJobId: schema.principalAssetOverrideApplications.processingJobId,
              })
              .from(schema.principalAssetOverrideApplications)
            const jobs = yield* db
              .select({ id: schema.processingJobs.id })
              .from(schema.processingJobs)
            return { applications, jobs, row }
          })
        )
      )
      expect(storedRoot.row).toMatchObject({
        operation: "create",
        replacementAssetId: TEST_BTC_ASSET_ID,
        supersedesOverrideId: null,
      })
      expect(storedRoot.applications).toHaveLength(2)
      expect(
        new Set(storedRoot.applications.map(({ processingJobId }) => processingJobId)).size
      ).toBe(1)
      expect(storedRoot.jobs).toHaveLength(1)

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.update(schema.processingJobs).set({ status: "completed" })
          })
        )
      )
      expect(expectProjection(yield* findProjection()).recomputation).toMatchObject({
        status: "updating",
        sourceJobs: [{ status: "complete" }],
      })
    })
  )

  it.effect("replaces and withdraws inclusion independently from identity", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveOverrides()
      const replaced = expectProjection(
        yield* replace({
          expectedActiveOverrideId: INCLUSION_OVERRIDE_ID,
          expectedSystemRevision: initial.system.inclusionRevision,
          replacement: { _tag: "inclusion", inclusion: "included" },
        })
      )
      const replacement = replaced.activeInclusionOverride
      expect(replacement).toMatchObject({
        kind: "inclusion",
        operation: "replace",
        inspectedSystemInclusion: "included",
        replacementInclusion: "included",
        supersedesOverrideId: INCLUSION_OVERRIDE_ID,
      })
      expect(replaced.activeIdentityOverride?.id).toBe(IDENTITY_OVERRIDE_ID)
      expect(replaced.effectiveDecision).toEqual({ _tag: "included", assetId: TEST_BTC_ASSET_ID })

      const withdrawn = expectProjection(
        yield* withdraw({
          expectedActiveOverrideId: replacement?.id ?? "missing",
          expectedSystemRevision: initial.system.inclusionRevision,
          kind: "inclusion",
        })
      )
      expect(withdrawn.activeInclusionOverride).toBeNull()
      expect(withdrawn.activeIdentityOverride?.id).toBe(IDENTITY_OVERRIDE_ID)
    })
  )

  it.effect("replaces and withdraws a visible override when no source currently matches", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveOverrides()
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .delete(schema.sourceRepresentationUses)
              .where(eq(schema.sourceRepresentationUses.sourceId, SOURCE_ID))
          })
        )
      )

      const replaced = expectProjection(
        yield* replace({
          expectedActiveOverrideId: IDENTITY_OVERRIDE_ID,
          expectedSystemRevision: initial.system.identityRevision,
          replacement: { _tag: "identity", assetId: CURRENT_ASSET_ID },
        })
      )
      const replacement = replaced.activeIdentityOverride
      if (replacement === null) return yield* Effect.die("Missing zero-source replacement")
      expect(replacement).toMatchObject({
        operation: "replace",
        supersedesOverrideId: IDENTITY_OVERRIDE_ID,
      })
      expect(replaced.recomputation).toEqual({ status: "not_scheduled" })

      const withdrawn = expectProjection(
        yield* withdraw({
          expectedActiveOverrideId: replacement.id,
          expectedSystemRevision: initial.system.identityRevision,
          kind: "identity",
        })
      )
      expect(withdrawn.activeIdentityOverride).toBeNull()
      expect(withdrawn.history.find(({ operation }) => operation === "withdraw")).toMatchObject({
        operation: "withdraw",
        supersedesOverrideId: replacement.id,
      })
      expect(withdrawn.recomputation).toEqual({ status: "not_scheduled" })

      const stored = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* Effect.all({
              applications: db
                .select({ overrideId: schema.principalAssetOverrideApplications.overrideId })
                .from(schema.principalAssetOverrideApplications),
              jobs: db.select({ id: schema.processingJobs.id }).from(schema.processingJobs),
              overrides: db
                .select({ id: schema.principalAssetOverrides.id })
                .from(schema.principalAssetOverrides),
            })
          })
        )
      )
      expect(stored.overrides).toHaveLength(4)
      expect(stored.applications).toEqual([])
      expect(stored.jobs).toEqual([])
    })
  )

  it.effect("creates again after withdrawal and supersedes the withdrawal", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveOverrides({ withActiveOverrides: false })
      const first = expectProjection(
        yield* create({
          expectedSystemRevision: initial.system.identityRevision,
          replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
        })
      )
      const firstId = first.activeIdentityOverride?.id ?? "missing"
      const withdrawn = expectProjection(
        yield* withdraw({
          expectedActiveOverrideId: firstId,
          expectedSystemRevision: initial.system.identityRevision,
          kind: "identity",
        })
      )
      const withdrawal = withdrawn.history.at(-1)

      const recreated = expectProjection(
        yield* create({
          expectedSystemRevision: initial.system.identityRevision,
          replacement: { _tag: "identity", assetId: CURRENT_ASSET_ID },
        })
      )
      expect(recreated.activeIdentityOverride).toMatchObject({
        operation: "create",
        supersedesOverrideId: withdrawal?.id,
      })
      expect(recreated.history.filter(({ kind }) => kind === "identity")).toHaveLength(3)

      const stored = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* Effect.all({
              applications: db
                .select({ overrideId: schema.principalAssetOverrideApplications.overrideId })
                .from(schema.principalAssetOverrideApplications),
              jobs: db.select({ id: schema.processingJobs.id }).from(schema.processingJobs),
            })
          })
        )
      )
      expect(stored.applications).toHaveLength(3)
      expect(stored.jobs).toHaveLength(1)
    })
  )

  it.effect("recovers a target-creation race as a typed create conflict", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveOverrides({ withActiveOverrides: false })
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.execute(sql`create sequence delay_first_override_target_insert`)
            yield* db.execute(sql`
              create function delay_first_override_target_insert() returns trigger
              language plpgsql as $trigger$
              begin
                if nextval('delay_first_override_target_insert') = 1 then
                  perform pg_advisory_xact_lock(hashtextextended('test:override-repository-create', 0));
                end if;
                return new;
              end
              $trigger$
            `)
            yield* db.execute(sql`
              create trigger delay_first_override_target_insert
              before insert on principal_asset_override_targets
              for each row execute function delay_first_override_target_insert()
            `)
          })
        )
      )

      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db.execute(
                sql`drop trigger delay_first_override_target_insert on principal_asset_override_targets`
              )
              yield* db.execute(sql`drop function delay_first_override_target_insert()`)
              yield* db.execute(sql`drop sequence delay_first_override_target_insert`)
            })
          )
        ).pipe(Effect.orDie)
      )

      const { release } = yield* context.holdAdvisoryLock({
        key: "test:override-repository-create",
      })
      const attempt = () =>
        create({
          expectedSystemRevision: initial.system.identityRevision,
          replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
        }).pipe(Effect.result)
      const attempts = yield* Effect.gen(function* () {
        const first = yield* Effect.forkScoped(attempt())
        yield* Effect.promise(() =>
          context.waitForQueryBlockedOnLock({
            queryIncludes: 'insert into "principal_asset_override_targets"',
          })
        )
        const second = yield* Effect.forkScoped(attempt())
        yield* Effect.promise(() =>
          context.waitForQueryBlockedOnLock({
            queryIncludes: 'from "principals"',
          })
        )
        yield* release
        return yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      }).pipe(Effect.ensuring(release))

      expect(attempts.filter(Result.isSuccess)).toHaveLength(1)
      const [failed] = attempts.filter(Result.isFailure)
      expect(failed?.failure).toBeInstanceOf(PrincipalAssetOverrideConflictError)
      if (failed?.failure instanceof PrincipalAssetOverrideConflictError) {
        expect(failed.failure.conflictKinds).toEqual(["active_override"])
        expect(failed.failure.expectedActiveOverrideId).toBe("")
      }

      const counts = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [overrides, applications, jobs] = yield* Effect.all([
              db
                .select({ id: schema.principalAssetOverrides.id })
                .from(schema.principalAssetOverrides),
              db
                .select({ overrideId: schema.principalAssetOverrideApplications.overrideId })
                .from(schema.principalAssetOverrideApplications),
              db.select({ id: schema.processingJobs.id }).from(schema.processingJobs),
            ])
            return [overrides.length, applications.length, jobs.length]
          })
        )
      )
      expect(counts).toEqual([1, 1, 1])
    })
  )

  it.effect("binds concurrent cross-kind responses to the override each mutation appended", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveOverrides({ withActiveOverrides: false })
      const [identity, inclusion] = yield* Effect.all(
        [
          create({
            expectedSystemRevision: initial.system.identityRevision,
            replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
          }),
          create({
            expectedSystemRevision: initial.system.inclusionRevision,
            replacement: { _tag: "inclusion", inclusion: "excluded" },
          }),
        ],
        { concurrency: "unbounded" }
      )

      const identityProjection = expectProjection(identity)
      const inclusionProjection = expectProjection(inclusion)
      expect(identityProjection.recomputation).toMatchObject({
        status: "updating",
        overrideIds: [identityProjection.activeIdentityOverride?.id],
      })
      expect(inclusionProjection.recomputation).toMatchObject({
        status: "updating",
        overrideIds: [inclusionProjection.activeInclusionOverride?.id],
      })

      const current = expectProjection(yield* findProjection())
      expect(current.recomputation).toMatchObject({
        status: "updating",
        overrideIds: expect.arrayContaining([
          identityProjection.activeIdentityOverride?.id,
          inclusionProjection.activeInclusionOverride?.id,
        ]),
      })
      if (current.recomputation.status !== "not_scheduled") {
        expect(current.recomputation.overrideIds).toHaveLength(2)
        expect(current.recomputation.sourceJobs.map(({ overrideId }) => overrideId)).toEqual(
          expect.arrayContaining([...current.recomputation.overrideIds])
        )
      }
    })
  )

  it.effect("uses one lock order for create and replace on the same target", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveOverrides()
      const withdrawn = expectProjection(
        yield* withdraw({
          expectedActiveOverrideId: INCLUSION_OVERRIDE_ID,
          expectedSystemRevision: initial.system.inclusionRevision,
          kind: "inclusion",
        })
      )

      const [identity, inclusion] = yield* Effect.all(
        [
          replace({
            expectedActiveOverrideId: IDENTITY_OVERRIDE_ID,
            expectedSystemRevision: withdrawn.system.identityRevision,
            replacement: { _tag: "identity", assetId: CURRENT_ASSET_ID },
          }),
          create({
            expectedSystemRevision: withdrawn.system.inclusionRevision,
            replacement: { _tag: "inclusion", inclusion: "included" },
          }),
        ],
        { concurrency: "unbounded" }
      )

      const identityProjection = expectProjection(identity)
      const inclusionProjection = expectProjection(inclusion)
      expect(identityProjection.recomputation).toMatchObject({
        status: "updating",
        overrideIds: [identityProjection.activeIdentityOverride?.id],
      })
      expect(inclusionProjection.recomputation).toMatchObject({
        status: "updating",
        overrideIds: [inclusionProjection.activeInclusionOverride?.id],
      })
    })
  )

  it.effect("retries a serialization failure without duplicating history or work", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveOverrides({ withActiveOverrides: false })
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.execute(sql`create sequence fail_first_override_insert`)
            yield* db.execute(sql`
              create function fail_first_override_insert() returns trigger
              language plpgsql as $trigger$
              begin
                if nextval('fail_first_override_insert') = 1 then
                  raise exception 'forced serialization retry' using errcode = '40001';
                end if;
                return new;
              end
              $trigger$
            `)
            yield* db.execute(sql`
              create trigger fail_first_override_insert
              before insert on principal_asset_overrides
              for each row execute function fail_first_override_insert()
            `)
          })
        )
      )

      const created = expectProjection(
        yield* create({
          expectedSystemRevision: initial.system.identityRevision,
          replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
        })
      )
      expect(created.recomputation).toMatchObject({ status: "updating" })

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.execute(
              sql`drop trigger fail_first_override_insert on principal_asset_overrides`
            )
            yield* db.execute(sql`drop function fail_first_override_insert()`)
            yield* db.execute(sql`drop sequence fail_first_override_insert`)
          })
        )
      )

      const counts = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [targets, overrides, applications, jobs] = yield* Effect.all([
              db
                .select({ id: schema.principalAssetOverrideTargets.id })
                .from(schema.principalAssetOverrideTargets),
              db
                .select({ id: schema.principalAssetOverrides.id })
                .from(schema.principalAssetOverrides),
              db
                .select({ overrideId: schema.principalAssetOverrideApplications.overrideId })
                .from(schema.principalAssetOverrideApplications),
              db.select({ id: schema.processingJobs.id }).from(schema.processingJobs),
            ])
            return [targets.length, overrides.length, applications.length, jobs.length]
          })
        )
      )
      expect(counts).toEqual([1, 1, 1, 1])
    })
  )

  it.effect("retries a deadlock without duplicating history or work", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveOverrides({ withActiveOverrides: false })
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.execute(sql`create sequence fail_first_override_deadlock`)
            yield* db.execute(sql`
              create function fail_first_override_deadlock() returns trigger
              language plpgsql as $trigger$
              begin
                if nextval('fail_first_override_deadlock') = 1 then
                  raise exception 'forced deadlock retry' using errcode = '40P01';
                end if;
                return new;
              end
              $trigger$
            `)
            yield* db.execute(sql`
              create trigger fail_first_override_deadlock
              before insert on principal_asset_overrides
              for each row execute function fail_first_override_deadlock()
            `)
          })
        )
      )

      const created = expectProjection(
        yield* create({
          expectedSystemRevision: initial.system.identityRevision,
          replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
        })
      )
      expect(created.recomputation).toMatchObject({ status: "updating" })

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.execute(
              sql`drop trigger fail_first_override_deadlock on principal_asset_overrides`
            )
            yield* db.execute(sql`drop function fail_first_override_deadlock()`)
            yield* db.execute(sql`drop sequence fail_first_override_deadlock`)
          })
        )
      )

      const counts = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [overrides, applications, jobs] = yield* Effect.all([
              db
                .select({ id: schema.principalAssetOverrides.id })
                .from(schema.principalAssetOverrides),
              db
                .select({ overrideId: schema.principalAssetOverrideApplications.overrideId })
                .from(schema.principalAssetOverrideApplications),
              db.select({ id: schema.processingJobs.id }).from(schema.processingJobs),
            ])
            return [overrides.length, applications.length, jobs.length]
          })
        )
      )
      expect(counts).toEqual([1, 1, 1])
    })
  )

  it.effect("writes nothing when create sees a stale system revision", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveOverrides({ withActiveOverrides: false })
      const result = yield* Effect.result(
        create({
          expectedSystemRevision: `${initial.system.identityRevision}:stale`,
          replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
        })
      )
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(PrincipalAssetOverrideConflictError)
        if (result.failure instanceof PrincipalAssetOverrideConflictError) {
          expect(result.failure.conflictKinds).toEqual(["system_revision"])
          expect(result.failure.currentActiveOverrideId).toBeNull()
        }
      }

      const counts = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [targets, overrides, applications, jobs] = yield* Effect.all([
              db
                .select({ id: schema.principalAssetOverrideTargets.id })
                .from(schema.principalAssetOverrideTargets),
              db
                .select({ id: schema.principalAssetOverrides.id })
                .from(schema.principalAssetOverrides),
              db
                .select({ overrideId: schema.principalAssetOverrideApplications.overrideId })
                .from(schema.principalAssetOverrideApplications),
              db.select({ id: schema.processingJobs.id }).from(schema.processingJobs),
            ])
            return [targets.length, overrides.length, applications.length, jobs.length]
          })
        )
      )
      expect(counts).toEqual([0, 0, 0, 0])
    })
  )

  it.effect("requests one replay follow-up behind an active sync", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveOverrides()
      const activeJobId = "00000000-0000-4000-8000-000000000820"
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.processingJobs).values({
              id: activeJobId,
              sourceId: SOURCE_ID,
              principalId: PRINCIPAL_ID,
              mode: "sync",
              status: "processing",
            })
          })
        )
      )

      const replaced = expectProjection(
        yield* replace({
          expectedActiveOverrideId: IDENTITY_OVERRIDE_ID,
          expectedSystemRevision: initial.system.identityRevision,
          replacement: { _tag: "identity", assetId: CURRENT_ASSET_ID },
        })
      )
      expect(replaced.recomputation).toMatchObject({
        status: "updating",
        sourceJobs: [
          {
            sourceId: SOURCE_ID,
            requestedJobId: activeJobId,
            jobId: activeJobId,
            status: "running",
          },
        ],
      })

      const [job] = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ followUpMode: schema.processingJobs.followUpMode })
              .from(schema.processingJobs)
              .where(eq(schema.processingJobs.id, activeJobId))
          })
        )
      )
      expect(job?.followUpMode).toBe("replay")
    })
  )

  it.effect("follows an active replay's durable follow-up and exposes failures", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveOverrides()
      const activeJobId = "00000000-0000-4000-8000-000000000821"
      const followUpJobId = "00000000-0000-4000-8000-000000000822"
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.processingJobs).values({
              id: activeJobId,
              sourceId: SOURCE_ID,
              principalId: PRINCIPAL_ID,
              mode: "replay",
              status: "processing",
            })
          })
        )
      )
      yield* replace({
        expectedActiveOverrideId: IDENTITY_OVERRIDE_ID,
        expectedSystemRevision: initial.system.identityRevision,
        replacement: { _tag: "identity", assetId: CURRENT_ASSET_ID },
      })

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.processingJobs).values({
              id: followUpJobId,
              sourceId: SOURCE_ID,
              principalId: PRINCIPAL_ID,
              mode: "replay",
              status: "failed",
              errorMessage: "provider unavailable",
            })
            yield* db
              .update(schema.processingJobs)
              .set({ status: "completed", followUpJobId })
              .where(eq(schema.processingJobs.id, activeJobId))
          })
        )
      )

      expect(expectProjection(yield* findProjection()).recomputation).toMatchObject({
        status: "failed",
        sourceJobs: [
          {
            requestedJobId: activeJobId,
            jobId: followUpJobId,
            status: "failed",
            failureCode: "source_replay_failed",
          },
        ],
      })

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.processingJobs)
              .set({ status: "credit_required", creditReasonCode: "credits_exhausted" })
              .where(eq(schema.processingJobs.id, followUpJobId))
          })
        )
      )
      expect(expectProjection(yield* findProjection()).recomputation).toMatchObject({
        status: "failed",
        sourceJobs: [
          {
            status: "credit_required",
            failureCode: "credits_exhausted",
          },
        ],
      })
    })
  )

  it.effect("requires the covering run snapshot to see a completed replay follow-up", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveOverrides()
      const activeJobId = "00000000-0000-4000-8000-000000000834"
      const followUpJobId = "00000000-0000-4000-8000-000000000835"
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.processingJobs).values({
              id: activeJobId,
              sourceId: SOURCE_ID,
              principalId: PRINCIPAL_ID,
              mode: "sync",
              status: "processing",
            })
          })
        )
      )
      yield* replace({
        expectedActiveOverrideId: IDENTITY_OVERRIDE_ID,
        expectedSystemRevision: initial.system.identityRevision,
        replacement: { _tag: "identity", assetId: CURRENT_ASSET_ID },
      })

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.processingJobs)
              .set({
                status: "failed",
                errorMessage: "superseded by durable replay follow-up",
                updatedAt: date("2026-09-05T07:55:00.000Z"),
              })
              .where(eq(schema.processingJobs.id, activeJobId))
            yield* db.insert(schema.processingJobs).values({
              id: followUpJobId,
              sourceId: SOURCE_ID,
              principalId: PRINCIPAL_ID,
              mode: "replay",
              status: "pending",
            })
            yield* db
              .update(schema.processingJobs)
              .set({ followUpJobId })
              .where(eq(schema.processingJobs.id, activeJobId))
          })
        )
      )
      const preFollowUpCompletionRevision = yield* captureV2Revision()
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.processingJobs)
              .set({
                status: "completed",
                completedAt: date("2026-09-05T07:56:00.000Z"),
                updatedAt: date("2026-09-05T07:56:00.000Z"),
              })
              .where(eq(schema.processingJobs.id, followUpJobId))
          })
        )
      )
      yield* insertCalculationRun({
        id: PRE_FOLLOW_UP_COMPLETION_RUN_ID,
        inputLedgerRevision: preFollowUpCompletionRevision,
        status: "complete",
      })

      expect(expectProjection(yield* findProjection()).recomputation).toMatchObject({
        status: "updating",
        sourceJobs: [{ jobId: followUpJobId, status: "complete" }],
        calculationRun: null,
      })

      const coveringRevision = yield* captureV2Revision()
      yield* insertCalculationRun({
        id: FOLLOW_UP_COVERING_RUN_ID,
        inputLedgerRevision: coveringRevision,
        status: "complete",
      })
      expect(expectProjection(yield* findProjection()).recomputation).toMatchObject({
        status: "complete",
        sourceJobs: [{ jobId: followUpJobId, status: "complete" }],
        calculationRun: { runId: FOLLOW_UP_COVERING_RUN_ID, status: "complete" },
      })
    })
  )

  it.effect("attributes only calculation runs whose snapshots cover this target's replay", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveOverrides({ withActiveOverrides: false })
      const preOverrideRevision = yield* captureV2Revision()
      const created = expectProjection(
        yield* create({
          expectedSystemRevision: initial.system.identityRevision,
          replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
        })
      )
      if (created.recomputation.status === "not_scheduled") {
        return yield* Effect.die("Create did not schedule replay work")
      }
      const jobId = created.recomputation.sourceJobs[0]?.jobId
      if (jobId === null || jobId === undefined) {
        return yield* Effect.die("Create did not expose its replay job")
      }

      const preCompletionRevision = yield* captureV2Revision()
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.processingJobs)
              .set({
                status: "completed",
                completedAt: date("2026-09-05T07:59:00.000Z"),
                updatedAt: date("2026-09-05T07:59:00.000Z"),
              })
              .where(eq(schema.processingJobs.id, jobId))
          })
        )
      )

      yield* insertCalculationRun({
        id: PRE_OVERRIDE_RUN_ID,
        inputLedgerRevision: preOverrideRevision,
        status: "complete",
      })
      yield* insertCalculationRun({
        id: PRE_COMPLETION_RUN_ID,
        inputLedgerRevision: preCompletionRevision,
        status: "complete",
      })

      yield* Effect.promise(() =>
        runPg(
          seedSyncEngineRepositoryFixture({
            userId: OTHER_USER_ID,
            principalId: OTHER_PRINCIPAL_ID,
            sourceId: OTHER_SOURCE_ID,
          })
        )
      )
      const coveringRevision = yield* captureV2Revision()
      yield* insertCalculationRun({
        id: OTHER_PRINCIPAL_RUN_ID,
        inputLedgerRevision: coveringRevision,
        principalId: OTHER_PRINCIPAL_ID,
        status: "complete",
      })

      expect(expectProjection(yield* findProjection()).recomputation).toMatchObject({
        status: "updating",
        sourceJobs: [{ status: "complete" }],
        calculationRun: null,
      })

      yield* insertCalculationRun({
        id: RUNNING_RUN_ID,
        inputLedgerRevision: coveringRevision,
        status: "running",
      })
      expect(expectProjection(yield* findProjection()).recomputation).toMatchObject({
        status: "updating",
        calculationRun: {
          runId: RUNNING_RUN_ID,
          status: "running",
          failureCode: null,
        },
      })

      const completeRevision = yield* captureV2Revision()
      yield* insertCalculationRun({
        id: COMPLETE_RUN_ID,
        inputLedgerRevision: completeRevision,
        status: "complete",
      })
      expect(expectProjection(yield* findProjection()).recomputation).toMatchObject({
        status: "complete",
        calculationRun: {
          runId: COMPLETE_RUN_ID,
          status: "complete",
          failureCode: null,
        },
      })

      const partialRevision = yield* captureV2Revision()
      yield* insertCalculationRun({
        id: PARTIAL_RUN_ID,
        inputLedgerRevision: partialRevision,
        status: "partial",
      })
      expect(expectProjection(yield* findProjection()).recomputation).toMatchObject({
        status: "partial",
        calculationRun: {
          runId: PARTIAL_RUN_ID,
          status: "partial",
          failureCode: null,
        },
      })

      const failedRevision = yield* captureV2Revision()
      yield* insertCalculationRun({
        id: FAILED_RUN_ID,
        inputLedgerRevision: failedRevision,
        status: "failed",
      })
      expect(expectProjection(yield* findProjection()).recomputation).toMatchObject({
        status: "failed",
        calculationRun: {
          runId: FAILED_RUN_ID,
          status: "failed",
          failureCode: "calculation_stale_recomputed",
        },
      })

      const secondTarget: PrincipalAssetOverrideTarget = {
        _tag: "representation",
        blockchain: "base",
        type: "token",
        contractAddress: SECOND_CONTRACT_ADDRESS,
        mintAddress: null,
      }
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [base] = yield* db
              .select({ id: schema.blockchains.id })
              .from(schema.blockchains)
              .where(eq(schema.blockchains.name, "base"))
              .limit(1)
            if (base === undefined) return yield* Effect.die("Missing Base fixture")
            yield* db.insert(schema.assetRepresentations).values({
              id: SECOND_REPRESENTATION_ID,
              assetId: CURRENT_ASSET_ID,
              blockchainId: base.id,
              type: "token",
              contractAddress: SECOND_CONTRACT_ADDRESS,
              mintAddress: null,
              decimals: 6,
              isSpam: false,
            })
            yield* db.insert(schema.sourceRepresentationUses).values({
              sourceId: SOURCE_ID,
              blockchainId: base.id,
              representationType: "token",
              contractAddress: SECOND_CONTRACT_ADDRESS,
              mintAddress: null,
            })
          })
        )
      )
      const secondInitial = expectProjection(yield* findProjection({ target: secondTarget }))
      const secondCreated = expectProjection(
        yield* create({
          expectedSystemRevision: secondInitial.system.identityRevision,
          replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
          target: secondTarget,
        })
      )
      if (secondCreated.recomputation.status === "not_scheduled") {
        return yield* Effect.die("Second target did not schedule replay work")
      }
      const secondJobId = secondCreated.recomputation.sourceJobs[0]?.jobId
      if (secondJobId === null || secondJobId === undefined) {
        return yield* Effect.die("Second target did not expose its replay job")
      }
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.processingJobs)
              .set({
                status: "completed",
                completedAt: date("2026-09-05T08:10:00.000Z"),
                updatedAt: date("2026-09-05T08:10:00.000Z"),
              })
              .where(eq(schema.processingJobs.id, secondJobId))
          })
        )
      )

      expect(
        expectProjection(yield* findProjection({ target: secondTarget })).recomputation
      ).toMatchObject({
        status: "updating",
        sourceJobs: [{ status: "complete" }],
        calculationRun: null,
      })
      expect(expectProjection(yield* findProjection()).recomputation).toMatchObject({
        status: "failed",
        calculationRun: { runId: FAILED_RUN_ID },
      })
    })
  )

  it.effect("excludes provider fallback when the transaction has any exact observation", () =>
    Effect.gen(function* () {
      yield* seedActiveOverrides({ withActiveOverrides: false })
      const providerTarget: PrincipalAssetOverrideTarget = {
        _tag: "provider_asset",
        providerAssetRowId: PROVIDER_ASSET_ID,
      }
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [coinbase] = yield* db
              .select({ id: schema.cex.id })
              .from(schema.cex)
              .where(eq(schema.cex.name, "coinbase"))
            if (coinbase === undefined) return yield* Effect.die("Missing Coinbase fixture")

            yield* db.insert(schema.cexAccount).values({
              id: SECOND_CEX_ACCOUNT_ID,
              cexId: coinbase.id,
              principalId: PRINCIPAL_ID,
              providerUserId: "provider-asset-second-user",
              providerAccountId: "provider-asset-second-account",
            })
            yield* db.insert(schema.sources).values({
              id: SECOND_SOURCE_ID,
              principalId: PRINCIPAL_ID,
              name: "Exact observation source",
              providerKey: "coinbase",
              sourceableType: "cex",
              cexAccountId: SECOND_CEX_ACCOUNT_ID,
              addressId: null,
            })
            yield* db.insert(schema.providerAssets).values([
              {
                id: PROVIDER_ASSET_ID,
                provider: "coinbase",
                providerAssetId: "provider-usdc",
                currencyCode: "USDC",
                name: "USD Coin",
                exponent: 6,
                providerType: "crypto",
                retrievedAt: date("2026-09-02T10:00:00.000Z"),
              },
              {
                id: OTHER_PROVIDER_ASSET_ID,
                provider: "coinbase",
                providerAssetId: "provider-eth",
                currencyCode: "ETH",
                name: "Ether",
                exponent: 18,
                providerType: "crypto",
                retrievedAt: date("2026-09-02T10:00:00.000Z"),
              },
            ])
            yield* db.insert(schema.providerAssetSourceUses).values([
              { providerAssetRowId: PROVIDER_ASSET_ID, sourceId: SOURCE_ID },
              { providerAssetRowId: PROVIDER_ASSET_ID, sourceId: SECOND_SOURCE_ID },
            ])
            yield* db.insert(schema.transactions).values([
              {
                id: CHAINLESS_TRANSACTION_ID,
                sourceId: SOURCE_ID,
                externalId: "chainless-provider-asset-use",
                timestamp: date("2026-09-02T10:00:00.000Z"),
                principalId: PRINCIPAL_ID,
              },
              {
                id: EXACT_TRANSACTION_ID,
                sourceId: SECOND_SOURCE_ID,
                externalId: "exact-provider-asset-use",
                timestamp: date("2026-09-02T10:01:00.000Z"),
                principalId: PRINCIPAL_ID,
              },
            ])
            yield* db.insert(schema.providerAssetTransactionUses).values([
              {
                providerAssetRowId: PROVIDER_ASSET_ID,
                transactionId: CHAINLESS_TRANSACTION_ID,
                sourceId: SOURCE_ID,
              },
              {
                providerAssetRowId: PROVIDER_ASSET_ID,
                transactionId: EXACT_TRANSACTION_ID,
                sourceId: SECOND_SOURCE_ID,
              },
            ])
            yield* db.insert(schema.providerTransfers).values({
              sourceId: SECOND_SOURCE_ID,
              transactionId: EXACT_TRANSACTION_ID,
              externalId: "exact-provider-asset-transfer",
              timestamp: date("2026-09-02T10:01:00.000Z"),
              direction: "inbound",
              processingMode: "accounting_and_evidence",
              fromAddress: "external",
              toAddress: "owned",
              providerAssetId: OTHER_PROVIDER_ASSET_ID,
              observedBlockchainId: sql`(select id from blockchains where lower(name) = 'base')`,
              observedRepresentationType: "token",
              observedContractAddress: CONTRACT_ADDRESS,
              observedMintAddress: null,
              observedDecimals: 6,
              amount: "1",
            })
          })
        )
      )

      const initial = expectProjection(yield* findProjection({ target: providerTarget }))
      const created = expectProjection(
        yield* create({
          expectedSystemRevision: initial.system.identityRevision,
          replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
          target: providerTarget,
        })
      )
      expect(created.recomputation).toMatchObject({
        status: "updating",
        sourceJobs: [{ sourceId: SOURCE_ID }],
      })

      const jobs = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ sourceId: schema.processingJobs.sourceId })
              .from(schema.processingJobs)
          })
        )
      )
      expect(jobs).toEqual([{ sourceId: SOURCE_ID }])
    })
  )

  it.effect("rolls back history and replay work when application linking fails", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveOverrides({ withActiveOverrides: false })
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.execute(sql`
              create function reject_test_override_application() returns trigger
              language plpgsql as $trigger$
              begin
                raise exception 'forced override application failure';
              end
              $trigger$
            `)
            yield* db.execute(sql`
              create trigger reject_test_override_application
              before insert on principal_asset_override_applications
              for each row execute function reject_test_override_application()
            `)
          })
        )
      )

      const result = yield* Effect.result(
        create({
          expectedSystemRevision: initial.system.identityRevision,
          replacement: { _tag: "identity", assetId: TEST_BTC_ASSET_ID },
        })
      )
      expect(Result.isFailure(result)).toBe(true)

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.execute(sql`
              drop trigger reject_test_override_application
              on principal_asset_override_applications
            `)
            yield* db.execute(sql`drop function reject_test_override_application()`)
          })
        )
      )

      const stored = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* Effect.all({
              applications: db
                .select({ overrideId: schema.principalAssetOverrideApplications.overrideId })
                .from(schema.principalAssetOverrideApplications),
              jobs: db.select({ id: schema.processingJobs.id }).from(schema.processingJobs),
              overrides: db
                .select({ id: schema.principalAssetOverrides.id })
                .from(schema.principalAssetOverrides),
              targets: db
                .select({ id: schema.principalAssetOverrideTargets.id })
                .from(schema.principalAssetOverrideTargets),
            })
          })
        )
      )
      expect(stored).toEqual({ applications: [], jobs: [], overrides: [], targets: [] })
    })
  )

  it.effect(
    "returns the current projection and writes nothing for stale compare-and-set values",
    () =>
      Effect.gen(function* () {
        const initial = yield* seedActiveOverrides()
        const staleRevision = yield* Effect.result(
          replace({
            expectedActiveOverrideId: IDENTITY_OVERRIDE_ID,
            expectedSystemRevision: `${initial.system.identityRevision}:stale`,
            replacement: { _tag: "identity", assetId: CURRENT_ASSET_ID },
          })
        )
        expect(Result.isFailure(staleRevision)).toBe(true)
        if (Result.isFailure(staleRevision)) {
          expect(staleRevision.failure).toBeInstanceOf(PrincipalAssetOverrideConflictError)
          if (staleRevision.failure instanceof PrincipalAssetOverrideConflictError) {
            expect(staleRevision.failure.conflictKinds).toEqual(["system_revision"])
            expect(staleRevision.failure.currentProjection.activeIdentityOverride?.id).toBe(
              IDENTITY_OVERRIDE_ID
            )
          }
        }

        const staleActive = yield* Effect.result(
          withdraw({
            expectedActiveOverrideId: "00000000-0000-4000-8000-000000000899",
            expectedSystemRevision: initial.system.identityRevision,
            kind: "identity",
          })
        )
        expect(Result.isFailure(staleActive)).toBe(true)
        if (
          Result.isFailure(staleActive) &&
          staleActive.failure instanceof PrincipalAssetOverrideConflictError
        ) {
          expect(staleActive.failure.conflictKinds).toEqual(["active_override"])
          expect(staleActive.failure.currentActiveOverrideId).toBe(IDENTITY_OVERRIDE_ID)
        }

        const stored = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return yield* Effect.all({
                applications: db
                  .select({ overrideId: schema.principalAssetOverrideApplications.overrideId })
                  .from(schema.principalAssetOverrideApplications),
                jobs: db.select({ id: schema.processingJobs.id }).from(schema.processingJobs),
                overrides: db
                  .select({ id: schema.principalAssetOverrides.id })
                  .from(schema.principalAssetOverrides),
              })
            })
          )
        )
        expect(stored.overrides).toHaveLength(2)
        expect(stored.applications).toEqual([])
        expect(stored.jobs).toEqual([])
      })
  )

  it.effect("rejects missing and incompatible identity replacements without writing", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveOverrides()
      const missing = yield* Effect.result(
        replace({
          expectedActiveOverrideId: IDENTITY_OVERRIDE_ID,
          expectedSystemRevision: initial.system.identityRevision,
          replacement: {
            _tag: "identity",
            assetId: "00000000-0000-4000-8000-000000000898",
          },
        })
      )
      expect(Result.isFailure(missing)).toBe(true)
      if (
        Result.isFailure(missing) &&
        missing.failure instanceof PrincipalAssetOverrideReplacementValidationError
      ) {
        expect(missing.failure.validation._tag).toBe("asset_not_found")
      }

      const incompatible = yield* Effect.result(
        replace({
          expectedActiveOverrideId: IDENTITY_OVERRIDE_ID,
          expectedSystemRevision: initial.system.identityRevision,
          replacement: { _tag: "identity", assetId: NFT_ASSET_ID },
        })
      )
      expect(Result.isFailure(incompatible)).toBe(true)
      if (
        Result.isFailure(incompatible) &&
        incompatible.failure instanceof PrincipalAssetOverrideReplacementValidationError
      ) {
        expect(incompatible.failure.validation).toMatchObject({
          _tag: "incompatible_asset_type",
          targetAssetType: "fungible",
        })
      }

      const stored = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* Effect.all({
              applications: db
                .select({ overrideId: schema.principalAssetOverrideApplications.overrideId })
                .from(schema.principalAssetOverrideApplications),
              jobs: db.select({ id: schema.processingJobs.id }).from(schema.processingJobs),
              overrides: db
                .select({ id: schema.principalAssetOverrides.id })
                .from(schema.principalAssetOverrides),
            })
          })
        )
      )
      expect(stored.overrides).toHaveLength(2)
      expect(stored.applications).toEqual([])
      expect(stored.jobs).toEqual([])
    })
  )

  it.effect("serializes racing replacements so only one appends", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveOverrides()
      const attempts = yield* Effect.all(
        [
          replace({
            expectedActiveOverrideId: IDENTITY_OVERRIDE_ID,
            expectedSystemRevision: initial.system.identityRevision,
            replacement: { _tag: "identity", assetId: CURRENT_ASSET_ID },
          }).pipe(Effect.result),
          replace({
            expectedActiveOverrideId: IDENTITY_OVERRIDE_ID,
            expectedSystemRevision: initial.system.identityRevision,
            replacement: { _tag: "identity", assetId: CURRENT_ASSET_ID },
          }).pipe(Effect.result),
        ],
        { concurrency: "unbounded" }
      )

      expect(attempts.filter(Result.isSuccess)).toHaveLength(1)
      const [failed] = attempts.filter(Result.isFailure)
      expect(failed?.failure).toBeInstanceOf(PrincipalAssetOverrideConflictError)
      if (failed?.failure instanceof PrincipalAssetOverrideConflictError) {
        expect(failed.failure.conflictKinds).toEqual(["active_override"])
        expect(failed.failure.currentProjection.history).toHaveLength(3)
      }
    })
  )

  it.effect("keeps missing and other-principal targets indistinguishable", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveOverrides()
      yield* Effect.promise(() =>
        runPg(
          seedSyncEngineRepositoryFixture({
            userId: OTHER_USER_ID,
            principalId: OTHER_PRINCIPAL_ID,
            sourceId: OTHER_SOURCE_ID,
          })
        )
      )

      const unowned = yield* replace({
        principalId: OTHER_PRINCIPAL_ID,
        expectedActiveOverrideId: IDENTITY_OVERRIDE_ID,
        expectedSystemRevision: initial.system.identityRevision,
        replacement: { _tag: "identity", assetId: CURRENT_ASSET_ID },
      })
      const missing = yield* runRepository(
        Effect.flatMap(PrincipalAssetOverrideRepository, (repository) =>
          repository.replace({
            actorUserId: AuthUserId.make(USER_ID),
            expectedActiveOverrideId: IDENTITY_OVERRIDE_ID,
            expectedSystemRevision: initial.system.identityRevision,
            principalId: PrincipalId.make(PRINCIPAL_ID),
            reason: "This target is absent.",
            replacement: { _tag: "identity", assetId: CURRENT_ASSET_ID },
            target: { ...target, contractAddress: "0xabcd000000000000000000000000000000000110" },
          })
        )
      )

      expect(unowned).toEqual(missing)
      expect(Option.isNone(unowned)).toBe(true)

      const unownedCreate = yield* create({
        expectedSystemRevision: initial.system.identityRevision,
        principalId: OTHER_PRINCIPAL_ID,
        replacement: { _tag: "identity", assetId: CURRENT_ASSET_ID },
      })
      const missingCreate = yield* create({
        expectedSystemRevision: initial.system.identityRevision,
        replacement: { _tag: "identity", assetId: CURRENT_ASSET_ID },
        target: { ...target, contractAddress: "0xabcd000000000000000000000000000000000110" },
      })
      expect(unownedCreate).toEqual(missingCreate)
      expect(Option.isNone(unownedCreate)).toBe(true)
    })
  )
})
