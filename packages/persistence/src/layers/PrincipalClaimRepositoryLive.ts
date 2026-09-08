/**
 * PrincipalClaimRepositoryLive - Postgres-backed ownership claim repository.
 *
 * @module PrincipalClaimRepositoryLive
 */

import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm"
import * as DateTime from "effect/DateTime"
import { PrincipalId } from "@my/core/ownership"
import type { ChainType } from "@my/core/source"
import { SourceId } from "@my/core/source"
import { getSourceSyncProgressPercent } from "@my/sync-engine/services"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { PersistenceError, wrapSqlError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import type { PrincipalClaimRow } from "../schema/PrincipalClaimsTable.ts"
import {
  PrincipalClaimRepository,
  type PrincipalClaim,
  PrincipalClaimTransferConflictError,
  type PrincipalClaimTransferError,
  PrincipalClaimTransferStaleError,
  isPrincipalClaimTransferConflictError,
  isPrincipalClaimTransferStaleError,
  type PrincipalClaimRepositoryService,
} from "../services/PrincipalClaimRepository.ts"
import { drizzle } from "./PgClientLive.ts"

const GERMAN_TIME_ZONE = "Europe/Berlin"

const selectPrincipalClaimFields = {
  id: schema.principalClaims.id,
  principalId: schema.principalClaims.principalId,
  sourceId: schema.principalClaims.sourceId,
  requestId: schema.principalClaims.requestId,
  claimType: schema.principalClaims.claimType,
  claimValueHash: schema.principalClaims.claimValueHash,
  chainType: schema.principalClaims.chainType,
  walletAddress: schema.principalClaims.walletAddress,
  payerChainType: schema.principalClaims.payerChainType,
  payerWalletAddress: schema.principalClaims.payerWalletAddress,
  year: schema.principalClaims.year,
  jurisdiction: schema.principalClaims.jurisdiction,
  expiresAt: schema.principalClaims.expiresAt,
  consumedAt: schema.principalClaims.consumedAt,
} as const

type SelectedPrincipalClaimRow = Pick<
  PrincipalClaimRow,
  | "id"
  | "principalId"
  | "sourceId"
  | "requestId"
  | "claimType"
  | "claimValueHash"
  | "chainType"
  | "walletAddress"
  | "payerChainType"
  | "payerWalletAddress"
  | "year"
  | "jurisdiction"
  | "expiresAt"
  | "consumedAt"
>

const rowToPrincipalClaim = (row: SelectedPrincipalClaimRow): Effect.Effect<PrincipalClaim> =>
  Effect.gen(function* () {
    const chainType: ChainType | null =
      row.chainType === null
        ? null
        : row.chainType === "evm" || row.chainType === "solana" || row.chainType === "bitcoin"
          ? row.chainType
          : yield* Effect.die(`Invalid principal claim chain type: ${row.chainType}`)
    const payerChainType: ChainType | null =
      row.payerChainType === null
        ? null
        : row.payerChainType === "evm" ||
            row.payerChainType === "solana" ||
            row.payerChainType === "bitcoin"
          ? row.payerChainType
          : yield* Effect.die(`Invalid principal claim payer chain type: ${row.payerChainType}`)
    return {
      id: row.id,
      principalId: PrincipalId.make(row.principalId),
      sourceId: row.sourceId === null ? null : SourceId.make(row.sourceId),
      requestId: row.requestId,
      claimType: row.claimType,
      claimValueHash: row.claimValueHash,
      chainType,
      walletAddress: row.walletAddress,
      payerChainType,
      payerWalletAddress: row.payerWalletAddress,
      year: row.year,
      jurisdiction: row.jurisdiction,
      expiresAt: row.expiresAt,
      consumedAt: row.consumedAt,
    }
  })

const isPrincipalClaimTransferError = (error: unknown): error is PrincipalClaimTransferError =>
  isPrincipalClaimTransferConflictError(error) || isPrincipalClaimTransferStaleError(error)

const SourceSyncJobProgressSnapshot = Schema.Struct({
  phase: Schema.optional(
    Schema.Literals(["discovering", "classifying", "reconciling", "completed"])
  ),
  processedRecords: Schema.optional(Schema.Finite),
  totalRecords: Schema.optional(Schema.NullOr(Schema.Finite)),
  fetchedRecords: Schema.optional(Schema.Finite),
  normalizedRecords: Schema.optional(Schema.Finite),
  failedRecords: Schema.optional(Schema.Finite),
})

const toPublicJobStatus = (
  status: "pending" | "processing" | "completed" | "failed" | "credit_required"
) => {
  switch (status) {
    case "pending":
      return "queued" as const
    case "processing":
      return "running" as const
    case "completed":
    case "failed":
      return status
    // Anonymous x402-paid sources are exempt from credit checks, so a credit-required
    // job here would be unexpected. Treat it like a failure for this claim-visible view.
    case "credit_required":
      return "failed" as const
  }
}

const decodeProgress = (progressDetails: unknown) =>
  progressDetails === null
    ? Effect.succeed(null)
    : Schema.decodeUnknownEffect(SourceSyncJobProgressSnapshot)(progressDetails).pipe(
        Effect.map((progress) => ({
          phase: progress.phase ?? null,
          processedRecords: progress.processedRecords ?? null,
          totalRecords: progress.totalRecords ?? null,
          fetchedRecords: progress.fetchedRecords ?? null,
          normalizedRecords: progress.normalizedRecords ?? null,
          failedRecords: progress.failedRecords ?? null,
        })),
        Effect.orElseSucceed(() => ({
          phase: null,
          processedRecords: null,
          totalRecords: null,
          fetchedRecords: null,
          normalizedRecords: null,
          failedRecords: null,
        }))
      )

const findPrincipalClaimTransferError = (error: unknown): PrincipalClaimTransferError | null => {
  if (isPrincipalClaimTransferError(error)) {
    return error
  }

  if (typeof error !== "object" || error === null || !("cause" in error)) {
    return null
  }

  return findPrincipalClaimTransferError(error.cause)
}

const wrapClaimTransferSqlError =
  (operation: string) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, PersistenceError | PrincipalClaimTransferError, R> =>
    Effect.mapError(effect, (cause) => {
      const transferError = findPrincipalClaimTransferError(cause)
      return transferError ?? new PersistenceError({ operation, cause })
    })

const make = Effect.gen(function* () {
  const db = yield* drizzle
  type ClaimTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

  // Claims retain accepted work, but anonymous attempts cannot certify the new owner.
  const takeClaimCalculationRequests = ({
    executor,
    sourceId,
    principalId,
  }: {
    readonly executor: ClaimTransaction
    readonly sourceId: SourceId
    readonly principalId: PrincipalId
  }) =>
    executor
      .delete(schema.calculationSyncRequests)
      .where(
        and(
          eq(schema.calculationSyncRequests.sourceId, sourceId),
          eq(schema.calculationSyncRequests.principalId, principalId)
        )
      )
      .returning({
        id: schema.calculationSyncRequests.id,
        sourceId: schema.calculationSyncRequests.sourceId,
        sourceJobId: schema.calculationSyncRequests.sourceJobId,
        jurisdiction: schema.calculationSyncRequests.jurisdiction,
        taxYear: schema.calculationSyncRequests.taxYear,
        reportingCurrency: schema.calculationSyncRequests.reportingCurrency,
        requestedAt: schema.calculationSyncRequests.requestedAt,
      })

  const fenceAndDeleteAnonymousCalculationRuns = ({
    executor,
    principalId,
    updatedAt,
  }: {
    readonly executor: ClaimTransaction
    readonly principalId: PrincipalId
    readonly updatedAt: Date
  }) =>
    Effect.gen(function* () {
      const taxYear = yield* DateTime.now.pipe(
        Effect.map(DateTime.setZoneNamedUnsafe(GERMAN_TIME_ZONE)),
        Effect.map(DateTime.toParts),
        Effect.map(({ year }) => year)
      )

      // Only recorded attempts identify other work invalidated by these deleted runs.
      const requestsOnDeletedRuns = executor
        .select({ requestId: schema.calculationSyncAttempts.requestId })
        .from(schema.calculationSyncAttempts)
        .innerJoin(
          schema.calculationRuns,
          eq(schema.calculationSyncAttempts.runId, schema.calculationRuns.id)
        )
        .where(eq(schema.calculationRuns.principalId, principalId))

      yield* executor
        .update(schema.calculationSyncRequests)
        .set({ status: "queued" })
        .where(inArray(schema.calculationSyncRequests.id, requestsOnDeletedRuns))

      yield* executor
        .delete(schema.calculationRuns)
        .where(eq(schema.calculationRuns.principalId, principalId))

      yield* executor
        .insert(schema.activeCalculationRuns)
        .values({
          principalId,
          jurisdiction: "DE",
          taxYear,
          reportingCurrency: "EUR",
          runId: null,
          minimumActivationRevision: sql`pg_current_xact_id()::text::numeric`,
          updatedAt,
        })
        .onConflictDoUpdate({
          target: [
            schema.activeCalculationRuns.principalId,
            schema.activeCalculationRuns.jurisdiction,
            schema.activeCalculationRuns.taxYear,
            schema.activeCalculationRuns.reportingCurrency,
          ],
          set: {
            runId: null,
            minimumActivationRevision: sql`pg_current_xact_id()::text::numeric`,
            updatedAt,
          },
        })
    })

  const create: PrincipalClaimRepositoryService["create"] = (params) =>
    Effect.gen(function* () {
      const now = yield* DateTime.nowAsDate
      const [row] = yield* db
        .insert(schema.principalClaims)
        .values({
          principalId: params.principalId,
          sourceId: params.sourceId,
          requestId: params.requestId,
          claimType: params.claimType,
          claimValueHash: params.claimValueHash,
          chainType: params.chainType,
          walletAddress: params.walletAddress,
          payerChainType: params.payerChainType,
          payerWalletAddress: params.payerWalletAddress,
          year: params.year,
          jurisdiction: params.jurisdiction,
          expiresAt: params.expiresAt,
          consumedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning(selectPrincipalClaimFields)

      if (row === undefined) {
        return yield* new PersistenceError({
          operation: "principalClaimRepository.create",
          cause: "failed to create principal claim",
        })
      }

      return yield* rowToPrincipalClaim(row)
    }).pipe(wrapSqlError("principalClaimRepository.create"))

  const findValidCliSourceClaim: PrincipalClaimRepositoryService["findValidCliSourceClaim"] = (
    params
  ) =>
    Effect.gen(function* () {
      const now = yield* DateTime.nowAsDate
      const [row] = yield* db
        .select(selectPrincipalClaimFields)
        .from(schema.principalClaims)
        .innerJoin(schema.principals, eq(schema.principals.id, schema.principalClaims.principalId))
        .innerJoin(schema.sources, eq(schema.sources.id, schema.principalClaims.sourceId))
        .innerJoin(schema.addresses, eq(schema.addresses.id, schema.sources.addressId))
        .where(
          and(
            eq(schema.principalClaims.requestId, params.requestId),
            eq(schema.principalClaims.claimType, "cli_claim_token"),
            eq(schema.principalClaims.claimValueHash, params.claimValueHash),
            isNull(schema.principalClaims.consumedAt),
            or(isNull(schema.principalClaims.expiresAt), gt(schema.principalClaims.expiresAt, now)),
            eq(schema.principals.kind, "anonymous_wallet"),
            eq(schema.sources.principalId, schema.principalClaims.principalId),
            eq(schema.addresses.principalId, schema.principalClaims.principalId),
            eq(schema.sources.sourceableType, "onchain"),
            sql`${schema.addresses.type}::text = ${schema.principalClaims.chainType}`,
            eq(schema.addresses.address, schema.principalClaims.walletAddress)
          )
        )
        .limit(1)

      if (row === undefined) {
        return Option.none<PrincipalClaim>()
      }

      if (
        row.sourceId === null ||
        row.chainType === null ||
        row.walletAddress === null ||
        row.year === null ||
        row.jurisdiction === null
      ) {
        return Option.none<PrincipalClaim>()
      }

      const [receiptRow] = yield* db
        .select({ id: schema.principalClaims.id })
        .from(schema.principalClaims)
        .where(
          and(
            eq(schema.principalClaims.requestId, row.requestId),
            eq(schema.principalClaims.claimType, "x402_receipt"),
            eq(schema.principalClaims.principalId, row.principalId),
            eq(schema.principalClaims.sourceId, row.sourceId),
            eq(schema.principalClaims.chainType, row.chainType),
            eq(schema.principalClaims.walletAddress, row.walletAddress),
            eq(schema.principalClaims.year, row.year),
            eq(schema.principalClaims.jurisdiction, row.jurisdiction),
            isNull(schema.principalClaims.consumedAt)
          )
        )
        .limit(1)

      if (receiptRow === undefined) {
        return Option.none<PrincipalClaim>()
      }

      const claim = yield* rowToPrincipalClaim(row)
      return Option.some(claim)
    }).pipe(wrapSqlError("principalClaimRepository.findValidCliSourceClaim"))

  const hasConsumedX402ReceiptForSource: PrincipalClaimRepositoryService["hasConsumedX402ReceiptForSource"] =
    (sourceId) =>
      Effect.gen(function* () {
        const [row] = yield* db
          .select({ id: schema.principalClaims.id })
          .from(schema.principalClaims)
          .where(
            and(
              eq(schema.principalClaims.sourceId, sourceId),
              eq(schema.principalClaims.claimType, "x402_receipt"),
              isNotNull(schema.principalClaims.consumedAt)
            )
          )
          .limit(1)

        return row !== undefined
      }).pipe(wrapSqlError("principalClaimRepository.hasConsumedX402ReceiptForSource"))

  const findAnonymousSourceEntitlementsByPayer: PrincipalClaimRepositoryService["findAnonymousSourceEntitlementsByPayer"] =
    (params) =>
      Effect.gen(function* () {
        const rows = yield* db
          .select({
            principalId: schema.principalClaims.principalId,
            sourceId: schema.principalClaims.sourceId,
            requestId: schema.principalClaims.requestId,
            chainType: schema.principalClaims.chainType,
            walletAddress: schema.principalClaims.walletAddress,
            year: schema.principalClaims.year,
            jurisdiction: schema.principalClaims.jurisdiction,
          })
          .from(schema.principalClaims)
          .innerJoin(
            schema.principals,
            eq(schema.principals.id, schema.principalClaims.principalId)
          )
          .innerJoin(schema.sources, eq(schema.sources.id, schema.principalClaims.sourceId))
          .innerJoin(schema.addresses, eq(schema.addresses.id, schema.sources.addressId))
          .where(
            and(
              eq(schema.principalClaims.claimType, "x402_receipt"),
              eq(schema.principalClaims.payerChainType, params.payerChainType),
              eq(schema.principalClaims.payerWalletAddress, params.payerWalletAddress),
              isNull(schema.principalClaims.consumedAt),
              eq(schema.principals.kind, "anonymous_wallet"),
              eq(schema.sources.principalId, schema.principalClaims.principalId),
              eq(schema.addresses.principalId, schema.principalClaims.principalId),
              eq(schema.sources.sourceableType, "onchain"),
              sql`${schema.addresses.type}::text = ${schema.principalClaims.chainType}`,
              eq(schema.addresses.address, schema.principalClaims.walletAddress)
            )
          )
          .orderBy(desc(schema.principalClaims.createdAt))

        return yield* Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            if (
              row.sourceId === null ||
              row.chainType === null ||
              row.walletAddress === null ||
              row.year === null ||
              row.jurisdiction === null
            ) {
              return yield* Effect.die("Invalid payer entitlement claim context.")
            }

            const chainType: ChainType =
              row.chainType === "evm" || row.chainType === "solana" || row.chainType === "bitcoin"
                ? row.chainType
                : yield* Effect.die(`Invalid entitlement chain type: ${row.chainType}`)

            return {
              principalId: PrincipalId.make(row.principalId),
              sourceId: SourceId.make(row.sourceId),
              requestId: row.requestId,
              chainType,
              walletAddress: row.walletAddress,
              year: row.year,
              jurisdiction: row.jurisdiction,
            }
          })
        )
      }).pipe(wrapSqlError("principalClaimRepository.findAnonymousSourceEntitlementsByPayer"))

  const findAnonymousSourceEntitlementByPayer: PrincipalClaimRepositoryService["findAnonymousSourceEntitlementByPayer"] =
    (params) =>
      findAnonymousSourceEntitlementsByPayer(params).pipe(
        Effect.map((entitlements) =>
          Option.fromNullishOr(entitlements.find((source) => source.sourceId === params.sourceId))
        )
      )

  const listAnonymousSourceSyncJobsByPayer: PrincipalClaimRepositoryService["listAnonymousSourceSyncJobsByPayer"] =
    (params) =>
      Effect.gen(function* () {
        const maybeEntitlement = yield* findAnonymousSourceEntitlementByPayer(params)
        if (Option.isNone(maybeEntitlement)) {
          return []
        }

        const entitlement = maybeEntitlement.value
        const rows = yield* db
          .select({
            id: schema.processingJobs.id,
            sourceId: schema.processingJobs.sourceId,
            status: schema.processingJobs.status,
            progressDetails: schema.processingJobs.progressDetails,
            errorMessage: schema.processingJobs.errorMessage,
          })
          .from(schema.processingJobs)
          .where(
            and(
              eq(schema.processingJobs.principalId, entitlement.principalId),
              eq(schema.processingJobs.sourceId, entitlement.sourceId)
            )
          )
          .orderBy(desc(schema.processingJobs.createdAt))

        return yield* Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            const progress = yield* decodeProgress(row.progressDetails)
            const phase = progress?.phase ?? null
            const processedRecords = progress?.processedRecords ?? null
            const totalRecords = progress?.totalRecords ?? null
            return {
              sourceId: SourceId.make(row.sourceId),
              jobId: row.id,
              status: toPublicJobStatus(row.status),
              phase,
              processedRecords,
              totalRecords,
              progressPercent: getSourceSyncProgressPercent({
                phase,
                processedRecords,
                totalRecords,
              }),
              fetchedRecords: progress?.fetchedRecords ?? null,
              normalizedRecords: progress?.normalizedRecords ?? null,
              failedRecords: progress?.failedRecords ?? null,
              message: row.errorMessage,
            }
          })
        )
      }).pipe(wrapSqlError("principalClaimRepository.listAnonymousSourceSyncJobsByPayer"))

  const findAnonymousSourceSyncJobByPayer: PrincipalClaimRepositoryService["findAnonymousSourceSyncJobByPayer"] =
    (params) =>
      listAnonymousSourceSyncJobsByPayer(params).pipe(
        Effect.map((jobs) => Option.fromNullishOr(jobs.find((job) => job.jobId === params.jobId)))
      )

  const findValidSiwxSourceClaim: PrincipalClaimRepositoryService["findValidSiwxSourceClaim"] = (
    params
  ) =>
    Effect.gen(function* () {
      const [row] = yield* db
        .select(selectPrincipalClaimFields)
        .from(schema.principalClaims)
        .innerJoin(schema.principals, eq(schema.principals.id, schema.principalClaims.principalId))
        .innerJoin(schema.sources, eq(schema.sources.id, schema.principalClaims.sourceId))
        .innerJoin(schema.addresses, eq(schema.addresses.id, schema.sources.addressId))
        .where(
          and(
            eq(schema.principalClaims.requestId, params.requestId),
            eq(schema.principalClaims.claimType, "x402_receipt"),
            eq(schema.principalClaims.payerChainType, params.payerChainType),
            eq(schema.principalClaims.payerWalletAddress, params.payerWalletAddress),
            isNull(schema.principalClaims.consumedAt),
            eq(schema.principals.kind, "anonymous_wallet"),
            eq(schema.sources.principalId, schema.principalClaims.principalId),
            eq(schema.addresses.principalId, schema.principalClaims.principalId),
            eq(schema.sources.sourceableType, "onchain"),
            sql`${schema.addresses.type}::text = ${schema.principalClaims.chainType}`,
            eq(schema.addresses.address, schema.principalClaims.walletAddress)
          )
        )
        .limit(1)

      if (
        row === undefined ||
        row.sourceId === null ||
        row.chainType === null ||
        row.walletAddress === null ||
        row.year === null ||
        row.jurisdiction === null
      ) {
        return Option.none<PrincipalClaim>()
      }

      const claim = yield* rowToPrincipalClaim(row)
      return Option.some(claim)
    }).pipe(wrapSqlError("principalClaimRepository.findValidSiwxSourceClaim"))

  const claimAnonymousSourceForUser: PrincipalClaimRepositoryService["claimAnonymousSourceForUser"] =
    (params) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const now = yield* DateTime.nowAsDate
            yield* tx
              .select({ id: schema.sources.id })
              .from(schema.sources)
              .where(eq(schema.sources.id, params.sourceId))
              .for("update")
              .pipe(wrapSqlError("principalClaimRepository.claimAnonymousSourceForUser.lockSource"))

            yield* tx
              .select({ id: schema.principals.id })
              .from(schema.principals)
              .where(
                or(
                  eq(schema.principals.id, params.anonymousPrincipalId),
                  eq(schema.principals.id, params.userPrincipalId)
                )
              )
              .orderBy(asc(schema.principals.id))
              .for("update")
              .pipe(
                wrapSqlError("principalClaimRepository.claimAnonymousSourceForUser.lockInventory")
              )

            const [claimRow] = yield* tx
              .select({
                ...selectPrincipalClaimFields,
                addressId: schema.addresses.id,
              })
              .from(schema.principalClaims)
              .innerJoin(
                schema.principals,
                eq(schema.principals.id, schema.principalClaims.principalId)
              )
              .innerJoin(schema.sources, eq(schema.sources.id, schema.principalClaims.sourceId))
              .innerJoin(schema.addresses, eq(schema.addresses.id, schema.sources.addressId))
              .where(
                and(
                  eq(schema.principalClaims.requestId, params.requestId),
                  eq(schema.principalClaims.claimType, "cli_claim_token"),
                  eq(schema.principalClaims.claimValueHash, params.claimValueHash),
                  eq(schema.principalClaims.principalId, params.anonymousPrincipalId),
                  eq(schema.principalClaims.sourceId, params.sourceId),
                  isNull(schema.principalClaims.consumedAt),
                  or(
                    isNull(schema.principalClaims.expiresAt),
                    gt(schema.principalClaims.expiresAt, now)
                  ),
                  eq(schema.principals.kind, "anonymous_wallet"),
                  eq(schema.sources.id, params.sourceId),
                  eq(schema.sources.principalId, params.anonymousPrincipalId),
                  eq(schema.sources.sourceableType, "onchain"),
                  eq(schema.addresses.principalId, params.anonymousPrincipalId),
                  sql`${schema.addresses.type}::text = ${schema.principalClaims.chainType}`,
                  eq(schema.addresses.address, schema.principalClaims.walletAddress)
                )
              )
              .limit(1)

            if (
              claimRow === undefined ||
              claimRow.sourceId === null ||
              claimRow.chainType === null ||
              claimRow.walletAddress === null ||
              claimRow.year === null ||
              claimRow.jurisdiction === null
            ) {
              return yield* new PrincipalClaimTransferStaleError({
                message: "Valid claim token not found.",
              })
            }

            const [receiptRow] = yield* tx
              .select({ id: schema.principalClaims.id })
              .from(schema.principalClaims)
              .where(
                and(
                  eq(schema.principalClaims.requestId, claimRow.requestId),
                  eq(schema.principalClaims.claimType, "x402_receipt"),
                  eq(schema.principalClaims.principalId, claimRow.principalId),
                  eq(schema.principalClaims.sourceId, claimRow.sourceId),
                  eq(schema.principalClaims.chainType, claimRow.chainType),
                  eq(schema.principalClaims.walletAddress, claimRow.walletAddress),
                  eq(schema.principalClaims.year, claimRow.year),
                  eq(schema.principalClaims.jurisdiction, claimRow.jurisdiction),
                  isNull(schema.principalClaims.consumedAt)
                )
              )
              .limit(1)

            if (receiptRow === undefined) {
              return yield* new PrincipalClaimTransferStaleError({
                message: "Matching receipt claim not found.",
              })
            }

            const [targetAddressRow] = yield* tx
              .select({ id: schema.addresses.id })
              .from(schema.addresses)
              .where(
                and(
                  eq(schema.addresses.principalId, params.userPrincipalId),
                  eq(schema.addresses.address, claimRow.walletAddress)
                )
              )
              .limit(1)

            if (targetAddressRow !== undefined) {
              // Merging a paid anonymous source into an existing user-owned wallet source is
              // intentionally deferred until normalized and tax artifact collisions have a
              // complete idempotency design. Keep the claim reusable by leaving it unconsumed.
              return yield* new PrincipalClaimTransferConflictError({
                message: "Target principal already owns the claimed wallet address.",
              })
            }

            const transferredRequests = yield* takeClaimCalculationRequests({
              executor: tx,
              sourceId: params.sourceId,
              principalId: params.anonymousPrincipalId,
            })

            const movedSources = yield* tx
              .update(schema.sources)
              .set({ principalId: params.userPrincipalId, updatedAt: now })
              .where(
                and(
                  eq(schema.sources.id, params.sourceId),
                  eq(schema.sources.principalId, params.anonymousPrincipalId)
                )
              )
              .returning({ id: schema.sources.id })

            if (movedSources.length !== 1) {
              return yield* new PrincipalClaimTransferStaleError({
                message: "Claimed source was not moved.",
              })
            }

            const movedAddresses = yield* tx
              .update(schema.addresses)
              .set({ principalId: params.userPrincipalId, updatedAt: now })
              .where(
                and(
                  eq(schema.addresses.id, claimRow.addressId),
                  eq(schema.addresses.principalId, params.anonymousPrincipalId)
                )
              )
              .returning({ id: schema.addresses.id })

            if (movedAddresses.length !== 1) {
              return yield* new PrincipalClaimTransferStaleError({
                message: "Claimed address was not moved.",
              })
            }

            yield* tx
              .update(schema.cexAccount)
              .set({ principalId: params.userPrincipalId, updatedAt: now })
              .where(eq(schema.cexAccount.principalId, params.anonymousPrincipalId))

            yield* tx
              .update(schema.transactions)
              .set({ principalId: params.userPrincipalId, updatedAt: now })
              .where(
                and(
                  eq(schema.transactions.sourceId, params.sourceId),
                  eq(schema.transactions.principalId, params.anonymousPrincipalId)
                )
              )

            yield* tx
              .update(schema.transfers)
              .set({ principalId: params.userPrincipalId, updatedAt: now })
              .where(
                and(
                  eq(schema.transfers.sourceId, params.sourceId),
                  eq(schema.transfers.principalId, params.anonymousPrincipalId)
                )
              )

            yield* tx
              .update(schema.transactionLegs)
              .set({ principalId: params.userPrincipalId, updatedAt: now })
              .where(
                and(
                  eq(schema.transactionLegs.sourceId, params.sourceId),
                  eq(schema.transactionLegs.principalId, params.anonymousPrincipalId)
                )
              )

            yield* tx
              .update(schema.inventoryMovements)
              .set({ principalId: params.userPrincipalId, updatedAt: now })
              .where(
                and(
                  eq(schema.inventoryMovements.sourceId, params.sourceId),
                  eq(schema.inventoryMovements.principalId, params.anonymousPrincipalId)
                )
              )

            yield* tx
              .update(schema.processingJobs)
              .set({ principalId: params.userPrincipalId, updatedAt: now })
              .where(
                and(
                  eq(schema.processingJobs.sourceId, params.sourceId),
                  eq(schema.processingJobs.principalId, params.anonymousPrincipalId)
                )
              )

            yield* tx
              .update(schema.syncRuns)
              .set({ principalId: params.userPrincipalId, updatedAt: now })
              .where(eq(schema.syncRuns.principalId, params.anonymousPrincipalId))

            yield* tx
              .update(schema.transactionReviews)
              .set({ principalId: params.userPrincipalId, updatedAt: now })
              .where(eq(schema.transactionReviews.principalId, params.anonymousPrincipalId))

            yield* tx
              .update(schema.transferReconciliations)
              .set({ principalId: params.userPrincipalId, updatedAt: now })
              .where(eq(schema.transferReconciliations.principalId, params.anonymousPrincipalId))

            const consumedClaims = yield* tx
              .update(schema.principalClaims)
              .set({ consumedAt: now, updatedAt: now })
              .where(
                and(
                  eq(schema.principalClaims.requestId, params.requestId),
                  eq(schema.principalClaims.principalId, params.anonymousPrincipalId),
                  isNull(schema.principalClaims.consumedAt)
                )
              )
              .returning({ id: schema.principalClaims.id })

            if (consumedClaims.length < 2) {
              return yield* new PrincipalClaimTransferStaleError({
                message: "Request claims were not consumed.",
              })
            }

            if (transferredRequests.length > 0) {
              yield* tx.insert(schema.calculationSyncRequests).values(
                transferredRequests.map((request) => ({
                  ...request,
                  principalId: params.userPrincipalId,
                  status: "queued" as const,
                }))
              )
            }

            yield* fenceAndDeleteAnonymousCalculationRuns({
              executor: tx,
              principalId: params.anonymousPrincipalId,
              updatedAt: now,
            })

            return params.sourceId
          })
        )
        .pipe(wrapClaimTransferSqlError("principalClaimRepository.claimAnonymousSourceForUser"))

  const claimAnonymousSourceForUserByPayer: PrincipalClaimRepositoryService["claimAnonymousSourceForUserByPayer"] =
    (params) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const now = yield* DateTime.nowAsDate
            yield* tx
              .select({ id: schema.sources.id })
              .from(schema.sources)
              .where(eq(schema.sources.id, params.sourceId))
              .for("update")
              .pipe(
                wrapSqlError(
                  "principalClaimRepository.claimAnonymousSourceForUserByPayer.lockSource"
                )
              )

            yield* tx
              .select({ id: schema.principals.id })
              .from(schema.principals)
              .where(
                or(
                  eq(schema.principals.id, params.anonymousPrincipalId),
                  eq(schema.principals.id, params.userPrincipalId)
                )
              )
              .orderBy(asc(schema.principals.id))
              .for("update")
              .pipe(
                wrapSqlError(
                  "principalClaimRepository.claimAnonymousSourceForUserByPayer.lockInventory"
                )
              )

            const [claimRow] = yield* tx
              .select({
                ...selectPrincipalClaimFields,
                addressId: schema.addresses.id,
              })
              .from(schema.principalClaims)
              .innerJoin(
                schema.principals,
                eq(schema.principals.id, schema.principalClaims.principalId)
              )
              .innerJoin(schema.sources, eq(schema.sources.id, schema.principalClaims.sourceId))
              .innerJoin(schema.addresses, eq(schema.addresses.id, schema.sources.addressId))
              .where(
                and(
                  eq(schema.principalClaims.requestId, params.requestId),
                  eq(schema.principalClaims.claimType, "x402_receipt"),
                  eq(schema.principalClaims.payerChainType, params.payerChainType),
                  eq(schema.principalClaims.payerWalletAddress, params.payerWalletAddress),
                  eq(schema.principalClaims.principalId, params.anonymousPrincipalId),
                  eq(schema.principalClaims.sourceId, params.sourceId),
                  isNull(schema.principalClaims.consumedAt),
                  eq(schema.principals.kind, "anonymous_wallet"),
                  eq(schema.sources.id, params.sourceId),
                  eq(schema.sources.principalId, params.anonymousPrincipalId),
                  eq(schema.sources.sourceableType, "onchain"),
                  eq(schema.addresses.principalId, params.anonymousPrincipalId),
                  sql`${schema.addresses.type}::text = ${schema.principalClaims.chainType}`,
                  eq(schema.addresses.address, schema.principalClaims.walletAddress)
                )
              )
              .limit(1)

            if (
              claimRow === undefined ||
              claimRow.sourceId === null ||
              claimRow.chainType === null ||
              claimRow.walletAddress === null ||
              claimRow.year === null ||
              claimRow.jurisdiction === null
            ) {
              return yield* new PrincipalClaimTransferStaleError({
                message: "Valid payer entitlement not found.",
              })
            }

            const [targetAddressRow] = yield* tx
              .select({ id: schema.addresses.id })
              .from(schema.addresses)
              .where(
                and(
                  eq(schema.addresses.principalId, params.userPrincipalId),
                  eq(schema.addresses.address, claimRow.walletAddress)
                )
              )
              .limit(1)

            if (targetAddressRow !== undefined) {
              return yield* new PrincipalClaimTransferConflictError({
                message: "Target principal already owns the claimed wallet address.",
              })
            }

            const transferredRequests = yield* takeClaimCalculationRequests({
              executor: tx,
              sourceId: params.sourceId,
              principalId: params.anonymousPrincipalId,
            })

            const movedSources = yield* tx
              .update(schema.sources)
              .set({ principalId: params.userPrincipalId, updatedAt: now })
              .where(
                and(
                  eq(schema.sources.id, params.sourceId),
                  eq(schema.sources.principalId, params.anonymousPrincipalId)
                )
              )
              .returning({ id: schema.sources.id })

            if (movedSources.length !== 1) {
              return yield* new PrincipalClaimTransferStaleError({
                message: "Claimed source was not moved.",
              })
            }

            const movedAddresses = yield* tx
              .update(schema.addresses)
              .set({ principalId: params.userPrincipalId, updatedAt: now })
              .where(
                and(
                  eq(schema.addresses.id, claimRow.addressId),
                  eq(schema.addresses.principalId, params.anonymousPrincipalId)
                )
              )
              .returning({ id: schema.addresses.id })

            if (movedAddresses.length !== 1) {
              return yield* new PrincipalClaimTransferStaleError({
                message: "Claimed address was not moved.",
              })
            }

            yield* tx
              .update(schema.cexAccount)
              .set({ principalId: params.userPrincipalId, updatedAt: now })
              .where(eq(schema.cexAccount.principalId, params.anonymousPrincipalId))

            yield* tx
              .update(schema.transactions)
              .set({ principalId: params.userPrincipalId, updatedAt: now })
              .where(
                and(
                  eq(schema.transactions.sourceId, params.sourceId),
                  eq(schema.transactions.principalId, params.anonymousPrincipalId)
                )
              )

            yield* tx
              .update(schema.transfers)
              .set({ principalId: params.userPrincipalId, updatedAt: now })
              .where(
                and(
                  eq(schema.transfers.sourceId, params.sourceId),
                  eq(schema.transfers.principalId, params.anonymousPrincipalId)
                )
              )

            yield* tx
              .update(schema.transactionLegs)
              .set({ principalId: params.userPrincipalId, updatedAt: now })
              .where(
                and(
                  eq(schema.transactionLegs.sourceId, params.sourceId),
                  eq(schema.transactionLegs.principalId, params.anonymousPrincipalId)
                )
              )

            yield* tx
              .update(schema.inventoryMovements)
              .set({ principalId: params.userPrincipalId, updatedAt: now })
              .where(
                and(
                  eq(schema.inventoryMovements.sourceId, params.sourceId),
                  eq(schema.inventoryMovements.principalId, params.anonymousPrincipalId)
                )
              )

            yield* tx
              .update(schema.processingJobs)
              .set({ principalId: params.userPrincipalId, updatedAt: now })
              .where(
                and(
                  eq(schema.processingJobs.sourceId, params.sourceId),
                  eq(schema.processingJobs.principalId, params.anonymousPrincipalId)
                )
              )

            yield* tx
              .update(schema.syncRuns)
              .set({ principalId: params.userPrincipalId, updatedAt: now })
              .where(eq(schema.syncRuns.principalId, params.anonymousPrincipalId))

            yield* tx
              .update(schema.transactionReviews)
              .set({ principalId: params.userPrincipalId, updatedAt: now })
              .where(eq(schema.transactionReviews.principalId, params.anonymousPrincipalId))

            yield* tx
              .update(schema.transferReconciliations)
              .set({ principalId: params.userPrincipalId, updatedAt: now })
              .where(eq(schema.transferReconciliations.principalId, params.anonymousPrincipalId))

            const consumedClaims = yield* tx
              .update(schema.principalClaims)
              .set({ consumedAt: now, updatedAt: now })
              .where(
                and(
                  eq(schema.principalClaims.requestId, params.requestId),
                  eq(schema.principalClaims.principalId, params.anonymousPrincipalId),
                  isNull(schema.principalClaims.consumedAt)
                )
              )
              .returning({ id: schema.principalClaims.id })

            if (consumedClaims.length < 1) {
              return yield* new PrincipalClaimTransferStaleError({
                message: "Request claims were not consumed.",
              })
            }

            if (transferredRequests.length > 0) {
              yield* tx.insert(schema.calculationSyncRequests).values(
                transferredRequests.map((request) => ({
                  ...request,
                  principalId: params.userPrincipalId,
                  status: "queued" as const,
                }))
              )
            }

            yield* fenceAndDeleteAnonymousCalculationRuns({
              executor: tx,
              principalId: params.anonymousPrincipalId,
              updatedAt: now,
            })

            return params.sourceId
          })
        )
        .pipe(
          wrapClaimTransferSqlError("principalClaimRepository.claimAnonymousSourceForUserByPayer")
        )

  return PrincipalClaimRepository.of({
    create,
    findValidCliSourceClaim,
    hasConsumedX402ReceiptForSource,
    findAnonymousSourceEntitlementsByPayer,
    findAnonymousSourceEntitlementByPayer,
    listAnonymousSourceSyncJobsByPayer,
    findAnonymousSourceSyncJobByPayer,
    findValidSiwxSourceClaim,
    claimAnonymousSourceForUser,
    claimAnonymousSourceForUserByPayer,
  } satisfies PrincipalClaimRepositoryService)
})

/**
 * PrincipalClaimRepositoryLive - Live ownership claim repository layer.
 */
export const PrincipalClaimRepositoryLive = Layer.effect(PrincipalClaimRepository, make)
