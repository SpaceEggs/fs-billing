SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- 邮箱设置（docs/smtp-settings-design.md）：单行表，管理员在后台配置 SMTP，Worker 每轮发信前读一次。
-- id 是布尔主键加 CHECK (id)：只可能有一行（值为 true）。version 做乐观并发，保存带 expectedVersion。
-- managed 为 false 时继续用环境变量（升级后的默认），第一次保存才设为 true；没有“退回环境变量”的入口。
CREATE TABLE smtp_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  managed boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT false,
  host text,
  port integer CHECK (port BETWEEN 1 AND 65535),
  secure boolean,
  username text,
  -- 只存密文（AES-256-GCM，格式 v1:<iv>:<tag>:<ct>）；明文与密钥都不进数据库。
  password_ciphertext text,
  mail_from text,
  site_url text,
  last_test_at timestamptz,
  last_test_ok boolean,
  -- 最近一次测试只存错误分类，不存服务器原始响应。
  last_test_result text CHECK (last_test_result IN ('ok', 'auth', 'retry', 'permanent')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES admins,
  -- 启用页面管理的配置时，连接与发件人必须齐全。
  CONSTRAINT smtp_settings_managed_complete CHECK (
    NOT (managed AND enabled)
    OR (host IS NOT NULL AND port IS NOT NULL AND secure IS NOT NULL AND mail_from IS NOT NULL)
  )
);
--> statement-breakpoint
-- 默认行：Worker 读不到设置行时也能按 managed = false 工作，保存只需 UPDATE。
INSERT INTO smtp_settings (id) VALUES (true);
--> statement-breakpoint
ALTER TABLE smtp_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY staff_only ON smtp_settings
  USING (app_is_operator()) WITH CHECK (app_is_operator());
--> statement-breakpoint
-- 没有 DELETE：设置行永远存在。
GRANT SELECT, INSERT, UPDATE ON smtp_settings TO fs_billing_app;
