SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE cdrs ALTER COLUMN billing_number SET NOT NULL;
--> statement-breakpoint
ALTER TABLE cdrs DROP CONSTRAINT cdrs_billing_number_check;
--> statement-breakpoint
ALTER TABLE cdrs ADD CONSTRAINT cdrs_billing_number_check
  CHECK (billing_number ~ '^[1-9][0-9]{5,14}$');
--> statement-breakpoint
ALTER TABLE unassigned_cdrs DROP CONSTRAINT unassigned_cdrs_billing_number_check;
--> statement-breakpoint
ALTER TABLE unassigned_cdrs ADD CONSTRAINT unassigned_cdrs_billing_number_check
  CHECK (billing_number ~ '^[1-9][0-9]{5,14}$');
--> statement-breakpoint
-- Format and structural/time validation failures have no trusted billing number.
-- All other parked calls, including projection mismatches, retain the computed number.
ALTER TABLE unassigned_cdrs ADD CONSTRAINT unassigned_cdrs_billing_number_reason_check
  CHECK ((billing_number IS NULL) =
    (reason = '号码格式错误' OR reason LIKE '话单校验失败: %'));
