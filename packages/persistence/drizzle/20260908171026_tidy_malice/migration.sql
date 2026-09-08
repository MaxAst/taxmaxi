CREATE TYPE "calculation_attempt_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "calculation_request_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "calculation_run_sync_captures" (
	"run_id" uuid PRIMARY KEY,
	"principal_id" uuid NOT NULL,
	"jurisdiction" text NOT NULL,
	"tax_year" integer NOT NULL,
	"reporting_currency" text NOT NULL,
	CONSTRAINT "calculation_run_sync_captures_scope_unique" UNIQUE("run_id","principal_id","jurisdiction","tax_year","reporting_currency")
);
--> statement-breakpoint
CREATE TABLE "calculation_run_sync_requests" (
	"run_id" uuid,
	"request_id" uuid,
	"principal_id" uuid NOT NULL,
	"jurisdiction" text NOT NULL,
	"tax_year" integer NOT NULL,
	"reporting_currency" text NOT NULL,
	CONSTRAINT "calculation_run_sync_requests_pkey" PRIMARY KEY("run_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "calculation_sync_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"request_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"jurisdiction" text NOT NULL,
	"tax_year" integer NOT NULL,
	"reporting_currency" text NOT NULL,
	"run_id" uuid,
	"status" "calculation_attempt_status" NOT NULL,
	"failure_code" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "calculation_sync_attempts_completion_consistent" CHECK (("status" = 'running') = ("completed_at" is null)),
	CONSTRAINT "calculation_sync_attempts_failure_consistent" CHECK (("status" = 'failed') = ("failure_code" is not null)),
	CONSTRAINT "calculation_sync_attempts_success_has_run" CHECK ("status" <> 'succeeded' or "run_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "calculation_sync_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"principal_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"source_job_id" uuid NOT NULL,
	"jurisdiction" text NOT NULL,
	"tax_year" integer NOT NULL,
	"reporting_currency" text NOT NULL,
	"status" "calculation_request_status" DEFAULT 'queued'::"calculation_request_status" NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	CONSTRAINT "calculation_sync_requests_job_scope_unique" UNIQUE("source_job_id","jurisdiction","tax_year","reporting_currency"),
	CONSTRAINT "calculation_sync_requests_id_scope_unique" UNIQUE("id","principal_id","jurisdiction","tax_year","reporting_currency"),
	CONSTRAINT "calculation_sync_requests_year_positive" CHECK ("tax_year" > 0)
);
--> statement-breakpoint
CREATE INDEX "idx_calculation_run_sync_requests_request" ON "calculation_run_sync_requests" ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calculation_sync_attempts_running_request_unique" ON "calculation_sync_attempts" ("request_id") WHERE "status" = 'running';--> statement-breakpoint
CREATE INDEX "idx_calculation_sync_attempts_request_started" ON "calculation_sync_attempts" ("request_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_calculation_sync_requests_scope_status" ON "calculation_sync_requests" ("principal_id","jurisdiction","tax_year","reporting_currency","status");--> statement-breakpoint
CREATE UNIQUE INDEX "processing_jobs_id_source_principal_unique" ON "processing_jobs" ("id","source_id","principal_id");--> statement-breakpoint
ALTER TABLE "calculation_run_sync_captures" ADD CONSTRAINT "calculation_run_sync_captures_run_scope_fk" FOREIGN KEY ("run_id","principal_id","jurisdiction","tax_year","reporting_currency") REFERENCES "calculation_runs"("id","principal_id","jurisdiction","tax_year","reporting_currency") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "calculation_run_sync_requests" ADD CONSTRAINT "calculation_run_sync_requests_capture_scope_fk" FOREIGN KEY ("run_id","principal_id","jurisdiction","tax_year","reporting_currency") REFERENCES "calculation_run_sync_captures"("run_id","principal_id","jurisdiction","tax_year","reporting_currency") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "calculation_run_sync_requests" ADD CONSTRAINT "calculation_run_sync_requests_request_scope_fk" FOREIGN KEY ("request_id","principal_id","jurisdiction","tax_year","reporting_currency") REFERENCES "calculation_sync_requests"("id","principal_id","jurisdiction","tax_year","reporting_currency") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "calculation_sync_attempts" ADD CONSTRAINT "calculation_sync_attempts_request_scope_fk" FOREIGN KEY ("request_id","principal_id","jurisdiction","tax_year","reporting_currency") REFERENCES "calculation_sync_requests"("id","principal_id","jurisdiction","tax_year","reporting_currency") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "calculation_sync_attempts" ADD CONSTRAINT "calculation_sync_attempts_captured_request_fk" FOREIGN KEY ("run_id","request_id") REFERENCES "calculation_run_sync_requests"("run_id","request_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "calculation_sync_requests" ADD CONSTRAINT "calculation_sync_requests_job_owner_fk" FOREIGN KEY ("source_job_id","source_id","principal_id") REFERENCES "processing_jobs"("id","source_id","principal_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "calculation_sync_requests" ADD CONSTRAINT "calculation_sync_requests_source_owner_fk" FOREIGN KEY ("source_id","principal_id") REFERENCES "sources"("id","principal_id") ON DELETE CASCADE;