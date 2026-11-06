import { describe, expect, it } from 'vitest';
import { en, zh } from './index.js';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/gu;

/** 空英文值白名单；I1 起始为空。 */
const allowEmptyEn = new Set<string>();

function flatten(
  value: Record<string, unknown>,
  prefix = '',
  out = new Map<string, string[]>(),
): Map<string, string[]> {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'string') {
      const base = path.replace(PLURAL_SUFFIX, '');
      const values = out.get(base) ?? [];
      values.push(child);
      out.set(base, values);
    } else if (typeof child === 'object' && child !== null) {
      flatten(child as Record<string, unknown>, path, out);
    }
  }
  return out;
}

const zhValues = flatten(zh);
const enValues = flatten(en);

function keys(values: Map<string, string[]>) {
  return [...values.keys()].sort();
}

function placeholders(values: string[]) {
  return new Set(
    values.flatMap((value) =>
      [...value.matchAll(PLACEHOLDER)].map((m) => m[1]),
    ),
  );
}

describe('i18n catalog', () => {
  it('has the same keys in Chinese and English', () => {
    expect(keys(enValues)).toEqual(keys(zhValues));
  });

  it('uses the same {{placeholders}} in both languages', () => {
    for (const key of keys(zhValues)) {
      expect([...placeholders(enValues.get(key) ?? [])].sort(), key).toEqual(
        [...placeholders(zhValues.get(key) ?? [])].sort(),
      );
    }
  });

  it('has no Chinese characters in English values', () => {
    for (const [key, values] of enValues) {
      for (const value of values) {
        expect(HAN.test(value), key).toBe(false);
      }
    }
  });

  it('has no empty English values', () => {
    for (const [key, values] of enValues) {
      if (allowEmptyEn.has(key)) continue;
      for (const value of values) expect(value.trim(), key).not.toBe('');
    }
  });

  it('has no TODO markers in Chinese values', () => {
    for (const [key, values] of zhValues) {
      for (const value of values) expect(value, key).not.toContain('TODO');
    }
  });
});
