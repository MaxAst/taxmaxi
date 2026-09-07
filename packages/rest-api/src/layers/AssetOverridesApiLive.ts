/**
 * AssetOverridesApiLive - Principal-scoped asset override REST handlers.
 *
 * @module AssetOverridesApiLive
 */

import { PrincipalAssetOverrideTarget } from "@my/core/assets"
import {
  PrincipalAssetOverrideRepository,
  type PrincipalAssetOverrideHistoryRecord,
  type PrincipalAssetOverrideProjection,
  type PrincipalAssetOverrideMutationError,
  type PrincipalAssetOverrideReadError,
  type PrincipalAssetOverrideRecomputation,
  type PrincipalAssetIdentityOverrideValidation,
} from "@my/persistence/services"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
  AssetOverrideCalculationRunResponse,
  AssetOverrideAssetNotFoundValidationResponse,
  AssetOverrideCanonicalTargetError,
  AssetOverrideCurrentResponse,
  AssetOverrideHistoryRecordResponse,
  AssetOverrideHistoryResponse,
  AssetOverrideIncompatibleAssetTypeValidationResponse,
  AssetOverrideNotScheduledRecomputationResponse,
  AssetOverrideReadyValidationResponse,
  AssetOverrideReplayJobResponse,
  AssetOverrideReadonlyError,
  AssetOverrideScheduledRecomputationResponse,
  AssetOverrideSelectedAssetResponse,
  AssetOverrideSystemResponse,
  AssetOverrideTargetNotFoundError,
  AssetOverrideMutationConflictError,
  AssetOverrideReplacementValidationError,
  AssetOverrideValidationWarningResponse,
  type AssetOverrideTargetQuery,
} from "../definitions/AssetOverridesApi.ts"
import { InternalServerError } from "../definitions/ApiErrors.ts"
import { TaxMaxiApi } from "../definitions/TaxMaxiApi.ts"
import { PrincipalResolutionService } from "../services/PrincipalResolutionService.ts"

const notScheduledRecomputation = AssetOverrideNotScheduledRecomputationResponse.make({
  status: "not_scheduled",
})

const internalError = (message: string) =>
  new InternalServerError({ requestId: Option.none(), message })

const canonicalTargetError = (
  reason: "invalid_target_shape" | "invalid_evm_address" | "unknown_blockchain"
) =>
  new AssetOverrideCanonicalTargetError({
    code: "invalid_canonical_target",
    reason,
  })

const targetNotFound = () => new AssetOverrideTargetNotFoundError({ code: "target_not_found" })

const readonlyForbidden = () => new AssetOverrideReadonlyError({ code: "readonly_user" })

const decodeTarget = (
  query: typeof AssetOverrideTargetQuery.Type
): Effect.Effect<PrincipalAssetOverrideTarget, AssetOverrideCanonicalTargetError> => {
  if (query.targetKind === "provider_asset") {
    if (
      query.blockchain !== undefined ||
      query.representationType !== undefined ||
      query.contractAddress !== undefined ||
      query.mintAddress !== undefined
    ) {
      return Effect.fail(canonicalTargetError("invalid_target_shape"))
    }

    return Schema.decodeUnknownEffect(PrincipalAssetOverrideTarget)({
      _tag: "provider_asset",
      providerAssetRowId: query.providerAssetRowId,
    }).pipe(Effect.mapError(() => canonicalTargetError("invalid_target_shape")))
  }

  if (query.providerAssetRowId !== undefined) {
    return Effect.fail(canonicalTargetError("invalid_target_shape"))
  }

  return Schema.decodeUnknownEffect(PrincipalAssetOverrideTarget)({
    _tag: "representation",
    blockchain: query.blockchain,
    type: query.representationType,
    contractAddress: query.contractAddress ?? null,
    mintAddress: query.mintAddress ?? null,
  }).pipe(Effect.mapError(() => canonicalTargetError("invalid_target_shape")))
}

const mapReadError = (
  error: PrincipalAssetOverrideReadError
): AssetOverrideCanonicalTargetError | InternalServerError =>
  error._tag === "PrincipalAssetOverrideInvalidTargetError"
    ? canonicalTargetError(error.reason)
    : internalError("Failed to read the principal asset override.")

const toHistoryRecord = (
  record: PrincipalAssetOverrideHistoryRecord
): AssetOverrideHistoryRecordResponse =>
  AssetOverrideHistoryRecordResponse.make({
    ...record,
    recordedAt: DateTime.makeUnsafe(record.recordedAt),
  })

const toSelectedAsset = (
  asset: Extract<PrincipalAssetIdentityOverrideValidation, { readonly _tag: "ready" }>["asset"]
): AssetOverrideSelectedAssetResponse => AssetOverrideSelectedAssetResponse.make(asset)

const toRecomputationResponse = (recomputation: PrincipalAssetOverrideRecomputation) =>
  recomputation.status === "not_scheduled"
    ? notScheduledRecomputation
    : AssetOverrideScheduledRecomputationResponse.make({
        status: recomputation.status,
        overrideIds: [...recomputation.overrideIds],
        sourceJobs: recomputation.sourceJobs.map((job) => AssetOverrideReplayJobResponse.make(job)),
        calculationRun:
          recomputation.calculationRun === null
            ? null
            : AssetOverrideCalculationRunResponse.make(recomputation.calculationRun),
      })

/** Serialize the existing independent asset decision and retained history projection. */
export const toAssetOverrideResponse = (
  projection: PrincipalAssetOverrideProjection
): AssetOverrideCurrentResponse =>
  AssetOverrideCurrentResponse.make({
    target: projection.target,
    system: AssetOverrideSystemResponse.make(projection.system),
    activeIdentityOverride:
      projection.activeIdentityOverride === null
        ? null
        : toHistoryRecord(projection.activeIdentityOverride),
    activeInclusionOverride:
      projection.activeInclusionOverride === null
        ? null
        : toHistoryRecord(projection.activeInclusionOverride),
    effectiveDecision: projection.effectiveDecision,
    checkedTechnicalBlockerKinds: projection.checkedTechnicalBlockerKinds,
    technicalBlockers: projection.technicalBlockers,
    identityOverrideUsesStaleSystemRevision: projection.identityOverrideUsesStaleSystemRevision,
    inclusionOverrideUsesStaleSystemRevision: projection.inclusionOverrideUsesStaleSystemRevision,
    history: projection.history.map(toHistoryRecord),
    recomputation: toRecomputationResponse(projection.recomputation),
  })

const toValidationResponse = (
  validation: PrincipalAssetIdentityOverrideValidation,
  recomputation: PrincipalAssetOverrideRecomputation
) => {
  if (validation._tag !== "ready") {
    return toRejectedValidationResponse(validation, recomputation)
  }

  return AssetOverrideReadyValidationResponse.make({
    asset: toSelectedAsset(validation.asset),
    projection: toAssetOverrideResponse(validation.projection),
    checkedTechnicalBlockerKinds: validation.checkedTechnicalBlockerKinds,
    technicalBlockers: validation.technicalBlockers,
    warnings: validation.warnings.map((warning) =>
      AssetOverrideValidationWarningResponse.make(warning)
    ),
    recomputation: toRecomputationResponse(validation.projection.recomputation),
  })
}

const toRejectedValidationResponse = (
  validation: Exclude<PrincipalAssetIdentityOverrideValidation, { readonly _tag: "ready" }>,
  recomputation: PrincipalAssetOverrideRecomputation
) => {
  switch (validation._tag) {
    case "asset_not_found":
      return AssetOverrideAssetNotFoundValidationResponse.make({
        assetId: validation.assetId,
        checkedTechnicalBlockerKinds: validation.checkedTechnicalBlockerKinds,
        technicalBlockers: validation.technicalBlockers,
        recomputation: toRecomputationResponse(recomputation),
      })
    case "incompatible_asset_type":
      return AssetOverrideIncompatibleAssetTypeValidationResponse.make({
        asset: AssetOverrideSelectedAssetResponse.make(validation.asset),
        targetAssetType: validation.targetAssetType,
        checkedTechnicalBlockerKinds: validation.checkedTechnicalBlockerKinds,
        technicalBlockers: validation.technicalBlockers,
        recomputation: toRecomputationResponse(recomputation),
      })
  }
}

const toMutationConflictError = (
  error: Extract<
    PrincipalAssetOverrideMutationError,
    { readonly _tag: "PrincipalAssetOverrideConflictError" }
  >
) =>
  new AssetOverrideMutationConflictError({
    code: "override_conflict",
    conflictKinds: [...error.conflictKinds],
    currentProjection: toAssetOverrideResponse(error.currentProjection),
    currentActiveOverrideId: error.currentActiveOverrideId,
    currentSystemRevision: error.currentSystemRevision,
    expectedActiveOverrideId:
      error.expectedActiveOverrideId === "" ? null : error.expectedActiveOverrideId,
    expectedSystemRevision: error.expectedSystemRevision,
  })

const mapMutationError = (
  error: PrincipalAssetOverrideMutationError
):
  | AssetOverrideCanonicalTargetError
  | AssetOverrideMutationConflictError
  | AssetOverrideReplacementValidationError
  | InternalServerError => {
  switch (error._tag) {
    case "PrincipalAssetOverrideInvalidTargetError":
      return canonicalTargetError(error.reason)
    case "PrincipalAssetOverrideConflictError":
      return toMutationConflictError(error)
    case "PrincipalAssetOverrideReplacementValidationError":
      return new AssetOverrideReplacementValidationError({
        code: "invalid_replacement",
        validation: toRejectedValidationResponse(
          error.validation,
          error.currentProjection.recomputation
        ),
        currentProjection: toAssetOverrideResponse(error.currentProjection),
      })
    case "PersistenceError":
      return internalError("Failed to change the principal asset override.")
  }
}

const mapWithdrawMutationError = (
  error: PrincipalAssetOverrideMutationError
): AssetOverrideCanonicalTargetError | AssetOverrideMutationConflictError | InternalServerError => {
  switch (error._tag) {
    case "PrincipalAssetOverrideInvalidTargetError":
      return canonicalTargetError(error.reason)
    case "PrincipalAssetOverrideConflictError":
      return toMutationConflictError(error)
    case "PrincipalAssetOverrideReplacementValidationError":
      return internalError("The withdrawal produced an unexpected validation error.")
    case "PersistenceError":
      return internalError("Failed to withdraw the principal asset override.")
  }
}

/** Live authenticated read, validation, creation, replacement, and withdrawal handlers. */
export const AssetOverridesApiLive = HttpApiBuilder.group(
  TaxMaxiApi,
  "assetOverrides",
  (handlers) =>
    Effect.gen(function* () {
      const repository = yield* PrincipalAssetOverrideRepository
      const principalResolution = yield* PrincipalResolutionService

      const resolvePrincipalId = principalResolution.resolveCurrentUserPrincipal.pipe(
        Effect.map(({ principal }) => principal.id),
        Effect.mapError(() => internalError("Failed to resolve the current user."))
      )

      const resolveMutationActor = principalResolution.resolveCurrentUserPrincipal.pipe(
        Effect.mapError(() => internalError("Failed to resolve the current user.")),
        Effect.flatMap(({ currentUser, principal }) =>
          currentUser.role === "readonly"
            ? Effect.fail(readonlyForbidden())
            : Effect.succeed({ actorUserId: currentUser.userId, principalId: principal.id })
        )
      )

      const findOwnedProjection = (query: typeof AssetOverrideTargetQuery.Type) =>
        Effect.gen(function* () {
          const target = yield* decodeTarget(query)
          const principalId = yield* resolvePrincipalId
          const projection = yield* repository
            .findProjection({ principalId, target })
            .pipe(Effect.mapError(mapReadError))

          if (Option.isNone(projection)) return yield* targetNotFound()

          return projection.value
        })

      return handlers
        .handle("getAssetOverrideCurrent", ({ query }) =>
          Effect.gen(function* () {
            const projection = yield* findOwnedProjection(query)
            return toAssetOverrideResponse(projection)
          })
        )
        .handle("getAssetOverrideHistory", ({ query }) =>
          Effect.gen(function* () {
            const projection = yield* findOwnedProjection(query)

            return AssetOverrideHistoryResponse.make({
              target: projection.target,
              history: projection.history.map(toHistoryRecord),
              recomputation: toRecomputationResponse(projection.recomputation),
            })
          })
        )
        .handle("validateAssetOverrideIdentity", ({ query }) =>
          Effect.gen(function* () {
            const target = yield* decodeTarget(query)
            const principalId = yield* resolvePrincipalId
            const validation = yield* repository
              .validateIdentityReplacement({
                assetId: query.assetId,
                principalId,
                target,
              })
              .pipe(Effect.mapError(mapReadError))

            if (Option.isNone(validation)) return yield* targetNotFound()

            if (validation.value._tag === "ready") {
              return toValidationResponse(
                validation.value,
                validation.value.projection.recomputation
              )
            }

            const projection = yield* repository
              .findProjection({ principalId, target })
              .pipe(Effect.mapError(mapReadError))
            if (Option.isNone(projection)) return yield* targetNotFound()

            return toValidationResponse(validation.value, projection.value.recomputation)
          })
        )
        .handle("createAssetOverride", ({ payload, query }) =>
          Effect.gen(function* () {
            const target = yield* decodeTarget(query)
            const actor = yield* resolveMutationActor
            const projection = yield* repository
              .create({
                ...actor,
                expectedSystemRevision: payload.expectedSystemRevision,
                reason: payload.reason,
                replacement:
                  payload._tag === "identity"
                    ? { _tag: "identity", assetId: payload.assetId }
                    : { _tag: "inclusion", inclusion: payload.inclusion },
                target,
              })
              .pipe(Effect.mapError(mapMutationError))

            if (Option.isNone(projection)) return yield* targetNotFound()

            return toAssetOverrideResponse(projection.value)
          })
        )
        .handle("replaceAssetOverride", ({ payload, query }) =>
          Effect.gen(function* () {
            const target = yield* decodeTarget(query)
            const actor = yield* resolveMutationActor
            const projection = yield* repository
              .replace({
                ...actor,
                expectedActiveOverrideId: payload.expectedActiveOverrideId,
                expectedSystemRevision: payload.expectedSystemRevision,
                reason: payload.reason,
                replacement:
                  payload._tag === "identity"
                    ? { _tag: "identity", assetId: payload.assetId }
                    : { _tag: "inclusion", inclusion: payload.inclusion },
                target,
              })
              .pipe(Effect.mapError(mapMutationError))

            if (Option.isNone(projection)) return yield* targetNotFound()

            return toAssetOverrideResponse(projection.value)
          })
        )
        .handle("withdrawAssetOverride", ({ payload, query }) =>
          Effect.gen(function* () {
            const target = yield* decodeTarget(query)
            const actor = yield* resolveMutationActor
            const projection = yield* repository
              .withdraw({
                ...actor,
                expectedActiveOverrideId: payload.expectedActiveOverrideId,
                expectedSystemRevision: payload.expectedSystemRevision,
                kind: payload.kind,
                reason: payload.reason,
                target,
              })
              .pipe(Effect.mapError(mapWithdrawMutationError))

            if (Option.isNone(projection)) return yield* targetNotFound()

            return toAssetOverrideResponse(projection.value)
          })
        )
    })
)
