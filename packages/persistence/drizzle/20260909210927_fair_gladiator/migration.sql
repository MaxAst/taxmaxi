CREATE TABLE "calculation_run_movement_inputs" (
	"run_id" uuid,
	"principal_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"target_id" uuid,
	"transaction_id" uuid,
	"event_id" uuid,
	"captured" jsonb NOT NULL,
	"valuation" jsonb NOT NULL,
	CONSTRAINT "calculation_run_movement_inputs_pkey" PRIMARY KEY("run_id","target_id"),
	CONSTRAINT "calculation_movement_inputs_capture_links" CHECK ((
      jsonb_typeof("captured") = 'object'
      and "captured"->>'targetId' = "target_id"::text
      and "captured"->>'currentOutcome' in ('included', 'withheld', 'absent', 'outside_period')
      and jsonb_typeof("captured"->'system') = 'object'
      and jsonb_typeof("captured"->'effective') = 'object'
      and ("captured"->'effective'->'event'->>'id') is not distinct from "event_id"::text
      and ("captured"->'current'->>'transactionId') is not distinct from "transaction_id"::text
      and ("captured"->'current' = 'null'::jsonb or (
        "captured"->'current'->>'targetId' = "target_id"::text
        and "captured"->'current'->>'sourceId' = "source_id"::text
      ))
    ) is true),
	CONSTRAINT "calculation_movement_inputs_valuation" CHECK ((
      jsonb_typeof("valuation") = 'object'
      and "valuation"->>'_tag' in ('not_evaluated', 'missing', 'ambiguous', 'selected')
      and ("valuation"->>'_tag' <> 'selected' or (
        "event_id" is not null
        and "valuation"->>'kind' in ('user_valuation', 'observed_consideration', 'market_quote')
        and jsonb_typeof("valuation"->'total'->'amount') = 'string'
        and jsonb_typeof("valuation"->'total'->'currency') = 'string'
      ))
    ) is true)
);
--> statement-breakpoint
CREATE INDEX "idx_calculation_movement_inputs_transaction" ON "calculation_run_movement_inputs" ("run_id","transaction_id");--> statement-breakpoint
CREATE INDEX "idx_calculation_movement_inputs_event" ON "calculation_run_movement_inputs" ("run_id","event_id");--> statement-breakpoint
ALTER TABLE "calculation_run_movement_inputs" ADD CONSTRAINT "calculation_movement_inputs_run_owner_fk" FOREIGN KEY ("run_id","principal_id") REFERENCES "calculation_runs"("id","principal_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "calculation_run_movement_inputs" ADD CONSTRAINT "calculation_movement_inputs_target_owner_fk" FOREIGN KEY ("target_id","source_id","principal_id") REFERENCES "movement_correction_targets"("id","source_id","principal_id") ON DELETE RESTRICT;