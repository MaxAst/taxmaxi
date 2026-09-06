/**
 * FactualLedgerRepositoryLive - Drizzle-backed factual-ledger adapter.
 *
 * @module FactualLedgerRepositoryLive
 */

import {
  AcquisitionEvent,
  AccountingEventId,
  CustodyUnitId,
  CustodyMovementEvent,
  DispositionEvent,
  MarketQuoteFact,
  ObservedConsiderationFact,
  type AcquisitionCause,
  type AccountingEvent,
  type DispositionCause,
  type ValuationFact,
} from "@my/core/accounting"
import { decidePrincipalAssetOverride, type PrincipalAssetEffectiveDecision } from "@my/core/assets"
import { CURRENCIES_BY_CODE, type CurrencyCode } from "@my/core/currency"
import { SourceId } from "@my/core/source"
import { aliasedTable, and, asc, eq, inArray, or } from "drizzle-orm"
import * as BigDecimal from "effect/BigDecimal"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { PersistenceError, wrapSqlError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import {
  FactualLedgerRepository,
  type FactualLedgerInputBlocker,
  type FactualLedgerInputBlockerTarget,
  type FactualLedgerRepositoryShape,
  type MovementCorrectionLegContext,
  type MovementCorrectionCustodyContext,
} from "../services/FactualLedgerRepository.ts"
import { makePrincipalTransactionOverrideDecisionLoader } from "./PrincipalTransactionOverrideDecisionLoader.ts"
import { drizzle } from "./PgClientLive.ts"
import {
  makePrincipalAssetOverrideDecisionLoader,
  type PrincipalAssetOverrideDecisions,
  type PrincipalProviderAssetDecision,
  type PrincipalSourceRepresentationUseDecision,
} from "./PrincipalAssetOverrideDecisionLoader.ts"

const ASSET_REVIEW_LAYERS = new Set([
  "principal_asset_override",
  "provider_asset_mapping",
  "solana_asset_mapping",
])

const EXCHANGE_TYPES = new Set([
  "buy_fiat",
  "sell_fiat",
  "swap_crypto_to_crypto",
  "trade_other",
  "nft_buy",
  "nft_sell",
])

const acquisitionCause = ({
  providerKey,
  providerTransactionType,
  transactionType,
}: {
  readonly providerKey: string | null
  readonly providerTransactionType: string | null
  readonly transactionType: string | null
}): AcquisitionCause => {
  if (
    providerKey === "coinbase" &&
    ((transactionType === "staking_reward" &&
      (providerTransactionType === "staking_reward" ||
        providerTransactionType === "earn_payout")) ||
      (transactionType === "interest_received" && providerTransactionType === "interest"))
  ) {
    return "passive_staking_reward"
  }
  if (transactionType === "gift_received") return "gift"
  if (transactionType === "airdrop") return "airdrop"
  if (transactionType === "mining_reward") return "mining_reward"
  if (transactionType === "staking_reward") return "staking_reward"
  if (transactionType === "payment_received") return "payment"
  if (EXCHANGE_TYPES.has(transactionType ?? "")) return "purchase"

  if (
    transactionType === "bounty" ||
    transactionType === "cashback" ||
    transactionType === "governance_reward" ||
    transactionType === "interest_received" ||
    transactionType === "masternode_reward" ||
    transactionType === "yield_farming_reward"
  ) {
    return "reward"
  }

  return "unknown"
}

const dispositionCause = ({
  kind,
  transactionType,
}: {
  readonly kind: "disposal" | "fee"
  readonly transactionType: string | null
}): DispositionCause => {
  if (kind === "fee") return "fee"
  if (transactionType === "gift_sent" || transactionType === "donation_sent") return "gift"
  if (transactionType === "payment_sent") return "payment"
  return EXCHANGE_TYPES.has(transactionType ?? "") ? "sale" : "unknown"
}

const decodeRequired = <S extends Schema.Constraint>({
  schema,
  input,
  operation,
}: {
  readonly schema: S
  readonly input: unknown
  readonly operation: string
}) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((cause) => new PersistenceError({ operation, cause }))
  )

const decodeValuationDecimal = (value: string): BigDecimal.BigDecimal | undefined =>
  Option.getOrUndefined(BigDecimal.fromString(value))

const isPositiveQuantity = (value: string): boolean => {
  const quantity = decodeValuationDecimal(value)
  return quantity !== undefined && BigDecimal.isPositive(quantity)
}

const isBeforeCutoff = (occurredAt: Date, occurredBefore: Date | undefined): boolean =>
  occurredBefore === undefined || occurredAt.getTime() < occurredBefore.getTime()

const validateReportingCurrency = (reportingCurrency: CurrencyCode) =>
  CURRENCIES_BY_CODE.has(reportingCurrency)
    ? Effect.succeed(reportingCurrency)
    : Effect.fail(
        new PersistenceError({
          operation: "factualLedgerRepository.load.reportingCurrency",
          cause: `Unsupported reporting currency: ${reportingCurrency}`,
        })
      )

const trimmedNonEmpty = (value: string | null | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === "" ? undefined : trimmed
}

const transactionReference = ({
  externalGroupId,
  externalId,
  transactionId,
}: {
  readonly externalGroupId: string | null
  readonly externalId: string | null
  readonly transactionId: string | null
}) => {
  for (const candidate of [externalGroupId, externalId, transactionId]) {
    const reference = trimmedNonEmpty(candidate)
    if (reference !== undefined) return reference
  }

  return undefined
}

const compareEvents = (left: AccountingEvent, right: AccountingEvent): number => {
  const timestampOrder = left.occurredAt.epochMillis - right.occurredAt.epochMillis
  return timestampOrder === 0 ? left.id.localeCompare(right.id) : timestampOrder
}

const utcDay = (date: Date): string => date.toISOString().slice(0, 10)

const utcDayStart = (day: string): Date =>
  DateTime.toDateUtc(DateTime.makeUnsafe(`${day}T00:00:00.000Z`))

const VALUATION_FACT_ORDER = {
  user_valuation: 0,
  observed_consideration: 1,
  market_quote: 2,
} satisfies Record<ValuationFact["_tag"], number>

const compareValuationFacts = (left: ValuationFact, right: ValuationFact): number => {
  const eventOrder = left.eventId.localeCompare(right.eventId)
  if (eventOrder !== 0) return eventOrder
  if (left._tag === "user_valuation" && right._tag === "user_valuation") {
    return (
      left.evidenceReference.localeCompare(right.evidenceReference) ||
      left.amount.currency.localeCompare(right.amount.currency) ||
      left.amount.format().localeCompare(right.amount.format())
    )
  }
  if (left._tag === right._tag) return 0
  return VALUATION_FACT_ORDER[left._tag] - VALUATION_FACT_ORDER[right._tag]
}

type FactDecisionOutcome =
  | {
      readonly _tag: "included"
      readonly assetId: string
      readonly systemAssetId: string
    }
  | { readonly _tag: "excluded" }
  | { readonly _tag: "ignored" }
  | {
      readonly _tag: "blocked"
      readonly assetId: string | null
      readonly codes: ReadonlyArray<FactualLedgerInputBlocker["code"]>
    }
  | { readonly _tag: "malformed"; readonly assetId: string | null }

const blockedDecisionCodes = (
  decision: Extract<PrincipalAssetEffectiveDecision, { readonly _tag: "blocked" }>
): ReadonlyArray<FactualLedgerInputBlocker["code"]> => [
  ...(decision.identity._tag === "unresolved" ? (["unresolved_identity"] as const) : []),
  ...decision.technicalBlockers,
]

const includedOutcome = ({
  decision,
  systemAssetId,
}: {
  readonly decision: PrincipalAssetEffectiveDecision
  readonly systemAssetId: string | null
}): FactDecisionOutcome => {
  if (decision._tag === "excluded") return { _tag: "excluded" }
  if (decision._tag === "blocked") {
    return {
      _tag: "blocked",
      assetId: decision.identity._tag === "resolved" ? decision.identity.assetId : systemAssetId,
      codes: blockedDecisionCodes(decision),
    }
  }
  return {
    _tag: "included",
    assetId: decision.assetId,
    systemAssetId: systemAssetId ?? decision.assetId,
  }
}

const exactFactDecision = ({
  exactDecision,
  providerDecision,
  storedAssetId,
}: {
  readonly exactDecision: PrincipalSourceRepresentationUseDecision
  readonly providerDecision: PrincipalProviderAssetDecision | undefined
  readonly storedAssetId: string | null
}): FactDecisionOutcome => {
  if (providerDecision?.systemInclusion === "excluded") return { _tag: "excluded" }

  const systemAssetId = exactDecision.systemAssetId
  const decision = decidePrincipalAssetOverride({
    systemIdentity:
      systemAssetId === null
        ? { _tag: "unresolved" }
        : { _tag: "resolved", assetId: systemAssetId },
    systemInclusion: exactDecision.systemInclusion,
    identityReplacement:
      exactDecision.identityReplacementAssetId === null
        ? null
        : { _tag: "resolved", assetId: exactDecision.identityReplacementAssetId },
    inclusionReplacement: exactDecision.inclusionReplacement,
    technicalBlockers:
      exactDecision.systemAssetId === null ? (providerDecision?.technicalBlockers ?? []) : [],
  })

  const outcome = includedOutcome({ decision, systemAssetId })
  return outcome._tag === "blocked" && outcome.assetId === null && storedAssetId !== null
    ? { ...outcome, assetId: storedAssetId }
    : outcome
}

const selectFactDecision = ({
  decisions,
  providerAssetRowId,
  requiresTarget,
  sourceRepresentationUseId,
  storedAssetId,
}: {
  readonly decisions: PrincipalAssetOverrideDecisions
  readonly providerAssetRowId: string | null
  readonly requiresTarget: boolean
  readonly sourceRepresentationUseId: string | null
  readonly storedAssetId: string | null
}): FactDecisionOutcome => {
  const providerDecision =
    providerAssetRowId === null
      ? undefined
      : decisions.providerAssetDecisionById.get(providerAssetRowId)

  if (sourceRepresentationUseId !== null) {
    const exactDecision =
      decisions.sourceRepresentationUseDecisionById.get(sourceRepresentationUseId)
    return exactDecision === undefined
      ? { _tag: "malformed", assetId: storedAssetId ?? providerDecision?.systemAssetId ?? null }
      : exactFactDecision({ exactDecision, providerDecision, storedAssetId })
  }

  if (providerAssetRowId !== null && decisions.ignoredProviderAssetRowIds.has(providerAssetRowId)) {
    return { _tag: "ignored" }
  }

  if (providerAssetRowId !== null) {
    return providerDecision === undefined
      ? { _tag: "malformed", assetId: storedAssetId }
      : includedOutcome({
          decision: providerDecision.effectiveDecision,
          systemAssetId: providerDecision.systemAssetId ?? storedAssetId,
        })
  }

  return requiresTarget || storedAssetId === null
    ? { _tag: "malformed", assetId: storedAssetId }
    : { _tag: "included", assetId: storedAssetId, systemAssetId: storedAssetId }
}

const blockerKey = (blocker: FactualLedgerInputBlocker): string =>
  [
    blocker.code,
    blocker.eventId,
    blocker.occurredAt.toISOString(),
    blocker.assetId,
    "providerAssetRowId" in blocker ? blocker.providerAssetRowId : null,
    blocker.custodyUnitId,
  ].join("\0")

const addOutcomeBlockers = ({
  blockers,
  custodyUnitId,
  eventId,
  occurredAt,
  outcome,
  providerAssetRowId,
}: {
  readonly blockers: Map<string, FactualLedgerInputBlocker>
  readonly custodyUnitId: CustodyUnitId
  readonly eventId: string
  readonly occurredAt: Date
  readonly outcome: Extract<FactDecisionOutcome, { readonly _tag: "blocked" | "malformed" }>
  readonly providerAssetRowId: string | null
}): boolean => {
  const codes = outcome._tag === "malformed" ? (["malformed_movement"] as const) : outcome.codes

  for (const code of codes) {
    let target: FactualLedgerInputBlockerTarget
    if (outcome.assetId === null) {
      if (providerAssetRowId === null) return false
      target = { assetId: null, providerAssetRowId }
    } else {
      target =
        providerAssetRowId === null
          ? { assetId: outcome.assetId }
          : { assetId: outcome.assetId, providerAssetRowId }
    }
    const blocker: FactualLedgerInputBlocker = {
      code,
      eventId: AccountingEventId.make(eventId),
      occurredAt,
      custodyUnitId,
      missingQuantity: null,
      ...target,
    }
    blockers.set(blockerKey(blocker), blocker)
  }
  return true
}

const recordOutcomeBlockers = ({
  blockers,
  custodyUnitIdBySource,
  eventId,
  occurredAt,
  outcome,
  providerAssetRowId,
  sourceId,
}: {
  readonly blockers: Map<string, FactualLedgerInputBlocker>
  readonly custodyUnitIdBySource: ReadonlyMap<string, CustodyUnitId>
  readonly eventId: string
  readonly occurredAt: Date
  readonly outcome: Extract<FactDecisionOutcome, { readonly _tag: "blocked" | "malformed" }>
  readonly providerAssetRowId: string | null
  readonly sourceId: string
}): PersistenceError | undefined => {
  const custodyUnitId = custodyUnitIdBySource.get(sourceId)
  if (custodyUnitId === undefined) {
    return new PersistenceError({
      operation: "factualLedgerRepository.load.blockerCustodyUnit",
      cause: `Source is not assigned to a custody unit: ${sourceId}`,
    })
  }
  if (
    !addOutcomeBlockers({
      blockers,
      custodyUnitId,
      eventId,
      occurredAt,
      outcome,
      providerAssetRowId,
    })
  ) {
    return new PersistenceError({
      operation: "factualLedgerRepository.load.unaddressableBlocker",
      cause: `Blocked fact has neither an asset nor provider-asset link: ${eventId}`,
    })
  }
}

const reviewIncludesAssetLayer = (matchedLayer: string | null): boolean =>
  (matchedLayer ?? "")
    .split(",")
    .map((layer) => layer.trim())
    .some((layer) => ASSET_REVIEW_LAYERS.has(layer))

const closeWithheldTransactionPairs = ({
  pairs,
  withheldTransactionIds,
}: {
  readonly pairs: ReadonlyArray<{
    readonly canonicalTransactionId: string | null
    readonly providerTransactionId: string
  }>
  readonly withheldTransactionIds: Set<string>
}): void => {
  let changed = true
  while (changed) {
    changed = false
    for (const pair of pairs) {
      if (pair.canonicalTransactionId === null) continue
      if (
        !withheldTransactionIds.has(pair.providerTransactionId) &&
        !withheldTransactionIds.has(pair.canonicalTransactionId)
      ) {
        continue
      }
      const previousSize = withheldTransactionIds.size
      withheldTransactionIds.add(pair.providerTransactionId)
      withheldTransactionIds.add(pair.canonicalTransactionId)
      changed = changed || withheldTransactionIds.size !== previousSize
    }
  }
}

const make = Effect.gen(function* () {
  const db = yield* drizzle
  const principalAssetOverrideDecisionLoader = yield* makePrincipalAssetOverrideDecisionLoader
  const movementCorrectionLoader = yield* makePrincipalTransactionOverrideDecisionLoader
  const feeTransactionTable = aliasedTable(schema.transactions, "fee_transaction")
  const providerTransactionTable = aliasedTable(schema.transactions, "provider_transaction")
  const canonicalTransactionTable = aliasedTable(schema.transactions, "canonical_transaction")
  const providerSourceTable = aliasedTable(schema.sources, "provider_source")
  const canonicalSourceTable = aliasedTable(schema.sources, "canonical_source")
  type LoadParams = Parameters<FactualLedgerRepositoryShape["load"]>[0]

  const loadLegEvents = ({
    custodyUnitIdBySource,
    decisions,
    inputBlockerByKey,
    principalId,
    reconciliationPairs,
    reconciledCanonicalTransferIds,
    reconciledProviderTransferIds,
    occurredBefore,
    withheldTransactionIds,
  }: Pick<LoadParams, "principalId"> & {
    readonly custodyUnitIdBySource: ReadonlyMap<string, CustodyUnitId>
    readonly decisions: PrincipalAssetOverrideDecisions
    readonly inputBlockerByKey: Map<string, FactualLedgerInputBlocker>
    readonly occurredBefore: Date | undefined
    readonly reconciliationPairs: ReadonlyArray<{
      readonly canonicalTransactionId: string | null
      readonly providerTransactionId: string
    }>
    readonly reconciledCanonicalTransferIds: ReadonlySet<string>
    readonly reconciledProviderTransferIds: ReadonlySet<string>
    readonly withheldTransactionIds: Set<string>
  }) =>
    Effect.gen(function* () {
      const rows = yield* db
        .select({
          id: schema.transactionLegs.id,
          targetId: schema.transactionLegs.movementCorrectionTargetId,
          fiatAmount: schema.transactionLegs.fiatAmount,
          fiatCurrency: schema.transactionLegs.fiatCurrency,
          sourceId: schema.transactionLegs.sourceId,
          providerKey: schema.sources.providerKey,
          timestamp: schema.transactionLegs.timestamp,
          assetId: schema.transactionLegs.assetId,
          assetRepresentationId: schema.transactionLegs.assetRepresentationId,
          providerAssetRowId: schema.transactionLegs.providerAssetRowId,
          sourceRepresentationUseId: schema.transactionLegs.sourceRepresentationUseId,
          sourceRawRecordId: schema.transactionLegs.sourceRawRecordId,
          amount: schema.transactionLegs.amount,
          kind: schema.transactionLegs.kind,
          derivationRule: schema.transactionLegs.derivationRule,
          originKind: schema.transactionLegs.originKind,
          providerTransferId: schema.transactionLegs.providerTransferId,
          sourceTransferId: schema.transactionLegs.sourceTransferId,
          transactionId: schema.transactions.id,
          externalId: schema.transactions.externalId,
          externalGroupId: schema.transactions.externalGroupId,
          transactionType: schema.transactions.transactionType,
          providerTransactionType: schema.transactions.providerTransactionType,
          providerResourcePath: schema.transactions.providerResourcePath,
          transactionSourceRawRecordId: schema.transactions.sourceRawRecordId,
          providerFiatAmount: schema.transactions.providerFiatAmount,
          providerFiatCurrency: schema.transactions.providerFiatCurrency,
          feeTransactionId: feeTransactionTable.id,
          feeExternalId: feeTransactionTable.externalId,
          feeExternalGroupId: feeTransactionTable.externalGroupId,
        })
        .from(schema.transactionLegs)
        .innerJoin(
          schema.sources,
          and(
            eq(schema.transactionLegs.sourceId, schema.sources.id),
            eq(schema.sources.principalId, principalId)
          )
        )
        .leftJoin(
          schema.transactions,
          and(
            eq(schema.transactionLegs.transactionId, schema.transactions.id),
            eq(schema.transactions.principalId, principalId),
            eq(schema.transactions.sourceId, schema.transactionLegs.sourceId)
          )
        )
        .leftJoin(
          feeTransactionTable,
          and(
            eq(schema.transactionLegs.feeForTransactionId, feeTransactionTable.id),
            eq(feeTransactionTable.principalId, principalId),
            eq(feeTransactionTable.sourceId, schema.transactionLegs.sourceId)
          )
        )
        .where(eq(schema.transactionLegs.principalId, principalId))
        .orderBy(asc(schema.transactionLegs.timestamp), asc(schema.transactionLegs.id))
        .pipe(wrapSqlError("factualLedgerRepository.load.legs"))

      const includedRows = rows.filter(({ timestamp }) => isBeforeCutoff(timestamp, occurredBefore))
      const events: AccountingEvent[] = []
      const eventRows: Array<{
        readonly event: AccountingEvent
        readonly row: (typeof rows)[number]
      }> = []
      const eventCountByTransactionId = new Map<string, number>()
      const withheldLegIds = new Set<string>()
      const feeTransactionPairs: Array<{
        readonly canonicalTransactionId: string | null
        readonly providerTransactionId: string
      }> = []
      const effectiveAssetByTransactionSystemAsset = new Map<string, string>()
      const effectiveAssetByLegId = new Map<string, string>()
      const isReconciledEconomicLeg = (row: (typeof rows)[number]) =>
        row.kind !== "fee" &&
        ((row.originKind === "canonical_transfer" &&
          row.sourceTransferId !== null &&
          reconciledCanonicalTransferIds.has(row.sourceTransferId)) ||
          (row.originKind === "provider_transfer" &&
            row.providerTransferId !== null &&
            reconciledProviderTransferIds.has(row.providerTransferId)))

      for (const row of includedRows) {
        if (row.transactionId !== null && row.feeTransactionId !== null) {
          feeTransactionPairs.push({
            canonicalTransactionId: row.transactionId,
            providerTransactionId: row.feeTransactionId,
          })
        }
        if (isReconciledEconomicLeg(row)) continue
        const outcome = selectFactDecision({
          decisions,
          providerAssetRowId: row.providerAssetRowId,
          requiresTarget:
            row.sourceRawRecordId !== null ||
            row.assetRepresentationId !== null ||
            row.originKind !== "none" ||
            row.providerAssetRowId !== null,
          sourceRepresentationUseId: row.sourceRepresentationUseId,
          storedAssetId: row.assetId,
        })
        if (outcome._tag === "excluded") {
          if (row.transactionId === null) withheldLegIds.add(row.id)
          else withheldTransactionIds.add(row.transactionId)
          if (row.feeTransactionId !== null) withheldTransactionIds.add(row.feeTransactionId)
          continue
        }
        if (outcome._tag === "ignored") {
          const blockerError = recordOutcomeBlockers({
            blockers: inputBlockerByKey,
            custodyUnitIdBySource,
            eventId: row.id,
            occurredAt: row.timestamp,
            outcome: { _tag: "malformed", assetId: row.assetId },
            providerAssetRowId: row.providerAssetRowId,
            sourceId: row.sourceId,
          })
          if (blockerError !== undefined) return yield* blockerError
          if (row.transactionId === null) withheldLegIds.add(row.id)
          else withheldTransactionIds.add(row.transactionId)
          if (row.feeTransactionId !== null) withheldTransactionIds.add(row.feeTransactionId)
          continue
        }
        if (outcome._tag === "blocked" || outcome._tag === "malformed") {
          const blockerError = recordOutcomeBlockers({
            blockers: inputBlockerByKey,
            custodyUnitIdBySource,
            eventId: row.id,
            occurredAt: row.timestamp,
            outcome,
            providerAssetRowId: row.providerAssetRowId,
            sourceId: row.sourceId,
          })
          if (blockerError !== undefined) return yield* blockerError
          if (!isPositiveQuantity(row.amount) && outcome._tag === "blocked") {
            const quantityError = recordOutcomeBlockers({
              blockers: inputBlockerByKey,
              custodyUnitIdBySource,
              eventId: row.id,
              occurredAt: row.timestamp,
              outcome: { _tag: "malformed", assetId: outcome.assetId },
              providerAssetRowId: row.providerAssetRowId,
              sourceId: row.sourceId,
            })
            if (quantityError !== undefined) return yield* quantityError
          }
          if (row.transactionId === null) withheldLegIds.add(row.id)
          else withheldTransactionIds.add(row.transactionId)
          if (row.feeTransactionId !== null) withheldTransactionIds.add(row.feeTransactionId)
          continue
        }
        if (!isPositiveQuantity(row.amount)) {
          const blockerError = recordOutcomeBlockers({
            blockers: inputBlockerByKey,
            custodyUnitIdBySource,
            eventId: row.id,
            occurredAt: row.timestamp,
            outcome: { _tag: "malformed", assetId: outcome.assetId },
            providerAssetRowId: row.providerAssetRowId,
            sourceId: row.sourceId,
          })
          if (blockerError !== undefined) return yield* blockerError
          if (row.transactionId === null) withheldLegIds.add(row.id)
          else withheldTransactionIds.add(row.transactionId)
          if (row.feeTransactionId !== null) withheldTransactionIds.add(row.feeTransactionId)
          continue
        }

        effectiveAssetByLegId.set(row.id, outcome.assetId)
        if (row.transactionId === null) continue
        const identityKey = `${row.transactionId}\0${outcome.systemAssetId}`
        const earlierAssetId = effectiveAssetByTransactionSystemAsset.get(identityKey)
        if (earlierAssetId !== undefined && earlierAssetId !== outcome.assetId) {
          const blockerError = recordOutcomeBlockers({
            blockers: inputBlockerByKey,
            custodyUnitIdBySource,
            eventId: row.id,
            occurredAt: row.timestamp,
            outcome: { _tag: "malformed", assetId: outcome.assetId },
            providerAssetRowId: row.providerAssetRowId,
            sourceId: row.sourceId,
          })
          if (blockerError !== undefined) return yield* blockerError
          withheldTransactionIds.add(row.transactionId)
          if (row.feeTransactionId !== null) withheldTransactionIds.add(row.feeTransactionId)
        } else {
          effectiveAssetByTransactionSystemAsset.set(identityKey, outcome.assetId)
        }
      }

      closeWithheldTransactionPairs({
        pairs: [...reconciliationPairs, ...feeTransactionPairs],
        withheldTransactionIds,
      })

      for (const row of includedRows) {
        if (
          withheldLegIds.has(row.id) ||
          (row.transactionId !== null && withheldTransactionIds.has(row.transactionId)) ||
          (row.feeTransactionId !== null && withheldTransactionIds.has(row.feeTransactionId))
        ) {
          continue
        }
        if (
          row.transactionId !== null &&
          row.kind !== "fee" &&
          !isReconciledEconomicLeg(row) &&
          row.derivationRule !== "internal_transfer_in" &&
          row.derivationRule !== "internal_transfer_out"
        ) {
          eventCountByTransactionId.set(
            row.transactionId,
            (eventCountByTransactionId.get(row.transactionId) ?? 0) + 1
          )
        }
      }

      for (const row of includedRows) {
        if (
          withheldLegIds.has(row.id) ||
          (row.transactionId !== null && withheldTransactionIds.has(row.transactionId)) ||
          (row.feeTransactionId !== null && withheldTransactionIds.has(row.feeTransactionId)) ||
          isReconciledEconomicLeg(row) ||
          row.derivationRule === "internal_transfer_in" ||
          row.derivationRule === "internal_transfer_out"
        ) {
          continue
        }

        const reference =
          row.kind === "fee" && row.feeTransactionId !== null
            ? transactionReference({
                externalGroupId: row.feeExternalGroupId,
                externalId: row.feeExternalId,
                transactionId: row.feeTransactionId,
              })
            : transactionReference(row)
        const effectiveAssetId = effectiveAssetByLegId.get(row.id)
        if (effectiveAssetId === undefined) {
          return yield* new PersistenceError({
            operation: "factualLedgerRepository.load.legDecision",
            cause: `Included leg has no effective asset decision: ${row.id}`,
          })
        }
        const common = {
          id: row.id,
          occurredAt: { epochMillis: row.timestamp.getTime() },
          assetId: effectiveAssetId,
          quantity: row.amount,
          ...(reference === undefined ? {} : { transactionReference: reference }),
        }

        if (row.kind === "acquisition" || row.kind === "income") {
          const event = yield* decodeRequired({
            schema: AcquisitionEvent,
            input: {
              _tag: "acquisition",
              ...common,
              custodySourceId: row.sourceId,
              cause: acquisitionCause({
                providerKey: row.providerKey,
                providerTransactionType: row.providerTransactionType,
                transactionType: row.transactionType,
              }),
            },
            operation: "factualLedgerRepository.load.event",
          })
          events.push(event)
          eventRows.push({ event, row })
          continue
        }

        const event = yield* decodeRequired({
          schema: DispositionEvent,
          input: {
            _tag: "disposition",
            ...common,
            custodySourceId: row.sourceId,
            cause: dispositionCause({ kind: row.kind, transactionType: row.transactionType }),
          },
          operation: "factualLedgerRepository.load.event",
        })
        events.push(event)
        eventRows.push({ event, row })
      }

      const legContexts: MovementCorrectionLegContext[] = rows.map((row) => ({
        custody: [],
        targetId: row.targetId,
        legId: row.id,
        sourceId: row.sourceId,
        transactionId: row.transactionId,
        occurredAt: row.timestamp.toISOString(),
        quantity: row.amount,
        storedAssetId: row.assetId,
        effectiveAssetId: effectiveAssetByLegId.get(row.id) ?? null,
        direction: row.kind === "acquisition" || row.kind === "income" ? "inbound" : "outbound",
        structure:
          row.kind === "fee"
            ? "fee"
            : isReconciledEconomicLeg(row)
              ? "custody"
              : "ownership_change",
        legKind: row.kind,
        transactionType: row.transactionType,
        providerTransactionType: row.providerTransactionType,
        recordedFiatAmount: row.fiatAmount,
        recordedFiatCurrency: row.fiatCurrency,
        providerFiatAmount: row.providerFiatAmount,
        providerFiatCurrency: row.providerFiatCurrency,
        derivationRule: row.derivationRule,
        feeForSourceRecordKey: row.feeExternalId,
        originKind: row.originKind,
        sourceTransferId: row.sourceTransferId,
        providerTransferId: row.providerTransferId,
      }))
      return { events, eventRows, eventCountByTransactionId, legContexts }
    })

  type LoadedLegEvents = Effect.Success<ReturnType<typeof loadLegEvents>>

  const loadProviderInputDecisions = ({
    custodyUnitIdBySource,
    decisions,
    handledProviderTransferIds,
    inputBlockerByKey,
    occurredBefore,
    principalId,
    withheldTransactionIds,
  }: Pick<LoadParams, "principalId"> & {
    readonly custodyUnitIdBySource: ReadonlyMap<string, CustodyUnitId>
    readonly decisions: PrincipalAssetOverrideDecisions
    readonly handledProviderTransferIds: ReadonlySet<string>
    readonly inputBlockerByKey: Map<string, FactualLedgerInputBlocker>
    readonly occurredBefore: Date | undefined
    readonly withheldTransactionIds: Set<string>
  }) =>
    Effect.gen(function* () {
      const rows = yield* db
        .select({
          id: schema.providerTransfers.id,
          sourceId: schema.providerTransfers.sourceId,
          timestamp: schema.providerTransfers.timestamp,
          transactionId: schema.providerTransfers.transactionId,
          providerAssetRowId: schema.providerTransfers.providerAssetId,
          sourceRepresentationUseId: schema.providerTransfers.sourceRepresentationUseId,
          processingMode: schema.providerTransfers.processingMode,
          inventoryAssetId: schema.inventoryMovements.assetId,
          needsReview: schema.transactionReviews.needsReview,
          matchedLayer: schema.transactionReviews.matchedLayer,
          reconciliationStatus: schema.transferReconciliations.status,
          reconciliationDeterministic: schema.transferReconciliations.deterministic,
        })
        .from(schema.providerTransfers)
        .innerJoin(
          schema.sources,
          and(
            eq(schema.providerTransfers.sourceId, schema.sources.id),
            eq(schema.sources.principalId, principalId)
          )
        )
        .leftJoin(
          schema.inventoryMovements,
          and(
            eq(schema.inventoryMovements.providerTransferId, schema.providerTransfers.id),
            eq(schema.inventoryMovements.principalId, principalId)
          )
        )
        .leftJoin(
          schema.transactionReviews,
          and(
            eq(schema.transactionReviews.transactionId, schema.providerTransfers.transactionId),
            eq(schema.transactionReviews.principalId, principalId)
          )
        )
        .leftJoin(
          schema.transferReconciliations,
          and(
            eq(schema.transferReconciliations.providerTransferId, schema.providerTransfers.id),
            eq(schema.transferReconciliations.principalId, principalId)
          )
        )
        .where(
          inArray(schema.providerTransfers.processingMode, [
            "accounting_and_evidence",
            "accounting_only",
          ])
        )
        .orderBy(asc(schema.providerTransfers.id))
        .pipe(wrapSqlError("factualLedgerRepository.load.providerInputs"))

      for (const row of rows) {
        if (!isBeforeCutoff(row.timestamp, occurredBefore)) continue
        if (handledProviderTransferIds.has(row.id)) continue

        const isFinalizedReconciliation =
          row.reconciliationStatus === "approved" ||
          (row.reconciliationStatus === "auto_applied" && row.reconciliationDeterministic)

        const outcome = selectFactDecision({
          decisions,
          providerAssetRowId: row.providerAssetRowId,
          requiresTarget: true,
          sourceRepresentationUseId: row.sourceRepresentationUseId,
          storedAssetId: row.inventoryAssetId,
        })
        if (outcome._tag === "excluded") {
          withheldTransactionIds.add(row.transactionId)
          continue
        }
        if (outcome._tag === "ignored" && !isFinalizedReconciliation) continue

        const assetReviewIsOpen =
          row.needsReview === true && reviewIncludesAssetLayer(row.matchedLayer)
        const blockedOutcome =
          outcome._tag === "blocked" || outcome._tag === "malformed"
            ? outcome
            : outcome._tag === "ignored"
              ? ({ _tag: "malformed", assetId: null } as const)
              : assetReviewIsOpen || isFinalizedReconciliation
                ? ({ _tag: "malformed", assetId: outcome.assetId } as const)
                : undefined
        if (blockedOutcome === undefined) continue

        const blockerError = recordOutcomeBlockers({
          blockers: inputBlockerByKey,
          custodyUnitIdBySource,
          eventId: row.id,
          occurredAt: row.timestamp,
          outcome: blockedOutcome,
          providerAssetRowId: row.providerAssetRowId,
          sourceId: row.sourceId,
        })
        if (blockerError !== undefined) return yield* blockerError
        withheldTransactionIds.add(row.transactionId)
      }

      const transactionUseRows = yield* db
        .select({
          providerAssetRowId: schema.providerAssetTransactionUses.providerAssetRowId,
          sourceId: schema.providerAssetTransactionUses.sourceId,
          transactionId: schema.providerAssetTransactionUses.transactionId,
          timestamp: schema.transactions.timestamp,
          needsReview: schema.transactionReviews.needsReview,
          matchedLayer: schema.transactionReviews.matchedLayer,
        })
        .from(schema.providerAssetTransactionUses)
        .innerJoin(
          schema.transactions,
          and(
            eq(schema.transactions.id, schema.providerAssetTransactionUses.transactionId),
            eq(schema.transactions.sourceId, schema.providerAssetTransactionUses.sourceId),
            eq(schema.transactions.principalId, principalId)
          )
        )
        .innerJoin(
          schema.sources,
          and(
            eq(schema.sources.id, schema.providerAssetTransactionUses.sourceId),
            eq(schema.sources.principalId, principalId)
          )
        )
        .leftJoin(
          schema.transactionReviews,
          and(
            eq(
              schema.transactionReviews.transactionId,
              schema.providerAssetTransactionUses.transactionId
            ),
            eq(schema.transactionReviews.principalId, principalId)
          )
        )
        .orderBy(
          asc(schema.providerAssetTransactionUses.transactionId),
          asc(schema.providerAssetTransactionUses.providerAssetRowId)
        )
        .pipe(wrapSqlError("factualLedgerRepository.load.providerTransactionUses"))

      for (const row of transactionUseRows) {
        if (!isBeforeCutoff(row.timestamp, occurredBefore)) continue
        const outcome = selectFactDecision({
          decisions,
          providerAssetRowId: row.providerAssetRowId,
          requiresTarget: true,
          sourceRepresentationUseId: null,
          storedAssetId: null,
        })
        if (outcome._tag === "excluded") {
          withheldTransactionIds.add(row.transactionId)
          continue
        }
        if (outcome._tag === "ignored") continue

        const assetReviewIsOpen =
          row.needsReview === true && reviewIncludesAssetLayer(row.matchedLayer)
        const blockedOutcome =
          outcome._tag === "blocked" || outcome._tag === "malformed"
            ? outcome
            : assetReviewIsOpen
              ? ({ _tag: "malformed", assetId: outcome.assetId } as const)
              : undefined
        if (blockedOutcome === undefined) continue

        const blockerError = recordOutcomeBlockers({
          blockers: inputBlockerByKey,
          custodyUnitIdBySource,
          eventId: row.transactionId,
          occurredAt: row.timestamp,
          outcome: blockedOutcome,
          providerAssetRowId: row.providerAssetRowId,
          sourceId: row.sourceId,
        })
        if (blockerError !== undefined) return yield* blockerError
        withheldTransactionIds.add(row.transactionId)
      }
    })

  const loadCustodyMovementEvents = ({
    custodyUnitIdBySource,
    decisions,
    inputBlockerByKey,
    occurredBefore,
    principalId,
    withheldTransactionIds,
  }: Pick<LoadParams, "principalId"> & {
    readonly custodyUnitIdBySource: ReadonlyMap<string, CustodyUnitId>
    readonly decisions: PrincipalAssetOverrideDecisions
    readonly inputBlockerByKey: Map<string, FactualLedgerInputBlocker>
    readonly occurredBefore: Date | undefined
    readonly withheldTransactionIds: Set<string>
  }) =>
    Effect.gen(function* () {
      const rows = yield* db
        .select({
          id: schema.transferReconciliations.id,
          providerTransferId: schema.providerTransfers.id,
          providerTransactionId: providerTransactionTable.id,
          canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
          canonicalTransactionId: schema.transferReconciliations.canonicalTransactionId,
          providerDirection: schema.providerTransfers.direction,
          providerSourceId: providerTransactionTable.sourceId,
          canonicalSourceId: canonicalTransactionTable.sourceId,
          canonicalTimestamp: canonicalTransactionTable.timestamp,
          canonicalExternalId: canonicalTransactionTable.externalId,
          canonicalExternalGroupId: canonicalTransactionTable.externalGroupId,
          providerAssetRowId: schema.providerTransfers.providerAssetId,
          providerSourceRepresentationUseId: schema.providerTransfers.sourceRepresentationUseId,
          providerInventoryAssetId: schema.inventoryMovements.assetId,
          assetId: schema.transfers.assetId,
          canonicalProviderAssetRowId: schema.transfers.providerAssetRowId,
          canonicalSourceRepresentationUseId: schema.transfers.sourceRepresentationUseId,
          amount: schema.transfers.amount,
        })
        .from(schema.transferReconciliations)
        .innerJoin(
          schema.providerTransfers,
          eq(schema.transferReconciliations.providerTransferId, schema.providerTransfers.id)
        )
        .innerJoin(
          providerTransactionTable,
          and(
            eq(schema.providerTransfers.transactionId, providerTransactionTable.id),
            eq(schema.providerTransfers.sourceId, providerTransactionTable.sourceId)
          )
        )
        .innerJoin(
          schema.inventoryMovements,
          and(
            eq(schema.inventoryMovements.providerTransferId, schema.providerTransfers.id),
            eq(schema.inventoryMovements.transactionId, providerTransactionTable.id),
            eq(schema.inventoryMovements.sourceId, schema.providerTransfers.sourceId)
          )
        )
        .innerJoin(
          schema.transfers,
          eq(schema.transferReconciliations.canonicalTransferId, schema.transfers.id)
        )
        .innerJoin(
          canonicalTransactionTable,
          and(
            eq(schema.transferReconciliations.canonicalTransactionId, canonicalTransactionTable.id),
            eq(schema.transfers.sourceId, canonicalTransactionTable.sourceId)
          )
        )
        .innerJoin(
          providerSourceTable,
          and(
            eq(providerTransactionTable.sourceId, providerSourceTable.id),
            eq(providerSourceTable.principalId, principalId)
          )
        )
        .innerJoin(
          canonicalSourceTable,
          and(
            eq(canonicalTransactionTable.sourceId, canonicalSourceTable.id),
            eq(canonicalSourceTable.principalId, principalId)
          )
        )
        .where(
          and(
            eq(schema.transferReconciliations.principalId, principalId),
            eq(schema.inventoryMovements.principalId, principalId),
            eq(providerTransactionTable.principalId, principalId),
            eq(canonicalTransactionTable.principalId, principalId),
            eq(schema.transfers.principalId, principalId),
            eq(schema.inventoryMovements.purpose, "principal"),
            eq(schema.inventoryMovements.reconciliationStatus, "matched"),
            or(
              eq(schema.transferReconciliations.status, "approved"),
              and(
                eq(schema.transferReconciliations.status, "auto_applied"),
                eq(schema.transferReconciliations.deterministic, true)
              )
            )
          )
        )
        .orderBy(asc(schema.transferReconciliations.id))
        .pipe(wrapSqlError("factualLedgerRepository.load.custodyMovements"))

      const eventRows: Array<{
        readonly event: AccountingEvent
        readonly canonicalTransferId: string
        readonly providerTransferId: string
        readonly canonicalTransactionId: string | null
        readonly providerTransactionId: string
      }> = []
      const custodyContexts: MovementCorrectionCustodyContext[] = []
      const reconciledCanonicalTransferIds = new Set<string>()
      const reconciledProviderTransferIds = new Set<string>()
      const handledProviderTransferIds = new Set<string>()
      const seenCanonicalTransferIds = new Set<string>()
      const pairs: Array<{
        readonly canonicalTransactionId: string | null
        readonly providerTransactionId: string
      }> = []
      for (const row of rows) {
        if (row.canonicalTransferId === null) continue
        custodyContexts.push({
          reconciliationId: row.id,
          canonicalTransferId: row.canonicalTransferId,
          providerTransferId: row.providerTransferId,
          canonicalTransactionId: row.canonicalTransactionId,
          providerTransactionId: row.providerTransactionId,
          canonicalSourceId: row.canonicalSourceId,
          providerSourceId: row.providerSourceId,
          occurredAt: row.canonicalTimestamp.toISOString(),
          quantity: row.amount,
          canonicalStoredAssetId: row.assetId,
          providerStoredAssetId: row.providerInventoryAssetId,
          providerDirection: row.providerDirection,
          outcome: isBeforeCutoff(row.canonicalTimestamp, occurredBefore)
            ? "withheld"
            : "outside_period",
        })
        handledProviderTransferIds.add(row.providerTransferId)
        reconciledCanonicalTransferIds.add(row.canonicalTransferId)
        reconciledProviderTransferIds.add(row.providerTransferId)
        if (!isBeforeCutoff(row.canonicalTimestamp, occurredBefore)) continue
        if (seenCanonicalTransferIds.has(row.canonicalTransferId)) {
          return yield* new PersistenceError({
            operation: "factualLedgerRepository.load.duplicateCustodyMovement",
            cause: `Canonical transfer has multiple active reconciliations: ${row.canonicalTransferId}`,
          })
        }
        seenCanonicalTransferIds.add(row.canonicalTransferId)
        pairs.push({
          canonicalTransactionId: row.canonicalTransactionId,
          providerTransactionId: row.providerTransactionId,
        })
        const canonicalOutcome = selectFactDecision({
          decisions,
          providerAssetRowId: row.canonicalProviderAssetRowId,
          requiresTarget: true,
          sourceRepresentationUseId: row.canonicalSourceRepresentationUseId,
          storedAssetId: row.assetId,
        })
        const providerOutcome = selectFactDecision({
          decisions,
          providerAssetRowId: row.providerAssetRowId,
          requiresTarget: true,
          sourceRepresentationUseId: row.providerSourceRepresentationUseId,
          storedAssetId: row.providerInventoryAssetId,
        })
        const outcomes = [
          {
            outcome: canonicalOutcome,
            providerAssetRowId: row.canonicalProviderAssetRowId,
            sourceId: row.canonicalSourceId,
          },
          {
            outcome: providerOutcome,
            providerAssetRowId: row.providerAssetRowId,
            sourceId: row.providerSourceId,
          },
        ] as const
        let hasBlockedOutcome = false
        for (const entry of outcomes) {
          const blockedOutcome =
            entry.outcome._tag === "blocked" || entry.outcome._tag === "malformed"
              ? entry.outcome
              : entry.outcome._tag === "ignored"
                ? ({ _tag: "malformed", assetId: null } as const)
                : undefined
          if (blockedOutcome === undefined) continue
          hasBlockedOutcome = true
          const blockerError = recordOutcomeBlockers({
            blockers: inputBlockerByKey,
            custodyUnitIdBySource,
            eventId: row.id,
            occurredAt: row.canonicalTimestamp,
            outcome: blockedOutcome,
            providerAssetRowId: entry.providerAssetRowId,
            sourceId: entry.sourceId,
          })
          if (blockerError !== undefined) return yield* blockerError
        }
        const isExcluded = outcomes.some(({ outcome }) => outcome._tag === "excluded")
        if (isExcluded) {
          withheldTransactionIds.add(row.providerTransactionId)
          if (row.canonicalTransactionId !== null) {
            withheldTransactionIds.add(row.canonicalTransactionId)
          }
          continue
        }
        if (hasBlockedOutcome) {
          withheldTransactionIds.add(row.providerTransactionId)
          if (row.canonicalTransactionId !== null) {
            withheldTransactionIds.add(row.canonicalTransactionId)
          }
          continue
        }
        if (canonicalOutcome._tag !== "included" || providerOutcome._tag !== "included") {
          return yield* new PersistenceError({
            operation: "factualLedgerRepository.load.custodyDecision",
            cause: `Custody movement has no included decision after preflight: ${row.id}`,
          })
        }
        if (!isPositiveQuantity(row.amount)) {
          const blockerError = recordOutcomeBlockers({
            blockers: inputBlockerByKey,
            custodyUnitIdBySource,
            eventId: row.id,
            occurredAt: row.canonicalTimestamp,
            outcome: { _tag: "malformed", assetId: canonicalOutcome.assetId },
            providerAssetRowId: row.canonicalProviderAssetRowId,
            sourceId: row.canonicalSourceId,
          })
          if (blockerError !== undefined) return yield* blockerError
          withheldTransactionIds.add(row.providerTransactionId)
          if (row.canonicalTransactionId !== null) {
            withheldTransactionIds.add(row.canonicalTransactionId)
          }
          continue
        }
        if (canonicalOutcome.assetId !== providerOutcome.assetId) {
          for (const entry of [
            {
              assetId: canonicalOutcome.assetId,
              providerAssetRowId: row.canonicalProviderAssetRowId,
              sourceId: row.canonicalSourceId,
            },
            {
              assetId: providerOutcome.assetId,
              providerAssetRowId: row.providerAssetRowId,
              sourceId: row.providerSourceId,
            },
          ]) {
            const blockerError = recordOutcomeBlockers({
              blockers: inputBlockerByKey,
              custodyUnitIdBySource,
              eventId: row.id,
              occurredAt: row.canonicalTimestamp,
              outcome: { _tag: "malformed", assetId: entry.assetId },
              providerAssetRowId: entry.providerAssetRowId,
              sourceId: entry.sourceId,
            })
            if (blockerError !== undefined) return yield* blockerError
          }
          withheldTransactionIds.add(row.providerTransactionId)
          if (row.canonicalTransactionId !== null) {
            withheldTransactionIds.add(row.canonicalTransactionId)
          }
          continue
        }

        const reference = transactionReference({
          externalGroupId: row.canonicalExternalGroupId,
          externalId: row.canonicalExternalId,
          transactionId: row.canonicalTransactionId,
        })
        const fromCustodySourceId =
          row.providerDirection === "outbound" ? row.providerSourceId : row.canonicalSourceId
        const toCustodySourceId =
          row.providerDirection === "outbound" ? row.canonicalSourceId : row.providerSourceId

        eventRows.push({
          event: yield* decodeRequired({
            schema: CustodyMovementEvent,
            input: {
              _tag: "custody_movement",
              id: row.id,
              occurredAt: { epochMillis: row.canonicalTimestamp.getTime() },
              assetId: canonicalOutcome.assetId,
              quantity: row.amount,
              ...(reference === undefined ? {} : { transactionReference: reference }),
              fromCustodySourceId,
              toCustodySourceId,
            },
            operation: "factualLedgerRepository.load.event",
          }),
          canonicalTransferId: row.canonicalTransferId,
          providerTransferId: row.providerTransferId,
          canonicalTransactionId: row.canonicalTransactionId,
          providerTransactionId: row.providerTransactionId,
        })
      }

      closeWithheldTransactionPairs({ pairs, withheldTransactionIds })

      return {
        eventRows,
        custodyContexts,
        handledProviderTransferIds,
        pairs,
        reconciledCanonicalTransferIds,
        reconciledProviderTransferIds,
      }
    })

  const makeObservedValuationFacts = ({
    eventRows,
    eventCountByTransactionId,
    reportingCurrency,
  }: Pick<LoadedLegEvents, "eventRows" | "eventCountByTransactionId"> &
    Pick<LoadParams, "reportingCurrency">) =>
    Effect.gen(function* () {
      const valuationFacts: ValuationFact[] = []
      for (const { event, row } of eventRows) {
        if (
          row.kind !== "fee" &&
          row.transactionId !== null &&
          eventCountByTransactionId.get(row.transactionId) === 1 &&
          row.providerFiatAmount !== null &&
          row.providerFiatCurrency === reportingCurrency
        ) {
          const providerAmount = decodeValuationDecimal(row.providerFiatAmount)
          if (
            providerAmount === undefined ||
            row.providerFiatAmount.startsWith("-") ||
            BigDecimal.isNegative(providerAmount)
          ) {
            continue
          }

          const providerResourcePath = trimmedNonEmpty(row.providerResourcePath)
          const evidenceReference =
            providerResourcePath === undefined
              ? row.transactionSourceRawRecordId === null
                ? `transaction:${row.transactionId}`
                : `source_raw_record:${row.transactionSourceRawRecordId}`
              : providerResourcePath

          valuationFacts.push(
            yield* decodeRequired({
              schema: ObservedConsiderationFact,
              input: {
                _tag: "observed_consideration",
                eventId: event.id,
                amount: {
                  amount: row.providerFiatAmount,
                  currency: reportingCurrency,
                },
                evidenceReference,
              },
              operation: "factualLedgerRepository.load.observedConsideration",
            })
          )
        }
      }

      return valuationFacts
    })

  const loadPriceRows = ({
    events,
    reportingCurrency,
  }: {
    readonly events: ReadonlyArray<AccountingEvent>
  } & Pick<LoadParams, "reportingCurrency">) => {
    if (reportingCurrency !== "EUR") return Effect.succeed([])

    const eventAssetIds = [...new Set(events.map(({ assetId }) => assetId))]
    const eventDayStarts = [
      ...new Set(events.map((event) => utcDay(event.occurredAt.toDate()))),
    ].map(utcDayStart)

    return eventAssetIds.length === 0 || eventDayStarts.length === 0
      ? Effect.succeed([])
      : db
          .select({
            assetId: schema.assetPrices.assetId,
            timestamp: schema.assetPrices.timestamp,
            price: schema.assetPrices.price,
            source: schema.assetPrices.source,
          })
          .from(schema.assetPrices)
          .where(
            and(
              inArray(schema.assetPrices.assetId, eventAssetIds),
              eq(schema.assetPrices.currency, reportingCurrency),
              inArray(schema.assetPrices.timestamp, eventDayStarts)
            )
          )
          .orderBy(asc(schema.assetPrices.assetId), asc(schema.assetPrices.timestamp))
          .pipe(wrapSqlError("factualLedgerRepository.load.prices"))
  }

  type PriceRows = Effect.Success<ReturnType<typeof loadPriceRows>>

  const priceRowKey = ({ assetId, timestamp }: Pick<PriceRows[number], "assetId" | "timestamp">) =>
    `${assetId}:${utcDay(timestamp)}`

  const makePriceQuoteMap = (priceRows: PriceRows): ReadonlyMap<string, PriceRows[number]> => {
    const quotes = new Map<string, PriceRows[number]>()

    for (const row of priceRows) {
      const value = decodeValuationDecimal(row.price)
      if (
        value === undefined ||
        !BigDecimal.isPositive(value) ||
        row.source === null ||
        row.source === "" ||
        row.source !== row.source.trim()
      ) {
        continue
      }

      quotes.set(priceRowKey(row), row)
    }

    return quotes
  }

  const makeMarketValuationFacts = ({
    events,
    priceRows,
    reportingCurrency,
  }: {
    readonly events: ReadonlyArray<AccountingEvent>
    readonly priceRows: PriceRows
  } & Pick<LoadParams, "reportingCurrency">) =>
    Effect.gen(function* () {
      const valuationFacts: ValuationFact[] = []
      const quotes = makePriceQuoteMap(priceRows)

      for (const event of events) {
        const quote = quotes.get(
          priceRowKey({ assetId: event.assetId, timestamp: event.occurredAt.toDate() })
        )
        if (quote === undefined) continue

        valuationFacts.push(
          yield* decodeRequired({
            schema: MarketQuoteFact,
            input: {
              _tag: "market_quote",
              eventId: event.id,
              unitPrice: {
                amount: quote.price,
                currency: reportingCurrency,
              },
              quotedAt: { epochMillis: quote.timestamp.getTime() },
              source: quote.source,
            },
            operation: "factualLedgerRepository.load.marketQuote",
          })
        )
      }

      return valuationFacts
    })

  const load: FactualLedgerRepositoryShape["load"] = ({
    occurredBefore,
    principalId,
    reportingCurrency,
  }) =>
    Effect.gen(function* () {
      const supportedReportingCurrency = yield* validateReportingCurrency(reportingCurrency)
      const legTargetRows = yield* db
        .select({
          providerAssetRowId: schema.transactionLegs.providerAssetRowId,
          sourceRepresentationUseId: schema.transactionLegs.sourceRepresentationUseId,
        })
        .from(schema.transactionLegs)
        .innerJoin(
          schema.sources,
          and(
            eq(schema.transactionLegs.sourceId, schema.sources.id),
            eq(schema.sources.principalId, principalId)
          )
        )
        .where(eq(schema.transactionLegs.principalId, principalId))
        .pipe(wrapSqlError("factualLedgerRepository.load.providerAssetRows"))
      const providerTransferTargetRows = yield* db
        .select({
          providerAssetRowId: schema.providerTransfers.providerAssetId,
          sourceRepresentationUseId: schema.providerTransfers.sourceRepresentationUseId,
        })
        .from(schema.providerTransfers)
        .innerJoin(
          schema.sources,
          and(
            eq(schema.providerTransfers.sourceId, schema.sources.id),
            eq(schema.sources.principalId, principalId)
          )
        )
        .pipe(wrapSqlError("factualLedgerRepository.load.providerTransferAssets"))
      const transferTargetRows = yield* db
        .select({
          providerAssetRowId: schema.transfers.providerAssetRowId,
          sourceRepresentationUseId: schema.transfers.sourceRepresentationUseId,
        })
        .from(schema.transfers)
        .innerJoin(
          schema.sources,
          and(
            eq(schema.transfers.sourceId, schema.sources.id),
            eq(schema.sources.principalId, principalId)
          )
        )
        .where(eq(schema.transfers.principalId, principalId))
        .pipe(wrapSqlError("factualLedgerRepository.load.transferTargets"))
      const providerTransactionUseTargetRows = yield* db
        .select({
          providerAssetRowId: schema.providerAssetTransactionUses.providerAssetRowId,
        })
        .from(schema.providerAssetTransactionUses)
        .innerJoin(
          schema.sources,
          and(
            eq(schema.providerAssetTransactionUses.sourceId, schema.sources.id),
            eq(schema.sources.principalId, principalId)
          )
        )
        .pipe(wrapSqlError("factualLedgerRepository.load.providerTransactionUseTargets"))
      const targetRows = [
        ...legTargetRows,
        ...providerTransferTargetRows,
        ...transferTargetRows,
        ...providerTransactionUseTargetRows.map(({ providerAssetRowId }) => ({
          providerAssetRowId,
          sourceRepresentationUseId: null,
        })),
      ]
      const providerAssetRowIds = targetRows.flatMap(({ providerAssetRowId }) =>
        providerAssetRowId === null ? [] : [providerAssetRowId]
      )
      const sourceRepresentationUseIds = targetRows.flatMap(({ sourceRepresentationUseId }) =>
        sourceRepresentationUseId === null ? [] : [sourceRepresentationUseId]
      )
      const decisions = yield* principalAssetOverrideDecisionLoader.load({
        principalId,
        providerAssetRowIds,
        sourceRepresentationUseIds,
      })
      const membershipRows = yield* db
        .select({
          custodyUnitId: schema.custodyUnitSources.custodyUnitId,
          sourceId: schema.custodyUnitSources.sourceId,
        })
        .from(schema.custodyUnitSources)
        .where(eq(schema.custodyUnitSources.principalId, principalId))
        .orderBy(
          asc(schema.custodyUnitSources.custodyUnitId),
          asc(schema.custodyUnitSources.sourceId)
        )
        .pipe(wrapSqlError("factualLedgerRepository.load.custodyUnitMembership"))
      const custodyUnitIdBySource = new Map(
        membershipRows.map(({ custodyUnitId, sourceId }) => [
          sourceId,
          CustodyUnitId.make(custodyUnitId),
        ])
      )
      const inputBlockerByKey = new Map<string, FactualLedgerInputBlocker>()
      const withheldTransactionIds = new Set<string>()
      const custodyMovementEvents = yield* loadCustodyMovementEvents({
        custodyUnitIdBySource,
        decisions,
        inputBlockerByKey,
        occurredBefore,
        principalId,
        withheldTransactionIds,
      })
      yield* loadProviderInputDecisions({
        custodyUnitIdBySource,
        decisions,
        handledProviderTransferIds: custodyMovementEvents.handledProviderTransferIds,
        inputBlockerByKey,
        occurredBefore,
        principalId,
        withheldTransactionIds,
      })
      const legEvents = yield* loadLegEvents({
        custodyUnitIdBySource,
        decisions,
        inputBlockerByKey,
        occurredBefore,
        principalId,
        reconciliationPairs: custodyMovementEvents.pairs,
        reconciledCanonicalTransferIds: custodyMovementEvents.reconciledCanonicalTransferIds,
        reconciledProviderTransferIds: custodyMovementEvents.reconciledProviderTransferIds,
        withheldTransactionIds,
      })
      const custodyEventRows = custodyMovementEvents.eventRows.filter(
        ({ canonicalTransactionId, providerTransactionId }) =>
          !withheldTransactionIds.has(providerTransactionId) &&
          (canonicalTransactionId === null || !withheldTransactionIds.has(canonicalTransactionId))
      )
      const custodyEvents = custodyEventRows.map(({ event }) => event)
      const events = [...legEvents.events, ...custodyEvents].sort(compareEvents)
      const valuationEvents = events.filter((event) => event._tag !== "custody_movement")
      const observedValuationFacts = yield* makeObservedValuationFacts({
        eventRows: legEvents.eventRows,
        eventCountByTransactionId: legEvents.eventCountByTransactionId,
        reportingCurrency: supportedReportingCurrency,
      })
      const priceRows = yield* loadPriceRows({
        events: valuationEvents,
        reportingCurrency: supportedReportingCurrency,
      })
      const marketValuationFacts = yield* makeMarketValuationFacts({
        events: valuationEvents,
        priceRows,
        reportingCurrency: supportedReportingCurrency,
      })
      const valuationFacts = [...observedValuationFacts, ...marketValuationFacts].sort(
        compareValuationFacts
      )

      const custodyUnitMembership = membershipRows.map(({ custodyUnitId, sourceId }) => ({
        custodyUnitId: CustodyUnitId.make(custodyUnitId),
        sourceId: SourceId.make(sourceId),
      }))
      const inputBlockers = [...inputBlockerByKey.values()].sort((left, right) =>
        blockerKey(left).localeCompare(blockerKey(right))
      )

      // Keep selections made before cutoff/technical checks even when no event was emitted.
      // All associations use the exact IDs read by the custody writer above.
      const custodyEventById = new Map<string, AccountingEvent>(
        custodyEvents.map((event) => [event.id, event])
      )
      const custodyByCanonicalTransfer = new Map<string, MovementCorrectionCustodyContext[]>()
      const custodyByProviderTransfer = new Map<string, MovementCorrectionCustodyContext[]>()
      for (const selection of custodyMovementEvents.custodyContexts) {
        const context: MovementCorrectionCustodyContext = custodyEventById.has(
          selection.reconciliationId
        )
          ? { ...selection, outcome: "included" }
          : selection
        const canonical = custodyByCanonicalTransfer.get(context.canonicalTransferId)
        if (canonical === undefined)
          custodyByCanonicalTransfer.set(context.canonicalTransferId, [context])
        else canonical.push(context)
        const provider = custodyByProviderTransfer.get(context.providerTransferId)
        if (provider === undefined)
          custodyByProviderTransfer.set(context.providerTransferId, [context])
        else provider.push(context)
      }
      const eventByLegId = new Map<string, AccountingEvent>(
        legEvents.events.map((event) => [event.id, event])
      )
      const eventsByTarget = new Map<string, AccountingEvent>()
      const correctionLegContexts = legEvents.legContexts.map((context) => {
        const custody =
          context.structure !== "custody"
            ? []
            : context.originKind === "canonical_transfer" && context.sourceTransferId !== null
              ? (custodyByCanonicalTransfer.get(context.sourceTransferId) ?? [])
              : context.originKind === "provider_transfer" && context.providerTransferId !== null
                ? (custodyByProviderTransfer.get(context.providerTransferId) ?? [])
                : []
        const includedCustody = custody.find((selection) => selection.outcome === "included")
        const event =
          context.structure === "custody"
            ? includedCustody === undefined
              ? undefined
              : custodyEventById.get(includedCustody.reconciliationId)
            : eventByLegId.get(context.legId)
        if (event !== undefined) eventsByTarget.set(context.targetId, event)
        return { ...context, custody, effectiveAssetId: event?.assetId ?? context.effectiveAssetId }
      })
      const correctionInputs = yield* movementCorrectionLoader.load({
        principalId,
        reportingCurrency: supportedReportingCurrency,
        occurredBefore,
        legContexts: correctionLegContexts,
        eventsByTarget,
        valuationFacts,
      })
      return {
        correctionInputs,
        events,
        valuationFacts,
        custodyUnitMembership,
        inputBlockers,
        principalAssetOverrideRevision: decisions.revision,
      }
    })

  return FactualLedgerRepository.of({ load })
})

/** Live factual-ledger repository layer. */
export const FactualLedgerRepositoryLive = Layer.effect(FactualLedgerRepository, make)
