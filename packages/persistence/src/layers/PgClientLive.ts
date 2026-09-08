/**
 * PgClientLive - PostgreSQL client layer for production use
 *
 * Provides a configured PgClient.layer with connection pooling.
 * Configuration is read from environment variables or Config service.
 *
 * @module PgClientLive
 */

import { PgClient } from "@effect/sql-pg"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import { fileURLToPath } from "node:url"
import * as Config from "effect/Config"
import type { ConfigError } from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { types } from "pg"

/**
 * Configuration for PgClient connection.
 * Reads from environment variables with sensible defaults.
 */
export const PgClientConfig = Config.all({
  url: Config.redacted("DATABASE_URL").pipe(
    Config.orElse(() =>
      Config.all({
        host: Config.string("PGHOST").pipe(Config.withDefault("localhost")),
        port: Config.int("PGPORT").pipe(Config.withDefault(5432)),
        user: Config.string("PGUSER").pipe(Config.withDefault("postgres")),
        password: Config.redacted("PGPASSWORD").pipe(Config.withDefault(Redacted.make("postgres"))),
        database: Config.string("PGDATABASE").pipe(Config.withDefault("taxmaxi")),
      }).pipe(
        Config.map(({ host, port, user, password, database }) =>
          Redacted.make(
            `postgresql://${user}:${Redacted.value(password)}@${host}:${port}/${database}`
          )
        )
      )
    )
  ),
  maxConnections: Config.int("PG_MAX_CONNECTIONS").pipe(Config.withDefault(10)),
  idleTimeout: Config.duration("PG_IDLE_TIMEOUT").pipe(Config.withDefault("60 seconds")),
  connectTimeout: Config.duration("PG_CONNECTION_TIMEOUT").pipe(Config.withDefault("10 seconds")),
})

const PG_DATE_TIME_TYPE_IDS = [1184, 1114, 1082, 1186, 1231, 1115, 1185, 1187, 1182]

const makeTypeParsers = () => ({
  getTypeParser: (typeId: number, format?: "text" | "binary") => {
    // Return raw values for date/time types to let Drizzle handle parsing
    if (PG_DATE_TIME_TYPE_IDS.includes(typeId)) {
      return (val: unknown) => val
    }
    return types.getTypeParser(typeId, format)
  },
})

/**
 * Build a PgClient layer from an explicit database URL.
 *
 * Intended for integration tests that orchestrate multiple databases
 * (for example admin DB + isolated test DB) without mutating process env.
 *
 * The caller owns the scope and must close it at teardown. Keep idle
 * connections available between fixture writes and assertions instead of
 * reconnecting after each pause. Production processes use `PgClientLive`.
 */
export const makePgClientLayerForTests = ({
  url,
  maxConnections = 10,
}: {
  readonly url: Redacted.Redacted<string>
  readonly maxConnections?: number
}): Layer.Layer<PgClient.PgClient | SqlClient, SqlError, never> =>
  PgClient.layer({
    url,
    maxConnections,
    connectTimeout: "10 seconds",
    types: makeTypeParsers(),
  })

/**
 * PgClientLive - Layer providing PgClient with production configuration.
 *
 * Reads connection configuration from environment variables:
 * - DATABASE_URL: Full PostgreSQL connection URL (preferred)
 * - Or individual vars: PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE
 * - PG_MAX_CONNECTIONS: Maximum pool connections (default: 10)
 * - PG_IDLE_TIMEOUT: Idle connection timeout (default: 60s)
 * - PG_CONNECTION_TIMEOUT: Connection timeout (default: 10s)
 *
 * Usage:
 * ```typescript
 * import { PgClientLive } from "@my/persistence/layers"
 *
 * const program = Effect.gen(function*() {
 *   const sql = yield* PgClient.PgClient
 *   // use sql...
 * }).pipe(Effect.provide(PgClientLive))
 * ```
 */
export const PgClientLive: Layer.Layer<
  PgClient.PgClient | SqlClient,
  ConfigError | SqlError,
  never
> = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* PgClientConfig
    return PgClient.layer({
      url: config.url,
      maxConnections: config.maxConnections,
      idleTimeout: config.idleTimeout,
      connectTimeout: config.connectTimeout,
      types: makeTypeParsers(),
    })
  })
)

export const drizzle = PgDrizzle.makeWithDefaults()

const PERSISTENCE_DRIZZLE_MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../../drizzle", import.meta.url)
)

/**
 * Run Drizzle SQL migrations using the Effect Postgres driver.
 *
 * This is primarily useful in test/bootstrap flows that need to migrate
 * a database programmatically without invoking CLI scripts.
 */
export const runDrizzleMigrations = ({
  migrationsFolder = PERSISTENCE_DRIZZLE_MIGRATIONS_FOLDER,
}: {
  readonly migrationsFolder?: string
} = {}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    yield* migrate(db, { migrationsFolder })
  })

/**
 * Execute an unsafe SQL statement using the currently provided PgClient.
 *
 * Intended for controlled setup/teardown statements in tests.
 */
export const runSqlUnsafe = ({
  statement,
  params,
}: {
  readonly statement: string
  readonly params?: ReadonlyArray<unknown>
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    yield* sql.unsafe(statement, params)
  })
