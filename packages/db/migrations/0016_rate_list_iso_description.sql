SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE rate_entries
  ADD COLUMN iso text NOT NULL DEFAULT '',
  ADD COLUMN description text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE rate_entries ADD CONSTRAINT rate_entries_iso_check
  CHECK (iso = '' OR iso ~ '^[A-Z]{2}$');
--> statement-breakpoint
ALTER TABLE cdrs ADD COLUMN iso text, ADD COLUMN description text;
--> statement-breakpoint
ALTER TABLE cdrs ADD CONSTRAINT cdrs_iso_check
  CHECK (iso IS NULL OR iso ~ '^[A-Z]{2}$') NOT VALID;
--> statement-breakpoint
ALTER TABLE cdrs VALIDATE CONSTRAINT cdrs_iso_check;
