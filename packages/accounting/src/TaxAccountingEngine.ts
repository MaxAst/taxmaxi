/**
 * Stateless tax-accounting engine over a factual ledger.
 *
 * @module accounting/TaxAccountingEngine
 */

import {
  AccountingMethodId,
  CustodyUnitId,
  multiplyByQuantity,
  prorate,
  type AccountingChoice,
  type AccountingChoiceId,
  type AccountingEvent,
  type AccountingEventId,
  type AccountingMethodChoice,
  AccountingQuantity,
  type AcquisitionEvent,
  type CustodyMovementEvent,
  type DispositionEvent,
  type InventoryScope,
  type InventoryScopeChoice,
  type JurisdictionCode,
  type MarketQuoteFact,
  type ObservedConsiderationFact,
  type TaxYear,
  type ValuationFact,
} from "@my/core/accounting"
import { divide, MonetaryAmount, round, subtract } from "@my/core/shared/values/MonetaryAmount"
import type { Timestamp } from "@my/core/shared/values/Timestamp"
import * as BigDecimal from "effect/BigDecimal"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { allocateFifoQuantity } from "./FifoLotMatcher.ts"
import {
  GERMAN_APPLIED_RULES,
  GERMAN_RULE_SET_VERSION,
  germanAcquisitionBlocker,
  germanAcquisitionIncomeTreatment,
  germanDispositionBlocker,
  germanPrivateDisposalTreatment,
  germanTaxYearEndExclusive,
  germanTaxYearOf,
  IllegalGermanAccountingChoiceError,
  isGermanJurisdiction,
  resolveGermanAccountingPolicy,
  type GermanBlockerCode,
} from "./GermanJurisdiction.ts"

/** Version recorded for every result produced by this engine contract. */
export const ACCOUNTING_ENGINE_VERSION = "1"

export { GERMAN_RULE_SET_VERSION, germanTaxYearEndExclusive }

type ChoiceKind = AccountingChoice["_tag"]

/** A required structural accounting choice could not be resolved. */
export class AccountingChoiceResolutionError extends Schema.TaggedError<AccountingChoiceResolutionError>()(
  "AccountingChoiceResolutionError",
  {
    choiceKind: Schema.Literals(["accounting_method", "inventory_scope"]),
    reason: Schema.Literals(["missing", "multiple_active", "broken_supersession", "cycle"]),
  }
) {}

/** No jurisdiction module exists for the requested jurisdiction code. */
export class UnsupportedJurisdictionError extends Schema.TaggedError<UnsupportedJurisdictionError>()(
  "UnsupportedJurisdictionError",
  { jurisdiction: Schema.String }
) {}

/** Failures caused by invalid structural engine configuration. */
export type TaxAccountingError =
  | AccountingChoiceResolutionError
  | IllegalGermanAccountingChoiceError
  | UnsupportedJurisdictionError

/** One factual quantity match between an acquisition and a disposition. */
export interface FactualFifoAllocation {
  readonly acquisitionEventId: AccountingEventId
  readonly dispositionEventId: AccountingEventId
  readonly assetId: string
  readonly custodyUnitId: CustodyUnitId
  readonly acquiredAt: Timestamp
  readonly disposedAt: Timestamp
  readonly quantity: AccountingQuantity
  readonly costBasis: MonetaryAmount | null
}

/** Factual money proved for one fully valued FIFO allocation. */
export interface RealizedResult {
  readonly acquisitionEventId: AccountingEventId
  readonly dispositionEventId: AccountingEventId
  readonly custodySourceId: DispositionEvent["custodySourceId"]
  readonly allocationSequence: number
  readonly assetId: string
  readonly acquiredAt: Timestamp
  readonly disposedAt: Timestamp
  readonly quantity: AccountingQuantity
  readonly costBasis: MonetaryAmount
  readonly proceeds: MonetaryAmount
  readonly gainLoss: MonetaryAmount
  readonly treatmentCodes: ReadonlyArray<string>
}

/** One remaining acquisition lot after the supplied ledger is processed. */
export interface DerivedLot {
  readonly acquisitionEventId: AccountingEventId
  readonly assetId: string
  readonly custodyUnitId: CustodyUnitId
  readonly acquiredAt: Timestamp
  readonly remainingQuantity: AccountingQuantity
  readonly costBasisPerUnit: MonetaryAmount | null
}

/** Jurisdiction-neutral blocker emitted by factual FIFO and valuation processing. */
export type StructuralBlockerCode =
  | "unknown_cause"
  | "missing_valuation"
  | "ambiguous_valuation"
  | "valuation_currency_mismatch"
  | "inventory_shortage"
  | "movement_shortage"
  | "blocked_inventory_suffix"

/** Machine-readable fact that kept the structural result from being complete. */
export interface TaxAccountingBlocker {
  readonly code: StructuralBlockerCode | GermanBlockerCode
  readonly eventId: AccountingEventId
  readonly assetId: string
  readonly custodyUnitId: CustodyUnitId
  readonly missingQuantity: AccountingQuantity | null
}

/** Jurisdiction-neutral income result shape populated by a jurisdiction module. */
export interface IncomeResult {
  readonly eventId: AccountingEventId
  readonly custodySourceId: AcquisitionEvent["custodySourceId"]
  readonly assetId: string
  readonly occurredAt: Timestamp
  readonly quantity: AccountingQuantity
  readonly value: MonetaryAmount
  readonly treatmentCodes: ReadonlyArray<string>
}

/** Quantity taken from one acquisition by an explained engine step. */
export interface ExplanationMatch {
  readonly acquisitionEventId: AccountingEventId
  readonly quantity: AccountingQuantity
}

/** One deterministic machine-readable explanation entry. */
export interface ExplanationEntry {
  readonly sequence: number
  readonly eventId: AccountingEventId
  readonly code: string
  readonly valuationKind: ValuationFact["_tag"] | null
  readonly matches: ReadonlyArray<ExplanationMatch>
}

/** Complete structural output of one pure engine invocation. */
export interface TaxAccountingResult {
  readonly status: "complete" | "partial"
  readonly jurisdiction: JurisdictionCode
  readonly taxYear: TaxYear
  readonly engineVersion: string
  readonly ruleSetVersion: string
  readonly accountingMethod: AccountingMethodId
  readonly inventoryScope: InventoryScope
  readonly appliedChoiceIds: ReadonlyArray<AccountingChoiceId>
  readonly appliedRules: ReadonlyArray<string>
  readonly processedEventIds: ReadonlyArray<AccountingEventId>
  readonly allocations: ReadonlyArray<FactualFifoAllocation>
  readonly realizedResults: ReadonlyArray<RealizedResult>
  readonly incomeResults: ReadonlyArray<IncomeResult>
  readonly derivedLots: ReadonlyArray<DerivedLot>
  readonly blockers: ReadonlyArray<TaxAccountingBlocker>
  readonly explanationTrace: ReadonlyArray<ExplanationEntry>
}

/** Inputs to the pure tax-accounting engine. */
export interface CalculateInput {
  readonly ledger: ReadonlyArray<AccountingEvent>
  readonly jurisdiction: JurisdictionCode
  readonly taxYear: TaxYear
  readonly accountingChoices: ReadonlyArray<AccountingChoice>
  readonly valuationFacts: ReadonlyArray<ValuationFact>
}

interface UserBasis {
  readonly total: MonetaryAmount
  readonly scale: number
}

interface EngineLot extends DerivedLot {
  readonly id: string
  readonly userBasis: UserBasis | null
}

// User totals are allocated from the remaining balance, never a rounded unit preview.
// The final portion receives the exact residual; FIFO only calls this with positive quantities.
const splitUserTotal = ({
  total,
  part,
  whole,
  scale,
}: {
  readonly total: MonetaryAmount
  readonly part: AccountingQuantity
  readonly whole: AccountingQuantity
  readonly scale: number
}) =>
  Effect.gen(function* () {
    const allocated = BigDecimal.equals(part, whole)
      ? total
      : yield* prorate({ total, part, whole, scale }).pipe(Effect.orDie)
    const remaining = MonetaryAmount.fromBigDecimal(
      BigDecimal.subtract(total.amount, allocated.amount),
      total.currency
    )
    return { allocated, remaining, scale }
  })

interface EngineState {
  readonly inventories: Map<string, EngineLot[]>
  readonly allocations: FactualFifoAllocation[]
  readonly realizedResults: RealizedResult[]
  readonly incomeResults: IncomeResult[]
  readonly blockers: TaxAccountingBlocker[]
  readonly explanationTrace: ExplanationEntry[]
  readonly blockedInventoryKeys: Set<string>
}

interface ValuationSelection {
  readonly _tag: "selected"
  readonly total: MonetaryAmount
  readonly kind: ValuationFact["_tag"]
}

interface MissingValuation {
  readonly _tag: "missing"
}

interface AmbiguousValuation {
  readonly _tag: "ambiguous"
}

type ValuationResolution = ValuationSelection | MissingValuation | AmbiguousValuation

const compareEvents = (left: AccountingEvent, right: AccountingEvent): number => {
  const timeDifference = left.occurredAt.epochMillis - right.occurredAt.epochMillis

  return timeDifference === 0 ? left.id.localeCompare(right.id) : timeDifference
}

type ChoiceByKind<Kind extends ChoiceKind> = Extract<AccountingChoice, { readonly _tag: Kind }>

const hasChoiceKind = <Kind extends ChoiceKind>(
  choice: AccountingChoice,
  choiceKind: Kind
): choice is ChoiceByKind<Kind> => choice._tag === choiceKind

const resolveChoice = <Kind extends ChoiceKind>({
  choices,
  jurisdiction,
  choiceKind,
}: {
  readonly choices: ReadonlyArray<AccountingChoice>
  readonly jurisdiction: JurisdictionCode
  readonly choiceKind: Kind
}): Effect.Effect<ChoiceByKind<Kind>, AccountingChoiceResolutionError> => {
  const relevant = choices.filter(
    (choice): choice is ChoiceByKind<Kind> =>
      hasChoiceKind(choice, choiceKind) && choice.jurisdiction === jurisdiction
  )
  const choiceById = new Map(relevant.map((choice) => [choice.id, choice]))

  for (const choice of relevant) {
    if (choice.supersedesChoiceId !== undefined && !choiceById.has(choice.supersedesChoiceId)) {
      return Effect.fail(
        new AccountingChoiceResolutionError({
          choiceKind,
          reason: "broken_supersession",
        })
      )
    }

    const visited = new Set<AccountingChoiceId>()
    let current: ChoiceByKind<Kind> | undefined = choice

    while (current !== undefined) {
      if (visited.has(current.id)) {
        return Effect.fail(
          new AccountingChoiceResolutionError({
            choiceKind,
            reason: "cycle",
          })
        )
      }

      visited.add(current.id)
      current =
        current.supersedesChoiceId === undefined
          ? undefined
          : choiceById.get(current.supersedesChoiceId)
    }
  }

  const supersededIds = new Set(
    relevant.flatMap((choice) =>
      choice.supersedesChoiceId === undefined ? [] : [choice.supersedesChoiceId]
    )
  )
  const active = relevant.filter((choice) => !supersededIds.has(choice.id))

  const resolved = active[0]

  return active.length === 1 && resolved !== undefined
    ? Effect.succeed(resolved)
    : Effect.fail(
        new AccountingChoiceResolutionError({
          choiceKind,
          reason: active.length === 0 ? "missing" : "multiple_active",
        })
      )
}

const resolveChoiceOrNull = <Kind extends ChoiceKind>({
  choices,
  jurisdiction,
  choiceKind,
}: {
  readonly choices: ReadonlyArray<AccountingChoice>
  readonly jurisdiction: JurisdictionCode
  readonly choiceKind: Kind
}): Effect.Effect<ChoiceByKind<Kind> | null, AccountingChoiceResolutionError> => {
  const hasRelevantChoice = choices.some(
    (choice) => hasChoiceKind(choice, choiceKind) && choice.jurisdiction === jurisdiction
  )

  return hasRelevantChoice
    ? resolveChoice({ choices, jurisdiction, choiceKind })
    : Effect.succeed(null)
}

const selectValuation = ({
  event,
  valuationFacts,
}: {
  readonly event: AccountingEvent
  readonly valuationFacts: ReadonlyArray<ValuationFact>
}): ValuationResolution => {
  const facts = valuationFacts.filter((fact) => fact.eventId === event.id)
  const userFacts = facts.filter((fact) => fact._tag === "user_valuation")
  if (userFacts.length > 1) return { _tag: "ambiguous" }
  const userFact = userFacts[0]
  if (userFact !== undefined) {
    return { _tag: "selected", total: userFact.amount, kind: userFact._tag }
  }

  const observed = facts.filter(
    (fact): fact is ObservedConsiderationFact => fact._tag === "observed_consideration"
  )

  if (observed.length > 1) {
    return { _tag: "ambiguous" }
  }

  const observedFact = observed[0]

  if (observedFact !== undefined) {
    return {
      _tag: "selected",
      total: observedFact.amount,
      kind: observedFact._tag,
    }
  }

  const quotes = facts.filter((fact): fact is MarketQuoteFact => fact._tag === "market_quote")

  if (quotes.length > 1) {
    return { _tag: "ambiguous" }
  }

  const quote = quotes[0]

  return quote === undefined
    ? { _tag: "missing" }
    : {
        _tag: "selected",
        total: multiplyByQuantity(quote.unitPrice, event.quantity),
        kind: quote._tag,
      }
}

const inventoryKey = ({
  assetId,
  custodyUnitId,
  inventoryScope,
}: {
  readonly assetId: string
  readonly custodyUnitId: CustodyUnitId
  readonly inventoryScope: InventoryScope
}): string => (inventoryScope === "whole_taxpayer" ? assetId : `${assetId}:${custodyUnitId}`)

const makeCustodyUnitId = (sourceId: string): CustodyUnitId => CustodyUnitId.make(sourceId)

const compareLots = (left: EngineLot, right: EngineLot): number => {
  const timeDifference = left.acquiredAt.epochMillis - right.acquiredAt.epochMillis

  if (timeDifference !== 0) {
    return timeDifference
  }

  const eventDifference = left.acquisitionEventId.localeCompare(right.acquisitionEventId)

  return eventDifference === 0 ? left.id.localeCompare(right.id) : eventDifference
}

const sortLots = (lots: ReadonlyArray<EngineLot>): EngineLot[] => [...lots].sort(compareLots)

const toDerivedLots = (inventories: ReadonlyMap<string, ReadonlyArray<EngineLot>>): DerivedLot[] =>
  [...inventories.values()]
    .flat()
    .filter((lot) => lot.remainingQuantity.value !== 0n)
    .map(({ id: _id, userBasis: _userBasis, ...lot }) => lot)

const appendExplanation = ({
  state,
  eventId,
  code,
  valuationKind,
  matches = [],
}: {
  readonly state: EngineState
  readonly eventId: AccountingEventId
  readonly code: string
  readonly valuationKind: ValuationFact["_tag"] | null
  readonly matches?: ReadonlyArray<ExplanationMatch>
}): void => {
  state.explanationTrace.push({
    sequence: state.explanationTrace.length,
    eventId,
    code,
    valuationKind,
    matches,
  })
}

const appendBlocker = ({
  state,
  code,
  eventId,
  assetId,
  custodyUnitId,
  missingQuantity = null,
  valuationKind = null,
  matches = [],
}: {
  readonly state: EngineState
  readonly code: TaxAccountingBlocker["code"]
  readonly eventId: AccountingEventId
  readonly assetId: string
  readonly custodyUnitId: CustodyUnitId
  readonly missingQuantity?: AccountingQuantity | null
  readonly valuationKind?: ValuationFact["_tag"] | null
  readonly matches?: ReadonlyArray<ExplanationMatch>
}): void => {
  state.blockers.push({ code, eventId, assetId, custodyUnitId, missingQuantity })
  appendExplanation({
    state,
    eventId,
    code: `blocker.${code}`,
    valuationKind,
    matches,
  })
}

const appendValuationBlocker = ({
  state,
  event,
  custodyUnitId,
  valuationResolution,
}: {
  readonly state: EngineState
  readonly event: AcquisitionEvent | DispositionEvent
  readonly custodyUnitId: CustodyUnitId
  readonly valuationResolution: MissingValuation | AmbiguousValuation
}): void =>
  appendBlocker({
    state,
    code: valuationResolution._tag === "ambiguous" ? "ambiguous_valuation" : "missing_valuation",
    eventId: event.id,
    assetId: event.assetId,
    custodyUnitId,
  })

const processCustodyMovement = ({
  event,
  inventoryScope,
  state,
}: {
  readonly event: CustodyMovementEvent
  readonly inventoryScope: InventoryScope
  readonly state: EngineState
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (inventoryScope === "whole_taxpayer") {
      appendExplanation({
        state,
        eventId: event.id,
        code: "pooled_custody_movement",
        valuationKind: null,
      })
      return
    }

    const sourceUnitId = makeCustodyUnitId(event.fromCustodySourceId)
    const destinationUnitId = makeCustodyUnitId(event.toCustodySourceId)
    const sourceKey = inventoryKey({
      assetId: event.assetId,
      custodyUnitId: sourceUnitId,
      inventoryScope,
    })
    const destinationKey = inventoryKey({
      assetId: event.assetId,
      custodyUnitId: destinationUnitId,
      inventoryScope,
    })

    if (state.blockedInventoryKeys.has(sourceKey)) {
      appendBlocker({
        state,
        code: "blocked_inventory_suffix",
        eventId: event.id,
        assetId: event.assetId,
        custodyUnitId: sourceUnitId,
      })
      state.blockedInventoryKeys.add(destinationKey)
      return
    }

    const sourceLots = state.inventories.get(sourceKey) ?? []
    const movementMatch = allocateFifoQuantity({
      lots: sourceLots,
      quantity: event.quantity,
    })
    const allocations = yield* Effect.forEach(movementMatch.allocations, (allocation) =>
      Effect.gen(function* () {
        const userSplit =
          allocation.lot.userBasis === null
            ? null
            : yield* splitUserTotal({
                ...allocation.lot.userBasis,
                whole: allocation.lot.remainingQuantity,
                part: allocation.matchedQuantity,
              })
        return { ...allocation, userSplit }
      })
    )
    const remainingById = new Map(
      allocations.map((allocation) => [
        allocation.lot.id,
        {
          ...allocation.lot,
          remainingQuantity: allocation.remainingQuantity,
          userBasis:
            allocation.userSplit === null
              ? null
              : { total: allocation.userSplit.remaining, scale: allocation.userSplit.scale },
        },
      ])
    )
    state.inventories.set(
      sourceKey,
      sourceLots.map((lot) => remainingById.get(lot.id) ?? lot)
    )
    const destinationLots = allocations.map((allocation, index) => ({
      ...allocation.lot,
      id: `${allocation.lot.id}:${event.id}:${index}`,
      custodyUnitId: destinationUnitId,
      remainingQuantity: allocation.matchedQuantity,
      userBasis:
        allocation.userSplit === null
          ? null
          : { total: allocation.userSplit.allocated, scale: allocation.userSplit.scale },
    }))
    state.inventories.set(
      destinationKey,
      sortLots([...(state.inventories.get(destinationKey) ?? []), ...destinationLots])
    )
    const matches = movementMatch.allocations.map((allocation) => ({
      acquisitionEventId: allocation.lot.acquisitionEventId,
      quantity: allocation.matchedQuantity,
    }))

    if (movementMatch.shortage !== null) {
      appendBlocker({
        state,
        code: "movement_shortage",
        eventId: event.id,
        assetId: event.assetId,
        custodyUnitId: sourceUnitId,
        missingQuantity: movementMatch.shortage,
        matches,
      })
      state.blockedInventoryKeys.add(sourceKey)
      state.blockedInventoryKeys.add(destinationKey)
    }

    appendExplanation({
      state,
      eventId: event.id,
      code: "fifo_basis_carried",
      valuationKind: null,
      matches,
    })
  })

const processAcquisition = ({
  event,
  custodyUnitId,
  inventoryKey,
  valuationResolution,
  useValuation,
  requiresValuation,
  incomeTreatmentCode,
  state,
}: {
  readonly event: AcquisitionEvent
  readonly custodyUnitId: CustodyUnitId
  readonly inventoryKey: string
  readonly valuationResolution: ValuationResolution
  readonly useValuation: boolean
  readonly requiresValuation: boolean
  readonly incomeTreatmentCode: string | null
  readonly state: EngineState
}): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const valuation =
      useValuation && valuationResolution._tag === "selected" ? valuationResolution : null
    const costBasisPerUnit =
      valuation === null
        ? null
        : Option.getOrNull(yield* Effect.option(divide(valuation.total, event.quantity)))
    const lot: EngineLot = {
      id: event.id,
      acquisitionEventId: event.id,
      assetId: event.assetId,
      custodyUnitId,
      acquiredAt: event.occurredAt,
      remainingQuantity: event.quantity,
      costBasisPerUnit,
      userBasis:
        valuation?.kind === "user_valuation"
          ? { total: valuation.total, scale: Math.max(18, valuation.total.amount.scale) }
          : null,
    }

    state.inventories.set(
      inventoryKey,
      sortLots([...(state.inventories.get(inventoryKey) ?? []), lot])
    )

    if (requiresValuation && valuationResolution._tag !== "selected") {
      appendValuationBlocker({
        state,
        event,
        custodyUnitId,
        valuationResolution,
      })
    }

    appendExplanation({
      state,
      eventId: event.id,
      code: "fifo_lot_created",
      valuationKind: valuation?.kind ?? null,
    })

    if (incomeTreatmentCode !== null && valuation !== null) {
      state.incomeResults.push({
        eventId: event.id,
        custodySourceId: event.custodySourceId,
        assetId: event.assetId,
        occurredAt: event.occurredAt,
        quantity: event.quantity,
        value: valuation.total,
        treatmentCodes: [incomeTreatmentCode],
      })
    }
  })

const processDisposition = ({
  event,
  custodyUnitId,
  inventoryKey,
  valuationResolution,
  requiresValuation,
  producesRealizedResults,
  state,
}: {
  readonly event: DispositionEvent
  readonly custodyUnitId: CustodyUnitId
  readonly inventoryKey: string
  readonly valuationResolution: ValuationResolution
  readonly requiresValuation: boolean
  readonly producesRealizedResults: boolean
  readonly state: EngineState
}): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const valuation =
      requiresValuation && valuationResolution._tag === "selected" ? valuationResolution : null

    if (state.blockedInventoryKeys.has(inventoryKey)) {
      appendBlocker({
        state,
        code: "blocked_inventory_suffix",
        eventId: event.id,
        assetId: event.assetId,
        custodyUnitId,
        valuationKind: valuation?.kind ?? null,
      })
      return
    }

    const lots = state.inventories.get(inventoryKey) ?? []
    const match = allocateFifoQuantity({
      lots,
      quantity: event.quantity,
    })
    const remainingById = new Map(
      match.allocations.map((allocation) => [allocation.lot.id, allocation.remainingQuantity])
    )
    const matches = match.allocations.map((allocation) => ({
      acquisitionEventId: allocation.lot.acquisitionEventId,
      quantity: allocation.matchedQuantity,
    }))

    if (requiresValuation && valuationResolution._tag !== "selected") {
      appendValuationBlocker({
        state,
        event,
        custodyUnitId,
        valuationResolution,
      })
    }

    if (match.shortage !== null) {
      appendBlocker({
        state,
        code: "inventory_shortage",
        eventId: event.id,
        assetId: event.assetId,
        custodyUnitId,
        missingQuantity: match.shortage,
        valuationKind: valuation?.kind ?? null,
        matches,
      })
      state.blockedInventoryKeys.add(inventoryKey)
    }

    const remainingUserBasis = new Map<string, UserBasis>()
    let userProceeds = valuation?.kind === "user_valuation" ? valuation.total : null
    let proceedsQuantity = event.quantity
    const proceedsScale = userProceeds === null ? 18 : Math.max(18, userProceeds.amount.scale)

    let currencyMismatchBlocked = false

    for (const matchAllocation of match.allocations) {
      const lot = matchAllocation.lot
      const allocationSequence = state.allocations.length
      const userBasisSplit =
        lot.userBasis === null
          ? null
          : yield* splitUserTotal({
              ...lot.userBasis,
              part: matchAllocation.matchedQuantity,
              whole: lot.remainingQuantity,
            })
      if (userBasisSplit !== null && lot.userBasis !== null)
        remainingUserBasis.set(lot.id, { ...lot.userBasis, total: userBasisSplit.remaining })
      const costBasis =
        userBasisSplit !== null
          ? userBasisSplit.allocated
          : lot.costBasisPerUnit === null
            ? null
            : round(multiplyByQuantity(lot.costBasisPerUnit, matchAllocation.matchedQuantity), 8)

      state.allocations.push({
        acquisitionEventId: lot.acquisitionEventId,
        dispositionEventId: event.id,
        assetId: event.assetId,
        custodyUnitId,
        acquiredAt: lot.acquiredAt,
        disposedAt: event.occurredAt,
        quantity: matchAllocation.matchedQuantity,
        costBasis,
      })
      const userProceedsSplit =
        userProceeds === null
          ? null
          : yield* splitUserTotal({
              total: userProceeds,
              part: matchAllocation.matchedQuantity,
              whole: proceedsQuantity,
              scale: proceedsScale,
            })
      const proceeds =
        userProceedsSplit !== null
          ? userProceedsSplit.allocated
          : valuation === null
            ? null
            : Option.getOrNull(
                yield* Effect.option(
                  prorate({
                    total: valuation.total,
                    part: matchAllocation.matchedQuantity,
                    whole: event.quantity,
                    scale: 8,
                  })
                )
              )
      if (userProceedsSplit !== null) {
        userProceeds = userProceedsSplit.remaining
        proceedsQuantity = AccountingQuantity.make(
          BigDecimal.subtract(proceedsQuantity, matchAllocation.matchedQuantity)
        )
      }

      if (!producesRealizedResults || costBasis === null || proceeds === null) {
        continue
      }

      const gainLoss = yield* Effect.result(subtract(proceeds, costBasis))

      if (Result.isFailure(gainLoss)) {
        if (!currencyMismatchBlocked) {
          appendBlocker({
            state,
            code: "valuation_currency_mismatch",
            eventId: event.id,
            assetId: event.assetId,
            custodyUnitId,
            valuationKind: valuation?.kind ?? null,
            matches: [
              {
                acquisitionEventId: lot.acquisitionEventId,
                quantity: matchAllocation.matchedQuantity,
              },
            ],
          })
          currencyMismatchBlocked = true
        }
        continue
      }

      state.realizedResults.push({
        acquisitionEventId: lot.acquisitionEventId,
        dispositionEventId: event.id,
        custodySourceId: event.custodySourceId,
        allocationSequence,
        assetId: event.assetId,
        acquiredAt: lot.acquiredAt,
        disposedAt: event.occurredAt,
        quantity: matchAllocation.matchedQuantity,
        costBasis,
        proceeds,
        gainLoss: gainLoss.success,
        treatmentCodes: [],
      })
    }

    appendExplanation({
      state,
      eventId: event.id,
      code: "fifo_disposition_matched",
      valuationKind: valuation?.kind ?? null,
      matches,
    })
    state.inventories.set(
      inventoryKey,
      lots.map((lot) => ({
        ...lot,
        remainingQuantity: remainingById.get(lot.id) ?? lot.remainingQuantity,
        userBasis: remainingUserBasis.get(lot.id) ?? lot.userBasis,
      }))
    )
  })

/** Calculate a complete deterministic structural result without external services. */
export const calculate = ({
  ledger,
  jurisdiction,
  taxYear,
  accountingChoices,
  valuationFacts,
}: CalculateInput): Effect.Effect<TaxAccountingResult, TaxAccountingError, never> =>
  Effect.gen(function* () {
    if (!isGermanJurisdiction(jurisdiction)) {
      return yield* new UnsupportedJurisdictionError({ jurisdiction })
    }

    const methodChoice: AccountingMethodChoice | null = yield* resolveChoiceOrNull({
      choices: accountingChoices,
      jurisdiction,
      choiceKind: "accounting_method",
    })
    const scopeChoice: InventoryScopeChoice | null = yield* resolveChoiceOrNull({
      choices: accountingChoices,
      jurisdiction,
      choiceKind: "inventory_scope",
    })
    const { accountingMethod, inventoryScope } = yield* resolveGermanAccountingPolicy({
      methodChoice,
      scopeChoice,
    })

    const orderedLedger = ledger
      .filter((event) => germanTaxYearOf(event.occurredAt) <= taxYear)
      .sort(compareEvents)
    const targetDispositionIds = new Set(
      orderedLedger
        .filter(
          (event): event is DispositionEvent =>
            event._tag === "disposition" && germanTaxYearOf(event.occurredAt) === taxYear
        )
        .map((event) => event.id)
    )
    const dispositionById = new Map(
      orderedLedger
        .filter((event): event is DispositionEvent => event._tag === "disposition")
        .map((event) => [event.id, event])
    )
    const acquisitionById = new Map(
      orderedLedger
        .filter((event): event is AcquisitionEvent => event._tag === "acquisition")
        .map((event) => [event.id, event])
    )
    const state: EngineState = {
      inventories: new Map(),
      allocations: [],
      realizedResults: [],
      incomeResults: [],
      blockers: [],
      explanationTrace: [],
      blockedInventoryKeys: new Set(),
    }

    for (const event of orderedLedger) {
      if (event._tag === "custody_movement") {
        yield* processCustodyMovement({ event, inventoryScope, state })
        continue
      }

      const custodyUnitId = makeCustodyUnitId(event.custodySourceId)
      const key = inventoryKey({
        assetId: event.assetId,
        custodyUnitId,
        inventoryScope,
      })
      const valuationResolution = selectValuation({ event, valuationFacts })
      const valuation = valuationResolution._tag === "selected" ? valuationResolution : null

      if (event.cause === "unknown") {
        appendBlocker({
          state,
          code: "unknown_cause",
          eventId: event.id,
          assetId: event.assetId,
          custodyUnitId,
          valuationKind: valuation?.kind ?? null,
        })
      }

      if (event._tag === "acquisition") {
        const germanBlocker = germanAcquisitionBlocker(event.cause)

        if (germanBlocker !== null) {
          appendBlocker({
            state,
            code: germanBlocker,
            eventId: event.id,
            assetId: event.assetId,
            custodyUnitId,
            valuationKind: valuation?.kind ?? null,
          })
        }

        const useValuation = germanBlocker === null

        yield* processAcquisition({
          event,
          custodyUnitId,
          inventoryKey: key,
          valuationResolution,
          useValuation,
          requiresValuation: useValuation,
          incomeTreatmentCode: germanAcquisitionIncomeTreatment(event.cause),
          state,
        })
        continue
      }

      const germanBlocker = germanDispositionBlocker(event.cause)

      if (germanBlocker !== null) {
        appendBlocker({
          state,
          code: germanBlocker,
          eventId: event.id,
          assetId: event.assetId,
          custodyUnitId,
          valuationKind: valuation?.kind ?? null,
        })
      }

      const producesRealizedResults = germanBlocker === null

      yield* processDisposition({
        event,
        custodyUnitId,
        inventoryKey: key,
        valuationResolution,
        requiresValuation: producesRealizedResults,
        producesRealizedResults,
        state,
      })
    }

    const allocationEntries = state.allocations
      .map((allocation, originalSequence) => ({ allocation, originalSequence }))
      .filter(({ allocation }) => targetDispositionIds.has(allocation.dispositionEventId))
    const allocationSequenceByOriginal = new Map(
      allocationEntries.map(({ originalSequence }, sequence) => [originalSequence, sequence])
    )

    return {
      status: state.blockers.length === 0 ? "complete" : "partial",
      jurisdiction,
      taxYear,
      engineVersion: ACCOUNTING_ENGINE_VERSION,
      ruleSetVersion: GERMAN_RULE_SET_VERSION,
      accountingMethod,
      inventoryScope,
      appliedChoiceIds: [methodChoice?.id, scopeChoice?.id].filter(
        (choiceId): choiceId is AccountingChoiceId => choiceId !== undefined
      ),
      appliedRules: [
        "engine.event_order.occurred_at_then_id",
        "engine.inventory.fifo",
        `engine.inventory.${inventoryScope}`,
        ...GERMAN_APPLIED_RULES,
      ],
      processedEventIds: orderedLedger.map((event) => event.id),
      allocations: allocationEntries.map(({ allocation }) => allocation),
      realizedResults: state.realizedResults
        .filter((result) => targetDispositionIds.has(result.dispositionEventId))
        .flatMap((result) => {
          const allocationSequence = allocationSequenceByOriginal.get(result.allocationSequence)

          if (allocationSequence === undefined) return []

          const disposition = dispositionById.get(result.dispositionEventId)
          const acquisition = acquisitionById.get(result.acquisitionEventId)
          const treatment =
            disposition === undefined || acquisition === undefined
              ? null
              : germanPrivateDisposalTreatment({
                  acquisition: result.acquiredAt,
                  acquisitionCause: acquisition.cause,
                  disposition: result.disposedAt,
                  cause: disposition.cause,
                })

          return [
            {
              ...result,
              allocationSequence,
              treatmentCodes: treatment === null ? result.treatmentCodes : [treatment],
            },
          ]
        }),
      incomeResults: state.incomeResults.filter(
        (result) => germanTaxYearOf(result.occurredAt) === taxYear
      ),
      derivedLots: toDerivedLots(state.inventories),
      blockers: state.blockers,
      explanationTrace: state.explanationTrace,
    }
  })
