/**
 * Movement-specific correction history and exact source replay requests.
 *
 * @module PrincipalTransactionOverridesTables
 */
import type { MovementClassificationInput, MovementPriceInput } from "@my/core/accounting"
import { CURRENCIES_BY_CODE } from "@my/core/currency"
import { sql } from "drizzle-orm"
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { assets } from "./AssetsTable.ts"
import { movementCorrectionTargets } from "./MovementCorrectionTargetsTable.ts"
import { principals } from "./PrincipalsTable.ts"
import { processingJobs } from "./ProcessingJobsTable.ts"
import { sources } from "./SourcesTable.ts"
import { legKindEnum } from "./TransactionLegsTable.ts"
import { users } from "./UsersTable.ts"

const whitespace = sql`U&'!0009!000A!000B!000C!000D!0020!0085!00A0!1680!2000!2001!2002!2003!2004!2005!2006!2007!2008!2009!200A!2028!2029!202F!205F!3000!FEFF' UESCAPE '!'`
const reportingCurrencies = sql.join(
  Array.from(CURRENCIES_BY_CODE.keys()).map((currency) => sql`${currency}`),
  sql`, `
)

export const movementCorrectionKindEnum = pgEnum("movement_correction_kind", [
  "price",
  "classification",
])
export const movementCorrectionOperationEnum = pgEnum("movement_correction_operation", [
  "create",
  "replace",
  "withdraw",
])
export const movementCorrectionDirectionEnum = pgEnum("movement_correction_direction", [
  "inbound",
  "outbound",
])
export const movementCorrectionStructureEnum = pgEnum("movement_correction_structure", [
  "ownership_change",
  "fee",
  "custody",
])

/** Immutable facts and user input. Current target ownership must never rewrite these fields. */
export const principalTransactionOverrides = pgTable(
  "principal_transaction_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "restrict" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),
    targetId: uuid("target_id")
      .notNull()
      .references(() => movementCorrectionTargets.id, { onDelete: "restrict" }),
    kind: movementCorrectionKindEnum("kind").notNull(),
    operation: movementCorrectionOperationEnum("operation").notNull(),
    inspectedSystemRevision: text("inspected_system_revision").notNull(),
    inspectedSourceRecordKey: text("inspected_source_record_key").notNull(),
    inspectedComponentKey: text("inspected_component_key").notNull(),
    inspectedQuantity: text("inspected_quantity").notNull(),
    inspectedEconomicAssetId: uuid("inspected_economic_asset_id").references(() => assets.id, {
      onDelete: "restrict",
    }),
    inspectedDirection: movementCorrectionDirectionEnum("inspected_direction").notNull(),
    inspectedStructure: movementCorrectionStructureEnum("inspected_structure").notNull(),
    inspectedOccurredAt: timestamp("inspected_occurred_at").notNull(),
    inspectedLegKind: legKindEnum("inspected_leg_kind").notNull(),
    inspectedFiatAmount: text("inspected_fiat_amount"),
    inspectedFiatCurrency: text("inspected_fiat_currency"),
    inspectedTransactionType: text("inspected_transaction_type"),
    inspectedProviderTransactionType: text("inspected_provider_transaction_type"),
    inspectedDerivationRule: text("inspected_derivation_rule"),
    inspectedFeeForSourceRecordKey: text("inspected_fee_for_source_record_key"),
    priceInput: jsonb("price_input").$type<MovementPriceInput>(),
    classificationInput: jsonb("classification_input").$type<MovementClassificationInput>(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    supersedesOverrideId: uuid("supersedes_override_id"),
    recordedAt: timestamp("recorded_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "principal_transaction_overrides_required_text",
      sql`length(btrim(${table.reason}, ${whitespace})) > 0 and length(btrim(${table.inspectedSystemRevision}, ${whitespace})) > 0 and length(btrim(${table.inspectedSourceRecordKey}, ${whitespace})) > 0 and length(btrim(${table.inspectedComponentKey}, ${whitespace})) > 0`
    ),
    check(
      "principal_transaction_overrides_quantity",
      sql`${table.inspectedQuantity} ~ '^[0-9]+([.][0-9]+)?$' and ${table.inspectedQuantity} ~ '[1-9]'`
    ),
    check(
      "principal_transaction_overrides_structure",
      sql`(${table.inspectedLegKind} in ('acquisition', 'income') and ${table.inspectedDirection} = 'inbound' and ${table.inspectedStructure} in ('ownership_change', 'custody')) or (${table.inspectedLegKind} = 'disposal' and ${table.inspectedDirection} = 'outbound' and ${table.inspectedStructure} in ('ownership_change', 'custody')) or (${table.inspectedLegKind} = 'fee' and ${table.inspectedDirection} = 'outbound' and ${table.inspectedStructure} = 'fee')`
    ),
    check(
      "principal_transaction_overrides_input_shape",
      sql`coalesce((
    ${table.operation} = 'withdraw' and ${table.priceInput} is null and ${table.classificationInput} is null
  ) or (
    ${table.operation} in ('create', 'replace') and (
      (${table.kind} = 'price' and ${table.inspectedStructure} <> 'custody' and ${table.classificationInput} is null and jsonb_typeof(${table.priceInput}) = 'object'
        and ${table.priceInput} - ARRAY['_tag','amount','currency'] = '{}'::jsonb
        and ${table.priceInput}->>'_tag' in ('unit_price','total_value')
        and jsonb_typeof(${table.priceInput}->'amount') = 'string' and ${table.priceInput}->>'amount' ~ '^[0-9]+([.][0-9]+)?$'
        and ${table.priceInput}->>'currency' in (${reportingCurrencies}))
      or (${table.kind} = 'classification' and ${table.priceInput} is null and jsonb_typeof(${table.classificationInput}) = 'object'
        and ${table.classificationInput} - ARRAY['_tag','cause'] = '{}'::jsonb
        and ${table.classificationInput}->>'_tag' = ${table.inspectedDirection}::text
        and ${table.inspectedStructure} = 'ownership_change'
        and ((${table.classificationInput}->>'_tag' = 'inbound' and ${table.classificationInput}->>'cause' in ('purchase','gift','airdrop','mining_reward','staking_reward','passive_staking_reward','reward','payment','unknown'))
          or (${table.classificationInput}->>'_tag' = 'outbound' and ${table.classificationInput}->>'cause' in ('sale','gift','payment','unknown'))))
    )
  ), false)`
    ),
    check(
      "principal_transaction_overrides_supersession_shape",
      sql`${table.operation} = 'create' or ${table.supersedesOverrideId} is not null`
    ),
    check(
      "principal_transaction_overrides_no_self_supersession",
      sql`${table.supersedesOverrideId} is null or ${table.supersedesOverrideId} <> ${table.id}`
    ),
    unique("principal_transaction_overrides_stream_record_unique").on(
      table.principalId,
      table.sourceId,
      table.targetId,
      table.kind,
      table.id
    ),
    unique("principal_transaction_overrides_record_source_unique").on(table.id, table.sourceId),
    uniqueIndex("principal_transaction_overrides_root_unique")
      .on(table.principalId, table.targetId, table.kind)
      .where(sql`${table.supersedesOverrideId} is null`),
    uniqueIndex("principal_transaction_overrides_supersedes_unique")
      .on(table.supersedesOverrideId)
      .where(sql`${table.supersedesOverrideId} is not null`),
    foreignKey({
      columns: [
        table.principalId,
        table.sourceId,
        table.targetId,
        table.kind,
        table.supersedesOverrideId,
      ],
      foreignColumns: [table.principalId, table.sourceId, table.targetId, table.kind, table.id],
      name: "principal_transaction_overrides_supersedes_fk",
    }),
    index("idx_principal_transaction_overrides_target_stream").on(
      table.principalId,
      table.targetId,
      table.kind,
      table.recordedAt
    ),
  ]
)

/** Exact source work selected when a correction is accepted; job state remains in the existing scheduler. */
export const principalTransactionOverrideApplications = pgTable(
  "principal_transaction_override_applications",
  {
    overrideId: uuid("override_id").notNull(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),
    processingJobId: uuid("processing_job_id").references(() => processingJobs.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.overrideId, table.sourceId] }),
    foreignKey({
      columns: [table.overrideId, table.sourceId],
      foreignColumns: [principalTransactionOverrides.id, principalTransactionOverrides.sourceId],
      name: "principal_transaction_override_applications_source_fk",
    }).onDelete("restrict"),
    index("idx_principal_transaction_override_applications_job").on(table.processingJobId),
  ]
)
