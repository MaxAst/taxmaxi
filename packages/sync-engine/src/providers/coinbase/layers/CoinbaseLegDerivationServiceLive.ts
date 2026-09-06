/**
 * CoinbaseLegDerivationServiceLive - Deterministic Coinbase leg derivation.
 *
 * @module CoinbaseLegDerivationServiceLive
 */

import * as BigDecimal from "effect/BigDecimal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import {
  absoluteDecimal,
  formatPlain,
  isNegativeAmount,
  isZeroAmount,
  parseAmount,
  subtractFeeFromDebit,
} from "../shared/CoinbaseDecimal.ts"
import { feeIsPartOfDebit } from "../shared/CoinbaseNetworkFee.ts"
import {
  CoinbaseLegDerivationError,
  CoinbaseLegDerivationService,
  type CoinbaseLegDerivationResult,
  type CoinbaseLegDerivationServiceShape,
  type DeriveCoinbaseLegsParams,
} from "../services/CoinbaseLegDerivationService.ts"

const CoinbaseMoneySchema = Schema.Struct({
  amount: Schema.String,
  currency: Schema.String,
})

const CoinbasePartySchema = Schema.Struct({
  resource: Schema.String,
  address: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  resource_path: Schema.optional(Schema.String),
})

const CoinbaseMetadataSchema = Schema.Struct({
  amount: CoinbaseMoneySchema,
  nativeAmount: CoinbaseMoneySchema,
  network: Schema.NullOr(Schema.Unknown),
  from: Schema.NullOr(CoinbasePartySchema),
  to: Schema.NullOr(CoinbasePartySchema),
  coinbaseReferenceMapping: Schema.Struct({
    transactionType: Schema.NullOr(Schema.String),
    inventoryEffect: Schema.Literals([
      "acquisition",
      "disposal",
      "income",
      "internal_transfer",
      "non_inventory",
      "unknown",
    ]),
    taxTreatment: Schema.Literals([
      "taxable_by_default",
      "non_taxable_by_default",
      "requires_additional_rule_logic",
    ]),
    resolutionStrategy: Schema.Literals([
      "static",
      "amount_sign",
      "venue_side",
      "paired_spread_fee",
      "no_leg",
    ]),
    pairedRecordRequired: Schema.Boolean,
    mappingStatus: Schema.Literals(["approved", "pending_review"]),
  }),
  providerAssetRowId: Schema.optional(Schema.String.check(Schema.isUUID())),
  pairedRecord: Schema.optional(
    Schema.Struct({
      externalId: Schema.String,
      amount: CoinbaseMoneySchema,
      nativeAmount: CoinbaseMoneySchema,
    })
  ),
})

type CoinbaseMetadata = Schema.Schema.Type<typeof CoinbaseMetadataSchema>
type CoinbaseMoney = Schema.Schema.Type<typeof CoinbaseMoneySchema>

const CoinbaseNetworkFeeSchema = Schema.Struct({
  transaction_fee: Schema.optional(CoinbaseMoneySchema),
})

const decodeNetworkFee = Schema.decodeUnknownOption(CoinbaseNetworkFeeSchema)

const invalidDecimalError = (value: string) =>
  new CoinbaseLegDerivationError({
    message: `Invalid decimal amount: ${value}`,
  })

/**
 * Find the network fee that Coinbase already counted into the primary
 * `amount`. That is the case when the fee uses the same currency as the
 * primary amount; fees in another currency or in the native fiat currency are
 * tracked outside the debit and return none.
 */
const sameCurrencyNetworkFee = (metadata: CoinbaseMetadata): Option.Option<CoinbaseMoney> =>
  Option.flatMap(decodeNetworkFee(metadata.network ?? undefined), (network) => {
    const fee = network.transaction_fee

    return fee !== undefined &&
      feeIsPartOfDebit({
        feeCurrency: fee.currency,
        amountCurrency: metadata.amount.currency,
        nativeCurrency: metadata.nativeAmount.currency,
      })
      ? Option.some(fee)
      : Option.none()
  })

const decodeCoinbaseMetadata = (
  metadata: unknown
): Effect.Effect<CoinbaseMetadata, CoinbaseLegDerivationError> =>
  Schema.decodeUnknownEffect(CoinbaseMetadataSchema)(metadata).pipe(
    Effect.mapError(
      (cause) =>
        new CoinbaseLegDerivationError({
          message: "Failed to decode normalized Coinbase transaction metadata",
          cause,
        })
    )
  )

const instrumentQuoteCurrency = (instrument: string | null): Option.Option<string> => {
  if (instrument === null) {
    return Option.none()
  }

  for (const separator of ["-", "_", "/"]) {
    const parts = instrument.split(separator)
    if (parts.length === 2 && parts[1] !== undefined && parts[1] !== "") {
      return Option.some(parts[1].toUpperCase())
    }
  }

  return Option.none()
}

const shouldSkipQuoteSideMainLeg = (metadata: CoinbaseMetadata): boolean => {
  const transactionType = metadata.coinbaseReferenceMapping.transactionType

  if (transactionType !== "buy_fiat" && transactionType !== "sell_fiat") {
    return false
  }

  return metadata.amount.currency.toUpperCase() === metadata.nativeAmount.currency.toUpperCase()
}

/**
 * Determine the canonical leg kind for the primary Coinbase amount from the
 * persisted mapping metadata written during normalization. Returns none when
 * the mapping produces no main inventory leg for this row.
 */
const deriveMainLegClassification = ({
  providerTransactionType,
  resolutionStrategy,
  inventoryEffect,
  amount,
  side,
}: {
  providerTransactionType: string | null
  resolutionStrategy: CoinbaseMetadata["coinbaseReferenceMapping"]["resolutionStrategy"]
  inventoryEffect: CoinbaseMetadata["coinbaseReferenceMapping"]["inventoryEffect"]
  amount: string
  side: string | null
}): Effect.Effect<
  Option.Option<{
    readonly kind: "acquisition" | "disposal" | "income" | "fee"
    readonly derivationRule: string
  }>,
  CoinbaseLegDerivationError
> => {
  const normalizedType = providerTransactionType ?? "unknown"
  const normalizedSide = side === null ? null : side.trim().toLowerCase()

  switch (resolutionStrategy) {
    case "static":
      switch (inventoryEffect) {
        case "acquisition":
          return Effect.succeed(
            Option.some({
              kind: "acquisition" as const,
              derivationRule: `coinbase_${normalizedType}`,
            })
          )
        case "disposal":
          return Effect.succeed(
            Option.some({
              kind: "disposal" as const,
              derivationRule: `coinbase_${normalizedType}`,
            })
          )
        case "income":
          if (isNegativeAmount(amount)) {
            return Effect.fail(
              new CoinbaseLegDerivationError({
                message: `${normalizedType} must have a positive asset amount for income treatment`,
              })
            )
          }
          return Effect.succeed(
            Option.some({
              kind: "income" as const,
              derivationRule: `coinbase_${normalizedType}`,
            })
          )
        default:
          return Effect.fail(
            new CoinbaseLegDerivationError({
              message: `Unsupported static Coinbase inventory effect ${inventoryEffect} for type ${normalizedType}`,
            })
          )
      }
    case "venue_side":
      if (normalizedSide === "buy") {
        return Effect.succeed(
          Option.some({
            kind: "acquisition" as const,
            derivationRule: `coinbase_${normalizedType}_buy`,
          })
        )
      }
      if (normalizedSide === "sell") {
        return Effect.succeed(
          Option.some({
            kind: "disposal" as const,
            derivationRule: `coinbase_${normalizedType}_sell`,
          })
        )
      }
      return Effect.fail(
        new CoinbaseLegDerivationError({
          message: `${normalizedType} is missing a deterministic venue side`,
        })
      )
    case "amount_sign":
      if (isZeroAmount(amount)) {
        return Effect.succeed(Option.none())
      }
      return Effect.succeed(
        Option.some(
          isNegativeAmount(amount)
            ? {
                kind: "disposal" as const,
                derivationRule: `coinbase_${normalizedType}_outflow`,
              }
            : {
                kind: "acquisition" as const,
                derivationRule: `coinbase_${normalizedType}_inflow`,
              }
        )
      )
    case "paired_spread_fee":
      // Paired rows carry the full principal on both sides; only the negative
      // release row yields a leg, and its amount is the spread vs the paired row.
      return Effect.succeed(
        isNegativeAmount(amount)
          ? Option.some({
              kind: "fee" as const,
              derivationRule: `coinbase_${normalizedType}_spread_fee`,
            })
          : Option.none()
      )
    case "no_leg":
      return Effect.succeed(Option.none())
  }
}

/** Derive a fee leg valuation when a deterministic quote price is available. */
const deriveFeeValuation = ({
  feeAmount,
  fillPrice,
  quoteCurrency,
}: {
  feeAmount: string
  fillPrice: string | null
  quoteCurrency: string | null
}): Effect.Effect<
  {
    readonly fiatAmount: string | null
    readonly fiatCurrency: string | null
  },
  CoinbaseLegDerivationError
> =>
  Effect.gen(function* () {
    if (fillPrice === null || quoteCurrency === null) {
      return {
        fiatAmount: null,
        fiatCurrency: null,
      } as const
    }

    const fee = yield* parseAmount(feeAmount, invalidDecimalError)
    const price = yield* parseAmount(fillPrice, invalidDecimalError)
    const fiatValue = BigDecimal.round(BigDecimal.abs(BigDecimal.multiply(fee, price)), {
      scale: 8,
      mode: "half-from-zero",
    })

    return {
      fiatAmount: formatPlain(BigDecimal.scale(fiatValue, 8)),
      fiatCurrency: quoteCurrency,
    } as const
  })

/**
 * Compute a disposal leg for the debit minus its same-currency network fee.
 * Coinbase counts that fee into the primary `amount`, so the main leg only
 * covers the principal and the separate fee leg covers the rest; together
 * they equal the debit. The fiat valuation shrinks by the same ratio.
 */
const deriveCarvedDisposalAmounts = ({
  metadata,
  networkFee,
}: {
  readonly metadata: CoinbaseMetadata
  readonly networkFee: CoinbaseMoney
}): Effect.Effect<
  {
    readonly amount: string
    readonly fiatAmount: string | null
    readonly fiatCurrency: string | null
  },
  CoinbaseLegDerivationError
> =>
  Effect.gen(function* () {
    const amount = yield* subtractFeeFromDebit({
      debitAmount: metadata.amount.amount,
      feeAmount: networkFee.amount,
      onFeeAboveDebit: () =>
        new CoinbaseLegDerivationError({
          message: `Network fee ${networkFee.amount} ${networkFee.currency} exceeds the debited amount ${metadata.amount.amount} ${metadata.amount.currency}`,
        }),
      onInvalid: invalidDecimalError,
    })

    const debit = BigDecimal.abs(yield* parseAmount(metadata.amount.amount, invalidDecimalError))
    const debitFiat = BigDecimal.abs(
      yield* parseAmount(metadata.nativeAmount.amount, invalidDecimalError)
    )
    const principal = yield* parseAmount(amount, invalidDecimalError)
    const fiatValue = Option.map(
      BigDecimal.divide(BigDecimal.multiply(debitFiat, principal), debit),
      (scaled) => BigDecimal.round(scaled, { scale: 8, mode: "half-from-zero" })
    )

    return {
      amount,
      fiatAmount: Option.match(fiatValue, {
        onNone: () => null,
        onSome: (value) => formatPlain(BigDecimal.scale(value, 8)),
      }),
      fiatCurrency: Option.isNone(fiatValue) ? null : metadata.nativeAmount.currency,
    } as const
  })

/**
 * Compute the main leg amount and fiat valuation. For paired spread fees the
 * leg amount is the spread between the negative release row and its paired
 * positive principal row; disposals subtract a same-currency network fee that
 * Coinbase counted into the debit; all other strategies use the row amount
 * directly.
 */
const deriveMainLegAmounts = ({
  params,
  metadata,
  networkFee,
}: {
  readonly params: DeriveCoinbaseLegsParams
  readonly metadata: CoinbaseMetadata
  readonly networkFee: Option.Option<CoinbaseMoney>
}): Effect.Effect<
  {
    readonly amount: string
    readonly fiatAmount: string | null
    readonly fiatCurrency: string | null
  },
  CoinbaseLegDerivationError
> =>
  Effect.gen(function* () {
    if (metadata.coinbaseReferenceMapping.resolutionStrategy !== "paired_spread_fee") {
      if (Option.isSome(networkFee)) {
        return yield* deriveCarvedDisposalAmounts({
          metadata,
          networkFee: networkFee.value,
        })
      }

      return {
        amount: absoluteDecimal(metadata.amount.amount),
        fiatAmount: absoluteDecimal(metadata.nativeAmount.amount),
        fiatCurrency: metadata.nativeAmount.currency,
      } as const
    }

    const paired = metadata.pairedRecord
    if (paired === undefined) {
      return yield* new CoinbaseLegDerivationError({
        message: `${params.transaction.providerTransactionType ?? "unknown"} requires a paired principal record to derive the spread fee`,
      })
    }

    const releasedPrincipal = yield* parseAmount(metadata.amount.amount, invalidDecimalError)
    const pairedPrincipal = yield* parseAmount(paired.amount.amount, invalidDecimalError)
    const spread = BigDecimal.subtract(BigDecimal.abs(releasedPrincipal), pairedPrincipal)
    if (BigDecimal.isNegative(spread)) {
      return yield* new CoinbaseLegDerivationError({
        message: `Paired principal ${paired.amount.amount} exceeds released principal ${metadata.amount.amount} for ${params.transaction.providerTransactionType ?? "unknown"}`,
      })
    }
    const amount = formatPlain(spread)

    const releasedFiat = yield* parseAmount(metadata.nativeAmount.amount, invalidDecimalError)
    const pairedFiat = yield* parseAmount(paired.nativeAmount.amount, invalidDecimalError)
    const fiatSpread = BigDecimal.subtract(BigDecimal.abs(releasedFiat), pairedFiat)
    const fiatAmount = BigDecimal.isNegative(fiatSpread) ? null : formatPlain(fiatSpread)

    return {
      amount,
      fiatAmount,
      fiatCurrency: fiatAmount === null ? null : metadata.nativeAmount.currency,
    } as const
  })

/** Build the main Coinbase leg when the mapping indicates inventory impact. */
const buildMainLeg = (
  params: DeriveCoinbaseLegsParams,
  metadata: CoinbaseMetadata
): Effect.Effect<
  Option.Option<CoinbaseLegDerivationResult["legs"][number]>,
  CoinbaseLegDerivationError
> =>
  Effect.gen(function* () {
    const maybeClassification = yield* deriveMainLegClassification({
      providerTransactionType: params.transaction.providerTransactionType,
      resolutionStrategy: metadata.coinbaseReferenceMapping.resolutionStrategy,
      inventoryEffect: metadata.coinbaseReferenceMapping.inventoryEffect,
      amount: metadata.amount.amount,
      side: params.venueContext?.side ?? null,
    })

    if (Option.isNone(maybeClassification)) {
      return Option.none()
    }
    const classification = maybeClassification.value

    if (params.primaryAsset === null) {
      return yield* new CoinbaseLegDerivationError({
        message: `No primary asset is available for Coinbase transaction type ${params.transaction.providerTransactionType ?? "unknown"}`,
      })
    }

    const networkFee =
      classification.kind === "disposal" ? sameCurrencyNetworkFee(metadata) : Option.none()
    const amounts = yield* deriveMainLegAmounts({
      params,
      metadata,
      networkFee,
    })
    const coversNoInventory =
      metadata.coinbaseReferenceMapping.resolutionStrategy === "paired_spread_fee" ||
      Option.isSome(networkFee)
    if (coversNoInventory && isZeroAmount(amounts.amount)) {
      return Option.none()
    }

    return Option.some({
      movementIdentity:
        params.transaction.externalId === null
          ? { _tag: "unavailable", reason: "missing_movement_identity" }
          : {
              _tag: "identified",
              sourceRecordKey: params.transaction.externalId,
              componentKey: "amount",
            },
      sourceId: params.transaction.sourceId,
      sourceRawRecordId: params.transaction.sourceRawRecordId,
      externalId: `${params.transaction.externalId ?? params.transaction.id}:main`,
      txHash: null,
      timestamp: params.transaction.timestamp,
      principalId: params.transaction.principalId,
      addressId: null,
      assetId: params.primaryAsset.id,
      assetRepresentationId: null,
      amount: amounts.amount,
      kind: classification.kind,
      provenance: "deterministic",
      derivationRule: classification.derivationRule,
      providerAssetRowId: metadata.providerAssetRowId ?? null,
      metadata: {
        provider: "coinbase",
        providerTransactionType: params.transaction.providerTransactionType,
        transactionType: metadata.coinbaseReferenceMapping.transactionType,
        assetCurrency: metadata.amount.currency,
        nativeCurrency: metadata.nativeAmount.currency,
        venueSide: params.venueContext?.side ?? null,
      },
      transactionId: params.transaction.id,
      originKind:
        params.primaryProviderTransferId === null
          ? ("none" as const)
          : ("provider_transfer" as const),
      providerTransferId: params.primaryProviderTransferId,
      sourceTransferId: null,
      fiatAmount: amounts.fiatAmount,
      fiatCurrency: amounts.fiatCurrency,
      feeForTransactionId: classification.kind === "fee" ? params.transaction.id : null,
    } as const)
  })

/** Build fee legs from normalized Coinbase fee transfer rows. */
const buildFeeLegs = (
  params: DeriveCoinbaseLegsParams,
  metadata: CoinbaseMetadata
): Effect.Effect<
  ReadonlyArray<CoinbaseLegDerivationResult["legs"][number]>,
  CoinbaseLegDerivationError
> =>
  Effect.forEach(params.feeTransfers, ({ transfer, asset, providerAssetRowId }) =>
    Effect.gen(function* () {
      const quoteCurrency = Option.getOrNull(
        instrumentQuoteCurrency(params.venueContext?.instrument ?? null)
      )
      const valuation = yield* deriveFeeValuation({
        feeAmount: transfer.amount,
        fillPrice:
          params.venueContext?.fillPrice === null ? null : String(params.venueContext?.fillPrice),
        quoteCurrency,
      })

      const sourceRecordKey = params.transaction.externalId
      // The normalizer records these exact source-field names in transfer external IDs.
      const componentKey =
        sourceRecordKey === null
          ? null
          : transfer.externalId === `${sourceRecordKey}:network_fee`
            ? "network.transaction_fee"
            : transfer.externalId === `${sourceRecordKey}:commission`
              ? "commission"
              : null
      return {
        movementIdentity:
          sourceRecordKey === null || componentKey === null
            ? { _tag: "unavailable", reason: "missing_movement_identity" }
            : { _tag: "identified", sourceRecordKey, componentKey },
        sourceId: transfer.sourceId,
        sourceRawRecordId: transfer.sourceRawRecordId,
        externalId: `${transfer.externalId ?? transfer.id}:fee_leg`,
        txHash: transfer.txHash,
        timestamp: transfer.timestamp,
        principalId: params.transaction.principalId,
        addressId: transfer.addressId,
        assetId: transfer.assetId,
        assetRepresentationId: transfer.assetRepresentationId,
        amount: absoluteDecimal(transfer.amount),
        kind: "fee",
        provenance: "deterministic",
        derivationRule:
          transfer.externalId?.endsWith(":network_fee") === true
            ? "coinbase_network_fee"
            : "coinbase_commission_fee",
        providerAssetRowId,
        metadata: {
          provider: "coinbase",
          providerTransactionType: params.transaction.providerTransactionType,
          transactionType: metadata.coinbaseReferenceMapping.transactionType,
          assetCurrency: asset.symbol,
          nativeCurrency: metadata.nativeAmount.currency,
          transferType: transfer.type,
        },
        transactionId: params.transaction.id,
        originKind: "canonical_transfer",
        providerTransferId: null,
        sourceTransferId: transfer.id,
        fiatAmount: valuation.fiatAmount,
        fiatCurrency: valuation.fiatCurrency,
        feeForTransactionId: params.transaction.id,
      } as const
    })
  )

const deriveLegs: CoinbaseLegDerivationServiceShape["deriveLegs"] = (params) =>
  Effect.gen(function* () {
    const metadata = yield* decodeCoinbaseMetadata(params.transaction.metadata)
    const feeLegs = yield* buildFeeLegs(params, metadata)
    const maybeMainLeg =
      !params.deriveMainLeg || shouldSkipQuoteSideMainLeg(metadata)
        ? Option.none()
        : yield* buildMainLeg(params, metadata)

    return {
      legs: [...Option.toArray(maybeMainLeg), ...feeLegs],
    } satisfies CoinbaseLegDerivationResult
  })

const make = Effect.succeed({
  deriveLegs,
} satisfies CoinbaseLegDerivationServiceShape)

/**
 * CoinbaseLegDerivationServiceLive - Live layer for deterministic Coinbase leg derivation.
 */
export const CoinbaseLegDerivationServiceLive = Layer.effect(CoinbaseLegDerivationService, make)
