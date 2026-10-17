CREATE FUNCTION auth.lookup_user_emails(user_ids text[])
RETURNS TABLE(user_id text, email text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT u.id, u.email
  FROM auth."user" u
  WHERE u.id = ANY(user_ids)
    AND current_setting('app.scope', true) = 'admin';
$$;
ALTER FUNCTION auth.lookup_user_emails(text[]) OWNER TO fs_billing_auth;
REVOKE ALL ON FUNCTION auth.lookup_user_emails(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.lookup_user_emails(text[]) TO fs_billing_app;
