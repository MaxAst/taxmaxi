import {
  TaxMaxiApi,
  TransactionOverrideCurrentResponse,
  TransactionOverrideHistoryResponse,
  TransactionOverrideTargetsResponse,
  TransactionOverrideMutationResponse,
  TransactionOverrideScopeQuery,
  TransactionOverrideSetRequest,
  TransactionOverrideWithdrawRequest,
  type TransactionOverrideConflictError,
  type TransactionOverrideNotFoundError,
  type TransactionOverrideReadonlyError,
  type TransactionOverrideValidationError,
} from "@my/rest-api/contracts"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { HttpApiClient } from "effect/unstable/httpapi"
import type { AssetRequestOptions } from "../assets/index.ts"

type TransactionOverridesClient = HttpApiClient.ForApi<typeof TaxMaxiApi>["transactionOverrides"]
type Client = { readonly transactionOverrides: TransactionOverridesClient }

/** Exact system, user, effective, work and covering-run facts for one movement. */
export type TransactionOverrideCurrent = Schema.Codec.Encoded<
  typeof TransactionOverrideCurrentResponse
>

/** Retained independent history with the same current attention and coverage context. */
export type TransactionOverrideHistory = Schema.Codec.Encoded<
  typeof TransactionOverrideHistoryResponse
>

/** Current targets recorded for an owned transaction, including separately recorded fees. */
export type TransactionOverrideTargets = Schema.Codec.Encoded<
  typeof TransactionOverrideTargetsResponse
>

/** Exact committed acceptance; subsequent projections are separate reads. */
export type TransactionOverrideMutationResult = Schema.Codec.Encoded<
  typeof TransactionOverrideMutationResponse
>

/** Exact tagged decimal or factual-cause input with explicit compare-and-set facts. */
export type TransactionOverrideSet = Schema.Codec.Encoded<typeof TransactionOverrideSetRequest>

/** The stream kind, expected leaf and inspected revision for a withdrawal. */
export type TransactionOverrideWithdrawal = Schema.Codec.Encoded<
  typeof TransactionOverrideWithdrawRequest
>

export type TransactionOverridePriceInput = Extract<
  TransactionOverrideSet["input"],
  { readonly _tag: "price" }
>["input"]
export type TransactionOverrideClassificationInput = Extract<
  TransactionOverrideSet["input"],
  { readonly _tag: "classification" }
>["input"]

/** Reads name a year explicitly; the API resolves the current German scope to DE/EUR. */
export type TransactionOverrideReadInput = { readonly targetId: string; readonly taxYear: number }

export type TransactionOverrideDiscoveryInput = {
  readonly transactionId: string
  readonly taxYear: number
}
export type TransactionOverrideCreateInput = {
  readonly targetId: string
  readonly override: TransactionOverrideSet
}
export type TransactionOverrideReplaceInput = {
  readonly targetId: string
  readonly replacement: TransactionOverrideSet
}
export type TransactionOverrideWithdrawInput = {
  readonly targetId: string
  readonly withdrawal: TransactionOverrideWithdrawal
}

export type TransactionOverrideTargetsError = Effect.Error<
  ReturnType<TransactionOverridesClient["getTransactionOverrideTargets"]>
>
export type TransactionOverrideCurrentError = Effect.Error<
  ReturnType<TransactionOverridesClient["getTransactionOverrideCurrent"]>
>
export type TransactionOverrideHistoryError = Effect.Error<
  ReturnType<TransactionOverridesClient["getTransactionOverrideHistory"]>
>
export type TransactionOverrideCreateError = Effect.Error<
  ReturnType<TransactionOverridesClient["createTransactionOverride"]>
>
export type TransactionOverrideReplaceError = Effect.Error<
  ReturnType<TransactionOverridesClient["replaceTransactionOverride"]>
>
export type TransactionOverrideWithdrawError = Effect.Error<
  ReturnType<TransactionOverridesClient["withdrawTransactionOverride"]>
>

/** Structured API failures retained by Effect and recoverable from Promise rejections. */
export type TaxMaxiTransactionOverrideError =
  | TransactionOverrideConflictError
  | TransactionOverrideNotFoundError
  | TransactionOverrideReadonlyError
  | TransactionOverrideValidationError

/** Effect-native reads and audited mutations keyed by the recorded movement target. */
export interface TransactionOverridesEffectResource {
  readonly getTargets: (
    input: TransactionOverrideDiscoveryInput
  ) => Effect.Effect<TransactionOverrideTargets, TransactionOverrideTargetsError>
  readonly getCurrent: (
    input: TransactionOverrideReadInput
  ) => Effect.Effect<TransactionOverrideCurrent, TransactionOverrideCurrentError>
  readonly getHistory: (
    input: TransactionOverrideReadInput
  ) => Effect.Effect<TransactionOverrideHistory, TransactionOverrideHistoryError>
  readonly create: (
    input: TransactionOverrideCreateInput
  ) => Effect.Effect<TransactionOverrideMutationResult, TransactionOverrideCreateError>
  readonly replace: (
    input: TransactionOverrideReplaceInput
  ) => Effect.Effect<TransactionOverrideMutationResult, TransactionOverrideReplaceError>
  readonly withdraw: (
    input: TransactionOverrideWithdrawInput
  ) => Effect.Effect<TransactionOverrideMutationResult, TransactionOverrideWithdrawError>
}

/** Promise counterparts share authentication and optional request cancellation with the SDK. */
export interface TransactionOverridesPromiseResource {
  readonly getTargets: (
    input: TransactionOverrideDiscoveryInput,
    options?: AssetRequestOptions
  ) => Promise<TransactionOverrideTargets>
  readonly getCurrent: (
    input: TransactionOverrideReadInput,
    options?: AssetRequestOptions
  ) => Promise<TransactionOverrideCurrent>
  readonly getHistory: (
    input: TransactionOverrideReadInput,
    options?: AssetRequestOptions
  ) => Promise<TransactionOverrideHistory>
  readonly create: (
    input: TransactionOverrideCreateInput,
    options?: AssetRequestOptions
  ) => Promise<TransactionOverrideMutationResult>
  readonly replace: (
    input: TransactionOverrideReplaceInput,
    options?: AssetRequestOptions
  ) => Promise<TransactionOverrideMutationResult>
  readonly withdraw: (
    input: TransactionOverrideWithdrawInput,
    options?: AssetRequestOptions
  ) => Promise<TransactionOverrideMutationResult>
}

const encodeCurrent = Schema.encodeSync(TransactionOverrideCurrentResponse)
const encodeHistory = Schema.encodeSync(TransactionOverrideHistoryResponse)
const encodeTargets = Schema.encodeSync(TransactionOverrideTargetsResponse)
const encodeMutation = Schema.encodeSync(TransactionOverrideMutationResponse)

const decodeScope = (taxYear: number) =>
  Schema.decodeEffect(TransactionOverrideScopeQuery)({ taxYear: String(taxYear) })

/** Adapt the generated HTTP client without changing decimal, history or application facts. */
export const makeTransactionOverridesEffectResource = (
  client: Effect.Effect<Client, never>
): TransactionOverridesEffectResource => ({
  getTargets: ({ transactionId, taxYear }) =>
    Effect.gen(function* () {
      const query = yield* decodeScope(taxYear)
      const resolved = yield* client
      return encodeTargets(
        yield* resolved.transactionOverrides.getTransactionOverrideTargets({
          params: { transactionId },
          query,
        })
      )
    }),
  getCurrent: ({ targetId, taxYear }) =>
    Effect.gen(function* () {
      const query = yield* decodeScope(taxYear)
      const resolved = yield* client
      return encodeCurrent(
        yield* resolved.transactionOverrides.getTransactionOverrideCurrent({
          params: { targetId },
          query,
        })
      )
    }),
  getHistory: ({ targetId, taxYear }) =>
    Effect.gen(function* () {
      const query = yield* decodeScope(taxYear)
      const resolved = yield* client
      return encodeHistory(
        yield* resolved.transactionOverrides.getTransactionOverrideHistory({
          params: { targetId },
          query,
        })
      )
    }),
  create: ({ targetId, override }) =>
    Effect.gen(function* () {
      const payload = yield* Schema.decodeEffect(TransactionOverrideSetRequest)(override)
      const resolved = yield* client
      return encodeMutation(
        yield* resolved.transactionOverrides.createTransactionOverride({
          params: { targetId },
          payload,
        })
      )
    }),
  replace: ({ targetId, replacement }) =>
    Effect.gen(function* () {
      const payload = yield* Schema.decodeEffect(TransactionOverrideSetRequest)(replacement)
      const resolved = yield* client
      return encodeMutation(
        yield* resolved.transactionOverrides.replaceTransactionOverride({
          params: { targetId },
          payload,
        })
      )
    }),
  withdraw: ({ targetId, withdrawal }) =>
    Effect.gen(function* () {
      const payload = yield* Schema.decodeEffect(TransactionOverrideWithdrawRequest)(withdrawal)
      const resolved = yield* client
      return encodeMutation(
        yield* resolved.transactionOverrides.withdrawTransactionOverride({
          params: { targetId },
          payload,
        })
      )
    }),
})

/** Use the existing Promise runner, including its error wrapper and AbortSignal support. */
export const makeTransactionOverridesPromiseResource = (
  effect: TransactionOverridesEffectResource,
  run: <A>(effect: Effect.Effect<A, unknown, never>, options?: AssetRequestOptions) => Promise<A>
): TransactionOverridesPromiseResource => ({
  getTargets: (input, options) => run(effect.getTargets(input), options),
  getCurrent: (input, options) => run(effect.getCurrent(input), options),
  getHistory: (input, options) => run(effect.getHistory(input), options),
  create: (input, options) => run(effect.create(input), options),
  replace: (input, options) => run(effect.replace(input), options),
  withdraw: (input, options) => run(effect.withdraw(input), options),
})
