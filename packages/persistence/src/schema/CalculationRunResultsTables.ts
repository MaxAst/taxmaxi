import { sql } from "drizzle-orm"
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core"
import type {
  CalculationRunMovementInput,
  CalculationRunMovementValuation,
} from "../services/CalculationRunRepository.ts"
import { movementCorrectionTargets } from "./MovementCorrectionTargetsTable.ts"
import { assets } from "./AssetsTable.ts"
import { calculationRuns } from "./CalculationRunsTables.ts"
import { custodyUnits } from "./CustodyUnitsTables.ts"
import { providerAssets } from "./ProviderAssetsTable.ts"

const quantity = (name: string) => numeric(name, { precision: 355, scale: 255 })
const money = (name: string) => numeric(name, { precision: 355, scale: 255 })
const instant = (name: string) => timestamp(name, { withTimezone: true, mode: "date" })

/** Stored explanation match encoded without losing decimal precision. */
export interface CalculationRunExplanationMatch {
  readonly acquisitionEventId: string
  readonly quantity: string
}

/** Complete movement facts frozen with one finalized calculation run, independently of corrections. */
export const calculationRunMovementInputs = pgTable(
  "calculation_run_movement_inputs",
  {
    runId: uuid("run_id").notNull(),
    principalId: uuid("principal_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    targetId: uuid("target_id").notNull(),
    transactionId: uuid("transaction_id"),
    eventId: uuid("event_id"),
    captured: jsonb("captured").$type<CalculationRunMovementInput>().notNull(),
    valuation: jsonb("valuation").$type<CalculationRunMovementValuation>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.targetId] }),
    foreignKey({
      columns: [table.runId, table.principalId],
      foreignColumns: [calculationRuns.id, calculationRuns.principalId],
      name: "calculation_movement_inputs_run_owner_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.targetId, table.sourceId, table.principalId],
      foreignColumns: [
        movementCorrectionTargets.id,
        movementCorrectionTargets.sourceId,
        movementCorrectionTargets.principalId,
      ],
      name: "calculation_movement_inputs_target_owner_fk",
    }).onDelete("restrict"),
    index("idx_calculation_movement_inputs_transaction").on(table.runId, table.transactionId),
    index("idx_calculation_movement_inputs_event").on(table.runId, table.eventId),
    check(
      "calculation_movement_inputs_capture_links",
      sql`(
      jsonb_typeof(${table.captured}) = 'object'
      and ${table.captured}->>'targetId' = ${table.targetId}::text
      and ${table.captured}->>'currentOutcome' in ('included', 'withheld', 'absent', 'outside_period')
      and jsonb_typeof(${table.captured}->'system') = 'object'
      and jsonb_typeof(${table.captured}->'effective') = 'object'
      and (${table.captured}->'effective'->'event'->>'id') is not distinct from ${table.eventId}::text
      and (${table.captured}->'current'->>'transactionId') is not distinct from ${table.transactionId}::text
      and (${table.captured}->'current' = 'null'::jsonb or (
        ${table.captured}->'current'->>'targetId' = ${table.targetId}::text
        and ${table.captured}->'current'->>'sourceId' = ${table.sourceId}::text
      ))
    ) is true`
    ),
    check(
      "calculation_movement_inputs_valuation",
      sql`(
      jsonb_typeof(${table.valuation}) = 'object'
      and ${table.valuation}->>'_tag' in ('not_evaluated', 'missing', 'ambiguous', 'selected')
      and (${table.valuation}->>'_tag' <> 'selected' or (
        ${table.eventId} is not null
        and ${table.valuation}->>'kind' in ('user_valuation', 'observed_consideration', 'market_quote')
        and jsonb_typeof(${table.valuation}->'total'->'amount') = 'string'
        and jsonb_typeof(${table.valuation}->'total'->'currency') = 'string'
      ))
    ) is true`
    ),
  ]
)

/** Custody-unit identity recorded as part of one calculation run's input snapshot. */
export const calculationRunCustodyUnits = pgTable(
  "calculation_run_custody_units",
  {
    runId: uuid("run_id").notNull(),
    principalId: uuid("principal_id").notNull(),
    custodyUnitId: uuid("custody_unit_id")
      .notNull()
      .references(() => custodyUnits.id),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.principalId, table.custodyUnitId] }),
    foreignKey({
      columns: [table.runId, table.principalId],
      foreignColumns: [calculationRuns.id, calculationRuns.principalId],
      name: "calculation_run_custody_units_run_principal_fk",
    }).onDelete("cascade"),
    index("idx_calculation_run_custody_units_unit").on(table.custodyUnitId),
  ]
)

/** Source membership frozen for one run-scoped custody-unit snapshot. */
export const calculationRunCustodyUnitSources = pgTable(
  "calculation_run_custody_unit_sources",
  {
    runId: uuid("run_id").notNull(),
    principalId: uuid("principal_id").notNull(),
    custodyUnitId: uuid("custody_unit_id").notNull(),
    sourceId: uuid("source_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.sourceId] }),
    foreignKey({
      columns: [table.runId, table.principalId, table.custodyUnitId],
      foreignColumns: [
        calculationRunCustodyUnits.runId,
        calculationRunCustodyUnits.principalId,
        calculationRunCustodyUnits.custodyUnitId,
      ],
      name: "calculation_run_custody_unit_sources_run_unit_fk",
    }).onDelete("cascade"),
    index("idx_calculation_run_custody_unit_sources_unit").on(table.runId, table.custodyUnitId),
  ]
)

/** Factual FIFO quantity allocation produced by one calculation run. */
export const calculationRunAllocations = pgTable(
  "calculation_run_allocations",
  {
    runId: uuid("run_id").notNull(),
    principalId: uuid("principal_id").notNull(),
    sequence: integer("sequence").notNull(),
    acquisitionEventId: uuid("acquisition_event_id").notNull(),
    dispositionEventId: uuid("disposition_event_id").notNull(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id),
    custodyUnitId: uuid("custody_unit_id").notNull(),
    acquiredAt: instant("acquired_at").notNull(),
    disposedAt: instant("disposed_at").notNull(),
    quantity: quantity("quantity").notNull(),
    costBasis: money("cost_basis"),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.sequence] }),
    foreignKey({
      columns: [table.runId, table.principalId, table.custodyUnitId],
      foreignColumns: [
        calculationRunCustodyUnits.runId,
        calculationRunCustodyUnits.principalId,
        calculationRunCustodyUnits.custodyUnitId,
      ],
      name: "calculation_run_allocations_run_unit_fk",
    }).onDelete("cascade"),
    index("idx_calculation_run_allocations_disposition").on(table.runId, table.dispositionEventId),
    check("calculation_run_allocations_sequence_non_negative", sql`${table.sequence} >= 0`),
    check("calculation_run_allocations_quantity_positive", sql`${table.quantity} > 0`),
  ]
)

/** Fully valued factual disposal result produced by one calculation run. */
export const calculationRunRealizedResults = pgTable(
  "calculation_run_realized_results",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => calculationRuns.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    sourceId: uuid("source_id").notNull(),
    allocationSequence: integer("allocation_sequence").notNull(),
    acquisitionEventId: uuid("acquisition_event_id").notNull(),
    dispositionEventId: uuid("disposition_event_id").notNull(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id),
    acquiredAt: instant("acquired_at").notNull(),
    disposedAt: instant("disposed_at").notNull(),
    quantity: quantity("quantity").notNull(),
    costBasis: money("cost_basis").notNull(),
    proceeds: money("proceeds").notNull(),
    gainLoss: money("gain_loss").notNull(),
    treatmentCodes: jsonb("treatment_codes").$type<ReadonlyArray<string>>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.sequence] }),
    foreignKey({
      columns: [table.runId, table.sourceId],
      foreignColumns: [
        calculationRunCustodyUnitSources.runId,
        calculationRunCustodyUnitSources.sourceId,
      ],
      name: "calculation_run_realized_results_run_source_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.runId, table.allocationSequence],
      foreignColumns: [calculationRunAllocations.runId, calculationRunAllocations.sequence],
      name: "calculation_run_realized_results_run_allocation_fk",
    }).onDelete("cascade"),
    index("idx_calculation_run_realized_disposition").on(table.runId, table.dispositionEventId),
    check("calculation_run_realized_sequence_non_negative", sql`${table.sequence} >= 0`),
    check("calculation_run_realized_quantity_positive", sql`${table.quantity} > 0`),
  ]
)

/** Jurisdiction income result produced by one calculation run. */
export const calculationRunIncomeResults = pgTable(
  "calculation_run_income_results",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => calculationRuns.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    sourceId: uuid("source_id").notNull(),
    eventId: uuid("event_id").notNull(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id),
    occurredAt: instant("occurred_at").notNull(),
    quantity: quantity("quantity").notNull(),
    value: money("value").notNull(),
    treatmentCodes: jsonb("treatment_codes").$type<ReadonlyArray<string>>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.sequence] }),
    foreignKey({
      columns: [table.runId, table.sourceId],
      foreignColumns: [
        calculationRunCustodyUnitSources.runId,
        calculationRunCustodyUnitSources.sourceId,
      ],
      name: "calculation_run_income_results_run_source_fk",
    }).onDelete("cascade"),
    index("idx_calculation_run_income_event").on(table.runId, table.eventId),
    check("calculation_run_income_sequence_non_negative", sql`${table.sequence} >= 0`),
    check("calculation_run_income_quantity_positive", sql`${table.quantity} > 0`),
  ]
)

/** Remaining derived inventory at the calculation run's year-end boundary. */
export const calculationRunDerivedLots = pgTable(
  "calculation_run_derived_lots",
  {
    runId: uuid("run_id").notNull(),
    principalId: uuid("principal_id").notNull(),
    sequence: integer("sequence").notNull(),
    acquisitionEventId: uuid("acquisition_event_id").notNull(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id),
    custodyUnitId: uuid("custody_unit_id").notNull(),
    acquiredAt: instant("acquired_at").notNull(),
    remainingQuantity: quantity("remaining_quantity").notNull(),
    costBasisPerUnit: money("cost_basis_per_unit"),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.sequence] }),
    foreignKey({
      columns: [table.runId, table.principalId, table.custodyUnitId],
      foreignColumns: [
        calculationRunCustodyUnits.runId,
        calculationRunCustodyUnits.principalId,
        calculationRunCustodyUnits.custodyUnitId,
      ],
      name: "calculation_run_derived_lots_run_unit_fk",
    }).onDelete("cascade"),
    index("idx_calculation_run_derived_lots_inventory").on(
      table.runId,
      table.custodyUnitId,
      table.assetId,
      table.acquiredAt
    ),
    check("calculation_run_derived_lots_sequence_non_negative", sql`${table.sequence} >= 0`),
    check("calculation_run_derived_lots_quantity_positive", sql`${table.remainingQuantity} > 0`),
  ]
)

/** Machine-readable blocker produced by one calculation run. */
export const calculationRunBlockers = pgTable(
  "calculation_run_blockers",
  {
    runId: uuid("run_id").notNull(),
    principalId: uuid("principal_id").notNull(),
    sequence: integer("sequence").notNull(),
    code: text("code").notNull(),
    eventId: uuid("event_id").notNull(),
    assetId: uuid("asset_id").references(() => assets.id),
    providerAssetRowId: uuid("provider_asset_row_id").references(() => providerAssets.id),
    custodyUnitId: uuid("custody_unit_id").notNull(),
    missingQuantity: quantity("missing_quantity"),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.sequence] }),
    foreignKey({
      columns: [table.runId, table.principalId, table.custodyUnitId],
      foreignColumns: [
        calculationRunCustodyUnits.runId,
        calculationRunCustodyUnits.principalId,
        calculationRunCustodyUnits.custodyUnitId,
      ],
      name: "calculation_run_blockers_run_unit_fk",
    }).onDelete("cascade"),
    index("idx_calculation_run_blockers_code").on(table.runId, table.code),
    check("calculation_run_blockers_sequence_non_negative", sql`${table.sequence} >= 0`),
    check(
      "calculation_run_blockers_target_link_required",
      sql`${table.assetId} is not null or ${table.providerAssetRowId} is not null`
    ),
    check(
      "calculation_run_blockers_missing_quantity_positive",
      sql`${table.missingQuantity} is null or ${table.missingQuantity} > 0`
    ),
  ]
)

/** Deterministic machine-readable explanation entry from one calculation run. */
export const calculationRunExplanationEntries = pgTable(
  "calculation_run_explanation_entries",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => calculationRuns.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    eventId: uuid("event_id").notNull(),
    code: text("code").notNull(),
    valuationKind: text("valuation_kind"),
    matches: jsonb("matches").$type<ReadonlyArray<CalculationRunExplanationMatch>>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.sequence] }),
    index("idx_calculation_run_explanations_event").on(table.runId, table.eventId),
    check("calculation_run_explanations_sequence_non_negative", sql`${table.sequence} >= 0`),
  ]
)

export type CalculationRunAllocation = typeof calculationRunAllocations.$inferSelect
export type CalculationRunAllocationInsert = typeof calculationRunAllocations.$inferInsert
export type CalculationRunCustodyUnit = typeof calculationRunCustodyUnits.$inferSelect
export type CalculationRunCustodyUnitInsert = typeof calculationRunCustodyUnits.$inferInsert
export type CalculationRunCustodyUnitSource = typeof calculationRunCustodyUnitSources.$inferSelect
export type CalculationRunCustodyUnitSourceInsert =
  typeof calculationRunCustodyUnitSources.$inferInsert
export type CalculationRunRealizedResult = typeof calculationRunRealizedResults.$inferSelect
export type CalculationRunRealizedResultInsert = typeof calculationRunRealizedResults.$inferInsert
export type CalculationRunIncomeResult = typeof calculationRunIncomeResults.$inferSelect
export type CalculationRunIncomeResultInsert = typeof calculationRunIncomeResults.$inferInsert
export type CalculationRunDerivedLot = typeof calculationRunDerivedLots.$inferSelect
export type CalculationRunDerivedLotInsert = typeof calculationRunDerivedLots.$inferInsert
export type CalculationRunBlocker = typeof calculationRunBlockers.$inferSelect
export type CalculationRunBlockerInsert = typeof calculationRunBlockers.$inferInsert
export type CalculationRunExplanationEntry = typeof calculationRunExplanationEntries.$inferSelect
export type CalculationRunExplanationEntryInsert =
  typeof calculationRunExplanationEntries.$inferInsert
