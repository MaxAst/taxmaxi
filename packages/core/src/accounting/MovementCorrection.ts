/**
 * Movement correction inputs and compatibility rules; application lives in the factual loader.
 *
 * @module accounting/MovementCorrection
 */
import * as BigDecimal from "effect/BigDecimal"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { CURRENCIES_BY_CODE } from "../currency/Currency.ts"
import { CurrencyCode } from "../currency/CurrencyCode.ts"
import { PrincipalId } from "../ownership/Principal.ts"
import { SourceId } from "../source/Source.ts"
import { AcquisitionCause } from "./AccountingEvent.ts"
import { AccountingQuantity } from "./AccountingQuantity.ts"

const NonEmptyString = Schema.Trimmed.check(Schema.isNonEmpty())
const Uuid = Schema.String.check(Schema.isUUID())
const PositiveQuantity = AccountingQuantity.check(
  Schema.isGreaterThanBigDecimal(BigDecimal.fromBigInt(0n))
)
const ExactAmount = Schema.String.check(Schema.isPattern(/^\d+(?:\.\d+)?$/))
const ReportingCurrency = CurrencyCode.check(
  Schema.makeFilter((currency) =>
    CURRENCIES_BY_CODE.has(currency) ? undefined : "Unsupported reporting currency"
  )
)

/** Durable target row ID; it is never a regenerated transaction-leg ID. */
export const MovementCorrectionTargetId = Uuid.pipe(Schema.brand("MovementCorrectionTargetId"))
export type MovementCorrectionTargetId = typeof MovementCorrectionTargetId.Type

/** Explicit producer evidence identity; component keys must never be current list positions. */
export const MovementCorrectionTargetIdentity = Schema.Struct({
  principalId: PrincipalId,
  sourceId: SourceId,
  sourceRecordKey: NonEmptyString,
  componentKey: NonEmptyString,
})
export type MovementCorrectionTargetIdentity = typeof MovementCorrectionTargetIdentity.Type

/** Independent append-only correction streams. */
export const MovementCorrectionKind = Schema.Literals(["price", "classification"])
export type MovementCorrectionKind = typeof MovementCorrectionKind.Type

/** Exact entered value, retained as text with its chosen mode and currency. */
export const MovementPriceInput = Schema.Union([
  Schema.TaggedStruct("unit_price", { amount: ExactAmount, currency: ReportingCurrency }),
  Schema.TaggedStruct("total_value", { amount: ExactAmount, currency: ReportingCurrency }),
]).annotate({ parseOptions: { onExcessProperty: "error" } })
export type MovementPriceInput = typeof MovementPriceInput.Type

/** User assertions of supported causes; these do not claim provider confirmation. */
export const MovementClassificationInput = Schema.Union([
  Schema.TaggedStruct("inbound", { cause: AcquisitionCause }),
  Schema.TaggedStruct("outbound", {
    cause: Schema.Literals(["sale", "gift", "payment", "unknown"]),
  }),
]).annotate({ parseOptions: { onExcessProperty: "error" } })
export type MovementClassificationInput = typeof MovementClassificationInput.Type

/** The only two editable inputs; audit metadata is supplied by the authenticated writer. */
export const MovementCorrectionInput = Schema.Union([
  Schema.TaggedStruct("price", { input: MovementPriceInput }),
  Schema.TaggedStruct("classification", { input: MovementClassificationInput }),
]).annotate({ parseOptions: { onExcessProperty: "error" } })
export type MovementCorrectionInput = typeof MovementCorrectionInput.Type

/** Structural facts inspected by a user and retained independently of later system conclusions. */
export const MovementCorrectionFacts = Schema.Struct({
  target: MovementCorrectionTargetIdentity,
  systemRevision: NonEmptyString,
  quantity: PositiveQuantity,
  economicAssetId: Schema.NullOr(Uuid),
  direction: Schema.Literals(["inbound", "outbound"]),
  structure: Schema.Literals(["ownership_change", "fee", "custody"]),
}).check(
  Schema.makeFilter((facts) =>
    facts.structure === "fee" && facts.direction !== "outbound"
      ? "An explicit fee must be outbound"
      : undefined
  )
)
export type MovementCorrectionFacts = typeof MovementCorrectionFacts.Type

/** Invalid replacement input; callers reject it before writing history or scheduling work. */
export class MovementCorrectionInputError extends Schema.TaggedError<MovementCorrectionInputError>()(
  "MovementCorrectionInputError",
  {
    code: Schema.Literals([
      "reporting_currency_mismatch",
      "classification_direction_mismatch",
      "fee_classification_forbidden",
      "custody_correction_forbidden",
    ]),
  }
) {}

/** Validate classification against the server's recorded structure, never caller-provided facts. */
export const validateMovementClassification = ({
  input,
  facts,
}: {
  readonly input: MovementClassificationInput
  readonly facts: MovementCorrectionFacts
}): Effect.Effect<void, MovementCorrectionInputError> => {
  if (facts.structure === "custody") {
    return Effect.fail(new MovementCorrectionInputError({ code: "custody_correction_forbidden" }))
  }
  if (facts.structure === "fee") {
    return Effect.fail(new MovementCorrectionInputError({ code: "fee_classification_forbidden" }))
  }
  if (facts.direction !== input._tag) {
    return Effect.fail(
      new MovementCorrectionInputError({ code: "classification_direction_mismatch" })
    )
  }
  return Effect.void
}

/** Application is withheld after structural changes; a new system revision alone stays applicable. */
export type MovementCorrectionCompatibility =
  | { readonly _tag: "applicable"; readonly stale: boolean }
  | {
      readonly _tag: "needs_attention"
      readonly reason:
        | "target_disappeared"
        | "target_changed"
        | "quantity_changed"
        | "asset_changed"
        | "structure_changed"
    }

/** Compare recorded identities directly, never search for a replacement target by row shape. */
export const movementCorrectionCompatibility = ({
  inspected,
  current,
}: {
  readonly inspected: MovementCorrectionFacts
  readonly current: MovementCorrectionFacts | null
}): MovementCorrectionCompatibility => {
  if (current === null) return { _tag: "needs_attention", reason: "target_disappeared" }
  if (
    inspected.target.principalId !== current.target.principalId ||
    inspected.target.sourceId !== current.target.sourceId ||
    inspected.target.sourceRecordKey !== current.target.sourceRecordKey ||
    inspected.target.componentKey !== current.target.componentKey
  )
    return { _tag: "needs_attention", reason: "target_changed" }
  if (!BigDecimal.equals(inspected.quantity, current.quantity)) {
    return { _tag: "needs_attention", reason: "quantity_changed" }
  }
  if (inspected.economicAssetId !== current.economicAssetId) {
    return { _tag: "needs_attention", reason: "asset_changed" }
  }
  if (inspected.direction !== current.direction || inspected.structure !== current.structure) {
    return { _tag: "needs_attention", reason: "structure_changed" }
  }
  return { _tag: "applicable", stale: inspected.systemRevision !== current.systemRevision }
}

const formatDecimal = (value: BigDecimal.BigDecimal): string => {
  if (value.scale <= 0) return (value.value * 10n ** BigInt(-value.scale)).toString()
  const digits = value.value.toString().padStart(value.scale + 1, "0")
  return `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`
}

// Reduce the fraction before checking whether its decimal expansion terminates.
const unitPreview = (total: BigDecimal.BigDecimal, quantity: AccountingQuantity) => {
  const shift = quantity.scale - total.scale
  const numerator = shift >= 0 ? total.value * 10n ** BigInt(shift) : total.value
  const denominator = shift >= 0 ? quantity.value : quantity.value * 10n ** BigInt(-shift)
  let a = numerator
  let b = denominator
  while (b !== 0n) {
    const remainder = a % b
    a = b
    b = remainder
  }
  let reducedDenominator = denominator / a
  let twos = 0
  let fives = 0
  while (reducedDenominator % 2n === 0n) {
    reducedDenominator /= 2n
    twos++
  }
  while (reducedDenominator % 5n === 0n) {
    reducedDenominator /= 5n
    fives++
  }
  const rounded = reducedDenominator !== 1n
  const scale = rounded ? 18 : Math.max(twos, fives)
  const scaledNumerator = numerator * 10n ** BigInt(scale)
  const quotient = scaledNumerator / denominator
  const remainder = scaledNumerator % denominator
  const value = quotient + (remainder * 2n >= denominator ? 1n : 0n)
  return { amount: formatDecimal(BigDecimal.make(value, scale)), rounded }
}

/** Exact authoritative total plus a unit preview that must never be used to reconstruct that total. */
export interface ResolvedMovementPrice {
  readonly input: MovementPriceInput
  readonly quantity: AccountingQuantity
  readonly currency: CurrencyCode
  readonly totalValue: string
  readonly unitPrice: { readonly amount: string; readonly rounded: boolean }
}

/** Resolve validated decimal input using the server's positive quantity and calculation currency. */
export const resolveMovementPrice = ({
  input,
  facts,
  reportingCurrency,
}: {
  readonly input: MovementPriceInput
  readonly facts: MovementCorrectionFacts
  readonly reportingCurrency: CurrencyCode
}): Effect.Effect<ResolvedMovementPrice, MovementCorrectionInputError> => {
  if (facts.structure === "custody") {
    return Effect.fail(new MovementCorrectionInputError({ code: "custody_correction_forbidden" }))
  }
  if (input.currency !== reportingCurrency) {
    return Effect.fail(new MovementCorrectionInputError({ code: "reporting_currency_mismatch" }))
  }
  const amount = BigDecimal.fromStringUnsafe(input.amount)
  return Effect.succeed({
    input,
    quantity: facts.quantity,
    currency: input.currency,
    totalValue:
      input._tag === "total_value"
        ? input.amount
        : formatDecimal(BigDecimal.multiply(amount, facts.quantity)),
    unitPrice:
      input._tag === "unit_price"
        ? { amount: input.amount, rounded: false }
        : unitPreview(amount, facts.quantity),
  })
}
