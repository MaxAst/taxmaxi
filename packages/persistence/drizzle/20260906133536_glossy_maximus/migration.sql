CREATE TABLE "calculation_run_correction_inputs" (
	"run_id" uuid,
	"principal_id" uuid NOT NULL,
	"jurisdiction" text NOT NULL,
	"tax_year" integer NOT NULL,
	"reporting_currency" text NOT NULL,
	"source_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"override_id" uuid,
	"kind" "movement_correction_kind" NOT NULL,
	"captured" jsonb NOT NULL,
	CONSTRAINT "calculation_run_correction_inputs_pkey" PRIMARY KEY("run_id","override_id"),
	CONSTRAINT "calculation_correction_inputs_captured_identity" CHECK ((
    jsonb_typeof("captured") = 'object'
    and "captured"->'history'->>'id' = "override_id"::text
    and "captured"->'history'->>'principalId' = "principal_id"::text
    and "captured"->'history'->>'sourceId' = "source_id"::text
    and "captured"->'history'->>'targetId' = "target_id"::text
    and "captured"->'history'->>'kind' = "kind"::text
    and "captured"->>'reportingCurrency' = "reporting_currency"
    and "captured"->>'application' in ('inactive', 'not_applied', 'applied', 'needs_attention')
    and "captured"->>'streamState' in ('active', 'withdrawn', 'superseded')
    and "captured"->>'currentOutcome' in ('included', 'withheld', 'absent', 'outside_period')
    and jsonb_typeof("captured"->'system') = 'object'
    and jsonb_typeof("captured"->'effective') = 'object'
  ) is true)
);
--> statement-breakpoint
ALTER TABLE "calculation_run_correction_inputs" ADD CONSTRAINT "calculation_correction_inputs_run_scope_fk" FOREIGN KEY ("run_id","principal_id","jurisdiction","tax_year","reporting_currency") REFERENCES "calculation_runs"("id","principal_id","jurisdiction","tax_year","reporting_currency") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "calculation_run_correction_inputs" ADD CONSTRAINT "calculation_correction_inputs_history_fk" FOREIGN KEY ("principal_id","source_id","target_id","kind","override_id") REFERENCES "principal_transaction_overrides"("principal_id","source_id","target_id","kind","id") ON DELETE RESTRICT;
--> statement-breakpoint
-- Schema-only audit guards authorized by #150 issuecomment-5559120782.
-- Drizzle does not model PostgreSQL triggers. No stored data is changed here.
CREATE FUNCTION reject_calculation_correction_input_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Calculation correction inputs are immutable' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER calculation_correction_inputs_immutable
BEFORE UPDATE OR DELETE ON calculation_run_correction_inputs
FOR EACH ROW EXECUTE FUNCTION reject_calculation_correction_input_mutation();
--> statement-breakpoint
CREATE FUNCTION check_calculation_correction_input_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  run_status calculation_run_status;
BEGIN
  SELECT status INTO run_status FROM calculation_runs WHERE id = NEW.run_id FOR SHARE;
  IF run_status IS NULL OR run_status NOT IN ('pending', 'running') THEN
    RAISE EXCEPTION 'Correction inputs require an unfinished calculation run' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER calculation_correction_inputs_unfinished_run
BEFORE INSERT ON calculation_run_correction_inputs
FOR EACH ROW EXECUTE FUNCTION check_calculation_correction_input_run();
