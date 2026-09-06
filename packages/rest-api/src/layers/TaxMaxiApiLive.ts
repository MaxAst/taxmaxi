/**
 * TaxMaxiApiLive - Live implementation layer for the TaxMaxi API
 *
 * Combines all API group implementations into a complete API layer that can be served.
 *
 * @module TaxMaxiApiLive
 */

import { HttpApiBuilder } from "effect/unstable/httpapi"
import { FetchHttpClient } from "effect/unstable/http"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { TaxMaxiApi, HealthCheckResponse } from "../definitions/TaxMaxiApi.ts"
import {
  AdminAuthMiddlewareLive,
  AuthMiddlewareLive,
  OptionalCurrentUserLive,
} from "./AuthMiddlewareLive.ts"
import { AdminProtocolReviewApiLive } from "./AdminProtocolReviewApiLive.ts"
import { AuthApiLive, AuthSessionApiLive, CoinbaseCompatApiLive } from "./AuthApiLive.ts"
import { AnonApiLive } from "./AnonApiLive.ts"
import { LegalReferenceApiLive } from "./LegalReferenceApiLive.ts"
import { PrincipalResolutionServiceLive } from "./PrincipalResolutionServiceLive.ts"
import { PrincipalsApiLive } from "./PrincipalsApiLive.ts"
import { AssetsApiLive } from "./AssetsApiLive.ts"
import { PortfolioApiLive } from "./PortfolioApiLive.ts"
import { CoinGeckoPriceServiceLive } from "./CoinGeckoPriceServiceLive.ts"
import { CoinGeckoClientLive } from "./CoinGeckoClientLive.ts"
import { AssetCanonicalizationServiceLive } from "./AssetCanonicalizationServiceLive.ts"
import { SourcesApiLive } from "./SourcesApiLive.ts"
import { SyncRunsApiLive } from "./SyncRunsApiLive.ts"
import { BillingApiLive } from "./BillingApiLive.ts"
import { StripeBillingServiceLive } from "./StripeBillingServiceLive.ts"
import { TransactionsApiLive } from "./TransactionsApiLive.ts"
import { TransactionOverridesApiLive } from "./TransactionOverridesApiLive.ts"
import { AssetOverridesApiLive } from "./AssetOverridesApiLive.ts"

// =============================================================================
// Health API Implementation
// =============================================================================

/**
 * HealthApiLive - Health check endpoint implementation
 *
 * Simple handler that returns the current health status.
 * This endpoint is not protected by authentication.
 */
const HealthApiLive = HttpApiBuilder.group(TaxMaxiApi, "health", (handlers) =>
  Effect.succeed(
    handlers.handle("healthCheck", () =>
      Effect.succeed(
        HealthCheckResponse.make({
          status: "ok",
          timestamp: DateTime.formatIso(DateTime.nowUnsafe()),
          version: Option.some("0.0.1"),
        })
      )
    )
  )
)

/**
 * CoreApiGroup - First group of core API implementations
 *
 * Merged to reduce the number of Layer.provide calls in the main chain
 * (TypeScript has a limit of ~20 arguments in pipe).
 */
const CoreApiGroup = Layer.mergeAll(
  HealthApiLive,
  AdminProtocolReviewApiLive,
  AuthApiLive,
  CoinbaseCompatApiLive,
  AuthSessionApiLive,
  LegalReferenceApiLive,
  AnonApiLive,
  PrincipalsApiLive,
  AssetsApiLive.pipe(Layer.provide(AssetCanonicalizationServiceLive)),
  PortfolioApiLive.pipe(Layer.provide(CoinGeckoPriceServiceLive)),
  SourcesApiLive,
  SyncRunsApiLive,
  BillingApiLive.pipe(Layer.provide(StripeBillingServiceLive)),
  TransactionsApiLive,
  AssetOverridesApiLive,
  TransactionOverridesApiLive
).pipe(
  Layer.provide(PrincipalResolutionServiceLive),
  Layer.provide(CoinGeckoClientLive.pipe(Layer.provide(FetchHttpClient.layer)))
)

/**
 * MasterDataApiGroup - Master data API implementations
 */
// const MasterDataApiGroup = Layer.mergeAll(UserWorkspacesApiLive)

// =============================================================================
// Complete API Layer
// =============================================================================

/**
 * TaxMaxiApiLive - Complete API layer combining all implementations
 *
 * Provides:
 * - Health check (unprotected)
 * - Legal references API (unprotected)
 *
 * Dependencies (required from consumer):
 * - Auth, source sync, legal reference, and tax calculation services
 */
export const TaxMaxiApiLive = HttpApiBuilder.layer(TaxMaxiApi).pipe(
  // Core API group (merged to reduce pipe arguments)
  Layer.provide(CoreApiGroup),
  // Layer.provide(MasterDataApiGroup),
  // Feature-specific APIs with dependencies
  // TODO: Layer.provide(MembershipPolicyApiGroup),
  // Authorization infrastructure
  // AuthorizationServiceWithDependencies provides ABAC+RBAC permission checking
  // Uses ABAC when policies exist, falls back to RBAC when no policies
  // Includes PolicyEngineLive for ABAC policy evaluation
  // TODO: Layer.provide(AuthorizationServiceWithDependencies),
  // AuthorizationConfigLive provides AUTHORIZATION_ENFORCEMENT env var
  // Set to false for grace period (skip membership checks), true for strict enforcement
  // TODO: Layer.provide(AuthorizationConfigLive),
  // AuthMiddlewareLive requires TokenValidator to be provided externally
  // - For production: use SessionTokenValidatorLive (validates against database)
  // - For testing: use SimpleTokenValidatorLive (user_<id>_<role> format)
  Layer.provide(OptionalCurrentUserLive),
  Layer.provide(AdminAuthMiddlewareLive),
  Layer.provide(AuthMiddlewareLive)
)
