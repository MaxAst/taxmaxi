import * as DateTime from "effect/DateTime"
import { AuthUserId } from "@my/core/authentication"
import {
  BillingRepository,
  type BillingAccount,
  type BillingRepositoryService,
  type BillingSubscriptionStatus,
  UserRepository,
  type UserRepositoryService,
} from "@my/persistence/services"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "@effect/vitest"
import { vi } from "vitest"

interface StripeMockState {
  checkoutFailure: "connection" | "invalid_request" | null
  checkoutParams: Array<unknown>
  charge: unknown
  dispute: unknown
  event: unknown
  invoicePayments: Array<unknown>
  paymentRecord: unknown
  priceListFailure: boolean
  priceListParams: Array<unknown>
  prices: Array<{
    readonly lookup_key?: string | null
    readonly [key: string]: unknown
  }>
  retrievedPrices: Record<string, unknown>
  refunds: Array<unknown>
  refundPagingLimit: number | null
  retrievedRefund: unknown
  listedSubscriptions: Array<unknown> | null
  subscription: unknown
  webhookFailure: unknown
}

const stripeMockState = vi.hoisted<StripeMockState>(() => ({
  checkoutFailure: null,
  checkoutParams: [],
  charge: null,
  dispute: null,
  event: null,
  invoicePayments: [],
  paymentRecord: null,
  priceListFailure: false,
  priceListParams: [],
  prices: [],
  retrievedPrices: {},
  refunds: [],
  refundPagingLimit: null,
  retrievedRefund: null,
  listedSubscriptions: null,
  subscription: null,
  webhookFailure: null,
}))

vi.mock("stripe", () => {
  class StripeMockError extends Data.Error {
    constructor(message: string) {
      super()
      this.message = message
    }

    readonly type: string = "StripeError"
    readonly code: string | undefined = undefined
    readonly requestId: string | undefined = undefined
    readonly statusCode: number | undefined = undefined
  }
  class StripeMockInvalidRequestError extends StripeMockError {
    override readonly type = "StripeInvalidRequestError"
  }
  class StripeMockConnectionError extends StripeMockError {
    override readonly type = "StripeConnectionError"
  }
  class StripeMockApiError extends StripeMockError {
    override readonly type = "StripeAPIError"
  }
  class StripeMockAuthenticationError extends StripeMockError {
    override readonly type = "StripeAuthenticationError"
    override readonly code = "api_key_expired"
    override readonly requestId = "req_expired_key"
    override readonly statusCode = 401
  }
  class StripeMockPermissionError extends StripeMockError {
    override readonly type = "StripePermissionError"
  }
  class StripeMockCardError extends StripeMockError {
    override readonly type = "StripeCardError"
  }

  return {
    default: class StripeMock {
      static readonly errors = {
        StripeError: StripeMockError,
        StripeAPIError: StripeMockApiError,
        StripeAuthenticationError: StripeMockAuthenticationError,
        StripeCardError: StripeMockCardError,
        StripeConnectionError: StripeMockConnectionError,
        StripeInvalidRequestError: StripeMockInvalidRequestError,
        StripePermissionError: StripeMockPermissionError,
      }
      readonly charges = {
        retrieve: () => Promise.resolve(stripeMockState.charge),
      }
      readonly checkout = {
        sessions: {
          create: (params: unknown) => {
            stripeMockState.checkoutParams.push(params)
            if (stripeMockState.checkoutFailure === "invalid_request") {
              return Promise.reject(new StripeMockInvalidRequestError("Price is inactive"))
            }
            if (stripeMockState.checkoutFailure === "connection") {
              return Promise.reject(new StripeMockConnectionError("Connection timed out"))
            }
            return Promise.resolve({ url: "https://checkout.stripe.test/session" })
          },
        },
      }
      readonly customers = {
        retrieve: () => Promise.resolve({ deleted: false }),
      }
      readonly disputes = {
        retrieve: () => Promise.resolve(stripeMockState.dispute),
      }
      readonly prices = {
        list: ({
          active,
          expand,
          lookup_keys: lookupKeys,
          limit,
        }: {
          readonly active?: boolean
          readonly expand?: ReadonlyArray<string>
          readonly lookup_keys?: ReadonlyArray<string>
          readonly limit?: number
        } = {}) => {
          stripeMockState.priceListParams.push({ active, expand, lookup_keys: lookupKeys, limit })
          if (stripeMockState.priceListFailure) {
            return Promise.reject(
              new StripeMockAuthenticationError(
                "Expired API Key provided: rk_live_secret123 sk_test_secret456 whsec_secret789\nretry denied"
              )
            )
          }
          const matchingPrices = stripeMockState.prices.filter(
            (price) =>
              (active !== true || price.active !== false) &&
              (lookupKeys === undefined ||
                (price.lookup_key !== undefined && lookupKeys.includes(price.lookup_key ?? "")))
          )
          const expandProducts = expand?.includes("data.product") === true
          return Promise.resolve({
            data: expandProducts
              ? matchingPrices
              : matchingPrices.map((price) => {
                  const product = price.product
                  return typeof product === "object" &&
                    product !== null &&
                    "id" in product &&
                    typeof product.id === "string"
                    ? { ...price, product: product.id }
                    : price
                }),
          })
        },
        retrieve: (priceId: string) => Promise.resolve(stripeMockState.retrievedPrices[priceId]),
      }
      readonly subscriptions = {
        list: () => ({
          autoPagingToArray: () =>
            Promise.resolve(stripeMockState.listedSubscriptions ?? [stripeMockState.subscription]),
        }),
        retrieve: () => Promise.resolve(stripeMockState.subscription),
      }
      readonly invoicePayments = {
        list: () => ({
          autoPagingToArray: () => Promise.resolve(stripeMockState.invoicePayments),
        }),
      }
      readonly paymentRecords = {
        retrieve: () => Promise.resolve(stripeMockState.paymentRecord),
      }
      readonly refunds = {
        list: () => ({
          autoPagingToArray: ({ limit }: { readonly limit: number }) => {
            stripeMockState.refundPagingLimit = limit
            return Promise.resolve(stripeMockState.refunds)
          },
        }),
        retrieve: () => Promise.resolve(stripeMockState.retrievedRefund),
      }
      readonly webhooks = {
        constructEventAsync: () =>
          stripeMockState.webhookFailure === null
            ? Promise.resolve(stripeMockState.event)
            : Promise.reject(stripeMockState.webhookFailure),
      }
    },
  }
})

import {
  allocateCreditNoteReversalAcrossPayments,
  allocateAnnualCreditsAcrossPayments,
  annualInvoiceProductIds,
  annualInvoiceCreditAllocations,
  annualPaymentAllocationsFromInvoicePayments,
  annualCheckoutIdempotencyKey,
  buildAnnualCheckoutParams,
  buildTopUpCheckoutParams,
  chargePaymentReference,
  completeInvoiceLines,
  createReservedAnnualCheckoutSession,
  currentExistingAnnualSubscription,
  disputeCreditReversal,
  hasExistingTaxMaxiAnnualSubscription,
  hasCompleteCatalogLookupKeys,
  hasFixedUnitAmount,
  invoicePaymentReference,
  isCatalogPriceDefinitionValid,
  isCatalogPriceCadenceValid,
  isAnnualInvoiceEligible,
  isAnnualInvoiceLineEligible,
  findEligibleAnnualInvoiceLine,
  isPaidTopUpSessionEligible,
  isSupportedCatalogCurrency,
  isTaxMaxiAnnualSubscription,
  isValidAnnualPrice,
  isValidTopUpPrice,
  loadAllStripeItems,
  persistAnnualCreditAllocations,
  resolvePaidFulfillmentUserId,
  resolveReservedAnnualCheckoutPrice,
  shouldReconcileAnnualSubscription,
  subscriptionIdToClearAfterConfirmation,
  StripeBillingServiceLive,
  verifiedTopUpCustomer,
  validateStripeWebhookEvent,
} from "../src/layers/StripeBillingServiceLive.ts"
import { StripeBillingService } from "../src/services/StripeBillingService.ts"
import {
  STRIPE_CATALOG_PRODUCT_METADATA_KEY,
  TAXMAXI_STRIPE_CATALOG,
  TAXMAXI_STRIPE_TAX_CODE,
  type TaxMaxiStripeCatalogItem,
} from "../src/services/StripeCatalog.ts"

const TEST_USER_ID = AuthUserId.make("00000000-0000-4000-8000-000000000192")
const OTHER_USER_ID = AuthUserId.make("00000000-0000-4000-8000-000000000193")

const billingAccount = ({
  userId = TEST_USER_ID,
  stripeCustomerId,
  subscriptionStatus = "active",
}: {
  readonly userId?: AuthUserId
  readonly stripeCustomerId: string | null
  readonly subscriptionStatus?: BillingSubscriptionStatus
}): BillingAccount => ({
  userId,
  stripeCustomerId,
  stripeCustomerGeneration: 0,
  stripeSubscriptionId: "sub_test",
  subscriptionStatus,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  lastSubscriptionEventCreatedAt: null,
})

const billingRepositoryStub: BillingRepositoryService = {
  findByUserId: () => Effect.succeed(Option.none()),
  findByStripeCustomerId: () => Effect.succeed(Option.none()),
  saveCustomer: () => Effect.void,
  saveSubscription: () => Effect.succeed(true),
  clearSubscription: () => Effect.succeed(true),
  reserveSubscriptionSync: () => Effect.succeed(1),
  clearCustomer: () => Effect.void,
  reserveAnnualCheckout: () =>
    Effect.succeed({
      generation: 1,
      expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-14T11:00:00.000Z")),
      priceId: "price_annual",
    }),
  clearAnnualCheckoutReservation: () => Effect.succeed(true),
  grantCredits: () => Effect.succeed(true),
  reconcilePaymentCreditReversals: () => Effect.succeed(false),
  setPaymentCreditReversal: () => Effect.succeed(true),
  availableCredits: () => Effect.succeed(0),
  hasProcessedEvent: () => Effect.succeed(false),
  markEventProcessed: () => Effect.void,
}

const userRepositoryStub: UserRepositoryService = {
  findById: () => Effect.succeed(Option.none()),
  findByEmail: () => Effect.succeed(Option.none()),
  create: () => Effect.die("unused user repository create"),
  update: () => Effect.die("unused user repository update"),
  markWelcomeSeen: () => Effect.die("unused user repository markWelcomeSeen"),
  delete: () => Effect.die("unused user repository delete"),
  findPlatformAdmins: Effect.succeed([]),
  isPlatformAdmin: () => Effect.succeed(false),
}

const repositoryLayers = Layer.merge(
  Layer.succeed(BillingRepository, billingRepositoryStub),
  Layer.succeed(UserRepository, userRepositoryStub)
)

const loadServiceWithoutStripeConfig = () =>
  Effect.runPromise(
    StripeBillingService.pipe(
      Effect.provide(StripeBillingServiceLive.pipe(Layer.provide(repositoryLayers))),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({}))
    )
  )

const loadServiceWithStripe = (billingRepository: BillingRepositoryService) =>
  Effect.runPromise(
    StripeBillingService.pipe(
      Effect.provide(
        StripeBillingServiceLive.pipe(
          Layer.provide(
            Layer.merge(
              Layer.succeed(BillingRepository, billingRepository),
              Layer.succeed(UserRepository, userRepositoryStub)
            )
          )
        )
      ),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnvRecord({
          STRIPE_SECRET_KEY: "sk_test",
          STRIPE_WEBHOOK_SECRET: "whsec_test",
        })
      )
    )
  )

const catalogProduct = (item: TaxMaxiStripeCatalogItem, id: string) => ({
  id,
  active: true,
  name: item.name,
  description: item.description,
  tax_code: TAXMAXI_STRIPE_TAX_CODE,
  metadata: { [STRIPE_CATALOG_PRODUCT_METADATA_KEY]: item.lookupKey },
})

const catalogPrice = (item: TaxMaxiStripeCatalogItem) => ({
  id: `price_${item.lookupKey}`,
  billing_scheme: "per_unit" as const,
  lookup_key: item.lookupKey,
  product: catalogProduct(item, `prod_${item.lookupKey}`),
  recurring:
    item.recurringInterval === null
      ? null
      : {
          interval: item.recurringInterval,
          interval_count: 1,
          usage_type: "licensed",
          trial_period_days: null,
        },
  transform_quantity: null,
  unit_amount: item.unitAmount,
  currency: item.currency,
  tax_behavior: item.taxBehavior,
})

const catalogPriceByLookupKey = (lookupKey: string, productId?: string) => {
  const item = TAXMAXI_STRIPE_CATALOG.find((candidate) => candidate.lookupKey === lookupKey)
  if (item === undefined) throw new Error(`Unknown TaxMaxi Stripe catalog item ${lookupKey}`)
  const price = catalogPrice(item)
  return productId === undefined
    ? price
    : { ...price, product: { ...price.product, id: productId } }
}

const completeStripeCatalog = () => TAXMAXI_STRIPE_CATALOG.map(catalogPrice)

describe("StripeBillingServiceLive", () => {
  it("scopes annual billing state to the TaxMaxi annual plan", () => {
    const subscription = ({
      lookupKey,
      product,
      interval = "year",
      intervalCount = 1,
      metadata = {},
    }: {
      readonly lookupKey: string | null
      readonly product: string
      readonly interval?: string
      readonly intervalCount?: number
      readonly metadata?: Readonly<Record<string, string>>
    }) => ({
      metadata,
      items: {
        data: [
          {
            price: {
              lookup_key: lookupKey,
              product,
              recurring: { interval, interval_count: intervalCount },
            },
          },
        ],
      },
    })

    expect(
      isTaxMaxiAnnualSubscription({
        subscription: subscription({
          lookupKey: null,
          product: "prod_archived",
          metadata: {
            plan_lookup_key: "taxmaxi_annual_10k_eur",
            plan_product_id: "prod_archived",
          },
        }),
      })
    ).toBe(true)
    expect(
      isTaxMaxiAnnualSubscription({
        subscription: subscription({
          lookupKey: null,
          product: "prod_partially_tagged_archived",
          metadata: { plan_lookup_key: "taxmaxi_annual_10k_eur" },
        }),
      })
    ).toBe(true)
    expect(
      isTaxMaxiAnnualSubscription({
        subscription: subscription({ lookupKey: null, product: "prod_annual" }),
        currentProductId: "prod_annual",
      })
    ).toBe(true)
    expect(
      isTaxMaxiAnnualSubscription({
        subscription: subscription({
          lookupKey: null,
          product: "prod_annual",
          interval: "month",
        }),
        currentProductId: "prod_annual",
      })
    ).toBe(false)
    expect(
      isTaxMaxiAnnualSubscription({
        subscription: subscription({
          lookupKey: null,
          product: "prod_annual",
          intervalCount: 2,
        }),
        currentProductId: "prod_annual",
      })
    ).toBe(false)
    expect(
      isTaxMaxiAnnualSubscription({
        subscription: subscription({ lookupKey: "professional_annual", product: "prod_other" }),
        currentProductId: "prod_annual",
      })
    ).toBe(false)
    expect(
      isTaxMaxiAnnualSubscription({
        subscription: subscription({
          lookupKey: null,
          product: "prod_professional",
          metadata: {
            plan_lookup_key: "taxmaxi_annual_10k_eur",
            plan_product_id: "prod_original_annual",
          },
        }),
      })
    ).toBe(false)
  })

  it.effect("loads every invoice line when Stripe embeds only the first page", () =>
    Effect.gen(function* () {
      let loadCount = 0
      const lines = yield* completeInvoiceLines({
        embeddedLines: ["add-on"],
        hasMore: true,
        loadAll: () =>
          Effect.sync(() => {
            loadCount += 1
            return ["add-on", "annual"]
          }),
      })

      expect(lines).toEqual(["add-on", "annual"])
      expect(loadCount).toBe(1)
    })
  )

  it("ignores stale local state and unrelated Stripe plans for annual Checkout", () => {
    const unrelatedSubscription = {
      status: "active",
      metadata: { plan_lookup_key: "taxmaxi_professional_annual" },
      items: {
        data: [
          {
            price: {
              lookup_key: "taxmaxi_professional_annual",
              product: "prod_pro",
              recurring: { interval: "year", interval_count: 1 },
            },
          },
        ],
      },
    }

    expect(
      hasExistingTaxMaxiAnnualSubscription({
        subscriptions: [unrelatedSubscription],
        currentProductId: "prod_annual",
      })
    ).toBe(false)
    expect(
      hasExistingTaxMaxiAnnualSubscription({
        subscriptions: [
          {
            status: "active",
            metadata: {},
            items: {
              data: [
                {
                  price: {
                    lookup_key: null,
                    product: "prod_annual",
                    recurring: { interval: "month", interval_count: 1 },
                  },
                },
              ],
            },
          },
        ],
        currentProductId: "prod_annual",
      })
    ).toBe(false)
    expect(
      hasExistingTaxMaxiAnnualSubscription({
        subscriptions: [
          {
            status: "past_due",
            metadata: {
              plan_lookup_key: "taxmaxi_annual_10k_eur",
              plan_product_id: "prod_archived_annual",
            },
            items: {
              data: [
                {
                  price: {
                    lookup_key: null,
                    product: "prod_archived_annual",
                    recurring: { interval: "year", interval_count: 1 },
                  },
                },
              ],
            },
          },
        ],
        currentProductId: "prod_annual",
      })
    ).toBe(true)
  })

  it.effect("auto-pages Stripe subscriptions before checking annual Checkout eligibility", () =>
    Effect.gen(function* () {
      const firstPage = ["unrelated"]
      let receivedLimit = 0
      const allSubscriptions = yield* Effect.promise(() =>
        loadAllStripeItems({
          page: {
            autoPagingToArray: ({ limit }) => {
              receivedLimit = limit
              return Promise.resolve([...firstPage, "annual"])
            },
          },
        })
      )

      expect(allSubscriptions).toEqual(["unrelated", "annual"])
      expect(receivedLimit).toBe(10_000)
    })
  )

  it("prefers an active annual replacement over a deleted annual subscription", () => {
    const annualSubscription = (id: string, status: string) => ({
      id,
      status,
      metadata: {
        plan_lookup_key: "taxmaxi_annual_10k_eur",
        plan_product_id: "prod_annual",
      },
      items: {
        data: [
          {
            price: {
              lookup_key: null,
              product: "prod_annual",
              recurring: { interval: "year", interval_count: 1 },
            },
          },
        ],
      },
    })

    expect(
      currentExistingAnnualSubscription([
        annualSubscription("sub_deleted", "canceled"),
        annualSubscription("sub_replacement", "active"),
      ])
    ).toMatchObject({ id: "sub_replacement", status: "active" })
    expect(
      currentExistingAnnualSubscription(
        [
          {
            id: "sub_legacy_same_product",
            status: "active",
            metadata: {},
            items: {
              data: [
                {
                  price: {
                    lookup_key: null,
                    product: "prod_annual",
                    recurring: { interval: "year", interval_count: 1 },
                  },
                },
              ],
            },
          },
        ],
        "prod_annual"
      )
    ).toMatchObject({ id: "sub_legacy_same_product", status: "active" })
  })

  it("reconciles current annual and tracked off-plan subscription events only", () => {
    const subscription = ({
      id,
      lookupKey,
      product,
    }: {
      readonly id: string
      readonly lookupKey: string | null
      readonly product: string
    }) => ({
      id,
      metadata: {},
      items: {
        data: [
          {
            price: {
              lookup_key: lookupKey,
              product,
              recurring: { interval: "year", interval_count: 1 },
            },
          },
        ],
      },
    })

    expect(
      shouldReconcileAnnualSubscription({
        subscription: subscription({
          id: "sub_annual",
          lookupKey: "taxmaxi_annual_10k_eur",
          product: "prod_annual",
        }),
        trackedSubscriptionId: null,
      })
    ).toBe(true)
    expect(
      shouldReconcileAnnualSubscription({
        subscription: subscription({
          id: "sub_legacy_same_product",
          lookupKey: null,
          product: "prod_annual",
        }),
        trackedSubscriptionId: null,
        currentProductId: "prod_annual",
      })
    ).toBe(true)
    expect(
      shouldReconcileAnnualSubscription({
        subscription: subscription({
          id: "sub_tracked",
          lookupKey: "professional_annual",
          product: "prod_professional",
        }),
        trackedSubscriptionId: "sub_tracked",
      })
    ).toBe(true)
    expect(
      shouldReconcileAnnualSubscription({
        subscription: subscription({
          id: "sub_unrelated",
          lookupKey: "professional_annual",
          product: "prod_professional",
        }),
        trackedSubscriptionId: "sub_annual",
      })
    ).toBe(false)
  })

  it("clears the replacement subscription when confirmation finds no annual plan", () => {
    expect(
      subscriptionIdToClearAfterConfirmation({
        currentSubscriptionId: "sub_replacement",
        confirmedSubscriptionId: null,
      })
    ).toBe("sub_replacement")
    expect(
      subscriptionIdToClearAfterConfirmation({
        currentSubscriptionId: "sub_replacement",
        confirmedSubscriptionId: "sub_confirmed",
      })
    ).toBeNull()
  })

  it("enables Stripe Tax in annual and top-up Checkout payloads", () => {
    const price = { id: "price_annual", product: "prod_annual" }
    const annual = buildAnnualCheckoutParams({
      customer: "cus_test",
      price,
      userId: TEST_USER_ID,
      frontendUrl: "https://taxmaxi.test",
      expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-15T12:00:00.000Z")),
      generation: 3,
    })
    const topUp = buildTopUpCheckoutParams({
      customer: "cus_test",
      price: { id: "price_top_up", product: "prod_top_up" },
      userId: TEST_USER_ID,
      frontendUrl: "https://taxmaxi.test",
    })

    expect(annual).toMatchObject({
      mode: "subscription",
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      cancel_url: "https://taxmaxi.test/app/billing",
      subscription_data: {
        metadata: { annual_checkout_generation: "3" },
      },
    })
    expect(topUp).toMatchObject({
      mode: "payment",
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
    })
  })

  it("keeps annual Checkout idempotency stable for one reservation", () => {
    const input = {
      userId: TEST_USER_ID,
      customer: "cus_test",
      generation: 3,
    } as const
    const firstRequest = annualCheckoutIdempotencyKey(input)
    const repeatedRequestAfterPriceChange = annualCheckoutIdempotencyKey(input)

    expect(firstRequest).toBe(repeatedRequestAfterPriceChange)
    expect(firstRequest).toBe(`taxmaxi-annual-checkout-${TEST_USER_ID}-cus_test-3`)
  })

  it.effect(
    "reuses the complete reserved annual Checkout request after the lookup key changes",
    () =>
      Effect.gen(function* () {
        const loadedPriceIds: Array<string> = []
        const requests: Array<{
          readonly params: {
            readonly line_items?: ReadonlyArray<{
              readonly price?: string
              readonly quantity?: number
            }>
          }
          readonly idempotencyKey: string
        }> = []
        const reservation = {
          generation: 3,
          expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-14T11:00:00.000Z")),
          priceId: "price_original",
        }
        const runCheckout = (currentPriceId: string) =>
          createReservedAnnualCheckoutSession({
            currentPrice: { id: currentPriceId, product: "prod_annual" },
            reservation,
            customer: "cus_test",
            userId: TEST_USER_ID,
            frontendUrl: "https://taxmaxi.test",
            loadPrice: (priceId) =>
              Effect.sync(() => {
                loadedPriceIds.push(priceId)
                return { id: priceId, product: "prod_annual" }
              }),
            createSession: ({ params, idempotencyKey }) =>
              Effect.sync(() => {
                requests.push({ params, idempotencyKey })
                return { url: "https://checkout.stripe.test/original" }
              }),
          })

        yield* runCheckout("price_original")
        yield* runCheckout("price_new")

        expect(loadedPriceIds).toEqual(["price_original"])
        expect(requests).toHaveLength(2)
        expect(requests[1]).toEqual(requests[0])
        expect(requests[0]?.params.line_items).toEqual([{ price: "price_original", quantity: 1 }])
      })
  )

  it.effect("loads a reserved annual price only when it differs from the current lookup", () =>
    Effect.gen(function* () {
      const loadedPriceIds: Array<string> = []
      const price = yield* resolveReservedAnnualCheckoutPrice({
        currentPrice: { id: "price_new" },
        reservedPriceId: "price_original",
        loadPrice: (priceId) =>
          Effect.sync(() => {
            loadedPriceIds.push(priceId)
            return { id: priceId }
          }),
      })

      expect(price.id).toBe("price_original")
      expect(loadedPriceIds).toEqual(["price_original"])
    })
  )

  it("rejects Stripe catalog prices without a fixed unit amount", () => {
    expect(hasFixedUnitAmount({ unit_amount: 1_000 })).toBe(true)
    expect(hasFixedUnitAmount({ unit_amount: null })).toBe(false)
  })

  it.effect("logs Stripe catalog request failures before returning a typed error", () =>
    Effect.gen(function* () {
      const logMessages: Array<unknown> = []
      const logger = Logger.make<unknown, void>(({ message }) => {
        logMessages.push(message)
      })
      stripeMockState.priceListFailure = true

      try {
        const service = yield* Effect.promise(() => loadServiceWithStripe(billingRepositoryStub))
        const result = yield* Effect.result(service.catalog).pipe(Effect.withLogger(logger))

        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { message: expect.stringContaining("Expired API Key provided") },
        })
        expect(logMessages).toContainEqual([
          {
            provider: "stripe",
            operation: "Could not load Stripe prices",
            stripeErrorType: "StripeAuthenticationError",
            stripeErrorCode: "api_key_expired",
            stripeErrorMessage:
              "Expired API Key provided: [REDACTED_STRIPE_KEY] [REDACTED_STRIPE_KEY] [REDACTED_STRIPE_WEBHOOK_SECRET] retry denied",
            stripeRequestId: "req_expired_key",
            stripeStatusCode: 401,
          },
          "Stripe request failed",
        ])
        const encodedLogMessages = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.Unknown)
        )(logMessages)
        expect(encodedLogMessages).not.toContain("rk_live_secret123")
        expect(encodedLogMessages).not.toContain("sk_test_secret456")
        expect(encodedLogMessages).not.toContain("whsec_secret789")
      } finally {
        stripeMockState.priceListFailure = false
      }
    })
  )

  it("validates the cadence promised by every Stripe catalog lookup key", () => {
    const yearly = { recurring: { interval: "year", interval_count: 1 } }
    const monthly = { recurring: { interval: "month", interval_count: 1 } }
    const multiYear = { recurring: { interval: "year", interval_count: 2 } }
    const oneTime = { recurring: null }

    for (const lookupKey of [
      "taxmaxi_annual_10k_eur",
      "taxmaxi_professional_annual_100k_eur",
      "taxmaxi_professional_matter_annual_10k_eur",
    ]) {
      expect(isCatalogPriceCadenceValid({ lookupKey, price: yearly })).toBe(true)
      expect(isCatalogPriceCadenceValid({ lookupKey, price: monthly })).toBe(false)
      expect(isCatalogPriceCadenceValid({ lookupKey, price: multiYear })).toBe(false)
      expect(isCatalogPriceCadenceValid({ lookupKey, price: oneTime })).toBe(false)
    }

    for (const lookupKey of [
      "taxmaxi_topup_1k_eur",
      "taxmaxi_professional_topup_20k_eur",
      "taxmaxi_enterprise_pilot_eur",
    ]) {
      expect(isCatalogPriceCadenceValid({ lookupKey, price: oneTime })).toBe(true)
      expect(isCatalogPriceCadenceValid({ lookupKey, price: yearly })).toBe(false)
    }
  })

  it.effect("requests only active prices with expanded Products for catalog and Checkout", () =>
    Effect.gen(function* () {
      stripeMockState.priceListParams.length = 0
      stripeMockState.prices = completeStripeCatalog()
      stripeMockState.listedSubscriptions = []
      stripeMockState.checkoutParams = []
      const service = yield* Effect.promise(() =>
        loadServiceWithStripe({
          ...billingRepositoryStub,
          findByUserId: () =>
            Effect.succeed(Option.some(billingAccount({ stripeCustomerId: "cus_test" }))),
          reserveAnnualCheckout: ({ priceId }) =>
            Effect.succeed({
              generation: 1,
              expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-14T11:00:00.000Z")),
              priceId,
            }),
        })
      )

      yield* service.catalog
      yield* service.createAnnualCheckout(TEST_USER_ID)

      expect(stripeMockState.priceListParams).toEqual([
        {
          active: true,
          expand: ["data.product"],
          lookup_keys: TAXMAXI_STRIPE_CATALOG.map(({ lookupKey }) => lookupKey),
          limit: TAXMAXI_STRIPE_CATALOG.length,
        },
        {
          active: true,
          expand: ["data.product"],
          lookup_keys: ["taxmaxi_annual_10k_eur"],
          limit: 1,
        },
      ])

      stripeMockState.listedSubscriptions = null
    })
  )

  it("accepts only one complete EUR catalog", () => {
    const prices = [
      "taxmaxi_annual_10k_eur",
      "taxmaxi_topup_1k_eur",
      "taxmaxi_professional_annual_100k_eur",
      "taxmaxi_professional_matter_annual_10k_eur",
      "taxmaxi_professional_topup_20k_eur",
      "taxmaxi_enterprise_pilot_eur",
    ].map((lookup_key) => ({ lookup_key }))

    expect(hasCompleteCatalogLookupKeys(prices)).toBe(true)
    expect(hasCompleteCatalogLookupKeys(prices.slice(1))).toBe(false)
    expect(
      hasCompleteCatalogLookupKeys([...prices.slice(1), { lookup_key: "taxmaxi_topup_1k_eur" }])
    ).toBe(false)
    expect(isSupportedCatalogCurrency("eur")).toBe(true)
    expect(isSupportedCatalogCurrency("usd")).toBe(false)
    expect(isSupportedCatalogCurrency("jpy")).toBe(false)
  })

  it("validates every Stripe catalog price against its complete catalog definition", () => {
    const [annualPrice] = completeStripeCatalog()

    expect(annualPrice).toBeDefined()
    if (annualPrice === undefined) return
    const annualRecurring = annualPrice.recurring
    expect(annualRecurring).not.toBeNull()
    if (annualRecurring === null) return

    expect(isCatalogPriceDefinitionValid(annualPrice)).toBe(true)
    expect(isCatalogPriceDefinitionValid({ ...annualPrice, unit_amount: 1 })).toBe(false)
    expect(isCatalogPriceDefinitionValid({ ...annualPrice, tax_behavior: "exclusive" })).toBe(false)
    expect(isCatalogPriceDefinitionValid({ ...annualPrice, billing_scheme: "tiered" })).toBe(false)
    expect(
      isCatalogPriceDefinitionValid({
        ...annualPrice,
        transform_quantity: { divide_by: 10, round: "up" },
      })
    ).toBe(false)
    expect(
      isCatalogPriceDefinitionValid({
        ...annualPrice,
        recurring: { ...annualRecurring, usage_type: "metered" },
      })
    ).toBe(false)
    expect(
      isCatalogPriceDefinitionValid({
        ...annualPrice,
        recurring: { ...annualRecurring, trial_period_days: 14 },
      })
    ).toBe(false)
    expect(isCatalogPriceDefinitionValid({ ...annualPrice, product: annualPrice.product.id })).toBe(
      false
    )
    expect(
      isCatalogPriceDefinitionValid({
        ...annualPrice,
        product: { id: annualPrice.product.id, deleted: true },
      })
    ).toBe(false)
    expect(
      isCatalogPriceDefinitionValid({
        ...annualPrice,
        product: { ...annualPrice.product, active: false },
      })
    ).toBe(false)
    expect(
      isCatalogPriceDefinitionValid({
        ...annualPrice,
        product: { ...annualPrice.product, name: "Changed product name" },
      })
    ).toBe(false)
    expect(
      isCatalogPriceDefinitionValid({
        ...annualPrice,
        product: { ...annualPrice.product, description: "Changed product description" },
      })
    ).toBe(false)
    expect(
      isCatalogPriceDefinitionValid({
        ...annualPrice,
        product: { ...annualPrice.product, tax_code: "txcd_wrong" },
      })
    ).toBe(false)
    expect(
      isCatalogPriceDefinitionValid({
        ...annualPrice,
        product: { ...annualPrice.product, metadata: {} },
      })
    ).toBe(false)
  })

  it.effect("logs Stripe signature failures without retaining the header or payload", () =>
    Effect.gen(function* () {
      const logMessages: Array<unknown> = []
      const logger = Logger.make<unknown, void>(({ message }) => {
        logMessages.push(message)
      })
      stripeMockState.webhookFailure = Object.assign(
        new Error("No signatures found matching the expected signature for payload."),
        {
          type: "StripeSignatureVerificationError",
          header: "t=123,v1=signature-secret",
          payload: '{"customer_email":"private@example.com"}',
        }
      )

      try {
        const service = yield* Effect.promise(() => loadServiceWithStripe(billingRepositoryStub))
        const result = yield* Effect.result(
          service.processWebhook({ payload: "{}", signature: "signature-secret" })
        ).pipe(Effect.withLogger(logger))

        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            message:
              "Invalid Stripe webhook signature: No signatures found matching the expected signature for payload.",
          },
        })
        expect(logMessages).toContainEqual([
          {
            provider: "stripe",
            operation: "Invalid Stripe webhook signature",
            stripeErrorType: "StripeSignatureVerificationError",
            stripeErrorCode: undefined,
            stripeErrorMessage: "No signatures found matching the expected signature for payload.",
            stripeRequestId: undefined,
            stripeStatusCode: undefined,
          },
          "Stripe request failed",
        ])
        const encodedLogMessages = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.Unknown)
        )(logMessages)
        expect(encodedLogMessages).not.toContain("signature-secret")
        expect(encodedLogMessages).not.toContain("private@example.com")
      } finally {
        stripeMockState.webhookFailure = null
      }
    })
  )

  it.effect.each([
    ["amount", { unit_amount: 1 }],
    ["tax behavior", { tax_behavior: "exclusive" as const }],
  ] as const)("rejects a complete Stripe catalog with the wrong %s", ([, override]) =>
    Effect.gen(function* () {
      const prices = completeStripeCatalog()
      const firstPrice = prices[0]

      expect(firstPrice).toBeDefined()
      if (firstPrice === undefined) return

      stripeMockState.prices = [{ ...firstPrice, ...override }, ...prices.slice(1)]
      try {
        const service = yield* Effect.promise(() => loadServiceWithStripe(billingRepositoryStub))
        const result = yield* Effect.result(service.catalog)

        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            message: "Stripe catalog prices do not match the TaxMaxi catalog definition",
          },
        })
      } finally {
        stripeMockState.prices = []
      }
    })
  )

  it.effect("logs catalog validation failures after Stripe returns prices", () =>
    Effect.gen(function* () {
      const logMessages: Array<unknown> = []
      const logger = Logger.make<unknown, void>(({ message }) => {
        logMessages.push(message)
      })
      const prices = completeStripeCatalog()
      const firstPrice = prices[0]
      expect(firstPrice).toBeDefined()
      if (firstPrice === undefined) return
      stripeMockState.prices = [{ ...firstPrice, unit_amount: 1 }, ...prices.slice(1)]

      const service = yield* Effect.promise(() => loadServiceWithStripe(billingRepositoryStub))
      const result = yield* Effect.result(service.catalog).pipe(Effect.withLogger(logger))

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { message: "Stripe catalog prices do not match the TaxMaxi catalog definition" },
      })
      expect(logMessages).toContainEqual([
        {
          provider: "stripe",
          operation: "Load billing catalog",
          validationReason: "unit_amount_mismatch",
          lookupKey: firstPrice.lookup_key,
          priceId: firstPrice.id,
          receivedPriceCount: TAXMAXI_STRIPE_CATALOG.length,
          expectedPriceCount: TAXMAXI_STRIPE_CATALOG.length,
        },
        "Stripe catalog validation failed",
      ])
    })
  )

  it.effect("turns malformed Stripe catalog responses into a logged billing failure", () =>
    Effect.gen(function* () {
      const logMessages: Array<unknown> = []
      const logger = Logger.make<unknown, void>(({ message }) => {
        logMessages.push(message)
      })
      const prices = completeStripeCatalog()
      const firstPrice = prices[0]
      expect(firstPrice).toBeDefined()
      if (firstPrice === undefined) return
      stripeMockState.prices = [
        {
          ...firstPrice,
          product: { ...firstPrice.product, metadata: null },
        },
        ...prices.slice(1),
      ]

      try {
        const service = yield* Effect.promise(() => loadServiceWithStripe(billingRepositoryStub))
        const result = yield* Effect.result(service.catalog).pipe(Effect.withLogger(logger))

        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { message: "Stripe returned an invalid catalog price response" },
        })
        expect(logMessages).toContainEqual([
          {
            provider: "stripe",
            operation: "Load billing catalog",
            validationReason: "response_shape_invalid",
            lookupKey: undefined,
            priceId: undefined,
            receivedPriceCount: undefined,
            expectedPriceCount: undefined,
          },
          "Stripe catalog validation failed",
        ])
      } finally {
        stripeMockState.prices = []
      }
    })
  )

  it.effect("rejects a catalog price whose cadence contradicts its lookup key", () =>
    Effect.gen(function* () {
      const annualPrice = catalogPriceByLookupKey("taxmaxi_professional_annual_100k_eur")
      const recurring = annualPrice.recurring
      if (recurring === null) throw new Error("Professional annual price must be recurring")
      stripeMockState.prices = [
        {
          ...annualPrice,
          id: "price_professional_monthly",
          recurring: { ...recurring, interval: "month" },
        },
      ]
      const service = yield* Effect.promise(() => loadServiceWithStripe(billingRepositoryStub))

      const result = yield* Effect.result(service.catalog)

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { message: "Stripe catalog price cadence does not match its lookup key" },
      })
    })
  )

  it.effect("rejects partial and non-EUR Stripe catalogs", () =>
    Effect.gen(function* () {
      const annualPrice = catalogPriceByLookupKey("taxmaxi_annual_10k_eur", "prod_annual")
      stripeMockState.prices = [annualPrice]
      const service = yield* Effect.promise(() => loadServiceWithStripe(billingRepositoryStub))

      const partial = yield* Effect.result(service.catalog)
      stripeMockState.prices = [{ ...annualPrice, currency: "usd" }]
      const nonEur = yield* Effect.result(service.catalog)

      expect(partial).toMatchObject({
        _tag: "Failure",
        failure: { message: "Stripe catalog must include every supported lookup key exactly once" },
      })
      expect(nonEur).toMatchObject({
        _tag: "Failure",
        failure: { message: "Stripe catalog prices must use EUR" },
      })
    })
  )

  it.effect("validates the nested shapes used by accepted Stripe webhook events", () =>
    Effect.gen(function* () {
      const valid = yield* Effect.result(
        validateStripeWebhookEvent({
          id: "evt_valid",
          created: 1_700_000_000,
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_valid",
              customer: "cus_valid",
              payment_intent: "pi_valid",
              payment_status: "paid",
              metadata: { purchase_kind: "top_up", taxmaxi_user_id: TEST_USER_ID },
            },
          },
        })
      )
      const invalid = yield* Effect.result(
        validateStripeWebhookEvent({
          id: "evt_invalid",
          created: 1_700_000_000,
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_invalid",
              customer: "cus_invalid",
              payment_intent: "pi_invalid",
              metadata: { purchase_kind: "top_up" },
            },
          },
        })
      )
      const unrelatedInvoice = yield* Effect.result(
        validateStripeWebhookEvent({
          id: "evt_unrelated_invoice",
          created: 1_700_000_000,
          type: "invoice.paid",
          data: {
            object: {
              id: "in_unrelated",
              amount_due: 0,
              billing_reason: "subscription_cycle",
              customer: "cus_unrelated",
              parent: {
                subscription_details: {
                  subscription: "sub_unrelated",
                  metadata: null,
                },
              },
              lines: { data: [], has_more: false },
            },
          },
        })
      )
      const invalidDeletedSubscription = yield* Effect.result(
        validateStripeWebhookEvent({
          id: "evt_invalid_deleted_subscription",
          created: 1_700_000_000,
          type: "customer.subscription.deleted",
          data: {
            object: {
              id: "sub_invalid_deleted",
              customer: "cus_invalid_deleted",
            },
          },
        })
      )

      expect(valid).toMatchObject({ _tag: "Success" })
      expect(unrelatedInvoice).toMatchObject({ _tag: "Success" })
      expect(invalid).toMatchObject({
        _tag: "Failure",
        failure: { message: "Invalid Stripe webhook event payload" },
      })
      expect(invalidDeletedSubscription).toMatchObject({
        _tag: "Failure",
        failure: { message: "Invalid Stripe webhook event payload" },
      })
    })
  )

  it("grants annual credits only for create or renewal invoices on the annual product", () => {
    expect(isValidAnnualPrice({ recurring: { interval: "year", interval_count: 1 } })).toBe(true)
    expect(isValidAnnualPrice({ recurring: { interval: "year", interval_count: 2 } })).toBe(false)
    expect(isValidAnnualPrice({ recurring: { interval: "month", interval_count: 1 } })).toBe(false)
    expect(
      isAnnualInvoiceEligible({
        billingReason: "subscription_cycle",
        planLookupKey: "taxmaxi_annual_10k_eur",
      })
    ).toBe(true)
    expect(
      isAnnualInvoiceEligible({
        billingReason: "subscription_cycle",
        planLookupKey: undefined,
      })
    ).toBe(true)
    expect(
      annualInvoiceProductIds({
        planLookupKey: undefined,
        planProductId: undefined,
        currentProductId: "prod_annual",
      })
    ).toEqual(["prod_annual"])
    expect(
      annualInvoiceProductIds({
        planLookupKey: "taxmaxi_professional_annual",
        planProductId: "prod_professional",
        currentProductId: "prod_annual",
      })
    ).toBeNull()
    expect(
      annualInvoiceProductIds({
        planLookupKey: "taxmaxi_annual_10k_eur",
        planProductId: "prod_original_annual",
        currentProductId: "prod_replacement_annual",
      })
    ).toEqual(["prod_original_annual", "prod_replacement_annual"])
    expect(
      isAnnualInvoiceEligible({
        billingReason: "subscription_update",
        planLookupKey: "taxmaxi_annual_10k_eur",
      })
    ).toBe(false)
    expect(
      isAnnualInvoiceLineEligible({
        proration: false,
        periodStart: 1_700_000_000,
        periodEnd: 1_731_536_000,
        interval: "year",
        intervalCount: 1,
        productId: "prod_annual",
        allowedProductIds: ["prod_annual"],
      })
    ).toBe(true)
    expect(
      isAnnualInvoiceLineEligible({
        proration: true,
        periodStart: 1_700_000_000,
        periodEnd: 1_731_536_000,
        interval: "year",
        intervalCount: 1,
        productId: "prod_annual",
        allowedProductIds: ["prod_annual"],
      })
    ).toBe(false)
    expect(
      isAnnualInvoiceLineEligible({
        proration: false,
        periodStart: 1_700_000_000,
        periodEnd: 1_731_536_000,
        interval: "year",
        intervalCount: 1,
        productId: "prod_other",
        allowedProductIds: ["prod_annual"],
      })
    ).toBe(false)

    expect(
      findEligibleAnnualInvoiceLine([
        {
          line: "add-on",
          proration: false,
          periodStart: 1_700_000_000,
          periodEnd: 1_702_678_400,
          interval: "month",
          intervalCount: 1,
          productId: "prod_add_on",
          allowedProductIds: ["prod_annual"],
        },
        {
          line: "annual",
          proration: false,
          periodStart: 1_700_000_000,
          periodEnd: 1_731_536_000,
          interval: "year",
          intervalCount: 1,
          productId: "prod_annual",
          allowedProductIds: ["prod_annual"],
        },
      ])
    ).toBe("annual")
    expect(
      findEligibleAnnualInvoiceLine([
        {
          line: "first-yearly-line",
          proration: false,
          periodStart: 1_700_000_000,
          periodEnd: 1_731_536_000,
          interval: "year",
          intervalCount: 1,
          productId: "prod_first",
          allowedProductIds: undefined,
        },
        {
          line: "second-yearly-line",
          proration: false,
          periodStart: 1_700_000_000,
          periodEnd: 1_731_536_000,
          interval: "year",
          intervalCount: 1,
          productId: "prod_second",
          allowedProductIds: undefined,
        },
      ])
    ).toBeUndefined()
    expect(
      isAnnualInvoiceLineEligible({
        proration: false,
        periodStart: 1_700_000_000,
        periodEnd: 1_702_678_400,
        interval: "month",
        intervalCount: 1,
        productId: "prod_annual",
        allowedProductIds: ["prod_annual"],
      })
    ).toBe(false)
    expect(
      isAnnualInvoiceLineEligible({
        proration: false,
        periodStart: 1_700_000_000,
        periodEnd: 1_763_072_000,
        interval: "year",
        intervalCount: 2,
        productId: "prod_annual",
        allowedProductIds: ["prod_annual"],
      })
    ).toBe(false)
  })

  it("splits annual credits across every paid PaymentIntent contribution", () => {
    expect(
      allocateAnnualCreditsAcrossPayments([
        { paymentReference: "pi_first", amountPaid: 4_000 },
        { paymentReference: "pi_second", amountPaid: 6_000 },
      ])
    ).toEqual([
      { paymentReference: "pi_first", paymentAmount: 4_000, credits: 4_000 },
      { paymentReference: "pi_second", paymentAmount: 6_000, credits: 6_000 },
    ])
    expect(
      allocateAnnualCreditsAcrossPayments([
        { paymentReference: "pi_first", amountPaid: 1 },
        { paymentReference: "pi_second", amountPaid: 2 },
      ]).reduce((total, payment) => total + payment.credits, 0)
    ).toBe(10_000)
    expect(
      allocateAnnualCreditsAcrossPayments([
        { paymentReference: "pi_one_cent", amountPaid: 1 },
        { paymentReference: "pi_remainder", amountPaid: 15_899 },
      ])
    ).toEqual([
      { paymentReference: "pi_one_cent", paymentAmount: 1, credits: 1 },
      { paymentReference: "pi_remainder", paymentAmount: 15_899, credits: 9_999 },
    ])
    const multipleSmallPayments = allocateAnnualCreditsAcrossPayments([
      { paymentReference: "pi_small_first", amountPaid: 1 },
      { paymentReference: "pi_small_second", amountPaid: 1 },
      { paymentReference: "pi_large", amountPaid: 15_898 },
    ])
    expect(multipleSmallPayments.map(({ credits }) => credits)).toEqual([1, 1, 9_998])
    expect(multipleSmallPayments.reduce((total, payment) => total + payment.credits, 0)).toBe(
      10_000
    )
  })

  it("allocates credit-note reversals deterministically across invoice payments", () => {
    const payments = [
      { paymentReference: "pi_second", paymentAmount: 6_000 },
      { paymentReference: "pi_first", paymentAmount: 4_000 },
    ]

    expect(allocateCreditNoteReversalAcrossPayments({ reversedAmount: 7_000, payments })).toEqual([
      { paymentReference: "pi_first", paymentAmount: 4_000, reversedAmount: 4_000 },
      { paymentReference: "pi_second", paymentAmount: 6_000, reversedAmount: 3_000 },
    ])
    expect(
      allocateCreditNoteReversalAcrossPayments({ reversedAmount: 10_001, payments })
    ).toBeNull()
  })

  it.effect("persists one stable allowance for a zero-due annual invoice across retries", () =>
    Effect.gen(function* () {
      const input = {
        invoiceId: "in_zero_due",
        amountDue: 0,
        paymentAllocations: [],
      } as const

      const allocations = annualInvoiceCreditAllocations(input)
      expect(allocations).toEqual([
        {
          paymentReference: null,
          paymentAmount: null,
          stripeInvoiceId: "in_zero_due",
          referenceSuffix: "invoice:in_zero_due",
          credits: 10_000,
        },
      ])
      const grants: Array<Parameters<BillingRepositoryService["grantCredits"]>[0]> = []
      const reconciled: Array<string> = []
      const persist = () =>
        persistAnnualCreditAllocations({
          userId: TEST_USER_ID,
          subscriptionId: "sub_zero_due",
          periodStart: 1_700_000_000,
          periodEnd: 1_731_536_000,
          allocations,
          grantCredits: (grant) =>
            Effect.sync(() => {
              grants.push(grant)
              return true
            }),
          reconcilePaymentCreditReversals: (paymentReference) =>
            Effect.sync(() => {
              reconciled.push(paymentReference)
              return true
            }),
        })
      yield* persist()
      yield* persist()

      expect(grants).toHaveLength(2)
      expect(grants[1]).toEqual(grants[0])
      expect(grants[0]).toMatchObject({
        amount: 10_000,
        kind: "annual_grant",
        paymentReference: null,
        reference: "stripe:annual:sub_zero_due:1700000000:1731536000:invoice:in_zero_due",
      })
      expect(reconciled).toEqual([])
      expect(
        annualInvoiceCreditAllocations({
          invoiceId: "in_missing_payment",
          amountDue: 1,
          paymentAllocations: [],
        })
      ).toEqual([])
    })
  )

  it("keeps every supported paid invoice contribution separate", () => {
    expect(
      [
        { payment: { type: "payment_intent" as const, payment_intent: "pi_test" } },
        { payment: { type: "charge" as const, charge: "ch_test" } },
        { payment: { type: "payment_record" as const, payment_record: "pyr_test" } },
      ].map(invoicePaymentReference)
    ).toEqual(["pi_test", "ch_test", "pyr_test"])

    expect(
      invoicePaymentReference({
        payment: {
          type: "charge",
          charge: { id: "ch_with_intent", payment_intent: "pi_canonical" },
        },
      })
    ).toBe("pi_canonical")
    expect(chargePaymentReference({ id: "ch_without_intent", payment_intent: null })).toBe(
      "ch_without_intent"
    )
  })

  it.effect("uses one canonical PaymentIntent reference from annual grant through reversal", () =>
    Effect.gen(function* () {
      const allocations = annualPaymentAllocationsFromInvoicePayments([
        {
          amount_paid: 10_000,
          payment: {
            type: "charge",
            charge: { id: "ch_annual", payment_intent: "pi_annual" },
          },
        },
      ])
      const grants: Array<Parameters<BillingRepositoryService["grantCredits"]>[0]> = []
      const reconciled: Array<string> = []
      yield* persistAnnualCreditAllocations({
        userId: TEST_USER_ID,
        subscriptionId: "sub_annual",
        periodStart: 1_700_000_000,
        periodEnd: 1_731_536_000,
        allocations: annualInvoiceCreditAllocations({
          invoiceId: "in_annual",
          amountDue: 10_000,
          paymentAllocations: allocations,
        }),
        grantCredits: (grant) =>
          Effect.sync(() => {
            grants.push(grant)
            return true
          }),
        reconcilePaymentCreditReversals: (paymentReference) =>
          Effect.sync(() => {
            reconciled.push(paymentReference)
            return true
          }),
      })

      expect(grants[0]?.paymentReference).toBe("pi_annual")
      expect(reconciled).toEqual(["pi_annual"])
      expect(chargePaymentReference({ id: "ch_annual", payment_intent: "pi_annual" })).toBe(
        grants[0]?.paymentReference
      )
    })
  )

  it("maps only payment-loss dispute states to a credit reversal", () => {
    expect(disputeCreditReversal({ status: "warning_closed", amount: 15_900 })).toEqual({
      reversedAmount: 0,
      terminal: true,
    })
    expect(disputeCreditReversal({ status: "won", amount: 15_900 })).toEqual({
      reversedAmount: 0,
      terminal: true,
    })
    expect(disputeCreditReversal({ status: "prevented", amount: 15_900 })).toEqual({
      reversedAmount: 0,
      terminal: true,
    })
    expect(disputeCreditReversal({ status: "lost", amount: 15_900 })).toEqual({
      reversedAmount: 15_900,
      terminal: true,
    })
    expect(disputeCreditReversal({ status: "needs_response", amount: 15_900 })).toEqual({
      reversedAmount: 15_900,
      terminal: false,
    })
  })

  it("requires top-up prices to be one-time", () => {
    expect(isValidTopUpPrice({ recurring: null })).toBe(true)
    expect(isValidTopUpPrice({ recurring: { interval: "month" } })).toBe(false)
    expect(isValidTopUpPrice({ recurring: { interval: "year" } })).toBe(false)
  })

  it("accepts delayed top-ups from payment facts without consulting current subscription state", () => {
    expect(isPaidTopUpSessionEligible({ purchaseKind: "top_up", paymentStatus: "paid" })).toBe(true)
    expect(isPaidTopUpSessionEligible({ purchaseKind: "top_up", paymentStatus: "unpaid" })).toBe(
      false
    )
    expect(isPaidTopUpSessionEligible({ purchaseKind: "annual", paymentStatus: "paid" })).toBe(
      false
    )
  })

  it.effect(
    "uses signed user metadata for paid fulfillment after the customer mapping changes",
    () =>
      Effect.gen(function* () {
        const resolved = yield* resolvePaidFulfillmentUserId({
          metadataUserId: TEST_USER_ID,
          stripeCustomerId: "cus_deleted",
          findByUserId: (userId) =>
            Effect.succeed(
              Option.some(billingAccount({ userId, stripeCustomerId: "cus_replacement" }))
            ),
          findByStripeCustomerId: () =>
            Effect.succeed(
              Option.some(
                billingAccount({ userId: OTHER_USER_ID, stripeCustomerId: "cus_deleted" })
              )
            ),
        })
        const invalid = yield* Effect.result(
          resolvePaidFulfillmentUserId({
            metadataUserId: OTHER_USER_ID,
            stripeCustomerId: "cus_deleted",
            findByUserId: () => Effect.succeed(Option.none()),
            findByStripeCustomerId: () =>
              Effect.succeed(Option.some(billingAccount({ stripeCustomerId: "cus_deleted" }))),
          })
        )

        expect(resolved).toBe(TEST_USER_ID)
        expect(invalid).toMatchObject({
          _tag: "Failure",
          failure: { message: "TaxMaxi billing account not found" },
        })
      })
  )

  it.effect(
    "uses the replacement customer for top-up Checkout after deleted-customer recovery",
    () =>
      Effect.gen(function* () {
        const requestedCustomers: Array<string> = []
        const customer = yield* verifiedTopUpCustomer({
          account: Option.some(billingAccount({ stripeCustomerId: "cus_deleted" })),
          userId: TEST_USER_ID,
          getOrCreateCustomer: () => Effect.succeed("cus_replacement"),
          findByUserId: () =>
            Effect.succeed(Option.some(billingAccount({ stripeCustomerId: "cus_replacement" }))),
          hasCurrentAnnualSubscription: () => Effect.succeed(true),
        })
        requestedCustomers.push(customer)

        expect(requestedCustomers).toEqual(["cus_replacement"])
        expect(requestedCustomers).not.toContain("cus_deleted")
      })
  )

  it.effect("rejects top-up Checkout when Stripe no longer has an active annual subscription", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        verifiedTopUpCustomer({
          account: Option.some(billingAccount({ stripeCustomerId: "cus_test" })),
          userId: TEST_USER_ID,
          getOrCreateCustomer: () => Effect.succeed("cus_test"),
          findByUserId: () =>
            Effect.succeed(Option.some(billingAccount({ stripeCustomerId: "cus_test" }))),
          hasCurrentAnnualSubscription: () => Effect.succeed(false),
        })
      )

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { message: "An active annual subscription is required" },
      })
    })
  )

  it.effect(
    "allows top-up Checkout when Stripe is active while local subscription state is stale",
    () =>
      Effect.gen(function* () {
        const customer = yield* verifiedTopUpCustomer({
          account: Option.some(
            billingAccount({ stripeCustomerId: "cus_test", subscriptionStatus: "canceled" })
          ),
          userId: TEST_USER_ID,
          getOrCreateCustomer: () => Effect.succeed("cus_test"),
          findByUserId: () =>
            Effect.succeed(
              Option.some(
                billingAccount({ stripeCustomerId: "cus_test", subscriptionStatus: "canceled" })
              )
            ),
          hasCurrentAnnualSubscription: () => Effect.succeed(true),
        })

        expect(customer).toBe("cus_test")
      })
  )

  it.effect("syncs a legacy yearly subscription through the webhook service path", () =>
    Effect.gen(function* () {
      const annualPrice = {
        ...catalogPriceByLookupKey("taxmaxi_annual_10k_eur", "prod_annual"),
        id: "price_annual",
      }
      stripeMockState.prices = [annualPrice]
      stripeMockState.subscription = {
        id: "sub_legacy_same_product",
        customer: "cus_test",
        status: "active",
        cancel_at_period_end: false,
        metadata: {},
        items: {
          data: [
            {
              current_period_end: 1_731_536_000,
              price: { ...annualPrice, lookup_key: null },
            },
          ],
        },
      }
      stripeMockState.event = {
        id: "evt_subscription_updated",
        created: 1_700_000_000,
        type: "customer.subscription.updated",
        data: { object: { id: "sub_legacy_same_product", customer: "cus_test" } },
      }
      const saved: Array<Parameters<BillingRepositoryService["saveSubscription"]>[0]> = []
      const service = yield* Effect.promise(() =>
        loadServiceWithStripe({
          ...billingRepositoryStub,
          findByStripeCustomerId: () =>
            Effect.succeed(
              Option.some({
                ...billingAccount({ stripeCustomerId: "cus_test" }),
                stripeSubscriptionId: null,
                subscriptionStatus: null,
              })
            ),
          saveSubscription: (input) =>
            Effect.sync(() => {
              saved.push(input)
              return true
            }),
        })
      )

      yield* service.processWebhook({ payload: "{}", signature: "sig_test" })

      expect(saved).toHaveLength(2)
      expect(saved[0]).toMatchObject({
        stripeCustomerId: "cus_test",
        stripeSubscriptionId: "sub_legacy_same_product",
        status: "active",
      })
    })
  )

  it.effect("syncs a tagged archived subscription without an active annual catalog price", () =>
    Effect.gen(function* () {
      const archivedAnnualPrice = {
        id: "price_archived_annual",
        lookup_key: null,
        product: "prod_archived_annual",
        recurring: { interval: "year", interval_count: 1 },
      }
      stripeMockState.prices = []
      stripeMockState.subscription = {
        id: "sub_archived_annual",
        customer: "cus_test",
        status: "past_due",
        cancel_at_period_end: false,
        metadata: {
          plan_lookup_key: "taxmaxi_annual_10k_eur",
          plan_product_id: "prod_archived_annual",
        },
        items: {
          data: [{ current_period_end: 1_731_536_000, price: archivedAnnualPrice }],
        },
      }
      stripeMockState.event = {
        id: "evt_archived_subscription_updated",
        created: 1_700_000_000,
        type: "customer.subscription.updated",
        data: { object: { id: "sub_archived_annual", customer: "cus_test" } },
      }
      const saved: Array<Parameters<BillingRepositoryService["saveSubscription"]>[0]> = []
      const service = yield* Effect.promise(() =>
        loadServiceWithStripe({
          ...billingRepositoryStub,
          findByStripeCustomerId: () =>
            Effect.succeed(Option.some(billingAccount({ stripeCustomerId: "cus_test" }))),
          saveSubscription: (input) =>
            Effect.sync(() => {
              saved.push(input)
              return true
            }),
        })
      )

      yield* service.processWebhook({ payload: "{}", signature: "sig_test" })

      expect(saved).toHaveLength(2)
      expect(saved[0]).toMatchObject({
        stripeSubscriptionId: "sub_archived_annual",
        status: "past_due",
      })
    })
  )

  it.effect("invalidates the producing Checkout when deletion arrives before local tracking", () =>
    Effect.gen(function* () {
      const deletedSubscription = {
        id: "sub_deleted_before_tracking",
        customer: "cus_test",
        status: "canceled",
        cancel_at_period_end: false,
        metadata: {
          plan_lookup_key: "taxmaxi_annual_10k_eur",
          plan_product_id: "prod_annual",
          annual_checkout_generation: "7",
        },
        items: {
          data: [
            {
              current_period_end: 1_731_536_000,
              price: {
                lookup_key: null,
                product: "prod_annual",
                recurring: { interval: "year", interval_count: 1 },
              },
            },
          ],
        },
      }
      stripeMockState.prices = []
      stripeMockState.subscription = deletedSubscription
      stripeMockState.listedSubscriptions = []
      stripeMockState.event = {
        id: "evt_deleted_before_tracking",
        created: 1_700_000_000,
        type: "customer.subscription.deleted",
        data: { object: deletedSubscription },
      }
      const saved: Array<Parameters<BillingRepositoryService["saveSubscription"]>[0]> = []
      const service = yield* Effect.promise(() =>
        loadServiceWithStripe({
          ...billingRepositoryStub,
          findByStripeCustomerId: () =>
            Effect.succeed(
              Option.some({
                ...billingAccount({ stripeCustomerId: "cus_test" }),
                stripeSubscriptionId: null,
                subscriptionStatus: null,
              })
            ),
          saveSubscription: (input) =>
            Effect.sync(() => {
              saved.push(input)
              return true
            }),
        })
      )

      yield* service.processWebhook({ payload: "{}", signature: "sig_test" })
      stripeMockState.listedSubscriptions = null

      expect(saved).toContainEqual(
        expect.objectContaining({
          stripeSubscriptionId: deletedSubscription.id,
          status: "canceled",
          annualCheckoutGeneration: 7,
        })
      )
    })
  )

  it.effect(
    "restores an active replacement after a late terminal event for an old subscription",
    () =>
      Effect.gen(function* () {
        const oldSubscription = {
          id: "sub_old_terminal",
          customer: "cus_test",
          status: "canceled",
          cancel_at_period_end: false,
          metadata: {
            plan_lookup_key: "taxmaxi_annual_10k_eur",
            plan_product_id: "prod_old",
            annual_checkout_generation: "4",
          },
          items: {
            data: [
              {
                current_period_end: 1_700_000_000,
                price: {
                  lookup_key: null,
                  product: "prod_old",
                  recurring: { interval: "year", interval_count: 1 },
                },
              },
            ],
          },
        }
        const replacementSubscription = {
          id: "sub_active_replacement",
          customer: "cus_test",
          status: "active",
          cancel_at_period_end: false,
          metadata: {
            plan_lookup_key: "taxmaxi_annual_10k_eur",
            plan_product_id: "prod_replacement",
            annual_checkout_generation: "5",
          },
          items: {
            data: [
              {
                current_period_end: 1_731_536_000,
                price: {
                  lookup_key: null,
                  product: "prod_replacement",
                  recurring: { interval: "year", interval_count: 1 },
                },
              },
            ],
          },
        }
        stripeMockState.subscription = oldSubscription
        stripeMockState.listedSubscriptions = [replacementSubscription]
        stripeMockState.event = {
          id: "evt_old_subscription_terminal",
          created: 1_700_000_000,
          type: "customer.subscription.updated",
          data: { object: { id: oldSubscription.id, customer: "cus_test" } },
        }
        const saved: Array<Parameters<BillingRepositoryService["saveSubscription"]>[0]> = []
        const service = yield* Effect.promise(() =>
          loadServiceWithStripe({
            ...billingRepositoryStub,
            findByStripeCustomerId: () =>
              Effect.succeed(
                Option.some({
                  ...billingAccount({ stripeCustomerId: "cus_test" }),
                  stripeSubscriptionId: replacementSubscription.id,
                })
              ),
            saveSubscription: (input) =>
              Effect.sync(() => {
                saved.push(input)
                return true
              }),
          })
        )

        yield* service.processWebhook({ payload: "{}", signature: "sig_test" })
        stripeMockState.listedSubscriptions = null

        expect(saved[0]).toMatchObject({
          stripeSubscriptionId: oldSubscription.id,
          status: "canceled",
          annualCheckoutGeneration: 4,
        })
        expect(saved.at(-1)).toMatchObject({
          stripeSubscriptionId: replacementSubscription.id,
          status: "active",
          annualCheckoutGeneration: 5,
        })
      })
  )

  it.effect("clears a deleted tagged subscription without an active annual catalog price", () =>
    Effect.gen(function* () {
      stripeMockState.prices = []
      stripeMockState.subscription = {
        id: "sub_archived_deleted",
        customer: "cus_test",
        status: "canceled",
        cancel_at_period_end: false,
        metadata: {
          plan_lookup_key: "taxmaxi_annual_10k_eur",
          plan_product_id: "prod_archived_annual",
        },
        items: {
          data: [
            {
              current_period_end: 1_731_536_000,
              price: {
                lookup_key: null,
                product: "prod_archived_annual",
                recurring: { interval: "year", interval_count: 1 },
              },
            },
          ],
        },
      }
      stripeMockState.event = {
        id: "evt_archived_subscription_deleted",
        created: 1_700_000_000,
        type: "customer.subscription.deleted",
        data: { object: stripeMockState.subscription },
      }
      const cleared: Array<Parameters<BillingRepositoryService["clearSubscription"]>[0]> = []
      const service = yield* Effect.promise(() =>
        loadServiceWithStripe({
          ...billingRepositoryStub,
          findByStripeCustomerId: () =>
            Effect.succeed(
              Option.some({
                ...billingAccount({ stripeCustomerId: "cus_test" }),
                stripeSubscriptionId: "sub_archived_deleted",
              })
            ),
          clearSubscription: (input) =>
            Effect.sync(() => {
              cleared.push(input)
              return true
            }),
        })
      )

      yield* service.processWebhook({ payload: "{}", signature: "sig_test" })

      expect(cleared).toEqual([
        {
          stripeCustomerId: "cus_test",
          stripeSubscriptionId: "sub_archived_deleted",
          eventCreatedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2023-11-14T22:13:20.000Z")),
          syncGeneration: 1,
        },
      ])
    })
  )

  it.effect("allows an active tagged archived subscription to buy a top-up", () =>
    Effect.gen(function* () {
      stripeMockState.checkoutParams = []
      stripeMockState.prices = [
        {
          ...catalogPriceByLookupKey("taxmaxi_topup_1k_eur"),
          id: "price_top_up",
        },
      ]
      stripeMockState.subscription = {
        id: "sub_archived_annual",
        customer: "cus_test",
        status: "active",
        metadata: {
          plan_lookup_key: "taxmaxi_annual_10k_eur",
          plan_product_id: "prod_archived_annual",
        },
        items: {
          data: [
            {
              price: {
                lookup_key: null,
                product: "prod_archived_annual",
                recurring: { interval: "year", interval_count: 1 },
              },
            },
          ],
        },
      }
      const service = yield* Effect.promise(() =>
        loadServiceWithStripe({
          ...billingRepositoryStub,
          findByUserId: () =>
            Effect.succeed(Option.some(billingAccount({ stripeCustomerId: "cus_test" }))),
        })
      )

      const checkoutUrl = yield* service.createTopUpCheckout(TEST_USER_ID)

      expect(checkoutUrl).toBe("https://checkout.stripe.test/session")
      expect(stripeMockState.checkoutParams[0]).toMatchObject({
        mode: "payment",
        customer: "cus_test",
        line_items: [{ price: "price_top_up", quantity: 1 }],
      })
    })
  )

  it.effect("clears a definitive failed annual Checkout reservation before retrying", () =>
    Effect.gen(function* () {
      const logMessages: Array<unknown> = []
      const logger = Logger.make<unknown, void>(({ message }) => {
        logMessages.push(message)
      })
      const currentPrice = {
        ...catalogPriceByLookupKey("taxmaxi_annual_10k_eur"),
        id: "price_current_annual",
      }
      const archivedPrice = {
        ...currentPrice,
        id: "price_archived_annual_checkout",
        lookup_key: null,
      }
      stripeMockState.checkoutFailure = "invalid_request"
      stripeMockState.checkoutParams = []
      stripeMockState.prices = [currentPrice]
      stripeMockState.retrievedPrices = { [archivedPrice.id]: archivedPrice }
      stripeMockState.listedSubscriptions = []
      let reservationGeneration = 1
      const cleared: Array<number> = []
      const service = yield* Effect.promise(() =>
        loadServiceWithStripe({
          ...billingRepositoryStub,
          findByUserId: () =>
            Effect.succeed(Option.some(billingAccount({ stripeCustomerId: "cus_test" }))),
          reserveAnnualCheckout: ({ priceId }) =>
            Effect.succeed({
              generation: reservationGeneration,
              expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-14T20:00:00.000Z")),
              priceId: reservationGeneration === 1 ? archivedPrice.id : priceId,
            }),
          clearAnnualCheckoutReservation: ({ generation }) =>
            Effect.sync(() => {
              cleared.push(generation)
              if (generation !== reservationGeneration) return false
              reservationGeneration += 1
              return true
            }),
        })
      )

      const first = yield* Effect.result(service.createAnnualCheckout(TEST_USER_ID)).pipe(
        Effect.withLogger(logger)
      )
      stripeMockState.checkoutFailure = null
      const retryUrl = yield* service.createAnnualCheckout(TEST_USER_ID)
      stripeMockState.listedSubscriptions = null

      expect(first).toMatchObject({
        _tag: "Failure",
        failure: { message: "Could not create annual Checkout: Price is inactive" },
      })
      expect(logMessages).toContainEqual([
        expect.objectContaining({
          provider: "stripe",
          operation: "Could not create annual Checkout",
          stripeErrorMessage: "Price is inactive",
        }),
        "Stripe request failed",
      ])
      expect(cleared).toEqual([1])
      expect(retryUrl).toBe("https://checkout.stripe.test/session")
      expect(stripeMockState.checkoutParams).toHaveLength(2)
      expect(stripeMockState.checkoutParams[1]).toMatchObject({
        line_items: [{ price: currentPrice.id, quantity: 1 }],
        metadata: { annual_checkout_generation: "2" },
      })
    })
  )

  it.effect("keeps an annual Checkout reservation after an ambiguous connection failure", () =>
    Effect.gen(function* () {
      stripeMockState.checkoutFailure = "connection"
      stripeMockState.checkoutParams = []
      stripeMockState.prices = [
        {
          ...catalogPriceByLookupKey("taxmaxi_annual_10k_eur"),
          id: "price_annual_connection",
        },
      ]
      stripeMockState.listedSubscriptions = []
      const cleared: Array<number> = []
      const service = yield* Effect.promise(() =>
        loadServiceWithStripe({
          ...billingRepositoryStub,
          findByUserId: () =>
            Effect.succeed(Option.some(billingAccount({ stripeCustomerId: "cus_test" }))),
          reserveAnnualCheckout: ({ priceId }) =>
            Effect.succeed({
              generation: 1,
              expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-14T20:00:00.000Z")),
              priceId,
            }),
          clearAnnualCheckoutReservation: ({ generation }) =>
            Effect.sync(() => {
              cleared.push(generation)
              return true
            }),
        })
      )

      const result = yield* Effect.result(service.createAnnualCheckout(TEST_USER_ID))
      stripeMockState.checkoutFailure = null
      stripeMockState.listedSubscriptions = null

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { message: "Could not create annual Checkout: Connection timed out" },
      })
      expect(cleared).toEqual([])
    })
  )

  it.effect("rejects unsupported direct Checkout prices before creating a session", () =>
    Effect.gen(function* () {
      const annualCatalogItem = TAXMAXI_STRIPE_CATALOG.find(
        ({ lookupKey }) => lookupKey === "taxmaxi_annual_10k_eur"
      )
      const topUpCatalogItem = TAXMAXI_STRIPE_CATALOG.find(
        ({ lookupKey }) => lookupKey === "taxmaxi_topup_1k_eur"
      )
      if (annualCatalogItem === undefined || topUpCatalogItem === undefined) {
        throw new Error("TaxMaxi Stripe Checkout catalog entries are missing")
      }

      stripeMockState.checkoutParams = []
      stripeMockState.prices = [
        {
          ...catalogPrice(topUpCatalogItem),
          id: "price_top_up_tiered",
          unit_amount: null,
        },
      ]
      stripeMockState.subscription = {
        id: "sub_active_annual",
        customer: "cus_test",
        status: "active",
        metadata: { plan_lookup_key: "taxmaxi_annual_10k_eur" },
        items: {
          data: [
            {
              price: {
                lookup_key: "taxmaxi_annual_10k_eur",
                product: "prod_annual",
                recurring: { interval: "year", interval_count: 1 },
              },
            },
          ],
        },
      }
      const service = yield* Effect.promise(() =>
        loadServiceWithStripe({
          ...billingRepositoryStub,
          findByUserId: () =>
            Effect.succeed(Option.some(billingAccount({ stripeCustomerId: "cus_test" }))),
        })
      )

      const tieredTopUp = yield* Effect.result(service.createTopUpCheckout(TEST_USER_ID))

      stripeMockState.prices = [
        {
          ...catalogPrice(annualCatalogItem),
          id: "price_annual_usd",
          currency: "usd",
        },
      ]
      stripeMockState.listedSubscriptions = []
      const nonEurAnnual = yield* Effect.result(service.createAnnualCheckout(TEST_USER_ID))

      stripeMockState.prices = [{ ...catalogPrice(annualCatalogItem), unit_amount: 1 }]
      const wrongAmountAnnual = yield* Effect.result(service.createAnnualCheckout(TEST_USER_ID))

      stripeMockState.prices = [
        {
          ...catalogPrice(topUpCatalogItem),
          tax_behavior: "exclusive",
        },
      ]
      stripeMockState.listedSubscriptions = null
      const wrongTaxTopUp = yield* Effect.result(service.createTopUpCheckout(TEST_USER_ID))

      stripeMockState.prices = [
        {
          ...catalogPrice(annualCatalogItem),
          product: {
            ...catalogPrice(annualCatalogItem).product,
            tax_code: "txcd_wrong",
          },
        },
      ]
      stripeMockState.listedSubscriptions = []
      const wrongProductTaxCodeAnnual = yield* Effect.result(
        service.createAnnualCheckout(TEST_USER_ID)
      )
      stripeMockState.listedSubscriptions = null

      expect(tieredTopUp).toMatchObject({
        _tag: "Failure",
        failure: { message: "Stripe Checkout prices must have a fixed unit amount" },
      })
      expect(nonEurAnnual).toMatchObject({
        _tag: "Failure",
        failure: { message: "Stripe Checkout prices must use EUR" },
      })
      expect(wrongAmountAnnual).toMatchObject({
        _tag: "Failure",
        failure: { message: "Stripe Checkout price does not match the TaxMaxi catalog definition" },
      })
      expect(wrongTaxTopUp).toMatchObject({
        _tag: "Failure",
        failure: { message: "Stripe Checkout price does not match the TaxMaxi catalog definition" },
      })
      expect(wrongProductTaxCodeAnnual).toMatchObject({
        _tag: "Failure",
        failure: { message: "Stripe Checkout price does not match the TaxMaxi catalog definition" },
      })
      expect(stripeMockState.checkoutParams).toEqual([])
    })
  )

  it.effect("rejects a malformed direct Checkout price before creating a session", () =>
    Effect.gen(function* () {
      const annualPrice = catalogPriceByLookupKey("taxmaxi_annual_10k_eur")
      stripeMockState.checkoutParams = []
      stripeMockState.prices = [
        {
          ...annualPrice,
          product: { ...annualPrice.product, metadata: null },
        },
      ]
      stripeMockState.listedSubscriptions = []

      try {
        const service = yield* Effect.promise(() =>
          loadServiceWithStripe({
            ...billingRepositoryStub,
            findByUserId: () =>
              Effect.succeed(Option.some(billingAccount({ stripeCustomerId: "cus_test" }))),
          })
        )
        const result = yield* Effect.result(service.createAnnualCheckout(TEST_USER_ID))

        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { message: "Stripe returned an invalid catalog price response" },
        })
        expect(stripeMockState.checkoutParams).toEqual([])
      } finally {
        stripeMockState.prices = []
        stripeMockState.listedSubscriptions = null
      }
    })
  )

  it.effect("blocks duplicate annual Checkout for a partially tagged archived subscription", () =>
    Effect.gen(function* () {
      stripeMockState.checkoutParams = []
      stripeMockState.prices = [
        {
          ...catalogPriceByLookupKey("taxmaxi_annual_10k_eur", "prod_replacement_annual"),
          id: "price_replacement_annual",
        },
      ]
      stripeMockState.subscription = {
        id: "sub_partially_tagged_archived",
        customer: "cus_test",
        status: "active",
        metadata: { plan_lookup_key: "taxmaxi_annual_10k_eur" },
        items: {
          data: [
            {
              price: {
                lookup_key: null,
                product: "prod_archived_annual",
                recurring: { interval: "year", interval_count: 1 },
              },
            },
          ],
        },
      }
      const service = yield* Effect.promise(() =>
        loadServiceWithStripe({
          ...billingRepositoryStub,
          findByUserId: () =>
            Effect.succeed(Option.some(billingAccount({ stripeCustomerId: "cus_test" }))),
        })
      )

      const result = yield* Effect.result(service.createAnnualCheckout(TEST_USER_ID))

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { message: "This account already has a subscription" },
      })
      expect(stripeMockState.checkoutParams).toEqual([])
    })
  )

  it.effect("grants a paid renewal from tagged archived subscription facts", () =>
    Effect.gen(function* () {
      const archivedAnnualPrice = {
        id: "price_archived_annual",
        lookup_key: null,
        product: "prod_archived_annual",
        recurring: { interval: "year", interval_count: 1 },
      }
      stripeMockState.prices = []
      stripeMockState.retrievedPrices = { price_archived_annual: archivedAnnualPrice }
      stripeMockState.invoicePayments = [
        {
          amount_paid: 15_900,
          payment: { type: "payment_intent", payment_intent: "pi_archived_renewal" },
        },
      ]
      stripeMockState.event = {
        id: "evt_archived_invoice_paid",
        created: 1_700_000_000,
        type: "invoice.paid",
        data: {
          object: {
            id: "in_archived_renewal",
            amount_due: 15_900,
            billing_reason: "subscription_cycle",
            customer: "cus_test",
            parent: {
              subscription_details: {
                subscription: "sub_archived_annual",
                metadata: {
                  plan_lookup_key: "taxmaxi_annual_10k_eur",
                  taxmaxi_user_id: TEST_USER_ID,
                },
              },
            },
            lines: {
              has_more: false,
              data: [
                {
                  parent: { subscription_item_details: { proration: false } },
                  pricing: { price_details: { price: "price_archived_annual" } },
                  period: { start: 1_700_000_000, end: 1_731_536_000 },
                },
              ],
            },
          },
        },
      }
      const grants: Array<Parameters<BillingRepositoryService["grantCredits"]>[0]> = []
      const service = yield* Effect.promise(() =>
        loadServiceWithStripe({
          ...billingRepositoryStub,
          findByUserId: () =>
            Effect.succeed(Option.some(billingAccount({ stripeCustomerId: "cus_test" }))),
          grantCredits: (input) =>
            Effect.sync(() => {
              grants.push(input)
              return true
            }),
        })
      )

      yield* service.processWebhook({ payload: "{}", signature: "sig_test" })

      expect(grants).toHaveLength(1)
      expect(grants[0]).toMatchObject({
        userId: TEST_USER_ID,
        amount: 10_000,
        paymentReference: "pi_archived_renewal",
        reference: "stripe:annual:sub_archived_annual:1700000000:1731536000:pi_archived_renewal",
      })
    })
  )

  it.effect("grants a paid renewal after the annual subscription moves to a new product", () =>
    Effect.gen(function* () {
      const replacementAnnualPrice = {
        ...catalogPriceByLookupKey("taxmaxi_annual_10k_eur", "prod_replacement_annual"),
        id: "price_replacement_annual",
      }
      stripeMockState.prices = [replacementAnnualPrice]
      stripeMockState.retrievedPrices = { price_replacement_annual: replacementAnnualPrice }
      stripeMockState.invoicePayments = [
        {
          amount_paid: 15_900,
          payment: { type: "payment_intent", payment_intent: "pi_migrated_renewal" },
        },
      ]
      stripeMockState.event = {
        id: "evt_migrated_invoice_paid",
        created: 1_700_000_000,
        type: "invoice.paid",
        data: {
          object: {
            id: "in_migrated_renewal",
            amount_due: 15_900,
            billing_reason: "subscription_cycle",
            customer: "cus_test",
            parent: {
              subscription_details: {
                subscription: "sub_migrated_annual",
                metadata: {
                  plan_lookup_key: "taxmaxi_annual_10k_eur",
                  plan_product_id: "prod_original_annual",
                  taxmaxi_user_id: TEST_USER_ID,
                },
              },
            },
            lines: {
              has_more: false,
              data: [
                {
                  parent: { subscription_item_details: { proration: false } },
                  pricing: { price_details: { price: "price_replacement_annual" } },
                  period: { start: 1_700_000_000, end: 1_731_536_000 },
                },
              ],
            },
          },
        },
      }
      const grants: Array<Parameters<BillingRepositoryService["grantCredits"]>[0]> = []
      const service = yield* Effect.promise(() =>
        loadServiceWithStripe({
          ...billingRepositoryStub,
          findByUserId: () =>
            Effect.succeed(Option.some(billingAccount({ stripeCustomerId: "cus_test" }))),
          grantCredits: (input) =>
            Effect.sync(() => {
              grants.push(input)
              return true
            }),
        })
      )

      yield* service.processWebhook({ payload: "{}", signature: "sig_test" })

      expect(grants).toHaveLength(1)
      expect(grants[0]).toMatchObject({
        amount: 10_000,
        paymentReference: "pi_migrated_renewal",
        stripeInvoiceId: "in_migrated_renewal",
      })
    })
  )

  it.effect("restores credits when a Stripe inquiry closes without a chargeback", () =>
    Effect.gen(function* () {
      stripeMockState.event = {
        id: "evt_inquiry_closed",
        created: 1_700_000_000,
        type: "charge.dispute.closed",
        data: { object: { id: "dp_inquiry" } },
      }
      stripeMockState.dispute = {
        id: "dp_inquiry",
        amount: 15_900,
        status: "warning_closed",
        charge: "ch_inquiry",
      }
      stripeMockState.charge = {
        id: "ch_inquiry",
        amount: 15_900,
        payment_intent: "pi_inquiry",
      }
      const reversals: Array<Parameters<BillingRepositoryService["setPaymentCreditReversal"]>[0]> =
        []
      const service = yield* Effect.promise(() =>
        loadServiceWithStripe({
          ...billingRepositoryStub,
          setPaymentCreditReversal: (input) =>
            Effect.sync(() => {
              reversals.push(input)
              return true
            }),
        })
      )

      yield* service.processWebhook({ payload: "{}", signature: "sig_test" })

      expect(reversals).toHaveLength(1)
      expect(reversals[0]).toMatchObject({
        paymentReference: "pi_inquiry",
        reversedAmount: 0,
        terminal: true,
      })
    })
  )

  it.effect(
    "keeps annual grant and refund references aligned through the webhook service path",
    () =>
      Effect.gen(function* () {
        const annualPrice = {
          ...catalogPriceByLookupKey("taxmaxi_annual_10k_eur", "prod_annual"),
          id: "price_annual",
        }
        stripeMockState.prices = [annualPrice]
        stripeMockState.retrievedPrices = { price_annual: annualPrice }
        stripeMockState.invoicePayments = [
          {
            amount_paid: 10_000,
            payment: {
              type: "charge",
              charge: { id: "ch_annual", payment_intent: "pi_annual" },
            },
          },
        ]
        stripeMockState.event = {
          id: "evt_invoice_paid",
          created: 1_700_000_000,
          type: "invoice.paid",
          data: {
            object: {
              id: "in_annual",
              amount_due: 10_000,
              billing_reason: "subscription_cycle",
              customer: "cus_test",
              parent: {
                subscription_details: {
                  subscription: "sub_legacy_same_product",
                  metadata: null,
                },
              },
              lines: {
                has_more: false,
                data: [
                  {
                    parent: { subscription_item_details: { proration: false } },
                    pricing: { price_details: { price: "price_annual" } },
                    period: { start: 1_700_000_000, end: 1_731_536_000 },
                  },
                ],
              },
            },
          },
        }
        const grants: Array<Parameters<BillingRepositoryService["grantCredits"]>[0]> = []
        const reversals: Array<
          Parameters<BillingRepositoryService["setPaymentCreditReversal"]>[0]
        > = []
        const service = yield* Effect.promise(() =>
          loadServiceWithStripe({
            ...billingRepositoryStub,
            findByStripeCustomerId: () =>
              Effect.succeed(Option.some(billingAccount({ stripeCustomerId: "cus_test" }))),
            grantCredits: (input) =>
              Effect.sync(() => {
                grants.push(input)
                return true
              }),
            setPaymentCreditReversal: (input) =>
              Effect.sync(() => {
                reversals.push(input)
                return true
              }),
          })
        )

        yield* service.processWebhook({ payload: "{}", signature: "sig_test" })
        stripeMockState.event = {
          id: "evt_charge_refunded",
          created: 1_700_000_100,
          type: "charge.refunded",
          data: {
            object: {
              id: "ch_annual",
              amount: 10_000,
              amount_refunded: 10_000,
              payment_intent: "pi_annual",
            },
          },
        }
        stripeMockState.refunds = [
          {
            id: "re_annual",
            amount: 10_000,
            status: "succeeded",
          },
        ]
        yield* service.processWebhook({ payload: "{}", signature: "sig_test" })

        expect(grants[0]).toMatchObject({
          amount: 10_000,
          paymentReference: "pi_annual",
          paymentAmount: 10_000,
          stripeInvoiceId: "in_annual",
          reference: "stripe:annual:sub_legacy_same_product:1700000000:1731536000:pi_annual",
        })
        expect(reversals[0]).toMatchObject({
          paymentReference: "pi_annual",
          reversalGroup: "stripe:refund:re_annual:payment",
          lossReference: "stripe:refund:re_annual",
          stripeInvoiceId: null,
          terminal: true,
        })
        expect(stripeMockState.refundPagingLimit).toBe(10_000)

        stripeMockState.retrievedRefund = {
          id: "re_annual",
          amount: 10_000,
          charge: "ch_annual",
          payment_intent: "pi_annual",
          status: "succeeded",
        }
        stripeMockState.event = {
          id: "evt_credit_note_created",
          created: 1_700_000_200,
          type: "credit_note.created",
          data: {
            object: {
              id: "cn_annual",
              currency: "eur",
              invoice: "in_annual",
              post_payment_amount: 10_000,
              status: "issued",
              refunds: [
                {
                  amount_refunded: 10_000,
                  payment_record_refund: null,
                  refund: "re_annual",
                  type: "refund",
                },
              ],
            },
          },
        }
        yield* service.processWebhook({ payload: "{}", signature: "sig_test" })

        expect(reversals[1]).toMatchObject({
          paymentReference: "pi_annual",
          reversalGroup: "stripe:credit-note:cn_annual:refund:re_annual",
          lossReference: "stripe:refund:re_annual",
          reversedAmount: 10_000,
          stripeInvoiceId: "in_annual",
          terminal: true,
        })
      })
  )

  it.effect("waits for a credit-note refund to succeed before reversing credits", () =>
    Effect.gen(function* () {
      stripeMockState.retrievedRefund = {
        id: "re_credit_note_pending",
        amount: 1_000,
        charge: "ch_credit_note_pending",
        payment_intent: "pi_credit_note_pending",
        status: "pending",
      }
      stripeMockState.charge = {
        id: "ch_credit_note_pending",
        amount: 2_000,
        payment_intent: "pi_credit_note_pending",
      }
      stripeMockState.event = {
        id: "evt_credit_note_pending",
        created: 1_700_000_000,
        type: "credit_note.created",
        data: {
          object: {
            id: "cn_pending_refund",
            currency: "eur",
            invoice: "in_pending_refund",
            post_payment_amount: 1_000,
            status: "issued",
            refunds: [
              {
                amount_refunded: 1_000,
                payment_record_refund: null,
                refund: "re_credit_note_pending",
                type: "refund",
              },
            ],
          },
        },
      }
      const reversals: Array<Parameters<BillingRepositoryService["setPaymentCreditReversal"]>[0]> =
        []
      const service = yield* Effect.promise(() =>
        loadServiceWithStripe({
          ...billingRepositoryStub,
          setPaymentCreditReversal: (input) =>
            Effect.sync(() => {
              reversals.push(input)
              return true
            }),
        })
      )

      yield* service.processWebhook({ payload: "{}", signature: "sig_test" })
      expect(reversals).toEqual([])

      stripeMockState.event = {
        id: "evt_credit_note_refund_succeeded",
        created: 1_700_000_100,
        type: "refund.updated",
        data: {
          object: {
            id: "re_credit_note_pending",
            amount: 1_000,
            charge: "ch_credit_note_pending",
            payment_intent: "pi_credit_note_pending",
            status: "succeeded",
          },
        },
      }
      yield* service.processWebhook({ payload: "{}", signature: "sig_test" })

      expect(reversals).toEqual([
        expect.objectContaining({
          paymentReference: "pi_credit_note_pending",
          reversalGroup: "stripe:refund:re_credit_note_pending:payment",
          lossReference: "stripe:refund:re_credit_note_pending",
          reversedAmount: 1_000,
          terminal: true,
        }),
      ])
    })
  )

  it.effect("reverses credits when a pending refund later succeeds", () =>
    Effect.gen(function* () {
      stripeMockState.charge = {
        id: "ch_async_refund",
        amount: 2_000,
        payment_intent: "pi_async_refund",
      }
      stripeMockState.event = {
        id: "evt_async_refund_pending",
        created: 1_700_000_000,
        type: "charge.refunded",
        data: {
          object: {
            id: "ch_async_refund",
            amount: 2_000,
            amount_refunded: 1_000,
            payment_intent: "pi_async_refund",
          },
        },
      }
      stripeMockState.refunds = [
        {
          id: "re_async_refund",
          amount: 1_000,
          status: "pending",
        },
      ]
      const reversals: Array<Parameters<BillingRepositoryService["setPaymentCreditReversal"]>[0]> =
        []
      const service = yield* Effect.promise(() =>
        loadServiceWithStripe({
          ...billingRepositoryStub,
          setPaymentCreditReversal: (input) =>
            Effect.sync(() => {
              reversals.push(input)
              return true
            }),
        })
      )

      yield* service.processWebhook({ payload: "{}", signature: "sig_test" })
      expect(reversals).toEqual([])

      stripeMockState.event = {
        id: "evt_async_refund_succeeded",
        created: 1_700_000_100,
        type: "refund.updated",
        data: {
          object: {
            id: "re_async_refund",
            amount: 1_000,
            charge: "ch_async_refund",
            payment_intent: "pi_async_refund",
            status: "succeeded",
          },
        },
      }
      yield* service.processWebhook({ payload: "{}", signature: "sig_test" })

      expect(reversals).toEqual([
        expect.objectContaining({
          paymentReference: "pi_async_refund",
          reversalGroup: "stripe:refund:re_async_refund:payment",
          lossReference: "stripe:refund:re_async_refund",
          reversedAmount: 1_000,
          paymentAmount: 2_000,
          terminal: true,
        }),
      ])
    })
  )

  it.effect("short-circuits duplicate Stripe webhook deliveries", () =>
    Effect.gen(function* () {
      stripeMockState.event = {
        id: "evt_already_processed",
        created: 1_700_000_000,
        type: "refund.updated",
        data: {
          object: {
            id: "re_already_processed",
            amount: 1_000,
            charge: "ch_already_processed",
            payment_intent: "pi_already_processed",
            status: "succeeded",
          },
        },
      }
      let reversalCalls = 0
      let processedCalls = 0
      const service = yield* Effect.promise(() =>
        loadServiceWithStripe({
          ...billingRepositoryStub,
          hasProcessedEvent: () => Effect.succeed(true),
          setPaymentCreditReversal: () =>
            Effect.sync(() => {
              reversalCalls += 1
              return true
            }),
          markEventProcessed: () =>
            Effect.sync(() => {
              processedCalls += 1
            }),
        })
      )

      yield* service.processWebhook({ payload: "{}", signature: "sig_test" })

      expect(reversalCalls).toBe(0)
      expect(processedCalls).toBe(0)
    })
  )

  it.effect("reverses PaymentRecord-funded annual credits from credit note refunds", () =>
    Effect.gen(function* () {
      const annualPrice = {
        ...catalogPriceByLookupKey("taxmaxi_annual_10k_eur", "prod_annual"),
        id: "price_annual",
      }
      stripeMockState.prices = [annualPrice]
      stripeMockState.retrievedPrices = { price_annual: annualPrice }
      stripeMockState.invoicePayments = [
        {
          amount_paid: 10_000,
          payment: { type: "payment_record", payment_record: "pr_annual" },
        },
      ]
      stripeMockState.event = {
        id: "evt_payment_record_invoice_paid",
        created: 1_700_000_000,
        type: "invoice.paid",
        data: {
          object: {
            id: "in_payment_record_annual",
            amount_due: 10_000,
            billing_reason: "subscription_cycle",
            customer: "cus_test",
            parent: {
              subscription_details: {
                subscription: "sub_payment_record_annual",
                metadata: null,
              },
            },
            lines: {
              has_more: false,
              data: [
                {
                  parent: { subscription_item_details: { proration: false } },
                  pricing: { price_details: { price: "price_annual" } },
                  period: { start: 1_700_000_000, end: 1_731_536_000 },
                },
              ],
            },
          },
        },
      }
      const grants: Array<Parameters<BillingRepositoryService["grantCredits"]>[0]> = []
      const reversals: Array<Parameters<BillingRepositoryService["setPaymentCreditReversal"]>[0]> =
        []
      const service = yield* Effect.promise(() =>
        loadServiceWithStripe({
          ...billingRepositoryStub,
          findByStripeCustomerId: () =>
            Effect.succeed(Option.some(billingAccount({ stripeCustomerId: "cus_test" }))),
          grantCredits: (input) =>
            Effect.sync(() => {
              grants.push(input)
              return true
            }),
          setPaymentCreditReversal: (input) =>
            Effect.sync(() => {
              reversals.push(input)
              return true
            }),
        })
      )

      yield* service.processWebhook({ payload: "{}", signature: "sig_test" })
      stripeMockState.paymentRecord = {
        id: "pr_annual",
        amount: { currency: "eur", value: 10_000 },
      }
      stripeMockState.event = {
        id: "evt_payment_record_refunded",
        created: 1_700_000_100,
        type: "credit_note.created",
        data: {
          object: {
            id: "cn_payment_record_refund",
            currency: "eur",
            invoice: "in_payment_record_annual",
            post_payment_amount: 10_000,
            status: "issued",
            refunds: [
              {
                amount_refunded: 10_000,
                payment_record_refund: {
                  payment_record: "pr_annual",
                  refund_group: "prr_annual",
                },
                type: "payment_record_refund",
              },
            ],
          },
        },
      }
      yield* service.processWebhook({ payload: "{}", signature: "sig_test" })

      expect(grants[0]).toMatchObject({
        amount: 10_000,
        paymentReference: "pr_annual",
        paymentAmount: 10_000,
        stripeInvoiceId: "in_payment_record_annual",
      })
      expect(reversals[0]).toMatchObject({
        paymentReference: "pr_annual",
        reversalGroup:
          "stripe:credit-note:cn_payment_record_refund:payment-record-refund:prr_annual",
        lossReference: "stripe:payment-record-refund:prr_annual",
        reversedAmount: 10_000,
        paymentAmount: 10_000,
        stripeInvoiceId: "in_payment_record_annual",
        terminal: true,
      })
    })
  )

  it.effect("reverses customer-balance and out-of-band credit note value", () =>
    Effect.gen(function* () {
      stripeMockState.invoicePayments = [
        {
          amount_paid: 4_000,
          payment: { type: "payment_intent", payment_intent: "pi_first" },
        },
        {
          amount_paid: 6_000,
          payment: { type: "payment_intent", payment_intent: "pi_second" },
        },
      ]
      stripeMockState.event = {
        id: "evt_non_refund_credit_note",
        created: 1_700_000_000,
        type: "credit_note.created",
        data: {
          object: {
            id: "cn_non_refund",
            currency: "eur",
            customer_balance_transaction: "cbtxn_credit_note",
            invoice: "in_non_refund",
            out_of_band_amount: 2_000,
            post_payment_amount: 7_000,
            status: "issued",
            refunds: [],
          },
        },
      }
      const reversals: Array<Parameters<BillingRepositoryService["setPaymentCreditReversal"]>[0]> =
        []
      const service = yield* Effect.promise(() =>
        loadServiceWithStripe({
          ...billingRepositoryStub,
          setPaymentCreditReversal: (input) =>
            Effect.sync(() => {
              reversals.push(input)
              return true
            }),
        })
      )

      yield* service.processWebhook({ payload: "{}", signature: "sig_test" })

      expect(reversals).toEqual([
        expect.objectContaining({
          paymentReference: "pi_first",
          reversalGroup: "stripe:credit-note:cn_non_refund:non-refund:pi_first",
          lossReference: "stripe:credit-note:cn_non_refund:non-refund",
          reversedAmount: 4_000,
          paymentAmount: 4_000,
          stripeInvoiceId: "in_non_refund",
          terminal: true,
        }),
        expect.objectContaining({
          paymentReference: "pi_second",
          reversalGroup: "stripe:credit-note:cn_non_refund:non-refund:pi_second",
          lossReference: "stripe:credit-note:cn_non_refund:non-refund",
          reversedAmount: 3_000,
          paymentAmount: 6_000,
          stripeInvoiceId: "in_non_refund",
          terminal: true,
        }),
      ])
    })
  )

  it.effect("starts without Stripe configuration and keeps local billing status available", () =>
    Effect.gen(function* () {
      const logMessages: Array<unknown> = []
      const logger = Logger.make<unknown, void>(({ message }) => {
        logMessages.push(message)
      })
      const service = yield* Effect.promise(() => loadServiceWithoutStripeConfig())
      const status = yield* service.status(TEST_USER_ID)
      const catalog = yield* Effect.result(service.catalog).pipe(Effect.withLogger(logger))
      const webhook = yield* Effect.result(
        service.processWebhook({ payload: "{}", signature: "missing" })
      )

      expect(status).toEqual({
        credits: 0,
        subscriptionStatus: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      })
      expect(catalog).toMatchObject({
        _tag: "Failure",
        failure: { message: "Stripe billing is not configured" },
      })
      expect(logMessages).toContainEqual([
        {
          provider: "stripe",
          operation: "Could not load Stripe prices",
          configurationError: "Stripe billing is not configured",
        },
        "Stripe request failed",
      ])
      expect(webhook).toMatchObject({
        _tag: "Failure",
        failure: { message: "Stripe webhook is not configured" },
      })
    })
  )
})
