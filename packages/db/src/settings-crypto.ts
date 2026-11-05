import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * 设置里的秘密（目前只有 SMTP 密码）的加密。
 *
 * 放在 `packages/db` 而不是 `packages/shared`：`packages/shared` 会打包进 Web，Node 的 `crypto` 不能进去，
 * 而且 Web 不该有解密能力。密钥来自 API / Worker 的环境变量 `SETTINGS_ENCRYPTION_KEY`（32 字节 base64）。
 *
 * 密文格式 `v1:<iv b64>:<tag b64>:<ct b64>`，AES-256-GCM，每次随机 12 字节 IV，AAD 固定。版本前缀留给
 * 以后换算法或参数；解不开时统一抛 {@link SettingsDecryptError}，错误信息固定，不含明文、密文或密钥。
 */

/** AES-256 的密钥字节数。 */
export const SETTINGS_KEY_BYTES = 32;
/** GCM 的 IV 字节数（96 位）。 */
export const SETTINGS_IV_BYTES = 12;
/** GCM 认证标签的字节数。 */
export const SETTINGS_TAG_BYTES = 16;
/** 当前密文格式版本。 */
export const SETTINGS_CIPHERTEXT_VERSION = 'v1';
/** SMTP 密码的 AAD；换字段时必须换 AAD，避免密文被挪用到别处。 */
export const SMTP_PASSWORD_AAD = 'smtp_settings.password';

const ALGORITHM = 'aes-256-gcm';

/** `SETTINGS_ENCRYPTION_KEY` 不是 32 字节的 base64。信息固定，不回显取值。 */
export class SettingsKeyError extends Error {
  readonly code = 'SETTINGS_KEY_INVALID';
  constructor() {
    super('设置加密密钥必须是 32 字节的 base64');
    this.name = 'SettingsKeyError';
  }
}

/** 密文版本不对、格式错误、认证失败（改过、密钥或 AAD 不对）。信息固定。 */
export class SettingsDecryptError extends Error {
  readonly code = 'SETTINGS_DECRYPT_FAILED';
  constructor() {
    super('设置密文无法解密');
    this.name = 'SettingsDecryptError';
  }
}

/** 解析 `SETTINGS_ENCRYPTION_KEY`：base64 解码后必须正好 32 字节。 */
export function parseSettingsKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== SETTINGS_KEY_BYTES) throw new SettingsKeyError();
  return key;
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== SETTINGS_KEY_BYTES)
    throw new SettingsKeyError();
}

/** 加密一个设置值；每次调用都用新的随机 IV，所以同一明文的密文每次都不同。 */
export function encryptSetting(
  plaintext: string,
  key: Buffer,
  aad: string,
): string {
  assertKey(key);
  const iv = randomBytes(SETTINGS_IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    SETTINGS_CIPHERTEXT_VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/** 解密 {@link encryptSetting} 的密文；任何失败都抛 {@link SettingsDecryptError}。 */
export function decryptSetting(
  ciphertext: string,
  key: Buffer,
  aad: string,
): string {
  try {
    assertKey(key);
    const parts = ciphertext.split(':');
    if (parts.length !== 4 || parts[0] !== SETTINGS_CIPHERTEXT_VERSION)
      throw new SettingsDecryptError();
    const iv = Buffer.from(parts[1]!, 'base64');
    const tag = Buffer.from(parts[2]!, 'base64');
    const data = Buffer.from(parts[3]!, 'base64');
    if (iv.length !== SETTINGS_IV_BYTES || tag.length !== SETTINGS_TAG_BYTES)
      throw new SettingsDecryptError();
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    throw new SettingsDecryptError();
  }
}
