-- 运维人工审计的组角色：不授予任何表权限，只能执行下面的保存查询。
-- 运维个人登录角色以 IN ROLE fs_billing_audit 加入，所以不设 NOINHERIT。
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fs_billing_audit') THEN
    CREATE ROLE fs_billing_audit NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO fs_billing_audit;

-- 参数为 NULL 表示不过滤；时间窗为 [p_from, p_to)。STABLE 的 sql 函数不能写入。
-- 属主即表属主，因此绕过 operation_logs/admins/tenants 的 RLS；邮箱自 0005 起在 auth."user"。
CREATE FUNCTION audit_operation_logs(
  p_tenant_code text DEFAULT NULL,
  p_action text DEFAULT NULL,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL
)
RETURNS TABLE(id uuid, created_at timestamptz, admin_id uuid, admin_email text,
  admin_name text, tenant_code text, action text, target text, details jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT l.id, l.created_at, l.admin_id, u.email, a.name, t.code, l.action, l.target, l.details
  FROM public.operation_logs l
  JOIN public.admins a ON a.id = l.admin_id
  JOIN auth."user" u ON u.id = a.auth_user_id
  LEFT JOIN public.tenants t ON t.id = l.tenant_id
  WHERE (p_tenant_code IS NULL OR upper(t.code) = upper(p_tenant_code))
    AND (p_action IS NULL OR l.action = p_action)
    AND (p_from IS NULL OR l.created_at >= p_from)
    AND (p_to IS NULL OR l.created_at < p_to)
  ORDER BY l.created_at DESC, l.id;
$$;
REVOKE ALL ON FUNCTION audit_operation_logs(text, text, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_operation_logs(text, text, timestamptz, timestamptz) TO fs_billing_audit;
