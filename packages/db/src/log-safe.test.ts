import { describe, expect, test } from 'vitest';
import { maskNumber, redactUrlForLog } from './log-safe.js';

describe('redactUrlForLog（阶段 9 PR 8）', () => {
  test.each([
    // 号码类参数名：整个值掩码
    [
      '/api/admin/tenants/t1/cdrs?callee=8613800138000&page=2',
      '/api/admin/tenants/t1/cdrs?callee=8613*******00(13)&page=2',
    ],
    [
      '/api/portal/cdrs?from=2026-10-01&callee=%2B447700900123&status=all',
      '/api/portal/cdrs?from=2026-10-01&callee=+4477******23(12)&status=all',
    ],
    // 部分号码（前缀搜索）：短的整体隐藏
    ['/api/admin/cdrs?callee=%2B44%207700', '/api/admin/cdrs?callee=+*(6)'],
    ['/api/admin/cdrs?callee=1380', '/api/admin/cdrs?callee=*(4)'],
    // 参数名不是号码类，但取值像号码（含分隔符）
    [
      '/api/admin/tenants?search=86%2013800-138000',
      '/api/admin/tenants?search=8613*******00(13)',
    ],
    ['/x?q=(0755)%2086001234', '/x?q=0755******34(12)'],
    // 大小写不敏感的参数名
    ['/x?Caller=075586001234', `/x?Caller=${maskNumber('075586001234')}`],
  ])('masks phone numbers in %s', (url, expected) => {
    expect(redactUrlForLog(url)).toBe(expected);
  });

  test.each([
    '/api/health',
    '/api/admin/cdrs?page=3&status=answered',
    '/api/admin/tenants?search=ABC001',
    // 日期、金额、UUID 不是号码
    '/api/admin/cdrs?from=2026-10-01&to=2026-10-31',
    '/api/admin/ledger?amount=1234.56&id=0a1b2c3d-0000-4000-8000-000000000001',
    // 不足 7 位数字的取值不当作号码
    '/api/admin/tenants?search=123456',
    '/x?empty=&flag',
  ])('leaves %s unchanged', (url) => {
    expect(redactUrlForLog(url)).toBe(url);
  });

  test('keeps the path, the order and the fragment, and masks every repeated parameter', () => {
    expect(
      redactUrlForLog('/p?callee=8613800138000&a=1&callee=8613912345678#top'),
    ).toBe('/p?callee=8613*******00(13)&a=1&callee=8613*******78(13)#top');
  });

  test('never leaves the middle digits of a number in the result', () => {
    const result = redactUrlForLog(
      '/p?callee=8613800138000&phone=%2B447700900123',
    );
    expect(result).not.toMatch(/13800138|7700900/);
  });

  test('a malformed escape is kept readable and does not throw', () => {
    expect(redactUrlForLog('/p?callee=%E0%A4%A&x=%zz')).toBe(
      '/p?callee=*(2)&x=%zz',
    );
  });

  test('maskNumber is the rule shared by the Worker and the API', () => {
    expect(maskNumber('8613800138000')).toBe('8613*******00(13)');
    expect(maskNumber('+447700900123')).toBe('+4477******23(12)');
    expect(maskNumber('12345')).toBe('*(5)');
  });
});
