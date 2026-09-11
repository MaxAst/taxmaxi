import { ChevronLeft, ChevronRight, CircleAlert, Landmark, WalletCards } from "lucide-react"
import type { TransactionListItem } from "taxmaxi"
import { z } from "zod"

import { Badge } from "#/components/ui/badge"
import { Button } from "#/components/ui/button"
import { m } from "#/paraglide/messages"
import { getLocale } from "#/paraglide/runtime"
import {
  transactionMovementLabel,
  transactionMovementFacts,
  transactionMovementCause,
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
    <section aria-busy={loading} className="@container flex min-w-0 flex-col gap-5">
      <header className="flex flex-col gap-2 @min-[36rem]:flex-row @min-[36rem]:items-end @min-[36rem]:justify-between">
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
        <div
          className="h-[min(32rem,60vh)] overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
          data-transaction-body
        >
          {loading && transactions.length === 0 ? (
            <div role="status" aria-label={m["app.dashboard.transactions.loading"]()}>
              <span className="sr-only">{m["app.dashboard.transactions.loading"]()}</span>
              <div aria-hidden="true" className="divide-y">
                {Array.from({ length: 6 }, (_, index) => (
                  <div
                    key={index}
                    data-transaction-skeleton
                    className="grid min-h-20 grid-cols-[5.5rem_minmax(0,1fr)] gap-3 px-3 py-3.5 sm:px-4"
                  >
                    <div className="h-4 w-16 rounded bg-muted" />
                    <div className="space-y-2">
                      <div className="h-4 w-2/3 rounded bg-muted" />
                      <div className="h-3 w-1/2 rounded bg-muted" />
                      <div className="h-3 w-1/3 rounded bg-muted" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : error && transactions.length === 0 ? (
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
                  className="relative grid min-h-20 grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-3 px-3 py-3.5 @min-[36rem]:grid-cols-[8rem_minmax(0,1fr)_minmax(8rem,auto)] sm:px-4 data-[selected=true]:bg-muted/40"
                  key={transaction.transactionId}
                >
                  <button
                    aria-label={m["app.inspector.open"]({
                      description: transaction.description ?? m["app.treatment.transaction"](),
                      transactionId: transaction.transactionId,
                    })}
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
                      {transaction.attention ? (
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
                        transaction.movements.map((movement) => {
                          const cause = transactionMovementCause(movement)
                          return (
                            <div key={movement.targetId} className="space-y-0.5">
                              <p>
                                {transactionMovementLabel(movement)}
                                {cause !== null &&
                                cause !== transactionTypeLabel(transaction.transactionType) ? (
                                  <> · {cause}</>
                                ) : null}
                              </p>
                              {transactionMovementFacts(movement).map((fact, factIndex) => (
                                <p key={`${fact.label}-${factIndex}`}>
                                  {fact.label}: {fact.amount}
                                </p>
                              ))}
                            </div>
                          )
                        })
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
                        className="mt-2 text-sm font-semibold tabular-nums @min-[36rem]:hidden"
                      >
                        <span className="text-muted-foreground">{result.label}: </span>
                        {result.amount}
                      </p>
                    ))}
                  </div>

                  <div className="hidden text-right @min-[36rem]:block">
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
        </div>
        <nav
          aria-label={m["app.dashboard.transactions.pagesLabel"]()}
          className="flex h-24 items-center justify-between gap-3 border-t bg-muted/20 px-3 py-3 sm:px-4"
        >
          <div className="min-w-0 text-xs tabular-nums text-muted-foreground">
            <p>
              {loading && transactions.length === 0
                ? m["app.dashboard.transactions.loading"]()
                : pageLabel}
            </p>
            {error && transactions.length > 0 ? (
              <button
                type="button"
                onClick={onRetry}
                className="min-h-11 text-left text-destructive underline"
              >
                {m["app.dashboard.transactions.pageRetry"]()}
              </button>
            ) : null}
          </div>
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
      </div>
    </section>
  )
}
