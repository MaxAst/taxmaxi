CREATE TYPE "movement_correction_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "movement_correction_kind" AS ENUM('price', 'classification');--> statement-breakpoint
CREATE TYPE "movement_correction_operation" AS ENUM('create', 'replace', 'withdraw');--> statement-breakpoint
CREATE TYPE "movement_correction_structure" AS ENUM('ownership_change', 'fee', 'custody');--> statement-breakpoint
CREATE TABLE "principal_transaction_override_applications" (
	"override_id" uuid,
	"source_id" uuid,
	"processing_job_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "principal_transaction_override_applications_pkey" PRIMARY KEY("override_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "principal_transaction_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"principal_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"kind" "movement_correction_kind" NOT NULL,
	"operation" "movement_correction_operation" NOT NULL,
	"inspected_system_revision" text NOT NULL,
	"inspected_source_record_key" text NOT NULL,
	"inspected_component_key" text NOT NULL,
	"inspected_quantity" text NOT NULL,
	"inspected_economic_asset_id" uuid,
	"inspected_direction" "movement_correction_direction" NOT NULL,
	"inspected_structure" "movement_correction_structure" NOT NULL,
	"inspected_occurred_at" timestamp NOT NULL,
	"inspected_leg_kind" "leg_kind" NOT NULL,
	"inspected_fiat_amount" text,
	"inspected_fiat_currency" text,
	"inspected_transaction_type" text,
	"inspected_provider_transaction_type" text,
	"inspected_derivation_rule" text,
	"inspected_fee_for_source_record_key" text,
	"price_input" jsonb,
	"classification_input" jsonb,
	"actor_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"supersedes_override_id" uuid,
	"recorded_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "principal_transaction_overrides_stream_record_unique" UNIQUE("principal_id","source_id","target_id","kind","id"),
	CONSTRAINT "principal_transaction_overrides_record_source_unique" UNIQUE("id","source_id"),
	CONSTRAINT "principal_transaction_overrides_required_text" CHECK (length(btrim("reason", U&'!0009!000A!000B!000C!000D!0020!0085!00A0!1680!2000!2001!2002!2003!2004!2005!2006!2007!2008!2009!200A!2028!2029!202F!205F!3000!FEFF' UESCAPE '!')) > 0 and length(btrim("inspected_system_revision", U&'!0009!000A!000B!000C!000D!0020!0085!00A0!1680!2000!2001!2002!2003!2004!2005!2006!2007!2008!2009!200A!2028!2029!202F!205F!3000!FEFF' UESCAPE '!')) > 0 and length(btrim("inspected_source_record_key", U&'!0009!000A!000B!000C!000D!0020!0085!00A0!1680!2000!2001!2002!2003!2004!2005!2006!2007!2008!2009!200A!2028!2029!202F!205F!3000!FEFF' UESCAPE '!')) > 0 and length(btrim("inspected_component_key", U&'!0009!000A!000B!000C!000D!0020!0085!00A0!1680!2000!2001!2002!2003!2004!2005!2006!2007!2008!2009!200A!2028!2029!202F!205F!3000!FEFF' UESCAPE '!')) > 0),
	CONSTRAINT "principal_transaction_overrides_quantity" CHECK ("inspected_quantity" ~ '^[0-9]+([.][0-9]+)?$' and "inspected_quantity" ~ '[1-9]'),
	CONSTRAINT "principal_transaction_overrides_structure" CHECK (("inspected_leg_kind" in ('acquisition', 'income') and "inspected_direction" = 'inbound' and "inspected_structure" in ('ownership_change', 'custody')) or ("inspected_leg_kind" = 'disposal' and "inspected_direction" = 'outbound' and "inspected_structure" in ('ownership_change', 'custody')) or ("inspected_leg_kind" = 'fee' and "inspected_direction" = 'outbound' and "inspected_structure" = 'fee')),
	CONSTRAINT "principal_transaction_overrides_input_shape" CHECK (coalesce((
    "operation" = 'withdraw' and "price_input" is null and "classification_input" is null
  ) or (
    "operation" in ('create', 'replace') and (
      ("kind" = 'price' and "inspected_structure" <> 'custody' and "classification_input" is null and jsonb_typeof("price_input") = 'object'
        and "price_input" - ARRAY['_tag','amount','currency'] = '{}'::jsonb
        and "price_input"->>'_tag' in ('unit_price','total_value')
        and jsonb_typeof("price_input"->'amount') = 'string' and "price_input"->>'amount' ~ '^[0-9]+([.][0-9]+)?$'
        and "price_input"->>'currency' in ('USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'CNY', 'HKD', 'SGD', 'KRW', 'KWD', 'BHD', 'OMR', 'CLF'))
      or ("kind" = 'classification' and "price_input" is null and jsonb_typeof("classification_input") = 'object'
        and "classification_input" - ARRAY['_tag','cause'] = '{}'::jsonb
        and "classification_input"->>'_tag' = "inspected_direction"::text
        and "inspected_structure" = 'ownership_change'
        and (("classification_input"->>'_tag' = 'inbound' and "classification_input"->>'cause' in ('purchase','gift','airdrop','mining_reward','staking_reward','passive_staking_reward','reward','payment','unknown'))
          or ("classification_input"->>'_tag' = 'outbound' and "classification_input"->>'cause' in ('sale','gift','payment','unknown'))))
    )
  ), false)),
	CONSTRAINT "principal_transaction_overrides_supersession_shape" CHECK ("operation" = 'create' or "supersedes_override_id" is not null),
	CONSTRAINT "principal_transaction_overrides_no_self_supersession" CHECK ("supersedes_override_id" is null or "supersedes_override_id" <> "id")
);
--> statement-breakpoint
CREATE INDEX "idx_principal_transaction_override_applications_job" ON "principal_transaction_override_applications" ("processing_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "principal_transaction_overrides_root_unique" ON "principal_transaction_overrides" ("principal_id","target_id","kind") WHERE "supersedes_override_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "principal_transaction_overrides_supersedes_unique" ON "principal_transaction_overrides" ("supersedes_override_id") WHERE "supersedes_override_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_principal_transaction_overrides_target_stream" ON "principal_transaction_overrides" ("principal_id","target_id","kind","recorded_at");--> statement-breakpoint
ALTER TABLE "principal_transaction_override_applications" ADD CONSTRAINT "principal_transaction_override_applications_WFBIaoHPkJ2F_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "principal_transaction_override_applications" ADD CONSTRAINT "principal_transaction_override_applications_GjSFoV6QO5ff_fkey" FOREIGN KEY ("processing_job_id") REFERENCES "processing_jobs"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "principal_transaction_override_applications" ADD CONSTRAINT "principal_transaction_override_applications_source_fk" FOREIGN KEY ("override_id","source_id") REFERENCES "principal_transaction_overrides"("id","source_id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "principal_transaction_overrides" ADD CONSTRAINT "principal_transaction_overrides_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "principal_transaction_overrides" ADD CONSTRAINT "principal_transaction_overrides_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "principal_transaction_overrides" ADD CONSTRAINT "principal_transaction_overrides_ilkgU35QNHW7_fkey" FOREIGN KEY ("target_id") REFERENCES "movement_correction_targets"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "principal_transaction_overrides" ADD CONSTRAINT "principal_transaction_overrides_1Y8TgoGi8STw_fkey" FOREIGN KEY ("inspected_economic_asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "principal_transaction_overrides" ADD CONSTRAINT "principal_transaction_overrides_actor_user_id_users_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "principal_transaction_overrides" ADD CONSTRAINT "principal_transaction_overrides_supersedes_fk" FOREIGN KEY ("principal_id","source_id","target_id","kind","supersedes_override_id") REFERENCES "principal_transaction_overrides"("principal_id","source_id","target_id","kind","id");