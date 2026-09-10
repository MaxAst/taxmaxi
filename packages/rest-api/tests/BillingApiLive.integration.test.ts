import { SourceSyncQueueUnexpectedTestLive } from "./support/SourceSyncQueueUnexpectedTestLive.ts"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpServerTestLive } from "./support/http-server.ts"
import {
  AuthService,
  HashedPassword,
  PasswordHasher,
  type AuthServiceShape,
} from "@my/core/authentication"
import {
  SourceSyncRunService,
  SourceSyncService,
  TransferReconciliationService,
  type SourceSyncRunServiceShape,
  type SourceSyncServiceShape,
  type TransferReconciliationServiceShape,
} from "@my/sync-engine/services"
import * as Chunk from "effect/Chunk"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { describe, expect, it } from "@effect/vitest"
import { vi } from "vitest"

import { drizzle } from "../../persistence/src/layers/PgClientLive.ts"
import { RepositoriesLive } from "../../persistence/src/layers/RepositoriesLive.ts"
import { schema } from "../../persistence/src/schema/index.ts"
import { makeIntegrationTestDatabaseContext } from "../../persistence/tests/support/integration-test-kit.ts"
import { AnonSessionServiceLive } from "../src/layers/AnonSessionServiceLive.ts"
import { SimpleTokenValidatorLive } from "../src/layers/AuthMiddlewareLive.ts"
import { TaxMaxiApiLive } from "../src/layers/TaxMaxiApiLive.ts"
import {
  STRIPE_CATALOG_PRODUCT_METADATA_KEY,
  TAXMAXI_STRIPE_CATALOG,
  TAXMAXI_STRIPE_TAX_CODE,
} from "../src/services/StripeCatalog.ts"
import { makeX402PaymentValidatorTestLive } from "./support/X402PaymentValidatorTestLive.ts"
import { SIWXProofVerifierTestLive } from "./support/SIWXProofVerifierTestLive.ts"

interface StripeHttpMockState {
  catalogError: Error | null
  checkoutModes: Array<string | undefined>
  prices: Array<{
    readonly id: string
    readonly billing_scheme: "per_unit"
    readonly lookup_key: string
    readonly product:
      | string
      | {
          readonly id: string
          readonly active: boolean
          readonly name: string
          readonly description: string
          readonly tax_code: string
          readonly metadata: Readonly<Record<string, string>>
        }
    readonly recurring: {
      readonly interval: string
      readonly interval_count: number
      readonly usage_type: "licensed"
      readonly trial_period_days: null
    } | null
    readonly transform_quantity: null
    readonly unit_amount: number
    readonly currency: string
    readonly tax_behavior: "inclusive" | "exclusive"
  }>
  subscriptions: Array<unknown>
  webhookInputs: Array<{ readonly payload: string; readonly signature: string }>
  webhookError: Error | null
}

const stripeHttpMockState = vi.hoisted<StripeHttpMockState>(() => ({
  catalogError: null,
  checkoutModes: [],
  prices: [],
  subscriptions: [],
  webhookInputs: [],
  webhookError: null,
}))

vi.mock("stripe", () => ({
  default: class StripeMock {
    readonly billingPortal = {
      sessions: {
        create: () => Promise.resolve({ url: "https://billing.stripe.test/portal" }),
      },
    }
    readonly checkout = {
      sessions: {
        create: (params: { readonly mode?: string }) => {
          stripeHttpMockState.checkoutModes.push(params.mode)
          return Promise.resolve({
            url: `https://checkout.stripe.test/${params.mode ?? "unknown"}`,
          })
        },
      },
    }
    readonly customers = {
      retrieve: () => Promise.resolve({ deleted: false }),
    }
    readonly prices = {
      list: ({ lookup_keys: lookupKeys }: { readonly lookup_keys?: ReadonlyArray<string> } = {}) =>
        stripeHttpMockState.catalogError === null
          ? Promise.resolve({
              data:
                lookupKeys === undefined
                  ? stripeHttpMockState.prices
                  : stripeHttpMockState.prices.filter((price) =>
                      lookupKeys.includes(price.lookup_key)
                    ),
            })
          : Promise.reject(stripeHttpMockState.catalogError),
      retrieve: (priceId: string) =>
        Promise.resolve(stripeHttpMockState.prices.find((price) => price.id === priceId)),
    }
    readonly subscriptions = {
      list: () => ({
        autoPagingToArray: () => Promise.resolve(stripeHttpMockState.subscriptions),
      }),
    }
    readonly webhooks = {
      constructEventAsync: (payload: string, signature: string) => {
        stripeHttpMockState.webhookInputs.push({ payload, signature })
        if (stripeHttpMockState.webhookError !== null) {
          return Promise.reject(stripeHttpMockState.webhookError)
        }
        return Promise.resolve({
          id: "evt_http_boundary",
          created: 1_700_000_000,
          type: "billing.http_boundary_test",
          data: { object: {} },
        })
      },
    }
  },
}))

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_rest_api_billing",
})
const TestPgClientLive = context.TestPgClientLive
const TEST_USER_ID = "00000000-0000-4000-8000-000000000199"
const AUTHORIZATION = `user_${TEST_USER_ID}_user`

const X402PaymentValidatorTestLive = makeX402PaymentValidatorTestLive({
  validPaymentHeader: "valid-test-x402-payment",
})
const TestConfigProvider = ConfigProvider.fromEnvRecord({
  ANON_SESSION_SECRET: "test-anon-session-secret-32-bytes-long",
  STRIPE_SECRET_KEY: "sk_test",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
  FRONTEND_URL: "https://taxmaxi.test",
})
const AnonSessionServiceTestLive = AnonSessionServiceLive.pipe(
  Layer.provide(ConfigProvider.layer(TestConfigProvider))
)

const SourceSyncServiceTestLive = Layer.succeed(SourceSyncService, {
  startSourceSyncJob: () =>
    Effect.die("SourceSyncService test stub: startSourceSyncJob not implemented"),
  replaySourceSyncJob: () =>
    Effect.die("SourceSyncService test stub: replaySourceSyncJob not implemented"),
  getSourceSyncJob: () =>
    Effect.die("SourceSyncService test stub: getSourceSyncJob not implemented"),
} satisfies SourceSyncServiceShape)

const SourceSyncRunServiceTestLive = Layer.succeed(SourceSyncRunService, {
  startSyncRun: () => Effect.die("SourceSyncRunService test stub: startSyncRun not implemented"),
  getSyncRun: () => Effect.die("SourceSyncRunService test stub: getSyncRun not implemented"),
} satisfies SourceSyncRunServiceShape)

const TransferReconciliationServiceTestLive = Layer.succeed(TransferReconciliationService, {
  reconcileTransferCandidates: () =>
    Effect.die(
      "TransferReconciliationService test stub: reconcileTransferCandidates not implemented"
    ),
  rollbackReconciliationsForSourceReplay: () => Effect.void,
  applyDeterministicInternalTransferCanonicalization: () =>
    Effect.die(
      "TransferReconciliationService test stub: applyDeterministicInternalTransferCanonicalization not implemented"
    ),
} satisfies TransferReconciliationServiceShape)

const AuthServiceTestLive = Layer.succeed(AuthService, {
  login: () => Effect.die("AuthService test stub: login not implemented"),
  register: () => Effect.die("AuthService test stub: register not implemented"),
  startEmailVerification: () =>
    Effect.die("AuthService test stub: startEmailVerification not implemented"),
  resendEmailVerification: () =>
    Effect.die("AuthService test stub: resendEmailVerification not implemented"),
  verifyEmail: () => Effect.die("AuthService test stub: verifyEmail not implemented"),
  startOAuthLogin: () => Effect.die("AuthService test stub: startOAuthLogin not implemented"),
  completeOAuthLogin: () => Effect.die("AuthService test stub: completeOAuthLogin not implemented"),
  startLink: () => Effect.die("AuthService test stub: startLink not implemented"),
  completeLink: () => Effect.die("AuthService test stub: completeLink not implemented"),
  logout: () => Effect.die("AuthService test stub: logout not implemented"),
  validateSession: () => Effect.die("AuthService test stub: validateSession not implemented"),
  linkIdentity: () => Effect.die("AuthService test stub: linkIdentity not implemented"),
  getEnabledProviders: Effect.succeed(Chunk.fromIterable(["local", "coinbase"] as const)),
} satisfies AuthServiceShape)

const PasswordHasherTestLive = Layer.succeed(PasswordHasher, {
  hash: () => Effect.succeed(HashedPassword.make("test-password-hash")),
  verify: () => Effect.succeed(true),
})

const PersistenceLayer = Layer.mergeAll(
  RepositoriesLive,
  SourceSyncServiceTestLive,
  SourceSyncRunServiceTestLive,
  TransferReconciliationServiceTestLive,
  AuthServiceTestLive,
  PasswordHasherTestLive
).pipe(Layer.provideMerge(TestPgClientLive))

const HttpLive = HttpRouter.serve(
  TaxMaxiApiLive.pipe(
    Layer.provide(SourceSyncQueueUnexpectedTestLive),
    Layer.provide(AnonSessionServiceTestLive),
    Layer.provide(SIWXProofVerifierTestLive),
    Layer.provide(X402PaymentValidatorTestLive),
    Layer.provide(SimpleTokenValidatorLive)
  )
).pipe(
  Layer.provideMerge(PersistenceLayer),
  Layer.provideMerge(HttpServerTestLive),
  Layer.provide(ConfigProvider.layer(TestConfigProvider))
)

const execute = (request: HttpClientRequest.HttpClientRequest) => HttpClient.execute(request)

const catalogPrices = () =>
  [
    {
      id: "price_individual_annual",
      billing_scheme: "per_unit" as const,
      lookup_key: "taxmaxi_annual_10k_eur",
      product: "prod_individual",
      recurring: {
        interval: "year",
        interval_count: 1,
        usage_type: "licensed" as const,
        trial_period_days: null,
      },
      transform_quantity: null,
      unit_amount: 15_900,
      currency: "eur",
      tax_behavior: "inclusive" as const,
    },
    {
      id: "price_individual_topup",
      billing_scheme: "per_unit" as const,
      lookup_key: "taxmaxi_topup_1k_eur",
      product: "prod_individual_topup",
      recurring: null,
      transform_quantity: null,
      unit_amount: 2_000,
      currency: "eur",
      tax_behavior: "inclusive" as const,
    },
    {
      id: "price_professional_annual",
      billing_scheme: "per_unit" as const,
      lookup_key: "taxmaxi_professional_annual_100k_eur",
      product: "prod_professional",
      recurring: {
        interval: "year",
        interval_count: 1,
        usage_type: "licensed" as const,
        trial_period_days: null,
      },
      transform_quantity: null,
      unit_amount: 159_000,
      currency: "eur",
      tax_behavior: "exclusive" as const,
    },
    {
      id: "price_professional_matter",
      billing_scheme: "per_unit" as const,
      lookup_key: "taxmaxi_professional_matter_annual_10k_eur",
      product: "prod_professional_matter",
      recurring: {
        interval: "year",
        interval_count: 1,
        usage_type: "licensed" as const,
        trial_period_days: null,
      },
      transform_quantity: null,
      unit_amount: 14_900,
      currency: "eur",
      tax_behavior: "exclusive" as const,
    },
    {
      id: "price_professional_topup",
      billing_scheme: "per_unit" as const,
      lookup_key: "taxmaxi_professional_topup_20k_eur",
      product: "prod_professional_topup",
      recurring: null,
      transform_quantity: null,
      unit_amount: 20_000,
      currency: "eur",
      tax_behavior: "exclusive" as const,
    },
    {
      id: "price_enterprise_pilot",
      billing_scheme: "per_unit" as const,
      lookup_key: "taxmaxi_enterprise_pilot_eur",
      product: "prod_enterprise_pilot",
      recurring: null,
      transform_quantity: null,
      unit_amount: 500_000,
      currency: "eur",
      tax_behavior: "exclusive" as const,
    },
  ].map((price) => {
    const item = TAXMAXI_STRIPE_CATALOG.find(({ lookupKey }) => lookupKey === price.lookup_key)
    if (item === undefined) throw new Error(`Unknown TaxMaxi catalog price ${price.lookup_key}`)
    return {
      ...price,
      product: {
        id: price.product,
        active: true,
        name: item.name,
        description: item.description,
        tax_code: TAXMAXI_STRIPE_TAX_CODE,
        metadata: { [STRIPE_CATALOG_PRODUCT_METADATA_KEY]: item.lookupKey },
      },
    }
  })

const annualSubscription = {
  id: "sub_active",
  customer: "cus_http_boundary",
  status: "active",
  metadata: {
    plan_lookup_key: "taxmaxi_annual_10k_eur",
    plan_product_id: "prod_individual",
  },
  items: {
    data: [
      {
        price: {
          lookup_key: "taxmaxi_annual_10k_eur",
          product: "prod_individual",
          recurring: { interval: "year", interval_count: 1 },
        },
      },
    ],
  },
}

await Effect.runPromise(context.recreateTestDatabase())
await context.runPg(
  Effect.gen(function* () {
    const db = yield* drizzle
    yield* db.insert(schema.users).values({
      id: TEST_USER_ID,
      email: "billing-http-boundary@taxmaxi.test",
      name: "Billing HTTP Boundary",
    })
    yield* db.insert(schema.billingAccounts).values({
      userId: TEST_USER_ID,
      stripeCustomerId: "cus_http_boundary",
    })
  })
)

describe("BillingApiLive", () => {
  it.effect("enforces billing auth and forwards the raw signed Stripe webhook", () =>
    Effect.gen(function* () {
      stripeHttpMockState.prices = catalogPrices()
      stripeHttpMockState.subscriptions = []
      stripeHttpMockState.checkoutModes = []
      stripeHttpMockState.webhookInputs = []
      stripeHttpMockState.webhookError = null

      yield* Effect.gen(function* () {
        const catalog = yield* execute(HttpClientRequest.get("/v1/billing/catalog"))
        expect(catalog.status).toBe(200)
        expect(yield* catalog.json).toEqual({
          prices: catalogPrices().map((price) => ({
            lookupKey: price.lookup_key,
            amountMinor: price.unit_amount,
            currency: price.currency,
            taxBehavior: price.tax_behavior,
            recurringInterval: price.recurring?.interval === "year" ? "year" : null,
          })),
        })

        for (const path of [
          "/v1/billing/status",
          "/v1/billing/checkout/annual",
          "/v1/billing/checkout/top-up",
          "/v1/billing/portal",
        ]) {
          const request = path.endsWith("status")
            ? HttpClientRequest.get(path)
            : HttpClientRequest.post(path)
          const response = yield* execute(request)
          expect(response.status).toBe(401)
        }

        const authenticatedStatus = yield* execute(
          HttpClientRequest.get("/v1/billing/status").pipe(
            HttpClientRequest.bearerToken(AUTHORIZATION)
          )
        )
        expect(authenticatedStatus.status).toBe(200)
        expect(yield* authenticatedStatus.json).toEqual({
          credits: 0,
          subscriptionStatus: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
        })

        const annualCheckout = yield* execute(
          HttpClientRequest.post("/v1/billing/checkout/annual").pipe(
            HttpClientRequest.bearerToken(AUTHORIZATION)
          )
        )
        expect(annualCheckout.status).toBe(200)
        expect(yield* annualCheckout.json).toEqual({
          url: "https://checkout.stripe.test/subscription",
        })

        stripeHttpMockState.subscriptions = [annualSubscription]
        const topUpCheckout = yield* execute(
          HttpClientRequest.post("/v1/billing/checkout/top-up").pipe(
            HttpClientRequest.bearerToken(AUTHORIZATION)
          )
        )
        const portal = yield* execute(
          HttpClientRequest.post("/v1/billing/portal").pipe(
            HttpClientRequest.bearerToken(AUTHORIZATION)
          )
        )
        const duplicateAnnual = yield* execute(
          HttpClientRequest.post("/v1/billing/checkout/annual").pipe(
            HttpClientRequest.bearerToken(AUTHORIZATION)
          )
        )
        expect(topUpCheckout.status).toBe(200)
        expect(portal.status).toBe(200)
        expect(duplicateAnnual.status).toBe(400)
        expect(yield* topUpCheckout.json).toEqual({
          url: "https://checkout.stripe.test/payment",
        })
        expect(yield* portal.json).toEqual({ url: "https://billing.stripe.test/portal" })
        expect(stripeHttpMockState.checkoutModes).toEqual(["subscription", "payment"])

        const missingSignature = yield* execute(
          HttpClientRequest.post("/v1/billing/webhooks/stripe").pipe(
            HttpClientRequest.bodyText("raw=stripe-body")
          )
        )
        expect(missingSignature.status).toBe(400)

        stripeHttpMockState.webhookError = new Error("invalid Stripe signature")
        const invalidSignature = yield* execute(
          HttpClientRequest.post("/v1/billing/webhooks/stripe").pipe(
            HttpClientRequest.setHeader("stripe-signature", "sig_invalid"),
            HttpClientRequest.bodyText("raw=forged-body")
          )
        )
        expect(invalidSignature.status).toBe(400)
        const persistedInvalidEvents = yield* Effect.promise(() =>
          context.runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return yield* db.select({ id: schema.stripeEvents.id }).from(schema.stripeEvents)
            })
          )
        )
        expect(persistedInvalidEvents).toEqual([])

        stripeHttpMockState.webhookError = null
        const webhook = yield* execute(
          HttpClientRequest.post("/v1/billing/webhooks/stripe").pipe(
            HttpClientRequest.setHeader("stripe-signature", "sig_http_boundary"),
            HttpClientRequest.bodyText("raw=stripe-body")
          )
        )
        expect(webhook.status).toBe(204)
        expect(stripeHttpMockState.webhookInputs).toEqual([
          { payload: "raw=forged-body", signature: "sig_invalid" },
          { payload: "raw=stripe-body", signature: "sig_http_boundary" },
        ])

        stripeHttpMockState.prices = []
        const unavailableCatalog = yield* execute(HttpClientRequest.get("/v1/billing/catalog"))
        expect(unavailableCatalog.status).toBe(500)

        stripeHttpMockState.catalogError = new Error(
          "Expired API Key provided: rk_live_http_secret"
        )
        const providerFailure = yield* execute(HttpClientRequest.get("/v1/billing/catalog"))
        const providerFailureBody = yield* providerFailure.text
        stripeHttpMockState.catalogError = null
        expect(providerFailure.status).toBe(500)
        expect(providerFailureBody).toContain("Could not load the billing catalog.")
        expect(providerFailureBody).not.toContain("Expired API Key")
        expect(providerFailureBody).not.toContain("rk_live_http_secret")
      }).pipe(Effect.provide(HttpLive), Effect.scoped)
    })
  )
})
