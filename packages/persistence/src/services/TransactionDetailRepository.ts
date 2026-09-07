/** Principal-owned factual transaction inspection.
 * @module TransactionDetailRepository
 */
import type { UnsupportedJurisdictionError } from "@my/accounting"
import type { PrincipalId } from "@my/core/ownership"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import type { PersistenceError } from "../errors/RepositoryError.ts"
import type { MovementCalculationScope } from "./PrincipalTransactionOverrideRepository.ts"

/** Safe retained provider evidence; payloads and account credentials are never returned. */
export interface TransactionDetailEvidence {
  readonly id: string
  readonly provider: string
  readonly recordType: string
  readonly externalRecordId: string
  readonly occurredAt: Date
  readonly importedAt: Date
}

/** Recorded movement facts, including exact writer-selected links. */
export interface TransactionDetailMovement {
  readonly id: string
  readonly transactionId: string | null
  readonly sourceId: string
  readonly timestamp: Date
  readonly assetId: string
  readonly amount: string
  readonly kind: "acquisition" | "disposal" | "income" | "fee"
  readonly provenance: "deterministic" | "rule" | "ai" | "manual"
  readonly derivationRule: string | null
  readonly movementCorrectionTargetId: string
  readonly sourceRawRecordId: string | null
  readonly sourceRepresentationUseId: string | null
  readonly providerAssetRowId: string | null
  readonly assetRepresentationId: string | null
  readonly originKind: "provider_transfer" | "canonical_transfer" | "none"
  readonly providerTransferId: string | null
  readonly sourceTransferId: string | null
  readonly feeForTransactionId: string | null
  readonly evidence: TransactionDetailEvidence | null
  readonly evidenceStatus: "available" | "unavailable"
}

/** Factual foundation, distinct from selected-run results and current correction projections. */
export interface TransactionDetail {
  readonly transactionId: string
  readonly timestamp: Date
  readonly source: {
    readonly sourceId: string
    readonly name: string
    readonly kind: "onchain" | "cex" | "dex"
  }
  readonly transactionType: string | null
  readonly providerTransactionType: string | null
  readonly description: string | null
  readonly externalId: string | null
  readonly movements: ReadonlyArray<TransactionDetailMovement>
  readonly reconciliations: ReadonlyArray<{
    readonly id: string
    readonly providerTransferId: string
    readonly canonicalTransferId: string | null
    readonly canonicalTransactionId: string | null
    readonly status: "pending" | "needs_review" | "approved" | "rejected" | "auto_applied"
    readonly matchReason: string
    readonly deterministic: boolean
  }>
  /** Prior classifications and disappeared target associations are not universally retained. */
  readonly classificationHistoryStatus: "unavailable"
}

/** Read one canonical ID under the same owned-source/produced-leg boundary as the list. */
export interface TransactionDetailRepositoryService {
  readonly find: (params: {
    readonly principalId: PrincipalId
    readonly transactionId: string
    readonly scope: MovementCalculationScope
  }) => Effect.Effect<
    Option.Option<TransactionDetail>,
    PersistenceError | UnsupportedJurisdictionError
  >
}

/** Factual transaction inspection service. */
export class TransactionDetailRepository extends Context.Service<
  TransactionDetailRepository,
  TransactionDetailRepositoryService
>()("@my/persistence/TransactionDetailRepository") {}
