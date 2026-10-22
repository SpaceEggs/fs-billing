import { randomUUID } from 'node:crypto';
import { beijingTime } from '@fs-billing/rating';
import { lockTenants, withAdmin, type Connection } from '../src/client.js';
import { ensureCdrPartitions } from '../src/partitions.js';
import { cdrs, ledgerEntries, tenants } from '../src/schema.js';

/** 账单测试的话单落在 2026 年 6 至 10 月。 */
export async function ensureStatementPartitions({ db }: Connection) {
  await ensureCdrPartitions(db, {
    moment: beijingTime('2026-06-01 00:00:00'),
    monthsAhead: 4,
  });
}

const ts = (text: string) => beijingTime(text);

/** 新建租户；创建时间可指定（北京时间），owner 连接写入。 */
export async function statementTenant(
  owner: Connection,
  options: {
    createdAt?: string;
    currency?: 'CNY' | 'USD';
    status?: 'active' | 'disabled';
  } = {},
): Promise<{ id: string; code: string }> {
  const id = randomUUID();
  const code = `S${id.replaceAll('-', '').slice(0, 10).toUpperCase()}`;
  await withAdmin(owner.db, (tx) =>
    tx.insert(tenants).values({
      id,
      code,
      name: `账单测试 ${code}`,
      currency: options.currency ?? 'CNY',
      status: options.status ?? 'active',
      overdraftLimit: '100',
      ...(options.createdAt && { createdAt: ts(options.createdAt) }),
    }),
  );
  return { id, code };
}

/**
 * 写一笔流水（owner 连接）。通话扣费的 occurred_at 是 `at`，created_at 默认比它晚 5 秒；
 * 人工流水两列都是 `at`。`createdAt` 单独指定“很久以后才写入”的补推；传 `'now'` 表示此刻写入
 * （晚于已生成账单的 generated_at，核对时算作迟到流水）。
 */
export async function statementLedger(
  owner: Connection,
  tenantId: string,
  kind: 'recharge' | 'credit_recharge' | 'gift' | 'adjustment' | 'call_charge',
  amount: string,
  at: string,
  options: { createdAt?: string; adminId?: string; note?: string } = {},
): Promise<void> {
  const occurredAt = ts(at);
  await withAdmin(owner.db, async (tx) => {
    await lockTenants(tx, [tenantId]);
    await tx.insert(ledgerEntries).values({
      tenantId,
      kind,
      amount,
      idempotencyKey: `test:${randomUUID()}`,
      note: options.note ?? (kind === 'call_charge' ? '' : '测试'),
      occurredAt,
      createdAt: options.createdAt
        ? options.createdAt === 'now'
          ? new Date()
          : ts(options.createdAt)
        : kind === 'call_charge'
          ? new Date(occurredAt.getTime() + 5000)
          : occurredAt,
      ...(kind !== 'call_charge' && {
        createdBy: options.adminId ?? null,
      }),
    });
  });
}

/** 一条话单（owner 连接）。answeredAt 为 null 表示未接通。 */
export async function statementCdr(
  owner: Connection,
  tenantId: string,
  options: {
    startedAt: string;
    answeredAt?: string | null;
    minutes?: string;
    charge?: string;
    country?: string;
    description?: string;
    callUuid?: string;
  },
): Promise<string> {
  const callUuid = options.callUuid ?? randomUUID();
  const startedAt = ts(options.startedAt);
  const answeredAt =
    options.answeredAt === null
      ? null
      : options.answeredAt === undefined
        ? startedAt
        : ts(options.answeredAt);
  await withAdmin(owner.db, (tx) =>
    tx.insert(cdrs).values({
      tenantId,
      callUuid,
      startedAt,
      answeredAt,
      endedAt: new Date((answeredAt ?? startedAt).getTime() + 61_000),
      caller: '1000',
      callee: '8613800138000',
      billingNumber: '8613800138000',
      durationSeconds: answeredAt ? 61 : 0,
      billedMinutes: answeredAt ? (options.minutes ?? '2') : '0',
      matchedPrefix: answeredAt ? '86' : null,
      country: answeredAt ? (options.country ?? '中国') : null,
      iso: answeredAt ? 'CN' : null,
      description: answeredAt ? (options.description ?? null) : null,
      rate: answeredAt ? '0.0500' : null,
      charge: answeredAt ? (options.charge ?? '0.1') : '0',
      hangupCause: answeredAt ? 'NORMAL_CLEARING' : 'CALL_REJECTED',
    }),
  );
  return callUuid;
}

/**
 * 一通已接通话并写好对应的扣费流水（amount = −charge），occurred_at 是接通时刻。
 * 返回话单 UUID。
 */
export async function statementCall(
  owner: Connection,
  tenantId: string,
  options: {
    startedAt?: string;
    answeredAt: string;
    minutes?: string;
    charge: string;
    country?: string;
    description?: string;
    chargedAt?: string;
    ledgerCreatedAt?: string;
  },
): Promise<string> {
  const callUuid = await statementCdr(owner, tenantId, {
    startedAt: options.startedAt ?? options.answeredAt,
    answeredAt: options.answeredAt,
    ...(options.minutes && { minutes: options.minutes }),
    charge: options.charge,
    ...(options.country && { country: options.country }),
    ...(options.description && { description: options.description }),
  });
  await statementLedger(
    owner,
    tenantId,
    'call_charge',
    `-${options.charge}`,
    options.answeredAt,
    options.ledgerCreatedAt ? { createdAt: options.ledgerCreatedAt } : {},
  );
  return callUuid;
}

export async function ledgerSum({ pool }: Connection, tenantId: string) {
  const { rows } = await pool.query<{ total: string }>(
    'select coalesce(sum(amount), 0)::text as total from ledger_entries where tenant_id = $1',
    [tenantId],
  );
  return rows[0]!.total;
}
