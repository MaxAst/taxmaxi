/**
 * TransactionOverridesApiLive - Owned movement correction REST reads and acceptance.
 *
 * @module TransactionOverridesApiLive
 */
import {
  AcquisitionCause,
  JurisdictionCode,
  MovementClassificationInput,
  MovementCorrectionFacts,
  TaxYear,
  validateMovementClassification,
} from "@my/core/accounting"
import { EUR } from "@my/core/currency"
import {
  PrincipalTransactionOverrideRepository,
  type PrincipalTransactionOverrideContext,
  type PrincipalTransactionOverrideHistoryRecord,
  type PrincipalTransactionOverrideProjection,
  type MovementCorrectionMutationError,
  type MovementCorrectionMutationResult,
} from "@my/persistence/services"
import {
  SourceSyncJobRepository,
  SourceSyncQueue,
  SourceSyncQueuePayload,
} from "@my/sync-engine/services"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InternalServerError } from "../definitions/ApiErrors.ts"
import { TaxMaxiApi } from "../definitions/TaxMaxiApi.ts"
import {
  TransactionOverrideConflictError,
  TransactionOverrideContext,
  TransactionOverrideCurrentResponse,
  TransactionOverrideMutationResponse,
  TransactionOverrideNotFoundError,
  TransactionOverrideReadonlyError,
  TransactionOverrideSetRequest,
  TransactionOverrideTargetsResponse,
  TransactionOverrideValidationError,
  TransactionOverrideWithdrawRequest,
} from "../definitions/TransactionOverridesApi.ts"
import { PrincipalResolutionService } from "../services/PrincipalResolutionService.ts"

const internalError = () =>
  new InternalServerError({
    requestId: Option.none(),
    message: "Failed to process the movement correction.",
  })

const notFound = () => new TransactionOverrideNotFoundError({ code: "target_not_found" })

const GERMAN_JURISDICTION = JurisdictionCode.make("DE")

const classificationCandidates: ReadonlyArray<MovementClassificationInput> = [
  ...AcquisitionCause.literals.map((cause) => ({ _tag: "inbound" as const, cause })),
  ...MovementClassificationInput.members[1].fields.cause.literals.map((cause) => ({
    _tag: "outbound" as const,
    cause,
  })),
]

const toHistory = (record: PrincipalTransactionOverrideHistoryRecord) =>
  Effect.gen(function* () {
    return {
      ...record,
      inspectedFacts: yield* Schema.encodeEffect(MovementCorrectionFacts)(record.inspectedFacts),
      inspectedSystem: {
        ...record.inspectedSystem,
        occurredAt: record.inspectedSystem.occurredAt.toISOString(),
      },
      recordedAt: record.recordedAt.toISOString(),
    }
  })

const toStream = (stream: PrincipalTransactionOverrideContext["price"]) =>
  Effect.gen(function* () {
    return {
      leaf: stream.leaf === null ? null : yield* toHistory(stream.leaf),
      active: stream.active === null ? null : yield* toHistory(stream.active),
    }
  })

const toContext = (context: PrincipalTransactionOverrideContext) =>
  Effect.gen(function* () {
    return yield* Schema.decodeEffect(TransactionOverrideContext)({
      ...context,
      current:
        context.current === null
          ? null
          : {
              ...context.current,
              facts: yield* Schema.encodeEffect(MovementCorrectionFacts)(context.current.facts),
              system: {
                ...context.current.system,
                occurredAt: context.current.system.occurredAt.toISOString(),
              },
            },
      price: yield* toStream(context.price),
      classification: yield* toStream(context.classification),
      history: yield* Effect.forEach(context.history, toHistory),
    })
  }).pipe(Effect.mapError(internalError))

/** Serialize current movement facts and history without changing coverage semantics. */
export const toTransactionOverrideResponse = (projection: PrincipalTransactionOverrideProjection) =>
  Effect.gen(function* () {
    const facts = projection.context.current?.facts
    const validClassificationInputs =
      facts === undefined
        ? []
        : yield* Effect.filter(classificationCandidates, (input) =>
            validateMovementClassification({ input, facts }).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false)
            )
          )
    return yield* Schema.decodeUnknownEffect(TransactionOverrideCurrentResponse)({
      ...projection,
      context: yield* toContext(projection.context),
      price: { ...projection.price, ...(yield* toStream(projection.price)) },
      classification: {
        ...projection.classification,
        ...(yield* toStream(projection.classification)),
      },
      validClassificationInputs,
    })
  }).pipe(Effect.mapError(internalError))

const rejectMutation = (error: MovementCorrectionMutationError) =>
  Effect.gen(function* () {
    switch (error._tag) {
      case "MovementCorrectionConflictError":
        return yield* new TransactionOverrideConflictError({
          code: "override_conflict",
          conflictKinds: [...error.conflictKinds],
          currentContext: yield* toContext(error.currentContext),
        })
      case "MovementCorrectionValidationError":
      case "MovementCorrectionInputError":
        return yield* new TransactionOverrideValidationError({ code: error.code })
      case "PersistenceError":
        return yield* internalError()
    }
  })

/** Authenticated target reads and atomic mutations, followed by existing queue delivery. */

export const TransactionOverridesApiLive = HttpApiBuilder.group(
  TaxMaxiApi,
  "transactionOverrides",
  (handlers) =>
    Effect.gen(function* () {
      const repository = yield* PrincipalTransactionOverrideRepository
      const principals = yield* PrincipalResolutionService
      const jobs = yield* SourceSyncJobRepository
      const queue = yield* SourceSyncQueue
      const resolvePrincipal = principals.resolveCurrentUserPrincipal.pipe(
        Effect.mapError(internalError)
      )
      const resolveActor = resolvePrincipal.pipe(
        Effect.flatMap(({ currentUser, principal }) =>
          currentUser.role === "readonly"
            ? Effect.fail(new TransactionOverrideReadonlyError({ code: "readonly_user" }))
            : Effect.succeed({ principalId: principal.id, actorUserId: currentUser.userId })
        )
      )
      const read = ({
        targetId,
        taxYear,
      }: {
        readonly targetId: string
        readonly taxYear: number
      }) =>
        Effect.gen(function* () {
          const { principal } = yield* resolvePrincipal
          const projection = yield* repository
            .findProjection({
              principalId: principal.id,
              targetId,
              scope: {
                jurisdiction: GERMAN_JURISDICTION,
                taxYear: TaxYear.make(taxYear),
                reportingCurrency: EUR,
              },
            })
            .pipe(Effect.mapError(internalError))
          if (Option.isNone(projection)) return yield* notFound()
          return yield* toTransactionOverrideResponse(projection.value)
        })
      // Acceptance is already committed. Delivery failure leaves the recorded work for recovery.
      const dispatchAccepted = (accepted: MovementCorrectionMutationResult) =>
        Effect.gen(function* () {
          const job = yield* jobs.getExecutionJob({ jobId: accepted.processingJobId }).pipe(
            Effect.map(Option.some),
            Effect.catchTags({
              SourceSyncJobPrerequisitesPendingError: () => Effect.succeed(Option.none()),
              SourceSyncJobExecutionRecordConflictError: () => Effect.succeed(Option.none()),
            })
          )
          if (Option.isNone(job) || job.value.status !== "pending") return
          yield* queue.enqueueSourceSyncJob(
            SourceSyncQueuePayload.make({
              jobId: job.value.id,
              sourceId: job.value.sourceId,
              principalId: job.value.principalId,
              mode: job.value.mode,
            })
          )
        }).pipe(
          Effect.catch((error) =>
            Effect.logError(
              { processingJobId: accepted.processingJobId, sourceId: accepted.sourceId, error },
              "Movement correction dispatch failed"
            )
          )
        )
      const respondAccepted = (accepted: Option.Option<MovementCorrectionMutationResult>) =>
        Effect.gen(function* () {
          if (Option.isNone(accepted)) return yield* notFound()
          const response = yield* Schema.decodeEffect(TransactionOverrideMutationResponse)({
            ...accepted.value,
            context: yield* toContext(accepted.value.context),
          }).pipe(Effect.mapError(internalError))
          yield* dispatchAccepted(accepted.value)
          return response
        })
      const set = ({
        operation,
        targetId,
        payload,
      }: {
        readonly operation: "create" | "replace"
        readonly targetId: string
        readonly payload: typeof TransactionOverrideSetRequest.Type
      }) =>
        Effect.gen(function* () {
          const actor = yield* resolveActor
          const accepted = yield* repository[operation]({
            ...actor,
            targetId,
            ...payload,
            reportingCurrency: EUR,
          }).pipe(Effect.catch(rejectMutation))
          return yield* respondAccepted(accepted)
        })
      return handlers
        .handle("getTransactionOverrideTargets", ({ params, query }) =>
          Effect.gen(function* () {
            const { principal } = yield* resolvePrincipal
            const targets = yield* repository
              .findTransactionTargets({
                principalId: principal.id,
                transactionId: params.transactionId,
                scope: {
                  jurisdiction: GERMAN_JURISDICTION,
                  taxYear: TaxYear.make(query.taxYear),
                  reportingCurrency: EUR,
                },
              })
              .pipe(Effect.mapError(internalError))
            if (Option.isNone(targets)) return yield* notFound()
            return yield* Schema.decodeEffect(TransactionOverrideTargetsResponse)({
              targets: yield* Effect.forEach(targets.value, toTransactionOverrideResponse),
            }).pipe(Effect.mapError(internalError))
          })
        )
        .handle("getTransactionOverrideCurrent", ({ params, query }) =>
          read({ ...params, ...query })
        )
        .handle("getTransactionOverrideHistory", ({ params, query }) =>
          read({ ...params, ...query })
        )
        .handle("createTransactionOverride", ({ params, payload }) =>
          set({ ...params, payload, operation: "create" })
        )
        .handle("replaceTransactionOverride", ({ params, payload }) =>
          set({ ...params, payload, operation: "replace" })
        )
        .handle(
          "withdrawTransactionOverride",
          ({
            params,
            payload,
          }: {
            params: { targetId: string }
            payload: typeof TransactionOverrideWithdrawRequest.Type
          }) =>
            Effect.gen(function* () {
              const actor = yield* resolveActor
              const accepted = yield* repository
                .withdraw({ ...actor, ...params, ...payload, reportingCurrency: EUR })
                .pipe(Effect.catch(rejectMutation))
              return yield* respondAccepted(accepted)
            })
        )
    })
)
