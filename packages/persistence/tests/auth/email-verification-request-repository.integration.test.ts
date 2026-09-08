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
const TEST_LIFETIME_MILLIS = 10 * 60 * 1000
const TEST_COOLDOWN_MILLIS = 60 * 1000
const TEST_MAX_SEND_COUNT = 5

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

      const started = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.startOrReuse({
              id: unusedFreshId,
              userId: TEST_FIRST_USER_ID,
              email: Email.make("verification-one@example.com"),
              code: EmailVerificationCode.make("REUSE002"),
              lifetimeMillis: TEST_LIFETIME_MILLIS,
              cooldownMillis: TEST_COOLDOWN_MILLIS,
            })
          )
        )
      )
      const afterReuseMillis = Timestamp.now().epochMillis
      // The seeded send is long past the cooldown, so the reuse sends.
      expect(started._tag).toBe("sent")
      const reused = started.request
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

      const started = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.startOrReuse({
              id: freshRequestId,
              userId: TEST_FIRST_USER_ID,
              email: Email.make("verification-one@example.com"),
              code: EmailVerificationCode.make("REUSE003"),
              lifetimeMillis: TEST_LIFETIME_MILLIS,
              cooldownMillis: TEST_COOLDOWN_MILLIS,
            })
          )
        )
      )
      // The expired row was seeded with a send just now, but an expired row
      // is not reused, so its cooldown does not apply to the fresh request.
      expect(started._tag).toBe("sent")
      const fresh = started.request
      expect(fresh.id).toBe(freshRequestId)
      expect(fresh.code).toBe(EmailVerificationCode.make("REUSE003"))
      expect(fresh.sendCount).toBe(1)
      expect(fresh.lastSentAt.epochMillis).toBeGreaterThan(expiresAt.epochMillis)
      // The expiry counts from the same in-lock send time as `lastSentAt`.
      expect(fresh.expiresAt.epochMillis).toBe(fresh.lastSentAt.epochMillis + TEST_LIFETIME_MILLIS)

      const rows = yield* Effect.promise(() => selectUserRows(TEST_FIRST_USER_ID))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.id).toBe(freshRequestId)
    })
  )

  it.effect("lets only the first writer send when a start races a renewal", () =>
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
                  lifetimeMillis: TEST_LIFETIME_MILLIS,
                  cooldownMillis: TEST_COOLDOWN_MILLIS,
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
                  lifetimeMillis: TEST_LIFETIME_MILLIS,
                  cooldownMillis: TEST_COOLDOWN_MILLIS,
                  maxSendCount: TEST_MAX_SEND_COUNT,
                })
              )
            )
          ),
        ],
        { concurrency: "unbounded" }
      )
      const afterRaceMillis = Timestamp.now().epochMillis

      // The seeded send is long past the cooldown, so whichever writer holds
      // the lock first sends and writes `lastSentAt`. The second writer reads
      // that write under the lock and lands inside the cooldown. Neither
      // writer creates a fresh row.
      const rows = yield* Effect.promise(() => selectUserRows(TEST_FIRST_USER_ID))
      expect(rows).toHaveLength(1)
      expect(started._tag === "sent" || renewed._tag === "sent").toBe(true)
      expect(started._tag === "cooldown" || renewed._tag === "cooldown").toBe(true)

      if (started._tag === "sent") {
        expect(started.request.id).toBe(requestId)
        expect(started.request.code).toBe(EmailVerificationCode.make("MIXED001"))
        expect(started.request.sendCount).toBe(1)
        expect(started.request.lastSentAt.epochMillis).toBeGreaterThanOrEqual(now.epochMillis)
        expect(started.request.lastSentAt.epochMillis).toBeLessThanOrEqual(afterRaceMillis)

        expect(renewed._tag).toBe("cooldown")
        if (renewed._tag === "cooldown") {
          expect(renewed.request.id).toBe(requestId)
          expect(renewed.request.sendCount).toBe(1)
          expect(renewed.request.lastSentAt.epochMillis).toBe(
            started.request.lastSentAt.epochMillis
          )
          expect(renewed.retryAfterMillis).toBeGreaterThan(0)
          expect(renewed.retryAfterMillis).toBeLessThanOrEqual(TEST_COOLDOWN_MILLIS)
        }

        expect(rows[0]?.id).toBe(requestId)
        expect(rows[0]?.sendCount).toBe(1)
        expect(rows[0]?.lastSentAt.getTime()).toBe(started.request.lastSentAt.epochMillis)
      } else {
        expect(renewed._tag).toBe("sent")
        if (renewed._tag === "sent") {
          expect(renewed.request.id).toBe(replacementId)
          expect(renewed.request.sendCount).toBe(2)
          expect(renewed.request.lastSentAt.epochMillis).toBeGreaterThanOrEqual(now.epochMillis)
          expect(renewed.request.lastSentAt.epochMillis).toBeLessThanOrEqual(afterRaceMillis)

          expect(started.request.id).toBe(replacementId)
          expect(started.request.code).toBe(EmailVerificationCode.make("MIXED003"))
          expect(started.request.sendCount).toBe(2)
          expect(started.request.lastSentAt.epochMillis).toBe(
            renewed.request.lastSentAt.epochMillis
          )
          expect(started.retryAfterMillis).toBeGreaterThan(0)
          expect(started.retryAfterMillis).toBeLessThanOrEqual(TEST_COOLDOWN_MILLIS)

          expect(rows[0]?.id).toBe(replacementId)
          expect(rows[0]?.sendCount).toBe(2)
          expect(rows[0]?.lastSentAt.getTime()).toBe(renewed.request.lastSentAt.epochMillis)
        }
      }
    })
  )

  it.effect("starts one request and sends once when two starts race for the same user", () =>
    Effect.gen(function* () {
      const firstFreshId = EmailVerificationRequestId.make("00000000-4000-4000-8000-000000000761")
      const secondFreshId = EmailVerificationRequestId.make("00000000-4000-4000-8000-000000000762")

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
                lifetimeMillis: TEST_LIFETIME_MILLIS,
                cooldownMillis: TEST_COOLDOWN_MILLIS,
              })
            )
          )
        )

      const outcomes = yield* Effect.all(
        [
          startWith({ id: firstFreshId, code: EmailVerificationCode.make("TWIN0001") }),
          startWith({ id: secondFreshId, code: EmailVerificationCode.make("TWIN0002") }),
        ],
        { concurrency: "unbounded" }
      )

      // The first writer inserts the fresh row and sends; the second reads
      // that row under the lock and is inside its cooldown.
      const sent = outcomes.filter((outcome) => outcome._tag === "sent")
      const cooled = outcomes.filter((outcome) => outcome._tag === "cooldown")
      expect(sent).toHaveLength(1)
      expect(cooled).toHaveLength(1)

      const [first, second] = outcomes
      expect(first.request.id).toBe(second.request.id)
      expect(first.request.code).toBe(second.request.code)
      expect(first.request.sendCount).toBe(1)
      expect(second.request.sendCount).toBe(1)
      expect(first.request.lastSentAt.epochMillis).toBe(second.request.lastSentAt.epochMillis)
      expect([firstFreshId, secondFreshId]).toContain(first.request.id)
      const cooledOutcome = cooled[0]
      if (cooledOutcome?._tag === "cooldown") {
        expect(cooledOutcome.retryAfterMillis).toBeGreaterThan(0)
        expect(cooledOutcome.retryAfterMillis).toBeLessThanOrEqual(TEST_COOLDOWN_MILLIS)
      }

      const rows = yield* Effect.promise(() => selectUserRows(TEST_FIRST_USER_ID))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.id).toBe(first.request.id)
      expect(rows[0]?.sendCount).toBe(1)
    })
  )

  it.effect("refuses a renewal inside the cooldown and writes nothing", () =>
    Effect.gen(function* () {
      const requestId = EmailVerificationRequestId.make("00000000-4000-4000-8000-000000000771")
      const sentAt = Timestamp.now()

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.create({
              id: requestId,
              userId: TEST_FIRST_USER_ID,
              email: Email.make("verification-one@example.com"),
              code: EmailVerificationCode.make("COOL0001"),
              expiresAt: Timestamp.addMinutes(sentAt, 10),
              sendCount: 2,
              lastSentAt: sentAt,
            })
          )
        )
      )

      const outcome = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.renew({
              id: requestId,
              replacementId: EmailVerificationRequestId.make(
                "00000000-4000-4000-8000-000000000772"
              ),
              code: EmailVerificationCode.make("COOL0002"),
              lifetimeMillis: TEST_LIFETIME_MILLIS,
              cooldownMillis: TEST_COOLDOWN_MILLIS,
              maxSendCount: TEST_MAX_SEND_COUNT,
            })
          )
        )
      )
      const afterMillis = Timestamp.now().epochMillis

      expect(outcome._tag).toBe("cooldown")
      if (outcome._tag === "cooldown") {
        expect(outcome.request.id).toBe(requestId)
        expect(outcome.request.code).toBe(EmailVerificationCode.make("COOL0001"))
        expect(outcome.request.sendCount).toBe(2)
        expect(outcome.request.lastSentAt.epochMillis).toBe(sentAt.epochMillis)
        // The rest of the cooldown, measured from the stored send time.
        expect(outcome.retryAfterMillis).toBeGreaterThanOrEqual(
          TEST_COOLDOWN_MILLIS - (afterMillis - sentAt.epochMillis)
        )
        expect(outcome.retryAfterMillis).toBeLessThanOrEqual(TEST_COOLDOWN_MILLIS)
      }

      const rows = yield* Effect.promise(() => selectUserRows(TEST_FIRST_USER_ID))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.id).toBe(requestId)
      expect(rows[0]?.sendCount).toBe(2)
      expect(rows[0]?.lastSentAt.getTime()).toBe(sentAt.epochMillis)
    })
  )

  it.effect("refuses a renewal after the last allowed send until the request expires", () =>
    Effect.gen(function* () {
      const requestId = EmailVerificationRequestId.make("00000000-4000-4000-8000-000000000781")
      const expiresAt = Timestamp.addMinutes(Timestamp.now(), 7)
      // The last send is just now, so the cooldown would also refuse; the cap
      // must decide first and report the wait until expiry.
      const lastSentAt = Timestamp.now()

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.create({
              id: requestId,
              userId: TEST_FIRST_USER_ID,
              email: Email.make("verification-one@example.com"),
              code: EmailVerificationCode.make("CAP00001"),
              expiresAt,
              sendCount: TEST_MAX_SEND_COUNT,
              lastSentAt,
            })
          )
        )
      )

      const beforeMillis = Timestamp.now().epochMillis
      const outcome = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.renew({
              id: requestId,
              replacementId: EmailVerificationRequestId.make(
                "00000000-4000-4000-8000-000000000782"
              ),
              code: EmailVerificationCode.make("CAP00002"),
              lifetimeMillis: TEST_LIFETIME_MILLIS,
              cooldownMillis: TEST_COOLDOWN_MILLIS,
              maxSendCount: TEST_MAX_SEND_COUNT,
            })
          )
        )
      )
      const afterMillis = Timestamp.now().epochMillis

      // The cap is what refuses, not the cooldown; the wait is the time until
      // the request expires, well past the rest of the cooldown.
      expect(outcome._tag).toBe("capped")
      if (outcome._tag === "capped") {
        expect(outcome.request.id).toBe(requestId)
        expect(outcome.request.sendCount).toBe(TEST_MAX_SEND_COUNT)
        expect(outcome.retryAfterMillis).toBeGreaterThan(TEST_COOLDOWN_MILLIS)
        expect(outcome.retryAfterMillis).toBeGreaterThanOrEqual(expiresAt.epochMillis - afterMillis)
        expect(outcome.retryAfterMillis).toBeLessThanOrEqual(expiresAt.epochMillis - beforeMillis)
      }

      const rows = yield* Effect.promise(() => selectUserRows(TEST_FIRST_USER_ID))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.id).toBe(requestId)
      expect(rows[0]?.sendCount).toBe(TEST_MAX_SEND_COUNT)
      expect(rows[0]?.lastSentAt.getTime()).toBe(lastSentAt.epochMillis)
    })
  )

  it.effect("treats an expired request as gone on renewal and writes nothing", () =>
    Effect.gen(function* () {
      const requestId = EmailVerificationRequestId.make("00000000-4000-4000-8000-000000000791")

      yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.create({
              id: requestId,
              userId: TEST_FIRST_USER_ID,
              email: Email.make("verification-one@example.com"),
              code: EmailVerificationCode.make("GONE0001"),
              expiresAt: Timestamp.addMillis(Timestamp.now(), -1000),
              sendCount: TEST_MAX_SEND_COUNT,
              lastSentAt: TEST_FIRST_SENT_AT,
            })
          )
        )
      )

      const outcome = yield* Effect.promise(() =>
        runRepository(
          Effect.flatMap(EmailVerificationRequestRepository, (repository) =>
            repository.renew({
              id: requestId,
              replacementId: EmailVerificationRequestId.make(
                "00000000-4000-4000-8000-000000000792"
              ),
              code: EmailVerificationCode.make("GONE0002"),
              lifetimeMillis: TEST_LIFETIME_MILLIS,
              cooldownMillis: TEST_COOLDOWN_MILLIS,
              maxSendCount: TEST_MAX_SEND_COUNT,
            })
          )
        )
      )

      // An expired request is not renewed; the row is left for the next
      // start to discard.
      expect(outcome._tag).toBe("missing")

      const rows = yield* Effect.promise(() => selectUserRows(TEST_FIRST_USER_ID))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.id).toBe(requestId)
      expect(rows[0]?.sendCount).toBe(TEST_MAX_SEND_COUNT)
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
                lifetimeMillis: TEST_LIFETIME_MILLIS,
                cooldownMillis: TEST_COOLDOWN_MILLIS,
                maxSendCount: TEST_MAX_SEND_COUNT,
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

      // Both renewals name the same id. The first replaces that row; the
      // second re-reads it under the lock and finds it gone.
      const renewed = outcomes.filter((outcome) => outcome._tag === "sent")
      expect(renewed).toHaveLength(1)
      expect(outcomes.filter((outcome) => outcome._tag === "missing")).toHaveLength(1)

      const winner = renewed[0]
      expect(winner).toBeDefined()
      if (winner !== undefined && winner._tag === "sent") {
        expect([firstReplacementId, secondReplacementId]).toContain(winner.request.id)
        expect(winner.request.userId).toBe(TEST_FIRST_USER_ID)
        expect(winner.request.sendCount).toBe(2)
        expect(winner.request.lastSentAt.epochMillis).toBeGreaterThanOrEqual(now.epochMillis)
        expect(winner.request.lastSentAt.epochMillis).toBeLessThanOrEqual(afterRaceMillis)
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
      expect(activeRows[0]?.id).toBe(winner?._tag === "sent" ? winner.request.id : undefined)
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
              lifetimeMillis: TEST_LIFETIME_MILLIS,
              cooldownMillis: TEST_COOLDOWN_MILLIS,
              maxSendCount: TEST_MAX_SEND_COUNT,
            })
          )
        )
      )
      expect(renewedAgainAfterGone._tag).toBe("missing")
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
