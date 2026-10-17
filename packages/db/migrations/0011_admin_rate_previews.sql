CREATE TABLE admin_rate_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX admin_rate_previews_expiry ON admin_rate_previews (expires_at);
ALTER TABLE admin_rate_previews ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_previews ON admin_rate_previews
  FOR ALL USING (app_scope() = 'admin') WITH CHECK (app_scope() = 'admin');
GRANT SELECT, INSERT, UPDATE, DELETE ON admin_rate_previews TO fs_billing_app;
