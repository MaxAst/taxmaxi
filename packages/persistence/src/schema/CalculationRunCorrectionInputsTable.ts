/**
 * Immutable movement correction inputs captured for one calculation snapshot.
 *
 * @module CalculationRunCorrectionInputsTable
 */
import { sql } from "drizzle-orm"
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from "drizzle-orm/pg-core"
import type { CalculationRunCorrectionInput } from "../services/FactualLedgerRepository.ts"
import { calculationRuns } from "./CalculationRunsTables.ts"
import {
  movementCorrectionKindEnum,
  principalTransactionOverrides,
} from "./PrincipalTransactionOverridesTables.ts"

/** One visible history record, including inactive history, and the inputs actually consumed by its run. */
export const calculationRunCorrectionInputs = pgTable(
  "calculation_run_correction_inputs",
  {
    runId: uuid("run_id").notNull(),
    principalId: uuid("principal_id").notNull(),
    jurisdiction: text("jurisdiction").notNull(),
    taxYear: integer("tax_year").notNull(),
    reportingCurrency: text("reporting_currency").notNull(),
    sourceId: uuid("source_id").notNull(),
    targetId: uuid("target_id").notNull(),
    overrideId: uuid("override_id").notNull(),
    kind: movementCorrectionKindEnum("kind").notNull(),
    captured: jsonb("captured").$type<CalculationRunCorrectionInput>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.overrideId] }),
    foreignKey({
      name: "calculation_correction_inputs_run_scope_fk",
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
    }).onDelete("restrict"),
    foreignKey({
      name: "calculation_correction_inputs_history_fk",
      columns: [table.principalId, table.sourceId, table.targetId, table.kind, table.overrideId],
      foreignColumns: [
        principalTransactionOverrides.principalId,
        principalTransactionOverrides.sourceId,
        principalTransactionOverrides.targetId,
        principalTransactionOverrides.kind,
        principalTransactionOverrides.id,
      ],
    }).onDelete("restrict"),
    check(
      "calculation_correction_inputs_captured_identity",
      sql`(
    jsonb_typeof(${table.captured}) = 'object'
    and ${table.captured}->'history'->>'id' = ${table.overrideId}::text
    and ${table.captured}->'history'->>'principalId' = ${table.principalId}::text
    and ${table.captured}->'history'->>'sourceId' = ${table.sourceId}::text
    and ${table.captured}->'history'->>'targetId' = ${table.targetId}::text
    and ${table.captured}->'history'->>'kind' = ${table.kind}::text
    and ${table.captured}->>'reportingCurrency' = ${table.reportingCurrency}
    and ${table.captured}->>'application' in ('inactive', 'not_applied', 'applied', 'needs_attention')
    and ${table.captured}->>'streamState' in ('active', 'withdrawn', 'superseded')
    and ${table.captured}->>'currentOutcome' in ('included', 'withheld', 'absent', 'outside_period')
    and jsonb_typeof(${table.captured}->'system') = 'object'
    and jsonb_typeof(${table.captured}->'effective') = 'object'
  ) is true`
    ),
  ]
)
