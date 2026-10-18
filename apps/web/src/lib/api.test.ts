import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminApiContract } from '@fs-billing/shared';
import { ApiRequestError, apiPath, callApi } from './api';

const tenantId = '00000000-0000-4000-8000-0000000000aa';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn<
    (url: string, init: RequestInit) => Promise<Response>
  >(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('apiPath', () => {
  it('fills path params and serializes the parsed query with defaults', () => {
    expect(
      apiPath(adminApiContract.adminTenantLedger, {
        params: { tenantId },
        query: { kind: 'gift', from: '2026-09-01', to: '2026-09-30' },
      }),
    ).toBe(
      `/api/admin/tenants/${tenantId}/ledger?from=2026-09-01&to=2026-09-30&kind=gift&page=1&pageSize=25`,
    );
  });

  it('encodes search text and omits absent filters', () => {
    expect(
      apiPath(adminApiContract.adminTenants, {
        query: { search: 'ABC 01&x', currency: 'USD', page: 2 },
      }),
    ).toBe(
      '/api/admin/tenants?page=2&pageSize=25&search=ABC+01%26x&currency=USD&sort=status_currency_balance',
    );
  });

  it('rejects a malformed tenant id before any request', () => {
    expect(() =>
      apiPath(adminApiContract.adminTenantDetail, {
        params: { tenantId: '../admins' },
      }),
    ).toThrow();
  });
});

describe('callApi', () => {
  it('sends the contract-normalized body: uppercase code and deduplicated lowercase emails', async () => {
    const fetchMock = stubFetch(409, {
      error: {
        code: 'TENANT_CODE_EXISTS',
        message: '租户编码已存在',
        requestId: 'req-1',
      },
    });
    const request = callApi('adminTenantCreate', {
      body: {
        code: 'abc001',
        name: '深圳市某某科技有限公司',
        currency: 'CNY',
        settings: {
          lowBalanceThreshold: '200',
          emails: ['Ops@Example.com', 'ops@example.com'],
        },
        initialRates: { kind: 'blank' },
      },
    });
    await expect(request).rejects.toMatchObject({
      status: 409,
      code: 'TENANT_CODE_EXISTS',
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/admin/tenants');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      code: 'ABC001',
      name: '深圳市某某科技有限公司',
      currency: 'CNY',
      contactName: '',
      contactPhone: '',
      remark: '',
      settings: { lowBalanceThreshold: '200', emails: ['ops@example.com'] },
      initialRates: { kind: 'blank' },
    });
  });

  it('parses CSV row errors from the admin error union', async () => {
    stubFetch(400, {
      error: {
        code: 'CSV_INVALID',
        message: 'CSV 无效',
        requestId: 'req-2',
        rows: [{ line: 3, reason: '前缀只能包含数字' }],
      },
    });
    const error = await callApi('adminTenants').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).body).toEqual({
      error: {
        code: 'CSV_INVALID',
        message: 'CSV 无效',
        requestId: 'req-2',
        rows: [{ line: 3, reason: '前缀只能包含数字' }],
      },
    });
  });

  it('posts parameterless admin commands without a body', async () => {
    const fetchMock = stubFetch(200, { auditId: null });
    await expect(
      callApi('adminTenantEnable', { params: { tenantId } }),
    ).resolves.toEqual({ auditId: null });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/admin/tenants/${tenantId}/enable`);
    expect(init?.body).toBeUndefined();
  });

  it('a success whose body cannot be read is an unknown outcome, not a schema error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start: (controller) =>
                controller.error(new TypeError('network error')),
            }),
            { status: 200 },
          ),
        ),
      ),
    );
    const error = await callApi('adminTenantEnable', {
      params: { tenantId },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 200, outcomeUnknown: true });
  });

  it('a success that does not match the contract is an unknown outcome', async () => {
    stubFetch(200, { unexpected: true });
    await expect(
      callApi('adminTenantEnable', { params: { tenantId } }),
    ).rejects.toMatchObject({ status: 200, outcomeUnknown: true });
  });

  it('an error response is not a lost response', async () => {
    stubFetch(503, {
      error: { code: 'SERVICE_UNAVAILABLE', message: '不可用', requestId: 'r' },
    });
    await expect(callApi('adminTenants')).rejects.toMatchObject({
      status: 503,
      outcomeUnknown: false,
    });
  });
});
