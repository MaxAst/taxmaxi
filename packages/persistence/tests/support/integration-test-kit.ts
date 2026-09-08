import * as DateTime from "effect/DateTime"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import { PgClient } from "@effect/sql-pg"
import { eq } from "drizzle-orm"
import * as Config from "effect/Config"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Scope from "effect/Scope"
import { afterAll, inject } from "vitest"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import {
  makePgClientLayerForTests,
  runDrizzleMigrations,
  runSqlUnsafe,
} from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  makeIntegrationTestDatabaseName,
  makeTestDatabaseTemplateName,
} from "./test-database-name.ts"

const testDatabaseConfig = Effect.runSync(
  Effect.gen(function* () {
    const workerId = yield* Config.string("VITEST_WORKER_ID").pipe(Config.withDefault("1"))
    const host = yield* Config.string("PGHOST").pipe(Config.withDefault("localhost"))
    // Integration tests always target the db-test compose service, never the
    // dev database on PGPORT. See compose.yaml.
    const port = yield* Config.int("TEST_PGPORT").pipe(Config.withDefault(5433))
    const user = yield* Config.string("PGUSER").pipe(Config.withDefault("postgres"))
    const password = yield* Config.redacted("PGPASSWORD").pipe(
      Config.withDefault(Redacted.make("postgres"))
    )

    return { workerId, host, port, user, password } as const
  })
)

const workerId = testDatabaseConfig.workerId.replace(/[^a-zA-Z0-9_]/g, "_")
const testRunId = inject("integrationTestRunId")
const migratedTestDatabaseTemplateName = makeTestDatabaseTemplateName({ testRunId })
const pgHost = testDatabaseConfig.host
const pgPort = testDatabaseConfig.port
const pgUser = testDatabaseConfig.user
const pgPassword = Redacted.value(testDatabaseConfig.password)

export const TEST_USER_ID = "00000000-0000-0000-0000-000000000181"
export const TEST_PRINCIPAL_ID = "00000000-0000-0000-0000-000000000183"
export const TEST_SOURCE_ID = "00000000-0000-0000-0000-000000000281"
export const TEST_RAW_RECORD_ID = "00000000-0000-0000-0000-000000000381"
export const TEST_BTC_ASSET_ID = "00000000-0000-4000-8000-000000000481"
export const TEST_EUR_ASSET_ID = "00000000-0000-0000-0000-000000000482"
export const TEST_BTC_REPRESENTATION_ID = "00000000-0000-0000-0000-000000000581"
export const TEST_EUR_REPRESENTATION_ID = "00000000-0000-0000-0000-000000000582"

export interface SyncEngineRepositoryFixture {
  readonly userId: string
  readonly principalId: string
  readonly sourceId: string
  readonly cexAccountId: string
  readonly baseBlockchainId: string
  readonly bitcoinBlockchainId: string
}

export type SyncEngineRepositoryTestRuntime = PgClient.PgClient | SqlClient

const quoteIdentifier = (identifier: string) => `"${identifier.replaceAll(`"`, `""`)}"`
const quoteSqlLiteral = (value: string) => `'${value.replaceAll(`'`, `''`)}'`

const PRESERVED_TEST_RESET_TABLES = [
  "__drizzle_migrations",
  "blockchains",
  "cex",
  "contract_registry",
  "event_signatures",
  "function_signatures",
  "jurisdiction_rule_set_rules",
  "jurisdiction_rule_sets",
  "legal_clauses",
  "legal_rule_citations",
  "legal_rules",
  "legal_sources",
  "protocol_function_mappings",
  "transaction_categories",
  "transaction_subcategories",
  "transaction_type_legal_rules",
  "transaction_types",
] as const

const preservedTestResetTablesSql = PRESERVED_TEST_RESET_TABLES.map(quoteSqlLiteral).join(", ")

/** A lazy real Postgres pool owned by the file, not by individual helper calls. */
const makeTestPgPool = (options: Parameters<typeof makePgClientLayerForTests>[0]) => {
  const scope = Scope.makeUnsafe()
  const context = Effect.runSync(
    Effect.cached(Layer.buildWithScope(makePgClientLayerForTests(options), scope))
  )

  return {
    layer: Layer.effectContext(context),
    close: Scope.close(scope, Exit.void),
  }
}

/**
 * Real Postgres with one isolated database and pool per file. Calls commit
 * normally, including across independent HTTP requests and concurrent fibers.
 * Pools close before database recreation and in the file's afterAll hook.
 */
export const makeIntegrationTestDatabaseContext = ({
  databaseNamePrefix,
  maxConnections = 4,
}: {
  readonly databaseNamePrefix: string
  /** Include a connection for lock observers as well as concurrent writers. */
  readonly maxConnections?: number
}) => {
  const databaseName = makeIntegrationTestDatabaseName({
    databaseNamePrefix,
    testRunId,
    workerId,
  })
  let defaultSchemaMigrated = false

  const testDatabaseUrl = Redacted.make(
    `postgresql://${pgUser}:${pgPassword}@${pgHost}:${pgPort}/${databaseName}`
  )
  const adminDatabaseUrl = Redacted.make(
    `postgresql://${pgUser}:${pgPassword}@${pgHost}:${pgPort}/postgres`
  )

  let testPool = makeTestPgPool({ url: testDatabaseUrl, maxConnections })
  // Keep this layer value stable for callers that assemble layers before setup.
  const TestPgClientLive = Layer.unwrap(Effect.sync(() => testPool.layer))
  const adminPool = makeTestPgPool({
    url: adminDatabaseUrl,
    maxConnections: 1,
  })
  const AdminPgClientLive = adminPool.layer

  const close = () => Effect.all([testPool.close, adminPool.close], { discard: true })
  afterAll(() => Effect.runPromise(close()))

  const closeTestPool = Effect.gen(function* () {
    yield* testPool.close
    testPool = makeTestPgPool({ url: testDatabaseUrl, maxConnections })
  })

  const runAdminSql = ({
    statement,
    params,
  }: {
    readonly statement: string
    readonly params?: ReadonlyArray<unknown>
  }) =>
    runSqlUnsafe(params === undefined ? { statement } : { statement, params }).pipe(
      Effect.provide(AdminPgClientLive),
      Effect.asVoid,
      Effect.scoped
    )

  const migrateTestDatabaseFromFolder = ({
    migrationsFolder,
  }: {
    readonly migrationsFolder: string
  }) =>
    runDrizzleMigrations({ migrationsFolder }).pipe(Effect.provide(TestPgClientLive), Effect.scoped)

  const terminateTestDatabaseConnections = () =>
    closeTestPool.pipe(
      Effect.andThen(
        runAdminSql({
          statement: `
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = $1
          AND pid <> pg_backend_pid()
      `,
          params: [databaseName],
        })
      )
    )

  const cloneMigratedTemplateDatabase = () =>
    Effect.gen(function* () {
      yield* terminateTestDatabaseConnections()
      yield* runAdminSql({
        statement: `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`,
      })
      yield* runAdminSql({
        statement: `CREATE DATABASE ${quoteIdentifier(databaseName)} TEMPLATE ${quoteIdentifier(
          migratedTestDatabaseTemplateName
        )}`,
      })
    })

  /**
   * Empty every mutable table before a test. DELETE only the tables that hold
   * rows: TRUNCATE rewrites the files of all 70 tables and 300+ indexes even
   * when they are empty, which cost 130-230 ms per test. Replica mode skips
   * row triggers (append-only guards) and FK checks for this transaction, the
   * same as TRUNCATE did. The schema has no sequences, so nothing to restart.
   */
  const resetTestData = () =>
    runSqlUnsafe({
      statement: `
        DO $$
        DECLARE
          t text;
          has_rows boolean;
        BEGIN
          PERFORM set_config('session_replication_role', 'replica', true);

          FOR t IN
            SELECT tablename FROM pg_tables
            WHERE schemaname = 'public'
              AND tablename <> ALL(ARRAY[${preservedTestResetTablesSql}])
          LOOP
            EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', t) INTO has_rows;
            IF has_rows THEN
              EXECUTE format('DELETE FROM public.%I', t);
            END IF;
          END LOOP;
        END $$;
      `,
    }).pipe(Effect.provide(TestPgClientLive), Effect.asVoid, Effect.scoped)

  const recreateTestDatabase = ({
    migrationsFolder,
  }: {
    readonly migrationsFolder?: string
  } = {}) =>
    Effect.gen(function* () {
      if (migrationsFolder === undefined && defaultSchemaMigrated) {
        yield* resetTestData()
        return
      }

      if (migrationsFolder === undefined) {
        yield* cloneMigratedTemplateDatabase()
        defaultSchemaMigrated = true
      } else {
        yield* terminateTestDatabaseConnections()
        yield* runAdminSql({
          statement: `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`,
        })
        yield* runAdminSql({
          statement: `CREATE DATABASE ${quoteIdentifier(databaseName)}`,
        })
        yield* migrateTestDatabaseFromFolder({ migrationsFolder })
        defaultSchemaMigrated = false
      }
    })

  const recreateEmptyTestDatabase = () =>
    Effect.gen(function* () {
      yield* terminateTestDatabaseConnections()
      yield* runAdminSql({
        statement: `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`,
      })
      yield* runAdminSql({
        statement: `CREATE DATABASE ${quoteIdentifier(databaseName)}`,
      })
      defaultSchemaMigrated = false
    })

  const runPg = <A, E>(effect: Effect.Effect<A, E, SyncEngineRepositoryTestRuntime>) =>
    Effect.runPromise(effect.pipe(Effect.provide(TestPgClientLive), Effect.scoped))

  /** Wait on this database's actual lock state, bounded by the live clock. */
  const waitForQueryBlockedOnLock = ({
    queryIncludes,
    minimumWaiters = 1,
  }: {
    readonly queryIncludes: string
    readonly minimumWaiters?: number
  }) =>
    runPg(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient

        while (true) {
          const [activity] = yield* sql<{ readonly count: number }>`
            select count(*)::int as count
            from pg_stat_activity
            where datname = current_database()
              and pid <> pg_backend_pid()
              and state = 'active'
              and wait_event_type = 'Lock'
              and position(${queryIncludes} in query) > 0
          `

          if (activity !== undefined && activity.count >= minimumWaiters) return
          yield* Effect.sleep("10 millis")
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: "2 seconds",
          orElse: () =>
            Effect.die(
              `Timed out waiting for ${minimumWaiters} lock waiter(s) containing ${queryIncludes} in ${databaseName}`
            ),
        })
      )
    )

  /** Hold a real transaction lock until released, also releasing on scope exit. */
  const holdAdvisoryLock = ({ key }: { readonly key: string }) =>
    Effect.gen(function* () {
      const acquired = yield* Deferred.make<void>()
      const released = yield* Deferred.make<void>()
      const holder = yield* Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`
            yield* Deferred.succeed(acquired, undefined)
            yield* Deferred.await(released)
          })
        )
      }).pipe(Effect.provide(TestPgClientLive), Effect.forkScoped)
      yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined))
      // Surface acquisition errors instead of waiting forever for the signal.
      yield* Effect.raceFirst(Deferred.await(acquired), Fiber.join(holder))

      return {
        release: Deferred.succeed(released, undefined).pipe(
          Effect.andThen(Fiber.join(holder)),
          Effect.orDie
        ),
      }
    })

  const runWithLayer = <A, E, R, LE>({
    effect,
    layer,
  }: {
    readonly effect: Effect.Effect<A, E, R>
    readonly layer: Layer.Layer<R, LE, PgClient.PgClient | SqlClient>
  }) => effect.pipe(Effect.provide(layer.pipe(Layer.provideMerge(TestPgClientLive))), Effect.scoped)

  return {
    databaseName,
    TestPgClientLive,
    recreateTestDatabase,
    recreateEmptyTestDatabase,
    runPg,
    runWithLayer,
    waitForQueryBlockedOnLock,
    holdAdvisoryLock,
    close,
  }
}

const requireBlockchainId = ({ name }: { readonly name: string }) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [blockchain] = yield* db
      .select({ id: schema.blockchains.id })
      .from(schema.blockchains)
      .where(eq(schema.blockchains.name, name))
      .limit(1)

    if (blockchain === undefined) {
      return yield* Effect.die(`Missing blockchain fixture for ${name}`)
    }

    return blockchain.id
  })

export const seedSyncEngineRepositoryFixture = ({
  userId = TEST_USER_ID,
  principalId = TEST_PRINCIPAL_ID,
  sourceId = TEST_SOURCE_ID,
}: {
  readonly userId?: string
  readonly principalId?: string
  readonly sourceId?: string
} = {}) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db.insert(schema.users).values({
      id: userId,
      email: `sync-engine-${userId}@taxmaxi.test`,
      name: "Sync Engine Repository Test User",
    })
    yield* db.insert(schema.principals).values({
      id: principalId,
      kind: "user",
      userId,
    })
    yield* db.insert(schema.billingAccounts).values({
      userId,
      stripeCustomerId: `cus_test_${userId}`,
    })
    yield* db.insert(schema.creditLedger).values({
      userId,
      delta: 100_000,
      kind: "manual_adjustment",
      reference: `test:sync-credit:${userId}`,
      paymentReference: null,
      expiresAt: null,
    })

    const cexId = yield* db
      .select({ id: schema.cex.id })
      .from(schema.cex)
      .where(eq(schema.cex.name, "coinbase"))
      .limit(1)
      .pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.die("Missing seeded coinbase CEX fixture")
            : Effect.succeed(rows[0].id)
        )
      )

    const [createdAccount] = yield* db
      .insert(schema.cexAccount)
      .values({
        cexId,
        principalId,
        providerUserId: `coinbase-user-${sourceId}`,
        providerAccountId: "coinbase-account-1",
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        expiresAt: DateTime.toDateUtc(DateTime.addDuration(yield* DateTime.now, "1 hour")),
        scopes: "wallet:accounts:read wallet:transactions:read",
      })
      .returning({ id: schema.cexAccount.id })

    if (createdAccount === undefined) {
      return yield* Effect.die("Failed to create cex account fixture")
    }

    yield* db.insert(schema.sources).values({
      id: sourceId,
      principalId,
      name: `Coinbase Source ${sourceId}`,
      providerKey: "coinbase",
      sourceableType: "cex",
      cexAccountId: createdAccount.id,
      addressId: null,
      createdAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
      updatedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
    })

    const baseBlockchainId = yield* requireBlockchainId({ name: "base" })
    const bitcoinBlockchainId = yield* requireBlockchainId({ name: "bitcoin" })

    return {
      userId,
      principalId,
      sourceId,
      cexAccountId: createdAccount.id,
      baseBlockchainId,
      bitcoinBlockchainId,
    } satisfies SyncEngineRepositoryFixture
  })

export const seedSyncEngineAssets = ({
  baseBlockchainId,
  bitcoinBlockchainId,
}: {
  readonly baseBlockchainId: string
  readonly bitcoinBlockchainId: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db.insert(schema.assets).values([
      {
        id: TEST_BTC_ASSET_ID,
        name: "Sync Engine Bitcoin Fixture",
        symbol: "BTC",
        coingeckoCoinId: "bitcoin",
        type: "fungible",
      },
      {
        id: TEST_EUR_ASSET_ID,
        name: "Sync Engine Euro Fixture",
        symbol: "EUR",
        type: "fungible",
      },
    ])

    yield* db.insert(schema.assetRepresentations).values([
      {
        id: TEST_BTC_REPRESENTATION_ID,
        assetId: TEST_BTC_ASSET_ID,
        blockchainId: bitcoinBlockchainId,
        contractAddress: "sync-engine-btc-fixture",
        mintAddress: null,
        decimals: 8,
        type: "token",
      },
      {
        id: TEST_EUR_REPRESENTATION_ID,
        assetId: TEST_EUR_ASSET_ID,
        blockchainId: baseBlockchainId,
        contractAddress: "sync-engine-eur-fixture",
        mintAddress: null,
        decimals: 2,
        type: "token",
      },
    ])
  })
