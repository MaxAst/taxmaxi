/**
 * EmailVerificationRequestRepositoryLive - PostgreSQL verification request persistence
 *
 * Provides the live repository for pending local email verification requests.
 *
 * @module EmailVerificationRequestRepositoryLive
 */

import { desc, eq, lte } from "drizzle-orm"
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
import { Timestamp } from "@my/core/shared/values/Timestamp"
import { wrapSqlError } from "../errors/RepositoryError.ts"
import {
  emailVerificationRequests,
  type EmailVerificationRequest as EmailVerificationRequestRow,
} from "../schema/EmailVerificationRequestsTable.ts"
import {
  EmailVerificationRequestRepository,
  type EmailVerificationRequestRepositoryService,
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

  const create: EmailVerificationRequestRepositoryService["create"] = (request) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
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
    Effect.gen(function* () {
      const [row] = yield* db
        .delete(emailVerificationRequests)
        .where(eq(emailVerificationRequests.id, id))
        .returning(selectFields)

      return Option.fromNullishOr(row).pipe(
        Option.flatMap((value) => rowToEmailVerificationRequest(value))
      )
    }).pipe(wrapSqlError("consume"))

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
