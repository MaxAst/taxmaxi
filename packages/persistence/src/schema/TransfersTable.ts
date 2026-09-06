import { sql } from "drizzle-orm"
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
import { addresses } from "./AddressesTable.ts"
import { assetRepresentations } from "./AssetRepresentationsTable.ts"
import { assets } from "./AssetsTable.ts"
import { blockchains } from "./BlockchainsTable.ts"
import { principals } from "./PrincipalsTable.ts"
import { providerAssets } from "./ProviderAssetsTable.ts"
import { sourceRecordsRaw } from "./SourceRecordsRawTable.ts"
import { sourceRepresentationUses } from "./SourceRepresentationUsesTable.ts"
import { sources } from "./SourcesTable.ts"

export const transferTypeEnum = pgEnum("transfer_type", [
  "erc20",
  "erc721",
  "erc1155",
  "internal",
  "native",
  "spl",
  "utxo",
  "cex",
  "dex",
  "fiat",
  "funding",
  "reward",
  "fee",
])

export type TransferType = (typeof transferTypeEnum.enumValues)[number]

/**
 * Provider-neutral movement records.
 *
 * Transfers model directional movement between parties and are used for
 * reconciliation, explainability, and leg derivation.
 */
export const transfers = pgTable(
  "transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    sourceId: uuid("source_id") // Owning source for ingestion lineage.
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    sourceRawRecordId: uuid("source_raw_record_id").references(() => sourceRecordsRaw.id, {
      // Raw provider record this movement was normalized from.
      onDelete: "set null",
    }),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    externalId: text("external_id"), // Provider movement id.
    externalGroupId: text("external_group_id"), // Groups related rows (order, tx, batch).

    addressId: uuid("address_id").references(() => addresses.id, { onDelete: "cascade" }),
    blockchainId: uuid("blockchain_id").references(() => blockchains.id),

    txHash: text("tx_hash"), // Onchain hash/signature/txid when available.

    timestamp: timestamp("timestamp").notNull(),
    type: transferTypeEnum("type").notNull(),

    // Transfer-specific from/to party references. For onchain these are addresses.
    fromAddress: text("from_address"),
    toAddress: text("to_address"),
    fromAccountRef: text("from_account_ref"), // Non-address sender reference (account/subaccount/user id).
    toAccountRef: text("to_account_ref"), // Non-address receiver reference.
    fromPartyType: text("from_party_type"), // Provider party resource type (account, user, address, email).
    fromPartyResourcePath: text("from_party_resource_path"), // Provider API path for from-party.
    toPartyType: text("to_party_type"), // Provider party resource type for destination.
    toPartyResourcePath: text("to_party_resource_path"), // Provider API path for to-party.

    // Asset and Amount
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id),
    assetRepresentationId: uuid("asset_representation_id"),
    sourceRepresentationUseId: uuid("source_representation_use_id"),
    providerAssetRowId: uuid("provider_asset_row_id").references(() => providerAssets.id, {
      onDelete: "set null",
    }),
    amount: numeric("amount", { precision: 355, scale: 255 }).notNull(), // Provider-native decimal amount.
    tokenId: text("token_id"), // Optional NFT/inscription-like identifier.

    notes: text("notes"), // Could be useful for user overrides
    metadata: jsonb("metadata"), // Additional provider fields retained for debugging/replay.

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "transfers_identifier_present",
      sql`${table.txHash} is not null or ${table.externalId} is not null`
    ),
    check(
      "transfers_from_party_present",
      sql`${table.fromAddress} is not null or ${table.fromAccountRef} is not null`
    ),
    check(
      "transfers_to_party_present",
      sql`${table.toAddress} is not null or ${table.toAccountRef} is not null`
    ),
    check(
      "transfers_tx_hash_requires_onchain_context",
      sql`${table.txHash} is null or (${table.blockchainId} is not null and ${table.addressId} is not null and ${table.fromAddress} is not null and ${table.toAddress} is not null)`
    ),
    foreignKey({
      columns: [table.assetRepresentationId],
      foreignColumns: [assetRepresentations.id],
      name: "transfers_asset_representation_fk",
    }),
    foreignKey({
      columns: [table.sourceRepresentationUseId, table.sourceId],
      foreignColumns: [sourceRepresentationUses.id, sourceRepresentationUses.sourceId],
      name: "transfers_representation_use_source_fk",
    }),
    uniqueIndex("idx_transfers_source_external_unique")
      .on(table.sourceId, table.externalId)
      .where(sql`${table.externalId} is not null`),

    // Transfers without an explicit external identity retain the existing shape guard.
    // Identified producer components use source/external uniqueness, including equal siblings.
    uniqueIndex("idx_transfers_unique")
      .on(
        table.txHash,
        table.addressId,
        table.type,
        table.fromAddress,
        table.toAddress,
        table.assetId,
        table.assetRepresentationId
      )
      .where(
        sql`${table.externalId} is null and ${table.txHash} is not null and ${table.addressId} is not null and ${table.fromAddress} is not null and ${table.toAddress} is not null`
      ),

    index("idx_transfers_source_timestamp").on(table.sourceId, table.timestamp),
    index("idx_transfers_principal_timestamp").on(table.principalId, table.timestamp),
    index("idx_transfers_external_group").on(table.sourceId, table.externalGroupId),
    index("idx_transfers_source_type").on(table.sourceId, table.type),
    index("idx_transfers_blockchain_tx_hash").on(table.blockchainId, table.txHash),
    index("idx_transfers_representation_use").on(table.sourceRepresentationUseId),
    index("idx_transfers_provider_asset_row").on(table.providerAssetRowId),
  ]
)

export type Transfer = typeof transfers.$inferSelect
export type TransferInsert = typeof transfers.$inferInsert
