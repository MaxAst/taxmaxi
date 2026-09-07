import { ChevronLeft, ChevronRight, CircleAlert, Landmark, WalletCards } from "lucide-react"
import type { TransactionListItem } from "taxmaxi"

import { Badge } from "#/components/ui/badge"
import { Button } from "#/components/ui/button"
import { m } from "#/paraglide/messages"
import { getLocale } from "#/paraglide/runtime"

export const TRANSACTION_PAGE_SIZE = 7

const formatDate = (timestamp: string): string =>
  new Intl.DateTimeFormat(getLocale(), {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(timestamp))

const formatTime = (timestamp: string): string =>
  new Intl.DateTimeFormat(getLocale(), {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp))

const gainLossFormatter = (currency: string) =>
  new Intl.NumberFormat(getLocale(), {
    currency,
    maximumFractionDigits: 2,
    style: "currency",
  })

const isDecimalString = (value: string): value is `${number}` =>
  /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)

const isZeroDecimal = (value: `${number}`): boolean => /^-?0(?:\.0+)?$/.test(value)

const typeLabel = (value: string | null): string => {
  if (value === null) return m["app.dashboard.transactions.unclassified"]()
  const words = value.replaceAll("_", " ").replaceAll("-", " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const movementLabel = (transaction: TransactionListItem): string => {
  if (transaction.movements.length === 0) {
    return m["app.dashboard.transactions.movementsPending"]()
  }

  const visible = transaction.movements
    .slice(0, 2)
    .map((movement) => `${movement.amount} ${movement.assetSymbol}`)
    .join(" · ")
  const remaining = transaction.movements.length - 2
  return remaining > 0
    ? `${visible} · ${m["app.dashboard.transactions.movementsMore"]({ count: remaining })}`
    : visible
}

const realizedGainLossLabel = (transaction: TransactionListItem): string => {
  if (transaction.calculationState === "partial") {
    return m["app.dashboard.transactions.gainLossPending"]()
  }
  if (transaction.realizedGainLoss === null || transaction.fiatCurrency === null) {
    return m["app.dashboard.transactions.gainLossNotApplicable"]()
  }

  const value = transaction.realizedGainLoss
  if (!isDecimalString(value)) return m["app.dashboard.transactions.gainLossPending"]()

  const absoluteValue = value.startsWith("-") ? value.slice(1) : value
  if (!isDecimalString(absoluteValue)) return m["app.dashboard.transactions.gainLossPending"]()

  const formatted = gainLossFormatter(transaction.fiatCurrency).format(absoluteValue)
  const sign = isZeroDecimal(value) ? "" : value.startsWith("-") ? "−" : "+"
  return `${sign}${formatted}`
}

export function TransactionsTable({
  disabled,
  onSelect,
  selectedTransactionId,
  error,
  hasNextPage,
  loading,
  onNextPage,
  onPreviousPage,
  onRetry,
  pageIndex,
  totalCount,
  transactions,
}: {
  readonly disabled: boolean
  readonly onSelect: (transaction: TransactionListItem, trigger: HTMLElement) => void
  readonly selectedTransactionId: string | null
  readonly error: boolean
  readonly hasNextPage: boolean
  readonly loading: boolean
  readonly onNextPage: () => void
  readonly onPreviousPage: () => void
  readonly onRetry: () => void
  readonly pageIndex: number
  readonly totalCount: number
  readonly transactions: ReadonlyArray<TransactionListItem>
}) {
  const visibleStart = transactions.length === 0 ? 0 : pageIndex * TRANSACTION_PAGE_SIZE + 1
  const visibleEnd = Math.min(pageIndex * TRANSACTION_PAGE_SIZE + transactions.length, totalCount)
  const totalLabel =
    totalCount === 1
      ? m["app.dashboard.transactions.totalOne"]({ count: totalCount })
      : m["app.dashboard.transactions.totalMany"]({ count: totalCount })
  const pageLabel =
    error && totalCount === 0
      ? m["app.dashboard.transactions.pageUnavailable"]()
      : m["app.dashboard.transactions.pageRange"]({
          end: visibleEnd,
          start: visibleStart,
          total: totalCount,
        })

  return (
    <section aria-busy={loading} className="flex min-w-0 flex-col gap-5">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {m["app.dashboard.transactions.eyebrow"]()}
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight">
            {m["app.dashboard.transactions.title"]()}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {m["app.dashboard.transactions.description"]()}
          </p>
        </div>
        <Badge className="w-fit" variant="secondary">
          {totalLabel}
        </Badge>
      </header>

      <div className="overflow-hidden rounded-xl border bg-background shadow-sm">
        {loading && transactions.length === 0 ? (
          <div
            className="flex min-h-48 items-center justify-center px-4 text-sm text-muted-foreground"
            role="status"
          >
            {m["app.dashboard.transactions.loading"]()}
          </div>
        ) : error ? (
          <div className="flex min-h-48 flex-col items-center justify-center gap-3 px-4 text-center">
            <div>
              <p className="font-medium">{m["app.dashboard.transactions.loadErrorTitle"]()}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {m["app.dashboard.transactions.loadErrorHint"]()}
              </p>
            </div>
            <Button onClick={onRetry} size="sm" variant="outline">
              {m["app.dashboard.transactions.retry"]()}
            </Button>
          </div>
        ) : transactions.length === 0 ? (
          <div className="flex min-h-48 items-center justify-center px-4 text-sm text-muted-foreground">
            {m["app.dashboard.transactions.empty"]()}
          </div>
        ) : (
          <div className="divide-y">
            {transactions.map((transaction) => (
              <article
                data-selected={transaction.transactionId === selectedTransactionId}
                className="relative grid min-h-20 grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-3 px-3 py-3.5 sm:grid-cols-[8rem_minmax(0,1fr)_minmax(8rem,auto)] sm:px-4 data-[selected=true]:bg-muted/40"
                key={transaction.transactionId}
              >
                <button
                  aria-label={m["app.inspector.open"]({
                    description: transaction.description ?? m["app.treatment.transaction"](),
                    transactionId: transaction.transactionId,
                  })}
                  aria-haspopup="dialog"
                  aria-expanded={transaction.transactionId === selectedTransactionId}
                  className="absolute inset-0 min-h-11 w-full cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default"
                  disabled={disabled}
                  onClick={(event) => onSelect(transaction, event.currentTarget)}
                  type="button"
                />
                <div>
                  <div className="text-sm font-medium tabular-nums">
                    {formatDate(transaction.timestamp)}
                  </div>
                  <div className="text-xs tabular-nums text-muted-foreground">
                    {formatTime(transaction.timestamp)}
                  </div>
                </div>

                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <Badge className="shrink-0" variant="outline">
                      {typeLabel(transaction.transactionType)}
                    </Badge>
                    <span className="truncate font-medium">
                      {transaction.description ?? typeLabel(transaction.transactionType)}
                    </span>
                    {transaction.needsReview ? (
                      <CircleAlert
                        aria-label={m["app.dashboard.transactions.needsReview"]()}
                        className="size-4 shrink-0 text-amber-600 dark:text-amber-300"
                      />
                    ) : null}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {movementLabel(transaction)}
                  </p>
                  <p className="mt-1 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                    {transaction.source.kind === "cex" ? (
                      <Landmark className="size-3.5 shrink-0" />
                    ) : (
                      <WalletCards className="size-3.5 shrink-0" />
                    )}
                    {transaction.source.name}
                  </p>
                  <p className="mt-2 text-sm font-semibold tabular-nums sm:hidden">
                    <span className="sr-only">
                      {m["app.dashboard.transactions.realizedGainLoss"]()}:{" "}
                    </span>
                    {realizedGainLossLabel(transaction)}
                  </p>
                </div>

                <div className="hidden text-right sm:block">
                  <p className="font-semibold tabular-nums">{realizedGainLossLabel(transaction)}</p>
                  <p className="text-xs text-muted-foreground">
                    {m["app.dashboard.transactions.realizedGainLoss"]()}
                  </p>
                </div>
              </article>
            ))}
          </div>
        )}

        {totalCount > 0 || pageIndex > 0 ? (
          <nav
            aria-label={m["app.dashboard.transactions.pagesLabel"]()}
            className="flex items-center justify-between gap-3 border-t bg-muted/20 px-3 py-3 sm:px-4"
          >
            <p className="text-xs tabular-nums text-muted-foreground">{pageLabel}</p>
            <div className="flex items-center gap-2">
              <Button
                aria-label={m["app.dashboard.transactions.previousPage"]()}
                disabled={loading || pageIndex === 0}
                onClick={onPreviousPage}
                size="sm"
                variant="outline"
              >
                <ChevronLeft data-icon="inline-start" />
                {m["app.dashboard.transactions.previous"]()}
              </Button>
              <Button
                aria-label={m["app.dashboard.transactions.nextPage"]()}
                disabled={loading || !hasNextPage}
                onClick={onNextPage}
                size="sm"
                variant="outline"
              >
                {m["app.dashboard.transactions.next"]()}
                <ChevronRight data-icon="inline-end" />
              </Button>
            </div>
          </nav>
        ) : null}
      </div>
    </section>
  )
}
