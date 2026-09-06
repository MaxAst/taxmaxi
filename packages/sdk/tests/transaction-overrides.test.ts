import { describe, expect, it } from "@effect/vitest"
import * as Fiber from "effect/Fiber"
import * as DateTime from "effect/DateTime"
import * as Scope from "effect/Scope"
import * as Exit from "effect/Exit"
import * as Latch from "effect/Latch"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  TaxMaxi,
  getTaxMaxiTransactionOverrideError,
  toTaxMaxiError,
  type TransactionOverrideCurrent,
  type TransactionOverrideCreateError,
  type TransactionOverrideCreateInput,
  type TransactionOverrideMutationResult,
  type TransactionOverrideSet,
} from "../src/index.ts"

const IDS = {
  principal: "00000000-0000-4000-8000-000000009501",
  source: "00000000-0000-4000-8000-000000009502",
  target: "00000000-0000-4000-8000-000000009503",
  leg: "00000000-0000-4000-8000-000000009504",
  transaction: "00000000-0000-4000-8000-000000009505",
  asset: "00000000-0000-4000-8000-000000009506",
  actor: "00000000-0000-4000-8000-000000009507",
  price: "00000000-0000-4000-8000-000000009508",
  classification: "00000000-0000-4000-8000-000000009509",
  job: "00000000-0000-4000-8000-000000009510",
  run: "00000000-0000-4000-8000-000000009511",
  withdrawal: "00000000-0000-4000-8000-000000009512",
  replacement: "00000000-0000-4000-8000-000000009513",
} as const

const TIME = "2025-03-01T00:00:00.000Z"
const JSON_VALUE = Schema.fromJsonString(Schema.Unknown)
const encodeJson = Schema.encodeSync(JSON_VALUE)
const decodeJson = Schema.decodeSync(JSON_VALUE)
const TARGET = {
  principalId: IDS.principal,
  sourceId: IDS.source,
  sourceRecordKey: "synthetic-purchase",
  componentKey: "amount",
} as const
const FACTS = {
  target: TARGET,
  systemRevision: "synthetic-eur-revision",
  quantity: "3",
  economicAssetId: IDS.asset,
  direction: "inbound",
  structure: "ownership_change",
} as const
const SYSTEM = {
  occurredAt: TIME,
  legKind: "acquisition",
  recordedFiatAmount: null,
  recordedFiatCurrency: null,
  transactionType: "unknown",
  providerTransactionType: "synthetic_unknown",
  derivationRule: null,
  feeForSourceRecordKey: null,
} as const
const EVENT = {
  _tag: "acquisition",
  id: IDS.leg,
  occurredAt: { epochMillis: DateTime.toEpochMillis(DateTime.makeUnsafe(TIME)) },
  assetId: IDS.asset,
  quantity: "3",
  custodySourceId: IDS.source,
  cause: "unknown",
  transactionReference: `transaction:${IDS.transaction}`,
} as const
const LEG = {
  targetId: IDS.target,
  legId: IDS.leg,
  sourceId: IDS.source,
  transactionId: IDS.transaction,
  occurredAt: TIME,
  quantity: "3",
  storedAssetId: IDS.asset,
  effectiveAssetId: IDS.asset,
  direction: "inbound",
  structure: "ownership_change",
  legKind: "acquisition",
  transactionType: SYSTEM.transactionType,
  providerTransactionType: SYSTEM.providerTransactionType,
  recordedFiatAmount: null,
  recordedFiatCurrency: null,
  providerFiatAmount: null,
  providerFiatCurrency: null,
  derivationRule: null,
  feeForSourceRecordKey: null,
  originKind: "none",
  sourceTransferId: null,
  providerTransferId: null,
  custody: [],
} as const
const EMPTY_STREAM = {
  leaf: null,
  active: null,
  stale: false,
  application: "inactive",
  applicationProblem: null,
  resolvedPrice: null,
  replay: { status: "not_scheduled", processingJobId: null, followUpJobId: null },
  coverage: null,
  coverageStatus: "not_requested",
} as const
const CURRENT = {
  context: {
    targetId: IDS.target,
    target: TARGET,
    current: {
      legId: IDS.leg,
      transactionId: IDS.transaction,
      facts: FACTS,
      system: SYSTEM,
      valuationEvidence: { reportingCurrency: "EUR", facts: [] },
    },
    price: { leaf: null, active: null },
    classification: { leaf: null, active: null },
    history: [],
  },
  scope: { jurisdiction: "DE", taxYear: 2025, reportingCurrency: "EUR" },
  inputs: {
    targetId: IDS.target,
    current: LEG,
    currentOutcome: "included",
    system: { event: EVENT, valuationFacts: [] },
    effective: { event: EVENT, valuationFacts: [] },
    corrections: [],
  },
  price: EMPTY_STREAM,
  classification: EMPTY_STREAM,
  validClassificationInputs: [
    { _tag: "inbound", cause: "purchase" },
    { _tag: "inbound", cause: "passive_staking_reward" },
  ],
} as const satisfies TransactionOverrideCurrent

const PRICE = {
  expectedLeafId: null,
  expectedSystemRevision: FACTS.systemRevision,
  reason: "Synthetic price evidence",
  input: { _tag: "price", input: { _tag: "total_value", amount: "1", currency: "EUR" } },
} as const satisfies TransactionOverrideSet
const PRICE_HISTORY = {
  id: IDS.price,
  principalId: IDS.principal,
  sourceId: IDS.source,
  targetId: IDS.target,
  kind: "price",
  operation: "create",
  inspectedFacts: FACTS,
  inspectedSystem: SYSTEM,
  inspectedValuationEvidence: { reportingCurrency: "EUR", facts: [] },
  input: PRICE.input,
  actorUserId: IDS.actor,
  reason: PRICE.reason,
  supersedesOverrideId: null,
  recordedAt: TIME,
} as const
const CLASS_HISTORY = {
  ...PRICE_HISTORY,
  id: IDS.classification,
  kind: "classification",
  input: { _tag: "classification", input: { _tag: "inbound", cause: "purchase" } },
  reason: "Synthetic ownership assertion",
} as const
const RESOLVED_PRICE = {
  totalValue: "1",
  currency: "EUR",
  unitPrice: { amount: "0.333333333333333333", rounded: true },
} as const
const EFFECTIVE = {
  event: { ...EVENT, cause: "purchase" },
  valuationFacts: [
    {
      _tag: "user_valuation",
      eventId: IDS.leg,
      amount: { amount: "1", currency: "EUR" },
      evidenceReference: `movement-price:${IDS.price}`,
    },
  ],
  classificationEvidence: { _tag: "user_assertion", overrideId: IDS.classification },
} as const
const CAPTURE = {
  history: PRICE_HISTORY,
  current: LEG,
  currentOutcome: "included",
  streamState: "active",
  reportingCurrency: "EUR",
  application: "applied",
  applicationProblem: null,
  resolvedPrice: RESOLVED_PRICE,
  system: CURRENT.inputs.system,
  effective: EFFECTIVE,
} as const
const COVERED = {
  ...CURRENT,
  context: {
    ...CURRENT.context,
    price: { leaf: PRICE_HISTORY, active: PRICE_HISTORY },
    classification: { leaf: CLASS_HISTORY, active: CLASS_HISTORY },
    history: [PRICE_HISTORY, CLASS_HISTORY],
  },
  inputs: {
    ...CURRENT.inputs,
    effective: EFFECTIVE,
    corrections: [CAPTURE, { ...CAPTURE, history: CLASS_HISTORY, resolvedPrice: null }],
  },
  price: {
    ...EMPTY_STREAM,
    leaf: PRICE_HISTORY,
    active: PRICE_HISTORY,
    application: "applied",
    resolvedPrice: RESOLVED_PRICE,
    replay: { status: "complete", processingJobId: IDS.job, followUpJobId: null },
    coverageStatus: "covered",
    coverage: {
      runId: IDS.run,
      status: "complete",
      failureCode: null,
      overrideId: IDS.price,
      input: {
        application: "applied",
        applicationProblem: null,
        resolvedPrice: RESOLVED_PRICE,
        system: CURRENT.inputs.system,
        effective: EFFECTIVE,
      },
    },
  },
  classification: {
    ...EMPTY_STREAM,
    leaf: CLASS_HISTORY,
    active: CLASS_HISTORY,
    application: "applied",
    replay: { status: "updating", processingJobId: IDS.job, followUpJobId: null },
    coverageStatus: "updating",
  },
} as const satisfies TransactionOverrideCurrent

const ACCEPTED = {
  context: {
    ...CURRENT.context,
    price: { leaf: PRICE_HISTORY, active: PRICE_HISTORY },
    history: [PRICE_HISTORY],
  },
  overrideId: IDS.price,
  sourceId: IDS.source,
  processingJobId: IDS.job,
} as const satisfies TransactionOverrideMutationResult

const REPLACEMENT_INPUT = {
  ...PRICE,
  expectedLeafId: IDS.price,
  input: { _tag: "price", input: { _tag: "unit_price", amount: "2", currency: "EUR" } },
} as const
const REPLACEMENT_HISTORY = {
  ...PRICE_HISTORY,
  id: IDS.replacement,
  operation: "replace",
  input: REPLACEMENT_INPUT.input,
  supersedesOverrideId: IDS.price,
} as const
const REPLACED = {
  ...ACCEPTED,
  overrideId: IDS.replacement,
  context: {
    ...ACCEPTED.context,
    price: { leaf: REPLACEMENT_HISTORY, active: REPLACEMENT_HISTORY },
    history: [PRICE_HISTORY, REPLACEMENT_HISTORY],
  },
} as const satisfies TransactionOverrideMutationResult
const WITHDRAWAL_HISTORY = {
  ...PRICE_HISTORY,
  id: IDS.withdrawal,
  operation: "withdraw",
  reason: "Synthetic withdrawal",
  input: null,
  supersedesOverrideId: IDS.replacement,
} as const
const WITHDRAWN = {
  ...ACCEPTED,
  overrideId: IDS.withdrawal,
  context: {
    ...ACCEPTED.context,
    price: { leaf: WITHDRAWAL_HISTORY, active: null },
    history: [PRICE_HISTORY, REPLACEMENT_HISTORY, WITHDRAWAL_HISTORY],
  },
} as const satisfies TransactionOverrideMutationResult

class CaughtPromiseError extends Data.TaggedError("CaughtPromiseError")<{
  readonly cause: unknown
}> {}

type CapturedRequest = {
  readonly url: string
  readonly method: string
  readonly body: unknown
  readonly headers: Headers
  readonly credentials: string | undefined
}

const makeFetch = ({
  captured = [],
  bodies = [CURRENT],
  status = 200,
}: {
  readonly captured?: CapturedRequest[]
  readonly bodies?: ReadonlyArray<unknown>
  readonly status?: number
} = {}): typeof globalThis.fetch => {
  let index = 0
  return (input, init) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const body =
          init?.body === undefined
            ? undefined
            : yield* Effect.promise(() => new Response(init.body).text())
        captured.push({
          url:
            typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
          method: init?.method ?? "GET",
          body: body === undefined || body === "" ? undefined : decodeJson(body),
          headers: new Headers(init?.headers),
          credentials: init?.credentials,
        })
        const response = bodies[index++]
        if (response === undefined) return yield* Effect.die("Unexpected synthetic SDK request")
        return new Response(encodeJson(response), {
          status,
          headers: { "Content-Type": "application/json" },
        })
      })
    )
}

const makeAbortableFetch =
  ({
    started,
    signals,
  }: {
    readonly started: Latch.Latch
    readonly signals: Array<AbortSignal | undefined>
  }): typeof globalThis.fetch =>
  (_input, init) =>
    Effect.runPromise(
      Effect.callback<Response, DOMException>((resume) => {
        const signal = init?.signal ?? undefined
        signals.push(signal)
        started.openUnsafe()
        if (signal === undefined) return
        const onAbort = () => resume(Effect.fail(new DOMException("Request aborted", "AbortError")))
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener("abort", onAbort, { once: true })
        return Effect.sync(() => signal.removeEventListener("abort", onAbort))
      })
    )

const read = { targetId: IDS.target, taxYear: 2025 }
const create = { targetId: IDS.target, override: PRICE } satisfies TransactionOverrideCreateInput

const catchPromise = <A>(effect: () => Promise<A>) =>
  Effect.tryPromise({ try: effect, catch: (cause) => new CaughtPromiseError({ cause }) }).pipe(
    Effect.flip
  )

describe("movement correction SDK resources", () => {
  for (const style of ["Effect", "Promise"] as const) {
    it.effect(`supports all six ${style} methods with exact request and response facts`, () =>
      Effect.gen(function* () {
        const captured: CapturedRequest[] = []
        const client = new TaxMaxi({
          apiKey: "synthetic-sdk-token",
          baseUrl: "https://sdk.example.test/",
          fetch: makeFetch({
            captured,
            bodies: [{ targets: [COVERED] }, COVERED, COVERED, ACCEPTED, REPLACED, WITHDRAWN],
          }),
        })
        const replacement = REPLACEMENT_INPUT
        const withdrawal = {
          expectedLeafId: IDS.replacement,
          expectedSystemRevision: FACTS.systemRevision,
          reason: "Synthetic withdrawal",
          kind: "price",
        } as const
        const targets =
          style === "Effect"
            ? yield* client.effect.transactionOverrides.getTargets({
                transactionId: IDS.transaction,
                taxYear: 2025,
              })
            : yield* Effect.promise(() =>
                client.transactionOverrides.getTargets({
                  transactionId: IDS.transaction,
                  taxYear: 2025,
                })
              )
        const current =
          style === "Effect"
            ? yield* client.effect.transactionOverrides.getCurrent(read)
            : yield* Effect.promise(() => client.transactionOverrides.getCurrent(read))
        const history =
          style === "Effect"
            ? yield* client.effect.transactionOverrides.getHistory(read)
            : yield* Effect.promise(() => client.transactionOverrides.getHistory(read))
        const created =
          style === "Effect"
            ? yield* client.effect.transactionOverrides.create(create)
            : yield* Effect.promise(() => client.transactionOverrides.create(create))
        const replaced =
          style === "Effect"
            ? yield* client.effect.transactionOverrides.replace({
                targetId: IDS.target,
                replacement,
              })
            : yield* Effect.promise(() =>
                client.transactionOverrides.replace({ targetId: IDS.target, replacement })
              )
        const withdrawn =
          style === "Effect"
            ? yield* client.effect.transactionOverrides.withdraw({
                targetId: IDS.target,
                withdrawal,
              })
            : yield* Effect.promise(() =>
                client.transactionOverrides.withdraw({ targetId: IDS.target, withdrawal })
              )
        expect(targets).toEqual({ targets: [COVERED] })
        expect(current).toEqual(COVERED)
        expect(history).toEqual(COVERED)
        expect([created, replaced, withdrawn]).toEqual([ACCEPTED, REPLACED, WITHDRAWN])
        expect(current.price.resolvedPrice).toEqual(RESOLVED_PRICE)
        expect(current.inputs.effective.classificationEvidence).toEqual({
          _tag: "user_assertion",
          overrideId: IDS.classification,
        })
        expect(captured.map((row) => new URL(row.url).pathname)).toEqual([
          `/v1/transaction-overrides/transactions/${IDS.transaction}/targets`,
          ...["current", "history", "create", "replace", "withdraw"].map(
            (action) => `/v1/transaction-overrides/${IDS.target}/${action}`
          ),
        ])
        expect(captured.map((row) => row.method)).toEqual([
          "GET",
          "GET",
          "GET",
          "POST",
          "POST",
          "POST",
        ])
        expect(captured.map((row) => Object.fromEntries(new URL(row.url).searchParams))).toEqual([
          { taxYear: "2025" },
          { taxYear: "2025" },
          { taxYear: "2025" },
          {},
          {},
          {},
        ])
        expect(captured.slice(3).map((row) => row.body)).toEqual([PRICE, replacement, withdrawal])
        expect(
          captured.every((row) => row.headers.get("authorization") === "Bearer synthetic-sdk-token")
        ).toBe(true)
      })
    )
  }

  for (const amount of [
    "0",
    "9007199254740993.12345678901234567890123456789",
    "0.000000000000000000000000000001",
  ]) {
    for (const mode of ["total_value", "unit_price"] as const) {
      it.effect(`preserves ${mode} decimal text ${amount} and the explicit withdrawal leaf`, () =>
        Effect.gen(function* () {
          const captured: CapturedRequest[] = []
          const input = { _tag: "price", input: { _tag: mode, amount, currency: "EUR" } } as const
          const record = { ...PRICE_HISTORY, input, supersedesOverrideId: IDS.withdrawal }
          const response = {
            ...ACCEPTED,
            context: {
              ...ACCEPTED.context,
              price: { leaf: record, active: record },
              history: [record],
            },
          }
          const client = new TaxMaxi({
            apiKey: "synthetic",
            fetch: makeFetch({ captured, bodies: [response] }),
          })
          const result = yield* client.effect.transactionOverrides.create({
            targetId: IDS.target,
            override: { ...PRICE, expectedLeafId: IDS.withdrawal, input },
          })
          expect(result.context.price.active?.input).toEqual(input)
          expect(captured[0]?.body).toEqual({ ...PRICE, expectedLeafId: IDS.withdrawal, input })
        })
      )
    }
  }

  for (const error of [
    { status: 404, body: { _tag: "TransactionOverrideNotFoundError", code: "target_not_found" } },
    { status: 403, body: { _tag: "TransactionOverrideReadonlyError", code: "readonly_user" } },
    {
      status: 409,
      body: {
        _tag: "TransactionOverrideConflictError",
        code: "override_conflict",
        conflictKinds: ["stream_leaf", "system_revision"],
        currentContext: COVERED.context,
      },
    },
    {
      status: 422,
      body: { _tag: "TransactionOverrideValidationError", code: "reporting_currency_mismatch" },
    },
    {
      status: 422,
      body: { _tag: "TransactionOverrideValidationError", code: "target_unavailable" },
    },
  ] as const) {
    it.effect(`preserves typed ${error.status} ${error.body.code} details in both styles`, () =>
      Effect.gen(function* () {
        const client = new TaxMaxi({
          apiKey: "synthetic",
          fetch: makeFetch({ status: error.status, bodies: [error.body, error.body] }),
        })
        const effectError: TransactionOverrideCreateError =
          yield* client.effect.transactionOverrides.create(create).pipe(Effect.flip)
        expect(effectError).toMatchObject(error.body)
        expect(getTaxMaxiTransactionOverrideError(effectError)).toMatchObject(error.body)
        const promiseError = yield* catchPromise(() => client.transactionOverrides.create(create))
        expect(promiseError.cause).toMatchObject({ status: error.status })
        expect(getTaxMaxiTransactionOverrideError(promiseError.cause)).toMatchObject(error.body)
        expect(getTaxMaxiTransactionOverrideError(error.body)).toMatchObject(error.body)
        expect(toTaxMaxiError(error.body).status).toBe(error.status)
        expect(getTaxMaxiTransactionOverrideError(toTaxMaxiError(effectError))).toMatchObject(
          error.body
        )
      })
    )
  }

  it.effect("requires valid explicit years and payloads before issuing a request", () =>
    Effect.gen(function* () {
      const captured: CapturedRequest[] = []
      const client = new TaxMaxi({
        apiKey: "synthetic",
        fetch: makeFetch({ captured, bodies: [] }),
      })
      for (const taxYear of [0, -1, 2025.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(
          Schema.isSchemaError(
            yield* client.effect.transactionOverrides
              .getCurrent({ ...read, taxYear })
              .pipe(Effect.flip)
          )
        ).toBe(true)
        expect(
          Schema.isSchemaError(
            yield* client.effect.transactionOverrides
              .getTargets({ transactionId: IDS.transaction, taxYear })
              .pipe(Effect.flip)
          )
        ).toBe(true)
      }
      expect(
        Schema.isSchemaError(
          yield* client.effect.transactionOverrides
            .create({ ...create, override: { ...PRICE, reason: "" } })
            .pipe(Effect.flip)
        )
      ).toBe(true)
      const promiseError = yield* catchPromise(() =>
        client.transactionOverrides.replace({
          targetId: IDS.target,
          replacement: {
            ...PRICE,
            input: { _tag: "price", input: { _tag: "total_value", amount: "-1", currency: "EUR" } },
          },
        })
      )
      expect(promiseError.cause).toMatchObject({ status: 400, code: "ParseError" })
      expect(captured).toEqual([])
      expect(
        getTaxMaxiTransactionOverrideError({
          _tag: "TransactionOverrideConflictError",
          code: "override_conflict",
        })
      ).toBeNull()
      expect(getTaxMaxiTransactionOverrideError("unrelated")).toBeNull()
    })
  )

  it.effect(
    "keeps browser credentials, forwarded cookies and dynamic headers on the shared request path",
    () =>
      Effect.gen(function* () {
        const captured: CapturedRequest[] = []
        let headerCount = 0
        const browser = TaxMaxi.fromBrowserSession({
          baseUrl: "https://sdk.example.test",
          fetch: makeFetch({ captured, bodies: [CURRENT, CURRENT] }),
          headers: () => ({ "x-synthetic-request": String(++headerCount) }),
        })
        yield* browser.effect.transactionOverrides.getCurrent(read)
        yield* Effect.promise(() => browser.transactionOverrides.getHistory(read))
        const server = TaxMaxi.fromRequest({
          cookieHeader: "synthetic_session=opaque",
          fetch: makeFetch({ captured, bodies: [ACCEPTED] }),
        })
        yield* Effect.promise(() => server.transactionOverrides.create(create))
        expect(captured.map((row) => row.credentials)).toEqual(["include", "include", undefined])
        expect(captured.slice(0, 2).map((row) => row.headers.get("x-synthetic-request"))).toEqual([
          "1",
          "2",
        ])
        expect(captured[2]?.headers.get("cookie")).toBe("synthetic_session=opaque")
        expect(captured.every((row) => row.headers.get("authorization") === null)).toBe(true)
      })
  )

  it.effect("passes Promise cancellation through to fetch without a second request", () =>
    Effect.gen(function* () {
      const signals: Array<AbortSignal | undefined> = []
      const started = yield* Latch.make()
      const client = new TaxMaxi({
        apiKey: "synthetic",
        fetch: makeAbortableFetch({ started, signals }),
      })
      const scope = yield* Scope.make()
      const signal = yield* Effect.abortSignal.pipe(Scope.provide(scope))
      const rejected = client.transactionOverrides.getCurrent(read, { signal }).then(
        () => "unexpected-success",
        (cause) => cause
      )
      yield* started.await
      yield* Scope.close(scope, Exit.void)
      yield* Effect.promise(() => rejected)
      expect(signals[0]?.aborted).toBe(true)
      expect(signals).toHaveLength(1)
    })
  )
  it.effect("interrupts Effect requests through the same fetch cancellation path", () =>
    Effect.gen(function* () {
      const signals: Array<AbortSignal | undefined> = []
      const started = yield* Latch.make()
      const client = new TaxMaxi({
        apiKey: "synthetic",
        fetch: makeAbortableFetch({ started, signals }),
      })
      const fiber = yield* Effect.forkChild(client.effect.transactionOverrides.getHistory(read))
      yield* started.await
      yield* Fiber.interrupt(fiber)
      expect(signals[0]?.aborted).toBe(true)
      expect(signals).toHaveLength(1)
    }).pipe(Effect.scoped)
  )

  it.effect(
    "preserves user-asserted classification payloads and the independent price stream",
    () =>
      Effect.gen(function* () {
        const captured: CapturedRequest[] = []
        const payload = { ...PRICE, reason: CLASS_HISTORY.reason, input: CLASS_HISTORY.input }
        const response = { ...ACCEPTED, overrideId: IDS.classification, context: COVERED.context }
        const client = new TaxMaxi({
          apiKey: "synthetic",
          fetch: makeFetch({ captured, bodies: [response] }),
        })
        const result = yield* client.effect.transactionOverrides.create({
          targetId: IDS.target,
          override: payload,
        })
        expect(result.overrideId).toBe(IDS.classification)
        expect(result.context.classification.active?.input).toEqual(CLASS_HISTORY.input)
        expect(result.context.price.active?.id).toBe(IDS.price)
        expect(captured[0]?.body).toEqual(payload)
      })
  )
})
