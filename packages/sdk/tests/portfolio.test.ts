import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  TaxMaxi,
  TaxMaxiError,
  type PortfolioCalculationStatus,
  type PortfolioCalculationStatusError,
} from "../src/index.ts"

const JOB_ID = "00000000-0000-4000-8000-000000009901"
const SOURCE_ID = "00000000-0000-4000-8000-000000009902"
const REQUEST = {
  requestId: "request-1",
  sourceId: SOURCE_ID,
  sourceJobId: JOB_ID,
  status: "failed",
  attempts: [
    { attemptId: "attempt-1", runId: "run-1", status: "failed", failureCode: "stale_run" },
    { attemptId: "attempt-2", runId: null, status: "failed", failureCode: "preparation_failed" },
  ],
} as const
const STATUS = {
  scope: { jurisdiction: "DE", taxYear: 2024, reportingCurrency: "EUR" },
  activeRun: { runId: "active-0", status: "partial" },
  work: { status: "failed", requests: [REQUEST] },
  jobs: [
    {
      sourceJobId: JOB_ID,
      sourceId: SOURCE_ID,
      sourceJobStatus: "completed",
      work: REQUEST,
      coveringRun: null,
      activeCoverage: "unknown",
    },
  ],
} as const satisfies PortfolioCalculationStatus
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const makeFetch =
  ({
    body,
    status = 200,
    requests,
  }: {
    readonly body: unknown
    readonly status?: number
    readonly requests: string[]
  }): typeof globalThis.fetch =>
  (input) => {
    requests.push(input instanceof Request ? input.url : String(input))
    return Promise.resolve(
      new Response(encodeJson(body), { status, headers: { "Content-Type": "application/json" } })
    )
  }

describe("portfolio calculation status SDK", () => {
  it.effect("preserves exact work, attempt, run, null and failure fields in both styles", () =>
    Effect.gen(function* () {
      const requests: string[] = []
      const client = new TaxMaxi({
        apiKey: "synthetic",
        baseUrl: "https://sdk.example.test",
        fetch: makeFetch({ body: STATUS, requests }),
      })
      expect(yield* client.effect.portfolio.getCalculationStatus({ taxYear: 2024 })).toStrictEqual(
        STATUS
      )
      expect(
        yield* Effect.promise(() =>
          client.portfolio.getCalculationStatus({ taxYear: 2024, sourceJobId: JOB_ID })
        )
      ).toStrictEqual(STATUS)
      expect(requests).toEqual([
        "https://sdk.example.test/v1/portfolio/calculation-status?taxYear=2024",
        `https://sdk.example.test/v1/portfolio/calculation-status?taxYear=2024&sourceJobId=${JOB_ID}`,
      ])
    })
  )

  it.effect("retains the route's typed not-found failure and Promise 404", () =>
    Effect.gen(function* () {
      const failure = {
        _tag: "PortfolioCalculationJobNotFoundResponse",
        code: "source_job_not_found",
      }
      const client = new TaxMaxi({
        apiKey: "synthetic",
        fetch: makeFetch({ body: failure, status: 404, requests: [] }),
      })
      const effectError: PortfolioCalculationStatusError = yield* client.effect.portfolio
        .getCalculationStatus({ taxYear: 2024, sourceJobId: JOB_ID })
        .pipe(Effect.flip)
      expect(effectError).toMatchObject(failure)
      const promiseError = yield* Effect.promise(() =>
        client.portfolio
          .getCalculationStatus({ taxYear: 2024, sourceJobId: JOB_ID })
          .catch((error: unknown) => error)
      )
      expect(promiseError).toBeInstanceOf(TaxMaxiError)
      expect(promiseError).toMatchObject({ status: 404, code: failure._tag, cause: failure })
    })
  )

  it.effect("rejects malformed year or job inputs with typed 400 before HTTP", () =>
    Effect.gen(function* () {
      const requests: string[] = []
      const client = new TaxMaxi({
        apiKey: "synthetic",
        fetch: makeFetch({ body: STATUS, requests }),
      })
      for (const input of [
        { taxYear: 2024.5 },
        { taxYear: Number.NaN },
        { taxYear: Number.POSITIVE_INFINITY },
        { taxYear: 2024, sourceJobId: "bad-id" },
      ]) {
        const error = yield* client.effect.portfolio.getCalculationStatus(input).pipe(Effect.flip)
        expect(Schema.isSchemaError(error)).toBe(true)
        const promiseError = yield* Effect.promise(() =>
          client.portfolio.getCalculationStatus(input).catch((error: unknown) => error)
        )
        expect(promiseError).toMatchObject({ status: 400, code: "ParseError" })
      }
      expect(requests).toEqual([])
    })
  )
})
