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

-- 列出 fs_billing_audit 超出白名单（public 的 USAGE、audit_operation_logs 的 EXECUTE）的权限，干净时为空。
-- 白名单只豁免不带 GRANT OPTION 的权限，否则审计角色能把查询转授给应用角色。
-- has_*_privilege 按角色 oid 判断，已包含经 PUBLIC 和成员关系得到的权限。
CREATE FUNCTION audit_role_violations() RETURNS SETOF text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH audit AS (
    SELECT * FROM pg_catalog.pg_roles WHERE rolname = 'fs_billing_audit'
  ),
  scoped AS (
    SELECT oid, nspname FROM pg_catalog.pg_namespace WHERE nspname IN ('public', 'auth')
  ),
  found(ord, line) AS (
    SELECT 1, '角色属性：' || v.attr
    FROM audit a, LATERAL (VALUES
      ('SUPERUSER', a.rolsuper), ('BYPASSRLS', a.rolbypassrls), ('CREATEROLE', a.rolcreaterole),
      ('CREATEDB', a.rolcreatedb), ('LOGIN', a.rolcanlogin), ('REPLICATION', a.rolreplication)
    ) v(attr, granted)
    WHERE v.granted
    UNION ALL
    SELECT 2, '是角色 ' || m.roleid::pg_catalog.regrole::text || ' 的成员'
    FROM audit a JOIN pg_catalog.pg_auth_members m ON m.member = a.oid
    UNION ALL
    SELECT 3, '在本库拥有 ' || pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid)
    FROM audit a
    JOIN pg_catalog.pg_shdepend d
      ON d.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass AND d.refobjid = a.oid
    JOIN pg_catalog.pg_database db ON db.oid = d.dbid
    WHERE db.datname = pg_catalog.current_database() AND d.deptype = 'o'
    UNION ALL
    -- CONNECT、TEMP 是 PUBLIC 的默认库权限，读不到业务数据，不算越权。
    SELECT 4, '数据库 ' || pg_catalog.current_database() || '：CREATE'
    FROM audit a
    WHERE pg_catalog.has_database_privilege(a.oid, pg_catalog.current_database(), 'CREATE')
    UNION ALL
    SELECT 5, 'schema ' || n.nspname || '：' || p.priv
    FROM audit a, scoped n, (VALUES ('USAGE'), ('USAGE WITH GRANT OPTION'), ('CREATE')) p(priv)
    WHERE p.priv <> CASE n.nspname WHEN 'public' THEN 'USAGE' ELSE 'USAGE WITH GRANT OPTION' END
      AND pg_catalog.has_schema_privilege(a.oid, n.oid, p.priv)
    UNION ALL
    SELECT 6, CASE c.relkind WHEN 'v' THEN '视图 ' WHEN 'm' THEN '物化视图 ' WHEN 'f' THEN '外部表 '
        ELSE '表 ' END || c.oid::pg_catalog.regclass::text || '：'
      || pg_catalog.string_agg(p.priv, ', ' ORDER BY p.n)
    FROM audit a
    JOIN pg_catalog.pg_class c ON c.relkind IN ('r', 'p', 'v', 'm', 'f')
    JOIN scoped n ON n.oid = c.relnamespace
    CROSS JOIN pg_catalog.unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES',
      'TRIGGER', 'MAINTAIN']) WITH ORDINALITY p(priv, n)
    WHERE pg_catalog.has_table_privilege(a.oid, c.oid, p.priv)
    GROUP BY c.oid, c.relkind
    UNION ALL
    SELECT 7, '列 ' || c.oid::pg_catalog.regclass::text || '.' || pg_catalog.quote_ident(att.attname)
      || '：' || pg_catalog.string_agg(p.priv, ', ' ORDER BY p.n)
    FROM audit a
    JOIN pg_catalog.pg_class c ON c.relkind IN ('r', 'p', 'v', 'm', 'f')
    JOIN scoped n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute att
      ON att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped
    CROSS JOIN pg_catalog.unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) WITH ORDINALITY p(priv, n)
    WHERE pg_catalog.has_column_privilege(a.oid, c.oid, att.attnum, p.priv)
      AND NOT pg_catalog.has_table_privilege(a.oid, c.oid, p.priv)
    GROUP BY c.oid, att.attname
    UNION ALL
    SELECT 8, '序列 ' || c.oid::pg_catalog.regclass::text || '：'
      || pg_catalog.string_agg(p.priv, ', ' ORDER BY p.n)
    FROM audit a
    JOIN pg_catalog.pg_class c ON c.relkind = 'S'
    JOIN scoped n ON n.oid = c.relnamespace
    CROSS JOIN pg_catalog.unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) WITH ORDINALITY p(priv, n)
    WHERE pg_catalog.has_sequence_privilege(a.oid, c.oid, p.priv)
    GROUP BY c.oid
    UNION ALL
    SELECT 9, CASE f.prokind WHEN 'p' THEN '过程 ' ELSE '函数 ' END
      || f.oid::pg_catalog.regprocedure::text || '：' || p.priv
    FROM audit a
    CROSS JOIN pg_catalog.pg_proc f
    JOIN scoped n ON n.oid = f.pronamespace
    CROSS JOIN (VALUES ('EXECUTE'), ('EXECUTE WITH GRANT OPTION')) p(priv)
    WHERE p.priv = CASE WHEN f.oid
        = pg_catalog.to_regprocedure('public.audit_operation_logs(text,text,timestamptz,timestamptz)')
        THEN 'EXECUTE WITH GRANT OPTION' ELSE 'EXECUTE' END
      AND pg_catalog.has_function_privilege(a.oid, f.oid, p.priv)
    UNION ALL
    -- 类型的 USAGE 本就默认授予 PUBLIC，不涉及数据，跳过 T。
    SELECT 10, '默认权限：' || d.defaclrole::pg_catalog.regrole::text || ' 在 '
      || coalesce('schema ' || n.nspname, '所有 schema') || ' 新建的'
      || CASE d.defaclobjtype WHEN 'r' THEN '表' WHEN 'S' THEN '序列' WHEN 'f' THEN '函数'
        WHEN 'n' THEN 'schema' ELSE d.defaclobjtype::text END
      || '授予 ' || CASE e.grantee WHEN 0 THEN 'PUBLIC' ELSE e.grantee::pg_catalog.regrole::text END
      || ' ' || pg_catalog.string_agg(e.privilege_type, ', ' ORDER BY e.privilege_type)
    FROM audit a
    CROSS JOIN pg_catalog.pg_default_acl d
    LEFT JOIN scoped n ON n.oid = d.defaclnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) e
    WHERE d.defaclobjtype <> 'T' AND e.grantee IN (a.oid, 0)
      AND (d.defaclnamespace = 0 OR n.oid IS NOT NULL)
    GROUP BY d.oid, d.defaclrole, n.nspname, d.defaclobjtype, e.grantee
  )
  SELECT line FROM found ORDER BY ord, line;
$$;
REVOKE ALL ON FUNCTION audit_role_violations() FROM PUBLIC;

-- 角色是集群级的，同名角色可能早已存在并带着别的权限。迁移不替它清理（别的库可能在用），只拒绝继续。
DO $$
DECLARE
  problems text;
BEGIN
  SELECT string_agg(v.line, '；' ORDER BY v.n) INTO problems
  FROM audit_role_violations() WITH ORDINALITY v(line, n);
  IF problems IS NOT NULL THEN
    RAISE EXCEPTION 'fs_billing_audit 超出只读权限：%；迁移不会自动清理，请人工核查后再执行', problems;
  END IF;
END $$;
