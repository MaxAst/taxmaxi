CREATE TABLE "movement_correction_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"principal_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"source_record_key" text NOT NULL,
	"component_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "movement_correction_targets_source_component_unique" UNIQUE("source_id","source_record_key","component_key"),
	CONSTRAINT "movement_correction_targets_id_owner_unique" UNIQUE("id","source_id","principal_id"),
	CONSTRAINT "movement_correction_targets_record_nonempty" CHECK (length(trim("source_record_key")) > 0),
	CONSTRAINT "movement_correction_targets_component_nonempty" CHECK (length(trim("component_key")) > 0)
);
--> statement-breakpoint
ALTER TABLE "transaction_legs" ADD COLUMN "movement_correction_target_id" uuid NOT NULL;--> statement-breakpoint
DROP INDEX "idx_transfers_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_transfers_unique" ON "transfers" ("tx_hash","address_id","type","from_address","to_address","asset_id","asset_representation_id") WHERE "external_id" is null and "tx_hash" is not null and "address_id" is not null and "from_address" is not null and "to_address" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_legs_movement_target_unique" ON "transaction_legs" ("movement_correction_target_id");--> statement-breakpoint
ALTER TABLE "movement_correction_targets" ADD CONSTRAINT "movement_correction_targets_source_owner_fk" FOREIGN KEY ("source_id","principal_id") REFERENCES "sources"("id","principal_id") ON DELETE RESTRICT ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "transaction_legs" ADD CONSTRAINT "transaction_legs_movement_target_owner_fk" FOREIGN KEY ("movement_correction_target_id","source_id","principal_id") REFERENCES "movement_correction_targets"("id","source_id","principal_id") ON UPDATE CASCADE;