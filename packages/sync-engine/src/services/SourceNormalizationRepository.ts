/**
 * SourceNormalizationRepository - Canonical persistence contract for normalized source artifacts.
 *
 * @module SourceNormalizationRepository
 */

import { SyncCreditReasonCode } from "@my/core/billing"
import type { PrincipalAssetTechnicalBlocker } from "@my/core/assets"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { ResolvedProviderTransactionTypeMapping } from "./ProviderReferenceRepository.ts"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"

/**
 * SourceSyncCreditExhaustedError - A registered user's transaction credits ran out mid-sync.
 *
 * Distinct from `SyncEngineStorageError` so callers can route it to a resumable
 * credit-required outcome instead of a generic sync failure.
 */
export class SourceSyncCreditExhaustedError extends Schema.TaggedError<SourceSyncCreditExhaustedError>()(
  "SourceSyncCreditExhaustedError",
  {
    reasonCode: SyncCreditReasonCode,
    availableCredits: Schema.Finite,
  }
) {}

/**
 * SourceTransferType - Canonical transfer types persisted during normalization.
 */
export type SourceTransferType =
  | "erc20"
  | "erc721"
  | "erc1155"
  | "internal"
  | "native"
  | "spl"
  | "utxo"
  | "cex"
  | "dex"
  | "fiat"
  | "funding"
  | "reward"
  | "fee"

/**
 * SourceLegKind - Accounting kind for canonical transaction legs.
 */
export type SourceLegKind = "acquisition" | "disposal" | "income" | "fee"

/**
 * SourceLegProvenance - Derivation provenance for canonical transaction legs.
 */
export type SourceLegProvenance = "deterministic" | "rule" | "ai" | "manual"

/** SourceLegOriginKind - Exact factual transfer origin recorded for a leg. */
export type SourceLegOriginKind = "provider_transfer" | "canonical_transfer" | "none"

/**
 * SourceProviderTransferDirection - Direction for durable provider-side movements.
 */
export type SourceProviderTransferDirection = "inbound" | "outbound"

/**
 * SourceProviderTransferProcessingMode - How a provider movement participates in
 * accounting and observed-transfer reconciliation.
 */
export type SourceProviderTransferProcessingMode =
  | "accounting_and_evidence"
  | "accounting_only"
  | "evidence_only"
  | "stale"

/**
 * ReviewStatus - Canonical review lifecycle values used when persisting transaction reviews.
 */
export type ReviewStatus = "auto_applied" | "needs_review" | "approved" | "changed"

/**
 * SourceTransactionDraft - Canonical transaction envelope upsert payload.
 */
export interface SourceTransactionDraft {
  readonly sourceId: string
  readonly sourceRawRecordId: string | null
  readonly externalId: string | null
  readonly externalGroupId: string | null
  readonly timestamp: Date
  readonly transactionType: string | null
  readonly providerTransactionType: string | null
  readonly providerStatus: string | null
  readonly providerResourcePath: string | null
  readonly providerDescription: string | null
  readonly providerCreatedAt: Date | null
  readonly providerUpdatedAt: Date | null
  readonly metadata: unknown
  /** Provider-reported fiat value of the whole transaction, as a decimal string, or null. */
  readonly providerFiatAmount: string | null
  /** Uppercase currency code of the provider-reported fiat value, or null. */
  readonly providerFiatCurrency: string | null
  readonly principalId: string
}

/**
 * SourceVenueContextDraft - Canonical venue context upsert payload.
 */
export interface SourceVenueContextDraft {
  readonly venueType: "cex" | "dex"
  readonly cexAccountId: string | null
  readonly externalAccountId: string | null
  readonly externalOrderId: string | null
  readonly externalFillId: string | null
  readonly side: string | null
  readonly instrument: string | null
  readonly fillPrice: string | null
  readonly commissionAmount: string | null
  readonly commissionCurrency: string | null
  readonly metadata: unknown
}

/**
 * SourceOnchainContextDraft - Chain-specific transaction context persisted next
 * to the canonical transaction envelope.
 */
export interface SourceOnchainContextDraft {
  readonly blockchainId: string
  readonly addressId: string
  readonly chainTxId: string
  readonly blockHeight: string | null
  readonly blockHash: string | null
  readonly positionInBlock: string | null
  readonly fromAddress: string
  readonly toAddress: string | null
  readonly gasUsed: string | null
  readonly gasPrice: string | null
  readonly feeAmount: string | null
  readonly feeAssetId: string | null
  readonly feeCostBasisAmount: string | null
  readonly feeCostBasisCurrency: string | null
  readonly isError: boolean
  readonly functionName: string | null
  readonly metadata: unknown
}

/**
 * SourceTransferDraft - Canonical transfer upsert payload.
 */
export interface SourceTransferDraft {
  readonly sourceId: string
  readonly principalId: string
  readonly sourceRawRecordId: string | null
  readonly externalId: string | null
  readonly externalGroupId: string | null
  readonly addressId: string | null
  readonly blockchainId: string | null
  readonly txHash: string | null
  readonly timestamp: Date
  readonly type: SourceTransferType
  readonly fromAddress: string | null
  readonly toAddress: string | null
  readonly fromAccountRef: string | null
  readonly toAccountRef: string | null
  readonly fromPartyType: string | null
  readonly fromPartyResourcePath: string | null
  readonly toPartyType: string | null
  readonly toPartyResourcePath: string | null
  readonly assetId: string
  readonly assetRepresentationId?: string | null
  /** Exact provider asset row used to derive this transfer, when present. */
  readonly providerAssetRowId?: string | null
  readonly amount: string
  readonly tokenId: string | null
  readonly notes: string | null
  readonly metadata: unknown
}

/**
 * SourceProviderTransferDraft - Provider-side principal movement payload persisted
 * before canonical asset mapping or reconciliation is complete.
 */
export interface SourceProviderTransferDraft {
  readonly sourceId: string
  readonly sourceRawRecordId: string | null
  readonly externalId: string | null
  readonly externalGroupId: string | null
  readonly providerAssetId: string | null
  readonly timestamp: Date
  readonly direction: SourceProviderTransferDirection
  readonly processingMode: SourceProviderTransferProcessingMode
  readonly fromAccountRef: string | null
  readonly toAccountRef: string | null
  readonly fromAddress: string | null
  readonly toAddress: string | null
  readonly networkName: string | null
  readonly networkHash: string | null
  readonly observedBlockchainId?: string | null
  readonly observedRepresentationType?: "native" | "token" | "nft" | null
  readonly observedContractAddress?: string | null
  readonly observedMintAddress?: string | null
  readonly observedDecimals?: number | null
  readonly amount: string
  readonly metadata: unknown
}

/** Producer-recorded source component, or an explicit reason identity cannot be supplied. */
export const SourceMovementIdentity = Schema.Union([
  Schema.TaggedStruct("identified", {
    sourceRecordKey: Schema.Trimmed.check(Schema.isNonEmpty()),
    componentKey: Schema.Trimmed.check(Schema.isNonEmpty()),
  }),
  Schema.TaggedStruct("unavailable", {
    reason: Schema.Literals(["missing_movement_identity", "ambiguous_movement_identity"]),
  }),
])
export type SourceMovementIdentity = typeof SourceMovementIdentity.Type

/**
 * SourceTransactionLegDraft - Canonical transaction leg upsert payload.
 */
export interface SourceTransactionLegDraft {
  readonly movementIdentity: SourceMovementIdentity
  readonly sourceId: string
  readonly sourceRawRecordId: string | null
  readonly externalId: string | null
  readonly txHash: string | null
  readonly timestamp: Date
  readonly principalId: string
  readonly addressId: string | null
  readonly assetId: string
  readonly assetRepresentationId?: string | null
  readonly amount: string
  readonly kind: SourceLegKind
  readonly provenance: SourceLegProvenance
  readonly derivationRule: string | null
  /** Exact chainless provider observation used to derive this leg, when present. */
  readonly providerAssetRowId?: string | null
  readonly metadata: unknown
  readonly transactionId: string | null
  /**
   * Provider-derived and originless writers must state this explicitly. The persistence writer
   * records `canonical_transfer` for the already-explicit `sourceTransferId` path.
   */
  readonly originKind?: SourceLegOriginKind
  /** Exact persisted provider transfer that produced this leg. */
  readonly providerTransferId?: string | null
  readonly sourceTransferId: string | null
  readonly fiatAmount: string | null
  readonly fiatCurrency: string | null
  readonly feeForTransactionId: string | null
}

/**
 * SourceTransactionReviewDraft - Review row upsert payload for ambiguous records.
 */
export interface SourceTransactionReviewDraft {
  readonly principalId: string
  readonly reviewStatus: ReviewStatus
  readonly originalTypeKey: string | null
  readonly originalConfidence: string | null
  readonly currentTypeKey: string | null
  readonly legalRuleSetVersion: string | null
  readonly categorizationReason: string | null
  readonly matchedLayer: string | null
  readonly needsReview: boolean
  readonly userNotes: string | null
  readonly reviewedAt: Date | null
}

/**
 * PersistedSourceTransaction - Persisted transaction projection required by follow-up steps.
 */
export interface PersistedSourceTransaction {
  readonly id: string
  readonly sourceId: string
  readonly sourceRawRecordId: string | null
  readonly externalId: string | null
  readonly timestamp: Date
  readonly providerTransactionType: string | null
  readonly metadata: unknown
  readonly principalId: string
}

/**
 * PersistedSourceVenueContext - Persisted venue context projection required by leg derivation.
 */
export interface PersistedSourceVenueContext {
  readonly transactionId: string
  readonly side: string | null
  readonly instrument: string | null
  readonly fillPrice: string | null
}

/**
 * PersistedSourceTransfer - Persisted fee transfer projection required by leg derivation.
 */
export interface PersistedSourceTransfer {
  readonly id: string
  readonly sourceId: string
  readonly sourceRawRecordId: string | null
  readonly externalId: string | null
  readonly txHash: string | null
  readonly timestamp: Date
  readonly addressId: string | null
  readonly assetId: string
  readonly assetRepresentationId: string | null
  readonly providerAssetRowId?: string | null
  readonly amount: string
  readonly type: SourceTransferType
  readonly metadata?: unknown
}

/**
 * PersistedSourceProviderTransfer - Persisted provider-side movement projection required
 * by reconciliation and review flows.
 */
export interface PersistedSourceProviderTransfer {
  readonly id: string
  readonly sourceId: string
  readonly sourceRawRecordId: string | null
  readonly transactionId: string
  readonly externalId: string | null
  readonly externalGroupId: string | null
  readonly providerAssetId: string | null
  readonly sourceRepresentationUseId: string | null
  readonly timestamp: Date
  readonly direction: SourceProviderTransferDirection
  readonly processingMode: SourceProviderTransferProcessingMode
  readonly fromAccountRef: string | null
  readonly toAccountRef: string | null
  readonly fromAddress: string | null
  readonly toAddress: string | null
  readonly networkName: string | null
  readonly networkHash: string | null
  readonly observedBlockchainId: string | null
  readonly observedRepresentationType: "native" | "token" | "nft" | null
  readonly observedContractAddress: string | null
  readonly observedMintAddress: string | null
  readonly observedDecimals: number | null
  readonly amount: string
  readonly metadata: unknown
}

/**
 * PersistedSourceLeg - Persisted leg projection used for FIFO side effects.
 */
export interface PersistedSourceLeg {
  readonly movementCorrectionTargetId: string
  readonly id: string
  readonly sourceId: string
  readonly timestamp: Date
  readonly principalId: string
  readonly assetId: string
  readonly assetRepresentationId: string | null
  readonly amount: string
  readonly kind: SourceLegKind
  readonly fiatAmount: string | null
  readonly fiatCurrency: string | null
}

/**
 * PersistNormalizedSourceArtifactsResult - Persisted projections returned by the repository.
 */
export interface PersistNormalizedSourceArtifactsResult {
  readonly transaction: PersistedSourceTransaction
  readonly venueContext: PersistedSourceVenueContext
  readonly providerTransfers: ReadonlyArray<PersistedSourceProviderTransfer>
  readonly canonicalTransfers: ReadonlyArray<PersistedSourceTransfer>
  readonly legs: ReadonlyArray<PersistedSourceLeg>
}

/** Typed reason a principal-scoped provider asset cannot produce accounting facts. */
export type SourceProviderAssetBlockedReason =
  | {
      readonly _tag: "technical_blocker"
      readonly technicalBlockers: ReadonlyArray<PrincipalAssetTechnicalBlocker>
    }
  | { readonly _tag: "unresolved_identity" }

/** Principal-scoped provider asset decision available to in-transaction leg derivation. */
export type SourceProviderAssetDecision =
  | { readonly _tag: "included"; readonly assetId: string }
  | { readonly _tag: "excluded" }
  | {
      readonly _tag: "blocked"
      readonly reason: SourceProviderAssetBlockedReason
    }

/** Recorded target carried by the exact provider-transfer fact being derived. */
export type SourceProviderAssetDecisionTarget =
  | {
      readonly _tag: "provider_transfer"
      readonly providerAssetRowId: string
      readonly sourceRepresentationUseId: string | null
    }
  | {
      readonly _tag: "provider_asset_transaction_use"
      readonly providerAssetRowId: string
    }

/** Writer-built canonical transfer waiting for its effective provider-asset decision. */
export interface SourceProviderAssetTransferCandidate {
  readonly _tag: "provider_asset_transfer_candidate"
  readonly target: Extract<
    SourceProviderAssetDecisionTarget,
    { readonly _tag: "provider_asset_transaction_use" }
  >
  readonly transfer: Omit<SourceTransferDraft, "assetId" | "providerAssetRowId">
}

/** Stable writer-supplied identity for a canonical transfer candidate in one source. */
export interface SourceProviderAssetTransferCandidateIdentity {
  readonly sourceId: string
  readonly externalId: string
}

/** Result of applying and persisting one writer-built transfer candidate. */
export type SourceProviderAssetTransferCandidateResult =
  | {
      readonly _tag: "included"
      /** Provider-derivation view; it uses system identity when one exists. */
      readonly transfer: PersistedSourceTransfer
    }
  | { readonly _tag: "excluded" }
  | {
      readonly _tag: "blocked"
      readonly reason: SourceProviderAssetBlockedReason
    }

/** Typed provider derivation outcome that withholds accounting facts without failing the raw row. */
export type SourceLegDerivationWithholdingReason = "malformed_movement"

/**
 * PersistNormalizedSourceArtifactsContext - Persisted pre-leg artifacts available
 * to provider-specific leg derivation inside the repository transaction.
 */
export interface PersistNormalizedSourceArtifactsContext {
  readonly transaction: PersistedSourceTransaction
  readonly venueContext: PersistedSourceVenueContext
  readonly providerTransfers: ReadonlyArray<PersistedSourceProviderTransfer>
  /** Direct association from each producer draft object to the row written for it. */
  readonly providerTransferByDraft: ReadonlyMap<
    SourceProviderTransferDraft,
    PersistedSourceProviderTransfer
  >
  readonly canonicalTransfers: ReadonlyArray<PersistedSourceTransfer>
  /** Resolves the principal's effective decision for the exact recorded provider-transfer fact. */
  readonly resolveProviderAssetDecision: (
    target: SourceProviderAssetDecisionTarget
  ) => SourceProviderAssetDecision
  /** Applies and persists one exact writer-built transfer candidate in this transaction. */
  readonly persistProviderAssetTransferCandidate: (
    candidate: SourceProviderAssetTransferCandidate
  ) => Effect.Effect<SourceProviderAssetTransferCandidateResult, SyncEngineStorageError>
  /** Records every writer-built transfer candidate before its decision is preflighted. */
  readonly recordProviderAssetTransferCandidateIdentity: (
    identity: SourceProviderAssetTransferCandidateIdentity
  ) => void
  /** Records the writer's review before provider-asset mapping details were added. */
  readonly recordTransactionReviewWithoutProviderAssetMapping: (
    review: SourceTransactionReviewDraft | null
  ) => void
  /** Records a provider-derived blocker while keeping the transaction and provider evidence. */
  readonly withholdAccountingFacts: (reason: SourceLegDerivationWithholdingReason) => void
}

/**
 * PersistNormalizedSourceArtifactsParamsBase - Shared normalized artifact inputs.
 */
export interface PersistNormalizedSourceArtifactsParamsBase {
  /** Replay reservation that this persistence call is allowed to finalize. */
  readonly replayReservationId?: string
  /**
   * Reserve related rows after persistence locks are held but before canonical artifacts are
   * written. The reservation shares this repository transaction and is rolled back on failure.
   */
  readonly beforePersist?: Effect.Effect<void, SyncEngineStorageError>
  readonly transaction: SourceTransactionDraft
  readonly venueContext: SourceVenueContextDraft
  readonly onchainContext?: SourceOnchainContextDraft | null | undefined
  readonly providerTransfers: ReadonlyArray<SourceProviderTransferDraft>
  readonly canonicalTransfers: ReadonlyArray<SourceTransferDraft>
  /**
   * Provider asset rows this transaction depends on, including currencies
   * that produce no provider transfer (for example exchange trade legs and
   * fees). Persisted as transaction-level uses so exception impact can count
   * every blocked transaction.
   */
  readonly providerAssetRowIds: ReadonlyArray<string>
  readonly transactionReview: SourceTransactionReviewDraft | null
  readonly resolvedTransactionType: ResolvedProviderTransactionTypeMapping
}

/**
 * PersistNormalizedSourceArtifactsWithLegsParams - Direct leg payload variant used
 * by repository-focused tests and pre-derived call sites.
 */
export interface PersistNormalizedSourceArtifactsWithLegsParams extends PersistNormalizedSourceArtifactsParamsBase {
  readonly legs: ReadonlyArray<SourceTransactionLegDraft>
}

/**
 * PersistNormalizedSourceArtifactsWithDerivationParams - Callback variant used by
 * orchestrators that must derive legs from persisted transaction and transfer ids.
 */
export interface PersistNormalizedSourceArtifactsWithDerivationParams<
  E,
> extends PersistNormalizedSourceArtifactsParamsBase {
  readonly deriveLegs: (
    context: PersistNormalizedSourceArtifactsContext
  ) => Effect.Effect<ReadonlyArray<SourceTransactionLegDraft>, E>
}

/**
 * PersistNormalizedSourceArtifactsParams - Atomic normalized artifact persistence input.
 */
export type PersistNormalizedSourceArtifactsParams<E> =
  | PersistNormalizedSourceArtifactsWithLegsParams
  | PersistNormalizedSourceArtifactsWithDerivationParams<E>

/** Stable transaction identity used to reserve replay credits before destructive reset work. */
export type ReplayTransactionCreditReservation = Pick<
  SourceTransactionDraft,
  "externalId" | "principalId" | "sourceId" | "sourceRawRecordId"
>

/** Credit usage inserted and owned by one replay job until persistence succeeds. */
export interface ReservedReplayTransactionCredit {
  readonly reference: string
  readonly sourceRawRecordId: string | null
}

/**
 * SourceNormalizationRepositoryShape - Atomic canonical write surface for normalized source artifacts.
 */
export interface SourceNormalizationRepositoryShape {
  /** Reserve every missing transaction credit atomically before a source replay resets state. */
  readonly reserveReplayTransactionCredits: (params: {
    readonly reservationId: string
    readonly transactions: ReadonlyArray<ReplayTransactionCreditReservation>
  }) => Effect.Effect<
    ReadonlyArray<ReservedReplayTransactionCredit>,
    SyncEngineStorageError | SourceSyncCreditExhaustedError
  >
  /** Release credits that are still owned by a failed replay reservation. */
  readonly releaseReplayTransactionCredits: (params: {
    readonly reservationId: string
    readonly references: ReadonlyArray<string>
  }) => Effect.Effect<void, SyncEngineStorageError>
  /**
   * Persist normalized canonical artifacts for one raw row, including review rows and FIFO side effects.
   */
  readonly persistNormalizedArtifacts: <E>(
    params: PersistNormalizedSourceArtifactsParams<E>
  ) => Effect.Effect<
    PersistNormalizedSourceArtifactsResult,
    E | SyncEngineStorageError | SourceSyncCreditExhaustedError
  >
}

/**
 * SourceNormalizationRepository - Context tag for normalized artifact persistence.
 */
export class SourceNormalizationRepository extends Context.Service<
  SourceNormalizationRepository,
  SourceNormalizationRepositoryShape
>()("SourceNormalizationRepository") {}
