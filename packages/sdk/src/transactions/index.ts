import {
  TransactionDetailResponse,
  TransactionDetailQuery,
  TransactionListResponse,
  TransactionListQuery,
} from "@my/rest-api/contracts"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { TaxMaxiEffectClient } from "../client.ts"

export type Transactions = Schema.Codec.Encoded<typeof TransactionListResponse>
export type TransactionListItem = Transactions["transactions"][number]

export type TransactionListInput = {
  readonly sourceId?: string
  readonly sourceIds?: ReadonlyArray<string>
  /** Inclusive ISO timestamp. */
  readonly from?: string
  /** Exclusive ISO timestamp. */
  readonly to?: string
  readonly order?: "newest" | "oldest"
  readonly cursor?: string | null
  readonly limit?: number
}

/** Exact facts and run-backed calculation with independently current corrections. */
export type TransactionDetail = Schema.Codec.Encoded<typeof TransactionDetailResponse>

/** Detail always names one canonical transaction and explicit DE/EUR tax year. */
export type TransactionDetailInput = { readonly transactionId: string; readonly taxYear: number }

/** Includes the declared transaction-not-found error without erasing the Effect error channel. */
export type TransactionDetailError = Effect.Error<
  ReturnType<TaxMaxiEffectClient["transactions"]["getTransaction"]>
>

export type TransactionsEffectResource = {
  readonly get: (
    input: TransactionDetailInput
  ) => Effect.Effect<TransactionDetail, TransactionDetailError>
  readonly list: (input?: TransactionListInput) => Effect.Effect<Transactions, unknown, never>
}

export type TransactionsPromiseResource = {
  readonly get: (input: TransactionDetailInput) => Promise<TransactionDetail>
  readonly list: (input?: TransactionListInput) => Promise<Transactions>
}

const encodeDetail = Schema.encodeSync(TransactionDetailResponse)

const encodeTransactions = Schema.encodeSync(TransactionListResponse)

export const makeTransactionsEffectResource = (
  client: Effect.Effect<TaxMaxiEffectClient, never>
): TransactionsEffectResource => ({
  get: ({ transactionId, taxYear }) =>
    Effect.gen(function* () {
      const query = yield* Schema.decodeEffect(TransactionDetailQuery)({ taxYear: String(taxYear) })
      const resolved = yield* client
      return encodeDetail(
        yield* resolved.transactions.getTransaction({ params: { transactionId }, query })
      )
    }),
  list: (input = {}) =>
    Effect.gen(function* () {
      const query = yield* Schema.decodeEffect(TransactionListQuery)({
        ...input,
        cursor: input.cursor ?? undefined,
        limit: input.limit === undefined ? undefined : String(input.limit),
      })
      const resolved = yield* client
      return encodeTransactions(yield* resolved.transactions.listTransactions({ query }))
    }),
})

export const makeTransactionsPromiseResource = (
  effect: TransactionsEffectResource,
  run: <A>(effect: Effect.Effect<A, unknown, never>) => Promise<A>
): TransactionsPromiseResource => ({
  get: (input) => run(effect.get(input)),
  list: (input) => run(effect.list(input)),
})
