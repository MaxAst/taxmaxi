/**
 * TransactionsApi - Principal-owned canonical transaction list and detail.
 *
 * @module TransactionsApi
 */

import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import * as Schema from "effect/Schema"
import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { AssetOverrideCurrentResponse } from "./AssetOverridesApi.ts"
import {
  TransactionOverrideCurrentResponse,
  TransactionOverrideScopeQuery,
} from "./TransactionOverridesApi.ts"
import { InternalServerError } from "./ApiErrors.ts"
import { SourceNotFoundError } from "./SourcesApi.ts"
import { AuthMiddleware } from "./AuthMiddleware.ts"

export class TransactionBadRequestError extends Schema.TaggedError<TransactionBadRequestError>()(
  "TransactionBadRequestError",
  { message: Schema.String },
  { httpApiStatus: 400 }
) {}

// An explicit UTC offset keeps boundaries independent of the API host timezone.
const TransactionDateBoundary = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/),
  Schema.makeFilter(
    (value) => {
      // Validate the written calendar/time before applying its offset; Date parsing can roll days forward.
      const localSecond = value.slice(0, 19)
      return DateTime.make(`${localSecond}Z`).pipe(
        Option.exists((date) => DateTime.formatIso(date).slice(0, 19) === localSecond)
      )
    },
    { expected: "a real calendar date and time" }
  )
).pipe(Schema.decodeTo(Schema.Date, SchemaTransformation.dateFromString))

const TransactionAttentionQuery = Schema.Literals(["true", "false"]).pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transform({
      decode: (value) => value === "true",
      encode: (value) => (value ? "true" : "false"),
    })
  )
)

/** Empty source selection means all owned sources; dates form a UTC half-open interval. */
export const TransactionListQuery = Schema.Struct({
  sourceId: Schema.optional(Schema.String.check(Schema.isUUID())),
  sourceIds: Schema.optional(Schema.Array(Schema.String.check(Schema.isUUID()))),
  from: Schema.optional(TransactionDateBoundary),
  to: Schema.optional(TransactionDateBoundary),
  order: Schema.optional(Schema.Literals(["newest", "oldest"])),
  attention: Schema.optional(TransactionAttentionQuery),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.FiniteFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(500)
    )
  ),
})

/** Compact source facts for a transaction row. */
export class TransactionListSource extends Schema.Class<TransactionListSource>(
  "TransactionListSource"
)({
  sourceId: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["onchain", "cex", "dex"]),
}) {}

/** Values and identity captured together by one completed calculation. */
export const TransactionListMovementCapture = Schema.Struct({
  runId: Schema.String,
  eventId: Schema.NullOr(Schema.String),
  outcome: Schema.Literals(["included", "withheld", "absent", "outside_period"]),
  quantity: Schema.NullOr(Schema.String),
  assetId: Schema.NullOr(Schema.String),
  assetSymbol: Schema.NullOr(Schema.String),
  eventKind: Schema.NullOr(Schema.Literals(["acquisition", "disposition", "custody_movement"])),
  cause: Schema.NullOr(Schema.String),
  valuationState: Schema.Literals(["selected", "not_evaluated", "missing", "ambiguous"]),
  selectedValue: Schema.NullOr(
    Schema.Struct({
      kind: Schema.Literals(["user_valuation", "observed_consideration", "market_quote"]),
      amount: Schema.String,
      currency: Schema.String,
    })
  ),
  providerConsiderations: Schema.Array(
    Schema.Struct({ amount: Schema.String, currency: Schema.String })
  ),
  acquisitionCostBasis: Schema.Null,
  realizedResults: Schema.Array(
    Schema.Struct({
      acquisitionEventId: Schema.String,
      quantity: Schema.String,
      costBasis: Schema.String,
      proceeds: Schema.String,
      gainLoss: Schema.String,
      currency: Schema.String,
    })
  ),
})

/** Compact movement facts for a transaction row. */
export class TransactionListMovement extends Schema.Class<TransactionListMovement>(
  "TransactionListMovement"
)({
  targetId: Schema.String,
  capture: Schema.NullOr(TransactionListMovementCapture),
  amount: Schema.String,
  assetSymbol: Schema.String,
  kind: Schema.Literals(["acquisition", "disposal", "income", "fee"]),
}) {}

/** One compact transaction row for the web table. */
export class TransactionListItem extends Schema.Class<TransactionListItem>("TransactionListItem")({
  transactionId: Schema.String,
  timestamp: Schema.String,
  source: TransactionListSource,
  /** Imported category; corrected causes belong to the completed movement captures. */
  transactionType: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  externalId: Schema.NullOr(Schema.String),
  movements: Schema.Array(TransactionListMovement),
  /** Income value in fiatCurrency from the active calculation. */
  income: Schema.NullOr(Schema.String),
  realizedGainLoss: Schema.NullOr(Schema.String),
  fiatCurrency: Schema.NullOr(Schema.String),
  calculationState: Schema.Literals(["complete", "partial"]),
  needsReview: Schema.Boolean,
  /** An owned review or blocker explicitly links to this transaction or one of its movements. */
  attention: Schema.Boolean,
}) {}

export class TransactionListPageInfo extends Schema.Class<TransactionListPageInfo>(
  "TransactionListPageInfo"
)({
  nextCursor: Schema.NullOr(Schema.String),
  hasMore: Schema.Boolean,
}) {}

/** Cursor page plus an exact count of principal-owned transactions that have accounting legs. */
export class TransactionListResponse extends Schema.Class<TransactionListResponse>(
  "TransactionListResponse"
)({
  transactions: Schema.Array(TransactionListItem),
  page: TransactionListPageInfo,
  totalCount: Schema.Finite,
}) {}

/** Owned economic assets available for filtering, including historical zero holdings. */
export class TransactionFilterChoicesResponse extends Schema.Class<TransactionFilterChoicesResponse>(
  "TransactionFilterChoicesResponse"
)({
  assets: Schema.Array(
    Schema.Struct({
      assetId: Schema.String,
      symbol: Schema.String,
      name: Schema.String,
      type: Schema.Literals(["fungible", "nft"]),
      coingeckoCoinId: Schema.NullOr(Schema.String),
      logoUrl: Schema.NullOr(Schema.String),
    })
  ),
}) {}

/** Missing, foreign and activity identifiers share the same public failure. */
export class TransactionNotFoundError extends Schema.TaggedError<TransactionNotFoundError>()(
  "TransactionNotFoundError",
  { code: Schema.Literal("transaction_not_found") },
  { httpApiStatus: 404 }
) {}

/** Explicit selected year in the supported DE/EUR scope. */
export const TransactionDetailQuery = TransactionOverrideScopeQuery

const NullableText = Schema.NullOr(Schema.String)
const IsoDate = Schema.toEncoded(Schema.DateTimeUtcFromString)
const EvidenceStatus = Schema.Literals(["available", "unavailable"])
const Evidence = Schema.Struct({
  sourceId: Schema.String,
  id: Schema.String,
  provider: Schema.String,
  recordType: Schema.String,
  externalRecordId: Schema.String,
  occurredAt: IsoDate,
  importedAt: IsoDate,
})

/** Owned recorded facts, current decisions and one immutable calculation snapshot. */
export const TransactionDetailResponse = Schema.Struct({
  attention: Schema.Boolean,
  transactionId: Schema.String,
  timestamp: IsoDate,
  source: TransactionListSource,
  sourceRawRecordId: NullableText,
  transactionType: NullableText,
  providerTransactionType: NullableText,
  description: NullableText,
  externalId: NullableText,
  classificationHistoryStatus: Schema.Literal("unavailable"),
  sourceEvidence: Schema.Array(
    Schema.Struct({
      origin: Schema.Literals(["transaction", "leg", "provider_transfer", "canonical_transfer"]),
      originId: Schema.String,
      sourceId: Schema.String,
      sourceRawRecordId: NullableText,
      evidence: Schema.NullOr(Evidence),
      status: EvidenceStatus,
    })
  ),
  movements: Schema.Array(
    Schema.Struct({
      capture: Schema.NullOr(TransactionListMovementCapture),
      imported: Schema.Struct({
        timestamp: IsoDate,
        assetId: Schema.String,
        amount: Schema.String,
        kind: Schema.Literals(["acquisition", "disposal", "income", "fee"]),
      }),
      id: Schema.String,
      transactionId: NullableText,
      sourceId: Schema.String,
      timestamp: IsoDate,
      assetId: Schema.String,
      amount: Schema.String,
      kind: Schema.Literals(["acquisition", "disposal", "income", "fee"]),
      provenance: Schema.Literals(["deterministic", "rule", "ai", "manual"]),
      derivationRule: NullableText,
      movementCorrectionTargetId: Schema.String,
      sourceRawRecordId: NullableText,
      sourceRepresentationUseId: NullableText,
      providerAssetRowId: NullableText,
      assetRepresentationId: NullableText,
      originKind: Schema.Literals(["provider_transfer", "canonical_transfer", "none"]),
      providerTransferId: NullableText,
      sourceTransferId: NullableText,
      feeForTransactionId: NullableText,
      evidence: Schema.NullOr(Evidence),
      evidenceStatus: EvidenceStatus,
    })
  ),
  reconciliations: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      providerTransferId: Schema.String,
      canonicalTransferId: NullableText,
      canonicalTransactionId: NullableText,
      status: Schema.Literals(["pending", "needs_review", "approved", "rejected", "auto_applied"]),
      matchReason: Schema.String,
      deterministic: Schema.Boolean,
    })
  ),
  movementOverrides: Schema.Array(TransactionOverrideCurrentResponse),
  assetOverrides: Schema.Array(
    Schema.Struct({
      movementId: Schema.String,
      projection: Schema.NullOr(AssetOverrideCurrentResponse),
    })
  ),
  calculation: Schema.Struct({
    run: Schema.NullOr(
      Schema.Struct({
        id: Schema.String,
        jurisdiction: Schema.String,
        taxYear: Schema.Int,
        reportingCurrency: Schema.String,
        status: Schema.Literals(["pending", "running", "complete", "partial", "failed"]),
        engineVersion: Schema.String,
        ruleSetVersion: Schema.String,
        inputLedgerRevision: Schema.String,
        valuationRevision: Schema.String,
        failureCode: NullableText,
      })
    ),
    state: Schema.Literals(["complete", "partial"]),
    monetaryStatus: Schema.Literals(["available", "partial", "unavailable", "not_applicable"]),
    derivedLots: Schema.Array(
      Schema.Struct({
        sequence: Schema.Int,
        acquisitionEventId: Schema.String,
        assetId: Schema.String,
        custodyUnitId: Schema.String,
        acquiredAt: IsoDate,
        remainingQuantity: Schema.String,
        costBasisPerUnit: NullableText,
      })
    ),
    allocations: Schema.Array(
      Schema.Struct({
        sequence: Schema.Int,
        acquisitionEventId: Schema.String,
        dispositionEventId: Schema.String,
        assetId: Schema.String,
        custodyUnitId: Schema.String,
        acquiredAt: IsoDate,
        disposedAt: IsoDate,
        quantity: Schema.String,
        costBasis: NullableText,
        proceeds: NullableText,
        gainLoss: NullableText,
        treatmentCodes: Schema.Array(Schema.String),
      })
    ),
    income: Schema.Array(
      Schema.Struct({
        sequence: Schema.Int,
        sourceId: Schema.String,
        eventId: Schema.String,
        assetId: Schema.String,
        occurredAt: IsoDate,
        quantity: Schema.String,
        value: Schema.String,
        treatmentCodes: Schema.Array(Schema.String),
      })
    ),
    blockers: Schema.Array(
      Schema.Struct({
        sequence: Schema.Int,
        eventId: Schema.String,
        code: Schema.String,
        assetId: NullableText,
        providerAssetRowId: NullableText,
        custodyUnitId: Schema.String,
        missingQuantity: NullableText,
      })
    ),
    processedEventIds: Schema.Array(Schema.String),
    correctionInputs: TransactionOverrideCurrentResponse.fields.inputs.fields.corrections,
  }),
})

const filterChoices = HttpApiEndpoint.get("filterChoices", "/transactions/filter-choices", {
  success: TransactionFilterChoicesResponse,
  error: [InternalServerError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "Get transaction filter choices",
    description:
      "Returns owned economic assets with disambiguating metadata, including historical assets with zero holdings. Choices use the same completed calculation projection as transaction rows.",
  })
)

const getTransaction = HttpApiEndpoint.get("getTransaction", "/transactions/:transactionId", {
  params: Schema.Struct({ transactionId: Schema.String.check(Schema.isUUID()) }),
  query: TransactionDetailQuery,
  success: TransactionDetailResponse,
  error: [TransactionNotFoundError, TransactionBadRequestError, InternalServerError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "Get transaction detail",
    description:
      "Returns owned recorded evidence, current correction histories and exact stored results for one selected DE/EUR calculation run. Unknown monetary values remain null.",
  })
)

const listTransactions = HttpApiEndpoint.get("listTransactions", "/transactions", {
  query: TransactionListQuery,
  success: TransactionListResponse,
  error: [TransactionBadRequestError, SourceNotFoundError, InternalServerError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "List transactions",
    description:
      "Returns a stable cursor page of compact accounting transactions owned by the authenticated principal. Select exact owned sources with repeated sourceIds parameters or the sourceId shorthand, never both. Omitted or empty sourceIds selects all owned sources. Optional from/to timestamps require explicit UTC offsets and form an inclusive-start, exclusive-end interval. Order is newest (default) or oldest, with transaction IDs breaking timestamp ties. Optional attention=true selects rows with an explicitly linked owned review or blocker; false or omitted keeps all rows. Cursors are bound to the source set, dates, order and attention selection. Rows and totalCount share these filters and exclude provider activity without accounting movements.",
  })
)

export class TransactionsApi extends HttpApiGroup.make("transactions")
  .add(listTransactions, filterChoices, getTransaction)
  .middleware(AuthMiddleware)
  .prefix("/v1")
  .annotateMerge(
    OpenApi.annotations({
      title: "Transactions",
      description: "Principal-owned canonical transaction reads",
    })
  ) {}
