import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { beijingTime, rate } from '@fs-billing/rating';
import {
  adminId,
  adminTransaction,
  connections,
  deferred,
  pgError,
  tenantId as tenantIdOf,
} from '../../test/support.js';
import { scratchDatabase } from '../../test/scratch.js';
import { ensureStatementPartitions } from '../../test/statements.js';
import { insertUnassigned, rateTenant } from '../../test/unassigned.js';
import { lockTenants, withAdmin, withSystem } from '../client.js';
import { createRateVersion, loadRatingTenant } from '../rates.js';
import { reconcileTenantStatements } from '../statements/index.js';
import {
  assignUnassigned,
  describeAffectedMonths,
  previewAssignment,
  UnassignedError,
  type AssignmentPreview,
  type UnassignedSelection,
} from './index.js';

const { app, owner } = connections();
let administrator: string;
let actor: { id: string; name: string };
beforeAll(async () => {
  administrator = await adminId(owner);
  actor = { id: administrator, name: '王敏' };
  await ensureStatementPartitions(app);
});

const newTag = () =>
  `T${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
const group = (tag: string): UnassignedSelection => ({ group: { tag } });
const expectedOf = (preview: AssignmentPreview) => ({
  assignable: preview.assignable,
  noRate: preview.noRate.count,
  chargeTotal: preview.chargeTotal,
});

/** 预览再按预览的数字提交，和页面的两步流程一致。 */
async function previewAndAssign(
  tenantId: string,
  selection: UnassignedSelection,
  key = randomUUID(),
  conn = app,
) {
  const preview = await previewAssignment(conn.db, { tenantId, selection });
  const result = await assignUnassigned(conn.db, {
    actor,
    tenantId,
    selection,
    idempotencyKey: key,
    expected: expectedOf(preview),
  });
  return { preview, result, key };
}

const one = async <T extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
) => (await owner.pool.query<T>(text, values)).rows[0]!;
const ledgerCount = async (tenantId: string) =>
  (
    await one<{ n: number }>(
      'select count(*)::int as n from ledger_entries where tenant_id = $1',
      [tenantId],
    )
  ).n;
const balanceOf = async (tenantId: string) =>
  (
    await one<{ balance: string }>(
      'select balance::text from tenant_balances where tenant_id = $1',
      [tenantId],
    )
  ).balance;
const cdrCount = async (tenantId: string) =>
  (
    await one<{ n: number }>(
      'select count(*)::int as n from cdrs where tenant_id = $1',
      [tenantId],
    )
  ).n;
const statusCounts = async (tag: string) =>
  Object.fromEntries(
    (
      await owner.pool.query<{ status: string; n: number }>(
        'select status, count(*)::int as n from unassigned_cdrs where tenant_tag = $1 group by 1',
        [tag],
      )
    ).rows.map((row) => [row.status, row.n]),
  );

/** 验收标准 1：种子数据下把 ABC01 的 326 条分配给 ABC001。提交会改变种子数字，所以在单独的库里做。 */
describe('验收标准 1 与 2：种子数据 ABC01 → ABC001', () => {
  const seeded = scratchDatabase({ seed: true });
  let abc001: string;
  let seedAdmin: string;
  const seedActor = () => ({ id: seedAdmin, name: '王敏' });
  const seedExpected = {
    assignable: 324,
    noRate: 2,
    chargeTotal: '58.35',
  };
  const abcSelection = group('ABC01');

  beforeAll(async () => {
    abc001 = await tenantIdOf(seeded.app, 'ABC001');
    seedAdmin = await adminId(seeded.owner);
  });

  const seededOne = async <T extends Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ) => (await seeded.owner.pool.query<T>(text, values)).rows[0]!;

  it('previews 326 ABC01 rows against ABC001 as 324 assignable, 58.35 and 2 without a rate', async () => {
    const before = await seededOne<{
      pending: number;
      logs: number;
      batches: number;
    }>(
      `select (select count(*)::int from unassigned_cdrs where status = 'pending' and tenant_tag = 'ABC01') as pending,
              (select count(*)::int from operation_logs) as logs,
              (select count(*)::int from unassigned_assignments) as batches`,
    );
    expect(before.pending).toBe(326);

    const preview = await previewAssignment(seeded.app.db, {
      tenantId: abc001,
      selection: abcSelection,
    });
    expect(preview).toMatchObject({
      tenant: { code: 'ABC001', currency: 'CNY' },
      selected: 326,
      assignable: 324,
      chargeTotal: '58.35',
      currency: 'CNY',
      noRate: { count: 2 },
      blocked: { count: 0, months: [] },
      notAssignable: { count: 0, reasons: [] },
      balance: { current: '-35.2', afterEstimate: '-93.55' },
      affectedMonths: [{ month: '2026-09', statementState: 'final' }],
    });
    // 2 条无费率：接通在 2026-08-05，早于 ABC001 第一个费率版本（2026-08-12 09:30）；
    // 「前缀 1876」来自租户任一版本里的最长前缀匹配。
    expect(preview.noRate.groups).toHaveLength(1);
    expect(preview.noRate.groups[0]).toMatchObject({
      reason: 'before_first_version',
      prefixHint: { prefix: '1876', country: '牙买加' },
      count: 2,
      firstEffectiveFrom: beijingTime('2026-08-12 09:30:00'),
    });
    expect(
      preview.noRate.groups[0]!.samples.map((s) => s.billingNumber).sort(),
    ).toEqual(['18765551234', '18765559876']);

    // 预览不落库：话单、余额、批次、日志都没变。
    expect(
      await seededOne(
        `select (select count(*)::int from unassigned_cdrs where status = 'pending' and tenant_tag = 'ABC01') as pending,
                (select count(*)::int from operation_logs) as logs,
                (select count(*)::int from unassigned_assignments) as batches`,
      ),
    ).toEqual(before);
  });

  it('assigning charges 58.35 and writes one call_charge per assignable row', async () => {
    const before = await seededOne<{ cdrs: number; ledger: number }>(
      `select (select count(*)::int from cdrs where tenant_id = $1) as cdrs,
              (select count(*)::int from ledger_entries where tenant_id = $1) as ledger`,
      [abc001],
    );
    const result = await assignUnassigned(seeded.app.db, {
      actor: seedActor(),
      tenantId: abc001,
      selection: abcSelection,
      idempotencyKey: 'seed-acceptance-1',
      expected: seedExpected,
    });
    expect(result).toMatchObject({
      replayed: false,
      currency: 'CNY',
      assigned: 324,
      noRate: 2,
      blocked: 0,
      chargeTotal: '58.35',
      balanceBefore: '-35.2',
      balanceAfter: '-93.55',
      affectedMonths: [{ month: '2026-09', statementState: 'final' }],
    });

    // 余额减少 58.35，缓存余额等于流水合计。
    expect(
      await seededOne(
        `select trim_scale(b.balance)::text as balance,
                (select trim_scale(sum(amount))::text from ledger_entries where tenant_id = $1) as ledger_total
         from tenant_balances b where b.tenant_id = $1`,
        [abc001],
      ),
    ).toEqual({ balance: '-93.55', ledger_total: '-93.55' });
    const after = await seededOne<{ cdrs: number; ledger: number }>(
      `select (select count(*)::int from cdrs where tenant_id = $1) as cdrs,
              (select count(*)::int from ledger_entries where tenant_id = $1) as ledger`,
      [abc001],
    );
    expect(after).toEqual({
      cdrs: before.cdrs + 324,
      ledger: before.ledger + 324,
    });

    // 每条已分配话单恰有一笔 call_charge：幂等键 call:<UUID>，金额等于话单费用，occurred_at 是接通时间。
    const matched = await seededOne(
      `select count(*)::int as rows,
              count(l.id)::int as ledgers,
              (count(*) filter (where l.occurred_at = u.answered_at and l.amount = -c.charge and l.kind = 'call_charge'))::int as consistent,
              trim_scale(sum(l.amount))::text as total
       from unassigned_cdrs u
       join cdrs c on c.call_uuid = u.call_uuid and c.tenant_id = $1
       left join ledger_entries l on l.tenant_id = $1 and l.idempotency_key = 'call:' || u.call_uuid::text
       where u.status = 'assigned'`,
      [abc001],
    );
    expect(matched).toEqual({
      rows: 324,
      ledgers: 324,
      consistent: 324,
      total: '-58.35',
    });

    // 剩下的就是 2 条无费率话单，保持待处理；话单状态与批次一致，call_uuids 已被认领。
    expect(
      (
        await seeded.owner.pool.query(
          `select status, reason, count(*)::int as n, count(assignment_id)::int as batched
           from unassigned_cdrs where tenant_tag = 'ABC01' group by 1, 2 order by 1`,
        )
      ).rows,
    ).toEqual([
      { status: 'assigned', reason: '租户不存在', n: 324, batched: 324 },
      { status: 'pending', reason: '租户不存在', n: 2, batched: 0 },
    ]);
    expect(
      await seededOne(
        `select count(*)::int as unclaimed from unassigned_cdrs u
         join call_uuids c on c.call_uuid = u.call_uuid
         where u.status = 'assigned' and c.tenant_id is distinct from $1::uuid`,
        [abc001],
      ),
    ).toEqual({ unclaimed: 0 });
    expect(
      await seededOne(
        `select assigned_count, no_rate_count, blocked_count, charge_total::text as charge,
                balance_before::text as before, balance_after::text as after,
                to_char(affected_months[1], 'YYYY-MM-DD') as month, source_tag, idempotency_key
         from unassigned_assignments where tenant_id = $1`,
        [abc001],
      ),
    ).toEqual({
      assigned_count: 324,
      no_rate_count: 2,
      blocked_count: 0,
      charge: '58.35',
      before: '-35.2',
      after: '-93.55',
      month: '2026-09-01',
      source_tag: 'ABC01',
      idempotency_key: 'seed-acceptance-1',
    });

    // 同事务写入的操作日志：对象是批次，余额前后与扣费合计在变更里。
    const audit = await seededOne<{
      action: string;
      admin_id: string;
      tenant_id: string;
      target: string;
      details: { content: Record<string, unknown>; target: { kind: string } };
    }>(
      `select l.action, l.admin_id, l.tenant_id, l.target, l.details
       from operation_logs l join unassigned_assignments a on a.audit_id = l.id`,
    );
    expect(audit).toMatchObject({
      action: 'unassigned_assign',
      admin_id: seedAdmin,
      tenant_id: abc001,
      details: {
        target: { kind: 'unassigned_batch' },
        content: {
          sourceTag: 'ABC01',
          assignedCount: 324,
          noRateCount: 2,
          blockedCount: 0,
          chargeTotal: '58.35',
          currency: 'CNY',
          affectedMonths: ['2026-09'],
          changes: [
            { field: 'callCount', before: null, after: '324' },
            { field: 'amount', before: null, after: '58.35' },
            { field: 'balance', before: '-35.2', after: '-93.55' },
          ],
        },
      },
    });
  });

  it('submitting the same batch twice charges once', async () => {
    const counts = () =>
      seededOne(
        `select (select count(*)::int from ledger_entries where tenant_id = $1) as ledger,
                (select count(*)::int from cdrs where tenant_id = $1) as cdrs,
                (select count(*)::int from unassigned_assignments) as batches,
                (select count(*)::int from operation_logs where action = 'unassigned_assign') as audits,
                (select trim_scale(balance)::text from tenant_balances where tenant_id = $1) as balance`,
        [abc001],
      );
    const before = await counts();

    // 同键重放：返回原结果，什么都不再执行。
    const replay = await assignUnassigned(seeded.app.db, {
      actor: seedActor(),
      tenantId: abc001,
      selection: abcSelection,
      idempotencyKey: 'seed-acceptance-1',
      expected: seedExpected,
    });
    expect(replay).toMatchObject({
      replayed: true,
      assigned: 324,
      chargeTotal: '58.35',
      balanceBefore: '-35.2',
      balanceAfter: '-93.55',
    });
    expect(await counts()).toEqual(before);

    // 换一个键重新提交同一批：剩下的 2 条无费率，没有可分配的，不写批次、不写日志、不扣费。
    await expect(
      assignUnassigned(seeded.app.db, {
        actor: seedActor(),
        tenantId: abc001,
        selection: abcSelection,
        idempotencyKey: 'seed-acceptance-1-again',
        expected: seedExpected,
      }),
    ).rejects.toMatchObject({
      name: 'UnassignedError',
      code: 'UNASSIGNED_NOTHING_TO_ASSIGN',
    });
    expect(await counts()).toEqual(before);
    expect(before.balance).toBe('-93.55');
  });

  it('the September statement becomes stale after the assignment and is not regenerated', async () => {
    const header = () =>
      seededOne(
        `select version, closing_balance::text as closing, calls, details_deleted
         from monthly_statements where tenant_id = $1 and month = '2026-09-01'`,
        [abc001],
      );
    const before = await header();
    expect(before).toMatchObject({ version: 1, closing: '-35.2' });

    const result = await withSystem(
      seeded.app.db,
      (tx) => reconcileTenantStatements(tx, abc001),
      { isolationLevel: 'repeatable read' },
    );
    expect(
      result.statements.map((s) => [s.month, s.status, s.diff, s.lateEntries]),
    ).toEqual([
      ['2026-08-01', 'ok', '0', 0],
      ['2026-09-01', 'stale', '-58.35', 324],
    ]);
    // 补扣费不会自动重新生成账单：头部原样不变。
    expect(await header()).toEqual(before);
    const alerts = (
      await seeded.owner.pool.query<{ kind: string; description: string }>(
        `select kind, description from system_alerts
         where tenant_id = $1 and kind = 'statement_mismatch' and recovered_at is null`,
        [abc001],
      )
    ).rows;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.description).toContain('ABC001 2026-09');
  });
});

describe('分配的规则', () => {
  it('prices each row at the rate valid when the call was answered, not the current one', async () => {
    const tenant = await rateTenant(owner);
    await withAdmin(owner.db, (tx) =>
      createRateVersion(
        tx,
        tenant.id,
        [
          {
            prefix: '86',
            country: '中国',
            iso: '',
            description: '',
            perMinute: rate('CNY', '0.1000'),
          },
        ],
        { effectiveFrom: beijingTime('2026-09-15 00:00:00') },
      ),
    );
    const tag = newTag();
    await insertUnassigned(owner, [
      { tag, answeredAt: '2026-09-10 10:00:00' },
      { tag, answeredAt: '2026-09-20 10:00:00' },
    ]);
    const { result } = await previewAndAssign(tenant.id, group(tag));
    expect(result).toMatchObject({ assigned: 2, chargeTotal: '0.3' });
    expect(
      (
        await owner.pool.query(
          `select to_char(answered_at at time zone 'Asia/Shanghai', 'MM-DD') as day, rate::text, charge::text
           from cdrs where tenant_id = $1 order by answered_at`,
          [tenant.id],
        )
      ).rows,
    ).toEqual([
      { day: '09-10', rate: '0.05', charge: '0.1' },
      { day: '09-20', rate: '0.1', charge: '0.2' },
    ]);
  });

  it('copies the call fields to cdrs and writes the charge, batch, audit and claim in one go', async () => {
    const tenant = await rateTenant(owner);
    const tag = newTag();
    const rows = await insertUnassigned(owner, [
      {
        tag,
        answeredAt: '2026-09-10 10:00:00',
        hangupCause: 'NORMAL_CLEARING',
      },
      {
        tag,
        answeredAt: '2026-09-11 10:00:00',
        seconds: 30,
        callee: '+441234567890',
        hangupCause: 'ORIGINATOR_CANCEL',
        unverified: true,
      },
      {
        tag,
        answeredAt: '2026-09-12 10:00:00',
        seconds: 130,
        callee: '+14155550123',
      },
    ]);
    const before = await one<{ received: Date }>(
      'select received_at as received from unassigned_cdrs where id = $1',
      [rows[1]!.id],
    );
    const { result } = await previewAndAssign(tenant.id, group(tag));
    expect(result).toMatchObject({
      assigned: 3,
      noRate: 0,
      chargeTotal: '0.15',
      balanceBefore: '0',
      balanceAfter: '-0.15',
    });
    expect(await balanceOf(tenant.id)).toBe('-0.15');
    expect(
      (
        await owner.pool.query(
          `select c.matched_prefix, c.country, c.billing_number, c.duration_seconds, c.billed_minutes::text as minutes,
                  c.rate::text as rate, c.charge::text as charge, c.hangup_cause, c.unverified,
                  l.amount::text as amount, l.kind, l.created_by,
                  (l.occurred_at = c.answered_at) as at_answer
           from cdrs c join ledger_entries l
             on l.tenant_id = c.tenant_id and l.idempotency_key = 'call:' || c.call_uuid::text
           where c.tenant_id = $1 order by c.answered_at`,
          [tenant.id],
        )
      ).rows,
    ).toEqual([
      {
        matched_prefix: '86',
        country: '中国',
        billing_number: '8613800138000',
        duration_seconds: 61,
        minutes: '2',
        rate: '0.05',
        charge: '0.1',
        hangup_cause: 'NORMAL_CLEARING',
        unverified: false,
        amount: '-0.1',
        kind: 'call_charge',
        created_by: null,
        at_answer: true,
      },
      {
        matched_prefix: '44',
        country: '英国',
        billing_number: '441234567890',
        duration_seconds: 30,
        minutes: '1',
        rate: '0.02',
        charge: '0.02',
        hangup_cause: 'ORIGINATOR_CANCEL',
        unverified: true,
        amount: '-0.02',
        kind: 'call_charge',
        created_by: null,
        at_answer: true,
      },
      {
        matched_prefix: '1',
        country: '美国/加拿大',
        billing_number: '14155550123',
        duration_seconds: 130,
        minutes: '3',
        rate: '0.01',
        charge: '0.03',
        hangup_cause: 'NORMAL_CLEARING',
        unverified: false,
        amount: '-0.03',
        kind: 'call_charge',
        created_by: null,
        at_answer: true,
      },
    ]);
    // 原来的接收时间保留；话单状态与批次、认领一致。
    expect(
      (
        await one<{ received: Date }>(
          'select received_at as received from cdrs where call_uuid = $1',
          [rows[1]!.callUuid],
        )
      ).received,
    ).toEqual(before.received);
    expect(
      await one(
        `select count(*)::int as assigned, count(distinct assignment_id)::int as batches,
                (count(*) filter (where assigned_tenant_id = $2 and resolved_by = $3))::int as owned
         from unassigned_cdrs where tenant_tag = $1 and status = 'assigned'`,
        [tag, tenant.id, administrator],
      ),
    ).toEqual({ assigned: 3, batches: 1, owned: 3 });
    expect(
      await one(
        `select count(*)::int as claimed from call_uuids where tenant_id = $1`,
        [tenant.id],
      ),
    ).toEqual({ claimed: 3 });
    expect(
      await one(
        `select l.action, l.admin_id, l.tenant_id, l.details #>> '{content,assignedCount}' as assigned
         from operation_logs l join unassigned_assignments a on a.audit_id = l.id
         where a.tenant_id = $1`,
        [tenant.id],
      ),
    ).toEqual({
      action: 'unassigned_assign',
      admin_id: administrator,
      tenant_id: tenant.id,
      assigned: '3',
    });
  });

  it('assigns unanswered calls without a charge', async () => {
    const tenant = await rateTenant(owner);
    const tag = newTag();
    await insertUnassigned(owner, [{ tag, answeredAt: null }]);
    const { result } = await previewAndAssign(tenant.id, group(tag));
    expect(result).toMatchObject({
      assigned: 1,
      chargeTotal: '0',
      balanceAfter: '0',
      affectedMonths: [],
    });
    expect(await ledgerCount(tenant.id)).toBe(0);
    expect(
      await one(
        'select charge::text, billed_minutes::text, answered_at from cdrs where tenant_id = $1',
        [tenant.id],
      ),
    ).toEqual({ charge: '0', billed_minutes: '0', answered_at: null });
  });

  it('keeps rows without a rate pending and explains why', async () => {
    const tenant = await rateTenant(owner, {
      firstRateAt: '2026-06-01 00:00:00',
    });
    const tag = newTag();
    await insertUnassigned(owner, [
      { tag, answeredAt: '2026-09-10 10:00:00' },
      // 早于首个版本，号码落在牙买加（有 1876 条目，也有 1）。
      { tag, answeredAt: '2026-05-20 10:00:00', callee: '+18765550100' },
      // 版本有效，但费率表里没有日本。
      { tag, answeredAt: '2026-09-11 10:00:00', callee: '+81345678901' },
    ]);
    const preview = await previewAssignment(app.db, {
      tenantId: tenant.id,
      selection: group(tag),
    });
    expect(preview).toMatchObject({
      selected: 3,
      assignable: 1,
      chargeTotal: '0.1',
    });
    expect(
      preview.noRate.groups
        .map((g) => [g.reason, g.prefixHint?.prefix ?? null, g.count])
        .sort(),
    ).toEqual([
      ['before_first_version', '1876', 1],
      ['prefix_not_in_version', null, 1],
    ]);
    const { result } = await previewAndAssign(tenant.id, group(tag));
    expect(result).toMatchObject({ assigned: 1, noRate: 2 });
    expect(await statusCounts(tag)).toEqual({ assigned: 1, pending: 2 });
  });

  it('selects by ids as well as by group, and the empty tag is a group of its own', async () => {
    const tenant = await rateTenant(owner);
    const tag = newTag();
    const rows = await insertUnassigned(owner, [{ tag }, { tag }, { tag }]);
    const picked: UnassignedSelection = {
      ids: [rows[0]!.id, rows[2]!.id, rows[0]!.id.toUpperCase()],
    };
    const { result } = await previewAndAssign(tenant.id, picked);
    expect(result.assigned).toBe(2);
    expect(await statusCounts(tag)).toEqual({ assigned: 2, pending: 1 });

    // 标签为空的分组（空串）只含空标签的行。
    const empty = await insertUnassigned(owner, [{ tag: '' }]);
    const preview = await previewAssignment(app.db, {
      tenantId: tenant.id,
      selection: group(''),
    });
    expect(preview.selected).toBeGreaterThanOrEqual(1);
    const mine = await previewAssignment(app.db, {
      tenantId: tenant.id,
      selection: { ids: [empty[0]!.id] },
    });
    expect(mine.selected).toBe(1);
  });

  it('rejects a selection above the row limit', async () => {
    const tenant = await rateTenant(owner);
    const tag = newTag();
    await insertUnassigned(owner, [{ tag }, { tag }, { tag }]);
    await expect(
      assignUnassigned(app.db, {
        actor,
        tenantId: tenant.id,
        selection: group(tag),
        idempotencyKey: randomUUID(),
        expected: { assignable: 3, noRate: 0, chargeTotal: '0.3' },
        maxRows: 2,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      previewAssignment(app.db, {
        tenantId: tenant.id,
        selection: { ids: [] },
      }),
    ).rejects.toBeInstanceOf(UnassignedError);
    expect(await ledgerCount(tenant.id)).toBe(0);
    expect(await statusCounts(tag)).toEqual({ pending: 3 });
  });

  it('rolls back when the preview figures no longer match', async () => {
    const tenant = await rateTenant(owner);
    const tag = newTag();
    await insertUnassigned(owner, [{ tag }, { tag }]);
    const preview = await previewAssignment(app.db, {
      tenantId: tenant.id,
      selection: group(tag),
    });
    expect(expectedOf(preview)).toEqual({
      assignable: 2,
      noRate: 0,
      chargeTotal: '0.2',
    });
    const attempt = (expected: ReturnType<typeof expectedOf>) =>
      assignUnassigned(app.db, {
        actor,
        tenantId: tenant.id,
        selection: group(tag),
        idempotencyKey: randomUUID(),
        expected,
      });
    // 预览之后又有新话单进组。
    await insertUnassigned(owner, [{ tag }]);
    await expect(attempt(expectedOf(preview))).rejects.toMatchObject({
      code: 'UNASSIGNED_PREVIEW_STALE',
    });
    // 条数、无费率数、金额任一不符都是同一个结果。
    const fresh = expectedOf(
      await previewAssignment(app.db, {
        tenantId: tenant.id,
        selection: group(tag),
      }),
    );
    expect(fresh.assignable).toBe(3);
    for (const wrong of [
      { ...fresh, assignable: 2 },
      { ...fresh, noRate: 1 },
      { ...fresh, chargeTotal: '0.31' },
    ])
      await expect(attempt(wrong)).rejects.toMatchObject({
        code: 'UNASSIGNED_PREVIEW_STALE',
      });
    // 整个事务回滚：没有话单、流水、批次、日志，待处理的行原样。
    expect(await cdrCount(tenant.id)).toBe(0);
    expect(await ledgerCount(tenant.id)).toBe(0);
    expect(await statusCounts(tag)).toEqual({ pending: 3 });
    expect(
      await one(
        'select count(*)::int as n from unassigned_assignments where tenant_id = $1',
        [tenant.id],
      ),
    ).toEqual({ n: 0 });
    // 用最新的数字提交就成功。
    expect((await attempt(fresh)).assigned).toBe(3);
  });

  it('rejects an idempotency key reused by another administrator or for another selection', async () => {
    const tenant = await rateTenant(owner);
    const tag = newTag();
    const other = newTag();
    await insertUnassigned(owner, [{ tag }, { tag }]);
    await insertUnassigned(owner, [{ tag: other }]);
    const key = randomUUID();
    await previewAndAssign(tenant.id, group(tag), key);
    const second = await withAdmin(owner.db, async (tx) => {
      const rows = await tx.execute<{ id: string }>(
        sql`select id from admins where id <> ${administrator}::uuid limit 1`,
      );
      return rows.rows[0]!.id;
    });
    // 另一个管理员用同一个键。
    await expect(
      assignUnassigned(app.db, {
        actor: { id: second, name: '李俊' },
        tenantId: tenant.id,
        selection: group(tag),
        idempotencyKey: key,
        expected: { assignable: 2, noRate: 0, chargeTotal: '0.2' },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    // 同一个管理员，换一份选择。
    await expect(
      assignUnassigned(app.db, {
        actor,
        tenantId: tenant.id,
        selection: group(other),
        idempotencyKey: key,
        expected: { assignable: 1, noRate: 0, chargeTotal: '0.1' },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    // 同键同请求仍是重放；键只在租户内唯一，别的租户可以用同一个键。
    expect(
      (
        await assignUnassigned(app.db, {
          actor,
          tenantId: tenant.id,
          selection: group(tag),
          idempotencyKey: key,
          expected: { assignable: 2, noRate: 0, chargeTotal: '0.2' },
        })
      ).replayed,
    ).toBe(true);
    const tenant2 = await rateTenant(owner);
    expect(
      (await previewAndAssign(tenant2.id, group(other), key)).result.replayed,
    ).toBe(false);
    expect(
      await assignUnassigned(app.db, {
        actor,
        tenantId: tenant.id,
        selection: group(tag),
        idempotencyKey: '   ',
        expected: { assignable: 2, noRate: 0, chargeTotal: '0.2' },
      }).catch((error: unknown) => (error as UnassignedError).code),
    ).toBe('VALIDATION_ERROR');
  });

  it('assigns a row once when two admins submit at the same time', async () => {
    const x = await rateTenant(owner);
    const y = await rateTenant(owner);
    const tag = newTag();
    const rows = await insertUnassigned(
      owner,
      Array.from({ length: 30 }, () => ({ tag })),
    );
    const preview = await previewAssignment(app.db, {
      tenantId: x.id,
      selection: group(tag),
    });
    expect(preview.assignable).toBe(30);
    // 两个目标租户、四个不同的键，同时提交同一批。
    const results = await Promise.allSettled(
      [x, y, x, y].map((tenant) =>
        assignUnassigned(app.db, {
          actor,
          tenantId: tenant.id,
          selection: group(tag),
          idempotencyKey: randomUUID(),
          expected: expectedOf(preview),
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((r) => r.status === 'rejected'))
      expect(r.reason).toMatchObject({ code: 'UNASSIGNED_NOTHING_TO_ASSIGN' });
    // 每条话单只有一笔流水、一条 cdrs，且都在同一个租户名下。
    const counts = await one<{ cdrs: number; ledger: number; tenants: number }>(
      `select count(*)::int as cdrs,
              (select count(*)::int from ledger_entries l where l.tenant_id = any($2::uuid[]) and l.kind = 'call_charge') as ledger,
              count(distinct c.tenant_id)::int as tenants
       from cdrs c where c.call_uuid = any($1::uuid[])`,
      [rows.map((r) => r.callUuid), [x.id, y.id]],
    );
    expect(counts).toEqual({ cdrs: 30, ledger: 30, tenants: 1 });
    expect(await statusCounts(tag)).toEqual({ assigned: 30 });
    expect(
      await one(
        `select sum(balance)::text as total from tenant_balances where tenant_id = any($1::uuid[])`,
        [[x.id, y.id]],
      ),
    ).toEqual({ total: '-3.0' });
  });

  it('a row locked by another request and resolved meanwhile is not assigned afterwards', async () => {
    const tenant = await rateTenant(owner);
    const tag = newTag();
    const rows = await insertUnassigned(owner, [{ tag }, { tag }]);
    const preview = await previewAssignment(app.db, {
      tenantId: tenant.id,
      selection: group(tag),
    });
    const holder = await owner.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT 1 FROM unassigned_cdrs WHERE tenant_tag = $1 FOR UPDATE',
        [tag],
      );
      const attempt = assignUnassigned(app.db, {
        actor,
        tenantId: tenant.id,
        selection: group(tag),
        idempotencyKey: randomUUID(),
        expected: expectedOf(preview),
      });
      const settled = attempt.then(
        () => 'resolved',
        () => 'rejected',
      );
      // 请求拿到租户锁后卡在这些行的行锁上。
      for (let i = 0; i < 200; i++) {
        const { rows: waiting } = await owner.pool.query(
          `select 1 from pg_stat_activity
           where datname = current_database() and wait_event_type = 'Lock'
             and query ilike '%unassigned_cdrs%for update%'`,
        );
        if (waiting.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await Promise.race([settled, Promise.resolve('waiting')])).toBe(
        'waiting',
      );
      // 持锁的一方把这些行处理掉（这里是忽略）并提交：等待的请求重新判断 status，看不到它们了。
      await holder.query(
        `UPDATE unassigned_cdrs SET status = 'ignored', ignore_reason = '测试', resolved_by = $2, resolved_at = now()
         WHERE tenant_tag = $1`,
        [tag, administrator],
      );
      await holder.query('COMMIT');
      await expect(attempt).rejects.toMatchObject({
        code: 'UNASSIGNED_NOTHING_TO_ASSIGN',
      });
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    expect(await cdrCount(tenant.id)).toBe(0);
    expect(await ledgerCount(tenant.id)).toBe(0);
    expect(await statusCounts(tag)).toEqual({ ignored: 2 });
    expect(rows).toHaveLength(2);
  });

  it('a second claim of the call uuid fails with call_uuids_pkey', async () => {
    const tenant = await rateTenant(owner);
    const tag = newTag();
    const [row] = await insertUnassigned(owner, [{ tag }]);
    await previewAndAssign(tenant.id, group(tag));
    // 同一个通话 UUID 的登记已属于租户，再写一条 cdrs（不声明 cdr_ingest）就是第二次认领。
    const error = await pgError(
      owner.pool.query(
        `insert into cdrs (tenant_id, call_uuid, started_at, answered_at, ended_at, caller, callee, billing_number,
                           duration_seconds, billed_minutes, matched_prefix, country, rate, charge)
         values ($1, $2, '2026-09-11 02:00:00+00', '2026-09-11 02:00:01+00', '2026-09-11 02:01:00+00', '1', '2', '8613800138000',
                 59, 1, '86', '中国', 0.05, 0.05)`,
        [tenant.id, row!.callUuid],
      ),
    );
    expect(error).toMatchObject({
      code: '23505',
      constraint: 'call_uuids_pkey',
    });
    expect(await cdrCount(tenant.id)).toBe(1);
  });

  it('a failure in the middle rolls the whole batch back', async () => {
    const tenant = await rateTenant(owner);
    const tag = newTag();
    const rows = await insertUnassigned(owner, [
      { tag, answeredAt: '2026-09-10 10:00:00' },
      { tag, answeredAt: '2026-09-10 10:10:00' },
      { tag, answeredAt: '2026-09-10 10:20:00' },
    ]);
    // 给第二条话单预置一笔金额不同的同键流水，使扣费在批次中途失败。
    await withAdmin(owner.db, async (tx) => {
      await lockTenants(tx, [tenant.id]);
      await tx.execute(
        sql`insert into ledger_entries (tenant_id, kind, amount, idempotency_key, occurred_at, created_at)
            values (${tenant.id}::uuid, 'call_charge', -9, ${`call:${rows[1]!.callUuid}`}, now(), now())`,
      );
    });
    const ledgerBefore = await ledgerCount(tenant.id);
    const balanceBefore = await balanceOf(tenant.id);
    const preview = await previewAssignment(app.db, {
      tenantId: tenant.id,
      selection: group(tag),
    });
    await expect(
      assignUnassigned(app.db, {
        actor,
        tenantId: tenant.id,
        selection: group(tag),
        idempotencyKey: randomUUID(),
        expected: expectedOf(preview),
      }),
    ).rejects.toThrow(/幂等键 call:.* 已用于另一笔流水/);
    // 第一条已经写过的话单与流水也一起回滚。
    expect(await cdrCount(tenant.id)).toBe(0);
    expect(await ledgerCount(tenant.id)).toBe(ledgerBefore);
    expect(await balanceOf(tenant.id)).toBe(balanceBefore);
    expect(await statusCounts(tag)).toEqual({ pending: 3 });
    expect(
      await one(
        `select (select count(*)::int from unassigned_assignments where tenant_id = $1) as batches,
                (select count(*)::int from operation_logs where tenant_id = $1) as audits,
                (select count(*)::int from call_uuids where tenant_id = $1) as claimed`,
        [tenant.id],
      ),
    ).toEqual({ batches: 0, audits: 0, claimed: 0 });
  });

  it('leaves rows without a call identity or billing number pending', async () => {
    const tenant = await rateTenant(owner);
    const tag = newTag();
    await insertUnassigned(owner, [
      { tag },
      { tag },
      // 校验失败：没有 call_uuid，没有计费号码。
      { tag, callUuid: null },
      // 号码格式错误：有 call_uuid，没有可信的计费号码。
      { tag, reason: '号码格式错误', billingNumber: null },
      // 计费号码不一致：有号码，但原因不在可分配范围（决定 35）。
      { tag, reason: '计费号码不一致' },
    ]);
    const preview = await previewAssignment(app.db, {
      tenantId: tenant.id,
      selection: group(tag),
    });
    expect(preview).toMatchObject({
      selected: 5,
      assignable: 2,
      notAssignable: { count: 3 },
    });
    expect(
      [...preview.notAssignable.reasons].sort((a, b) =>
        a.reason.localeCompare(b.reason),
      ),
    ).toEqual(
      [
        { reason: '话单校验失败', count: 1 },
        { reason: '号码格式错误', count: 1 },
        { reason: '计费号码不一致', count: 1 },
      ].sort((a, b) => a.reason.localeCompare(b.reason)),
    );
    const { result } = await previewAndAssign(tenant.id, group(tag));
    expect(result.assigned).toBe(2);
    expect(await statusCounts(tag)).toEqual({ assigned: 2, pending: 3 });
    expect(await cdrCount(tenant.id)).toBe(2);
  });

  it('rows answered in a details-deleted month are not assigned', async () => {
    const tenant = await rateTenant(owner);
    const tag = newTag();
    await insertUnassigned(owner, [
      { tag, answeredAt: '2026-08-15 10:00:00' },
      { tag, answeredAt: '2026-07-15 10:00:00' },
    ]);
    const before = await previewAssignment(app.db, {
      tenantId: tenant.id,
      selection: group(tag),
    });
    expect(before.assignable).toBe(2);
    // 7 月的话单已删除（账单头部置标志）。
    await owner.pool.query(
      `insert into monthly_statements (tenant_id, month, opening_balance, recharge, gift, adjustment,
                                       call_charges, closing_balance, call_minutes, details_deleted)
       values ($1, '2026-07-01', 0, 0, 0, 0, 0, 0, 0, true)`,
      [tenant.id],
    );
    const preview = await previewAssignment(app.db, {
      tenantId: tenant.id,
      selection: group(tag),
    });
    expect(preview).toMatchObject({
      selected: 2,
      assignable: 1,
      blocked: { count: 1, months: ['2026-07'] },
    });
    // 预览之后才冻结的月份：用旧数字提交被拦下，什么都没写。
    await expect(
      assignUnassigned(app.db, {
        actor,
        tenantId: tenant.id,
        selection: group(tag),
        idempotencyKey: randomUUID(),
        expected: expectedOf(before),
      }),
    ).rejects.toMatchObject({ code: 'UNASSIGNED_PREVIEW_STALE' });
    expect(await cdrCount(tenant.id)).toBe(0);

    const { result } = await previewAndAssign(tenant.id, group(tag));
    expect(result).toMatchObject({ assigned: 1, blocked: 1 });
    expect(
      (
        await owner.pool.query(
          `select to_char(answered_at at time zone 'Asia/Shanghai', 'YYYY-MM') as month, status
           from unassigned_cdrs where tenant_tag = $1 order by answered_at`,
          [tag],
        )
      ).rows,
    ).toEqual([
      { month: '2026-07', status: 'pending' },
      { month: '2026-08', status: 'assigned' },
    ]);
    expect(
      await one(
        `select count(*)::int as n from cdrs where tenant_id = $1
         and answered_at < '2026-07-31 16:00+00' and answered_at >= '2026-06-30 16:00+00'`,
        [tenant.id],
      ),
    ).toEqual({ n: 0 });
  });

  it('creates the missing cdrs partition before assigning an old row', async () => {
    const tenant = await rateTenant(owner, {
      createdAt: '2025-01-01 09:00:00',
      firstRateAt: '2025-01-01 00:00:00',
    });
    const tag = newTag();
    await insertUnassigned(owner, [{ tag, answeredAt: '2025-03-10 10:00:00' }]);
    const exists = async () =>
      (
        await one<{ present: boolean }>(
          `select to_regclass('cdrs_2025_03') is not null as present`,
        )
      ).present;
    expect(await exists()).toBe(false);
    const { result } = await previewAndAssign(tenant.id, group(tag));
    expect(result).toMatchObject({
      assigned: 1,
      affectedMonths: [{ month: '2025-03', statementState: 'none' }],
    });
    expect(await exists()).toBe(true);
    expect(
      await one(
        `select count(*)::int as n from only cdrs_2025_03 where tenant_id = $1`,
        [tenant.id],
      ),
    ).toEqual({ n: 1 });
  });

  it('describes the statement state of each affected month', async () => {
    const tenant = await rateTenant(owner);
    await owner.pool.query(
      `insert into monthly_statements (tenant_id, month, opening_balance, recharge, gift, adjustment,
                                       call_charges, closing_balance, call_minutes)
       values ($1, '2026-08-01', 0, 0, 0, 0, 0, 0, 0)`,
      [tenant.id],
    );
    const { rows } = await owner.pool.query<{ month: string }>(
      `select to_char(date_trunc('month', statement_timestamp() at time zone 'Asia/Shanghai'), 'YYYY-MM-DD') as month`,
    );
    const current = rows[0]!.month;
    expect(
      await withAdmin(app.db, (tx) =>
        describeAffectedMonths(tx, tenant.id, [
          '2026-08-01',
          '2026-07-01',
          current,
        ]),
      ),
    ).toEqual([
      { month: '2026-07', statementState: 'none' },
      { month: '2026-08', statementState: 'final' },
      { month: current.slice(0, 7), statementState: 'live' },
    ]);
  });

  it('previewing for a tenant that does not exist is a not-found error', async () => {
    const tag = newTag();
    await insertUnassigned(owner, [{ tag }]);
    await expect(
      previewAssignment(app.db, {
        tenantId: randomUUID(),
        selection: group(tag),
      }),
    ).rejects.toMatchObject({ name: 'NotFoundError' });
  });
});

describe('租户锁', () => {
  it('an assignment waits for the tenant lock held by another transaction', async () => {
    const tenant = await rateTenant(owner);
    const tag = newTag();
    await insertUnassigned(owner, [{ tag }]);
    const preview = await previewAssignment(app.db, {
      tenantId: tenant.id,
      selection: group(tag),
    });
    const release = deferred();
    const locked = deferred();
    const holder = adminTransaction(app.db, async (tx) => {
      await lockTenants(tx, [tenant.id]);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const attempt = assignUnassigned(app.db, {
      actor,
      tenantId: tenant.id,
      selection: group(tag),
      idempotencyKey: randomUUID(),
      expected: expectedOf(preview),
    });
    const early = await Promise.race([
      attempt.then(() => 'done'),
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 300)),
    ]);
    expect(early).toBe('waiting');
    release.resolve();
    await holder;
    expect((await attempt).assigned).toBe(1);
  });

  it('authorization reads do not wait for a transaction holding the tenant lock', async () => {
    const tenant = await rateTenant(owner);
    const locked = deferred();
    const release = deferred();
    // 持租户锁并已经改过余额缓存行（和分配中途一样）的事务，还没提交。
    const holder = adminTransaction(app.db, async (tx) => {
      await lockTenants(tx, [tenant.id]);
      await tx.execute(sql`insert into ledger_entries (tenant_id, kind, amount, idempotency_key, occurred_at)
        values (${tenant.id}::uuid, 'call_charge', -1, ${`call:${randomUUID()}`}, now())`);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    // Worker 的授权接口：读缓存余额和费率表，不拿租户锁，所以不排队，也看不到未提交的扣费。
    const started = Date.now();
    const read = await withSystem(app.db, (tx) =>
      loadRatingTenant(tx, tenant.code),
    );
    const elapsed = Date.now() - started;
    release.resolve();
    await holder;
    expect(read?.balance.value.toFixed()).toBe('0');
    expect(elapsed).toBeLessThan(2000);
  });
});
