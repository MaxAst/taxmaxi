import { sql } from "drizzle-orm"
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { calculationRuns } from "./CalculationRunsTables.ts"
import { processingJobs } from "./ProcessingJobsTable.ts"
import { sources } from "./SourcesTable.ts"

export const calculationRequestStatusEnum = pgEnum("calculation_request_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
])

export const calculationAttemptStatusEnum = pgEnum("calculation_attempt_status", [
  "running",
  "succeeded",
  "failed",
])

/** Exact completed source work accepted for one annual calculation scope. */
export const calculationSyncRequests = pgTable(
  "calculation_sync_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    principalId: uuid("principal_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    sourceJobId: uuid("source_job_id").notNull(),
    jurisdiction: text("jurisdiction").notNull(),
    taxYear: integer("tax_year").notNull(),
    reportingCurrency: text("reporting_currency").notNull(),
    status: calculationRequestStatusEnum("status").notNull().default("queued"),
    requestedAt: timestamp("requested_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    unique("calculation_sync_requests_job_scope_unique").on(
      table.sourceJobId,
      table.jurisdiction,
      table.taxYear,
      table.reportingCurrency
    ),
    unique("calculation_sync_requests_id_scope_unique").on(
      table.id,
      table.principalId,
      table.jurisdiction,
      table.taxYear,
      table.reportingCurrency
    ),
    foreignKey({
      name: "calculation_sync_requests_job_owner_fk",
      columns: [table.sourceJobId, table.sourceId, table.principalId],
      foreignColumns: [processingJobs.id, processingJobs.sourceId, processingJobs.principalId],
    }).onDelete("cascade"),
    foreignKey({
      name: "calculation_sync_requests_source_owner_fk",
      columns: [table.sourceId, table.principalId],
      foreignColumns: [sources.id, sources.principalId],
    }).onDelete("cascade"),
    check("calculation_sync_requests_year_positive", sql`${table.taxYear} > 0`),
    index("idx_calculation_sync_requests_scope_status").on(
      table.principalId,
      table.jurisdiction,
      table.taxYear,
      table.reportingCurrency,
      table.status
    ),
  ]
)

/** Presence records explicit capture; absence means legacy/uncaptured, never an empty capture. */
export const calculationRunSyncCaptures = pgTable(
  "calculation_run_sync_captures",
  {
    runId: uuid("run_id").primaryKey(),
    principalId: uuid("principal_id").notNull(),
    jurisdiction: text("jurisdiction").notNull(),
    taxYear: integer("tax_year").notNull(),
    reportingCurrency: text("reporting_currency").notNull(),
  },
  (table) => [
    unique("calculation_run_sync_captures_scope_unique").on(
      table.runId,
      table.principalId,
      table.jurisdiction,
      table.taxYear,
      table.reportingCurrency
    ),
    foreignKey({
      name: "calculation_run_sync_captures_run_scope_fk",
      columns: [
        table.runId,
        table.principalId,
        table.jurisdiction,
        table.taxYear,
        table.reportingCurrency,
      ],
      foreignColumns: [
        calculationRuns.id,
        calculationRuns.principalId,
        calculationRuns.jurisdiction,
        calculationRuns.taxYear,
        calculationRuns.reportingCurrency,
      ],
    }).onDelete("cascade"),
  ]
)

/** Immutable request membership from the run's accounting input snapshot, including settled requests. */
export const calculationRunSyncRequests = pgTable(
  "calculation_run_sync_requests",
  {
    runId: uuid("run_id").notNull(),
    requestId: uuid("request_id").notNull(),
    principalId: uuid("principal_id").notNull(),
    jurisdiction: text("jurisdiction").notNull(),
    taxYear: integer("tax_year").notNull(),
    reportingCurrency: text("reporting_currency").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.requestId] }),
    foreignKey({
      name: "calculation_run_sync_requests_capture_scope_fk",
      columns: [
        table.runId,
        table.principalId,
        table.jurisdiction,
        table.taxYear,
        table.reportingCurrency,
      ],
      foreignColumns: [
        calculationRunSyncCaptures.runId,
        calculationRunSyncCaptures.principalId,
        calculationRunSyncCaptures.jurisdiction,
        calculationRunSyncCaptures.taxYear,
        calculationRunSyncCaptures.reportingCurrency,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "calculation_run_sync_requests_request_scope_fk",
      columns: [
        table.requestId,
        table.principalId,
        table.jurisdiction,
        table.taxYear,
        table.reportingCurrency,
      ],
      foreignColumns: [
        calculationSyncRequests.id,
        calculationSyncRequests.principalId,
        calculationSyncRequests.jurisdiction,
        calculationSyncRequests.taxYear,
        calculationSyncRequests.reportingCurrency,
      ],
    }).onDelete("cascade"),
    index("idx_calculation_run_sync_requests_request").on(table.requestId),
  ]
)

/** One attempt at an exact request. Failure before engine start has no invented run ID. */
export const calculationSyncAttempts = pgTable(
  "calculation_sync_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id").notNull(),
    principalId: uuid("principal_id").notNull(),
    jurisdiction: text("jurisdiction").notNull(),
    taxYear: integer("tax_year").notNull(),
    reportingCurrency: text("reporting_currency").notNull(),
    runId: uuid("run_id"),
    status: calculationAttemptStatusEnum("status").notNull(),
    failureCode: text("failure_code"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    foreignKey({
      name: "calculation_sync_attempts_request_scope_fk",
      columns: [
        table.requestId,
        table.principalId,
        table.jurisdiction,
        table.taxYear,
        table.reportingCurrency,
      ],
      foreignColumns: [
        calculationSyncRequests.id,
        calculationSyncRequests.principalId,
        calculationSyncRequests.jurisdiction,
        calculationSyncRequests.taxYear,
        calculationSyncRequests.reportingCurrency,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "calculation_sync_attempts_captured_request_fk",
      columns: [table.runId, table.requestId],
      foreignColumns: [calculationRunSyncRequests.runId, calculationRunSyncRequests.requestId],
    }).onDelete("cascade"),
    uniqueIndex("calculation_sync_attempts_running_request_unique")
      .on(table.requestId)
      .where(sql`${table.status} = 'running'`),
    index("idx_calculation_sync_attempts_request_started").on(table.requestId, table.startedAt),
    check(
      "calculation_sync_attempts_completion_consistent",
      sql`(${table.status} = 'running') = (${table.completedAt} is null)`
    ),
    check(
      "calculation_sync_attempts_failure_consistent",
      sql`(${table.status} = 'failed') = (${table.failureCode} is not null)`
    ),
    check(
      "calculation_sync_attempts_success_has_run",
      sql`${table.status} <> 'succeeded' or ${table.runId} is not null`
    ),
  ]
)
