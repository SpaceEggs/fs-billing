import type { FastifyBaseLogger } from 'fastify';
import {
  decryptSetting,
  readEffectiveMailRecord,
  SettingsDecryptError,
  SMTP_PASSWORD_AAD,
  type PoolDb,
} from '@fs-billing/db';
import type { MailSettings } from '@fs-billing/mailer';

type Logger = Pick<FastifyBaseLogger, 'error'>;

/**
 * 每轮发信前按 `docs/smtp-settings-design.md` 的「配置来源」表决定用哪套 SMTP 配置。
 *
 * - `managed = false`：用环境变量（升级后的默认），没配就不发信。
 * - `managed = true && enabled = false`：不发信，邮件留在发件箱。
 * - `managed = true && enabled = true`：只用数据库里的配置，不再看环境变量。
 *
 * 页面管理的配置有问题（没有密钥、解不开密文、有账号却没有密码）时记一条固定错误并返回 `undefined`：
 * **绝不回退到环境变量**，否则会用错账号发信。读数据库失败不在这里吞掉，让调用方的 tick 错误处理接管。
 * 错误日志不含密文、密码或密钥。
 */

/** 连接超时、每轮封数、最大尝试次数仍来自环境变量，不进数据库。 */
export interface MailTuning {
  readonly timeoutMs: number;
  readonly ratePerTick: number;
  readonly maxAttempts: number;
}

export interface ResolveMailSettingsOptions {
  /** 环境变量来源的配置；`managed = false` 时原样返回。 */
  readonly envSettings: MailSettings | undefined;
  /** `SETTINGS_ENCRYPTION_KEY` 解析后的密钥；未设置为 `undefined`。 */
  readonly key: Buffer | undefined;
  readonly tuning: MailTuning;
  readonly logger?: Logger | undefined;
}

const KEY_MISSING =
  '邮箱设置中有密码，但未设置 SETTINGS_ENCRYPTION_KEY：本轮不发送邮件，也不回退到环境变量';
const DECRYPT_FAILED =
  '邮箱设置中的密码无法解密：本轮不发送邮件，也不回退到环境变量';
const PASSWORD_MISSING =
  '邮箱设置使用账号认证，但没有可用的密码：本轮不发送邮件，也不回退到环境变量';
const INCOMPLETE =
  '邮箱设置缺少主机、端口、加密方式或发件人：本轮不发送邮件，也不回退到环境变量';

export async function resolveMailSettings(
  db: PoolDb,
  { envSettings, key, tuning, logger }: ResolveMailSettingsOptions,
): Promise<MailSettings | undefined> {
  // 读数据库失败要往外抛：由 tick 的错误处理记录并把这次任务标成失败。
  const record = await readEffectiveMailRecord(db);
  if (!record.managed) return envSettings;
  if (!record.enabled) return undefined;

  // 迁移约束保证 managed + enabled 时这四项已填；万一被绕过，也按配置不可用处理，不回退。
  if (
    record.host === null ||
    record.port === null ||
    record.secure === null ||
    record.mailFrom === null
  ) {
    logger?.error(INCOMPLETE);
    return undefined;
  }

  let pass: string | undefined;
  if (record.passwordCiphertext !== null) {
    if (key === undefined) {
      logger?.error(KEY_MISSING);
      return undefined;
    }
    try {
      pass = decryptSetting(record.passwordCiphertext, key, SMTP_PASSWORD_AAD);
    } catch (error) {
      // 只捕获解密错误；其它异常（例如代码缺陷）照常往外抛。
      if (!(error instanceof SettingsDecryptError)) throw error;
      logger?.error(DECRYPT_FAILED);
      return undefined;
    }
  } else if ((record.username ?? '') !== '') {
    // 有账号却没有密文：无法认证，不发信。
    logger?.error(PASSWORD_MISSING);
    return undefined;
  }

  const username = record.username ?? '';
  return {
    host: record.host,
    port: record.port,
    secure: record.secure,
    user: username === '' ? undefined : username,
    pass,
    from: record.mailFrom,
    timeoutMs: tuning.timeoutMs,
    ratePerTick: tuning.ratePerTick,
    maxAttempts: tuning.maxAttempts,
    // 页面管理的配置没有站点地址就是没有，不回退到 APP_PUBLIC_URL。
    siteUrl: record.siteUrl ?? undefined,
  };
}
