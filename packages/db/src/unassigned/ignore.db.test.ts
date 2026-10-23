import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { adminId, connections } from '../../test/support.js';
import { ensureStatementPartitions } from '../../test/statements.js';
import { insertUnassigned, rateTenant } from '../../test/unassigned.js';
import { assignUnassigned } from './assign.js';
import { ignoreUnassigned, unignoreUnassigned } from './ignore.js';
import { previewAssignment } from './preview.js';

const { app, owner } = connections();
let actor: { id: string; name: string };
beforeAll(async () => {
  actor = { id: await adminId(owner), name: '王敏' };
  await ensureStatementPartitions(app);
});

const newTag = () =>
  `T${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
const rowsOf = async (tag: string) =>
  (
    await owner.pool.query<{
      status: string;
      ignore_reason: string | null;
      resolved_by: string | null;
      resolved: boolean;
    }>(
      `select status, ignore_reason, resolved_by, resolved_at is not null as resolved
       from unassigned_cdrs where tenant_tag = $1 order by id`,
      [tag],
    )
  ).rows;
const auditsOf = async (action: string, ids: string[]) =>
  (
    await owner.pool.query<{
      admin_id: string;
      tenant_id: string | null;
      target: string;
      details: { content: Record<string, unknown>; target: { kind: string } };
    }>(
      `select admin_id, tenant_id, target, details from operation_logs
       where action = $1 and id = any($2::uuid[])`,
      [action, ids],
    )
  ).rows;

describe('忽略与撤销忽略', () => {
  it('ignores with a reason and restores to pending', async () => {
    const tag = newTag();
    const rows = await insertUnassigned(owner, [
      { tag },
      { tag },
      // 校验失败的行没有 call_uuid，同样可以忽略。
      { tag, callUuid: null },
    ]);

    const ignored = await ignoreUnassigned(app.db, {
      actor,
      selection: { group: { tag } },
      reason: '  FreeSWITCH 测试呼叫  ',
    });
    expect(ignored.changed).toBe(3);
    expect(await rowsOf(tag)).toEqual(
      Array.from({ length: 3 }, () => ({
        status: 'ignored',
        ignore_reason: 'FreeSWITCH 测试呼叫',
        resolved_by: actor.id,
        resolved: true,
      })),
    );
    const [audit] = await auditsOf('unassigned_ignore', [ignored.auditId!]);
    expect(audit).toMatchObject({
      admin_id: actor.id,
      tenant_id: null,
      // 忽略没有批次表：对象取本条审计自身的 id。
      target: ignored.auditId,
      details: {
        target: { kind: 'unassigned_batch', id: ignored.auditId },
        content: {
          count: 3,
          reason: 'FreeSWITCH 测试呼叫',
          sourceTag: tag,
          changes: [{ field: 'callCount', before: null, after: '3' }],
        },
      },
    });

    // 忽略过的行再忽略：影响 0 行，不写日志。
    const again = await ignoreUnassigned(app.db, {
      actor,
      selection: { group: { tag } },
      reason: '重复',
    });
    expect(again).toEqual({ changed: 0, auditId: null });

    // 撤销忽略：回到待处理，忽略字段清空，写日志。
    const restored = await unignoreUnassigned(app.db, {
      actor,
      selection: { ids: [rows[0]!.id, rows[1]!.id] },
    });
    expect(restored.changed).toBe(2);
    expect(await rowsOf(tag)).toEqual(
      expect.arrayContaining([
        {
          status: 'pending',
          ignore_reason: null,
          resolved_by: null,
          resolved: false,
        },
      ]),
    );
    expect(
      (await rowsOf(tag)).filter((r) => r.status === 'pending'),
    ).toHaveLength(2);
    const [unignore] = await auditsOf('unassigned_unignore', [
      restored.auditId!,
    ]);
    expect(unignore).toMatchObject({
      admin_id: actor.id,
      tenant_id: null,
      details: { content: { count: 2 } },
    });
    expect(
      await unignoreUnassigned(app.db, {
        actor,
        selection: { ids: [rows[0]!.id] },
      }),
    ).toEqual({ changed: 0, auditId: null });
  });

  it('rejects an empty reason', async () => {
    const tag = newTag();
    await insertUnassigned(owner, [{ tag }]);
    for (const reason of ['', '   ', '\n\t'])
      await expect(
        ignoreUnassigned(app.db, {
          actor,
          selection: { group: { tag } },
          reason,
        }),
      ).rejects.toMatchObject({
        name: 'UnassignedError',
        code: 'VALIDATION_ERROR',
      });
    await expect(
      ignoreUnassigned(app.db, {
        actor,
        selection: { group: { tag } },
        reason: 'x'.repeat(2001),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    // 数据库也不允许没有原因的忽略。
    await expect(
      owner.pool.query(
        `update unassigned_cdrs set status = 'ignored', ignore_reason = '  ', resolved_by = $2, resolved_at = now()
         where tenant_tag = $1`,
        [tag, actor.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect((await rowsOf(tag)).map((r) => r.status)).toEqual(['pending']);
    expect(
      (
        await owner.pool.query(
          `select count(*)::int as n from operation_logs where action = 'unassigned_ignore' and details #>> '{content,sourceTag}' = $1`,
          [tag],
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
  });

  it('an assigned row cannot be ignored or restored and an ignored row cannot be assigned', async () => {
    const tenant = await rateTenant(owner);
    const tag = newTag();
    const [assignedRow] = await insertUnassigned(owner, [{ tag }]);
    const preview = await previewAssignment(app.db, {
      tenantId: tenant.id,
      selection: { ids: [assignedRow!.id] },
    });
    await assignUnassigned(app.db, {
      actor,
      tenantId: tenant.id,
      selection: { ids: [assignedRow!.id] },
      idempotencyKey: randomUUID(),
      expected: {
        assignable: preview.assignable,
        noRate: preview.noRate.count,
        chargeTotal: preview.chargeTotal,
      },
    });
    expect(
      await ignoreUnassigned(app.db, {
        actor,
        selection: { ids: [assignedRow!.id] },
        reason: '误操作',
      }),
    ).toEqual({ changed: 0, auditId: null });
    expect(
      await unignoreUnassigned(app.db, {
        actor,
        selection: { ids: [assignedRow!.id] },
      }),
    ).toEqual({ changed: 0, auditId: null });
    expect((await rowsOf(tag)).map((r) => r.status)).toEqual(['assigned']);

    const ignoredTag = newTag();
    const [ignoredRow] = await insertUnassigned(owner, [{ tag: ignoredTag }]);
    await ignoreUnassigned(app.db, {
      actor,
      selection: { ids: [ignoredRow!.id] },
      reason: '测试',
    });
    await expect(
      assignUnassigned(app.db, {
        actor,
        tenantId: tenant.id,
        selection: { ids: [ignoredRow!.id] },
        idempotencyKey: randomUUID(),
        expected: { assignable: 1, noRate: 0, chargeTotal: '0.1' },
      }),
    ).rejects.toMatchObject({ code: 'UNASSIGNED_NOTHING_TO_ASSIGN' });
  });
});
