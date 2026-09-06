/**
 * Valuation facts supplied separately from the factual ledger.
 *
 * @module accounting/ValuationFact
 */

import * as Schema from "effect/Schema"
import { CURRENCIES_BY_CODE } from "../currency/Currency.ts"
import { MonetaryAmount } from "../shared/values/MonetaryAmount.ts"
import { Timestamp } from "../shared/values/Timestamp.ts"
import { AccountingEventId } from "./AccountingEvent.ts"

const NonEmptyString = Schema.Trimmed.check(Schema.isNonEmpty())
const SupportedFiatMonetaryAmount = MonetaryAmount.pipe(
  Schema.check(
    Schema.makeFilter((amount) =>
      CURRENCIES_BY_CODE.has(amount.currency)
        ? undefined
        : `Unsupported fiat currency: ${amount.currency}`
    )
  )
)

const NonNegativeObservedAmount = SupportedFiatMonetaryAmount.pipe(
  Schema.check(
    Schema.makeFilter((amount) =>
      amount.isNegative ? "Observed consideration must not be negative." : undefined
    )
  )
)

const PositiveMarketQuoteUnitPrice = SupportedFiatMonetaryAmount.pipe(
  Schema.check(
    Schema.makeFilter((amount) =>
      amount.isPositive ? undefined : "Market quote unit price must be positive."
    )
  )
)

/** Provider-reported non-negative total consideration for one accounting event. */
export const ObservedConsiderationFact = Schema.TaggedStruct("observed_consideration", {
  eventId: AccountingEventId,
  amount: NonNegativeObservedAmount,
  evidenceReference: NonEmptyString,
}).annotate({
  identifier: "ObservedConsiderationFact",
  title: "Observed Consideration Fact",
  description: "Non-negative total money reported by a provider; zero is valid",
})

/** The ObservedConsiderationFact type. */
export type ObservedConsiderationFact = typeof ObservedConsiderationFact.Type

/** Strictly positive market unit-price quote available for one accounting event. */
export const MarketQuoteFact = Schema.TaggedStruct("market_quote", {
  eventId: AccountingEventId,
  unitPrice: PositiveMarketQuoteUnitPrice,
  quotedAt: Timestamp,
  source: NonEmptyString,
}).annotate({
  identifier: "MarketQuoteFact",
  title: "Market Quote Fact",
  description: "Strictly positive market unit-price quote available for one accounting event",
})

/** The MarketQuoteFact type. */
export type MarketQuoteFact = typeof MarketQuoteFact.Type

/** Resolved non-negative total supplied by a user for exactly one accounting event. */
export const UserValuationFact = Schema.TaggedStruct("user_valuation", {
  eventId: AccountingEventId,
  amount: SupportedFiatMonetaryAmount.check(
    Schema.makeFilter((amount) =>
      amount.isNegative ? "User valuation must not be negative." : undefined
    )
  ),
  evidenceReference: NonEmptyString,
}).annotate({
  identifier: "UserValuationFact",
  title: "User Valuation Fact",
  description: "Resolved exact user-supplied total; zero is known valuation, not missing evidence",
})

/** The UserValuationFact type. */
export type UserValuationFact = typeof UserValuationFact.Type

/**
 * Money evidence available to the accounting engine for one event.
 *
 * User valuation, provider-observed consideration and market quotes remain distinct.
 * A single user valuation wins; otherwise the engine prefers provider evidence. A
 * stored amount that was calculated from a quote is not observed consideration.
 * When an event needs money and has none of these facts, the engine returns a
 * machine-readable blocker and never substitutes zero.
 */
export const ValuationFact = Schema.Union([
  ObservedConsiderationFact,
  MarketQuoteFact,
  UserValuationFact,
]).annotate({
  identifier: "ValuationFact",
  title: "Valuation Fact",
  description: "User valuation, observed consideration or market quote for one accounting event",
})

/** The ValuationFact type. */
export type ValuationFact = typeof ValuationFact.Type
