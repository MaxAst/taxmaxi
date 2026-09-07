/**
 * Email - Branded type for email addresses
 *
 * A branded string type for validated email addresses using RFC-compliant
 * pattern matching.
 *
 * @module Email
 */

import * as Schema from "effect/Schema"

/**
 * Email address validation pattern (simplified RFC 5322)
 *
 * This pattern covers most valid email addresses while being practical:
 * - Local part: alphanumeric, dots, hyphens, underscores, plus signs
 * - @ symbol
 * - Domain: alphanumeric and hyphens, with at least one dot for TLD
 */
const EMAIL_PATTERN =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/

/**
 * Email - Branded string for validated email addresses
 *
 * Validates format against a simplified RFC 5322 pattern. An `Email` never
 * carries surrounding whitespace; request bodies trim the raw string before
 * this check. It may carry any casing; the writer stores it trimmed and
 * lowercased through `sanitizeEmail`.
 */
export const Email = Schema.String.pipe(
  Schema.annotate({
    identifier: "Email",
    title: "Email Address",
    description: "A valid email address",
    examples: ["test@example.com"],
  }),
  Schema.check(Schema.isPattern(EMAIL_PATTERN)),
  Schema.brand("Email")
)

/**
 * The branded Email type
 */
export type Email = typeof Email.Type

/**
 * Type guard for Email using Schema.is
 */
export const isEmail = Schema.is(Email)

/**
 * Sanitize an account email: trim and lowercase it.
 *
 * The writer applies this before it stores an account email, a local
 * identity's provider ID, or a verification request, and before it looks a
 * local identity up for login. `Max@Example.com` and `max@example.com` are
 * one account.
 */
export const sanitizeEmail = (email: Email): Email => Email.make(email.trim().toLowerCase())
