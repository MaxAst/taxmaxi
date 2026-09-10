/**
 * TransactionsApiLive - Canonical transaction list and detail handlers.
 *
 * @module TransactionsApiLive
 */

import { HttpApiBuilder } from "effect/unstable/httpapi"
import { JurisdictionCode } from "@my/core/accounting"
import { EUR } from "@my/core/currency"
import {
  TransactionDetailRepository,
  type TransactionDetailEvidence,
  TransactionListRepository,
} from "@my/persistence/services"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { toAssetOverrideResponse } from "./AssetOverridesApiLive.ts"
import { toTransactionOverrideResponse } from "./TransactionOverridesApiLive.ts"
import { InternalServerError } from "../definitions/ApiErrors.ts"
import { SourceNotFoundError } from "../definitions/SourcesApi.ts"
import { TaxMaxiApi } from "../definitions/TaxMaxiApi.ts"
import {
  TransactionBadRequestError,
  TransactionNotFoundError,
  TransactionDetailResponse,
  TransactionFilterChoicesResponse,
  TransactionListItem,
  TransactionListMovement,
  TransactionListPageInfo,
  TransactionListResponse,
  TransactionListSource,
} from "../definitions/TransactionsApi.ts"
import { PrincipalResolutionService } from "../services/PrincipalResolutionService.ts"

const defaultPageLimit = 25
const GERMAN_JURISDICTION = JurisdictionCode.make("DE")
const internalError = (message: string) =>
  new InternalServerError({ requestId: Option.none(), message })

const toEvidence = (evidence: TransactionDetailEvidence | null) =>
  evidence === null
    ? null
    : {
        ...evidence,
        occurredAt: evidence.occurredAt.toISOString(),
        importedAt: evidence.importedAt.toISOString(),
      }

/** Authenticated canonical list and selected-year detail reads. */
export const TransactionsApiLive = HttpApiBuilder.group(TaxMaxiApi, "transactions", (handlers) =>
  Effect.gen(function* () {
    const repository = yield* TransactionListRepository
    const detailRepository = yield* TransactionDetailRepository
    const principalResolutionService = yield* PrincipalResolutionService

    return handlers
      .handle("filterChoices", () =>
        Effect.gen(function* () {
          const { principal } = yield* principalResolutionService.resolveCurrentUserPrincipal.pipe(
            Effect.mapError(() => internalError("Failed to resolve the current user."))
          )
          const choices = yield* repository
            .filterChoices({
              principalId: principal.id,
              jurisdiction: GERMAN_JURISDICTION,
              reportingCurrency: EUR,
            })
            .pipe(
              Effect.mapError(() => internalError("Failed to load transaction filter choices."))
            )
          return TransactionFilterChoicesResponse.make(choices)
        })
      )
      .handle("getTransaction", ({ params, query }) =>
        Effect.gen(function* () {
          const { principal } = yield* principalResolutionService.resolveCurrentUserPrincipal.pipe(
            Effect.mapError(() => internalError("Failed to resolve the current user."))
          )
          const found = yield* detailRepository
            .find({
              principalId: principal.id,
              transactionId: params.transactionId,
              scope: {
                jurisdiction: GERMAN_JURISDICTION,
                reportingCurrency: EUR,
                taxYear: query.taxYear,
              },
            })
            .pipe(Effect.mapError(() => internalError("Failed to load transaction detail.")))
          if (Option.isNone(found))
            return yield* new TransactionNotFoundError({ code: "transaction_not_found" })
          const detail = found.value
          return TransactionDetailResponse.make({
            ...detail,
            timestamp: detail.timestamp.toISOString(),
            source: TransactionListSource.make(detail.source),
            sourceEvidence: detail.sourceEvidence.map((link) => ({
              ...link,
              evidence: toEvidence(link.evidence),
            })),
            movements: detail.movements.map((movement) => ({
              ...movement,
              timestamp: movement.timestamp.toISOString(),
              imported: {
                ...movement.imported,
                timestamp: movement.imported.timestamp.toISOString(),
              },
              evidence: toEvidence(movement.evidence),
            })),
            movementOverrides: yield* Effect.forEach(
              detail.movementOverrides,
              toTransactionOverrideResponse
            ),
            assetOverrides: detail.assetOverrides.map((entry) => ({
              ...entry,
              projection:
                entry.projection === null ? null : toAssetOverrideResponse(entry.projection),
            })),
            calculation: {
              ...detail.calculation,
              derivedLots: detail.calculation.derivedLots.map((lot) => ({
                ...lot,
                acquiredAt: lot.acquiredAt.toISOString(),
              })),
              allocations: detail.calculation.allocations.map((allocation) => ({
                ...allocation,
                acquiredAt: allocation.acquiredAt.toISOString(),
                disposedAt: allocation.disposedAt.toISOString(),
              })),
              income: detail.calculation.income.map((income) => ({
                ...income,
                occurredAt: income.occurredAt.toISOString(),
              })),
            },
          })
        })
      )
      .handle("listTransactions", ({ query }) =>
        Effect.gen(function* () {
          if (query.sourceId !== undefined && query.sourceIds !== undefined) {
            return yield* new TransactionBadRequestError({
              message: "Specify sourceId or sourceIds, not both.",
            })
          }
          if (query.from !== undefined && query.to !== undefined && query.from >= query.to) {
            return yield* new TransactionBadRequestError({
              message: "The date interval must have from before to.",
            })
          }
          const { principal } = yield* principalResolutionService.resolveCurrentUserPrincipal.pipe(
            Effect.mapError(() => internalError("Failed to resolve the current user."))
          )
          const page = yield* repository
            .list({
              principalId: principal.id,
              jurisdiction: GERMAN_JURISDICTION,
              reportingCurrency: EUR,
              sourceIds: query.sourceIds ?? (query.sourceId === undefined ? [] : [query.sourceId]),
              assetIds: query.assetIds ?? [],
              categories: query.categories ?? [],
              from: query.from ?? null,
              to: query.to ?? null,
              order: query.order ?? "newest",
              attention: query.attention ?? false,
              cursor: query.cursor ?? null,
              limit: query.limit ?? defaultPageLimit,
            })
            .pipe(
              Effect.mapError((error) =>
                error._tag === "TransactionListInvalidCursorError"
                  ? new TransactionBadRequestError({ message: error.message })
                  : error._tag === "TransactionListSourceNotFoundError"
                    ? new SourceNotFoundError({ message: error.message })
                    : internalError("Failed to load transactions.")
              )
            )

          return TransactionListResponse.make({
            transactions: page.items.map((item) =>
              TransactionListItem.make({
                ...item,
                source: TransactionListSource.make(item.source),
                // The repository projects display fields and captured values from the same run.
                movements: item.movements.map((movement) => TransactionListMovement.make(movement)),
              })
            ),
            page: TransactionListPageInfo.make({
              nextCursor: page.nextCursor,
              hasMore: page.hasMore,
            }),
            totalCount: page.totalCount,
          })
        })
      )
  })
)
