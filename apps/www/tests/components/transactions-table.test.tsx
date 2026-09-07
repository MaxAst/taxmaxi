// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render as testingRender,
  screen,
  within,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TaxMaxi, type TransactionDetail, type TransactionListItem } from "taxmaxi"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactElement } from "react"

import { setLocale } from "#/paraglide/runtime"

import { TransactionsTable } from "#/components/transactions-table"

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
  movements: [{ amount: "0.4", assetSymbol: "BTC", kind: "disposal" }],
  realizedGainLoss: "2000",
  fiatCurrency: "EUR",
  calculationState: "complete",
  needsReview: false,
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
  disabled: false,
  onUnauthorized: vi.fn(),
  error: false,
  hasNextPage: false,
  loading: false,
  onNextPage: vi.fn(),
  onPreviousPage: vi.fn(),
  onRetry: vi.fn(),
  pageIndex: 0,
  totalCount: 1,
  transactions: [transaction],
}

describe("TransactionsTable", () => {
  afterEach(() => {
    cleanup()
    clients.splice(0).forEach((client) => client.clear())
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it("renders real compact rows and the exact total", () => {
    render(<TransactionsTable {...defaultProps} />)

    expect(screen.getByText("Sold Bitcoin")).toBeTruthy()
    expect(screen.getByText("0.4 BTC")).toBeTruthy()
    expect(screen.getByText("Coinbase")).toBeTruthy()
    expect(screen.getByText("1 transaction")).toBeTruthy()
    expect(screen.getByText("1–1 of 1")).toBeTruthy()
  })

  it("shows incomplete valuation as pending without hiding the transaction row", () => {
    render(
      <TransactionsTable
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
      <TransactionsTable
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

    expect(screen.getAllByText("Not applicable")).toHaveLength(2)
  })

  it("shows gain and calculation state in the compact mobile row", () => {
    const { rerender } = render(<TransactionsTable {...defaultProps} />)

    const mobileGain = screen
      .getAllByText("+€2,000.00")
      .find((element) => element.className.includes("sm:hidden"))
    expect(mobileGain).toBeDefined()

    rerender(
      <TransactionsTable
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
      <TransactionsTable
        {...defaultProps}
        transactions={[{ ...transaction, realizedGainLoss: "9007199254740993" }]}
      />
    )

    expect(screen.getAllByText("+€9,007,199,254,740,993.00")).toHaveLength(2)
  })

  it("formats large fractional losses from the exact decimal string", () => {
    render(
      <TransactionsTable
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
    const { rerender } = render(<TransactionsTable {...defaultProps} loading transactions={[]} />)
    expect(screen.getByRole("status").textContent).toContain("Loading transactions")

    rerender(<TransactionsTable {...defaultProps} totalCount={0} transactions={[]} />)
    expect(screen.getByText("No transactions yet.")).toBeTruthy()

    rerender(<TransactionsTable {...defaultProps} error transactions={[]} />)
    expect(screen.getByText("Transactions could not be loaded.")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(defaultProps.onRetry).toHaveBeenCalledOnce()
  })

  it("exposes previous and next cursor controls", () => {
    const { rerender } = render(<TransactionsTable {...defaultProps} hasNextPage totalCount={8} />)
    const previous = screen.getByRole("button", { name: "Previous page" })
    const next = screen.getByRole("button", { name: "Next page" })
    expect(previous.hasAttribute("disabled")).toBe(true)
    expect(next.hasAttribute("disabled")).toBe(false)

    fireEvent.click(next)
    expect(defaultProps.onNextPage).toHaveBeenCalledOnce()

    rerender(<TransactionsTable {...defaultProps} pageIndex={1} totalCount={8} transactions={[]} />)
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }))
    expect(defaultProps.onPreviousPage).toHaveBeenCalledOnce()
  })

  it("can return to the previous page when a later page fails", () => {
    render(
      <TransactionsTable {...defaultProps} error pageIndex={1} totalCount={0} transactions={[]} />
    )

    fireEvent.click(screen.getByRole("button", { name: "Previous page" }))
    expect(defaultProps.onPreviousPage).toHaveBeenCalledOnce()
  })
})

describe("transaction treatment disclosure", () => {
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
      <TransactionsTable
        {...defaultProps}
        transactions={[transaction, { ...transaction, transactionId: "other" }]}
        totalCount={2}
      />
    )
    expect(get).not.toHaveBeenCalled()
    const firstToggle = screen.getAllByRole("button", { name: /Treatment · 2025/ }).at(0)
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
      <TransactionsTable
        {...defaultProps}
        transactions={[{ ...transaction, timestamp: "2025-12-31T23:30:00.000Z" }]}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: /Treatment · 2026/ }))
    expect(screen.getByText("Loading treatment results…")).toBeTruthy()
    expect(get).toHaveBeenLastCalledWith({
      transactionId: transaction.transactionId,
      taxYear: 2026,
    })
    rerender(<TransactionsTable {...defaultProps} />)
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
      <TransactionsTable
        {...defaultProps}
        transactions={[{ ...transaction, transactionId: "other" }]}
      />
    )
    expect(screen.queryByRole("region", { name: /Treatment results/ })).toBeNull()
    expect(get).toHaveBeenCalledTimes(2)
  })

  it("keeps the list on failure, retries reads, and distinguishes no run from no result entries", async () => {
    const get = vi
      .spyOn(taxmaxi.transactions, "get")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ ...detail(), calculation: { ...detail().calculation, run: null } })
      .mockResolvedValue(detail())
    render(<TransactionsTable {...defaultProps} />)
    const toggle = screen.getByRole("button", { name: /Treatment · 2025/ })
    fireEvent.click(toggle)
    await screen.findByText("Could not load treatment results. Try again.")
    expect(screen.getByText("Sold Bitcoin")).toBeTruthy()
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
      render(<TransactionsTable {...defaultProps} />)
      fireEvent.click(screen.getByRole("button", { name: /Treatment · 2025/ }))
      await screen.findByText(`Monetary results: ${monetaryStatus.replace("_", " ")}.`)
      expect(
        screen.getByText("No disposal allocations or income results were returned.")
      ).toBeTruthy()
      expect(screen.queryByText("Tax-free holding period")).toBeNull()
    }
  )

  it.each([
    ["en", "Treatment · 2025 · Transaction", "Treatment results · Transaction"],
    ["de", "Behandlung · 2025 · Transaktion", "Behandlungsergebnisse · Transaktion"],
  ] as const)(
    "localizes missing-description disclosure names in %s",
    async (locale, toggleLabel, regionLabel) => {
      const originalUrl = window.location.href
      window.history.replaceState(null, "", "/app")
      setLocale(locale, { reload: false })
      try {
        vi.spyOn(taxmaxi.transactions, "get").mockResolvedValue(detail())
        render(
          <TransactionsTable
            {...defaultProps}
            transactions={[{ ...transaction, description: null }]}
          />
        )
        fireEvent.click(
          screen.getByRole("button", { name: `${toggleLabel} · ${transaction.transactionId}` })
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
        setLocale("en", { reload: false })
        window.history.replaceState(null, "", originalUrl)
      }
    }
  )

  it("gives same-year rows unique control and result region names", async () => {
    vi.spyOn(taxmaxi.transactions, "get").mockImplementation(async ({ transactionId }) => ({
      ...detail(),
      transactionId,
    }))
    render(
      <TransactionsTable
        {...defaultProps}
        transactions={[transaction, { ...transaction, transactionId: "other" }]}
        totalCount={2}
      />
    )
    const first = screen.getByRole("button", {
      name: `Treatment · 2025 · Sold Bitcoin · ${transaction.transactionId}`,
    })
    const second = screen.getByRole("button", { name: "Treatment · 2025 · Sold Bitcoin · other" })
    fireEvent.click(first)
    fireEvent.click(second)
    expect(
      screen.getByRole("region", {
        name: `Treatment results · Sold Bitcoin · ${transaction.transactionId}`,
      })
    ).toBeTruthy()
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
      render(<TransactionsTable {...defaultProps} />)
      fireEvent.click(screen.getByRole("button", { name: /Treatment · 2025/ }))
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
    render(<TransactionsTable {...defaultProps} />)
    const toggle = screen.getByRole("button", { name: /Treatment · 2025/ })
    fireEvent.click(toggle)
    expect(screen.getByText("Loading treatment results…")).toBeTruthy()
    fireEvent.click(toggle)
    await act(async () => {
      finish?.(detail())
    })
    expect(screen.queryByRole("region", { name: /Treatment results/ })).toBeNull()
    fireEvent.click(toggle)
    await screen.findByText("Returned run: run-a · 2025 · DE · EUR")
    expect(get).toHaveBeenCalledTimes(2)
  })
})
