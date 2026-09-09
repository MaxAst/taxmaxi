// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query"
import { useRef, useState, type ComponentProps } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  TaxMaxi,
  TaxMaxiError,
  type TransactionDetail,
  type PortfolioCalculationStatus,
} from "taxmaxi"
import { queries, refreshTransactionQueries } from "#/integrations/taxmaxi/queries"
import { setLocale } from "#/paraglide/runtime"
import { TransactionInspector } from "#/components/transaction-inspector"

const IDS = {
  transaction: "00000000-0000-4000-8000-000000009501",
  other: "00000000-0000-4000-8000-000000009502",
  source: "00000000-0000-4000-8000-000000009503",
  principal: "00000000-0000-4000-8000-000000009504",
  target: "00000000-0000-4000-8000-000000009505",
  leg: "00000000-0000-4000-8000-000000009506",
  asset: "00000000-0000-4000-8000-000000009507",
  actor: "00000000-0000-4000-8000-000000009508",
  oldPrice: "00000000-0000-4000-8000-000000009509",
  price: "00000000-0000-4000-8000-000000009510",
  classification: "00000000-0000-4000-8000-000000009511",
  withdrawal: "00000000-0000-4000-8000-000000009512",
  raw: "00000000-0000-4000-8000-000000009513",
  providerAsset: "00000000-0000-4000-8000-000000009514",
  run: "00000000-0000-4000-8000-000000009515",
  job: "00000000-0000-4000-8000-000000009516",
  assetOverride: "00000000-0000-4000-8000-000000009517",
  replacementAsset: "00000000-0000-4000-8000-000000009518",
}
const TIME = "2025-03-01T00:00:00.000Z"
type Correction = TransactionDetail["movementOverrides"][number]
type History = Correction["context"]["history"][number]
type Inputs = Correction["inputs"]["system"]
type AssetProjection = NonNullable<TransactionDetail["assetOverrides"][number]["projection"]>
type Selection = NonNullable<ComponentProps<typeof TransactionInspector>["selection"]>
const SELECTION: Selection = {
  transactionId: IDS.transaction,
  taxYear: 2025,
  description: "Imported purchase",
}

function richDetail(currentTotal: "1" | "30" = "1"): TransactionDetail {
  const unitPrice =
    currentTotal === "1"
      ? { amount: "0.333333333333333333", rounded: true }
      : { amount: "10", rounded: false }
  const target: Correction["context"]["target"] = {
    principalId: IDS.principal,
    sourceId: IDS.source,
    sourceRecordKey: "purchase-3",
    componentKey: "amount",
  }
  const facts: History["inspectedFacts"] = {
    target,
    systemRevision: "original-provider-facts",
    quantity: "3",
    economicAssetId: IDS.replacementAsset,
    direction: "inbound",
    structure: "ownership_change",
  }
  const system: History["inspectedSystem"] = {
    occurredAt: TIME,
    legKind: "acquisition",
    recordedFiatAmount: null,
    recordedFiatCurrency: null,
    transactionType: "unknown",
    providerTransactionType: "provider-buy",
    derivationRule: null,
    feeForSourceRecordKey: null,
  }
  const systemInputs: Inputs = {
    event: {
      _tag: "acquisition",
      id: IDS.leg,
      occurredAt: { epochMillis: Date.parse(TIME) },
      assetId: IDS.replacementAsset,
      quantity: "3",
      custodySourceId: IDS.source,
      cause: "unknown",
      transactionReference: `transaction:${IDS.transaction}`,
    },
    valuationFacts: [],
  }
  const effectiveInputs = (amount: string, overrideId: string): Inputs => ({
    ...systemInputs,
    valuationFacts: [
      {
        _tag: "user_valuation",
        eventId: IDS.leg,
        amount: { amount, currency: "EUR" },
        evidenceReference: `movement-price:${overrideId}`,
      },
    ],
  })
  const oldPrice: History = {
    id: IDS.oldPrice,
    principalId: IDS.principal,
    sourceId: IDS.source,
    targetId: IDS.target,
    kind: "price",
    operation: "create",
    inspectedFacts: facts,
    inspectedSystem: system,
    inspectedValuationEvidence: { reportingCurrency: "EUR", facts: [] },
    input: { _tag: "price", input: { _tag: "total_value", amount: "20", currency: "EUR" } },
    actorUserId: IDS.actor,
    reason: "Original receipt total",
    supersedesOverrideId: null,
    recordedAt: TIME,
  }
  const price: History = {
    ...oldPrice,
    id: IDS.price,
    operation: "replace",
    input: { _tag: "price", input: { _tag: "total_value", amount: currentTotal, currency: "EUR" } },
    reason: "Corrected receipt total",
    supersedesOverrideId: IDS.oldPrice,
    recordedAt: "2025-03-03T00:00:00.000Z",
  }
  const classification: History = {
    ...oldPrice,
    id: IDS.classification,
    kind: "classification",
    input: { _tag: "classification", input: { _tag: "inbound", cause: "purchase" } },
    reason: "Receipt established purchase",
  }
  const withdrawal: History = {
    ...classification,
    id: IDS.withdrawal,
    operation: "withdraw",
    input: null,
    reason: "Withdraw disputed classification",
    supersedesOverrideId: IDS.classification,
    recordedAt: "2025-03-04T00:00:00.000Z",
  }
  const current: NonNullable<Correction["inputs"]["current"]> = {
    targetId: IDS.target,
    legId: IDS.leg,
    sourceId: IDS.source,
    transactionId: IDS.transaction,
    occurredAt: TIME,
    quantity: "3",
    storedAssetId: IDS.asset,
    effectiveAssetId: IDS.replacementAsset,
    direction: "inbound",
    structure: "ownership_change",
    legKind: "acquisition",
    transactionType: "unknown",
    providerTransactionType: "provider-buy",
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
  }
  const captured: TransactionDetail["calculation"]["correctionInputs"][number] = {
    history: oldPrice,
    current,
    currentOutcome: "included",
    streamState: "active",
    reportingCurrency: "EUR",
    application: "applied",
    applicationProblem: null,
    resolvedPrice: {
      totalValue: "20",
      currency: "EUR",
      unitPrice: { amount: "6.666666666666666667", rounded: true },
    },
    system: systemInputs,
    effective: effectiveInputs("20", IDS.oldPrice),
  }
  const inactive: Correction["classification"] = {
    leaf: withdrawal,
    active: null,
    stale: false,
    application: "inactive",
    applicationProblem: null,
    resolvedPrice: null,
    replay: { status: "updating", processingJobId: IDS.job, followUpJobId: null },
    coverage: null,
    coverageStatus: "updating",
  }
  const correction: Correction = {
    context: {
      targetId: IDS.target,
      target,
      current: {
        legId: IDS.leg,
        transactionId: IDS.transaction,
        facts,
        system,
        valuationEvidence: { reportingCurrency: "EUR", facts: [] },
      },
      price: { leaf: price, active: price },
      classification: { leaf: withdrawal, active: null },
      history: [oldPrice, price, classification, withdrawal],
    },
    scope: { jurisdiction: "DE", taxYear: 2025, reportingCurrency: "EUR" },
    inputs: {
      targetId: IDS.target,
      current,
      currentOutcome: "included",
      system: systemInputs,
      effective: effectiveInputs(currentTotal, IDS.price),
      corrections: [
        {
          ...captured,
          history: price,
          effective: effectiveInputs(currentTotal, IDS.price),
          resolvedPrice: {
            totalValue: currentTotal,
            currency: "EUR",
            unitPrice,
          },
        },
      ],
    },
    price: {
      ...inactive,
      leaf: price,
      active: price,
      application: "applied",
      resolvedPrice: {
        totalValue: currentTotal,
        currency: "EUR",
        unitPrice,
      },
    },
    classification: inactive,
    validClassificationInputs: [{ _tag: "inbound", cause: "purchase" }],
  }
  const assetHistory: AssetProjection["history"][number] = {
    id: IDS.assetOverride,
    kind: "identity",
    operation: "create",
    inspectedSystemRevision: "asset-system-1",
    inspectedSystemIdentity: { _tag: "resolved", assetId: IDS.asset },
    inspectedSystemInclusion: null,
    replacementIdentity: { _tag: "resolved", assetId: IDS.replacementAsset },
    replacementInclusion: null,
    actorUserId: IDS.actor,
    reason: "Use the reviewed economic asset",
    supersedesOverrideId: null,
    recordedAt: TIME,
  }
  const projection: AssetProjection = {
    target: { _tag: "provider_asset", providerAssetRowId: IDS.providerAsset },
    system: {
      identity: { _tag: "resolved", assetId: IDS.asset },
      identityRevision: "asset-system-1",
      inclusion: "included",
      inclusionRevision: "inclusion-1",
    },
    activeIdentityOverride: assetHistory,
    activeInclusionOverride: null,
    effectiveDecision: { _tag: "included", assetId: IDS.replacementAsset },
    checkedTechnicalBlockerKinds: ["missing_decimals"],
    technicalBlockers: [],
    identityOverrideUsesStaleSystemRevision: false,
    inclusionOverrideUsesStaleSystemRevision: false,
    history: [assetHistory],
    recomputation: { status: "not_scheduled" },
  }
  const evidence: NonNullable<TransactionDetail["sourceEvidence"][number]["evidence"]> = {
    sourceId: IDS.source,
    id: IDS.raw,
    provider: "coinbase",
    recordType: "coinbase_transaction",
    externalRecordId: "purchase-3",
    occurredAt: TIME,
    importedAt: "2025-03-02T00:00:00.000Z",
  }
  return {
    transactionId: IDS.transaction,
    timestamp: TIME,
    source: { sourceId: IDS.source, name: "Imported exchange", kind: "cex" },
    sourceRawRecordId: IDS.raw,
    transactionType: "unknown",
    providerTransactionType: "provider-buy",
    description: SELECTION.description,
    externalId: "purchase-3",
    classificationHistoryStatus: "unavailable",
    movements: [
      {
        id: IDS.leg,
        transactionId: IDS.transaction,
        sourceId: IDS.source,
        timestamp: TIME,
        assetId: IDS.asset,
        amount: "3",
        kind: "acquisition",
        provenance: "rule",
        derivationRule: "purchase-rule",
        movementCorrectionTargetId: IDS.target,
        sourceRawRecordId: IDS.raw,
        sourceRepresentationUseId: null,
        providerAssetRowId: IDS.providerAsset,
        assetRepresentationId: null,
        originKind: "none",
        providerTransferId: null,
        sourceTransferId: null,
        feeForTransactionId: null,
        evidence,
        evidenceStatus: "available",
      },
    ],
    sourceEvidence: [
      {
        origin: "transaction",
        originId: IDS.transaction,
        sourceId: IDS.source,
        sourceRawRecordId: IDS.raw,
        evidence,
        status: "available",
      },
      {
        origin: "leg",
        originId: IDS.leg,
        sourceId: IDS.source,
        sourceRawRecordId: null,
        evidence: null,
        status: "unavailable",
      },
    ],
    reconciliations: [],
    movementOverrides: [correction],
    assetOverrides: [{ movementId: IDS.leg, projection }],
    calculation: {
      run: {
        id: IDS.run,
        jurisdiction: "DE",
        taxYear: 2025,
        reportingCurrency: "EUR",
        status: "partial",
        engineVersion: "engine-fixture",
        ruleSetVersion: "rules-fixture",
        inputLedgerRevision: "1",
        valuationRevision: "1",
        failureCode: null,
      },
      state: "partial",
      monetaryStatus: "partial",
      derivedLots: [],
      allocations: [
        {
          sequence: 0,
          acquisitionEventId: IDS.leg,
          dispositionEventId: IDS.other,
          assetId: IDS.asset,
          custodyUnitId: IDS.source,
          acquiredAt: TIME,
          disposedAt: TIME,
          quantity: "3",
          costBasis: "0",
          proceeds: null,
          gainLoss: null,
          treatmentCodes: [],
        },
      ],
      income: [],
      blockers: [],
      processedEventIds: [IDS.leg],
      correctionInputs: [captured],
    },
  }
}

const clients: QueryClient[] = []
let mobile = false
beforeEach(() => {
  mobile = false
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: mobile,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  })
})
afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})

function mount(
  taxmaxi: TaxMaxi,
  {
    selection = SELECTION,
    readStatus = false,
  }: {
    selection?: Selection | null
    readStatus?: boolean
  } = {}
) {
  // Detail-only regressions model an unavailable independent work-status read.
  if (!readStatus)
    vi.spyOn(taxmaxi.portfolio, "getCalculationStatus").mockRejectedValue(
      new Error("Independent work status unavailable")
    )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const onUnauthorized = vi.fn()
  const onClose = vi.fn()
  const returnFocusRef = { current: null }
  const element = (value: Selection | null, disabled = false) => (
    <QueryClientProvider client={client}>
      <TransactionInspector
        selection={value}
        taxmaxi={taxmaxi}
        disabled={disabled}
        onUnauthorized={onUnauthorized}
        onClose={onClose}
        returnFocusRef={returnFocusRef}
      />
    </QueryClientProvider>
  )
  const view = render(element(selection))
  return {
    ...view,
    client,
    onClose,
    onUnauthorized,
    select: (value: Selection | null) => view.rerender(element(value)),
    disable: () => view.rerender(element(selection, true)),
  }
}

function section(title: string): HTMLElement {
  const container = screen.getByRole("heading", { name: title }).closest("section")
  if (container === null) throw new Error(`Missing section: ${title}`)
  return container
}

function selectedWork({
  status,
  activeRunId = IDS.run,
  taxYear = 2025,
}: {
  status: PortfolioCalculationStatus["work"]["status"]
  activeRunId?: string | null
  taxYear?: number
}): PortfolioCalculationStatus {
  const requests: PortfolioCalculationStatus["work"]["requests"] =
    status === "not_requested"
      ? []
      : [
          {
            requestId: "request-after-import",
            sourceId: IDS.source,
            sourceJobId: IDS.job,
            status,
            attempts:
              status === "queued"
                ? []
                : [
                    {
                      attemptId: "calculation-attempt",
                      runId: status === "failed" ? null : IDS.other,
                      status,
                      failureCode: status === "failed" ? "preparation_failed" : null,
                    },
                  ],
          },
        ]
  return {
    scope: { jurisdiction: "DE", taxYear, reportingCurrency: "EUR" },
    activeRun: activeRunId === null ? null : { runId: activeRunId, status: "complete" },
    work: { status, requests },
    jobs: requests.map((work) => ({
      sourceId: IDS.source,
      sourceJobId: IDS.job,
      sourceJobStatus: "completed",
      work,
      coveringRun: status === "succeeded" ? { runId: IDS.other, status: "complete" } : null,
      activeCoverage:
        status === "succeeded" && activeRunId === IDS.other ? "covered" : "not_covered",
    })),
  }
}

function sdkClient(body: TransactionDetail) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  )
  return {
    taxmaxi: TaxMaxi.fromBrowserSession({ baseUrl: "https://inspector.example.test", fetch }),
    fetch,
  }
}

describe("TransactionInspector", () => {
  it.each([false, true])(
    "preserves evidence, current decisions and captured facts on mobile=%s",
    async (isMobile) => {
      mobile = isMobile
      const { taxmaxi, fetch } = sdkClient(richDetail())
      mount(taxmaxi)
      await screen.findByRole("heading", { name: "Recorded transaction" })
      expect(screen.getAllByRole("dialog")).toHaveLength(1)
      expect(fetch).toHaveBeenCalledTimes(1)
      const movements = within(section("Movements"))
      expect(movements.getByText("3")).toBeTruthy()
      expect(movements.getByText(IDS.asset)).toBeTruthy()
      const evidence = within(section("Source evidence"))
      expect(evidence.getByText("coinbase")).toBeTruthy()
      expect(evidence.getByText("Not retained or unavailable")).toBeTruthy()
      const current = within(section("Current decisions"))
      expect(current.getAllByText("1 EUR").length).toBeGreaterThan(0)
      expect(current.getByText("0.333333333333333333 EUR")).toBeTruthy()
      expect(current.getByText("Rounded unit preview · not the total")).toBeTruthy()
      const captured = within(section("Inputs captured by the displayed run"))
      expect(captured.getAllByText("20 EUR").length).toBeGreaterThan(0)
      expect(captured.queryByText("1 EUR")).toBeNull()
      expect(captured.getByText(IDS.run)).toBeTruthy()
      expect(current.getByText("Corrected receipt total")).toBeTruthy()
      expect(current.getByText("Withdraw disputed classification")).toBeTruthy()
      expect(current.getByText("Original receipt total")).toBeTruthy()
      expect(current.getByText("Retained correction history")).toBeTruthy()
      expect(screen.getByText("Retained asset history")).toBeTruthy()
      expect(screen.getByText("Use the reviewed economic asset")).toBeTruthy()
      const allocation = within(screen.getByRole("region", { name: "Disposal allocation 1" }))
      expect(allocation.getByText("0 EUR")).toBeTruthy()
      expect(allocation.getAllByText("Unavailable")).toHaveLength(2)
      expect(allocation.queryByText("Tax-free holding period")).toBeNull()
    }
  )

  it.each(["en", "de"] as const)(
    "localizes reconciliation reasons in %s and retains unknown codes",
    async (locale) => {
      const originalUrl = window.location.href
      window.history.replaceState(null, "", "/app")
      await setLocale(locale, { reload: false })
      try {
        const detail = richDetail()
        const { taxmaxi } = sdkClient({
          ...detail,
          reconciliations: [
            {
              id: "known-reconciliation",
              providerTransferId: IDS.target,
              canonicalTransferId: null,
              canonicalTransactionId: null,
              status: "auto_applied",
              matchReason: "deterministic_wallet_receipt_match",
              deterministic: true,
            },
            {
              id: "unknown-reconciliation",
              providerTransferId: IDS.target,
              canonicalTransferId: null,
              canonicalTransactionId: null,
              status: "needs_review",
              matchReason: "future_reason_code",
              deterministic: false,
            },
          ],
        })
        mount(taxmaxi)
        await screen.findByText(
          locale === "en"
            ? "Wallet receipt matched unambiguously"
            : "Wallet-Eingang eindeutig zugeordnet"
        )
        expect(
          screen.getByText(
            locale === "en"
              ? "Unrecognized reconciliation reason: future_reason_code"
              : "Unbekannter Abgleichsgrund: future_reason_code"
          )
        ).toBeTruthy()
        expect(screen.queryByText("deterministic_wallet_receipt_match")).toBeNull()
      } finally {
        cleanup()
        await setLocale("en", { reload: false })
        window.history.replaceState(null, "", originalUrl)
      }
    }
  )

  it.each(["en", "de"] as const)(
    "localizes calculation and technical blockers in %s while retaining audit codes",
    async (locale) => {
      const originalUrl = window.location.href
      window.history.replaceState(null, "", "/app")
      await setLocale(locale, { reload: false })
      try {
        const detail = richDetail()
        const { taxmaxi } = sdkClient({
          ...detail,
          assetOverrides: detail.assetOverrides.map((item) => ({
            ...item,
            projection: item.projection
              ? {
                  ...item.projection,
                  technicalBlockers: ["missing_decimals"],
                  checkedTechnicalBlockerKinds: ["missing_decimals"],
                  effectiveDecision: {
                    _tag: "blocked",
                    identity: { _tag: "resolved", assetId: IDS.replacementAsset },
                    reason: "technical_blocker",
                    technicalBlockers: ["missing_decimals"],
                  },
                }
              : null,
          })),
          calculation: {
            ...detail.calculation,
            blockers: ["missing_valuation", "future_blocker"].map((code, sequence) => ({
              sequence,
              eventId: IDS.leg,
              code,
              assetId: IDS.asset,
              providerAssetRowId: null,
              custodyUnitId: IDS.source,
              missingQuantity: null,
            })),
          },
        })
        mount(taxmaxi)
        await screen.findByText(locale === "en" ? "Valuation missing" : "Bewertung fehlt")
        expect(
          screen.getByText(locale === "en" ? "Coinbase transaction" : "Coinbase-Transaktion")
        ).toBeTruthy()
        expect(
          screen.getByText(locale === "en" ? "Unknown blocker" : "Unbekannter Blocker")
        ).toBeTruthy()
        expect(
          screen.getAllByText(
            locale === "en" ? "Asset decimal precision missing" : "Dezimalstellen des Assets fehlen"
          ).length
        ).toBeGreaterThan(0)
        expect(screen.getByText("future_blocker")).toBeTruthy()
        expect(screen.getByText("missing_valuation")).toBeTruthy()
        expect(
          screen.getAllByText(
            locale === "en" ? "Unrecognized value: provider-buy" : "Unbekannter Wert: provider-buy"
          ).length
        ).toBeGreaterThan(0)
      } finally {
        cleanup()
        await setLocale("en", { reload: false })
        window.history.replaceState(null, "", originalUrl)
      }
    }
  )

  it("does not fetch without a selection and rejects a late reply after selecting another transaction", async () => {
    const taxmaxi = new TaxMaxi({ apiKey: "", baseUrl: "https://inspector.example.test" })
    let finish: ((value: TransactionDetail) => void) | undefined
    const get = vi
      .spyOn(taxmaxi.transactions, "get")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      .mockResolvedValue({
        ...richDetail(),
        transactionId: IDS.other,
        externalId: "selected-second",
      })
    const view = mount(taxmaxi, { selection: null })
    expect(get).not.toHaveBeenCalled()
    view.select(SELECTION)
    expect(get).toHaveBeenCalledTimes(1)
    view.select({ ...SELECTION, transactionId: IDS.other, description: "Second selection" })
    await screen.findByText("selected-second")
    await act(async () => {
      finish?.({ ...richDetail(), externalId: "late-first" })
    })
    expect(screen.queryByText("late-first")).toBeNull()
    expect(screen.getAllByRole("dialog")).toHaveLength(1)
    expect(get).toHaveBeenNthCalledWith(2, { transactionId: IDS.other, taxYear: 2025 })
  })

  it("keeps a missing transaction distinct from a read failure and retries in place", async () => {
    const taxmaxi = new TaxMaxi({ apiKey: "", baseUrl: "https://inspector.example.test" })
    const get = vi
      .spyOn(taxmaxi.transactions, "get")
      .mockRejectedValueOnce(
        new TaxMaxiError({ status: 404, message: "Missing", code: "TransactionNotFoundError" })
      )
      .mockResolvedValue(richDetail())
    mount(taxmaxi)
    await screen.findByText(
      "This transaction is no longer available. Your selection has been kept."
    )
    fireEvent.click(screen.getByRole("button", { name: "Retry results" }))
    await screen.findByRole("heading", { name: "Recorded transaction" })
    expect(get).toHaveBeenCalledTimes(2)
    expect(
      screen.queryByText("This transaction is no longer available. Your selection has been kept.")
    ).toBeNull()
  })

  it.each([false, true])("closes with Escape and returns focus on mobile=%s", async (isMobile) => {
    mobile = isMobile
    const { taxmaxi } = sdkClient(richDetail())
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    clients.push(client)
    function Harness() {
      const [selection, setSelection] = useState<Selection | null>(null)
      const returnFocusRef = useRef<HTMLButtonElement | null>(null)
      return (
        <>
          <button ref={returnFocusRef} onClick={() => setSelection(SELECTION)}>
            Open fixture
          </button>
          <TransactionInspector
            selection={selection}
            taxmaxi={taxmaxi}
            disabled={false}
            onUnauthorized={() => undefined}
            onClose={() => setSelection(null)}
            returnFocusRef={returnFocusRef}
          />
        </>
      )
    }
    render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>
    )
    const opener = screen.getByRole("button", { name: "Open fixture" })
    opener.focus()
    fireEvent.click(opener)
    await screen.findByRole("heading", { name: "Recorded transaction" })
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close transaction" }))
    fireEvent.keyDown(document.activeElement ?? document, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })
  it.each([false, true])(
    "restores list focus after the selected row disappears on mobile=%s",
    async (isMobile) => {
      mobile = isMobile
      const { taxmaxi } = sdkClient(richDetail())
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      clients.push(client)
      function Harness() {
        const [selection, setSelection] = useState<Selection | null>(null)
        const [hasRow, setHasRow] = useState(true)
        const returnFocusRef = useRef<HTMLElement | null>(null)
        const fallbackFocusRef = useRef<HTMLDivElement | null>(null)
        return (
          <>
            <div
              ref={fallbackFocusRef}
              tabIndex={-1}
              role="region"
              aria-label="Fixture transactions"
            >
              {hasRow ? (
                <button
                  onClick={(event) => {
                    returnFocusRef.current = event.currentTarget
                    setSelection(SELECTION)
                  }}
                >
                  Open fixture
                </button>
              ) : null}
            </div>
            <button onClick={() => setHasRow(false)}>Remove row</button>
            <TransactionInspector
              selection={selection}
              taxmaxi={taxmaxi}
              disabled={false}
              onUnauthorized={() => undefined}
              onClose={() => setSelection(null)}
              returnFocusRef={returnFocusRef}
              fallbackFocusRef={fallbackFocusRef}
            />
          </>
        )
      }
      render(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>
      )
      fireEvent.click(screen.getByRole("button", { name: "Open fixture" }))
      await screen.findByRole("heading", { name: "Recorded transaction" })
      fireEvent.click(screen.getByText("Remove row"))
      fireEvent.click(screen.getByRole("button", { name: "Close transaction" }))
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole("region", { name: "Fixture transactions" })
        )
      )
    }
  )
})

const advanceRefresh = async (milliseconds = 1) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
}

function settledDetail(currentTotal: "1" | "30" = "1"): TransactionDetail {
  const detail = richDetail(currentTotal)
  return {
    ...detail,
    movementOverrides: detail.movementOverrides.map((correction) => {
      const covered = (stream: Correction["price"]): Correction["price"] => ({
        ...stream,
        replay: { ...stream.replay, status: "complete" },
        coverageStatus: "covered",
        coverage: stream.leaf
          ? {
              runId: IDS.run,
              status: "partial",
              failureCode: null,
              overrideId: stream.leaf.id,
              input: {
                application: stream.application,
                applicationProblem: stream.applicationProblem,
                resolvedPrice: stream.resolvedPrice,
                system: correction.inputs.system,
                effective: correction.inputs.effective,
              },
            }
          : null,
      })
      return {
        ...correction,
        price: covered(correction.price),
        classification: covered(correction.classification),
      }
    }),
  }
}

describe("selected transaction refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    focusManager.setFocused(true)
    onlineManager.setOnline(true)
  })
  afterEach(() => {
    cleanup()
    focusManager.setFocused(undefined)
    onlineManager.setOnline(true)
    vi.useRealTimers()
  })

  it("polls recorded replay, refreshes the same list cursor on a new run and stops when settled", async () => {
    let body = richDetail("30")
    const urls: string[] = []
    const taxmaxi = TaxMaxi.fromBrowserSession({
      baseUrl: "https://refresh.example.test",
      fetch: async (input) => {
        const url = input instanceof Request ? input.url : String(input)
        urls.push(url)
        if (new URL(url).pathname.endsWith("/transactions"))
          return Response.json({
            transactions: [],
            totalCount: 0,
            page: { hasMore: false, nextCursor: null },
          })
        return Response.json(body)
      },
    })
    const view = mount(taxmaxi)
    const list = new QueryObserver(
      view.client,
      queries.transactionList(taxmaxi, { cursor: "kept-page", limit: 7 })
    )
    const unsubscribe = list.subscribe(() => undefined)
    try {
      await advanceRefresh()
      expect(urls.filter((url) => url.includes("taxYear="))).toHaveLength(1)
      body = settledDetail("30")
      if (body.calculation.run)
        body = {
          ...body,
          calculation: {
            ...body.calculation,
            run: { ...body.calculation.run, id: IDS.other },
            correctionInputs: body.movementOverrides.flatMap((item) => item.inputs.corrections),
            allocations: body.calculation.allocations.map((item) => ({
              ...item,
              costBasis: "30",
              proceeds: "30",
              gainLoss: "0",
            })),
          },
        }
      await advanceRefresh(2_000)
      expect(screen.getByText(`Returned run: ${IDS.other} · 2025 · DE · EUR`)).toBeTruthy()
      expect(
        within(screen.getByRole("region", { name: "Disposal allocation 1" })).getByText("0 EUR")
      ).toBeTruthy()
      expect(urls.filter((url) => new URL(url).pathname.endsWith("/transactions"))).toEqual([
        "https://refresh.example.test/v1/transactions?cursor=kept-page&limit=7",
        "https://refresh.example.test/v1/transactions?cursor=kept-page&limit=7",
      ])
      const count = urls.length
      await advanceRefresh(10_000)
      expect(urls).toHaveLength(count)
    } finally {
      unsubscribe()
    }
  })

  it.each(["movement replay", "movement coverage", "asset replay"] as const)(
    "polls recorded %s independently of calculation completeness",
    async (work) => {
      const settled = settledDetail()
      const body: TransactionDetail =
        work === "asset replay"
          ? {
              ...settled,
              assetOverrides: settled.assetOverrides.map((item) => ({
                ...item,
                projection: item.projection
                  ? {
                      ...item.projection,
                      recomputation: {
                        status: "updating",
                        overrideIds: [IDS.assetOverride],
                        sourceJobs: [
                          {
                            overrideId: IDS.assetOverride,
                            sourceId: IDS.source,
                            requestedJobId: IDS.job,
                            jobId: IDS.job,
                            status: "pending",
                            failureCode: null,
                          },
                        ],
                        calculationRun: null,
                      },
                    }
                  : null,
              })),
            }
          : {
              ...settled,
              movementOverrides: settled.movementOverrides.map((item) => ({
                ...item,
                price: {
                  ...item.price,
                  ...(work === "movement replay"
                    ? { replay: { ...item.price.replay, status: "updating" } }
                    : { coverageStatus: "updating", coverage: null }),
                },
              })),
            }
      const { taxmaxi, fetch } = sdkClient(body)
      mount(taxmaxi)
      await advanceRefresh()
      await advanceRefresh(2_000)
      expect(fetch).toHaveBeenCalledTimes(2)
    }
  )

  it("invalidates again when the observed run returns from B to A", async () => {
    let body = settledDetail()
    const { taxmaxi, fetch } = sdkClient(body)
    fetch.mockImplementation(async () => Response.json(body))
    const view = mount(taxmaxi)
    const options = queries.transactionList(taxmaxi, { limit: 7 })
    const list = vi.spyOn(taxmaxi.transactions, "list").mockResolvedValue({
      transactions: [],
      totalCount: 0,
      page: { hasMore: false, nextCursor: null },
    })
    const observer = new QueryObserver(view.client, options)
    const unsubscribe = observer.subscribe(() => undefined)
    try {
      await advanceRefresh()
      if (!body.calculation.run) throw new Error("Fixture run missing")
      body = {
        ...body,
        calculation: { ...body.calculation, run: { ...body.calculation.run, id: IDS.other } },
      }
      act(() => focusManager.setFocused(false))
      act(() => focusManager.setFocused(true))
      await advanceRefresh()
      body = settledDetail()
      act(() => focusManager.setFocused(false))
      act(() => focusManager.setFocused(true))
      await advanceRefresh()
      expect(list).toHaveBeenCalledTimes(3)
      expect(screen.getByText(`Returned run: ${IDS.run} · 2025 · DE · EUR`)).toBeTruthy()
    } finally {
      unsubscribe()
    }
  })

  it.each(["partial", "no run"] as const)(
    "does not poll %s without recorded pending work",
    async (scenario) => {
      const body = settledDetail()
      const { taxmaxi, fetch } = sdkClient(
        scenario === "no run"
          ? {
              ...body,
              calculation: { ...body.calculation, run: null, monetaryStatus: "unavailable" },
            }
          : body
      )
      mount(taxmaxi)
      await advanceRefresh()
      await advanceRefresh(20_000)
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  )

  it("stops the previous selection's pending polling on change and closure", async () => {
    const urls: string[] = []
    const taxmaxi = TaxMaxi.fromBrowserSession({
      baseUrl: "https://refresh.example.test",
      fetch: async (input) => {
        const url = input instanceof Request ? input.url : String(input)
        urls.push(url)
        return Response.json(
          new URL(url).pathname.endsWith(IDS.other)
            ? { ...settledDetail(), transactionId: IDS.other }
            : richDetail()
        )
      },
    })
    const view = mount(taxmaxi)
    await advanceRefresh()
    view.select({ ...SELECTION, transactionId: IDS.other })
    await advanceRefresh()
    await advanceRefresh(6_000)
    expect(urls).toHaveLength(2)
    view.select(SELECTION)
    await advanceRefresh()
    const count = urls.length
    view.select(null)
    await advanceRefresh(10_000)
    expect(urls).toHaveLength(count)
  })

  it.each([401, 404])(
    "stops polling after HTTP %s and preserves the selected ID",
    async (status) => {
      let missing = false
      const calls: string[] = []
      const taxmaxi = TaxMaxi.fromBrowserSession({
        baseUrl: "https://refresh.example.test",
        fetch: async (input) => {
          calls.push(input instanceof Request ? input.url : String(input))
          return missing
            ? Response.json(
                {
                  _tag: status === 404 ? "TransactionNotFoundError" : "Unauthorized",
                  message: "Fixture failure",
                },
                { status }
              )
            : Response.json(richDetail())
        },
      })
      const view = mount(taxmaxi)
      await advanceRefresh()
      missing = true
      await advanceRefresh(2_000)
      await advanceRefresh(20_000)
      expect(calls).toHaveLength(2)
      expect(calls.every((url) => url.includes(IDS.transaction))).toBe(true)
      if (status === 404)
        expect(
          screen.getByText("This transaction is no longer available. Your selection has been kept.")
        ).toBeTruthy()
      else expect(view.onUnauthorized).toHaveBeenCalled()
    }
  )

  it("restarts an initial selected request after a writer signal and rejects its late response", async () => {
    let completeOld: ((response: Response) => void) | undefined
    let count = 0
    const taxmaxi = TaxMaxi.fromBrowserSession({
      baseUrl: "https://refresh.example.test",
      fetch: async () => {
        count += 1
        if (count === 1)
          return new Promise((resolve) => {
            completeOld = resolve
          })
        return Response.json({ ...settledDetail(), externalId: "new-source-facts" })
      },
    })
    const view = mount(taxmaxi)
    await advanceRefresh()
    await act(async () => {
      await refreshTransactionQueries(view.client)
    })
    await advanceRefresh()
    expect(screen.getByText("new-source-facts")).toBeTruthy()
    await act(async () => {
      completeOld?.(Response.json({ ...settledDetail(), externalId: "old-source-facts" }))
    })
    await advanceRefresh()
    expect(screen.queryByText("old-source-facts")).toBeNull()
    expect(count).toBe(2)
  })

  it.each(["close", "change", "auth"] as const)(
    "finishes an observed run refresh after %s unless authentication is lost",
    async (action) => {
      let body = settledDetail()
      const { taxmaxi, fetch } = sdkClient(body)
      fetch.mockImplementation(async () => Response.json(body))
      const view = mount(taxmaxi)
      const list = vi.spyOn(taxmaxi.transactions, "list").mockResolvedValue({
        transactions: [],
        totalCount: 0,
        page: { hasMore: false, nextCursor: null },
      })
      const observer = new QueryObserver(view.client, queries.transactionList(taxmaxi))
      const unsubscribe = observer.subscribe(() => undefined)
      let release: (() => void) | undefined
      const originalCancel = view.client.cancelQueries.bind(view.client)
      const barrier = new Promise<void>((resolve) => {
        release = resolve
      })
      try {
        await advanceRefresh()
        vi.spyOn(view.client, "cancelQueries").mockImplementation(async (filters, options) => {
          await originalCancel(filters, options)
          await barrier
        })
        if (!body.calculation.run) throw new Error("Fixture run missing")
        body = {
          ...body,
          calculation: { ...body.calculation, run: { ...body.calculation.run, id: IDS.other } },
        }
        act(() => focusManager.setFocused(false))
        act(() => focusManager.setFocused(true))
        await advanceRefresh()
        if (action === "close") view.select(null)
        else if (action === "change") view.select({ ...SELECTION, transactionId: IDS.other })
        else view.disable()
        await act(async () => {
          release?.()
        })
        await advanceRefresh()
        expect(list).toHaveBeenCalledTimes(action === "auth" ? 1 : 2)
      } finally {
        release?.()
        unsubscribe()
      }
    }
  )

  it("cancels pending delivery and polling when authentication disables the inspector", async () => {
    let complete: ((response: Response) => void) | undefined
    let calls = 0
    const taxmaxi = TaxMaxi.fromBrowserSession({
      baseUrl: "https://refresh.example.test",
      fetch: async () => {
        calls += 1
        return new Promise((resolve) => {
          complete = resolve
        })
      },
    })
    const view = mount(taxmaxi)
    await advanceRefresh()
    view.disable()
    await act(async () => {
      complete?.(Response.json(richDetail()))
    })
    await advanceRefresh(10_000)
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(calls).toBe(1)
    expect(
      view.client.getQueryData(
        queries.transactionDetail(taxmaxi, { transactionId: IDS.transaction, taxYear: 2025 })
          .queryKey
      )
    ).toBeUndefined()
  })

  it("refetches external corrections on focus while cached facts are fresh", async () => {
    let body = settledDetail()
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => Response.json(body))
    const taxmaxi = TaxMaxi.fromBrowserSession({ baseUrl: "https://refresh.example.test", fetch })
    mount(taxmaxi)
    await advanceRefresh()
    body = {
      ...body,
      movementOverrides: body.movementOverrides.map((item) => ({
        ...item,
        price: {
          ...item.price,
          stale: true,
          application: "needs_attention",
          applicationProblem: "quantity_changed",
        },
      })),
    }
    act(() => focusManager.setFocused(false))
    act(() => focusManager.setFocused(true))
    await advanceRefresh()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(screen.getByText("Quantity changed")).toBeTruthy()
    expect(
      within(section("Inputs captured by the displayed run")).getAllByText("20 EUR").length
    ).toBeGreaterThan(0)
    expect(within(section("Current decisions")).getAllByText("1 EUR").length).toBeGreaterThan(0)
    act(() => onlineManager.setOnline(false))
    act(() => onlineManager.setOnline(true))
    await advanceRefresh()
    expect(fetch).toHaveBeenCalledTimes(3)
  })
  it.each([true, false])(
    "discovers imported work on a fresh inspector with prior result %s",
    async (hasRun) => {
      let status = selectedWork({ status: "queued", activeRunId: hasRun ? IDS.run : null })
      let body = settledDetail()
      if (!hasRun)
        body = {
          ...body,
          calculation: {
            ...body.calculation,
            run: null,
            state: "partial",
            monetaryStatus: "unavailable",
            allocations: [],
            income: [],
            derivedLots: [],
          },
        }
      let statusReads = 0
      let detailReads = 0
      const taxmaxi = TaxMaxi.fromBrowserSession({
        baseUrl: "https://work.example.test",
        fetch: async (input) => {
          const url = new URL(input instanceof Request ? input.url : String(input))
          if (url.pathname.endsWith("/calculation-status")) {
            expect(url.searchParams.get("taxYear")).toBe("2025")
            statusReads += 1
            return Response.json(status)
          }
          detailReads += 1
          return Response.json(body)
        },
      })
      const view = mount(taxmaxi, { readStatus: true })
      await advanceRefresh()
      expect(screen.getByText("Queued")).toBeTruthy()
      if (hasRun)
        expect(screen.getByText(`Returned run: ${IDS.run} · 2025 · DE · EUR`)).toBeTruthy()
      status = selectedWork({ status: "running", activeRunId: hasRun ? IDS.run : null })
      await advanceRefresh(2_000)
      expect(screen.getByText("Running")).toBeTruthy()
      expect(detailReads).toBe(1)
      body = settledDetail("30")
      if (!body.calculation.run) throw new Error("Fixture run missing")
      body = {
        ...body,
        calculation: {
          ...body.calculation,
          run: { ...body.calculation.run, id: IDS.other },
          allocations: body.calculation.allocations.map((item) => ({
            ...item,
            costBasis: "30",
            proceeds: "30",
            gainLoss: "0",
          })),
        },
      }
      status = selectedWork({ status: "succeeded", activeRunId: IDS.other })
      await advanceRefresh(2_000)
      expect(screen.getByText(`Returned run: ${IDS.other} · 2025 · DE · EUR`)).toBeTruthy()
      expect(
        view.client.getQueryData(queries.transactionCalculationStatus(taxmaxi, 2025).queryKey)?.work
          .requests[0]?.requestId
      ).toBe("request-after-import")
      const reads = [statusReads, detailReads]
      await advanceRefresh(10_000)
      expect([statusReads, detailReads]).toEqual(reads)
    }
  )

  it.each(["not_requested", "failed"] as const)(
    "does not poll %s selected-year work",
    async (work) => {
      let reads = 0
      const taxmaxi = TaxMaxi.fromBrowserSession({
        baseUrl: "https://terminal.example.test",
        fetch: async (input) => {
          if (String(input).includes("calculation-status")) {
            reads += 1
            return Response.json(selectedWork({ status: work }))
          }
          return Response.json(settledDetail())
        },
      })
      mount(taxmaxi, { readStatus: true })
      await advanceRefresh()
      const currentWork = screen.getByText("Current calculation work").parentElement
      expect(currentWork?.textContent).toContain(work === "failed" ? "Failed" : "Not requested")
      await advanceRefresh(10_000)
      expect(reads).toBe(1)
    }
  )

  it("rejects a delayed previous-year status response and stops status requests on close", async () => {
    let release: ((value: Response) => void) | undefined
    const requestedYears: string[] = []
    const taxmaxi = TaxMaxi.fromBrowserSession({
      baseUrl: "https://selection.example.test",
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.pathname.endsWith("/calculation-status")) {
          const year = url.searchParams.get("taxYear") ?? ""
          requestedYears.push(year)
          if (year === "2025")
            return new Promise((resolve) => {
              release = resolve
            })
          return Response.json(selectedWork({ status: "not_requested", taxYear: 2024 }))
        }
        return Response.json(settledDetail())
      },
    })
    const view = mount(taxmaxi, { readStatus: true })
    await advanceRefresh()
    view.select({ ...SELECTION, taxYear: 2024 })
    await advanceRefresh()
    await act(async () => {
      release?.(Response.json(selectedWork({ status: "queued" })))
    })
    expect(screen.queryByText("Queued")).toBeNull()
    view.select(null)
    await advanceRefresh(10_000)
    expect(requestedYears).toEqual(["2025", "2024"])
  })

  it("stops detail and status polling after status authentication failure", async () => {
    let statusReads = 0
    let detailReads = 0
    const taxmaxi = TaxMaxi.fromBrowserSession({
      baseUrl: "https://auth.example.test",
      fetch: async (input) => {
        if (String(input).includes("calculation-status")) {
          statusReads += 1
          return Response.json({ _tag: "Unauthorized" }, { status: 401 })
        }
        detailReads += 1
        return Response.json(richDetail())
      },
    })
    const view = mount(taxmaxi, { readStatus: true })
    await advanceRefresh()
    expect(view.onUnauthorized).toHaveBeenCalled()
    await advanceRefresh(10_000)
    expect([statusReads, detailReads]).toEqual([1, 1])
  })
  it.each(["close", "change", "auth", "missing"] as const)(
    "stops recorded queued-work polling on %s",
    async (action) => {
      let statusReads = 0
      const taxmaxi = TaxMaxi.fromBrowserSession({
        baseUrl: "https://stop.example.test",
        fetch: async (input) => {
          const url = new URL(input instanceof Request ? input.url : String(input))
          if (url.pathname.endsWith("/calculation-status")) {
            if (url.searchParams.get("taxYear") === "2024")
              return Response.json(selectedWork({ status: "not_requested", taxYear: 2024 }))
            statusReads += 1
            return Response.json(selectedWork({ status: "queued" }))
          }
          return action === "missing"
            ? Response.json({ _tag: "TransactionNotFoundError" }, { status: 404 })
            : Response.json(settledDetail())
        },
      })
      const view = mount(taxmaxi, { readStatus: true })
      await advanceRefresh()
      if (action === "close") view.select(null)
      if (action === "change") view.select({ ...SELECTION, taxYear: 2024 })
      if (action === "auth") view.disable()
      await advanceRefresh(10_000)
      expect(statusReads).toBe(1)
    }
  )

  it("finishes a mismatched-run refresh through a same-transaction description update", async () => {
    let body = settledDetail()
    let reads = 0
    const taxmaxi = TaxMaxi.fromBrowserSession({
      baseUrl: "https://mismatch.example.test",
      fetch: async (input) => {
        if (String(input).includes("calculation-status"))
          return Response.json(selectedWork({ status: "succeeded", activeRunId: IDS.other }))
        reads += 1
        return Response.json(body)
      },
    })
    const view = mount(taxmaxi, { readStatus: true })
    let release: (() => void) | undefined
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const cancel = view.client.cancelQueries.bind(view.client)
    vi.spyOn(view.client, "cancelQueries").mockImplementation(async (filters, options) => {
      await cancel(filters, options)
      await barrier
    })
    try {
      await advanceRefresh()
      expect(screen.getByText(`Returned run: ${IDS.run} · 2025 · DE · EUR`)).toBeTruthy()
      // Status coverage for the newer run is never attached to the old displayed result.
      expect(screen.getByText("Current calculation work").parentElement?.textContent).not.toContain(
        "Covered"
      )
      if (!body.calculation.run) throw new Error("Fixture run missing")
      body = {
        ...body,
        calculation: { ...body.calculation, run: { ...body.calculation.run, id: IDS.other } },
      }
      view.select({ ...SELECTION, description: "Refreshed description" })
      await act(async () => {
        release?.()
      })
      await advanceRefresh()
      expect(screen.getByText(`Returned run: ${IDS.other} · 2025 · DE · EUR`)).toBeTruthy()
      expect(reads).toBe(2)
    } finally {
      release?.()
    }
  })

  it("keeps keyboard focus on the inspector after work-status retry succeeds", async () => {
    let fail = true
    const taxmaxi = TaxMaxi.fromBrowserSession({
      baseUrl: "https://retry.example.test",
      fetch: async (input) => {
        if (String(input).includes("calculation-status"))
          return fail
            ? Response.json({ _tag: "InternalServerError" }, { status: 500 })
            : Response.json(selectedWork({ status: "not_requested" }))
        return Response.json(settledDetail())
      },
    })
    mount(taxmaxi, { readStatus: true })
    await advanceRefresh()
    const retry = screen.getByRole("button", { name: "Refresh results" })
    retry.focus()
    fail = false
    fireEvent.click(retry)
    await advanceRefresh()
    expect(document.activeElement?.tagName).toBe("SECTION")
    expect(screen.queryByRole("button", { name: "Refresh results" })).toBeNull()
  })
  it("retains a newer displayed result when an older status snapshot arrives later", async () => {
    let completeStatus: ((response: Response) => void) | undefined
    const body = settledDetail()
    if (!body.calculation.run) throw new Error("Fixture run missing")
    const newer = {
      ...body,
      calculation: { ...body.calculation, run: { ...body.calculation.run, id: IDS.other } },
    }
    let detailReads = 0
    const taxmaxi = TaxMaxi.fromBrowserSession({
      baseUrl: "https://late-status.example.test",
      fetch: async (input) => {
        if (String(input).includes("calculation-status"))
          return new Promise((resolve) => {
            completeStatus = resolve
          })
        detailReads += 1
        return Response.json(newer)
      },
    })
    mount(taxmaxi, { readStatus: true })
    await advanceRefresh()
    await act(async () => {
      completeStatus?.(Response.json(selectedWork({ status: "not_requested" })))
    })
    await advanceRefresh()
    expect(screen.getByText(`Returned run: ${IDS.other} · 2025 · DE · EUR`)).toBeTruthy()
    expect(detailReads).toBe(2)
    expect(screen.getByText("Current calculation work").parentElement?.textContent).not.toContain(
      "Covered"
    )
  })

  it("backs off a failed status read with retained pending work and resumes discovery", async () => {
    let statusReads = 0
    const taxmaxi = TaxMaxi.fromBrowserSession({
      baseUrl: "https://status-recovery.example.test",
      fetch: async (input) => {
        if (String(input).includes("calculation-status")) {
          statusReads += 1
          if (statusReads === 2)
            return Response.json({ _tag: "InternalServerError" }, { status: 500 })
          return Response.json(selectedWork({ status: statusReads === 1 ? "queued" : "failed" }))
        }
        return Response.json(settledDetail())
      },
    })
    mount(taxmaxi, { readStatus: true })
    await advanceRefresh()
    await advanceRefresh(2_000)
    expect(screen.getByText("Calculation work status could not be loaded.")).toBeTruthy()
    expect(screen.getByText(`Returned run: ${IDS.run} · 2025 · DE · EUR`)).toBeTruthy()
    await advanceRefresh(10_000)
    expect(statusReads).toBe(2)
    await advanceRefresh(20_000)
    expect(statusReads).toBe(3)
    expect(screen.getByText("Current calculation work").parentElement?.textContent).toContain(
      "Failed"
    )
    await advanceRefresh(30_000)
    expect(statusReads).toBe(3)
  })
})
