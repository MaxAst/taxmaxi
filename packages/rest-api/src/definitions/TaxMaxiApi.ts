/**
 * TaxMaxiApi - Main HTTP API definition for TaxMaxi
 *
 * Combines the public, auth, source sync, and legal API groups
 * into a single HttpApi definition that can be served with HttpApiBuilder.
 *
 * @module TaxMaxiApi
 */

import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import * as Schema from "effect/Schema"
import { AuthApi, AuthSessionApi, CoinbaseCompatApi } from "./AuthApi.ts"
import { BillingApi } from "./BillingApi.ts"
import { AdminProtocolReviewApi } from "./AdminProtocolReviewApi.ts"
import { AnonApi } from "./AnonApi.ts"
import { LegalReferenceApi } from "./LegalReferenceApi.ts"
import { PrincipalsApi } from "./PrincipalsApi.ts"
import { AssetsApi } from "./AssetsApi.ts"
import { PortfolioApi } from "./PortfolioApi.ts"
import { SourcesApi } from "./SourcesApi.ts"
import { SyncRunsApi } from "./SyncRunsApi.ts"
import { TransactionsApi } from "./TransactionsApi.ts"
import { TransactionOverridesApi } from "./TransactionOverridesApi.ts"
import { AssetOverridesApi } from "./AssetOverridesApi.ts"

// =============================================================================
// Health Check Types
// =============================================================================

/**
 * HealthCheckResponse - Response for the health check endpoint
 */
export class HealthCheckResponse extends Schema.Class<HealthCheckResponse>("HealthCheckResponse")({
  status: Schema.Literals(["ok", "degraded", "unhealthy"]),
  timestamp: Schema.String,
  version: Schema.OptionFromNullOr(Schema.String),
}) {}

// =============================================================================
// Health API Group
// =============================================================================

/**
 * Health check endpoint
 * GET /health
 */
const healthCheck = HttpApiEndpoint.get("healthCheck", "/", {
  success: HealthCheckResponse,
}).annotateMerge(
  OpenApi.annotations({
    summary: "Health check",
    description: "Returns the current health status of the API",
  })
)

/**
 * HealthApi - Unprotected health check group
 *
 * No authentication required - used by load balancers and monitoring.
 */
export class HealthApi extends HttpApiGroup.make("health")
  .add(healthCheck)
  .prefix("/health")
  .annotateMerge(
    OpenApi.annotations({
      title: "Health",
      description: "API health and status endpoints",
    })
  ) {}

// =============================================================================
// Main API Definition
// =============================================================================

/**
 * TaxMaxiApi - TaxMaxi API definition combining all groups
 *
 * Groups:
 * - /health - Health check (unprotected)
 * - /auth - Authentication (mixed public/protected)
 * - /cdp - Coinbase OAuth compatibility callback (unprotected)
 * - /v1/legal - Legal reference retrieval (public)
 */
export class TaxMaxiApi extends HttpApi.make("TaxMaxiApi")
  .add(HealthApi)
  .add(AnonApi)
  .add(AdminProtocolReviewApi)
  .add(AuthApi)
  .add(AuthSessionApi)
  .add(BillingApi)
  .add(CoinbaseCompatApi)
  .add(LegalReferenceApi)
  .add(PrincipalsApi)
  .add(AssetsApi)
  .add(PortfolioApi)
  .add(SourcesApi)
  .add(SyncRunsApi)
  .add(TransactionsApi)
  .add(AssetOverridesApi)
  .add(TransactionOverridesApi)
  .annotateMerge(
    OpenApi.annotations({
      title: "TaxMaxi API",
      description: "Crypto tax reporting API",
      version: "0.0.1",
      servers: [
        { url: "http://localhost:4000", description: "Local" },
        { url: "https://api.taxmaxi.com", description: "Production" },
      ],
    })
  ) {}
