import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  adminRatePreviewResponseSchema,
  adminRateVersionResponseSchema,
  adminRateExportResponseSchema,
  adminRateCancelFutureVersionResponseSchema,
  createAdminRateRequestSchemas,
} from '@fs-billing/shared';
import {
  connections,
  adminId,
  backendPid,
  deferred,
  waitForTenantLock,
} from '../../test/support.js';
import { lockTenants, withAdmin } from '../client.js';
import { databaseNow } from '../clock.js';
import { operationLogs, rateVersions } from '../schema.js';
import { createTenant } from './tenants.js';
import { createAdminRatesService } from './rates.js';

const { app, owner } = connections();
let actor: { id: string; name: string };
beforeAll(async () => {
  actor = { id: await adminId(owner), name: '费率管理员' };
});
async function fixture(currency: 'CNY' | 'USD' = 'CNY') {
  const result = await createTenant({
    db: app.db,
    actor,
    creatorEmail: 'admin@example.com',
    request: {
      code: `R${randomUUID().replaceAll('-', '')}`,
      name: '费率测试',
      currency,
      contactName: '',
      contactPhone: '',
      remark: '',
      settings: { lowBalanceThreshold: '10' },
      initialRates: {
        kind: 'entries',
        entries: [{ prefix: '86', country: '中国', rate: '0.1234' }],
      },
    },
  });
  return {
    db: app.db,
    actor,
    tenantId: result.tenant.id,
    baseVersionId: result.initialRateVersionId,
  };
}
const file = (text: string) => ({
  filename: 'rates.csv',
  contentBase64: Buffer.from(text).toString('base64'),
});
const entry = {
  prefix: '1',
  country: '美国',
  rate: '999999999999999999999999.0001',
};
async function snapshot(tenantId: string) {
  return withAdmin(app.db, async (tx) => ({
    versions: await tx
      .select()
      .from(rateVersions)
      .where(eq(rateVersions.tenantId, tenantId)),
    logs: await tx
      .select()
      .from(operationLogs)
      .where(eq(operationLogs.tenantId, tenantId)),
  }));
}

describe('admin rates service', () => {
  it('edits a complete version with exact precision and database immediate time plus audit', async () => {
    const context = await fixture();
    const service = createAdminRatesService();
    const result = adminRateVersionResponseSchema.parse(
      await service.editRate({
        ...context,
        request: {
          baseVersionId: context.baseVersionId,
          entry,
          schedule: { kind: 'immediate' },
        },
      }),
    );
    expect(result.version.entries).toEqual([
      entry,
      { prefix: '86', country: '中国', rate: '0.1234' },
    ]);
    const [instant] = await withAdmin(app.db, (tx) =>
      tx
        .select({
          immediate: sql<boolean>`${rateVersions.effectiveFrom} <= now()`,
        })
        .from(rateVersions)
        .where(eq(rateVersions.id, result.version.id)),
    );
    expect(instant?.immediate).toBe(true);
    expect(
      (await snapshot(context.tenantId)).logs.find(
        (log) => log.id === result.auditId,
      ),
    ).toMatchObject({
      action: 'rate_entry_edit',
      tenantId: context.tenantId,
      target: result.version.id,
    });
    expect((await service.getRates({ ...context, query: {} })).current).toEqual(
      result.version,
    );
    await expect(
      service.editRate({
        ...context,
        request: {
          baseVersionId: context.baseVersionId,
          entry,
          schedule: { kind: 'immediate' },
        },
      }),
    ).rejects.toMatchObject({ code: 'RATE_VERSION_CONFLICT' });
  });

  it('invalid CSV reports all physical rows and writes no versions or audits', async () => {
    const context = await fixture();
    const service = createAdminRatesService();
    const before = await snapshot(context.tenantId);
    const result = adminRatePreviewResponseSchema.parse(
      await service.importPreview({
        ...context,
        request: {
          baseVersionId: context.baseVersionId,
          file: file(
            `前缀,国家,费率\n86,中国,0.0001\n001,坏,1\n2,坏,-1\n3,${'国'.repeat(201)},0.1\n86,重复,0.2`,
          ),
          schedule: { kind: 'immediate' },
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('预期 CSV 校验失败');
    expect(result.errors.map((error) => error.line)).toEqual([3, 4, 5, 6]);
    expect(result).not.toHaveProperty('previewId');
    expect(await snapshot(context.tenantId)).toEqual(before);
  });

  it('Chinese CSV preview binds actor purpose and path and commits all rows once', async () => {
    const context = await fixture();
    const service = createAdminRatesService();
    const before = await snapshot(context.tenantId);
    const preview = await service.importPreview({
      ...context,
      request: {
        baseVersionId: context.baseVersionId,
        file: file(
          '\ufeff前缀,国家,费率\r\n86,中国,0.2345\r\n1,美国,0.0001\r\n',
        ),
        schedule: { kind: 'immediate' },
      },
    });
    expect(preview).toMatchObject({
      ok: true,
      encoding: 'UTF-8',
      counts: { added: 1, modified: 1, deleted: 0 },
    });
    expect(await snapshot(context.tenantId)).toEqual(before);
    if (!preview.ok) throw new Error('预期 CSV 成功');
    const request = { previewId: preview.previewId };
    await expect(
      service.importCommit({
        ...context,
        actor: { id: randomUUID(), name: '另一管理员' },
        request,
      }),
    ).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
    await expect(
      service.copyCommit({ ...context, request }),
    ).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
    await expect(
      service.importCommit({ ...context, tenantId: randomUUID(), request }),
    ).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
    const result = await service.importCommit({ ...context, request });
    expect(result.version.entries).toEqual([
      { prefix: '1', country: '美国', rate: '0.0001' },
      { prefix: '86', country: '中国', rate: '0.2345' },
    ]);
    expect(
      (await snapshot(context.tenantId)).logs.find(
        (log) => log.id === result.auditId,
      ),
    ).toMatchObject({ action: 'rate_import' });
    await expect(
      service.importCommit({ ...context, request }),
    ).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
    expect((await snapshot(context.tenantId)).versions).toHaveLength(2);
  });

  it('rejects stale previews after another version commits without partial writes', async () => {
    const context = await fixture();
    const service = createAdminRatesService();
    const preview = await service.importPreview({
      ...context,
      request: {
        baseVersionId: context.baseVersionId,
        file: file('1,美国,0.1'),
        schedule: { kind: 'immediate' },
      },
    });
    if (!preview.ok) throw new Error('预期成功');
    await service.editRate({
      ...context,
      request: {
        baseVersionId: context.baseVersionId,
        entry,
        schedule: { kind: 'immediate' },
      },
    });
    const before = await snapshot(context.tenantId);
    await expect(
      service.importCommit({
        ...context,
        request: { previewId: preview.previewId },
      }),
    ).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
    expect(await snapshot(context.tenantId)).toEqual(before);
  });

  it('expires configured TTL and rechecks stored schedule at commit', async () => {
    const context = await fixture();
    for (const expiresBySchedule of [false, true]) {
      const service = createAdminRatesService({
        previewTtlMs: expiresBySchedule ? 60000 : 15,
      });
      const preview = await service.importPreview({
        ...context,
        request: {
          baseVersionId: context.baseVersionId,
          file: file('1,美国,0.1'),
          schedule: expiresBySchedule
            ? {
                kind: 'scheduled',
                effectiveFrom: new Date(Date.now() + 500).toISOString(),
              }
            : { kind: 'immediate' },
        },
      });
      if (!preview.ok) throw new Error('预期成功');
      const before = await snapshot(context.tenantId);
      await new Promise((resolve) =>
        setTimeout(resolve, expiresBySchedule ? 550 : 40),
      );
      await expect(
        service.importCommit({
          ...context,
          request: { previewId: preview.previewId },
        }),
      ).rejects.toMatchObject({
        code: expiresBySchedule ? 'PREVIEW_STALE' : 'PREVIEW_EXPIRED',
      });
      expect(await snapshot(context.tenantId)).toEqual(before);
    }
  });

  it('uses configured horizon for edit import copy and commit', async () => {
    const context = await fixture();
    const target = await fixture();
    const service = createAdminRatesService({
      rateRequests: createAdminRateRequestSchemas(1000),
    });
    const schedule = {
      kind: 'scheduled',
      effectiveFrom: new Date(Date.now() + 60000).toISOString(),
    } as const;
    await expect(
      service.editRate({
        ...context,
        request: { baseVersionId: context.baseVersionId, entry, schedule },
      }),
    ).rejects.toThrow();
    await expect(
      service.importPreview({
        ...context,
        request: {
          baseVersionId: context.baseVersionId,
          file: file('1,美国,0.1'),
          schedule,
        },
      }),
    ).rejects.toThrow();
    await expect(
      service.copyPreview({
        ...context,
        request: {
          sourceVersionId: context.baseVersionId,
          targetTenantId: target.tenantId,
          targetBaseVersionId: target.baseVersionId,
          schedule,
        },
      }),
    ).rejects.toThrow();
    expect((await snapshot(context.tenantId)).versions).toHaveLength(1);
  });

  it('enforces decoded byte and row limits before writes', async () => {
    const context = await fixture();
    const request = {
      baseVersionId: context.baseVersionId,
      file: file('1,美国,0.1\n86,中国,0.2'),
      schedule: { kind: 'immediate' } as const,
    };
    await expect(
      createAdminRatesService({ maxCsvBytes: 2 }).importPreview({
        ...context,
        request,
      }),
    ).rejects.toMatchObject({ code: 'CSV_LIMIT_EXCEEDED' });
    await expect(
      createAdminRatesService({ maxRows: 1 }).importPreview({
        ...context,
        request,
      }),
    ).rejects.toMatchObject({ code: 'CSV_LIMIT_EXCEEDED' });
    expect((await snapshot(context.tenantId)).versions).toHaveLength(1);
  });

  it('copy uses source path and writes only target audit with ownership and currency checks', async () => {
    const source = await fixture();
    const target = await fixture();
    const usd = await fixture('USD');
    const service = createAdminRatesService();
    const request = {
      sourceVersionId: source.baseVersionId,
      targetTenantId: target.tenantId,
      targetBaseVersionId: target.baseVersionId,
      schedule: { kind: 'immediate' } as const,
    };
    await expect(
      service.copyPreview({ ...target, request }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      service.copyPreview({
        ...source,
        request: { ...request, sourceVersionId: target.baseVersionId },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.copyPreview({
        ...source,
        request: {
          ...request,
          targetTenantId: usd.tenantId,
          targetBaseVersionId: usd.baseVersionId,
        },
      }),
    ).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH' });
    const preview = await service.copyPreview({ ...source, request });
    if (!preview.ok) throw new Error('预期成功');
    const before = await snapshot(source.tenantId);
    await expect(
      service.copyCommit({
        ...target,
        request: { previewId: preview.previewId },
      }),
    ).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
    const result = await service.copyCommit({
      ...source,
      request: { previewId: preview.previewId },
    });
    expect(await snapshot(source.tenantId)).toEqual(before);
    expect(
      (await snapshot(target.tenantId)).logs.find(
        (log) => log.id === result.auditId,
      ),
    ).toMatchObject({
      tenantId: target.tenantId,
      action: 'rate_copy',
      target: result.version.id,
      details: {
        content: {
          sourceTenantId: source.tenantId,
          sourceVersionId: source.baseVersionId,
        },
      },
    });
  });

  it('exports four decimal CSV and a same transaction audit', async () => {
    const context = await fixture();
    const service = createAdminRatesService();
    const result = adminRateExportResponseSchema.parse(
      await service.exportRates({
        ...context,
        request: { versionId: context.baseVersionId },
      }),
    );
    expect(result.csv).toBe('prefix,country,rate\n86,中国,0.1234\n');
    expect(
      (await snapshot(context.tenantId)).logs.find(
        (log) => log.id === result.auditId,
      ),
    ).toMatchObject({ action: 'rate_export', target: context.baseVersionId });
    await expect(
      service.exportRates({
        ...context,
        request: { versionId: (await fixture()).baseVersionId },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('cancels only future versions beyond configured margin and audits full entries', async () => {
    const context = await fixture();
    const service = createAdminRatesService({
      cancelClockSkewMarginSeconds: 300,
    });
    await expect(
      service.cancelFutureVersion({
        ...context,
        request: { versionId: context.baseVersionId },
      }),
    ).rejects.toMatchObject({ code: 'RATE_VERSION_CONFLICT' });
    await expect(
      service.cancelFutureVersion({
        ...context,
        request: { versionId: randomUUID() },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const scheduled = await service.editRate({
      ...context,
      request: {
        baseVersionId: context.baseVersionId,
        entry,
        schedule: {
          kind: 'scheduled',
          effectiveFrom: new Date(Date.now() + 120000).toISOString(),
        },
      },
    });
    const before = await snapshot(context.tenantId);
    await expect(
      service.cancelFutureVersion({
        ...context,
        request: { versionId: scheduled.version.id },
      }),
    ).rejects.toMatchObject({ code: 'RATE_VERSION_CONFLICT' });
    expect(await snapshot(context.tenantId)).toEqual(before);
    const cancelled = adminRateCancelFutureVersionResponseSchema.parse(
      await createAdminRatesService({
        cancelClockSkewMarginSeconds: 0,
      }).cancelFutureVersion({
        ...context,
        request: { versionId: scheduled.version.id },
      }),
    );
    const after = await snapshot(context.tenantId);
    expect(after.versions.map((version) => version.id)).toEqual([
      context.baseVersionId,
    ]);
    expect(
      after.logs.find((log) => log.id === cancelled.auditId),
    ).toMatchObject({
      action: 'rate_schedule_cancel',
      details: {
        content: {
          cancelledVersionId: scheduled.version.id,
          entries: scheduled.version.entries,
        },
      },
    });
  });

  it('rejects cancellation exactly at the configured database clock margin', async () => {
    const context = await fixture();
    const service = createAdminRatesService({
      cancelClockSkewMarginSeconds: 60,
    });
    await withAdmin(app.db, async (tx) => {
      const now = await databaseNow(tx);
      const effectiveFrom = new Date(now.getTime() + 60000).toISOString();
      const scheduled = await service.editRate({
        ...context,
        db: tx,
        request: {
          baseVersionId: context.baseVersionId,
          entry,
          schedule: { kind: 'scheduled', effectiveFrom },
        },
      });
      await expect(
        service.cancelFutureVersion({
          ...context,
          db: tx,
          request: { versionId: scheduled.version.id },
        }),
      ).rejects.toMatchObject({ code: 'RATE_VERSION_CONFLICT' });
      const cancellations = await tx
        .select()
        .from(operationLogs)
        .where(eq(operationLogs.action, 'rate_schedule_cancel'));
      expect(
        cancellations.some((log) => log.tenantId === context.tenantId),
      ).toBe(false);
    });
    expect((await snapshot(context.tenantId)).versions).toHaveLength(2);
  });

  it('maps activation during a tenant lock wait to conflict and rolls back cancellation audit', async () => {
    const context = await fixture();
    const service = createAdminRatesService({
      cancelClockSkewMarginSeconds: 0,
    });
    const scheduled = await service.editRate({
      ...context,
      request: {
        baseVersionId: context.baseVersionId,
        entry,
        schedule: {
          kind: 'scheduled',
          effectiveFrom: new Date(Date.now() + 1000).toISOString(),
        },
      },
    });
    const ready = deferred();
    const release = deferred();
    const blocker = withAdmin(app.db, async (tx) => {
      await lockTenants(tx, [context.tenantId]);
      ready.resolve();
      await release.promise;
    });
    await ready.promise;
    const pid = deferred<number>();
    const cancel = withAdmin(app.db, async (tx) => {
      pid.resolve(await backendPid(tx));
      return service.cancelFutureVersion({
        ...context,
        db: tx,
        request: { versionId: scheduled.version.id },
      });
    });
    const rejected = expect(cancel).rejects.toMatchObject({
      code: 'RATE_VERSION_CONFLICT',
    });
    try {
      await waitForTenantLock(owner, await pid.promise, context.tenantId);
      await new Promise((resolve) => setTimeout(resolve, 1100));
    } finally {
      release.resolve();
    }
    await blocker;
    await rejected;
    const after = await snapshot(context.tenantId);
    expect(
      after.versions.some((version) => version.id === scheduled.version.id),
    ).toBe(true);
    expect(
      after.logs.filter((log) => log.action === 'rate_schedule_cancel'),
    ).toEqual([]);
  });
});
