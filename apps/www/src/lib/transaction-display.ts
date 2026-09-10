import type { TransactionListItem } from "taxmaxi"
import { z } from "zod"
import * as BigDecimal from "effect/BigDecimal"
import * as Option from "effect/Option"
import { m } from "#/paraglide/messages"
import { getLocale } from "#/paraglide/runtime"

const decimal = z.custom<`${number}`>(
  (value) =>
    typeof value === "string" &&
    /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) &&
    Option.isSome(BigDecimal.fromString(value))
)

/** Format exact decimal strings without hiding known nonzero sub-cent values. */
export function formatTransactionAmount({
  value,
  currency,
  locale = getLocale(),
}: {
  readonly value: string | null
  readonly currency: string | null
  readonly locale?: string
}): string {
  const parsed = decimal.safeParse(value)
  if (!parsed.success || currency === null || !/^[A-Z]{3}$/.test(currency)) {
    return m["app.dashboard.transactions.valueUnavailable"]()
  }
  const amount = parsed.data
  const exact = BigDecimal.fromStringUnsafe(amount)
  const zero = BigDecimal.isZero(exact)
  const tiny = !zero && BigDecimal.isLessThan(BigDecimal.abs(exact), BigDecimal.make(1n, 2))
  const formatter = new Intl.NumberFormat(locale, {
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    style: "currency",
  })
  const sign = zero ? "" : amount.startsWith("-") ? "−" : "+"
  const unsigned = decimal.parse(amount.startsWith("-") ? amount.slice(1) : amount)
  return `${sign}${tiny ? "<" : ""}${formatter.format(tiny ? "0.01" : unsigned)}`
}

export function transactionResults(transaction: TransactionListItem) {
  const hasIncome =
    transaction.income !== null || transaction.movements.some(({ kind }) => kind === "income")
  const label = (value: string | null) =>
    value === null && transaction.calculationState === "partial"
      ? m["app.dashboard.transactions.gainLossPending"]()
      : formatTransactionAmount({ value, currency: transaction.fiatCurrency })
  const results = []
  if (hasIncome)
    results.push({
      label: m["app.dashboard.transactions.income"](),
      amount: label(transaction.income),
    })
  if (
    transaction.realizedGainLoss !== null ||
    transaction.movements.some(
      ({ kind }) =>
        kind === "fee" ||
        (kind === "disposal" && transaction.transactionType !== "internal_transfer")
    )
  ) {
    results.push({
      label: transaction.movements.some(
        ({ kind, capture }) => kind === "fee" && (capture?.realizedResults.length ?? 0) > 0
      )
        ? m["app.dashboard.transactions.totalGainLoss"]()
        : m["app.dashboard.transactions.realizedGainLoss"](),
      amount: label(transaction.realizedGainLoss),
    })
  }
  return results
}

export function transactionMovementLabel(movement: Movement): string {
  const parsed = decimal.safeParse(movement.amount)
  const amount = parsed.success ? parsed.data.replace(/^-/, "") : null
  const value =
    amount === null
      ? m["app.dashboard.transactions.valueUnavailable"]()
      : `${amount} ${movement.assetSymbol}`
  if (movement.kind === "fee") return m["app.dashboard.transactions.feeMovement"]({ amount: value })
  return movement.kind === "acquisition" || movement.kind === "income"
    ? m["app.dashboard.transactions.receivedMovement"]({
        amount: amount === null ? value : `+${value}`,
      })
    : m["app.dashboard.transactions.sentMovement"]({
        amount: amount === null ? value : `−${value}`,
      })
}

type Movement = TransactionListItem["movements"][number]
type DisplayFact = { readonly label: string; readonly amount: string }

/** Present recorded movement money without substituting valuation for consideration or basis. */
export function transactionMovementFacts(movement: Movement): ReadonlyArray<DisplayFact> {
  const capture = movement.capture
  const facts: Array<DisplayFact> = []
  const add = (label: string, value: string | null, currency: string | null) =>
    facts.push({ label, amount: formatTransactionAmount({ value, currency }) })
  const fee = movement.kind === "fee"
  const providerLabel = fee
    ? m["app.dashboard.transactions.feePaid"]()
    : capture?.cause === "purchase"
      ? m["app.dashboard.transactions.paid"]()
      : capture?.cause === "sale"
        ? m["app.dashboard.transactions.receivedValue"]()
        : m["app.dashboard.transactions.providerAmount"]()
  for (const value of capture?.providerConsiderations ?? [])
    add(providerLabel, value.amount, value.currency)
  if (
    capture?.cause === "purchase" ||
    capture?.cause === "sale" ||
    capture?.eventKind === "custody_movement"
  ) {
    if (capture.providerConsiderations.length === 0) add(providerLabel, null, null)
  }
  const selected = capture?.selectedValue
  if (selected !== undefined && selected !== null) {
    const label = fee
      ? m["app.dashboard.transactions.feeValuation"]()
      : selected.kind === "market_quote"
        ? m["app.dashboard.transactions.marketValuation"]()
        : selected.kind === "user_valuation"
          ? m["app.dashboard.transactions.userValuation"]()
          : m["app.dashboard.transactions.selectedConsideration"]()
    add(label, selected.amount, selected.currency)
  } else if (fee || capture?.eventKind === "acquisition") {
    add(
      fee
        ? m["app.dashboard.transactions.feeValue"]()
        : m["app.dashboard.transactions.valuation"](),
      null,
      null
    )
  }
  const results = capture?.realizedResults ?? []
  const currencies = [...new Set(results.map((result) => result.currency))]
  for (const currency of currencies) {
    const inCurrency = results.filter((result) => result.currency === currency)
    const sum = (field: "proceeds" | "costBasis" | "gainLoss") => {
      let total = BigDecimal.make(0n, 0)
      for (const result of inCurrency) {
        const parsed = decimal.safeParse(result[field])
        if (!parsed.success) return null
        total = BigDecimal.sum(total, BigDecimal.fromStringUnsafe(parsed.data))
      }
      return BigDecimal.format(total)
    }
    if (fee) add(m["app.dashboard.transactions.feeGainLoss"](), sum("gainLoss"), currency)
    else {
      add(m["app.dashboard.transactions.proceeds"](), sum("proceeds"), currency)
      add(m["app.dashboard.transactions.costBasis"](), sum("costBasis"), currency)
    }
  }
  if (
    !fee &&
    (capture === null || capture.eventKind === null) &&
    (selected === undefined || selected === null)
  )
    add(m["app.dashboard.transactions.movementValue"](), null, null)
  if (!fee && capture?.eventKind === "disposition" && results.length === 0)
    add(m["app.dashboard.transactions.proceeds"](), null, null)
  return facts
}

/** Label only the cause captured for this movement, without inventing a row-wide category. */
export function transactionMovementCause(movement: Movement): string | null {
  switch (movement.capture?.cause) {
    case "purchase":
      return m["app.dashboard.transactions.causes.purchase"]()
    case "sale":
      return m["app.dashboard.transactions.causes.sale"]()
    case "gift":
      return m["app.dashboard.transactions.causes.gift"]()
    case "airdrop":
      return m["app.dashboard.transactions.types.airdrop"]()
    case "mining_reward":
      return m["app.dashboard.transactions.types.mining_reward"]()
    case "staking_reward":
      return m["app.dashboard.transactions.types.staking_reward"]()
    case "passive_staking_reward":
      return m["app.dashboard.transactions.causes.passiveStaking"]()
    case "reward":
      return m["app.dashboard.transactions.causes.reward"]()
    case "payment":
      return m["app.dashboard.transactions.causes.payment"]()
    case "fee":
      return null
    case "unknown":
      return m["app.dashboard.transactions.unclassified"]()
    default:
      return null
  }
}

export function transactionTypeLabel(value: string | null): string {
  switch (value) {
    case "airdrop":
      return m["app.dashboard.transactions.types.airdrop"]()
    case "bounty":
      return m["app.dashboard.transactions.types.bounty"]()
    case "cashback":
      return m["app.dashboard.transactions.types.cashback"]()
    case "fork_income":
      return m["app.dashboard.transactions.types.fork_income"]()
    case "gift_received":
      return m["app.dashboard.transactions.types.gift_received"]()
    case "governance_reward":
      return m["app.dashboard.transactions.types.governance_reward"]()
    case "interest_received":
      return m["app.dashboard.transactions.types.interest_received"]()
    case "mining_reward":
      return m["app.dashboard.transactions.types.mining_reward"]()
    case "masternode_reward":
      return m["app.dashboard.transactions.types.masternode_reward"]()
    case "other_income":
      return m["app.dashboard.transactions.types.other_income"]()
    case "security_token_income":
      return m["app.dashboard.transactions.types.security_token_income"]()
    case "staking_reward":
      return m["app.dashboard.transactions.types.staking_reward"]()
    case "yield_farming_reward":
      return m["app.dashboard.transactions.types.yield_farming_reward"]()
    case "payment_received":
      return m["app.dashboard.transactions.types.payment_received"]()
    case "derivative_profit_received":
      return m["app.dashboard.transactions.types.derivative_profit_received"]()
    case "fee":
      return m["app.dashboard.transactions.types.fee"]()
    case "platform_fee":
      return m["app.dashboard.transactions.types.platform_fee"]()
    case "gas_fee":
      return m["app.dashboard.transactions.types.gas_fee"]()
    case "gift_sent":
      return m["app.dashboard.transactions.types.gift_sent"]()
    case "donation_sent":
      return m["app.dashboard.transactions.types.donation_sent"]()
    case "lost":
      return m["app.dashboard.transactions.types.lost"]()
    case "theft":
      return m["app.dashboard.transactions.types.theft"]()
    case "burn":
      return m["app.dashboard.transactions.types.burn"]()
    case "payment_sent":
      return m["app.dashboard.transactions.types.payment_sent"]()
    case "withholding_tax_paid":
      return m["app.dashboard.transactions.types.withholding_tax_paid"]()
    case "derivative_fee_paid":
      return m["app.dashboard.transactions.types.derivative_fee_paid"]()
    case "transaction_cost":
      return m["app.dashboard.transactions.types.transaction_cost"]()
    case "internal_transfer":
      return m["app.dashboard.transactions.types.internal_transfer"]()
    case "bridging_transfer":
      return m["app.dashboard.transactions.types.bridging_transfer"]()
    case "token_migration_transfer":
      return m["app.dashboard.transactions.types.token_migration_transfer"]()
    case "buy_fiat":
      return m["app.dashboard.transactions.types.buy_fiat"]()
    case "sell_fiat":
      return m["app.dashboard.transactions.types.sell_fiat"]()
    case "swap_crypto_to_crypto":
      return m["app.dashboard.transactions.types.swap_crypto_to_crypto"]()
    case "trade_other":
      return m["app.dashboard.transactions.types.trade_other"]()
    case "open_derivative_position":
      return m["app.dashboard.transactions.types.open_derivative_position"]()
    case "close_derivative_position":
      return m["app.dashboard.transactions.types.close_derivative_position"]()
    case "funding_payment_paid":
      return m["app.dashboard.transactions.types.funding_payment_paid"]()
    case "funding_payment_received":
      return m["app.dashboard.transactions.types.funding_payment_received"]()
    case "margin_interest_paid":
      return m["app.dashboard.transactions.types.margin_interest_paid"]()
    case "liquidation":
      return m["app.dashboard.transactions.types.liquidation"]()
    case "staking_deposit":
      return m["app.dashboard.transactions.types.staking_deposit"]()
    case "staking_withdrawal":
      return m["app.dashboard.transactions.types.staking_withdrawal"]()
    case "lend_deposit":
      return m["app.dashboard.transactions.types.lend_deposit"]()
    case "lend_withdrawal":
      return m["app.dashboard.transactions.types.lend_withdrawal"]()
    case "borrow":
      return m["app.dashboard.transactions.types.borrow"]()
    case "repay_loan":
      return m["app.dashboard.transactions.types.repay_loan"]()
    case "collateral_deposit":
      return m["app.dashboard.transactions.types.collateral_deposit"]()
    case "collateral_withdrawal":
      return m["app.dashboard.transactions.types.collateral_withdrawal"]()
    case "add_liquidity":
      return m["app.dashboard.transactions.types.add_liquidity"]()
    case "remove_liquidity":
      return m["app.dashboard.transactions.types.remove_liquidity"]()
    case "nft_mint":
      return m["app.dashboard.transactions.types.nft_mint"]()
    case "nft_buy":
      return m["app.dashboard.transactions.types.nft_buy"]()
    case "nft_sell":
      return m["app.dashboard.transactions.types.nft_sell"]()
    case "nft_transfer":
      return m["app.dashboard.transactions.types.nft_transfer"]()
    case "nft_royalty_income":
      return m["app.dashboard.transactions.types.nft_royalty_income"]()
    case "nft_royalty_expense":
      return m["app.dashboard.transactions.types.nft_royalty_expense"]()
    case "spam":
      return m["app.dashboard.transactions.types.spam"]()
    case "refund":
      return m["app.dashboard.transactions.types.refund"]()
    case "chargeback":
      return m["app.dashboard.transactions.types.chargeback"]()
    case "uncategorized":
      return m["app.dashboard.transactions.types.uncategorized"]()
    default:
      return m["app.dashboard.transactions.unclassified"]()
  }
}
