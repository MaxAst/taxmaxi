import { z } from "zod"
import type { TransactionListInput } from "taxmaxi"
import { m } from "#/paraglide/messages"

const category = z.enum([
  "purchase",
  "sale",
  "gift",
  "airdrop",
  "mining_reward",
  "staking",
  "staking_reward",
  "passive_staking_reward",
  "reward",
  "payment",
  "unknown",
  "custody_movement",
])
const ids = z
  .array(z.uuid())
  .transform((values) => [...new Set(values.map((value) => value.toLowerCase()))].sort())
  .optional()
const localDate = z.iso.date()
const timezone = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value })
    return true
  } catch {
    return false
  }
})

/** URL dates are inclusive calendar dates in the saved timezone, never browser-local instants. */
const transactionFilterSearchSchema = z
  .object({
    sourceIds: ids,
    assetIds: ids,
    categories: z
      .array(category)
      .transform((values) => [...new Set(values)].sort())
      .optional(),
    from: localDate.optional(),
    // The inclusive end needs a following day inside the four-digit ISO range.
    to: localDate.refine((date) => date !== "9999-12-31").optional(),
    timezone: timezone.optional(),
    order: z.enum(["newest", "oldest"]).optional(),
    attention: z.boolean().optional(),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to)

export type TransactionFilters = z.output<typeof transactionFilterSearchSchema>
export const EMPTY_TRANSACTION_FILTERS: TransactionFilters = {}

/** Route errors display only localized copy, never raw schema issues or URL values. */
export function parseTransactionFilters(input: unknown): TransactionFilters {
  const result = transactionFilterSearchSchema.safeParse(input)
  if (result.success) {
    const { from, to } = transactionFilterInput(result.data)
    if (from !== undefined && to !== undefined && Date.parse(from) >= Date.parse(to)) {
      throw new Error(m["app.transactionFilters.invalidUrl"]())
    }
    return result.data
  }

  const reversedDates = result.error.issues.some(
    (issue) => issue.code === "custom" && issue.path.length === 0
  )
  throw new Error(
    reversedDates
      ? m["app.transactionFilters.reversedDates"]()
      : m["app.transactionFilters.invalidUrl"]()
  )
}

/** Keep other /app and child-route search keys while validating the filter boundary. */
export function validateTransactionSearch(search: Record<string, unknown>) {
  return { ...search, ...parseTransactionFilters(search) }
}

export function updateTransactionSearch(
  search: Record<string, unknown>,
  filters: TransactionFilters
) {
  const rest = { ...search }
  for (const key of [
    "sourceIds",
    "assetIds",
    "categories",
    "from",
    "to",
    "timezone",
    "order",
    "attention",
  ]) {
    delete rest[key]
  }
  return { ...rest, ...parseTransactionFilters(filters) }
}

function dayStart(date: string, timeZone: string): string {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  const dayAt = (instant: number) => {
    const parts = format.formatToParts(instant)
    return ["year", "month", "day"]
      .map((type) => parts.find((part) => part.type === type)?.value)
      .join("-")
  }
  // Find the first instant belonging to this local day. This also handles
  // zones whose clock jumps at midnight and days skipped by offset changes.
  const center = Date.parse(`${date}T00:00:00Z`)
  let low = center - 48 * 60 * 60 * 1000
  let high = center + 48 * 60 * 60 * 1000
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (dayAt(middle) < date) low = middle + 1
    else high = middle
  }
  return new Date(low).toISOString()
}

/** Convert inclusive local dates to the API's UTC half-open interval across DST. */
export function transactionFilterInput(filters: TransactionFilters): TransactionListInput {
  const timeZone = filters.timezone ?? "Europe/Berlin"
  let end: string | undefined
  if (filters.to) {
    const nextDay = new Date(`${filters.to}T00:00:00Z`)
    nextDay.setUTCDate(nextDay.getUTCDate() + 1)
    end = dayStart(nextDay.toISOString().slice(0, 10), timeZone)
  }
  return {
    ...(filters.sourceIds?.length ? { sourceIds: filters.sourceIds } : {}),
    ...(filters.assetIds?.length ? { assetIds: filters.assetIds } : {}),
    ...(filters.categories?.length ? { categories: filters.categories } : {}),
    ...(filters.from ? { from: dayStart(filters.from, timeZone) } : {}),
    ...(end ? { to: end } : {}),
    ...(filters.order ? { order: filters.order } : {}),
    ...(filters.attention !== undefined ? { attention: filters.attention } : {}),
  }
}
