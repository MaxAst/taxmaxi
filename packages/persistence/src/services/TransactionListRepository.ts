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

/** Compact movement facts displayed with a transaction row. */
export interface TransactionListMovement {
  readonly amount: string
  readonly assetSymbol: string
  readonly kind: "acquisition" | "disposal" | "income" | "fee"
}

/** One compact transaction row for the principal-wide table. */
export interface TransactionListItem {
  readonly transactionId: string
  readonly timestamp: string
  readonly source: TransactionListSource
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
  readonly sourceId: string | null
  readonly cursor: string | null
  readonly limit: number
}

/** Persistence contract for the canonical principal-owned transaction list. */
export interface TransactionListRepositoryService {
  readonly list: (
    params: TransactionListParams
  ) => Effect.Effect<TransactionListPage, TransactionListRepositoryError>
}

/** Context tag for canonical transaction list reads. */
export class TransactionListRepository extends Context.Service<
  TransactionListRepository,
  TransactionListRepositoryService
>()("@my/persistence/TransactionListRepository") {}
