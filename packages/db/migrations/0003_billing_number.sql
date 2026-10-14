SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- Nullable for historical rows and old workers during rolling deployment.
ALTER TABLE cdrs ADD COLUMN billing_number text;
--> statement-breakpoint
ALTER TABLE unassigned_cdrs ADD COLUMN billing_number text;
--> statement-breakpoint
ALTER TABLE cdrs ADD CONSTRAINT cdrs_billing_number_check
  CHECK (billing_number IS NULL OR billing_number ~ '^[1-9][0-9]{0,14}$') NOT VALID;
--> statement-breakpoint
ALTER TABLE unassigned_cdrs ADD CONSTRAINT unassigned_cdrs_billing_number_check
  CHECK (billing_number IS NULL OR billing_number ~ '^[1-9][0-9]{0,14}$') NOT VALID;
--> statement-breakpoint
ALTER TABLE cdrs VALIDATE CONSTRAINT cdrs_billing_number_check;
--> statement-breakpoint
ALTER TABLE unassigned_cdrs VALIDATE CONSTRAINT unassigned_cdrs_billing_number_check;
