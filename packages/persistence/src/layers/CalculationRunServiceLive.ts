/**
 * CalculationRunServiceLive - Repeatable-read full calculation runs.
 *
 * @module CalculationRunServiceLive
 */

import {
  ACCOUNTING_ENGINE_VERSION,
  AccountingChoiceResolutionError,
  calculate,
  GERMAN_RULE_SET_VERSION,
  germanTaxYearEndExclusive,
  type TaxAccountingError,
  UnsupportedJurisdictionError,
} from "@my/accounting"
import {
  format as formatQuantity,
  type AccountingEvent,
  type ValuationFact,
} from "@my/core/accounting"
import { createHash } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { databaseErrorMetadata } from "../errors/DatabaseErrorMetadata.ts"
import { PersistenceError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import {
  CalculationRunAlreadyStoredError,
  CalculationRunCurrencyMismatchError,
  type CalculationRunResult,
  InputLedgerRevision,
  CalculationRunRepository,
  CalculationSyncRequestId,
  ValuationRevision,
} from "../services/CalculationRunRepository.ts"
import {
  CalculationRunService,
  type CalculationRunServiceShape,
} from "../services/CalculationRunService.ts"
import {
  FactualLedgerRepository,
  type CustodyUnitMembership,
  type CalculationRunCorrectionInput,
  type FactualLedgerInputBlocker,
  type PrincipalAssetOverrideRevisionRecord,
} from "../services/FactualLedgerRepository.ts"
import { drizzle } from "./PgClientLive.ts"

const CALCULATION_FAILED_CODE = "calculation_failed"
const CALCULATION_STALE_RECOMPUTED_CODE = "calculation_stale_recomputed"
const BLOCKER_PROVIDER_ASSET_FOREIGN_KEY = "calculation_run_blockers_DSx7wqqyVAYZ_fkey"

const IllegalAccountingChoiceErrorTag = Schema.TaggedStruct("IllegalAccountingChoiceError", {})

const isTaxAccountingError = (error: unknown): error is TaxAccountingError =>
  Schema.is(AccountingChoiceResolutionError)(error) ||
  Schema.is(UnsupportedJurisdictionError)(error) ||
  Schema.is(IllegalAccountingChoiceErrorTag)(error)

const canonicalEvent = (event: AccountingEvent): ReadonlyArray<string | number | null> => {
  const common = [
    event._tag,
    event.id,
    event.occurredAt.epochMillis,
    event.assetId,
    formatQuantity(event.quantity),
    event.transactionReference ?? null,
  ]

  return event._tag === "custody_movement"
    ? [...common, event.fromCustodySourceId, event.toCustodySourceId]
    : [...common, event.custodySourceId, event.cause]
}

const canonicalValuationFact = (fact: ValuationFact): ReadonlyArray<string | number | null> => {
  switch (fact._tag) {
    case "observed_consideration":
    case "user_valuation":
      return [
        fact._tag,
        fact.eventId,
        fact.amount.format(),
        fact.amount.currency,
        fact.evidenceReference,
      ]
    case "market_quote":
      return [
        fact._tag,
        fact.eventId,
        fact.unitPrice.format(),
        fact.unitPrice.currency,
        fact.quotedAt.epochMillis,
        fact.source,
      ]
  }
}

const canonicalInputBlocker = (
  blocker: FactualLedgerInputBlocker
): ReadonlyArray<string | number | null> => [
  blocker.code,
  blocker.eventId,
  blocker.occurredAt.getTime(),
  blocker.assetId ?? null,
  "providerAssetRowId" in blocker ? (blocker.providerAssetRowId ?? null) : null,
  blocker.custodyUnitId,
]

const sha256 = (domain: string, value: unknown): string =>
  createHash("sha256").update(domain).update("\0").update(JSON.stringify(value)).digest("hex")

const makeLedgerRevision = ({
  snapshotTransactionId,
  snapshotVisibility,
  events,
  inputBlockers,
  custodyUnitMembership,
  principalAssetOverrideRevision,
  correctionInputs,
}: {
  readonly correctionInputs: ReadonlyArray<CalculationRunCorrectionInput>
  readonly snapshotTransactionId: string
  readonly snapshotVisibility: string
  readonly events: ReadonlyArray<AccountingEvent>
  readonly inputBlockers: ReadonlyArray<FactualLedgerInputBlocker>
  readonly custodyUnitMembership: ReadonlyArray<CustodyUnitMembership>
  readonly principalAssetOverrideRevision: ReadonlyArray<PrincipalAssetOverrideRevisionRecord>
}): InputLedgerRevision =>
  InputLedgerRevision.make(
    `v2:${snapshotTransactionId}:${snapshotVisibility}:${sha256("taxmaxi:factual-ledger:v2", {
      events: events.map(canonicalEvent),
      inputBlockers: inputBlockers
        .map(canonicalInputBlocker)
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      custodyUnitMembership: custodyUnitMembership.map(({ sourceId, custodyUnitId }) => [
        sourceId,
        custodyUnitId,
      ]),
      principalAssetOverrideRevision,
      correctionInputs,
    })}`
  )

const makeValuationRevision = (valuationFacts: ReadonlyArray<ValuationFact>): ValuationRevision =>
  ValuationRevision.make(
    `sha256:${sha256("taxmaxi:valuation-facts:v1", valuationFacts.map(canonicalValuationFact))}`
  )

const isConcurrentFactChange = (error: unknown): boolean => {
  const metadata = databaseErrorMetadata(error)
  return metadata?.code === "23503" && metadata.constraint === BLOCKER_PROVIDER_ASSET_FOREIGN_KEY
}

const make = Effect.gen(function* () {
  const db = yield* drizzle
  const calculationRunRepository = yield* CalculationRunRepository
  const factualLedgerRepository = yield* FactualLedgerRepository

  const loadSnapshot = (params: Parameters<CalculationRunServiceShape["recompute"]>[0]) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.execute(sql`set transaction isolation level repeatable read`)
          const snapshotTransactionRows = yield* tx
            .select({
              transactionId: sql<string>`pg_current_xact_id()::text`,
              visibility: sql<string>`replace(pg_current_snapshot()::text, ':', '.')`,
            })
            .from(schema.principals)
            .where(eq(schema.principals.id, params.principalId))
            .limit(1)
          const snapshotTransactionId = snapshotTransactionRows[0]?.transactionId
          const snapshotVisibility = snapshotTransactionRows[0]?.visibility

          if (snapshotTransactionId === undefined || snapshotVisibility === undefined) {
            return yield* new PersistenceError({
              operation: "calculationRunService.recompute.revision",
              cause: "PostgreSQL did not return a transaction sequence",
            })
          }

          const factualLedger = yield* factualLedgerRepository.load({
            principalId: params.principalId,
            reportingCurrency: params.reportingCurrency,
            occurredBefore: germanTaxYearEndExclusive(params.taxYear).toDate(),
          })
          const requests = yield* tx
            .select({ id: schema.calculationSyncRequests.id })
            .from(schema.calculationSyncRequests)
            .where(
              and(
                eq(schema.calculationSyncRequests.principalId, params.principalId),
                eq(schema.calculationSyncRequests.jurisdiction, params.jurisdiction),
                eq(schema.calculationSyncRequests.taxYear, params.taxYear),
                eq(schema.calculationSyncRequests.reportingCurrency, params.reportingCurrency)
              )
            )
          const syncCapture = {
            requestIds: requests.map(({ id }) => CalculationSyncRequestId.make(id)),
          }
          const inputLedgerRevision = makeLedgerRevision({
            snapshotTransactionId,
            snapshotVisibility,
            events: factualLedger.events,
            inputBlockers: factualLedger.inputBlockers,
            custodyUnitMembership: factualLedger.custodyUnitMembership,
            principalAssetOverrideRevision: factualLedger.principalAssetOverrideRevision,
            correctionInputs: factualLedger.correctionInputs,
          })
          const valuationRevision = makeValuationRevision(factualLedger.valuationFacts)
          return { factualLedger, inputLedgerRevision, valuationRevision, syncCapture }
        })
      )
      .pipe(
        Effect.mapError((error) =>
          Schema.is(CalculationRunAlreadyStoredError)(error) ||
          Schema.is(CalculationRunCurrencyMismatchError)(error) ||
          Schema.is(PersistenceError)(error) ||
          isTaxAccountingError(error)
            ? error
            : new PersistenceError({
                operation: "calculationRunService.loadSnapshot",
                cause: error,
              })
        )
      )

  const recompute: CalculationRunServiceShape["recompute"] = (params) =>
    Effect.gen(function* () {
      const snapshot = yield* loadSnapshot(params)

      yield* calculationRunRepository.start({
        id: params.id,
        principalId: params.principalId,
        jurisdiction: params.jurisdiction,
        taxYear: params.taxYear,
        reportingCurrency: params.reportingCurrency,
        engineVersion: ACCOUNTING_ENGINE_VERSION,
        ruleSetVersion: GERMAN_RULE_SET_VERSION,
        inputLedgerRevision: snapshot.inputLedgerRevision,
        valuationRevision: snapshot.valuationRevision,
        custodyUnitMembership: snapshot.factualLedger.custodyUnitMembership,
        correctionInputs: snapshot.factualLedger.correctionInputs,
        syncCapture: snapshot.syncCapture,
      })

      return yield* calculate({
        ledger: snapshot.factualLedger.events,
        jurisdiction: params.jurisdiction,
        taxYear: params.taxYear,
        accountingChoices: params.accountingChoices,
        valuationFacts: snapshot.factualLedger.valuationFacts,
      }).pipe(
        Effect.flatMap((result) => {
          const inputBlockers = snapshot.factualLedger.inputBlockers
          const combinedResult: CalculationRunResult =
            inputBlockers.length === 0
              ? result
              : {
                  ...result,
                  status: "partial",
                  blockers: [...inputBlockers, ...result.blockers],
                }

          return calculationRunRepository.persist({
            writeMode: "finalize_started",
            id: params.id,
            principalId: params.principalId,
            reportingCurrency: params.reportingCurrency,
            inputLedgerRevision: snapshot.inputLedgerRevision,
            valuationRevision: snapshot.valuationRevision,
            result: combinedResult,
            correctionInputs: snapshot.factualLedger.correctionInputs,
            syncCapture: snapshot.syncCapture,
          })
        }),
        Effect.onError((originalCause) =>
          calculationRunRepository
            .fail({
              id: params.id,
              principalId: params.principalId,
              failureCode: isConcurrentFactChange(originalCause)
                ? CALCULATION_STALE_RECOMPUTED_CODE
                : CALCULATION_FAILED_CODE,
            })
            .pipe(
              Effect.catchCause((settlementCause) =>
                Effect.logError(
                  {
                    runId: params.id,
                    principalId: params.principalId,
                    originalCause,
                    settlementCause,
                  },
                  "calculation-run-service:failure-settlement-failed"
                )
              )
            )
        )
      )
    }).pipe(
      Effect.mapError((error) =>
        Schema.is(CalculationRunAlreadyStoredError)(error) ||
        Schema.is(CalculationRunCurrencyMismatchError)(error) ||
        Schema.is(PersistenceError)(error) ||
        isTaxAccountingError(error)
          ? error
          : new PersistenceError({ operation: "calculationRunService.recompute", cause: error })
      )
    )

  return CalculationRunService.of({ recompute })
})

/** Live full-run orchestration over PostgreSQL and the pure accounting engine. */
export const CalculationRunServiceLive = Layer.effect(CalculationRunService, make)
