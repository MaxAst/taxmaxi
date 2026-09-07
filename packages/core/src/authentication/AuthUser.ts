/**
 * AuthUser - Core user entity for authentication
 *
 * Represents an authenticated user in the system. A single AuthUser can have
 * multiple UserIdentity records linking them to different auth providers.
 *
 * @module AuthUser
 */

import * as Schema from "effect/Schema"
import { AuthUserId } from "./AuthUserId.ts"
import { AuthProviderType } from "./AuthProviderType.ts"
import { Email } from "./Email.ts"
import { Timestamp } from "../shared/values/Timestamp.ts"

/**
 * UserRole - The role assigned to a user
 *
 * Defines access levels within the application:
 * - 'owner': Workspace owner with full org access
 * - 'viewer': Read-only access
 */
export const UserRole = Schema.Literals(["admin", "owner", "member", "viewer"]).annotate({
  identifier: "UserRole",
  title: "User Role",
  description: "The role assigned to a user determining their access level",
})

/**
 * The UserRole type
 */
export type UserRole = typeof UserRole.Type

/**
 * Type guard for UserRole using Schema.is
 */
export const isUserRole = Schema.is(UserRole)

/**
 * Infer a display name from the email local part.
 *
 * Local registration does not collect a display name, so the backend derives
 * one from the portion before `@`.
 */
export const inferDisplayNameFromEmail = (email: Email): string => {
  const [localPart = ""] = email.split("@")
  return localPart.length > 0 ? localPart : "user"
}

/**
 * AuthUser - The main user entity for authentication
 *
 * Contains core user information and tracks which auth provider was
 * used for the primary/initial registration. Users can link additional
 * providers via UserIdentity records.
 */
export class AuthUser extends Schema.Class<AuthUser>("AuthUser")({
  /**
   * Unique identifier for the user
   */
  id: AuthUserId,

  /**
   * User's email address (used for identification and communication)
   */
  email: Email,

  /**
   * User's display name
   */
  displayName: Schema.Trimmed.check(Schema.isNonEmpty()).annotate({
    title: "Display Name",
    description: "The user's display name",
    examples: ["Max Mustermann"],
  }),

  /**
   * User's role determining access level
   */
  role: UserRole,

  /**
   * The primary auth provider used for initial registration
   */
  primaryProvider: AuthProviderType,

  /**
   * Whether the user's email address has been verified
   */
  emailVerified: Schema.Boolean.annotate({
    title: "Email Verified",
    description: "Whether the user's email address has been verified",
  }),

  /**
   * When the user first finished or skipped the welcome.
   *
   * Null means the welcome has not been seen. The server stamps this once;
   * later marks keep the first timestamp.
   */
  welcomeSeenAt: Schema.NullOr(Timestamp).annotate({
    title: "Welcome Seen At",
    description: "When the user first finished or skipped the welcome, or null if not yet seen",
  }),

  /**
   * When the user account was created
   */
  createdAt: Timestamp,

  /**
   * When the user account was last updated
   */
  updatedAt: Timestamp,
}) {}

/**
 * Type guard for AuthUser using Schema.is
 */
export const isAuthUser = Schema.is(AuthUser)
