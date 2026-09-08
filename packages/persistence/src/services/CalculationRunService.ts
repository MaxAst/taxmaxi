/**
 * CalculationRunService - Full calculation over one stable factual snapshot.
 *
 * @module CalculationRunService
 */

import type { TaxAccountingError } from "@my/accounting"
import type { AccountingChoice, JurisdictionCode, TaxYear } from "@my/core/accounting"
import type { CurrencyCode } from "@my/core/currency"
import type { PrincipalId } from "@my/core/ownership"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type {
  CalculationRunId,
  CalculationSyncPreparation,
  CalculationRunWriteError,
  CalculationRunWriteResult,
} from "./CalculationRunRepository.ts"

/** Input for one full calculation over a stable factual snapshot. */
export interface RecomputeCalculationRunParams {
  /** Explicitly observed inputs for recording a failure before a run starts. */
  readonly syncPreparation?: CalculationSyncPreparation
  readonly id: CalculationRunId
  readonly principalId: PrincipalId
  readonly jurisdiction: JurisdictionCode
  readonly taxYear: TaxYear
  readonly reportingCurrency: CurrencyCode
  readonly accountingChoices: ReadonlyArray<AccountingChoice>
}

/** Expected failures while loading, calculating, and writing one complete snapshot. */
export type CalculationRunRecomputeError = CalculationRunWriteError | TaxAccountingError

/** Orchestration contract for immutable full calculation runs. */
export interface CalculationRunServiceShape {
  readonly recompute: (
    params: RecomputeCalculationRunParams
  ) => Effect.Effect<CalculationRunWriteResult, CalculationRunRecomputeError>
}

/** Context tag for full calculation-run orchestration. */
export class CalculationRunService extends Context.Service<
  CalculationRunService,
  CalculationRunServiceShape
>()("@my/persistence/CalculationRunService") {}
