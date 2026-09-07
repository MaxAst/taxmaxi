/**
 * AuthConfig - Configuration system for authentication providers
 *
 * Provides runtime configuration for enabling/disabling auth providers,
 * per-provider settings, and global auth behavior options.
 *
 * Configuration is loaded from environment variables:
 * - AUTH_ENABLED_PROVIDERS: Comma-separated list of enabled providers
 * - AUTH_DEFAULT_ROLE: Default role for new users
 * - AUTH_SESSION_DURATION: Session duration (e.g., "24 hours")
 * - AUTH_AUTO_LINK_BY_EMAIL: Auto-link identities by email match
 *
 * @module AuthConfig
 */

import * as Config from "effect/Config"
import type { ConfigError } from "effect/Config"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import type { Input as DurationInput } from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { AuthProviderType } from "./AuthProviderType.ts"
import { isAuthProviderType } from "./AuthProviderType.ts"
import type { UserRole } from "./AuthUser.ts"
import { isUserRole } from "./AuthUser.ts"

// =============================================================================
// Provider-specific Configuration Schemas
// =============================================================================

/**
 * LocalAuthConfig - Configuration for local (email/password) authentication
 */
export class LocalAuthConfig extends Schema.Class<LocalAuthConfig>("LocalAuthConfig")({
  /**
   * Minimum password length
   */
  minPasswordLength: Schema.Finite.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThan(0))
  ).annotate({
    title: "Minimum Password Length",
    description: "Minimum required password length",
  }),

  /**
   * Whether to require uppercase characters in passwords
   */
  requireUppercase: Schema.Boolean.annotate({
    title: "Require Uppercase",
    description: "Whether passwords must contain uppercase characters",
  }),

  /**
   * Whether to require numbers in passwords
   */
  requireNumbers: Schema.Boolean.annotate({
    title: "Require Numbers",
    description: "Whether passwords must contain numbers",
  }),

  /**
   * Whether to require special characters in passwords
   */
  requireSpecialChars: Schema.Boolean.annotate({
    title: "Require Special Characters",
    description: "Whether passwords must contain special characters",
  }),
}) {}

/**
 * GoogleAuthConfig - Configuration for Google OAuth provider
 */
export class GoogleAuthConfig extends Schema.Class<GoogleAuthConfig>("GoogleAuthConfig")({
  /**
   * Google OAuth Client ID
   */
  clientId: Schema.Trimmed.check(Schema.isNonEmpty()).annotate({
    title: "Client ID",
    description: "Google OAuth client ID from Google Cloud Console",
  }),

  /**
   * Google OAuth Client Secret
   */
  clientSecret: Schema.RedactedFromValue(Schema.Trimmed.check(Schema.isNonEmpty())).annotate({
    title: "Client Secret",
    description: "Google OAuth client secret for server-side authentication",
  }),

  /**
   * OAuth redirect URI
   */
  redirectUri: Schema.Trimmed.check(Schema.isNonEmpty()).annotate({
    title: "Redirect URI",
    description: "OAuth callback URL registered in Google Cloud Console",
  }),
}) {}

/**
 * CoinbaseAuthConfig - Configuration for Coinbase OAuth provider
 */
export class CoinbaseAuthConfig extends Schema.Class<CoinbaseAuthConfig>("CoinbaseAuthConfig")({
  /**
   * Coinbase OAuth Client ID
   */
  clientId: Schema.Trimmed.check(Schema.isNonEmpty()).annotate({
    title: "Client ID",
    description: "Coinbase OAuth client ID",
  }),

  /**
   * Coinbase OAuth Client Secret
   */
  clientSecret: Schema.RedactedFromValue(Schema.Trimmed.check(Schema.isNonEmpty())).annotate({
    title: "Client Secret",
    description: "Coinbase OAuth client secret",
  }),

  /**
   * OAuth redirect URI
   */
  redirectUri: Schema.Trimmed.check(Schema.isNonEmpty()).annotate({
    title: "Redirect URI",
    description: "OAuth callback URL registered in Coinbase",
  }),
}) {}

/**
 * ProviderConfigs - Union type for all provider configurations
 */
export type ProviderConfig = LocalAuthConfig | GoogleAuthConfig | CoinbaseAuthConfig

// =============================================================================
// Provider Configs Interface
// =============================================================================

/**
 * ProviderConfigs - Per-provider configuration settings
 */
export interface ProviderConfigs {
  readonly local: Option.Option<LocalAuthConfig>
  readonly google: Option.Option<GoogleAuthConfig>
  readonly coinbase: Option.Option<CoinbaseAuthConfig>
}

// =============================================================================
// Global Auth Configuration
// =============================================================================

/**
 * AuthConfigData - Global authentication configuration data
 *
 * Controls which providers are enabled, their configurations,
 * and global authentication behavior.
 */
export interface AuthConfigData {
  /**
   * Which auth providers are currently active
   */
  readonly enabledProviders: ReadonlyArray<AuthProviderType>

  /**
   * Per-provider configuration settings
   */
  readonly providerConfigs: ProviderConfigs

  /**
   * Default role assigned to newly registered users
   */
  readonly defaultRole: UserRole

  /**
   * Default session duration for new sessions
   */
  readonly sessionDuration: DurationInput

  /**
   * Whether to automatically link identities by email match
   *
   * When true, if a user authenticates with a new provider but
   * the email matches an existing user, the identity is linked
   * to the existing account.
   */
  readonly autoLinkByEmail: boolean
}

/**
 * AuthConfig - Context.Service for dependency injection
 *
 * Usage:
 * ```typescript
 * import { AuthConfig } from "@my/core/authentication"
 *
 * const program = Effect.gen(function* () {
 *   const config = yield* AuthConfig
 *   if (config.enabledProviders.includes("google")) {
 *     // Google auth is enabled
 *   }
 * })
 * ```
 */
export class AuthConfig extends Context.Service<AuthConfig, AuthConfigData>()("AuthConfig") {}

// =============================================================================
// Configuration Defaults
// =============================================================================

/**
 * Default LocalAuthConfig values
 */
export const localAuthDefaults: LocalAuthConfig = LocalAuthConfig.make({
  minPasswordLength: 8,
  requireUppercase: false,
  requireNumbers: false,
  requireSpecialChars: false,
})

/**
 * Default AuthConfig values
 */
export const authConfigDefaults: {
  readonly enabledProviders: ReadonlyArray<AuthProviderType>
  readonly defaultRole: UserRole
  readonly sessionDuration: Duration.Duration
  readonly autoLinkByEmail: boolean
} = {
  enabledProviders: ["local"],
  defaultRole: "member",
  sessionDuration: Duration.hours(24),
  autoLinkByEmail: true,
}

// =============================================================================
// Configuration Loading from Environment
// =============================================================================

/**
 * Parse a comma-separated list of provider types
 */
const parseProviders = (value: string): ReadonlyArray<AuthProviderType> => {
  const providers = value.split(",").map((s) => s.trim().toLowerCase())
  return providers.filter(isAuthProviderType)
}

/**
 * Parse a UserRole from string
 */
const parseUserRole = (value: string): UserRole => {
  const role = value.trim().toLowerCase()
  if (isUserRole(role)) {
    return role
  }
  return "member"
}

/**
 * Config for local auth provider settings
 */
const localAuthConfig: Config.Config<Option.Option<LocalAuthConfig>> = Config.all({
  minPasswordLength: Config.int("MIN_PASSWORD_LENGTH").pipe(
    Config.withDefault(localAuthDefaults.minPasswordLength)
  ),
  requireUppercase: Config.boolean("REQUIRE_UPPERCASE").pipe(
    Config.withDefault(localAuthDefaults.requireUppercase)
  ),
  requireNumbers: Config.boolean("REQUIRE_NUMBERS").pipe(
    Config.withDefault(localAuthDefaults.requireNumbers)
  ),
  requireSpecialChars: Config.boolean("REQUIRE_SPECIAL_CHARS").pipe(
    Config.withDefault(localAuthDefaults.requireSpecialChars)
  ),
}).pipe(
  Config.nested("AUTH_LOCAL"),
  Config.map((c) => Option.some(LocalAuthConfig.make(c))),
  Config.withDefault(Option.some(localAuthDefaults))
)

/**
 * Config for Google auth provider settings
 */
const googleAuthConfig: Config.Config<Option.Option<GoogleAuthConfig>> = Config.all({
  clientId: Config.string("CLIENT_ID"),
  clientSecret: Config.redacted("CLIENT_SECRET"),
  redirectUri: Config.string("REDIRECT_URI"),
}).pipe(
  Config.nested("AUTH_GOOGLE"),
  Config.map((c) =>
    Option.some(
      GoogleAuthConfig.make({
        clientId: c.clientId,
        clientSecret: c.clientSecret,
        redirectUri: c.redirectUri,
      })
    )
  ),
  Config.orElse(() => Config.succeed(Option.none()))
)

/**
 * Config for Coinbase auth provider settings
 */
const coinbaseAuthConfig: Config.Config<Option.Option<CoinbaseAuthConfig>> = Config.all({
  clientId: Config.string("CLIENT_ID"),
  clientSecret: Config.redacted("CLIENT_SECRET"),
  redirectUri: Config.string("REDIRECT_URI"),
}).pipe(
  Config.nested("AUTH_COINBASE"),
  Config.map((c) =>
    Option.some(
      CoinbaseAuthConfig.make({
        clientId: c.clientId,
        clientSecret: c.clientSecret,
        redirectUri: c.redirectUri,
      })
    )
  ),
  Config.orElse(() => Config.succeed(Option.none()))
)

/**
 * Full AuthConfig from environment variables
 */
export const authConfig: Config.Config<AuthConfigData> = Config.all({
  enabledProviders: Config.string("AUTH_ENABLED_PROVIDERS").pipe(
    Config.map(parseProviders),
    Config.withDefault(authConfigDefaults.enabledProviders)
  ),
  defaultRole: Config.string("AUTH_DEFAULT_ROLE").pipe(
    Config.map(parseUserRole),
    Config.withDefault(authConfigDefaults.defaultRole)
  ),
  sessionDuration: Config.duration("AUTH_SESSION_DURATION").pipe(
    Config.withDefault(authConfigDefaults.sessionDuration)
  ),
  autoLinkByEmail: Config.boolean("AUTH_AUTO_LINK_BY_EMAIL").pipe(
    Config.withDefault(authConfigDefaults.autoLinkByEmail)
  ),
  local: localAuthConfig,
  google: googleAuthConfig,
  coinbase: coinbaseAuthConfig,
}).pipe(
  Config.map(
    (c): AuthConfigData => ({
      enabledProviders: c.enabledProviders,
      defaultRole: c.defaultRole,
      sessionDuration: c.sessionDuration,
      autoLinkByEmail: c.autoLinkByEmail,
      providerConfigs: {
        local: c.local,
        google: c.google,
        coinbase: c.coinbase,
      },
    })
  )
)

/**
 * AuthConfig loaded from environment
 */
export const authConfigFromEnv: Effect.Effect<AuthConfigData, ConfigError> = authConfig

// =============================================================================
// Layer
// =============================================================================

/**
 * AuthConfigLive - Layer providing AuthConfig from environment variables
 *
 * Reads configuration from:
 * - AUTH_ENABLED_PROVIDERS: Comma-separated list (default: "local")
 * - AUTH_DEFAULT_ROLE: Default user role (default: "member")
 * - AUTH_SESSION_DURATION: Session duration (default: "24 hours")
 * - AUTH_AUTO_LINK_BY_EMAIL: Auto-link by email (default: true)
 *
 * Provider-specific configs (nested):
 * - AUTH_LOCAL_*: Local auth settings
 * - AUTH_GOOGLE_*: Google settings (CLIENT_ID, CLIENT_SECRET, REDIRECT_URI)
 * - AUTH_COINBASE_*: Coinbase settings (CLIENT_ID, CLIENT_SECRET, REDIRECT_URI)
 */
export const AuthConfigLive: Layer.Layer<AuthConfig, ConfigError> = Layer.effect(
  AuthConfig,
  authConfigFromEnv
)

/**
 * Create an AuthConfig layer with partial overrides
 *
 * Useful for tests or specific configurations where you want to
 * use defaults but override specific values.
 */
export const makeAuthConfigLayer = (
  overrides?: Partial<AuthConfigData>
): Layer.Layer<AuthConfig, ConfigError> =>
  Layer.effect(
    AuthConfig,
    Effect.map(
      authConfigFromEnv,
      (config): AuthConfigData => ({
        ...config,
        ...overrides,
        providerConfigs: {
          ...config.providerConfigs,
          ...overrides?.providerConfigs,
        },
      })
    )
  )

/**
 * Create an AuthConfig layer with all values specified directly
 * (no environment loading)
 *
 * Useful for tests where you want full control over the configuration.
 */
export const makeAuthConfig = (config: AuthConfigData): Layer.Layer<AuthConfig> =>
  Layer.succeed(AuthConfig, config)

// =============================================================================
// Helpers
// =============================================================================

/**
 * Check if a provider is enabled in the config
 */
export const isProviderEnabled = (config: AuthConfigData, provider: AuthProviderType): boolean =>
  config.enabledProviders.includes(provider)

/**
 * Get the local auth provider config
 */
export const getLocalConfig = (config: AuthConfigData): Option.Option<LocalAuthConfig> =>
  config.providerConfigs.local

/**
 * Get the Google auth provider config
 */
export const getGoogleConfig = (config: AuthConfigData): Option.Option<GoogleAuthConfig> =>
  config.providerConfigs.google

/**
 * Get the GitHub auth provider config
 */
export const getCoinbaseConfig = (config: AuthConfigData): Option.Option<CoinbaseAuthConfig> =>
  config.providerConfigs.coinbase

/**
 * Get the configuration for a specific provider
 */
export const getProviderConfig = (
  config: AuthConfigData,
  provider: AuthProviderType
): Option.Option<ProviderConfig> => {
  switch (provider) {
    case "local":
      return config.providerConfigs.local
    case "coinbase":
      return config.providerConfigs.coinbase
    case "google":
      return config.providerConfigs.google
  }
}

/**
 * Check if a provider is both enabled and configured
 */
export const isProviderAvailable = (config: AuthConfigData, provider: AuthProviderType): boolean =>
  isProviderEnabled(config, provider) && Option.isSome(getProviderConfig(config, provider))
