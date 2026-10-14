DO $$
BEGIN
  IF EXISTS (
    SELECT lower(email) FROM (
      SELECT email FROM public.admins UNION ALL SELECT email FROM public.portal_accounts
    ) profiles GROUP BY lower(email) HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '0005 auth migration: normalized profile email conflict; resolve duplicate accounts before migration';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fs_billing_auth') THEN
    CREATE ROLE fs_billing_auth LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fs_billing_identity') THEN
    CREATE ROLE fs_billing_identity NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;
--> statement-breakpoint
CREATE SCHEMA auth;
REVOKE ALL ON SCHEMA auth FROM PUBLIC;
CREATE TABLE auth."user" (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE auth.session (
  id text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL,
  ip_address text,
  user_agent text,
  user_id text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE
);
CREATE INDEX session_user_id_idx ON auth.session(user_id);
CREATE TABLE auth.account (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL
);
CREATE INDEX account_user_id_idx ON auth.account(user_id);
CREATE TABLE auth.verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_identifier_idx ON auth.verification(identifier);
CREATE TABLE auth.login_failures (
  email_key text PRIMARY KEY,
  window_id uuid NOT NULL,
  failed_count integer NOT NULL CHECK (failed_count >= 0),
  last_failed_at timestamptz NOT NULL,
  locked_until timestamptz
);
REVOKE ALL ON ALL TABLES IN SCHEMA auth FROM PUBLIC;
GRANT USAGE ON SCHEMA auth TO fs_billing_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth."user", auth.session, auth.account,
  auth.verification, auth.login_failures TO fs_billing_auth;
--> statement-breakpoint
ALTER TABLE public.admins ADD COLUMN auth_user_id text;
ALTER TABLE public.portal_accounts ADD COLUMN auth_user_id text;
INSERT INTO auth."user"(id, name, email, created_at, updated_at)
SELECT 'migrated:admin:' || id::text, name, lower(email), created_at, created_at FROM public.admins
UNION ALL
SELECT 'migrated:portal:' || id::text, email, lower(email), created_at, created_at FROM public.portal_accounts;
UPDATE public.admins SET auth_user_id = 'migrated:admin:' || id::text;
UPDATE public.portal_accounts SET auth_user_id = 'migrated:portal:' || id::text;
ALTER TABLE public.admins
  ALTER COLUMN auth_user_id SET NOT NULL,
  ADD CONSTRAINT admins_auth_user_id_unique UNIQUE(auth_user_id),
  ADD CONSTRAINT admins_auth_user_id_fk FOREIGN KEY(auth_user_id) REFERENCES auth."user"(id) ON DELETE RESTRICT,
  DROP COLUMN email;
ALTER TABLE public.portal_accounts
  ALTER COLUMN auth_user_id SET NOT NULL,
  ADD CONSTRAINT portal_accounts_auth_user_id_unique UNIQUE(auth_user_id),
  ADD CONSTRAINT portal_accounts_auth_user_id_fk FOREIGN KEY(auth_user_id) REFERENCES auth."user"(id) ON DELETE RESTRICT,
  DROP COLUMN email;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO fs_billing_identity;
GRANT SELECT(id, auth_user_id, name, status) ON public.admins TO fs_billing_identity;
GRANT SELECT(id, tenant_id, auth_user_id, status) ON public.portal_accounts TO fs_billing_identity;
GRANT SELECT(id, code, name, currency, status) ON public.tenants TO fs_billing_identity;
CREATE FUNCTION public.resolve_auth_identity(auth_user_id text)
RETURNS TABLE(kind text, profile_id uuid, tenant_id uuid, profile_name text,
  profile_status text, tenant_code text, tenant_name text, tenant_currency text, tenant_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH matches AS (
    SELECT 'admin'::text AS kind, a.id AS profile_id, NULL::uuid AS tenant_id,
      a.name AS profile_name, a.status AS profile_status,
      NULL::text AS tenant_code, NULL::text AS tenant_name,
      NULL::text AS tenant_currency, NULL::text AS tenant_status
    FROM public.admins a WHERE a.auth_user_id = $1
    UNION ALL
    SELECT 'customer'::text, p.id, p.tenant_id, NULL::text, p.status,
      t.code, t.name, t.currency, t.status
    FROM public.portal_accounts p JOIN public.tenants t ON t.id = p.tenant_id
    WHERE p.auth_user_id = $1
  ), cardinality AS (SELECT count(*) AS n FROM matches)
  SELECT m.* FROM matches m CROSS JOIN cardinality c WHERE c.n = 1
  UNION ALL
  SELECT CASE WHEN n = 0 THEN 'none' ELSE 'ambiguous' END,
    NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text
  FROM cardinality WHERE n <> 1;
$$;
ALTER FUNCTION public.resolve_auth_identity(text) OWNER TO fs_billing_identity;
REVOKE ALL ON FUNCTION public.resolve_auth_identity(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_auth_identity(text) TO fs_billing_app;
