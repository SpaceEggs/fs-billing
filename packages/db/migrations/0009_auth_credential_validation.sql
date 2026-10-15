CREATE OR REPLACE FUNCTION auth.set_credential(target_user_id text, password_hash text, temp_issued_at timestamptz)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF target_user_id IS NULL OR btrim(target_user_id) = '' THEN
    RAISE EXCEPTION 'target_user_id is required' USING ERRCODE = '22023';
  END IF;
  IF password_hash IS NULL OR btrim(password_hash) = '' THEN
    RAISE EXCEPTION 'password_hash is required' USING ERRCODE = '22023';
  END IF;
  IF temp_issued_at IS NULL OR NOT isfinite(temp_issued_at)
     OR temp_issued_at > clock_timestamp() THEN
    RAISE EXCEPTION 'temporary credential issuance must be a finite, non-future timestamp'
      USING ERRCODE = '22023';
  END IF;
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
CREATE OR REPLACE FUNCTION auth.insert_credential(
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
  IF account_id IS NULL OR btrim(account_id) = '' THEN
    RAISE EXCEPTION 'account_id is required' USING ERRCODE = '22023';
  END IF;
  IF target_user_id IS NULL OR btrim(target_user_id) = '' THEN
    RAISE EXCEPTION 'target_user_id is required' USING ERRCODE = '22023';
  END IF;
  IF password_hash IS NULL OR btrim(password_hash) = '' THEN
    RAISE EXCEPTION 'password_hash is required' USING ERRCODE = '22023';
  END IF;
  IF temp_issued_at IS NULL OR NOT isfinite(temp_issued_at)
     OR temp_issued_at > clock_timestamp() THEN
    RAISE EXCEPTION 'temporary credential issuance must be a finite, non-future timestamp'
      USING ERRCODE = '22023';
  END IF;
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
