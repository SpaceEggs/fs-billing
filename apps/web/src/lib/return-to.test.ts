import { createMemoryHistory } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import type { Identity } from '@fs-billing/shared';
import { createQueryClient } from '../query-client';
import { createAppRouter } from '../router';
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

const router = createAppRouter(createQueryClient(), createMemoryHistory());

describe('resolveReturnPath', () => {
  it('returns to a same-zone path with its query and hash', () => {
    expect(resolveReturnPath('/ledger?type=充值#top', customer, router)).toBe(
      '/ledger?type=%E5%85%85%E5%80%BC#top',
    );
    expect(resolveReturnPath('/admin/tenants?page=2', admin, router)).toBe(
      '/admin/tenants?page=2',
    );
  });

  it('keeps encoded slashes and malformed escapes as same-origin paths', () => {
    expect(resolveReturnPath('/a/../%2fevil.example', customer, router)).toBe(
      '/%2fevil.example',
    );
    expect(resolveReturnPath('/%E0%A4%A', customer, router)).toBe('/%E0%A4%A');
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
    ['/login/', '/'],
    ['/%6cogin', '/'],
    ['/LOGIN', '/'],
    ['/%61dmin', '/'],
    ['/Admin/tenants', '/'],
    ['/a/..//evil.example', '/'],
  ])('sends a customer from %j to %s', (candidate, expected) => {
    expect(resolveReturnPath(candidate, customer, router)).toBe(expected);
  });

  it.each([
    ['/', '/admin'],
    ['/ledger', '/admin'],
    ['/admin/login', '/admin'],
    ['/administrator', '/admin'],
    ['/admin/login/', '/admin'],
    ['/admin/%6cogin', '/admin'],
    ['/ADMIN/LOGIN', '/admin'],
  ])('sends an admin from %j to %s', (candidate, expected) => {
    expect(resolveReturnPath(candidate, admin, router)).toBe(expected);
  });
});

describe('stored return path', () => {
  it('is consumed exactly once', () => {
    rememberReturnPath('/?tab=ledger');
    expect(takeReturnPath()).toBe('/?tab=ledger');
    expect(takeReturnPath()).toBeNull();
  });

  it('survives a page reload through sessionStorage', () => {
    rememberReturnPath('/?tab=ledger');
    takeReturnPath(null);
    sessionStorage.setItem('fs-billing.return-to', '/?tab=calls');
    expect(takeReturnPath()).toBe('/?tab=calls');
  });

  it('falls back to memory when storage throws', () => {
    const broken = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
      removeItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    } as unknown as Storage;
    expect(() => rememberReturnPath('/?tab=ledger', broken)).not.toThrow();
    expect(takeReturnPath(broken)).toBe('/?tab=ledger');
    expect(takeReturnPath(broken)).toBeNull();
  });

  it('falls back to memory when sessionStorage is unavailable', () => {
    rememberReturnPath('/?tab=ledger', null);
    expect(takeReturnPath(null)).toBe('/?tab=ledger');
  });
});
