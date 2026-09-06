/**
 * HeliusSolanaSourceSyncProvider - Provider-facing Helius Solana sync abstraction.
 *
 * @module HeliusSolanaSourceSyncProvider
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { ResolvedProviderTransactionTypeMapping } from "../../../services/ProviderReferenceRepository.ts"
import type {
  PersistedSourceTransaction,
  PersistedSourceTransfer,
  PersistedSourceVenueContext,
  SourceLegKind,
  SourceMovementIdentity,
  SourceProviderTransferDraft,
  SourceTransactionDraft,
  SourceTransactionLegDraft,
  SourceTransactionReviewDraft,
  SourceTransferDraft,
  SourceVenueContextDraft,
  SourceOnchainContextDraft,
} from "../../../services/SourceNormalizationRepository.ts"
import type { SourceRawRecord, SourceSyncSource } from "../../../services/SourceSyncModels.ts"
import { SyncEngineStorageError } from "../../../services/SyncEngineStorageError.ts"
import type {
  FetchProviderRawBatchParams,
  FetchProviderRawBatchResult,
  SourceSyncProviderError,
} from "../../../shared/SourceProviderRawBatch.ts"

/**
 * Concrete provider key for production Solana wallet ingestion.
 */
export const HELIUS_SOLANA_PROVIDER_KEY = "helius-solana"

/**
 * Stable raw record type for full Solana transactions returned by Helius.
 */
export const HELIUS_SOLANA_RECORD_TYPE_TRANSACTION_FULL = "solana_transaction_full"

/**
 * HeliusSolanaReferenceDataRefreshResult - Helius-owned reference refresh summary.
 */
export interface HeliusSolanaReferenceDataRefreshResult {
  readonly transactionTypeCatalogCount: number
  readonly providerAssetCatalogCount: number
  readonly defaultTransactionMappingCount: number
  readonly defaultProviderAssetMappingCount: number
}

/**
 * HeliusSolanaNormalizationLookups - Provider-side lookup data reused across normalization.
 */
export interface HeliusSolanaNormalizationLookups {
  readonly providerKey: typeof HELIUS_SOLANA_PROVIDER_KEY
  readonly solanaBlockchainId: string | null
}

/**
 * PrepareHeliusSolanaNormalizationParams - Inputs required to normalize one Helius raw record.
 */
export interface PrepareHeliusSolanaNormalizationParams {
  readonly source: SourceSyncSource
  readonly sourceRecord: SourceRawRecord
  readonly lookups: HeliusSolanaNormalizationLookups
}

/**
 * HeliusSolanaCanonicalLegPlan - Leg classification computed during normalization for one
 * canonical transfer, keyed by the transfer's external id so deriveLegs can link the
 * persisted transfer row to its accounting leg.
 */
export interface HeliusSolanaCanonicalLegPlan {
  readonly movementIdentity: SourceMovementIdentity
  readonly transferExternalId: string
  readonly kind: SourceLegKind
  readonly role: "principal" | "fee" | "rent"
  readonly derivationRule: string
}

/**
 * PreparedHeliusSolanaNormalization - Canonical Solana artifacts ready for persistence.
 */
export interface PreparedHeliusSolanaNormalization {
  readonly providerAssetRowIds: ReadonlyArray<string>
  readonly transaction: SourceTransactionDraft
  readonly venueContext: SourceVenueContextDraft
  readonly onchainContext: SourceOnchainContextDraft | null
  readonly providerTransfers: ReadonlyArray<SourceProviderTransferDraft>
  readonly canonicalTransfers: ReadonlyArray<SourceTransferDraft>
  readonly transactionReview: SourceTransactionReviewDraft | null
  readonly resolvedTransactionType: ResolvedProviderTransactionTypeMapping
  readonly legDerivationStrategy: "derive" | "skip"
  /** One plan per canonical transfer; empty when legDerivationStrategy is "skip". */
  readonly legPlans: ReadonlyArray<HeliusSolanaCanonicalLegPlan>
}

/**
 * DeriveHeliusSolanaProviderLegsParams - Persisted artifacts required for deterministic leg derivation.
 */
export interface DeriveHeliusSolanaProviderLegsParams {
  readonly transaction: PersistedSourceTransaction
  readonly venueContext: PersistedSourceVenueContext | null
  readonly canonicalTransfers: ReadonlyArray<PersistedSourceTransfer>
  readonly legPlans: ReadonlyArray<HeliusSolanaCanonicalLegPlan>
}

/**
 * HeliusSolanaNormalizationDecodeError - Cached Solana full transaction payload is malformed.
 */
export class HeliusSolanaNormalizationDecodeError extends Schema.TaggedError<HeliusSolanaNormalizationDecodeError>()(
  "HeliusSolanaNormalizationDecodeError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  }
) {}

/**
 * HeliusSolanaNormalizationReferenceError - Required local Solana reference data is missing.
 */
export class HeliusSolanaNormalizationReferenceError extends Schema.TaggedError<HeliusSolanaNormalizationReferenceError>()(
  "HeliusSolanaNormalizationReferenceError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  }
) {}

/**
 * HeliusSolanaCursorDecodeError - Persisted Helius pagination cursor is malformed.
 */
export class HeliusSolanaCursorDecodeError extends Schema.TaggedError<HeliusSolanaCursorDecodeError>()(
  "HeliusSolanaCursorDecodeError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  }
) {}

/**
 * HeliusSolanaPayloadDecodeError - Helius returned a malformed transaction page.
 */
export class HeliusSolanaPayloadDecodeError extends Schema.TaggedError<HeliusSolanaPayloadDecodeError>()(
  "HeliusSolanaPayloadDecodeError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  }
) {}

/**
 * HeliusSolanaRecoverableNormalizationError - Helius errors that fail one raw row without aborting the job.
 */
export type HeliusSolanaRecoverableNormalizationError =
  | HeliusSolanaNormalizationDecodeError
  | HeliusSolanaNormalizationReferenceError

/**
 * HeliusSolanaSourceSyncProviderShape - Helius provider surface consumed by the registry adapter.
 *
 * Keep this contract provider-specific. SourceProviderRegistryLive adapts it to
 * SourceProviderModuleShape for generic source sync orchestration.
 */
export interface HeliusSolanaSourceSyncProviderShape {
  readonly fetchRawBatch: (
    params: FetchProviderRawBatchParams
  ) => Effect.Effect<FetchProviderRawBatchResult, SourceSyncProviderError>

  readonly refreshReferenceData: Effect.Effect<
    HeliusSolanaReferenceDataRefreshResult,
    SyncEngineStorageError
  >

  readonly loadNormalizationLookups: Effect.Effect<
    HeliusSolanaNormalizationLookups,
    SyncEngineStorageError
  >

  readonly prepareNormalization: (
    params: PrepareHeliusSolanaNormalizationParams
  ) => Effect.Effect<
    PreparedHeliusSolanaNormalization,
    HeliusSolanaRecoverableNormalizationError | SyncEngineStorageError
  >

  readonly deriveLegs: (
    params: DeriveHeliusSolanaProviderLegsParams
  ) => Effect.Effect<
    ReadonlyArray<SourceTransactionLegDraft>,
    HeliusSolanaRecoverableNormalizationError | SyncEngineStorageError
  >
}

/**
 * HeliusSolanaSourceSyncProvider - Context tag for the Helius Solana provider boundary.
 */
export class HeliusSolanaSourceSyncProvider extends Context.Service<
  HeliusSolanaSourceSyncProvider,
  HeliusSolanaSourceSyncProviderShape
>()("HeliusSolanaSourceSyncProvider") {}
