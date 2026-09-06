/**
 * HeliusSolanaSourceSyncProviderLive - Helius Solana raw-history ingestion provider.
 *
 * @module HeliusSolanaSourceSyncProviderLive
 */

import { SOLANA_WRAPPED_NATIVE_MINT } from "@my/core/assets"
import * as Timestamp from "@my/core/shared/values/Timestamp"
import * as BigDecimal from "effect/BigDecimal"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"
import * as SchemaIssue from "effect/SchemaIssue"
import {
  ActivityEvidence,
  ActivityFacts,
  ActivityMovementFacts,
  ActivityOnchainEntrypointFacts,
  ActivityOnchainFacts,
} from "../../../services/ActivityClassificationService.ts"
import { AssetRepository } from "../../../services/AssetRepository.ts"
import type { ResolvedProviderTransactionTypeMapping } from "../../../services/ProviderReferenceRepository.ts"
import type {
  SourceTransactionDraft,
  SourceOnchainContextDraft,
  SourceProviderTransferDraft,
  SourceTransactionLegDraft,
  SourceTransactionReviewDraft,
  SourceTransferDraft,
  SourceVenueContextDraft,
} from "../../../services/SourceNormalizationRepository.ts"
import {
  FetchProviderRawBatchResult,
  ProviderRawRecord,
  SourceSyncCursorDecodeError,
  SourceSyncProviderFailureError,
  UnsupportedSyncProviderError,
  type FetchProviderRawBatchParams,
  type SourceSyncProviderError,
} from "../../../shared/SourceProviderRawBatch.ts"
import {
  HELIUS_SOLANA_PROVIDER_KEY,
  HELIUS_SOLANA_RECORD_TYPE_TRANSACTION_FULL,
  HeliusSolanaCursorDecodeError,
  HeliusSolanaNormalizationDecodeError,
  HeliusSolanaNormalizationReferenceError,
  HeliusSolanaPayloadDecodeError,
  HeliusSolanaSourceSyncProvider,
  type HeliusSolanaCanonicalLegPlan,
  type HeliusSolanaNormalizationLookups,
  type HeliusSolanaReferenceDataRefreshResult,
  type HeliusSolanaSourceSyncProviderShape,
} from "../services/HeliusSolanaSourceSyncProvider.ts"
import {
  HeliusSolanaAuthError,
  HeliusSolanaProviderError,
  HeliusSolanaSyncClient,
  type HeliusSolanaSyncClientError,
} from "../services/HeliusSolanaSyncClient.ts"
import {
  HeliusSolanaAssetResolutionService,
  SOLANA_BLOCKCHAIN_NAME,
  type HeliusSolanaResolvedAsset,
} from "../services/HeliusSolanaAssetResolutionService.ts"
import {
  HeliusSolanaAssetResolutionServiceLive,
  toHeliusSolanaReferenceDataRefreshResult,
} from "./HeliusSolanaAssetResolutionServiceLive.ts"
import { HeliusSolanaSyncClientLive } from "./HeliusSolanaSyncClientLive.ts"
import { SyncEngineStorageError } from "../../../services/SyncEngineStorageError.ts"

const emptyReferenceDataRefresh = {
  transactionTypeCatalogCount: 0,
  providerAssetCatalogCount: 0,
  defaultTransactionMappingCount: 0,
  defaultProviderAssetMappingCount: 0,
} satisfies HeliusSolanaReferenceDataRefreshResult

const SOLANA_EXPLORER_SIGNATURE_URL = "https://explorer.solana.com/tx/"
const SOLANA_TOKEN_PROGRAM_IDS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFvcsdN5kh5qMJ2AKU9FK",
])
const SOLANA_TOKEN_PROGRAM_NAMES = new Set(["spl-token", "spl-token-2022"])
const MAX_NATIVE_SUBSET_SEARCH_STATES = 4_096
// Helius wallet transfer rows report native SOL under this pseudo-mint. It is
// not a real SPL mint, so it must never reach SPL asset resolution or DAS
// lookups; rows carrying it are native SOL evidence.
const HELIUS_NATIVE_SOL_PSEUDO_MINT = "So11111111111111111111111111111111111111111"

const HeliusSolanaTransactionsPageSchema = Schema.Struct({
  data: Schema.Array(Schema.Unknown),
  paginationToken: Schema.NullOr(Schema.String),
})

const HeliusSolanaFullTransactionEntrySchema = Schema.Struct({
  slot: Schema.Finite,
  transactionIndex: Schema.Finite,
  transaction: Schema.Struct({
    signatures: Schema.Array(Schema.String),
  }),
  meta: Schema.NullOr(Schema.Unknown),
  blockTime: Schema.NullOr(Schema.Finite),
})

const HeliusSolanaAccountKeySchema = Schema.Union([
  Schema.String,
  Schema.Struct({
    pubkey: Schema.String,
    signer: Schema.optional(Schema.Boolean),
    writable: Schema.optional(Schema.Boolean),
  }),
])

const HeliusSolanaInstructionSchema = Schema.Struct({
  programId: Schema.optional(Schema.String),
  program: Schema.optional(Schema.String),
  parsed: Schema.optional(Schema.Unknown),
})

const HeliusSolanaInnerInstructionsSchema = Schema.Struct({
  index: Schema.Finite,
  instructions: Schema.Array(HeliusSolanaInstructionSchema),
})

const HeliusSolanaCloseAccountParsedInstructionSchema = Schema.Struct({
  type: Schema.Literals(["closeAccount"]),
})

const SolanaTokenDecimalsSchema = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))
const SolanaRawTokenAmountSchema = Schema.String.check(
  Schema.isPattern(/^(0|[1-9]\d*)$/, {
    message: "Expected canonical unsigned token raw units.",
  })
)

const HeliusSolanaTokenBalanceSchema = Schema.Struct({
  accountIndex: Schema.Finite,
  mint: Schema.String,
  owner: Schema.optional(Schema.NullOr(Schema.String)),
  programId: Schema.optional(Schema.NullOr(Schema.String)),
  uiTokenAmount: Schema.Struct({
    amount: SolanaRawTokenAmountSchema,
    decimals: SolanaTokenDecimalsSchema,
    uiAmountString: Schema.optional(Schema.NullOr(Schema.String)),
  }),
})

const HeliusSolanaDecimalStringSchema = Schema.Union([Schema.String, Schema.Finite]).pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transformOrFail((value, options) => {
      const amount = typeof value === "number" ? String(value) : value.trim()
      return Option.match(BigDecimal.fromString(amount), {
        onNone: () =>
          Effect.fail(
            new SchemaIssue.InvalidValue(
              { message: "Expected a decimal token amount string or number." },
              value,
              options
            )
          ),
        onSome: () => Effect.succeed(amount),
      })
    }),
    encode: SchemaGetter.transform((value) => value),
  })
)

const HeliusSolanaParsedTokenTransferSchema = Schema.Struct({
  mint: Schema.optional(Schema.String),
  tokenAmount: Schema.optional(HeliusSolanaDecimalStringSchema),
  fromUserAccount: Schema.optional(Schema.String),
  toUserAccount: Schema.optional(Schema.String),
  fromTokenAccount: Schema.optional(Schema.String),
  toTokenAccount: Schema.optional(Schema.String),
})

const HeliusSolanaWalletTransferSchema = Schema.Struct({
  signature: Schema.String,
  timestamp: Schema.Finite,
  direction: Schema.Literals(["in", "out"]),
  counterparty: Schema.String,
  mint: Schema.String,
  symbol: Schema.NullOr(Schema.String),
  amount: Schema.Union([Schema.Finite, Schema.FiniteFromString]),
  amountRaw: SolanaRawTokenAmountSchema,
  decimals: SolanaTokenDecimalsSchema,
})

const HeliusSolanaWalletTransfersPageSchema = Schema.Struct({
  data: Schema.Array(HeliusSolanaWalletTransferSchema),
  pagination: Schema.Struct({
    hasMore: Schema.Boolean,
    nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
  }),
})

const HeliusSolanaCursorPayloadSchema = Schema.Struct({
  paginationToken: Schema.NullOr(Schema.String),
  resumeBoundaryActive: Schema.Boolean,
  resumeCheckpointExternalId: Schema.NullOr(Schema.String),
  resumeHighWatermarkIso: Schema.NullOr(Schema.String),
  walletTransferCursor: Schema.NullOr(Schema.String),
  walletTransferExhausted: Schema.Boolean,
  pendingWalletTransfers: Schema.Array(HeliusSolanaWalletTransferSchema),
})

const HeliusSolanaFullTransactionPayloadSchema = Schema.Struct({
  slot: Schema.Finite,
  transactionIndex: Schema.optional(Schema.Finite),
  transaction: Schema.Struct({
    signatures: Schema.Array(Schema.String),
    message: Schema.Struct({
      accountKeys: Schema.Array(HeliusSolanaAccountKeySchema),
      instructions: Schema.optional(Schema.Array(HeliusSolanaInstructionSchema)),
    }),
  }),
  meta: Schema.NullOr(
    Schema.Struct({
      err: Schema.NullOr(Schema.Unknown),
      fee: Schema.optional(Schema.Finite),
      preBalances: Schema.optional(Schema.Array(Schema.Finite)),
      postBalances: Schema.optional(Schema.Array(Schema.Finite)),
      preTokenBalances: Schema.optional(Schema.Array(HeliusSolanaTokenBalanceSchema)),
      postTokenBalances: Schema.optional(Schema.Array(HeliusSolanaTokenBalanceSchema)),
      innerInstructions: Schema.optional(Schema.Array(HeliusSolanaInnerInstructionsSchema)),
    })
  ),
  blockTime: Schema.NullOr(Schema.Finite),
  type: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  tokenTransfers: Schema.optional(Schema.Array(HeliusSolanaParsedTokenTransferSchema)),
})

const HeliusSolanaRawRecordPayloadSchema = Schema.Struct({
  fullTransaction: HeliusSolanaFullTransactionPayloadSchema,
  walletTransferEvidence: Schema.Array(HeliusSolanaWalletTransferSchema),
})

interface HeliusSolanaCursorPayload {
  readonly paginationToken: string | null
  readonly resumeBoundaryActive: boolean
  readonly resumeCheckpointExternalId: string | null
  readonly resumeHighWatermark: Date | null
  readonly walletTransferCursor: string | null
  readonly walletTransferExhausted: boolean
  readonly pendingWalletTransfers: ReadonlyArray<HeliusSolanaWalletTransfer>
}

interface DecodedHeliusSolanaTransactionEntry {
  readonly signature: string
  readonly blockTime: number
  readonly payload: unknown
}

type HeliusSolanaFullTransactionPayload = Schema.Schema.Type<
  typeof HeliusSolanaFullTransactionPayloadSchema
>
type HeliusSolanaAccountKey = Schema.Schema.Type<typeof HeliusSolanaAccountKeySchema>
type HeliusSolanaInstruction = Schema.Schema.Type<typeof HeliusSolanaInstructionSchema>
type HeliusSolanaTokenBalance = Schema.Schema.Type<typeof HeliusSolanaTokenBalanceSchema>
type HeliusSolanaParsedTokenTransfer = Schema.Schema.Type<
  typeof HeliusSolanaParsedTokenTransferSchema
>
type HeliusSolanaWalletTransfer = Schema.Schema.Type<typeof HeliusSolanaWalletTransferSchema>
type HeliusSolanaRawRecordPayload = Schema.Schema.Type<typeof HeliusSolanaRawRecordPayloadSchema>

interface SolanaBalanceMovement {
  /** Source-native component coordinate, absent when the provider exposes no identity. */
  readonly componentKey: string | null
  readonly identityIssue?: "ambiguous_movement_identity"
  readonly asset: HeliusSolanaResolvedAsset
  readonly amount: string
  readonly rawUnits: string
  readonly observedDecimals: number | null
  readonly matchCounterparty: string | null
  readonly direction: "inbound" | "outbound"
  readonly fromAddress: string
  readonly toAddress: string
  readonly role: "principal" | "fee" | "rent"
  readonly position: number
  readonly evidenceKind:
    | "balance_delta"
    | "token_balance_delta"
    | "parsed_transfer"
    | "transfer_row"
  readonly supplementalTransferRow: HeliusSolanaWalletTransfer | null
}

interface MovementContradiction {
  readonly reason: string
  readonly evidence: unknown
}

const decodeUnknownCursorPayload = Schema.decodeUnknownEffect(HeliusSolanaCursorPayloadSchema)
const decodeUnknownTransactionsPage = Schema.decodeUnknownEffect(HeliusSolanaTransactionsPageSchema)
const decodeUnknownFullTransactionEntry = Schema.decodeUnknownEffect(
  HeliusSolanaFullTransactionEntrySchema
)
const decodeUnknownRawRecordPayload = Schema.decodeUnknownEffect(HeliusSolanaRawRecordPayloadSchema)
const decodeUnknownWalletTransfersPage = Schema.decodeUnknownEffect(
  HeliusSolanaWalletTransfersPageSchema
)
const decodeCloseAccountParsedInstruction = Schema.decodeUnknownOption(
  HeliusSolanaCloseAccountParsedInstructionSchema
)

const toCursorDecodeError = (message: string, cause?: unknown) =>
  cause === undefined
    ? new HeliusSolanaCursorDecodeError({ message })
    : new HeliusSolanaCursorDecodeError({ message, cause })

const toPayloadDecodeError = (message: string, cause?: unknown) =>
  cause === undefined
    ? new HeliusSolanaPayloadDecodeError({ message })
    : new HeliusSolanaPayloadDecodeError({ message, cause })

const decodeCursorPayload = (
  payload: unknown
): Effect.Effect<HeliusSolanaCursorPayload, HeliusSolanaCursorDecodeError> => {
  if (payload === null || payload === undefined) {
    return Effect.succeed({
      paginationToken: null,
      resumeBoundaryActive: false,
      resumeCheckpointExternalId: null,
      resumeHighWatermark: null,
      walletTransferCursor: null,
      walletTransferExhausted: false,
      pendingWalletTransfers: [],
    })
  }

  return Effect.gen(function* () {
    const decoded = yield* decodeUnknownCursorPayload(payload).pipe(
      Effect.mapError((cause) =>
        toCursorDecodeError(
          `Invalid persisted Helius Solana cursor payload: ${cause.message}`,
          cause
        )
      )
    )
    const resumeHighWatermarkIso = decoded.resumeHighWatermarkIso
    const resumeHighWatermark =
      resumeHighWatermarkIso === null
        ? null
        : yield* Timestamp.fromString(resumeHighWatermarkIso).pipe(
            Effect.map((timestamp) => timestamp.toDate()),
            Effect.mapError((cause) =>
              toCursorDecodeError(
                `Invalid persisted Helius Solana resume high watermark: ${resumeHighWatermarkIso}`,
                cause
              )
            )
          )

    return {
      paginationToken: decoded.paginationToken,
      resumeBoundaryActive: decoded.resumeBoundaryActive,
      resumeCheckpointExternalId: decoded.resumeCheckpointExternalId,
      resumeHighWatermark,
      walletTransferCursor: decoded.walletTransferCursor,
      walletTransferExhausted: decoded.walletTransferExhausted,
      pendingWalletTransfers: decoded.pendingWalletTransfers,
    }
  })
}

const encodeCursorPayload = (payload: HeliusSolanaCursorPayload): unknown => ({
  paginationToken: payload.paginationToken,
  resumeBoundaryActive: payload.resumeBoundaryActive,
  resumeCheckpointExternalId: payload.resumeCheckpointExternalId,
  resumeHighWatermarkIso:
    payload.resumeHighWatermark === null
      ? null
      : Timestamp.fromDate(payload.resumeHighWatermark).toISOString(),
  walletTransferCursor: payload.walletTransferCursor,
  walletTransferExhausted: payload.walletTransferExhausted,
  pendingWalletTransfers: payload.pendingWalletTransfers,
})

const decodeTransactionsPage = (
  payload: unknown
): Effect.Effect<
  { readonly data: ReadonlyArray<unknown>; readonly paginationToken: string | null },
  HeliusSolanaPayloadDecodeError
> =>
  decodeUnknownTransactionsPage(payload).pipe(
    Effect.mapError((cause) =>
      toPayloadDecodeError(`Invalid Helius Solana transactions page: ${cause.message}`, cause)
    )
  )

const decodeTransactionEntry = (
  payload: unknown
): Effect.Effect<DecodedHeliusSolanaTransactionEntry, HeliusSolanaPayloadDecodeError> =>
  decodeUnknownFullTransactionEntry(payload).pipe(
    Effect.mapError((cause) =>
      toPayloadDecodeError(`Invalid Helius Solana full transaction entry: ${cause.message}`, cause)
    ),
    Effect.flatMap((decoded) => {
      const signature = decoded.transaction.signatures[0]

      if (signature === undefined || signature.trim() === "") {
        return Effect.fail(
          toPayloadDecodeError("Invalid Helius Solana full transaction entry: missing signature")
        )
      }

      if (decoded.blockTime === null) {
        return Effect.fail(
          toPayloadDecodeError(
            `Invalid Helius Solana full transaction entry blockTime for signature ${signature}: missing blockTime`
          )
        )
      }

      if (!Number.isFinite(decoded.blockTime)) {
        return Effect.fail(
          toPayloadDecodeError(
            `Invalid Helius Solana full transaction entry blockTime for signature ${signature}`
          )
        )
      }

      return Effect.succeed({
        signature,
        blockTime: decoded.blockTime,
        payload,
      })
    })
  )

const occurredAtFromBlockTime = (blockTime: number): Date =>
  DateTime.toDateUtc(DateTime.makeUnsafe(blockTime * 1_000))

const makeRawRecord = ({
  walletAddress,
  entry,
}: {
  readonly walletAddress: string
  readonly entry: DecodedHeliusSolanaTransactionEntry
}): ProviderRawRecord =>
  ProviderRawRecord.make({
    providerKey: HELIUS_SOLANA_PROVIDER_KEY,
    recordType: HELIUS_SOLANA_RECORD_TYPE_TRANSACTION_FULL,
    externalRecordId: entry.signature,
    externalAccountId: walletAddress,
    externalParentId: null,
    occurredAt: occurredAtFromBlockTime(entry.blockTime),
    payload: entry.payload,
  })

const maxOccurredAt = (records: ReadonlyArray<ProviderRawRecord>): Date | null =>
  records.reduce<Date | null>(
    (current, record) => Timestamp.maxNullableDate(current, record.occurredAt),
    null
  )

interface IncrementalBoundaryScanResult {
  readonly records: ReadonlyArray<ProviderRawRecord>
  readonly reachedBoundary: boolean
}

const inactiveCursorPayload = (paginationToken: string | null): HeliusSolanaCursorPayload => ({
  paginationToken,
  resumeBoundaryActive: false,
  resumeCheckpointExternalId: null,
  resumeHighWatermark: null,
  walletTransferCursor: null,
  walletTransferExhausted: false,
  pendingWalletTransfers: [],
})

const makeNextCursorPayload = ({
  paginationToken,
  isIncrementalBoundaryScan,
  reachedBoundary,
  resumeHighWatermark,
  resumeCheckpointExternalId,
  walletTransferCursor,
  walletTransferExhausted,
  pendingWalletTransfers,
}: {
  readonly paginationToken: string | null
  readonly isIncrementalBoundaryScan: boolean
  readonly reachedBoundary: boolean
  readonly resumeHighWatermark: Date | null
  readonly resumeCheckpointExternalId: string | null
  readonly walletTransferCursor: string | null
  readonly walletTransferExhausted: boolean
  readonly pendingWalletTransfers: ReadonlyArray<HeliusSolanaWalletTransfer>
}): HeliusSolanaCursorPayload => {
  if (reachedBoundary || paginationToken === null) {
    return inactiveCursorPayload(null)
  }

  if (isIncrementalBoundaryScan && resumeHighWatermark !== null) {
    return {
      paginationToken,
      resumeBoundaryActive: true,
      resumeCheckpointExternalId,
      resumeHighWatermark,
      walletTransferCursor,
      walletTransferExhausted,
      pendingWalletTransfers,
    }
  }

  return {
    paginationToken,
    resumeBoundaryActive: false,
    resumeCheckpointExternalId: null,
    resumeHighWatermark: null,
    walletTransferCursor,
    walletTransferExhausted,
    pendingWalletTransfers,
  }
}

const scanIncrementalBoundary = ({
  records,
  resumeHighWatermark,
  resumeCheckpointExternalId,
}: {
  readonly records: ReadonlyArray<ProviderRawRecord>
  readonly resumeHighWatermark: Date
  readonly resumeCheckpointExternalId: string | null
}): IncrementalBoundaryScanResult => {
  const watermark = Timestamp.fromDate(resumeHighWatermark)
  const boundaryIndex = records.findIndex((record) => {
    const occurredAt = Timestamp.fromDate(record.occurredAt)
    const isAtWatermark = Timestamp.equals(occurredAt, watermark)

    return (
      Timestamp.isBefore(occurredAt, watermark) ||
      (isAtWatermark &&
        resumeCheckpointExternalId !== null &&
        record.externalRecordId === resumeCheckpointExternalId)
    )
  })

  return {
    records: boundaryIndex === -1 ? records : records.slice(0, boundaryIndex),
    reachedBoundary: boundaryIndex !== -1,
  }
}

const toSharedCursorDecodeError = (error: HeliusSolanaCursorDecodeError) =>
  new SourceSyncCursorDecodeError({
    providerKey: HELIUS_SOLANA_PROVIDER_KEY,
    message: error.message,
  })

const toProviderFailureError = (
  error: HeliusSolanaSyncClientError | HeliusSolanaPayloadDecodeError
): SourceSyncProviderFailureError => {
  if (Schema.is(HeliusSolanaAuthError)(error)) {
    return new SourceSyncProviderFailureError({
      providerKey: HELIUS_SOLANA_PROVIDER_KEY,
      message: error.message,
      retryable: false,
    })
  }

  if (Schema.is(HeliusSolanaProviderError)(error)) {
    return new SourceSyncProviderFailureError({
      providerKey: HELIUS_SOLANA_PROVIDER_KEY,
      message: error.message,
      retryable: error.retryable,
    })
  }

  return new SourceSyncProviderFailureError({
    providerKey: HELIUS_SOLANA_PROVIDER_KEY,
    message: error.message,
    retryable: false,
  })
}

const isRetryableFailure = (error: SourceSyncProviderError): boolean =>
  error._tag === "SourceSyncProviderFailureError" && error.retryable

const toReferenceRefreshStorageError = (cause: unknown): SyncEngineStorageError =>
  Schema.is(SyncEngineStorageError)(cause)
    ? cause
    : new SyncEngineStorageError({
        operation: "heliusSolanaSourceSyncProvider.refreshReferenceData",
        cause,
      })

const toNormalizationDecodeError = (message: string, cause?: unknown) =>
  cause === undefined
    ? new HeliusSolanaNormalizationDecodeError({ message })
    : new HeliusSolanaNormalizationDecodeError({ message, cause })

const accountKeyAddress = (accountKey: HeliusSolanaAccountKey): string =>
  typeof accountKey === "string" ? accountKey : accountKey.pubkey

const lamportsToSol = (lamports: bigint): string => {
  const sign = lamports < 0n ? "-" : ""
  const absolute = lamports < 0n ? -lamports : lamports
  const whole = absolute / 1_000_000_000n
  const fractional = String(absolute % 1_000_000_000n)
    .padStart(9, "0")
    .replace(/0+$/, "")
  return fractional === "" ? `${sign}${whole}` : `${sign}${whole}.${fractional}`
}

const rawTokenAmountToDecimal = ({
  amount,
  decimals,
}: {
  readonly amount: string
  readonly decimals: number
}) => {
  const raw = BigInt(amount)
  const sign = raw < 0n ? "-" : ""
  const absolute = raw < 0n ? -raw : raw
  const divisor = 10n ** BigInt(decimals)
  const whole = absolute / divisor
  const fractional = String(absolute % divisor)
    .padStart(decimals, "0")
    .replace(/0+$/, "")
  return fractional === "" ? `${sign}${whole}` : `${sign}${whole}.${fractional}`
}

const isDecimalZero = (amount: string): boolean =>
  Option.match(BigDecimal.fromString(amount), {
    onNone: () => false,
    onSome: BigDecimal.isZero,
  })

const decimalAmountToExactRawUnits = ({
  amount,
  decimals,
}: {
  readonly amount: string
  readonly decimals: number
}): string | null =>
  Option.match(BigDecimal.fromString(amount), {
    onNone: () => null,
    onSome: (decimal) => {
      const rawUnits = BigDecimal.scale(decimal, decimals).value.toString()
      const roundTripAmount = rawTokenAmountToDecimal({ amount: rawUnits, decimals })
      return movementAmountStringsEqual(amount, roundTripAmount) ? rawUnits : null
    },
  })

const movementAmountStringsEqual = (left: string, right: string): boolean => {
  const leftAmount = BigDecimal.fromString(left)
  const rightAmount = BigDecimal.fromString(right)
  return (
    Option.isSome(leftAmount) &&
    Option.isSome(rightAmount) &&
    BigDecimal.equals(leftAmount.value, rightAmount.value)
  )
}

const subtractBigIntStrings = (left: string, right: string): bigint => BigInt(left) - BigInt(right)

const signedWalletTransferRawAmount = (transfer: HeliusSolanaWalletTransfer): bigint | null => {
  if (!/^\d+$/.test(transfer.amountRaw)) {
    return null
  }

  const amount = BigInt(transfer.amountRaw)
  return transfer.direction === "in" ? amount : -amount
}

const findUniqueWalletTransferSubset = ({
  candidateTransfers,
  targetRawAmount,
  expectedDecimals,
}: {
  readonly candidateTransfers: ReadonlyArray<HeliusSolanaWalletTransfer>
  readonly targetRawAmount: bigint
  readonly expectedDecimals: number | null
}): ReadonlyArray<HeliusSolanaWalletTransfer> | null => {
  if (candidateTransfers.length > 20) {
    return null
  }

  const signedAmounts: Array<bigint> = []
  for (const transfer of candidateTransfers) {
    const amount = signedWalletTransferRawAmount(transfer)
    if (amount === null || transfer.decimals !== expectedDecimals) {
      return null
    }

    signedAmounts.push(amount)
  }

  const remainingBounds: Array<{ readonly minimum: bigint; readonly maximum: bigint }> = [
    { minimum: 0n, maximum: 0n },
  ]
  for (let index = signedAmounts.length - 1; index >= 0; index -= 1) {
    const amount = signedAmounts[index]
    const nextBounds = remainingBounds[0]
    if (amount === undefined || nextBounds === undefined) {
      return null
    }

    remainingBounds.unshift({
      minimum: nextBounds.minimum + (amount < 0n ? amount : 0n),
      maximum: nextBounds.maximum + (amount > 0n ? amount : 0n),
    })
  }

  let visitedStates = 0
  const searchState: {
    limitReached: boolean
    uniqueSelection: ReadonlyArray<number> | null
    multipleSelectionsFound: boolean
  } = {
    limitReached: false,
    uniqueSelection: null,
    multipleSelectionsFound: false,
  }
  const selectedIndexes: Array<number> = []

  const visit = (index: number, total: bigint): void => {
    if (searchState.limitReached || searchState.multipleSelectionsFound) {
      return
    }
    if (visitedStates >= MAX_NATIVE_SUBSET_SEARCH_STATES) {
      searchState.limitReached = true
      return
    }
    visitedStates += 1

    const bounds = remainingBounds[index]
    if (
      bounds === undefined ||
      targetRawAmount < total + bounds.minimum ||
      targetRawAmount > total + bounds.maximum
    ) {
      return
    }

    if (index === signedAmounts.length) {
      if (total === targetRawAmount) {
        if (searchState.uniqueSelection === null) {
          searchState.uniqueSelection = [...selectedIndexes]
        } else {
          searchState.multipleSelectionsFound = true
        }
      }
      return
    }

    visit(index + 1, total)

    const amount = signedAmounts[index]
    if (amount === undefined || searchState.limitReached || searchState.multipleSelectionsFound) {
      return
    }
    selectedIndexes.push(index)
    visit(index + 1, total + amount)
    selectedIndexes.pop()
  }

  visit(0, 0n)

  const uniqueSelection = searchState.uniqueSelection
  if (searchState.limitReached || searchState.multipleSelectionsFound || uniqueSelection === null) {
    return null
  }

  return uniqueSelection
    .map((index) => candidateTransfers[index])
    .filter((row) => row !== undefined)
}

const matchExplicitWrappedSolRows = ({
  transfers,
  payload,
  walletAddress,
}: {
  readonly transfers: ReadonlyArray<HeliusSolanaWalletTransfer>
  readonly payload: HeliusSolanaFullTransactionPayload
  readonly walletAddress: string
}): Set<HeliusSolanaWalletTransfer> => {
  const matchedRows = new Set<HeliusSolanaWalletTransfer>()
  const explicitWrappedSolTransfers = (payload.tokenTransfers ?? []).filter(
    (transfer) => transfer.mint === SOLANA_WRAPPED_NATIVE_MINT
  )

  for (const parsedTransfer of explicitWrappedSolTransfers) {
    const tokenAmount = parsedTransfer.tokenAmount
    const fromAddress = parsedTransfer.fromUserAccount ?? parsedTransfer.fromTokenAccount ?? null
    const toAddress = parsedTransfer.toUserAccount ?? parsedTransfer.toTokenAccount ?? null
    const direction =
      toAddress === walletAddress ? "in" : fromAddress === walletAddress ? "out" : null
    const counterparty =
      direction === "in"
        ? (parsedTransfer.fromUserAccount ?? null)
        : direction === "out"
          ? (parsedTransfer.toUserAccount ?? null)
          : null
    if (tokenAmount === undefined || direction === null) {
      continue
    }

    const matchingRow = transfers.find(
      (row) =>
        !matchedRows.has(row) &&
        row.direction === direction &&
        /^\d+$/.test(row.amountRaw) &&
        (counterparty === null || row.counterparty === counterparty) &&
        movementAmountStringsEqual(
          rawTokenAmountToDecimal({ amount: row.amountRaw, decimals: row.decimals }),
          tokenAmount
        )
    )
    if (matchingRow !== undefined) {
      matchedRows.add(matchingRow)
    }
  }

  return matchedRows
}

const matchWrappedSolBalanceRows = ({
  transfers,
  payload,
  walletAddress,
  matchedRows,
}: {
  readonly transfers: ReadonlyArray<HeliusSolanaWalletTransfer>
  readonly payload: HeliusSolanaFullTransactionPayload
  readonly walletAddress: string
  readonly matchedRows: Set<HeliusSolanaWalletTransfer>
}): void => {
  const preWrappedBalances = (payload.meta?.preTokenBalances ?? []).filter(
    (balance) => balance.mint === SOLANA_WRAPPED_NATIVE_MINT
  )
  const postWrappedBalances = (payload.meta?.postTokenBalances ?? []).filter(
    (balance) => balance.mint === SOLANA_WRAPPED_NATIVE_MINT
  )
  const wrappedBalanceKey = (balance: HeliusSolanaTokenBalance) =>
    `${balance.accountIndex}:${balance.mint}`
  const preWrappedByKey = new Map(
    preWrappedBalances.map((balance) => [wrappedBalanceKey(balance), balance])
  )
  const postWrappedByKey = new Map(
    postWrappedBalances.map((balance) => [wrappedBalanceKey(balance), balance])
  )
  const wrappedBalanceKeys = new Set([...preWrappedByKey.keys(), ...postWrappedByKey.keys()])

  for (const key of wrappedBalanceKeys) {
    const pre = preWrappedByKey.get(key)
    const post = postWrappedByKey.get(key)
    const balance = post ?? pre
    const owner = post?.owner ?? pre?.owner ?? null
    if (balance === undefined || owner !== walletAddress) {
      continue
    }

    const delta = subtractBigIntStrings(
      post?.uiTokenAmount.amount ?? "0",
      pre?.uiTokenAmount.amount ?? "0"
    )
    if (delta === 0n) {
      continue
    }

    const matchingRows = findUniqueWalletTransferSubset({
      candidateTransfers: transfers.filter((transfer) => !matchedRows.has(transfer)),
      targetRawAmount: delta,
      expectedDecimals: balance.uiTokenAmount.decimals,
    })
    matchingRows?.forEach((row) => matchedRows.add(row))
  }
}

const buildRefinedNativeMovements = ({
  transfers,
  nativeMovement,
  nativeAsset,
  walletAddress,
}: {
  readonly transfers: ReadonlyArray<HeliusSolanaWalletTransfer>
  readonly nativeMovement: SolanaBalanceMovement
  readonly nativeAsset: HeliusSolanaResolvedAsset
  readonly walletAddress: string
}): ReadonlyArray<SolanaBalanceMovement> =>
  transfers.map((transfer) => {
    const direction = transfer.direction === "in" ? "inbound" : "outbound"

    return {
      asset: nativeAsset,
      amount: rawTokenAmountToDecimal({
        amount: transfer.amountRaw,
        decimals: transfer.decimals,
      }),
      rawUnits: transfer.amountRaw,
      observedDecimals: transfer.decimals,
      matchCounterparty: transfer.counterparty,
      direction,
      fromAddress: direction === "inbound" ? transfer.counterparty : walletAddress,
      toAddress: direction === "inbound" ? walletAddress : transfer.counterparty,
      role: nativeMovement.role,
      componentKey: null,
      position: 0,
      evidenceKind: "transfer_row",
      supplementalTransferRow: transfer,
    }
  })

const stableMapping = (transactionType: string | null): ResolvedProviderTransactionTypeMapping => ({
  providerTransactionType: transactionType ?? "unknown",
  transactionType,
  inventoryEffect: transactionType === "gas_fee" ? "non_inventory" : "unknown",
  taxTreatment: "requires_additional_rule_logic",
  resolutionStrategy: "no_leg",
  pairedRecordRequired: false,
  mappingStatus: transactionType === null ? "pending_review" : "approved",
})

const buildReview = ({
  principalId,
  reason,
  matchedLayer,
}: {
  readonly principalId: string
  readonly reason: string
  readonly matchedLayer: string
}): SourceTransactionReviewDraft => ({
  principalId,
  reviewStatus: "needs_review",
  originalTypeKey: "unknown",
  originalConfidence: "0.40",
  currentTypeKey: "unknown",
  legalRuleSetVersion: null,
  categorizationReason: reason,
  matchedLayer,
  needsReview: true,
  userNotes: null,
  reviewedAt: null,
})

const toProviderTransactionType = (payload: HeliusSolanaFullTransactionPayload): string =>
  payload.meta?.err === null ? (payload.type ?? payload.source ?? "solana_transaction") : "failed"

const firstSignerOrFallback = ({
  payload,
  fallback,
}: {
  readonly payload: HeliusSolanaFullTransactionPayload
  readonly fallback: string
}): string => {
  const signer = payload.transaction.message.accountKeys.find(
    (accountKey) => typeof accountKey !== "string" && accountKey.signer === true
  )
  if (signer !== undefined) {
    return accountKeyAddress(signer)
  }

  const feePayer = payload.transaction.message.accountKeys[0]
  return feePayer === undefined ? fallback : accountKeyAddress(feePayer)
}

const inferCounterparty = ({
  direction,
  walletAddress,
  accountKeys,
}: {
  readonly direction: "inbound" | "outbound"
  readonly walletAddress: string
  readonly accountKeys: ReadonlyArray<HeliusSolanaAccountKey>
}): string => {
  const other = accountKeys.map(accountKeyAddress).find((address) => address !== walletAddress)
  if (other !== undefined) {
    return other
  }
  return direction === "inbound" ? "solana:unknown_sender" : "solana:unknown_recipient"
}

const isTokenProgramInstruction = (instruction: HeliusSolanaInstruction): boolean =>
  (instruction.program !== undefined && SOLANA_TOKEN_PROGRAM_NAMES.has(instruction.program)) ||
  (instruction.programId !== undefined && SOLANA_TOKEN_PROGRAM_IDS.has(instruction.programId))

const isTokenAccountCloseInstruction = (instruction: HeliusSolanaInstruction): boolean =>
  isTokenProgramInstruction(instruction) &&
  Option.isSome(decodeCloseAccountParsedInstruction(instruction.parsed))

const hasTokenAccountCloseInstruction = (payload: HeliusSolanaFullTransactionPayload): boolean =>
  [
    ...(payload.transaction.message.instructions ?? []),
    ...(payload.meta?.innerInstructions ?? []).flatMap((entry) => entry.instructions),
  ].some(isTokenAccountCloseInstruction)

const canonicalMovementExternalId = (signature: string, movement: SolanaBalanceMovement): string =>
  movement.componentKey === null
    ? `${signature}:unidentified:${movement.evidenceKind}:${movement.position}`
    : `${signature}:component:${movement.componentKey}`

const buildTransferDraft = ({
  source,
  sourceRecord,
  blockchainId,
  movement,
  signature,
  timestamp,
}: {
  readonly source: {
    readonly id: string
    readonly principalId: string
    readonly addressId: string | null
  }
  readonly sourceRecord: { readonly id: string }
  readonly blockchainId: string
  readonly movement: SolanaBalanceMovement
  readonly signature: string
  readonly timestamp: Date
}): SourceTransferDraft | null => {
  if (movement.asset.canonicalAssetId === null || source.addressId === null) {
    return null
  }

  const assetId = movement.asset.canonicalAssetId

  return {
    sourceId: source.id,
    principalId: source.principalId,
    sourceRawRecordId: sourceRecord.id,
    externalId: canonicalMovementExternalId(signature, movement),
    externalGroupId: signature,
    addressId: source.addressId,
    blockchainId,
    txHash: signature,
    timestamp,
    type:
      movement.role === "fee" ? "fee" : movement.asset.assetKind === "native" ? "native" : "spl",
    fromAddress: movement.fromAddress,
    toAddress: movement.toAddress,
    fromAccountRef: null,
    toAccountRef: null,
    fromPartyType: "address",
    fromPartyResourcePath: null,
    toPartyType: "address",
    toPartyResourcePath: null,
    assetId,
    assetRepresentationId: movement.asset.assetRepresentationId,
    providerAssetRowId: movement.asset.providerAssetRowId,
    amount: movement.amount,
    tokenId: null,
    notes: movement.role === "rent" ? "Solana account close or rent refund balance effect" : null,
    metadata: {
      provider: HELIUS_SOLANA_PROVIDER_KEY,
      role: movement.role,
      evidenceKind: movement.evidenceKind,
      rawUnits: movement.rawUnits,
      mintAddress: movement.asset.mintAddress,
      supplementalTransferRow: movement.supplementalTransferRow,
    },
  }
}

const buildLegPlan = ({
  movement,
  signature,
}: {
  readonly movement: SolanaBalanceMovement
  readonly signature: string
}): HeliusSolanaCanonicalLegPlan => ({
  movementIdentity:
    movement.componentKey === null
      ? { _tag: "unavailable", reason: movement.identityIssue ?? "missing_movement_identity" }
      : { _tag: "identified", sourceRecordKey: signature, componentKey: movement.componentKey },
  transferExternalId: canonicalMovementExternalId(signature, movement),
  kind:
    movement.role === "fee" ? "fee" : movement.direction === "inbound" ? "acquisition" : "disposal",
  role: movement.role,
  derivationRule:
    movement.role === "fee"
      ? "helius_solana_fee"
      : movement.role === "rent"
        ? "helius_solana_rent_refund"
        : movement.direction === "inbound"
          ? "helius_solana_inbound"
          : "helius_solana_outbound",
})

const buildProviderTransferDraft = ({
  sourceId,
  sourceRawRecordId,
  blockchainId,
  signature,
  timestamp,
  movement,
  externalId,
  canonicalTransferExternalId,
  processingMode,
  observedRepresentationIdentityKnown,
}: {
  readonly sourceId: string
  readonly sourceRawRecordId: string
  readonly blockchainId: string
  readonly signature: string
  readonly timestamp: Date
  readonly movement: SolanaBalanceMovement
  readonly externalId: string
  readonly canonicalTransferExternalId: string | null
  readonly processingMode: SourceProviderTransferDraft["processingMode"]
  readonly observedRepresentationIdentityKnown: boolean
}): SourceProviderTransferDraft => ({
  sourceId,
  sourceRawRecordId,
  externalId,
  externalGroupId: signature,
  providerAssetId: movement.asset.providerAssetRowId,
  timestamp,
  direction: movement.direction,
  processingMode,
  fromAccountRef: null,
  toAccountRef: null,
  fromAddress: movement.fromAddress,
  toAddress: movement.toAddress,
  networkName: SOLANA_BLOCKCHAIN_NAME,
  networkHash: signature,
  observedBlockchainId:
    processingMode === "accounting_only" || !observedRepresentationIdentityKnown
      ? null
      : blockchainId,
  observedRepresentationType:
    processingMode === "accounting_only" ||
    !observedRepresentationIdentityKnown ||
    movement.asset.representationTypeObserved !== true
      ? null
      : movement.asset.assetKind,
  observedContractAddress: null,
  observedMintAddress:
    processingMode === "accounting_only" || !observedRepresentationIdentityKnown
      ? null
      : movement.asset.mintAddress,
  observedDecimals:
    processingMode === "accounting_only" || !observedRepresentationIdentityKnown
      ? null
      : movement.observedDecimals,
  amount: movement.amount,
  metadata: {
    provider: HELIUS_SOLANA_PROVIDER_KEY,
    role: movement.role,
    canonicalTransferExternalId,
    evidenceKind: movement.evidenceKind,
    rawUnits: movement.rawUnits,
    mintAddress: movement.asset.mintAddress,
    supplementalTransferRow: movement.supplementalTransferRow,
  },
})

const resolveWalletAddress = ({
  sourceId,
  sourceWalletAddress,
  sourceRecordExternalAccountId,
}: {
  readonly sourceId: string
  readonly sourceWalletAddress: string | null
  readonly sourceRecordExternalAccountId: string | null
}) => {
  const walletAddress = sourceWalletAddress ?? sourceRecordExternalAccountId

  if (walletAddress === null || walletAddress.trim() === "") {
    return Effect.fail(
      new HeliusSolanaNormalizationReferenceError({
        message: `Solana source ${sourceId} has no wallet address for normalization.`,
      })
    )
  }

  return Effect.succeed(walletAddress)
}

const requirePayloadSignature = (payload: HeliusSolanaFullTransactionPayload) => {
  const signature = payload.transaction.signatures[0]

  if (signature === undefined || signature.trim() === "") {
    return Effect.fail(
      toNormalizationDecodeError(
        "Invalid Helius Solana full transaction payload: missing signature"
      )
    )
  }

  return Effect.succeed(signature)
}

const timestampFromPayload = ({
  payload,
  fallback,
}: {
  readonly payload: HeliusSolanaFullTransactionPayload
  readonly fallback: Date
}): Date => {
  if (payload.blockTime === null) {
    return fallback
  }

  return occurredAtFromBlockTime(payload.blockTime)
}

const collectSplTokenMints = ({
  payload,
  walletTransferEvidence,
}: {
  readonly payload: HeliusSolanaFullTransactionPayload
  readonly walletTransferEvidence: ReadonlyArray<HeliusSolanaWalletTransfer>
}): ReadonlyArray<string> =>
  Array.from(
    new Set([
      ...(payload.meta?.preTokenBalances ?? []).map((balance) => balance.mint),
      ...(payload.meta?.postTokenBalances ?? []).map((balance) => balance.mint),
      ...(payload.tokenTransfers ?? []).flatMap((transfer) =>
        transfer.mint === undefined ? [] : [transfer.mint]
      ),
      ...walletTransferEvidence.map((transfer) => transfer.mint),
    ])
  ).filter((mintAddress) => mintAddress !== HELIUS_NATIVE_SOL_PSEUDO_MINT)

const collectObservedSplDecimals = ({
  payload,
  walletTransferEvidence,
}: {
  readonly payload: HeliusSolanaFullTransactionPayload
  readonly walletTransferEvidence: ReadonlyArray<HeliusSolanaWalletTransfer>
}): ReadonlyMap<string, number | null> => {
  const decimalsByMint = new Map<string, number | null>()
  const observations = [
    ...(payload.meta?.preTokenBalances ?? []).map((balance) => ({
      mintAddress: balance.mint,
      decimals: balance.uiTokenAmount.decimals,
    })),
    ...(payload.meta?.postTokenBalances ?? []).map((balance) => ({
      mintAddress: balance.mint,
      decimals: balance.uiTokenAmount.decimals,
    })),
    ...walletTransferEvidence.map((transfer) => ({
      mintAddress: transfer.mint,
      decimals: transfer.decimals,
    })),
  ]

  for (const observation of observations) {
    const current = decimalsByMint.get(observation.mintAddress)
    if (current === undefined) {
      decimalsByMint.set(observation.mintAddress, observation.decimals)
    } else if (current !== observation.decimals) {
      decimalsByMint.set(observation.mintAddress, null)
    }
  }

  return decimalsByMint
}

const mapAssetsByMint = (
  requestedMints: ReadonlyArray<string>,
  resolvedTokens: ReadonlyArray<HeliusSolanaResolvedAsset>
): ReadonlyMap<string, HeliusSolanaResolvedAsset> =>
  new Map(
    requestedMints.flatMap((mintAddress, index) => {
      const asset = resolvedTokens[index]
      return asset === undefined ? [] : [[mintAddress, asset]]
    })
  )

const make = ({
  refreshReferenceData,
}: {
  readonly refreshReferenceData: HeliusSolanaSourceSyncProviderShape["refreshReferenceData"]
}) =>
  Effect.gen(function* () {
    const heliusSyncClient = yield* HeliusSolanaSyncClient
    const assetRepository = yield* AssetRepository
    const assetResolutionService = yield* HeliusSolanaAssetResolutionService

    const cacheWalletTransferEvidenceForRawBatch = ({
      walletAddress,
      records,
      cursor,
    }: {
      readonly walletAddress: string
      readonly records: ReadonlyArray<ProviderRawRecord>
      readonly cursor: HeliusSolanaCursorPayload
    }) =>
      Effect.gen(function* () {
        if (records.length === 0) {
          return {
            records,
            walletTransferCursor: cursor.walletTransferCursor,
            walletTransferExhausted: cursor.walletTransferExhausted,
            pendingWalletTransfers: cursor.pendingWalletTransfers,
          }
        }

        const signatures = new Set(records.map((record) => record.externalRecordId))
        const oldestOccurredAt = records.reduce(
          (oldest, record) => Math.min(oldest, Math.floor(record.occurredAt.getTime() / 1_000)),
          Number.POSITIVE_INFINITY
        )
        const availableTransfers = [...cursor.pendingWalletTransfers]
        let nextCursor = cursor.walletTransferCursor
        let exhausted = cursor.walletTransferExhausted
        const visitedCursors = new Set(nextCursor === null ? [] : [nextCursor])
        let lastPageMatchedCurrentBatch = availableTransfers.some((transfer) =>
          signatures.has(transfer.signature)
        )
        const hasCrossedBatchBoundary = () =>
          availableTransfers.some((transfer) => transfer.timestamp < oldestOccurredAt)

        while (!exhausted && (!hasCrossedBatchBoundary() || lastPageMatchedCurrentBatch)) {
          const page = yield* heliusSyncClient
            .fetchTransfersForAddress({
              walletAddress,
              limit: 100,
              cursor: nextCursor,
            })
            .pipe(
              Effect.mapError(toProviderFailureError),
              Effect.flatMap((payload) =>
                decodeUnknownWalletTransfersPage(payload).pipe(
                  Effect.mapError((cause) =>
                    toProviderFailureError(
                      toPayloadDecodeError(
                        `Invalid Helius Solana wallet transfers page: ${cause.message}`,
                        cause
                      )
                    )
                  )
                )
              )
            )

          lastPageMatchedCurrentBatch = page.data.some((transfer) =>
            signatures.has(transfer.signature)
          )
          availableTransfers.push(...page.data)

          if (!page.pagination.hasMore) {
            exhausted = true
            nextCursor = null
            continue
          }

          const continuationCursor = page.pagination.nextCursor
          if (continuationCursor === null || continuationCursor === undefined) {
            return yield* toProviderFailureError(
              toPayloadDecodeError(
                "Helius Solana wallet transfer evidence pagination had no continuation cursor."
              )
            )
          }
          if (visitedCursors.has(continuationCursor)) {
            return yield* toProviderFailureError(
              toPayloadDecodeError(
                "Helius Solana wallet transfer evidence pagination repeated a cursor."
              )
            )
          }

          visitedCursors.add(continuationCursor)
          nextCursor = continuationCursor
        }

        const transfersBySignature = new Map<string, Array<HeliusSolanaWalletTransfer>>()
        for (const transfer of availableTransfers) {
          if (!signatures.has(transfer.signature)) {
            continue
          }

          const current = transfersBySignature.get(transfer.signature) ?? []
          current.push(transfer)
          transfersBySignature.set(transfer.signature, current)
        }

        const cachedRecords = records.map((record) =>
          ProviderRawRecord.make({
            recordType: record.recordType,
            providerKey: record.providerKey,
            externalRecordId: record.externalRecordId,
            externalAccountId: record.externalAccountId,
            externalParentId: record.externalParentId,
            occurredAt: record.occurredAt,
            payload: {
              fullTransaction: record.payload,
              walletTransferEvidence: transfersBySignature.get(record.externalRecordId) ?? [],
            },
          })
        )
        const pendingWalletTransfers = availableTransfers.filter(
          (transfer) =>
            !signatures.has(transfer.signature) && transfer.timestamp <= oldestOccurredAt
        )

        return {
          records: cachedRecords,
          walletTransferCursor: nextCursor,
          walletTransferExhausted: exhausted,
          pendingWalletTransfers,
        }
      })

    const fetchHeliusRawBatch = ({
      sourceId,
      walletAddress,
      cursorPayload,
      resumeHighWatermark,
      resumeCheckpointExternalId,
      pageSize,
    }: {
      readonly sourceId: string
      readonly walletAddress: string | null
      readonly cursorPayload: unknown
      readonly resumeHighWatermark: Date | null
      readonly resumeCheckpointExternalId: string | null
      readonly pageSize: number
    }) =>
      Effect.gen(function* () {
        const cursor = yield* decodeCursorPayload(cursorPayload).pipe(
          Effect.mapError(toSharedCursorDecodeError)
        )

        if (walletAddress === null || walletAddress.trim() === "") {
          return yield* new SourceSyncProviderFailureError({
            providerKey: HELIUS_SOLANA_PROVIDER_KEY,
            message: `Helius Solana source ${sourceId} has no wallet address`,
            retryable: false,
          })
        }

        const page = yield* heliusSyncClient
          .fetchTransactionsForAddress({
            walletAddress,
            config: {
              limit: pageSize,
              paginationToken: cursor.paginationToken,
              transactionDetails: "full",
              sortOrder: "desc",
              filters: {
                status: "any",
                tokenAccounts: "balanceChanged",
              },
            },
          })
          .pipe(Effect.mapError(toProviderFailureError))

        const decodedPage = yield* decodeTransactionsPage(page).pipe(
          Effect.mapError(toProviderFailureError)
        )
        const entries = yield* Effect.forEach(decodedPage.data, decodeTransactionEntry).pipe(
          Effect.mapError(toProviderFailureError)
        )
        const records = entries.map((entry) => makeRawRecord({ walletAddress, entry }))
        const activeResumeHighWatermark = cursor.resumeHighWatermark ?? resumeHighWatermark
        const activeResumeCheckpointExternalId =
          cursor.resumeCheckpointExternalId ?? resumeCheckpointExternalId
        const isIncrementalBoundaryScan =
          activeResumeHighWatermark !== null &&
          (cursor.resumeBoundaryActive || cursor.paginationToken === null)
        const boundaryScan = isIncrementalBoundaryScan
          ? scanIncrementalBoundary({
              records,
              resumeHighWatermark: activeResumeHighWatermark,
              resumeCheckpointExternalId: activeResumeCheckpointExternalId,
            })
          : {
              records,
              reachedBoundary: false,
            }
        const filteredRecords = boundaryScan.records
        const cachedBatch = yield* cacheWalletTransferEvidenceForRawBatch({
          walletAddress,
          records: filteredRecords,
          cursor,
        })
        const nextCursor = makeNextCursorPayload({
          paginationToken: decodedPage.paginationToken,
          isIncrementalBoundaryScan,
          reachedBoundary: boundaryScan.reachedBoundary,
          resumeHighWatermark: activeResumeHighWatermark,
          resumeCheckpointExternalId: activeResumeCheckpointExternalId,
          walletTransferCursor: cachedBatch.walletTransferCursor,
          walletTransferExhausted: cachedBatch.walletTransferExhausted,
          pendingWalletTransfers: cachedBatch.pendingWalletTransfers,
        })

        yield* Effect.logInfo(
          {
            sourceId,
            provider: HELIUS_SOLANA_PROVIDER_KEY,
            pageSize,
            hasPaginationToken: cursor.paginationToken !== null,
            resumeBoundaryActive: isIncrementalBoundaryScan,
            reachedResumeBoundary: boundaryScan.reachedBoundary,
            recordCount: cachedBatch.records.length,
            retryable: false,
          },
          "helius-solana:raw-batch"
        )

        return FetchProviderRawBatchResult.make({
          records: cachedBatch.records,
          cursorPayload: encodeCursorPayload(nextCursor),
          highWatermark: maxOccurredAt(cachedBatch.records),
          done: boundaryScan.reachedBoundary || decodedPage.paginationToken === null,
        })
      })

    const fetchRawBatch: HeliusSolanaSourceSyncProviderShape["fetchRawBatch"] = (
      params: FetchProviderRawBatchParams
    ) => {
      if (params.providerKey !== HELIUS_SOLANA_PROVIDER_KEY) {
        return Effect.fail(new UnsupportedSyncProviderError({ providerKey: params.providerKey }))
      }

      return fetchHeliusRawBatch({
        sourceId: params.sourceId,
        walletAddress: params.walletAddress,
        cursorPayload: params.cursorPayload,
        resumeHighWatermark: params.resumeHighWatermark,
        resumeCheckpointExternalId: params.resumeCheckpointExternalId,
        pageSize: params.pageSize,
      }).pipe(
        Effect.tapError((error) =>
          Effect.logError(
            {
              sourceId: params.sourceId,
              provider: HELIUS_SOLANA_PROVIDER_KEY,
              pageSize: params.pageSize,
              hasPaginationToken:
                params.cursorPayload !== null && params.cursorPayload !== undefined,
              recordCount: 0,
              retryable: isRetryableFailure(error),
            },
            "helius-solana:raw-batch-failed"
          )
        )
      )
    }

    const loadNormalizationLookups: HeliusSolanaSourceSyncProviderShape["loadNormalizationLookups"] =
      assetRepository.listBlockchains.pipe(
        Effect.map((blockchains) => {
          const solana = blockchains.find(
            (blockchain) => blockchain.name.toLowerCase() === SOLANA_BLOCKCHAIN_NAME
          )
          return solana?.id ?? null
        }),
        Effect.map((solanaBlockchainId) => ({
          providerKey: HELIUS_SOLANA_PROVIDER_KEY,
          solanaBlockchainId,
        }))
      )

    const requireSolanaBlockchainId = (lookups: HeliusSolanaNormalizationLookups) =>
      lookups.solanaBlockchainId === null
        ? Effect.fail(
            new HeliusSolanaNormalizationReferenceError({
              message: "Missing seeded Solana blockchain row.",
            })
          )
        : Effect.succeed(lookups.solanaBlockchainId)

    const resolveNativeSol = assetResolutionService.resolveAsset({
      kind: "native",
      mintAddress: null,
    })

    const decodeNormalizationPayload = (
      payload: unknown
    ): Effect.Effect<HeliusSolanaRawRecordPayload, HeliusSolanaNormalizationDecodeError> =>
      decodeUnknownRawRecordPayload(payload).pipe(
        Effect.mapError((cause) =>
          toNormalizationDecodeError(
            `Invalid Helius Solana raw record payload: ${cause.message}`,
            cause
          )
        ),
        Effect.flatMap((decoded) => {
          const decimalsByBalance = new Map<string, number>()
          const balances = [
            ...(decoded.fullTransaction.meta?.preTokenBalances ?? []),
            ...(decoded.fullTransaction.meta?.postTokenBalances ?? []),
          ]

          for (const balance of balances) {
            const key = `${balance.accountIndex}:${balance.mint}`
            const priorDecimals = decimalsByBalance.get(key)
            if (priorDecimals !== undefined && priorDecimals !== balance.uiTokenAmount.decimals) {
              return Effect.fail(
                toNormalizationDecodeError(
                  "Conflicting Solana token decimals were observed for the same balance.",
                  {
                    accountIndex: balance.accountIndex,
                    mint: balance.mint,
                    priorDecimals,
                    observedDecimals: balance.uiTokenAmount.decimals,
                  }
                )
              )
            }
            decimalsByBalance.set(key, balance.uiTokenAmount.decimals)
          }

          return Effect.succeed(decoded)
        })
      )

    const buildSolMovements = ({
      payload,
      nativeAsset,
      walletAddress,
    }: {
      readonly payload: HeliusSolanaFullTransactionPayload
      readonly nativeAsset: HeliusSolanaResolvedAsset
      readonly walletAddress: string
    }): ReadonlyArray<SolanaBalanceMovement> => {
      const meta = payload.meta
      if (meta === null) {
        return []
      }

      const preBalances = meta.preBalances ?? []
      const postBalances = meta.postBalances ?? []
      const walletIndex = payload.transaction.message.accountKeys
        .map(accountKeyAddress)
        .findIndex((address) => address === walletAddress)
      const walletDelta =
        walletIndex === -1
          ? 0n
          : BigInt(postBalances[walletIndex] ?? 0) - BigInt(preBalances[walletIndex] ?? 0)
      const fee = BigInt(meta.fee ?? 0)
      const counterparty = inferCounterparty({
        direction: walletDelta >= 0n ? "inbound" : "outbound",
        walletAddress,
        accountKeys: payload.transaction.message.accountKeys,
      })
      const feePayer = firstSignerOrFallback({ payload, fallback: walletAddress })
      const principalDelta =
        meta.err === null && fee > 0n && feePayer === walletAddress
          ? walletDelta + fee
          : walletDelta
      const isRentRefund = principalDelta > 0n && hasTokenAccountCloseInstruction(payload)
      const transfers =
        meta.err === null && principalDelta !== 0n
          ? [
              {
                asset: nativeAsset,
                amount: lamportsToSol(principalDelta < 0n ? -principalDelta : principalDelta),
                rawUnits: String(principalDelta < 0n ? -principalDelta : principalDelta),
                observedDecimals: nativeAsset.decimals,
                matchCounterparty: null,
                direction: principalDelta > 0n ? "inbound" : "outbound",
                fromAddress: principalDelta > 0n ? counterparty : walletAddress,
                toAddress: principalDelta > 0n ? walletAddress : counterparty,
                role: isRentRefund ? "rent" : "principal",
                componentKey: `native_balance:${walletAddress}`,
                position: 0,
                evidenceKind: "balance_delta",
                supplementalTransferRow: null,
              } satisfies SolanaBalanceMovement,
            ]
          : []

      if (fee === 0n || feePayer !== walletAddress) {
        return transfers
      }

      return [
        ...transfers,
        {
          asset: nativeAsset,
          amount: lamportsToSol(fee),
          rawUnits: String(fee),
          observedDecimals: nativeAsset.decimals,
          matchCounterparty: null,
          direction: "outbound",
          fromAddress: walletAddress,
          toAddress: "solana:fee",
          role: "fee",
          componentKey: "meta.fee",
          position: 1,
          evidenceKind: "balance_delta",
          supplementalTransferRow: null,
        },
      ]
    }

    const refineNativeSolEvidence = ({
      transfers,
      nativeMovements,
      nativeAsset,
      walletAddress,
      payload,
    }: {
      readonly transfers: ReadonlyArray<HeliusSolanaWalletTransfer>
      readonly nativeMovements: ReadonlyArray<SolanaBalanceMovement>
      readonly nativeAsset: HeliusSolanaResolvedAsset
      readonly walletAddress: string
      readonly payload: HeliusSolanaFullTransactionPayload
    }): {
      readonly nativeMovements: ReadonlyArray<SolanaBalanceMovement>
      readonly splTransfers: ReadonlyArray<HeliusSolanaWalletTransfer>
      readonly ambiguousTransfers: ReadonlyArray<HeliusSolanaWalletTransfer>
    } => {
      const nativeMovement = nativeMovements.find(
        (movement) => movement.role !== "fee" && movement.asset.assetKind === "native"
      )
      const sentinelTransfers = transfers.filter(
        (transfer) =>
          transfer.mint === SOLANA_WRAPPED_NATIVE_MINT ||
          transfer.mint === HELIUS_NATIVE_SOL_PSEUDO_MINT
      )
      if (sentinelTransfers.length === 0) {
        return { nativeMovements, splTransfers: transfers, ambiguousTransfers: [] }
      }

      // Only wrapped-SOL rows can be explained by wrapped-SOL token evidence;
      // pseudo-mint rows are native lamport evidence and skip that matching.
      const wrappedSolSentinelTransfers = sentinelTransfers.filter(
        (transfer) => transfer.mint === SOLANA_WRAPPED_NATIVE_MINT
      )
      const matchedWrappedSolRows = matchExplicitWrappedSolRows({
        transfers: wrappedSolSentinelTransfers,
        payload,
        walletAddress,
      })
      const candidateTransfersBeforeBalanceEvidence = wrappedSolSentinelTransfers.filter(
        (transfer) => !matchedWrappedSolRows.has(transfer)
      )
      matchWrappedSolBalanceRows({
        transfers: candidateTransfersBeforeBalanceEvidence,
        payload,
        walletAddress,
        matchedRows: matchedWrappedSolRows,
      })

      const candidateNativeTransfers = sentinelTransfers.filter(
        (transfer) => !matchedWrappedSolRows.has(transfer)
      )
      if (nativeMovement === undefined) {
        return {
          nativeMovements,
          splTransfers: transfers.filter(
            (transfer) => !candidateNativeTransfers.includes(transfer)
          ),
          ambiguousTransfers: candidateNativeTransfers,
        }
      }

      const targetNativeRawAmount =
        BigInt(nativeMovement.rawUnits) * (nativeMovement.direction === "inbound" ? 1n : -1n)
      const nativeWalletTransfers = findUniqueWalletTransferSubset({
        candidateTransfers: candidateNativeTransfers,
        targetRawAmount: targetNativeRawAmount,
        expectedDecimals: nativeAsset.decimals,
      })

      if (nativeWalletTransfers === null) {
        return {
          nativeMovements,
          splTransfers: transfers.filter(
            (transfer) =>
              !candidateNativeTransfers.includes(transfer) || matchedWrappedSolRows.has(transfer)
          ),
          ambiguousTransfers: candidateNativeTransfers,
        }
      }

      // Pseudo-mint rows left over after native matching stay native evidence
      // for review; routing them into the SPL path would double-count lamports
      // already covered by the balance-delta movement.
      const leftoverPseudoMintTransfers = candidateNativeTransfers.filter(
        (transfer) =>
          transfer.mint === HELIUS_NATIVE_SOL_PSEUDO_MINT &&
          !nativeWalletTransfers.includes(transfer)
      )
      const splTransfers = transfers.filter(
        (transfer) =>
          !nativeWalletTransfers.includes(transfer) &&
          !leftoverPseudoMintTransfers.includes(transfer)
      )

      const refinedNativeMovements = buildRefinedNativeMovements({
        transfers: nativeWalletTransfers,
        nativeMovement,
        nativeAsset,
        walletAddress,
      })
      const remainingNativeMovements = nativeMovements.filter(
        (movement) => movement !== nativeMovement
      )

      return {
        nativeMovements: [...refinedNativeMovements, ...remainingNativeMovements].map(
          (movement, position) => ({ ...movement, position })
        ),
        splTransfers,
        ambiguousTransfers: leftoverPseudoMintTransfers,
      }
    }

    const balanceKey = (balance: HeliusSolanaTokenBalance): string =>
      `${balance.accountIndex}:${balance.mint}`

    const buildSplMovements = ({
      payload,
      walletAddress,
      assetsByMint,
      offset,
    }: {
      readonly payload: HeliusSolanaFullTransactionPayload
      readonly walletAddress: string
      readonly assetsByMint: ReadonlyMap<string, HeliusSolanaResolvedAsset>
      readonly offset: number
    }): ReadonlyArray<SolanaBalanceMovement> => {
      const meta = payload.meta
      if (meta === null || meta.err !== null) {
        return []
      }

      const preBalances = meta.preTokenBalances ?? []
      const postBalances = meta.postTokenBalances ?? []
      const preByKey = new Map(preBalances.map((balance) => [balanceKey(balance), balance]))
      const postByKey = new Map(postBalances.map((balance) => [balanceKey(balance), balance]))
      const keys = Array.from(new Set([...preByKey.keys(), ...postByKey.keys()]))

      return keys.flatMap((key, index) => {
        const pre = preByKey.get(key)
        const post = postByKey.get(key)
        const balance = post ?? pre
        if (balance === undefined) {
          return []
        }

        const owner = post?.owner ?? pre?.owner ?? null
        if (owner !== walletAddress) {
          return []
        }

        const delta = subtractBigIntStrings(
          post?.uiTokenAmount.amount ?? "0",
          pre?.uiTokenAmount.amount ?? "0"
        )
        if (delta === 0n) {
          return []
        }

        const asset = assetsByMint.get(balance.mint)
        if (asset === undefined) {
          return []
        }

        const componentIsAmbiguous =
          preBalances.filter((entry) => balanceKey(entry) === key).length > 1 ||
          postBalances.filter((entry) => balanceKey(entry) === key).length > 1
        const absoluteDelta = delta < 0n ? -delta : delta
        const direction = delta > 0n ? "inbound" : "outbound"
        const counterparty = inferCounterparty({
          direction,
          walletAddress,
          accountKeys: payload.transaction.message.accountKeys,
        })

        return [
          {
            asset,
            amount: rawTokenAmountToDecimal({
              amount: String(absoluteDelta),
              decimals: balance.uiTokenAmount.decimals,
            }),
            rawUnits: String(absoluteDelta),
            observedDecimals: balance.uiTokenAmount.decimals,
            matchCounterparty: null,
            direction,
            fromAddress: direction === "inbound" ? counterparty : walletAddress,
            toAddress: direction === "inbound" ? walletAddress : counterparty,
            role: "principal",
            componentKey: componentIsAmbiguous
              ? null
              : `token_balance:${balance.accountIndex}:${balance.mint}`,
            ...(componentIsAmbiguous
              ? { identityIssue: "ambiguous_movement_identity" as const }
              : {}),
            position: offset + index,
            evidenceKind: "token_balance_delta",
            supplementalTransferRow: null,
          } satisfies SolanaBalanceMovement,
        ]
      })
    }

    const buildParsedSplMovements = ({
      transfers,
      walletAddress,
      assetsByMint,
      offset,
    }: {
      readonly transfers: ReadonlyArray<HeliusSolanaParsedTokenTransfer>
      readonly walletAddress: string
      readonly assetsByMint: ReadonlyMap<string, HeliusSolanaResolvedAsset>
      readonly offset: number
    }): ReadonlyArray<SolanaBalanceMovement> =>
      transfers.flatMap((transfer, index) => {
        const mint = transfer.mint
        const tokenAmount = transfer.tokenAmount
        if (mint === undefined || tokenAmount === undefined || isDecimalZero(tokenAmount)) {
          return []
        }

        const asset = assetsByMint.get(mint)
        if (asset === undefined) {
          return []
        }

        const fromAddress = transfer.fromUserAccount ?? transfer.fromTokenAccount ?? null
        const toAddress = transfer.toUserAccount ?? transfer.toTokenAccount ?? null
        const direction =
          toAddress === walletAddress
            ? "inbound"
            : fromAddress === walletAddress
              ? "outbound"
              : null
        if (direction === null) {
          return []
        }
        return [
          {
            asset,
            amount: tokenAmount,
            rawUnits: tokenAmount,
            observedDecimals: null,
            matchCounterparty:
              direction === "inbound"
                ? (transfer.fromUserAccount ?? null)
                : (transfer.toUserAccount ?? null),
            direction,
            fromAddress: fromAddress ?? "solana:unknown_sender",
            toAddress: toAddress ?? "solana:unknown_recipient",
            role: "principal",
            componentKey: null,
            position: offset + index,
            evidenceKind: "parsed_transfer",
            supplementalTransferRow: null,
          } satisfies SolanaBalanceMovement,
        ]
      })

    const buildTransferRowSplMovements = ({
      transfers,
      walletAddress,
      assetsByMint,
      offset,
    }: {
      readonly transfers: ReadonlyArray<HeliusSolanaWalletTransfer>
      readonly walletAddress: string
      readonly assetsByMint: ReadonlyMap<string, HeliusSolanaResolvedAsset>
      readonly offset: number
    }): ReadonlyArray<SolanaBalanceMovement> =>
      transfers.flatMap((transfer, index) => {
        if (transfer.amountRaw === "0") {
          return []
        }

        const asset = assetsByMint.get(transfer.mint)
        if (asset === undefined) {
          return []
        }

        const direction = transfer.direction === "in" ? "inbound" : "outbound"
        const amount = rawTokenAmountToDecimal({
          amount: transfer.amountRaw,
          decimals: transfer.decimals,
        })

        return [
          {
            asset,
            amount,
            rawUnits: transfer.amountRaw,
            observedDecimals: transfer.decimals,
            matchCounterparty: transfer.counterparty,
            direction,
            fromAddress: direction === "inbound" ? transfer.counterparty : walletAddress,
            toAddress: direction === "inbound" ? walletAddress : transfer.counterparty,
            role: "principal",
            componentKey: null,
            position: offset + index,
            evidenceKind: "transfer_row",
            supplementalTransferRow: transfer,
          } satisfies SolanaBalanceMovement,
        ]
      })

    const movementAmountsEqual = (
      left: SolanaBalanceMovement,
      right: SolanaBalanceMovement
    ): boolean => {
      if (left.evidenceKind === "parsed_transfer" && right.evidenceKind === "transfer_row") {
        const leftAmount = BigDecimal.fromString(left.amount)
        const rightAmount = BigDecimal.fromString(right.amount)

        return (
          Option.isSome(leftAmount) &&
          Option.isSome(rightAmount) &&
          BigDecimal.equals(leftAmount.value, rightAmount.value)
        )
      }

      if (left.observedDecimals !== null && right.observedDecimals !== null) {
        return left.observedDecimals === right.observedDecimals && left.rawUnits === right.rawUnits
      }

      const leftAmount = BigDecimal.fromString(left.amount)
      const rightAmount = BigDecimal.fromString(right.amount)

      return (
        Option.isSome(leftAmount) &&
        Option.isSome(rightAmount) &&
        BigDecimal.equals(leftAmount.value, rightAmount.value)
      )
    }

    const movementsMatch = (
      authoritativeMovement: SolanaBalanceMovement,
      transferRowMovement: SolanaBalanceMovement
    ): boolean =>
      authoritativeMovement.asset.mintAddress === transferRowMovement.asset.mintAddress &&
      authoritativeMovement.direction === transferRowMovement.direction &&
      (authoritativeMovement.matchCounterparty === null ||
        transferRowMovement.matchCounterparty === null ||
        authoritativeMovement.matchCounterparty === transferRowMovement.matchCounterparty) &&
      (authoritativeMovement.observedDecimals === null ||
        (authoritativeMovement.observedDecimals === transferRowMovement.observedDecimals &&
          authoritativeMovement.rawUnits === transferRowMovement.rawUnits)) &&
      movementAmountsEqual(authoritativeMovement, transferRowMovement)

    const findTransferRowContradictions = ({
      transferRows,
      authoritativeMovements,
    }: {
      readonly transferRows: ReadonlyArray<SolanaBalanceMovement>
      readonly authoritativeMovements: ReadonlyArray<SolanaBalanceMovement>
    }): ReadonlyArray<MovementContradiction> => {
      const unmatchedAuthoritativeMovements = [...authoritativeMovements]

      return transferRows.flatMap((movement) => {
        const matchIndex = unmatchedAuthoritativeMovements.findIndex((candidate) =>
          movementsMatch(candidate, movement)
        )

        if (matchIndex !== -1) {
          unmatchedAuthoritativeMovements.splice(matchIndex, 1)
          return []
        }

        return [
          {
            reason: "Helius transfer-row evidence contradicts full transaction movement evidence.",
            evidence: {
              mintAddress: movement.asset.mintAddress,
              direction: movement.direction,
              amount: movement.amount,
              rawUnits: movement.rawUnits,
              evidenceKind: movement.evidenceKind,
            },
          },
        ]
      })
    }

    const joinTransferRowEvidence = ({
      authoritativeMovements,
      transferRowMovements,
    }: {
      readonly authoritativeMovements: ReadonlyArray<SolanaBalanceMovement>
      readonly transferRowMovements: ReadonlyArray<SolanaBalanceMovement>
    }): ReadonlyArray<SolanaBalanceMovement> => {
      const unmatchedTransferRows = [...transferRowMovements]

      return authoritativeMovements.map((movement) => {
        const matchingIndexes = unmatchedTransferRows.flatMap((candidate, index) =>
          movementsMatch(movement, candidate) ? [index] : []
        )
        const positionMatchIndex = matchingIndexes.find(
          (index) => unmatchedTransferRows[index]?.position === movement.position
        )
        const matchIndex =
          movement.matchCounterparty === null
            ? matchingIndexes.length === 1
              ? (matchingIndexes[0] ?? -1)
              : -1
            : (positionMatchIndex ?? matchingIndexes[0] ?? -1)
        const [transferRowMovement] =
          matchIndex === -1 ? [] : unmatchedTransferRows.splice(matchIndex, 1)
        const supplementalTransferRow = transferRowMovement?.supplementalTransferRow ?? null

        if (
          supplementalTransferRow === null ||
          movement.evidenceKind === "transfer_row" ||
          transferRowMovement === undefined
        ) {
          return movement
        }

        const preferTransferRowAmountEvidence = movement.evidenceKind === "parsed_transfer"
        const preferTransferRowEndpointEvidence = movement.matchCounterparty === null

        return {
          ...movement,
          matchCounterparty: preferTransferRowEndpointEvidence
            ? transferRowMovement.matchCounterparty
            : movement.matchCounterparty,
          fromAddress: preferTransferRowEndpointEvidence
            ? transferRowMovement.fromAddress
            : movement.fromAddress,
          toAddress: preferTransferRowEndpointEvidence
            ? transferRowMovement.toAddress
            : movement.toAddress,
          rawUnits:
            preferTransferRowAmountEvidence || movement.observedDecimals === null
              ? transferRowMovement.rawUnits
              : movement.rawUnits,
          observedDecimals: preferTransferRowAmountEvidence
            ? transferRowMovement.observedDecimals
            : (movement.observedDecimals ?? transferRowMovement.observedDecimals),
          supplementalTransferRow,
        }
      })
    }

    const findSupplementalSplEvidenceMovements = ({
      observedMovements,
      parsedMovements,
      transferRowMovements,
    }: {
      readonly observedMovements: ReadonlyArray<SolanaBalanceMovement>
      readonly parsedMovements: ReadonlyArray<SolanaBalanceMovement>
      readonly transferRowMovements: ReadonlyArray<SolanaBalanceMovement>
    }): ReadonlyArray<SolanaBalanceMovement> => {
      const unrepresentedParsedMovements = parsedMovements.filter(
        (movement) =>
          !observedMovements.some(
            (candidate) =>
              candidate.evidenceKind === "parsed_transfer" &&
              candidate.asset.mintAddress === movement.asset.mintAddress &&
              candidate.direction === movement.direction &&
              candidate.fromAddress === movement.fromAddress &&
              candidate.toAddress === movement.toAddress &&
              movementAmountsEqual(candidate, movement)
          )
      )
      const transferRowsMissingFromObservedMovements = transferRowMovements.filter(
        (movement) =>
          !observedMovements.some(
            (candidate) =>
              candidate === movement ||
              (movement.supplementalTransferRow !== null &&
                candidate.supplementalTransferRow === movement.supplementalTransferRow)
          )
      )
      const joinedParsedMovements = joinTransferRowEvidence({
        authoritativeMovements: unrepresentedParsedMovements,
        transferRowMovements: transferRowsMissingFromObservedMovements,
      })
      const unrepresentedTransferRows = transferRowsMissingFromObservedMovements.filter(
        (movement) =>
          !joinedParsedMovements.some(
            (candidate) =>
              candidate === movement ||
              (movement.supplementalTransferRow !== null &&
                candidate.supplementalTransferRow === movement.supplementalTransferRow)
          )
      )

      return [...joinedParsedMovements, ...unrepresentedTransferRows]
    }

    const buildActivityFacts = ({
      sourceId,
      signature,
      timestamp,
      providerTransactionType,
      blockchainId,
      payload,
      movements,
      contradictions,
    }: {
      readonly sourceId: string
      readonly signature: string
      readonly timestamp: Date
      readonly providerTransactionType: string
      readonly blockchainId: string
      readonly payload: HeliusSolanaFullTransactionPayload
      readonly movements: ReadonlyArray<SolanaBalanceMovement>
      readonly contradictions: ReadonlyArray<MovementContradiction>
    }): ActivityFacts =>
      ActivityFacts.make({
        sourceKind: "solana",
        providerKey: HELIUS_SOLANA_PROVIDER_KEY,
        sourceId,
        externalId: signature,
        occurredAt: timestamp,
        providerActivityType: providerTransactionType,
        movements: movements.map(
          (movement) =>
            new ActivityMovementFacts({
              direction: movement.direction,
              role: movement.role === "fee" ? "gas" : movement.role,
              assetId: movement.asset.canonicalAssetId,
              assetSymbol: movement.asset.currencyCode,
              amount: movement.amount,
              fiatAmount: null,
              fiatCurrency: null,
              address: movement.direction === "inbound" ? movement.fromAddress : movement.toAddress,
              accountRef: null,
              tokenId: null,
              metadata: {
                evidenceKind: movement.evidenceKind,
                rawUnits: movement.rawUnits,
                mintAddress: movement.asset.mintAddress,
                providerAssetRowId: movement.asset.providerAssetRowId,
                supplementalTransferRow: movement.supplementalTransferRow,
              },
            })
        ),
        cex: null,
        onchain: new ActivityOnchainFacts({
          chainType: "solana",
          blockchainId,
          txHash: signature,
          blockNumber: String(payload.slot),
          status: payload.meta?.err === null ? "succeeded" : "failed",
          feePayer: firstSignerOrFallback({
            payload,
            fallback: "solana:unknown_fee_payer",
          }),
          entrypoints: (payload.transaction.message.instructions ?? []).flatMap((instruction) => {
            const id = instruction.programId ?? instruction.program ?? null
            if (id === null) {
              return []
            }

            return [
              new ActivityOnchainEntrypointFacts({
                kind: "program",
                id,
                name: instruction.program ?? null,
                metadata: instruction,
              }),
            ]
          }),
          metadata: {
            slot: payload.slot,
            transactionIndex: payload.transactionIndex ?? null,
            error: payload.meta?.err ?? null,
          },
        }),
        utxo: null,
        rawPayload: payload,
        evidence: [
          ...movements.map(
            (movement) =>
              new ActivityEvidence({
                kind: movement.evidenceKind,
                source: HELIUS_SOLANA_PROVIDER_KEY,
                summary: `Solana ${movement.evidenceKind} movement`,
                payload: {
                  mintAddress: movement.asset.mintAddress,
                  amount: movement.amount,
                  rawUnits: movement.rawUnits,
                  direction: movement.direction,
                  role: movement.role,
                  position: movement.position,
                  supplementalTransferRow: movement.supplementalTransferRow,
                },
              })
          ),
          ...contradictions.map(
            (contradiction) =>
              new ActivityEvidence({
                kind: "transfer_row",
                source: HELIUS_SOLANA_PROVIDER_KEY,
                summary: contradiction.reason,
                payload: contradiction.evidence,
              })
          ),
        ],
      })

    const chooseAuthoritativeSplMovements = ({
      parsedSplMovements,
      tokenBalanceSplMovements,
      transferRowSplMovements,
    }: {
      readonly parsedSplMovements: ReadonlyArray<SolanaBalanceMovement>
      readonly tokenBalanceSplMovements: ReadonlyArray<SolanaBalanceMovement>
      readonly transferRowSplMovements: ReadonlyArray<SolanaBalanceMovement>
    }): ReadonlyArray<SolanaBalanceMovement> => {
      if (tokenBalanceSplMovements.length > 0) {
        const parsedWithObservedDecimals = enrichParsedMovementsWithBalanceDecimals({
          parsedMovements: parsedSplMovements,
          balanceMovements: tokenBalanceSplMovements,
        })
        if (
          parsedWithObservedDecimals !== null &&
          (movementTotalsEqual(parsedWithObservedDecimals, tokenBalanceSplMovements) ||
            movementNetRawTotalsEqual(parsedWithObservedDecimals, tokenBalanceSplMovements))
        ) {
          return parsedWithObservedDecimals
        }

        if (
          movementTotalsEqual(transferRowSplMovements, tokenBalanceSplMovements) &&
          movementRawTotalsEqual(transferRowSplMovements, tokenBalanceSplMovements)
        ) {
          return transferRowSplMovements
        }

        return tokenBalanceSplMovements
      }

      if (parsedSplMovements.length > 0) {
        return parsedSplMovements
      }

      return transferRowSplMovements
    }

    const chooseCanonicalSplMovements = ({
      parsedSplMovements,
      tokenBalanceSplMovements,
      transferRowSplMovements,
    }: {
      readonly parsedSplMovements: ReadonlyArray<SolanaBalanceMovement>
      readonly tokenBalanceSplMovements: ReadonlyArray<SolanaBalanceMovement>
      readonly transferRowSplMovements: ReadonlyArray<SolanaBalanceMovement>
    }): ReadonlyArray<SolanaBalanceMovement> => {
      if (tokenBalanceSplMovements.length > 0) {
        return tokenBalanceSplMovements
      }

      if (parsedSplMovements.length > 0) {
        return parsedSplMovements
      }

      return transferRowSplMovements
    }

    function enrichParsedMovementsWithBalanceDecimals({
      parsedMovements,
      balanceMovements,
    }: {
      readonly parsedMovements: ReadonlyArray<SolanaBalanceMovement>
      readonly balanceMovements: ReadonlyArray<SolanaBalanceMovement>
    }): ReadonlyArray<SolanaBalanceMovement> | null {
      if (parsedMovements.length === 0) {
        return null
      }

      const decimalsByMovement = new Map<string, number | null>()
      for (const movement of balanceMovements) {
        if (movement.observedDecimals === null) {
          return null
        }

        const key = movement.asset.mintAddress ?? "native"
        const existing = decimalsByMovement.get(key)
        if (existing !== undefined && existing !== movement.observedDecimals) {
          decimalsByMovement.set(key, null)
        } else if (existing === undefined) {
          decimalsByMovement.set(key, movement.observedDecimals)
        }
      }

      const enriched: Array<SolanaBalanceMovement> = []
      for (const movement of parsedMovements) {
        const key = movement.asset.mintAddress ?? "native"
        const decimals = decimalsByMovement.get(key)
        if (decimals === undefined || decimals === null) {
          return null
        }

        const rawUnits = decimalAmountToExactRawUnits({ amount: movement.amount, decimals })
        if (rawUnits === null) {
          return null
        }

        enriched.push({ ...movement, rawUnits, observedDecimals: decimals })
      }

      return enriched
    }

    function movementRawTotalsEqual(
      left: ReadonlyArray<SolanaBalanceMovement>,
      right: ReadonlyArray<SolanaBalanceMovement>
    ): boolean {
      const totals = (movements: ReadonlyArray<SolanaBalanceMovement>) => {
        const result = new Map<string, bigint>()

        for (const movement of movements) {
          if (movement.observedDecimals === null || !/^\d+$/.test(movement.rawUnits)) {
            return null
          }

          const key = `${movement.asset.mintAddress ?? "native"}:${movement.direction}:${movement.observedDecimals}`
          result.set(key, (result.get(key) ?? 0n) + BigInt(movement.rawUnits))
        }

        return result
      }

      const leftTotals = totals(left)
      const rightTotals = totals(right)
      if (leftTotals === null || rightTotals === null || leftTotals.size !== rightTotals.size) {
        return false
      }

      return Array.from(leftTotals).every(([key, amount]) => rightTotals.get(key) === amount)
    }

    function movementNetRawTotalsEqual(
      left: ReadonlyArray<SolanaBalanceMovement>,
      right: ReadonlyArray<SolanaBalanceMovement>
    ): boolean {
      const totals = (movements: ReadonlyArray<SolanaBalanceMovement>) => {
        const result = new Map<string, bigint>()

        for (const movement of movements) {
          if (movement.observedDecimals === null || !/^\d+$/.test(movement.rawUnits)) {
            return null
          }

          const key = `${movement.asset.mintAddress ?? "native"}:${movement.observedDecimals}`
          const amount = BigInt(movement.rawUnits)
          const signedAmount = movement.direction === "inbound" ? amount : -amount
          result.set(key, (result.get(key) ?? 0n) + signedAmount)
        }

        return result
      }

      const leftTotals = totals(left)
      const rightTotals = totals(right)
      if (leftTotals === null || rightTotals === null || leftTotals.size !== rightTotals.size) {
        return false
      }

      return Array.from(leftTotals).every(([key, amount]) => rightTotals.get(key) === amount)
    }

    function movementTotalsEqual(
      left: ReadonlyArray<SolanaBalanceMovement>,
      right: ReadonlyArray<SolanaBalanceMovement>
    ): boolean {
      if (left.length === 0 || right.length === 0) {
        return false
      }

      const totals = (movements: ReadonlyArray<SolanaBalanceMovement>) => {
        const result = new Map<string, BigDecimal.BigDecimal>()

        for (const movement of movements) {
          const amount = BigDecimal.fromString(movement.amount)
          if (Option.isNone(amount)) {
            return null
          }

          const key = `${movement.asset.mintAddress ?? "native"}:${movement.direction}`
          const existing = result.get(key)
          result.set(
            key,
            existing === undefined ? amount.value : BigDecimal.sum(existing, amount.value)
          )
        }

        return result
      }

      const leftTotals = totals(left)
      const rightTotals = totals(right)
      if (leftTotals === null || rightTotals === null || leftTotals.size !== rightTotals.size) {
        return false
      }

      return Array.from(leftTotals).every(([key, amount]) => {
        const rightAmount = rightTotals.get(key)
        return rightAmount !== undefined && BigDecimal.equals(amount, rightAmount)
      })
    }

    const findContradictionsForEvidence = ({
      authoritativeSplMovements,
      transferRowSplMovements,
    }: {
      readonly authoritativeSplMovements: ReadonlyArray<SolanaBalanceMovement>
      readonly transferRowSplMovements: ReadonlyArray<SolanaBalanceMovement>
    }): ReadonlyArray<MovementContradiction> => {
      if (authoritativeSplMovements === transferRowSplMovements) {
        return []
      }

      return findTransferRowContradictions({
        transferRows: transferRowSplMovements,
        authoritativeMovements: authoritativeSplMovements,
      })
    }

    const buildNormalizationReview = ({
      principalId,
      payload,
      movements,
      contradictions,
      resolvedTransactionType,
    }: {
      readonly principalId: string
      readonly payload: HeliusSolanaFullTransactionPayload
      readonly movements: ReadonlyArray<SolanaBalanceMovement>
      readonly contradictions: ReadonlyArray<MovementContradiction>
      readonly resolvedTransactionType: ResolvedProviderTransactionTypeMapping
    }): SourceTransactionReviewDraft | null => {
      const hasUnresolvedAssets = movements.some(
        (movement) => movement.asset.kind === "review_required"
      )
      const hasFailedTransaction = payload.meta?.err !== null
      const hasUnclassifiedSuccessfulTransaction =
        payload.meta?.err === null &&
        movements.length === 0 &&
        (resolvedTransactionType.mappingStatus === "pending_review" ||
          resolvedTransactionType.transactionType === null)

      if (
        !hasUnresolvedAssets &&
        !hasFailedTransaction &&
        contradictions.length === 0 &&
        !hasUnclassifiedSuccessfulTransaction
      ) {
        return null
      }

      if (hasFailedTransaction) {
        return buildReview({
          principalId,
          reason: "Solana transaction failed; only fee data was normalized.",
          matchedLayer: "solana_failed_transaction",
        })
      }

      if (contradictions.length > 0) {
        return buildReview({
          principalId,
          reason:
            "Solana transaction has contradictory transfer-row evidence that requires review.",
          matchedLayer: "solana_transfer_evidence",
        })
      }

      if (hasUnresolvedAssets) {
        return buildReview({
          principalId,
          reason:
            "Solana transaction contains unsupported or unmapped SPL asset movement that requires review.",
          matchedLayer: "solana_asset_mapping",
        })
      }

      return buildReview({
        principalId,
        reason:
          "Solana transaction normalized without a deterministic activity classification and requires review.",
        matchedLayer: "solana_unknown_activity",
      })
    }

    const buildOnchainContext = ({
      addressId,
      blockchainId,
      signature,
      payload,
      walletAddress,
      providerTransactionType,
      nativeAsset,
    }: {
      readonly addressId: string | null
      readonly blockchainId: string
      readonly signature: string
      readonly payload: HeliusSolanaFullTransactionPayload
      readonly walletAddress: string
      readonly providerTransactionType: string
      readonly nativeAsset: HeliusSolanaResolvedAsset
    }): SourceOnchainContextDraft | null => {
      if (addressId === null) {
        return null
      }

      const positionInBlock =
        payload.transactionIndex === undefined ? null : String(payload.transactionIndex)

      return {
        blockchainId,
        addressId,
        chainTxId: signature,
        blockHeight: String(payload.slot),
        blockHash: null,
        positionInBlock,
        fromAddress: firstSignerOrFallback({ payload, fallback: walletAddress }),
        toAddress: walletAddress,
        gasUsed: null,
        gasPrice: null,
        feeAmount: payload.meta?.fee === undefined ? null : String(payload.meta.fee),
        feeAssetId: nativeAsset.canonicalAssetId,
        feeCostBasisAmount: null,
        feeCostBasisCurrency: null,
        isError: payload.meta?.err !== null,
        functionName: providerTransactionType,
        metadata: {
          provider: HELIUS_SOLANA_PROVIDER_KEY,
          explorerUrl: `${SOLANA_EXPLORER_SIGNATURE_URL}${signature}`,
          error: payload.meta?.err ?? null,
          instructions: payload.transaction.message.instructions ?? [],
        },
      }
    }

    const buildTransactionDraft = ({
      sourceId,
      sourceRawRecordId,
      principalId,
      signature,
      timestamp,
      providerTransactionType,
      resolvedTransactionType,
      payload,
      activityFacts,
      contradictions,
    }: {
      readonly sourceId: string
      readonly sourceRawRecordId: string
      readonly principalId: string
      readonly signature: string
      readonly timestamp: Date
      readonly providerTransactionType: string
      readonly resolvedTransactionType: ResolvedProviderTransactionTypeMapping
      readonly payload: HeliusSolanaFullTransactionPayload
      readonly activityFacts: ActivityFacts
      readonly contradictions: ReadonlyArray<MovementContradiction>
    }): SourceTransactionDraft => ({
      sourceId,
      sourceRawRecordId,
      externalId: signature,
      externalGroupId: signature,
      timestamp,
      transactionType: resolvedTransactionType.transactionType,
      providerTransactionType,
      providerStatus: payload.meta?.err === null ? "succeeded" : "failed",
      providerResourcePath: `${SOLANA_EXPLORER_SIGNATURE_URL}${signature}`,
      providerDescription: payload.description ?? null,
      providerCreatedAt: timestamp,
      providerUpdatedAt: null,
      metadata: {
        provider: HELIUS_SOLANA_PROVIDER_KEY,
        source: payload.source ?? null,
        type: payload.type ?? null,
        activityFacts,
        transferEvidenceContradictions: contradictions,
      },
      providerFiatAmount: null,
      providerFiatCurrency: null,
      principalId,
    })

    const buildVenueContext = ({
      walletAddress,
    }: {
      readonly walletAddress: string
    }): SourceVenueContextDraft => ({
      venueType: "dex",
      cexAccountId: null,
      externalAccountId: walletAddress,
      externalOrderId: null,
      externalFillId: null,
      side: null,
      instrument: null,
      fillPrice: null,
      commissionAmount: null,
      commissionCurrency: null,
      metadata: {
        provider: HELIUS_SOLANA_PROVIDER_KEY,
        chain: SOLANA_BLOCKCHAIN_NAME,
      },
    })

    return HeliusSolanaSourceSyncProvider.of({
      fetchRawBatch,
      refreshReferenceData,
      loadNormalizationLookups,
      prepareNormalization: ({ source, sourceRecord, lookups }) =>
        Effect.gen(function* () {
          const blockchainId = yield* requireSolanaBlockchainId(lookups)

          const walletAddress = yield* resolveWalletAddress({
            sourceId: source.id,
            sourceWalletAddress: source.walletAddress,
            sourceRecordExternalAccountId: sourceRecord.externalAccountId,
          })

          const normalizationPayload = yield* decodeNormalizationPayload(sourceRecord.payload)
          const payload = normalizationPayload.fullTransaction

          const signature = yield* requirePayloadSignature(payload)

          const timestamp = timestampFromPayload({
            payload,
            fallback: sourceRecord.occurredAt,
          })
          const walletTransferEvidence = normalizationPayload.walletTransferEvidence.filter(
            (transfer) => transfer.signature === signature
          )

          const providerTransactionType = toProviderTransactionType(payload)

          const nativeAsset = yield* resolveNativeSol.pipe(
            Effect.mapError(
              (cause) =>
                new HeliusSolanaNormalizationReferenceError({
                  message: "Failed to resolve native Solana asset.",
                  cause,
                })
            )
          )

          const rawSolMovements = buildSolMovements({
            payload,
            nativeAsset,
            walletAddress,
          })

          const {
            nativeMovements: solMovements,
            splTransfers: splWalletTransferEvidence,
            ambiguousTransfers: ambiguousNativeSolTransfers,
          } = refineNativeSolEvidence({
            transfers: walletTransferEvidence,
            nativeMovements: rawSolMovements,
            nativeAsset,
            walletAddress,
            payload,
          })

          const tokenMints = collectSplTokenMints({
            payload,
            walletTransferEvidence: [...splWalletTransferEvidence, ...ambiguousNativeSolTransfers],
          })
          const observedDecimalsByMint = collectObservedSplDecimals({
            payload,
            walletTransferEvidence: [...splWalletTransferEvidence, ...ambiguousNativeSolTransfers],
          })

          const resolvedTokens = yield* assetResolutionService
            .resolveAssets({
              assets: tokenMints.map((mintAddress) => {
                const observedDecimals = observedDecimalsByMint.get(mintAddress)
                return {
                  kind: "spl",
                  mintAddress,
                  ...(observedDecimals === undefined ? {} : { observedDecimals }),
                }
              }),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new HeliusSolanaNormalizationReferenceError({
                    message: "Failed to resolve Solana SPL assets.",
                    cause,
                  })
              )
            )

          const assetsByMint = mapAssetsByMint(tokenMints, resolvedTokens)

          const parsedSplMovements = buildParsedSplMovements({
            transfers: payload.tokenTransfers ?? [],
            walletAddress,
            assetsByMint,
            offset: rawSolMovements.length,
          })

          const transferRowSplMovements = buildTransferRowSplMovements({
            transfers: splWalletTransferEvidence,
            walletAddress,
            assetsByMint,
            offset: rawSolMovements.length,
          })
          const ambiguousNativeSolMovements = buildTransferRowSplMovements({
            transfers: ambiguousNativeSolTransfers,
            walletAddress,
            assetsByMint,
            offset: rawSolMovements.length + transferRowSplMovements.length,
          }).map(
            (movement): SolanaBalanceMovement => ({
              ...movement,
              asset: {
                ...movement.asset,
                representationTypeObserved: false,
              },
            })
          )

          const tokenBalanceSplMovements = buildSplMovements({
            payload,
            walletAddress,
            assetsByMint,
            offset: rawSolMovements.length,
          })

          const splMovements = chooseAuthoritativeSplMovements({
            parsedSplMovements,
            tokenBalanceSplMovements,
            transferRowSplMovements,
          })

          const joinedSplMovements =
            splMovements === transferRowSplMovements
              ? splMovements
              : joinTransferRowEvidence({
                  authoritativeMovements: splMovements,
                  transferRowMovements: transferRowSplMovements,
                })
          const supplementalSplEvidenceMovements = findSupplementalSplEvidenceMovements({
            observedMovements: joinedSplMovements,
            parsedMovements: parsedSplMovements,
            transferRowMovements: transferRowSplMovements,
          })

          const canonicalSplMovements = chooseCanonicalSplMovements({
            parsedSplMovements,
            tokenBalanceSplMovements,
            transferRowSplMovements,
          })
          const joinedCanonicalSplMovements = (
            canonicalSplMovements === transferRowSplMovements
              ? canonicalSplMovements
              : joinTransferRowEvidence({
                  authoritativeMovements: canonicalSplMovements,
                  transferRowMovements: transferRowSplMovements,
                })
          ).filter((movement) => movement.asset.kind !== "excluded")

          const contradictionSplMovements = splMovements.filter(
            (movement) => movement.asset.kind !== "excluded"
          )
          const contradictionTransferRowSplMovements =
            splMovements === transferRowSplMovements
              ? contradictionSplMovements
              : transferRowSplMovements.filter((movement) => movement.asset.kind !== "excluded")

          const contradictions = [
            ...findContradictionsForEvidence({
              authoritativeSplMovements: contradictionSplMovements,
              transferRowSplMovements: contradictionTransferRowSplMovements,
            }),
            ...ambiguousNativeSolTransfers.map(
              (transfer): MovementContradiction => ({
                reason:
                  "Wallet transfer row could not be classified exactly as native SOL or wrapped SOL.",
                evidence: transfer,
              })
            ),
          ]

          const movements = [
            ...solMovements,
            ...joinedSplMovements.map((movement, index) => ({
              ...movement,
              position: solMovements.length + index,
            })),
          ]
          const canonicalMovements = [
            ...rawSolMovements.filter((movement) => movement.asset.kind !== "excluded"),
            ...joinedCanonicalSplMovements,
          ]
          const conflictingApprovedMovement = canonicalMovements.find(
            (movement) =>
              movement.asset.mappingStatus === "approved" &&
              movement.observedDecimals !== null &&
              movement.asset.decimals !== null &&
              movement.observedDecimals !== movement.asset.decimals
          )
          if (conflictingApprovedMovement !== undefined) {
            return yield* new HeliusSolanaNormalizationReferenceError({
              message: `Approved Solana asset mapping for ${conflictingApprovedMovement.asset.currencyCode} conflicts with observed type or decimals evidence.`,
            })
          }
          const ambiguousNativeSolMovementSet = new Set(ambiguousNativeSolMovements)
          const providerObservationMovements = [
            ...movements,
            ...supplementalSplEvidenceMovements,
            ...ambiguousNativeSolMovements,
          ]

          const providerAssetRowIds = [
            ...new Set(
              [...canonicalMovements, ...providerObservationMovements].map(
                (movement) => movement.asset.providerAssetRowId
              )
            ),
          ]

          const canonicalTransferPlans = canonicalMovements.flatMap((movement) => {
            const draft = buildTransferDraft({
              source,
              sourceRecord,
              blockchainId,
              movement,
              signature,
              timestamp,
            })
            return draft === null ? [] : [{ draft, plan: buildLegPlan({ movement, signature }) }]
          })
          const canonicalTransfers = canonicalTransferPlans.map(({ draft }) => draft)

          const movementsMatch = (
            candidate: SolanaBalanceMovement,
            movement: SolanaBalanceMovement
          ): boolean =>
            candidate.role === movement.role &&
            candidate.direction === movement.direction &&
            candidate.asset.providerAssetRowId === movement.asset.providerAssetRowId &&
            candidate.fromAddress === movement.fromAddress &&
            candidate.toAddress === movement.toAddress &&
            movementAmountsEqual(candidate, movement)

          const matchedObservedMovementIndexes = new Set<number>()
          const matchedCanonicalMovementIndexes = new Set<number>()
          canonicalMovements.forEach((canonicalMovement, canonicalIndex) => {
            const observedIndex = providerObservationMovements.findIndex(
              (movement, index) =>
                !matchedObservedMovementIndexes.has(index) &&
                movementsMatch(canonicalMovement, movement)
            )
            if (observedIndex !== -1) {
              matchedObservedMovementIndexes.add(observedIndex)
              matchedCanonicalMovementIndexes.add(canonicalIndex)
            }
          })

          const canonicalProviderTransfers = canonicalMovements.map((movement, index) => {
            const hasObservedMatch = matchedCanonicalMovementIndexes.has(index)

            return buildProviderTransferDraft({
              sourceId: source.id,
              sourceRawRecordId: sourceRecord.id,
              blockchainId,
              signature,
              timestamp,
              movement,
              externalId: `${canonicalMovementExternalId(signature, movement)}:provider`,
              canonicalTransferExternalId: canonicalMovementExternalId(signature, movement),
              processingMode: hasObservedMatch ? "accounting_and_evidence" : "accounting_only",
              observedRepresentationIdentityKnown: true,
            })
          })
          const evidenceProviderTransfers = providerObservationMovements.flatMap(
            (movement, index) => {
              if (matchedObservedMovementIndexes.has(index)) {
                return []
              }

              return [
                buildProviderTransferDraft({
                  sourceId: source.id,
                  sourceRawRecordId: sourceRecord.id,
                  blockchainId,
                  signature,
                  timestamp,
                  movement,
                  externalId: `${signature}:provider:${movement.role}:evidence:${index}`,
                  canonicalTransferExternalId: null,
                  processingMode: "evidence_only",
                  observedRepresentationIdentityKnown: !ambiguousNativeSolMovementSet.has(movement),
                }),
              ]
            }
          )
          const providerTransfers = [...canonicalProviderTransfers, ...evidenceProviderTransfers]

          const resolvedTransactionType = stableMapping(
            providerTransactionType === "failed" ? "gas_fee" : null
          )

          const transactionReview = buildNormalizationReview({
            principalId: source.principalId,
            payload,
            movements,
            contradictions,
            resolvedTransactionType,
          })

          const onchainContext = buildOnchainContext({
            addressId: source.addressId,
            blockchainId,
            signature,
            payload,
            walletAddress,
            providerTransactionType,
            nativeAsset,
          })

          const activityFacts = buildActivityFacts({
            sourceId: source.id,
            signature,
            timestamp,
            providerTransactionType,
            blockchainId,
            payload,
            movements,
            contradictions,
          })

          // Legs are derived only when every canonical movement is backed by an
          // approved local mapping and nothing on the transaction needs review.
          // Unresolved observations keep their raw and provider rows but stay
          // outside legs, inventory, and FIFO.
          const legDerivationStrategy =
            transactionReview === null &&
            canonicalTransferPlans.length > 0 &&
            canonicalTransferPlans.length === canonicalMovements.length
              ? "derive"
              : "skip"

          return {
            providerAssetRowIds,
            transaction: buildTransactionDraft({
              sourceId: source.id,
              sourceRawRecordId: sourceRecord.id,
              principalId: source.principalId,
              signature,
              timestamp,
              providerTransactionType,
              resolvedTransactionType,
              payload,
              activityFacts,
              contradictions,
            }),
            venueContext: buildVenueContext({ walletAddress }),
            onchainContext,
            providerTransfers,
            canonicalTransfers,
            transactionReview,
            resolvedTransactionType,
            legDerivationStrategy,
            legPlans:
              legDerivationStrategy === "derive"
                ? canonicalTransferPlans.map(({ plan }) => plan)
                : [],
          }
        }),
      deriveLegs: ({ transaction, canonicalTransfers, legPlans }) =>
        Effect.gen(function* () {
          const plansByTransferExternalId = new Map(
            legPlans.map((plan) => [plan.transferExternalId, plan])
          )

          return yield* Effect.forEach(canonicalTransfers, (transfer) => {
            const plan =
              transfer.externalId === null
                ? undefined
                : plansByTransferExternalId.get(transfer.externalId)

            if (plan === undefined) {
              return Effect.fail(
                new HeliusSolanaNormalizationReferenceError({
                  message: `Missing Solana leg plan for canonical transfer ${transfer.externalId ?? transfer.id}.`,
                })
              )
            }

            return Effect.succeed({
              movementIdentity: plan.movementIdentity,
              sourceId: transfer.sourceId,
              sourceRawRecordId: transfer.sourceRawRecordId,
              externalId:
                plan.movementIdentity._tag === "identified"
                  ? `${plan.movementIdentity.sourceRecordKey}:movement:${plan.movementIdentity.componentKey}:leg`
                  : `${plan.transferExternalId}:unidentified_leg`,
              txHash: transfer.txHash,
              timestamp: transfer.timestamp,
              principalId: transaction.principalId,
              addressId: transfer.addressId,
              assetId: transfer.assetId,
              assetRepresentationId: transfer.assetRepresentationId,
              amount: transfer.amount,
              kind: plan.kind,
              provenance: "deterministic",
              derivationRule: plan.derivationRule,
              metadata: {
                provider: HELIUS_SOLANA_PROVIDER_KEY,
                role: plan.role,
              },
              transactionId: transaction.id,
              sourceTransferId: transfer.id,
              fiatAmount: null,
              fiatCurrency: null,
              feeForTransactionId: plan.kind === "fee" ? transaction.id : null,
            } satisfies SourceTransactionLegDraft)
          })
        }),
    } satisfies HeliusSolanaSourceSyncProviderShape)
  })

const makeWithEmptyReferenceData = make({
  refreshReferenceData: Effect.succeed(emptyReferenceDataRefresh),
})

const makeWithAssetResolutionReferenceData = Effect.gen(function* () {
  const assetResolutionService = yield* HeliusSolanaAssetResolutionService

  return yield* make({
    refreshReferenceData: assetResolutionService.ensureDefaultMappings.pipe(
      Effect.map(toHeliusSolanaReferenceDataRefreshResult),
      Effect.mapError(toReferenceRefreshStorageError)
    ),
  })
})

/**
 * HeliusSolanaSourceSyncProviderFromClientLive - Helius provider layer with an injectable client.
 */
export const HeliusSolanaSourceSyncProviderFromClientLive = Layer.effect(
  HeliusSolanaSourceSyncProvider,
  makeWithEmptyReferenceData
)

/**
 * HeliusSolanaSourceSyncProviderFromClientAndAssetResolutionLive - Injectable Helius provider with asset reference refresh.
 */
export const HeliusSolanaSourceSyncProviderFromClientAndAssetResolutionLive = Layer.effect(
  HeliusSolanaSourceSyncProvider,
  makeWithAssetResolutionReferenceData
)

/**
 * HeliusSolanaSourceSyncProviderLive - Production Helius Solana provider layer.
 */
export const HeliusSolanaSourceSyncProviderLive =
  HeliusSolanaSourceSyncProviderFromClientAndAssetResolutionLive.pipe(
    Layer.provide(HeliusSolanaAssetResolutionServiceLive),
    Layer.provide(HeliusSolanaSyncClientLive)
  )
