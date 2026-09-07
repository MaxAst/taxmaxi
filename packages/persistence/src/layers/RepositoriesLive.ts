/**
 * RepositoriesLive - Combined layer providing all real repository implementations
 *
 * This module provides a single layer that combines all repository implementations
 * for use in production and testing with real database connections.
 *
 * Dependencies:
 * - PgClient.PgClient (SqlClient.SqlClient) - Must be provided by the caller
 *
 * @module RepositoriesLive
 */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Chunk from "effect/Chunk"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import {
  authConfigFromEnv,
  localAuthDefaults,
  type AuthProvider,
  type AuthConfigData,
  PasswordHasherConfigTag,
  BcryptAdapterTag,
  BcryptPasswordHasherLive,
  SessionTokenGeneratorLive,
  SessionTokenConfigTag,
  CryptoRandomAdapterTag,
} from "@my/core/authentication"
import { UserRepositoryLive } from "./UserRepositoryLive.ts"
import { BillingRepositoryLive } from "./BillingRepositoryLive.ts"
import { EmailVerificationDeliveryServiceLive } from "./EmailVerificationDeliveryServiceLive.ts"
import { WalletNameCacheRepositoryLive } from "./WalletNameCacheRepositoryLive.ts"
import { EmailVerificationRequestRepositoryLive } from "./EmailVerificationRequestRepositoryLive.ts"
import { IdentityRepositoryLive } from "./IdentityRepositoryLive.ts"
import { SessionRepositoryLive } from "./SessionRepositoryLive.ts"
import { SourceRepositoryLive } from "./SourceRepositoryLive.ts"
import { SourceReportRepositoryLive } from "./SourceReportRepositoryLive.ts"
import { TransactionDetailRepositoryLive } from "./TransactionDetailRepositoryLive.ts"
import { TransactionListRepositoryLive } from "./TransactionListRepositoryLive.ts"
import { PortfolioRepositoryLive } from "./PortfolioRepositoryLive.ts"
import { CexAccountRepositoryLive } from "./CexAccountRepositoryLive.ts"
import { OAuthStateStoreLive } from "./OAuthStateStoreLive.ts"
import { PrincipalRepositoryLive } from "./PrincipalRepositoryLive.ts"
import { PrincipalClaimRepositoryLive } from "./PrincipalClaimRepositoryLive.ts"
import { TaxCalculationServiceLive } from "./TaxCalculationServiceLive.ts"
import { AuthServiceLive } from "./AuthServiceLive.ts"
import { CoinbaseAuthProviderLive } from "./CoinbaseAuthProviderLive.ts"
import { GoogleAuthProviderLive } from "./GoogleAuthProviderLive.ts"
import { LocalAuthProviderLive } from "./LocalAuthProviderLive.ts"
import { LegalReferenceRepositoryLive } from "./LegalReferenceRepositoryLive.ts"
import { AssetCatalogRepositoryLive } from "./AssetCatalogRepositoryLive.ts"
import { AssetExceptionRepositoryLive } from "./AssetExceptionRepositoryLive.ts"
import { AssetRepositoryLive } from "./AssetRepositoryLive.ts"
import { AssetResolutionJobRepositoryLive } from "./AssetResolutionJobRepositoryLive.ts"
import { CoinbaseCredentialRepositoryLive } from "./CoinbaseCredentialRepositoryLive.ts"
import { ProviderAssetRepositoryLive } from "./ProviderAssetRepositoryLive.ts"
import { ProviderReferenceRepositoryLive } from "./ProviderReferenceRepositoryLive.ts"
import { ProtocolCandidateRepositoryLive } from "./ProtocolCandidateRepositoryLive.ts"
import { ProtocolTransactionTypeMappingRepositoryLive } from "./ProtocolTransactionTypeMappingRepositoryLive.ts"
import { SourceNormalizationRepositoryLive } from "./SourceNormalizationRepositoryLive.ts"
import { SourceRawRecordRepositoryLive } from "./SourceRawRecordRepositoryLive.ts"
import { SourceReplayRepositoryLive } from "./SourceReplayRepositoryLive.ts"
import { SourceSyncJobRepositoryLive } from "./SourceSyncJobRepositoryLive.ts"
import { SourceSyncRunRepositoryLive } from "./SourceSyncRunRepositoryLive.ts"
import { SourceSyncStateRepositoryLive } from "./SourceSyncStateRepositoryLive.ts"
import { CalculationRunRepositoryLive } from "./CalculationRunRepositoryLive.ts"
import { PrincipalTransactionOverrideRepositoryLive } from "./PrincipalTransactionOverrideRepositoryLive.ts"
import { PrincipalAssetOverrideRepositoryLive } from "./PrincipalAssetOverrideRepositoryLive.ts"
import { SyncEngineSourceRepositoryLive } from "./SyncEngineSourceRepositoryLive.ts"
import { TransferReconciliationRepositoryLive } from "./TransferReconciliationRepositoryLive.ts"
import { SyncEngineTransactionLive } from "./SyncEngineTransactionLive.ts"
import { CoinbaseAuthProvider } from "../services/CoinbaseAuthProvider.ts"
import { CoinbaseConfigTag } from "../services/CoinbaseConfig.ts"
import { GoogleAuthProvider } from "../services/GoogleAuthProvider.ts"
import { GoogleConfigTag } from "../services/GoogleConfig.ts"
import { LocalAuthProvider } from "../services/LocalAuthProvider.ts"
import { AuthServiceConfig, SessionDurationConfig } from "../services/AuthServiceConfig.ts"
import { PersistenceError } from "../errors/RepositoryError.ts"

/**
 * RepositoriesLive - Combined layer providing all repository implementations
 *
 * This layer provides implementations for:
 * - authentication/user/session repositories and services
 * - legal reference, source, account, and tax calculation repositories
 * - sync-engine source, job, run, state, raw record, replay, and normalization repositories
 * - provider asset/reference repositories services
 *
 * All implementations use PostgreSQL via @effect/sql-pg.
 *
 * Usage:
 * ```typescript
 * import { PgClientLive, RepositoriesLive } from "@my/persistence/layers"
 *
 * const FullLayer = RepositoriesLive.pipe(
 *   Layer.provide(PgClientLive)
 * )
 * ```
 *
 * For testing with shared testcontainers:
 * ```typescript
 * import { RepositoriesLive } from "@my/persistence/layers"
 * import { SharedPgClientLive } from "./test/Utils.ts"
 *
 * const TestLayer = RepositoriesLive.pipe(
 *   Layer.provide(SharedPgClientLive)
 * )
 * ```
 */
export const RepositoriesLive = Layer.mergeAll(
  BillingRepositoryLive,
  UserRepositoryLive,
  EmailVerificationRequestRepositoryLive,
  WalletNameCacheRepositoryLive,
  IdentityRepositoryLive,
  SessionRepositoryLive,
  OAuthStateStoreLive,
  PrincipalRepositoryLive,
  PrincipalClaimRepositoryLive,
  LegalReferenceRepositoryLive,
  SourceRepositoryLive,
  SourceReportRepositoryLive,
  TransactionListRepositoryLive,
  TransactionDetailRepositoryLive,
  PortfolioRepositoryLive,
  CexAccountRepositoryLive,
  TaxCalculationServiceLive,
  AssetCatalogRepositoryLive,
  AssetExceptionRepositoryLive,
  AssetRepositoryLive,
  AssetResolutionJobRepositoryLive,
  CoinbaseCredentialRepositoryLive,
  ProviderAssetRepositoryLive,
  ProviderReferenceRepositoryLive,
  ProtocolCandidateRepositoryLive,
  ProtocolTransactionTypeMappingRepositoryLive,
  SourceNormalizationRepositoryLive,
  SourceRawRecordRepositoryLive,
  SourceReplayRepositoryLive,
  SourceSyncJobRepositoryLive,
  SourceSyncRunRepositoryLive,
  SourceSyncStateRepositoryLive,
  CalculationRunRepositoryLive,
  PrincipalAssetOverrideRepositoryLive,
  PrincipalTransactionOverrideRepositoryLive,
  SyncEngineSourceRepositoryLive,
  SyncEngineTransactionLive,
  TransferReconciliationRepositoryLive
)

// =============================================================================
// Crypto Adapters for Authentication Services
// =============================================================================

/**
 * WebCryptoAdapter - Provides random bytes using the Web Crypto API
 *
 * Works in both Node.js and browsers since crypto.getRandomValues
 * is available in both environments.
 */
const WebCryptoAdapter = Layer.succeed(CryptoRandomAdapterTag, {
  getRandomBytes: (length: number) =>
    Effect.sync(() => {
      const bytes = new Uint8Array(length)
      crypto.getRandomValues(bytes)
      return bytes
    }),
})

const runWebCrypto = <A>(operation: string, evaluate: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new PersistenceError({ operation, cause }),
  }).pipe(Effect.orDie)

/**
 * SimpleBcryptAdapter - Bcrypt adapter using the native Web Crypto API
 *
 * This is a simplified password hashing implementation using PBKDF2.
 * For production use, consider using the bcryptjs package instead.
 *
 * Note: This implementation uses PBKDF2 which is acceptable but bcrypt
 * or argon2 are preferred for password hashing.
 */
const SimpleBcryptAdapter = Layer.succeed(BcryptAdapterTag, {
  hash: (password: string, rounds: number): Effect.Effect<string> =>
    Effect.gen(function* () {
      const encoder = new TextEncoder()
      const data = encoder.encode(password)
      const salt = crypto.getRandomValues(new Uint8Array(16))
      const keyMaterial = yield* runWebCrypto("passwordHasher.hash.importKey", () =>
        crypto.subtle.importKey("raw", data, "PBKDF2", false, ["deriveBits"])
      )
      const iterations = Math.pow(2, rounds)
      const derivedBits = yield* runWebCrypto("passwordHasher.hash.deriveBits", () =>
        crypto.subtle.deriveBits(
          {
            name: "PBKDF2",
            salt,
            iterations,
            hash: "SHA-256",
          },
          keyMaterial,
          256
        )
      )
      const hashArray = new Uint8Array(derivedBits)
      const saltHex = Array.from(salt)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
      const hashHex = Array.from(hashArray)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
      return `pbkdf2$${rounds}$${saltHex}$${hashHex}`
    }),
  compare: (password: string, hash: string): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const isPbkdf2HashParts = (
        value: ReadonlyArray<string>
      ): value is readonly [scheme: string, rounds: string, saltHex: string, hashHex: string] =>
        value.length === 4 && value[0] === "pbkdf2"

      const parts = hash.split("$")
      if (!isPbkdf2HashParts(parts)) {
        return false
      }
      const [, roundsStr, saltHex, storedHashHex] = parts
      const rounds = Number.parseInt(roundsStr, 10)

      const saltBytes = saltHex.match(/.{1,2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? []
      const salt = new Uint8Array(saltBytes)
      const encoder = new TextEncoder()
      const data = encoder.encode(password)
      const keyMaterial = yield* runWebCrypto("passwordHasher.compare.importKey", () =>
        crypto.subtle.importKey("raw", data, "PBKDF2", false, ["deriveBits"])
      )
      const iterations = Math.pow(2, rounds)
      const derivedBits = yield* runWebCrypto("passwordHasher.compare.deriveBits", () =>
        crypto.subtle.deriveBits(
          {
            name: "PBKDF2",
            salt,
            iterations,
            hash: "SHA-256",
          },
          keyMaterial,
          256
        )
      )
      const hashArray = new Uint8Array(derivedBits)
      const computedHashHex = Array.from(hashArray)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")

      return computedHashHex === storedHashHex
    }),
})

// =============================================================================
// Auth Service Dependencies
// =============================================================================

/**
 * SessionTokenGeneratorWithCrypto - SessionTokenGenerator with Web Crypto
 */
const SessionTokenGeneratorWithCrypto = SessionTokenGeneratorLive.pipe(
  Layer.provide(WebCryptoAdapter),
  Layer.provide(SessionTokenConfigTag.Default)
)

/**
 * PasswordHasherWithCrypto - PasswordHasher with PBKDF2 implementation
 */
const PasswordHasherWithCrypto = BcryptPasswordHasherLive.pipe(
  Layer.provide(SimpleBcryptAdapter),
  Layer.provide(PasswordHasherConfigTag.Fast) // Use fast for development
)

/**
 * LocalAuthProviderWithDeps - LocalAuthProvider with repositories and hasher
 */
const LocalAuthProviderWithDeps = LocalAuthProviderLive.pipe(
  Layer.provide(PasswordHasherWithCrypto),
  Layer.provide(UserRepositoryLive),
  Layer.provide(IdentityRepositoryLive)
)

/**
 * GoogleConfigFromAuthConfig - Provide Google config from auth env config
 */
const GoogleConfigFromAuthConfig = Layer.effect(
  GoogleConfigTag,
  Effect.gen(function* () {
    const authConfig = yield* authConfigFromEnv.pipe(Effect.orDie)
    const googleConfig = authConfig.providerConfigs.google

    if (Option.isNone(googleConfig)) {
      return yield* Effect.die(
        "Google provider enabled but AUTH_GOOGLE_CLIENT_ID / AUTH_GOOGLE_CLIENT_SECRET / AUTH_GOOGLE_REDIRECT_URI are not configured"
      )
    }

    return googleConfig.value
  })
)

/**
 * GoogleAuthProviderWithDeps - GoogleAuthProvider with config and HTTP client
 */
const GoogleAuthProviderWithDeps = GoogleAuthProviderLive.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(GoogleConfigFromAuthConfig)
)

/**
 * CoinbaseConfigFromAuthConfig - Provide Coinbase config from auth env config
 */
const CoinbaseConfigFromAuthConfig = Layer.effect(
  CoinbaseConfigTag,
  Effect.gen(function* () {
    const authConfig = yield* authConfigFromEnv.pipe(Effect.orDie)
    const coinbaseConfig = authConfig.providerConfigs.coinbase

    if (Option.isNone(coinbaseConfig)) {
      return yield* Effect.die(
        "Coinbase provider enabled but AUTH_COINBASE_CLIENT_ID / AUTH_COINBASE_CLIENT_SECRET / AUTH_COINBASE_REDIRECT_URI are not configured"
      )
    }

    return coinbaseConfig.value
  })
)

/**
 * CoinbaseAuthProviderWithDeps - CoinbaseAuthProvider with config and HTTP client
 */
const CoinbaseAuthProviderWithDeps = CoinbaseAuthProviderLive.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(CoinbaseConfigFromAuthConfig)
)

/**
 * Build enabled provider instances from auth configuration
 *
 * Fails fast on startup when a configured provider dependency is missing,
 * or when no providers are enabled.
 */
const buildEnabledProvidersFromConfig = (
  authConfig: AuthConfigData,
  localProvider: AuthProvider,
  googleProvider: Option.Option<AuthProvider>,
  coinbaseProvider: Option.Option<AuthProvider>
) =>
  Effect.gen(function* () {
    const providers: AuthProvider[] = []

    for (const provider of Array.from(new Set(authConfig.enabledProviders))) {
      switch (provider) {
        case "local": {
          providers.push(localProvider)
          break
        }
        case "google": {
          if (Option.isNone(googleProvider)) {
            return yield* Effect.die(
              "Google provider is enabled but GoogleAuthProvider dependency is unavailable"
            )
          }
          providers.push(googleProvider.value)
          break
        }
        case "coinbase": {
          if (Option.isNone(coinbaseProvider)) {
            return yield* Effect.die(
              "Coinbase provider is enabled but CoinbaseAuthProvider dependency is unavailable"
            )
          }
          providers.push(coinbaseProvider.value)
          break
        }
      }
    }

    if (providers.length === 0) {
      return yield* Effect.die(
        "No authentication providers enabled. Set AUTH_ENABLED_PROVIDERS to include at least one provider"
      )
    }

    return providers
  })

/**
 * AuthServiceConfigDefault - AuthService configuration from env
 *
 * Creates AuthServiceConfig using enabled providers from AUTH_ENABLED_PROVIDERS.
 */
const AuthServiceConfigDefault = Layer.effect(
  AuthServiceConfig,
  Effect.gen(function* () {
    const authConfig = yield* authConfigFromEnv.pipe(Effect.orDie)
    const localProvider = yield* LocalAuthProvider
    const localAuth = Option.getOrElse(authConfig.providerConfigs.local, () => localAuthDefaults)
    const googleProvider = authConfig.enabledProviders.includes("google")
      ? Option.some((yield* GoogleAuthProvider) satisfies AuthProvider)
      : Option.none<AuthProvider>()
    const coinbaseProvider = authConfig.enabledProviders.includes("coinbase")
      ? Option.some((yield* CoinbaseAuthProvider) satisfies AuthProvider)
      : Option.none<AuthProvider>()

    const providers = yield* buildEnabledProvidersFromConfig(
      authConfig,
      localProvider,
      googleProvider,
      coinbaseProvider
    )

    return {
      providers: Chunk.fromIterable(providers),
      sessionDurations: SessionDurationConfig.Default,
      localAuth,
      autoProvisionUsers: true,
      linkIdentitiesByEmail: authConfig.autoLinkByEmail,
    }
  })
).pipe(
  Layer.provide(LocalAuthProviderWithDeps),
  Layer.provide(GoogleAuthProviderWithDeps),
  Layer.provide(CoinbaseAuthProviderWithDeps)
)

/**
 * AuthServiceWithDeps - AuthServiceLive with all dependencies
 */
const AuthServiceWithDeps = AuthServiceLive.pipe(
  Layer.provide(AuthServiceConfigDefault),
  Layer.provide(EmailVerificationDeliveryServiceLive),
  Layer.provide(SessionTokenGeneratorWithCrypto),
  Layer.provide(PasswordHasherWithCrypto),
  Layer.provide(UserRepositoryLive),
  Layer.provide(EmailVerificationRequestRepositoryLive),
  Layer.provide(IdentityRepositoryLive),
  Layer.provide(SessionRepositoryLive),
  Layer.provide(OAuthStateStoreLive),
  Layer.provide(PrincipalRepositoryLive)
)

// =============================================================================
// Combined Layers
// =============================================================================

/**
 * AuthLive - Auth bundle for applications that need authentication services.
 *
 * Provides:
 * - AuthService
 * - PasswordHasher
 */
export const AuthLive = Layer.mergeAll(AuthServiceWithDeps, PasswordHasherWithCrypto)
