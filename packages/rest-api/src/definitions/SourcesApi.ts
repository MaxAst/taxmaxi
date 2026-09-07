/**
 * SourcesApi - HTTP API group for sources
 *
 * Provides endpoints for:
 * - Syncing transactions for a source
 * - Checking sync job status for a source
 * - Calculating tax of a synced source
 *
 * @module SourcesApi
 */

import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import { AuthMiddleware } from "./AuthMiddleware.ts"
import { ReportReviewReasonCode } from "@my/core/report"
import { SyncCreditReasonCode } from "@my/core/billing"
import {
  ChainType,
  NameServiceNamespace,
  Source,
  WalletNameResolutionErrorCode,
} from "@my/core/source"
import { InternalServerError, UnauthorizedError } from "./ApiErrors.ts"

// =============================================================================
// Source-Specific Error Schemas (with HTTP status codes)
// =============================================================================

export class SourceBadRequestError extends Schema.TaggedError<SourceBadRequestError>()(
  "SourceBadRequestError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 }
) {}

export class SourceNotFoundError extends Schema.TaggedError<SourceNotFoundError>()(
  "SourceNotFoundError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 404 }
) {}

export class SourcePaymentRequiredError extends Schema.TaggedError<SourcePaymentRequiredError>()(
  "SourcePaymentRequiredError",
  {
    message: Schema.String,
    paymentRequired: Schema.optional(Schema.Unknown),
  },
  { httpApiStatus: 402 }
) {}

/**
 * SourceTaxCalculationBlockingObservation - A provider asset observation blocking
 * a source's tax calculation, named by provider and currency code.
 */
export class SourceTaxCalculationBlockingObservation extends Schema.Class<SourceTaxCalculationBlockingObservation>(
  "SourceTaxCalculationBlockingObservation"
)({
  provider: Schema.String,
  currencyCode: Schema.String,
}) {}

/**
 * SourceTaxCalculationPendingError - The source has unresolved provider asset
 * observations, so its tax calculation cannot run yet.
 */
export class SourceTaxCalculationPendingError extends Schema.TaggedError<SourceTaxCalculationPendingError>()(
  "SourceTaxCalculationPendingError",
  {
    message: Schema.String,
    blockingObservations: Schema.Array(SourceTaxCalculationBlockingObservation),
  },
  { httpApiStatus: 422 }
) {}

/**
 * SourceCreditRequiredError - Caller has no usable credits to start a billable sync (402).
 */
export class SourceCreditRequiredError extends Schema.TaggedError<SourceCreditRequiredError>()(
  "SourceCreditRequiredError",
  {
    message: Schema.String,
    reasonCode: SyncCreditReasonCode,
    availableCredits: Schema.Finite,
  },
  { httpApiStatus: 402 }
) {}

// =============================================================================
// Request/Response Schemas
// =============================================================================

/**
 * SourceListResponse - Started source sync job info
 */
export class SourceListResponse extends Schema.Class<SourceListResponse>("SourceListResponse")({
  sources: Schema.Array(Source),
}) {}

/**
 * SourceCreateRequest - Request body for creating or reusing an onchain source.
 */
export class SourceCreateRequest extends Schema.Class<SourceCreateRequest>("SourceCreateRequest")({
  type: Schema.Literal("onchain"),
  walletAddress: Schema.Trimmed.check(Schema.isNonEmpty()),
  name: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty())),
  sync: Schema.optional(Schema.Boolean),
  year: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(2020))),
  jurisdiction: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty())),
}) {}

/**
 * SourceNameResolveRequest - Request body for resolving a wallet name.
 */
export class SourceNameResolveRequest extends Schema.Class<SourceNameResolveRequest>(
  "SourceNameResolveRequest"
)({
  name: Schema.Trimmed.check(Schema.isNonEmpty()),
}) {}

/**
 * SourceNameResolveResponse - Resolved wallet name and address.
 */
export class SourceNameResolveResponse extends Schema.Class<SourceNameResolveResponse>(
  "SourceNameResolveResponse"
)({
  name: Schema.String,
  namespace: NameServiceNamespace,
  resolvedAddress: Schema.String,
  chainType: ChainType,
}) {}

/**
 * SourceNameResolutionError - A wallet name could not be resolved.
 *
 * `code` is the stable contract for clients; `message` is developer-facing
 * and not meant for display.
 */
export class SourceNameResolutionError extends Schema.TaggedError<SourceNameResolutionError>()(
  "SourceNameResolutionError",
  {
    code: WalletNameResolutionErrorCode,
    name: Schema.String,
    namespace: Schema.NullOr(NameServiceNamespace),
    message: Schema.String,
  },
  { httpApiStatus: 400 }
) {}

/**
 * SourceSyncCreditOutcomeResponse - Credit-required details for a resumable sync outcome.
 *
 * `additionalCreditsRequired` is null until the billable total for the run is
 * known, and is an upper bound once set: pending records may turn out to be
 * free (skipped, failed, or matching an already-charged transaction).
 */
export class SourceSyncCreditOutcomeResponse extends Schema.Class<SourceSyncCreditOutcomeResponse>(
  "SourceSyncCreditOutcomeResponse"
)({
  reasonCode: SyncCreditReasonCode,
  availableCredits: Schema.Finite,
  creditsConsumed: Schema.Finite,
  additionalCreditsRequired: Schema.NullOr(Schema.Finite),
}) {}

/**
 * SourceSyncStartResponse - Started source sync job info
 */
export class SourceSyncStartResponse extends Schema.Class<SourceSyncStartResponse>(
  "SourceSyncStartResponse"
)({
  sourceId: Schema.String,
  jobId: Schema.String,
  status: Schema.Literals(["queued", "running", "completed", "failed", "credit_required"]),
  message: Schema.NullOr(Schema.String),
  /** True when the caller can resume progress with a new sync call, e.g. after topping up credits. */
  resumable: Schema.Boolean,
  creditOutcome: Schema.NullOr(SourceSyncCreditOutcomeResponse),
}) {}

/**
 * SourceCreateClaimMetadata - Anonymous source claim handle.
 */
export class SourceCreateClaimMetadata extends Schema.Class<SourceCreateClaimMetadata>(
  "SourceCreateClaimMetadata"
)({
  requestId: Schema.String,
  claimToken: Schema.String,
  expiresAt: Schema.String,
}) {}

/**
 * SourceCreateResponse - Created or reused source and optional initial sync job.
 */
export class SourceCreateResponse extends Schema.Class<SourceCreateResponse>(
  "SourceCreateResponse"
)({
  source: Source,
  created: Schema.Boolean,
  syncJob: Schema.NullOr(SourceSyncStartResponse),
  claim: Schema.NullOr(SourceCreateClaimMetadata),
}) {}

/**
 * SourceSyncJobResponse - Result of a source sync job
 */
export class SourceSyncJobResponse extends Schema.Class<SourceSyncJobResponse>(
  "SourceSyncJobResponse"
)({
  sourceId: Schema.String,
  jobId: Schema.String,
  status: Schema.Literals(["queued", "running", "completed", "failed", "credit_required"]),
  phase: Schema.NullOr(Schema.Literals(["discovering", "classifying", "reconciling", "completed"])),
  processedRecords: Schema.NullOr(Schema.Finite),
  totalRecords: Schema.NullOr(Schema.Finite),
  progressPercent: Schema.NullOr(Schema.Finite),
  /** Raw provider records fetched and cached so far, not the count of persisted transactions. */
  fetchedRecords: Schema.NullOr(Schema.Finite),
  normalizedRecords: Schema.NullOr(Schema.Finite),
  failedRecords: Schema.NullOr(Schema.Finite),
  message: Schema.NullOr(Schema.String),
  /** True when the caller can resume progress with a new sync call, e.g. after topping up credits. */
  resumable: Schema.Boolean,
  creditOutcome: Schema.NullOr(SourceSyncCreditOutcomeResponse),
}) {}

const currentTaxYear = DateTime.toPartsUtc(DateTime.nowUnsafe()).year

/**
 * TaxCalculationRequest - Request body for calculating tax of a source
 */
export class TaxCalculationRequest extends Schema.Class<TaxCalculationRequest>(
  "TaxCalculationRequest"
)({
  year: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1970),
    Schema.isLessThanOrEqualTo(currentTaxYear)
  ),
  jurisdiction: Schema.String,
}) {}

/**
 * TaxCalculationResponse - Tax calculation result of a source
 */
export class TaxCalculationResponse extends Schema.Class<TaxCalculationResponse>(
  "TaxCalculationResponse"
)({
  calculationRunId: Schema.String,
  year: Schema.Finite,
  currency: Schema.String,
  taxableGains: Schema.Finite,
  taxableLosses: Schema.Finite,
  taxFreeGains: Schema.Finite,
  incomeTotal: Schema.Finite,
}) {}

const SourceReportCursor = Schema.NullOr(Schema.String)
const SourceReportAmount = Schema.String
const SourceReportTreatmentCodes = Schema.Array(Schema.String)

/**
 * SourceReportPageParams - Stable cursor pagination parameters for report lists.
 */
export const SourceReportPageParams = Schema.Struct({
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.FiniteFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(100)
    )
  ),
})

/**
 * SourceReportAsset - Asset descriptor used by source report rows.
 */
export class SourceReportAsset extends Schema.Class<SourceReportAsset>("SourceReportAsset")({
  assetId: Schema.String,
  symbol: Schema.String,
  name: Schema.String,
}) {}

/**
 * SourceReportPageInfo - Cursor pagination metadata.
 */
export class SourceReportPageInfo extends Schema.Class<SourceReportPageInfo>(
  "SourceReportPageInfo"
)({
  nextCursor: SourceReportCursor,
  hasMore: Schema.Boolean,
}) {}

/**
 * SourceReportSyncStatus - Latest source sync metadata.
 */
export class SourceReportSyncStatus extends Schema.Class<SourceReportSyncStatus>(
  "SourceReportSyncStatus"
)({
  /** Id of the latest processing job for the source, or null when the source has no job. */
  jobId: Schema.NullOr(Schema.String),
  status: Schema.NullOr(
    Schema.Literals(["pending", "processing", "completed", "failed", "credit_required"])
  ),
  mode: Schema.NullOr(Schema.Literals(["sync", "replay"])),
  queuedAt: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
  lastSyncedAt: Schema.NullOr(Schema.String),
  lastErrorMessage: Schema.NullOr(Schema.String),
  /** Raw provider records fetched and cached so far, not the count of persisted transactions. */
  fetchedRecords: Schema.NullOr(Schema.Finite),
  normalizedRecords: Schema.NullOr(Schema.Finite),
  failedRecords: Schema.NullOr(Schema.Finite),
}) {}

/**
 * SourceReportReviewSummary - Report health state for frontend and SDK consumers.
 */
export class SourceReportReviewIssue extends Schema.Class<SourceReportReviewIssue>(
  "SourceReportReviewIssue"
)({
  code: ReportReviewReasonCode,
  count: Schema.Finite,
  blocking: Schema.Boolean,
  summary: Schema.String,
}) {}

export class SourceReportReviewSummary extends Schema.Class<SourceReportReviewSummary>(
  "SourceReportReviewSummary"
)({
  status: Schema.Literals(["ok", "needs_review"]),
  needsReviewCount: Schema.Finite,
  blockingIssueCount: Schema.Finite,
  issues: Schema.Array(SourceReportReviewIssue),
}) {}

/**
 * SourceReportTotals - High-level source report counters and totals.
 */
export class SourceReportTotals extends Schema.Class<SourceReportTotals>("SourceReportTotals")({
  transactionCount: Schema.Finite,
  legCount: Schema.Finite,
  assetCount: Schema.Finite,
  fifoLotCount: Schema.Finite,
  disposalCount: Schema.Finite,
  incomeCount: Schema.Finite,
  feeCount: Schema.Finite,
  realizedGainLoss: SourceReportAmount,
  incomeTotal: SourceReportAmount,
  currency: Schema.NullOr(Schema.String),
}) {}

/**
 * SourceOverviewResponse - Source metadata plus report counters.
 */
export class SourceOverviewResponse extends Schema.Class<SourceOverviewResponse>(
  "SourceOverviewResponse"
)({
  calculationRunId: Schema.NullOr(Schema.String),
  source: Source,
  latestSync: SourceReportSyncStatus,
  totals: SourceReportTotals,
  review: SourceReportReviewSummary,
}) {}

/**
 * SourceAssetPnlRow - Per-asset P&L report row.
 *
 * The costBasis field reports the remaining open-position basis, while proceeds
 * and realizedGainLoss report realized disposal totals.
 */
export class SourceAssetPnlRow extends Schema.Class<SourceAssetPnlRow>("SourceAssetPnlRow")({
  asset: SourceReportAsset,
  acquiredAmount: SourceReportAmount,
  disposedAmount: SourceReportAmount,
  openAmount: SourceReportAmount,
  costBasis: Schema.NullOr(SourceReportAmount),
  costBasisStatus: Schema.Literals(["known", "pending_review"]),
  proceeds: SourceReportAmount,
  realizedGainLoss: SourceReportAmount,
  currency: Schema.NullOr(Schema.String),
  review: SourceReportReviewSummary,
}) {}

export class SourceAssetPnlResponse extends Schema.Class<SourceAssetPnlResponse>(
  "SourceAssetPnlResponse"
)({
  calculationRunId: Schema.NullOr(Schema.String),
  assets: Schema.Array(SourceAssetPnlRow),
}) {}

/**
 * SourceTransactionMovement - Asset movement nested under a transaction row.
 */
export class SourceTransactionMovement extends Schema.Class<SourceTransactionMovement>(
  "SourceTransactionMovement"
)({
  legId: Schema.String,
  asset: SourceReportAsset,
  kind: Schema.Literals(["acquisition", "disposal", "income", "fee"]),
  amount: SourceReportAmount,
  fiatAmount: Schema.NullOr(SourceReportAmount),
  fiatCurrency: Schema.NullOr(Schema.String),
  provenance: Schema.Literals(["deterministic", "rule", "ai", "manual"]),
  derivationRule: Schema.NullOr(Schema.String),
}) {}

export class SourceTransactionRow extends Schema.Class<SourceTransactionRow>(
  "SourceTransactionRow"
)({
  transactionId: Schema.String,
  timestamp: Schema.String,
  externalId: Schema.NullOr(Schema.String),
  externalGroupId: Schema.NullOr(Schema.String),
  transactionType: Schema.NullOr(Schema.String),
  providerTransactionType: Schema.NullOr(Schema.String),
  providerStatus: Schema.NullOr(Schema.String),
  providerDescription: Schema.NullOr(Schema.String),
  movements: Schema.Array(SourceTransactionMovement),
}) {}

export class SourceTransactionsResponse extends Schema.Class<SourceTransactionsResponse>(
  "SourceTransactionsResponse"
)({
  transactions: Schema.Array(SourceTransactionRow),
  page: SourceReportPageInfo,
}) {}

export class SourceTaxEventRow extends Schema.Class<SourceTaxEventRow>("SourceTaxEventRow")({
  legId: Schema.String,
  transactionId: Schema.NullOr(Schema.String),
  timestamp: Schema.String,
  kind: Schema.Literals(["acquisition", "disposal", "income", "fee"]),
  asset: SourceReportAsset,
  amount: SourceReportAmount,
  fiatAmount: Schema.NullOr(SourceReportAmount),
  fiatCurrency: Schema.NullOr(Schema.String),
  costBasis: Schema.NullOr(SourceReportAmount),
  proceeds: Schema.NullOr(SourceReportAmount),
  gainLoss: Schema.NullOr(SourceReportAmount),
  treatmentCodes: SourceReportTreatmentCodes,
  provenance: Schema.Literals(["deterministic", "rule", "ai", "manual"]),
  derivationRule: Schema.NullOr(Schema.String),
}) {}

export class SourceTaxEventsResponse extends Schema.Class<SourceTaxEventsResponse>(
  "SourceTaxEventsResponse"
)({
  calculationRunId: Schema.NullOr(Schema.String),
  taxEvents: Schema.Array(SourceTaxEventRow),
  page: SourceReportPageInfo,
}) {}

export class SourceFifoLotDisposalSummary extends Schema.Class<SourceFifoLotDisposalSummary>(
  "SourceFifoLotDisposalSummary"
)({
  disposalLegId: Schema.String,
  matchedAmount: SourceReportAmount,
  proceeds: Schema.NullOr(SourceReportAmount),
  costBasis: Schema.NullOr(SourceReportAmount),
  gainLoss: Schema.NullOr(SourceReportAmount),
}) {}

export class SourceFifoLotRow extends Schema.Class<SourceFifoLotRow>("SourceFifoLotRow")({
  lotId: Schema.String,
  asset: SourceReportAsset,
  acquiredAt: Schema.String,
  originalAmount: SourceReportAmount,
  remainingAmount: SourceReportAmount,
  costBasisPerToken: Schema.NullOr(SourceReportAmount),
  costBasisCurrency: Schema.NullOr(Schema.String),
  costBasisStatus: Schema.Literals(["known", "pending_review"]),
  sourceLegId: Schema.NullOr(Schema.String),
  sourceProviderTransferId: Schema.NullOr(Schema.String),
  disposalMatches: Schema.Array(SourceFifoLotDisposalSummary),
}) {}

export class SourceFifoLotsResponse extends Schema.Class<SourceFifoLotsResponse>(
  "SourceFifoLotsResponse"
)({
  calculationRunId: Schema.NullOr(Schema.String),
  fifoLots: Schema.Array(SourceFifoLotRow),
  page: SourceReportPageInfo,
}) {}

export class SourceDisposalMatchedLot extends Schema.Class<SourceDisposalMatchedLot>(
  "SourceDisposalMatchedLot"
)({
  lotId: Schema.String,
  asset: SourceReportAsset,
  acquiredAt: Schema.String,
  matchedAmount: SourceReportAmount,
  costBasis: SourceReportAmount,
  proceeds: SourceReportAmount,
  gainLoss: SourceReportAmount,
  treatmentCodes: SourceReportTreatmentCodes,
}) {}

export class SourceDisposalExplanationResponse extends Schema.Class<SourceDisposalExplanationResponse>(
  "SourceDisposalExplanationResponse"
)({
  calculationRunId: Schema.NullOr(Schema.String),
  disposalLegId: Schema.String,
  transactionId: Schema.NullOr(Schema.String),
  asset: SourceReportAsset,
  amount: SourceReportAmount,
  proceeds: Schema.NullOr(SourceReportAmount),
  costBasis: Schema.NullOr(SourceReportAmount),
  gainLoss: Schema.NullOr(SourceReportAmount),
  acquiredAt: Schema.NullOr(Schema.String),
  disposedAt: Schema.String,
  treatmentCodes: SourceReportTreatmentCodes,
  provenance: Schema.Literals(["deterministic", "rule", "ai", "manual"]),
  derivationRule: Schema.NullOr(Schema.String),
  matchedLots: Schema.Array(SourceDisposalMatchedLot),
}) {}

// =============================================================================
// Protected API Endpoints
// =============================================================================

/**
 * GET /sources - List all sources for the authenticated user
 */
const listSources = HttpApiEndpoint.get("listSources", "/sources", {
  success: SourceListResponse,
  error: [SourceBadRequestError, InternalServerError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "List sources",
    description: "Lists all sources for the authenticated user.",
  })
)

/**
 * POST /sources - Create or reuse a source for the authenticated user.
 */
const createSource = HttpApiEndpoint.post("createSource", "/sources", {
  payload: Schema.Struct(SourceCreateRequest.fields),
  success: SourceCreateResponse,
  error: [
    SourceBadRequestError,
    SourceNameResolutionError,
    UnauthorizedError,
    SourcePaymentRequiredError,
    SourceCreditRequiredError,
    InternalServerError,
  ],
}).annotateMerge(
  OpenApi.annotations({
    summary: "Create source",
    description:
      "Creates or reuses an onchain source for an authenticated user, or creates an anonymous wallet source when no credentials are present.",
  })
)

/**
 * POST /sources/:provider/sync - Start a source sync job
 */
const startSourceSyncJob = HttpApiEndpoint.post("startSourceSyncJob", "/sources/:sourceId/sync", {
  params: Schema.Struct({
    sourceId: Schema.String,
  }),
  success: SourceSyncStartResponse,
  error: [SourceBadRequestError, SourceCreditRequiredError, InternalServerError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "Start source sync",
    description: "Starts sync for the specified source or returns active/completed job",
  })
)

/**
 * POST /sources/:sourceId/replay - Reset derived source data and replay cached raw rows
 */
const replaySourceSyncJob = HttpApiEndpoint.post(
  "replaySourceSyncJob",
  "/sources/:sourceId/replay",
  {
    params: Schema.Struct({
      sourceId: Schema.String,
    }),
    success: SourceSyncStartResponse,
    error: [SourceBadRequestError, SourceCreditRequiredError, InternalServerError],
  }
).annotateMerge(
  OpenApi.annotations({
    summary: "Replay source normalization",
    description:
      "Resets canonical data for the specified source and rebuilds it from cached raw provider records.",
  })
)

/**
 * GET /sources/:sourceId/jobs/:jobId - Get status of a source sync job
 */
const getSourceSyncJobStatus = HttpApiEndpoint.get(
  "getSourceSyncJobStatus",
  "/sources/:sourceId/jobs/:jobId",
  {
    params: Schema.Struct({
      sourceId: Schema.String,
      jobId: Schema.String,
    }),
    success: SourceSyncJobResponse,
    error: [SourceBadRequestError, SourceNotFoundError, InternalServerError],
  }
).annotateMerge(
  OpenApi.annotations({
    summary: "Get source sync job status",
    description: "Returns sync job status and counters for the authenticated user.",
  })
)

/**
 * POST /sources/:sourceId/tax - Calculate tax of a source in a given jurisdiction
 */
const calculateTaxForSource = HttpApiEndpoint.post(
  "calculateTaxForSource",
  "/sources/:sourceId/tax",
  {
    params: Schema.Struct({
      sourceId: Schema.String,
    }),
    payload: Schema.Struct(TaxCalculationRequest.fields),
    success: TaxCalculationResponse,
    error: [
      SourceBadRequestError,
      SourceNotFoundError,
      SourceTaxCalculationPendingError,
      InternalServerError,
    ],
  }
).annotateMerge(
  OpenApi.annotations({
    summary: "Calculate tax for source",
    description: "Calculates jurisdiction-oriented tax from normalized FIFO and income data.",
  })
)

const getSourceOverview = HttpApiEndpoint.get("getSourceOverview", "/sources/:sourceId/overview", {
  params: Schema.Struct({ sourceId: Schema.String }),
  success: SourceOverviewResponse,
  error: [SourceBadRequestError, SourceNotFoundError, InternalServerError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "Get source overview",
    description: "Returns source metadata, latest sync status, and report counters.",
  })
)

const listSourceAssetPnl = HttpApiEndpoint.get(
  "listSourceAssetPnl",
  "/sources/:sourceId/assets/pnl",
  {
    params: Schema.Struct({ sourceId: Schema.String }),
    success: SourceAssetPnlResponse,
    error: [SourceBadRequestError, SourceNotFoundError, InternalServerError],
  }
).annotateMerge(
  OpenApi.annotations({
    summary: "List source asset P&L",
    description: "Returns source-scoped per-asset inventory and realized P&L rows.",
  })
)

const listSourceTransactions = HttpApiEndpoint.get(
  "listSourceTransactions",
  "/sources/:sourceId/transactions",
  {
    params: Schema.Struct({ sourceId: Schema.String }),
    query: SourceReportPageParams,
    success: SourceTransactionsResponse,
    error: [SourceBadRequestError, SourceNotFoundError, InternalServerError],
  }
).annotateMerge(
  OpenApi.annotations({
    summary: "List source transactions",
    description: "Returns paginated source-scoped normalized transaction rows.",
  })
)

const listSourceTaxEvents = HttpApiEndpoint.get(
  "listSourceTaxEvents",
  "/sources/:sourceId/tax-events",
  {
    params: Schema.Struct({ sourceId: Schema.String }),
    query: SourceReportPageParams,
    success: SourceTaxEventsResponse,
    error: [SourceBadRequestError, SourceNotFoundError, InternalServerError],
  }
).annotateMerge(
  OpenApi.annotations({
    summary: "List source tax events",
    description: "Returns paginated tax-visible read projections from canonical rows.",
  })
)

const listSourceFifoLots = HttpApiEndpoint.get(
  "listSourceFifoLots",
  "/sources/:sourceId/fifo-lots",
  {
    params: Schema.Struct({ sourceId: Schema.String }),
    query: SourceReportPageParams,
    success: SourceFifoLotsResponse,
    error: [SourceBadRequestError, SourceNotFoundError, InternalServerError],
  }
).annotateMerge(
  OpenApi.annotations({
    summary: "List source FIFO lots",
    description: "Returns paginated source-scoped FIFO lots and disposal match summaries.",
  })
)

const explainSourceDisposal = HttpApiEndpoint.get(
  "explainSourceDisposal",
  "/sources/:sourceId/disposals/:legId/explanation",
  {
    params: Schema.Struct({ sourceId: Schema.String, legId: Schema.String }),
    success: SourceDisposalExplanationResponse,
    error: [SourceBadRequestError, SourceNotFoundError, InternalServerError],
  }
).annotateMerge(
  OpenApi.annotations({
    summary: "Explain source disposal",
    description: "Returns deterministic FIFO derivation details for a disposal leg.",
  })
)

/**
 * POST /sources/resolve-name - Resolve a wallet name to an onchain address
 */
const resolveSourceName = HttpApiEndpoint.post("resolveSourceName", "/sources/resolve-name", {
  payload: Schema.Struct(SourceNameResolveRequest.fields),
  success: SourceNameResolveResponse,
  error: [SourceNameResolutionError, InternalServerError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "Resolve wallet name",
    description:
      "Resolves a wallet name such as vitalik.eth or bonfida.sol to its onchain address, using a server-side cache. The name-service namespace is detected from the name itself.",
  })
)

// =============================================================================
// API Groups
// =============================================================================

/**
 * SourcesApi - Protected sources endpoints
 */
export class SourcesApi extends HttpApiGroup.make("sources")
  .add(listSources)
  .add(startSourceSyncJob)
  .add(replaySourceSyncJob)
  .add(getSourceSyncJobStatus)
  .add(calculateTaxForSource)
  .add(getSourceOverview)
  .add(listSourceAssetPnl)
  .add(listSourceTransactions)
  .add(listSourceTaxEvents)
  .add(listSourceFifoLots)
  .add(explainSourceDisposal)
  .add(resolveSourceName)
  .middleware(AuthMiddleware)
  .add(createSource)
  .prefix("/v1")
  .annotateMerge(
    OpenApi.annotations({
      title: "Sources",
      description: "Endpoints for syncing sources and calculating their tax",
    })
  ) {}
