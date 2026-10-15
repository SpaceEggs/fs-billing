DO $$
DECLARE
  collisions text;
BEGIN
  SELECT string_agg(format('%s/%s: %s', user_id, provider_id, ids), E'\n' ORDER BY user_id, provider_id)
  INTO collisions
  FROM (
    SELECT user_id, provider_id, string_agg(id, ', ' ORDER BY id) AS ids
    FROM auth.account
    GROUP BY user_id, provider_id
    HAVING count(*) > 1
  ) duplicates;
  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION E'0007 duplicate auth.account (user_id, provider_id); choose which credential survives:\n%', collisions;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE auth.account
  ADD CONSTRAINT account_user_id_provider_id_key UNIQUE (user_id, provider_id);
GRANT USAGE ON SCHEMA auth TO fs_billing_app;
CREATE FUNCTION auth.revoke_user_sessions(target_user_id text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  DELETE FROM auth.session WHERE user_id = target_user_id;
$$;
CREATE FUNCTION auth.set_credential(target_user_id text, password_hash text, temp_issued_at timestamptz)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE auth.account
  SET password = password_hash,
      temporary_password_issued_at = temp_issued_at,
      updated_at = clock_timestamp()
  WHERE user_id = target_user_id AND provider_id = 'credential';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credential account missing for user %', target_user_id;
  END IF;
  DELETE FROM auth.login_failures
  WHERE email_key = (SELECT lower(email) FROM auth."user" WHERE id = target_user_id);
END;
$$;
CREATE FUNCTION auth.insert_credential(
  account_id text,
  target_user_id text,
  password_hash text,
  temp_issued_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  inserted boolean := false;
BEGIN
  INSERT INTO auth.account (
    id, account_id, provider_id, user_id, password,
    temporary_password_issued_at, created_at, updated_at
  ) VALUES (
    account_id, target_user_id, 'credential', target_user_id, password_hash,
    temp_issued_at, clock_timestamp(), clock_timestamp()
  )
  ON CONFLICT (user_id, provider_id) DO NOTHING
  RETURNING true INTO inserted;
  RETURN COALESCE(inserted, false);
END;
$$;
ALTER FUNCTION auth.revoke_user_sessions(text) OWNER TO fs_billing_auth;
ALTER FUNCTION auth.set_credential(text, text, timestamptz) OWNER TO fs_billing_auth;
ALTER FUNCTION auth.insert_credential(text, text, text, timestamptz) OWNER TO fs_billing_auth;
REVOKE ALL ON FUNCTION auth.revoke_user_sessions(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.set_credential(text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.insert_credential(text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.revoke_user_sessions(text) TO fs_billing_app;
GRANT EXECUTE ON FUNCTION auth.set_credential(text, text, timestamptz) TO fs_billing_app;
GRANT EXECUTE ON FUNCTION auth.insert_credential(text, text, text, timestamptz) TO fs_billing_app;
