import {
  AssetOverrideCanonicalTargetError,
  AssetOverrideMutationConflictError,
  AssetOverrideReadonlyError,
  AssetOverrideReplacementValidationError,
  AssetOverrideTargetNotFoundError,
  AssetDecisionConflictError,
  AssetDecisionValidationError,
  AssetLookupNotFoundError,
  AssetLookupValidationError,
  AssetStaleRevisionError,
  AuthValidationError,
  PortfolioCalculationJobNotFoundResponse,
  SourceCreditRequiredError,
  TransactionOverrideConflictError,
  TransactionOverrideNotFoundError,
  TransactionOverrideReadonlyError,
  TransactionOverrideValidationError,
} from "@my/rest-api/contracts"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as SchemaAST from "effect/SchemaAST"
import { resolveAt } from "effect/SchemaAST"
import { HttpClientError } from "effect/unstable/http"
import type { TaxMaxiTransactionOverrideError } from "./transaction-overrides/index.ts"
import type { TaxMaxiAssetOverrideError } from "./asset-overrides/index.ts"

const TaxMaxiFieldError = Schema.Struct({
  field: Schema.optional(Schema.String),
  message: Schema.String,
})

export type TaxMaxiFieldError = typeof TaxMaxiFieldError.Type

export class TaxMaxiError extends Schema.Error<TaxMaxiError>("TaxMaxiError")({
  cause: Schema.optional(Schema.Unknown),
  code: Schema.optional(Schema.String),
  fieldErrors: Schema.Array(TaxMaxiFieldError).pipe(
    Schema.withConstructorDefault(Effect.succeed([]))
  ),
  message: Schema.String,
  requestId: Schema.optional(Schema.String),
  status: Schema.Finite,
}) {}

const isTaxMaxiError = Schema.is(TaxMaxiError)
const isAuthValidationError = Schema.is(AuthValidationError)

const getErrorRecord = (error: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof error === "object" && error !== null
    ? (error as Readonly<Record<string, unknown>>)
    : undefined

type SchemaConstructor = {
  readonly ast: SchemaAST.AST
}

const hasSchemaAst = (value: unknown): value is SchemaConstructor =>
  typeof value === "object" && value !== null && "ast" in value

const getErrorCode = (error: unknown): string | undefined => {
  const record = getErrorRecord(error)
  return typeof record?._tag === "string" ? record._tag : undefined
}

const getStringProperty = (error: unknown, property: string): string | undefined => {
  const value = getErrorRecord(error)?.[property]
  return typeof value === "string" && value !== "" ? value : undefined
}

const getCauseMessage = (cause: unknown): string | undefined => {
  if (cause instanceof Error && cause.message !== "") {
    return cause.message
  }

  if (typeof cause === "string" && cause !== "") {
    return cause
  }

  return undefined
}

const getFieldErrors = (error: unknown): ReadonlyArray<TaxMaxiFieldError> => {
  if (!isAuthValidationError(error)) {
    return []
  }

  const field = Option.getOrUndefined(error.field)

  if (field === undefined) {
    return []
  }

  return [{ field, message: error.message }]
}

const getAnnotatedErrorStatus = (error: unknown): number | undefined => {
  if (!(error instanceof Error) || !hasSchemaAst(error.constructor)) {
    return undefined
  }

  return resolveAt<number>("httpApiStatus")(error.constructor.ast) ?? 500
}

const getErrorStatusFromCode = (code: string | undefined): number | undefined => {
  if (code === undefined) {
    return undefined
  }

  if (code.includes("UnauthorizedError")) {
    return 401
  }

  if (code.includes("ForbiddenError")) {
    return 403
  }

  if (
    code.includes("BadRequestError") ||
    code.includes("ValidationError") ||
    code.includes("ParseError")
  ) {
    return 400
  }

  if (code.includes("NotFoundError")) {
    return 404
  }

  return undefined
}

export const isTaxMaxiUnauthorizedError = (error: unknown): error is TaxMaxiError =>
  isTaxMaxiError(error) && (error.status === 401 || getErrorStatusFromCode(error.code) === 401)

export type TaxMaxiCreditRequired = {
  readonly reasonCode: SourceCreditRequiredError["reasonCode"]
  readonly availableCredits: number
}

const decodeCreditRequired = Schema.decodeUnknownExit(SourceCreditRequiredError)

/**
 * Extract the structured credit details from a credit-required (402) sync
 * refusal, or null for any other error. Clients use these fields to render
 * their own recovery copy instead of the error message.
 */
export const getTaxMaxiCreditRequired = (error: unknown): TaxMaxiCreditRequired | null => {
  const candidate = isTaxMaxiError(error) ? error.cause : error

  return Exit.match(decodeCreditRequired(candidate), {
    onFailure: () => null,
    onSuccess: ({ availableCredits, reasonCode }) => ({ availableCredits, reasonCode }),
  })
}

export type TaxMaxiAssetDecisionConflict =
  | "stale_revision"
  | "ambiguous_identity"
  | "identity_changed"

export type TaxMaxiAssetDecisionErrorCode =
  | TaxMaxiAssetDecisionConflict
  | "invalid_evidence"
  | "invalid_claim"

const decodeAssetDecisionError = Schema.decodeUnknownExit(
  Schema.Union([AssetStaleRevisionError, AssetDecisionConflictError, AssetDecisionValidationError])
)

export type TaxMaxiAssetLookupErrorCode = "invalid_lookup" | "observation_not_found"

const decodeAssetLookupError = Schema.decodeUnknownExit(
  Schema.Union([AssetLookupValidationError, AssetLookupNotFoundError])
)

const AssetOverrideError = Schema.Union([
  AssetOverrideCanonicalTargetError,
  AssetOverrideTargetNotFoundError,
  AssetOverrideReadonlyError,
  AssetOverrideMutationConflictError,
  AssetOverrideReplacementValidationError,
])

const isAssetOverrideError = Schema.is(AssetOverrideError)
const decodeAssetOverrideError = Schema.decodeUnknownExit(AssetOverrideError)

/** Extract structured principal asset override details from an SDK or Effect error. */
export const getTaxMaxiAssetOverrideError = (error: unknown): TaxMaxiAssetOverrideError | null => {
  const candidate = isTaxMaxiError(error) ? error.cause : error
  if (isAssetOverrideError(candidate)) return candidate

  return Exit.match(decodeAssetOverrideError(candidate), {
    onFailure: () => null,
    onSuccess: (details) => details,
  })
}

const TransactionOverrideError = Schema.Union([
  TransactionOverrideConflictError,
  TransactionOverrideNotFoundError,
  TransactionOverrideReadonlyError,
  TransactionOverrideValidationError,
])

const isTransactionOverrideError = Schema.is(TransactionOverrideError)
const decodeTransactionOverrideError = Schema.decodeUnknownExit(TransactionOverrideError)

// Generated client errors may be plain decoded values without an Error constructor.
// Read status from the matching declared schema, preserving its exact API contract.
const getTransactionOverrideErrorStatus = (error: unknown): number | undefined => {
  const details = getTaxMaxiTransactionOverrideError(error)
  if (details === null) return undefined
  for (const errorSchema of TransactionOverrideError.members) {
    if (Schema.is(errorSchema)(details)) return resolveAt<number>("httpApiStatus")(errorSchema.ast)
  }
  return undefined
}

/** Recover exact movement conflict or validation details from an SDK, Effect or encoded error. */
export const getTaxMaxiTransactionOverrideError = (
  error: unknown
): TaxMaxiTransactionOverrideError | null => {
  const candidate = isTaxMaxiError(error) ? error.cause : error
  if (isTransactionOverrideError(candidate)) return candidate
  return Exit.match(decodeTransactionOverrideError(candidate), {
    onFailure: () => null,
    onSuccess: (details) => details,
  })
}

/** Extract the machine-readable code from an asset observation lookup failure. */
export const getTaxMaxiAssetLookupErrorCode = (
  error: unknown
): TaxMaxiAssetLookupErrorCode | null => {
  const candidate = isTaxMaxiError(error) ? error.cause : error

  return Exit.match(decodeAssetLookupError(candidate), {
    onFailure: () => null,
    onSuccess: ({ code }) => code,
  })
}

/** Extract the machine-readable code from an asset exception decision failure. */
export const getTaxMaxiAssetDecisionErrorCode = (
  error: unknown
): TaxMaxiAssetDecisionErrorCode | null => {
  const candidate = isTaxMaxiError(error) ? error.cause : error

  return Exit.match(decodeAssetDecisionError(candidate), {
    onFailure: () => null,
    onSuccess: ({ code }) => code,
  })
}

/** Extract the machine-readable conflict from an asset exception decision failure. */
export const getTaxMaxiAssetDecisionConflict = (
  error: unknown
): TaxMaxiAssetDecisionConflict | null => {
  const code = getTaxMaxiAssetDecisionErrorCode(error)
  return code === "stale_revision" || code === "ambiguous_identity" || code === "identity_changed"
    ? code
    : null
}

export const toTaxMaxiError = (error: unknown): TaxMaxiError => {
  if (isTaxMaxiError(error)) {
    return error
  }

  const portfolioNotFound = Schema.decodeUnknownExit(PortfolioCalculationJobNotFoundResponse)(error)
  if (Exit.isSuccess(portfolioNotFound)) {
    return new TaxMaxiError({
      cause: error,
      code: portfolioNotFound.value._tag,
      message: "TaxMaxi API request failed.",
      status: 404,
    })
  }

  if (HttpClientError.isHttpClientError(error)) {
    if (error.reason._tag === "TransportError") {
      const causeMessage = getCauseMessage(error.reason.cause)

      return new TaxMaxiError({
        cause: error,
        code: getErrorCode(error),
        message:
          causeMessage === undefined
            ? "Could not reach the TaxMaxi API."
            : `Could not reach the TaxMaxi API: ${causeMessage}`,
        status: 0,
      })
    }

    return new TaxMaxiError({
      cause: error,
      code: getErrorCode(error),
      message:
        error.reason._tag === "StatusCodeError"
          ? "TaxMaxi API request failed."
          : "Received an unexpected response from the TaxMaxi API.",
      status: error.response?.status ?? 0,
    })
  }

  if (Schema.isSchemaError(error)) {
    return new TaxMaxiError({
      cause: error,
      code: "ParseError",
      message: "TaxMaxi API request or response validation failed.",
      status: 400,
    })
  }

  if (error instanceof TypeError) {
    return new TaxMaxiError({
      cause: error,
      code: error.name,
      message:
        error.message === ""
          ? "Could not reach the TaxMaxi API."
          : `Could not reach the TaxMaxi API: ${error.message}`,
      status: 0,
    })
  }

  if (
    error instanceof Error &&
    (error.name.includes("RequestError") || error.message.startsWith("Transport error"))
  ) {
    return new TaxMaxiError({
      cause: error,
      code: error.name,
      message:
        error.message === ""
          ? "Could not reach the TaxMaxi API."
          : `Could not reach the TaxMaxi API: ${error.message}`,
      status: 0,
    })
  }

  const code = getErrorCode(error)

  if (code !== undefined) {
    return new TaxMaxiError({
      cause: error,
      code,
      fieldErrors: getFieldErrors(error),
      message: getStringProperty(error, "message") ?? "TaxMaxi API request failed.",
      requestId: getStringProperty(error, "requestId"),
      status:
        getTransactionOverrideErrorStatus(error) ??
        getAnnotatedErrorStatus(error) ??
        getErrorStatusFromCode(code) ??
        500,
    })
  }

  if (error instanceof Error) {
    return new TaxMaxiError({
      cause: error,
      code: error.name,
      message: error.message === "" ? "TaxMaxi API request failed." : error.message,
      status: 500,
    })
  }

  return new TaxMaxiError({
    cause: error,
    message: "TaxMaxi API request failed.",
    status: 500,
  })
}
