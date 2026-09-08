/**
 * CalculationRunRepository - Write-once calculation-run persistence contract.
 *
 * @module CalculationRunRepository
 */

import type { TaxAccountingBlocker, TaxAccountingResult } from "@my/accounting"
import type {
  AccountingEventId,
  AccountingQuantity,
  CustodyUnitId,
  JurisdictionCode,
  TaxYear,
} from "@my/core/accounting"
import { CurrencyCode } from "@my/core/currency"
import type { PrincipalId } from "@my/core/ownership"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { PersistenceError } from "../errors/RepositoryError.ts"
import type {
  CustodyUnitMembership,
  CalculationRunCorrectionInput,
  FactualLedgerInputBlockerCode,
} from "./FactualLedgerRepository.ts"

/** Stable, caller-assigned identity of one immutable calculation run. */
export const CalculationRunId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("CalculationRunId")
)

/** Stable, caller-assigned identity of one immutable calculation run. */
export type CalculationRunId = typeof CalculationRunId.Type

/** Stable identity of accepted completed-sync work, independent of a run. */
export const CalculationSyncRequestId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("CalculationSyncRequestId")
)

/** Stable identity of accepted completed-sync work. */
export type CalculationSyncRequestId = typeof CalculationSyncRequestId.Type

/** Stable identity of one attempt at a completed-sync request. */
export const CalculationSyncAttemptId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("CalculationSyncAttemptId")
)

/** Stable identity of one attempt at a completed-sync request. */
export type CalculationSyncAttemptId = typeof CalculationSyncAttemptId.Type

/** Exact work owned by one worker before its accounting snapshot exists. */
export interface CalculationSyncClaim {
  readonly requestId: CalculationSyncRequestId
  readonly attemptId: CalculationSyncAttemptId
}

/** Exact request links read alongside the factual ledger; an empty array is explicit evidence. */
export interface CalculationRunSyncCapture {
  readonly requestIds: ReadonlyArray<CalculationSyncRequestId>
}

/**
 * Revision of the factual ledger used as calculation input.
 *
 * The token records the snapshot transaction ID and a PostgreSQL snapshot with
 * colons replaced by dots, followed by the canonical factual-content hash.
 */
export const InputLedgerRevision = Schema.Trimmed.pipe(
  Schema.check(Schema.isPattern(/^v2:\d+:\d+\.\d+\.(?:\d+(?:,\d+)*)?:[0-9a-f]{64}$/)),
  Schema.brand("InputLedgerRevision")
)

/** Revision of the factual ledger used as calculation input. */
export type InputLedgerRevision = typeof InputLedgerRevision.Type

/** Revision of the valuation facts used as calculation input. */
export const ValuationRevision = Schema.Trimmed.pipe(
  Schema.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
  Schema.brand("ValuationRevision")
)

/** Revision of the valuation facts used as calculation input. */
export type ValuationRevision = typeof ValuationRevision.Type

/** A terminal calculation run cannot be written again under the same ID. */
export class CalculationRunAlreadyStoredError extends Schema.TaggedError<CalculationRunAlreadyStoredError>()(
  "CalculationRunAlreadyStoredError",
  { runId: CalculationRunId }
) {}

/** A monetary result does not match the run's declared reporting currency. */
export class CalculationRunCurrencyMismatchError extends Schema.TaggedError<CalculationRunCurrencyMismatchError>()(
  "CalculationRunCurrencyMismatchError",
  {
    runId: CalculationRunId,
    expected: CurrencyCode,
    actual: CurrencyCode,
  }
) {}

/** Fact-layer blocker codes that remain outside the pure accounting engine. */
export type CalculationRunFactBlockerCode = FactualLedgerInputBlockerCode

/** At least one stored target that tells the principal which fact must be fixed. */
export type CalculationRunFactBlockerTarget =
  | {
      readonly assetId: string
      readonly providerAssetRowId?: string | null
    }
  | {
      readonly assetId?: null
      readonly providerAssetRowId: string
    }

/** A blocker found while stored facts are adapted into accounting events. */
export type CalculationRunFactBlocker = {
  readonly code: CalculationRunFactBlockerCode
  readonly eventId: AccountingEventId
  readonly custodyUnitId: CustodyUnitId
  readonly missingQuantity: AccountingQuantity | null
} & CalculationRunFactBlockerTarget

/** Engine and fact-layer blockers accepted by calculation-run persistence. */
export type CalculationRunResultBlocker = TaxAccountingBlocker | CalculationRunFactBlocker

/** Combined result stored by persistence without widening the pure engine contract. */
export type CalculationRunResult = Omit<TaxAccountingResult, "blockers"> & {
  readonly blockers: ReadonlyArray<CalculationRunResultBlocker>
}

/** Input required to write one terminal calculation run and compare it for activation. */
export interface PersistCalculationRunParams {
  /** Finalization never recreates a run removed since start; atomic writes create a new run. */
  readonly writeMode: "finalize_started" | "atomic"
  readonly id: CalculationRunId
  readonly principalId: PrincipalId
  readonly reportingCurrency: CurrencyCode
  readonly inputLedgerRevision: InputLedgerRevision
  readonly valuationRevision: ValuationRevision
  readonly syncCapture: CalculationRunSyncCapture
  readonly correctionInputs: ReadonlyArray<CalculationRunCorrectionInput>
  readonly result: CalculationRunResult
}

/** Input metadata committed before the pure engine starts. */
export interface StartCalculationRunParams {
  /** Omission uses normal snapshot-time claiming; supplied pairs must still be owned. */
  readonly syncClaims?: ReadonlyArray<CalculationSyncClaim>
  readonly id: CalculationRunId
  readonly principalId: PrincipalId
  readonly jurisdiction: JurisdictionCode
  readonly taxYear: TaxYear
  readonly reportingCurrency: CurrencyCode
  readonly engineVersion: string
  readonly ruleSetVersion: string
  readonly inputLedgerRevision: InputLedgerRevision
  readonly valuationRevision: ValuationRevision
  readonly syncCapture: CalculationRunSyncCapture
  readonly correctionInputs: ReadonlyArray<CalculationRunCorrectionInput>
  readonly custodyUnitMembership: ReadonlyArray<CustodyUnitMembership>
}

/** Input used to settle a visible running calculation after an error. */
export interface FailCalculationRunParams {
  readonly id: CalculationRunId
  readonly principalId: PrincipalId
  readonly failureCode: string
}

/** Outcome of a durable run write and monotonic active-pointer comparison. */
export interface CalculationRunWriteResult {
  readonly activated: boolean
  readonly inputLedgerRevision: InputLedgerRevision
  readonly valuationRevision: ValuationRevision
  readonly status: "complete" | "partial"
}

/** Expected failures while writing a calculation run. */
export type CalculationRunWriteError =
  | CalculationRunAlreadyStoredError
  | CalculationRunCurrencyMismatchError
  | PersistenceError

/** Calculation states exposed to API consumers. Pending writes are not externally visible. */
export const ExposedCalculationRunStatus = Schema.Literals([
  "running",
  "complete",
  "partial",
  "failed",
])

/** Calculation states exposed to API consumers. */
export type ExposedCalculationRunStatus = typeof ExposedCalculationRunStatus.Type

/** Principal-level status of the latest calculation for one reporting scope. */
export interface CalculationRunStatusSummary {
  readonly runId: CalculationRunId
  readonly status: ExposedCalculationRunStatus
  readonly failureCode: string | null
}

/** Scope used to select a principal's latest calculation run. */
export interface GetLatestCalculationRunStatusParams {
  readonly principalId: PrincipalId
  readonly jurisdiction: JurisdictionCode
  readonly taxYear: TaxYear
  readonly reportingCurrency: CurrencyCode
}

/** Scope used to list tax years that already have an active-run pointer. */
export interface ListActiveCalculationRunTaxYearsParams {
  readonly principalId: PrincipalId
  readonly jurisdiction: JurisdictionCode
  readonly reportingCurrency: CurrencyCode
}

/** Input for one bounded calculation-maintenance pass. */
export interface MaintainCalculationRunsParams {
  /** Continue discovery after this principal; omit to start again. */
  readonly afterPrincipalId?: PrincipalId
  readonly staleBefore: Date
  readonly limit: number
}

/** Durable work found by one calculation-maintenance pass. */
export interface CalculationRunMaintenanceResult {
  /** Next discovery cursor; null wraps the next pass to the beginning. */
  readonly nextAfterPrincipalId: PrincipalId | null
  readonly failedStaleRuns: number
  readonly principalIds: ReadonlyArray<PrincipalId>
}

/** Exact scope and optional owned job selected by the shared read. */
export interface GetCalculationSyncStatusParams extends GetLatestCalculationRunStatusParams {
  readonly sourceJobId?: string
}

/** A supplied job is absent or belongs to another principal. */
export class CalculationSyncJobNotFoundError extends Schema.TaggedError<CalculationSyncJobNotFoundError>()(
  "CalculationSyncJobNotFoundError",
  { sourceJobId: Schema.String }
) {}

/** Durable request state, independent of whether the active result covers it. */
export interface CalculationSyncWork {
  readonly requestId: CalculationSyncRequestId
  readonly sourceId: string
  readonly sourceJobId: string
  readonly status: "queued" | "running" | "succeeded" | "failed"
  readonly attempts: ReadonlyArray<{
    readonly attemptId: CalculationSyncAttemptId
    readonly runId: CalculationRunId | null
    readonly status: "running" | "succeeded" | "failed"
    readonly failureCode: string | null
  }>
}

/** A finalized run whose exact captured membership includes the request. */
export interface CalculationSyncCoveringRun {
  readonly runId: CalculationRunId
  readonly status: "complete" | "partial"
}

/** Coverage for a discovered completed job or an explicitly selected owned job. */
export interface CalculationSyncJobStatus {
  readonly sourceJobStatus: "pending" | "processing" | "completed" | "failed" | "credit_required"
  readonly sourceJobId: string
  readonly sourceId: string
  readonly work: CalculationSyncWork | null
  readonly coveringRun: CalculationSyncCoveringRun | null
  /** Unknown when the source job has not completed, or the active run has no recorded capture. */
  readonly activeCoverage: "covered" | "not_covered" | "unknown"
}

/** One database snapshot of active results, scope-wide work, and selected job coverage. */
export interface CalculationSyncStatus {
  readonly scope: GetLatestCalculationRunStatusParams
  readonly activeRun: CalculationSyncCoveringRun | null
  readonly work: {
    /** Running takes precedence, then queued, failed, succeeded; no requests means not_requested. */
    readonly status: "not_requested" | "queued" | "running" | "succeeded" | "failed"
    /** Outstanding scope requests only; succeeded requests remain available on selected jobs. */
    readonly requests: ReadonlyArray<CalculationSyncWork>
  }
  readonly jobs: ReadonlyArray<CalculationSyncJobStatus>
}

/** Persistence contract for atomic, write-once calculation results. */
export interface CalculationRunRepositoryShape {
  /** Claim queued/failed scope work before hydration without inventing a calculation run. */
  readonly claimSyncRequests: (
    params: GetLatestCalculationRunStatusParams
  ) => Effect.Effect<ReadonlyArray<CalculationSyncClaim>, PersistenceError>

  /** Fail only the caller's exact still-running, runless attempts. */
  readonly failSyncClaims: (
    params: GetLatestCalculationRunStatusParams & {
      readonly claims: ReadonlyArray<CalculationSyncClaim>
      readonly failureCode: string
    }
  ) => Effect.Effect<void, PersistenceError>

  /** List every durably accepted scope year, including previously succeeded work. */
  readonly listRequestedTaxYears: (
    params: ListActiveCalculationRunTaxYearsParams
  ) => Effect.Effect<ReadonlyArray<TaxYear>, PersistenceError>

  /** Read all scope work and exact selected-job coverage without writing or enqueueing. */
  readonly getSyncStatus: (
    params: GetCalculationSyncStatusParams
  ) => Effect.Effect<CalculationSyncStatus, CalculationSyncJobNotFoundError | PersistenceError>

  /** List the tax years with an active-run pointer for one principal and scope. */
  readonly listActiveTaxYears: (
    params: ListActiveCalculationRunTaxYearsParams
  ) => Effect.Effect<ReadonlyArray<TaxYear>, PersistenceError>

  /** Read the newest factual revision for one principal and calculation scope. */
  readonly getLatestStatus: (
    params: GetLatestCalculationRunStatusParams
  ) => Effect.Effect<CalculationRunStatusSummary | null, PersistenceError>

  /**
   * Fail stale running runs, keep their principals pending until a replacement
   * starts, and find completed source work absent from every run snapshot.
   */
  readonly settleStaleAndFindRecomputePrincipals: (
    params: MaintainCalculationRunsParams
  ) => Effect.Effect<CalculationRunMaintenanceResult, PersistenceError>

  /** Commit one visible running run and its immutable factual-snapshot membership. */
  readonly start: (
    params: StartCalculationRunParams
  ) => Effect.Effect<void, CalculationRunAlreadyStoredError | PersistenceError>

  /** Settle a running run as failed without writing result rows or changing the active pointer. */
  readonly fail: (
    params: FailCalculationRunParams
  ) => Effect.Effect<void, CalculationRunAlreadyStoredError | PersistenceError>

  /**
   * Persist every row of a complete or partial engine result, then activate it
   * only when its factual snapshot is newer than the current active run.
   *
   * A run started through `start` keeps its committed correction and custody snapshots.
   * Both paths require explicitly captured correction inputs; they never reload current history. Direct
   * persistence snapshots live custody membership for the legacy atomic path.
   * A run ID is single-use after it reaches a terminal status.
   */
  readonly persist: (
    params: PersistCalculationRunParams
  ) => Effect.Effect<CalculationRunWriteResult, CalculationRunWriteError>
}

/** Context tag for calculation-run writes. */
export class CalculationRunRepository extends Context.Service<
  CalculationRunRepository,
  CalculationRunRepositoryShape
>()("@my/persistence/CalculationRunRepository") {}
