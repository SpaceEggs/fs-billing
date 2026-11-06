SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- 账号语言（docs/i18n-design.md §6.1）：NULL 表示还没选过，按浏览器语言；只允许 zh 或 en。
-- 可空且不设默认值，升级时无需回填，登录后由 API 按会话身份的 profileId 写入。
ALTER TABLE portal_accounts ADD COLUMN IF NOT EXISTS locale text
  CHECK (locale IN ('zh', 'en'));
--> statement-breakpoint
ALTER TABLE admins ADD COLUMN IF NOT EXISTS locale text
  CHECK (locale IN ('zh', 'en'));
--> statement-breakpoint
-- 身份解析函数带回账号语言；返回列集合变了，CREATE OR REPLACE 不能改返回类型，先删后建。
DROP FUNCTION IF EXISTS public.resolve_auth_identity(text);
--> statement-breakpoint
-- SECURITY DEFINER 函数以 fs_billing_identity 执行，列级授权必须包含新列。
GRANT SELECT(locale) ON public.admins TO fs_billing_identity;
--> statement-breakpoint
GRANT SELECT(locale) ON public.portal_accounts TO fs_billing_identity;
--> statement-breakpoint
CREATE FUNCTION public.resolve_auth_identity(auth_user_id text)
RETURNS TABLE(kind text, profile_id uuid, tenant_id uuid, profile_name text,
  profile_status text, tenant_code text, tenant_name text, tenant_currency text,
  tenant_status text, profile_locale text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH matches AS (
    SELECT 'admin'::text AS kind, a.id AS profile_id, NULL::uuid AS tenant_id,
      a.name AS profile_name, a.status AS profile_status,
      NULL::text AS tenant_code, NULL::text AS tenant_name,
      NULL::text AS tenant_currency, NULL::text AS tenant_status,
      a.locale AS profile_locale
    FROM public.admins a WHERE a.auth_user_id = $1
    UNION ALL
    SELECT 'customer'::text, p.id, p.tenant_id, NULL::text, p.status,
      t.code, t.name, t.currency, t.status, p.locale
    FROM public.portal_accounts p JOIN public.tenants t ON t.id = p.tenant_id
    WHERE p.auth_user_id = $1
  ), cardinality AS (SELECT count(*) AS n FROM matches)
  SELECT m.* FROM matches m CROSS JOIN cardinality c WHERE c.n = 1
  UNION ALL
  SELECT CASE WHEN n = 0 THEN 'none' ELSE 'ambiguous' END,
    NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text,
    NULL::text, NULL::text, NULL::text
  FROM cardinality WHERE n <> 1;
$$;
--> statement-breakpoint
ALTER FUNCTION public.resolve_auth_identity(text) OWNER TO fs_billing_identity;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.resolve_auth_identity(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.resolve_auth_identity(text) TO fs_billing_app;
