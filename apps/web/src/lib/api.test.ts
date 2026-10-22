import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminApiContract } from '@fs-billing/shared';
import {
  ApiRequestError,
  apiPath,
  callApi,
  callDownload,
  downloadFilename,
} from './api';

const saved = vi.hoisted(() => [] as [string, Blob][]);
vi.mock('./download', () => ({
  downloadBlob: (filename: string, blob: Blob) =>
    void saved.push([filename, blob]),
}));

const tenantId = '00000000-0000-4000-8000-0000000000aa';

afterEach(() => {
  vi.unstubAllGlobals();
  saved.length = 0;
});

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

describe('callDownload', () => {
  const csvResponse = (init?: ResponseInit) =>
    new Response('\uFEFFcsv', {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition':
          'attachment; filename="cdrs_ABC001_2026-09-01_2026-09-29.csv"',
      },
      ...init,
    });

  it('posts the normalized filters with the cookie and saves the blob under the server filename', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(csvResponse()));
    vi.stubGlobal('fetch', fetchMock);
    const result = await callDownload('portalCdrsExport', {
      body: { from: '2026-09-01', to: '2026-09-29', callee: '+44 7700 900123' },
    });
    expect(result).toEqual({
      filename: 'cdrs_ABC001_2026-09-01_2026-09-29.csv',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('/api/portal/cdrs/export');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      from: '2026-09-01',
      to: '2026-09-29',
      callee: '447700900123',
      status: 'answered',
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]![0]).toBe('cdrs_ABC001_2026-09-01_2026-09-29.csv');
    // BOM 随内容原样保存（Blob.text() 会去掉 BOM，所以比较字节）。
    expect([...new Uint8Array(await saved[0]![1].arrayBuffer())]).toEqual([
      0xef, 0xbb, 0xbf, 0x63, 0x73, 0x76,
    ]);
  });

  it('puts the tenant in the admin path', async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(() =>
      Promise.resolve(csvResponse()),
    );
    vi.stubGlobal('fetch', fetchMock);
    await callDownload('adminTenantCdrsExport', {
      params: { tenantId },
      body: { from: '2026-09-01', to: '2026-09-29', unverifiedOnly: true },
    });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `/api/admin/tenants/${tenantId}/cdrs/export`,
    );
  });

  it('refuses an invalid range before any request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      callDownload('portalCdrsExport', {
        body: { from: '2026-09-01', to: '2026-10-01' },
      }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it('parses a failed response like callApi and saves nothing', async () => {
    stubFetch(429, {
      error: {
        code: 'RATE_LIMITED',
        message: '导出人数过多',
        requestId: 'req-1',
        retryAfterSeconds: 5,
      },
    });
    const error = await callDownload('portalCdrsExport', {
      body: { from: '2026-09-01', to: '2026-09-29' },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    expect(saved).toHaveLength(0);
  });

  it('treats a lost connection before the response as an unknown outcome', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('network'))),
    );
    const error = await callDownload('portalCdrsExport', {
      body: { from: '2026-09-01', to: '2026-09-29' },
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 0, outcomeUnknown: true });
    expect(saved).toHaveLength(0);
  });

  it('does not save a truncated file when the body stream breaks', async () => {
    const broken = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'));
        controller.error(new TypeError('terminated'));
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(broken, {
            status: 200,
            headers: { 'content-type': 'text/csv; charset=utf-8' },
          }),
        ),
      ),
    );
    const error = await callDownload('portalCdrsExport', {
      body: { from: '2026-09-01', to: '2026-09-29' },
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 0, outcomeUnknown: true });
    expect(saved).toHaveLength(0);
  });

  it('does not save a success that is not CSV', async () => {
    stubFetch(200, { hello: 'world' });
    const error = await callDownload('portalCdrsExport', {
      body: { from: '2026-09-01', to: '2026-09-29' },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(saved).toHaveLength(0);
  });
});

describe('downloadFilename', () => {
  it('takes the quoted ASCII filename', () => {
    expect(
      downloadFilename('attachment; filename="cdrs_ABC001_2026-09-01.csv"'),
    ).toBe('cdrs_ABC001_2026-09-01.csv');
  });

  it.each([
    null,
    'attachment',
    'attachment; filename="../etc/passwd"',
    'attachment; filename="a b.csv"',
    'attachment; filename="报表.csv"',
  ])('falls back to export.csv for %j', (header) => {
    expect(downloadFilename(header)).toBe('export.csv');
  });
});
