-- Nullable for historical rows and old workers during rolling deployment.
ALTER TABLE cdrs ADD COLUMN billing_number text
  CHECK (billing_number IS NULL OR billing_number ~ '^[1-9][0-9]{0,14}$');
--> statement-breakpoint
ALTER TABLE unassigned_cdrs ADD COLUMN billing_number text
  CHECK (billing_number IS NULL OR billing_number ~ '^[1-9][0-9]{0,14}$');
