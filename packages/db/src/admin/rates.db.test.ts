import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { z } from 'zod';
import {
  adminRatePreviewResponseSchema,
  adminRateVersionResponseSchema,
  adminRateExportResponseSchema,
  adminRateCancelFutureVersionResponseSchema,
  createAdminRateRequestSchemas,
  DEFAULT_ADMIN_RATE_MAX_ROWS,
} from '@fs-billing/shared';
import {
  connections,
  adminId,
  backendPid,
  deferred,
  waitForTenantLock,
} from '../../test/support.js';
import { connect, lockTenants, withAdmin, withTenant } from '../client.js';
import { databaseNow } from '../clock.js';
import { adminRatePreviews, operationLogs, rateVersions } from '../schema.js';
import { createTenant } from './tenants.js';
import { createAdminRatesService } from './rates.js';
import { ratePreviewPayloadSchema } from './rate-preview.js';

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
        entries: [
          {
            iso: '',
            description: '',
            prefix: '86',
            country: '中国',
            rate: '0.1234',
          },
        ],
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
  contentBase64: Buffer.from(
    text.startsWith(',')
      ? `ISO,Country,Destination Prefix,Description,Rate\n${text}`
      : text,
  ).toString('base64'),
});
const entry = {
  iso: '',
  description: '',
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
      .where(eq(operationLogs.tenantId, tenantId))
      // 不排序时是堆里的物理顺序，会随空闲空间复用变化，`logs.at(-1)` 就不是最新的一条。
      .orderBy(operationLogs.createdAt),
  }));
}

describe('admin rates service', () => {
  it('reads only preview identity before the tenant lock and parses the full payload once afterward', async () => {
    const context = await fixture();
    const service = createAdminRatesService();
    const preview = await service.importPreview({
      ...context,
      request: {
        baseVersionId: context.baseVersionId,
        file: file(',美国,1,,0.1'),
        schedule: { kind: 'immediate' },
      },
    });
    if (!preview.ok) throw new Error('Expected successful preview');
    const parse = vi.spyOn(ratePreviewPayloadSchema, 'safeParse');
    const reads = vi.spyOn(pg.Client.prototype, 'query');
    try {
      await service.importCommit({
        ...context,
        request: { previewId: preview.previewId },
      });
      expect(parse).toHaveBeenCalledTimes(1);
      const statements = reads.mock.calls.map(([query]) =>
        z
          .union([
            z.string(),
            z.object({ text: z.string() }).transform((value) => value.text),
          ])
          .parse(query),
      );
      const previewReads = statements.filter((statement) =>
        statement.includes('from "admin_rate_previews"'),
      );
      expect(previewReads).toHaveLength(2);
      expect(previewReads[0]).toContain('select "tenant_id", "consumed_at",');
      for (const key of ['kind', 'pathTenantId', 'actorId'])
        expect(previewReads[0]).toContain(`"payload"->>'${key}'`);
      expect(previewReads[0]).not.toContain('"expires_at"');
      expect(previewReads[1]).toContain('"payload", "expires_at"');
      const lockIndex = statements.findIndex((statement) =>
        statement.includes('lock_tenants'),
      );
      expect(statements.indexOf(previewReads[0]!)).toBeLessThan(lockIndex);
      expect(statements.indexOf(previewReads[1]!)).toBeGreaterThan(lockIndex);
    } finally {
      parse.mockRestore();
      reads.mockRestore();
    }
  });

  it.each(['actor', 'consumed', 'kind', 'path'] as const)(
    'rejects a stale %s before waiting for the target tenant lock',
    async (reason) => {
      const context = await fixture();
      const service = createAdminRatesService();
      const preview = await service.importPreview({
        ...context,
        request: {
          baseVersionId: context.baseVersionId,
          file: file(',美国,1,,0.1'),
          schedule: { kind: 'immediate' },
        },
      });
      if (!preview.ok) throw new Error('Expected successful preview');
      const request = { previewId: preview.previewId };
      if (reason === 'consumed')
        await service.importCommit({ ...context, request });
      const ready = deferred();
      const release = deferred();
      const blocker = withAdmin(app.db, async (tx) => {
        await lockTenants(tx, [context.tenantId]);
        ready.resolve();
        await release.promise;
      });
      await ready.promise;
      const input = {
        ...context,
        actor:
          reason === 'actor'
            ? { id: randomUUID(), name: 'Other admin' }
            : context.actor,
        tenantId: reason === 'path' ? randomUUID() : context.tenantId,
        request,
      };
      const committing =
        reason === 'kind'
          ? service.copyCommit(input)
          : service.importCommit(input);
      const rejected = expect(committing).rejects.toMatchObject({
        code: 'PREVIEW_STALE',
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          rejected,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () =>
                reject(new Error('Stale preview waited for the tenant lock')),
              2000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
        release.resolve();
        await blocker;
        await rejected;
      }
    },
  );

  it('accepts case-insensitive actor and path identities in both preflight and locked checks', async () => {
    const context = await fixture();
    const service = createAdminRatesService();
    const preview = await service.importPreview({
      ...context,
      request: {
        baseVersionId: context.baseVersionId,
        file: file(',美国,1,,0.1'),
        schedule: { kind: 'immediate' },
      },
    });
    if (!preview.ok) throw new Error('Expected successful preview');
    await owner.pool.query(
      "UPDATE admin_rate_previews SET payload = jsonb_set(jsonb_set(payload, '{actorId}', to_jsonb(upper(payload->>'actorId'))), '{pathTenantId}', to_jsonb(upper(payload->>'pathTenantId'))) WHERE id=$1",
      [preview.previewId],
    );
    const result = await service.importCommit({
      ...context,
      tenantId: context.tenantId.toUpperCase(),
      actor: { ...context.actor, id: context.actor.id.toUpperCase() },
      request: { previewId: preview.previewId },
    });
    expect(result.version.entries).toEqual([
      { iso: '', description: '', prefix: '1', country: '美国', rate: '0.1' },
    ]);
  });

  it('maps incompatible persisted payloads to PREVIEW_STALE without consuming them or writing rates', async () => {
    const context = await fixture();
    const service = createAdminRatesService();
    const preview = await service.importPreview({
      ...context,
      request: {
        baseVersionId: context.baseVersionId,
        file: file(',美国,1,,0.1'),
        schedule: { kind: 'immediate' },
      },
    });
    if (!preview.ok) throw new Error('Expected successful preview');
    const before = await snapshot(context.tenantId);
    await owner.pool.query(
      'UPDATE admin_rate_previews SET payload = jsonb_set(payload, \'{schedule}\', \'{"kind":"unsupported"}\') WHERE id = $1',
      [preview.previewId],
    );
    await expect(
      service.importCommit({
        ...context,
        request: { previewId: preview.previewId },
      }),
    ).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
    expect(await snapshot(context.tenantId)).toEqual(before);
    expect(
      (
        await owner.pool.query(
          'SELECT consumed_at FROM admin_rate_previews WHERE id = $1',
          [preview.previewId],
        )
      ).rows,
    ).toEqual([{ consumed_at: null }]);
  });
  it.each(['import', 'copy'] as const)(
    'shares %s previews across instances and consumes concurrent commits once',
    async (kind) => {
      const source = await fixture();
      const target = kind === 'copy' ? await fixture() : source;
      const first = createAdminRatesService();
      const preview =
        kind === 'import'
          ? await first.importPreview({
              ...source,
              request: {
                baseVersionId: source.baseVersionId,
                file: file(',美国,1,,0.1'),
                schedule: { kind: 'immediate' },
              },
            })
          : await first.copyPreview({
              ...source,
              request: {
                sourceVersionId: source.baseVersionId,
                targetTenantId: target.tenantId,
                targetBaseVersionId: target.baseVersionId,
                schedule: { kind: 'immediate' },
              },
            });
      if (!preview.ok) throw new Error('Expected successful preview');
      const secondConnection = connect(inject('appUrl'), { max: 2 });
      const before = await snapshot(target.tenantId);
      try {
        const commit = () => {
          const instance = createAdminRatesService();
          const input = {
            ...source,
            db: secondConnection.db,
            request: { previewId: preview.previewId },
          };
          return kind === 'import'
            ? instance.importCommit(input)
            : instance.copyCommit(input);
        };
        const results = await Promise.allSettled([commit(), commit()]);
        expect(
          results.filter((result) => result.status === 'fulfilled'),
        ).toHaveLength(1);
        expect(
          results.find((result) => result.status === 'rejected'),
        ).toMatchObject({ reason: { code: 'PREVIEW_STALE' } });
        const after = await snapshot(target.tenantId);
        expect(after.versions).toHaveLength(before.versions.length + 1);
        expect(after.logs).toHaveLength(before.logs.length + 1);
        expect(after.logs.at(-1)?.action).toBe(
          kind === 'import' ? 'rate_import' : 'rate_copy',
        );
        await expect(commit()).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
      } finally {
        await secondConnection.pool.end();
      }
    },
  );

  it('rolls preview consumption and version back when audit validation fails and allows a fresh instance retry', async () => {
    const context = await fixture();
    const preview = await createAdminRatesService().importPreview({
      ...context,
      request: {
        baseVersionId: context.baseVersionId,
        file: file(',美国,1,,0.1'),
        schedule: { kind: 'immediate' },
      },
    });
    if (!preview.ok) throw new Error('Expected successful preview');
    const before = await snapshot(context.tenantId);
    await expect(
      createAdminRatesService().importCommit({
        ...context,
        actor: { ...context.actor, name: '' },
        request: { previewId: preview.previewId },
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(await snapshot(context.tenantId)).toEqual(before);
    await createAdminRatesService().importCommit({
      ...context,
      request: { previewId: preview.previewId },
    });
    expect((await snapshot(context.tenantId)).versions).toHaveLength(2);
  });

  it('checks database expiry after waiting for the target tenant lock', async () => {
    const context = await fixture();
    const preview = await createAdminRatesService().importPreview({
      ...context,
      request: {
        baseVersionId: context.baseVersionId,
        file: file(',美国,1,,0.1'),
        schedule: { kind: 'immediate' },
      },
    });
    if (!preview.ok) throw new Error('Expected successful preview');
    const ready = deferred();
    const release = deferred();
    const blocker = withAdmin(app.db, async (tx) => {
      await lockTenants(tx, [context.tenantId]);
      ready.resolve();
      await release.promise;
    });
    await ready.promise;
    const pid = deferred<number>();
    const committing = withAdmin(app.db, async (tx) => {
      pid.resolve(await backendPid(tx));
      return createAdminRatesService().importCommit({
        ...context,
        db: tx,
        request: { previewId: preview.previewId },
      });
    });
    const rejection = expect(committing).rejects.toMatchObject({
      code: 'PREVIEW_EXPIRED',
    });
    try {
      await waitForTenantLock(owner, await pid.promise, context.tenantId);
      await owner.pool.query(
        "UPDATE admin_rate_previews SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
        [preview.previewId],
      );
    } finally {
      release.resolve();
    }
    await blocker;
    await rejection;
    expect((await snapshot(context.tenantId)).versions).toHaveLength(1);
  });

  it('hides previews from tenant scope and cleans old expired records on new previews', async () => {
    const context = await fixture();
    const makePreview = () =>
      createAdminRatesService().importPreview({
        ...context,
        request: {
          baseVersionId: context.baseVersionId,
          file: file(',美国,1,,0.1'),
          schedule: { kind: 'immediate' },
        },
      });
    const preview = await makePreview();
    if (!preview.ok) throw new Error('Expected successful preview');
    expect(
      await withTenant(app.db, context.tenantId, (tx) =>
        tx.select().from(adminRatePreviews),
      ),
    ).toEqual([]);
    await expect(
      withTenant(app.db, context.tenantId, (tx) =>
        tx.execute(
          sql`insert into admin_rate_previews (tenant_id, payload, expires_at) values (${context.tenantId}, '{}'::jsonb, now())`,
        ),
      ),
    ).rejects.toThrow();
    await owner.pool.query(
      "UPDATE admin_rate_previews SET expires_at = clock_timestamp() - interval '2 days' WHERE id = $1",
      [preview.previewId],
    );
    await makePreview();
    expect(
      (
        await owner.pool.query(
          'SELECT id FROM admin_rate_previews WHERE id = $1',
          [preview.previewId],
        )
      ).rows,
    ).toEqual([]);
  });

  it('accepts exactly the CSV row limit and rejects one extra row before saving a preview', async () => {
    const context = await fixture();
    const service = createAdminRatesService();
    const rows = Array.from(
      { length: DEFAULT_ADMIN_RATE_MAX_ROWS },
      (_, index) => `,测试,${index + 10000},,0.1`,
    );
    const preview = await service.importPreview({
      ...context,
      request: {
        baseVersionId: context.baseVersionId,
        file: file(
          'ISO,Country,Destination Prefix,Description,Rate\n' + rows.join('\n'),
        ),
        schedule: { kind: 'immediate' },
      },
    });
    expect(preview).toMatchObject({
      ok: true,
      counts: { added: DEFAULT_ADMIN_RATE_MAX_ROWS },
    });
    rows.push(',额外,99999,,0.1');
    await expect(
      service.importPreview({
        ...context,
        request: {
          baseVersionId: context.baseVersionId,
          file: file(
            'ISO,Country,Destination Prefix,Description,Rate\n' +
              rows.join('\n'),
          ),
          schedule: { kind: 'immediate' },
        },
      }),
    ).rejects.toMatchObject({ code: 'CSV_LIMIT_EXCEEDED' });
    expect((await snapshot(context.tenantId)).versions).toHaveLength(1);
  });

  it('rejects multiline edits without writes and reimports exported quoted countries', async () => {
    const context = await fixture();
    const service = createAdminRatesService();
    const before = await snapshot(context.tenantId);
    for (const country of [
      '英\n国',
      '英\r国',
      '英\r\n国',
      '\n英国',
      '英国\r',
    ]) {
      await expect(
        service.editRate({
          ...context,
          request: {
            baseVersionId: context.baseVersionId,
            entry: {
              iso: '',
              description: '',
              prefix: '44',
              country,
              rate: '0.0400',
            },
            schedule: { kind: 'immediate' },
          },
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect(await snapshot(context.tenantId)).toEqual(before);
    const edited = await service.editRate({
      ...context,
      request: {
        baseVersionId: context.baseVersionId,
        entry: {
          iso: '',
          description: '',
          prefix: '44',
          country: '英国,"手机"',
          rate: '0.0400',
        },
        schedule: { kind: 'immediate' },
      },
    });
    const exported = await service.exportRates({
      ...context,
      request: { versionId: edited.version.id },
    });
    expect(exported.csv).toContain(',"英国,""手机""",44,,0.0400');
    const preview = await service.importPreview({
      ...context,
      request: {
        baseVersionId: edited.version.id,
        file: file(exported.csv),
        schedule: { kind: 'immediate' },
      },
    });
    expect(preview).toMatchObject({
      ok: true,
      counts: { added: 0, modified: 0, deleted: 0 },
    });
    if (!preview.ok) throw new Error('预期导出的 CSV 可重新导入');
    const imported = await service.importCommit({
      ...context,
      request: { previewId: preview.previewId },
    });
    expect(imported.version.entries).toEqual(edited.version.entries);
  });

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
      {
        iso: '',
        description: '',
        prefix: '86',
        country: '中国',
        rate: '0.1234',
      },
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
            `ISO,国家,号码前缀,说明,费率\nCN,中国,86,,0.0001\n,坏,001,,1\n,坏,2,,-1\n,${'国'.repeat(201)},3,,0.1\n,重复,86,,0.2`,
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
          '﻿ISO,国家,号码前缀,说明,费率\r\n,中国,86,,0.2345\r\n,美国,1,,0.0001\r\n',
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
      {
        iso: '',
        description: '',
        prefix: '1',
        country: '美国',
        rate: '0.0001',
      },
      {
        iso: '',
        description: '',
        prefix: '86',
        country: '中国',
        rate: '0.2345',
      },
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
        file: file(',美国,1,,0.1'),
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
          file: file(',美国,1,,0.1'),
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
          file: file(',美国,1,,0.1'),
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
      file: file(',美国,1,,0.1\n,中国,86,,0.2'),
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
    const revised = await service.editRate({
      ...source,
      request: {
        baseVersionId: source.baseVersionId,
        entry: {
          prefix: '86',
          iso: 'CN',
          country: '中国',
          description: 'Mobile',
          rate: '0.1234',
        },
        schedule: { kind: 'immediate' },
      },
    });
    source.baseVersionId = revised.version.id;
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
    expect(result.version.entries).toEqual(revised.version.entries);
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
    expect(result.csv).toBe(
      'ISO,Country,Destination Prefix,Description,Rate\n,中国,86,,0.1234\n',
    );
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

it('ISO-only and description-only edits are modified rows, search all labels, export/reimport unchanged and audit cancellation', async () => {
  const context = await fixture();
  const service = createAdminRatesService();
  const first = await service.editRate({
    ...context,
    request: {
      baseVersionId: context.baseVersionId,
      entry: {
        prefix: '86',
        iso: 'CN',
        country: '中国',
        description: 'Mobile',
        rate: '0.1234',
      },
      schedule: { kind: 'immediate' },
    },
  });
  for (const search of ['86', 'cn', '中国', 'mobile']) {
    const rates = await service.getRates({ ...context, query: { search } });
    expect(rates.current.entries).toEqual([
      {
        prefix: '86',
        iso: 'CN',
        country: '中国',
        description: 'Mobile',
        rate: '0.1234',
      },
    ]);
  }
  const exported = await service.exportRates({
    ...context,
    request: { versionId: first.version.id },
  });
  expect(exported.csv).toBe(
    'ISO,Country,Destination Prefix,Description,Rate\nCN,中国,86,Mobile,0.1234\n',
  );
  const unchanged = await service.importPreview({
    ...context,
    request: {
      baseVersionId: first.version.id,
      file: file(exported.csv),
      schedule: { kind: 'immediate' },
    },
  });
  expect(unchanged).toMatchObject({
    ok: true,
    counts: { added: 0, modified: 0, deleted: 0 },
  });
  for (const row of ['US,中国,86,Mobile,0.1234', 'CN,中国,86,Fixed,0.1234']) {
    const preview = await service.importPreview({
      ...context,
      request: {
        baseVersionId: first.version.id,
        file: file(`ISO,Country,Destination Prefix,Description,Rate\n${row}`),
        schedule: { kind: 'immediate' },
      },
    });
    expect(preview).toMatchObject({
      ok: true,
      counts: { added: 0, modified: 1, deleted: 0 },
    });
  }
  const future = await service.editRate({
    ...context,
    request: {
      baseVersionId: first.version.id,
      entry: {
        prefix: '86',
        iso: 'CN',
        country: '中国',
        description: 'Fixed',
        rate: '0.1234',
      },
      schedule: {
        kind: 'scheduled',
        effectiveFrom: new Date(Date.now() + 86_400_000).toISOString(),
      },
    },
  });
  await service.cancelFutureVersion({
    ...context,
    request: { versionId: future.version.id },
  });
  const logs = await owner.pool.query<{ details: unknown }>(
    `select details from operation_logs where tenant_id=$1 and action='rate_schedule_cancel'`,
    [context.tenantId],
  );
  expect(logs.rows[0]?.details).toMatchObject({
    content: {
      entries: [{ iso: 'CN', country: '中国', description: 'Fixed' }],
    },
  });
});

it('old three-column CSV is rejected with a dedicated error and no writes', async () => {
  const context = await fixture();
  const before = await snapshot(context.tenantId);
  const result = await createAdminRatesService().importPreview({
    ...context,
    request: {
      baseVersionId: context.baseVersionId,
      file: file('prefix,country,rate\n44,英国,0.02'),
      schedule: { kind: 'immediate' },
    },
  });
  expect(result).toEqual({
    ok: false,
    errors: [
      expect.objectContaining({
        line: 1,
        reason:
          '不再支持三列格式（前缀、国家、费率）。请改用五列并保留表头：ISO,Country,Destination Prefix,Description,Rate；可在导入对话框下载 CSV 模板',
      }),
    ],
  });
  expect(await snapshot(context.tenantId)).toEqual(before);
});

it('pre-migration previews without metadata are stale and remain unconsumed', async () => {
  const context = await fixture();
  const service = createAdminRatesService();
  const preview = await service.importPreview({
    ...context,
    request: {
      baseVersionId: context.baseVersionId,
      file: file(',英国,44,,0.02'),
      schedule: { kind: 'immediate' },
    },
  });
  if (!preview.ok) throw new Error('Expected preview');
  const before = await snapshot(context.tenantId);
  await owner.pool.query(
    `update admin_rate_previews set payload=jsonb_set(payload, '{entries}', '[{"prefix":"44","country":"英国","rate":"0.02"}]'::jsonb) where id=$1`,
    [preview.previewId],
  );
  await expect(
    service.importCommit({
      ...context,
      request: { previewId: preview.previewId },
    }),
  ).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
  expect(await snapshot(context.tenantId)).toEqual(before);
  expect(
    (
      await owner.pool.query(
        'select consumed_at from admin_rate_previews where id=$1',
        [preview.previewId],
      )
    ).rows,
  ).toEqual([{ consumed_at: null }]);
});
