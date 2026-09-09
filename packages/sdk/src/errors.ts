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
  AuthApi,
  AuthValidationError,
  EmailVerificationRequiredError,
  PasswordWeakError,
  PortfolioCalculationJobNotFoundResponse,
  SourceCreditRequiredError,
  TransactionOverrideConflictError,
  TransactionOverrideNotFoundError,
  TransactionOverrideReadonlyError,
  TransactionOverrideValidationError,
  VerificationResendRateLimitedError,
} from "@my/rest-api/contracts"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as SchemaAST from "effect/SchemaAST"
import { resolveAt } from "effect/SchemaAST"
import { HttpClientError } from "effect/unstable/http"
import type { HttpApiEndpoint } from "effect/unstable/httpapi"
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

// Schema classes are functions, so `error.constructor` is a function here.
const hasSchemaAst = (value: unknown): value is SchemaConstructor =>
  (typeof value === "object" || typeof value === "function") && value !== null && "ast" in value

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

// Errors the generated client yields are instances of their declared schema
// class, and each class carries its `httpApiStatus` annotation. A class with
// no status falls through to the code-based lookup.
const getAnnotatedErrorStatus = (error: unknown): number | undefined => {
  if (!(error instanceof Error) || !hasSchemaAst(error.constructor)) {
    return undefined
  }

  return resolveAt<number>("httpApiStatus")(error.constructor.ast)
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

export type TaxMaxiPasswordRequirement = PasswordWeakError["requirements"][number]

export type TaxMaxiPasswordRequirements = {
  readonly requirements: ReadonlyArray<TaxMaxiPasswordRequirement>
  readonly minPasswordLength: number
}

const decodePasswordWeak = Schema.decodeUnknownExit(PasswordWeakError)

/**
 * Extract the unmet password rule codes and the minimum length from a weak
 * password (400) refusal, or null for any other error. The codes carry no
 * display text; clients map each code to their own copy.
 */
export const getTaxMaxiPasswordRequirements = (
  error: unknown
): TaxMaxiPasswordRequirements | null => {
  const candidate = isTaxMaxiError(error) ? error.cause : error

  return Exit.match(decodePasswordWeak(candidate), {
    onFailure: () => null,
    onSuccess: ({ minPasswordLength, requirements }) => ({ minPasswordLength, requirements }),
  })
}

const decodeEmailVerificationRequired = Schema.decodeUnknownExit(EmailVerificationRequiredError)

/**
 * True when a login was refused (403) because the local email is still
 * unverified. The API has restored the verification cookie, so the client
 * can continue on its verify page.
 */
export const isTaxMaxiEmailVerificationRequiredError = (error: unknown): boolean => {
  const candidate = isTaxMaxiError(error) ? error.cause : error

  return Exit.isSuccess(decodeEmailVerificationRequired(candidate))
}

const decodeResendRateLimited = Schema.decodeUnknownExit(VerificationResendRateLimitedError)

/**
 * Extract the wait in seconds from a resend refusal (429), or null for any
 * other error. A number only; clients render their own countdown.
 */
export const getTaxMaxiRetryAfterSeconds = (error: unknown): number | null => {
  const candidate = isTaxMaxiError(error) ? error.cause : error

  return Exit.match(decodeResendRateLimited(candidate), {
    onFailure: () => null,
    onSuccess: ({ retryAfterSeconds }) => retryAfterSeconds,
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
const getDeclaredStatus = (
  members: ReadonlyArray<Schema.Top>,
  details: unknown
): number | undefined => {
  for (const errorSchema of members) {
    if (Schema.is(errorSchema)(details)) return resolveAt<number>("httpApiStatus")(errorSchema.ast)
  }
  return undefined
}

const getTransactionOverrideErrorStatus = (error: unknown): number | undefined => {
  const details = getTaxMaxiTransactionOverrideError(error)
  return details === null ? undefined : getDeclaredStatus(TransactionOverrideError.members, details)
}

// The endpoints behind the SDK's local-auth methods (`auth.providers`,
// `register`, `verifyEmail`, `resendVerification`, `login`).
const LOCAL_AUTH_ENDPOINTS = [
  "getProviders",
  "register",
  "verifyEmail",
  "resendVerification",
  "login",
] as const satisfies ReadonlyArray<keyof typeof AuthApi.endpoints>

// One error schema an endpoint declares. The runtime `error` set is typed as
// `Schema.Top`; the contract types the whole set as one codec (`~Error`), so
// each member decodes to one of its values with the same decoding services.
type DeclaredError<Endpoint extends HttpApiEndpoint.Constraint> = Schema.Codec<
  Endpoint["~Error"]["Type"],
  unknown,
  Endpoint["~Error"]["DecodingServices"],
  unknown
>

const getDeclaredErrors = <
  Endpoint extends HttpApiEndpoint.Constraint & { readonly error: ReadonlySet<Schema.Top> },
>(
  endpoint: Endpoint
): ReadonlyArray<DeclaredError<Endpoint>> =>
  Array.from(endpoint.error) as ReadonlyArray<DeclaredError<Endpoint>>

// Every error those endpoints declare, read from the contract itself so an
// error added to an endpoint later maps to its declared status without an
// SDK change. Plain bodies (not class instances) need this decode step.
const LocalAuthError = Schema.Union(
  Array.from(
    new Set(LOCAL_AUTH_ENDPOINTS.flatMap((name) => getDeclaredErrors(AuthApi.endpoints[name])))
  )
)

const decodeLocalAuthError = Schema.decodeUnknownExit(LocalAuthError)

const getLocalAuthErrorStatus = (error: unknown): number | undefined => {
  const candidate = isTaxMaxiError(error) ? error.cause : error

  return Exit.match(decodeLocalAuthError(candidate), {
    onFailure: () => undefined,
    onSuccess: (details) => getDeclaredStatus(LocalAuthError.members, details),
  })
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
        getLocalAuthErrorStatus(error) ??
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
