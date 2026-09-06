import {
  check,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { addresses } from "./AddressesTable.ts"
import { assetRepresentations } from "./AssetRepresentationsTable.ts"
import { assets } from "./AssetsTable.ts"
import { movementCorrectionTargets } from "./MovementCorrectionTargetsTable.ts"
import { principals } from "./PrincipalsTable.ts"
import { providerAssets } from "./ProviderAssetsTable.ts"
import { providerTransfers } from "./ProviderTransfersTable.ts"
import { sourceRecordsRaw } from "./SourceRecordsRawTable.ts"
import { sourceRepresentationUses } from "./SourceRepresentationUsesTable.ts"
import { sources } from "./SourcesTable.ts"
import { transactions } from "./TransactionsTable.ts"
import { transfers } from "./TransfersTable.ts"

/**
 * Leg kind enum - the factual direction of each accounting leg
 * - acquisition: receiving an asset
 * - disposal: sending an asset
 * - income: receiving an asset as income (e.g., staking rewards, airdrops)
 * - fee: gas fees or other transaction costs
 */
export const legKindEnum = pgEnum("leg_kind", ["acquisition", "disposal", "income", "fee"])

export type LegKind = (typeof legKindEnum.enumValues)[number]

/**
 * Provenance enum - how the leg was derived
 * - deterministic: derived from known transfer patterns (most reliable)
 * - rule: derived from function signature or protocol mappings
 * - ai: derived from LLM categorization (requires review)
 * - manual: manually set by user
 */
export const legProvenanceEnum = pgEnum("leg_provenance", ["deterministic", "rule", "ai", "manual"])

export type LegProvenance = (typeof legProvenanceEnum.enumValues)[number]

/** Records which factual transfer, if any, directly produced a transaction leg. */
export const transactionLegOriginKindEnum = pgEnum("transaction_leg_origin_kind", [
  "provider_transfer",
  "canonical_transfer",
  "none",
])

export type TransactionLegOriginKind = (typeof transactionLegOriginKindEnum.enumValues)[number]

/**
 * Transaction legs table - factual accounting legs derived from raw transfers/events
 *
 * This table is part of the factual ledger used by calculation runs. Each transfer
 * may produce multiple legs (e.g., a swap produces a disposal leg and an acquisition leg,
 * plus potentially a fee leg for gas).
 *
 * Key invariants:
 * - Fee legs are always explicit (never conflated with payments)
 * - Direction and cause stay factual; the engine decides tax treatment
 * - Derived lots, allocations, and money belong to immutable calculation runs
 */
export const transactionLegs = pgTable(
  "transaction_legs",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Exact durable movement target selected by the producer and retained across replay. */
    movementCorrectionTargetId: uuid("movement_correction_target_id").notNull(),

    sourceId: uuid("source_id") // Owning custody source for factual-ledger replay.
      .notNull()
      .references(() => sources.id, {
        onDelete: "cascade",
      }),
    sourceRawRecordId: uuid("source_raw_record_id").references(() => sourceRecordsRaw.id, {
      // Raw record link used to trace normalization decisions back to provider payload.
      onDelete: "set null",
    }),
    externalId: text("external_id"), // Provider leg/event id for idempotent replay.

    // Transaction context
    txHash: text("tx_hash"), // Optional onchain tx reference for explorer/debug links.
    timestamp: timestamp("timestamp").notNull(),

    // User/address scope
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    addressId: uuid("address_id").references(() => addresses.id, { onDelete: "cascade" }),

    // Asset and amount
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id),
    assetRepresentationId: uuid("asset_representation_id"),
    sourceRepresentationUseId: uuid("source_representation_use_id"),
    providerAssetRowId: uuid("provider_asset_row_id").references(() => providerAssets.id, {
      onDelete: "set null",
    }),
    amount: numeric("amount", { precision: 355, scale: 255 }).notNull(), // Exact asset quantity in canonical asset units.

    // Accounting classification
    kind: legKindEnum("kind").notNull(),

    // How this leg was derived
    provenance: legProvenanceEnum("provenance").notNull(),

    // Derivation metadata - which rule/pattern/layer produced this leg
    derivationRule: text("derivation_rule"),
    metadata: jsonb("metadata"), // Rule/debug payload for review and replay traceability.

    // Link to parent transaction
    transactionId: uuid("transaction_id").references(() => transactions.id, {
      onDelete: "cascade",
    }),

    // Exact transfer origin selected by the leg writer. Originless legs say so explicitly.
    originKind: transactionLegOriginKindEnum("origin_kind").notNull(),
    providerTransferId: uuid("provider_transfer_id").references(() => providerTransfers.id, {
      onDelete: "cascade",
    }),
    sourceTransferId: uuid("source_transfer_id").references(() => transfers.id, {
      onDelete: "cascade",
    }),

    // Fiat valuation at time of leg (calculated from price at timestamp)
    fiatAmount: numeric("fiat_amount", { precision: 36, scale: 8 }),
    fiatCurrency: text("fiat_currency"),

    // For fee legs: link to the transaction that incurred this fee
    feeForTransactionId: uuid("fee_for_transaction_id").references(() => transactions.id, {
      onDelete: "cascade",
    }),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.movementCorrectionTargetId, table.sourceId, table.principalId],
      foreignColumns: [
        movementCorrectionTargets.id,
        movementCorrectionTargets.sourceId,
        movementCorrectionTargets.principalId,
      ],
      name: "transaction_legs_movement_target_owner_fk",
    }).onUpdate("cascade"),
    uniqueIndex("transaction_legs_movement_target_unique").on(table.movementCorrectionTargetId),
    foreignKey({
      columns: [table.assetRepresentationId],
      foreignColumns: [assetRepresentations.id],
      name: "transaction_legs_asset_representation_fk",
    }),
    foreignKey({
      columns: [table.sourceRepresentationUseId, table.sourceId],
      foreignColumns: [sourceRepresentationUses.id, sourceRepresentationUses.sourceId],
      name: "transaction_legs_representation_use_source_fk",
    }),
    check(
      "transaction_legs_identifier_present",
      sql`${table.txHash} is not null or ${table.externalId} is not null`
    ),
    check(
      "transaction_legs_tx_hash_requires_address",
      sql`${table.txHash} is null or ${table.addressId} is not null`
    ),
    check(
      "transaction_legs_origin_matches_kind",
      sql`(${table.originKind} = 'provider_transfer' and ${table.providerTransferId} is not null and ${table.sourceTransferId} is null)
        or (${table.originKind} = 'canonical_transfer' and ${table.providerTransferId} is null and ${table.sourceTransferId} is not null)
        or (${table.originKind} = 'none' and ${table.providerTransferId} is null and ${table.sourceTransferId} is null)`
    ),
    uniqueIndex("idx_transaction_legs_source_external_unique")
      .on(table.sourceId, table.externalId)
      .where(sql`${table.externalId} is not null`),

    // Prevent duplicate legs from same transfer with same kind
    // A transfer can produce multiple legs of different kinds (e.g., swap: acquisition + disposal)
    uniqueIndex("idx_transaction_legs_unique")
      .on(table.txHash, table.addressId, table.assetId, table.kind, table.sourceTransferId)
      .where(sql`${table.txHash} is not null and ${table.addressId} is not null`),

    // Ensure a transaction has at most one canonical gas fee leg per asset+address.
    uniqueIndex("idx_transaction_legs_gas_fee_unique")
      .on(table.txHash, table.addressId, table.assetId)
      .where(
        sql`${table.txHash} is not null AND ${table.addressId} is not null AND ${table.kind} = 'fee' AND ${table.derivationRule} IN ('gas_fee', 'failed_tx_gas_fee')`
      ),

    // Query legs by source (provider import and factual-ledger replay)
    index("idx_transaction_legs_source").on(table.sourceId),

    // Query legs by transaction
    index("idx_transaction_legs_transaction").on(table.transactionId),

    index("idx_transaction_legs_provider_transfer").on(table.providerTransferId),

    // Query legs by address (for portfolio views)
    index("idx_transaction_legs_address").on(table.addressId),

    // Query legs by principal (for tax reports)
    index("idx_transaction_legs_principal").on(table.principalId),

    // Query legs by asset (for factual-ledger calculation input)
    index("idx_transaction_legs_asset").on(table.assetId),

    index("idx_transaction_legs_representation_use").on(table.sourceRepresentationUseId),

    index("idx_transaction_legs_provider_asset_row").on(table.providerAssetRowId),

    // Query legs by kind for factual-ledger calculation input
    index("idx_transaction_legs_kind").on(table.kind),

    // Timestamp ordering for chronological processing
    index("idx_transaction_legs_timestamp").on(table.timestamp),
  ]
)

export type TransactionLeg = typeof transactionLegs.$inferSelect
export type TransactionLegInsert = typeof transactionLegs.$inferInsert
