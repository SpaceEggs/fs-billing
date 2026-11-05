import { describe, expect, it } from 'vitest';
import {
  decryptSetting,
  encryptSetting,
  parseSettingsKey,
  SettingsDecryptError,
  SettingsKeyError,
  SMTP_PASSWORD_AAD,
} from './settings-crypto.js';

const key = parseSettingsKey(Buffer.alloc(32, 7).toString('base64'));
const plaintext = 'p@ssw0rd-测试-明文';

describe('settings-crypto', () => {
  it('round trips through AES-256-GCM', () => {
    const ciphertext = encryptSetting(plaintext, key, SMTP_PASSWORD_AAD);
    expect(ciphertext.startsWith('v1:')).toBe(true);
    expect(decryptSetting(ciphertext, key, SMTP_PASSWORD_AAD)).toBe(plaintext);
  });

  it('uses a fresh IV so the same plaintext encrypts differently each time', () => {
    const first = encryptSetting(plaintext, key, SMTP_PASSWORD_AAD);
    const second = encryptSetting(plaintext, key, SMTP_PASSWORD_AAD);
    expect(first).not.toBe(second);
    expect(first.split(':')[1]).not.toBe(second.split(':')[1]);
  });

  it('rejects a tampered ciphertext', () => {
    const parts = encryptSetting(plaintext, key, SMTP_PASSWORD_AAD).split(':');
    const data = Buffer.from(parts[3]!, 'base64');
    data[0] = data[0]! ^ 0xff;
    parts[3] = data.toString('base64');
    expect(() =>
      decryptSetting(parts.join(':'), key, SMTP_PASSWORD_AAD),
    ).toThrow(SettingsDecryptError);
  });

  it('rejects a tampered authentication tag', () => {
    const parts = encryptSetting(plaintext, key, SMTP_PASSWORD_AAD).split(':');
    const tag = Buffer.from(parts[2]!, 'base64');
    tag[0] = tag[0]! ^ 0xff;
    parts[2] = tag.toString('base64');
    expect(() =>
      decryptSetting(parts.join(':'), key, SMTP_PASSWORD_AAD),
    ).toThrow(SettingsDecryptError);
  });

  it('rejects the wrong key', () => {
    const ciphertext = encryptSetting(plaintext, key, SMTP_PASSWORD_AAD);
    const wrong = Buffer.alloc(32, 9);
    expect(() => decryptSetting(ciphertext, wrong, SMTP_PASSWORD_AAD)).toThrow(
      SettingsDecryptError,
    );
  });

  it('rejects the wrong AAD', () => {
    const ciphertext = encryptSetting(plaintext, key, SMTP_PASSWORD_AAD);
    expect(() =>
      decryptSetting(ciphertext, key, 'smtp_settings.other'),
    ).toThrow(SettingsDecryptError);
  });

  it('rejects an unknown ciphertext version', () => {
    const ciphertext = encryptSetting(plaintext, key, SMTP_PASSWORD_AAD);
    expect(() =>
      decryptSetting(ciphertext.replace(/^v1:/, 'v2:'), key, SMTP_PASSWORD_AAD),
    ).toThrow(SettingsDecryptError);
  });

  it('rejects malformed ciphertext', () => {
    for (const bad of ['', 'v1', 'v1:aaa', 'v1:aaa:bbb:ccc:ddd'])
      expect(() => decryptSetting(bad, key, SMTP_PASSWORD_AAD)).toThrow(
        SettingsDecryptError,
      );
  });

  it('accepts only a 32 byte base64 key and never echoes the value', () => {
    expect(
      parseSettingsKey(Buffer.alloc(32, 1).toString('base64')),
    ).toHaveLength(32);
    for (const value of [
      Buffer.alloc(31, 1).toString('base64'),
      Buffer.alloc(33, 1).toString('base64'),
      'not-base64',
    ]) {
      let error: unknown;
      try {
        parseSettingsKey(value);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(SettingsKeyError);
      expect((error as Error).message).not.toContain(value);
    }
    expect(() => parseSettingsKey('')).toThrow(SettingsKeyError);
  });

  it('does not put the plaintext in a decryption error message', () => {
    const ciphertext = encryptSetting(plaintext, key, SMTP_PASSWORD_AAD);
    try {
      decryptSetting(ciphertext, Buffer.alloc(32, 9), SMTP_PASSWORD_AAD);
      throw new Error('expected decryption to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(SettingsDecryptError);
      expect((error as Error).message).not.toContain(plaintext);
      expect((error as Error).message).not.toContain(ciphertext);
    }
  });
});
