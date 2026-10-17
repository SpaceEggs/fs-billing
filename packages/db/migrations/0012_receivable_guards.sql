CREATE FUNCTION receivable_voids_pending_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'fs_billing_app' AND NOT app_is_operator() THEN
    RAISE EXCEPTION 'receivable events require operator scope'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (
    SELECT FROM receivable_settlements s
    WHERE s.ledger_entry_id = NEW.ledger_entry_id
      AND NOT EXISTS (
        SELECT FROM receivable_settlement_reversals r WHERE r.settlement_id = s.id
      )
  ) THEN
    RAISE EXCEPTION 'credit must be pending before voiding'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'receivable_voids_pending';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION receivable_voids_pending_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION receivable_settlement_reversals_not_voided_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'fs_billing_app' AND NOT app_is_operator() THEN
    RAISE EXCEPTION 'receivable events require operator scope'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (
    SELECT FROM receivable_settlements s
    JOIN receivable_voids v ON v.ledger_entry_id = s.ledger_entry_id
    WHERE s.id = NEW.settlement_id
  ) THEN
    RAISE EXCEPTION 'voided credits cannot receive reversal events'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'receivable_settlement_reversals_not_voided';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION receivable_settlement_reversals_not_voided_guard() FROM PUBLIC;
--> statement-breakpoint
-- Existing require_tenant_lock triggers run before these state guards.
CREATE TRIGGER receivable_voids_state_guard BEFORE INSERT ON receivable_voids
  FOR EACH ROW EXECUTE FUNCTION receivable_voids_pending_guard();
CREATE TRIGGER receivable_settlement_reversals_state_guard BEFORE INSERT ON receivable_settlement_reversals
  FOR EACH ROW EXECUTE FUNCTION receivable_settlement_reversals_not_voided_guard();
