import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ALERT_KIND_LABELS, alertKindSchema } from '@fs-billing/shared';
import { connections, createTenant } from '../test/support.js';
import { ensureStatementPartitions } from '../test/statements.js';
import {
  alertWindowPredicate,
  alertsInWindow,
  countAlertsInWindow,
  getAlertDetail,
  readAlertSummary,
  unassignedFilterOfKey,
} from './alert-list.js';
import { queueAlertNotices } from './alert-notify.js';
import { raiseAlert, recoverAlert } from './alerts.js';
import { withAdmin, withSystem } from './client.js';

const { app, owner } = connections();

// 假时钟：窗口查询的参照时间显式传入，告警的时间用 raiseAlert / recoverAlert 的 at 写死，不依赖真实时间。
const NOW = new Date('2026-10-29T04:00:00.000Z');
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);
const system = <T>(fn: Parameters<typeof withSystem<T>>[1]) =>
  withSystem(app.db, fn);
const raise = (input: Parameters<typeof raiseAlert>[1]) =>
  system((tx) => raiseAlert(tx, input));
const recover = (input: Parameters<typeof recoverAlert>[1]) =>
  system((tx) => recoverAlert(tx, input));
const inWindow = (input: Parameters<typeof alertsInWindow>[1]) =>
  alertsInWindow(app.db, input);

// 详情用例写的话单：用完删掉，免得别的测试文件按未验证话单统计时看到。
const cdrTenants: string[] = [];
const removeUnverifiedCdrs = () =>
  owner.pool.query('delete from cdrs where tenant_id = any($1::uuid[])', [
    cdrTenants,
  ]);
// 通知记录用例改了告警设置，恢复成迁移的默认值（别的测试文件期望版本 1）。
afterAll(async () => {
  await removeUnverifiedCdrs();
  await owner.pool.query(
    `update alert_settings set recipients = '{}', digest_minutes = 15`,
  );
});
beforeEach(async () => {
  await owner.pool.query(
    "delete from email_outbox where template like 'alert\\_%'",
  );
  await owner.pool.query('delete from system_alerts');
});

/** 窗口边界用例：key → 开始、恢复相对 NOW 的小时数。 */
async function windowFixture() {
  const rows: [string, number, number | null][] = [
    // 进行中：不论开始多久都算
    ['open-old', 24 * 100, null],
    ['open-new', 1, null],
    // 已恢复
    ['rec-ancient', 24 * 41, 24 * 35], // 41 天前开始、35 天前恢复：只在 all
    ['rec-month', 24 * 40, 24 * 10], // 恢复落在 30 天内
    ['rec-day-by-recovery', 25, 2], // 开始在 24h 外，恢复在 24h 内
    ['rec-day-by-start', 23, 22], // 开始、恢复都在 24h 内
    ['rec-edge', 24, 23.5], // 开始恰好 24 小时前：算
    ['rec-just-out', 24.01, 24.005], // 刚好出窗口：不算（也不算 30d 之外）
  ];
  for (const [key, startedHoursAgo, recoveredHoursAgo] of rows) {
    await raise({
      kind: 'cdr_failed',
      subjectKey: key,
      description: key,
      at: ago(startedHoursAgo),
    });
    if (recoveredHoursAgo !== null)
      await recover({
        kind: 'cdr_failed',
        subjectKey: key,
        at: ago(recoveredHoursAgo),
      });
  }
}
const descriptions = (items: readonly { description: string }[]) =>
  items.map((item) => item.description);

describe('窗口谓词', () => {
  it('counts open alerts always, and recovered ones whose start or recovery is inside the window', async () => {
    await windowFixture();
    const h24 = await inWindow({ window: '24h', now: NOW, pageSize: 100 });
    expect(descriptions(h24.items)).toEqual([
      // 进行中在前，然后开始时间降序
      'open-new',
      'open-old',
      'rec-day-by-start',
      'rec-edge',
      'rec-day-by-recovery',
    ]);
    expect(h24.total).toBe(5);
    const d30 = await inWindow({ window: '30d', now: NOW, pageSize: 100 });
    expect(descriptions(d30.items)).toEqual([
      'open-new',
      'open-old',
      'rec-day-by-start',
      'rec-edge',
      'rec-just-out',
      'rec-day-by-recovery',
      'rec-month',
    ]);
    const all = await inWindow({ window: 'all', now: NOW, pageSize: 100 });
    expect(all.total).toBe(8);
    expect(all.items.at(-1)?.description).toBe('rec-ancient');
    // 条数函数与列表 total 同一个谓词。
    for (const window of ['24h', '30d', 'all'] as const)
      expect(
        await withAdmin(app.db, (tx) =>
          countAlertsInWindow(tx, { window, now: NOW }),
        ),
      ).toBe((await inWindow({ window, now: NOW })).total);
    // 谓词本身可以套在别的别名上（供别的查询复用）。
    expect(alertWindowPredicate('all', { alias: 'x' })).toBeDefined();
  });

  it('filters by status and kind and reports the open count regardless of filters', async () => {
    await windowFixture();
    await raise({
      kind: 'auth_timeout',
      subjectKey: 'fs-authorize',
      description: 'auth',
      calls: 23,
      at: ago(2),
    });
    const open = await inWindow({ window: 'all', status: 'open', now: NOW });
    expect(open.total).toBe(3);
    expect(open.openCount).toBe(3);
    const recovered = await inWindow({
      window: '24h',
      status: 'recovered',
      now: NOW,
    });
    expect(descriptions(recovered.items)).toEqual([
      'rec-day-by-start',
      'rec-edge',
      'rec-day-by-recovery',
    ]);
    // 状态筛选下 openCount 仍是全部进行中的条数。
    expect(recovered.openCount).toBe(3);
    const auth = await inWindow({
      window: '30d',
      kind: 'auth_timeout',
      now: NOW,
    });
    expect(auth.items).toHaveLength(1);
    expect(auth.items[0]).toMatchObject({
      kind: 'auth_timeout',
      kindLabel: ALERT_KIND_LABELS['auth_timeout'],
      affectedCalls: 23,
      status: 'open',
      recoveredAt: null,
      tenant: null,
      durationSeconds: 2 * 3600,
    });
  });

  it('pages in the same order and gives recovered alerts a fixed duration', async () => {
    await windowFixture();
    const first = await inWindow({
      window: 'all',
      now: NOW,
      page: 1,
      pageSize: 3,
    });
    const second = await inWindow({
      window: 'all',
      now: NOW,
      page: 2,
      pageSize: 3,
    });
    const third = await inWindow({
      window: 'all',
      now: NOW,
      page: 3,
      pageSize: 3,
    });
    expect([...first.items, ...second.items, ...third.items]).toHaveLength(8);
    expect(
      descriptions([...first.items, ...second.items, ...third.items]),
    ).toEqual(
      descriptions(
        (await inWindow({ window: 'all', now: NOW, pageSize: 100 })).items,
      ),
    );
    const edge = (
      await inWindow({ window: 'all', now: NOW, pageSize: 100 })
    ).items.find((item) => item.description === 'rec-edge');
    // 已恢复：开始 24 小时前、恢复 23.5 小时前 = 30 分钟，不随 now 变化。
    expect(edge?.durationSeconds).toBe(30 * 60);
  });

  it('shows the tenant of per-tenant alerts', async () => {
    const tenant = await createTenant(app, 'CNY');
    await raise({
      kind: 'statement_mismatch',
      subjectKey: `statement:${tenant.id}:2026-09`,
      tenantId: tenant.id,
      description: '账单核对',
      at: ago(1),
    });
    const list = await inWindow({ window: '24h', now: NOW });
    expect(list.items[0]?.tenant).toEqual({
      id: tenant.id,
      code: tenant.code,
      name: `测试 ${tenant.code}`,
    });
  });
});

describe('汇总', () => {
  it('counts open alerts, the last 24 hours and the latest opened start', async () => {
    expect(await readAlertSummary(app.db, { now: NOW })).toEqual({
      open: 0,
      last24h: 0,
      lastOpenedAt: null,
    });
    await windowFixture();
    const summary = await readAlertSummary(app.db, { now: NOW });
    expect(summary.open).toBe(2);
    expect(summary.last24h).toBe(5);
    expect(summary.lastOpenedAt).toBe(
      ago(1).toISOString().replace('Z', '000Z'),
    );
    // last24h 就是列表 window=24h 的 total。
    expect(summary.last24h).toBe(
      (await inWindow({ window: '24h', now: NOW })).total,
    );
  });
});

describe('告警键反推未归属页的筛选', () => {
  it.each([
    ['unassigned:缺少租户标签', { reason: '缺少租户标签', tag: null }],
    ['unassigned:接通时无费率', { reason: '接通时无费率', tag: null }],
    ['unassigned:租户不存在:ABC01', { reason: '租户不存在', tag: 'ABC01' }],
    [
      'invalid-cdr:话单校验失败: billsec(invalid_type)',
      { reason: '话单校验失败: billsec(invalid_type)', tag: null },
    ],
    ['invalid-json', null],
    ['cdr-save', null],
    ['unassigned:', null],
    [null, null],
  ])('%s', (key, expected) => {
    expect(unassignedFilterOfKey(key)).toEqual(expected);
  });
});

describe('告警详情', () => {
  it('returns 404 for an unknown alert', async () => {
    await expect(getAlertDetail(app.db, randomUUID())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('gives every alert kind a Chinese label shared with the mail templates', () => {
    for (const kind of alertKindSchema.options)
      expect(ALERT_KIND_LABELS[kind], kind).toBeTruthy();
  });

  it('counts unverified calls per tenant inside the alert period, top five, with the cdr range', async () => {
    await ensureStatementPartitions(app);
    const tenants = [] as { id: string; code: string }[];
    for (let index = 0; index < 7; index++) {
      const tenant = await createTenant(app, 'CNY');
      tenants.push(tenant);
      cdrTenants.push(tenant.id);
    }
    const startedAt = ago(3);
    const { id } = await raise({
      kind: 'auth_timeout',
      subjectKey: 'fs-authorize',
      description: '授权超时放行',
      calls: 28,
      at: startedAt,
    });
    await recover({
      kind: 'auth_timeout',
      subjectKey: 'fs-authorize',
      at: ago(1),
    });
    // 租户 i 在告警期间收到 i+1 条未验证话单（received_at 在 [开始, 恢复] 内）；
    // 另外：一条已验证、一条在告警开始之前入库、一条在恢复之后入库，都不统计。
    const insert = (
      tenantId: string,
      options: { unverified: boolean; receivedAt: Date; startedAt: Date },
    ) =>
      owner.pool.query(
        `insert into cdrs (tenant_id, call_uuid, started_at, answered_at, ended_at, caller, callee, billing_number,
           duration_seconds, billed_minutes, matched_prefix, country, rate, charge, hangup_cause, unverified, received_at)
         values ($1,$2,$3,$3,$3,'1','8613800138000','8613800138000',1,1,'86','中国',0.05,0.1,'NORMAL_CLEARING',$4,$5)`,
        [
          tenantId,
          randomUUID(),
          options.startedAt,
          options.unverified,
          options.receivedAt,
        ],
      );
    const call = (minutesAfterStart: number) =>
      new Date(startedAt.getTime() + minutesAfterStart * 60_000);
    let minute = 1;
    for (const [index, tenant] of tenants.entries())
      for (let n = 0; n <= index; n++, minute++)
        await insert(tenant.id, {
          unverified: true,
          receivedAt: call(minute),
          startedAt: call(minute - 1),
        });
    const firstStart = call(0);
    const lastStart = call(minute - 2);
    await insert(tenants[0]!.id, {
      unverified: false,
      receivedAt: call(5),
      startedAt: call(4),
    });
    await insert(tenants[0]!.id, {
      unverified: true,
      receivedAt: ago(5),
      startedAt: ago(5),
    });
    await insert(tenants[0]!.id, {
      unverified: true,
      receivedAt: ago(0),
      startedAt: ago(0.5),
    });

    const detail = await getAlertDetail(app.db, id, { now: NOW });
    expect(detail).toMatchObject({
      id,
      kind: 'auth_timeout',
      status: 'recovered',
      affectedCalls: 28,
      notify: true,
    });
    // 受影响最多的 5 个：条数 7、6、5、4、3。
    expect(detail.affectedTenants).toEqual({
      items: [6, 5, 4, 3, 2].map((index) => ({
        id: tenants[index]!.id,
        code: tenants[index]!.code,
        name: `测试 ${tenants[index]!.code}`,
        count: index + 1,
      })),
      truncated: false,
    });
    expect(detail.cdrRange).toMatchObject({
      from: firstStart.toISOString().replace('Z', '000Z'),
      to: lastStart.toISOString().replace('Z', '000Z'),
      fromDay: '2026-10-29',
      toDay: '2026-10-29',
    });
    expect(detail.unassignedFilter).toBeNull();
  });

  it('counts the period of an old, short, recovered authorization alert', async () => {
    await ensureStatementPartitions(app);
    await removeUnverifiedCdrs();
    const tenant = await createTenant(app, 'CNY');
    cdrTenants.push(tenant.id);
    // 2026-08-20 开始、2 小时后恢复：离 NOW 已有两个多月，但只持续了两小时，不该被「最近 30 天」截掉。
    const startedAt = new Date('2026-08-20T02:00:00Z');
    const { id } = await raise({
      kind: 'auth_timeout',
      subjectKey: 'fs-authorize',
      description: '很久以前的授权超时',
      at: startedAt,
    });
    await recover({
      kind: 'auth_timeout',
      subjectKey: 'fs-authorize',
      at: new Date('2026-08-20T04:00:00Z'),
    });
    const insert = (receivedAt: string) =>
      owner.pool.query(
        `insert into cdrs (tenant_id, call_uuid, started_at, answered_at, ended_at, caller, callee, billing_number,
           duration_seconds, billed_minutes, matched_prefix, country, rate, charge, hangup_cause, unverified, received_at)
         values ($1,$2,$3,$3,$3,'1','8613800138000','8613800138000',1,1,'86','中国',0.05,0.1,'NORMAL_CLEARING',true,$3)`,
        [tenant.id, randomUUID(), new Date(receivedAt)],
      );
    await insert('2026-08-20T03:00:00Z');
    await insert('2026-08-20T03:30:00Z');
    await insert('2026-08-20T05:00:00Z'); // 恢复之后：不算
    const detail = await getAlertDetail(app.db, id, { now: NOW });
    expect(detail.status).toBe('recovered');
    expect(detail.affectedTenants).toEqual({
      items: [
        {
          id: tenant.id,
          code: tenant.code,
          name: `测试 ${tenant.code}`,
          count: 2,
        },
      ],
      truncated: false,
    });
    expect(detail.cdrRange).toMatchObject({
      fromDay: '2026-08-20',
      toDay: '2026-08-20',
    });
  });

  it('caps a long recovered alert at thirty days before its end', async () => {
    await ensureStatementPartitions(app);
    await removeUnverifiedCdrs();
    const tenant = await createTenant(app, 'CNY');
    cdrTenants.push(tenant.id);
    // 2026-07-01 开始、2026-08-20 恢复（50 天）：只统计恢复前 30 天，即 2026-07-21 起。
    const { id } = await raise({
      kind: 'auth_timeout',
      subjectKey: 'fs-authorize',
      description: '持续五十天',
      at: new Date('2026-07-01T00:00:00Z'),
    });
    await recover({
      kind: 'auth_timeout',
      subjectKey: 'fs-authorize',
      at: new Date('2026-08-20T00:00:00Z'),
    });
    for (const receivedAt of ['2026-07-05T00:00:00Z', '2026-08-01T00:00:00Z'])
      await owner.pool.query(
        `insert into cdrs (tenant_id, call_uuid, started_at, answered_at, ended_at, caller, callee, billing_number,
           duration_seconds, billed_minutes, matched_prefix, country, rate, charge, hangup_cause, unverified, received_at)
         values ($1,$2,$3,$3,$3,'1','8613800138000','8613800138000',1,1,'86','中国',0.05,0.1,'NORMAL_CLEARING',true,$3)`,
        [tenant.id, randomUUID(), new Date(receivedAt)],
      );
    const detail = await getAlertDetail(app.db, id, { now: NOW });
    expect(detail.affectedTenants?.truncated).toBe(true);
    expect(detail.affectedTenants?.items.map((item) => item.count)).toEqual([
      1,
    ]);
    expect(detail.cdrRange?.fromDay).toBe('2026-08-01');
  });

  it('caps a long running authorization alert at thirty days and says so', async () => {
    await ensureStatementPartitions(app);
    // 上一个用例留下的未验证话单在窗口内，先清掉（owner 可以删）。
    await removeUnverifiedCdrs();
    const { id } = await raise({
      kind: 'auth_timeout',
      subjectKey: 'fs-authorize',
      description: '持续',
      at: ago(24 * 45),
    });
    const detail = await getAlertDetail(app.db, id, { now: NOW });
    expect(detail.status).toBe('open');
    expect(detail.affectedTenants).toEqual({ items: [], truncated: true });
    expect(detail.cdrRange).toBeNull();
  });

  it('links unassigned alerts to the unassigned page filter and shows no stats for other kinds', async () => {
    const { id } = await raise({
      kind: 'cdr_failed',
      subjectKey: 'unassigned:租户不存在:ABC01',
      description: '话单停放到未归属',
      calls: 3,
      at: ago(1),
    });
    const detail = await getAlertDetail(app.db, id, { now: NOW });
    expect(detail.unassignedFilter).toEqual({
      reason: '租户不存在',
      tag: 'ABC01',
    });
    expect(detail.affectedTenants).toBeNull();
    expect(detail.cdrRange).toBeNull();
    const other = await raise({
      kind: 'cdr_failed',
      subjectKey: 'cdr-save',
      description: '保存失败',
      at: ago(1),
    });
    expect(
      (await getAlertDetail(app.db, other.id)).unassignedFilter,
    ).toBeNull();
  });

  it('tells two same-kind alerts with the same start time apart by id, and falls back to kind and start for old rows', async () => {
    const at = new Date('2026-10-29T01:00:00Z');
    // 同一个事务里开两条同类型的告警：startedAt 完全相同。
    const [first, second] = await system(async (tx) => [
      await raiseAlert(tx, {
        kind: 'cdr_failed',
        subjectKey: 'twin-1',
        description: '一',
        at,
      }),
      await raiseAlert(tx, {
        kind: 'cdr_failed',
        subjectKey: 'twin-2',
        description: '二',
        at,
      }),
    ]);
    await owner.pool.query(
      `update alert_settings set recipients = array['ops@example.test'], digest_minutes = 10`,
    );
    const tick = (when: string) =>
      system((tx) => queueAlertNotices(tx, { at: new Date(when) }));
    await tick('2026-10-29T01:01:00Z'); // 一封开始邮件，两条都在里面
    await raise({
      kind: 'cdr_failed',
      subjectKey: 'twin-1',
      description: '一 again',
      at: new Date('2026-10-29T01:05:00Z'),
    });
    await tick('2026-10-29T01:11:00Z'); // 只有 twin-1 有新增，只汇总它
    const templates = async (id: string) =>
      (await getAlertDetail(app.db, id, { now: NOW })).notices.map(
        (notice) => notice.template,
      );
    expect(await templates(first.id)).toEqual(['alert_start', 'alert_digest']);
    expect(await templates(second.id)).toEqual(['alert_start']);

    // 此前入队的行没有 id：按 (kind, startedAt) 关联。
    const old = await raise({
      kind: 'audit_failed',
      subjectKey: 'old-row',
      description: '旧',
      at: new Date('2026-10-29T02:00:00Z'),
    });
    await owner.pool.query(
      `insert into email_outbox (dedupe_key, template, params, recipients, status, created_at)
       values ('legacy-start', 'alert_start', $1::jsonb, array['ops@example.test'], 'pending', '2026-10-29T02:01:00Z')`,
      [
        JSON.stringify({
          alerts: [
            {
              kind: 'audit_failed',
              description: '旧',
              startedAt: '2026-10-29T02:00:00.000Z',
            },
          ],
        }),
      ],
    );
    expect(await templates(old.id)).toEqual(['alert_start']);
  });

  it('shows the newest fifty notices, oldest first', async () => {
    const { id } = await raise({
      kind: 'cdr_failed',
      subjectKey: 'chatty',
      description: '很多邮件',
      at: new Date('2026-10-29T00:00:00Z'),
    });
    await owner.pool.query(
      `insert into email_outbox (dedupe_key, template, params, recipients, status, created_at)
       select 'chatty:' || g, 'alert_digest',
         jsonb_build_object('alerts', jsonb_build_array(jsonb_build_object('id', $1::text, 'kind', 'cdr_failed',
           'startedAt', '2026-10-29T00:00:00.000Z'))),
         array['ops@example.test'], 'pending', '2026-10-29T01:00:00Z'::timestamptz + g * interval '1 minute'
       from generate_series(1, 60) g`,
      [id],
    );
    const { notices } = await getAlertDetail(app.db, id, { now: NOW });
    expect(notices).toHaveLength(50);
    const times = notices.map((notice) => notice.queuedAt);
    expect(times).toEqual([...times].sort());
    // 最新的一封（第 60 分钟）在，最旧的十封（第 1–10 分钟）不在。
    expect(times.at(-1)).toBe('2026-10-29T02:00:00.000000Z');
    expect(times[0]).toBe('2026-10-29T01:11:00.000000Z');
  });

  it('lists the start, digest and recovery mails of this alert only, without recipient addresses', async () => {
    // 两条告警同一 tick 开始，一封开始邮件；只有其中一条发汇总与恢复。
    const a = await raise({
      kind: 'auth_timeout',
      subjectKey: 'fs-authorize',
      description: 'A',
      at: new Date('2026-10-29T01:00:00Z'),
    });
    const b = await raise({
      kind: 'cdr_failed',
      subjectKey: 'cdr-save',
      description: 'B',
      at: new Date('2026-10-29T01:00:00Z'),
    });
    await owner.pool.query(
      `update alert_settings set recipients = array['ops-secret@example.test'], digest_minutes = 10`,
    );
    const tick = (at: string) =>
      system((tx) => queueAlertNotices(tx, { at: new Date(at) }));
    await tick('2026-10-29T01:01:00Z');
    await raise({
      kind: 'auth_timeout',
      subjectKey: 'fs-authorize',
      description: 'A again',
      at: new Date('2026-10-29T01:05:00Z'),
    });
    await tick('2026-10-29T01:11:00Z');
    await recover({
      kind: 'auth_timeout',
      subjectKey: 'fs-authorize',
      at: new Date('2026-10-29T01:20:00Z'),
    });
    await tick('2026-10-29T01:21:00Z');
    await owner.pool.query(
      `update email_outbox set status = 'sent', sent_at = created_at + interval '2 seconds'
       where template = 'alert_start'`,
    );

    const detailA = await getAlertDetail(app.db, a.id, { now: NOW });
    expect(
      detailA.notices.map((notice) => [notice.template, notice.status]),
    ).toEqual([
      ['alert_start', 'sent'],
      ['alert_digest', 'pending'],
      ['alert_recovered', 'pending'],
    ]);
    expect(detailA.notices[0]?.sentAt).not.toBeNull();
    expect(detailA.notices[1]?.sentAt).toBeNull();
    // B 只有开始邮件（汇总要有新增事件，恢复要它自己恢复）。
    const detailB = await getAlertDetail(app.db, b.id, { now: NOW });
    expect(detailB.notices.map((notice) => notice.template)).toEqual([
      'alert_start',
    ]);
    // 响应里没有任何收件人地址。
    expect(JSON.stringify([detailA, detailB])).not.toContain('@');
    // 不发邮件的类型没有记录，并标明 notify 为否。
    const failed = await raise({
      kind: 'email_failed',
      subjectKey: 'smtp',
      description: 'smtp',
      at: new Date('2026-10-29T01:00:00Z'),
    });
    const detailF = await getAlertDetail(app.db, failed.id, { now: NOW });
    expect(detailF.notify).toBe(false);
    expect(detailF.notices).toEqual([]);
  });
});
