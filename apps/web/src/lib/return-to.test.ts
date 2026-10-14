import { describe, expect, it } from 'vitest';
import type { Identity } from '@fs-billing/shared';
import {
  rememberReturnPath,
  resolveReturnPath,
  takeReturnPath,
} from './return-to';

const customer: Identity = {
  kind: 'customer',
  profileId: '00000000-0000-4000-8000-000000000001',
  email: 'abc001@example.com',
  tenant: {
    id: '00000000-0000-4000-8000-000000000002',
    code: 'ABC001',
    name: '深圳市某某科技有限公司',
    currency: 'CNY',
  },
};
const admin: Identity = {
  kind: 'admin',
  profileId: '00000000-0000-4000-8000-000000000003',
  name: '王敏',
  email: 'wangmin@example.com',
};

describe('resolveReturnPath', () => {
  it('returns to a same-zone path with its query and hash', () => {
    expect(resolveReturnPath('/ledger?type=充值#top', customer)).toBe(
      '/ledger?type=%E5%85%85%E5%80%BC#top',
    );
    expect(resolveReturnPath('/admin/tenants?page=2', admin)).toBe(
      '/admin/tenants?page=2',
    );
  });

  it.each([
    [null, '/'],
    ['', '/'],
    ['https://evil.example/', '/'],
    ['//evil.example/path', '/'],
    ['/\\evil.example', '/'],
    ['javascript:alert(1)', '/'],
    ['ledger', '/'],
    ['/admin', '/'],
    ['/admin/tenants', '/'],
    ['/login', '/'],
    ['/a\nb', '/'],
  ])('sends a customer from %j to %s', (candidate, expected) => {
    expect(resolveReturnPath(candidate, customer)).toBe(expected);
  });

  it.each([
    ['/', '/admin'],
    ['/ledger', '/admin'],
    ['/admin/login', '/admin'],
    ['/administrator', '/admin'],
  ])('sends an admin from %j to %s', (candidate, expected) => {
    expect(resolveReturnPath(candidate, admin)).toBe(expected);
  });
});

describe('stored return path', () => {
  it('is consumed exactly once', () => {
    rememberReturnPath('/?tab=ledger');
    expect(takeReturnPath()).toBe('/?tab=ledger');
    expect(takeReturnPath()).toBeNull();
  });
});
