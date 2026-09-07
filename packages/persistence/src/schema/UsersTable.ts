import { sql } from "drizzle-orm"
import { boolean, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"

export const userRoleEnum = pgEnum("user_role", ["user", "admin"])

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    name: text("name"),
    role: userRoleEnum("role").notNull().default("user"),
    /** Server time of the first welcome mark. Null until the user finishes or skips the welcome. */
    welcomeSeenAt: timestamp("welcome_seen_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("users_email_lower_uidx").on(sql`lower(${table.email})`)]
)

export type UserRow = typeof users.$inferSelect
