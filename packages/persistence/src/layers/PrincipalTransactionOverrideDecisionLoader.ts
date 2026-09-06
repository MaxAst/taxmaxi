/**
 * PrincipalTransactionOverrideDecisionLoader - Capture movement correction inputs in the caller's snapshot.
 *
 * @module PrincipalTransactionOverrideDecisionLoader
 */
import {
  AccountingEvent,
  MovementClassificationInput,
  MovementCorrectionFacts,
  MovementPriceInput,
  ValuationFact,
  UserValuationFact,
  resolveMovementPrice,
  type CustodyUnitId,
} from "@my/core/accounting"
import type { CurrencyCode } from "@my/core/currency"
import type { PrincipalId } from "@my/core/ownership"
import { and, asc, eq, getTableColumns } from "drizzle-orm"
import * as BigDecimal from "effect/BigDecimal"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PersistenceError, wrapSqlError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import type {
  CalculationRunCorrectionInput,
  CapturedMovementCorrectionHistory,
  MovementCorrectionLegContext,
  MovementPriceApplicationProblem,
  FactualLedgerInputBlocker,
} from "../services/FactualLedgerRepository.ts"
import { drizzle } from "./PgClientLive.ts"

const captureHistory = (row: typeof schema.principalTransactionOverrides.$inferSelect) =>
  Effect.gen(function* () {
    const inspectedFacts = yield* Schema.decodeEffect(MovementCorrectionFacts)({
      target: {
        principalId: row.principalId,
        sourceId: row.sourceId,
        sourceRecordKey: row.inspectedSourceRecordKey,
        componentKey: row.inspectedComponentKey,
      },
      systemRevision: row.inspectedSystemRevision,
      quantity: row.inspectedQuantity,
      economicAssetId: row.inspectedEconomicAssetId,
      direction: row.inspectedDirection,
      structure: row.inspectedStructure,
    })
    const input =
      row.operation === "withdraw"
        ? null
        : row.kind === "price"
          ? {
              _tag: "price" as const,
              input: yield* Schema.decodeUnknownEffect(MovementPriceInput)(row.priceInput),
            }
          : {
              _tag: "classification" as const,
              input: yield* Schema.decodeUnknownEffect(MovementClassificationInput)(
                row.classificationInput
              ),
            }
    return {
      id: row.id,
      principalId: row.principalId,
      sourceId: row.sourceId,
      targetId: row.targetId,
      kind: row.kind,
      operation: row.operation,
      inspectedFacts: yield* Schema.encodeEffect(MovementCorrectionFacts)(inspectedFacts),
      inspectedSystem: {
        occurredAt: row.inspectedOccurredAt.toISOString(),
        legKind: row.inspectedLegKind,
        recordedFiatAmount: row.inspectedFiatAmount,
        recordedFiatCurrency: row.inspectedFiatCurrency,
        transactionType: row.inspectedTransactionType,
        providerTransactionType: row.inspectedProviderTransactionType,
        derivationRule: row.inspectedDerivationRule,
        feeForSourceRecordKey: row.inspectedFeeForSourceRecordKey,
      },
      input,
      actorUserId: row.actorUserId,
      reason: row.reason,
      supersedesOverrideId: row.supersedesOverrideId,
      recordedAt: row.recordedAt.toISOString(),
    } satisfies CapturedMovementCorrectionHistory
  })

/** Apply only the active price stream after the caller has decided event eligibility. */
const applyPrices = ({
  captured,
  eventsByTarget,
  custodyUnitIdBySource,
  identitiesByTarget,
  valuationFacts,
  reportingCurrency,
}: {
  readonly captured: ReadonlyArray<CalculationRunCorrectionInput>
  readonly eventsByTarget: ReadonlyMap<string, AccountingEvent>
  readonly custodyUnitIdBySource: ReadonlyMap<string, CustodyUnitId>
  readonly identitiesByTarget: ReadonlyMap<
    string,
    { readonly sourceRecordKey: string; readonly componentKey: string }
  >
  readonly valuationFacts: ReadonlyArray<ValuationFact>
  readonly reportingCurrency: CurrencyCode
}) =>
  Effect.gen(function* () {
    const userFacts = new Map<string, UserValuationFact>()
    const inputBlockers: FactualLedgerInputBlocker[] = []
    const decisions: CalculationRunCorrectionInput[] = []
    for (const capture of captured) {
      const { current, history } = capture
      if (
        capture.streamState !== "active" ||
        history.input?._tag !== "price" ||
        capture.currentOutcome === "outside_period"
      ) {
        decisions.push(capture)
        continue
      }
      const event = eventsByTarget.get(history.targetId)
      const inspected = yield* Schema.decodeEffect(MovementCorrectionFacts)(history.inspectedFacts)
      const identity = identitiesByTarget.get(history.targetId)
      const problem: MovementPriceApplicationProblem | null =
        current === null
          ? "target_unavailable"
          : event === undefined
            ? "target_ineligible"
            : identity === undefined ||
                identity.sourceRecordKey !== inspected.target.sourceRecordKey ||
                identity.componentKey !== inspected.target.componentKey ||
                current.sourceId !== inspected.target.sourceId
              ? "target_changed"
              : current.structure === "custody" ||
                  current.structure !== inspected.structure ||
                  current.direction !== inspected.direction ||
                  event._tag === "custody_movement"
                ? "structure_changed"
                : !BigDecimal.equals(event.quantity, inspected.quantity)
                  ? "quantity_changed"
                  : event.assetId !== inspected.economicAssetId
                    ? "asset_changed"
                    : history.input.input.currency !== reportingCurrency
                      ? "reporting_currency_mismatch"
                      : null
      let resolvedPrice: CalculationRunCorrectionInput["resolvedPrice"] = null
      if (problem === null && event !== undefined) {
        // The inspected positive quantity was just checked against the actual current event.
        // No historical revision is represented as a current one.
        const resolved = yield* resolveMovementPrice({
          input: history.input.input,
          facts: inspected,
          reportingCurrency,
        })
        const fact = yield* Schema.decodeEffect(UserValuationFact)({
          _tag: "user_valuation",
          eventId: event.id,
          amount: { amount: resolved.totalValue, currency: resolved.currency },
          evidenceReference: `movement-price:${history.id}`,
        })
        userFacts.set(event.id, fact)
        resolvedPrice = {
          totalValue: resolved.totalValue,
          unitPrice: resolved.unitPrice,
          currency: resolved.currency,
        }
      }
      if (problem !== null && event !== undefined && current !== null) {
        const custodyUnitId = custodyUnitIdBySource.get(current.sourceId)
        if (custodyUnitId === undefined)
          return yield* new PersistenceError({
            operation: "movementPrice.blockerCustodyUnit",
            cause: `Source is not assigned to a custody unit: ${current.sourceId}`,
          })
        inputBlockers.push({
          code:
            problem === "reporting_currency_mismatch"
              ? "movement_price_currency_mismatch"
              : "movement_correction_needs_attention",
          eventId: event.id,
          occurredAt: event.occurredAt.toDate(),
          assetId: event.assetId,
          custodyUnitId,
          missingQuantity: null,
        })
      }
      decisions.push({
        ...capture,
        application: problem === null ? "applied" : "needs_attention",
        applicationProblem: problem,
        resolvedPrice,
      })
    }
    const correctionInputs = yield* Effect.forEach(decisions, (capture) =>
      Effect.gen(function* () {
        const event = eventsByTarget.get(capture.history.targetId)
        const fact = event === undefined ? undefined : userFacts.get(event.id)
        return fact === undefined
          ? capture
          : {
              ...capture,
              effective: {
                ...capture.system,
                valuationFacts: [
                  ...capture.system.valuationFacts,
                  yield* Schema.encodeEffect(UserValuationFact)(fact),
                ],
              },
            }
      })
    )
    return {
      correctionInputs,
      inputBlockers,
      valuationFacts: [...valuationFacts, ...userFacts.values()],
    }
  })

/** Load owned history once, apply eligible prices, and retain exact system and consumed inputs. */
export const makePrincipalTransactionOverrideDecisionLoader = Effect.gen(function* () {
  const db = yield* drizzle
  const load = ({
    principalId,
    reportingCurrency,
    occurredBefore,
    legContexts,
    eventsByTarget,
    valuationFacts,
    custodyUnitIdBySource,
  }: {
    readonly custodyUnitIdBySource: ReadonlyMap<string, CustodyUnitId>
    readonly principalId: PrincipalId
    readonly reportingCurrency: CurrencyCode
    readonly occurredBefore: Date | undefined
    readonly legContexts: ReadonlyArray<MovementCorrectionLegContext>
    readonly eventsByTarget: ReadonlyMap<string, AccountingEvent>
    readonly valuationFacts: ReadonlyArray<ValuationFact>
  }) =>
    Effect.gen(function* () {
      const rows = yield* db
        .select({
          ...getTableColumns(schema.principalTransactionOverrides),
          sourceRecordKey: schema.movementCorrectionTargets.sourceRecordKey,
          componentKey: schema.movementCorrectionTargets.componentKey,
        })
        .from(schema.principalTransactionOverrides)
        .innerJoin(
          schema.movementCorrectionTargets,
          and(
            eq(schema.movementCorrectionTargets.id, schema.principalTransactionOverrides.targetId),
            eq(
              schema.movementCorrectionTargets.sourceId,
              schema.principalTransactionOverrides.sourceId
            ),
            eq(schema.movementCorrectionTargets.principalId, principalId)
          )
        )
        .innerJoin(
          schema.sources,
          and(
            eq(schema.sources.id, schema.principalTransactionOverrides.sourceId),
            eq(schema.sources.principalId, principalId)
          )
        )
        .where(eq(schema.principalTransactionOverrides.principalId, principalId))
        .orderBy(
          asc(schema.principalTransactionOverrides.targetId),
          asc(schema.principalTransactionOverrides.kind),
          asc(schema.principalTransactionOverrides.recordedAt),
          asc(schema.principalTransactionOverrides.id)
        )
      const contextByTarget = new Map(legContexts.map((context) => [context.targetId, context]))
      const valuationsByEvent = new Map<string, ValuationFact[]>()
      for (const fact of valuationFacts) {
        const existing = valuationsByEvent.get(fact.eventId)
        if (existing === undefined) valuationsByEvent.set(fact.eventId, [fact])
        else existing.push(fact)
      }
      const superseded = new Set(
        rows.flatMap((row) => (row.supersedesOverrideId === null ? [] : [row.supersedesOverrideId]))
      )
      const streamKey = (row: (typeof rows)[number]) => `${row.targetId}:${row.kind}`
      const relevantStreams = new Set(
        rows
          .filter((row) => {
            if (occurredBefore === undefined || row.inspectedOccurredAt < occurredBefore)
              return true
            const current = contextByTarget.get(row.targetId)
            if (current === undefined) return false
            if (eventsByTarget.has(row.targetId)) return true
            return current.custody.length > 0
              ? current.custody.some((selection) => selection.outcome !== "outside_period")
              : current.occurredAt < occurredBefore.toISOString()
          })
          .map(streamKey)
      )
      const captured: CalculationRunCorrectionInput[] = []
      for (const row of rows) {
        if (!relevantStreams.has(streamKey(row))) continue
        const current = contextByTarget.get(row.targetId) ?? null
        const event = current === null ? undefined : eventsByTarget.get(current.targetId)
        const system = {
          event: event === undefined ? null : yield* Schema.encodeEffect(AccountingEvent)(event),
          valuationFacts: yield* Effect.forEach(
            event === undefined ? [] : (valuationsByEvent.get(event.id) ?? []),
            (fact) => Schema.encodeEffect(ValuationFact)(fact)
          ),
        }
        const streamState = superseded.has(row.id)
          ? "superseded"
          : row.operation === "withdraw"
            ? "withdrawn"
            : "active"
        captured.push({
          history: yield* captureHistory(row),
          current,
          currentOutcome:
            event !== undefined
              ? "included"
              : current === null
                ? "absent"
                : current.custody.length > 0
                  ? current.custody.every((selection) => selection.outcome === "outside_period")
                    ? "outside_period"
                    : "withheld"
                  : occurredBefore !== undefined &&
                      current.occurredAt >= occurredBefore.toISOString()
                    ? "outside_period"
                    : "withheld",
          streamState,
          application: streamState === "active" ? "not_applied" : "inactive",
          reportingCurrency,
          applicationProblem: null,
          resolvedPrice: null,
          system,
          effective: system,
        })
      }
      return yield* applyPrices({
        captured,
        eventsByTarget,
        custodyUnitIdBySource,
        reportingCurrency,
        valuationFacts,
        identitiesByTarget: new Map(
          rows.map((row) => [
            row.targetId,
            { sourceRecordKey: row.sourceRecordKey, componentKey: row.componentKey },
          ])
        ),
      })
    }).pipe(wrapSqlError("principalTransactionOverrideDecisionLoader.load"))
  return { load }
})
