SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cdrs
    WHERE billing_number IS NULL OR billing_number !~ '^[1-9][0-9]{5,14}$'
  ) OR EXISTS (
    SELECT 1 FROM unassigned_cdrs
    WHERE (billing_number IS NOT NULL AND billing_number !~ '^[1-9][0-9]{5,14}$')
      OR (billing_number IS NULL) <>
        (reason = '号码格式错误' OR reason LIKE '话单校验失败: %')
  ) THEN
    RAISE EXCEPTION 'reset the dev database before 0004: legacy billing_number rows present';
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE cdrs ALTER COLUMN billing_number SET NOT NULL;
--> statement-breakpoint
ALTER TABLE cdrs DROP CONSTRAINT cdrs_billing_number_check;
--> statement-breakpoint
ALTER TABLE cdrs ADD CONSTRAINT cdrs_billing_number_check
  CHECK (billing_number ~ '^[1-9][0-9]{5,14}$') NOT VALID;
--> statement-breakpoint
ALTER TABLE unassigned_cdrs DROP CONSTRAINT unassigned_cdrs_billing_number_check;
--> statement-breakpoint
ALTER TABLE unassigned_cdrs ADD CONSTRAINT unassigned_cdrs_billing_number_check
  CHECK (billing_number ~ '^[1-9][0-9]{5,14}$') NOT VALID;
--> statement-breakpoint
-- Format and structural/time validation failures have no trusted billing number.
-- All other parked calls, including projection mismatches, retain the computed number.
ALTER TABLE unassigned_cdrs ADD CONSTRAINT unassigned_cdrs_billing_number_reason_check
  CHECK ((billing_number IS NULL) =
    (reason = '号码格式错误' OR reason LIKE '话单校验失败: %')) NOT VALID;
--> statement-breakpoint
ALTER TABLE cdrs VALIDATE CONSTRAINT cdrs_billing_number_check;
--> statement-breakpoint
ALTER TABLE unassigned_cdrs VALIDATE CONSTRAINT unassigned_cdrs_billing_number_check;
--> statement-breakpoint
ALTER TABLE unassigned_cdrs VALIDATE CONSTRAINT unassigned_cdrs_billing_number_reason_check;
