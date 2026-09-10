import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { TaxMaxi, TaxMaxiError, type TransactionDetail } from "../src/index.ts"

const TRANSACTION_ID = "00000000-0000-4000-8000-000000009901"
const SOURCE_ID = "00000000-0000-4000-8000-000000009902"
const DETAIL = {
  attention: false,
  transactionId: TRANSACTION_ID,
  timestamp: "2025-03-01T00:00:00.000Z",
  source: { sourceId: SOURCE_ID, name: "Synthetic wallet", kind: "onchain" },
  sourceRawRecordId: null,
  transactionType: "sell",
  providerTransactionType: null,
  description: null,
  externalId: null,
  classificationHistoryStatus: "unavailable",
  sourceEvidence: [],
  movements: [],
  reconciliations: [],
  movementOverrides: [],
  assetOverrides: [],
  calculation: {
    run: null,
    state: "partial",
    monetaryStatus: "unavailable",
    derivedLots: [],
    allocations: [],
    income: [],
    blockers: [],
    processedEventIds: [],
    correctionInputs: [],
  },
} as const satisfies TransactionDetail

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const makeFetch =
  ({
    body,
    status = 200,
    requests,
  }: {
    readonly body: unknown
    readonly status?: number
    readonly requests: Array<{
      readonly url: string
      readonly headers: Headers
      readonly credentials: string | undefined
    }>
  }): typeof globalThis.fetch =>
  (input, init) => {
    requests.push({
      url: input instanceof Request ? input.url : String(input),
      headers: new Headers(init?.headers),
      credentials: init?.credentials,
    })
    return Promise.resolve(
      new Response(encodeJson(body), { status, headers: { "Content-Type": "application/json" } })
    )
  }

const READ = { transactionId: TRANSACTION_ID, taxYear: 2025 }

describe("transaction detail SDK", () => {
  it.effect("encodes the explicit ID/year and preserves unknown results in both SDK styles", () =>
    Effect.gen(function* () {
      const requests: Array<{ url: string; headers: Headers; credentials: string | undefined }> = []
      const client = TaxMaxi.fromBrowserSession({
        baseUrl: "https://sdk.example.test",
        fetch: makeFetch({ body: DETAIL, requests }),
      })
      expect(yield* client.effect.transactions.get(READ)).toEqual(DETAIL)
      expect(yield* Effect.promise(() => client.transactions.get(READ))).toEqual(DETAIL)
      expect(requests.map((request) => request.url)).toEqual([
        `https://sdk.example.test/v1/transactions/${TRANSACTION_ID}?taxYear=2025`,
        `https://sdk.example.test/v1/transactions/${TRANSACTION_ID}?taxYear=2025`,
      ])
      expect(requests.map((request) => request.credentials)).toEqual(["include", "include"])
    })
  )

  it.effect("preserves explicit attention independently of unavailable calculation values", () =>
    Effect.gen(function* () {
      const requests: Array<{ url: string; headers: Headers; credentials: string | undefined }> = []
      const detail = { ...DETAIL, attention: true }
      const client = TaxMaxi.fromBrowserSession({
        baseUrl: "https://sdk.example.test",
        fetch: makeFetch({ body: detail, requests }),
      })
      for (const response of [
        yield* client.effect.transactions.get(READ),
        yield* Effect.promise(() => client.transactions.get(READ)),
      ]) {
        expect(response.attention).toBe(true)
        expect(response.calculation.run).toBeNull()
        expect(response.calculation.monetaryStatus).toBe("unavailable")
      }
    })
  )

  it.effect("retains the not-found tag and machine code across Effect and Promise failures", () =>
    Effect.gen(function* () {
      const failure = { _tag: "TransactionNotFoundError", code: "transaction_not_found" }
      const client = new TaxMaxi({
        apiKey: "synthetic",
        fetch: makeFetch({ body: failure, status: 404, requests: [] }),
      })
      const effectError = yield* client.effect.transactions.get(READ).pipe(Effect.flip)
      expect(effectError).toMatchObject(failure)
      const promiseError = yield* Effect.promise(() =>
        client.transactions.get(READ).catch((error: unknown) => error)
      )
      expect(Schema.is(TaxMaxiError)(promiseError)).toBe(true)
      expect(promiseError).toMatchObject({
        status: 404,
        code: "TransactionNotFoundError",
        cause: failure,
      })
    })
  )

  it.effect("rejects invalid years before sending a request", () =>
    Effect.gen(function* () {
      const requests: Array<{ url: string; headers: Headers; credentials: string | undefined }> = []
      const client = new TaxMaxi({
        apiKey: "synthetic",
        fetch: makeFetch({ body: DETAIL, requests }),
      })
      for (const taxYear of [2025.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        const error = yield* client.effect.transactions.get({ ...READ, taxYear }).pipe(Effect.flip)
        expect(Schema.isSchemaError(error)).toBe(true)
      }
      expect(requests).toHaveLength(0)
    })
  )
})
