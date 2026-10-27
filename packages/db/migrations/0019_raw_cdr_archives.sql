SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- 原始 JSON 归档（阶段 8 PR 3）：raw_cdr_archives 清单（每个北京月一行，状态机 exporting → verified → detached → dropped），
-- 导出、分离、丢弃、挂回 raw_cdrs 月分区的 SECURITY DEFINER 函数；决定 48：ensure_month_partition 加 lock_timeout。

-- 决定 48：缺分区时建分区要父表的 ACCESS EXCLUSIVE 锁，被长事务拦住就会让全部话单读写排在它后面。
-- 加 2 秒 lock_timeout：拿不到锁以 55P03 失败（Worker 记 partition_failed 告警，pg-boss 重试），被挡住的读写最多多等 2 秒。
-- 函数体与 0000 相同，只多一个 SET；CREATE OR REPLACE 保留属主与权限。
CREATE OR REPLACE FUNCTION ensure_month_partition(parent text, moment timestamptz) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  month_start timestamp := date_trunc('month', moment AT TIME ZONE 'Asia/Shanghai');
  partition_name text := parent || '_' || to_char(month_start, 'YYYY_MM');
BEGIN
  IF NOT app_is_operator() THEN
    RAISE EXCEPTION '建分区只允许管理员或系统身份' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF cardinality(tenant_locks_marked()) > 0 THEN
    RAISE EXCEPTION '建分区要在单独的事务里进行，不能在持有租户锁的事务里'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF parent NOT IN ('cdrs', 'raw_cdrs') THEN
    RAISE EXCEPTION '% 不是按月分区的表', parent USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF to_regclass(partition_name) IS NOT NULL THEN
    RETURN partition_name;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('partition:' || partition_name, 0));
  IF to_regclass(partition_name) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      partition_name,
      parent,
      month_start AT TIME ZONE 'Asia/Shanghai',
      (month_start + interval '1 month') AT TIME ZONE 'Asia/Shanghai'
    );
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', partition_name);
  END IF;
  RETURN partition_name;
END $$;
--> statement-breakpoint
-- 归档清单：每个北京月一行。阶段由时间戳决定（verified_at / detached_at / dropped_at），state = 'failed' 只是
-- 「最近一步抛了错」的标记，续作时按时间戳判断停在哪一步。restored_at：整月恢复后 30 天内不再归档。
CREATE TABLE raw_cdr_archives (
  month date PRIMARY KEY CHECK (extract(day FROM month) = 1),
  state text NOT NULL CHECK (state IN ('exporting', 'verified', 'detached', 'dropped', 'failed')),
  file_key text CHECK (btrim(file_key) <> ''),
  rows bigint CHECK (rows >= 0),
  body_bytes bigint CHECK (body_bytes >= 0),
  file_bytes bigint CHECK (file_bytes >= 0),
  file_sha256 text CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  rows_digest text CHECK (rows_digest ~ '^[0-9a-f]{64}$'),
  db_fingerprint jsonb,
  chunks jsonb CHECK (jsonb_typeof(chunks) = 'array'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  detached_at timestamptz,
  dropped_at timestamptz,
  restored_at timestamptz,
  CONSTRAINT raw_cdr_archives_shape CHECK (
    -- verified 及以后：文件已校验，清单齐全。
    (state NOT IN ('verified', 'detached', 'dropped') OR (
      verified_at IS NOT NULL AND file_key IS NOT NULL AND rows IS NOT NULL AND body_bytes IS NOT NULL
      AND file_bytes IS NOT NULL AND file_sha256 IS NOT NULL AND rows_digest IS NOT NULL
      AND db_fingerprint IS NOT NULL AND chunks IS NOT NULL))
    AND (state <> 'exporting' OR (verified_at IS NULL AND detached_at IS NULL AND dropped_at IS NULL))
    AND (state NOT IN ('exporting', 'verified') OR (detached_at IS NULL AND dropped_at IS NULL))
    AND (state NOT IN ('detached', 'dropped') OR detached_at IS NOT NULL)
    AND (state <> 'detached' OR dropped_at IS NULL)
    AND (state <> 'dropped' OR dropped_at IS NOT NULL)
    AND (state <> 'failed' OR dropped_at IS NULL)
    -- 步骤只能依次推进。
    AND (detached_at IS NULL OR verified_at IS NOT NULL)
    AND (dropped_at IS NULL OR detached_at IS NOT NULL)
  )
);
--> statement-breakpoint
ALTER TABLE raw_cdr_archives ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY staff_only ON raw_cdr_archives
  USING (app_is_operator()) WITH CHECK (app_is_operator());
--> statement-breakpoint
-- 状态机推进要 UPDATE；没有 DELETE。
GRANT SELECT, INSERT, UPDATE ON raw_cdr_archives TO fs_billing_app;
--> statement-breakpoint
-- 导出游标：应用角色没有分区的权限，也不能从父表读（长时间持有父表 ACCESS SHARE 会把建分区的
-- ACCESS EXCLUSIVE 请求挡住，进而挡住全部话单读写），所以由属主打开一个直接按分区名读取的游标，
-- 调用方在自己的 REPEATABLE READ 只读事务里 FETCH。行按 (received_at, id) 排序；received_at 用文本取，
-- 不经 JavaScript Date（会截成毫秒）；sha256、字节数与行哈希由数据库算（convert_to(body, 'UTF8')）。
-- p_with_body 为假时 body 为空，用于校验步骤只比较哈希、不再传输原文。
CREATE FUNCTION raw_cdrs_export_cursor(p_month date, p_with_body boolean DEFAULT true) RETURNS refcursor
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  partition_name text := 'raw_cdrs_' || to_char(p_month, 'YYYY_MM');
  cur refcursor := 'raw_cdrs_export';
BEGIN
  IF NOT app_is_operator() THEN
    RAISE EXCEPTION '导出原始话单只允许管理员或系统身份' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_month IS NULL OR p_month <> date_trunc('month', p_month)::date THEN
    RAISE EXCEPTION '月份必须是某月 1 日' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (
    SELECT FROM pg_inherits
    WHERE inhrelid = to_regclass(partition_name) AND inhparent = 'public.raw_cdrs'::regclass
  ) THEN
    RAISE EXCEPTION '分区 % 不存在或已脱离 raw_cdrs', partition_name USING ERRCODE = 'undefined_table';
  END IF;
  OPEN cur FOR EXECUTE format(
    $sql$SELECT id,
      to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS received_at,
      encode(sha256(convert_to(body, 'UTF8')), 'hex') AS sha256,
      octet_length(body)::bigint AS body_bytes,
      hashtextextended(id::text || body, 0) AS row_hash,
      (tenant_id IS NOT NULL OR call_uuid IS NOT NULL) AS linked,
      CASE WHEN $1 THEN body END AS body
    FROM %I ORDER BY received_at, id$sql$, partition_name) USING p_with_body;
  RETURN cur;
END $$;
--> statement-breakpoint
-- 分离分区。先对分区加 ACCESS EXCLUSIVE 锁，再在没有父表锁的情况下重算指纹（要扫整个分区，耗时），
-- 与清单里导出时的指纹和传入的指纹都相符才分离，所以对 raw_cdrs 的 ACCESS EXCLUSIVE 只持续到 DETACH 与改名结束。
-- 函数在事务里，用不了 DETACH … CONCURRENTLY，所以是普通 DETACH；每次加锁最多等 3 秒（函数级 lock_timeout，
-- 函数返回后恢复调用方的设置），拿不到就以 55P03 失败，数据没动，下次再试。清单的 verified 要求和 detached 的更新
-- 由调用方放在同一个事务里，所以不会出现「分区已分离而清单没记」。
CREATE FUNCTION raw_cdrs_detach_partition(p_month date, p_fingerprint jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET lock_timeout = '3s' AS $$
DECLARE
  partition_name text := 'raw_cdrs_' || to_char(p_month, 'YYYY_MM');
  archived_name text := 'raw_cdrs_' || to_char(p_month, 'YYYY_MM') || '_archived';
  manifest raw_cdr_archives%ROWTYPE;
  seen record;
BEGIN
  IF NOT app_is_operator() THEN
    RAISE EXCEPTION '分离分区只允许管理员或系统身份' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF cardinality(tenant_locks_marked()) > 0 THEN
    RAISE EXCEPTION '分离分区要在单独的事务里进行，不能在持有租户锁的事务里'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF p_month IS NULL OR p_month <> date_trunc('month', p_month)::date THEN
    RAISE EXCEPTION '月份必须是某月 1 日' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO manifest FROM raw_cdr_archives WHERE month = p_month;
  IF NOT FOUND OR manifest.verified_at IS NULL OR manifest.detached_at IS NOT NULL THEN
    RAISE EXCEPTION '% 的归档没有通过校验，或已经分离', partition_name
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF p_fingerprint IS DISTINCT FROM manifest.db_fingerprint THEN
    RAISE EXCEPTION '传入的指纹与清单里的不一致' USING ERRCODE = 'data_exception';
  END IF;
  IF NOT EXISTS (
    SELECT FROM pg_inherits
    WHERE inhrelid = to_regclass(partition_name) AND inhparent = 'public.raw_cdrs'::regclass
  ) THEN
    RAISE EXCEPTION '分区 % 不存在或已脱离 raw_cdrs', partition_name USING ERRCODE = 'undefined_table';
  END IF;
  IF to_regclass(archived_name) IS NOT NULL THEN
    RAISE EXCEPTION '% 已存在', archived_name USING ERRCODE = 'duplicate_table';
  END IF;
  EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE', partition_name);
  EXECUTE format(
    'SELECT count(*)::bigint AS n, coalesce(sum(octet_length(body)), 0)::bigint AS bytes,
            coalesce(bit_xor(hashtextextended(id::text || body, 0)), 0)::bigint AS xor
     FROM %I', partition_name) INTO seen;
  IF seen.n <> (p_fingerprint ->> 'count')::bigint
     OR seen.bytes <> (p_fingerprint ->> 'bodyBytes')::bigint
     OR seen.xor <> (p_fingerprint ->> 'xor')::bigint THEN
    RAISE EXCEPTION '分区 % 的内容与导出时不一致（行数 %、字节 %）', partition_name, seen.n, seen.bytes
      USING ERRCODE = 'data_corrupted';
  END IF;
  EXECUTE format('ALTER TABLE raw_cdrs DETACH PARTITION %I', partition_name);
  EXECUTE format('ALTER TABLE %I RENAME TO %I', partition_name, archived_name);
  -- 主键索引跟着改名，免得后来重建同名分区时索引名对不上。
  IF to_regclass(partition_name || '_pkey') IS NOT NULL THEN
    EXECUTE format('ALTER INDEX %I RENAME TO %I', partition_name || '_pkey', archived_name || '_pkey');
  END IF;
END $$;
--> statement-breakpoint
-- 丢弃已分离的 …_archived 表：唯一不可逆的一步。清单必须记着已校验、已分离、未丢弃；
-- 该表若仍挂在 raw_cdrs 下则拒绝；表已经不存在（人工删过）视为完成。
CREATE FUNCTION raw_cdrs_drop_detached(p_month date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET lock_timeout = '3s' AS $$
DECLARE
  archived_name text := 'raw_cdrs_' || to_char(p_month, 'YYYY_MM') || '_archived';
BEGIN
  IF NOT app_is_operator() THEN
    RAISE EXCEPTION '丢弃分区只允许管理员或系统身份' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF cardinality(tenant_locks_marked()) > 0 THEN
    RAISE EXCEPTION '丢弃分区要在单独的事务里进行，不能在持有租户锁的事务里'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF p_month IS NULL OR p_month <> date_trunc('month', p_month)::date THEN
    RAISE EXCEPTION '月份必须是某月 1 日' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (
    SELECT FROM raw_cdr_archives
    WHERE month = p_month AND verified_at IS NOT NULL AND detached_at IS NOT NULL AND dropped_at IS NULL
  ) THEN
    RAISE EXCEPTION '% 的归档不处于「已分离、未丢弃」', archived_name
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF to_regclass(archived_name) IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT FROM pg_inherits WHERE inhrelid = to_regclass(archived_name)) THEN
    RAISE EXCEPTION '% 仍然挂在父表下，不能丢弃', archived_name USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  EXECUTE format('DROP TABLE %I', archived_name);
END $$;
--> statement-breakpoint
-- 宽限期内把 …_archived 原样挂回 raw_cdrs（整月恢复的快路径，不需要读归档文件）。
CREATE FUNCTION raw_cdrs_reattach_partition(p_month date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET lock_timeout = '3s' AS $$
DECLARE
  partition_name text := 'raw_cdrs_' || to_char(p_month, 'YYYY_MM');
  archived_name text := 'raw_cdrs_' || to_char(p_month, 'YYYY_MM') || '_archived';
  month_start timestamp := p_month;
BEGIN
  IF NOT app_is_operator() THEN
    RAISE EXCEPTION '挂回分区只允许管理员或系统身份' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF cardinality(tenant_locks_marked()) > 0 THEN
    RAISE EXCEPTION '挂回分区要在单独的事务里进行，不能在持有租户锁的事务里'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF p_month IS NULL OR p_month <> date_trunc('month', p_month)::date THEN
    RAISE EXCEPTION '月份必须是某月 1 日' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (
    SELECT FROM raw_cdr_archives
    WHERE month = p_month AND verified_at IS NOT NULL AND detached_at IS NOT NULL AND dropped_at IS NULL
  ) THEN
    RAISE EXCEPTION '% 的归档不处于「已分离、未丢弃」', archived_name
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF to_regclass(archived_name) IS NULL THEN
    RAISE EXCEPTION '% 不存在', archived_name USING ERRCODE = 'undefined_table';
  END IF;
  IF to_regclass(partition_name) IS NOT NULL THEN
    RAISE EXCEPTION '% 已存在', partition_name USING ERRCODE = 'duplicate_table';
  END IF;
  IF EXISTS (SELECT FROM pg_inherits WHERE inhrelid = to_regclass(archived_name)) THEN
    RAISE EXCEPTION '% 已经挂在父表下', archived_name USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  EXECUTE format('ALTER TABLE %I RENAME TO %I', archived_name, partition_name);
  IF to_regclass(archived_name || '_pkey') IS NOT NULL THEN
    EXECUTE format('ALTER INDEX %I RENAME TO %I', archived_name || '_pkey', partition_name || '_pkey');
  END IF;
  EXECUTE format(
    'ALTER TABLE raw_cdrs ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)',
    partition_name,
    month_start AT TIME ZONE 'Asia/Shanghai',
    (month_start + interval '1 month') AT TIME ZONE 'Asia/Shanghai'
  );
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION raw_cdrs_export_cursor(date, boolean) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION raw_cdrs_detach_partition(date, jsonb) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION raw_cdrs_drop_detached(date) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION raw_cdrs_reattach_partition(date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION raw_cdrs_export_cursor(date, boolean), raw_cdrs_detach_partition(date, jsonb),
  raw_cdrs_drop_detached(date), raw_cdrs_reattach_partition(date) TO fs_billing_app;
