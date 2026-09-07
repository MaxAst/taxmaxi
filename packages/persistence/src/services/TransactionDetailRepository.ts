/** Principal-owned transaction inspection with current decisions and stored run results.
 * @module TransactionDetailRepository
 */
import type { UnsupportedJurisdictionError } from "@my/accounting"
import type { PrincipalId } from "@my/core/ownership"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import type { PersistenceError } from "../errors/RepositoryError.ts"
import type { CalculationRunCorrectionInput } from "./FactualLedgerRepository.ts"
import type { PrincipalAssetOverrideProjection } from "./PrincipalAssetOverrideRepository.ts"
import type {
  MovementCalculationScope,
  PrincipalTransactionOverrideProjection,
} from "./PrincipalTransactionOverrideRepository.ts"

/** Safe retained provider evidence; payloads and account credentials are never returned. */
export interface TransactionDetailEvidence {
  readonly sourceId: string
  readonly id: string
  readonly provider: string
  readonly recordType: string
  readonly externalRecordId: string
  readonly occurredAt: Date
  readonly importedAt: Date
}

/** One explicit writer-recorded evidence path, including unavailable retained payloads. */
export interface TransactionDetailEvidenceLink {
  readonly origin: "transaction" | "leg" | "provider_transfer" | "canonical_transfer"
  readonly originId: string
  readonly sourceId: string
  readonly sourceRawRecordId: string | null
  readonly evidence: TransactionDetailEvidence | null
  readonly status: "available" | "unavailable"
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

/** One immutable selected-scope run and its stored facts; current corrections live outside it. */
export interface TransactionDetailCalculation {
  readonly run: {
    readonly id: string
    readonly jurisdiction: string
    readonly taxYear: number
    readonly reportingCurrency: string
    readonly status: "pending" | "running" | "complete" | "partial" | "failed"
    readonly engineVersion: string
    readonly ruleSetVersion: string
    readonly inputLedgerRevision: string
    readonly valuationRevision: string
    readonly failureCode: string | null
  } | null
  /** Completeness of this transaction, independent of run status and current work. */
  readonly state: "complete" | "partial"
  /** Money availability is independent of processing and run status; custody has no monetary result. */
  readonly monetaryStatus: "available" | "partial" | "unavailable" | "not_applicable"
  /** Stored remaining inventory; per-unit basis is never presented as or multiplied into a total. */
  readonly derivedLots: ReadonlyArray<{
    readonly sequence: number
    readonly acquisitionEventId: string
    readonly assetId: string
    readonly custodyUnitId: string
    readonly acquiredAt: Date
    readonly remainingQuantity: string
    readonly costBasisPerUnit: string | null
  }>
  readonly allocations: ReadonlyArray<{
    readonly sequence: number
    readonly acquisitionEventId: string
    readonly dispositionEventId: string
    readonly assetId: string
    readonly custodyUnitId: string
    readonly acquiredAt: Date
    readonly disposedAt: Date
    readonly quantity: string
    readonly costBasis: string | null
    readonly proceeds: string | null
    readonly gainLoss: string | null
    readonly treatmentCodes: ReadonlyArray<string>
  }>
  readonly income: ReadonlyArray<{
    readonly sequence: number
    readonly sourceId: string
    readonly eventId: string
    readonly assetId: string
    readonly occurredAt: Date
    readonly quantity: string
    readonly value: string
    readonly treatmentCodes: ReadonlyArray<string>
  }>
  readonly blockers: ReadonlyArray<{
    readonly sequence: number
    readonly eventId: string
    readonly code: string
    readonly assetId: string | null
    readonly providerAssetRowId: string | null
    readonly custodyUnitId: string
    readonly missingQuantity: string | null
  }>
  readonly processedEventIds: ReadonlyArray<string>
  readonly correctionInputs: ReadonlyArray<CalculationRunCorrectionInput>
}

/** Owned facts, selected-run results and independent current correction projections. */
export interface TransactionDetail {
  readonly calculation: TransactionDetailCalculation
  readonly movementOverrides: ReadonlyArray<PrincipalTransactionOverrideProjection>
  readonly assetOverrides: ReadonlyArray<{
    readonly movementId: string
    readonly projection: PrincipalAssetOverrideProjection | null
  }>
  readonly sourceRawRecordId: string | null
  readonly sourceEvidence: ReadonlyArray<TransactionDetailEvidenceLink>
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

/** Principal-owned transaction inspection service. */
export class TransactionDetailRepository extends Context.Service<
  TransactionDetailRepository,
  TransactionDetailRepositoryService
>()("@my/persistence/TransactionDetailRepository") {}
