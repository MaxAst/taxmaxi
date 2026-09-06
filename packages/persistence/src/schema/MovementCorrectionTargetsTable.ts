import { sql } from "drizzle-orm"
import { check, foreignKey, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core"
import { sources } from "./SourcesTable.ts"

/** Durable producer movement identities. Replay deletes legs, never these targets. */
export const movementCorrectionTargets = pgTable(
  "movement_correction_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    principalId: uuid("principal_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    sourceRecordKey: text("source_record_key").notNull(),
    componentKey: text("component_key").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.sourceId, table.principalId],
      foreignColumns: [sources.id, sources.principalId],
      name: "movement_correction_targets_source_owner_fk",
    })
      .onDelete("restrict")
      .onUpdate("cascade"),
    unique("movement_correction_targets_source_component_unique").on(
      table.sourceId,
      table.sourceRecordKey,
      table.componentKey
    ),
    unique("movement_correction_targets_id_owner_unique").on(
      table.id,
      table.sourceId,
      table.principalId
    ),
    check(
      "movement_correction_targets_record_nonempty",
      sql`length(trim(${table.sourceRecordKey})) > 0`
    ),
    check(
      "movement_correction_targets_component_nonempty",
      sql`length(trim(${table.componentKey})) > 0`
    ),
  ]
)
