import { beforeEach, describe, expect, it } from "@effect/vitest"
import { eq } from "drizzle-orm"
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

  it.effect("records a repeated send on an existing request without changing its count", () =>
    Effect.gen(function* () {
      const requestId = EmailVerificationRequestId.make("00000000-4000-4000-8000-000000000731")
      const missingRequestId = EmailVerificationRequestId.make(
        "00000000-4000-4000-8000-000000000732"
      )
      const secondSentAt = Timestamp.addMinutes(TEST_FIRST_SENT_AT, 2)

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.create({
              id: requestId,
              userId: TEST_FIRST_USER_ID,
              email: Email.make("verification-one@example.com"),
              code: EmailVerificationCode.make("RESEND01"),
              expiresAt: Timestamp.addMinutes(Timestamp.now(), 10),
              sendCount: 1,
              lastSentAt: TEST_FIRST_SENT_AT,
            })
          )
        )
      )

      const recorded = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.recordSend({ id: requestId, sentAt: secondSentAt })
          )
        )
      )
      expect(Option.isSome(recorded)).toBe(true)
      if (Option.isSome(recorded)) {
        expect(recorded.value.id).toBe(requestId)
        expect(recorded.value.code).toBe(EmailVerificationCode.make("RESEND01"))
        expect(recorded.value.sendCount).toBe(1)
        expect(recorded.value.lastSentAt.epochMillis).toBe(secondSentAt.epochMillis)
      }

      const stored = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.findById(requestId)
          )
        )
      )
      expect(Option.isSome(stored)).toBe(true)
      if (Option.isSome(stored)) {
        expect(stored.value.sendCount).toBe(1)
        expect(stored.value.lastSentAt.epochMillis).toBe(secondSentAt.epochMillis)
      }

      const recordedOnMissing = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.recordSend({ id: missingRequestId, sentAt: secondSentAt })
          )
        )
      )
      expect(Option.isNone(recordedOnMissing)).toBe(true)
    })
  )

  it.effect("renews a request once when two renewals race for the same request", () =>
    Effect.gen(function* () {
      const requestId = EmailVerificationRequestId.make("00000000-4000-4000-8000-000000000741")
      const firstReplacementId = EmailVerificationRequestId.make(
        "00000000-4000-4000-8000-000000000742"
      )
      const secondReplacementId = EmailVerificationRequestId.make(
        "00000000-4000-4000-8000-000000000743"
      )
      const now = Timestamp.now()

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.create({
              id: requestId,
              userId: TEST_FIRST_USER_ID,
              email: Email.make("verification-one@example.com"),
              code: EmailVerificationCode.make("RACE0001"),
              expiresAt: Timestamp.addMinutes(now, 10),
              sendCount: 1,
              lastSentAt: TEST_FIRST_SENT_AT,
            })
          )
        )
      )

      const renewWith = ({
        replacementId,
        code,
      }: {
        readonly replacementId: EmailVerificationRequestId
        readonly code: EmailVerificationCode
      }) =>
        Effect.promise(() =>
          runRepository(
            Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
              repository.renew({
                id: requestId,
                replacementId,
                code,
                expiresAt: Timestamp.addMinutes(now, 10),
                sentAt: now,
              })
            )
          )
        )

      const outcomes = yield* Effect.all(
        [
          renewWith({
            replacementId: firstReplacementId,
            code: EmailVerificationCode.make("RACE0002"),
          }),
          renewWith({
            replacementId: secondReplacementId,
            code: EmailVerificationCode.make("RACE0003"),
          }),
        ],
        { concurrency: "unbounded" }
      )

      const renewed = outcomes.filter(Option.isSome)
      expect(renewed).toHaveLength(1)
      expect(outcomes.filter(Option.isNone)).toHaveLength(1)

      const winner = renewed[0]
      expect(winner).toBeDefined()
      if (winner !== undefined) {
        expect([firstReplacementId, secondReplacementId]).toContain(winner.value.id)
        expect(winner.value.userId).toBe(TEST_FIRST_USER_ID)
        expect(winner.value.sendCount).toBe(2)
        expect(winner.value.lastSentAt.epochMillis).toBe(now.epochMillis)
      }

      const replacedRequest = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.findById(requestId)
          )
        )
      )
      expect(Option.isNone(replacedRequest)).toBe(true)

      const activeRows = yield* Effect.promise(() =>
        context.runPg(
          Effect.gen(function* () {
            const db = yield* drizzle

            return yield* db
              .select({
                id: schema.emailVerificationRequests.id,
                sendCount: schema.emailVerificationRequests.sendCount,
              })
              .from(schema.emailVerificationRequests)
              .where(eq(schema.emailVerificationRequests.userId, TEST_FIRST_USER_ID))
          })
        )
      )
      expect(activeRows).toHaveLength(1)
      expect(activeRows[0]?.id).toBe(winner?.value.id)
      expect(activeRows[0]?.sendCount).toBe(2)

      const renewedAgainAfterGone = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.renew({
              id: requestId,
              replacementId: EmailVerificationRequestId.make(
                "00000000-4000-4000-8000-000000000744"
              ),
              code: EmailVerificationCode.make("RACE0004"),
              expiresAt: Timestamp.addMinutes(now, 10),
              sentAt: now,
            })
          )
        )
      )
      expect(Option.isNone(renewedAgainAfterGone)).toBe(true)
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
