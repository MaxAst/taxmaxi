/**
 * EmailVerificationRequestRepositoryLive - PostgreSQL verification request persistence
 *
 * Provides the live repository for pending local email verification requests.
 *
 * @module EmailVerificationRequestRepositoryLive
 */

import { and, desc, eq, gt, lte, sql } from "drizzle-orm"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  AuthUserId,
  Email,
  EmailVerificationCode,
  EmailVerificationRequest,
  EmailVerificationRequestId,
} from "@my/core/authentication"
import { Timestamp, addMillis } from "@my/core/shared/values/Timestamp"
import { wrapSqlError } from "../errors/RepositoryError.ts"
import {
  emailVerificationRequests,
  type EmailVerificationRequest as EmailVerificationRequestRow,
} from "../schema/EmailVerificationRequestsTable.ts"
import {
  type EmailVerificationCooldown,
  EmailVerificationRequestRepository,
  type EmailVerificationRequestRenewalOutcome,
  type EmailVerificationRequestRepositoryService,
  type EmailVerificationRequestStartOutcome,
} from "../services/EmailVerificationRequestRepository.ts"
import { drizzle } from "./PgClientLive.ts"

type SelectedEmailVerificationRequestRow = Pick<
  EmailVerificationRequestRow,
  | "id"
  | "userId"
  | "email"
  | "code"
  | "expiresAt"
  | "sendCount"
  | "lastSentAt"
  | "createdAt"
  | "updatedAt"
>

const rowToEmailVerificationRequest = (
  row: SelectedEmailVerificationRequestRow
): Option.Option<EmailVerificationRequest> => {
  if (row.userId === null) {
    return Option.none()
  }

  return Option.some(
    EmailVerificationRequest.make({
      id: EmailVerificationRequestId.make(row.id),
      userId: AuthUserId.make(row.userId),
      email: Email.make(row.email),
      code: EmailVerificationCode.make(row.code),
      expiresAt: Timestamp.make({ epochMillis: row.expiresAt.getTime() }),
      sendCount: row.sendCount,
      lastSentAt: Timestamp.make({ epochMillis: row.lastSentAt.getTime() }),
      createdAt: Timestamp.make({ epochMillis: row.createdAt.getTime() }),
      updatedAt: Timestamp.make({ epochMillis: row.updatedAt.getTime() }),
    })
  )
}

/**
 * The `cooldown` outcome for a stored request whose recorded last send is
 * younger than `cooldownMillis` as of the send time taken inside the lock,
 * or undefined when the cooldown has passed. The decision reads the stored
 * `lastSentAt` and nothing else.
 */
const cooldownOutcome = ({
  request,
  now,
  cooldownMillis,
}: {
  readonly request: EmailVerificationRequest
  readonly now: Date
  readonly cooldownMillis: number
}): EmailVerificationCooldown | undefined => {
  const sinceLastSend = now.getTime() - request.lastSentAt.epochMillis

  return sinceLastSend < cooldownMillis
    ? { _tag: "cooldown", request, retryAfterMillis: cooldownMillis - sinceLastSend }
    : undefined
}

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const selectFields = {
    id: emailVerificationRequests.id,
    userId: emailVerificationRequests.userId,
    email: emailVerificationRequests.email,
    code: emailVerificationRequests.code,
    expiresAt: emailVerificationRequests.expiresAt,
    sendCount: emailVerificationRequests.sendCount,
    lastSentAt: emailVerificationRequests.lastSentAt,
    createdAt: emailVerificationRequests.createdAt,
    updatedAt: emailVerificationRequests.updatedAt,
  } as const

  /**
   * Serialize every writer of one user's verification requests. The lock is
   * held until the transaction ends, so the reads after it see the previous
   * holder's committed rows (READ COMMITTED takes a fresh snapshot per
   * statement).
   */
  const lockUserRequests = ({
    executor,
    userId,
  }: {
    readonly executor: Pick<typeof db, "execute">
    readonly userId: AuthUserId
  }) =>
    executor
      .execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`email_verification_requests:${userId}`}, 0))`
      )
      .pipe(Effect.asVoid)

  const create: EmailVerificationRequestRepositoryService["create"] = (request) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* lockUserRequests({ executor: tx, userId: request.userId })

          const now = yield* DateTime.nowAsDate

          yield* tx
            .delete(emailVerificationRequests)
            .where(eq(emailVerificationRequests.userId, request.userId))

          yield* tx.insert(emailVerificationRequests).values({
            id: request.id,
            userId: request.userId,
            email: request.email,
            code: request.code,
            expiresAt: request.expiresAt.toDate(),
            sendCount: request.sendCount,
            lastSentAt: request.lastSentAt.toDate(),
            createdAt: now,
            updatedAt: now,
          })

          return EmailVerificationRequest.make({
            id: request.id,
            userId: request.userId,
            email: request.email,
            code: request.code,
            expiresAt: request.expiresAt,
            sendCount: request.sendCount,
            lastSentAt: request.lastSentAt,
            createdAt: Timestamp.make({ epochMillis: now.getTime() }),
            updatedAt: Timestamp.make({ epochMillis: now.getTime() }),
          })
        })
      )
      .pipe(wrapSqlError("create"))

  const startOrReuse: EmailVerificationRequestRepositoryService["startOrReuse"] = (start) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* lockUserRequests({ executor: tx, userId: start.userId })

          // The send time is taken after the lock, so it is later than the
          // previous holder's write and decides "active" and the cooldown as
          // of this send.
          const now = yield* DateTime.nowAsDate
          const [active] = yield* tx
            .select(selectFields)
            .from(emailVerificationRequests)
            .where(
              and(
                eq(emailVerificationRequests.userId, start.userId),
                gt(emailVerificationRequests.expiresAt, now)
              )
            )
            .orderBy(desc(emailVerificationRequests.createdAt))
            .limit(1)
          const stored = Option.fromNullishOr(active).pipe(
            Option.flatMap((value) => rowToEmailVerificationRequest(value))
          )

          if (active !== undefined && Option.isSome(stored)) {
            const cooldown = cooldownOutcome({
              request: stored.value,
              now,
              cooldownMillis: start.cooldownMillis,
            })

            if (cooldown !== undefined) {
              return cooldown
            }

            const [reused] = yield* tx
              .update(emailVerificationRequests)
              .set({
                lastSentAt: now,
                updatedAt: now,
              })
              .where(eq(emailVerificationRequests.id, active.id))
              .returning(selectFields)
            const request = Option.fromNullishOr(reused).pipe(
              Option.flatMap((value) => rowToEmailVerificationRequest(value))
            )

            // Every writer of this user's rows, `consume` included, holds the
            // user lock, so the row selected above is still here. The Option
            // only covers the row mapping's nullable user column.
            if (Option.isSome(request)) {
              return {
                _tag: "sent",
                request: request.value,
              } satisfies EmailVerificationRequestStartOutcome
            }
          }

          yield* tx
            .delete(emailVerificationRequests)
            .where(eq(emailVerificationRequests.userId, start.userId))

          // The expiry counts from the same in-lock send time, so a wait on
          // the lock does not shorten the code's life.
          const sentAt = Timestamp.make({ epochMillis: now.getTime() })
          const expiresAt = addMillis(sentAt, start.lifetimeMillis)

          yield* tx.insert(emailVerificationRequests).values({
            id: start.id,
            userId: start.userId,
            email: start.email,
            code: start.code,
            expiresAt: expiresAt.toDate(),
            sendCount: 1,
            lastSentAt: now,
            createdAt: now,
            updatedAt: now,
          })

          return {
            _tag: "sent",
            request: EmailVerificationRequest.make({
              id: start.id,
              userId: start.userId,
              email: start.email,
              code: start.code,
              expiresAt,
              sendCount: 1,
              lastSentAt: sentAt,
              createdAt: sentAt,
              updatedAt: sentAt,
            }),
          } satisfies EmailVerificationRequestStartOutcome
        })
      )
      .pipe(wrapSqlError("startOrReuse"))

  const renew: EmailVerificationRequestRepositoryService["renew"] = (renewal) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          // The user is read before the lock only to know which lock to take.
          // The row is read again after the lock, because a writer holding the
          // lock meanwhile may have replaced or consumed it.
          const [owner] = yield* tx
            .select({ userId: emailVerificationRequests.userId })
            .from(emailVerificationRequests)
            .where(eq(emailVerificationRequests.id, renewal.id))
            .limit(1)

          if (owner === undefined || owner.userId === null) {
            return { _tag: "missing" } satisfies EmailVerificationRequestRenewalOutcome
          }

          yield* lockUserRequests({ executor: tx, userId: AuthUserId.make(owner.userId) })

          const [locked] = yield* tx
            .select(selectFields)
            .from(emailVerificationRequests)
            .where(eq(emailVerificationRequests.id, renewal.id))
            .limit(1)
          const stored = Option.fromNullishOr(locked).pipe(
            Option.flatMap((value) => rowToEmailVerificationRequest(value))
          )

          if (locked === undefined || locked.userId === null || Option.isNone(stored)) {
            return { _tag: "missing" } satisfies EmailVerificationRequestRenewalOutcome
          }

          // Taken after the lock, like in `startOrReuse`; the rule below and
          // the expiry both count from it.
          const now = yield* DateTime.nowAsDate

          // An expired request ends its lineage: it is not renewed, and the
          // next unverified login starts a fresh one through `startOrReuse`.
          if (locked.expiresAt.getTime() <= now.getTime()) {
            return { _tag: "missing" } satisfies EmailVerificationRequestRenewalOutcome
          }

          // The cap and the cooldown are decided here, under the same lock
          // that writes the send facts, so two resends cannot both pass them.
          // The cap comes first: a lineage that has used all its sends waits
          // until the request expires, whether or not its last send is still
          // inside the cooldown.
          if (locked.sendCount >= renewal.maxSendCount) {
            return {
              _tag: "capped",
              request: stored.value,
              retryAfterMillis: locked.expiresAt.getTime() - now.getTime(),
            } satisfies EmailVerificationRequestRenewalOutcome
          }

          const cooldown = cooldownOutcome({
            request: stored.value,
            now,
            cooldownMillis: renewal.cooldownMillis,
          })

          if (cooldown !== undefined) {
            return cooldown
          }

          const sentAt = Timestamp.make({ epochMillis: now.getTime() })
          const expiresAt = addMillis(sentAt, renewal.lifetimeMillis)
          const sendCount = locked.sendCount + 1

          yield* tx.insert(emailVerificationRequests).values({
            id: renewal.replacementId,
            userId: locked.userId,
            email: locked.email,
            code: renewal.code,
            expiresAt: expiresAt.toDate(),
            sendCount,
            lastSentAt: now,
            createdAt: now,
            updatedAt: now,
          })

          yield* tx
            .delete(emailVerificationRequests)
            .where(eq(emailVerificationRequests.id, renewal.id))

          return {
            _tag: "sent",
            request: EmailVerificationRequest.make({
              id: renewal.replacementId,
              userId: AuthUserId.make(locked.userId),
              email: Email.make(locked.email),
              code: renewal.code,
              expiresAt,
              sendCount,
              lastSentAt: sentAt,
              createdAt: sentAt,
              updatedAt: sentAt,
            }),
          } satisfies EmailVerificationRequestRenewalOutcome
        })
      )
      .pipe(wrapSqlError("renew"))

  const findById: EmailVerificationRequestRepositoryService["findById"] = (id) =>
    Effect.gen(function* () {
      const [row] = yield* db
        .select(selectFields)
        .from(emailVerificationRequests)
        .where(eq(emailVerificationRequests.id, id))

      return Option.fromNullishOr(row).pipe(
        Option.flatMap((value) => rowToEmailVerificationRequest(value))
      )
    }).pipe(wrapSqlError("findById"))

  const findByUserId: EmailVerificationRequestRepositoryService["findByUserId"] = (userId) =>
    Effect.gen(function* () {
      const [row] = yield* db
        .select(selectFields)
        .from(emailVerificationRequests)
        .where(eq(emailVerificationRequests.userId, userId))
        .orderBy(desc(emailVerificationRequests.createdAt))
        .limit(1)

      return Option.fromNullishOr(row).pipe(
        Option.flatMap((value) => rowToEmailVerificationRequest(value))
      )
    }).pipe(wrapSqlError("findByUserId"))

  const consume: EmailVerificationRequestRepositoryService["consume"] = (id) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          // Same shape as `renew`: the user is read only to know which lock to
          // take, and the delete runs after the lock so it cannot pull a row
          // out from under another writer's select.
          const [owner] = yield* tx
            .select({ userId: emailVerificationRequests.userId })
            .from(emailVerificationRequests)
            .where(eq(emailVerificationRequests.id, id))
            .limit(1)

          if (owner === undefined || owner.userId === null) {
            return Option.none()
          }

          yield* lockUserRequests({ executor: tx, userId: AuthUserId.make(owner.userId) })

          const [row] = yield* tx
            .delete(emailVerificationRequests)
            .where(eq(emailVerificationRequests.id, id))
            .returning(selectFields)

          return Option.fromNullishOr(row).pipe(
            Option.flatMap((value) => rowToEmailVerificationRequest(value))
          )
        })
      )
      .pipe(wrapSqlError("consume"))

  const deleteExpired: EmailVerificationRequestRepositoryService["deleteExpired"] = (now) =>
    Effect.gen(function* () {
      const deleted = yield* db
        .delete(emailVerificationRequests)
        .where(lte(emailVerificationRequests.expiresAt, now.toDate()))
        .returning({ id: emailVerificationRequests.id })

      return deleted.length
    }).pipe(wrapSqlError("deleteExpired"))

  return {
    create,
    startOrReuse,
    renew,
    findById,
    findByUserId,
    consume,
    deleteExpired,
  } satisfies EmailVerificationRequestRepositoryService
})

/**
 * Live EmailVerificationRequestRepository layer.
 */
export const EmailVerificationRequestRepositoryLive = Layer.effect(
  EmailVerificationRequestRepository,
  make
)
