import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { adminId, connections } from '../../test/support.js';
import { withAdmin } from '../client.js';
import { writeAudit } from './audit.js';

const { app, owner } = connections();
let administrator: string;
beforeAll(async () => {
  administrator = await adminId(owner);
});

const rowOf = async (id: string) =>
  (
    await owner.pool.query<{
      admin_id: string | null;
      actor_label: string | null;
      target: string;
      details: { actor: object };
    }>(
      'select admin_id, actor_label, target, details from operation_logs where id = $1',
      [id],
    )
  ).rows[0];

describe('writeAudit', () => {
  it('records an administrator in admin_id and a command line source in actor_label', async () => {
    const adminAudit = randomUUID();
    const systemAudit = randomUUID();
    const target = randomUUID();
    const label = `cli:auth:bootstrap@probe-${randomUUID()}/ops`;
    await withAdmin(app.db, async (tx) => {
      await writeAudit(tx, {
        id: adminAudit,
        actor: { id: administrator, name: '王敏' },
        occurredAt: new Date().toISOString(),
        tenantId: null,
        target: { kind: 'admin', id: target },
        action: 'admin_disable',
        content: { summary: '停用账号', changes: [] },
      });
      await writeAudit(tx, {
        id: systemAudit,
        actor: { label },
        occurredAt: new Date().toISOString(),
        tenantId: null,
        target: { kind: 'admin', id: target },
        action: 'credential_bootstrap',
        content: {
          summary: '创建管理员凭据',
          changes: [],
          mode: 'create',
          result: 'succeeded',
          errorCode: null,
          revokedSessions: 0,
        },
      });
    });
    expect(await rowOf(adminAudit)).toMatchObject({
      admin_id: administrator,
      actor_label: null,
      target,
      details: { actor: { id: administrator, name: '王敏' } },
    });
    expect(await rowOf(systemAudit)).toMatchObject({
      admin_id: null,
      actor_label: label,
      target,
      details: { actor: { label } },
    });
  });

  it('refuses a command line source on an administrator action and the other way round', async () => {
    const base = {
      occurredAt: new Date().toISOString(),
      tenantId: null,
      target: { kind: 'admin' as const, id: randomUUID() },
    };
    await expect(
      withAdmin(app.db, (tx) =>
        writeAudit(tx, {
          ...base,
          id: randomUUID(),
          actor: { label: 'cli' },
          action: 'admin_disable',
          content: { summary: 'x', changes: [] },
        } as never),
      ),
    ).rejects.toThrow();
    await expect(
      withAdmin(app.db, (tx) =>
        writeAudit(tx, {
          ...base,
          id: randomUUID(),
          actor: { id: administrator, name: '王敏' },
          action: 'credential_bootstrap',
          content: {
            summary: 'x',
            changes: [],
            mode: 'create',
            result: 'succeeded',
            errorCode: null,
            revokedSessions: 0,
          },
        } as never),
      ),
    ).rejects.toThrow();
  });
});
