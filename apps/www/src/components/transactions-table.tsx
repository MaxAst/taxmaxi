import { ChevronLeft, ChevronRight, CircleAlert, Landmark, WalletCards } from "lucide-react"
import type { TransactionListItem } from "taxmaxi"
import { z } from "zod"

import { Badge } from "#/components/ui/badge"
import { Button } from "#/components/ui/button"
import { m } from "#/paraglide/messages"
import { getLocale } from "#/paraglide/runtime"
import {
  transactionMovements,
  transactionResults,
  transactionTypeLabel,
} from "#/lib/transaction-display"

export const TRANSACTION_PAGE_SIZE = 25
export const TRANSACTION_PAGE_SIZES = [25, 50, 100, 500] as const
export type TransactionPageSize = (typeof TRANSACTION_PAGE_SIZES)[number]
const pageSizeSchema = z.coerce
  .number()
  .pipe(z.union([z.literal(25), z.literal(50), z.literal(100), z.literal(500)]))

export function parseTransactionPageSize(value: unknown): TransactionPageSize {
  const parsed = pageSizeSchema.safeParse(value)
  return parsed.success ? parsed.data : TRANSACTION_PAGE_SIZE
}

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
  pageSize,
  onPageSizeChange,
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
  readonly pageSize: TransactionPageSize
  readonly onPageSizeChange: (size: TransactionPageSize) => void
  readonly totalCount: number
  readonly transactions: ReadonlyArray<TransactionListItem>
}) {
  const visibleStart = transactions.length === 0 ? 0 : pageIndex * pageSize + 1
  const visibleEnd = Math.min(pageIndex * pageSize + transactions.length, totalCount)
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
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            {m["app.dashboard.transactions.pageSize"]()}
            <select
              className="min-h-11 rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              value={pageSize}
              disabled={disabled}
              onChange={(event) =>
                onPageSizeChange(parseTransactionPageSize(event.currentTarget.value))
              }
            >
              {TRANSACTION_PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {m["app.dashboard.transactions.pageSizeOption"]({ count: size })}
                </option>
              ))}
            </select>
          </label>
          <Badge className="w-fit" variant="secondary">
            {totalLabel}
          </Badge>
        </div>
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
                    <span className="truncate font-medium">
                      {transactionTypeLabel(transaction.transactionType)}
                    </span>
                    {transaction.needsReview ? (
                      <CircleAlert
                        aria-label={m["app.dashboard.transactions.needsReview"]()}
                        className="size-4 shrink-0 text-amber-600 dark:text-amber-300"
                      />
                    ) : null}
                  </div>
                  {transaction.description !== null &&
                  transaction.description.toLocaleLowerCase() !==
                    transactionTypeLabel(transaction.transactionType).toLocaleLowerCase() ? (
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {transaction.description}
                    </p>
                  ) : null}
                  <div className="mt-1 flex flex-col gap-0.5 text-xs tabular-nums text-muted-foreground">
                    {transaction.movements.length === 0 ? (
                      <p>{m["app.dashboard.transactions.movementsPending"]()}</p>
                    ) : (
                      transactionMovements(transaction).map((movement, index) => (
                        <p key={index}>{movement}</p>
                      ))
                    )}
                  </div>
                  <p className="mt-1 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                    {transaction.source.kind === "cex" ? (
                      <Landmark className="size-3.5 shrink-0" />
                    ) : (
                      <WalletCards className="size-3.5 shrink-0" />
                    )}
                    {transaction.source.name}
                  </p>
                  {transactionResults(transaction).map((result) => (
                    <p
                      key={result.label}
                      className="mt-2 text-sm font-semibold tabular-nums sm:hidden"
                    >
                      <span className="text-muted-foreground">{result.label}: </span>
                      {result.amount}
                    </p>
                  ))}
                </div>

                <div className="hidden text-right sm:block">
                  {transactionResults(transaction).map((result) => (
                    <div key={result.label}>
                      <p className="font-semibold tabular-nums">{result.amount}</p>
                      <p className="text-xs text-muted-foreground">{result.label}</p>
                    </div>
                  ))}
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
