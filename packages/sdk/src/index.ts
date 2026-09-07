import * as Effect from "effect/Effect"
import {
  makeTaxMaxiEffectClient,
  resolveHeaders,
  type TaxMaxiEffectClient,
  type TaxMaxiEffectClientOptions,
  type TaxMaxiHeaders,
  type TaxMaxiHeadersProvider,
  type TaxMaxiOptions,
  type TaxMaxiBrowserSessionOptions,
  type TaxMaxiRequestOptions,
} from "./client.ts"
import {
  makeAdminProtocolReviewEffectResource,
  makeAdminProtocolReviewPromiseResource,
  type AdminProtocolReviewEffectResource,
  type AdminProtocolReviewPromiseResource,
} from "./admin-protocol-review/index.ts"
import {
  makeAnonEffectResource,
  makeAnonPromiseResource,
  type AnonEffectResource,
  type AnonPromiseResource,
} from "./anon/index.ts"
import {
  makeAuthEffectResource,
  makeAuthPromiseResource,
  type AuthEffectResource,
  type AuthPromiseResource,
} from "./auth/index.ts"
import {
  makeAssetsEffectResource,
  makeAssetsPromiseResource,
  type AssetRequestOptions,
  type AssetsEffectResource,
  type AssetsPromiseResource,
} from "./assets/index.ts"
import {
  makeAssetOverridesEffectResource,
  makeAssetOverridesPromiseResource,
  type AssetOverridesEffectResource,
  type AssetOverridesPromiseResource,
} from "./asset-overrides/index.ts"
import {
  makeTransactionOverridesEffectResource,
  makeTransactionOverridesPromiseResource,
  type TransactionOverridesEffectResource,
  type TransactionOverridesPromiseResource,
} from "./transaction-overrides/index.ts"
import { toTaxMaxiError } from "./errors.ts"
import {
  makeBillingEffectResource,
  makeBillingPromiseResource,
  type BillingEffectResource,
  type BillingPromiseResource,
} from "./billing/index.ts"
import {
  makePortfolioEffectResource,
  makePortfolioPromiseResource,
  type PortfolioEffectResource,
  type PortfolioPromiseResource,
} from "./portfolio/index.ts"
import {
  makeSourcesEffectResource,
  makeSourcesPromiseResource,
  type SourcesEffectResource,
  type SourcesPromiseResource,
} from "./sources/index.ts"
import {
  makeTransactionsEffectResource,
  makeTransactionsPromiseResource,
  type TransactionsEffectResource,
  type TransactionsPromiseResource,
} from "./transactions/index.ts"

export {
  DEFAULT_BASE_URL,
  makeTaxMaxiEffectClient,
  makeTaxMaxiHttpClientTransform,
  normalizeBaseUrl,
} from "./client.ts"
export type {
  TaxMaxiBrowserSessionOptions,
  TaxMaxiEffectClient,
  TaxMaxiEffectClientOptions,
  TaxMaxiHeaders,
  TaxMaxiHeadersProvider,
  TaxMaxiOptions,
  TaxMaxiRequestCredentials,
  TaxMaxiRequestOptions,
} from "./client.ts"
export type {
  AdminProtocolReviewEffectResource,
  AdminProtocolReviewPromiseResource,
  ProtocolCandidateReview,
  ProtocolCandidateReviewDetail,
  ProtocolCandidateReviewDetailInput,
  ProtocolCandidateReviewList,
  ProtocolCandidateReviewListInput,
  TaxMaxiTransactionTypeList,
} from "./admin-protocol-review/index.ts"
export type {
  AssetCatalogAsset,
  AssetCatalogDetailInput,
  AssetCatalogList,
  AssetCatalogListInput,
  AssetExceptionDecisionConfirmationInput,
  AssetExceptionDecisionInput,
  AssetExceptionDetail,
  AssetExceptionList,
  AssetExceptionListInput,
  AssetExceptionLookupInput,
  AssetExceptionPreview,
  AssetRepresentation,
  AssetRequestOptions,
  AssetsEffectResource,
  AssetsPromiseResource,
  PendingAsset,
  PendingAssetList,
  PendingAssetListInput,
  TaxMaxiAssetType,
} from "./assets/index.ts"
export type {
  AssetOverrideCreateError,
  AssetOverrideCreateInput,
  AssetOverrideCreateResult,
  AssetOverrideCurrent,
  AssetOverrideCurrentError,
  AssetOverrideHistory,
  AssetOverrideHistoryError,
  AssetOverrideIdentityValidation,
  AssetOverrideIdentityValidationError,
  AssetOverrideIdentityValidationInput,
  AssetOverrideReplaceError,
  AssetOverrideReplaceInput,
  AssetOverrideReplacement,
  AssetOverridesEffectResource,
  AssetOverridesPromiseResource,
  AssetOverrideTarget,
  AssetOverrideWithdrawError,
  AssetOverrideWithdrawInput,
  AssetOverrideWithdrawal,
  TaxMaxiAssetOverrideError,
} from "./asset-overrides/index.ts"
export type {
  TransactionOverrideCurrent,
  TransactionOverrideHistory,
  TransactionOverrideTargets,
  TransactionOverrideMutationResult,
  TransactionOverrideSet,
  TransactionOverrideWithdrawal,
  TransactionOverridePriceInput,
  TransactionOverrideClassificationInput,
  TransactionOverrideReadInput,
  TransactionOverrideDiscoveryInput,
  TransactionOverrideCreateInput,
  TransactionOverrideReplaceInput,
  TransactionOverrideWithdrawInput,
  TransactionOverrideTargetsError,
  TransactionOverrideCurrentError,
  TransactionOverrideHistoryError,
  TransactionOverrideCreateError,
  TransactionOverrideReplaceError,
  TransactionOverrideWithdrawError,
  TaxMaxiTransactionOverrideError,
  TransactionOverridesEffectResource,
  TransactionOverridesPromiseResource,
} from "./transaction-overrides/index.ts"
export type {
  Account,
  AuthAuthorizeRedirectResponse,
  AuthEffectResource,
  AuthLogoutResponse,
  AuthOAuthSessionResponse,
  AuthPromiseResource,
} from "./auth/index.ts"
export {
  TaxMaxiError,
  getTaxMaxiAssetOverrideError,
  getTaxMaxiTransactionOverrideError,
  getTaxMaxiAssetDecisionConflict,
  getTaxMaxiAssetDecisionErrorCode,
  getTaxMaxiAssetLookupErrorCode,
  getTaxMaxiCreditRequired,
  isTaxMaxiUnauthorizedError,
  toTaxMaxiError,
} from "./errors.ts"
export type {
  TaxMaxiAssetDecisionConflict,
  TaxMaxiAssetDecisionErrorCode,
  TaxMaxiAssetLookupErrorCode,
  TaxMaxiCreditRequired,
  TaxMaxiFieldError,
} from "./errors.ts"
export type {
  BillingCatalog,
  BillingEffectResource,
  BillingPromiseResource,
  BillingRedirect,
  BillingStatus,
} from "./billing/index.ts"
export type {
  PortfolioAssets,
  PortfolioAssetsInput,
  PortfolioEffectResource,
  PortfolioPromiseResource,
} from "./portfolio/index.ts"
export type {
  AnonEffectResource,
  AnonPromiseResource,
  AnonSession,
  AnonSessionChallenge,
  AnonSessionCreateInput,
  AnonSessionDelete,
  AnonSourceHandle,
  AnonSourceInput,
  AnonSourceJobInput,
  AnonSourceList,
  AnonSourceSyncJob,
} from "./anon/index.ts"
export type {
  CalculateTaxInput,
  Source,
  SourceAssetPnl,
  SourceCreate,
  SourceCreateInput,
  SourceDisposalExplanation,
  SourceDisposalExplanationInput,
  SourceFifoLots,
  SourceIdInput,
  SourceList,
  SourceOverview,
  SourceReportPageInput,
  SourcesEffectResource,
  SourcesPromiseResource,
  SourceSyncJob,
  SourceSyncJobInput,
  SourceSyncStart,
  SourceTaxEvents,
  SourceTransactions,
  TaxCalculation,
} from "./sources/index.ts"
export type {
  TransactionDetail,
  TransactionDetailInput,
  TransactionDetailError,
  TransactionListInput,
  TransactionListItem,
  Transactions,
  TransactionsEffectResource,
  TransactionsPromiseResource,
} from "./transactions/index.ts"

export type TaxMaxiEffectResources = {
  readonly adminProtocolReview: AdminProtocolReviewEffectResource
  readonly anon: AnonEffectResource
  readonly assetOverrides: AssetOverridesEffectResource
  readonly assets: AssetsEffectResource
  readonly auth: AuthEffectResource
  readonly billing: BillingEffectResource
  readonly portfolio: PortfolioEffectResource
  readonly sources: SourcesEffectResource
  readonly transactions: TransactionsEffectResource
  readonly transactionOverrides: TransactionOverridesEffectResource
}

export type TaxMaxiPromiseResources = {
  readonly adminProtocolReview: AdminProtocolReviewPromiseResource
  readonly anon: AnonPromiseResource
  readonly assetOverrides: AssetOverridesPromiseResource
  readonly assets: AssetsPromiseResource
  readonly auth: AuthPromiseResource
  readonly billing: BillingPromiseResource
  readonly portfolio: PortfolioPromiseResource
  readonly sources: SourcesPromiseResource
  readonly transactions: TransactionsPromiseResource
  readonly transactionOverrides: TransactionOverridesPromiseResource
}

const makeTaxMaxiEffectResources = (
  client: Effect.Effect<TaxMaxiEffectClient, never>
): TaxMaxiEffectResources => ({
  adminProtocolReview: makeAdminProtocolReviewEffectResource(client),
  anon: makeAnonEffectResource(client),
  assetOverrides: makeAssetOverridesEffectResource(client),
  assets: makeAssetsEffectResource(client),
  auth: makeAuthEffectResource(client),
  billing: makeBillingEffectResource(client),
  portfolio: makePortfolioEffectResource(client),
  sources: makeSourcesEffectResource(client),
  transactions: makeTransactionsEffectResource(client),
  transactionOverrides: makeTransactionOverridesEffectResource(client),
})

const mergeHeaders =
  (
    headers: TaxMaxiHeadersProvider | undefined,
    additionalHeaders: TaxMaxiHeaders
  ): TaxMaxiHeadersProvider =>
  () => ({
    ...resolveHeaders(headers),
    ...additionalHeaders,
  })

export class TaxMaxi implements TaxMaxiPromiseResources {
  readonly adminProtocolReview: AdminProtocolReviewPromiseResource
  readonly anon: AnonPromiseResource
  readonly assetOverrides: AssetOverridesPromiseResource
  readonly assets: AssetsPromiseResource
  readonly auth: AuthPromiseResource
  readonly billing: BillingPromiseResource
  readonly portfolio: PortfolioPromiseResource
  readonly effect: TaxMaxiEffectResources
  readonly sources: SourcesPromiseResource
  readonly transactions: TransactionsPromiseResource
  readonly transactionOverrides: TransactionOverridesPromiseResource

  private readonly client: Effect.Effect<TaxMaxiEffectClient, never>

  constructor(options: TaxMaxiOptions) {
    this.client = makeTaxMaxiEffectClient(options)
    this.effect = makeTaxMaxiEffectResources(this.client)
    this.adminProtocolReview = makeAdminProtocolReviewPromiseResource(
      this.effect.adminProtocolReview,
      this.run
    )
    this.anon = makeAnonPromiseResource(this.effect.anon, this.run)
    this.assetOverrides = makeAssetOverridesPromiseResource(this.effect.assetOverrides, this.run)
    this.assets = makeAssetsPromiseResource(this.effect.assets, this.run)
    this.auth = makeAuthPromiseResource(this.effect.auth, this.run)
    this.billing = makeBillingPromiseResource(this.effect.billing, this.run)
    this.portfolio = makePortfolioPromiseResource(this.effect.portfolio, this.run)
    this.sources = makeSourcesPromiseResource(this.effect.sources, this.run)
    this.transactions = makeTransactionsPromiseResource(this.effect.transactions, this.run)
    this.transactionOverrides = makeTransactionOverridesPromiseResource(
      this.effect.transactionOverrides,
      this.run
    )
  }

  static makeEffectClient(
    options: TaxMaxiEffectClientOptions = {}
  ): Effect.Effect<TaxMaxiEffectClient, never> {
    return makeTaxMaxiEffectClient(options)
  }

  static fromBrowserSession(options: TaxMaxiBrowserSessionOptions = {}): TaxMaxi {
    return TaxMaxi.fromEffectClientOptions({
      ...options,
      credentials: options.credentials ?? "include",
    })
  }

  static fromRequest(options: TaxMaxiRequestOptions): TaxMaxi {
    return TaxMaxi.fromEffectClientOptions({
      ...options,
      headers: mergeHeaders(options.headers, {
        cookie: options.cookieHeader,
      }),
    })
  }

  private static fromEffectClientOptions(options: TaxMaxiEffectClientOptions): TaxMaxi {
    return new TaxMaxi({
      ...options,
      apiKey: options.apiKey ?? "",
    })
  }

  private readonly run = <A>(
    effect: Effect.Effect<A, unknown, never>,
    options?: AssetRequestOptions
  ): Promise<A> =>
    Effect.runPromise(effect, options).catch((error: unknown) => {
      throw toTaxMaxiError(error)
    })
}
