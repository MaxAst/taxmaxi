/**
 * SourceNormalizationRepositoryLive - Atomic canonical persistence for normalized sync artifacts.
 *
 * This repository writes provider and canonical facts only. Tax accounting is produced later by
 * immutable calculation runs over the factual ledger.
 *
 * @module SourceNormalizationRepositoryLive
 */

import { createHash } from "node:crypto"
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm"
import * as BigDecimal from "effect/BigDecimal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { canonicalizeAddress, type PrincipalAssetTechnicalBlocker } from "@my/core/assets"
import { drizzle } from "./PgClientLive.ts"
import { schema } from "../schema/index.ts"
import {
  type PersistNormalizedSourceArtifactsParams,
  type PersistNormalizedSourceArtifactsResult,
  type PersistedSourceProviderTransfer,
  type PersistedSourceTransaction,
  type PersistedSourceTransfer,
  type SourceOnchainContextDraft,
  SourceNormalizationRepository,
  SourceMovementIdentity,
  type SourceProviderAssetDecision,
  type SourceProviderAssetDecisionTarget,
  type SourceProviderAssetTransferCandidate,
  type SourceProviderAssetTransferCandidateIdentity,
  type SourceProviderTransferDraft,
  type SourceTransactionDraft,
  type SourceTransactionLegDraft,
  type SourceTransactionReviewDraft,
  type SourceTransferDraft,
  type SourceVenueContextDraft,
  type SourceNormalizationRepositoryShape,
  SourceSyncCreditExhaustedError,
  SyncEngineStorageError,
} from "@my/sync-engine/services"
import {
  nowDate,
  toSyncEngineStorageError,
  wrapSyncEngineSqlError,
  wrapSyncEngineStorageError,
} from "./SyncEngineRepositorySupport.ts"
import {
  makePrincipalAssetOverrideDecisionLoader,
  type PrincipalAssetOverrideDecisions,
  type PrincipalAssetOverrideHistorySnapshot,
  resolvePrincipalAssetId,
  resolveSystemAssetId,
} from "./PrincipalAssetOverrideDecisionLoader.ts"

interface PersistedSourceLegRecord {
  readonly movementCorrectionTargetId: string
  readonly id: string
  readonly sourceId: string
  readonly sourceRawRecordId: string | null
  readonly transactionId: string | null
  readonly timestamp: Date
  readonly principalId: string
  readonly assetId: string
  readonly assetRepresentationId: string | null
  readonly sourceRepresentationUseId: string | null
  readonly providerAssetRowId: string | null
  readonly originKind: "provider_transfer" | "canonical_transfer" | "none"
  readonly providerTransferId: string | null
  readonly amount: string
  readonly kind: "acquisition" | "disposal" | "income" | "fee"
  readonly fiatAmount: string | null
  readonly fiatCurrency: string | null
  readonly derivationRule: string | null
}

interface SourceRepresentationUseTarget {
  readonly sourceId: string
  readonly blockchainId: string
  readonly representationType: "native" | "token" | "nft"
  readonly contractAddress: string | null
  readonly mintAddress: string | null
}

interface RecordedSourceRepresentationUses {
  readonly idByAssetRepresentationId: ReadonlyMap<string, string>
  readonly idByTargetKey: ReadonlyMap<string, string>
}

type LinkedSourceProviderTransferDraft = SourceProviderTransferDraft & {
  readonly sourceRepresentationUseId: string | null
}

interface LinkedSourceProviderTransferInput {
  readonly draft: SourceProviderTransferDraft
  readonly linked: LinkedSourceProviderTransferDraft
}

type LinkedSourceTransferDraft = SourceTransferDraft & {
  readonly sourceRepresentationUseId: string | null
  readonly providerAssetRowId: string | null
}

type LinkedSourceTransactionLegDraft = SourceTransactionLegDraft & {
  readonly sourceRepresentationUseId: string | null
  readonly providerAssetRowId: string | null
  readonly originKind: "provider_transfer" | "canonical_transfer" | "none"
  readonly providerTransferId: string | null
}

/**
 * Wrap residual errors in `SyncEngineStorageError`, but let a typed credit-exhaustion
 * outcome pass through so callers can route it to a resumable state instead of a
 * generic storage failure.
 */
const wrapPreservingCreditExhausted =
  (operation: string) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, SyncEngineStorageError | SourceSyncCreditExhaustedError, R> =>
    Effect.mapError(effect, (error) =>
      Schema.is(SourceSyncCreditExhaustedError)(error)
        ? error
        : toSyncEngineStorageError({ error, operation })
    )

const COMPLETED_PROVIDER_STATUSES = new Set(["completed", "succeeded"])

const hasCompletedProviderStatus = (providerStatus: string | null): boolean =>
  providerStatus !== null && COMPLETED_PROVIDER_STATUSES.has(providerStatus.toLowerCase())

const hasFailedProviderStatus = (providerStatus: string | null): boolean =>
  providerStatus?.toLowerCase() === "failed"

const stableTransactionId = ({
  externalId,
  sourceId,
  sourceRawRecordId,
}: Pick<SourceTransactionDraft, "externalId" | "sourceId" | "sourceRawRecordId">):
  | string
  | null => {
  if (externalId === null && sourceRawRecordId === null) {
    return null
  }

  const identity =
    sourceRawRecordId === null ? `external:${externalId}` : `raw:${sourceRawRecordId}`
  const digest = createHash("sha256")
    .update("taxmaxi:canonical-transaction")
    .update("\0")
    .update(sourceId)
    .update("\0")
    .update(identity)
    .digest("hex")
  const variant = ((Number.parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16)

  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}

const sourceRepresentationUseKey = ({
  sourceId,
  blockchainId,
  representationType,
  contractAddress,
  mintAddress,
}: {
  readonly sourceId: string
  readonly blockchainId: string
  readonly representationType: "native" | "token" | "nft"
  readonly contractAddress: string | null
  readonly mintAddress: string | null
}): string =>
  JSON.stringify([sourceId, blockchainId, representationType, contractAddress, mintAddress])

const ProviderTransferMetadataSchema = Schema.Struct({
  role: Schema.optional(Schema.Literals(["principal", "fee", "rent"])),
})

const PRINCIPAL_OVERRIDE_REVIEW_LAYER = "principal_asset_override"

const appendReviewSegment = ({
  existing,
  segment,
  separator,
}: {
  readonly existing: string | null
  readonly segment: string
  readonly separator: string
}): string =>
  existing === null || existing.trim() === ""
    ? segment
    : existing.includes(segment)
      ? existing
      : `${existing}${separator}${segment}`

const withPrincipalAssetTechnicalBlockerReview = ({
  principalId,
  transactionType,
  review,
  technicalBlockers,
}: {
  readonly principalId: string
  readonly transactionType: string | null
  readonly review: SourceTransactionReviewDraft | null
  readonly technicalBlockers: ReadonlyArray<PrincipalAssetTechnicalBlocker>
}): SourceTransactionReviewDraft => ({
  principalId,
  reviewStatus: "needs_review",
  originalTypeKey: review?.originalTypeKey ?? transactionType,
  originalConfidence: review?.originalConfidence ?? null,
  currentTypeKey: review?.currentTypeKey ?? transactionType,
  legalRuleSetVersion: review?.legalRuleSetVersion ?? null,
  categorizationReason: appendReviewSegment({
    existing: review?.categorizationReason ?? null,
    segment: `principal_asset_override: Accounting facts withheld by technical blockers: ${technicalBlockers.join(", ")}.`,
    separator: " ",
  }),
  matchedLayer: appendReviewSegment({
    existing: review?.matchedLayer ?? null,
    segment: PRINCIPAL_OVERRIDE_REVIEW_LAYER,
    separator: ",",
  }),
  needsReview: true,
  userNotes: review?.userNotes ?? null,
  reviewedAt: null,
})

const withPrincipalAssetUnresolvedIdentityReview = ({
  principalId,
  transactionType,
  review,
}: {
  readonly principalId: string
  readonly transactionType: string | null
  readonly review: SourceTransactionReviewDraft | null
}): SourceTransactionReviewDraft => ({
  principalId,
  reviewStatus: "needs_review",
  originalTypeKey: review?.originalTypeKey ?? transactionType,
  originalConfidence: review?.originalConfidence ?? null,
  currentTypeKey: review?.currentTypeKey ?? transactionType,
  legalRuleSetVersion: review?.legalRuleSetVersion ?? null,
  categorizationReason: appendReviewSegment({
    existing: review?.categorizationReason ?? null,
    segment: "principal_asset_override: Accounting facts withheld by unresolved identity.",
    separator: " ",
  }),
  matchedLayer: appendReviewSegment({
    existing: review?.matchedLayer ?? null,
    segment: PRINCIPAL_OVERRIDE_REVIEW_LAYER,
    separator: ",",
  }),
  needsReview: true,
  userNotes: review?.userNotes ?? null,
  reviewedAt: null,
})

const withPrincipalAssetExclusionReview = ({
  principalId,
  transactionType,
  review,
}: {
  readonly principalId: string
  readonly transactionType: string | null
  readonly review: SourceTransactionReviewDraft | null
}): SourceTransactionReviewDraft => ({
  principalId,
  reviewStatus: "needs_review",
  originalTypeKey: review?.originalTypeKey ?? transactionType,
  originalConfidence: review?.originalConfidence ?? null,
  currentTypeKey: review?.currentTypeKey ?? transactionType,
  legalRuleSetVersion: review?.legalRuleSetVersion ?? null,
  categorizationReason: appendReviewSegment({
    existing: review?.categorizationReason ?? null,
    segment:
      "principal_asset_override: Accounting facts withheld by an active principal exclusion.",
    separator: " ",
  }),
  matchedLayer: appendReviewSegment({
    existing: review?.matchedLayer ?? null,
    segment: PRINCIPAL_OVERRIDE_REVIEW_LAYER,
    separator: ",",
  }),
  needsReview: true,
  userNotes: review?.userNotes ?? null,
  reviewedAt: null,
})

const applyPrincipalProviderAssetDecisions = ({
  decisions,
  legs,
  providerAssetRowIds,
  providerTransfers,
  resolvedDerivationTargets,
  sourceRepresentationUseIds,
  derivationTechnicalBlockers,
}: {
  readonly decisions: PrincipalAssetOverrideDecisions
  readonly legs: ReadonlyArray<
    SourceTransactionLegDraft & {
      readonly sourceRepresentationUseId: string | null
      readonly providerAssetRowId: string | null
    }
  >
  readonly providerAssetRowIds: ReadonlyArray<string>
  readonly providerTransfers: ReadonlyArray<PersistedSourceProviderTransfer>
  readonly resolvedDerivationTargets: ReadonlyArray<SourceProviderAssetDecisionTarget>
  readonly sourceRepresentationUseIds: ReadonlyArray<string>
  readonly derivationTechnicalBlockers: ReadonlyArray<PrincipalAssetTechnicalBlocker>
}): {
  readonly hasPrincipalExclusion: boolean
  readonly resolvesProviderAssetMappingReview: boolean
  readonly hasUnresolvedIdentity: boolean
  readonly withholdsAccountingFacts: boolean
  readonly technicalBlockers: ReadonlyArray<PrincipalAssetTechnicalBlocker>
  readonly legs: ReadonlyArray<
    SourceTransactionLegDraft & {
      readonly sourceRepresentationUseId: string | null
      readonly providerAssetRowId: string | null
    }
  >
  readonly feeCustodyAssetIds: ReadonlyArray<string | null>
} => {
  const effectiveLegs: Array<
    SourceTransactionLegDraft & {
      readonly sourceRepresentationUseId: string | null
      readonly providerAssetRowId: string | null
    }
  > = []
  const feeCustodyAssetIds: Array<string | null> = []
  let hasUnresolvedIdentity = false
  let hasPrincipalExclusion = false
  let resolvesProviderAssetMappingReview = false
  const technicalBlockers = new Set<PrincipalAssetTechnicalBlocker>(derivationTechnicalBlockers)
  let hasBlockedOrExcludedExactUse = false
  for (const sourceRepresentationUseId of sourceRepresentationUseIds) {
    const decision = decisions.sourceRepresentationUseDecisionById.get(sourceRepresentationUseId)
    if (decision === undefined) {
      hasUnresolvedIdentity = true
      hasBlockedOrExcludedExactUse = true
      continue
    }

    const inclusion = decision.inclusionReplacement ?? decision.systemInclusion
    const assetId = decision.identityReplacementAssetId ?? decision.systemAssetId
    if (decision.inclusionReplacement === "excluded") hasPrincipalExclusion = true
    if (assetId === null) hasUnresolvedIdentity = true
    if (inclusion === "excluded" || assetId === null) hasBlockedOrExcludedExactUse = true
  }
  const providerDecisionBlocks = ({
    providerAssetRowId,
    sourceRepresentationUseId,
  }: {
    readonly providerAssetRowId: string | null
    readonly sourceRepresentationUseId: string | null
  }): boolean => {
    if (providerAssetRowId === null) return false

    const providerDecision = decisions.providerAssetDecisionById.get(providerAssetRowId)
    if (sourceRepresentationUseId !== null) {
      const exactDecision =
        decisions.sourceRepresentationUseDecisionById.get(sourceRepresentationUseId)
      if (exactDecision?.inclusionReplacement === "excluded") hasPrincipalExclusion = true
      const exactInclusion =
        exactDecision === undefined
          ? "excluded"
          : (exactDecision.inclusionReplacement ?? exactDecision.systemInclusion)
      const exactAssetId =
        exactDecision?.identityReplacementAssetId ?? exactDecision?.systemAssetId ?? null
      if (
        providerDecision?.systemAssetId === null &&
        providerDecision.systemInclusion !== "excluded" &&
        exactInclusion === "included" &&
        exactAssetId !== null
      ) {
        resolvesProviderAssetMappingReview = true
      }
      return providerDecision?.systemInclusion === "excluded"
    }
    if (decisions.ignoredProviderAssetRowIds.has(providerAssetRowId)) return false

    if (providerDecision === undefined) {
      hasUnresolvedIdentity = true
      return true
    }

    for (const technicalBlocker of providerDecision.technicalBlockers) {
      technicalBlockers.add(technicalBlocker)
    }

    if (
      providerDecision.systemInclusion === "included" &&
      providerDecision.inclusion === "excluded"
    ) {
      hasPrincipalExclusion = true
    }
    if (
      providerDecision.systemAssetId === null &&
      providerDecision.effectiveDecision._tag === "included"
    ) {
      resolvesProviderAssetMappingReview = true
    }

    if (
      providerDecision.effectiveDecision._tag === "blocked" &&
      providerDecision.effectiveDecision.reason === "unresolved_identity"
    ) {
      hasUnresolvedIdentity = true
    }

    return providerDecision.effectiveDecision._tag !== "included"
  }
  const referencedProviderAssetRowIds = new Set([
    ...legs.flatMap(({ providerAssetRowId }) =>
      providerAssetRowId === null || providerAssetRowId === undefined ? [] : [providerAssetRowId]
    ),
    ...providerTransfers.flatMap(({ providerAssetId }) =>
      providerAssetId === null ? [] : [providerAssetId]
    ),
  ])
  let hasBlockedOrExcludedProviderUse = false
  for (const target of resolvedDerivationTargets) {
    if (
      providerDecisionBlocks({
        providerAssetRowId: target.providerAssetRowId,
        sourceRepresentationUseId:
          target._tag === "provider_transfer" ? target.sourceRepresentationUseId : null,
      })
    ) {
      hasBlockedOrExcludedProviderUse = true
    }
  }
  for (const { providerAssetRowId, sourceRepresentationUseId } of legs) {
    if (
      providerDecisionBlocks({
        providerAssetRowId: providerAssetRowId ?? null,
        sourceRepresentationUseId,
      })
    ) {
      hasBlockedOrExcludedProviderUse = true
    }
  }
  for (const { processingMode, providerAssetId, sourceRepresentationUseId } of providerTransfers) {
    if (
      processingMode !== "evidence_only" &&
      processingMode !== "stale" &&
      providerDecisionBlocks({
        providerAssetRowId: providerAssetId,
        sourceRepresentationUseId,
      })
    ) {
      hasBlockedOrExcludedProviderUse = true
    }
  }
  for (const providerAssetRowId of providerAssetRowIds) {
    if (
      !referencedProviderAssetRowIds.has(providerAssetRowId) &&
      providerDecisionBlocks({ providerAssetRowId, sourceRepresentationUseId: null })
    ) {
      hasBlockedOrExcludedProviderUse = true
    }
  }

  for (const leg of legs) {
    const providerAssetRowId = leg.providerAssetRowId ?? null
    const providerDecision =
      providerAssetRowId === null
        ? undefined
        : decisions.providerAssetDecisionById.get(providerAssetRowId)
    const mayUseProviderFallback =
      providerAssetRowId !== null &&
      leg.assetRepresentationId === null &&
      leg.sourceRepresentationUseId === null
    const exactDecision =
      leg.sourceRepresentationUseId === null
        ? undefined
        : decisions.sourceRepresentationUseDecisionById.get(leg.sourceRepresentationUseId)
    const representationSystemAssetId =
      exactDecision?.systemAssetId ??
      resolveSystemAssetId({
        decisions,
        assetId: leg.assetId,
        assetRepresentationId: leg.assetRepresentationId,
      })
    const systemAssetId = mayUseProviderFallback
      ? (providerDecision?.systemAssetId ??
        (providerDecision?.effectiveDecision._tag === "included"
          ? providerDecision.effectiveDecision.assetId
          : representationSystemAssetId))
      : representationSystemAssetId
    const assetId =
      exactDecision === undefined
        ? resolvePrincipalAssetId({
            decisions,
            systemAssetId,
            assetRepresentationId: leg.assetRepresentationId,
            providerAssetRowId: mayUseProviderFallback ? providerAssetRowId : null,
          })
        : (exactDecision.identityReplacementAssetId ?? systemAssetId)
    effectiveLegs.push({ ...leg, assetId })
    feeCustodyAssetIds.push(
      mayUseProviderFallback
        ? (providerDecision?.systemAssetId ?? null)
        : representationSystemAssetId
    )
  }

  const withholdsAccountingFacts =
    hasBlockedOrExcludedExactUse ||
    hasBlockedOrExcludedProviderUse ||
    derivationTechnicalBlockers.length > 0

  return {
    hasPrincipalExclusion,
    resolvesProviderAssetMappingReview,
    hasUnresolvedIdentity,
    withholdsAccountingFacts,
    technicalBlockers: [...technicalBlockers].sort(),
    legs: withholdsAccountingFacts ? [] : effectiveLegs,
    feeCustodyAssetIds: withholdsAccountingFacts ? [] : feeCustodyAssetIds,
  }
}

const resolveSourceProviderAssetDecision = ({
  decisions,
  target,
}: {
  readonly decisions: PrincipalAssetOverrideDecisions
  readonly target: SourceProviderAssetDecisionTarget
}): SourceProviderAssetDecision => {
  const providerAssetRowId = target.providerAssetRowId
  const sourceRepresentationUseId =
    target._tag === "provider_transfer" ? target.sourceRepresentationUseId : null
  const providerDecision = decisions.providerAssetDecisionById.get(providerAssetRowId)
  if (sourceRepresentationUseId !== null) {
    const exactDecision =
      decisions.sourceRepresentationUseDecisionById.get(sourceRepresentationUseId)
    if (exactDecision === undefined) {
      return { _tag: "blocked", reason: { _tag: "unresolved_identity" } }
    }
    if (providerDecision?.systemInclusion === "excluded") return { _tag: "excluded" }
    const inclusion = exactDecision.inclusionReplacement ?? exactDecision.systemInclusion
    if (inclusion === "excluded") return { _tag: "excluded" }
    const assetId = exactDecision.identityReplacementAssetId ?? exactDecision.systemAssetId
    return assetId === null
      ? { _tag: "blocked", reason: { _tag: "unresolved_identity" } }
      : { _tag: "included", assetId }
  }

  if (providerDecision === undefined) {
    return { _tag: "blocked", reason: { _tag: "unresolved_identity" } }
  }
  const decision = providerDecision.effectiveDecision
  if (decision._tag === "blocked") {
    return {
      _tag: "blocked",
      reason:
        decision.reason === "unresolved_identity"
          ? { _tag: "unresolved_identity" }
          : {
              _tag: "technical_blocker",
              technicalBlockers: providerDecision.technicalBlockers,
            },
    }
  }
  if (decision._tag === "excluded") return { _tag: "excluded" }
  return { _tag: "included", assetId: decision.assetId }
}

const resolveCanonicalTransferSystemAssetId = ({
  decisions,
  transfer,
}: {
  readonly decisions: PrincipalAssetOverrideDecisions
  readonly transfer: Pick<
    PersistedSourceTransfer,
    "assetId" | "assetRepresentationId" | "providerAssetRowId"
  >
}): string => {
  if (transfer.assetRepresentationId !== null) {
    return resolveSystemAssetId({
      decisions,
      assetId: transfer.assetId,
      assetRepresentationId: transfer.assetRepresentationId,
    })
  }

  if (transfer.providerAssetRowId === null || transfer.providerAssetRowId === undefined) {
    return transfer.assetId
  }

  return (
    decisions.providerAssetDecisionById.get(transfer.providerAssetRowId)?.systemAssetId ??
    transfer.assetId
  )
}

const decodeProviderTransferMetadata = (metadata: unknown) =>
  Schema.decodeUnknownEffect(ProviderTransferMetadataSchema)(metadata).pipe(
    Effect.map((decoded) => ({
      purpose: decoded.role === "fee" ? ("fee" as const) : ("principal" as const),
    })),
    Effect.orElseSucceed(() => ({ purpose: "principal" as const }))
  )

const NumericStringSchema = Schema.Union([Schema.String, Schema.Finite])

const decodeNumericString = ({
  value,
  operation,
}: {
  readonly value: unknown
  readonly operation: string
}): Effect.Effect<string, ReturnType<typeof toSyncEngineStorageError>> =>
  Schema.decodeUnknownEffect(NumericStringSchema)(value).pipe(
    Effect.map(String),
    Effect.mapError(() =>
      toSyncEngineStorageError({
        operation,
        error: `Expected string or number, got ${typeof value}`,
      })
    )
  )

const compareDecimalStrings = ({
  left,
  right,
}: {
  readonly left: string
  readonly right: string
}) =>
  Effect.gen(function* () {
    const leftQuantity = yield* Option.match(BigDecimal.fromString(left), {
      onNone: () =>
        Effect.fail(
          toSyncEngineStorageError({
            error: `Invalid decimal value: ${left}`,
            operation: "sourceNormalizationRepository.compareDecimalStrings",
          })
        ),
      onSome: Effect.succeed,
    })
    const rightQuantity = yield* Option.match(BigDecimal.fromString(right), {
      onNone: () =>
        Effect.fail(
          toSyncEngineStorageError({
            error: `Invalid decimal value: ${right}`,
            operation: "sourceNormalizationRepository.compareDecimalStrings",
          })
        ),
      onSome: Effect.succeed,
    })

    return BigDecimal.Order(leftQuantity, rightQuantity)
  })

const make = Effect.gen(function* () {
  const db = yield* drizzle
  const principalAssetOverrideDecisionLoader = yield* makePrincipalAssetOverrideDecisionLoader

  type SourceNormalizationExecutor = Pick<typeof db, "delete" | "insert" | "select" | "update">

  const selectPersistedTransactionFields = {
    id: schema.transactions.id,
    sourceId: schema.transactions.sourceId,
    sourceRawRecordId: schema.transactions.sourceRawRecordId,
    externalId: schema.transactions.externalId,
    timestamp: schema.transactions.timestamp,
    providerTransactionType: schema.transactions.providerTransactionType,
    metadata: schema.transactions.metadata,
    principalId: schema.transactions.principalId,
  } as const

  const selectPersistedVenueContextFields = {
    transactionId: schema.transactionVenueContext.transactionId,
    side: schema.transactionVenueContext.side,
    instrument: schema.transactionVenueContext.instrument,
    fillPrice: schema.transactionVenueContext.fillPrice,
  } as const

  const selectPersistedTransferFields = {
    id: schema.transfers.id,
    sourceId: schema.transfers.sourceId,
    principalId: schema.transfers.principalId,
    sourceRawRecordId: schema.transfers.sourceRawRecordId,
    externalId: schema.transfers.externalId,
    txHash: schema.transfers.txHash,
    timestamp: schema.transfers.timestamp,
    addressId: schema.transfers.addressId,
    assetId: schema.transfers.assetId,
    assetRepresentationId: schema.transfers.assetRepresentationId,
    sourceRepresentationUseId: schema.transfers.sourceRepresentationUseId,
    providerAssetRowId: schema.transfers.providerAssetRowId,
    amount: schema.transfers.amount,
    type: schema.transfers.type,
    metadata: schema.transfers.metadata,
  } as const

  const selectPersistedProviderTransferFields = {
    id: schema.providerTransfers.id,
    sourceId: schema.providerTransfers.sourceId,
    sourceRawRecordId: schema.providerTransfers.sourceRawRecordId,
    transactionId: schema.providerTransfers.transactionId,
    externalId: schema.providerTransfers.externalId,
    externalGroupId: schema.providerTransfers.externalGroupId,
    providerAssetId: schema.providerTransfers.providerAssetId,
    sourceRepresentationUseId: schema.providerTransfers.sourceRepresentationUseId,
    timestamp: schema.providerTransfers.timestamp,
    direction: schema.providerTransfers.direction,
    processingMode: schema.providerTransfers.processingMode,
    fromAccountRef: schema.providerTransfers.fromAccountRef,
    toAccountRef: schema.providerTransfers.toAccountRef,
    fromAddress: schema.providerTransfers.fromAddress,
    toAddress: schema.providerTransfers.toAddress,
    networkName: schema.providerTransfers.networkName,
    networkHash: schema.providerTransfers.networkHash,
    observedBlockchainId: schema.providerTransfers.observedBlockchainId,
    observedRepresentationType: schema.providerTransfers.observedRepresentationType,
    observedContractAddress: schema.providerTransfers.observedContractAddress,
    observedMintAddress: schema.providerTransfers.observedMintAddress,
    observedDecimals: schema.providerTransfers.observedDecimals,
    amount: schema.providerTransfers.amount,
    metadata: schema.providerTransfers.metadata,
  } as const

  const selectPersistedLegFields = {
    movementCorrectionTargetId: schema.transactionLegs.movementCorrectionTargetId,
    id: schema.transactionLegs.id,
    sourceId: schema.transactionLegs.sourceId,
    sourceRawRecordId: schema.transactionLegs.sourceRawRecordId,
    transactionId: schema.transactionLegs.transactionId,
    timestamp: schema.transactionLegs.timestamp,
    principalId: schema.transactionLegs.principalId,
    assetId: schema.transactionLegs.assetId,
    assetRepresentationId: schema.transactionLegs.assetRepresentationId,
    sourceRepresentationUseId: schema.transactionLegs.sourceRepresentationUseId,
    providerAssetRowId: schema.transactionLegs.providerAssetRowId,
    originKind: schema.transactionLegs.originKind,
    providerTransferId: schema.transactionLegs.providerTransferId,
    amount: schema.transactionLegs.amount,
    kind: schema.transactionLegs.kind,
    fiatAmount: schema.transactionLegs.fiatAmount,
    fiatCurrency: schema.transactionLegs.fiatCurrency,
    derivationRule: schema.transactionLegs.derivationRule,
  } as const

  const upsertTransaction = ({
    executor,
    transaction,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly transaction: SourceTransactionDraft
  }) =>
    Effect.gen(function* () {
      const now = nowDate()
      const deterministicTransactionId = stableTransactionId(transaction)
      if (deterministicTransactionId === null) {
        return yield* toSyncEngineStorageError({
          operation: "sourceNormalizationRepository.upsertTransaction.identity",
          error: "Transaction is missing a stable source identity",
        })
      }
      const [existingExternalTransaction] =
        transaction.externalId === null
          ? []
          : yield* executor
              .select({ id: schema.transactions.id })
              .from(schema.transactions)
              .where(
                and(
                  eq(schema.transactions.sourceId, transaction.sourceId),
                  eq(schema.transactions.externalId, transaction.externalId)
                )
              )
              .limit(1)
              .pipe(
                wrapSyncEngineSqlError(
                  "sourceNormalizationRepository.upsertTransaction.findExternal"
                )
              )
      const transactionId = existingExternalTransaction?.id ?? deterministicTransactionId

      const conflictSet = {
        externalId: sql.raw("excluded.external_id"),
        sourceRawRecordId: sql.raw("excluded.source_raw_record_id"),
        externalGroupId: sql.raw("excluded.external_group_id"),
        timestamp: sql.raw("excluded.timestamp"),
        transactionType: sql.raw("excluded.transaction_type"),
        providerTransactionType: sql.raw("excluded.provider_transaction_type"),
        providerStatus: sql.raw("excluded.provider_status"),
        providerResourcePath: sql.raw("excluded.provider_resource_path"),
        providerDescription: sql.raw("excluded.provider_description"),
        providerCreatedAt: sql.raw("excluded.provider_created_at"),
        providerUpdatedAt: sql.raw("excluded.provider_updated_at"),
        metadata: sql.raw("excluded.metadata"),
        providerFiatAmount: sql.raw("excluded.provider_fiat_amount"),
        providerFiatCurrency: sql.raw("excluded.provider_fiat_currency"),
        principalId: sql.raw("excluded.principal_id"),
        updatedAt: now,
      } as const
      const insert = executor.insert(schema.transactions).values({
        ...transaction,
        id: transactionId,
        createdAt: now,
        updatedAt: now,
      })
      const upsert = insert.onConflictDoUpdate({
        target: schema.transactions.id,
        set: conflictSet,
      })
      const [persisted] = yield* upsert
        .returning(selectPersistedTransactionFields)
        .pipe(wrapSyncEngineSqlError("sourceNormalizationRepository.upsertTransaction"))

      if (persisted === undefined) {
        return yield* toSyncEngineStorageError({
          operation: "sourceNormalizationRepository.upsertTransaction",
          error: "failed to persist transaction",
        })
      }

      return persisted
    })

  const consumeTransactionCredit = ({
    executor,
    externalId,
    mode,
    principalId,
    replayReservationId,
    sourceId,
    sourceRawRecordId,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly externalId: string | null
    readonly mode: "persist" | "reserve"
    readonly principalId: string
    readonly replayReservationId: string | null
    readonly sourceId: string
    readonly sourceRawRecordId: string | null
  }) =>
    Effect.gen(function* () {
      const [principal] = yield* executor
        .select({ userId: schema.principals.userId })
        .from(schema.principals)
        .where(eq(schema.principals.id, principalId))
        .limit(1)
        .pipe(
          wrapSyncEngineSqlError(
            "sourceNormalizationRepository.consumeTransactionCredit.findPrincipal"
          )
        )

      // Anonymous x402 principals keep their payment-based access path. Every
      // registered user transaction must be backed by a billing credit.
      if (principal?.userId === null || principal === undefined) return null

      if (sourceRawRecordId !== null) {
        const [paidRawRecord] = yield* executor
          .select({ id: schema.sourceRecordsRaw.id })
          .from(schema.sourceRecordsRaw)
          .innerJoin(
            schema.principalClaims,
            and(
              eq(schema.principalClaims.sourceId, schema.sourceRecordsRaw.sourceId),
              eq(schema.principalClaims.claimType, "x402_receipt")
            )
          )
          .where(
            and(
              eq(schema.sourceRecordsRaw.id, sourceRawRecordId),
              eq(schema.sourceRecordsRaw.sourceId, sourceId),
              isNotNull(schema.principalClaims.consumedAt),
              lte(schema.sourceRecordsRaw.createdAt, schema.principalClaims.consumedAt)
            )
          )
          .limit(1)
          .pipe(
            wrapSyncEngineSqlError(
              "sourceNormalizationRepository.consumeTransactionCredit.findClaimedX402Payment"
            )
          )

        // The x402 payment covered raw records retained when the source was claimed.
        // Records imported after the claim still use the registered user's credits.
        if (paidRawRecord !== undefined) return null
      }

      const [account] = yield* executor
        .select({ userId: schema.billingAccounts.userId })
        .from(schema.billingAccounts)
        .where(eq(schema.billingAccounts.userId, principal.userId))
        .limit(1)
        .for("update")
        .pipe(
          wrapSyncEngineSqlError(
            "sourceNormalizationRepository.consumeTransactionCredit.lockAccount"
          )
        )

      if (account === undefined) {
        return yield* new SourceSyncCreditExhaustedError({
          reasonCode: "no_usable_credits",
          availableCredits: 0,
        })
      }

      const rawReference =
        sourceRawRecordId === null ? null : `transaction:${sourceId}:raw:${sourceRawRecordId}`
      const externalReference =
        externalId === null ? null : `transaction:${sourceId}:external:${externalId}`
      if (rawReference === null && externalReference === null) {
        return yield* toSyncEngineStorageError({
          operation: "sourceNormalizationRepository.consumeTransactionCredit.identity",
          error: "Transaction is missing a stable source identity",
        })
      }

      const [previousForRawRecord] =
        sourceRawRecordId === null
          ? []
          : yield* executor
              .select({ externalId: schema.transactions.externalId })
              .from(schema.transactions)
              .where(
                and(
                  eq(schema.transactions.sourceId, sourceId),
                  eq(schema.transactions.sourceRawRecordId, sourceRawRecordId)
                )
              )
              .limit(1)
              .pipe(
                wrapSyncEngineSqlError(
                  "sourceNormalizationRepository.consumeTransactionCredit.findPreviousByRawRecord"
                )
              )
      const [previousForExternalId] =
        externalId === null
          ? []
          : yield* executor
              .select({ sourceRawRecordId: schema.transactions.sourceRawRecordId })
              .from(schema.transactions)
              .where(
                and(
                  eq(schema.transactions.sourceId, sourceId),
                  eq(schema.transactions.externalId, externalId)
                )
              )
              .limit(1)
              .pipe(
                wrapSyncEngineSqlError(
                  "sourceNormalizationRepository.consumeTransactionCredit.findPreviousByExternalId"
                )
              )
      const previousExternalReference =
        previousForRawRecord?.externalId === null || previousForRawRecord?.externalId === undefined
          ? null
          : `transaction:${sourceId}:external:${previousForRawRecord.externalId}`
      const previousRawReference =
        previousForExternalId?.sourceRawRecordId === null ||
        previousForExternalId?.sourceRawRecordId === undefined
          ? null
          : `transaction:${sourceId}:raw:${previousForExternalId.sourceRawRecordId}`
      const candidateReferences = [
        rawReference,
        externalReference,
        previousExternalReference,
        previousRawReference,
      ].filter((reference): reference is string => reference !== null)
      const existingEntries = yield* executor
        .select({
          id: schema.creditLedger.id,
          reference: schema.creditLedger.reference,
          replayReservationId: schema.creditLedger.replayReservationId,
        })
        .from(schema.creditLedger)
        .where(inArray(schema.creditLedger.reference, [...new Set(candidateReferences)]))
        .for("update")
        .pipe(
          wrapSyncEngineSqlError(
            "sourceNormalizationRepository.consumeTransactionCredit.findExisting"
          )
        )
      const existingByReference = new Map(
        existingEntries.map((entry) => [entry.reference, entry] as const)
      )
      const existingRaw = rawReference === null ? undefined : existingByReference.get(rawReference)
      const existingExternal =
        externalReference === null ? undefined : existingByReference.get(externalReference)
      const existingForSameExternalRaw =
        previousRawReference === null ? undefined : existingByReference.get(previousRawReference)
      const existingForPreviousExternal =
        previousExternalReference === null
          ? undefined
          : existingByReference.get(previousExternalReference)
      const existing =
        existingRaw ?? existingExternal ?? existingForSameExternalRaw ?? existingForPreviousExternal
      if (existing !== undefined) {
        if (
          mode === "persist" &&
          existing.replayReservationId !== null &&
          existing.replayReservationId !== replayReservationId
        ) {
          return yield* toSyncEngineStorageError({
            operation:
              "sourceNormalizationRepository.consumeTransactionCredit.reservationOwnership",
            error: "Replay transaction credit reservation ownership changed",
          })
        }
        const migratedReference =
          existing === existingForPreviousExternal &&
          existingRaw === undefined &&
          existingExternal === undefined &&
          existingForSameExternalRaw === undefined
            ? (externalReference ?? rawReference ?? existing.reference)
            : existing.reference
        const nextReplayReservationId =
          mode === "persist"
            ? existing.replayReservationId === replayReservationId
              ? null
              : existing.replayReservationId
            : replayReservationId === null
              ? existing.replayReservationId
              : existing.replayReservationId === null
                ? null
                : replayReservationId
        if (
          migratedReference !== existing.reference ||
          nextReplayReservationId !== existing.replayReservationId
        ) {
          const [updated] = yield* executor
            .update(schema.creditLedger)
            .set({
              reference: migratedReference,
              replayReservationId: nextReplayReservationId,
            })
            .where(
              existing.replayReservationId === null
                ? eq(schema.creditLedger.id, existing.id)
                : and(
                    eq(schema.creditLedger.id, existing.id),
                    eq(schema.creditLedger.replayReservationId, existing.replayReservationId)
                  )
            )
            .returning({ id: schema.creditLedger.id })
            .pipe(
              wrapSyncEngineSqlError(
                "sourceNormalizationRepository.consumeTransactionCredit.updateExisting"
              )
            )
          if (updated === undefined) {
            return yield* toSyncEngineStorageError({
              operation:
                "sourceNormalizationRepository.consumeTransactionCredit.reservationOwnership",
              error: "Replay transaction credit reservation ownership changed",
            })
          }
        }
        return mode === "reserve" &&
          replayReservationId !== null &&
          nextReplayReservationId === replayReservationId
          ? migratedReference
          : null
      }

      if (mode === "persist" && replayReservationId !== null) {
        return yield* toSyncEngineStorageError({
          operation: "sourceNormalizationRepository.consumeTransactionCredit.missingReservation",
          error: "Replay transaction credit reservation no longer exists",
        })
      }

      const reference = externalReference ?? rawReference
      if (reference === null) {
        return yield* toSyncEngineStorageError({
          operation: "sourceNormalizationRepository.consumeTransactionCredit.identity",
          error: "Transaction is missing a stable source identity",
        })
      }

      const now = nowDate()
      const rows = yield* executor
        .select({
          balance: sql<number>`coalesce(sum(${schema.creditLedger.delta}), 0)`,
          expiresAt: schema.creditLedger.expiresAt,
        })
        .from(schema.creditLedger)
        .where(
          and(
            eq(schema.creditLedger.userId, account.userId),
            or(isNull(schema.creditLedger.expiresAt), gt(schema.creditLedger.expiresAt, now))
          )
        )
        .groupBy(schema.creditLedger.expiresAt)
        .orderBy(asc(schema.creditLedger.expiresAt))
        .pipe(
          wrapSyncEngineSqlError(
            "sourceNormalizationRepository.consumeTransactionCredit.loadBalance"
          )
        )

      const buckets = rows.map((row) => ({
        balance: Number(row.balance),
        expiresAt: row.expiresAt,
      }))
      const totalBalance = buckets.reduce((total, candidate) => total + candidate.balance, 0)
      if (totalBalance <= 0) {
        return yield* new SourceSyncCreditExhaustedError({
          reasonCode: "no_usable_credits",
          availableCredits: Math.max(totalBalance, 0),
        })
      }

      const bucket = buckets.find((candidate) => candidate.balance > 0)
      if (bucket === undefined) {
        return yield* new SourceSyncCreditExhaustedError({
          reasonCode: "no_usable_credits",
          availableCredits: Math.max(totalBalance, 0),
        })
      }

      yield* executor
        .insert(schema.creditLedger)
        .values({
          userId: account.userId,
          delta: -1,
          kind: "transaction_usage",
          reference,
          paymentReference: null,
          replayReservationId,
          expiresAt: bucket.expiresAt,
        })
        .pipe(
          wrapSyncEngineSqlError("sourceNormalizationRepository.consumeTransactionCredit.insert")
        )

      return reference
    })

  const upsertVenueContext = ({
    executor,
    venueContext,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly venueContext: SourceVenueContextDraft & {
      readonly transactionId: string
    }
  }) =>
    Effect.gen(function* () {
      const now = nowDate()
      const [persisted] = yield* executor
        .insert(schema.transactionVenueContext)
        .values({
          ...venueContext,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.transactionVenueContext.transactionId,
          set: {
            venueType: sql.raw("excluded.venue_type"),
            cexAccountId: sql.raw("excluded.cex_account_id"),
            externalAccountId: sql.raw("excluded.external_account_id"),
            externalOrderId: sql.raw("excluded.external_order_id"),
            externalFillId: sql.raw("excluded.external_fill_id"),
            side: sql.raw("excluded.side"),
            instrument: sql.raw("excluded.instrument"),
            fillPrice: sql.raw("excluded.fill_price"),
            commissionAmount: sql.raw("excluded.commission_amount"),
            commissionCurrency: sql.raw("excluded.commission_currency"),
            metadata: sql.raw("excluded.metadata"),
            updatedAt: now,
          },
        })
        .returning(selectPersistedVenueContextFields)
        .pipe(wrapSyncEngineSqlError("sourceNormalizationRepository.upsertVenueContext"))

      if (persisted === undefined) {
        return yield* toSyncEngineStorageError({
          operation: "sourceNormalizationRepository.upsertVenueContext",
          error: "failed to persist transaction venue context",
        })
      }

      return {
        ...persisted,
        fillPrice: persisted.fillPrice === null ? null : String(persisted.fillPrice),
      }
    })

  const upsertOnchainContext = ({
    executor,
    transactionId,
    onchainContext,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly transactionId: string
    readonly onchainContext: SourceOnchainContextDraft | null | undefined
  }) =>
    onchainContext === null || onchainContext === undefined
      ? executor
          .delete(schema.transactionOnchainContext)
          .where(eq(schema.transactionOnchainContext.transactionId, transactionId))
          .pipe(
            wrapSyncEngineSqlError("sourceNormalizationRepository.upsertOnchainContext.delete"),
            Effect.asVoid
          )
      : Effect.gen(function* () {
          const now = nowDate()
          yield* executor
            .insert(schema.transactionOnchainContext)
            .values({
              transactionId,
              blockchainId: onchainContext.blockchainId,
              addressId: onchainContext.addressId,
              chainTxId: onchainContext.chainTxId,
              blockHeight: onchainContext.blockHeight,
              blockHash: onchainContext.blockHash,
              positionInBlock: onchainContext.positionInBlock,
              fromAddress: onchainContext.fromAddress,
              toAddress: onchainContext.toAddress,
              gasUsed: onchainContext.gasUsed,
              gasPrice: onchainContext.gasPrice,
              feeAmount: onchainContext.feeAmount,
              feeAssetId: onchainContext.feeAssetId,
              feeCostBasisAmount: onchainContext.feeCostBasisAmount,
              feeCostBasisCurrency: onchainContext.feeCostBasisCurrency,
              isError: onchainContext.isError,
              functionName: onchainContext.functionName,
              metadata: onchainContext.metadata,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: schema.transactionOnchainContext.transactionId,
              set: {
                blockchainId: sql.raw("excluded.blockchain_id"),
                addressId: sql.raw("excluded.address_id"),
                chainTxId: sql.raw("excluded.tx_hash"),
                blockHeight: sql.raw("excluded.block_number"),
                blockHash: sql.raw("excluded.block_hash"),
                positionInBlock: sql.raw("excluded.position_in_block"),
                fromAddress: sql.raw("excluded.from_address"),
                toAddress: sql.raw("excluded.to_address"),
                gasUsed: sql.raw("excluded.gas_used"),
                gasPrice: sql.raw("excluded.gas_price"),
                feeAmount: sql.raw("excluded.gas_fee_in_native"),
                feeAssetId: sql.raw("excluded.fee_asset_id"),
                feeCostBasisAmount: sql.raw("excluded.gas_fee_cost_basis_amount"),
                feeCostBasisCurrency: sql.raw("excluded.gas_fee_cost_basis_currency"),
                isError: sql.raw("excluded.is_error"),
                functionName: sql.raw("excluded.function_name"),
                metadata: sql.raw("excluded.metadata"),
                updatedAt: now,
              },
            })
            .pipe(wrapSyncEngineSqlError("sourceNormalizationRepository.upsertOnchainContext"))
        })

  const upsertCanonicalTransfers = ({
    executor,
    canonicalTransfers,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly canonicalTransfers: ReadonlyArray<LinkedSourceTransferDraft>
  }) =>
    Effect.forEach(canonicalTransfers, (transfer) =>
      Effect.gen(function* () {
        const now = nowDate()
        const [persisted] = yield* executor
          .insert(schema.transfers)
          .values({
            ...transfer,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [schema.transfers.sourceId, schema.transfers.externalId],
            targetWhere: sql`${schema.transfers.externalId} is not null`,
            set: {
              sourceRawRecordId: sql.raw("excluded.source_raw_record_id"),
              externalGroupId: sql.raw("excluded.external_group_id"),
              addressId: sql.raw("excluded.address_id"),
              blockchainId: sql.raw("excluded.blockchain_id"),
              txHash: sql.raw("excluded.tx_hash"),
              timestamp: sql.raw("excluded.timestamp"),
              type: sql.raw("excluded.type"),
              fromAddress: sql.raw("excluded.from_address"),
              toAddress: sql.raw("excluded.to_address"),
              fromAccountRef: sql.raw("excluded.from_account_ref"),
              toAccountRef: sql.raw("excluded.to_account_ref"),
              fromPartyType: sql.raw("excluded.from_party_type"),
              fromPartyResourcePath: sql.raw("excluded.from_party_resource_path"),
              toPartyType: sql.raw("excluded.to_party_type"),
              toPartyResourcePath: sql.raw("excluded.to_party_resource_path"),
              assetId: sql.raw("excluded.asset_id"),
              assetRepresentationId: sql.raw("excluded.asset_representation_id"),
              sourceRepresentationUseId: sql.raw("excluded.source_representation_use_id"),
              providerAssetRowId: sql.raw("excluded.provider_asset_row_id"),
              amount: sql.raw("excluded.amount"),
              tokenId: sql.raw("excluded.token_id"),
              notes: sql.raw("excluded.notes"),
              metadata: sql.raw("excluded.metadata"),
              principalId: sql.raw("excluded.principal_id"),
              updatedAt: now,
            },
          })
          .returning(selectPersistedTransferFields)
          .pipe(wrapSyncEngineSqlError("sourceNormalizationRepository.upsertCanonicalTransfers"))

        if (persisted === undefined) {
          return yield* toSyncEngineStorageError({
            operation: "sourceNormalizationRepository.upsertCanonicalTransfers",
            error: "failed to persist transfer",
          })
        }

        const amount = yield* decodeNumericString({
          value: persisted.amount,
          operation: "sourceNormalizationRepository.upsertCanonicalTransfers.amount",
        })

        return {
          ...persisted,
          amount,
        }
      })
    )

  /**
   * Keep the transaction's provider-asset dependencies in step with the
   * latest normalization pass. Replays can change which provider assets a
   * record depends on, so stale rows are removed instead of accreting.
   */
  const syncProviderAssetTransactionUses = ({
    executor,
    transactionId,
    sourceId,
    providerAssetRowIds,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly transactionId: string
    readonly sourceId: string
    readonly providerAssetRowIds: ReadonlyArray<string>
  }) =>
    Effect.gen(function* () {
      const now = nowDate()
      const distinctProviderAssetRowIds = [...new Set(providerAssetRowIds)]

      yield* executor
        .delete(schema.providerAssetTransactionUses)
        .where(
          and(
            eq(schema.providerAssetTransactionUses.transactionId, transactionId),
            distinctProviderAssetRowIds.length === 0
              ? undefined
              : notInArray(
                  schema.providerAssetTransactionUses.providerAssetRowId,
                  distinctProviderAssetRowIds
                )
          )
        )
        .pipe(
          wrapSyncEngineSqlError(
            "sourceNormalizationRepository.syncProviderAssetTransactionUses.deleteStale"
          )
        )

      if (distinctProviderAssetRowIds.length === 0) {
        return
      }

      yield* executor
        .insert(schema.providerAssetTransactionUses)
        .values(
          distinctProviderAssetRowIds.map((providerAssetRowId) => ({
            providerAssetRowId,
            transactionId,
            sourceId,
            createdAt: now,
            updatedAt: now,
          }))
        )
        .onConflictDoNothing({
          target: [
            schema.providerAssetTransactionUses.providerAssetRowId,
            schema.providerAssetTransactionUses.transactionId,
          ],
        })
        .pipe(
          wrapSyncEngineSqlError(
            "sourceNormalizationRepository.syncProviderAssetTransactionUses.insert"
          )
        )
    })

  const upsertProviderTransfers = ({
    executor,
    transactionId,
    providerTransfers,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly transactionId: string
    readonly providerTransfers: ReadonlyArray<LinkedSourceProviderTransferInput>
  }) =>
    Effect.forEach(providerTransfers, ({ draft, linked: providerTransfer }) =>
      Effect.gen(function* () {
        const now = nowDate()
        const incomingObservedRepresentationIsAbsent = sql`
          excluded.observed_blockchain_id is null
          and excluded.observed_representation_type is null
          and excluded.observed_contract_address is null
          and excluded.observed_mint_address is null
          and excluded.observed_decimals is null
        `
        const incomingTransferIsAccountingOnly = sql`
          excluded.processing_mode = 'accounting_only'
        `
        const incomingObservedRepresentationMatchesStoredIdentity = sql`
          excluded.observed_blockchain_id is not null
          and excluded.observed_blockchain_id = ${schema.providerTransfers.observedBlockchainId}
          and excluded.observed_contract_address is not distinct from ${schema.providerTransfers.observedContractAddress}
          and excluded.observed_mint_address is not distinct from ${schema.providerTransfers.observedMintAddress}
          and (
            excluded.observed_representation_type is null
            or ${schema.providerTransfers.observedRepresentationType} is null
            or excluded.observed_representation_type = ${schema.providerTransfers.observedRepresentationType}
          )
        `
        const [persisted] = yield* executor
          .insert(schema.providerTransfers)
          .values({
            ...providerTransfer,
            transactionId,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [schema.providerTransfers.sourceId, schema.providerTransfers.externalId],
            targetWhere: sql`${schema.providerTransfers.externalId} is not null`,
            set: {
              sourceRawRecordId: sql.raw("excluded.source_raw_record_id"),
              transactionId: sql.raw("excluded.transaction_id"),
              externalGroupId: sql.raw("excluded.external_group_id"),
              providerAssetId: sql.raw("excluded.provider_asset_id"),
              sourceRepresentationUseId: sql`case
                when ${incomingTransferIsAccountingOnly} then null
                when ${incomingObservedRepresentationIsAbsent} or (
                  ${incomingObservedRepresentationMatchesStoredIdentity}
                  and excluded.observed_representation_type is null
                )
                then ${schema.providerTransfers.sourceRepresentationUseId}
                else excluded.source_representation_use_id
              end`,
              timestamp: sql.raw("excluded.timestamp"),
              direction: sql.raw("excluded.direction"),
              processingMode: sql.raw("excluded.processing_mode"),
              fromAccountRef: sql.raw("excluded.from_account_ref"),
              toAccountRef: sql.raw("excluded.to_account_ref"),
              fromAddress: sql.raw("excluded.from_address"),
              toAddress: sql.raw("excluded.to_address"),
              networkName: sql.raw("excluded.network_name"),
              networkHash: sql.raw("excluded.network_hash"),
              observedBlockchainId: sql`case
                when ${incomingTransferIsAccountingOnly} then null
                when ${incomingObservedRepresentationIsAbsent}
                then ${schema.providerTransfers.observedBlockchainId}
                else excluded.observed_blockchain_id
              end`,
              observedRepresentationType: sql`case
                when ${incomingTransferIsAccountingOnly} then null
                when ${incomingObservedRepresentationIsAbsent} or (
                  ${incomingObservedRepresentationMatchesStoredIdentity}
                  and excluded.observed_representation_type is null
                )
                then ${schema.providerTransfers.observedRepresentationType}
                else excluded.observed_representation_type
              end`,
              observedContractAddress: sql`case
                when ${incomingTransferIsAccountingOnly} then null
                when ${incomingObservedRepresentationIsAbsent}
                then ${schema.providerTransfers.observedContractAddress}
                else excluded.observed_contract_address
              end`,
              observedMintAddress: sql`case
                when ${incomingTransferIsAccountingOnly} then null
                when ${incomingObservedRepresentationIsAbsent}
                then ${schema.providerTransfers.observedMintAddress}
                else excluded.observed_mint_address
              end`,
              observedDecimals: sql`case
                when ${incomingTransferIsAccountingOnly} then null
                when ${incomingObservedRepresentationIsAbsent} or (
                  ${incomingObservedRepresentationMatchesStoredIdentity}
                  and excluded.observed_decimals is null
                )
                then ${schema.providerTransfers.observedDecimals}
                else excluded.observed_decimals
              end`,
              amount: sql.raw("excluded.amount"),
              metadata: sql`case
                when (
                  not (${incomingTransferIsAccountingOnly})
                  and (
                    ${incomingObservedRepresentationIsAbsent}
                    or ${incomingObservedRepresentationMatchesStoredIdentity}
                  )
                )
                  and excluded.observed_decimals is null
                  and ${schema.providerTransfers.observedDecimals} is not null
                  and excluded.amount = ${schema.providerTransfers.amount}
                then ${schema.providerTransfers.metadata}
                else excluded.metadata
              end`,
              updatedAt: now,
            },
          })
          .returning(selectPersistedProviderTransferFields)
          .pipe(wrapSyncEngineSqlError("sourceNormalizationRepository.upsertProviderTransfers"))

        if (persisted === undefined) {
          return yield* toSyncEngineStorageError({
            operation: "sourceNormalizationRepository.upsertProviderTransfers",
            error: "failed to persist provider transfer",
          })
        }

        const amount = yield* decodeNumericString({
          value: persisted.amount,
          operation: "sourceNormalizationRepository.upsertProviderTransfers.amount",
        })

        const persistedProviderTransfer = {
          ...persisted,
          amount,
        } satisfies PersistedSourceProviderTransfer

        return {
          draft,
          persisted: persistedProviderTransfer,
        } as const
      })
    ).pipe(
      Effect.map((pairs) => ({
        providerTransfers: pairs.map(({ persisted }) => persisted),
        providerTransferByDraft: new Map(
          pairs.map(({ draft, persisted }) => [draft, persisted] as const)
        ),
      }))
    )

  const recordMovementTarget = ({
    executor,
    leg,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly leg: LinkedSourceTransactionLegDraft
  }) =>
    Effect.gen(function* () {
      const identity = leg.movementIdentity
      if (identity._tag !== "identified") {
        return yield* toSyncEngineStorageError({
          operation: "sourceNormalizationRepository.recordMovementTarget",
          error: "An unidentified movement passed the transaction withholding check",
        })
      }
      const target = schema.movementCorrectionTargets
      yield* executor
        .insert(target)
        .values({
          sourceId: leg.sourceId,
          principalId: leg.principalId,
          sourceRecordKey: identity.sourceRecordKey,
          componentKey: identity.componentKey,
        })
        .onConflictDoNothing({
          target: [target.sourceId, target.sourceRecordKey, target.componentKey],
        })
        .pipe(wrapSyncEngineSqlError("sourceNormalizationRepository.recordMovementTarget.insert"))
      const [recorded] = yield* executor
        .select({ id: target.id })
        .from(target)
        .where(
          and(
            eq(target.sourceId, leg.sourceId),
            eq(target.principalId, leg.principalId),
            eq(target.sourceRecordKey, identity.sourceRecordKey),
            eq(target.componentKey, identity.componentKey)
          )
        )
        .pipe(wrapSyncEngineSqlError("sourceNormalizationRepository.recordMovementTarget.read"))
      if (recorded === undefined) {
        return yield* toSyncEngineStorageError({
          operation: "sourceNormalizationRepository.recordMovementTarget",
          error: "The movement target does not belong to the leg's source and principal",
        })
      }
      return recorded.id
    })

  const upsertTransactionLegs = ({
    executor,
    legs,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly legs: ReadonlyArray<LinkedSourceTransactionLegDraft>
  }) =>
    Effect.forEach(legs, (leg) =>
      Effect.gen(function* () {
        const movementCorrectionTargetId = yield* recordMovementTarget({ executor, leg })
        const now = nowDate()
        const [persisted] = yield* executor
          .insert(schema.transactionLegs)
          .values({
            ...leg,
            movementCorrectionTargetId,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: schema.transactionLegs.movementCorrectionTargetId,
            set: {
              externalId: sql.raw("excluded.external_id"),
              sourceRawRecordId: sql.raw("excluded.source_raw_record_id"),
              txHash: sql.raw("excluded.tx_hash"),
              timestamp: sql.raw("excluded.timestamp"),
              principalId: sql.raw("excluded.principal_id"),
              addressId: sql.raw("excluded.address_id"),
              assetId: sql.raw("excluded.asset_id"),
              assetRepresentationId: sql.raw("excluded.asset_representation_id"),
              sourceRepresentationUseId: sql.raw("excluded.source_representation_use_id"),
              providerAssetRowId: sql.raw("excluded.provider_asset_row_id"),
              amount: sql.raw("excluded.amount"),
              kind: sql.raw("excluded.kind"),
              provenance: sql.raw("excluded.provenance"),
              derivationRule: sql.raw("excluded.derivation_rule"),
              metadata: sql.raw("excluded.metadata"),
              transactionId: sql.raw("excluded.transaction_id"),
              originKind: sql.raw("excluded.origin_kind"),
              providerTransferId: sql.raw("excluded.provider_transfer_id"),
              sourceTransferId: sql.raw("excluded.source_transfer_id"),
              fiatAmount: sql.raw("excluded.fiat_amount"),
              fiatCurrency: sql.raw("excluded.fiat_currency"),
              feeForTransactionId: sql.raw("excluded.fee_for_transaction_id"),
              updatedAt: now,
            },
          })
          .returning(selectPersistedLegFields)
          .pipe(wrapSyncEngineSqlError("sourceNormalizationRepository.upsertTransactionLegs"))

        if (persisted === undefined) {
          return yield* toSyncEngineStorageError({
            operation: "sourceNormalizationRepository.upsertTransactionLegs",
            error: "failed to persist transaction leg",
          })
        }

        const amount = yield* decodeNumericString({
          value: persisted.amount,
          operation: "sourceNormalizationRepository.upsertTransactionLegs.amount",
        })
        const fiatAmount =
          persisted.fiatAmount === null
            ? null
            : yield* decodeNumericString({
                value: persisted.fiatAmount,
                operation: "sourceNormalizationRepository.upsertTransactionLegs.fiatAmount",
              })

        return {
          ...persisted,
          amount,
          fiatAmount,
        } satisfies PersistedSourceLegRecord
      })
    )

  const finalizeTransactionLegOrigins = ({
    legs,
    providerTransfers,
  }: {
    readonly legs: ReadonlyArray<
      SourceTransactionLegDraft & {
        readonly sourceRepresentationUseId: string | null
        readonly providerAssetRowId: string | null
      }
    >
    readonly providerTransfers: ReadonlyArray<PersistedSourceProviderTransfer>
  }): Effect.Effect<ReadonlyArray<LinkedSourceTransactionLegDraft>, SyncEngineStorageError> => {
    const providerTransferById = new Map(
      providerTransfers.map((providerTransfer) => [providerTransfer.id, providerTransfer] as const)
    )

    return Effect.forEach(legs, (leg) => {
      const originKind =
        leg.originKind ?? (leg.sourceTransferId === null ? null : "canonical_transfer")
      if (originKind === null) {
        return Effect.fail(
          toSyncEngineStorageError({
            operation: "sourceNormalizationRepository.finalizeTransactionLegOrigins.kind",
            error: `Leg ${leg.externalId ?? "without external id"} has no explicit transfer origin kind`,
          })
        )
      }

      const providerTransferId = leg.providerTransferId ?? null
      const originIsValid =
        (originKind === "provider_transfer" &&
          providerTransferId !== null &&
          leg.sourceTransferId === null &&
          leg.transactionId !== null) ||
        (originKind === "canonical_transfer" &&
          providerTransferId === null &&
          leg.sourceTransferId !== null) ||
        (originKind === "none" && providerTransferId === null && leg.sourceTransferId === null)

      if (!originIsValid) {
        return Effect.fail(
          toSyncEngineStorageError({
            operation: "sourceNormalizationRepository.finalizeTransactionLegOrigins.links",
            error: `Leg ${leg.externalId ?? "without external id"} has transfer links that do not match ${originKind}`,
          })
        )
      }

      if (providerTransferId !== null) {
        const providerTransfer = providerTransferById.get(providerTransferId)
        if (
          providerTransfer === undefined ||
          providerTransfer.sourceId !== leg.sourceId ||
          providerTransfer.transactionId !== leg.transactionId
        ) {
          return Effect.fail(
            toSyncEngineStorageError({
              operation: "sourceNormalizationRepository.finalizeTransactionLegOrigins.scope",
              error: `Provider transfer ${providerTransferId} does not belong to leg source ${leg.sourceId} and transaction ${leg.transactionId ?? "null"}`,
            })
          )
        }
      }

      return Effect.succeed({ ...leg, originKind, providerTransferId })
    })
  }

  const upsertTransactionReview = ({
    executor,
    transactionId,
    transactionReview,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly transactionId: string
    readonly transactionReview: SourceTransactionReviewDraft | null
  }) =>
    transactionReview === null
      ? executor
          .delete(schema.transactionReviews)
          .where(eq(schema.transactionReviews.transactionId, transactionId))
          .pipe(
            wrapSyncEngineSqlError("sourceNormalizationRepository.upsertTransactionReview.delete"),
            Effect.asVoid
          )
      : Effect.gen(function* () {
          const now = nowDate()
          yield* executor
            .insert(schema.transactionReviews)
            .values({
              transactionId,
              principalId: transactionReview.principalId,
              reviewStatus: transactionReview.reviewStatus,
              originalTypeKey: transactionReview.originalTypeKey,
              originalConfidence: transactionReview.originalConfidence,
              currentTypeKey: transactionReview.currentTypeKey,
              legalRuleSetVersion: transactionReview.legalRuleSetVersion,
              categorizationReason: transactionReview.categorizationReason,
              matchedLayer: transactionReview.matchedLayer,
              needsReview: transactionReview.needsReview,
              userNotes: transactionReview.userNotes,
              reviewedAt: transactionReview.reviewedAt,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: schema.transactionReviews.transactionId,
              set: {
                reviewStatus: sql.raw("excluded.review_status"),
                originalTypeKey: sql.raw("excluded.original_type_key"),
                originalConfidence: sql.raw("excluded.original_confidence"),
                currentTypeKey: sql.raw("excluded.current_type_key"),
                legalRuleSetVersion: sql.raw("excluded.legal_rule_set_version"),
                categorizationReason: sql.raw("excluded.categorization_reason"),
                matchedLayer: sql.raw("excluded.matched_layer"),
                needsReview: sql.raw("excluded.needs_review"),
                userNotes: sql.raw("excluded.user_notes"),
                reviewedAt: sql.raw("excluded.reviewed_at"),
                updatedAt: now,
              },
            })
            .pipe(
              wrapSyncEngineSqlError("sourceNormalizationRepository.upsertTransactionReview.upsert")
            )
        })

  const recordSourceRepresentationUses = ({
    executor,
    providerTransfers,
    assetRepresentationIds,
    sourceId,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly providerTransfers: ReadonlyArray<SourceProviderTransferDraft>
    readonly assetRepresentationIds: ReadonlyArray<string>
    readonly sourceId: string
  }) =>
    Effect.gen(function* () {
      const observedRepresentations = new Map<string, SourceRepresentationUseTarget>()
      const targetKeyByAssetRepresentationId = new Map<string, string>()

      for (const transfer of providerTransfers) {
        if (
          transfer.observedBlockchainId === null ||
          transfer.observedBlockchainId === undefined ||
          transfer.observedRepresentationType === null ||
          transfer.observedRepresentationType === undefined
        ) {
          continue
        }

        const representation = {
          sourceId,
          blockchainId: transfer.observedBlockchainId,
          representationType: transfer.observedRepresentationType,
          contractAddress: canonicalizeAddress(transfer.observedContractAddress ?? null),
          mintAddress: canonicalizeAddress(transfer.observedMintAddress ?? null),
        } as const
        observedRepresentations.set(sourceRepresentationUseKey(representation), representation)
      }

      const uniqueRepresentationIds = [...new Set(assetRepresentationIds)]
      const storedRepresentations =
        uniqueRepresentationIds.length === 0
          ? []
          : yield* executor
              .select({
                id: schema.assetRepresentations.id,
                blockchainId: schema.assetRepresentations.blockchainId,
                representationType: schema.assetRepresentations.type,
                contractAddress: schema.assetRepresentations.contractAddress,
                mintAddress: schema.assetRepresentations.mintAddress,
              })
              .from(schema.assetRepresentations)
              .where(inArray(schema.assetRepresentations.id, uniqueRepresentationIds))
              .pipe(
                wrapSyncEngineSqlError(
                  "sourceNormalizationRepository.recordSourceRepresentationUses.loadRepresentations"
                )
              )

      for (const storedRepresentation of storedRepresentations) {
        const representation = {
          sourceId,
          blockchainId: storedRepresentation.blockchainId,
          representationType: storedRepresentation.representationType,
          contractAddress: storedRepresentation.contractAddress,
          mintAddress: storedRepresentation.mintAddress,
        } as const
        const targetKey = sourceRepresentationUseKey(representation)
        observedRepresentations.set(targetKey, representation)
        targetKeyByAssetRepresentationId.set(storedRepresentation.id, targetKey)
      }

      if (observedRepresentations.size === 0) {
        return {
          idByAssetRepresentationId: new Map(),
          idByTargetKey: new Map(),
        } satisfies RecordedSourceRepresentationUses
      }

      const now = nowDate()
      yield* executor
        .insert(schema.sourceRepresentationUses)
        .values(
          Array.from(observedRepresentations.values(), (representation) => ({
            ...representation,
            createdAt: now,
            updatedAt: now,
          }))
        )
        .onConflictDoNothing()
        .pipe(
          wrapSyncEngineSqlError("sourceNormalizationRepository.recordSourceRepresentationUses")
        )

      const recordedUses = yield* executor
        .select({
          id: schema.sourceRepresentationUses.id,
          sourceId: schema.sourceRepresentationUses.sourceId,
          blockchainId: schema.sourceRepresentationUses.blockchainId,
          representationType: schema.sourceRepresentationUses.representationType,
          contractAddress: schema.sourceRepresentationUses.contractAddress,
          mintAddress: schema.sourceRepresentationUses.mintAddress,
        })
        .from(schema.sourceRepresentationUses)
        .where(
          and(
            eq(schema.sourceRepresentationUses.sourceId, sourceId),
            or(
              ...Array.from(observedRepresentations.values(), (representation) =>
                and(
                  eq(schema.sourceRepresentationUses.blockchainId, representation.blockchainId),
                  eq(
                    schema.sourceRepresentationUses.representationType,
                    representation.representationType
                  ),
                  representation.contractAddress === null
                    ? isNull(schema.sourceRepresentationUses.contractAddress)
                    : eq(
                        schema.sourceRepresentationUses.contractAddress,
                        representation.contractAddress
                      ),
                  representation.mintAddress === null
                    ? isNull(schema.sourceRepresentationUses.mintAddress)
                    : eq(schema.sourceRepresentationUses.mintAddress, representation.mintAddress)
                )
              )
            )
          )
        )
        .pipe(
          wrapSyncEngineSqlError(
            "sourceNormalizationRepository.recordSourceRepresentationUses.loadRecordedUses"
          )
        )
      const idByTargetKey = new Map(
        recordedUses.map((recordedUse) => [sourceRepresentationUseKey(recordedUse), recordedUse.id])
      )
      const idByAssetRepresentationId = new Map<string, string>()
      for (const [assetRepresentationId, targetKey] of targetKeyByAssetRepresentationId) {
        const sourceRepresentationUseId = idByTargetKey.get(targetKey)
        if (sourceRepresentationUseId !== undefined) {
          idByAssetRepresentationId.set(assetRepresentationId, sourceRepresentationUseId)
        }
      }

      return {
        idByAssetRepresentationId,
        idByTargetKey,
      } satisfies RecordedSourceRepresentationUses
    })

  const sourceRepresentationUseIdForAssetRepresentation = ({
    assetRepresentationId,
    recordedUses,
    operation,
  }: {
    readonly assetRepresentationId: string | null | undefined
    readonly recordedUses: RecordedSourceRepresentationUses
    readonly operation: string
  }) => {
    if (assetRepresentationId === null || assetRepresentationId === undefined) {
      return Effect.succeed(null)
    }

    const sourceRepresentationUseId =
      recordedUses.idByAssetRepresentationId.get(assetRepresentationId)
    return sourceRepresentationUseId === undefined
      ? toSyncEngineStorageError({
          operation,
          error: `No source representation use was recorded for asset representation ${assetRepresentationId}`,
        })
      : Effect.succeed(sourceRepresentationUseId)
  }

  const sourceRepresentationUseIdForProviderTransfer = ({
    sourceId,
    transfer,
    recordedUses,
  }: {
    readonly sourceId: string
    readonly transfer: SourceProviderTransferDraft
    readonly recordedUses: RecordedSourceRepresentationUses
  }) => {
    if (
      transfer.observedBlockchainId === null ||
      transfer.observedBlockchainId === undefined ||
      transfer.observedRepresentationType === null ||
      transfer.observedRepresentationType === undefined
    ) {
      return Effect.succeed(null)
    }

    const targetKey = sourceRepresentationUseKey({
      sourceId,
      blockchainId: transfer.observedBlockchainId,
      representationType: transfer.observedRepresentationType,
      contractAddress: canonicalizeAddress(transfer.observedContractAddress ?? null),
      mintAddress: canonicalizeAddress(transfer.observedMintAddress ?? null),
    })
    const sourceRepresentationUseId = recordedUses.idByTargetKey.get(targetKey)
    return sourceRepresentationUseId === undefined
      ? toSyncEngineStorageError({
          operation:
            "sourceNormalizationRepository.persistNormalizedArtifacts.providerTransferTarget",
          error: `No source representation use was recorded for provider transfer ${transfer.externalId ?? transfer.networkHash ?? "without identity"}`,
        })
      : Effect.succeed(sourceRepresentationUseId)
  }

  const removeInventoryMovementsForTransaction = ({
    executor,
    transactionId,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly transactionId: string
  }) =>
    executor
      .delete(schema.inventoryMovements)
      .where(eq(schema.inventoryMovements.transactionId, transactionId))
      .pipe(
        wrapSyncEngineSqlError(
          "sourceNormalizationRepository.removeInventoryMovementsForTransaction.deleteMovements"
        )
      )

  const removeInventoryMovementForProviderTransfer = ({
    executor,
    providerTransferId,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly providerTransferId: string
  }) =>
    executor
      .delete(schema.inventoryMovements)
      .where(eq(schema.inventoryMovements.providerTransferId, providerTransferId))
      .pipe(
        wrapSyncEngineSqlError(
          "sourceNormalizationRepository.removeInventoryMovementForProviderTransfer.deleteMovement"
        )
      )

  const removeStaleProviderInventoryMovements = ({
    executor,
    transactionId,
    currentProviderTransferIds,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly transactionId: string
    readonly currentProviderTransferIds: ReadonlySet<string>
  }) =>
    Effect.gen(function* () {
      const movements = yield* executor
        .select({ providerTransferId: schema.inventoryMovements.providerTransferId })
        .from(schema.inventoryMovements)
        .where(
          and(
            eq(schema.inventoryMovements.transactionId, transactionId),
            sql`${schema.inventoryMovements.providerTransferId} is not null`
          )
        )
        .pipe(
          wrapSyncEngineSqlError(
            "sourceNormalizationRepository.removeStaleProviderInventoryMovements.selectMovements"
          )
        )

      yield* Effect.forEach(
        movements.flatMap(({ providerTransferId }) =>
          providerTransferId !== null && !currentProviderTransferIds.has(providerTransferId)
            ? [providerTransferId]
            : []
        ),
        (providerTransferId) =>
          removeInventoryMovementForProviderTransfer({
            executor,
            providerTransferId,
          })
      )
    })

  const clearStaleObservedProviderTransferRepresentations = ({
    executor,
    transactionId,
    currentProviderTransferIds,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly transactionId: string
    readonly currentProviderTransferIds: ReadonlySet<string>
  }) =>
    Effect.gen(function* () {
      const providerTransfers = yield* executor
        .select({
          id: schema.providerTransfers.id,
          reconciliationStatus: schema.transferReconciliations.status,
        })
        .from(schema.providerTransfers)
        .leftJoin(
          schema.transferReconciliations,
          eq(schema.transferReconciliations.providerTransferId, schema.providerTransfers.id)
        )
        .where(eq(schema.providerTransfers.transactionId, transactionId))
        .pipe(
          wrapSyncEngineSqlError(
            "sourceNormalizationRepository.clearStaleObservedProviderTransferRepresentations.selectTransfers"
          )
        )

      yield* Effect.forEach(
        providerTransfers.filter(({ id }) => !currentProviderTransferIds.has(id)),
        ({ id, reconciliationStatus }) =>
          Effect.gen(function* () {
            if (reconciliationStatus === "auto_applied" || reconciliationStatus === "approved") {
              return yield* new SyncEngineStorageError({
                operation:
                  "sourceNormalizationRepository.clearStaleObservedProviderTransferRepresentations.activeReconciliation",
                cause: {
                  providerTransferId: id,
                  reconciliationStatus,
                  message:
                    "Cannot remove observed provider transfer evidence while its reconciliation is active.",
                },
              })
            }

            yield* executor
              .update(schema.providerTransfers)
              .set({
                observedBlockchainId: null,
                observedRepresentationType: null,
                observedContractAddress: null,
                observedMintAddress: null,
                observedDecimals: null,
                sourceRepresentationUseId: null,
                processingMode: "stale",
                updatedAt: nowDate(),
              })
              .where(eq(schema.providerTransfers.id, id))
              .pipe(
                wrapSyncEngineSqlError(
                  "sourceNormalizationRepository.clearStaleObservedProviderTransferRepresentations.clearTransfer"
                )
              )
          })
      )
    })

  const persistProviderInventoryMovements = ({
    decisions,
    executor,
    transaction,
    providerTransfers,
    feesOnly,
  }: {
    readonly decisions: PrincipalAssetOverrideDecisions
    readonly executor: SourceNormalizationExecutor
    readonly transaction: PersistedSourceTransaction
    readonly providerTransfers: ReadonlyArray<PersistedSourceProviderTransfer>
    readonly feesOnly: boolean
  }) => {
    const orderedProviderTransfers = [
      ...providerTransfers.filter((providerTransfer) => providerTransfer.direction === "inbound"),
      ...providerTransfers.filter((providerTransfer) => providerTransfer.direction === "outbound"),
    ]

    return Effect.forEach(orderedProviderTransfers, (providerTransfer) =>
      Effect.gen(function* () {
        if (
          providerTransfer.processingMode === "evidence_only" ||
          providerTransfer.processingMode === "stale"
        ) {
          return yield* removeInventoryMovementForProviderTransfer({
            executor,
            providerTransferId: providerTransfer.id,
          })
        }

        const metadata = yield* decodeProviderTransferMetadata(providerTransfer.metadata)
        const purpose = metadata.purpose

        if (feesOnly && purpose !== "fee") {
          return yield* removeInventoryMovementForProviderTransfer({
            executor,
            providerTransferId: providerTransfer.id,
          })
        }

        if (providerTransfer.providerAssetId === null) {
          return yield* removeInventoryMovementForProviderTransfer({
            executor,
            providerTransferId: providerTransfer.id,
          })
        }

        const [assetMapping] = yield* executor
          .select({
            assetId: schema.providerAssetMappings.canonicalAssetId,
            assetRepresentationId: schema.providerAssetMappings.assetRepresentationId,
            mappingStatus: schema.providerAssetMappings.mappingStatus,
          })
          .from(schema.providerAssetMappings)
          .where(
            and(
              eq(schema.providerAssetMappings.providerAssetRowId, providerTransfer.providerAssetId),
              eq(schema.providerAssetMappings.mappingKind, "asset")
            )
          )
          .limit(1)
          .pipe(
            wrapSyncEngineSqlError(
              "sourceNormalizationRepository.persistProviderInventoryMovements.assetMapping"
            )
          )

        const exactDecision =
          providerTransfer.sourceRepresentationUseId === null
            ? undefined
            : decisions.sourceRepresentationUseDecisionById.get(
                providerTransfer.sourceRepresentationUseId
              )
        const providerDecision = decisions.providerAssetDecisionById.get(
          providerTransfer.providerAssetId
        )
        const systemAssetId =
          exactDecision === undefined
            ? (providerDecision?.systemAssetId ??
              (assetMapping?.mappingStatus === "approved" ? assetMapping.assetId : null))
            : exactDecision.systemAssetId
        const principalAssetId =
          exactDecision === undefined
            ? providerDecision?.effectiveDecision._tag === "included"
              ? providerDecision.effectiveDecision.assetId
              : systemAssetId
            : (exactDecision.identityReplacementAssetId ?? systemAssetId)
        const assetId = purpose === "fee" ? systemAssetId : principalAssetId

        if (assetId === null || assetId === undefined) {
          return yield* removeInventoryMovementForProviderTransfer({
            executor,
            providerTransferId: providerTransfer.id,
          })
        }

        const [exactRepresentation] =
          providerTransfer.sourceRepresentationUseId === null
            ? []
            : yield* executor
                .select({
                  id: schema.assetRepresentations.id,
                  assetId: schema.assetRepresentations.assetId,
                })
                .from(schema.sourceRepresentationUses)
                .innerJoin(
                  schema.assetRepresentations,
                  and(
                    eq(
                      schema.assetRepresentations.blockchainId,
                      schema.sourceRepresentationUses.blockchainId
                    ),
                    eq(
                      schema.assetRepresentations.type,
                      schema.sourceRepresentationUses.representationType
                    ),
                    or(
                      and(
                        isNull(schema.assetRepresentations.contractAddress),
                        isNull(schema.sourceRepresentationUses.contractAddress)
                      ),
                      eq(
                        schema.assetRepresentations.contractAddress,
                        schema.sourceRepresentationUses.contractAddress
                      )
                    ),
                    or(
                      and(
                        isNull(schema.assetRepresentations.mintAddress),
                        isNull(schema.sourceRepresentationUses.mintAddress)
                      ),
                      eq(
                        schema.assetRepresentations.mintAddress,
                        schema.sourceRepresentationUses.mintAddress
                      )
                    )
                  )
                )
                .where(
                  eq(schema.sourceRepresentationUses.id, providerTransfer.sourceRepresentationUseId)
                )
                .limit(1)
                .pipe(
                  wrapSyncEngineSqlError(
                    "sourceNormalizationRepository.persistProviderInventoryMovements.exactRepresentation"
                  )
                )
        const assetRepresentationId =
          exactRepresentation?.assetId === assetId
            ? exactRepresentation.id
            : assetMapping?.assetId === assetId
              ? (assetMapping.assetRepresentationId ?? null)
              : null

        const now = nowDate()
        const [movement] = yield* executor
          .insert(schema.inventoryMovements)
          .values({
            principalId: transaction.principalId,
            sourceId: providerTransfer.sourceId,
            sourceRawRecordId: providerTransfer.sourceRawRecordId,
            transactionId: transaction.id,
            providerTransferId: providerTransfer.id,
            assetId,
            assetRepresentationId,
            timestamp: providerTransfer.timestamp,
            direction: providerTransfer.direction,
            purpose,
            taxTreatment: "pending_review",
            reconciliationStatus: "unmatched",
            amount: providerTransfer.amount,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: schema.inventoryMovements.providerTransferId,
            targetWhere: sql`${schema.inventoryMovements.providerTransferId} is not null`,
            set: {
              principalId: sql.raw("excluded.principal_id"),
              sourceRawRecordId: sql.raw("excluded.source_raw_record_id"),
              transactionId: sql.raw("excluded.transaction_id"),
              assetId: sql.raw("excluded.asset_id"),
              assetRepresentationId: sql.raw("excluded.asset_representation_id"),
              timestamp: sql.raw("excluded.timestamp"),
              direction: sql.raw("excluded.direction"),
              purpose: sql.raw("excluded.purpose"),
              reconciliationStatus: sql`case
                  when ${schema.inventoryMovements.sourceRawRecordId} is distinct from excluded.source_raw_record_id
                    or ${schema.inventoryMovements.transactionId} is distinct from excluded.transaction_id
                    or ${schema.inventoryMovements.assetId} is distinct from excluded.asset_id
                    or ${schema.inventoryMovements.assetRepresentationId} is distinct from excluded.asset_representation_id
                    or ${schema.inventoryMovements.timestamp} is distinct from excluded.timestamp
                    or ${schema.inventoryMovements.direction} is distinct from excluded.direction
                    or ${schema.inventoryMovements.purpose} is distinct from excluded.purpose
                    or ${schema.inventoryMovements.amount} is distinct from excluded.amount
                  then 'unmatched'::inventory_movement_reconciliation_status
                  else ${schema.inventoryMovements.reconciliationStatus}
                end`,
              amount: sql.raw("excluded.amount"),
              updatedAt: now,
            },
          })
          .returning({ id: schema.inventoryMovements.id })
          .pipe(
            wrapSyncEngineSqlError(
              "sourceNormalizationRepository.persistProviderInventoryMovements.upsertMovement"
            )
          )

        if (movement === undefined) {
          return yield* toSyncEngineStorageError({
            operation:
              "sourceNormalizationRepository.persistProviderInventoryMovements.upsertMovement",
            error: "failed to persist inventory movement",
          })
        }
      })
    )
  }

  const persistFeeInventoryMovements = ({
    executor,
    legs,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly legs: ReadonlyArray<{
      readonly leg: PersistedSourceLegRecord
      readonly systemAssetId: string | null
    }>
  }) =>
    Effect.forEach(
      legs.filter(({ leg }) => leg.kind === "fee"),
      ({ leg, systemAssetId }) =>
        Effect.gen(function* () {
          if (systemAssetId === null) {
            yield* executor
              .delete(schema.inventoryMovements)
              .where(eq(schema.inventoryMovements.transactionLegId, leg.id))
              .pipe(
                wrapSyncEngineSqlError(
                  "sourceNormalizationRepository.persistFeeInventoryMovements.deleteUnresolvedSystemAsset"
                )
              )
            return
          }

          const amountComparison = yield* compareDecimalStrings({
            left: leg.amount,
            right: "0",
          })

          if (amountComparison === 0) {
            yield* executor
              .delete(schema.inventoryMovements)
              .where(eq(schema.inventoryMovements.transactionLegId, leg.id))
              .pipe(
                wrapSyncEngineSqlError(
                  "sourceNormalizationRepository.persistFeeInventoryMovements.deleteZeroMovement"
                )
              )
            return
          }

          if (leg.transactionId === null) {
            return yield* toSyncEngineStorageError({
              operation: "sourceNormalizationRepository.persistFeeInventoryMovements.transactionId",
              error: "fee leg is missing its transaction",
            })
          }

          const now = nowDate()
          const [movement] = yield* executor
            .insert(schema.inventoryMovements)
            .values({
              principalId: leg.principalId,
              sourceId: leg.sourceId,
              sourceRawRecordId: leg.sourceRawRecordId,
              transactionId: leg.transactionId,
              providerTransferId: null,
              transactionLegId: leg.id,
              assetId: systemAssetId,
              assetRepresentationId: leg.assetRepresentationId,
              timestamp: leg.timestamp,
              direction: "outbound",
              purpose: "fee",
              taxTreatment: "pending_review",
              reconciliationStatus: "unmatched",
              amount: leg.amount,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: schema.inventoryMovements.transactionLegId,
              targetWhere: sql`${schema.inventoryMovements.transactionLegId} is not null`,
              set: {
                principalId: sql.raw("excluded.principal_id"),
                sourceRawRecordId: sql.raw("excluded.source_raw_record_id"),
                transactionId: sql.raw("excluded.transaction_id"),
                assetId: sql.raw("excluded.asset_id"),
                assetRepresentationId: sql.raw("excluded.asset_representation_id"),
                timestamp: sql.raw("excluded.timestamp"),
                reconciliationStatus: sql`case
                  when ${schema.inventoryMovements.sourceRawRecordId} is distinct from excluded.source_raw_record_id
                    or ${schema.inventoryMovements.transactionId} is distinct from excluded.transaction_id
                    or ${schema.inventoryMovements.assetId} is distinct from excluded.asset_id
                    or ${schema.inventoryMovements.assetRepresentationId} is distinct from excluded.asset_representation_id
                    or ${schema.inventoryMovements.timestamp} is distinct from excluded.timestamp
                    or ${schema.inventoryMovements.amount} is distinct from excluded.amount
                  then 'unmatched'::inventory_movement_reconciliation_status
                  else ${schema.inventoryMovements.reconciliationStatus}
                end`,
                amount: sql.raw("excluded.amount"),
                updatedAt: now,
              },
            })
            .returning({ id: schema.inventoryMovements.id })
            .pipe(
              wrapSyncEngineSqlError(
                "sourceNormalizationRepository.persistFeeInventoryMovements.upsertMovement"
              )
            )

          if (movement === undefined) {
            return yield* toSyncEngineStorageError({
              operation:
                "sourceNormalizationRepository.persistFeeInventoryMovements.upsertMovement",
              error: "failed to persist fee inventory movement",
            })
          }
        })
    )

  const preparePrincipalAssetDecisionApplication = ({
    overrideHistorySnapshot,
    derivationDecisions,
    canonicalTransfers,
    derivedLegs,
    resolvedDerivationTargets,
    persistedProviderTransfers,
    linkedCanonicalTransfers,
  }: {
    readonly overrideHistorySnapshot: PrincipalAssetOverrideHistorySnapshot
    readonly derivationDecisions: PrincipalAssetOverrideDecisions
    readonly canonicalTransfers: ReadonlyArray<{ readonly assetRepresentationId?: string | null }>
    readonly derivedLegs: ReadonlyArray<
      SourceTransactionLegDraft & { readonly sourceRepresentationUseId: string | null }
    >
    readonly resolvedDerivationTargets: ReadonlyArray<SourceProviderAssetDecisionTarget>
    readonly persistedProviderTransfers: ReadonlyArray<PersistedSourceProviderTransfer>
    readonly linkedCanonicalTransfers: ReadonlyArray<LinkedSourceTransferDraft>
  }) =>
    Effect.gen(function* () {
      const sourceRepresentationUseIds = [
        ...persistedProviderTransfers.flatMap((providerTransfer) =>
          providerTransfer.sourceRepresentationUseId === null ||
          providerTransfer.processingMode === "evidence_only" ||
          providerTransfer.processingMode === "stale"
            ? []
            : [providerTransfer.sourceRepresentationUseId]
        ),
        ...linkedCanonicalTransfers.flatMap(({ sourceRepresentationUseId }) =>
          sourceRepresentationUseId === null ? [] : [sourceRepresentationUseId]
        ),
        ...derivedLegs.flatMap(({ sourceRepresentationUseId }) =>
          sourceRepresentationUseId === null ? [] : [sourceRepresentationUseId]
        ),
        ...resolvedDerivationTargets.flatMap((target) =>
          target._tag === "provider_transfer" && target.sourceRepresentationUseId !== null
            ? [target.sourceRepresentationUseId]
            : []
        ),
      ]
      const exactDecisions = yield* principalAssetOverrideDecisionLoader.loadFromSnapshot({
        snapshot: overrideHistorySnapshot,
        assetRepresentationIds: [...canonicalTransfers, ...derivedLegs].flatMap(
          ({ assetRepresentationId }) =>
            assetRepresentationId === null || assetRepresentationId === undefined
              ? []
              : [assetRepresentationId]
        ),
        sourceRepresentationUseIds,
        providerAssetRowIds: [],
      })
      const decisions = includeExactPrincipalAssetDecisions({
        decisions: derivationDecisions,
        exactDecisions,
      })
      return { decisions, sourceRepresentationUseIds }
    })

  const includeExactPrincipalAssetDecisions = ({
    decisions,
    exactDecisions,
  }: {
    readonly decisions: PrincipalAssetOverrideDecisions
    readonly exactDecisions: PrincipalAssetOverrideDecisions
  }): PrincipalAssetOverrideDecisions => ({
    ...decisions,
    assetIdByRepresentationId: new Map([
      ...decisions.assetIdByRepresentationId,
      ...exactDecisions.assetIdByRepresentationId,
    ]),
    systemAssetIdByRepresentationId: new Map([
      ...decisions.systemAssetIdByRepresentationId,
      ...exactDecisions.systemAssetIdByRepresentationId,
    ]),
    sourceRepresentationUseDecisionById: new Map([
      ...decisions.sourceRepresentationUseDecisionById,
      ...exactDecisions.sourceRepresentationUseDecisionById,
    ]),
  })

  const persistNormalizedArtifacts = <E>(
    params: PersistNormalizedSourceArtifactsParams<E>
  ): Effect.Effect<
    PersistNormalizedSourceArtifactsResult,
    E | SyncEngineStorageError | SourceSyncCreditExhaustedError
  > =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const networkMovementLockKeys = [
            ...new Set(
              params.providerTransfers
                .filter(
                  (providerTransfer) =>
                    providerTransfer.networkHash !== null &&
                    providerTransfer.networkHash.trim() !== ""
                )
                .map(
                  (providerTransfer) =>
                    `${params.transaction.principalId}:${providerTransfer.networkName?.toLowerCase() ?? ""}:${providerTransfer.networkHash?.toLowerCase() ?? ""}`
                )
            ),
          ].sort()
          yield* Effect.forEach(
            networkMovementLockKeys,
            (lockKey) =>
              tx
                .execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`)
                .pipe(
                  wrapSyncEngineSqlError(
                    "sourceNormalizationRepository.persistNormalizedArtifacts.lockNetworkMovement"
                  )
                ),
            { concurrency: 1, discard: true }
          )

          // The write changes no value, but advances the tuple version. A concurrent override
          // mutation with an older SERIALIZABLE snapshot must then use its existing retry path.
          const [ownedPrincipal] = yield* tx
            .update(schema.principals)
            .set({ updatedAt: sql`${schema.principals.updatedAt}` })
            .where(eq(schema.principals.id, params.transaction.principalId))
            .returning({ id: schema.principals.id })
            .pipe(
              wrapSyncEngineSqlError(
                "sourceNormalizationRepository.persistNormalizedArtifacts.lockPrincipal"
              )
            )

          if (ownedPrincipal === undefined) {
            return yield* toSyncEngineStorageError({
              operation: "sourceNormalizationRepository.persistNormalizedArtifacts.lockPrincipal",
              error: `Principal ${params.transaction.principalId} no longer exists`,
            })
          }

          const overrideHistorySnapshot = yield* principalAssetOverrideDecisionLoader.loadHistory({
            principalId: params.transaction.principalId,
          })

          const [ownedSource] = yield* tx
            .select({ id: schema.sources.id })
            .from(schema.sources)
            .where(
              and(
                eq(schema.sources.id, params.transaction.sourceId),
                eq(schema.sources.principalId, params.transaction.principalId)
              )
            )
            .limit(1)
            .for("update")
            .pipe(
              wrapSyncEngineSqlError(
                "sourceNormalizationRepository.persistNormalizedArtifacts.lockSourceInventory"
              )
            )

          if (ownedSource === undefined) {
            return yield* toSyncEngineStorageError({
              operation:
                "sourceNormalizationRepository.persistNormalizedArtifacts.lockSourceInventory",
              error: `Source ${params.transaction.sourceId} is no longer owned by principal ${params.transaction.principalId}`,
            })
          }

          if (params.beforePersist !== undefined) {
            yield* params.beforePersist
          }

          const initialDecisions = yield* principalAssetOverrideDecisionLoader.loadFromSnapshot({
            snapshot: overrideHistorySnapshot,
            providerAssetRowIds: [
              ...params.providerAssetRowIds,
              ...params.providerTransfers.flatMap(({ providerAssetId }) =>
                providerAssetId === null ? [] : [providerAssetId]
              ),
            ],
            assetRepresentationIds: [
              ...params.canonicalTransfers,
              ...("legs" in params ? params.legs : []),
            ].flatMap(({ assetRepresentationId }) =>
              assetRepresentationId === null || assetRepresentationId === undefined
                ? []
                : [assetRepresentationId]
            ),
          })
          const canonicalTransfers = params.canonicalTransfers.map((transfer) => ({
            ...transfer,
            assetId: resolvePrincipalAssetId({
              decisions: initialDecisions,
              systemAssetId: transfer.assetId,
              assetRepresentationId: transfer.assetRepresentationId,
              providerAssetRowId: transfer.providerAssetRowId,
            }),
          }))

          const persistedTransaction = yield* upsertTransaction({
            executor: tx,
            transaction: params.transaction,
          })
          yield* consumeTransactionCredit({
            executor: tx,
            externalId: persistedTransaction.externalId,
            mode: "persist",
            principalId: persistedTransaction.principalId,
            replayReservationId: params.replayReservationId ?? null,
            sourceId: persistedTransaction.sourceId,
            sourceRawRecordId: persistedTransaction.sourceRawRecordId,
          })
          const persistedVenueContext = yield* upsertVenueContext({
            executor: tx,
            venueContext: {
              ...params.venueContext,
              transactionId: persistedTransaction.id,
            },
          })
          yield* upsertOnchainContext({
            executor: tx,
            transactionId: persistedTransaction.id,
            onchainContext: params.onchainContext,
          })
          yield* syncProviderAssetTransactionUses({
            executor: tx,
            transactionId: persistedTransaction.id,
            sourceId: persistedTransaction.sourceId,
            providerAssetRowIds: params.providerAssetRowIds,
          })
          const recordedUses = yield* recordSourceRepresentationUses({
            executor: tx,
            providerTransfers: params.providerTransfers,
            assetRepresentationIds: [
              ...canonicalTransfers,
              ...("legs" in params ? params.legs : []),
            ].flatMap(({ assetRepresentationId }) =>
              assetRepresentationId === null || assetRepresentationId === undefined
                ? []
                : [assetRepresentationId]
            ),
            sourceId: persistedTransaction.sourceId,
          })
          const linkedProviderTransfers = yield* Effect.forEach(
            params.providerTransfers,
            (providerTransfer) =>
              Effect.map(
                sourceRepresentationUseIdForProviderTransfer({
                  sourceId: persistedTransaction.sourceId,
                  transfer: providerTransfer,
                  recordedUses,
                }),
                (sourceRepresentationUseId) => ({
                  draft: providerTransfer,
                  linked: {
                    ...providerTransfer,
                    sourceRepresentationUseId,
                  },
                })
              )
          )
          const linkedCanonicalTransfers = yield* Effect.forEach(canonicalTransfers, (transfer) =>
            Effect.map(
              sourceRepresentationUseIdForAssetRepresentation({
                assetRepresentationId: transfer.assetRepresentationId,
                recordedUses,
                operation:
                  "sourceNormalizationRepository.persistNormalizedArtifacts.canonicalTransferTarget",
              }),
              (sourceRepresentationUseId) => ({
                ...transfer,
                sourceRepresentationUseId,
                providerAssetRowId: transfer.providerAssetRowId ?? null,
              })
            )
          )
          const { providerTransfers: persistedProviderTransfers, providerTransferByDraft } =
            yield* upsertProviderTransfers({
              executor: tx,
              transactionId: persistedTransaction.id,
              providerTransfers: linkedProviderTransfers,
            })
          const preDerivationSourceRepresentationUseIds = persistedProviderTransfers.flatMap(
            ({ sourceRepresentationUseId }) =>
              sourceRepresentationUseId === null ? [] : [sourceRepresentationUseId]
          )
          const persistedExactDecisions =
            yield* principalAssetOverrideDecisionLoader.loadFromSnapshot({
              snapshot: overrideHistorySnapshot,
              assetRepresentationIds: canonicalTransfers.flatMap(({ assetRepresentationId }) =>
                assetRepresentationId === null || assetRepresentationId === undefined
                  ? []
                  : [assetRepresentationId]
              ),
              sourceRepresentationUseIds: preDerivationSourceRepresentationUseIds,
              providerAssetRowIds: [],
            })
          const derivationDecisions = includeExactPrincipalAssetDecisions({
            decisions: initialDecisions,
            exactDecisions: persistedExactDecisions,
          })
          const persistedCanonicalTransfers = yield* upsertCanonicalTransfers({
            executor: tx,
            canonicalTransfers: linkedCanonicalTransfers,
          })
          const systemCanonicalTransfers = persistedCanonicalTransfers.map((transfer) => ({
            ...transfer,
            assetId: resolveCanonicalTransferSystemAssetId({
              decisions: derivationDecisions,
              transfer,
            }),
          }))
          const candidateLinkedCanonicalTransfers: Array<
            SourceTransferDraft & {
              readonly sourceRepresentationUseId: string | null
              readonly providerAssetRowId: string | null
            }
          > = []
          const persistedCandidateCanonicalTransfers: PersistedSourceTransfer[] = []
          const attemptedCandidateIdentities: SourceProviderAssetTransferCandidateIdentity[] = []
          const resolvedDerivationTargets: SourceProviderAssetDecisionTarget[] = []
          const derivationTechnicalBlockers: PrincipalAssetTechnicalBlocker[] = []
          const recordedTransactionReviewWithoutProviderAssetMapping: {
            value:
              | { readonly _tag: "not_recorded" }
              | {
                  readonly _tag: "recorded"
                  readonly review: SourceTransactionReviewDraft | null
                }
          } = { value: { _tag: "not_recorded" } }
          const resolveDerivationProviderAssetDecision = (
            target: SourceProviderAssetDecisionTarget
          ) => {
            resolvedDerivationTargets.push(target)
            return resolveSourceProviderAssetDecision({
              decisions: derivationDecisions,
              target,
            })
          }
          const persistProviderAssetTransferCandidate = (
            candidate: SourceProviderAssetTransferCandidate
          ) =>
            Effect.gen(function* () {
              const decision = resolveDerivationProviderAssetDecision(candidate.target)
              if (decision._tag !== "included") return decision

              const linkedCandidate = {
                ...candidate.transfer,
                assetId: decision.assetId,
                providerAssetRowId: candidate.target.providerAssetRowId,
                sourceRepresentationUseId: null,
              }
              const [persistedCandidate] = yield* upsertCanonicalTransfers({
                executor: tx,
                canonicalTransfers: [linkedCandidate],
              })
              if (persistedCandidate === undefined) {
                return yield* toSyncEngineStorageError({
                  operation:
                    "sourceNormalizationRepository.persistNormalizedArtifacts.persistProviderAssetTransferCandidate",
                  error: "failed to persist writer-built provider asset transfer candidate",
                })
              }

              candidateLinkedCanonicalTransfers.push(linkedCandidate)
              persistedCandidateCanonicalTransfers.push(persistedCandidate)

              return {
                _tag: "included",
                transfer: {
                  ...persistedCandidate,
                  assetId: resolveCanonicalTransferSystemAssetId({
                    decisions: derivationDecisions,
                    transfer: persistedCandidate,
                  }),
                },
              } as const
            })
          const derivedLegs =
            "deriveLegs" in params
              ? yield* params.deriveLegs({
                  transaction: persistedTransaction,
                  venueContext: persistedVenueContext,
                  providerTransfers: persistedProviderTransfers,
                  providerTransferByDraft,
                  canonicalTransfers: systemCanonicalTransfers,
                  resolveProviderAssetDecision: resolveDerivationProviderAssetDecision,
                  persistProviderAssetTransferCandidate,
                  recordProviderAssetTransferCandidateIdentity: (identity) => {
                    attemptedCandidateIdentities.push(identity)
                  },
                  recordTransactionReviewWithoutProviderAssetMapping: (review) => {
                    recordedTransactionReviewWithoutProviderAssetMapping.value = {
                      _tag: "recorded",
                      review,
                    }
                  },
                  withholdAccountingFacts: (reason) => {
                    derivationTechnicalBlockers.push(reason)
                  },
                })
              : params.legs
          // Validate producer facts before any accounting leg or inventory movement is written.
          // Duplicate explicit components are ambiguous; rows are never matched to discover identity.
          const movementKeys = new Map<string, Set<string>>()
          let movementIdentityIssue:
            | "missing_movement_identity"
            | "ambiguous_movement_identity"
            | null = null
          for (const leg of derivedLegs) {
            const decoded = Schema.decodeOption(SourceMovementIdentity)(leg.movementIdentity)
            if (
              Option.isNone(decoded) ||
              leg.sourceId !== persistedTransaction.sourceId ||
              leg.principalId !== persistedTransaction.principalId
            ) {
              movementIdentityIssue = "missing_movement_identity"
              break
            }
            const identity = decoded.value
            if (identity._tag === "unavailable") {
              movementIdentityIssue = identity.reason
              break
            }
            const components = movementKeys.get(identity.sourceRecordKey) ?? new Set<string>()
            if (components.has(identity.componentKey)) {
              movementIdentityIssue = "ambiguous_movement_identity"
              break
            }
            components.add(identity.componentKey)
            movementKeys.set(identity.sourceRecordKey, components)
          }
          if (movementIdentityIssue !== null) derivationTechnicalBlockers.push("malformed_movement")

          const derivedLegAssetRepresentationIds = derivedLegs.flatMap(
            ({ assetRepresentationId }) =>
              assetRepresentationId === null || assetRepresentationId === undefined
                ? []
                : [assetRepresentationId]
          )
          const derivedLegRecordedUses = yield* recordSourceRepresentationUses({
            executor: tx,
            providerTransfers: [],
            assetRepresentationIds: derivedLegAssetRepresentationIds,
            sourceId: persistedTransaction.sourceId,
          })
          const sourceTransferIds = [
            ...new Set(
              derivedLegs.flatMap(({ sourceTransferId }) =>
                sourceTransferId === null ? [] : [sourceTransferId]
              )
            ),
          ]
          const sourceTransferTargets =
            sourceTransferIds.length === 0
              ? []
              : yield* tx
                  .select({
                    id: schema.transfers.id,
                    sourceRepresentationUseId: schema.transfers.sourceRepresentationUseId,
                    providerAssetRowId: schema.transfers.providerAssetRowId,
                  })
                  .from(schema.transfers)
                  .where(inArray(schema.transfers.id, sourceTransferIds))
                  .pipe(
                    wrapSyncEngineSqlError(
                      "sourceNormalizationRepository.persistNormalizedArtifacts.loadSourceTransferTargets"
                    )
                  )
          const sourceTransferTargetById = new Map(
            sourceTransferTargets.map((target) => [target.id, target])
          )
          const providerTransferTargetById = new Map(
            persistedProviderTransfers.map((providerTransfer) => [
              providerTransfer.id,
              providerTransfer,
            ])
          )
          const linkedLegTargets = yield* Effect.forEach(derivedLegs, (leg) =>
            Effect.gen(function* () {
              const sourceTransferTarget =
                leg.sourceTransferId === null
                  ? undefined
                  : sourceTransferTargetById.get(leg.sourceTransferId)
              const providerTransferTarget =
                leg.providerTransferId === null || leg.providerTransferId === undefined
                  ? undefined
                  : providerTransferTargetById.get(leg.providerTransferId)
              const sourceRepresentationUseId =
                leg.assetRepresentationId === null || leg.assetRepresentationId === undefined
                  ? (sourceTransferTarget?.sourceRepresentationUseId ??
                    providerTransferTarget?.sourceRepresentationUseId ??
                    null)
                  : yield* sourceRepresentationUseIdForAssetRepresentation({
                      assetRepresentationId: leg.assetRepresentationId,
                      recordedUses: derivedLegRecordedUses,
                      operation:
                        "sourceNormalizationRepository.persistNormalizedArtifacts.legTarget",
                    })

              return {
                ...leg,
                sourceRepresentationUseId,
                providerAssetRowId:
                  leg.providerAssetRowId ??
                  sourceTransferTarget?.providerAssetRowId ??
                  providerTransferTarget?.providerAssetId ??
                  null,
              }
            })
          )
          const { decisions: completeDecisions, sourceRepresentationUseIds } =
            yield* preparePrincipalAssetDecisionApplication({
              overrideHistorySnapshot,
              derivationDecisions,
              canonicalTransfers: [...canonicalTransfers, ...candidateLinkedCanonicalTransfers],
              derivedLegs: linkedLegTargets,
              resolvedDerivationTargets,
              persistedProviderTransfers,
              linkedCanonicalTransfers: [
                ...linkedCanonicalTransfers,
                ...candidateLinkedCanonicalTransfers,
              ],
            })
          const providerDecisionResult = applyPrincipalProviderAssetDecisions({
            decisions: completeDecisions,
            legs: linkedLegTargets,
            providerAssetRowIds: params.providerAssetRowIds,
            providerTransfers: persistedProviderTransfers,
            resolvedDerivationTargets,
            sourceRepresentationUseIds,
            derivationTechnicalBlockers,
          })
          if (providerDecisionResult.withholdsAccountingFacts) {
            yield* tx
              .delete(schema.transactionLegs)
              .where(eq(schema.transactionLegs.transactionId, persistedTransaction.id))
              .pipe(
                wrapSyncEngineSqlError(
                  "sourceNormalizationRepository.persistNormalizedArtifacts.removeWithheldTransactionLegs"
                )
              )
            if (attemptedCandidateIdentities.length > 0) {
              yield* tx
                .delete(schema.transfers)
                .where(
                  or(
                    ...attemptedCandidateIdentities.map(({ externalId, sourceId }) =>
                      and(
                        eq(schema.transfers.sourceId, sourceId),
                        eq(schema.transfers.externalId, externalId)
                      )
                    )
                  )
                )
                .pipe(
                  wrapSyncEngineSqlError(
                    "sourceNormalizationRepository.persistNormalizedArtifacts.removeWithheldCandidateTransfers"
                  )
                )
            }
          }
          const retainedCandidateCanonicalTransfers =
            providerDecisionResult.withholdsAccountingFacts
              ? []
              : persistedCandidateCanonicalTransfers
          const effectiveLegs = providerDecisionResult.legs
          const linkedLegs = yield* finalizeTransactionLegOrigins({
            legs: effectiveLegs,
            providerTransfers: persistedProviderTransfers,
          })
          const persistedLegs = yield* upsertTransactionLegs({
            executor: tx,
            legs: linkedLegs,
          })
          const persistedLegsWithSystemAssets = yield* Effect.forEach(persistedLegs, (leg, index) =>
            Effect.gen(function* () {
              const feeCustodyAssetId = providerDecisionResult.feeCustodyAssetIds[index]
              if (feeCustodyAssetId === undefined) {
                return yield* toSyncEngineStorageError({
                  operation:
                    "sourceNormalizationRepository.persistNormalizedArtifacts.legSystemAsset",
                  error: "persisted leg has no matching system asset",
                })
              }
              return { leg, systemAssetId: feeCustodyAssetId }
            })
          )

          const hasCompletedStatus = hasCompletedProviderStatus(params.transaction.providerStatus)
          const hasFailedStatus = hasFailedProviderStatus(params.transaction.providerStatus)
          const materializesProviderMovements =
            (hasCompletedStatus || hasFailedStatus) &&
            !providerDecisionResult.withholdsAccountingFacts
          const currentProviderTransferIds = new Set(
            persistedProviderTransfers.map((providerTransfer) => providerTransfer.id)
          )

          yield* clearStaleObservedProviderTransferRepresentations({
            executor: tx,
            transactionId: persistedTransaction.id,
            currentProviderTransferIds,
          })

          if (materializesProviderMovements) {
            yield* removeStaleProviderInventoryMovements({
              executor: tx,
              transactionId: persistedTransaction.id,
              currentProviderTransferIds,
            })
            yield* persistProviderInventoryMovements({
              decisions: completeDecisions,
              executor: tx,
              transaction: persistedTransaction,
              providerTransfers: persistedProviderTransfers,
              feesOnly: hasFailedStatus,
            })
            yield* persistFeeInventoryMovements({
              executor: tx,
              legs: persistedLegsWithSystemAssets,
            })
          } else {
            yield* removeInventoryMovementsForTransaction({
              executor: tx,
              transactionId: persistedTransaction.id,
            })
          }

          const resolvedProviderMappingReview =
            providerDecisionResult.resolvesProviderAssetMappingReview &&
            !providerDecisionResult.withholdsAccountingFacts &&
            recordedTransactionReviewWithoutProviderAssetMapping.value._tag === "recorded"
              ? recordedTransactionReviewWithoutProviderAssetMapping.value.review
              : params.transactionReview
          const principalExclusionReview = providerDecisionResult.hasPrincipalExclusion
            ? withPrincipalAssetExclusionReview({
                principalId: persistedTransaction.principalId,
                transactionType: params.transaction.transactionType,
                review: resolvedProviderMappingReview,
              })
            : resolvedProviderMappingReview
          const unresolvedIdentityReview = providerDecisionResult.hasUnresolvedIdentity
            ? withPrincipalAssetUnresolvedIdentityReview({
                principalId: persistedTransaction.principalId,
                transactionType: params.transaction.transactionType,
                review: principalExclusionReview,
              })
            : principalExclusionReview
          const technicalBlockerReview =
            providerDecisionResult.technicalBlockers.length === 0
              ? unresolvedIdentityReview
              : withPrincipalAssetTechnicalBlockerReview({
                  principalId: persistedTransaction.principalId,
                  transactionType: params.transaction.transactionType,
                  review: unresolvedIdentityReview,
                  technicalBlockers: providerDecisionResult.technicalBlockers,
                })

          yield* upsertTransactionReview({
            executor: tx,
            transactionId: persistedTransaction.id,
            transactionReview:
              movementIdentityIssue === null
                ? technicalBlockerReview
                : {
                    principalId: persistedTransaction.principalId,
                    reviewStatus: "needs_review",
                    originalTypeKey: params.transaction.transactionType,
                    originalConfidence: null,
                    currentTypeKey: params.transaction.transactionType,
                    legalRuleSetVersion: null,
                    matchedLayer: "movement_identity",
                    categorizationReason: movementIdentityIssue,
                    needsReview: true,
                    userNotes: technicalBlockerReview?.userNotes ?? null,
                    reviewedAt: null,
                  },
          })
          if (persistedTransaction.sourceRawRecordId !== null) {
            yield* tx
              .update(schema.sourceRecordsRaw)
              .set({
                normalizedAt: nowDate(),
                normalizationError: null,
                updatedAt: nowDate(),
              })
              .where(eq(schema.sourceRecordsRaw.id, persistedTransaction.sourceRawRecordId))
              .pipe(
                wrapSyncEngineSqlError(
                  "sourceNormalizationRepository.persistNormalizedArtifacts.markRawRecordNormalized"
                )
              )
          }

          return {
            transaction: persistedTransaction,
            venueContext: persistedVenueContext,
            providerTransfers: persistedProviderTransfers,
            canonicalTransfers: [
              ...persistedCanonicalTransfers,
              ...retainedCandidateCanonicalTransfers,
            ],
            legs: persistedLegs,
          }
        })
      )
      .pipe(
        wrapPreservingCreditExhausted("sourceNormalizationRepository.persistNormalizedArtifacts")
      )

  const reserveReplayTransactionCredits: SourceNormalizationRepositoryShape["reserveReplayTransactionCredits"] =
    ({ reservationId, transactions }) =>
      db
        .transaction((tx) =>
          Effect.forEach(
            transactions,
            (transaction) =>
              consumeTransactionCredit({
                executor: tx,
                externalId: transaction.externalId,
                mode: "reserve",
                principalId: transaction.principalId,
                replayReservationId: reservationId,
                sourceId: transaction.sourceId,
                sourceRawRecordId: transaction.sourceRawRecordId,
              }),
            { concurrency: 1 }
          ).pipe(
            Effect.map((references) =>
              references.flatMap((reference, index) =>
                reference === null
                  ? []
                  : [
                      {
                        reference,
                        sourceRawRecordId: transactions[index]?.sourceRawRecordId ?? null,
                      },
                    ]
              )
            )
          )
        )
        .pipe(
          wrapPreservingCreditExhausted(
            "sourceNormalizationRepository.reserveReplayTransactionCredits"
          )
        )

  const releaseReplayTransactionCredits: SourceNormalizationRepositoryShape["releaseReplayTransactionCredits"] =
    ({ references, reservationId }) =>
      references.length === 0
        ? Effect.void
        : db
            .delete(schema.creditLedger)
            .where(
              and(
                eq(schema.creditLedger.kind, "transaction_usage"),
                eq(schema.creditLedger.replayReservationId, reservationId),
                inArray(schema.creditLedger.reference, references)
              )
            )
            .pipe(
              wrapSyncEngineStorageError(
                "sourceNormalizationRepository.releaseReplayTransactionCredits"
              )
            )

  return SourceNormalizationRepository.of({
    reserveReplayTransactionCredits,
    releaseReplayTransactionCredits,
    persistNormalizedArtifacts,
  } satisfies SourceNormalizationRepositoryShape)
})

export const SourceNormalizationRepositoryLive = Layer.effect(SourceNormalizationRepository, make)
