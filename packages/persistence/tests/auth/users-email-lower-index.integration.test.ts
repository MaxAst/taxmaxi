import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { databaseErrorMetadata } from "../../src/errors/DatabaseErrorMetadata.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import { makeIntegrationTestDatabaseContext } from "../support/integration-test-kit.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_users_email_lower_index",
})

await Effect.runPromise(context.recreateTestDatabase())

const FIRST_USER_ID = "00000000-4000-4000-8000-000000000801"
const SECOND_USER_ID = "00000000-4000-4000-8000-000000000802"

const insertUser = ({ id, email }: { readonly id: string; readonly email: string }) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db.insert(schema.users).values({
      id,
      email,
      emailVerified: false,
    })
  }).pipe(Effect.provide(context.TestPgClientLive), Effect.scoped)

const readStoredEmails = () =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const rows = yield* db.select({ email: schema.users.email }).from(schema.users)
    return rows.map((row) => row.email)
  }).pipe(Effect.provide(context.TestPgClientLive), Effect.scoped)

describe("users email index", () => {
  it.effect("rejects a case-variant duplicate email even from a raw insert", () =>
    Effect.gen(function* () {
      yield* insertUser({ id: FIRST_USER_ID, email: "a@x.test" })

      const duplicate = yield* insertUser({ id: SECOND_USER_ID, email: "A@x.test" }).pipe(
        Effect.result
      )

      expect(Result.isFailure(duplicate)).toBe(true)
      if (Result.isFailure(duplicate)) {
        expect(databaseErrorMetadata(duplicate.failure)).toMatchObject({
          code: "23505",
          constraint: "users_email_lower_uidx",
        })
      }

      expect(yield* readStoredEmails()).toEqual(["a@x.test"])
    })
  )
})
