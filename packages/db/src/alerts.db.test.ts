import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { beijingTime, money, parseDialedNumber } from '@fs-billing/rating';
import {
  adminId,
  connections,
  createTenant,
  pgError,
} from '../test/support.js';
import { ensureStatementPartitions } from '../test/statements.js';
import { insertUnassigned, rateTenant } from '../test/unassigned.js';
import {
  AlertKeys,
  alertNotifies,
  raiseAlert,
  recoverAlert,
  recoverClearedUnassignedAlerts,
  recoverPaidChargeReconcileAlerts,
  recoverQuietAlerts,
  unassignedRowAlertKey,
} from './alerts.js';
import { chargeCall, priceAndInsertCdr } from './cdr-intake.js';
import { lockTenants, withSystem } from './client.js';
import { appendLedgerEntry, callChargeKey } from './ledger.js';
import { loadRatingTenant } from './rates.js';
import { cdrs, systemAlertKinds } from './schema.js';
import { ignoreUnassigned } from './unassigned/ignore.js';

const { app, owner } = connections();
let administrator: string;
beforeAll(async () => {
  administrator = await adminId(owner);
  await ensureStatementPartitions(app);
});
// 告警按 (kind, subject_key) 合并；每个用例从没有告警开始。
beforeEach(async () => {
  await owner.pool.query('delete from system_alerts');
});

interface AlertRow {
  id: string;
  kind: string;
  subject_key: string | null;
  tenant_id: string | null;
  description: string;
  occurrences: number;
  affected_calls: number;
  notify: boolean;
  notified_start_at: Date | null;
  notified_recovered_at: Date | null;
  started_at: Date;
  last_seen_at: Date;
  recovered_at: Date | null;
}
const alerts = async (kind?: string) =>
  (
    await owner.pool.query<AlertRow>(
      `select id, kind, subject_key, tenant_id, description, occurrences, affected_calls, notify,
              notified_start_at, notified_recovered_at, started_at, last_seen_at, recovered_at
       from system_alerts where ($1::text is null or kind = $1) order by started_at, id`,
      [kind ?? null],
    )
  ).rows;
const raise = (input: Parameters<typeof raiseAlert>[1]) =>
  withSystem(app.db, (tx) => raiseAlert(tx, input));
const recover = (input: Parameters<typeof recoverAlert>[1]) =>
  withSystem(app.db, (tx) => recoverAlert(tx, input));

describe('raiseAlert 与 recoverAlert', () => {
  it('opens one alert per key and merges later events into it', async () => {
    const t0 = new Date('2026-10-29T01:00:00Z');
    const t1 = new Date('2026-10-29T01:07:00Z');
    const first = await raise({
      kind: 'cdr_failed',
      subjectKey: AlertKeys.cdrSave,
      description: '第一次',
      calls: 1,
      at: t0,
    });
    const second = await raise({
      kind: 'cdr_failed',
      subjectKey: AlertKeys.cdrSave,
      description: '第二次',
      calls: 2,
      at: t1,
    });
    expect(first.opened).toBe(true);
    expect(second).toEqual({ id: first.id, opened: false });
    expect(await alerts()).toMatchObject([
      {
        subject_key: 'cdr-save',
        description: '第二次',
        occurrences: 2,
        affected_calls: 3,
        started_at: t0,
        last_seen_at: t1,
        recovered_at: null,
      },
    ]);
    // 另一个键、另一个 kind 各自一条。
    await raise({
      kind: 'cdr_failed',
      subjectKey: AlertKeys.invalidJson,
      description: 'x',
    });
    await raise({
      kind: 'partition_failed',
      subjectKey: AlertKeys.cdrSave,
      description: 'x',
    });
    expect(await alerts()).toHaveLength(3);
  });

  it('keeps the tenant of the first event and sets or adds the affected calls', async () => {
    const tenant = await createTenant(app, 'CNY');
    const other = await createTenant(app, 'CNY');
    const key = AlertKeys.statement(tenant.id, '2026-09');
    await raise({
      kind: 'statement_mismatch',
      subjectKey: key,
      tenantId: tenant.id,
      description: 'a',
      calls: 5,
      callsMode: 'set',
    });
    await raise({
      kind: 'statement_mismatch',
      subjectKey: key,
      tenantId: other.id,
      description: 'b',
      calls: 2,
      callsMode: 'set',
    });
    expect(await alerts()).toMatchObject([
      { tenant_id: tenant.id, description: 'b', affected_calls: 2 },
    ]);
  });

  it('concurrent events keep one open alert', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        raise({
          kind: 'auth_timeout',
          subjectKey: AlertKeys.authTimeout,
          description: `事件 ${index}`,
          calls: 1,
        }),
      ),
    );
    expect(results.filter((result) => result.opened)).toHaveLength(1);
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(await alerts()).toMatchObject([
      { occurrences: 12, affected_calls: 12, recovered_at: null },
    ]);
  });

  it('allows only one open alert per key at the database level, but not for keyless legacy rows', async () => {
    await raise({
      kind: 'cdr_failed',
      subjectKey: 'dup',
      description: 'x',
    });
    expect(
      await pgError(
        owner.pool.query(
          `insert into system_alerts (kind, subject_key, description) values ('cdr_failed', 'dup', 'y')`,
        ),
      ),
    ).toMatchObject({
      code: '23505',
      constraint: 'system_alerts_open_subject',
    });
    // 无键的旧行不参与唯一性。
    await owner.pool.query(
      `insert into system_alerts (kind, description) values ('cdr_failed', 'a'), ('cdr_failed', 'b')`,
    );
    // 恢复之后同一个键可以再开。
    await recover({ kind: 'cdr_failed', subjectKey: 'dup' });
    await raise({ kind: 'cdr_failed', subjectKey: 'dup', description: 'z' });
    expect(await alerts('cdr_failed')).toHaveLength(4);
  });

  it('recovers an open alert once, leaves recovered ones alone, and opens a new one afterwards', async () => {
    const t0 = new Date('2026-10-29T01:00:00Z');
    await raise({
      kind: 'audit_failed',
      subjectKey: AlertKeys.auditResetPassword,
      description: 'a',
      at: t0,
    });
    // 推进了时钟的告警：recovered_at 不能早于 started_at（表约束），所以取较大者。
    expect(
      await recover({
        kind: 'audit_failed',
        subjectKey: AlertKeys.auditResetPassword,
        at: new Date('2026-10-29T00:00:00Z'),
      }),
    ).toBe(1);
    const [recovered] = await alerts();
    expect(recovered?.recovered_at).toEqual(t0);
    expect(
      await recover({
        kind: 'audit_failed',
        subjectKey: AlertKeys.auditResetPassword,
      }),
    ).toBe(0);
    expect((await alerts())[0]?.recovered_at).toEqual(t0);
    await raise({
      kind: 'audit_failed',
      subjectKey: AlertKeys.auditResetPassword,
      description: 'b',
    });
    expect(await alerts()).toMatchObject([
      { occurrences: 1, recovered_at: t0 },
      { occurrences: 1, recovered_at: null, description: 'b' },
    ]);
  });

  it('decides notify by kind when the alert opens: email_failed never notifies', async () => {
    for (const kind of systemAlertKinds)
      await raise({ kind, subjectKey: 'policy', description: kind });
    const rows = await alerts();
    expect(rows).toHaveLength(systemAlertKinds.length);
    for (const row of rows) {
      expect(row.notify).toBe(row.kind !== 'email_failed');
      expect(row.notify).toBe(alertNotifies(row.kind as never));
      // 新告警还没发过邮件：开始邮件标记为空（notify 为真表示等待发送）。
      expect(row.notified_start_at).toBeNull();
    }
    // 合并事件不改 notify。
    await owner.pool.query(`update system_alerts set notify = false`);
    await raise({
      kind: 'cdr_failed',
      subjectKey: 'policy',
      description: 'again',
    });
    expect((await alerts('cdr_failed')).map((row) => row.notify)).toEqual([
      false,
    ]);
  });

  it('recovers only the quiet-window alerts that have been silent long enough', async () => {
    const t0 = new Date('2026-10-29T01:00:00Z');
    const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
    await raise({
      kind: 'auth_timeout',
      subjectKey: AlertKeys.authTimeout,
      description: 'a',
      at: t0,
    });
    await raise({
      kind: 'cdr_failed',
      subjectKey: AlertKeys.invalidJson,
      description: 'j',
      at: at(5),
    });
    // 不是事件型：靠各自的条件恢复，静默窗口不动它。
    await raise({
      kind: 'partition_failed',
      subjectKey: AlertKeys.partitionMaintenance,
      description: 'p',
      at: t0,
    });
    const quiet = (minutes: number) =>
      withSystem(app.db, (tx) =>
        recoverQuietAlerts(tx, { quietMinutes: 10, at: at(minutes) }),
      );
    expect(await quiet(9)).toBe(0);
    expect(await quiet(10)).toBe(1);
    expect(await quiet(15)).toBe(1);
    expect(await quiet(600)).toBe(0);
    const rows = await alerts();
    expect(
      Object.fromEntries(
        rows.map((row) => [row.subject_key, row.recovered_at !== null]),
      ),
    ).toEqual({
      'fs-authorize': true,
      'partition-maintenance': false,
      'invalid-json': true,
    });
    // 默认窗口 10 分钟。
    await raise({
      kind: 'auth_timeout',
      subjectKey: AlertKeys.authTimeout,
      description: 'a',
      at: at(100),
    });
    expect(
      await withSystem(app.db, (tx) => recoverQuietAlerts(tx, { at: at(109) })),
    ).toBe(0);
    expect(
      await withSystem(app.db, (tx) => recoverQuietAlerts(tx, { at: at(111) })),
    ).toBe(1);
  });
});

describe('未归属话单的告警恢复', () => {
  const tagOf = () =>
    `T${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
  const FAILURE = '话单校验失败: variables.billsec(invalid_union)';
  const openKeys = async () =>
    (await alerts())
      .filter((row) => row.recovered_at === null)
      .map((row) => row.subject_key);

  it('maps a pending row to the alert key the ingest path writes', () => {
    expect(
      unassignedRowAlertKey({
        callUuid: randomUUID(),
        reason: '租户不存在',
        tenantTag: 'ABC01',
      }),
    ).toBe('unassigned:租户不存在:ABC01');
    expect(
      unassignedRowAlertKey({
        callUuid: randomUUID(),
        reason: '接通时无费率',
        tenantTag: 'ABC01',
      }),
    ).toBe('unassigned:接通时无费率');
    expect(
      unassignedRowAlertKey({
        callUuid: null,
        reason: FAILURE,
        tenantTag: 'X',
      }),
    ).toBe(`invalid-cdr:${FAILURE}`);
  });

  it('an ignored last pending row recovers it, an assigned one too, and a remaining pending row keeps it open', async () => {
    const tagA = tagOf();
    const tagB = tagOf();
    // A：两条「租户不存在」；B：一条校验失败（无 UUID）。
    await insertUnassigned(owner, [{ tag: tagA }, { tag: tagA }]);
    await insertUnassigned(owner, [
      { tag: tagB, callUuid: null, reason: FAILURE },
    ]);
    await owner.pool.query(
      `delete from unassigned_cdrs where status = 'pending' and tenant_tag <> all($1::text[])`,
      [[tagA, tagB]],
    );
    const keyA = `unassigned:租户不存在:${tagA}`;
    const keyB = `invalid-cdr:${FAILURE}`;
    for (const subjectKey of [keyA, keyB])
      await raise({
        kind: 'cdr_failed',
        subjectKey,
        description: subjectKey,
        calls: 1,
      });
    const ids = (
      await owner.pool.query<{ id: string }>(
        `select id from unassigned_cdrs where tenant_tag = $1 order by id`,
        [tagA],
      )
    ).rows.map((row) => row.id);
    const actor = { id: administrator, name: '王敏' };

    // 忽略 A 的一条：还剩一条 pending，A 的告警不恢复。
    await ignoreUnassigned(app.db, {
      actor,
      selection: { ids: [ids[0]!] },
      reason: '测试',
    });
    expect(await openKeys()).toEqual([keyA, keyB]);
    // 忽略最后一条：恢复。B 与它无关。
    await ignoreUnassigned(app.db, {
      actor,
      selection: { ids: [ids[1]!] },
      reason: '测试',
    });
    expect(await openKeys()).toEqual([keyB]);
    // 忽略 B 的唯一一条（无 UUID 的校验失败行）：恢复。
    await ignoreUnassigned(app.db, {
      actor,
      selection: { group: { tag: tagB } },
      reason: '测试',
    });
    expect(await openKeys()).toEqual([]);
  });

  it('the sweep recovers alerts whose pending rows are gone and leaves the others', async () => {
    const tag = tagOf();
    await owner.pool.query(
      `delete from unassigned_cdrs where status = 'pending'`,
    );
    await insertUnassigned(owner, [{ tag }]);
    const kept = `unassigned:租户不存在:${tag}`;
    const gone = `unassigned:租户不存在:${tagOf()}`;
    for (const subjectKey of [kept, gone])
      await raise({ kind: 'cdr_failed', subjectKey, description: 'x' });
    // 不属于未归属类的键不受影响。
    await raise({
      kind: 'cdr_failed',
      subjectKey: 'cdr-save',
      description: 'x',
    });
    expect(
      await withSystem(app.db, (tx) => recoverClearedUnassignedAlerts(tx)),
    ).toBe(1);
    expect(await openKeys()).toEqual([kept, 'cdr-save']);
  });
});

describe('扣费对账告警的恢复', () => {
  const answeredAt = beijingTime('2026-09-10 10:00:00');
  async function parkedCharge() {
    const tenant = await rateTenant(owner);
    const callUuid = randomUUID();
    await withSystem(app.db, async (tx) => {
      await lockTenants(tx, [tenant.id]);
      await priceAndInsertCdr(
        tx,
        { id: tenant.id, rating: await loadRatingTenant(tx, tenant.code) },
        {
          callUuid,
          startedAt: new Date(answeredAt.getTime() - 5_000),
          answeredAt,
          endedAt: new Date(answeredAt.getTime() + 61_000),
          caller: '075586001234',
          callee: '+8613800138000',
          billsec: 61,
          hangupCause: 'NORMAL_CLEARING',
          unverified: false,
        },
        parseDialedNumber('8613800138000')!,
      );
    });
    return { tenant, callUuid };
  }
  /** 对账任务写告警时，同一事务里置 reconcile_alerted。 */
  const open = (callUuid: string, tenantId: string) =>
    withSystem(app.db, async (tx) => {
      await lockTenants(tx, [tenantId]);
      await tx
        .update(cdrs)
        .set({ reconcileAlerted: true })
        .where(and(eq(cdrs.callUuid, callUuid), eq(cdrs.tenantId, tenantId)));
      await raiseAlert(tx, {
        kind: 'cdr_failed',
        subjectKey: AlertKeys.chargeReconcile(callUuid),
        tenantId,
        description: `${callUuid}: 扣费对账持续失败，请人工处理`,
        calls: 1,
      });
    });

  it('recovers a charge-reconcile alert in the charge transaction', async () => {
    const { tenant, callUuid } = await parkedCharge();
    await open(callUuid, tenant.id);
    expect(await alerts()).toMatchObject([
      { subject_key: `charge-reconcile:${callUuid}`, recovered_at: null },
    ]);
    // 回滚的扣费事务不恢复告警。
    await expect(
      withSystem(app.db, async (tx) => {
        await lockTenants(tx, [tenant.id]);
        await chargeCall(tx, { tenantId: tenant.id, callUuid });
        throw new Error('回滚');
      }),
    ).rejects.toThrow('回滚');
    expect((await alerts())[0]?.recovered_at).toBeNull();
    await withSystem(app.db, async (tx) => {
      await lockTenants(tx, [tenant.id]);
      await chargeCall(tx, { tenantId: tenant.id, callUuid });
    });
    expect((await alerts())[0]?.recovered_at).toBeInstanceOf(Date);
  });

  it('does not touch alerts of calls that never had a reconcile alert', async () => {
    const { tenant, callUuid } = await parkedCharge();
    const other = randomUUID();
    await raise({
      kind: 'cdr_failed',
      subjectKey: AlertKeys.chargeReconcile(other),
      tenantId: tenant.id,
      description: 'x',
    });
    await withSystem(app.db, async (tx) => {
      await lockTenants(tx, [tenant.id]);
      await chargeCall(tx, { tenantId: tenant.id, callUuid });
    });
    expect((await alerts())[0]?.recovered_at).toBeNull();
  });

  it('the sweep recovers an alert whose ledger entry was written by hand', async () => {
    const { tenant, callUuid } = await parkedCharge();
    await raise({
      kind: 'cdr_failed',
      subjectKey: AlertKeys.chargeReconcile(callUuid),
      tenantId: tenant.id,
      description: 'x',
    });
    const sweep = () =>
      withSystem(app.db, (tx) => recoverPaidChargeReconcileAlerts(tx));
    expect(await sweep()).toBe(0);
    // 人工补记的流水（幂等键与扣费一致）。
    await withSystem(app.db, async (tx) => {
      await lockTenants(tx, [tenant.id]);
      await appendLedgerEntry(
        tx,
        { id: tenant.id, currency: 'CNY' },
        {
          kind: 'call_charge',
          amount: money('CNY', '-0.1'),
          occurredAt: answeredAt,
          note: '人工补记',
          idempotencyKey: callChargeKey(callUuid),
        },
      );
    });
    expect(await sweep()).toBe(1);
    expect(await sweep()).toBe(0);
  });
});
