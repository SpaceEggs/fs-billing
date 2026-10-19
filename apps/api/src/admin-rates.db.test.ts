import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  adminRateExportResponseSchema,
  adminRateCancelFutureVersionResponseSchema,
  adminRatePreviewResponseSchema,
  adminRatesResponseSchema,
  adminRateVersionResponseSchema,
  adminTenantCreateResponseSchema,
} from '@fs-billing/shared';
import {
  apiConnections,
  createFixture,
  fixtureApi,
  login,
  requestHeaders,
  type Fixture,
} from '../test/support.js';

const connections = apiConnections();
const { api } = fixtureApi(connections);
let fixture: Fixture;
let cookie: string;
beforeAll(async () => {
  fixture = await createFixture(connections);
  cookie = (await login(api, fixture.admin)).cookie;
});
async function create(currency: 'CNY' | 'USD' = 'CNY') {
  const response = await api.inject({
    method: 'POST',
    url: '/api/admin/tenants',
    headers: requestHeaders(cookie),
    payload: {
      code: `RATES${randomUUID().replaceAll('-', '')}`,
      name: '费率测试租户',
      currency,
      settings: { lowBalanceThreshold: '0' },
      initialRates: {
        kind: 'entries',
        entries: [
          {
            iso: '',
            description: '',
            prefix: '1',
            country: '美国',
            rate: '0.0001',
          },
        ],
      },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return adminTenantCreateResponseSchema.parse(response.json());
}
function post(
  tenantId: string,
  suffix: string,
  payload: Record<string, unknown>,
) {
  return api.inject({
    method: 'POST',
    url: `/api/admin/tenants/${tenantId}/rates/${suffix}`,
    headers: requestHeaders(cookie),
    payload,
  });
}
async function rates(tenantId: string) {
  const response = await api.inject({
    url: `/api/admin/tenants/${tenantId}/rates`,
    headers: requestHeaders(cookie),
  });
  expect(response.statusCode, response.body).toBe(200);
  return adminRatesResponseSchema.parse(response.json());
}
function csv(content: string) {
  return {
    filename: 'rates.csv',
    contentBase64: Buffer.from(content).toString('base64'),
  };
}
async function audit(auditId: string | null) {
  if (auditId === null) throw new Error('expected an audit id');
  const result = await connections.owner.pool.query<{
    tenant_id: string;
    action: string;
    details: { content: Record<string, unknown> };
  }>('select tenant_id, action, details from operation_logs where id=$1', [
    auditId,
  ]);
  expect(result.rows).toHaveLength(1);
  return result.rows[0];
}

describe('admin rates HTTP', () => {
  it('imports a Chinese header atomically, preserves precision and audits export', async () => {
    const created = await create();
    const tenantId = created.tenant.id;
    const preview = await post(tenantId, 'import/preview', {
      file: csv(
        'ISO,国家,号码前缀,说明,费率\r\n,美国,1,,0.1234\r\n,中国,86,,0.0001',
      ),
      baseVersionId: created.initialRateVersionId,
      schedule: { kind: 'immediate' },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const parsed = adminRatePreviewResponseSchema.parse(preview.json());
    expect(parsed).toMatchObject({
      ok: true,
      counts: { added: 1, modified: 1, deleted: 0 },
    });
    if (!parsed.ok) throw new Error('Expected valid preview');
    expect((await rates(tenantId)).current.id).toBe(
      created.initialRateVersionId,
    );
    const commit = await post(tenantId, 'import/commit', {
      previewId: parsed.previewId,
    });
    expect(commit.statusCode, commit.body).toBe(200);
    const saved = adminRateVersionResponseSchema.parse(commit.json());
    expect(saved.version.entries).toEqual([
      {
        iso: '',
        description: '',
        prefix: '1',
        country: '美国',
        rate: '0.1234',
      },
      {
        iso: '',
        description: '',
        prefix: '86',
        country: '中国',
        rate: '0.0001',
      },
    ]);
    expect(await audit(saved.auditId)).toMatchObject({
      tenant_id: tenantId,
      action: 'rate_import',
      details: { content: { rateVersionId: saved.version.id } },
    });
    const exported = await post(tenantId, 'export', {
      versionId: saved.version.id,
    });
    expect(exported.statusCode, exported.body).toBe(200);
    const output = adminRateExportResponseSchema.parse(exported.json());
    expect(output.csv.replaceAll('\r\n', '\n').trim()).toBe(
      'ISO,Country,Destination Prefix,Description,Rate\n,美国,1,,0.1234\n,中国,86,,0.0001',
    );
    expect(await audit(output.auditId)).toMatchObject({
      tenant_id: tenantId,
      action: 'rate_export',
    });
  });

  it('reports every invalid physical CSV row and creates no version or audit', async () => {
    const created = await create();
    const tenantId = created.tenant.id;
    const before = await connections.owner.pool.query(
      'select id from operation_logs where tenant_id=$1 order by id',
      [tenantId],
    );
    const response = await post(tenantId, 'import/preview', {
      file: csv(
        'ISO,国家,号码前缀,说明,费率\n,中国,86,,0.001\n,无效,00,,1\n,负数,2,,-1\n,超精度,3,,0.00001',
      ),
      baseVersionId: created.initialRateVersionId,
      schedule: { kind: 'immediate' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const preview = adminRatePreviewResponseSchema.parse(response.json());
    expect(preview.ok).toBe(false);
    if (preview.ok) throw new Error('Expected row errors');
    expect(preview.errors.map((error) => error.line)).toEqual([3, 4, 5]);
    expect(response.json()).not.toHaveProperty('previewId');
    expect((await rates(tenantId)).current.entries).toEqual([
      {
        iso: '',
        description: '',
        prefix: '1',
        country: '美国',
        rate: '0.0001',
      },
    ]);
    expect(
      (
        await connections.owner.pool.query(
          'select id from rate_versions where tenant_id=$1',
          [tenantId],
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await connections.owner.pool.query(
          'select id from operation_logs where tenant_id=$1 order by id',
          [tenantId],
        )
      ).rows,
    ).toEqual(before.rows);
  });

  it('maps wrong tenant versions, stale previews, invalid precision and encoding errors', async () => {
    const first = await create();
    const second = await create();
    const tenantId = first.tenant.id;
    const foreign = await post(tenantId, 'export', {
      versionId: second.initialRateVersionId,
    });
    expect(foreign.statusCode, foreign.body).toBe(404);
    expect(foreign.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    const stale = await post(tenantId, 'import/commit', {
      previewId: randomUUID(),
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'PREVIEW_STALE' } });
    const precision = await post(tenantId, 'edit-entry', {
      baseVersionId: first.initialRateVersionId,
      entry: {
        iso: '',
        description: '',
        prefix: '1',
        country: '美国',
        rate: '0.00001',
      },
      schedule: { kind: 'immediate' },
    });
    expect(precision.statusCode, precision.body).toBe(400);
    expect(precision.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR' },
    });
    const encoding = await post(tenantId, 'import/preview', {
      baseVersionId: first.initialRateVersionId,
      file: { filename: 'bad.csv', contentBase64: '/w==' },
      schedule: { kind: 'immediate' },
    });
    expect(encoding.statusCode, encoding.body).toBe(400);
    expect(encoding.json()).toMatchObject({
      error: { code: 'CSV_ENCODING_UNSUPPORTED' },
    });
  });

  it('cancels only a future version outside the margin and snapshots the complete audit', async () => {
    const created = await create();
    const tenantId = created.tenant.id;
    const current = await post(tenantId, 'cancel-future-version', {
      versionId: created.initialRateVersionId,
    });
    expect(current.statusCode, current.body).toBe(409);
    expect(current.json()).toMatchObject({
      error: { code: 'RATE_VERSION_CONFLICT' },
    });
    const edit = await post(tenantId, 'edit-entry', {
      baseVersionId: created.initialRateVersionId,
      entry: {
        iso: '',
        description: '',
        prefix: '1',
        country: '美国',
        rate: '0.5678',
      },
      schedule: {
        kind: 'scheduled',
        effectiveFrom: new Date(Date.now() + 300_000).toISOString(),
      },
    });
    expect(edit.statusCode, edit.body).toBe(200);
    const scheduled = adminRateVersionResponseSchema.parse(edit.json());
    expect(
      (await rates(tenantId)).scheduled.map((version) => version.id),
    ).toContain(scheduled.version.id);
    const cancel = await post(tenantId, 'cancel-future-version', {
      versionId: scheduled.version.id,
    });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(cancel.json()).toMatchObject({
      cancelledVersionId: scheduled.version.id,
    });
    expect(
      await audit(
        adminRateCancelFutureVersionResponseSchema.parse(cancel.json()).auditId,
      ),
    ).toMatchObject({
      tenant_id: tenantId,
      action: 'rate_schedule_cancel',
      details: {
        content: {
          cancelledVersionId: scheduled.version.id,
          entries: [
            {
              iso: '',
              description: '',
              prefix: '1',
              country: '美国',
              rate: '0.5678',
            },
          ],
        },
      },
    });
    expect((await rates(tenantId)).scheduled).toEqual([]);
    expect((await rates(tenantId)).current.id).toBe(
      created.initialRateVersionId,
    );
    const near = await post(tenantId, 'edit-entry', {
      baseVersionId: created.initialRateVersionId,
      entry: {
        iso: '',
        description: '',
        prefix: '1',
        country: '美国',
        rate: '0.4321',
      },
      schedule: {
        kind: 'scheduled',
        effectiveFrom: new Date(Date.now() + 30_000).toISOString(),
      },
    });
    expect(near.statusCode, near.body).toBe(200);
    const nearVersion = adminRateVersionResponseSchema.parse(near.json());
    const guarded = await post(tenantId, 'cancel-future-version', {
      versionId: nearVersion.version.id,
    });
    expect(guarded.statusCode, guarded.body).toBe(409);
    expect(
      (await rates(tenantId)).scheduled.map((version) => version.id),
    ).toEqual([nearVersion.version.id]);
  });

  it('binds copy to the source path and audits changes against the target', async () => {
    const source = await create();
    const target = await create();
    const preview = await post(source.tenant.id, 'copy/preview', {
      sourceVersionId: source.initialRateVersionId,
      targetTenantId: target.tenant.id,
      targetBaseVersionId: target.initialRateVersionId,
      schedule: { kind: 'immediate' },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const parsed = adminRatePreviewResponseSchema.parse(preview.json());
    if (!parsed.ok) throw new Error('Expected copy preview');
    const wrongPath = await post(target.tenant.id, 'copy/commit', {
      previewId: parsed.previewId,
    });
    expect(wrongPath.statusCode, wrongPath.body).toBe(409);
    const wrongPurpose = await post(source.tenant.id, 'import/commit', {
      previewId: parsed.previewId,
    });
    expect(wrongPurpose.statusCode, wrongPurpose.body).toBe(409);
    const commit = await post(source.tenant.id, 'copy/commit', {
      previewId: parsed.previewId,
    });
    expect(commit.statusCode, commit.body).toBe(200);
    const copied = adminRateVersionResponseSchema.parse(commit.json());
    expect(await audit(copied.auditId)).toMatchObject({
      tenant_id: target.tenant.id,
      action: 'rate_copy',
      details: {
        content: {
          sourceTenantId: source.tenant.id,
          sourceVersionId: source.initialRateVersionId,
          rateVersionId: copied.version.id,
        },
      },
    });
    expect((await rates(target.tenant.id)).current.id).toBe(copied.version.id);
    expect((await rates(source.tenant.id)).current.id).toBe(
      source.initialRateVersionId,
    );
    const usd = await create('USD');
    const mismatch = await post(source.tenant.id, 'copy/preview', {
      sourceVersionId: source.initialRateVersionId,
      targetTenantId: usd.tenant.id,
      targetBaseVersionId: usd.initialRateVersionId,
      schedule: { kind: 'immediate' },
    });
    expect(mismatch.statusCode, mismatch.body).toBe(409);
    expect(mismatch.json()).toMatchObject({
      error: { code: 'CURRENCY_MISMATCH' },
    });
  });

  it('rejects customer identity on every rates operation despite forged admin headers', async () => {
    const created = await create();
    const customer = (await login(api, fixture.a)).cookie;
    const path = `/api/admin/tenants/${created.tenant.id}/rates`;
    const validEdit = {
      baseVersionId: created.initialRateVersionId,
      entry: {
        iso: '',
        description: '',
        prefix: '1',
        country: '美国',
        rate: '0.1234',
      },
      schedule: { kind: 'immediate' },
    };
    for (const [method, suffix, payload] of [
      ['GET', '', undefined],
      ['POST', '/edit-entry', validEdit],
      [
        'POST',
        '/import/preview',
        {
          baseVersionId: created.initialRateVersionId,
          file: csv('ISO,国家,号码前缀,说明,费率\n,美国,1,,0.1234'),
          schedule: { kind: 'immediate' },
        },
      ],
      ['POST', '/import/commit', { previewId: randomUUID() }],
      ['POST', '/export', { versionId: created.initialRateVersionId }],
      [
        'POST',
        '/copy/preview',
        {
          sourceVersionId: created.initialRateVersionId,
          targetTenantId: randomUUID(),
          targetBaseVersionId: randomUUID(),
          schedule: { kind: 'immediate' },
        },
      ],
      ['POST', '/copy/commit', { previewId: randomUUID() }],
      [
        'POST',
        '/cancel-future-version',
        { versionId: created.initialRateVersionId },
      ],
    ] as const) {
      const response = await api.inject({
        method,
        url: path + suffix,
        headers: {
          ...requestHeaders(customer),
          'x-role': 'admin',
          'x-tenant-id': created.tenant.id,
        },
        ...(payload ? { payload } : {}),
      });
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
    expect((await rates(created.tenant.id)).current.id).toBe(
      created.initialRateVersionId,
    );
  });
});
