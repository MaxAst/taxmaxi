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
} from "@my/core/accounting"
import type { CurrencyCode } from "@my/core/currency"
import type { PrincipalId } from "@my/core/ownership"
import { and, asc, eq, getTableColumns } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { wrapSqlError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import type {
  CalculationRunCorrectionInput,
  CapturedMovementCorrectionHistory,
  MovementCorrectionLegContext,
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

/** Load owned history once, then capture recorded context and exact engine inputs without applying corrections. */
export const makePrincipalTransactionOverrideDecisionLoader = Effect.gen(function* () {
  const db = yield* drizzle
  const load = ({
    principalId,
    reportingCurrency,
    occurredBefore,
    legContexts,
    eventsByTarget,
    valuationFacts,
  }: {
    readonly principalId: PrincipalId
    readonly reportingCurrency: CurrencyCode
    readonly occurredBefore: Date | undefined
    readonly legContexts: ReadonlyArray<MovementCorrectionLegContext>
    readonly eventsByTarget: ReadonlyMap<string, AccountingEvent>
    readonly valuationFacts: ReadonlyArray<ValuationFact>
  }) =>
    Effect.gen(function* () {
      const rows = yield* db
        .select(getTableColumns(schema.principalTransactionOverrides))
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
          system,
          effective: system,
        })
      }
      return captured
    }).pipe(wrapSqlError("principalTransactionOverrideDecisionLoader.load"))
  return { load }
})
