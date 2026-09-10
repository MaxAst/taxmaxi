-- Guard immutable movement captures and preserve atomic anonymous claims.
CREATE FUNCTION reject_calculation_movement_input_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM calculation_runs WHERE id = OLD.run_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Calculation movement inputs are immutable' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER calculation_movement_inputs_immutable
BEFORE UPDATE OR DELETE ON calculation_run_movement_inputs
FOR EACH ROW EXECUTE FUNCTION reject_calculation_movement_input_mutation();
--> statement-breakpoint
CREATE FUNCTION check_calculation_movement_input_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  run_status calculation_run_status;
BEGIN
  SELECT status INTO run_status FROM calculation_runs WHERE id = NEW.run_id FOR SHARE;
  IF run_status IS NULL OR run_status NOT IN ('pending', 'running') THEN
    RAISE EXCEPTION 'Movement inputs require an unfinished calculation run' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER calculation_movement_inputs_unfinished_run
BEFORE INSERT ON calculation_run_movement_inputs
FOR EACH ROW EXECUTE FUNCTION check_calculation_movement_input_run();

--> statement-breakpoint
-- Claims transfer the exact source/target owner before discarding the old run.
-- Check ownership at commit, after the same transaction has deleted old captures.
ALTER TABLE calculation_run_movement_inputs
ALTER CONSTRAINT calculation_movement_inputs_target_owner_fk DEFERRABLE INITIALLY DEFERRED;
