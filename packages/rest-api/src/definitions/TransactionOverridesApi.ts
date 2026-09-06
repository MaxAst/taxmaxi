/**
 * TransactionOverridesApi - Audited movement corrections and exact target discovery.
 *
 * @module TransactionOverridesApi
 */
import {
  AccountingEvent,
  TaxYear,
  MovementClassificationInput,
  MovementCorrectionFacts,
  MovementCorrectionInput,
  MovementCorrectionKind,
  MovementCorrectionTargetIdentity,
  ObservedConsiderationFact,
  MarketQuoteFact,
  ValuationFact,
} from "@my/core/accounting"
import { CurrencyCode } from "@my/core/currency"
import * as Schema from "effect/Schema"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { AuthMiddleware } from "./AuthMiddleware.ts"
import { InternalServerError } from "./ApiErrors.ts"

const Uuid = Schema.String.check(Schema.isUUID())

const IsoDate = Schema.toEncoded(Schema.DateTimeUtcFromString)

const NullableText = Schema.NullOr(Schema.String)

const Application = Schema.Literals(["inactive", "not_applied", "applied", "needs_attention"])

const ApplicationProblem = Schema.NullOr(
  Schema.Literals([
    "target_unavailable",
    "target_ineligible",
    "target_changed",
    "quantity_changed",
    "asset_changed",
    "structure_changed",
    "reporting_currency_mismatch",
  ])
)

const ResolvedPrice = Schema.NullOr(
  Schema.Struct({
    totalValue: Schema.String,
    unitPrice: Schema.Struct({ amount: Schema.String, rounded: Schema.Boolean }),
    currency: CurrencyCode,
  })
)

const Scope = Schema.Struct({
  jurisdiction: Schema.Literal("DE"),
  taxYear: Schema.Int,
  reportingCurrency: Schema.Literal("EUR"),
})

/** Coverage reads always name their selected year; the server resolves DE/EUR. */

export const TransactionOverrideScopeQuery = Schema.Struct({
  taxYear: Schema.FiniteFromString.pipe(Schema.decodeTo(TaxYear)),
})

const TargetParams = Schema.Struct({ targetId: Uuid })

const TransactionParams = Schema.Struct({ transactionId: Uuid })

const SystemEvidence = Schema.Struct({
  occurredAt: IsoDate,
  legKind: Schema.Literals(["acquisition", "disposal", "income", "fee"]),
  recordedFiatAmount: NullableText,
  recordedFiatCurrency: NullableText,
  transactionType: NullableText,
  providerTransactionType: NullableText,
  derivationRule: NullableText,
  feeForSourceRecordKey: NullableText,
})

const ValuationEvidence = Schema.Struct({
  reportingCurrency: CurrencyCode,
  facts: Schema.Array(
    Schema.Union([Schema.toEncoded(ObservedConsiderationFact), Schema.toEncoded(MarketQuoteFact)])
  ),
})

/** Immutable accepted facts and original evidence, independently of current conclusions. */

export const TransactionOverrideHistoryRecord = Schema.Struct({
  id: Uuid,
  principalId: Uuid,
  sourceId: Uuid,
  targetId: Uuid,
  kind: MovementCorrectionKind,
  operation: Schema.Literals(["create", "replace", "withdraw"]),
  inspectedFacts: Schema.toEncoded(MovementCorrectionFacts),
  inspectedSystem: SystemEvidence,
  inspectedValuationEvidence: ValuationEvidence,
  input: Schema.NullOr(MovementCorrectionInput),
  actorUserId: Uuid,
  reason: Schema.String,
  supersedesOverrideId: Schema.NullOr(Uuid),
  recordedAt: IsoDate,
})

const StreamFields = {
  leaf: Schema.NullOr(TransactionOverrideHistoryRecord),
  active: Schema.NullOr(TransactionOverrideHistoryRecord),
}

/** Exact owned inspection returned by reads, acceptance, and conflict responses. */

export const TransactionOverrideContext = Schema.Struct({
  targetId: Uuid,
  target: MovementCorrectionTargetIdentity,
  current: Schema.NullOr(
    Schema.Struct({
      legId: Uuid,
      transactionId: Schema.NullOr(Uuid),
      facts: Schema.toEncoded(MovementCorrectionFacts),
      system: SystemEvidence,
      valuationEvidence: ValuationEvidence,
    })
  ),
  price: Schema.Struct(StreamFields),
  classification: Schema.Struct(StreamFields),
  history: Schema.Array(TransactionOverrideHistoryRecord),
})

const EngineInputs = Schema.Struct({
  event: Schema.NullOr(Schema.toEncoded(AccountingEvent)),
  valuationFacts: Schema.Array(Schema.toEncoded(ValuationFact)),
  classificationEvidence: Schema.optional(
    Schema.TaggedStruct("user_assertion", { overrideId: Uuid })
  ),
})

const CustodyContext = Schema.Struct({
  reconciliationId: Uuid,
  canonicalTransferId: Uuid,
  providerTransferId: Uuid,
  canonicalTransactionId: Schema.NullOr(Uuid),
  providerTransactionId: Uuid,
  canonicalSourceId: Uuid,
  providerSourceId: Uuid,
  occurredAt: IsoDate,
  quantity: Schema.String,
  canonicalStoredAssetId: Uuid,
  providerStoredAssetId: Uuid,
  providerDirection: Schema.Literals(["inbound", "outbound"]),
  outcome: Schema.Literals(["included", "withheld", "outside_period"]),
})

const LegContext = Schema.Struct({
  targetId: Uuid,
  legId: Uuid,
  sourceId: Uuid,
  transactionId: Schema.NullOr(Uuid),
  occurredAt: IsoDate,
  quantity: Schema.String,
  storedAssetId: Uuid,
  effectiveAssetId: Schema.NullOr(Uuid),
  direction: Schema.Literals(["inbound", "outbound"]),
  structure: Schema.Literals(["ownership_change", "fee", "custody"]),
  legKind: Schema.Literals(["acquisition", "income", "disposal", "fee"]),
  transactionType: NullableText,
  providerTransactionType: NullableText,
  recordedFiatAmount: NullableText,
  recordedFiatCurrency: NullableText,
  providerFiatAmount: NullableText,
  providerFiatCurrency: NullableText,
  derivationRule: NullableText,
  feeForSourceRecordKey: NullableText,
  originKind: Schema.Literals(["none", "canonical_transfer", "provider_transfer"]),
  sourceTransferId: Schema.NullOr(Uuid),
  providerTransferId: Schema.NullOr(Uuid),
  custody: Schema.Array(CustodyContext),
})

const CurrentOutcome = Schema.Literals(["included", "withheld", "absent", "outside_period"])

const ApplicationFields = {
  application: Application,
  applicationProblem: ApplicationProblem,
  resolvedPrice: ResolvedPrice,
  system: EngineInputs,
  effective: EngineInputs,
}

const CapturedInput = Schema.Struct({
  history: TransactionOverrideHistoryRecord,
  current: Schema.NullOr(LegContext),
  currentOutcome: CurrentOutcome,
  streamState: Schema.Literals(["active", "withdrawn", "superseded"]),
  reportingCurrency: CurrencyCode,
  ...ApplicationFields,
})

const StreamProjection = Schema.Struct({
  ...StreamFields,
  stale: Schema.Boolean,
  application: Application,
  applicationProblem: ApplicationProblem,
  resolvedPrice: ResolvedPrice,
  replay: Schema.Struct({
    status: Schema.Literals(["not_scheduled", "updating", "complete", "failed"]),
    processingJobId: Schema.NullOr(Uuid),
    followUpJobId: Schema.NullOr(Uuid),
  }),
  coverage: Schema.NullOr(
    Schema.Struct({
      runId: Uuid,
      status: Schema.Literals(["running", "complete", "partial", "failed"]),
      failureCode: NullableText,
      overrideId: Uuid,
      input: Schema.Struct(ApplicationFields),
    })
  ),
  coverageStatus: Schema.Literals([
    "not_requested",
    "outside_period",
    "updating",
    "failed",
    "covered",
  ]),
})

/** Current inputs, independent attention/work/coverage, and structurally permitted factual choices. */

export const TransactionOverrideCurrentResponse = Schema.Struct({
  context: TransactionOverrideContext,
  scope: Scope,
  inputs: Schema.Struct({
    targetId: Uuid,
    current: Schema.NullOr(LegContext),
    currentOutcome: CurrentOutcome,
    system: EngineInputs,
    effective: EngineInputs,
    corrections: Schema.Array(CapturedInput),
  }),
  price: StreamProjection,
  classification: StreamProjection,
  validClassificationInputs: Schema.Array(MovementClassificationInput),
})
/** Owned current targets; empty is distinct from an unknown or foreign transaction. */

export const TransactionOverrideTargetsResponse = Schema.Struct({
  targets: Schema.Array(TransactionOverrideCurrentResponse),
})
/** History read retains the same current attention and covering-run context. */

export const TransactionOverrideHistoryResponse = TransactionOverrideCurrentResponse

const CompareAndSetFields = {
  expectedLeafId: Schema.NullOr(Uuid),
  expectedSystemRevision: Schema.Trimmed.check(Schema.isNonEmpty()),
  reason: Schema.Trimmed.check(Schema.isNonEmpty()),
}
/** Create and replace both compare the actual stream leaf, including a prior withdrawal. */

export const TransactionOverrideSetRequest = Schema.Struct({
  ...CompareAndSetFields,
  input: MovementCorrectionInput,
}).annotate({ parseOptions: { onExcessProperty: "error" } })
/** Append a withdrawal to one independent stream. */

export const TransactionOverrideWithdrawRequest = Schema.Struct({
  ...CompareAndSetFields,
  kind: MovementCorrectionKind,
}).annotate({ parseOptions: { onExcessProperty: "error" } })
/** Exact committed acceptance; a later read or dispatch failure cannot rewrite this result. */

export const TransactionOverrideMutationResponse = Schema.Struct({
  context: TransactionOverrideContext,
  overrideId: Uuid,
  sourceId: Uuid,
  processingJobId: Uuid,
})

/** Missing and foreign records intentionally share one response. */

export class TransactionOverrideNotFoundError extends Schema.TaggedError<TransactionOverrideNotFoundError>()(
  "TransactionOverrideNotFoundError",
  { code: Schema.Literal("target_not_found") },
  { httpApiStatus: 404 }
) {}
/** Read-only sessions may inspect but cannot append history. */

export class TransactionOverrideReadonlyError extends Schema.TaggedError<TransactionOverrideReadonlyError>()(
  "TransactionOverrideReadonlyError",
  { code: Schema.Literal("readonly_user") },
  { httpApiStatus: 403 }
) {}
/** Both compare-and-set failures retain the exact server-read context. */

export class TransactionOverrideConflictError extends Schema.TaggedError<TransactionOverrideConflictError>()(
  "TransactionOverrideConflictError",
  {
    code: Schema.Literal("override_conflict"),
    conflictKinds: Schema.Array(Schema.Literals(["stream_leaf", "system_revision"])),
    currentContext: TransactionOverrideContext,
  },
  { httpApiStatus: 409 }
) {}
/** Structurally incompatible input is rejected without history or work. */

export class TransactionOverrideValidationError extends Schema.TaggedError<TransactionOverrideValidationError>()(
  "TransactionOverrideValidationError",
  {
    code: Schema.Literals([
      "target_unavailable",
      "invalid_actor",
      "invalid_reason",
      "invalid_input",
      "stream_active",
      "stream_inactive",
      "reporting_currency_mismatch",
      "classification_direction_mismatch",
      "fee_classification_forbidden",
      "custody_correction_forbidden",
    ]),
  },
  { httpApiStatus: 422 }
) {}

const ReadErrors = [TransactionOverrideNotFoundError, InternalServerError] as const

const MutationErrors = [
  ...ReadErrors,
  TransactionOverrideReadonlyError,
  TransactionOverrideConflictError,
  TransactionOverrideValidationError,
] as const

/** Authenticated REST resource for corrections keyed by durable movement target. */

export class TransactionOverridesApi extends HttpApiGroup.make("transactionOverrides")
  .add(
    HttpApiEndpoint.get("getTransactionOverrideTargets", "/transactions/:transactionId/targets", {
      params: TransactionParams,
      query: TransactionOverrideScopeQuery,
      success: TransactionOverrideTargetsResponse,
      error: ReadErrors,
    })
  )
  .add(
    HttpApiEndpoint.get("getTransactionOverrideCurrent", "/:targetId/current", {
      params: TargetParams,
      query: TransactionOverrideScopeQuery,
      success: TransactionOverrideCurrentResponse,
      error: ReadErrors,
    })
  )
  .add(
    HttpApiEndpoint.get("getTransactionOverrideHistory", "/:targetId/history", {
      params: TargetParams,
      query: TransactionOverrideScopeQuery,
      success: TransactionOverrideHistoryResponse,
      error: ReadErrors,
    })
  )
  .add(
    HttpApiEndpoint.post("createTransactionOverride", "/:targetId/create", {
      params: TargetParams,
      payload: TransactionOverrideSetRequest,
      success: TransactionOverrideMutationResponse,
      error: MutationErrors,
    })
  )
  .add(
    HttpApiEndpoint.post("replaceTransactionOverride", "/:targetId/replace", {
      params: TargetParams,
      payload: TransactionOverrideSetRequest,
      success: TransactionOverrideMutationResponse,
      error: MutationErrors,
    })
  )
  .add(
    HttpApiEndpoint.post("withdrawTransactionOverride", "/:targetId/withdraw", {
      params: TargetParams,
      payload: TransactionOverrideWithdrawRequest,
      success: TransactionOverrideMutationResponse,
      error: MutationErrors,
    })
  )
  .middleware(AuthMiddleware)
  .prefix("/v1/transaction-overrides")
  .annotateMerge(
    OpenApi.annotations({
      title: "Movement corrections",
      description:
        "Audited principal-owned valuation and factual-cause corrections with exact run coverage.",
    })
  ) {}
