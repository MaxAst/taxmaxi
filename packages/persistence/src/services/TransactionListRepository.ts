/**
 * TransactionListRepository - Principal-owned compact transaction reads.
 *
 * @module TransactionListRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { JurisdictionCode } from "@my/core/accounting"
import type { CurrencyCode } from "@my/core/currency"
import type { PersistenceError } from "../errors/RepositoryError.ts"

/** The supplied transaction cursor is malformed or belongs to another list scope. */
export class TransactionListInvalidCursorError extends Schema.TaggedError<TransactionListInvalidCursorError>()(
  "TransactionListInvalidCursorError",
  { cursor: Schema.String }
) {
  override get message(): string {
    return "Invalid transaction pagination cursor."
  }
}

/** The requested source is absent or belongs to another principal. */
export class TransactionListSourceNotFoundError extends Schema.TaggedError<TransactionListSourceNotFoundError>()(
  "TransactionListSourceNotFoundError",
  { sourceId: Schema.String }
) {
  override get message(): string {
    return "Source not found."
  }
}

export type TransactionListRepositoryError =
  | TransactionListInvalidCursorError
  | TransactionListSourceNotFoundError
  | PersistenceError

/** Compact source facts displayed with a transaction row. */
export interface TransactionListSource {
  readonly sourceId: string
  readonly name: string
  readonly kind: "onchain" | "cex" | "dex"
}

/** One exact allocation recorded by the displayed calculation, including its consumed quantity. */
export interface TransactionListRealizedResult {
  readonly acquisitionEventId: string
  readonly quantity: string
  readonly costBasis: string
  readonly proceeds: string
  readonly gainLoss: string
  readonly currency: string
}

/** Immutable movement facts from the displayed run; never values from remaining inventory. */
export interface TransactionListMovementCapture {
  readonly runId: string
  readonly eventId: string | null
  readonly outcome: "included" | "withheld" | "absent" | "outside_period"
  readonly quantity: string | null
  readonly assetId: string | null
  readonly assetSymbol: string | null
  readonly eventKind: "acquisition" | "disposition" | "custody_movement" | null
  readonly cause: string | null
  readonly valuationState: "selected" | "not_evaluated" | "missing" | "ambiguous"
  readonly selectedValue: {
    readonly kind: "user_valuation" | "observed_consideration" | "market_quote"
    readonly amount: string
    readonly currency: string
  } | null
  /** Provider amounts explicitly linked to this event by the writer, independently of selection. */
  readonly providerConsiderations: ReadonlyArray<{
    readonly amount: string
    readonly currency: string
  }>
  /** Original acquisition basis is not captured. Selected value must not stand in for it. */
  readonly acquisitionCostBasis: null
  readonly realizedResults: ReadonlyArray<TransactionListRealizedResult>
}

/** Compact movement facts displayed with a transaction row. */
export interface TransactionListMovement {
  readonly targetId: string
  readonly capture: TransactionListMovementCapture | null
  readonly amount: string
  readonly assetSymbol: string
  readonly kind: "acquisition" | "disposal" | "income" | "fee"
}

/** One compact transaction row for the principal-wide table. */
export interface TransactionListItem {
  readonly transactionId: string
  readonly timestamp: string
  readonly source: TransactionListSource
  /** Imported transaction category; completed corrected causes belong to each movement capture. */
  readonly transactionType: string | null
  readonly description: string | null
  readonly externalId: string | null
  readonly movements: ReadonlyArray<TransactionListMovement>
  /** Income value from the active calculation, separate from disposal gains. */
  readonly income: string | null
  readonly realizedGainLoss: string | null
  readonly fiatCurrency: string | null
  readonly calculationState: "complete" | "partial"
  readonly needsReview: boolean
  /** Explicit owned review or movement/transaction-linked blocker; independent of scope status. */
  readonly attention: boolean
}

/** Stable cursor page with an exact count for principal transactions that have accounting legs. */
export interface TransactionListPage {
  readonly items: ReadonlyArray<TransactionListItem>
  readonly nextCursor: string | null
  readonly hasMore: boolean
  readonly totalCount: number
}

export interface TransactionListParams {
  readonly principalId: string
  readonly jurisdiction: JurisdictionCode
  readonly reportingCurrency: CurrencyCode
  readonly sourceIds: ReadonlyArray<string>
  /** UTC half-open occurrence interval. */
  readonly from: Date | null
  readonly to: Date | null
  readonly order: "newest" | "oldest"
  readonly attention?: boolean
  readonly cursor: string | null
  readonly limit: number
}

/** Owned historical economic asset metadata, including assets whose inventory is fully sold. */
export interface TransactionFilterAssetChoice {
  readonly assetId: string
  readonly symbol: string
  readonly name: string
  readonly type: "fungible" | "nft"
  readonly coingeckoCoinId: string | null
  readonly logoUrl: string | null
}

/** Persistence contract for the canonical principal-owned transaction list. */
export interface TransactionListRepositoryService {
  /** Choices follow completed movement identity, independently of current holdings and page filters. */
  readonly filterChoices: (params: {
    readonly principalId: string
    readonly jurisdiction: JurisdictionCode
    readonly reportingCurrency: CurrencyCode
  }) => Effect.Effect<
    { readonly assets: ReadonlyArray<TransactionFilterAssetChoice> },
    PersistenceError
  >
  readonly list: (
    params: TransactionListParams
  ) => Effect.Effect<TransactionListPage, TransactionListRepositoryError>
}

/** Context tag for canonical transaction list reads. */
export class TransactionListRepository extends Context.Service<
  TransactionListRepository,
  TransactionListRepositoryService
>()("@my/persistence/TransactionListRepository") {}
