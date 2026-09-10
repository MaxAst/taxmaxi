import { TransactionOverrideScopeQuery } from "@my/rest-api/contracts"
import { describe, expect, it } from "@effect/vitest"
import { vi } from "vitest"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import {
  DEFAULT_BASE_URL,
  TaxMaxi,
  TaxMaxiError,
  getTaxMaxiAssetDecisionConflict,
  getTaxMaxiAssetDecisionErrorCode,
  getTaxMaxiCreditRequired,
  isTaxMaxiUnauthorizedError,
  makeTaxMaxiHttpClientTransform,
  normalizeBaseUrl,
  toTaxMaxiError,
  type TaxMaxiHeaders,
} from "../src/index.ts"
import { TaxMaxiInternal } from "../src/internal.ts"

type FetchInput = Parameters<typeof globalThis.fetch>[0]
type FetchInit = NonNullable<Parameters<typeof globalThis.fetch>[1]>

type CapturedRequest = {
  readonly body?: string
  readonly credentials: string | undefined
  readonly headers: TaxMaxiHeaders
  readonly url: string
}

type CaptureRequest = (input: FetchInput, init: FetchInit | undefined) => void

type MakeSequenceFetchOptions = {
  readonly capture: CaptureRequest
  readonly fallbackBody: string
  readonly responseBodies: Array<string>
}

class UnexpectedPromiseRejection extends Data.TaggedError("UnexpectedPromiseRejection")<{
  readonly cause: unknown
}> {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const healthResponseBody = JSON.stringify({
  status: "ok",
  timestamp: "2026-04-29T00:00:00.000Z",
  version: null,
})

const sourceListResponseBody = JSON.stringify({
  sources: [],
})

const billingCatalogResponse = {
  prices: [
    {
      lookupKey: "taxmaxi_annual_10k_eur",
      amountMinor: 15_900,
      currency: "eur",
      taxBehavior: "inclusive",
      recurringInterval: "year",
    },
  ],
} as const

const billingStatusResponse = {
  credits: 10_000,
  subscriptionStatus: "active",
  currentPeriodEnd: "2027-08-14T12:00:00.000Z",
  cancelAtPeriodEnd: false,
} as const

const accountResponse = {
  account: {
    id: "00000000-0000-4000-8000-000000000101",
    email: "account@taxmaxi.test",
    displayName: "Account Owner",
    role: "member",
    emailVerified: true,
    welcomeSeenAt: null,
    createdAt: "2026-08-18T12:00:00.000Z",
    updatedAt: "2026-08-18T12:30:00.000Z",
  },
  loginMethods: [
    {
      id: "00000000-0000-4000-8000-000000000102",
      provider: "coinbase",
      providerEmail: "provider@coinbase.test",
      linkedAt: "2026-08-18T12:00:00.000Z",
      isCurrentSession: true,
      isAvailable: false,
      unavailableReason: "provider_disabled",
      canRemove: false,
    },
  ],
} as const

const sourceCreateResponseBody = JSON.stringify({
  source: {
    id: "00000000-0000-4000-8000-000000000001",
    principalId: "00000000-0000-4000-8000-000000000002",
    name: "Demo Solana wallet",
    providerKey: "helius-solana",
    sourceRef: {
      _tag: "onchain",
      addressId: "00000000-0000-4000-8000-000000000003",
    },
    createdAt: {
      epochMillis: 1_767_225_600_000,
    },
  },
  created: true,
  syncJob: null,
  claim: {
    requestId: "00000000-0000-4000-8000-000000000004",
    claimToken: "claim-token",
    expiresAt: "2026-01-01T00:00:00.000Z",
  },
})

const sourceResponse = {
  id: "00000000-0000-4000-8000-000000000001",
  principalId: "00000000-0000-4000-8000-000000000002",
  name: "Demo Solana wallet",
  providerKey: "helius-solana",
  sourceRef: {
    _tag: "onchain",
    addressId: "00000000-0000-4000-8000-000000000003",
  },
  createdAt: {
    epochMillis: 1_767_225_600_000,
  },
} as const

const sourceOverviewResponseBody = JSON.stringify({
  calculationRunId: null,
  source: sourceResponse,
  latestSync: {
    jobId: null,
    status: null,
    mode: null,
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    lastSyncedAt: null,
    lastErrorMessage: null,
    fetchedRecords: null,
    normalizedRecords: null,
    failedRecords: null,
  },
  totals: {
    transactionCount: 0,
    legCount: 0,
    assetCount: 0,
    fifoLotCount: 0,
    disposalCount: 0,
    incomeCount: 0,
    feeCount: 0,
    realizedGainLoss: "0",
    incomeTotal: "0",
    currency: null,
  },
  review: {
    status: "ok",
    needsReviewCount: 0,
    blockingIssueCount: 0,
    issues: [],
  },
})

const emptySourceAssetPnlResponseBody = JSON.stringify({ calculationRunId: null, assets: [] })
const emptyPortfolioSummary = {
  totalValue: "0",
  costBasis: "0",
  profitLoss: "0",
  profitLossPercentage: null,
}
const portfolioAssetsResponseBody = JSON.stringify({
  currency: "EUR",
  activeRun: null,
  latestRun: null,
  summary: emptyPortfolioSummary,
  assets: [],
})

const emptyProviderAssetReviewsResponseBody = JSON.stringify({
  providerAssets: [],
  page: {
    nextCursor: null,
    hasMore: false,
  },
})

const unresolvedTransferReconciliationsResponseBody = JSON.stringify({
  reconciliations: [
    {
      id: "00000000-0000-4000-8000-000000000021",
      principalId: "00000000-0000-4000-8000-000000000002",
      providerTransferId: "00000000-0000-4000-8000-000000000022",
      providerSourceId: "00000000-0000-4000-8000-000000000023",
      providerTimestamp: "2026-08-13T10:00:00.000Z",
      providerDirection: "outbound",
      providerAmount: "1.25",
      networkName: "solana",
      networkHash: "signature",
      canonicalTransferId: null,
      canonicalTransactionId: "00000000-0000-4000-8000-000000000024",
      status: "pending",
      matchReason: "asset_representation_review_pending",
      confidence: "1.0000",
      deterministic: false,
      reviewMetadata: { candidateCount: 1 },
      createdAt: "2026-08-13T10:01:00.000Z",
      updatedAt: "2026-08-13T10:01:00.000Z",
    },
  ],
  page: {
    nextCursor: null,
    hasMore: false,
  },
})

const pendingAssetResponse = {
  id: "00000000-0000-4000-8000-000000000019",
  provider: "coinbase",
  providerAssetId: "cbeth",
  symbol: "cbETH",
  name: "Coinbase Wrapped Staked ETH",
  providerType: "crypto",
} as const

const pendingAssetListResponseBody = JSON.stringify({
  pendingAssets: [pendingAssetResponse],
  page: {
    nextCursor: null,
    hasMore: false,
  },
})
const assetCatalogAssetResponse = {
  id: "00000000-0000-4000-8000-000000000010",
  name: "USD Coin",
  symbol: "USDC",
  coingeckoCoinId: "usd-coin",
  logoUrl: null,
  type: "fungible",
  representations: [
    {
      id: "00000000-0000-4000-8000-000000000012",
      blockchainId: "00000000-0000-4000-8000-000000000011",
      blockchainName: "solana",
      blockchainChainType: "solana",
      blockchainChainId: null,
      blockchainExplorerUrl: "https://explorer.solana.com",
      blockchainLogoUrl: null,
      contractAddress: null,
      mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      decimals: 6,
      logoUrl: null,
      type: "token",
      metadata: null,
    },
  ],
} as const

const assetCatalogListResponseBody = JSON.stringify({
  assets: [assetCatalogAssetResponse],
  page: {
    nextCursor: null,
    hasMore: false,
  },
})

const assetCatalogAssetResponseBody = JSON.stringify(assetCatalogAssetResponse)

const assetExceptionListResponseBody = JSON.stringify({
  exceptions: [
    {
      providerAssetRowId: "00000000-0000-4000-8000-000000000020",
      provider: "coinbase",
      providerAssetId: "exception-token",
      naturalKey: "currency_code:EXC",
      currencyCode: "EXC",
      name: "Exception Token",
      providerType: "crypto",
      reason: "ownership_conflict",
      severity: "critical",
      evidenceRevision: 2,
      policyRevision: "policy.1",
      currentConclusionRevision: "no_current_conclusion",
      currentPolicyEvaluationRevision: "00000000-0000-4000-8000-000000000021",
      blockedReports: 1,
      affectedPrincipals: 1,
      affectedTransactions: 2,
      affectedSources: 1,
      affectedCalculations: 0,
      existingGeneratedReportSnapshots: 0,
      affectedTransactionValueEur: "1250.50",
      oldestAt: "2026-08-21T12:00:00.000Z",
    },
  ],
  page: { nextCursor: "opaque-cursor", hasMore: true },
})

const assetCanonicalizationResponseBody = JSON.stringify({
  providerAsset: {
    id: "00000000-0000-4000-8000-000000000009",
    provider: "coinbase",
    providerAssetId: "63062039-7afb-56ff-8e19-5e3215dc404a",
    naturalKey: null,
    currencyCode: "ADA",
    name: "Cardano",
    exponent: 6,
    providerType: "crypto",
    mappingKind: "asset",
    canonicalAssetId: "00000000-0000-4000-8000-000000000010",
    assetRepresentationId: "00000000-0000-4000-8000-000000000012",
    canonicalFiatCurrency: null,
    mappingStatus: "approved",
    reviewerNotes: "Looks correct.",
    sourceNotes: "Approved with CoinGecko asset/platform metadata.",
  },
  canonicalAsset: {
    id: "00000000-0000-4000-8000-000000000010",
    representationId: "00000000-0000-4000-8000-000000000012",
    blockchainId: "00000000-0000-4000-8000-000000000011",
    blockchainName: "cardano",
    name: "Cardano",
    symbol: "ADA",
    type: "fungible",
    decimals: 6,
    contractAddress: null,
    mintAddress: null,
    representationType: "native",
  },
  evidence: {
    source: "coingecko",
    coinId: "cardano",
    coinName: "Cardano",
    coinSymbol: "ADA",
    platformId: "cardano",
    platformName: "Cardano",
    contractAddress: null,
  },
})

const approvedProviderAssetResponseBody = JSON.stringify({
  id: "00000000-0000-4000-8000-000000000009",
  provider: "coinbase",
  providerAssetId: "63062039-7afb-56ff-8e19-5e3215dc404a",
  naturalKey: null,
  currencyCode: "ADA",
  name: "Cardano",
  exponent: 6,
  providerType: "crypto",
  mappingKind: "asset",
  canonicalAssetId: "00000000-0000-4000-8000-000000000010",
  assetRepresentationId: "00000000-0000-4000-8000-000000000012",
  canonicalFiatCurrency: null,
  mappingStatus: "approved",
  reviewerNotes: "Identity checked.",
  sourceNotes: "Approved from exact representation evidence.",
})

const emptySourceTransactionsResponseBody = JSON.stringify({
  transactions: [],
  page: { nextCursor: null, hasMore: false },
})

const transactionListResponse = {
  transactions: [],
  page: { nextCursor: null, hasMore: false },
  totalCount: 0,
} as const

const emptySourceTaxEventsResponseBody = JSON.stringify({
  calculationRunId: null,
  taxEvents: [],
  page: { nextCursor: null, hasMore: false },
})

const emptySourceFifoLotsResponseBody = JSON.stringify({
  calculationRunId: null,
  fifoLots: [],
  page: { nextCursor: null, hasMore: false },
})

const sourceDisposalExplanationResponseBody = JSON.stringify({
  calculationRunId: null,
  disposalLegId: "00000000-0000-4000-8000-000000000006",
  transactionId: "00000000-0000-4000-8000-000000000007",
  asset: {
    assetId: "00000000-0000-4000-8000-000000000008",
    symbol: "BTC",
    name: "Bitcoin",
  },
  amount: "0.1",
  proceeds: "500",
  costBasis: "500",
  gainLoss: "0",
  acquiredAt: "2025-01-01T00:00:00.000Z",
  disposedAt: "2025-02-01T00:00:00.000Z",
  treatmentCodes: [],
  provenance: "deterministic",
  derivationRule: "internal_transfer_out",
  matchedLots: [],
})

const anonSourceJobResponse = {
  sourceId: "00000000-0000-4000-8000-000000000001",
  jobId: "00000000-0000-4000-8000-000000000005",
  status: "queued",
  phase: null,
  processedRecords: null,
  totalRecords: null,
  progressPercent: null,
  fetchedRecords: null,
  normalizedRecords: null,
  failedRecords: null,
  message: null,
  resumable: false,
  creditOutcome: null,
}

const anonSourceJobsResponseBody = JSON.stringify({
  jobs: [anonSourceJobResponse],
})

const anonSourceJobResponseBody = JSON.stringify(anonSourceJobResponse)

const toHeaderRecord = (headers: FetchInit["headers"]): TaxMaxiHeaders => {
  const record: Record<string, string> = {}

  for (const [key, value] of new Headers(headers)) {
    record[key] = value
  }

  return record
}

const getRequestUrl = (input: FetchInput): string => {
  if (typeof input === "string") {
    return input
  }

  if (input instanceof URL) {
    return input.toString()
  }

  return input.url
}

const makeFetch =
  (
    capturedRequests: Array<CapturedRequest>,
    responseBody: string = healthResponseBody
  ): typeof globalThis.fetch =>
  (input, init) => {
    capturedRequests.push({
      credentials: init?.credentials === undefined ? undefined : String(init.credentials),
      headers: toHeaderRecord(init?.headers),
      url: getRequestUrl(input),
    })

    return Promise.resolve(
      new Response(responseBody, {
        headers: {
          "Content-Type": "application/json",
        },
        status: 200,
      })
    )
  }

const makeSequenceFetch =
  ({ capture, fallbackBody, responseBodies }: MakeSequenceFetchOptions): typeof globalThis.fetch =>
  (input, init) => {
    capture(input, init)

    return Promise.resolve(
      new Response(responseBodies.shift() ?? fallbackBody, {
        headers: { "Content-Type": "application/json" },
        status: 200,
      })
    )
  }

const makeBodyCapturingFetch =
  ({
    capturedRequests,
    fallbackBody,
    responseBodies,
  }: {
    readonly capturedRequests: Array<CapturedRequest>
    readonly fallbackBody: string
    readonly responseBodies: Array<string>
  }): typeof globalThis.fetch =>
  (input, init) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const requestBody =
          init?.body === undefined
            ? undefined
            : yield* Effect.promise(() => new Response(init.body).text())
        capturedRequests.push({
          ...(requestBody === undefined || requestBody === "" ? {} : { body: requestBody }),
          credentials: init?.credentials === undefined ? undefined : String(init.credentials),
          headers: toHeaderRecord(init?.headers),
          url: getRequestUrl(input),
        })

        return new Response(responseBodies.shift() ?? fallbackBody, {
          headers: { "Content-Type": "application/json" },
          status: 200,
        })
      })
    )

const makeAbortableFetch =
  (captureSignal: (signal: AbortSignal | undefined) => void): typeof globalThis.fetch =>
  (_input, init) =>
    Effect.runPromise(
      Effect.callback<Response, DOMException>((resume) => {
        const signal = init?.signal ?? undefined
        captureSignal(signal)

        if (signal === undefined) {
          return
        }

        const onAbort = () => resume(Effect.fail(new DOMException("Request aborted", "AbortError")))

        if (signal.aborted) {
          onAbort()
          return
        }

        signal.addEventListener("abort", onAbort, { once: true })
        return Effect.sync(() => signal.removeEventListener("abort", onAbort))
      })
    )

const makeFailureFetch =
  (error: unknown): typeof globalThis.fetch =>
  () =>
    Promise.reject(error)

describe("normalizeBaseUrl", () => {
  it("defaults to the production API URL", () => {
    expect(normalizeBaseUrl()).toBe(DEFAULT_BASE_URL)
  })

  it("removes trailing slashes, search params, and hash fragments", () => {
    expect(normalizeBaseUrl("https://api.example.test/v1/")).toBe("https://api.example.test/v1")
    expect(normalizeBaseUrl(new URL("http://localhost:4000/api/?ignored=true#hash"))).toBe(
      "http://localhost:4000/api"
    )
  })
})

describe("TaxMaxi Effect client foundation", () => {
  it.effect(
    "constructs a TaxMaxiApi HttpApiClient with injected fetch, credentials, and headers",
    () =>
      Effect.gen(function* () {
        const capturedRequests: Array<CapturedRequest> = []

        const client = yield* TaxMaxi.makeEffectClient({
          apiKey: "tm_test_phase_1",
          baseUrl: "https://sdk.example.test/",
          credentials: "include",
          fetch: makeFetch(capturedRequests),
          headers: {
            Authorization: "Bearer should-be-overridden",
            "X-TaxMaxi-Client": "phase-1",
          },
        })

        yield* client.health.healthCheck(undefined)

        expect(capturedRequests).toEqual([
          {
            credentials: "include",
            headers: expect.objectContaining({
              authorization: "Bearer tm_test_phase_1",
              "x-taxmaxi-client": "phase-1",
            }),
            url: "https://sdk.example.test/health",
          },
        ])
      })
  )

  it.effect("resolves dynamic headers for each request", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<CapturedRequest> = []
      let requestCount = 0

      const client = yield* TaxMaxi.makeEffectClient({
        baseUrl: "https://sdk.example.test",
        fetch: makeFetch(capturedRequests),
        headers: () => {
          requestCount += 1
          return {
            "X-Request-Count": String(requestCount),
          }
        },
      })

      yield* client.health.healthCheck(undefined)
      yield* client.health.healthCheck(undefined)

      expect(capturedRequests).toEqual([
        expect.objectContaining({
          headers: expect.objectContaining({ "x-request-count": "1" }),
        }),
        expect.objectContaining({
          headers: expect.objectContaining({ "x-request-count": "2" }),
        }),
      ])
    })
  )

  it.effect("exposes the same client construction through TaxMaxi instances", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<CapturedRequest> = []
      const taxmaxi = new TaxMaxi({
        apiKey: "tm_instance",
        baseUrl: "https://sdk.example.test",
        fetch: makeFetch(capturedRequests, sourceListResponseBody),
      })

      yield* Effect.promise(() => taxmaxi.sources.list())

      expect(capturedRequests).toEqual([
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: "Bearer tm_instance",
          }),
          url: "https://sdk.example.test/v1/sources",
        }),
      ])
    })
  )

  it("exports the request transform for lower-level Effect composition", () => {
    expect(typeof makeTaxMaxiHttpClientTransform).toBe("function")
  })
})

describe("TaxMaxi Promise client", () => {
  it.effect("lists canonical transactions through the transactions resource", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<CapturedRequest> = []
      const taxmaxi = new TaxMaxi({
        apiKey: "tm_transactions",
        baseUrl: "https://sdk.example.test",
        fetch: makeFetch(capturedRequests, encodeJson(transactionListResponse)),
      })

      yield* Effect.promise(() =>
        expect(
          taxmaxi.transactions.list({ cursor: "transaction-cursor", limit: 10 })
        ).resolves.toEqual(transactionListResponse)
      )
      expect(capturedRequests).toEqual([
        expect.objectContaining({
          url: "https://sdk.example.test/v1/transactions?cursor=transaction-cursor&limit=10",
        }),
      ])
    })
  )

  it.effect("passes an owned source filter and preserves canonical partial rows", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<CapturedRequest> = []
      const sourceId = "00000000-0000-4000-8000-000000000001"
      const response = {
        transactions: [
          {
            transactionId: "00000000-0000-4000-8000-000000000002",
            timestamp: "2025-03-05T12:00:00.000Z",
            source: { sourceId, name: "Wallet", kind: "onchain" },
            transactionType: "buy_fiat",
            description: null,
            externalId: null,
            movements: [
              {
                targetId: "00000000-0000-4000-8000-000000000301",
                capture: null,
                amount: "0.1",
                assetSymbol: "BTC",
                kind: "acquisition",
              },
            ],
            income: null,
            realizedGainLoss: null,
            fiatCurrency: null,
            calculationState: "partial",
            needsReview: false,
          },
        ],
        totalCount: 2,
        page: { nextCursor: "next-source-cursor", hasMore: true },
      } as const
      const taxmaxi = new TaxMaxi({
        apiKey: "tm_transactions",
        baseUrl: "https://sdk.example.test",
        fetch: makeFetch(capturedRequests, encodeJson(response)),
      })
      yield* Effect.promise(() =>
        expect(
          taxmaxi.transactions.list({ sourceId, cursor: "source-cursor", limit: 1 })
        ).resolves.toEqual(response)
      )
      expect(capturedRequests).toEqual([
        expect.objectContaining({
          url: `https://sdk.example.test/v1/transactions?sourceId=${sourceId}&cursor=source-cursor&limit=1`,
        }),
      ])
    })
  )

  it.effect("decodes original purchase value and exact sale allocations after full disposal", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<CapturedRequest> = []
      const source = {
        sourceId: "00000000-0000-4000-8000-000000000302",
        name: "Synthetic wallet",
        kind: "onchain",
      } as const
      const capture = {
        runId: "00000000-0000-4000-8000-000000000303",
        eventId: "00000000-0000-4000-8000-000000000304",
        outcome: "included",
        quantity: "10",
        assetId: "00000000-0000-4000-8000-000000000305",
        assetSymbol: "TOKEN",
        eventKind: "acquisition",
        cause: "purchase",
        valuationState: "selected",
        selectedValue: { kind: "user_valuation", amount: "20", currency: "EUR" },
        providerConsiderations: [],
        acquisitionCostBasis: null,
        realizedResults: [],
      } as const
      const row = {
        transactionId: "00000000-0000-4000-8000-000000000306",
        timestamp: "2025-03-05T12:00:00.000Z",
        source,
        transactionType: "buy_fiat",
        description: null,
        externalId: null,
        movements: [
          {
            targetId: "00000000-0000-4000-8000-000000000307",
            capture,
            amount: "10",
            assetSymbol: "TOKEN",
            kind: "acquisition",
          },
        ],
        income: null,
        realizedGainLoss: null,
        fiatCurrency: "EUR",
        calculationState: "complete",
        needsReview: false,
      } as const
      const response = {
        transactions: [
          row,
          {
            ...row,
            transactionId: "00000000-0000-4000-8000-000000000308",
            timestamp: "2025-04-05T12:00:00.000Z",
            transactionType: "sell_fiat",
            realizedGainLoss: "10",
            movements: [
              {
                targetId: "00000000-0000-4000-8000-000000000309",
                amount: "10",
                assetSymbol: "TOKEN",
                kind: "disposal",
                capture: {
                  ...capture,
                  eventId: "00000000-0000-4000-8000-000000000310",
                  eventKind: "disposition",
                  cause: "sale",
                  selectedValue: { kind: "observed_consideration", amount: "30", currency: "EUR" },
                  providerConsiderations: [{ amount: "30", currency: "EUR" }],
                  realizedResults: [
                    {
                      acquisitionEventId: "00000000-0000-4000-8000-000000000304",
                      quantity: "10",
                      costBasis: "20",
                      proceeds: "30",
                      gainLoss: "10",
                      currency: "EUR",
                    },
                  ],
                },
              },
            ],
          },
        ],
        totalCount: 2,
        page: { nextCursor: null, hasMore: false },
      } as const
      const taxmaxi = new TaxMaxi({
        apiKey: "00000000-0000-4000-8000-000000000305",
        baseUrl: "https://sdk.example.test",
        fetch: makeFetch(capturedRequests, encodeJson(response)),
      })
      yield* Effect.promise(() => expect(taxmaxi.transactions.list()).resolves.toEqual(response))
    })
  )

  it.effect("plumbs successful resource responses through Promise methods", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<CapturedRequest> = []
      const taxmaxi = new TaxMaxi({
        apiKey: "tm_test_phase_2",
        baseUrl: "https://sdk.example.test",
        fetch: makeFetch(capturedRequests, sourceListResponseBody),
      })

      yield* Effect.promise(() =>
        expect(taxmaxi.sources.list()).resolves.toEqual({
          sources: [],
        })
      )

      expect(capturedRequests).toEqual([
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: "Bearer tm_test_phase_2",
          }),
          url: "https://sdk.example.test/v1/sources",
        }),
      ])
    })
  )

  it.effect("uses the browser session for every billing route and returns encoded responses", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<{
        readonly credentials: string | undefined
        readonly method: string
        readonly url: string
      }> = []
      const responseBodies = [
        encodeJson(billingCatalogResponse),
        encodeJson(billingStatusResponse),
        encodeJson({ url: "https://checkout.stripe.test/annual" }),
        encodeJson({ url: "https://checkout.stripe.test/top-up" }),
        encodeJson({ url: "https://billing.stripe.test/portal" }),
      ]
      const taxmaxi = TaxMaxi.fromBrowserSession({
        baseUrl: "https://sdk.example.test",
        fetch: makeSequenceFetch({
          capture: (input, init) => {
            capturedRequests.push({
              credentials: init?.credentials === undefined ? undefined : String(init.credentials),
              method:
                typeof input === "string" || input instanceof URL
                  ? (init?.method ?? "GET")
                  : input.method,
              url: getRequestUrl(input),
            })
          },
          fallbackBody: responseBodies[responseBodies.length - 1] ?? "{}",
          responseBodies,
        }),
      })

      yield* Effect.promise(() =>
        expect(taxmaxi.billing.catalog()).resolves.toEqual(billingCatalogResponse)
      )
      yield* Effect.promise(() =>
        expect(taxmaxi.billing.status()).resolves.toEqual(billingStatusResponse)
      )
      yield* Effect.promise(() =>
        expect(taxmaxi.billing.createAnnualCheckout()).resolves.toEqual({
          url: "https://checkout.stripe.test/annual",
        })
      )
      yield* Effect.promise(() =>
        expect(taxmaxi.billing.createTopUpCheckout()).resolves.toEqual({
          url: "https://checkout.stripe.test/top-up",
        })
      )
      yield* Effect.promise(() =>
        expect(taxmaxi.billing.createPortalSession()).resolves.toEqual({
          url: "https://billing.stripe.test/portal",
        })
      )

      expect(capturedRequests).toEqual([
        {
          credentials: "include",
          method: "GET",
          url: "https://sdk.example.test/v1/billing/catalog",
        },
        {
          credentials: "include",
          method: "GET",
          url: "https://sdk.example.test/v1/billing/status",
        },
        {
          credentials: "include",
          method: "POST",
          url: "https://sdk.example.test/v1/billing/checkout/annual",
        },
        {
          credentials: "include",
          method: "POST",
          url: "https://sdk.example.test/v1/billing/checkout/top-up",
        },
        {
          credentials: "include",
          method: "POST",
          url: "https://sdk.example.test/v1/billing/portal",
        },
      ])
    })
  )

  it.effect("exposes account details and server-side logout through the public auth resource", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<{
        readonly credentials: string | undefined
        readonly method: string
        readonly url: string
      }> = []
      const responseBodies = [encodeJson(accountResponse), encodeJson({ success: true })]
      const taxmaxi = TaxMaxi.fromBrowserSession({
        baseUrl: "https://sdk.example.test",
        fetch: makeSequenceFetch({
          capture: (input, init) => {
            capturedRequests.push({
              credentials: init?.credentials === undefined ? undefined : String(init.credentials),
              method:
                typeof input === "string" || input instanceof URL
                  ? (init?.method ?? "GET")
                  : input.method,
              url: getRequestUrl(input),
            })
          },
          fallbackBody: responseBodies[responseBodies.length - 1] ?? "{}",
          responseBodies,
        }),
      })

      const account = yield* Effect.promise(() => taxmaxi.auth.account())

      expect(account).toEqual(accountResponse)
      expect(account.loginMethods[0]?.isAvailable).toBe(false)
      expect(account.loginMethods[0]?.unavailableReason).toBe("provider_disabled")
      yield* Effect.promise(() => expect(taxmaxi.auth.logout()).resolves.toEqual({ success: true }))

      expect(capturedRequests).toEqual([
        {
          credentials: "include",
          method: "GET",
          url: "https://sdk.example.test/auth/me",
        },
        {
          credentials: "include",
          method: "POST",
          url: "https://sdk.example.test/auth/logout",
        },
      ])
    })
  )

  it.effect("creates paid anonymous sources through the injected fetch implementation", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<CapturedRequest> = []
      const taxmaxi = TaxMaxi.fromBrowserSession({
        baseUrl: "https://sdk.example.test",
        fetch: makeFetch(capturedRequests, sourceCreateResponseBody),
      })

      yield* Effect.promise(() =>
        expect(
          taxmaxi.sources.create({
            type: "onchain",
            walletAddress: "So11111111111111111111111111111111111111112",
            name: "Demo Solana wallet",
          })
        ).resolves.toMatchObject({
          created: true,
          source: {
            name: "Demo Solana wallet",
            providerKey: "helius-solana",
          },
        })
      )

      expect(capturedRequests).toEqual([
        expect.objectContaining({
          credentials: "include",
          url: "https://sdk.example.test/v1/sources",
        }),
      ])
    })
  )

  it.effect("plumbs anonymous source sync-status methods through browser sessions", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<CapturedRequest> = []
      const responseBodies = [anonSourceJobsResponseBody, anonSourceJobResponseBody]
      const taxmaxi = TaxMaxi.fromBrowserSession({
        baseUrl: "https://sdk.example.test",
        fetch: makeSequenceFetch({
          capture: (input, init) => {
            capturedRequests.push({
              credentials: init?.credentials === undefined ? undefined : String(init.credentials),
              headers: toHeaderRecord(init?.headers),
              url: getRequestUrl(input),
            })
          },
          fallbackBody: anonSourceJobResponseBody,
          responseBodies,
        }),
      })

      yield* Effect.promise(() =>
        expect(
          taxmaxi.anon.sources.listJobs({
            sourceId: anonSourceJobResponse.sourceId,
          })
        ).resolves.toEqual({
          jobs: [anonSourceJobResponse],
        })
      )
      yield* Effect.promise(() =>
        expect(
          taxmaxi.anon.sources.getJob({
            sourceId: anonSourceJobResponse.sourceId,
            jobId: anonSourceJobResponse.jobId,
          })
        ).resolves.toEqual(anonSourceJobResponse)
      )

      expect(capturedRequests).toEqual([
        expect.objectContaining({
          credentials: "include",
          url: "https://sdk.example.test/v1/anon/sources/00000000-0000-4000-8000-000000000001/jobs",
        }),
        expect.objectContaining({
          credentials: "include",
          url: "https://sdk.example.test/v1/anon/sources/00000000-0000-4000-8000-000000000001/jobs/00000000-0000-4000-8000-000000000005",
        }),
      ])
    })
  )

  it.effect("plumbs source report endpoints through the public sources resource", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<CapturedRequest> = []
      const sourceId = "00000000-0000-4000-8000-000000000001"
      const legId = "00000000-0000-4000-8000-000000000006"
      const responseBodies = [
        sourceOverviewResponseBody,
        emptySourceAssetPnlResponseBody,
        emptySourceTransactionsResponseBody,
        emptySourceTaxEventsResponseBody,
        emptySourceFifoLotsResponseBody,
        sourceDisposalExplanationResponseBody,
      ]
      const taxmaxi = new TaxMaxi({
        apiKey: "tm_report",
        baseUrl: "https://sdk.example.test",
        fetch: makeSequenceFetch({
          capture: (input, init) => {
            capturedRequests.push({
              credentials: init?.credentials === undefined ? undefined : String(init.credentials),
              headers: toHeaderRecord(init?.headers),
              url: getRequestUrl(input),
            })
          },
          fallbackBody: emptySourceAssetPnlResponseBody,
          responseBodies,
        }),
      })

      yield* Effect.promise(() => taxmaxi.sources.getOverview({ sourceId }))
      yield* Effect.promise(() => taxmaxi.sources.listAssetPnl({ sourceId }))
      yield* Effect.promise(() => taxmaxi.sources.listTransactions({ sourceId, limit: 25 }))
      yield* Effect.promise(() =>
        taxmaxi.sources.listTaxEvents({ sourceId, cursor: "cursor-value", limit: 10 })
      )
      yield* Effect.promise(() => taxmaxi.sources.listFifoLots({ sourceId }))
      yield* Effect.promise(() => taxmaxi.sources.explainDisposal({ sourceId, legId }))

      expect(capturedRequests).toEqual([
        expect.objectContaining({
          url: "https://sdk.example.test/v1/sources/00000000-0000-4000-8000-000000000001/overview",
        }),
        expect.objectContaining({
          url: "https://sdk.example.test/v1/sources/00000000-0000-4000-8000-000000000001/assets/pnl",
        }),
        expect.objectContaining({
          url: "https://sdk.example.test/v1/sources/00000000-0000-4000-8000-000000000001/transactions?limit=25",
        }),
        expect.objectContaining({
          url: "https://sdk.example.test/v1/sources/00000000-0000-4000-8000-000000000001/tax-events?cursor=cursor-value&limit=10",
        }),
        expect.objectContaining({
          url: "https://sdk.example.test/v1/sources/00000000-0000-4000-8000-000000000001/fifo-lots",
        }),
        expect.objectContaining({
          url: "https://sdk.example.test/v1/sources/00000000-0000-4000-8000-000000000001/disposals/00000000-0000-4000-8000-000000000006/explanation",
        }),
      ])
    })
  )

  it.effect("lists combined and source-scoped portfolio assets", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<CapturedRequest> = []
      const sourceId = "00000000-0000-4000-8000-000000000001"
      const taxmaxi = new TaxMaxi({
        apiKey: "tm_portfolio",
        baseUrl: "https://sdk.example.test",
        fetch: makeSequenceFetch({
          capture: (input, init) => {
            capturedRequests.push({
              credentials: init?.credentials === undefined ? undefined : String(init.credentials),
              headers: toHeaderRecord(init?.headers),
              url: getRequestUrl(input),
            })
          },
          fallbackBody: portfolioAssetsResponseBody,
          responseBodies: [portfolioAssetsResponseBody, portfolioAssetsResponseBody],
        }),
      })

      yield* Effect.promise(() =>
        expect(taxmaxi.portfolio.listAssets({ currency: "EUR" })).resolves.toEqual({
          currency: "EUR",
          activeRun: null,
          latestRun: null,
          summary: emptyPortfolioSummary,
          assets: [],
        })
      )
      yield* Effect.promise(() => taxmaxi.portfolio.listAssets({ sourceId, currency: "eur" }))

      expect(capturedRequests.map((request) => request.url)).toEqual([
        "https://sdk.example.test/v1/portfolio/assets?currency=eur",
        `https://sdk.example.test/v1/portfolio/assets?sourceId=${sourceId}&currency=eur`,
      ])
    })
  )

  it.effect(
    "plumbs asset catalog endpoints through the public assets resource as plain objects",
    () =>
      Effect.gen(function* () {
        const capturedRequests: Array<CapturedRequest> = []
        const responseBodies = [
          assetCatalogListResponseBody,
          assetCatalogAssetResponseBody,
          pendingAssetListResponseBody,
          assetExceptionListResponseBody,
        ]
        const taxmaxi = new TaxMaxi({
          apiKey: "",
          baseUrl: "https://sdk.example.test",
          fetch: makeSequenceFetch({
            capture: (input, init) => {
              capturedRequests.push({
                credentials: init?.credentials === undefined ? undefined : String(init.credentials),
                headers: toHeaderRecord(init?.headers),
                url: getRequestUrl(input),
              })
            },
            fallbackBody: assetCatalogListResponseBody,
            responseBodies,
          }),
        })

        const assetList = yield* Effect.promise(() =>
          taxmaxi.assets.list({
            query: "usdc",
            cursor: "00000000-0000-4000-8000-000000000009",
            limit: 25,
          })
        )
        const asset = yield* Effect.promise(() =>
          taxmaxi.assets.get({ assetId: assetCatalogAssetResponse.id })
        )
        const pendingAssetList = yield* Effect.promise(() =>
          taxmaxi.assets.listPending({
            query: "btc",
            provider: "coinbase",
            limit: 10,
          })
        )
        const exceptionList = yield* Effect.promise(() =>
          taxmaxi.assets.listExceptions({
            query: "spam",
            cursor: "opaque-start",
            limit: 5,
          })
        )

        expect(assetList).toStrictEqual({
          assets: [assetCatalogAssetResponse],
          page: {
            nextCursor: null,
            hasMore: false,
          },
        })
        expect(asset).toStrictEqual(assetCatalogAssetResponse)
        expect(pendingAssetList).toStrictEqual({
          pendingAssets: [pendingAssetResponse],
          page: {
            nextCursor: null,
            hasMore: false,
          },
        })
        expect(exceptionList).toMatchObject({
          exceptions: [
            {
              providerAssetRowId: "00000000-0000-4000-8000-000000000020",
              severity: "critical",
            },
          ],
          page: { nextCursor: "opaque-cursor", hasMore: true },
        })

        expect(capturedRequests).toEqual([
          expect.objectContaining({
            url: "https://sdk.example.test/v1/assets?q=usdc&cursor=00000000-0000-4000-8000-000000000009&limit=25",
          }),
          expect.objectContaining({
            url: "https://sdk.example.test/v1/assets/00000000-0000-4000-8000-000000000010",
          }),
          expect.objectContaining({
            url: "https://sdk.example.test/v1/assets/pending?q=btc&provider=coinbase&limit=10",
          }),
          expect.objectContaining({
            url: "https://sdk.example.test/v1/assets/exceptions?q=spam&cursor=opaque-start&limit=5",
          }),
        ])
      })
  )

  it.effect("aborts an asset request when its signal is cancelled", () =>
    Effect.gen(function* () {
      let requestSignal: AbortSignal | undefined
      const taxmaxi = new TaxMaxi({
        apiKey: "",
        baseUrl: "https://sdk.example.test",
        fetch: makeAbortableFetch((signal) => {
          requestSignal = signal
        }),
      })
      const scope = yield* Scope.make()
      const signal = yield* Effect.abortSignal.pipe(Scope.provide(scope))
      const request = taxmaxi.assets.list({}, { signal })

      yield* Effect.promise(() => vi.waitFor(() => expect(requestSignal).toBeDefined()))
      yield* Scope.close(scope, Exit.void)

      yield* Effect.promise(() => expect(request).rejects.toBeInstanceOf(TaxMaxiError))
      yield* Effect.promise(() => vi.waitFor(() => expect(requestSignal?.aborted).toBe(true)))
    })
  )

  it.effect("plumbs asset review endpoints through the internal assets resource", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<CapturedRequest> = []
      const providerAssetId = "00000000-0000-4000-8000-000000000009"
      const responseBodies = [
        emptyProviderAssetReviewsResponseBody,
        unresolvedTransferReconciliationsResponseBody,
        unresolvedTransferReconciliationsResponseBody,
        assetCanonicalizationResponseBody,
        approvedProviderAssetResponseBody,
      ]
      const taxmaxi = new TaxMaxiInternal({
        apiKey: "tm_assets",
        baseUrl: "https://sdk.example.test",
        fetch: makeBodyCapturingFetch({
          capturedRequests,
          fallbackBody: emptyProviderAssetReviewsResponseBody,
          responseBodies,
        }),
      })

      yield* Effect.promise(() =>
        expect(
          taxmaxi.assets.listProviderAssetReviews({
            provider: "coinbase",
            status: "excluded",
            cursor: "00000000-0000-4000-8000-000000000008",
            limit: 25,
          })
        ).resolves.toEqual({
          providerAssets: [],
          page: {
            nextCursor: null,
            hasMore: false,
          },
        })
      )
      yield* Effect.promise(() =>
        expect(
          taxmaxi.assets.listUnresolvedTransferReconciliations({
            status: "pending",
            cursor: "opaque-cursor",
            limit: 25,
          })
        ).resolves.toMatchObject({
          reconciliations: [
            {
              status: "pending",
              matchReason: "asset_representation_review_pending",
            },
          ],
        })
      )
      const effectReconciliations =
        yield* taxmaxi.effect.assets.listUnresolvedTransferReconciliations({
          status: "needs_review",
          limit: 10,
        })
      expect(effectReconciliations).toMatchObject({
        reconciliations: [{ providerAmount: "1.25" }],
      })
      yield* Effect.promise(() =>
        expect(
          taxmaxi.assets.canonicalizeProviderAsset({
            id: providerAssetId,
            reviewerNotes: "Looks correct.",
          })
        ).resolves.toMatchObject({
          providerAsset: {
            assetRepresentationId: "00000000-0000-4000-8000-000000000012",
            mappingStatus: "approved",
          },
        })
      )
      yield* Effect.promise(() =>
        expect(
          taxmaxi.assets.approveProviderAsset({
            id: providerAssetId,
            canonicalAssetId: "00000000-0000-4000-8000-000000000011",
            assetRepresentationId: "00000000-0000-4000-8000-000000000012",
            reviewerNotes: "Identity checked.",
          })
        ).resolves.toMatchObject({ mappingStatus: "approved" })
      )

      expect(capturedRequests).toEqual([
        expect.objectContaining({
          url: "https://sdk.example.test/v1/assets/provider-assets?provider=coinbase&status=excluded&cursor=00000000-0000-4000-8000-000000000008&limit=25",
        }),
        expect.objectContaining({
          url: "https://sdk.example.test/v1/assets/transfer-reconciliations/unresolved?status=pending&cursor=opaque-cursor&limit=25",
        }),
        expect.objectContaining({
          url: "https://sdk.example.test/v1/assets/transfer-reconciliations/unresolved?status=needs_review&limit=10",
        }),
        expect.objectContaining({
          url: "https://sdk.example.test/v1/assets/provider-assets/00000000-0000-4000-8000-000000000009/canonicalize",
        }),
        expect.objectContaining({
          body: encodeJson({
            canonicalAssetId: "00000000-0000-4000-8000-000000000011",
            assetRepresentationId: "00000000-0000-4000-8000-000000000012",
            reviewerNotes: "Identity checked.",
          }),
          url: "https://sdk.example.test/v1/assets/provider-assets/00000000-0000-4000-8000-000000000009/approve",
        }),
      ])
    })
  )

  it.effect("allows browser session callers to omit ambient credentials", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<CapturedRequest> = []
      const taxmaxi = TaxMaxi.fromBrowserSession({
        baseUrl: "https://sdk.example.test",
        credentials: "omit",
        fetch: makeFetch(capturedRequests, sourceCreateResponseBody),
      })

      yield* Effect.promise(() =>
        taxmaxi.sources.create({
          type: "onchain",
          walletAddress: "So11111111111111111111111111111111111111112",
        })
      )

      expect(capturedRequests).toEqual([
        expect.objectContaining({
          credentials: "omit",
          url: "https://sdk.example.test/v1/sources",
        }),
      ])
    })
  )

  it.effect("keeps Effect-native resource methods available", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<CapturedRequest> = []
      const taxmaxi = new TaxMaxi({
        apiKey: "tm_test_phase_2",
        baseUrl: "https://sdk.example.test",
        fetch: makeFetch(capturedRequests, sourceListResponseBody),
      })

      const sources = yield* taxmaxi.effect.sources.list()
      expect(sources).toEqual({
        sources: [],
      })
    })
  )

  it.effect("normalizes Promise method failures into TaxMaxiError", () =>
    Effect.gen(function* () {
      const taxmaxi = new TaxMaxi({
        apiKey: "tm_test_phase_2",
        baseUrl: "https://sdk.example.test",
        fetch: makeFailureFetch(new TypeError("socket closed")),
      })

      const error = yield* Effect.tryPromise({
        try: () => taxmaxi.sources.list(),
        catch: (error) =>
          Schema.is(TaxMaxiError)(error) ? error : new UnexpectedPromiseRejection({ cause: error }),
      }).pipe(Effect.flip)

      expect(Schema.is(TaxMaxiError)(error)).toBe(true)

      if (Schema.is(TaxMaxiError)(error)) {
        expect(error.status).toBe(0)
        expect(error.message).toContain("Could not reach the TaxMaxi API")
      }
    })
  )

  it("preserves UnauthorizedError status when Effect wraps the API error code", () => {
    const error = toTaxMaxiError({
      _tag: "(FiberFailure) UnauthorizedError",
      message: "Anon session required.",
    })

    expect(error).toBeInstanceOf(TaxMaxiError)
    expect(error.code).toBe("(FiberFailure) UnauthorizedError")
    expect(error.message).toBe("Anon session required.")
    expect(error.status).toBe(401)
    expect(isTaxMaxiUnauthorizedError(error)).toBe(true)
  })

  it("recognizes wrapped UnauthorizedError codes even if status was mis-normalized", () => {
    const error = new TaxMaxiError({
      code: "(FiberFailure) UnauthorizedError",
      message: "Anon session required.",
      status: 500,
    })

    expect(isTaxMaxiUnauthorizedError(error)).toBe(true)
  })

  it("extracts structured credit details from a credit-required sync refusal", () => {
    const refusal = {
      _tag: "SourceCreditRequiredError",
      message: "No usable credits available to start a sync.",
      reasonCode: "no_usable_credits",
      availableCredits: 0,
    }
    const wrapped = toTaxMaxiError(refusal)

    expect(getTaxMaxiCreditRequired(wrapped)).toEqual({
      reasonCode: "no_usable_credits",
      availableCredits: 0,
    })
    expect(getTaxMaxiCreditRequired(refusal)).toEqual({
      reasonCode: "no_usable_credits",
      availableCredits: 0,
    })
  })

  it("returns null credit details for unrelated errors", () => {
    expect(getTaxMaxiCreditRequired(new Error("boom"))).toBeNull()
    expect(
      getTaxMaxiCreditRequired(toTaxMaxiError({ _tag: "SourceNotFoundError", message: "gone" }))
    ).toBeNull()
    expect(getTaxMaxiCreditRequired(null)).toBeNull()
  })

  it.each(["stale_revision", "ambiguous_identity", "identity_changed"] as const)(
    "extracts the %s asset decision conflict from a wrapped API error",
    (code) => {
      const cause = {
        _tag: code === "stale_revision" ? "AssetStaleRevisionError" : "AssetDecisionConflictError",
        code,
        ...(code === "stale_revision"
          ? {
              evidenceRevision: 3,
              currentConclusionRevision: "no_current_conclusion",
              currentPolicyEvaluationRevision: "00000000-0000-4000-8000-000000000704",
            }
          : {}),
      }

      expect(getTaxMaxiAssetDecisionConflict(toTaxMaxiError(cause))).toBe(code)
      expect(getTaxMaxiAssetDecisionConflict(cause)).toBe(code)
    }
  )

  it("returns null asset decision conflict details for unrelated errors", () => {
    expect(getTaxMaxiAssetDecisionConflict(new Error("boom"))).toBeNull()
    expect(getTaxMaxiAssetDecisionConflict(null)).toBeNull()
  })

  it.each(["invalid_evidence", "invalid_claim"] as const)(
    "extracts the %s asset decision validation code without treating it as a conflict",
    (code) => {
      const cause = { _tag: "AssetDecisionValidationError", code }

      expect(getTaxMaxiAssetDecisionErrorCode(toTaxMaxiError(cause))).toBe(code)
      expect(getTaxMaxiAssetDecisionErrorCode(cause)).toBe(code)
      expect(getTaxMaxiAssetDecisionConflict(cause)).toBeNull()
    }
  )

  it.effect("builds explicit first-party request clients with cookie headers", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<CapturedRequest> = []
      const taxmaxi = TaxMaxi.fromRequest({
        baseUrl: "https://sdk.example.test",
        cookieHeader: "sid=session-value",
        fetch: makeFetch(capturedRequests, sourceListResponseBody),
      })

      yield* Effect.promise(() => taxmaxi.sources.list())

      expect(capturedRequests).toEqual([
        expect.objectContaining({
          headers: expect.objectContaining({
            cookie: "sid=session-value",
          }),
        }),
      ])
    })
  )
})

describe("public movement correction client registration", () => {
  it.effect("exposes recorded target discovery through the public generated client", () =>
    Effect.gen(function* () {
      const capturedRequests: CapturedRequest[] = []
      const client = yield* TaxMaxi.makeEffectClient({
        apiKey: "synthetic-movement-token",
        baseUrl: "https://sdk.example.test",
        fetch: makeBodyCapturingFetch({
          capturedRequests,
          responseBodies: ['{"targets":[]}'],
          fallbackBody: "{}",
        }),
      })
      const query = yield* Schema.decodeEffect(TransactionOverrideScopeQuery)({ taxYear: "2025" })
      expect(
        yield* client.transactionOverrides.getTransactionOverrideTargets({
          params: { transactionId: "00000000-0000-4000-8000-000000009505" },
          query,
        })
      ).toEqual({ targets: [] })
      expect(capturedRequests).toHaveLength(1)
      expect(capturedRequests[0]?.url).toBe(
        "https://sdk.example.test/v1/transaction-overrides/transactions/00000000-0000-4000-8000-000000009505/targets?taxYear=2025"
      )
      expect(capturedRequests[0]?.headers).toMatchObject({
        authorization: "Bearer synthetic-movement-token",
      })
    })
  )
})

describe("portfolio status error conversion", () => {
  it("recognizes the full decoded 404 schema without guessing from the tag", () => {
    const cause = { _tag: "PortfolioCalculationJobNotFoundResponse", code: "source_job_not_found" }
    expect(toTaxMaxiError(cause)).toMatchObject({ status: 404, code: cause._tag, cause })
    expect(toTaxMaxiError({ ...cause, code: "unrelated" }).status).toBe(500)
  })
})
