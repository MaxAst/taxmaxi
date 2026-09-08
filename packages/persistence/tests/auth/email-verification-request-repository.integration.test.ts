import { beforeEach, describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import {
  AuthUserId,
  Email,
  EmailVerificationCode,
  EmailVerificationRequestId,
} from "@my/core/authentication"
import * as Timestamp from "@my/core/shared/values/Timestamp"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { EmailVerificationRequestRepositoryLive } from "../../src/layers/EmailVerificationRequestRepositoryLive.ts"
import { schema } from "../../src/schema/index.ts"
import { EmailVerificationRequestRepository } from "../../src/services/EmailVerificationRequestRepository.ts"
import { makeIntegrationTestDatabaseContext } from "../support/integration-test-kit.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_email_verification_repo",
})

await Effect.runPromise(context.recreateTestDatabase())

const TEST_FIRST_USER_ID = AuthUserId.make("00000000-4000-4000-8000-000000000701")
const TEST_SECOND_USER_ID = AuthUserId.make("00000000-4000-4000-8000-000000000702")
const TEST_FIRST_SENT_AT = Timestamp.Timestamp.make({ epochMillis: 1_757_300_000_000 })

const runRepository = <A, E>(effect: Effect.Effect<A, E, EmailVerificationRequestRepository>) =>
  Effect.runPromise(
    context.runWithLayer({
      effect,
      layer: EmailVerificationRequestRepositoryLive,
    })
  )

const seedUser = ({ userId, email }: { readonly userId: AuthUserId; readonly email: Email }) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db.insert(schema.users).values({
      id: userId,
      email,
      emailVerified: false,
      name: email.split("@")[0],
    })
  })

describe("EmailVerificationRequestRepositoryLive", () => {
  beforeEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* context.recreateTestDatabase()
        yield* Effect.promise(() =>
          context.runPg(
            Effect.all([
              seedUser({
                userId: TEST_FIRST_USER_ID,
                email: Email.make("verification-one@example.com"),
              }),
              seedUser({
                userId: TEST_SECOND_USER_ID,
                email: Email.make("verification-two@example.com"),
              }),
            ])
          )
        )
      })
    )
  )

  it.effect("creates, loads, replaces, and consumes verification requests", () =>
    Effect.gen(function* () {
      const firstRequestId = EmailVerificationRequestId.make("00000000-4000-4000-8000-000000000711")
      const replacementRequestId = EmailVerificationRequestId.make(
        "00000000-4000-4000-8000-000000000712"
      )

      const firstCreated = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.create({
              id: firstRequestId,
              userId: TEST_FIRST_USER_ID,
              email: Email.make("verification-one@example.com"),
              code: EmailVerificationCode.make("FIRST001"),
              expiresAt: Timestamp.addMinutes(Timestamp.now(), 10),
              sendCount: 1,
              lastSentAt: TEST_FIRST_SENT_AT,
            })
          )
        )
      )

      expect(firstCreated.id).toBe(firstRequestId)

      const loadedById = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.findById(firstRequestId)
          )
        )
      )
      expect(Option.isSome(loadedById)).toBe(true)
      if (Option.isSome(loadedById)) {
        expect(loadedById.value.code).toBe(EmailVerificationCode.make("FIRST001"))
        expect(loadedById.value.sendCount).toBe(1)
        expect(loadedById.value.lastSentAt.epochMillis).toBe(TEST_FIRST_SENT_AT.epochMillis)
      }

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.create({
              id: replacementRequestId,
              userId: TEST_FIRST_USER_ID,
              email: Email.make("verification-one@example.com"),
              code: EmailVerificationCode.make("SECOND01"),
              expiresAt: Timestamp.addMinutes(Timestamp.now(), 10),
              sendCount: 2,
              lastSentAt: Timestamp.now(),
            })
          )
        )
      )

      const replacedRequest = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.findById(firstRequestId)
          )
        )
      )
      expect(Option.isNone(replacedRequest)).toBe(true)

      const latestRequest = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.findByUserId(TEST_FIRST_USER_ID)
          )
        )
      )
      expect(Option.isSome(latestRequest)).toBe(true)
      if (Option.isSome(latestRequest)) {
        expect(latestRequest.value.id).toBe(replacementRequestId)
        expect(latestRequest.value.code).toBe(EmailVerificationCode.make("SECOND01"))
        expect(latestRequest.value.sendCount).toBe(2)
      }

      const consumedRequest = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.consume(replacementRequestId)
          )
        )
      )
      expect(Option.isSome(consumedRequest)).toBe(true)
      if (Option.isSome(consumedRequest)) {
        expect(consumedRequest.value.id).toBe(replacementRequestId)
      }

      const missingAfterConsume = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.findById(replacementRequestId)
          )
        )
      )
      expect(Option.isNone(missingAfterConsume)).toBe(true)
    })
  )

  it.effect("deletes expired verification requests without removing active ones", () =>
    Effect.gen(function* () {
      const expiredRequestId = EmailVerificationRequestId.make(
        "00000000-4000-4000-8000-000000000721"
      )
      const activeRequestId = EmailVerificationRequestId.make(
        "00000000-4000-4000-8000-000000000722"
      )
      const now = Timestamp.now()

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            Effect.all([
              repository.create({
                id: expiredRequestId,
                userId: TEST_FIRST_USER_ID,
                email: Email.make("verification-one@example.com"),
                code: EmailVerificationCode.make("EXPIRE01"),
                expiresAt: Timestamp.addMinutes(now, -1),
                sendCount: 1,
                lastSentAt: Timestamp.addMinutes(now, -11),
              }),
              repository.create({
                id: activeRequestId,
                userId: TEST_SECOND_USER_ID,
                email: Email.make("verification-two@example.com"),
                code: EmailVerificationCode.make("ACTIVE01"),
                expiresAt: Timestamp.addMinutes(now, 5),
                sendCount: 1,
                lastSentAt: now,
              }),
            ])
          )
        )
      )

      const deletedCount = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.deleteExpired(now)
          )
        )
      )
      expect(deletedCount).toBe(1)

      const expiredRequest = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.findById(expiredRequestId)
          )
        )
      )
      const activeRequest = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.findById(activeRequestId)
          )
        )
      )

      expect(Option.isNone(expiredRequest)).toBe(true)
      expect(Option.isSome(activeRequest)).toBe(true)
    })
  )
})
