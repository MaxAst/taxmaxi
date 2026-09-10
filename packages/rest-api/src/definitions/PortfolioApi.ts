/** PortfolioApi - Current user portfolio endpoints. */

import { TaxYear } from "@my/core/accounting"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { InternalServerError } from "./ApiErrors.ts"
import { AuthMiddleware } from "./AuthMiddleware.ts"

export class PortfolioSourceNotFoundResponse extends Schema.TaggedError<PortfolioSourceNotFoundResponse>()(
  "PortfolioSourceNotFoundResponse",
  { message: Schema.String },
  { httpApiStatus: 404 }
) {}

/** The two source query forms cannot be combined. */
export class PortfolioBadRequestResponse extends Schema.TaggedError<PortfolioBadRequestResponse>()(
  "PortfolioBadRequestResponse",
  { code: Schema.Literal("conflicting_source_filters") },
  { httpApiStatus: 400 }
) {}

export class PortfolioAssetRow extends Schema.Class<PortfolioAssetRow>("PortfolioAssetRow")({
  assetId: Schema.String,
  symbol: Schema.String,
  name: Schema.String,
  logoUrl: Schema.NullOr(Schema.String),
  amount: Schema.BigDecimalFromString,
  currentPrice: Schema.NullOr(Schema.BigDecimalFromString),
  totalValue: Schema.NullOr(Schema.BigDecimalFromString),
  profitLoss: Schema.NullOr(Schema.BigDecimalFromString),
}) {}

export class PortfolioSummary extends Schema.Class<PortfolioSummary>("PortfolioSummary")({
  totalValue: Schema.NullOr(Schema.BigDecimalFromString),
  costBasis: Schema.NullOr(Schema.BigDecimalFromString),
  profitLoss: Schema.NullOr(Schema.BigDecimalFromString),
  profitLossPercentage: Schema.NullOr(Schema.BigDecimalFromString),
}) {}

export class PortfolioBlockerCountResponse extends Schema.Class<PortfolioBlockerCountResponse>(
  "PortfolioBlockerCountResponse"
)({
  code: Schema.String,
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}) {}

export class PortfolioActiveRunResponse extends Schema.Class<PortfolioActiveRunResponse>(
  "PortfolioActiveRunResponse"
)({
  runId: Schema.String,
  status: Schema.Literals(["complete", "partial"]),
  blockerCounts: Schema.Array(PortfolioBlockerCountResponse),
}) {}

export class PortfolioLatestRunResponse extends Schema.Class<PortfolioLatestRunResponse>(
  "PortfolioLatestRunResponse"
)({
  runId: Schema.String,
  status: Schema.Literals(["running", "complete", "partial", "failed"]),
  failureCode: Schema.NullOr(Schema.String),
}) {}

export class PortfolioAssetsResponse extends Schema.Class<PortfolioAssetsResponse>(
  "PortfolioAssetsResponse"
)({
  currency: Schema.String,
  activeRun: Schema.NullOr(PortfolioActiveRunResponse),
  latestRun: Schema.NullOr(PortfolioLatestRunResponse),
  summary: PortfolioSummary,
  assets: Schema.Array(PortfolioAssetRow),
}) {}

export const PortfolioCurrency = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String.check(Schema.isLowercased(), Schema.isPattern(/^[a-z]{3}$/)),
    SchemaTransformation.toLowerCase()
  )
)

const PortfolioAssetsQuery = Schema.Struct({
  sourceId: Schema.optional(Schema.String.check(Schema.isUUID())),
  sourceIds: Schema.optional(Schema.Array(Schema.String.check(Schema.isUUID()))),
  currency: Schema.optional(PortfolioCurrency),
})

const listPortfolioAssets = HttpApiEndpoint.get("listPortfolioAssets", "/assets", {
  query: PortfolioAssetsQuery,
  success: PortfolioAssetsResponse,
  error: [PortfolioBadRequestResponse, PortfolioSourceNotFoundResponse, InternalServerError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "List portfolio assets",
    description:
      "Returns positions from the active calculation run across all user sources or the union of selected sources’ captured custody units, counted once, plus the latest run status and live CoinGecko values. Select owned sources with repeated sourceIds parameters or the sourceId shorthand, never both. Omitted or empty sourceIds selects all sources.",
  })
)

/** Exact selected-year work and coverage, read without starting a calculation. */
export const PortfolioCalculationStatusQuery = Schema.Struct({
  taxYear: Schema.FiniteFromString.pipe(Schema.decodeTo(TaxYear)),
  sourceJobId: Schema.optional(Schema.String.check(Schema.isUUID())),
})

export class PortfolioCalculationJobNotFoundResponse extends Schema.TaggedError<PortfolioCalculationJobNotFoundResponse>()(
  "PortfolioCalculationJobNotFoundResponse",
  { code: Schema.Literal("source_job_not_found") },
  { httpApiStatus: 404 }
) {}

const CalculationRun = Schema.Struct({
  runId: Schema.String,
  status: Schema.Literals(["complete", "partial"]),
})

const CalculationWork = Schema.Struct({
  requestId: Schema.String,
  sourceId: Schema.String,
  sourceJobId: Schema.String,
  status: Schema.Literals(["queued", "running", "succeeded", "failed"]),
  attempts: Schema.Array(
    Schema.Struct({
      attemptId: Schema.String,
      runId: Schema.NullOr(Schema.String),
      status: Schema.Literals(["running", "succeeded", "failed"]),
      failureCode: Schema.NullOr(Schema.String),
    })
  ),
})

/** Work spans the whole scope even when jobs are filtered to one source job. */
export class PortfolioCalculationStatusResponse extends Schema.Class<PortfolioCalculationStatusResponse>(
  "PortfolioCalculationStatusResponse"
)({
  scope: Schema.Struct({
    jurisdiction: Schema.Literal("DE"),
    taxYear: TaxYear,
    reportingCurrency: Schema.Literal("EUR"),
  }),
  activeRun: Schema.NullOr(CalculationRun),
  work: Schema.Struct({
    status: Schema.Literals(["not_requested", "queued", "running", "succeeded", "failed"]),
    requests: Schema.Array(CalculationWork),
  }),
  jobs: Schema.Array(
    Schema.Struct({
      sourceJobStatus: Schema.Literals([
        "pending",
        "processing",
        "completed",
        "failed",
        "credit_required",
      ]),
      sourceJobId: Schema.String,
      sourceId: Schema.String,
      work: Schema.NullOr(CalculationWork),
      coveringRun: Schema.NullOr(CalculationRun),
      activeCoverage: Schema.Literals(["covered", "not_covered", "unknown"]),
    })
  ),
}) {}

const getCalculationStatus = HttpApiEndpoint.get("getCalculationStatus", "/calculation-status", {
  query: PortfolioCalculationStatusQuery,
  success: PortfolioCalculationStatusResponse,
  error: [PortfolioCalculationJobNotFoundResponse, InternalServerError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "Read selected-year calculation status",
    description:
      "Returns DE/EUR scope work independently of an optional source job filter. Without a filter, discovers the newest completed job per owned source. Active coverage and covering runs are separate: compare active run IDs before attaching coverage to separately fetched results. Unknown coverage includes legacy runs without captured evidence. This read never requests a calculation.",
  })
)

export class PortfolioApi extends HttpApiGroup.make("portfolio")
  .add(listPortfolioAssets)
  .add(getCalculationStatus)
  .middleware(AuthMiddleware)
  .prefix("/v1/portfolio")
  .annotateMerge(OpenApi.annotations({ title: "Portfolio" })) {}
