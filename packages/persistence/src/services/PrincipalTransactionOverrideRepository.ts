/**
 * PrincipalTransactionOverrideRepository - Owned movement context and audited stream reads.
 *
 * @module PrincipalTransactionOverrideRepository
 */
import type {
  JurisdictionCode,
  TaxYear,
  MovementClassificationInput,
  MovementCorrectionFacts,
  MovementCorrectionInput,
  MovementCorrectionInputError,
  MovementCorrectionTargetIdentity,
  MovementPriceInput,
} from "@my/core/accounting"
import type { AuthUserId } from "@my/core/authentication"
import type { CurrencyCode } from "@my/core/currency"
import * as Data from "effect/Data"
import type { PrincipalId } from "@my/core/ownership"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import type { MovementValuationEvidence } from "./FactualLedgerRepository.ts"
import type { UnsupportedJurisdictionError } from "@my/accounting"
import type {
  CalculationRunCorrectionInput,
  MovementFactualProjection,
} from "./FactualLedgerRepository.ts"
import type { PersistenceError } from "../errors/RepositoryError.ts"

/** Recorded system evidence, kept separate from effective correction inputs. */
export interface MovementSystemEvidence {
  readonly occurredAt: Date
  readonly legKind: "acquisition" | "disposal" | "income" | "fee"
  readonly recordedFiatAmount: string | null
  readonly recordedFiatCurrency: string | null
  readonly transactionType: string | null
  readonly providerTransactionType: string | null
  readonly derivationRule: string | null
  readonly feeForSourceRecordKey: string | null
}

/** One immutable event in exactly one correction stream. */
export interface PrincipalTransactionOverrideHistoryRecord {
  readonly id: string
  readonly principalId: string
  readonly sourceId: string
  readonly targetId: string
  readonly kind: "price" | "classification"
  readonly operation: "create" | "replace" | "withdraw"
  readonly inspectedFacts: MovementCorrectionFacts
  readonly inspectedSystem: MovementSystemEvidence
  readonly inspectedValuationEvidence: MovementValuationEvidence
  readonly input:
    | { readonly _tag: "price"; readonly input: MovementPriceInput }
    | { readonly _tag: "classification"; readonly input: MovementClassificationInput }
    | null
  readonly actorUserId: string
  readonly reason: string
  readonly supersedesOverrideId: string | null
  readonly recordedAt: Date
}

/** The latest event and active input differ after withdrawal. */
export interface MovementCorrectionStream {
  readonly leaf: PrincipalTransactionOverrideHistoryRecord | null
  readonly active: PrincipalTransactionOverrideHistoryRecord | null
}

/** Owned target and recorded facts used for inspection and atomic mutations. */
export interface PrincipalTransactionOverrideContext {
  readonly targetId: string
  readonly target: MovementCorrectionTargetIdentity
  readonly current: {
    readonly legId: string
    readonly transactionId: string | null
    readonly facts: MovementCorrectionFacts
    readonly system: MovementSystemEvidence
    readonly valuationEvidence: MovementValuationEvidence
  } | null
  readonly price: MovementCorrectionStream
  readonly classification: MovementCorrectionStream
  readonly history: ReadonlyArray<PrincipalTransactionOverrideHistoryRecord>
}

/** Explicit compare-and-set values, including the withdrawal leaf after an inactive stream. */
export interface MovementCorrectionMutationParams {
  readonly principalId: PrincipalId
  readonly actorUserId: AuthUserId
  readonly targetId: string
  readonly expectedSystemRevision: string
  readonly expectedLeafId: string | null
  readonly reason: string
}

/** Input currency is checked against the caller's resolved calculation context. */
export interface SetMovementCorrectionParams extends MovementCorrectionMutationParams {
  readonly input: MovementCorrectionInput
  readonly reportingCurrency: CurrencyCode
}

/** Withdrawal changes exactly one independent stream. */
export interface WithdrawMovementCorrectionParams extends MovementCorrectionMutationParams {
  readonly reportingCurrency: CurrencyCode
  readonly kind: "price" | "classification"
}

/** A stale inspection never appends history or schedules work. */
export class MovementCorrectionConflictError extends Data.TaggedError(
  "MovementCorrectionConflictError"
)<{
  readonly conflictKinds: ReadonlyArray<"stream_leaf" | "system_revision">
  readonly currentContext: PrincipalTransactionOverrideContext
}> {}

/** A request cannot truthfully record an accepted correction in the current context. */
export class MovementCorrectionValidationError extends Data.TaggedError(
  "MovementCorrectionValidationError"
)<{
  readonly code:
    | "target_unavailable"
    | "invalid_actor"
    | "invalid_reason"
    | "invalid_input"
    | "stream_active"
    | "stream_inactive"
}> {}

/** Expected mutation failures; every failure rolls back history and durable work together. */
export type MovementCorrectionMutationError =
  | PersistenceError
  | MovementCorrectionConflictError
  | MovementCorrectionValidationError
  | MovementCorrectionInputError

/** The accepted event and exact durable job selected in the same transaction. */
export interface MovementCorrectionMutationResult {
  readonly context: PrincipalTransactionOverrideContext
  readonly overrideId: string
  readonly sourceId: string
  readonly processingJobId: string
}

/** Explicit jurisdiction calendar and currency for one projection and its covering run. */
export interface MovementCalculationScope {
  readonly jurisdiction: JurisdictionCode
  readonly taxYear: TaxYear
  readonly reportingCurrency: CurrencyCode
}

/** Durable requested work and its selected follow-up, independent of calculation outcome. */
export interface MovementCorrectionReplay {
  readonly status: "not_scheduled" | "updating" | "complete" | "failed"
  readonly processingJobId: string | null
  readonly followUpJobId: string | null
}

/** Exact stored application outcome from a run whose snapshot covers this stream leaf and work. */
export interface MovementCorrectionCoverage {
  readonly runId: string
  readonly status: "running" | "complete" | "partial" | "failed"
  readonly failureCode: string | null
  readonly overrideId: string
  readonly input: Pick<
    CalculationRunCorrectionInput,
    "application" | "applicationProblem" | "resolvedPrice" | "system" | "effective"
  >
}

/** Current inspection and application, durable work, and past run coverage are separate facts. */
export interface MovementCorrectionStreamProjection extends MovementCorrectionStream {
  readonly stale: boolean
  readonly application: CalculationRunCorrectionInput["application"]
  readonly applicationProblem: CalculationRunCorrectionInput["applicationProblem"]
  readonly resolvedPrice: CalculationRunCorrectionInput["resolvedPrice"]
  readonly replay: MovementCorrectionReplay
  readonly coverage: MovementCorrectionCoverage | null
  readonly coverageStatus: "not_requested" | "outside_period" | "updating" | "failed" | "covered"
}

/** The calculation-facing facts and both audited streams for an owned movement. */
export interface PrincipalTransactionOverrideProjection {
  /** Only schema-valid current inspection facts. If unavailable, inputs distinguishes a present withheld leg from an absent target. */
  readonly context: PrincipalTransactionOverrideContext
  readonly scope: MovementCalculationScope
  readonly inputs: MovementFactualProjection
  readonly price: MovementCorrectionStreamProjection
  readonly classification: MovementCorrectionStreamProjection
}

/** Principal-scoped context and atomic audited mutations. */
export interface PrincipalTransactionOverrideRepositoryShape {
  /** Read one owned target in a consistent snapshot. Missing and foreign targets both return none. */
  readonly findContext: (params: {
    readonly principalId: PrincipalId
    readonly targetId: string
    readonly reportingCurrency: CurrencyCode
  }) => Effect.Effect<Option.Option<PrincipalTransactionOverrideContext>, PersistenceError>
  /** Read effective inputs after full factual eligibility and same-scope snapshot coverage. */
  readonly findProjection: (params: {
    readonly principalId: PrincipalId
    readonly targetId: string
    readonly scope: MovementCalculationScope
  }) => Effect.Effect<
    Option.Option<PrincipalTransactionOverrideProjection>,
    PersistenceError | UnsupportedJurisdictionError
  >
  /** Discover current exact target links for an owned transaction; disappeared targets remain readable by ID. */
  readonly findTransactionTargets: (params: {
    readonly principalId: PrincipalId
    readonly transactionId: string
    readonly scope: MovementCalculationScope
  }) => Effect.Effect<
    Option.Option<ReadonlyArray<PrincipalTransactionOverrideProjection>>,
    PersistenceError | UnsupportedJurisdictionError
  >
  /** Append an initial event or create after the explicitly expected withdrawal leaf. */
  readonly create: (
    params: SetMovementCorrectionParams
  ) => Effect.Effect<
    Option.Option<MovementCorrectionMutationResult>,
    MovementCorrectionMutationError
  >
  /** Replace the expected active leaf using current server-read facts. */
  readonly replace: (
    params: SetMovementCorrectionParams
  ) => Effect.Effect<
    Option.Option<MovementCorrectionMutationResult>,
    MovementCorrectionMutationError
  >
  /** Append a withdrawal and schedule application of the current system conclusion. */
  readonly withdraw: (
    params: WithdrawMovementCorrectionParams
  ) => Effect.Effect<
    Option.Option<MovementCorrectionMutationResult>,
    MovementCorrectionMutationError
  >
}

/** Principal-scoped movement correction history and mutations. */
export class PrincipalTransactionOverrideRepository extends Context.Service<
  PrincipalTransactionOverrideRepository,
  PrincipalTransactionOverrideRepositoryShape
>()("@my/persistence/PrincipalTransactionOverrideRepository") {}
