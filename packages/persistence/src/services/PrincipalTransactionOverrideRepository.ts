/**
 * PrincipalTransactionOverrideRepository - Owned movement context and audited stream reads.
 *
 * @module PrincipalTransactionOverrideRepository
 */
import type {
  MovementClassificationInput,
  MovementCorrectionFacts,
  MovementCorrectionTargetIdentity,
  MovementPriceInput,
} from "@my/core/accounting"
import type { PrincipalId } from "@my/core/ownership"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import type { PersistenceError } from "../errors/RepositoryError.ts"

/** Recorded system evidence, kept separate from effective correction inputs. */
export interface MovementSystemEvidence {
  readonly occurredAt: Date
  readonly legKind: "acquisition" | "disposal" | "income" | "fee"
  readonly recordedFiatAmount: string | null
  readonly recordedFiatCurrency: string | null
  readonly transactionType: string | null
  readonly providerTransactionType: string | null
  readonly derivationRule: string | null
  readonly feeForSourceRecordKey: string | null
}

/** One immutable event in exactly one correction stream. */
export interface PrincipalTransactionOverrideHistoryRecord {
  readonly id: string
  readonly principalId: string
  readonly sourceId: string
  readonly targetId: string
  readonly kind: "price" | "classification"
  readonly operation: "create" | "replace" | "withdraw"
  readonly inspectedFacts: MovementCorrectionFacts
  readonly inspectedSystem: MovementSystemEvidence
  readonly input:
    | { readonly _tag: "price"; readonly input: MovementPriceInput }
    | { readonly _tag: "classification"; readonly input: MovementClassificationInput }
    | null
  readonly actorUserId: string
  readonly reason: string
  readonly supersedesOverrideId: string | null
  readonly recordedAt: Date
}

/** The latest event and active input differ after withdrawal. */
export interface MovementCorrectionStream {
  readonly leaf: PrincipalTransactionOverrideHistoryRecord | null
  readonly active: PrincipalTransactionOverrideHistoryRecord | null
}

/** Owned target and recorded facts; later tasks add effective/application projections. */
export interface PrincipalTransactionOverrideContext {
  readonly targetId: string
  readonly target: MovementCorrectionTargetIdentity
  readonly current: {
    readonly legId: string
    readonly transactionId: string | null
    readonly facts: MovementCorrectionFacts
    readonly system: MovementSystemEvidence
  } | null
  readonly price: MovementCorrectionStream
  readonly classification: MovementCorrectionStream
  readonly history: ReadonlyArray<PrincipalTransactionOverrideHistoryRecord>
}

/** Storage/read foundation only; accepted mutations and replay scheduling arrive in T04. */
export interface PrincipalTransactionOverrideRepositoryShape {
  /** Read one owned target in a consistent snapshot. Missing and foreign targets both return none. */
  readonly findContext: (params: {
    readonly principalId: PrincipalId
    readonly targetId: string
  }) => Effect.Effect<Option.Option<PrincipalTransactionOverrideContext>, PersistenceError>
}

/** Principal-scoped movement correction history reader. */
export class PrincipalTransactionOverrideRepository extends Context.Service<
  PrincipalTransactionOverrideRepository,
  PrincipalTransactionOverrideRepositoryShape
>()("@my/persistence/PrincipalTransactionOverrideRepository") {}
