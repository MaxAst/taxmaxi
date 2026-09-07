// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useRef, useState, type ComponentProps } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TaxMaxi, TaxMaxiError, type TransactionDetail } from "taxmaxi"
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

function richDetail(): TransactionDetail {
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
    input: { _tag: "price", input: { _tag: "total_value", amount: "1", currency: "EUR" } },
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
      effective: effectiveInputs("1", IDS.price),
      corrections: [
        {
          ...captured,
          history: price,
          effective: effectiveInputs("1", IDS.price),
          resolvedPrice: {
            totalValue: "1",
            currency: "EUR",
            unitPrice: { amount: "0.333333333333333333", rounded: true },
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
        totalValue: "1",
        currency: "EUR",
        unitPrice: { amount: "0.333333333333333333", rounded: true },
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
    recordType: "transaction",
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

function mount(taxmaxi: TaxMaxi, selection: Selection | null = SELECTION) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const onUnauthorized = vi.fn()
  const onClose = vi.fn()
  const returnFocusRef = { current: null }
  const element = (value: Selection | null) => (
    <QueryClientProvider client={client}>
      <TransactionInspector
        selection={value}
        taxmaxi={taxmaxi}
        disabled={false}
        onUnauthorized={onUnauthorized}
        onClose={onClose}
        returnFocusRef={returnFocusRef}
      />
    </QueryClientProvider>
  )
  const view = render(element(selection))
  return {
    ...view,
    onClose,
    onUnauthorized,
    select: (value: Selection | null) => view.rerender(element(value)),
  }
}

function section(title: string): HTMLElement {
  const container = screen.getByRole("heading", { name: title }).closest("section")
  if (container === null) throw new Error(`Missing section: ${title}`)
  return container
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
    const view = mount(taxmaxi, null)
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
})
