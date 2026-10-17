ALTER POLICY tenant_read ON tenants USING (
  (SELECT app_is_operator())
  OR ((SELECT app_scope()) = 'tenant' AND id = (SELECT app_tenant_id()))
);
--> statement-breakpoint
ALTER POLICY tenant_read ON portal_accounts USING (
  (SELECT app_is_operator())
  OR ((SELECT app_scope()) = 'tenant' AND tenant_id = (SELECT app_tenant_id()))
);
--> statement-breakpoint
ALTER POLICY tenant_read ON rate_versions USING (
  (SELECT app_is_operator())
  OR ((SELECT app_scope()) = 'tenant' AND tenant_id = (SELECT app_tenant_id()))
);
--> statement-breakpoint
ALTER POLICY tenant_read ON rate_entries USING (
  (SELECT app_is_operator())
  OR ((SELECT app_scope()) = 'tenant' AND tenant_id = (SELECT app_tenant_id()))
);
--> statement-breakpoint
ALTER POLICY tenant_read ON ledger_entries USING (
  (SELECT app_is_operator())
  OR ((SELECT app_scope()) = 'tenant' AND tenant_id = (SELECT app_tenant_id()))
);
--> statement-breakpoint
ALTER POLICY tenant_read ON receivable_settlements USING (
  (SELECT app_is_operator())
  OR ((SELECT app_scope()) = 'tenant' AND tenant_id = (SELECT app_tenant_id()))
);
--> statement-breakpoint
ALTER POLICY tenant_read ON tenant_balances USING (
  (SELECT app_is_operator())
  OR ((SELECT app_scope()) = 'tenant' AND tenant_id = (SELECT app_tenant_id()))
);
--> statement-breakpoint
ALTER POLICY tenant_read ON cdrs USING (
  (SELECT app_is_operator())
  OR ((SELECT app_scope()) = 'tenant' AND tenant_id = (SELECT app_tenant_id()))
);
--> statement-breakpoint
ALTER POLICY tenant_read ON monthly_statements USING (
  (SELECT app_is_operator())
  OR ((SELECT app_scope()) = 'tenant' AND tenant_id = (SELECT app_tenant_id()))
);
--> statement-breakpoint
ALTER POLICY tenant_read ON balance_alert_settings USING (
  (SELECT app_is_operator())
  OR ((SELECT app_scope()) = 'tenant' AND tenant_id = (SELECT app_tenant_id()))
);
--> statement-breakpoint
ALTER POLICY tenant_read ON balance_alert_deliveries USING (
  (SELECT app_is_operator())
  OR ((SELECT app_scope()) = 'tenant' AND tenant_id = (SELECT app_tenant_id()))
);
--> statement-breakpoint
ALTER POLICY tenant_read ON receivable_settlement_reversals USING (
  (SELECT app_is_operator())
  OR ((SELECT app_scope()) = 'tenant' AND tenant_id = (SELECT app_tenant_id()))
);
--> statement-breakpoint
ALTER POLICY tenant_read ON receivable_voids USING (
  (SELECT app_is_operator())
  OR ((SELECT app_scope()) = 'tenant' AND tenant_id = (SELECT app_tenant_id()))
);
