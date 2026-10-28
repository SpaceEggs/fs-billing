import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  adminApiErrorSchema,
  adminUnassignedAssignResponseSchema,
  adminUnassignedGroupsResponseSchema,
  adminUnassignedListResponseSchema,
  adminUnassignedPreviewResponseSchema,
  adminUnassignedResolveResponseSchema,
  adminUnassignedSummaryResponseSchema,
} from '@fs-billing/shared';
import {
  apiConnections,
  createFixture,
  fixtureApi,
  login,
  requestHeaders,
  type Fixture,
} from '../test/support.js';
import { seededApi } from '../test/scratch.js';
import { ensureStatementPartitions } from '../test/statements.js';
import { insertUnassigned, rateTenant } from '../test/unassigned.js';

const connections = apiConnections();
const { api } = fixtureApi(connections);
let fixture: Fixture;
let adminCookie: string;
let otherAdminCookie: string;

const get = (url: string, cookie = adminCookie) =>
  api.inject({ url, headers: requestHeaders(cookie) });
const post = (url: string, payload: object, cookie = adminCookie) =>
  api.inject({
    method: 'POST',
    url,
    headers: requestHeaders(cookie),
    payload,
  });
const errorOf = (body: string) => adminApiErrorSchema.parse(JSON.parse(body));
const newTag = () =>
  `T${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
const group = (tag: string) => ({ group: { tag } });

beforeAll(async () => {
  fixture = await createFixture(connections);
  await ensureStatementPartitions(connections);
  adminCookie = (await login(api, fixture.admin)).cookie;
  otherAdminCookie = (await login(api, fixture.otherAdmin)).cookie;
});

const logsOf = async (action: string, tenantId: string | null = null) =>
  (
    await connections.owner.pool.query<{
      id: string;
      admin_id: string | null;
      tenant_id: string | null;
      target: string;
      details: {
        actor: { id: string; name: string };
        target: { kind: string; id: string };
        content: Record<string, unknown>;
      };
    }>(
      `SELECT id,admin_id,tenant_id,target,details FROM public.operation_logs
       WHERE action = $1 AND ($2::uuid IS NULL OR tenant_id = $2) ORDER BY created_at,id`,
      [action, tenantId],
    )
  ).rows;
const one = async <T extends object>(text: string, values: unknown[] = []) =>
  (await connections.owner.pool.query<T>(text, values)).rows[0]!;
const balanceOf = async (tenantId: string) =>
  (
    await one<{ balance: string }>(
      'select balance::text from tenant_balances where tenant_id = $1',
      [tenantId],
    )
  ).balance;
const ledgerCount = async (tenantId: string) =>
  (
    await one<{ n: number }>(
      'select count(*)::int as n from ledger_entries where tenant_id = $1',
      [tenantId],
    )
  ).n;

describe('GET /api/admin/unassigned-cdrs/{summary,groups}', () => {
  it('counts pending and ignored rows', async () => {
    const read = async () =>
      adminUnassignedSummaryResponseSchema.parse(
        (await get('/api/admin/unassigned-cdrs/summary')).json(),
      );
    const before = await read();
    const tag = newTag();
    const rows = await insertUnassigned(connections.owner, [
      { tag },
      { tag },
      { tag },
    ]);
    expect(await read()).toEqual({
      pending: before.pending + 3,
      ignored: before.ignored,
    });
    const ignored = await post('/api/admin/unassigned-cdrs/ignore', {
      selection: { ids: [rows[0]!.id] },
      reason: '测试呼叫',
    });
    expect(ignored.statusCode, ignored.body).toBe(200);
    expect(await read()).toEqual({
      pending: before.pending + 2,
      ignored: before.ignored + 1,
    });
  });

  it('groups pending rows by tag with their reasons and similar tenant codes', async () => {
    const tenant = await rateTenant(connections.owner);
    const typo = `${tenant.code}X`;
    const empty = await insertUnassigned(connections.owner, [
      { tag: '', reason: '缺少租户标签' },
      { tag: '', reason: '缺少租户标签' },
    ]);
    await insertUnassigned(connections.owner, [
      { tag: typo },
      { tag: typo },
      { tag: typo, reason: '接通时无费率' },
      { tag: typo, callUuid: null },
      { tag: typo, callUuid: null },
    ]);
    expect(empty).toHaveLength(2);
    const response = await get('/api/admin/unassigned-cdrs/groups');
    expect(response.statusCode, response.body).toBe(200);
    const body = adminUnassignedGroupsResponseSchema.parse(response.json());
    const found = body.groups.find((candidate) => candidate.tag === typo);
    expect(found).toMatchObject({
      tag: typo,
      count: 5,
      suggestedTenants: [
        {
          id: tenant.id,
          code: tenant.code,
          name: expect.any(String) as string,
        },
      ],
    });
    // 校验失败的原因带每行不同的明细，合成一类；条数降序。
    expect(found?.reasons).toHaveLength(3);
    expect(found?.reasons.map((entry) => entry.count)).toEqual([2, 2, 1]);
    expect(found?.reasons).toEqual(
      expect.arrayContaining([
        { reason: '话单校验失败', count: 2 },
        { reason: '租户不存在', count: 2 },
        { reason: '接通时无费率', count: 1 },
      ]),
    );
    // 标签为空的分组没有相近租户。
    const blank = body.groups.find((candidate) => candidate.tag === '');
    expect(blank?.suggestedTenants).toEqual([]);
    expect(blank?.reasons).toContainEqual({ reason: '缺少租户标签', count: 2 });
    expect(body.total).toBe(
      body.groups.reduce((sum, candidate) => sum + candidate.count, 0),
    );
    // 条数降序。
    expect(body.groups.map((candidate) => candidate.count)).toEqual(
      [...body.groups.map((candidate) => candidate.count)].sort(
        (a, b) => b - a,
      ),
    );
    // 大小写不同也算相近。
    const lower = `${tenant.code.toLowerCase()}`;
    await insertUnassigned(connections.owner, [{ tag: lower }]);
    const again = adminUnassignedGroupsResponseSchema.parse(
      (await get('/api/admin/unassigned-cdrs/groups')).json(),
    );
    expect(
      again.groups.find((candidate) => candidate.tag === lower)
        ?.suggestedTenants[0]?.code,
    ).toBe(tenant.code);
  });
});

describe('GET /api/admin/unassigned-cdrs', () => {
  it('pages one tag, newest first, and marks the rows that can only be ignored', async () => {
    const tag = newTag();
    await insertUnassigned(connections.owner, [
      { tag, answeredAt: '2026-09-10 10:00:00' },
      { tag, answeredAt: '2026-09-11 10:00:00' },
      { tag, answeredAt: '2026-09-12 10:00:00' },
      { tag, answeredAt: '2026-09-13 10:00:00', reason: '接通时无费率' },
      { tag, answeredAt: null },
      // 没有通话身份、没有计费号码、原因不可分配。
      { tag, callUuid: null },
      { tag, billingNumber: null, reason: '号码格式错误' },
      { tag, reason: '计费号码不一致' },
    ]);
    const first = await get(
      `/api/admin/unassigned-cdrs?tag=${tag}&pageSize=3&page=1`,
    );
    expect(first.statusCode, first.body).toBe(200);
    const page = adminUnassignedListResponseSchema.parse(first.json());
    expect(page.status).toBe('pending');
    expect(page.pagination).toEqual({ page: 1, pageSize: 3, total: 8 });
    expect(page.items).toHaveLength(3);
    const all = adminUnassignedListResponseSchema.parse(
      (await get(`/api/admin/unassigned-cdrs?tag=${tag}&pageSize=100`)).json(),
    );
    expect(all.items).toHaveLength(8);
    const assignable = all.items.filter((row) => row.assignable);
    // 租户不存在 × 4（含未接通）与接通时无费率 × 1 可分配；其余三行只能忽略。
    expect(assignable).toHaveLength(5);
    const blocked = all.items.filter((row) => !row.assignable);
    expect(blocked).toHaveLength(3);
    expect(blocked.map((row) => row.reason)).toEqual(
      expect.arrayContaining(['号码格式错误', '计费号码不一致']),
    );
    expect(
      blocked.filter((row) => row.reason.startsWith('话单校验失败')),
    ).toHaveLength(1);
    expect(all.items.find((row) => row.callUuid === null)).toMatchObject({
      time: null,
      assignable: false,
      pushCount: 1,
      ignore: null,
    });
    const times = all.items
      .map((row) => row.time)
      .filter((time): time is string => time !== null);
    expect(times).toEqual([...times].sort().reverse());
    // 第二页接着第一页，不重复。
    const second = adminUnassignedListResponseSchema.parse(
      (
        await get(`/api/admin/unassigned-cdrs?tag=${tag}&pageSize=3&page=2`)
      ).json(),
    );
    expect(second.items.map((row) => row.id)).toEqual(
      all.items.slice(3, 6).map((row) => row.id),
    );
  });

  it('lists ignored rows with the reason, the administrator and the time', async () => {
    const tag = newTag();
    const rows = await insertUnassigned(connections.owner, [{ tag }, { tag }]);
    await post('/api/admin/unassigned-cdrs/ignore', {
      selection: { ids: [rows[0]!.id] },
      reason: '内部线路',
    });
    const pending = adminUnassignedListResponseSchema.parse(
      (await get(`/api/admin/unassigned-cdrs?tag=${tag}`)).json(),
    );
    expect(pending.items.map((row) => row.id)).toEqual([rows[1]!.id]);
    const ignored = adminUnassignedListResponseSchema.parse(
      (
        await get(`/api/admin/unassigned-cdrs?tag=${tag}&status=ignored`)
      ).json(),
    );
    expect(ignored.status).toBe('ignored');
    expect(ignored.items).toHaveLength(1);
    expect(ignored.items[0]).toMatchObject({
      id: rows[0]!.id,
      ignore: {
        reason: '内部线路',
        by: { id: fixture.admin.profileId, name: 'admin' },
        at: expect.any(String) as string,
      },
    });
    // 不属于这个标签的筛选看不到。
    expect(
      adminUnassignedListResponseSchema.parse(
        (
          await get(`/api/admin/unassigned-cdrs?tag=${newTag()}&status=ignored`)
        ).json(),
      ).items,
    ).toEqual([]);
  });

  it('refuses an unknown status and an oversized page', async () => {
    for (const query of ['status=assigned', 'pageSize=101', 'page=0', 'x=1'])
      expect(
        (await get(`/api/admin/unassigned-cdrs?${query}`)).statusCode,
        query,
      ).toBe(400);
  });
});

describe('assign preview and assign', () => {
  /** 一个有费率的租户和 3 条可分配话单（每条 2 分钟 × 0.05 = 0.10）加 1 条接通早于费率生效的话单。 */
  async function scenario() {
    const tenant = await rateTenant(connections.owner, {
      firstRateAt: '2026-06-01 00:00:00',
    });
    const tag = newTag();
    await insertUnassigned(connections.owner, [
      { tag },
      { tag },
      { tag },
      { tag, answeredAt: '2026-05-20 10:00:00' },
    ]);
    return { tenant, tag };
  }

  it('previews the figures without writing anything', async () => {
    const { tenant, tag } = await scenario();
    const logs = (await logsOf('unassigned_assign')).length;
    const response = await post('/api/admin/unassigned-cdrs/assign-preview', {
      tenantId: tenant.id,
      selection: group(tag),
    });
    expect(response.statusCode, response.body).toBe(200);
    const preview = adminUnassignedPreviewResponseSchema.parse(response.json());
    expect(preview).toMatchObject({
      tenant: { id: tenant.id, code: tenant.code, currency: 'CNY' },
      selected: 4,
      assignable: 3,
      chargeTotal: '0.3',
      currency: 'CNY',
      noRate: { count: 1 },
      blocked: { count: 0, months: [] },
      notAssignable: { count: 0, reasons: [] },
      balance: { current: '0', afterEstimate: '-0.3' },
      affectedMonths: [{ month: '2026-09', statementState: 'none' }],
    });
    expect(preview.noRate.groups).toHaveLength(1);
    expect(preview.noRate.groups[0]).toMatchObject({
      reason: 'before_first_version',
      prefixHint: { prefix: '86', country: '中国' },
      count: 1,
      firstEffectiveFrom: '2026-05-31T16:00:00.000Z',
      samples: [{ billingNumber: '8613800138000' }],
    });
    // 预览不落库：话单、余额、批次、日志都没变。
    expect(await balanceOf(tenant.id)).toBe('0');
    expect(await ledgerCount(tenant.id)).toBe(0);
    expect((await logsOf('unassigned_assign')).length).toBe(logs);
    expect(
      (
        await one<{ n: number }>(
          `select count(*)::int as n from unassigned_cdrs where tenant_tag = $1 and status = 'pending'`,
          [tag],
        )
      ).n,
    ).toBe(4);
  });

  it('assigns with the previewed figures, charges once and writes one audit entry', async () => {
    const { tenant, tag } = await scenario();
    const selection = group(tag);
    const preview = adminUnassignedPreviewResponseSchema.parse(
      (
        await post('/api/admin/unassigned-cdrs/assign-preview', {
          tenantId: tenant.id,
          selection,
        })
      ).json(),
    );
    const request = {
      tenantId: tenant.id,
      selection,
      idempotencyKey: `assign-${randomUUID()}`,
      expected: {
        assignable: preview.assignable,
        noRate: preview.noRate.count,
        chargeTotal: preview.chargeTotal,
      },
    };
    const response = await post('/api/admin/unassigned-cdrs/assign', request);
    expect(response.statusCode, response.body).toBe(200);
    const result = adminUnassignedAssignResponseSchema.parse(response.json());
    expect(result).toMatchObject({
      replayed: false,
      tenantId: tenant.id,
      currency: 'CNY',
      assigned: 3,
      noRate: 1,
      blocked: 0,
      chargeTotal: '0.3',
      balanceBefore: '0',
      balanceAfter: '-0.3',
      affectedMonths: [{ month: '2026-09', statementState: 'none' }],
    });
    expect(await balanceOf(tenant.id)).toBe('-0.3');
    expect(await ledgerCount(tenant.id)).toBe(3);
    // 无费率的那条留在待处理。
    const rest = adminUnassignedListResponseSchema.parse(
      (await get(`/api/admin/unassigned-cdrs?tag=${tag}`)).json(),
    );
    expect(rest.items).toHaveLength(1);
    const audits = await logsOf('unassigned_assign', tenant.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      id: result.auditId,
      admin_id: fixture.admin.profileId,
      target: result.assignmentId,
      details: {
        target: { kind: 'unassigned_batch', id: result.assignmentId },
        content: {
          sourceTag: tag,
          assignedCount: 3,
          noRateCount: 1,
          chargeTotal: '0.3',
          currency: 'CNY',
          affectedMonths: ['2026-09'],
          changes: [
            { field: 'callCount', before: null, after: '3' },
            { field: 'amount', before: null, after: '0.3' },
            { field: 'balance', before: '0', after: '-0.3' },
          ],
        },
      },
    });

    // 同键重放：返回原结果，不再扣费、不再写日志。
    const replay = await post('/api/admin/unassigned-cdrs/assign', request);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(adminUnassignedAssignResponseSchema.parse(replay.json())).toEqual({
      ...result,
      replayed: true,
    });
    expect(await balanceOf(tenant.id)).toBe('-0.3');
    expect(await ledgerCount(tenant.id)).toBe(3);
    expect(await logsOf('unassigned_assign', tenant.id)).toHaveLength(1);

    // 同键、另一个操作人：409 IDEMPOTENCY_CONFLICT。
    const stolen = await post(
      '/api/admin/unassigned-cdrs/assign',
      request,
      otherAdminCookie,
    );
    expect(stolen.statusCode).toBe(409);
    expect(errorOf(stolen.body).error.code).toBe('IDEMPOTENCY_CONFLICT');
    // 同键、另一份选择：409。
    const changed = await post('/api/admin/unassigned-cdrs/assign', {
      ...request,
      expected: { ...request.expected, chargeTotal: '9' },
    });
    expect(changed.statusCode).toBe(409);
    expect(errorOf(changed.body).error.code).toBe('IDEMPOTENCY_CONFLICT');

    // 另一个键、同一分组：只剩无费率的一条，没有可分配的，409 UNASSIGNED_NOTHING_TO_ASSIGN。
    const nothing = await post('/api/admin/unassigned-cdrs/assign', {
      ...request,
      idempotencyKey: `assign-${randomUUID()}`,
      expected: { assignable: 0, noRate: 1, chargeTotal: '0' },
    });
    expect(nothing.statusCode).toBe(409);
    expect(errorOf(nothing.body).error.code).toBe(
      'UNASSIGNED_NOTHING_TO_ASSIGN',
    );
    expect(await ledgerCount(tenant.id)).toBe(3);
    expect(await logsOf('unassigned_assign', tenant.id)).toHaveLength(1);
  });

  it('answers 409 when the figures changed since the preview and changes nothing', async () => {
    const { tenant, tag } = await scenario();
    const preview = adminUnassignedPreviewResponseSchema.parse(
      (
        await post('/api/admin/unassigned-cdrs/assign-preview', {
          tenantId: tenant.id,
          selection: group(tag),
        })
      ).json(),
    );
    // 预览之后又有一条话单进了这个分组。
    await insertUnassigned(connections.owner, [{ tag }]);
    const response = await post('/api/admin/unassigned-cdrs/assign', {
      tenantId: tenant.id,
      selection: group(tag),
      idempotencyKey: `assign-${randomUUID()}`,
      expected: {
        assignable: preview.assignable,
        noRate: preview.noRate.count,
        chargeTotal: preview.chargeTotal,
      },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(errorOf(response.body).error.code).toBe('UNASSIGNED_PREVIEW_STALE');
    expect(await balanceOf(tenant.id)).toBe('0');
    expect(await ledgerCount(tenant.id)).toBe(0);
    expect(await logsOf('unassigned_assign', tenant.id)).toEqual([]);
  });

  it('answers 400 for more rows than one batch and 404 for an unknown tenant', async () => {
    const { tenant } = await scenario();
    const ids = Array.from({ length: 501 }, () => randomUUID());
    for (const url of [
      '/api/admin/unassigned-cdrs/assign-preview',
      '/api/admin/unassigned-cdrs/assign',
    ]) {
      const response = await post(url, {
        tenantId: tenant.id,
        selection: { ids },
        idempotencyKey: 'too-many',
        expected: { assignable: 0, noRate: 0, chargeTotal: '0' },
      });
      expect(response.statusCode, url).toBe(400);
      expect(errorOf(response.body).error.code).toBe('VALIDATION_ERROR');
    }
    const unknown = await post('/api/admin/unassigned-cdrs/assign-preview', {
      tenantId: randomUUID(),
      selection: { ids: [randomUUID()] },
    });
    expect(unknown.statusCode).toBe(404);
    const malformed = await post('/api/admin/unassigned-cdrs/assign-preview', {
      tenantId: tenant.id,
      selection: { ids: [] },
    });
    expect(malformed.statusCode).toBe(400);
  });
});

describe('ignore and unignore', () => {
  it('ignores with a reason, restores to pending and logs both', async () => {
    const tag = newTag();
    const rows = await insertUnassigned(connections.owner, [
      { tag },
      { tag, callUuid: null },
    ]);
    const selection = group(tag);
    const ignore = await post('/api/admin/unassigned-cdrs/ignore', {
      selection,
      reason: '  测试呼叫  ',
    });
    expect(ignore.statusCode, ignore.body).toBe(200);
    const ignored = adminUnassignedResolveResponseSchema.parse(ignore.json());
    expect(ignored.changed).toBe(2);
    expect(ignored.auditId).not.toBeNull();
    const [audit] = (await logsOf('unassigned_ignore')).filter(
      (log) => log.id === ignored.auditId,
    );
    expect(audit).toMatchObject({
      admin_id: fixture.admin.profileId,
      tenant_id: null,
      details: {
        target: { kind: 'unassigned_batch', id: ignored.auditId },
        content: { count: 2, reason: '测试呼叫', sourceTag: tag },
      },
    });

    // 重复提交：什么都不变，不写日志。
    const again = await post('/api/admin/unassigned-cdrs/ignore', {
      selection,
      reason: '测试呼叫',
    });
    expect(adminUnassignedResolveResponseSchema.parse(again.json())).toEqual({
      changed: 0,
      auditId: null,
    });

    const restore = await post('/api/admin/unassigned-cdrs/unignore', {
      selection: { ids: rows.map((row) => row.id) },
    });
    expect(restore.statusCode, restore.body).toBe(200);
    const restored = adminUnassignedResolveResponseSchema.parse(restore.json());
    expect(restored.changed).toBe(2);
    expect(
      (await logsOf('unassigned_unignore')).some(
        (log) =>
          log.id === restored.auditId && log.details.content['count'] === 2,
      ),
    ).toBe(true);
    const pending = adminUnassignedListResponseSchema.parse(
      (await get(`/api/admin/unassigned-cdrs?tag=${tag}`)).json(),
    );
    expect(pending.items).toHaveLength(2);
    expect(pending.items.every((row) => row.ignore === null)).toBe(true);
    expect(
      adminUnassignedResolveResponseSchema.parse(
        (
          await post('/api/admin/unassigned-cdrs/unignore', { selection })
        ).json(),
      ),
    ).toEqual({ changed: 0, auditId: null });
  });

  it('refuses a missing or blank reason and a malformed selection', async () => {
    const tag = newTag();
    await insertUnassigned(connections.owner, [{ tag }]);
    for (const payload of [
      { selection: group(tag) },
      { selection: group(tag), reason: '' },
      { selection: group(tag), reason: '   ' },
      { selection: group(tag), reason: 'x'.repeat(2001) },
      { selection: {}, reason: 'x' },
      { selection: { ids: ['nope'] }, reason: 'x' },
    ]) {
      const response = await post('/api/admin/unassigned-cdrs/ignore', payload);
      expect(response.statusCode, JSON.stringify(payload).slice(0, 80)).toBe(
        400,
      );
    }
    expect(
      adminUnassignedListResponseSchema.parse(
        (await get(`/api/admin/unassigned-cdrs?tag=${tag}`)).json(),
      ).items,
    ).toHaveLength(1);
  });
});

describe('a deactivated administrator', () => {
  it('loses the session at once and cannot assign, ignore, delete or read', async () => {
    const extra = await createFixture(connections);
    const session = await login(api, extra.admin);
    const tenant = await rateTenant(connections.owner);
    const tag = newTag();
    await insertUnassigned(connections.owner, [{ tag }]);
    expect(
      (await get('/api/admin/unassigned-cdrs', session.cookie)).statusCode,
    ).toBe(200);
    const disable = await post(
      `/api/admin/admins/${extra.admin.profileId}/disable`,
      {},
    );
    expect(disable.statusCode, disable.body).toBe(200);
    const calls = [
      get('/api/admin/unassigned-cdrs/summary', session.cookie),
      post(
        '/api/admin/unassigned-cdrs/assign',
        {
          tenantId: tenant.id,
          selection: group(tag),
          idempotencyKey: 'disabled',
          expected: { assignable: 1, noRate: 0, chargeTotal: '0.1' },
        },
        session.cookie,
      ),
      post(
        '/api/admin/unassigned-cdrs/ignore',
        { selection: group(tag), reason: 'x' },
        session.cookie,
      ),
      post(
        `/api/admin/tenants/${tenant.id}/cdr-deletions`,
        {
          fromMonth: '2026-08',
          toMonth: '2026-08',
          tenantCode: tenant.code,
          expectedCount: 0,
        },
        session.cookie,
      ),
    ];
    for (const response of await Promise.all(calls))
      expect(response.statusCode).toBe(401);
    expect(await ledgerCount(tenant.id)).toBe(0);
  });
});

describe('seed data', () => {
  const seeded = seededApi();

  const seededPost = (url: string, payload: object) =>
    seeded.api().inject({
      method: 'POST',
      url,
      headers: requestHeaders(seeded.cookie()),
      payload,
    });

  it('returns the mockup figures through the preview and assign endpoints', async () => {
    const owner = seeded.owner();
    const abc001 = (
      await owner.pool.query<{ id: string }>(
        `select id from tenants where code = 'ABC001'`,
      )
    ).rows[0]!.id;
    const groups = adminUnassignedGroupsResponseSchema.parse(
      (
        await seeded.api().inject({
          url: '/api/admin/unassigned-cdrs/groups',
          headers: requestHeaders(seeded.cookie()),
        })
      ).json(),
    );
    expect(
      groups.groups.find((candidate) => candidate.tag === 'ABC01'),
    ).toMatchObject({
      count: 326,
      reasons: [{ reason: '租户不存在', count: 326 }],
      suggestedTenants: [{ id: abc001, code: 'ABC001' }],
    });

    const previewed = await seededPost(
      '/api/admin/unassigned-cdrs/assign-preview',
      { tenantId: abc001, selection: group('ABC01') },
    );
    expect(previewed.statusCode, previewed.body).toBe(200);
    const preview = adminUnassignedPreviewResponseSchema.parse(
      previewed.json(),
    );
    expect(preview).toMatchObject({
      tenant: { code: 'ABC001', currency: 'CNY' },
      selected: 326,
      assignable: 324,
      chargeTotal: '58.35',
      noRate: { count: 2 },
      balance: { current: '-35.2', afterEstimate: '-93.55' },
      affectedMonths: [{ month: '2026-09', statementState: 'final' }],
    });
    // 「前缀 1876」来自 prefixHint；2 条的接通早于第一个费率版本（决定 36、37）。
    expect(preview.noRate.groups).toMatchObject([
      {
        reason: 'before_first_version',
        prefixHint: { prefix: '1876', country: '牙买加' },
        count: 2,
        firstEffectiveFrom: '2026-08-12T01:30:00.000Z',
      },
    ]);

    const request = {
      tenantId: abc001,
      selection: group('ABC01'),
      idempotencyKey: 'mockup-figures',
      expected: { assignable: 324, noRate: 2, chargeTotal: '58.35' },
    };
    const assigned = await seededPost(
      '/api/admin/unassigned-cdrs/assign',
      request,
    );
    expect(assigned.statusCode, assigned.body).toBe(200);
    const result = adminUnassignedAssignResponseSchema.parse(assigned.json());
    expect(result).toMatchObject({
      replayed: false,
      assigned: 324,
      noRate: 2,
      chargeTotal: '58.35',
      balanceBefore: '-35.2',
      balanceAfter: '-93.55',
      affectedMonths: [{ month: '2026-09', statementState: 'final' }],
    });
    // 余额减少 58.35，324 笔通话扣费流水，2 条无费率的留在待处理。
    const after = (
      await owner.pool.query<{
        balance: string;
        charges: number;
        pending: number;
      }>(
        `select (select balance::text from tenant_balances where tenant_id = $1) as balance,
                (select count(*)::int from ledger_entries where tenant_id = $1
                  and kind = 'call_charge' and created_at > now() - interval '5 minutes') as charges,
                (select count(*)::int from unassigned_cdrs where tenant_tag = 'ABC01' and status = 'pending') as pending`,
        [abc001],
      )
    ).rows[0];
    expect(after).toEqual({ balance: '-93.550', charges: 324, pending: 2 });
  });

  it('replays the stored result for the same idempotency key', async () => {
    const owner = seeded.owner();
    const abc001 = (
      await owner.pool.query<{ id: string }>(
        `select id from tenants where code = 'ABC001'`,
      )
    ).rows[0]!.id;
    const request = {
      tenantId: abc001,
      selection: group('ABC01'),
      idempotencyKey: 'mockup-figures',
      expected: { assignable: 324, noRate: 2, chargeTotal: '58.35' },
    };
    const before = (
      await owner.pool.query<{ balance: string }>(
        'select balance::text from tenant_balances where tenant_id = $1',
        [abc001],
      )
    ).rows[0]!.balance;
    const replay = await seededPost(
      '/api/admin/unassigned-cdrs/assign',
      request,
    );
    expect(replay.statusCode, replay.body).toBe(200);
    expect(
      adminUnassignedAssignResponseSchema.parse(replay.json()),
    ).toMatchObject({
      replayed: true,
      assigned: 324,
      balanceAfter: '-93.55',
    });
    // 另一个键、同一分组：2 条无费率的没有可分配的。
    const other = await seededPost('/api/admin/unassigned-cdrs/assign', {
      ...request,
      idempotencyKey: 'another-key',
      expected: { assignable: 0, noRate: 2, chargeTotal: '0' },
    });
    expect(other.statusCode).toBe(409);
    expect(errorOf(other.body).error.code).toBe('UNASSIGNED_NOTHING_TO_ASSIGN');
    expect(
      (
        await owner.pool.query<{ balance: string }>(
          'select balance::text from tenant_balances where tenant_id = $1',
          [abc001],
        )
      ).rows[0]!.balance,
    ).toBe(before);
  });
});
