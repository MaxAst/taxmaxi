// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render as testingRender,
  screen,
  within,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TaxMaxi, type TransactionDetail, type TransactionListItem } from "taxmaxi"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useRef, useState, type ComponentProps, type ReactElement } from "react"

import { setLocale } from "#/paraglide/runtime"
import * as BigDecimal from "effect/BigDecimal"

import { TransactionsTable, type TransactionPageSize } from "#/components/transactions-table"
import { TransactionInspector } from "#/components/transaction-inspector"
import { m } from "#/paraglide/messages"

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi
      .fn()
      .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  })
})

const transaction: TransactionListItem = {
  transactionId: "00000000-0000-4000-8000-000000000101",
  timestamp: "2025-03-10T12:00:00.000Z",
  source: {
    sourceId: "00000000-0000-4000-8000-000000000201",
    name: "Coinbase",
    kind: "cex",
  },
  transactionType: "sell_fiat",
  description: "Sold Bitcoin",
  externalId: "coinbase-sale-1",
  movements: [
    {
      targetId: "00000000-0000-4000-8000-000000000601",
      capture: null,
      amount: "0.4",
      assetSymbol: "BTC",
      kind: "disposal",
    },
  ],
  income: null,
  realizedGainLoss: "2000",
  fiatCurrency: "EUR",
  calculationState: "complete",
  needsReview: false,
  attention: false,
}

const taxmaxi = new TaxMaxi({ apiKey: "", baseUrl: "https://treatment.example.test" })
const clients: Array<QueryClient> = []
const render = (element: ReactElement) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return testingRender(element, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })
}

const detail = (): TransactionDetail => ({
  transactionId: transaction.transactionId,
  timestamp: transaction.timestamp,
  source: transaction.source,
  transactionType: transaction.transactionType,
  description: transaction.description,
  externalId: transaction.externalId,
  sourceRawRecordId: null,
  providerTransactionType: null,
  classificationHistoryStatus: "unavailable",
  sourceEvidence: [],
  movements: [],
  reconciliations: [],
  movementOverrides: [],
  assetOverrides: [],
  calculation: {
    run: {
      id: "run-a",
      taxYear: 2025,
      jurisdiction: "DE",
      reportingCurrency: "EUR",
      status: "partial",
      engineVersion: "test",
      ruleSetVersion: "test",
      inputLedgerRevision: "1",
      valuationRevision: "1",
      failureCode: null,
    },
    state: "partial",
    monetaryStatus: "partial",
    derivedLots: [],
    allocations: [],
    income: [],
    blockers: [],
    processedEventIds: [],
    correctionInputs: [],
  },
})

const defaultProps = {
  taxmaxi,
  onSelect: vi.fn(),
  selectedTransactionId: null,
  disabled: false,
  onUnauthorized: vi.fn(),
  error: false,
  hasNextPage: false,
  loading: false,
  onNextPage: vi.fn(),
  onPreviousPage: vi.fn(),
  onRetry: vi.fn(),
  pageIndex: 0,
  pageSize: 25 as const,
  onPageSizeChange: vi.fn(),
  totalCount: 1,
  transactions: [transaction],
}

function TransactionsWithInspector(
  props: Omit<typeof defaultProps, "pageSize"> & { pageSize: TransactionPageSize }
) {
  const [selection, setSelection] =
    useState<ComponentProps<typeof TransactionInspector>["selection"]>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  return (
    <>
      <TransactionsTable
        {...props}
        selectedTransactionId={selection?.transactionId ?? null}
        onSelect={(row, trigger) => {
          props.onSelect(row, trigger)
          returnFocusRef.current = trigger
          setSelection({
            transactionId: row.transactionId,
            taxYear: Number(
              new Intl.DateTimeFormat("en", { year: "numeric", timeZone: "Europe/Berlin" }).format(
                new Date(row.timestamp)
              )
            ),
            description: row.description ?? m["app.treatment.transaction"](),
          })
        }}
      />
      <TransactionInspector
        selection={selection}
        taxmaxi={props.taxmaxi}
        disabled={props.disabled}
        onUnauthorized={props.onUnauthorized}
        onClose={() => setSelection(null)}
        returnFocusRef={returnFocusRef}
      />
    </>
  )
}

const openName = (row: TransactionListItem = transaction) =>
  m["app.inspector.open"]({
    description: row.description ?? m["app.treatment.transaction"](),
    transactionId: row.transactionId,
  })

describe("TransactionsTable", () => {
  it.each([25, 50, 100, 500] as const)(
    "uses selected size %s for ranges and the page control",
    (pageSize) => {
      render(
        <TransactionsWithInspector
          {...defaultProps}
          pageIndex={1}
          pageSize={pageSize}
          totalCount={1204}
        />
      )
      expect(screen.getByText(`${pageSize + 1}–${pageSize + 1} of 1204`)).toBeTruthy()
      expect(
        screen.getByRole("combobox", { name: "Rows per page" }).getAttribute("disabled")
      ).toBeNull()
      fireEvent.change(screen.getByRole("combobox", { name: "Rows per page" }), {
        target: { value: "500" },
      })
      expect(defaultProps.onPageSizeChange).toHaveBeenCalledWith(500)
    }
  )

  it("keeps loading bounded at page size 500", () => {
    render(<TransactionsWithInspector {...defaultProps} pageSize={500} loading transactions={[]} />)
    expect(screen.getAllByRole("status")).toHaveLength(1)
    expect(document.querySelectorAll("article")).toHaveLength(0)
  })

  afterEach(() => {
    cleanup()
    clients.splice(0).forEach((client) => client.clear())
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it("renders real compact rows and the exact total", () => {
    render(<TransactionsWithInspector {...defaultProps} />)

    expect(screen.getByText("Sold Bitcoin")).toBeTruthy()
    expect(screen.getByText("Sent −0.4 BTC")).toBeTruthy()
    expect(screen.getByText("Coinbase")).toBeTruthy()
    expect(screen.getByText("1 transaction")).toBeTruthy()
    expect(screen.getByText("1–1 of 1")).toBeTruthy()
  })

  it("uses a full-row native button and reports the selected transaction and opener", async () => {
    vi.spyOn(taxmaxi.transactions, "get").mockResolvedValue(detail())
    render(<TransactionsWithInspector {...defaultProps} />)
    const opener = screen.getByRole("button", { name: openName() })
    expect(opener.tagName).toBe("BUTTON")
    expect(opener.getAttribute("type")).toBe("button")
    expect(opener.getAttribute("aria-haspopup")).toBe("dialog")
    expect(opener.getAttribute("aria-expanded")).toBe("false")
    opener.focus()
    fireEvent.click(opener)
    expect(defaultProps.onSelect).toHaveBeenCalledExactlyOnceWith(transaction, opener)
    expect(screen.getAllByRole("dialog")).toHaveLength(1)
    expect(opener.getAttribute("aria-expanded")).toBe("true")
    const close = screen.getByRole("button", { name: m["app.inspector.close"]() })
    expect(document.activeElement).toBe(close)
    fireEvent.click(close)
    await waitFor(() => expect(document.activeElement).toBe(opener))
    expect(opener.getAttribute("aria-expanded")).toBe("false")
  })

  it("disables selection after authentication is lost", () => {
    render(<TransactionsWithInspector {...defaultProps} disabled />)
    const opener = screen.getByRole("button", { name: openName() })
    expect(opener.hasAttribute("disabled")).toBe(true)
    fireEvent.click(opener)
    expect(defaultProps.onSelect).not.toHaveBeenCalled()
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it.each(["complete", "partial"] as const)(
    "shows staking income with %s calculation",
    (calculationState) => {
      render(
        <TransactionsWithInspector
          {...defaultProps}
          transactions={[
            {
              ...transaction,
              transactionType: "staking_reward",
              description: "Staking reward",
              movements: [
                {
                  targetId: "00000000-0000-4000-8000-000000000602",
                  capture: null,
                  amount: "0.01",
                  assetSymbol: "ETH",
                  kind: "income",
                },
              ],
              realizedGainLoss: null,
              income: "12.34",
              calculationState,
            },
          ]}
        />
      )
      expect(screen.getByText("Staking reward")).toBeTruthy()
      expect(screen.getAllByText(/Income/).length).toBe(2)
      expect(screen.queryByText("Realized gain/loss")).toBeNull()
      expect(
        screen.getAllByText(calculationState === "complete" ? "+€12.34" : "Pending").length
      ).toBe(2)
    }
  )

  it("shows income alongside disposal gains", () => {
    render(
      <TransactionsWithInspector
        {...defaultProps}
        transactions={[{ ...transaction, income: "2", realizedGainLoss: "-0.25" }]}
      />
    )
    expect(screen.getAllByText("+€2.00").length).toBe(2)
    expect(screen.getAllByText("−€0.25").length).toBe(2)
  })

  it.each([
    ["0.004", "+<€0.01"],
    ["-0.004", "−<€0.01"],
    ["0", "€0.00"],
  ])("preserves tiny and zero results in rows: %s", (income, expected) => {
    render(
      <TransactionsWithInspector
        {...defaultProps}
        transactions={[
          {
            ...transaction,
            transactionType: "staking_reward",
            description: null,
            movements: [
              {
                targetId: "00000000-0000-4000-8000-000000000603",
                capture: null,
                amount: "0.004",
                assetSymbol: "ETH",
                kind: "income",
              },
            ],
            income,
            realizedGainLoss: null,
          },
        ]}
      />
    )
    expect(screen.getAllByText(expected)).toHaveLength(2)
    expect(screen.getAllByText("Staking reward")).toHaveLength(1)
    expect(screen.queryByText("Not applicable")).toBeNull()
  })

  it("separates incoming, outgoing, and fee movements without rounding token quantities", () => {
    render(
      <TransactionsWithInspector
        {...defaultProps}
        transactions={[
          {
            ...transaction,
            movements: [
              {
                targetId: "00000000-0000-4000-8000-000000000604",
                capture: null,
                amount: "0.000000000000000001",
                assetSymbol: "ETH",
                kind: "acquisition",
              },
              {
                targetId: "00000000-0000-4000-8000-000000000605",
                capture: null,
                amount: "20",
                assetSymbol: "EUR",
                kind: "disposal",
              },
              {
                targetId: "00000000-0000-4000-8000-000000000606",
                capture: null,
                amount: "0",
                assetSymbol: "ETH",
                kind: "fee",
              },
            ],
          },
        ]}
      />
    )
    expect(screen.getByText("Received +0.000000000000000001 ETH")).toBeTruthy()
    expect(screen.getByText("Sent −20 EUR")).toBeTruthy()
    expect(screen.getByText("Fee: 0 ETH")).toBeTruthy()
  })

  it.each(["buy_fiat", "internal_transfer"])(
    "omits inapplicable gain/loss for %s",
    (transactionType) => {
      render(
        <TransactionsWithInspector
          {...defaultProps}
          transactions={[
            {
              ...transaction,
              transactionType,
              description: null,
              income: null,
              realizedGainLoss: null,
              fiatCurrency: null,
              movements:
                transactionType === "internal_transfer"
                  ? [
                      {
                        targetId: "00000000-0000-4000-8000-000000000607",
                        capture: null,
                        amount: "1",
                        assetSymbol: "ETH",
                        kind: "acquisition",
                      },
                      {
                        targetId: "00000000-0000-4000-8000-000000000608",
                        capture: null,
                        amount: "1",
                        assetSymbol: "ETH",
                        kind: "disposal",
                      },
                    ]
                  : [
                      {
                        targetId: "00000000-0000-4000-8000-000000000609",
                        capture: null,
                        amount: "1",
                        assetSymbol: "ETH",
                        kind: "acquisition",
                      },
                    ],
            },
          ]}
        />
      )
      expect(screen.queryByText("Realized gain/loss")).toBeNull()
      expect(screen.queryByText("Unavailable")).toBeNull()
    }
  )

  it.each([false, true])(
    "retains an internal transfer's actual result or separate fee: %s",
    (hasFee) => {
      render(
        <TransactionsWithInspector
          {...defaultProps}
          transactions={[
            {
              ...transaction,
              transactionType: "internal_transfer",
              description: null,
              realizedGainLoss: hasFee ? null : "-0.25",
              movements: [
                {
                  targetId: "00000000-0000-4000-8000-000000000610",
                  capture: null,
                  amount: "1",
                  assetSymbol: "ETH",
                  kind: hasFee ? "fee" : "disposal",
                },
              ],
            },
          ]}
        />
      )
      expect(screen.getAllByText(/Realized gain\/loss/)).toHaveLength(2)
      expect(screen.getAllByText(hasFee ? "Unavailable" : "−€0.25")).toHaveLength(2)
    }
  )

  it("renders scientific decimal strings from the server serializer across all row fields", () => {
    const encoded = BigDecimal.format(BigDecimal.fromStringUnsafe("0.000000000000000001"))
    const loss = BigDecimal.format(BigDecimal.fromStringUnsafe("-0.000000000000000001"))
    expect(encoded).toBe("1e-18")
    expect(loss).toBe("-1e-18")
    render(
      <TransactionsWithInspector
        {...defaultProps}
        transactions={[
          {
            ...transaction,
            transactionType: "staking_reward",
            description: null,
            income: encoded,
            realizedGainLoss: loss,
            movements: [
              {
                targetId: "00000000-0000-4000-8000-000000000611",
                capture: null,
                amount: encoded,
                assetSymbol: "ETH",
                kind: "income",
              },
              {
                targetId: "00000000-0000-4000-8000-000000000612",
                capture: null,
                amount: encoded,
                assetSymbol: "ETH",
                kind: "fee",
              },
            ],
          },
        ]}
      />
    )
    expect(screen.getByText("Received +1e-18 ETH")).toBeTruthy()
    expect(screen.getByText("Fee: 1e-18 ETH")).toBeTruthy()
    expect(screen.getAllByText("+<€0.01")).toHaveLength(2)
    expect(screen.getAllByText("−<€0.01")).toHaveLength(2)
    expect(screen.queryByText(/Unavailable/)).toBeNull()
  })

  it("keeps unavailable movement amounts unsigned", () => {
    render(
      <TransactionsWithInspector
        {...defaultProps}
        transactions={[
          {
            ...transaction,
            movements: [
              {
                targetId: "00000000-0000-4000-8000-000000000613",
                capture: null,
                amount: "invalid",
                assetSymbol: "ETH",
                kind: "acquisition",
              },
            ],
          },
        ]}
      />
    )
    expect(screen.getByText("Received Unavailable")).toBeTruthy()
    expect(screen.queryByText(/Received \+Unavailable/)).toBeNull()
  })

  it("shows incomplete valuation as pending without hiding the transaction row", () => {
    render(
      <TransactionsWithInspector
        {...defaultProps}
        transactions={[
          {
            ...transaction,
            calculationState: "partial",
            realizedGainLoss: null,
            fiatCurrency: null,
          },
        ]}
      />
    )

    expect(screen.getByText("Sold Bitcoin")).toBeTruthy()
    expect(screen.getAllByText("Pending")).toHaveLength(2)
  })

  it("does not label a complete transaction with no gain or loss as pending", () => {
    render(
      <TransactionsWithInspector
        {...defaultProps}
        transactions={[
          {
            ...transaction,
            realizedGainLoss: null,
            fiatCurrency: null,
          },
        ]}
      />
    )

    expect(screen.getAllByText("Unavailable")).toHaveLength(2)
  })

  it("shows gain and calculation state in the compact mobile row", () => {
    const { rerender } = render(<TransactionsWithInspector {...defaultProps} />)

    const mobileGain = screen
      .getAllByText("+€2,000.00")
      .find((element) => element.className.includes("sm:hidden"))
    expect(mobileGain).toBeDefined()

    rerender(
      <TransactionsWithInspector
        {...defaultProps}
        transactions={[
          {
            ...transaction,
            calculationState: "partial",
            realizedGainLoss: null,
            fiatCurrency: null,
          },
        ]}
      />
    )
    const mobilePending = screen
      .getAllByText("Pending")
      .find((element) => element.className.includes("sm:hidden"))
    expect(mobilePending).toBeDefined()
  })

  it("formats gains beyond Number.MAX_SAFE_INTEGER without losing precision", () => {
    render(
      <TransactionsWithInspector
        {...defaultProps}
        transactions={[{ ...transaction, realizedGainLoss: "9007199254740993" }]}
      />
    )

    expect(screen.getAllByText("+€9,007,199,254,740,993.00")).toHaveLength(2)
  })

  it("formats large fractional losses from the exact decimal string", () => {
    render(
      <TransactionsWithInspector
        {...defaultProps}
        transactions={[
          {
            ...transaction,
            realizedGainLoss: "-1234567890123456789012345678.87654321",
          },
        ]}
      />
    )

    expect(screen.getAllByText("−€1,234,567,890,123,456,789,012,345,678.88")).toHaveLength(2)
  })

  it("shows loading, empty, and error states", () => {
    const { rerender } = render(
      <TransactionsWithInspector {...defaultProps} loading transactions={[]} />
    )
    expect(screen.getByRole("status").textContent).toContain("Loading transactions")

    rerender(<TransactionsWithInspector {...defaultProps} totalCount={0} transactions={[]} />)
    expect(screen.getByText("No transactions yet.")).toBeTruthy()

    rerender(<TransactionsWithInspector {...defaultProps} error transactions={[]} />)
    expect(screen.getByText("Transactions could not be loaded.")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(defaultProps.onRetry).toHaveBeenCalledOnce()
  })

  it("exposes previous and next cursor controls", () => {
    const { rerender } = render(
      <TransactionsWithInspector {...defaultProps} hasNextPage totalCount={8} />
    )
    const previous = screen.getByRole("button", { name: "Previous page" })
    const next = screen.getByRole("button", { name: "Next page" })
    expect(previous.hasAttribute("disabled")).toBe(true)
    expect(next.hasAttribute("disabled")).toBe(false)

    fireEvent.click(next)
    expect(defaultProps.onNextPage).toHaveBeenCalledOnce()

    rerender(
      <TransactionsWithInspector {...defaultProps} pageIndex={1} totalCount={8} transactions={[]} />
    )
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }))
    expect(defaultProps.onPreviousPage).toHaveBeenCalledOnce()
  })

  it("can return to the previous page when a later page fails", () => {
    render(
      <TransactionsWithInspector
        {...defaultProps}
        error
        pageIndex={1}
        totalCount={0}
        transactions={[]}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Previous page" }))
    expect(defaultProps.onPreviousPage).toHaveBeenCalledOnce()
  })
})

describe("selected transaction treatment", () => {
  afterEach(() => {
    cleanup()
    clients.splice(0).forEach((client) => client.clear())
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it("loads only opened rows and renders each result's codes and exact decimal strings", async () => {
    const response = detail()
    const allocation = {
      sequence: 0,
      acquisitionEventId: "acquisition",
      dispositionEventId: "disposal",
      assetId: "btc",
      custodyUnitId: "wallet",
      acquiredAt: transaction.timestamp,
      disposedAt: transaction.timestamp,
      quantity: "0.123456789012345678",
      costBasis: "1.234567890123456789",
      proceeds: "2",
      gainLoss: null,
      treatmentCodes: ["de.taxable_private_disposal"],
    }
    const allocations = [
      allocation,
      { ...allocation, sequence: 1, treatmentCodes: ["de.tax_free_holding_period"] },
      { ...allocation, sequence: 2, treatmentCodes: ["future.example"] },
      { ...allocation, sequence: 3, treatmentCodes: [] },
    ]
    const incomeResults = [
      {
        sequence: 0,
        sourceId: "source",
        eventId: "income",
        assetId: "eth",
        occurredAt: transaction.timestamp,
        quantity: "0.123456789012345678",
        value: "0.123456789012345678",
        treatmentCodes: ["de.taxable_income_section22_3_staking"],
      },
    ]
    const get = vi.spyOn(taxmaxi.transactions, "get").mockResolvedValue({
      ...response,
      calculation: { ...response.calculation, allocations, income: incomeResults },
    })
    render(
      <TransactionsWithInspector
        {...defaultProps}
        transactions={[transaction, { ...transaction, transactionId: "other" }]}
        totalCount={2}
      />
    )
    expect(get).not.toHaveBeenCalled()
    const firstToggle = screen.getAllByRole("button", { name: openName() }).at(0)
    if (firstToggle === undefined) throw new Error("Missing disclosure toggle")
    fireEvent.click(firstToggle)
    await screen.findByText("Taxable private disposal")
    expect(get).toHaveBeenCalledExactlyOnceWith({
      transactionId: transaction.transactionId,
      taxYear: 2025,
    })
    expect(screen.getByText("Requested tax year: 2025")).toBeTruthy()
    expect(screen.getByText("Returned run: run-a · 2025 · DE · EUR")).toBeTruthy()
    const first = screen.getByRole("region", { name: "Disposal allocation 1" })
    expect(within(first).getByText("0.123456789012345678")).toBeTruthy()
    expect(within(first).getByText("1.234567890123456789 EUR")).toBeTruthy()
    expect(within(first).getByText("Unavailable")).toBeTruthy()
    expect(within(first).queryByText("Tax-free holding period")).toBeNull()
    expect(
      within(screen.getByRole("region", { name: "Disposal allocation 2" })).getByText(
        "Tax-free holding period"
      )
    ).toBeTruthy()
    expect(
      within(screen.getByRole("region", { name: "Disposal allocation 3" })).getByText(
        "future.example"
      )
    ).toBeTruthy()
    const empty = screen.getByRole("region", { name: "Disposal allocation 4" })
    expect(
      within(empty).getByText(
        "No treatment codes returned. This does not establish tax-free treatment."
      )
    ).toBeTruthy()
    expect(within(empty).queryByText("Tax-free holding period")).toBeNull()
    const income = screen.getByRole("region", { name: "Income result 1" })
    expect(within(income).getByText("Taxable staking income (§ 22 no. 3)")).toBeTruthy()
    expect(within(income).getByText("0.123456789012345678 EUR")).toBeTruthy()
  })

  it("uses the DE calendar year and keeps delayed results isolated across transaction and year changes", async () => {
    let finish: ((value: TransactionDetail) => void) | undefined
    const get = vi
      .spyOn(taxmaxi.transactions, "get")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      .mockResolvedValue(detail())
    const { rerender } = render(
      <TransactionsWithInspector
        {...defaultProps}
        transactions={[{ ...transaction, timestamp: "2025-12-31T23:30:00.000Z" }]}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: openName() }))
    expect(screen.getByText("Loading treatment results…")).toBeTruthy()
    expect(get).toHaveBeenLastCalledWith({
      transactionId: transaction.transactionId,
      taxYear: 2026,
    })
    fireEvent.click(screen.getByRole("button", { name: m["app.inspector.close"]() }))
    rerender(<TransactionsWithInspector {...defaultProps} />)
    fireEvent.click(screen.getByRole("button", { name: openName() }))
    await screen.findByText("Returned run: run-a · 2025 · DE · EUR")
    expect(get).toHaveBeenLastCalledWith({
      transactionId: transaction.transactionId,
      taxYear: 2025,
    })
    const late = detail()
    const lateRun = late.calculation.run
    if (lateRun === null) throw new Error("Missing fixture run")
    await act(async () => {
      finish?.({
        ...late,
        calculation: { ...late.calculation, run: { ...lateRun, id: "old-year" } },
      })
    })
    expect(screen.queryByText(/old-year/)).toBeNull()
    rerender(
      <TransactionsWithInspector
        {...defaultProps}
        transactions={[{ ...transaction, transactionId: "other" }]}
      />
    )
    expect(screen.getByRole("region", { name: /Treatment results/ })).toBeTruthy()
    expect(get).toHaveBeenCalledTimes(2)
  })

  it("keeps the list on failure, retries reads, and distinguishes no run from no result entries", async () => {
    const get = vi
      .spyOn(taxmaxi.transactions, "get")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ ...detail(), calculation: { ...detail().calculation, run: null } })
      .mockResolvedValue(detail())
    render(<TransactionsWithInspector {...defaultProps} />)
    const toggle = screen.getByRole("button", { name: openName() })
    fireEvent.click(toggle)
    await screen.findByText("Could not load treatment results. Try again.")
    expect(screen.getAllByText("Sold Bitcoin").length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole("button", { name: "Retry results" }))
    await screen.findByText("No calculation is available for this requested year.")
    expect(screen.queryByText("Tax-free holding period")).toBeNull()
    expect(get).toHaveBeenCalledTimes(2)
  })
})

describe("treatment lifecycle and monetary status", () => {
  afterEach(() => {
    cleanup()
    clients.splice(0).forEach((client) => client.clear())
    vi.restoreAllMocks()
  })

  it.each(["available", "partial", "unavailable", "not_applicable"] as const)(
    "shows the returned monetary status %s without inventing treatment for empty results",
    async (monetaryStatus) => {
      const response = detail()
      vi.spyOn(taxmaxi.transactions, "get").mockResolvedValue({
        ...response,
        calculation: { ...response.calculation, state: "complete", monetaryStatus },
      })
      render(<TransactionsWithInspector {...defaultProps} />)
      fireEvent.click(screen.getByRole("button", { name: openName() }))
      await screen.findByText(`Monetary results: ${monetaryStatus.replace("_", " ")}.`)
      expect(
        screen.getByText("No disposal allocations or income results were returned.")
      ).toBeTruthy()
      expect(screen.queryByText("Tax-free holding period")).toBeNull()
    }
  )

  it.each([
    ["en", "Treatment results · Transaction"],
    ["de", "Behandlungsergebnisse · Transaktion"],
  ] as const)(
    "localizes missing-description disclosure names in %s",
    async (locale, regionLabel) => {
      const originalUrl = window.location.href
      window.history.replaceState(null, "", "/app")
      await setLocale(locale, { reload: false })
      try {
        vi.spyOn(taxmaxi.transactions, "get").mockResolvedValue(detail())
        render(
          <TransactionsWithInspector
            {...defaultProps}
            transactions={[{ ...transaction, description: null }]}
          />
        )
        fireEvent.click(
          screen.getByRole("button", { name: openName({ ...transaction, description: null }) })
        )
        await screen.findByText(
          locale === "de"
            ? "Zurückgegebener Lauf: run-a · 2025 · DE · EUR"
            : "Returned run: run-a · 2025 · DE · EUR"
        )
        expect(
          screen.getByRole("region", { name: `${regionLabel} · ${transaction.transactionId}` })
        ).toBeTruthy()
      } finally {
        cleanup()
        await setLocale("en", { reload: false })
        window.history.replaceState(null, "", originalUrl)
      }
    }
  )

  it("switches same-year rows in one inspector with unique control and result region names", async () => {
    vi.spyOn(taxmaxi.transactions, "get").mockImplementation(async ({ transactionId }) => ({
      ...detail(),
      transactionId,
    }))
    render(
      <TransactionsWithInspector
        {...defaultProps}
        transactions={[transaction, { ...transaction, transactionId: "other" }]}
        totalCount={2}
      />
    )
    const first = screen.getByRole("button", {
      name: openName(),
    })
    const second = screen.getByRole("button", {
      name: openName({ ...transaction, transactionId: "other" }),
    })
    fireEvent.click(first)
    await screen.findByRole("region", {
      name: `Treatment results · Sold Bitcoin · ${transaction.transactionId}`,
    })
    fireEvent.click(screen.getByRole("button", { name: m["app.inspector.close"]() }))
    fireEvent.click(second)
    expect(
      screen.queryByRole("region", {
        name: `Treatment results · Sold Bitcoin · ${transaction.transactionId}`,
      })
    ).toBeNull()
    expect(
      screen.getByRole("region", { name: "Treatment results · Sold Bitcoin · other" })
    ).toBeTruthy()
  })

  it.each(["success", "failure"] as const)(
    "keeps focus in the disclosure through retry pending and %s",
    async (outcome) => {
      let finish: ((value: TransactionDetail) => void) | undefined
      let fail: ((error: Error) => void) | undefined
      vi.spyOn(taxmaxi.transactions, "get")
        .mockRejectedValueOnce(new Error("offline"))
        .mockImplementationOnce(
          () =>
            new Promise((resolve, reject) => {
              finish = resolve
              fail = reject
            })
        )
      render(<TransactionsWithInspector {...defaultProps} />)
      fireEvent.click(screen.getByRole("button", { name: openName() }))
      const retry = await screen.findByRole("button", { name: "Retry results" })
      retry.focus()
      fireEvent.click(retry)
      const region = screen.getByRole("region", { name: /Treatment results/ })
      expect(document.activeElement).toBe(region)
      await screen.findByText("Loading treatment results…")
      expect(document.activeElement).toBe(region)
      await act(async () => {
        if (outcome === "success") finish?.(detail())
        else fail?.(new Error("offline again"))
      })
      if (outcome === "success") await screen.findByText("Returned run: run-a · 2025 · DE · EUR")
      else await screen.findByRole("button", { name: "Retry results" })
      expect(document.activeElement).toBe(region)
    }
  )

  it("cancels pending delivery on close and starts a fresh read when reopened", async () => {
    let finish: ((value: TransactionDetail) => void) | undefined
    const get = vi
      .spyOn(taxmaxi.transactions, "get")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      .mockResolvedValue(detail())
    render(<TransactionsWithInspector {...defaultProps} />)
    const toggle = screen.getByRole("button", { name: openName() })
    fireEvent.click(toggle)
    expect(screen.getByText("Loading treatment results…")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: m["app.inspector.close"]() }))
    await act(async () => {
      finish?.(detail())
    })
    expect(screen.queryByRole("region", { name: /Treatment results/ })).toBeNull()
    fireEvent.click(toggle)
    await screen.findByText("Returned run: run-a · 2025 · DE · EUR")
    expect(get).toHaveBeenCalledTimes(2)
  })
})
