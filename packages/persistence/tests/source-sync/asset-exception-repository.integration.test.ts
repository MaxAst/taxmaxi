import { seedMovementLegs } from "../support/movement-leg-fixtures.ts"
import * as DateTime from "effect/DateTime"
import { NO_CURRENT_ASSET_CONCLUSION, NO_CURRENT_ASSET_POLICY_EVALUATION } from "@my/core/assets"
import { AssetExceptionRepository, ProviderAssetRepository } from "@my/sync-engine/services"
import { and, asc, eq, inArray, sql } from "drizzle-orm"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { AssetExceptionRepositoryLive } from "../../src/layers/AssetExceptionRepositoryLive.ts"
import { ProviderAssetRepositoryLive } from "../../src/layers/ProviderAssetRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_BTC_REPRESENTATION_ID,
  TEST_PRINCIPAL_ID,
  TEST_SOURCE_ID,
  TEST_USER_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_asset_exception_repo",
})

const runPg = context.runPg

const runRepository = <A, E>(effect: Effect.Effect<A, E, AssetExceptionRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: AssetExceptionRepositoryLive }))

const runProviderRepository = <A, E>(effect: Effect.Effect<A, E, ProviderAssetRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: ProviderAssetRepositoryLive }))

const seedException = (
  suffix = "",
  {
    sourceId = TEST_SOURCE_ID,
    principalId = TEST_PRINCIPAL_ID,
  }: { readonly sourceId?: string; readonly principalId?: string } = {}
) =>
  runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const observedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:00:00.000Z"))
      const [providerAsset] = yield* db
        .insert(schema.providerAssets)
        .values({
          provider: "coinbase",
          providerAssetId: `exception-token${suffix}`,
          naturalKey: `currency_code:EXC${suffix}`,
          currencyCode: "EXC",
          name: "Exception Token",
          exponent: 6,
          providerType: "crypto",
          rawProviderPayload: { id: `exception-token${suffix}` },
          evidenceRevision: 2,
          discoveredAt: observedAt,
          retrievedAt: observedAt,
        })
        .returning({ id: schema.providerAssets.id })
      if (providerAsset === undefined) {
        return yield* Effect.die("Failed to seed provider asset")
      }

      yield* db.insert(schema.assetResolutionJobs).values({
        providerAssetRowId: providerAsset.id,
        evidenceRevision: 2,
        policyRevision: "test-policy.1",
        status: "completed",
      })
      // The actionable evaluation is created after the observation was first
      // discovered; ranking must age the case from this later timestamp.
      const evaluatedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-05T00:00:00.000Z"))
      const [decision] = yield* db
        .insert(schema.assetResolutionDecisions)
        .values({
          providerAssetRowId: providerAsset.id,
          evidenceRevision: 2,
          policyRevision: "test-policy.1",
          outcome: "pending",
          reason: "display_collision",
          actor: "policy:test-policy.1",
          createdAt: evaluatedAt,
        })
        .returning({ id: schema.assetResolutionDecisions.id })
      if (decision === undefined) {
        return yield* Effect.die("Failed to seed resolution decision")
      }
      yield* db.insert(schema.assetResolutionCurrentState).values({
        providerAssetRowId: providerAsset.id,
        currentConclusionId: null,
        currentPolicyEvaluationId: decision.id,
      })
      const [evidence] = yield* db
        .insert(schema.assetResolutionEvidence)
        .values({
          decisionId: decision.id,
          authority: "chain",
          claimKind: "representation",
          sourceLocator: `coinbase:exception-token${suffix}`,
          retrievedAt: observedAt,
          evidenceRevision: 2,
          decodedClaim: { blockchain: "base", decimals: 6 },
          rawPayload: { asset: "exception-token" },
        })
        .returning({ id: schema.assetResolutionEvidence.id })
      if (evidence === undefined) {
        return yield* Effect.die("Failed to seed evidence")
      }

      yield* db.insert(schema.providerAssetSourceUses).values({
        providerAssetRowId: providerAsset.id,
        sourceId,
      })
      const [transaction] = yield* db
        .insert(schema.transactions)
        .values({
          sourceId,
          principalId,
          externalId: `exception-transaction${suffix}`,
          timestamp: observedAt,
          metadata: {
            provider: "coinbase",
            nativeAmount: { amount: "1250.50", currency: "EUR" },
          },
          providerFiatAmount: "1250.50",
          providerFiatCurrency: "EUR",
        })
        .returning({ id: schema.transactions.id })
      if (transaction === undefined) {
        return yield* Effect.die("Failed to seed transaction")
      }
      yield* db.insert(schema.providerTransfers).values({
        sourceId,
        transactionId: transaction.id,
        externalId: `exception-transfer${suffix}`,
        providerAssetId: providerAsset.id,
        timestamp: observedAt,
        direction: "inbound",
        processingMode: "accounting_and_evidence",
        fromAccountRef: "coinbase:external",
        toAccountRef: "coinbase:user",
        amount: "10",
      })

      return {
        providerAssetRowId: providerAsset.id,
        decisionId: decision.id,
        evidenceId: evidence.id,
      }
    })
  )

beforeEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* context.recreateTestDatabase()
      yield* Effect.promise(() => runPg(seedSyncEngineRepositoryFixture()))
    })
  )
)

describe("AssetExceptionRepositoryLive", () => {
  it.effect(
    "keeps the conclusion but clears the current policy evaluation when evidence advances",
    () =>
      Effect.gen(function* () {
        const suffix = "-new-evidence"
        const fixture = yield* Effect.promise(() => seedException(suffix))
        const currentConclusionId = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const [conclusion] = yield* db
                .insert(schema.assetResolutionDecisions)
                .values({
                  providerAssetRowId: fixture.providerAssetRowId,
                  evidenceRevision: 2,
                  policyRevision: "test-policy.settled.1",
                  outcome: "excluded",
                  reason: "provider_artifact",
                  actor: "policy:test-policy.settled.1",
                })
                .returning({ id: schema.assetResolutionDecisions.id })
              if (conclusion === undefined) {
                return yield* Effect.die("Failed to seed current conclusion")
              }
              yield* db
                .update(schema.assetResolutionCurrentState)
                .set({
                  currentConclusionId: conclusion.id,
                  currentPolicyEvaluationId: fixture.decisionId,
                })
                .where(
                  eq(
                    schema.assetResolutionCurrentState.providerAssetRowId,
                    fixture.providerAssetRowId
                  )
                )
              return conclusion.id
            })
          )
        )

        yield* Effect.promise(() =>
          runProviderRepository(
            Effect.flatMap(ProviderAssetRepository, (repository) =>
              repository.upsertProviderAssets({
                providerKey: "coinbase",
                entries: [
                  {
                    providerAssetId: `exception-token${suffix}`,
                    naturalKey: `currency_code:EXC${suffix}`,
                    currencyCode: "EXC",
                    name: "Exception Token Updated",
                    exponent: 6,
                    providerType: "crypto",
                    payload: { id: `exception-token${suffix}`, version: 2 },
                  },
                ],
              })
            )
          )
        )
        const detail = yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(AssetExceptionRepository, (repository) =>
              repository.findDetail({
                _tag: "row_id",
                providerAssetRowId: fixture.providerAssetRowId,
              })
            )
          )
        )

        expect(Option.getOrNull(detail)).toMatchObject({
          evidenceRevision: 3,
          currentConclusionRevision: currentConclusionId,
          currentPolicyEvaluationRevision: NO_CURRENT_ASSET_POLICY_EVALUATION,
          currentConclusion: { id: currentConclusionId },
          currentPolicyEvaluation: null,
        })
      })
  )

  it.effect("preserves an explicit null conclusion pointer when older history is conclusive", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException("-explicit-null"))
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.assetResolutionDecisions).values({
              providerAssetRowId: fixture.providerAssetRowId,
              evidenceRevision: 1,
              policyRevision: "test-policy.legacy",
              outcome: "excluded",
              reason: "provider_artifact",
              actor: "policy:test-policy.legacy",
            })
            yield* db
              .update(schema.assetResolutionCurrentState)
              .set({
                currentConclusionId: null,
                currentPolicyEvaluationId: fixture.decisionId,
              })
              .where(
                eq(
                  schema.assetResolutionCurrentState.providerAssetRowId,
                  fixture.providerAssetRowId
                )
              )
          })
        )
      )

      const input = {
        providerAssetRowId: fixture.providerAssetRowId,
        claim: { _tag: "exclusion", reason: "provider_artifact" } as const,
        evidenceRevision: 2,
        currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
        currentPolicyEvaluationRevision: fixture.decisionId,
        evidenceSnapshotIds: [fixture.evidenceId],
        rationale: null,
        expectedResultingAssetId: null,
        expectedAssetOutcome: "none" as const,
        expectedRepresentationOutcome: "none" as const,
      }
      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            const detail = yield* repository.findDetail({
              _tag: "row_id",
              providerAssetRowId: fixture.providerAssetRowId,
            })
            const preview = yield* repository.previewDecision(input)
            const submitted = yield* repository.submitDecision({ input, actorId: TEST_USER_ID })
            return { detail, preview, submitted }
          })
        )
      )

      expect(Option.getOrNull(result.detail)).toMatchObject({
        currentConclusion: null,
        currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
        currentPolicyEvaluation: { id: fixture.decisionId },
      })
      expect(result.preview).toMatchObject({ _tag: "ready" })
      expect(result.submitted).toMatchObject({ _tag: "accepted" })
    })
  )

  it.effect("classifies human changes to an automatic conclusion by their result", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException("-automatic-conclusion"))
      const automaticConclusionId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [conclusion] = yield* db
              .insert(schema.assetResolutionDecisions)
              .values({
                providerAssetRowId: fixture.providerAssetRowId,
                evidenceRevision: 1,
                policyRevision: "test-policy.automatic",
                outcome: "excluded",
                reason: "provider_artifact",
                actor: "policy:test-policy.automatic",
              })
              .returning({ id: schema.assetResolutionDecisions.id })
            if (conclusion === undefined) {
              return yield* Effect.die("Failed to seed automatic conclusion")
            }
            yield* db
              .update(schema.assetResolutionCurrentState)
              .set({
                currentConclusionId: conclusion.id,
                currentPolicyEvaluationId: fixture.decisionId,
              })
              .where(
                eq(
                  schema.assetResolutionCurrentState.providerAssetRowId,
                  fixture.providerAssetRowId
                )
              )
            return conclusion.id
          })
        )
      )

      const previews = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            const supersession = yield* repository.previewDecision({
              providerAssetRowId: fixture.providerAssetRowId,
              claim: { _tag: "exclusion", reason: "confirmed_spam" },
              evidenceRevision: 2,
              currentConclusionRevision: automaticConclusionId,
              currentPolicyEvaluationRevision: fixture.decisionId,
              evidenceSnapshotIds: [fixture.evidenceId],
              rationale: null,
            })
            const reversal = yield* repository.previewDecision({
              providerAssetRowId: fixture.providerAssetRowId,
              claim: {
                _tag: "identity",
                assetId: null,
                newAsset: { name: "Corrected Token", symbol: "COR", type: "fungible" },
                representation: null,
              },
              evidenceRevision: 2,
              currentConclusionRevision: automaticConclusionId,
              currentPolicyEvaluationRevision: fixture.decisionId,
              evidenceSnapshotIds: [fixture.evidenceId],
              rationale: "The automatic exclusion was incorrect.",
            })
            return { reversal, supersession }
          })
        )
      )

      expect(previews.supersession).toMatchObject({
        _tag: "ready",
        preview: {
          decisionAction: "supersession",
          supersededConclusion: { id: automaticConclusionId },
        },
      })
      expect(previews.reversal).toMatchObject({
        _tag: "ready",
        preview: {
          decisionAction: "reversal",
          supersededConclusion: { id: automaticConclusionId },
        },
      })
    })
  )

  it.effect("shows policy-backed rematerialization as blocked across operator surfaces", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException("-policy-rematerialization"))
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [asset] = yield* db
              .insert(schema.assets)
              .values({ name: "Policy Target", symbol: "POL", type: "fungible" })
              .returning({ id: schema.assets.id })
            const [job] = yield* db
              .insert(schema.processingJobs)
              .values({
                sourceId: TEST_SOURCE_ID,
                principalId: TEST_PRINCIPAL_ID,
                mode: "replay",
                status: "pending",
              })
              .returning({ id: schema.processingJobs.id })
            if (asset === undefined || job === undefined) {
              return yield* Effect.die("Failed to seed policy-backed rematerialization")
            }
            yield* db.insert(schema.providerAssetMappings).values({
              providerAssetRowId: fixture.providerAssetRowId,
              mappingKind: "asset",
              canonicalAssetId: asset.id,
              assetRepresentationId: null,
              mappingStatus: "approved",
            })
            yield* db
              .update(schema.assetResolutionCurrentState)
              .set({ currentConclusionId: null, currentPolicyEvaluationId: fixture.decisionId })
              .where(
                eq(
                  schema.assetResolutionCurrentState.providerAssetRowId,
                  fixture.providerAssetRowId
                )
              )
            yield* db.insert(schema.assetDecisionRematerializations).values({
              decisionId: fixture.decisionId,
              sourceId: TEST_SOURCE_ID,
              processingJobId: job.id,
              status: "pending",
            })
          })
        )
      )

      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            const list = yield* repository.listExceptions({
              cursor: null,
              limit: 10,
              query: null,
            })
            const detail = yield* repository.findDetail({
              _tag: "row_id",
              providerAssetRowId: fixture.providerAssetRowId,
            })
            const preview = yield* repository.previewDecision({
              providerAssetRowId: fixture.providerAssetRowId,
              claim: { _tag: "exclusion", reason: "confirmed_spam" },
              evidenceRevision: 2,
              currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
              currentPolicyEvaluationRevision: fixture.decisionId,
              evidenceSnapshotIds: [fixture.evidenceId],
              rationale: null,
            })
            return { list, detail, preview }
          })
        )
      )

      expect(result.list).toEqual([
        expect.objectContaining({
          providerAssetRowId: fixture.providerAssetRowId,
          blockedReports: 1,
        }),
      ])
      expect(Option.getOrNull(result.detail)).toMatchObject({
        impact: { blockedReports: 1 },
        rematerialization: { status: "pending", affectedSourceCount: 1 },
      })
      expect(result.preview).toMatchObject({
        _tag: "ready",
        preview: {
          impact: { blockedReports: 1 },
          supersededConclusion: null,
        },
      })

      const newerPolicyEvaluationId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [evaluation] = yield* db
              .insert(schema.assetResolutionDecisions)
              .values({
                providerAssetRowId: fixture.providerAssetRowId,
                evidenceRevision: 2,
                policyRevision: "test-policy.rematerialization-advanced",
                outcome: "fail_closed",
                reason: "ownership_conflict",
                actor: "system:asset-resolution-policy",
              })
              .returning({ id: schema.assetResolutionDecisions.id })
            if (evaluation === undefined) {
              return yield* Effect.die("Failed to advance the policy evaluation")
            }
            yield* db
              .update(schema.assetResolutionCurrentState)
              .set({ currentPolicyEvaluationId: evaluation.id })
              .where(
                eq(
                  schema.assetResolutionCurrentState.providerAssetRowId,
                  fixture.providerAssetRowId
                )
              )
            return evaluation.id
          })
        )
      )

      const advanced = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            const list = yield* repository.listExceptions({
              cursor: null,
              limit: 10,
              query: null,
            })
            const detail = yield* repository.findDetail({
              _tag: "row_id",
              providerAssetRowId: fixture.providerAssetRowId,
            })
            return { detail, list }
          })
        )
      )

      expect(advanced.list).toEqual([
        expect.objectContaining({
          currentPolicyEvaluationRevision: newerPolicyEvaluationId,
          blockedReports: 1,
        }),
      ])
      expect(Option.getOrNull(advanced.detail)).toMatchObject({
        currentPolicyEvaluationRevision: newerPolicyEvaluationId,
        impact: { blockedReports: 1 },
        rematerialization: { status: "pending", affectedSourceCount: 1 },
      })
    })
  )

  it.effect("lists completed domain exceptions with impact-ranked aggregate reach", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException())

      const rows = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            return yield* repository.listExceptions({ cursor: null, limit: 10, query: null })
          })
        )
      )

      expect(rows).toEqual([
        expect.objectContaining({
          providerAssetRowId: fixture.providerAssetRowId,
          reason: "display_collision",
          severity: "medium",
          blockedReports: 1,
          affectedPrincipals: 1,
          affectedTransactions: 1,
          affectedSources: 1,
          affectedCalculations: 1,
          affectedTransactionValueEur: "1250.50",
          // The case ages from the actionable evaluation, not from the earlier
          // provider observation discovery.
          oldestAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-05T00:00:00.000Z")),
        }),
      ])
    })
  )

  it.effect("filters exceptions by a search query across provider keys and names", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException())

      const { matchingName, matchingNaturalKey, noMatch } = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            const matchingName = yield* repository.listExceptions({
              cursor: null,
              limit: 10,
              query: "exception token",
            })
            const matchingNaturalKey = yield* repository.listExceptions({
              cursor: null,
              limit: 10,
              query: "currency_code:EXC",
            })
            const noMatch = yield* repository.listExceptions({
              cursor: null,
              limit: 10,
              query: "unrelated-asset",
            })
            return { matchingName, matchingNaturalKey, noMatch }
          })
        )
      )

      expect(matchingName).toEqual([
        expect.objectContaining({ providerAssetRowId: fixture.providerAssetRowId }),
      ])
      expect(matchingNaturalKey).toEqual([
        expect.objectContaining({ providerAssetRowId: fixture.providerAssetRowId }),
      ])
      expect(noMatch).toEqual([])
    })
  )

  it.effect("keeps a conclusive evaluation that disagrees with the conclusion discoverable", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException("-conclusive-disagreement"))

      // Settle the observation as excluded, then let a later evidence revision
      // produce a conclusive attach recommendation. The conclusion stays in
      // force, but the case must not vanish from the review queue.
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [conclusion] = yield* db
              .insert(schema.assetResolutionDecisions)
              .values({
                providerAssetRowId: fixture.providerAssetRowId,
                evidenceRevision: 2,
                policyRevision: "test-policy.settled.1",
                outcome: "excluded",
                reason: "spam_evidence",
                actor: "system:asset-resolution-policy",
              })
              .returning({ id: schema.assetResolutionDecisions.id })
            if (conclusion === undefined) {
              return yield* Effect.die("Failed to seed excluded conclusion")
            }
            yield* db
              .update(schema.providerAssets)
              .set({ evidenceRevision: 3 })
              .where(eq(schema.providerAssets.id, fixture.providerAssetRowId))
            yield* db.insert(schema.assetResolutionJobs).values({
              providerAssetRowId: fixture.providerAssetRowId,
              evidenceRevision: 3,
              policyRevision: "test-policy.1",
              status: "completed",
            })
            const [reversalEvaluation] = yield* db
              .insert(schema.assetResolutionDecisions)
              .values({
                providerAssetRowId: fixture.providerAssetRowId,
                evidenceRevision: 3,
                policyRevision: "test-policy.1",
                outcome: "attach",
                reason: null,
                actor: "system:asset-resolution-policy",
                createdAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-06T00:00:00.000Z")),
              })
              .returning({ id: schema.assetResolutionDecisions.id })
            if (reversalEvaluation === undefined) {
              return yield* Effect.die("Failed to seed conclusive evaluation")
            }
            yield* db
              .update(schema.assetResolutionCurrentState)
              .set({
                currentConclusionId: conclusion.id,
                currentPolicyEvaluationId: reversalEvaluation.id,
              })
              .where(
                eq(
                  schema.assetResolutionCurrentState.providerAssetRowId,
                  fixture.providerAssetRowId
                )
              )
          })
        )
      )

      const disagreement = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(AssetExceptionRepository, (repository) =>
            repository.listExceptions({ cursor: null, limit: 10, query: null })
          )
        )
      )
      expect(disagreement).toEqual([
        expect.objectContaining({
          providerAssetRowId: fixture.providerAssetRowId,
          reason: "conclusion_disagreement",
          severity: "high",
        }),
      ])

      // An evaluation that agrees with the conclusion has nothing to review.
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.assetResolutionDecisions)
              .set({ outcome: "excluded", reason: "spam_evidence" })
              .where(
                and(
                  eq(
                    schema.assetResolutionDecisions.providerAssetRowId,
                    fixture.providerAssetRowId
                  ),
                  eq(schema.assetResolutionDecisions.evidenceRevision, 3)
                )
              )
          })
        )
      )
      const agreement = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(AssetExceptionRepository, (repository) =>
            repository.listExceptions({ cursor: null, limit: 10, query: null })
          )
        )
      )
      expect(agreement).toEqual([])

      // A human conclusion at the evaluation's evidence revision already
      // answered this evidence, so the disagreement stays hidden.
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.assetResolutionDecisions)
              .set({ outcome: "attach", reason: null })
              .where(
                and(
                  eq(
                    schema.assetResolutionDecisions.providerAssetRowId,
                    fixture.providerAssetRowId
                  ),
                  eq(schema.assetResolutionDecisions.evidenceRevision, 3)
                )
              )
            yield* db
              .update(schema.assetResolutionDecisions)
              .set({
                evidenceRevision: 3,
                humanClaim: { _tag: "exclusion", reason: "confirmed_spam" },
                actor: `user:${TEST_USER_ID}`,
              })
              .where(
                and(
                  eq(
                    schema.assetResolutionDecisions.providerAssetRowId,
                    fixture.providerAssetRowId
                  ),
                  eq(schema.assetResolutionDecisions.outcome, "excluded")
                )
              )
          })
        )
      )
      const humanSettled = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(AssetExceptionRepository, (repository) =>
            repository.listExceptions({ cursor: null, limit: 10, query: null })
          )
        )
      )
      expect(humanSettled).toEqual([])
    })
  )

  it.effect("keeps a same-asset evaluation with different representation facts discoverable", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException("-representation-disagreement"))

      // The conclusion attaches the observation to the fixture BTC
      // representation. A later evaluation recommends the same economic asset
      // through the same representation facts first, then through different
      // decimals.
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const blockchainRows = yield* db
              .select({ id: schema.blockchains.id, name: schema.blockchains.name })
              .from(schema.blockchains)
              .where(inArray(schema.blockchains.name, ["base", "bitcoin"]))
            const baseBlockchainId = blockchainRows.find(({ name }) => name === "base")?.id
            const bitcoinBlockchainId = blockchainRows.find(({ name }) => name === "bitcoin")?.id
            if (baseBlockchainId === undefined || bitcoinBlockchainId === undefined) {
              return yield* Effect.die("Missing fixture blockchains")
            }
            yield* seedSyncEngineAssets({ baseBlockchainId, bitcoinBlockchainId })
            const [conclusion] = yield* db
              .insert(schema.assetResolutionDecisions)
              .values({
                providerAssetRowId: fixture.providerAssetRowId,
                evidenceRevision: 2,
                policyRevision: "test-policy.settled.1",
                outcome: "attach",
                assetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
                actor: "system:asset-resolution-policy",
              })
              .returning({ id: schema.assetResolutionDecisions.id })
            if (conclusion === undefined) {
              return yield* Effect.die("Failed to seed attach conclusion")
            }
            yield* db
              .update(schema.providerAssets)
              .set({ evidenceRevision: 3 })
              .where(eq(schema.providerAssets.id, fixture.providerAssetRowId))
            yield* db.insert(schema.assetResolutionJobs).values({
              providerAssetRowId: fixture.providerAssetRowId,
              evidenceRevision: 3,
              policyRevision: "test-policy.1",
              status: "completed",
            })
            const [evaluation] = yield* db
              .insert(schema.assetResolutionDecisions)
              .values({
                providerAssetRowId: fixture.providerAssetRowId,
                evidenceRevision: 3,
                policyRevision: "test-policy.1",
                outcome: "attach",
                assetId: TEST_BTC_ASSET_ID,
                blockchain: "bitcoin",
                representationType: "token",
                contractAddress: "sync-engine-btc-fixture",
                mintAddress: null,
                decimals: 8,
                actor: "system:asset-resolution-policy",
              })
              .returning({ id: schema.assetResolutionDecisions.id })
            if (evaluation === undefined) {
              return yield* Effect.die("Failed to seed attach evaluation")
            }
            yield* db
              .update(schema.assetResolutionCurrentState)
              .set({
                currentConclusionId: conclusion.id,
                currentPolicyEvaluationId: evaluation.id,
              })
              .where(
                eq(
                  schema.assetResolutionCurrentState.providerAssetRowId,
                  fixture.providerAssetRowId
                )
              )
          })
        )
      )

      const matchingFacts = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(AssetExceptionRepository, (repository) =>
            repository.listExceptions({ cursor: null, limit: 10, query: null })
          )
        )
      )
      expect(matchingFacts).toEqual([])

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.assetResolutionDecisions)
              .set({ decimals: 9 })
              .where(
                and(
                  eq(
                    schema.assetResolutionDecisions.providerAssetRowId,
                    fixture.providerAssetRowId
                  ),
                  eq(schema.assetResolutionDecisions.evidenceRevision, 3)
                )
              )
          })
        )
      )
      const differentFacts = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(AssetExceptionRepository, (repository) =>
            repository.listExceptions({ cursor: null, limit: 10, query: null })
          )
        )
      )
      expect(differentFacts).toEqual([
        expect.objectContaining({
          providerAssetRowId: fixture.providerAssetRowId,
          reason: "conclusion_disagreement",
        }),
      ])
    })
  )

  it.effect("previews and atomically accepts a typed exclusion without a free-text rationale", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException())
      const input = {
        providerAssetRowId: fixture.providerAssetRowId,
        claim: { _tag: "exclusion", reason: "confirmed_spam" } as const,
        evidenceRevision: 2,
        currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
        currentPolicyEvaluationRevision: fixture.decisionId,
        evidenceSnapshotIds: [fixture.evidenceId],
        rationale: null,
        expectedResultingAssetId: null,
        expectedAssetOutcome: "none" as const,
        expectedRepresentationOutcome: "none" as const,
      }

      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            const preview = yield* repository.previewDecision(input)
            const submitted = yield* repository.submitDecision({ input, actorId: TEST_USER_ID })
            return { preview, submitted }
          })
        )
      )

      expect(result.preview).toMatchObject({
        _tag: "ready",
        preview: {
          assetOutcome: "none",
          representationOutcome: "none",
          rematerializationSourceCount: 1,
        },
      })
      expect(result.submitted).toMatchObject({
        _tag: "accepted",
        detail: {
          reviewStatus: "excluded",
          impact: { blockedReports: 1, affectedSources: 1 },
          rematerialization: { status: "pending", affectedSourceCount: 1 },
        },
      })

      const state = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const decisions = yield* db
              .select({
                outcome: schema.assetResolutionDecisions.outcome,
                rationale: schema.assetResolutionDecisions.rationale,
              })
              .from(schema.assetResolutionDecisions)
            const mappings = yield* db
              .select({ status: schema.providerAssetMappings.mappingStatus })
              .from(schema.providerAssetMappings)
            const work = yield* db
              .select({
                sourceId: schema.assetDecisionRematerializations.sourceId,
                processingJobId: schema.assetDecisionRematerializations.processingJobId,
              })
              .from(schema.assetDecisionRematerializations)
            return { decisions, mappings, work }
          })
        )
      )

      expect(state.decisions).toEqual(
        expect.arrayContaining([
          { outcome: "pending", rationale: null },
          { outcome: "excluded", rationale: null },
        ])
      )
      expect(state.mappings).toEqual([{ status: "excluded" }])
      expect(state.work).toEqual([
        { sourceId: TEST_SOURCE_ID, processingJobId: expect.any(String) },
      ])

      const processingJobId = state.work[0]?.processingJobId
      if (processingJobId === undefined || processingJobId === null) {
        throw new Error("Expected rematerialization processing job")
      }
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.processingJobs)
              .set({ status: "pending", attemptCount: 1 })
              .where(eq(schema.processingJobs.id, processingJobId))
          })
        )
      )
      const retryingDetail = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            const found = yield* repository.findDetail({
              _tag: "row_id",
              providerAssetRowId: fixture.providerAssetRowId,
            })
            if (Option.isNone(found)) {
              return yield* Effect.die("Expected retrying exception detail")
            }
            return found.value
          })
        )
      )
      expect(retryingDetail.rematerialization).toMatchObject({
        status: "pending",
        pendingSourceCount: 1,
        runningSourceCount: 0,
        retryingSourceCount: 1,
        remainingSourceCount: 1,
      })

      // The job lifecycle settles rebuild rows when a replay finishes
      // (covered by source-sync-job-repository tests); readers trust the
      // stored row status.
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.processingJobs)
              .set({ status: "completed", completedAt: yield* DateTime.nowAsDate })
              .where(eq(schema.processingJobs.id, processingJobId))
            yield* db
              .update(schema.assetDecisionRematerializations)
              .set({ status: "complete" })
              .where(eq(schema.assetDecisionRematerializations.sourceId, TEST_SOURCE_ID))
          })
        )
      )
      const completedDetail = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            const found = yield* repository.findDetail({
              _tag: "row_id",
              providerAssetRowId: fixture.providerAssetRowId,
            })
            if (Option.isNone(found)) {
              return yield* Effect.die("Expected completed exception detail")
            }
            return found.value
          })
        )
      )

      expect(completedDetail).toMatchObject({
        impact: { blockedReports: 0, affectedSources: 1 },
        rematerialization: { status: "complete" },
      })

      const completedFollowUpJobId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [followUpJob] = yield* db
              .insert(schema.processingJobs)
              .values({
                sourceId: TEST_SOURCE_ID,
                principalId: TEST_PRINCIPAL_ID,
                mode: "replay",
                status: "completed",
              })
              .returning({ id: schema.processingJobs.id })
            if (followUpJob === undefined) {
              return yield* Effect.die("Expected completed replay follow-up")
            }
            yield* db
              .update(schema.processingJobs)
              .set({
                status: "failed",
                followUpMode: "replay",
                followUpJobId: followUpJob.id,
              })
              .where(eq(schema.processingJobs.id, processingJobId))
            // Follow-up materialization repoints unfinished rows to the new
            // replay job, and its completion settles them.
            yield* db
              .update(schema.assetDecisionRematerializations)
              .set({ processingJobId: followUpJob.id, status: "complete" })
              .where(eq(schema.assetDecisionRematerializations.sourceId, TEST_SOURCE_ID))
            return followUpJob.id
          })
        )
      )
      const completedFollowUpDetail = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            const found = yield* repository.findDetail({
              _tag: "row_id",
              providerAssetRowId: fixture.providerAssetRowId,
            })
            if (Option.isNone(found)) {
              return yield* Effect.die("Expected completed follow-up exception detail")
            }
            return found.value
          })
        )
      )

      expect(completedFollowUpDetail).toMatchObject({
        impact: { blockedReports: 0, affectedSources: 1 },
        rematerialization: { status: "complete" },
      })

      const failedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-21T18:00:00.000Z"))
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.processingJobs)
              .set({
                status: "failed",
                completedAt: failedAt,
                followUpMode: null,
                followUpJobId: null,
              })
              .where(eq(schema.processingJobs.id, processingJobId))
            yield* db
              .delete(schema.processingJobs)
              .where(eq(schema.processingJobs.id, completedFollowUpJobId))
            // A failed replay parks the rows at operator_attention; the reader
            // falls back to the generic failure code when none was stored.
            yield* db
              .update(schema.assetDecisionRematerializations)
              .set({
                processingJobId,
                status: "operator_attention",
                failureCode: null,
                lastFailureAt: failedAt,
              })
              .where(eq(schema.assetDecisionRematerializations.sourceId, TEST_SOURCE_ID))
          })
        )
      )
      const failedDetail = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            const found = yield* repository.findDetail({
              _tag: "row_id",
              providerAssetRowId: fixture.providerAssetRowId,
            })
            if (Option.isNone(found)) {
              return yield* Effect.die("Expected failed exception detail")
            }
            return found.value
          })
        )
      )

      expect(failedDetail).toMatchObject({
        impact: { blockedReports: 1, affectedSources: 1 },
        rematerialization: {
          status: "operator_attention",
          failedSourceCount: 1,
          lastFailureAt: failedAt,
          failureCode: "rematerialization_failed",
        },
      })
    })
  )

  it.effect("reuses a pending replay without scheduling a redundant follow-up", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException())
      const pendingReplayJobId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [pendingReplay] = yield* db
              .insert(schema.processingJobs)
              .values({
                sourceId: TEST_SOURCE_ID,
                principalId: TEST_PRINCIPAL_ID,
                mode: "replay",
                status: "pending",
              })
              .returning({ id: schema.processingJobs.id })
            if (pendingReplay === undefined) {
              return yield* Effect.die("Failed to seed pending replay job")
            }
            return pendingReplay.id
          })
        )
      )

      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            return yield* repository.submitDecision({
              actorId: TEST_USER_ID,
              input: {
                providerAssetRowId: fixture.providerAssetRowId,
                claim: { _tag: "exclusion", reason: "confirmed_spam" },
                evidenceRevision: 2,
                currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
                currentPolicyEvaluationRevision: fixture.decisionId,
                evidenceSnapshotIds: [fixture.evidenceId],
                rationale: null,
                expectedResultingAssetId: null,
                expectedAssetOutcome: "none",
                expectedRepresentationOutcome: "none",
              },
            })
          })
        )
      )

      expect(result).toMatchObject({ _tag: "accepted" })
      const state = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const jobs = yield* db
              .select({
                id: schema.processingJobs.id,
                mode: schema.processingJobs.mode,
                status: schema.processingJobs.status,
                followUpMode: schema.processingJobs.followUpMode,
              })
              .from(schema.processingJobs)
              .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
            const work = yield* db
              .select({ processingJobId: schema.assetDecisionRematerializations.processingJobId })
              .from(schema.assetDecisionRematerializations)
            const calculationRuns = yield* db
              .select({ id: schema.calculationRuns.id })
              .from(schema.calculationRuns)
            return { calculationRuns, jobs, work }
          })
        )
      )

      // The not-yet-started replay already rebuilds this decision when it
      // runs, so it is reused directly instead of being marked for a
      // follow-up replay that would leave its rebuild rows unsettled.
      expect(state.jobs).toEqual([
        { id: pendingReplayJobId, mode: "replay", status: "pending", followUpMode: null },
      ])
      expect(state.work).toEqual([{ processingJobId: pendingReplayJobId }])
      expect(state.calculationRuns).toEqual([])
    })
  )

  it.effect("preserves the replay scheduling error operation", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException())
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.processingJobs).values({
              sourceId: TEST_SOURCE_ID,
              principalId: TEST_PRINCIPAL_ID,
              mode: "replay",
              status: "pending",
            })
            yield* db.execute(sql`
              create function fail_asset_exception_replay_update() returns trigger
              language plpgsql as $trigger$
              begin
                raise exception 'injected replay update failure';
              end
              $trigger$
            `)
            yield* db.execute(sql`
              create trigger fail_asset_exception_replay_update
              before update on processing_jobs
              for each row execute function fail_asset_exception_replay_update()
            `)
          })
        )
      )

      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.result(
            Effect.flatMap(AssetExceptionRepository, (repository) =>
              repository.submitDecision({
                actorId: TEST_USER_ID,
                input: {
                  providerAssetRowId: fixture.providerAssetRowId,
                  claim: { _tag: "exclusion", reason: "confirmed_spam" },
                  evidenceRevision: 2,
                  currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
                  currentPolicyEvaluationRevision: fixture.decisionId,
                  evidenceSnapshotIds: [fixture.evidenceId],
                  rationale: null,
                  expectedResultingAssetId: null,
                  expectedAssetOutcome: "none",
                  expectedRepresentationOutcome: "none",
                },
              })
            )
          )
        )
      )
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.execute(
              sql`drop trigger fail_asset_exception_replay_update on processing_jobs`
            )
            yield* db.execute(sql`drop function fail_asset_exception_replay_update()`)
          })
        )
      )

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { operation: "assetExceptionRepository.scheduleRematerialization" },
      })
    })
  )

  it.effect("still requires a rationale for an identity decision", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException())
      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            return yield* repository.previewDecision({
              providerAssetRowId: fixture.providerAssetRowId,
              claim: {
                _tag: "identity",
                assetId: null,
                newAsset: { name: "Exception Token", symbol: "EXC", type: "fungible" },
                representation: null,
              },
              evidenceRevision: 2,
              currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
              currentPolicyEvaluationRevision: fixture.decisionId,
              evidenceSnapshotIds: [fixture.evidenceId],
              rationale: null,
            })
          })
        )
      )

      expect(result).toEqual({ _tag: "invalid_evidence" })
    })
  )

  it.effect("serializes concurrent submissions and returns a typed stale revision", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException())
      const input = {
        providerAssetRowId: fixture.providerAssetRowId,
        claim: { _tag: "exclusion", reason: "provider_artifact" } as const,
        evidenceRevision: 2,
        currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
        currentPolicyEvaluationRevision: fixture.decisionId,
        evidenceSnapshotIds: [fixture.evidenceId],
        rationale: "The provider generated this observation as an internal artifact.",
        expectedResultingAssetId: null,
        expectedAssetOutcome: "none" as const,
        expectedRepresentationOutcome: "none" as const,
      }

      const submit = () =>
        runRepository(
          Effect.flatMap(AssetExceptionRepository, (repository) =>
            repository.submitDecision({ input, actorId: TEST_USER_ID })
          )
        )
      const results = yield* Effect.promise(() => Promise.all([submit(), submit()]))

      expect(results.map(({ _tag }) => _tag).sort()).toEqual(["accepted", "stale_revision"])
      expect(results.find(({ _tag }) => _tag === "stale_revision")).toMatchObject({
        _tag: "stale_revision",
        evidenceRevision: 2,
      })

      const counts = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const decisions = yield* db
              .select({ id: schema.assetResolutionDecisions.id })
              .from(schema.assetResolutionDecisions)
            const work = yield* db
              .select({ sourceId: schema.assetDecisionRematerializations.sourceId })
              .from(schema.assetDecisionRematerializations)
            return { decisions: decisions.length, work: work.length }
          })
        )
      )

      expect(counts).toEqual({ decisions: 2, work: 1 })
    })
  )

  it.effect("does not deadlock a submission against concurrent source-use recording", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException("-source-use-race"))
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .delete(schema.providerAssetSourceUses)
              .where(
                and(
                  eq(schema.providerAssetSourceUses.providerAssetRowId, fixture.providerAssetRowId),
                  eq(schema.providerAssetSourceUses.sourceId, TEST_SOURCE_ID)
                )
              )
            yield* db.insert(schema.providerAssetMappings).values({
              providerAssetRowId: fixture.providerAssetRowId,
              mappingKind: "asset",
              canonicalAssetId: null,
              assetRepresentationId: null,
              canonicalFiatCurrency: null,
              mappingStatus: "pending_review",
              reviewerNotes: null,
              sourceNotes: "Concurrent source-use fixture",
            })
          })
        )
      )

      const input = {
        providerAssetRowId: fixture.providerAssetRowId,
        claim: { _tag: "exclusion", reason: "provider_artifact" } as const,
        evidenceRevision: 2,
        currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
        currentPolicyEvaluationRevision: fixture.decisionId,
        evidenceSnapshotIds: [fixture.evidenceId],
        rationale: "The provider generated this observation as an internal artifact.",
        expectedResultingAssetId: null,
        expectedAssetOutcome: "none" as const,
        expectedRepresentationOutcome: "none" as const,
      }

      const [submitted, recorded] = yield* Effect.promise(() =>
        Promise.all([
          runRepository(
            Effect.flatMap(AssetExceptionRepository, (repository) =>
              repository.submitDecision({ input, actorId: TEST_USER_ID })
            )
          ),
          runProviderRepository(
            Effect.flatMap(ProviderAssetRepository, (repository) =>
              repository.recordProviderAssetSourceUses({
                sourceId: TEST_SOURCE_ID,
                providerAssetRowIds: [fixture.providerAssetRowId],
                observations: [],
              })
            )
          ),
        ])
      )

      expect(submitted).toMatchObject({ _tag: "accepted" })
      expect(recorded).toBe(1)
    })
  )

  it.effect("rejects confirmation when only the evidence revision changed", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException("-evidence-stale"))
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.assetResolutionCurrentState)
              .set({ currentConclusionId: null, currentPolicyEvaluationId: fixture.decisionId })
              .where(
                eq(
                  schema.assetResolutionCurrentState.providerAssetRowId,
                  fixture.providerAssetRowId
                )
              )
            yield* db
              .update(schema.providerAssets)
              .set({ evidenceRevision: 3 })
              .where(eq(schema.providerAssets.id, fixture.providerAssetRowId))
          })
        )
      )

      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(AssetExceptionRepository, (repository) =>
            repository.submitDecision({
              actorId: TEST_USER_ID,
              input: {
                providerAssetRowId: fixture.providerAssetRowId,
                claim: { _tag: "exclusion", reason: "provider_artifact" },
                evidenceRevision: 2,
                currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
                currentPolicyEvaluationRevision: fixture.decisionId,
                evidenceSnapshotIds: [fixture.evidenceId],
                rationale: null,
                expectedResultingAssetId: null,
                expectedAssetOutcome: "none",
                expectedRepresentationOutcome: "none",
              },
            })
          )
        )
      )

      expect(result).toEqual({
        _tag: "stale_revision",
        evidenceRevision: 3,
        currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
        currentPolicyEvaluationRevision: fixture.decisionId,
      })
      const writes = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const decisions = yield* db.select().from(schema.assetResolutionDecisions)
            const mappings = yield* db.select().from(schema.providerAssetMappings)
            const work = yield* db.select().from(schema.assetDecisionRematerializations)
            return { decisions: decisions.length, mappings: mappings.length, work: work.length }
          })
        )
      )
      expect(writes).toEqual({ decisions: 1, mappings: 0, work: 0 })
    })
  )

  it.effect("rejects confirmation when only the current policy evaluation changed", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException())
      const newerPolicyEvaluationId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [evaluation] = yield* db
              .insert(schema.assetResolutionDecisions)
              .values({
                providerAssetRowId: fixture.providerAssetRowId,
                evidenceRevision: 2,
                policyRevision: "test-policy.2",
                outcome: "fail_closed",
                reason: "ownership_conflict",
                actor: "policy:test-policy.2",
              })
              .returning({ id: schema.assetResolutionDecisions.id })
            if (evaluation === undefined) {
              return yield* Effect.die("Failed to seed replacement policy evaluation")
            }
            yield* db
              .update(schema.assetResolutionCurrentState)
              .set({ currentConclusionId: null, currentPolicyEvaluationId: evaluation.id })
              .where(
                eq(
                  schema.assetResolutionCurrentState.providerAssetRowId,
                  fixture.providerAssetRowId
                )
              )
            return evaluation.id
          })
        )
      )

      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            return yield* repository.submitDecision({
              input: {
                providerAssetRowId: fixture.providerAssetRowId,
                claim: { _tag: "exclusion", reason: "provider_artifact" },
                evidenceRevision: 2,
                currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
                currentPolicyEvaluationRevision: fixture.decisionId,
                evidenceSnapshotIds: [fixture.evidenceId],
                rationale: null,
                expectedResultingAssetId: null,
                expectedAssetOutcome: "none",
                expectedRepresentationOutcome: "none",
              },
              actorId: TEST_USER_ID,
            })
          })
        )
      )

      expect(result).toEqual({
        _tag: "stale_revision",
        evidenceRevision: 2,
        currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
        currentPolicyEvaluationRevision: newerPolicyEvaluationId,
      })
      const work = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db.select().from(schema.assetDecisionRematerializations)
          })
        )
      )
      expect(work).toEqual([])
    })
  )

  it.effect("rolls back every write when the final current-state compare-and-set misses", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException())
      const newerPolicyEvaluationId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [evaluation] = yield* db
              .insert(schema.assetResolutionDecisions)
              .values({
                providerAssetRowId: fixture.providerAssetRowId,
                evidenceRevision: 2,
                policyRevision: "test-policy.cas-race",
                outcome: "fail_closed",
                reason: "ownership_conflict",
                actor: "policy:test-policy.cas-race",
              })
              .returning({ id: schema.assetResolutionDecisions.id })
            if (evaluation === undefined) {
              return yield* Effect.die("Failed to seed competing policy evaluation")
            }
            yield* db
              .update(schema.assetResolutionCurrentState)
              .set({ currentConclusionId: null, currentPolicyEvaluationId: fixture.decisionId })
              .where(
                eq(
                  schema.assetResolutionCurrentState.providerAssetRowId,
                  fixture.providerAssetRowId
                )
              )
            return evaluation.id
          })
        )
      )
      const readWriteCounts = () =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const decisions = yield* db
              .select({ id: schema.assetResolutionDecisions.id })
              .from(schema.assetResolutionDecisions)
            const mappings = yield* db
              .select({ id: schema.providerAssetMappings.id })
              .from(schema.providerAssetMappings)
            const work = yield* db
              .select({ decisionId: schema.assetDecisionRematerializations.decisionId })
              .from(schema.assetDecisionRematerializations)
            return { decisions: decisions.length, mappings: mappings.length, work: work.length }
          })
        )
      const before = yield* Effect.promise(() => readWriteCounts())

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.execute(
              sql.raw(`
            create function advance_asset_policy_during_human_insert() returns trigger
            language plpgsql as $trigger$
            begin
              if new.human_claim is not null then
                update asset_resolution_current_state
                set current_policy_evaluation_id = '${newerPolicyEvaluationId}'::uuid
                where provider_asset_row_id = new.provider_asset_row_id;
              end if;
              return new;
            end
            $trigger$
          `)
            )
            yield* db.execute(sql`
          create trigger advance_asset_policy_during_human_insert
          after insert on asset_resolution_decisions
          for each row execute function advance_asset_policy_during_human_insert()
        `)
          })
        )
      )

      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(AssetExceptionRepository, (repository) =>
            repository.submitDecision({
              input: {
                providerAssetRowId: fixture.providerAssetRowId,
                claim: { _tag: "exclusion", reason: "provider_artifact" },
                evidenceRevision: 2,
                currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
                currentPolicyEvaluationRevision: fixture.decisionId,
                evidenceSnapshotIds: [fixture.evidenceId],
                rationale: null,
                expectedResultingAssetId: null,
                expectedAssetOutcome: "none",
                expectedRepresentationOutcome: "none",
              },
              actorId: TEST_USER_ID,
            })
          )
        )
      )
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.execute(
              sql`drop trigger advance_asset_policy_during_human_insert on asset_resolution_decisions`
            )
            yield* db.execute(sql`drop function advance_asset_policy_during_human_insert()`)
          })
        )
      )

      expect(result).toMatchObject({
        _tag: "stale_revision",
        currentPolicyEvaluationRevision: fixture.decisionId,
      })
      expect(yield* Effect.promise(() => readWriteCounts())).toEqual(before)
    })
  )

  it.effect("derives and persists a new canonical identity from a declarative claim", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException())
      const input = {
        providerAssetRowId: fixture.providerAssetRowId,
        claim: {
          _tag: "identity",
          assetId: null,
          newAsset: { name: "Exception Coin", symbol: "EXC", type: "fungible" },
          representation: null,
        } as const,
        evidenceRevision: 2,
        currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
        currentPolicyEvaluationRevision: fixture.decisionId,
        evidenceSnapshotIds: [fixture.evidenceId],
        rationale: "The provider evidence identifies this as a distinct fungible economic asset.",
        expectedResultingAssetId: null,
        expectedAssetOutcome: "create" as const,
        expectedRepresentationOutcome: "none" as const,
      }

      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            const preview = yield* repository.previewDecision(input)
            const submitted = yield* repository.submitDecision({ input, actorId: TEST_USER_ID })
            return { preview, submitted }
          })
        )
      )

      expect(result.preview).toMatchObject({
        _tag: "ready",
        preview: { assetOutcome: "create", representationOutcome: "none" },
      })
      expect(result.submitted).toMatchObject({
        _tag: "accepted",
        detail: { reviewStatus: "approved" },
      })

      const state = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const assets = yield* db
              .select({
                id: schema.assets.id,
                name: schema.assets.name,
                symbol: schema.assets.symbol,
              })
              .from(schema.assets)
              .where(eq(schema.assets.name, "Exception Coin"))
            const mappings = yield* db
              .select({
                assetId: schema.providerAssetMappings.canonicalAssetId,
                status: schema.providerAssetMappings.mappingStatus,
              })
              .from(schema.providerAssetMappings)
              .where(
                eq(schema.providerAssetMappings.providerAssetRowId, fixture.providerAssetRowId)
              )
            return { assets, mappings }
          })
        )
      )

      expect(state.assets).toEqual([
        expect.objectContaining({ name: "Exception Coin", symbol: "EXC" }),
      ])
      expect(state.mappings).toEqual([{ assetId: state.assets[0]?.id, status: "approved" }])
    })
  )

  it.effect("requires Helius identity claims to match the observed representation", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException())
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.providerAssets)
              .set({
                provider: "helius-solana",
                providerAssetId: "ObservedMint111",
                naturalKey: "solana:mint:ObservedMint111",
                providerType: "spl-token",
                exponent: 6,
              })
              .where(eq(schema.providerAssets.id, fixture.providerAssetRowId))
          })
        )
      )

      const preview = (
        representation: {
          readonly blockchain: string
          readonly type: "token"
          readonly contractAddress: null
          readonly mintAddress: string
          readonly decimals: number
        } | null
      ) =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            return yield* repository.previewDecision({
              providerAssetRowId: fixture.providerAssetRowId,
              claim: {
                _tag: "identity",
                assetId: null,
                newAsset: { name: "Observed Asset", symbol: "OBS", type: "fungible" },
                representation,
              },
              evidenceRevision: 2,
              currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
              currentPolicyEvaluationRevision: fixture.decisionId,
              evidenceSnapshotIds: [fixture.evidenceId],
              rationale: "The exact Solana representation is confirmed by stored evidence.",
            })
          })
        )

      yield* Effect.promise(() =>
        expect(preview(null)).resolves.toMatchObject({ _tag: "invalid_claim" })
      )
      yield* Effect.promise(() =>
        expect(
          preview({
            blockchain: "solana",
            type: "token",
            contractAddress: null,
            mintAddress: "DifferentMint222",
            decimals: 6,
          })
        ).resolves.toMatchObject({ _tag: "invalid_claim" })
      )
      yield* Effect.promise(() =>
        expect(
          preview({
            blockchain: "solana",
            type: "token",
            contractAddress: null,
            mintAddress: "ObservedMint111",
            decimals: 6,
          })
        ).resolves.toMatchObject({ _tag: "ready" })
      )

      // Older stored evidence can disagree with the latest provider metadata,
      // and replay validates every stored row against the approved mapping. A
      // claim that matches only the latest metadata must be rejected, or the
      // accepted decision would fail its rebuild every time.
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [solana] = yield* db
              .select({ id: schema.blockchains.id })
              .from(schema.blockchains)
              .where(eq(schema.blockchains.name, "solana"))
            if (solana === undefined) {
              return yield* Effect.die("Missing seeded solana blockchain")
            }
            yield* db
              .update(schema.providerTransfers)
              .set({
                observedBlockchainId: solana.id,
                observedRepresentationType: "token",
                observedMintAddress: "ObservedMint111",
                observedDecimals: 9,
              })
              .where(eq(schema.providerTransfers.providerAssetId, fixture.providerAssetRowId))
          })
        )
      )
      yield* Effect.promise(() =>
        expect(
          preview({
            blockchain: "solana",
            type: "token",
            contractAddress: null,
            mintAddress: "ObservedMint111",
            decimals: 6,
          })
        ).resolves.toMatchObject({ _tag: "invalid_claim" })
      )

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.providerTransfers)
              .set({ observedDecimals: 6 })
              .where(eq(schema.providerTransfers.providerAssetId, fixture.providerAssetRowId))
          })
        )
      )
      yield* Effect.promise(() =>
        expect(
          preview({
            blockchain: "solana",
            type: "token",
            contractAddress: null,
            mintAddress: "ObservedMint111",
            decimals: 6,
          })
        ).resolves.toMatchObject({ _tag: "ready" })
      )
    })
  )

  it.effect("rejects representations for chainless observations", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException())

      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            return yield* repository.previewDecision({
              providerAssetRowId: fixture.providerAssetRowId,
              claim: {
                _tag: "identity",
                assetId: null,
                newAsset: { name: "Chainless Asset", symbol: "CHA", type: "fungible" },
                representation: {
                  blockchain: "base",
                  type: "token",
                  contractAddress: "0x0000000000000000000000000000000000000001",
                  mintAddress: null,
                  decimals: 6,
                },
              },
              evidenceRevision: 2,
              currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
              currentPolicyEvaluationRevision: fixture.decisionId,
              evidenceSnapshotIds: [fixture.evidenceId],
              rationale:
                "A chainless provider observation cannot prove an on-chain representation.",
            })
          })
        )
      )

      expect(result).toMatchObject({ _tag: "invalid_claim" })
    })
  )

  it.effect("rejects chainless claims when a chain representation was observed", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException())
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [blockchain] = yield* db
              .select({ id: schema.blockchains.id })
              .from(schema.blockchains)
              .where(eq(schema.blockchains.name, "base"))
            if (blockchain === undefined) {
              return yield* Effect.die("Missing seeded base blockchain")
            }
            yield* db
              .update(schema.providerTransfers)
              .set({
                observedBlockchainId: blockchain.id,
                observedRepresentationType: "token",
                observedContractAddress: "0x-observed-chain-identity",
                observedDecimals: 6,
              })
              .where(eq(schema.providerTransfers.providerAssetId, fixture.providerAssetRowId))
          })
        )
      )

      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            return yield* repository.previewDecision({
              providerAssetRowId: fixture.providerAssetRowId,
              claim: {
                _tag: "identity",
                assetId: null,
                newAsset: { name: "Chainless Claim", symbol: "CHC", type: "fungible" },
                representation: null,
              },
              evidenceRevision: 2,
              currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
              currentPolicyEvaluationRevision: fixture.decisionId,
              evidenceSnapshotIds: [fixture.evidenceId],
              rationale: "An approved mapping without a representation cannot satisfy replay.",
            })
          })
        )
      )

      expect(result).toMatchObject({ _tag: "invalid_claim" })
    })
  )

  it.effect("rejects identity claims that match only part of the stored observations", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException())
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [blockchain] = yield* db
              .select({ id: schema.blockchains.id })
              .from(schema.blockchains)
              .where(eq(schema.blockchains.name, "base"))
            if (blockchain === undefined) {
              return yield* Effect.die("Missing seeded base blockchain")
            }
            yield* db
              .update(schema.providerTransfers)
              .set({
                observedBlockchainId: blockchain.id,
                observedRepresentationType: "token",
                observedContractAddress: "0x-partial-match",
                observedDecimals: 6,
              })
              .where(eq(schema.providerTransfers.providerAssetId, fixture.providerAssetRowId))
            const [transaction] = yield* db
              .select({ id: schema.transactions.id })
              .from(schema.transactions)
              .where(eq(schema.transactions.externalId, "exception-transaction"))
              .limit(1)
            if (transaction === undefined) {
              return yield* Effect.die("Missing seeded transaction")
            }
            // A second stored observation disagrees on decimals, so replay would
            // fail while re-validating it against the approved mapping.
            yield* db.insert(schema.providerTransfers).values({
              sourceId: TEST_SOURCE_ID,
              transactionId: transaction.id,
              externalId: "exception-transfer-conflicting",
              providerAssetId: fixture.providerAssetRowId,
              timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T01:00:00.000Z")),
              direction: "inbound",
              processingMode: "accounting_and_evidence",
              fromAccountRef: "coinbase:external",
              toAccountRef: "coinbase:user",
              amount: "5",
              observedBlockchainId: blockchain.id,
              observedRepresentationType: "token",
              observedContractAddress: "0x-partial-match",
              observedDecimals: 9,
            })
          })
        )
      )

      const preview = (decimals: number) =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            return yield* repository.previewDecision({
              providerAssetRowId: fixture.providerAssetRowId,
              claim: {
                _tag: "identity",
                assetId: null,
                newAsset: { name: "Partial Match Asset", symbol: "PMA", type: "fungible" },
                representation: {
                  blockchain: "base",
                  type: "token",
                  contractAddress: "0x-partial-match",
                  mintAddress: null,
                  decimals,
                },
              },
              evidenceRevision: 2,
              currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
              currentPolicyEvaluationRevision: fixture.decisionId,
              evidenceSnapshotIds: [fixture.evidenceId],
              rationale: "Every stored observation must stay compatible with the claim.",
            })
          })
        )

      yield* Effect.promise(() =>
        expect(preview(6)).resolves.toMatchObject({ _tag: "invalid_claim" })
      )

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.providerTransfers)
              .set({ observedDecimals: 6 })
              .where(eq(schema.providerTransfers.externalId, "exception-transfer-conflicting"))
          })
        )
      )
      yield* Effect.promise(() => expect(preview(6)).resolves.toMatchObject({ _tag: "ready" }))
    })
  )

  it.effect("rejects chainless identity claims incompatible with the provider asset type", () =>
    Effect.gen(function* () {
      const fiatFixture = yield* Effect.promise(() => seedException("-fiat-claim"))
      const nftFixture = yield* Effect.promise(() => seedException("-nft-claim"))
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.providerAssets)
              .set({ providerType: "fiat" })
              .where(eq(schema.providerAssets.id, fiatFixture.providerAssetRowId))
          })
        )
      )

      const results = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            const fiatAsAsset = yield* repository.previewDecision({
              providerAssetRowId: fiatFixture.providerAssetRowId,
              claim: {
                _tag: "identity",
                assetId: null,
                newAsset: { name: "Fiat as asset", symbol: "FIA", type: "fungible" },
                representation: null,
              },
              evidenceRevision: 2,
              currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
              currentPolicyEvaluationRevision: fiatFixture.decisionId,
              evidenceSnapshotIds: [fiatFixture.evidenceId],
              rationale: "A fiat observation must not become an economic asset mapping.",
            })
            const cryptoAsNft = yield* repository.previewDecision({
              providerAssetRowId: nftFixture.providerAssetRowId,
              claim: {
                _tag: "identity",
                assetId: null,
                newAsset: { name: "Crypto NFT", symbol: "CNF", type: "nft" },
                representation: null,
              },
              evidenceRevision: 2,
              currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
              currentPolicyEvaluationRevision: nftFixture.decisionId,
              evidenceSnapshotIds: [nftFixture.evidenceId],
              rationale: "A chainless crypto observation must remain fungible.",
            })
            return { fiatAsAsset, cryptoAsNft }
          })
        )
      )

      expect(results.fiatAsAsset).toMatchObject({ _tag: "invalid_claim" })
      expect(results.cryptoAsNft).toMatchObject({ _tag: "invalid_claim" })
    })
  )

  it.effect("rejects a representation incompatible with an existing asset type", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException())
      const assetId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [blockchain] = yield* db
              .select({ id: schema.blockchains.id })
              .from(schema.blockchains)
              .where(eq(schema.blockchains.name, "base"))
            const [asset] = yield* db
              .insert(schema.assets)
              .values({ name: "Fungible Target", symbol: "FUN", type: "fungible" })
              .returning({ id: schema.assets.id })
            if (asset === undefined || blockchain === undefined) {
              return yield* Effect.die("Failed to seed target asset")
            }
            yield* db
              .update(schema.providerTransfers)
              .set({
                observedBlockchainId: blockchain.id,
                observedRepresentationType: "nft",
                observedContractAddress: "0x-fungible-target",
                observedDecimals: 0,
              })
              .where(eq(schema.providerTransfers.providerAssetId, fixture.providerAssetRowId))
            return asset.id
          })
        )
      )

      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            return yield* repository.previewDecision({
              providerAssetRowId: fixture.providerAssetRowId,
              claim: {
                _tag: "identity",
                assetId,
                newAsset: null,
                representation: {
                  blockchain: "base",
                  type: "nft",
                  contractAddress: "0x-fungible-target",
                  mintAddress: null,
                  decimals: 0,
                },
              },
              evidenceRevision: 2,
              currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
              currentPolicyEvaluationRevision: fixture.decisionId,
              evidenceSnapshotIds: [fixture.evidenceId],
              rationale: "Attempt to attach an incompatible NFT representation.",
            })
          })
        )
      )

      expect(result).toMatchObject({ _tag: "ambiguous_identity" })
    })
  )

  it.effect("serializes shared representation corrections and preserves the prior owner", () =>
    Effect.gen(function* () {
      const secondUserId = "00000000-0000-4000-8000-000000000311"
      const secondPrincipalId = "00000000-0000-4000-8000-000000000312"
      const secondSourceId = "00000000-0000-4000-8000-000000000313"
      yield* Effect.promise(() =>
        runPg(
          seedSyncEngineRepositoryFixture({
            userId: secondUserId,
            principalId: secondPrincipalId,
            sourceId: secondSourceId,
          })
        )
      )
      const [first, second, lateApproval] = yield* Effect.promise(() =>
        Promise.all([
          seedException("-ownership-a"),
          seedException("-ownership-b", {
            sourceId: secondSourceId,
            principalId: secondPrincipalId,
          }),
          seedException("-ownership-late"),
        ])
      )
      const seeded = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [blockchain] = yield* db
              .select({ id: schema.blockchains.id })
              .from(schema.blockchains)
              .where(eq(schema.blockchains.name, "base"))
            const [oldAsset, replacementAsset] = yield* db
              .insert(schema.assets)
              .values([
                { name: "Old Owner", symbol: "OLD", type: "fungible" },
                { name: "Correct Owner", symbol: "RIGHT", type: "fungible" },
              ])
              .returning({ id: schema.assets.id, symbol: schema.assets.symbol })
            if (
              blockchain === undefined ||
              oldAsset === undefined ||
              replacementAsset === undefined
            ) {
              return yield* Effect.die("Failed to seed ownership correction assets")
            }
            const owner = oldAsset.symbol === "OLD" ? oldAsset : replacementAsset
            const replacement = oldAsset.symbol === "RIGHT" ? oldAsset : replacementAsset
            const [representation] = yield* db
              .insert(schema.assetRepresentations)
              .values({
                assetId: owner.id,
                blockchainId: blockchain.id,
                type: "token",
                contractAddress: "0xownership-correction",
                decimals: 6,
              })
              .returning({ id: schema.assetRepresentations.id })
            if (representation === undefined) {
              return yield* Effect.die("Failed to seed owned representation")
            }
            yield* db.insert(schema.providerAssetMappings).values(
              [first.providerAssetRowId, second.providerAssetRowId].map((providerAssetRowId) => ({
                providerAssetRowId,
                mappingKind: "asset" as const,
                canonicalAssetId: owner.id,
                assetRepresentationId: representation.id,
                mappingStatus: "approved" as const,
              }))
            )
            yield* db
              .update(schema.providerTransfers)
              .set({
                observedBlockchainId: blockchain.id,
                observedRepresentationType: "token",
                observedContractAddress: "0xownership-correction",
                observedDecimals: 6,
              })
              .where(
                inArray(schema.providerTransfers.providerAssetId, [
                  first.providerAssetRowId,
                  second.providerAssetRowId,
                ])
              )
            const [transaction] = yield* db
              .select({ id: schema.transactions.id })
              .from(schema.transactions)
              .where(eq(schema.transactions.externalId, "exception-transaction-ownership-a"))
            if (transaction === undefined) {
              return yield* Effect.die("Failed to load ownership correction transaction")
            }
            yield* db.insert(schema.transfers).values({
              sourceId: TEST_SOURCE_ID,
              principalId: TEST_PRINCIPAL_ID,
              externalId: "ownership-correction-transfer",
              timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:00:00.000Z")),
              type: "cex",
              fromAccountRef: "coinbase:external",
              toAccountRef: "coinbase:user",
              assetId: owner.id,
              assetRepresentationId: representation.id,
              amount: "10",
            })
            const [leg] = yield* db
              .insert(schema.transactionLegs)
              .values(
                yield* seedMovementLegs([
                  {
                    movementIdentity: {
                      sourceRecordKey: "ownership-correction-leg",
                      componentKey: "movement",
                    },
                    sourceId: TEST_SOURCE_ID,
                    principalId: TEST_PRINCIPAL_ID,
                    externalId: "ownership-correction-leg",
                    transactionId: transaction.id,
                    timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:00:00.000Z")),
                    assetId: owner.id,
                    assetRepresentationId: representation.id,
                    amount: "10",
                    kind: "acquisition",
                    provenance: "deterministic",
                    originKind: "none" as const,
                  },
                ])
              )
              .returning({ id: schema.transactionLegs.id })
            if (leg === undefined) {
              return yield* Effect.die("Failed to seed ownership correction leg")
            }
            yield* db.insert(schema.inventoryMovements).values({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_SOURCE_ID,
              transactionId: transaction.id,
              transactionLegId: leg.id,
              assetId: owner.id,
              assetRepresentationId: representation.id,
              timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T00:00:00.000Z")),
              direction: "inbound",
              purpose: "principal",
              taxTreatment: "taxable",
              reconciliationStatus: "unmatched",
              amount: "10",
            })
            return {
              oldAssetId: owner.id,
              replacementAssetId: replacement.id,
              representationId: representation.id,
            }
          })
        )
      )

      const input = {
        providerAssetRowId: first.providerAssetRowId,
        claim: {
          _tag: "identity",
          assetId: seeded.replacementAssetId,
          newAsset: null,
          representation: {
            blockchain: "base",
            type: "token",
            contractAddress: "0xownership-correction",
            mintAddress: null,
            decimals: 6,
          },
        } as const,
        evidenceRevision: 2,
        currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
        currentPolicyEvaluationRevision: first.decisionId,
        evidenceSnapshotIds: [first.evidenceId],
        rationale: "The representation belongs to the replacement economic asset.",
        expectedResultingAssetId: seeded.replacementAssetId,
        expectedAssetOutcome: "reuse" as const,
        expectedRepresentationOutcome: "reassign" as const,
      }
      const secondInput = {
        ...input,
        providerAssetRowId: second.providerAssetRowId,
        currentPolicyEvaluationRevision: second.decisionId,
        evidenceSnapshotIds: [second.evidenceId],
      }
      const initialPreview = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(AssetExceptionRepository, (repository) =>
            repository.previewDecision(input)
          )
        )
      )
      if (initialPreview._tag !== "ready") {
        throw new Error("Expected ownership correction preview")
      }
      const representationLocked = yield* Deferred.make<void>()
      const releaseApproval = yield* Deferred.make<void>()
      const approval = runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .select({ id: schema.assetRepresentations.id })
                .from(schema.assetRepresentations)
                .where(eq(schema.assetRepresentations.id, seeded.representationId))
                .for("share")
              yield* Deferred.succeed(representationLocked, undefined)
              yield* Deferred.await(releaseApproval)
              yield* tx.insert(schema.providerAssetMappings).values({
                providerAssetRowId: lateApproval.providerAssetRowId,
                mappingKind: "asset",
                canonicalAssetId: seeded.oldAssetId,
                assetRepresentationId: seeded.representationId,
                mappingStatus: "approved",
              })
            })
          )
        })
      )
      yield* Deferred.await(representationLocked)
      const racedSubmission = runRepository(
        Effect.flatMap(AssetExceptionRepository, (repository) =>
          repository.submitDecision({
            input: {
              ...input,
              expectedAffectedObservationRevisions:
                initialPreview.preview.affectedObservationRevisions,
            },
            actorId: TEST_USER_ID,
          })
        )
      )
      yield* Effect.promise(() =>
        context.waitForQueryBlockedOnLock({ queryIncludes: "asset_representations" })
      )
      yield* Deferred.succeed(releaseApproval, undefined)
      yield* Effect.promise(() => approval)
      expect(yield* Effect.promise(() => racedSubmission)).toEqual({ _tag: "identity_changed" })

      const previewBeforeRelatedChange = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(AssetExceptionRepository, (repository) =>
            repository.previewDecision(input)
          )
        )
      )
      if (previewBeforeRelatedChange._tag !== "ready") {
        throw new Error("Expected refreshed ownership correction preview")
      }

      const relatedPolicyEvaluationId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [policyEvaluation] = yield* db
              .insert(schema.assetResolutionDecisions)
              .values({
                providerAssetRowId: second.providerAssetRowId,
                evidenceRevision: 2,
                policyRevision: "test-policy.concurrent-related.1",
                outcome: "pending",
                reason: "display_collision",
                actor: "policy:test-policy.concurrent-related.1",
              })
              .returning({ id: schema.assetResolutionDecisions.id })
            if (policyEvaluation === undefined) {
              return yield* Effect.die("Failed to seed concurrent related policy evaluation")
            }
            yield* db
              .update(schema.assetResolutionCurrentState)
              .set({ currentPolicyEvaluationId: policyEvaluation.id })
              .where(
                eq(schema.assetResolutionCurrentState.providerAssetRowId, second.providerAssetRowId)
              )
            return policyEvaluation.id
          })
        )
      )
      const staleRelatedSubmission = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(AssetExceptionRepository, (repository) =>
            repository.submitDecision({
              input: {
                ...input,
                expectedAffectedObservationRevisions:
                  previewBeforeRelatedChange.preview.affectedObservationRevisions,
              },
              actorId: TEST_USER_ID,
            })
          )
        )
      )
      const stateAfterStaleRelatedSubmission = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [representation] = yield* db
              .select({ assetId: schema.assetRepresentations.assetId })
              .from(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.id, seeded.representationId))
            const ownership = yield* db
              .select({ id: schema.assetRepresentationOwnershipDecisions.id })
              .from(schema.assetRepresentationOwnershipDecisions)
              .where(
                eq(
                  schema.assetRepresentationOwnershipDecisions.assetRepresentationId,
                  seeded.representationId
                )
              )
            const rematerializations = yield* db
              .select({ decisionId: schema.assetDecisionRematerializations.decisionId })
              .from(schema.assetDecisionRematerializations)
            return { ownership, rematerializations, representation }
          })
        )
      )
      expect(staleRelatedSubmission).toMatchObject({ _tag: "stale_revision" })
      expect(stateAfterStaleRelatedSubmission.representation?.assetId).toBe(seeded.oldAssetId)
      expect(stateAfterStaleRelatedSubmission.ownership).toEqual([])
      expect(stateAfterStaleRelatedSubmission.rematerializations).toEqual([])

      const preview = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(AssetExceptionRepository, (repository) =>
            repository.previewDecision(input)
          )
        )
      )
      if (preview._tag !== "ready") {
        throw new Error("Expected ownership correction preview after related change")
      }
      const expectedAffectedObservationRevisions = preview.preview.affectedObservationRevisions
      const refreshedSecondInput = {
        ...secondInput,
        currentPolicyEvaluationRevision: relatedPolicyEvaluationId,
      }

      const submissions = yield* Effect.promise(() =>
        Promise.all(
          [input, refreshedSecondInput].map((candidate) =>
            runRepository(
              Effect.flatMap(AssetExceptionRepository, (repository) =>
                repository.submitDecision({
                  input: { ...candidate, expectedAffectedObservationRevisions },
                  actorId: TEST_USER_ID,
                })
              )
            )
          )
        )
      )

      expect(preview).toMatchObject({
        _tag: "ready",
        preview: {
          representationOutcome: "reassign",
          impact: {
            // These approved mappings need prospective replay after the
            // ownership correction, but they do not block current calculations.
            blockedReports: 0,
            affectedPrincipals: 2,
            affectedTransactions: 3,
            affectedSources: 2,
            affectedCalculations: 2,
          },
          rematerializationSourceCount: 2,
        },
      })
      expect(submissions.map(({ _tag }) => _tag).sort()).toEqual(["accepted", "stale_revision"])

      const persisted = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [representation] = yield* db
              .select({ assetId: schema.assetRepresentations.assetId })
              .from(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.id, seeded.representationId))
            const mappings = yield* db
              .select({ assetId: schema.providerAssetMappings.canonicalAssetId })
              .from(schema.providerAssetMappings)
              .where(
                inArray(schema.providerAssetMappings.providerAssetRowId, [
                  first.providerAssetRowId,
                  second.providerAssetRowId,
                  lateApproval.providerAssetRowId,
                ])
              )
            const ownership = yield* db
              .select({
                id: schema.assetRepresentationOwnershipDecisions.id,
                assetId: schema.assetRepresentationOwnershipDecisions.assetId,
                supersedesDecisionId:
                  schema.assetRepresentationOwnershipDecisions.supersedesDecisionId,
              })
              .from(schema.assetRepresentationOwnershipDecisions)
              .where(
                eq(
                  schema.assetRepresentationOwnershipDecisions.assetRepresentationId,
                  seeded.representationId
                )
              )
              .orderBy(asc(schema.assetRepresentationOwnershipDecisions.createdAt))
            const currentStates = yield* db
              .select({
                providerAssetRowId: schema.assetResolutionCurrentState.providerAssetRowId,
                currentConclusionId: schema.assetResolutionCurrentState.currentConclusionId,
              })
              .from(schema.assetResolutionCurrentState)
              .where(
                inArray(schema.assetResolutionCurrentState.providerAssetRowId, [
                  first.providerAssetRowId,
                  second.providerAssetRowId,
                  lateApproval.providerAssetRowId,
                ])
              )
            const work = yield* db
              .select({ decisionId: schema.assetDecisionRematerializations.decisionId })
              .from(schema.assetDecisionRematerializations)
            const dependentAssetIds = yield* Effect.all({
              inventoryMovements: db
                .select({ assetId: schema.inventoryMovements.assetId })
                .from(schema.inventoryMovements)
                .where(
                  eq(schema.inventoryMovements.assetRepresentationId, seeded.representationId)
                ),
              transactionLegs: db
                .select({ assetId: schema.transactionLegs.assetId })
                .from(schema.transactionLegs)
                .where(eq(schema.transactionLegs.assetRepresentationId, seeded.representationId)),
              transfers: db
                .select({ assetId: schema.transfers.assetId })
                .from(schema.transfers)
                .where(eq(schema.transfers.assetRepresentationId, seeded.representationId)),
            })
            return { representation, mappings, ownership, currentStates, work, dependentAssetIds }
          })
        )
      )

      expect(persisted.representation?.assetId).toBe(seeded.replacementAssetId)
      expect(persisted.mappings).toHaveLength(3)
      expect(persisted.mappings.every(({ assetId }) => assetId === seeded.replacementAssetId)).toBe(
        true
      )
      expect(persisted.ownership).toHaveLength(2)
      const ownershipRoot = persisted.ownership.find(
        ({ supersedesDecisionId }) => supersedesDecisionId === null
      )
      const ownershipCorrection = persisted.ownership.find(
        ({ supersedesDecisionId }) => supersedesDecisionId !== null
      )
      expect(ownershipRoot).toMatchObject({ assetId: seeded.oldAssetId })
      expect(ownershipCorrection).toMatchObject({ assetId: seeded.replacementAssetId })
      expect(ownershipCorrection?.supersedesDecisionId).toBe(ownershipRoot?.id)
      expect(persisted.currentStates).toHaveLength(3)
      expect(
        persisted.currentStates.every(({ currentConclusionId }) => currentConclusionId !== null)
      ).toBe(true)
      expect(persisted.work).toHaveLength(6)
      expect(persisted.dependentAssetIds).toEqual({
        inventoryMovements: [{ assetId: seeded.replacementAssetId }],
        transactionLegs: [{ assetId: seeded.replacementAssetId }],
        transfers: [{ assetId: seeded.replacementAssetId }],
      })

      const focalDecisionId = persisted.currentStates.find(
        ({ providerAssetRowId }) => providerAssetRowId === first.providerAssetRowId
      )?.currentConclusionId
      if (focalDecisionId === null || focalDecisionId === undefined) {
        throw new Error("Expected the focal current conclusion")
      }
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.assetDecisionRematerializations)
              .set({
                status: "operator_attention",
                failureCode: "related_source_failed",
                lastFailureAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-26T12:00:00.000Z")),
              })
              .where(
                and(
                  eq(schema.assetDecisionRematerializations.decisionId, focalDecisionId),
                  eq(schema.assetDecisionRematerializations.sourceId, secondSourceId)
                )
              )
          })
        )
      )
      const detailWithRelatedFailure = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(AssetExceptionRepository, (repository) =>
            repository.findDetail({
              _tag: "row_id",
              providerAssetRowId: first.providerAssetRowId,
            })
          )
        )
      )
      expect(Option.getOrNull(detailWithRelatedFailure)?.rematerialization).toMatchObject({
        status: "operator_attention",
        affectedSourceCount: 2,
        pendingSourceCount: 1,
        runningSourceCount: 0,
        completedSourceCount: 0,
        failedSourceCount: 1,
        retryingSourceCount: 0,
        remainingSourceCount: 2,
        failureCode: "related_source_failed",
      })

      for (const assetId of [seeded.oldAssetId, seeded.replacementAssetId]) {
        const latest = yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(AssetExceptionRepository, (repository) =>
              repository.findDetail({
                _tag: "row_id",
                providerAssetRowId: first.providerAssetRowId,
              })
            )
          )
        )
        const detail = Option.getOrNull(latest)
        if (detail === null) {
          throw new Error("Expected ownership correction detail")
        }
        const correction = {
          ...input,
          claim: { ...input.claim, assetId },
          currentConclusionRevision: detail.currentConclusionRevision,
          currentPolicyEvaluationRevision: detail.currentPolicyEvaluationRevision,
          expectedResultingAssetId: assetId,
        }
        const correctionResult = yield* Effect.promise(() =>
          runRepository(
            Effect.gen(function* () {
              const repository = yield* AssetExceptionRepository
              const preview = yield* repository.previewDecision(correction)
              if (preview._tag !== "ready") {
                return { preview, submitted: preview }
              }
              const submitted = yield* repository.submitDecision({
                input: {
                  ...correction,
                  expectedAffectedObservationRevisions:
                    preview.preview.affectedObservationRevisions,
                },
                actorId: TEST_USER_ID,
              })
              return { preview, submitted }
            })
          )
        )
        expect(correctionResult.preview).toMatchObject({
          _tag: "ready",
          preview: { representationOutcome: "reassign" },
        })
        expect(correctionResult.submitted).toMatchObject({ _tag: "accepted" })
      }

      const ownershipChain = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                id: schema.assetRepresentationOwnershipDecisions.id,
                assetId: schema.assetRepresentationOwnershipDecisions.assetId,
                supersedesDecisionId:
                  schema.assetRepresentationOwnershipDecisions.supersedesDecisionId,
              })
              .from(schema.assetRepresentationOwnershipDecisions)
              .where(
                eq(
                  schema.assetRepresentationOwnershipDecisions.assetRepresentationId,
                  seeded.representationId
                )
              )
          })
        )
      )
      const supersededIds = new Set(
        ownershipChain.flatMap(({ supersedesDecisionId }) =>
          supersedesDecisionId === null ? [] : [supersedesDecisionId]
        )
      )
      const tips = ownershipChain.filter(({ id }) => !supersededIds.has(id))
      expect(ownershipChain).toHaveLength(4)
      expect(tips).toEqual([expect.objectContaining({ assetId: seeded.replacementAssetId })])
    })
  )

  it.effect("keeps an active human decision visible after the evidence revision advances", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException())
      const humanDecisionId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [humanDecision] = yield* db
              .insert(schema.assetResolutionDecisions)
              .values({
                providerAssetRowId: fixture.providerAssetRowId,
                evidenceRevision: 2,
                policyRevision: "human-test.1",
                outcome: "excluded",
                supersedesDecisionId: fixture.decisionId,
                reason: "confirmed_spam",
                humanClaim: { _tag: "exclusion", reason: "confirmed_spam" },
                rationale: "Human evidence settles the observation.",
                actor: TEST_USER_ID,
              })
              .returning({ id: schema.assetResolutionDecisions.id })
            if (humanDecision === undefined) {
              return yield* Effect.die("Failed to seed human decision")
            }
            yield* db.insert(schema.assetResolutionDecisionEvidenceLinks).values({
              decisionId: humanDecision.id,
              evidenceId: fixture.evidenceId,
            })
            yield* db
              .update(schema.assetResolutionCurrentState)
              .set({ currentConclusionId: humanDecision.id, currentPolicyEvaluationId: null })
              .where(
                eq(
                  schema.assetResolutionCurrentState.providerAssetRowId,
                  fixture.providerAssetRowId
                )
              )

            yield* db
              .update(schema.providerAssets)
              .set({ evidenceRevision: 3 })
              .where(eq(schema.providerAssets.id, fixture.providerAssetRowId))
            return humanDecision.id
          })
        )
      )

      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            const found = yield* repository.findDetail({
              _tag: "row_id",
              providerAssetRowId: fixture.providerAssetRowId,
            })
            if (Option.isNone(found)) {
              return yield* Effect.die("Expected exception detail")
            }
            const preview = yield* repository.previewDecision({
              providerAssetRowId: fixture.providerAssetRowId,
              claim: { _tag: "exclusion", reason: "provider_artifact" },
              evidenceRevision: 3,
              currentConclusionRevision: humanDecisionId,
              currentPolicyEvaluationRevision: NO_CURRENT_ASSET_POLICY_EVALUATION,
              evidenceSnapshotIds: [fixture.evidenceId],
              rationale: "The active settled evidence remains available for supersession.",
            })
            return { detail: found.value, preview }
          })
        )
      )

      expect(result.detail).toMatchObject({
        reviewStatus: "excluded",
        currentConclusionRevision: humanDecisionId,
        currentPolicyEvaluationRevision: NO_CURRENT_ASSET_POLICY_EVALUATION,
        currentConclusion: { id: humanDecisionId, evidenceRevision: 2 },
        currentPolicyEvaluation: null,
        evidence: [expect.objectContaining({ id: fixture.evidenceId, evidenceRevision: 2 })],
      })
      expect(result.preview).toMatchObject({ _tag: "ready" })
    })
  )

  it.effect(
    "supersedes the current conclusion while preserving the current policy evaluation",
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() => seedException())
        const seeded = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const [humanDecision] = yield* db
                .insert(schema.assetResolutionDecisions)
                .values({
                  providerAssetRowId: fixture.providerAssetRowId,
                  evidenceRevision: 2,
                  policyRevision: "human-test.1",
                  outcome: "excluded",
                  supersedesDecisionId: fixture.decisionId,
                  reason: "confirmed_spam",
                  humanClaim: { _tag: "exclusion", reason: "confirmed_spam" },
                  rationale: "Human evidence settles the observation.",
                  actor: TEST_USER_ID,
                })
                .returning({ id: schema.assetResolutionDecisions.id })
              if (humanDecision === undefined) {
                return yield* Effect.die("Failed to seed human decision")
              }
              yield* db.insert(schema.assetResolutionDecisionEvidenceLinks).values({
                decisionId: humanDecision.id,
                evidenceId: fixture.evidenceId,
              })
              yield* db
                .update(schema.providerAssets)
                .set({ evidenceRevision: 3 })
                .where(eq(schema.providerAssets.id, fixture.providerAssetRowId))
              yield* db
                .update(schema.assetResolutionJobs)
                .set({ evidenceRevision: 3 })
                .where(
                  eq(schema.assetResolutionJobs.providerAssetRowId, fixture.providerAssetRowId)
                )
              // New evidence reopens review with an active policy evaluation at
              // revision 3 while the human conclusion stays active at revision 2.
              // A single administrator superseding their own conclusion must not
              // collide with the policy row in the active-per-revision slot.
              const [policyRecheck] = yield* db
                .insert(schema.assetResolutionDecisions)
                .values({
                  providerAssetRowId: fixture.providerAssetRowId,
                  evidenceRevision: 3,
                  policyRevision: "test-policy.2",
                  outcome: "pending",
                  reason: "display_collision",
                  actor: "policy:test-policy.2",
                })
                .returning({ id: schema.assetResolutionDecisions.id })
              if (policyRecheck === undefined) {
                return yield* Effect.die("Failed to seed policy re-check decision")
              }
              yield* db
                .insert(schema.assetResolutionCurrentState)
                .values({
                  providerAssetRowId: fixture.providerAssetRowId,
                  currentConclusionId: humanDecision.id,
                  currentPolicyEvaluationId: policyRecheck.id,
                })
                .onConflictDoUpdate({
                  target: schema.assetResolutionCurrentState.providerAssetRowId,
                  set: {
                    currentConclusionId: humanDecision.id,
                    currentPolicyEvaluationId: policyRecheck.id,
                  },
                })
              return { humanDecisionId: humanDecision.id, policyRecheckId: policyRecheck.id }
            })
          )
        )

        const review = yield* Effect.promise(() =>
          runRepository(
            Effect.gen(function* () {
              const repository = yield* AssetExceptionRepository
              const queue = yield* repository.listExceptions({
                cursor: null,
                limit: 10,
                query: null,
              })
              const detail = yield* repository.findDetail({
                _tag: "row_id",
                providerAssetRowId: fixture.providerAssetRowId,
              })
              const preview = yield* repository.previewDecision({
                providerAssetRowId: fixture.providerAssetRowId,
                claim: { _tag: "exclusion", reason: "provider_artifact" },
                evidenceRevision: 3,
                currentConclusionRevision: seeded.humanDecisionId,
                currentPolicyEvaluationRevision: seeded.policyRecheckId,
                evidenceSnapshotIds: [fixture.evidenceId],
                rationale: null,
              })
              return { detail, preview, queue }
            })
          )
        )
        expect(review.queue).toEqual([
          expect.objectContaining({
            providerAssetRowId: fixture.providerAssetRowId,
            currentConclusionRevision: seeded.humanDecisionId,
            currentPolicyEvaluationRevision: seeded.policyRecheckId,
          }),
        ])
        expect(Option.getOrNull(review.detail)).toMatchObject({
          reviewStatus: "unresolved",
          currentConclusion: { id: seeded.humanDecisionId, evidenceRevision: 2 },
          currentPolicyEvaluation: { id: seeded.policyRecheckId, evidenceRevision: 3 },
        })
        expect(review.preview).toMatchObject({
          _tag: "ready",
          preview: {
            supersededConclusion: { id: seeded.humanDecisionId },
            currentConclusionRevision: seeded.humanDecisionId,
            currentPolicyEvaluationRevision: seeded.policyRecheckId,
          },
        })

        const submit = () =>
          runRepository(
            Effect.flatMap(AssetExceptionRepository, (repository) =>
              repository.submitDecision({
                input: {
                  providerAssetRowId: fixture.providerAssetRowId,
                  claim: { _tag: "exclusion", reason: "provider_artifact" },
                  evidenceRevision: 3,
                  currentConclusionRevision: seeded.humanDecisionId,
                  currentPolicyEvaluationRevision: seeded.policyRecheckId,
                  evidenceSnapshotIds: [fixture.evidenceId],
                  rationale: null,
                  expectedResultingAssetId: null,
                  expectedAssetOutcome: "none",
                  expectedRepresentationOutcome: "none",
                },
                actorId: TEST_USER_ID,
              })
            )
          )
        const results = yield* Effect.promise(() => Promise.all([submit(), submit()]))
        expect(results.map(({ _tag }) => _tag).sort()).toEqual(["accepted", "stale_revision"])
        const result = results.find(({ _tag }) => _tag === "accepted")
        if (result === undefined || result._tag !== "accepted") {
          throw new Error("Expected one accepted current conclusion")
        }
        const persisted = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const decisions = yield* db
                .select({
                  id: schema.assetResolutionDecisions.id,
                  outcome: schema.assetResolutionDecisions.outcome,
                  evidenceRevision: schema.assetResolutionDecisions.evidenceRevision,
                })
                .from(schema.assetResolutionDecisions)
                .where(
                  eq(schema.assetResolutionDecisions.providerAssetRowId, fixture.providerAssetRowId)
                )
              const [current] = yield* db
                .select({
                  currentConclusionId: schema.assetResolutionCurrentState.currentConclusionId,
                  currentPolicyEvaluationId:
                    schema.assetResolutionCurrentState.currentPolicyEvaluationId,
                })
                .from(schema.assetResolutionCurrentState)
                .where(
                  eq(
                    schema.assetResolutionCurrentState.providerAssetRowId,
                    fixture.providerAssetRowId
                  )
                )
              const mappings = yield* db
                .select({ id: schema.providerAssetMappings.providerAssetRowId })
                .from(schema.providerAssetMappings)
                .where(
                  eq(schema.providerAssetMappings.providerAssetRowId, fixture.providerAssetRowId)
                )
              const rematerializations = yield* db
                .select({ sourceId: schema.assetDecisionRematerializations.sourceId })
                .from(schema.assetDecisionRematerializations)
                .innerJoin(
                  schema.assetResolutionDecisions,
                  eq(
                    schema.assetResolutionDecisions.id,
                    schema.assetDecisionRematerializations.decisionId
                  )
                )
                .where(
                  eq(schema.assetResolutionDecisions.providerAssetRowId, fixture.providerAssetRowId)
                )
              return { current, decisions, mappings, rematerializations }
            })
          )
        )
        if (result.detail.currentConclusion === null) {
          throw new Error("Expected an accepted current conclusion")
        }
        expect(persisted.decisions).toHaveLength(4)
        expect(persisted.mappings).toHaveLength(1)
        expect(persisted.rematerializations).toHaveLength(1)
        expect(persisted.current).toEqual({
          currentConclusionId: result.detail.currentConclusion.id,
          currentPolicyEvaluationId: seeded.policyRecheckId,
        })
        expect(
          persisted.decisions.find((decision) => decision.id === seeded.humanDecisionId)
        ).toBeDefined()
        expect(
          persisted.decisions.find((decision) => decision.id === seeded.policyRecheckId)
        ).toBeDefined()
        expect(result).toMatchObject({
          _tag: "accepted",
          detail: {
            currentConclusion: {
              supersedesConclusionId: seeded.humanDecisionId,
              evidenceRevision: 3,
            },
            currentPolicyEvaluation: {
              id: seeded.policyRecheckId,
              outcome: "pending",
              evidenceRevision: 3,
            },
          },
        })
        const settledQueue = yield* Effect.promise(() =>
          runRepository(
            Effect.flatMap(AssetExceptionRepository, (repository) =>
              repository.listExceptions({ cursor: null, limit: 10, query: null })
            )
          )
        )
        expect(settledQueue).toEqual([])
      })
  )

  it.effect("treats a display match for a new asset as an explicit identity conflict", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException())
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .insert(schema.assets)
              .values({ name: "Duplicate Display", symbol: "DUP", type: "fungible" })
          })
        )
      )

      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            return yield* repository.previewDecision({
              providerAssetRowId: fixture.providerAssetRowId,
              claim: {
                _tag: "identity",
                assetId: null,
                newAsset: { name: "duplicate display", symbol: "dup", type: "fungible" },
                representation: null,
              },
              evidenceRevision: 2,
              currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
              currentPolicyEvaluationRevision: fixture.decisionId,
              evidenceSnapshotIds: [fixture.evidenceId],
              rationale: "Display fields alone cannot prove economic identity.",
            })
          })
        )
      )

      expect(result).toMatchObject({ _tag: "ambiguous_identity" })
    })
  )

  it.effect("treats an NFKC lookalike display for a new asset as an identity conflict", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException())
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .insert(schema.assets)
              .values({ name: "Duplicate Display", symbol: "DUP", type: "fungible" })
          })
        )
      )

      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            return yield* repository.previewDecision({
              providerAssetRowId: fixture.providerAssetRowId,
              claim: {
                _tag: "identity",
                assetId: null,
                // Full-width characters NFKC-fold to the existing display text.
                newAsset: {
                  name: "Ｄｕｐｌｉｃａｔｅ Ｄｉｓｐｌａｙ",
                  symbol: "ＤＵＰ",
                  type: "fungible",
                },
                representation: null,
              },
              evidenceRevision: 2,
              currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
              currentPolicyEvaluationRevision: fixture.decisionId,
              evidenceSnapshotIds: [fixture.evidenceId],
              rationale: "Lookalike display text must collide with the existing asset.",
            })
          })
        )
      )

      expect(result).toMatchObject({ _tag: "ambiguous_identity" })
    })
  )

  it.effect("treats a reused name or symbol as an identity conflict for a new asset", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException())
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .insert(schema.assets)
              .values({ name: "Duplicate Display", symbol: "DUP", type: "fungible" })
          })
        )
      )

      const preview = (newAsset: { readonly name: string; readonly symbol: string }) =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            return yield* repository.previewDecision({
              providerAssetRowId: fixture.providerAssetRowId,
              claim: {
                _tag: "identity",
                assetId: null,
                newAsset: { ...newAsset, type: "fungible" },
                representation: null,
              },
              evidenceRevision: 2,
              currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
              currentPolicyEvaluationRevision: fixture.decisionId,
              evidenceSnapshotIds: [fixture.evidenceId],
              rationale: "Either display value colliding must block the duplicate.",
            })
          })
        )

      // The automatic resolver's duplicate brake treats any name-or-symbol
      // cross-match as a collision; the human path must match it.
      yield* Effect.promise(() =>
        expect(preview({ name: "Duplicate Display", symbol: "OTHER" })).resolves.toMatchObject({
          _tag: "ambiguous_identity",
        })
      )
      yield* Effect.promise(() =>
        expect(preview({ name: "Something Else", symbol: "DUP" })).resolves.toMatchObject({
          _tag: "ambiguous_identity",
        })
      )
      yield* Effect.promise(() =>
        expect(
          preview({ name: "Fresh Asset", symbol: "DUPLICATE DISPLAY" })
        ).resolves.toMatchObject({
          _tag: "ambiguous_identity",
        })
      )
    })
  )

  it.effect("treats an already-owned representation as a conflict for a new-asset claim", () =>
    Effect.gen(function* () {
      const [first, second] = yield* Effect.promise(() =>
        Promise.all([seedException("-owned-a"), seedException("-owned-b")])
      )
      const sharedAddress = "0x-owned-representation"

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [blockchain] = yield* db
              .select({ id: schema.blockchains.id })
              .from(schema.blockchains)
              .where(eq(schema.blockchains.name, "base"))
            if (blockchain === undefined) {
              return yield* Effect.die("Failed to seed Base blockchain observation")
            }
            yield* Effect.all([
              db
                .update(schema.providerTransfers)
                .set({
                  observedBlockchainId: blockchain.id,
                  observedRepresentationType: "token",
                  observedContractAddress: sharedAddress,
                  observedDecimals: 6,
                })
                .where(eq(schema.providerTransfers.providerAssetId, first.providerAssetRowId)),
              db
                .update(schema.providerTransfers)
                .set({
                  observedBlockchainId: blockchain.id,
                  observedRepresentationType: "token",
                  observedContractAddress: sharedAddress,
                  observedDecimals: 6,
                })
                .where(eq(schema.providerTransfers.providerAssetId, second.providerAssetRowId)),
            ])
          })
        )
      )

      const firstInput = {
        providerAssetRowId: first.providerAssetRowId,
        claim: {
          _tag: "identity",
          assetId: null,
          newAsset: { name: "Owned Token", symbol: "OWN", type: "fungible" },
          representation: {
            blockchain: "base",
            type: "token",
            contractAddress: sharedAddress,
            mintAddress: null,
            decimals: 6,
          },
        } as const,
        evidenceRevision: 2,
        currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
        currentPolicyEvaluationRevision: first.decisionId,
        evidenceSnapshotIds: [first.evidenceId],
        rationale: "The first observation creates the economic asset.",
        expectedResultingAssetId: null,
        expectedAssetOutcome: "create" as const,
        expectedRepresentationOutcome: "create" as const,
      }

      const firstSubmitted = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            return yield* repository.submitDecision({ input: firstInput, actorId: TEST_USER_ID })
          })
        )
      )
      expect(firstSubmitted).toMatchObject({ _tag: "accepted" })

      // A different display name, so only the owned representation can raise
      // the conflict; the claim must not be rewritten into a silent reuse.
      const secondInput = {
        providerAssetRowId: second.providerAssetRowId,
        claim: {
          ...firstInput.claim,
          newAsset: { name: "Other Owned Token", symbol: "OWN2", type: "fungible" },
        } as const,
        evidenceRevision: 2,
        currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
        currentPolicyEvaluationRevision: second.decisionId,
        evidenceSnapshotIds: [second.evidenceId],
        rationale: "The representation already belongs to the first asset.",
        expectedResultingAssetId: null,
        expectedAssetOutcome: "create" as const,
        expectedRepresentationOutcome: "create" as const,
      }

      const secondResults = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            const preview = yield* repository.previewDecision(secondInput)
            const submitted = yield* repository.submitDecision({
              input: secondInput,
              actorId: TEST_USER_ID,
            })
            return { preview, submitted }
          })
        )
      )

      expect(secondResults.preview).toMatchObject({ _tag: "ambiguous_identity" })
      expect(secondResults.submitted).toMatchObject({ _tag: "ambiguous_identity" })
    })
  )

  it.effect("reports directly owned evidence in the decision history", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException())

      const detail = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            const found = yield* repository.findDetail({
              _tag: "row_id",
              providerAssetRowId: fixture.providerAssetRowId,
            })
            if (Option.isNone(found)) {
              return yield* Effect.die("Expected exception detail")
            }
            return found.value
          })
        )
      )

      // The policy decision stores its evidence directly through
      // asset_resolution_evidence.decision_id without link rows; history must
      // still report it.
      const policyDecision = detail.decisionHistory.find(
        (decision) => decision.id === fixture.decisionId
      )
      expect(policyDecision?.evidenceSnapshotIds).toEqual([fixture.evidenceId])
    })
  )

  it.effect("counts transactions blocked through source-only uses in the impact", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException())
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            // A Coinbase buy blocked by an unresolved currency persists with no
            // provider transfer; only the transaction-level use records it.
            const [tradeTransaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: TEST_SOURCE_ID,
                principalId: TEST_PRINCIPAL_ID,
                externalId: "exception-trade-without-transfer",
                timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-03T00:00:00.000Z")),
                metadata: {
                  provider: "coinbase",
                  nativeAmount: { amount: "500.25", currency: "EUR" },
                },
                providerFiatAmount: "500.25",
                providerFiatCurrency: "EUR",
              })
              .returning({ id: schema.transactions.id })
            if (tradeTransaction === undefined) {
              return yield* Effect.die("Failed to seed trade transaction")
            }
            yield* db.insert(schema.providerAssetTransactionUses).values({
              providerAssetRowId: fixture.providerAssetRowId,
              transactionId: tradeTransaction.id,
              sourceId: TEST_SOURCE_ID,
            })
          })
        )
      )

      const detail = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            const found = yield* repository.findDetail({
              _tag: "row_id",
              providerAssetRowId: fixture.providerAssetRowId,
            })
            if (Option.isNone(found)) {
              return yield* Effect.die("Expected exception detail")
            }
            return found.value
          })
        )
      )

      expect(detail.impact).toMatchObject({
        affectedTransactions: 2,
        affectedTransactionValueEur: "1750.75",
      })
    })
  )

  it.effect("serializes conflicting claims for the same representation identity", () =>
    Effect.gen(function* () {
      const [first, second] = yield* Effect.promise(() =>
        Promise.all([seedException("-lock-a"), seedException("-lock-b")])
      )
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [blockchain] = yield* db
              .select({ id: schema.blockchains.id })
              .from(schema.blockchains)
              .where(eq(schema.blockchains.name, "base"))
            if (blockchain === undefined) {
              return yield* Effect.die("Failed to seed Base blockchain")
            }
            yield* Effect.all([
              db
                .update(schema.providerTransfers)
                .set({
                  observedBlockchainId: blockchain.id,
                  observedRepresentationType: "token",
                  observedContractAddress: "0x-shared-representation",
                  observedDecimals: 6,
                })
                .where(eq(schema.providerTransfers.providerAssetId, first.providerAssetRowId)),
              db
                .update(schema.providerTransfers)
                .set({
                  observedBlockchainId: blockchain.id,
                  observedRepresentationType: "nft",
                  observedContractAddress: "0x-shared-representation",
                  observedDecimals: 0,
                })
                .where(eq(schema.providerTransfers.providerAssetId, second.providerAssetRowId)),
            ])
          })
        )
      )
      const submit = ({
        fixture,
        type,
        decimals,
      }: {
        readonly fixture: Awaited<ReturnType<typeof seedException>>
        readonly type: "token" | "nft"
        readonly decimals: number
      }) =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            return yield* repository.submitDecision({
              actorId: TEST_USER_ID,
              input: {
                providerAssetRowId: fixture.providerAssetRowId,
                claim: {
                  _tag: "identity",
                  assetId: null,
                  newAsset: {
                    name: `Representation ${type}`,
                    symbol: type === "token" ? "RPT" : "RPN",
                    type: type === "nft" ? "nft" : "fungible",
                  },
                  representation: {
                    blockchain: "base",
                    type,
                    contractAddress: "0x-shared-representation",
                    mintAddress: null,
                    decimals,
                  },
                },
                evidenceRevision: 2,
                currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
                currentPolicyEvaluationRevision: fixture.decisionId,
                evidenceSnapshotIds: [fixture.evidenceId],
                rationale: "Concurrent claim for one representation identity.",
                expectedResultingAssetId: null,
                expectedAssetOutcome: "create",
                expectedRepresentationOutcome: "create",
              },
            })
          })
        )

      const results = yield* Effect.promise(() =>
        Promise.all([
          submit({ fixture: first, type: "token", decimals: 6 }),
          submit({ fixture: second, type: "nft", decimals: 0 }),
        ])
      )

      expect(results.map((result) => result._tag).sort()).toEqual([
        "accepted",
        "ambiguous_identity",
      ])
    })
  )

  it.effect("normalizes EVM contract identities before previewing and persisting them", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException("-evm-case"))
      const mixedCaseAddress = "0xAbCdEf0000000000000000000000000000001234"
      const alternateCaseAddress = "0xABCDEF0000000000000000000000000000001234"
      const normalizedAddress = mixedCaseAddress.toLowerCase()

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [blockchain] = yield* db
              .select({ id: schema.blockchains.id })
              .from(schema.blockchains)
              .where(eq(schema.blockchains.name, "base"))
            if (blockchain === undefined) {
              return yield* Effect.die("Failed to seed Base blockchain observation")
            }
            yield* db
              .update(schema.providerTransfers)
              .set({
                observedBlockchainId: blockchain.id,
                observedRepresentationType: "token",
                observedContractAddress: mixedCaseAddress,
                observedDecimals: 6,
              })
              .where(eq(schema.providerTransfers.providerAssetId, fixture.providerAssetRowId))
          })
        )
      )

      const firstInput = {
        providerAssetRowId: fixture.providerAssetRowId,
        claim: {
          _tag: "identity",
          assetId: null,
          newAsset: { name: "Case Token", symbol: "CASE", type: "fungible" },
          representation: {
            blockchain: "base",
            type: "token",
            contractAddress: mixedCaseAddress,
            mintAddress: null,
            decimals: 6,
          },
        } as const,
        evidenceRevision: 2,
        currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
        currentPolicyEvaluationRevision: fixture.decisionId,
        evidenceSnapshotIds: [fixture.evidenceId],
        rationale: "The observed Base contract identifies this economic asset.",
        expectedResultingAssetId: null,
        expectedAssetOutcome: "create" as const,
        expectedRepresentationOutcome: "create" as const,
      }

      const first = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            const preview = yield* repository.previewDecision(firstInput)
            const submitted = yield* repository.submitDecision({
              input: firstInput,
              actorId: TEST_USER_ID,
            })
            return { preview, submitted }
          })
        )
      )

      expect(first.preview).toMatchObject({
        _tag: "ready",
        preview: { assetOutcome: "create", representationOutcome: "create" },
      })
      expect(first.submitted).toMatchObject({ _tag: "accepted" })

      const created = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [asset] = yield* db
              .select({ id: schema.assets.id })
              .from(schema.assets)
              .where(eq(schema.assets.name, "Case Token"))
            const [decision] = yield* db
              .select({ id: schema.assetResolutionCurrentState.currentConclusionId })
              .from(schema.assetResolutionCurrentState)
              .where(
                eq(
                  schema.assetResolutionCurrentState.providerAssetRowId,
                  fixture.providerAssetRowId
                )
              )
            if (asset === undefined || decision === undefined || decision.id === null) {
              return yield* Effect.die("Failed to load the first EVM identity decision")
            }
            return { assetId: asset.id, decisionId: decision.id }
          })
        )
      )

      const secondInput = {
        ...firstInput,
        claim: {
          _tag: "identity",
          assetId: created.assetId,
          newAsset: null,
          representation: {
            ...firstInput.claim.representation,
            contractAddress: alternateCaseAddress,
          },
        } as const,
        currentConclusionRevision: created.decisionId,
        currentPolicyEvaluationRevision: fixture.decisionId,
        rationale: "A differently cased address still identifies the existing Base representation.",
        expectedResultingAssetId: created.assetId,
        expectedAssetOutcome: "reuse" as const,
        expectedRepresentationOutcome: "reuse" as const,
      }

      const second = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            const preview = yield* repository.previewDecision(secondInput)
            const submitted = yield* repository.submitDecision({
              input: secondInput,
              actorId: TEST_USER_ID,
            })
            return { preview, submitted }
          })
        )
      )

      expect(second.preview).toMatchObject({
        _tag: "ready",
        preview: { assetOutcome: "reuse", representationOutcome: "reuse" },
      })
      expect(second.submitted).toMatchObject({ _tag: "accepted" })

      const stored = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const representations = yield* db
              .select({ contractAddress: schema.assetRepresentations.contractAddress })
              .from(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.assetId, created.assetId))
            const decisions = yield* db
              .select({
                contractAddress: schema.assetResolutionDecisions.contractAddress,
                humanClaim: schema.assetResolutionDecisions.humanClaim,
              })
              .from(schema.assetResolutionDecisions)
              .where(eq(schema.assetResolutionDecisions.assetId, created.assetId))
            return { representations, decisions }
          })
        )
      )

      expect(stored.representations).toEqual([{ contractAddress: normalizedAddress }])
      expect(stored.decisions).toHaveLength(2)
      expect(stored.decisions.map((decision) => decision.contractAddress)).toEqual([
        normalizedAddress,
        normalizedAddress,
      ])
      for (const decision of stored.decisions) {
        expect(decision.humanClaim).toEqual(
          expect.objectContaining({
            representation: expect.objectContaining({ contractAddress: normalizedAddress }),
          })
        )
      }
    })
  )

  it.effect("reuses a legacy mixed-case EVM representation", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException("-legacy-evm-case"))
      const storedAddress = "0xAbCdEf0000000000000000000000000000005678"
      const claimedAddress = "0xABCDEF0000000000000000000000000000005678"

      const seeded = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [blockchain] = yield* db
              .select({ id: schema.blockchains.id })
              .from(schema.blockchains)
              .where(eq(schema.blockchains.name, "base"))
            const [asset] = yield* db
              .insert(schema.assets)
              .values({ name: "Legacy Case Token", symbol: "LCASE", type: "fungible" })
              .returning({ id: schema.assets.id })
            if (blockchain === undefined || asset === undefined) {
              return yield* Effect.die("Failed to seed legacy EVM representation")
            }
            yield* db.insert(schema.assetRepresentations).values({
              assetId: asset.id,
              blockchainId: blockchain.id,
              type: "token",
              contractAddress: storedAddress,
              decimals: 6,
            })
            yield* db
              .update(schema.providerTransfers)
              .set({
                observedBlockchainId: blockchain.id,
                observedRepresentationType: "token",
                observedContractAddress: claimedAddress,
                observedDecimals: 6,
              })
              .where(eq(schema.providerTransfers.providerAssetId, fixture.providerAssetRowId))
            return { assetId: asset.id }
          })
        )
      )

      const input = {
        providerAssetRowId: fixture.providerAssetRowId,
        claim: {
          _tag: "identity",
          assetId: seeded.assetId,
          newAsset: null,
          representation: {
            blockchain: "base",
            type: "token",
            contractAddress: claimedAddress,
            mintAddress: null,
            decimals: 6,
          },
        } as const,
        evidenceRevision: 2,
        currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
        currentPolicyEvaluationRevision: fixture.decisionId,
        evidenceSnapshotIds: [fixture.evidenceId],
        rationale: "The legacy mixed-case row is the same Base contract identity.",
        expectedResultingAssetId: seeded.assetId,
        expectedAssetOutcome: "reuse" as const,
        expectedRepresentationOutcome: "reuse" as const,
      }

      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            const preview = yield* repository.previewDecision(input)
            const submitted = yield* repository.submitDecision({ input, actorId: TEST_USER_ID })
            return { preview, submitted }
          })
        )
      )

      expect(result.preview).toMatchObject({
        _tag: "ready",
        preview: { assetOutcome: "reuse", representationOutcome: "reuse" },
      })
      expect(result.submitted).toMatchObject({ _tag: "accepted" })

      const representations = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ contractAddress: schema.assetRepresentations.contractAddress })
              .from(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.assetId, seeded.assetId))
          })
        )
      )
      expect(representations).toEqual([{ contractAddress: storedAddress }])
    })
  )

  it.effect("serializes concurrent claims for the same new canonical identity", () =>
    Effect.gen(function* () {
      const [first, second] = yield* Effect.promise(() =>
        Promise.all([seedException("-a"), seedException("-b")])
      )
      const submit = (fixture: Awaited<ReturnType<typeof seedException>>) =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            return yield* repository.submitDecision({
              actorId: TEST_USER_ID,
              input: {
                providerAssetRowId: fixture.providerAssetRowId,
                claim: {
                  _tag: "identity",
                  assetId: null,
                  newAsset: {
                    name: "Concurrent Exception Coin",
                    symbol: "CEC",
                    type: "fungible",
                  },
                  representation: null,
                },
                evidenceRevision: 2,
                currentConclusionRevision: NO_CURRENT_ASSET_CONCLUSION,
                currentPolicyEvaluationRevision: fixture.decisionId,
                evidenceSnapshotIds: [fixture.evidenceId],
                rationale: "Concurrent observations identify the same economic asset.",
                expectedResultingAssetId: null,
                expectedAssetOutcome: "create",
                expectedRepresentationOutcome: "none",
              },
            })
          })
        )

      const results = yield* Effect.promise(() => Promise.all([submit(first), submit(second)]))

      expect(results.map((result) => result._tag).sort()).toEqual([
        "accepted",
        "ambiguous_identity",
      ])
      const assets = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ id: schema.assets.id })
              .from(schema.assets)
              .where(eq(schema.assets.name, "Concurrent Exception Coin"))
          })
        )
      )
      expect(assets).toHaveLength(1)
    })
  )

  it.effect("supports exact lookup after the exception leaves the queue", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => seedException())

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [previousDecision] = yield* db
              .insert(schema.assetResolutionDecisions)
              .values({
                providerAssetRowId: fixture.providerAssetRowId,
                evidenceRevision: 1,
                policyRevision: "test-policy.0",
                outcome: "pending",
                reason: "display_collision",
                actor: "policy:test-policy.0",
              })
              .returning({ id: schema.assetResolutionDecisions.id })
            if (previousDecision === undefined) {
              return yield* Effect.die("Failed to seed previous policy decision")
            }
            yield* db
              .update(schema.assetResolutionEvidence)
              .set({ decisionId: previousDecision.id })
              .where(eq(schema.assetResolutionEvidence.id, fixture.evidenceId))
            yield* db.insert(schema.assetResolutionDecisionEvidenceLinks).values({
              decisionId: fixture.decisionId,
              evidenceId: fixture.evidenceId,
            })
          })
        )
      )

      const detail = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* AssetExceptionRepository
            const found = yield* repository.findDetail({
              _tag: "provider_asset_id",
              provider: "coinbase",
              providerAssetId: "exception-token",
            })
            if (Option.isNone(found)) {
              return yield* Effect.die("Expected exception detail")
            }
            return found.value
          })
        )
      )

      expect(detail).toMatchObject({
        providerAssetRowId: fixture.providerAssetRowId,
        currentPolicyEvaluation: { outcome: "pending", reason: "display_collision" },
        evidence: [expect.objectContaining({ id: fixture.evidenceId, authority: "chain" })],
        impact: { affectedSources: 1, affectedTransactions: 1 },
      })
    })
  )
})
