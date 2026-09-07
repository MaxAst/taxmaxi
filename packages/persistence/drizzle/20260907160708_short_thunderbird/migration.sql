ALTER TABLE "users" DROP CONSTRAINT "users_email_key";--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uidx" ON "users" (lower("email"));