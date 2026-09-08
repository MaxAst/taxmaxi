import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { users } from "./UsersTable.ts"

export const emailVerificationRequests = pgTable("email_verification_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  code: text("code").notNull(),
  expiresAt: timestamp("expires_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  sendCount: integer("send_count").notNull(),
  lastSentAt: timestamp("last_sent_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
})

export type EmailVerificationRequest = typeof emailVerificationRequests.$inferSelect
