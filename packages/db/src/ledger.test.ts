import { describe, expect, it } from 'vitest';
import { canonicalTenantId } from './ledger.js';

const LOW = '00000000-0000-4000-8000-000000000001';
const HIGH = '00000000-0000-4000-8000-000000000002';

describe('canonicalTenantId', () => {
  it('把 PostgreSQL 接受的 UUID 写法规范成小写带连字符', () => {
    expect(canonicalTenantId(HIGH)).toBe(HIGH);
    expect(canonicalTenantId(HIGH.toUpperCase())).toBe(HIGH);
    expect(canonicalTenantId(`{${HIGH}}`)).toBe(HIGH);
    expect(canonicalTenantId(HIGH.replaceAll('-', ''))).toBe(HIGH);
    expect(canonicalTenantId('0000-0000-0000-4000-8000-0000-0000-0002')).toBe(
      HIGH,
    );
    expect(canonicalTenantId('{00000000-00004000-80000000-00000002}')).toBe(
      HIGH,
    );
  });

  it('规范形式的字典序与 uuid 数值序一致，小写原文序相反的写法也一样', () => {
    const lowPlain = LOW.replaceAll('-', '');
    const lowBraced = `{${LOW}}`;
    expect(HIGH < lowPlain).toBe(true);
    expect(HIGH < lowBraced).toBe(true);
    expect(canonicalTenantId(lowPlain) < canonicalTenantId(HIGH)).toBe(true);
    expect(canonicalTenantId(lowBraced) < canonicalTenantId(`{${HIGH}}`)).toBe(
      true,
    );
    expect(canonicalTenantId(HIGH)).toBe(canonicalTenantId(`{${HIGH}}`));
  });

  it('拒绝 PostgreSQL 不接受的 UUID', () => {
    for (const value of [
      '',
      'not-a-uuid',
      `{${HIGH}`,
      `${HIGH}-`,
      `-${LOW}`,
      `${HIGH} `,
      `urn:uuid:${HIGH}`,
      `${HIGH.slice(0, 8)}--${HIGH.slice(9)}`,
    ]) {
      expect(() => canonicalTenantId(value)).toThrow(/不是合法的 UUID/);
    }
  });
});
