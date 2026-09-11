/**
 * FactualLedgerRepository - Stored facts adapted to tax-accounting inputs.
 *
 * @module FactualLedgerRepository
 */

import type {
  AccountingEvent,
  ObservedConsiderationFact,
  MarketQuoteFact,
  CustodyUnitId,
  ValuationFact,
  MovementCorrectionFacts,
  ResolvedMovementPrice,
} from "@my/core/accounting"
import type { PrincipalAssetTechnicalBlocker } from "@my/core/assets"
import type { CurrencyCode } from "@my/core/currency"
import type { PrincipalId } from "@my/core/ownership"
import type { SourceId } from "@my/core/source"
import type * as Schema from "effect/Schema"
import type {
  PrincipalTransactionOverrideHistoryRecord,
  MovementSystemEvidence,
} from "./PrincipalTransactionOverrideRepository.ts"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { PersistenceError } from "../errors/RepositoryError.ts"

/** Inputs needed to load one principal's factual ledger and price facts. */
export interface LoadFactualLedgerParams {
  readonly principalId: PrincipalId
  readonly reportingCurrency: CurrencyCode
  /** Exclusive event-time boundary used by scoped calculation runs. */
  readonly occurredBefore?: Date
}

/** Current factual mapping from one custody source to its accounting inventory unit. */
export interface CustodyUnitMembership {
  readonly sourceId: SourceId
  readonly custodyUnitId: CustodyUnitId
}

/** Fact-layer reason a movement or its requested correction cannot supply a complete result. */
export type FactualLedgerInputBlockerCode =
  | PrincipalAssetTechnicalBlocker
  | "unresolved_identity"
  | "movement_correction_needs_attention"
  | "movement_price_currency_mismatch"

/** Reason an active movement correction could not supply the current calculation input. */
export type MovementCorrectionApplicationProblem =
  | "target_unavailable"
  | "target_ineligible"
  | "target_changed"
  | "quantity_changed"
  | "asset_changed"
  | "structure_changed"
  | "reporting_currency_mismatch"

/** At least one stored target that identifies the blocked fact. */
export type FactualLedgerInputBlockerTarget =
  | {
      readonly assetId: string
      readonly providerAssetRowId?: string | null
    }
  | {
      readonly assetId?: null
      readonly providerAssetRowId: string
    }

/** Machine-readable fact-layer blocker stored beside engine blockers on a run. */
export type FactualLedgerInputBlocker = {
  readonly code: FactualLedgerInputBlockerCode
  readonly eventId: AccountingEvent["id"]
  readonly occurredAt: Date
  readonly custodyUnitId: CustodyUnitId
  readonly missingQuantity: null
} & FactualLedgerInputBlockerTarget

/**
 * Canonical identity-override stream leaf read while adapting factual rows.
 *
 * The tagged target keeps exact representations and chainless provider assets distinct.
 * Every leaf includes its stream kind, record ID, operation, supersession link, and
 * replacement so the calculation input commits to the decision snapshot it read.
 */
export type PrincipalAssetOverrideRevisionRecord =
  | {
      readonly target: {
        readonly _tag: "representation"
        readonly targetId: string
        readonly blockchainId: string
        readonly representationType: "native" | "token" | "nft"
        readonly contractAddress: string | null
        readonly mintAddress: string | null
      }
      readonly kind: "identity" | "inclusion"
      readonly overrideId: string
      readonly operation: "create" | "replace" | "withdraw"
      readonly supersedesOverrideId: string | null
      readonly replacementAssetId: string | null
      readonly replacementInclusion: "included" | "excluded" | null
    }
  | {
      readonly target: {
        readonly _tag: "provider_asset"
        readonly targetId: string
        readonly providerAssetRowId: string
      }
      readonly kind: "identity" | "inclusion"
      readonly overrideId: string
      readonly operation: "create" | "replace" | "withdraw"
      readonly supersedesOverrideId: string | null
      readonly replacementAssetId: string | null
      readonly replacementInclusion: "included" | "excluded" | null
    }

/** Exact pre-correction valuation evidence in the reporting currency used for inspection. */
export interface MovementValuationEvidence {
  readonly reportingCurrency: CurrencyCode
  readonly facts: ReadonlyArray<
    | Schema.Codec.Encoded<typeof ObservedConsiderationFact>
    | Schema.Codec.Encoded<typeof MarketQuoteFact>
  >
}

/** Exact immutable history values encoded for a run snapshot, without runtime decimal/date objects. */
export type CapturedMovementCorrectionHistory = Omit<
  PrincipalTransactionOverrideHistoryRecord,
  "inspectedFacts" | "inspectedSystem" | "recordedAt"
> & {
  readonly inspectedFacts: Schema.Codec.Encoded<typeof MovementCorrectionFacts>
  readonly inspectedSystem: Omit<MovementSystemEvidence, "occurredAt"> & {
    readonly occurredAt: string
  }
  readonly recordedAt: string
}

/** Exact selected custody relationship, retained even when no event enters the engine. */
export interface MovementCorrectionCustodyContext {
  readonly reconciliationId: string
  readonly canonicalTransferId: string
  readonly providerTransferId: string
  readonly canonicalTransactionId: string | null
  readonly providerTransactionId: string
  readonly canonicalSourceId: string
  readonly providerSourceId: string
  readonly occurredAt: string
  readonly quantity: string
  readonly canonicalStoredAssetId: string
  readonly providerStoredAssetId: string
  readonly providerDirection: "inbound" | "outbound"
  readonly outcome: "included" | "withheld" | "outside_period"
}

/** Recorded current movement context, including facts withheld from the engine. */
export interface MovementCorrectionLegContext {
  readonly targetId: string
  readonly legId: string
  readonly sourceId: string
  readonly transactionId: string | null
  readonly occurredAt: string
  readonly quantity: string
  readonly storedAssetId: string
  readonly effectiveAssetId: string | null
  readonly direction: "inbound" | "outbound"
  readonly structure: "ownership_change" | "fee" | "custody"
  readonly legKind: "acquisition" | "income" | "disposal" | "fee"
  readonly transactionType: string | null
  readonly providerTransactionType: string | null
  readonly recordedFiatAmount: string | null
  readonly recordedFiatCurrency: string | null
  readonly providerFiatAmount: string | null
  readonly providerFiatCurrency: string | null
  readonly derivationRule: string | null
  readonly feeForSourceRecordKey: string | null
  readonly originKind: "none" | "canonical_transfer" | "provider_transfer"
  readonly sourceTransferId: string | null
  readonly providerTransferId: string | null
  readonly custody: ReadonlyArray<MovementCorrectionCustodyContext>
}

/** Exact event and valuation inputs passed to the engine for a target, or honest absence. */
export interface MovementCorrectionEngineInputs {
  /** User assertion source, only when this effective cause came from that retained history record. */
  readonly classificationEvidence?: {
    readonly _tag: "user_assertion"
    readonly overrideId: string
  }
  readonly event: Schema.Codec.Encoded<typeof AccountingEvent> | null
  readonly valuationFacts: ReadonlyArray<Schema.Codec.Encoded<typeof ValuationFact>>
}

/** One history record and the context/inputs that this run's factual snapshot actually read. */
export interface CalculationRunCorrectionInput {
  readonly history: CapturedMovementCorrectionHistory
  readonly current: MovementCorrectionLegContext | null
  readonly currentOutcome: "included" | "withheld" | "absent" | "outside_period"
  readonly streamState: "active" | "withdrawn" | "superseded"
  readonly application: "inactive" | "not_applied" | "applied" | "needs_attention"
  readonly reportingCurrency: CurrencyCode
  /** Null when no active correction was rejected for this run. */
  readonly applicationProblem: MovementCorrectionApplicationProblem | null
  /** Exact selected total and display-only unit preview, present only for an applied price. */
  readonly resolvedPrice: Pick<
    ResolvedMovementPrice,
    "totalValue" | "unitPrice" | "currency"
  > | null
  readonly system: MovementCorrectionEngineInputs
  readonly effective: MovementCorrectionEngineInputs
}

/** Stored accounting facts ready for the pure tax-accounting engine. */
export interface FactualLedger {
  /** Every recorded movement and its final combined inputs, including withheld movements. */
  readonly movements: ReadonlyMap<string, MovementFactualProjection>
  readonly events: ReadonlyArray<AccountingEvent>
  readonly inputBlockers: ReadonlyArray<FactualLedgerInputBlocker>
  readonly valuationFacts: ReadonlyArray<ValuationFact>
  readonly custodyUnitMembership: ReadonlyArray<CustodyUnitMembership>
  readonly correctionInputs: ReadonlyArray<CalculationRunCorrectionInput>
  readonly principalAssetOverrideRevision: ReadonlyArray<PrincipalAssetOverrideRevisionRecord>
}

/** Current target inputs from the same factual read used by calculations, even without history. */
export interface MovementFactualProjection {
  readonly targetId: string
  readonly current: MovementCorrectionLegContext | null
  readonly currentOutcome: CalculationRunCorrectionInput["currentOutcome"]
  readonly system: MovementCorrectionEngineInputs
  readonly effective: MovementCorrectionEngineInputs
  readonly corrections: ReadonlyArray<CalculationRunCorrectionInput>
}

/** Shared snapshot result with complete movement inputs for calculation capture. */
export interface FactualLedgerSnapshot {
  readonly ledger: Omit<FactualLedger, "movements">
  readonly movements: ReadonlyMap<string, MovementFactualProjection>
}

/** Persistence contract for adapting stored rows to a factual ledger. */
export interface FactualLedgerRepositoryShape {
  readonly load: (
    params: LoadFactualLedgerParams
  ) => Effect.Effect<FactualLedger, PersistenceError | Schema.SchemaError>
}

/** Context tag for factual-ledger reads. */
export class FactualLedgerRepository extends Context.Service<
  FactualLedgerRepository,
  FactualLedgerRepositoryShape
>()("@my/persistence/FactualLedgerRepository") {}
