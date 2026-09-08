import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { makeIntegrationTestDatabaseContext } from "./integration-test-kit.ts"

const context = makeIntegrationTestDatabaseContext({ databaseNamePrefix: "taxmaxi_pool_lifetime" })
const observer = makeIntegrationTestDatabaseContext({ databaseNamePrefix: "taxmaxi_pool_observer" })

await Effect.runPromise(context.recreateTestDatabase())
await Effect.runPromise(observer.recreateTestDatabase())

const backend = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const [row] = yield* sql<{ readonly pid: number }>`select pg_backend_pid() as pid`
  return row?.pid
})

describe("file-scoped real Postgres pool", () => {
  it.live("reuses connections across helper calls and closes every connection at teardown", () =>
    Effect.gen(function* () {
      const first = yield* Effect.promise(() => context.runPg(backend))
      yield* Effect.sleep("20 millis")
      const second = yield* Effect.promise(() => context.runPg(backend))
      expect(first).toBeTypeOf("number")
      expect(second).toBe(first)
      yield* context.close()
      const sessions = yield* Effect.promise(() =>
        observer.runPg(
          Effect.gen(function* () {
            const sql = yield* PgClient.PgClient
            return yield* sql<{ readonly pid: number }>`
              select pid from pg_stat_activity where datname = ${context.databaseName}
            `
          })
        )
      )
      expect(sessions).toEqual([])
    })
  )
})
