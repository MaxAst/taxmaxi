import { and, asc, eq, isNull, sql } from "drizzle-orm"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  AuthUser,
  AuthUserId,
  Email,
  sanitizeEmail,
  inferDisplayNameFromEmail,
  type AuthProviderType,
  type UserRole,
} from "@my/core/authentication"
import { Timestamp } from "@my/core/shared/values/Timestamp"
import { EntityNotFoundError, wrapSqlError } from "../errors/RepositoryError.ts"
import { identities } from "../schema/IdentitiesTable.ts"
import { users, type UserRow } from "../schema/UsersTable.ts"
import { UserRepository, type UserRepositoryService } from "../services/UserRepository.ts"
import { drizzle } from "./PgClientLive.ts"

type SelectedUserRow = Pick<
  UserRow,
  "id" | "email" | "emailVerified" | "name" | "role" | "welcomeSeenAt" | "createdAt" | "updatedAt"
>

const toAuthRole = (role: "user" | "admin"): UserRole => (role === "admin" ? "admin" : "member")

const fromAuthRole = (role: UserRole): "user" | "admin" => (role === "admin" ? "admin" : "user")

const toDisplayName = ({
  email,
  name,
}: {
  readonly email: Email
  readonly name: string | null
}): string => {
  const trimmedName = name?.trim()
  if (trimmedName && trimmedName.length > 0) {
    return trimmedName
  }
  return inferDisplayNameFromEmail(email)
}

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const selectAuthUserFields = {
    id: users.id,
    email: users.email,
    emailVerified: users.emailVerified,
    name: users.name,
    role: users.role,
    welcomeSeenAt: users.welcomeSeenAt,
    createdAt: users.createdAt,
    updatedAt: users.updatedAt,
  } as const

  const getPrimaryProviderFromIdentity = (userId: AuthUserId) =>
    Effect.gen(function* () {
      const [identity] = yield* db
        .select({ provider: identities.provider })
        .from(identities)
        .where(eq(identities.userId, userId))
        .orderBy(asc(identities.createdAt))
      return Option.fromNullishOr(identity).pipe(Option.map((value) => value.provider))
    })

  const rowToAuthUserWithPrimaryProvider = (
    row: SelectedUserRow,
    primaryProviderOverride?: AuthProviderType
  ) =>
    Effect.gen(function* () {
      const userId = AuthUserId.make(row.id)
      const email = Email.make(row.email)
      const identityProvider = yield* getPrimaryProviderFromIdentity(userId)

      const primaryProvider =
        primaryProviderOverride ??
        Option.match(identityProvider, {
          onNone: (): AuthProviderType => "local",
          onSome: (provider) => provider,
        })

      return AuthUser.make({
        id: userId,
        email,
        displayName: toDisplayName({ email, name: row.name }),
        role: toAuthRole(row.role),
        primaryProvider,
        emailVerified: row.emailVerified,
        welcomeSeenAt:
          row.welcomeSeenAt === null
            ? null
            : Timestamp.make({ epochMillis: row.welcomeSeenAt.getTime() }),
        createdAt: Timestamp.make({ epochMillis: row.createdAt.getTime() }),
        updatedAt: Timestamp.make({ epochMillis: row.updatedAt.getTime() }),
      })
    })

  const findById: UserRepositoryService["findById"] = (id) =>
    Effect.gen(function* () {
      const [row] = yield* db.select(selectAuthUserFields).from(users).where(eq(users.id, id))

      if (row === undefined) {
        return Option.none<AuthUser>()
      }

      const user = yield* rowToAuthUserWithPrimaryProvider(row)
      return Option.some(user)
    }).pipe(wrapSqlError("findById"))

  /**
   * Account emails are stored trimmed and lowercased, so any casing of
   * the argument finds the same account. The comparison runs on `lower(email)`
   * and is served by the `users_email_lower_uidx` index.
   */
  const findByEmail: UserRepositoryService["findByEmail"] = (email) =>
    Effect.gen(function* () {
      const [row] = yield* db
        .select(selectAuthUserFields)
        .from(users)
        .where(eq(sql`lower(${users.email})`, sanitizeEmail(email)))

      if (row === undefined) {
        return Option.none<AuthUser>()
      }

      const user = yield* rowToAuthUserWithPrimaryProvider(row)
      return Option.some(user)
    }).pipe(wrapSqlError("findByEmail"))

  const create: UserRepositoryService["create"] = (user) =>
    Effect.gen(function* () {
      const now = yield* DateTime.nowAsDate

      const [created] = yield* db
        .insert(users)
        .values({
          id: user.id,
          email: user.email,
          emailVerified: user.emailVerified,
          name: user.displayName,
          role: fromAuthRole(user.role),
          createdAt: now,
          updatedAt: now,
        })
        .returning(selectAuthUserFields)

      if (!created) {
        return yield* new EntityNotFoundError({ entityType: "AuthUser", entityId: user.id })
      }

      return yield* rowToAuthUserWithPrimaryProvider(created, user.primaryProvider)
    }).pipe(wrapSqlError("create"))

  const update: UserRepositoryService["update"] = (id, data) =>
    Effect.gen(function* () {
      const updateSet: {
        readonly email?: string
        readonly name?: string
        readonly role?: "user" | "admin"
        readonly emailVerified?: boolean
        readonly updatedAt: Date
      } = {
        ...(data.email !== undefined ? { email: data.email } : {}),
        ...(data.displayName !== undefined ? { name: data.displayName } : {}),
        ...(data.role !== undefined ? { role: fromAuthRole(data.role) } : {}),
        ...(data.emailVerified !== undefined ? { emailVerified: data.emailVerified } : {}),
        updatedAt: yield* DateTime.nowAsDate,
      }

      const [updated] = yield* db
        .update(users)
        .set(updateSet)
        .where(eq(users.id, id))
        .returning(selectAuthUserFields)

      if (!updated) {
        return yield* new EntityNotFoundError({ entityType: "AuthUser", entityId: id })
      }

      return yield* rowToAuthUserWithPrimaryProvider(updated)
    }).pipe(wrapSqlError("update"))

  const markWelcomeSeen: UserRepositoryService["markWelcomeSeen"] = ({ userId }) =>
    Effect.gen(function* () {
      const now = yield* DateTime.nowAsDate

      // Set once: the row changes only while the stamp is null, so a repeat mark
      // (or a racing first mark) leaves both the stamp and updatedAt as they are.
      yield* db
        .update(users)
        .set({ welcomeSeenAt: now, updatedAt: now })
        .where(and(eq(users.id, userId), isNull(users.welcomeSeenAt)))

      const [row] = yield* db.select(selectAuthUserFields).from(users).where(eq(users.id, userId))

      if (row === undefined) {
        return yield* new EntityNotFoundError({ entityType: "AuthUser", entityId: userId })
      }

      return yield* rowToAuthUserWithPrimaryProvider(row)
    }).pipe(wrapSqlError("markWelcomeSeen"))

  const deleteUser: UserRepositoryService["delete"] = (id) =>
    Effect.gen(function* () {
      const [deleted] = yield* db.delete(users).where(eq(users.id, id)).returning({ id: users.id })

      if (!deleted) {
        return yield* new EntityNotFoundError({ entityType: "AuthUser", entityId: id })
      }
    }).pipe(wrapSqlError("delete"))

  const findPlatformAdmins: UserRepositoryService["findPlatformAdmins"] = Effect.gen(function* () {
    const rows = yield* db
      .select(selectAuthUserFields)
      .from(users)
      .where(eq(users.role, "admin"))
      .orderBy(asc(users.email))

    return yield* Effect.forEach(rows, (row) => rowToAuthUserWithPrimaryProvider(row))
  }).pipe(wrapSqlError("findPlatformAdmins"))

  const isPlatformAdmin: UserRepositoryService["isPlatformAdmin"] = (id) =>
    Effect.gen(function* () {
      const [row] = yield* db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, id), eq(users.role, "admin")))
      return row !== undefined
    }).pipe(wrapSqlError("isPlatformAdmin"))

  return {
    findById,
    findByEmail,
    create,
    update,
    markWelcomeSeen,
    delete: deleteUser,
    findPlatformAdmins,
    isPlatformAdmin,
  } satisfies UserRepositoryService
})

export const UserRepositoryLive = Layer.effect(UserRepository, make)
