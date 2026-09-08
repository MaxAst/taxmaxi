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

const selectUserRows = (userId: AuthUserId) =>
  context.runPg(
    Effect.gen(function* () {
      const db = yield* drizzle

      return yield* db
        .select({
          id: schema.emailVerificationRequests.id,
          sendCount: schema.emailVerificationRequests.sendCount,
          lastSentAt: schema.emailVerificationRequests.lastSentAt,
        })
        .from(schema.emailVerificationRequests)
        .where(eq(schema.emailVerificationRequests.userId, userId))
    })
  )

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

  it.effect("reuses the active request on start and records the send time", () =>
    Effect.gen(function* () {
      const activeRequestId = EmailVerificationRequestId.make(
        "00000000-4000-4000-8000-000000000731"
      )
      const unusedFreshId = EmailVerificationRequestId.make("00000000-4000-4000-8000-000000000732")
      const now = Timestamp.now()

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.create({
              id: activeRequestId,
              userId: TEST_FIRST_USER_ID,
              email: Email.make("verification-one@example.com"),
              code: EmailVerificationCode.make("REUSE001"),
              expiresAt: Timestamp.addMinutes(now, 10),
              sendCount: 1,
              lastSentAt: TEST_FIRST_SENT_AT,
            })
          )
        )
      )

      const reused = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.startOrReuse({
              id: unusedFreshId,
              userId: TEST_FIRST_USER_ID,
              email: Email.make("verification-one@example.com"),
              code: EmailVerificationCode.make("REUSE002"),
              expiresAt: Timestamp.addMinutes(now, 10),
            })
          )
        )
      )
      const afterReuseMillis = Timestamp.now().epochMillis
      expect(reused.id).toBe(activeRequestId)
      expect(reused.code).toBe(EmailVerificationCode.make("REUSE001"))
      expect(reused.sendCount).toBe(1)
      // The send time is taken inside the lock, not passed by the caller.
      expect(reused.lastSentAt.epochMillis).toBeGreaterThanOrEqual(now.epochMillis)
      expect(reused.lastSentAt.epochMillis).toBeLessThanOrEqual(afterReuseMillis)

      const storedAfterReuse = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.findById(activeRequestId)
          )
        )
      )
      expect(Option.isSome(storedAfterReuse)).toBe(true)
      if (Option.isSome(storedAfterReuse)) {
        expect(storedAfterReuse.value.sendCount).toBe(1)
        expect(storedAfterReuse.value.lastSentAt.epochMillis).toBe(reused.lastSentAt.epochMillis)
      }

      const rows = yield* Effect.promise(() => selectUserRows(TEST_FIRST_USER_ID))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.id).toBe(activeRequestId)
    })
  )

  // `it.live` keeps the real clock, so the seeded row can expire for real.
  it.live("starts fresh when the active request expired before the lock was taken", () =>
    Effect.gen(function* () {
      const expiringRequestId = EmailVerificationRequestId.make(
        "00000000-4000-4000-8000-000000000733"
      )
      const freshRequestId = EmailVerificationRequestId.make("00000000-4000-4000-8000-000000000734")
      const seededAt = Timestamp.now()
      const expiresAt = Timestamp.addMillis(seededAt, 50)

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.create({
              id: expiringRequestId,
              userId: TEST_FIRST_USER_ID,
              email: Email.make("verification-one@example.com"),
              code: EmailVerificationCode.make("EXPIRE02"),
              expiresAt,
              sendCount: 3,
              lastSentAt: seededAt,
            })
          )
        )
      )

      // A caller that decided "still active" at `seededAt` would have been
      // wrong by the time it holds the lock: the row is expired by then.
      yield* Effect.sleep("100 millis")

      const fresh = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.startOrReuse({
              id: freshRequestId,
              userId: TEST_FIRST_USER_ID,
              email: Email.make("verification-one@example.com"),
              code: EmailVerificationCode.make("REUSE003"),
              expiresAt: Timestamp.addMinutes(Timestamp.now(), 10),
            })
          )
        )
      )
      expect(fresh.id).toBe(freshRequestId)
      expect(fresh.code).toBe(EmailVerificationCode.make("REUSE003"))
      expect(fresh.sendCount).toBe(1)
      expect(fresh.lastSentAt.epochMillis).toBeGreaterThan(expiresAt.epochMillis)

      const rows = yield* Effect.promise(() => selectUserRows(TEST_FIRST_USER_ID))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.id).toBe(freshRequestId)
    })
  )

  it.effect("keeps one row with the renewed count when a start races a renewal", () =>
    Effect.gen(function* () {
      const requestId = EmailVerificationRequestId.make("00000000-4000-4000-8000-000000000751")
      const replacementId = EmailVerificationRequestId.make("00000000-4000-4000-8000-000000000752")
      const unusedFreshId = EmailVerificationRequestId.make("00000000-4000-4000-8000-000000000753")
      const now = Timestamp.now()

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.create({
              id: requestId,
              userId: TEST_FIRST_USER_ID,
              email: Email.make("verification-one@example.com"),
              code: EmailVerificationCode.make("MIXED001"),
              expiresAt: Timestamp.addMinutes(now, 10),
              sendCount: 1,
              lastSentAt: TEST_FIRST_SENT_AT,
            })
          )
        )
      )

      const [started, renewed] = yield* Effect.all(
        [
          Effect.promise(() =>
            runRepository(
              Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
                repository.startOrReuse({
                  id: unusedFreshId,
                  userId: TEST_FIRST_USER_ID,
                  email: Email.make("verification-one@example.com"),
                  code: EmailVerificationCode.make("MIXED002"),
                  expiresAt: Timestamp.addMinutes(now, 10),
                })
              )
            )
          ),
          Effect.promise(() =>
            runRepository(
              Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
                repository.renew({
                  id: requestId,
                  replacementId,
                  code: EmailVerificationCode.make("MIXED003"),
                  expiresAt: Timestamp.addMinutes(now, 10),
                })
              )
            )
          ),
        ],
        { concurrency: "unbounded" }
      )
      const afterRaceMillis = Timestamp.now().epochMillis

      // The renewal always finds its row: either it runs first, or the start
      // reused that same row (a reuse never deletes it).
      expect(Option.isSome(renewed)).toBe(true)
      if (Option.isSome(renewed)) {
        expect(renewed.value.id).toBe(replacementId)
        expect(renewed.value.sendCount).toBe(2)
        expect(renewed.value.lastSentAt.epochMillis).toBeGreaterThanOrEqual(now.epochMillis)
        expect(renewed.value.lastSentAt.epochMillis).toBeLessThanOrEqual(afterRaceMillis)
      }

      // The start never created a fresh row: it reused either the original
      // (ran first) or the replacement (ran second).
      expect(started.sendCount).toBeGreaterThanOrEqual(1)
      expect(started.sendCount).toBeLessThanOrEqual(2)
      expect(started.id).not.toBe(unusedFreshId)
      const startRanSecond = started.sendCount === 2
      if (startRanSecond) {
        expect(started.id).toBe(replacementId)
        expect(started.code).toBe(EmailVerificationCode.make("MIXED003"))
      } else {
        expect(started.id).toBe(requestId)
        expect(started.code).toBe(EmailVerificationCode.make("MIXED001"))
      }
      expect(started.lastSentAt.epochMillis).toBeGreaterThanOrEqual(now.epochMillis)
      expect(started.lastSentAt.epochMillis).toBeLessThanOrEqual(afterRaceMillis)

      const rows = yield* Effect.promise(() => selectUserRows(TEST_FIRST_USER_ID))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.id).toBe(replacementId)
      expect(rows[0]?.sendCount).toBe(2)
      expect(rows.filter((row) => row.sendCount === 1)).toHaveLength(0)
      // Each writer takes its send time inside the lock, so the stored value
      // is the second writer's, which is the later of the two.
      const renewedLastSentAtMillis = Option.isSome(renewed)
        ? renewed.value.lastSentAt.epochMillis
        : Number.NaN
      expect(rows[0]?.lastSentAt.getTime()).toBe(
        Math.max(started.lastSentAt.epochMillis, renewedLastSentAtMillis)
      )
    })
  )

  it.effect("starts one request when two starts race for the same user", () =>
    Effect.gen(function* () {
      const firstFreshId = EmailVerificationRequestId.make("00000000-4000-4000-8000-000000000761")
      const secondFreshId = EmailVerificationRequestId.make("00000000-4000-4000-8000-000000000762")
      const now = Timestamp.now()

      const startWith = ({
        id,
        code,
      }: {
        readonly id: EmailVerificationRequestId
        readonly code: EmailVerificationCode
      }) =>
        Effect.promise(() =>
          runRepository(
            Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
              repository.startOrReuse({
                id,
                userId: TEST_FIRST_USER_ID,
                email: Email.make("verification-one@example.com"),
                code,
                expiresAt: Timestamp.addMinutes(now, 10),
              })
            )
          )
        )

      const [first, second] = yield* Effect.all(
        [
          startWith({ id: firstFreshId, code: EmailVerificationCode.make("TWIN0001") }),
          startWith({ id: secondFreshId, code: EmailVerificationCode.make("TWIN0002") }),
        ],
        { concurrency: "unbounded" }
      )

      expect(first.id).toBe(second.id)
      expect(first.code).toBe(second.code)
      expect(first.sendCount).toBe(1)
      expect(second.sendCount).toBe(1)
      expect([firstFreshId, secondFreshId]).toContain(first.id)

      const rows = yield* Effect.promise(() => selectUserRows(TEST_FIRST_USER_ID))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.id).toBe(first.id)
      expect(rows[0]?.sendCount).toBe(1)
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
      const afterRaceMillis = Timestamp.now().epochMillis

      const renewed = outcomes.filter(Option.isSome)
      expect(renewed).toHaveLength(1)
      expect(outcomes.filter(Option.isNone)).toHaveLength(1)

      const winner = renewed[0]
      expect(winner).toBeDefined()
      if (winner !== undefined) {
        expect([firstReplacementId, secondReplacementId]).toContain(winner.value.id)
        expect(winner.value.userId).toBe(TEST_FIRST_USER_ID)
        expect(winner.value.sendCount).toBe(2)
        expect(winner.value.lastSentAt.epochMillis).toBeGreaterThanOrEqual(now.epochMillis)
        expect(winner.value.lastSentAt.epochMillis).toBeLessThanOrEqual(afterRaceMillis)
      }

      const replacedRequest = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.findById(requestId)
          )
        )
      )
      expect(Option.isNone(replacedRequest)).toBe(true)

      const activeRows = yield* Effect.promise(() => selectUserRows(TEST_FIRST_USER_ID))
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
