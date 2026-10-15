CREATE FUNCTION auth.insert_user(user_id text, user_name text, user_email text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO auth."user"(id, name, email, updated_at)
  VALUES (user_id, user_name, user_email, clock_timestamp());
END;
$$;
CREATE FUNCTION auth.clear_login_failures(target_email_key text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  DELETE FROM auth.login_failures WHERE email_key = target_email_key;
END;
$$;
ALTER FUNCTION auth.insert_user(text, text, text) OWNER TO fs_billing_auth;
ALTER FUNCTION auth.clear_login_failures(text) OWNER TO fs_billing_auth;
REVOKE ALL ON FUNCTION auth.insert_user(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.clear_login_failures(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.insert_user(text, text, text) TO fs_billing_app;
GRANT EXECUTE ON FUNCTION auth.clear_login_failures(text) TO fs_billing_app;
