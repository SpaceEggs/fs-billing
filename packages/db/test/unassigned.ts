import { randomUUID } from 'node:crypto';
import { beijingTime, normalizeDialedNumber, rate } from '@fs-billing/rating';
import { lockTenants, withAdmin, type Connection } from '../src/client.js';
import { callChargeKey } from '../src/ledger.js';
import { createRateVersion } from '../src/rates.js';
import { cdrs, ledgerEntries, unassignedCdrs } from '../src/schema.js';
import { statementTenant } from './statements.js';

/** 夹具租户的费率：86 = 0.05，1 = 0.01，44 = 0.02，1876 = 0.25（人民币）。 */
const FIXTURE_RATES = [
  { prefix: '86', country: '中国', perMinute: '0.0500' },
  { prefix: '1', country: '美国/加拿大', perMinute: '0.0100' },
  { prefix: '44', country: '英国', perMinute: '0.0200' },
  { prefix: '1876', country: '牙买加', perMinute: '0.2500' },
] as const;

/** 新建一个带费率表的租户（owner 连接）：创建时间和首个费率版本的生效时间可指定（北京时间）。 */
export async function rateTenant(
  owner: Connection,
  options: { createdAt?: string; firstRateAt?: string } = {},
): Promise<{ id: string; code: string }> {
  const tenant = await statementTenant(owner, {
    createdAt: options.createdAt ?? '2026-05-01 09:00:00',
  });
  await withAdmin(owner.db, (tx) =>
    createRateVersion(
      tx,
      tenant.id,
      FIXTURE_RATES.map((entry) => ({
        prefix: entry.prefix,
        country: entry.country,
        iso: '',
        description: '',
        perMinute: rate('CNY', entry.perMinute),
      })),
      {
        effectiveFrom: beijingTime(
          options.firstRateAt ?? '2026-06-01 00:00:00',
        ),
      },
    ),
  );
  return tenant;
}

export interface UnassignedFixture {
  readonly tag?: string;
  /** 北京时间；未接通传 null。默认 2026-09-10 10:00:00。 */
  readonly answeredAt?: string | null;
  /** 默认 61 秒（2 个计费分钟）。 */
  readonly seconds?: number;
  /** 默认 +8613800138000（前缀 86）。 */
  readonly callee?: string;
  /** 默认「租户不存在」；没有通话身份的行默认为一条校验失败原因。 */
  readonly reason?: string;
  /** 默认由被叫算出；传 null 模拟没有可信计费号码（号码格式错误）。 */
  readonly billingNumber?: string | null;
  /** 为 null 表示没有通话身份（校验失败的行）。 */
  readonly callUuid?: string | null;
  readonly hangupCause?: string;
  readonly unverified?: boolean;
}

/** 往 unassigned_cdrs 写若干 pending 行（owner 连接），返回行编号和通话 UUID。 */
export async function insertUnassigned(
  owner: Connection,
  rows: readonly UnassignedFixture[],
): Promise<{ id: string; callUuid: string | null }[]> {
  const values = rows.map((row) => {
    const callee = row.callee ?? '+8613800138000';
    const answeredText =
      row.answeredAt === undefined ? '2026-09-10 10:00:00' : row.answeredAt;
    const seconds = row.seconds ?? 61;
    const callUuid = row.callUuid === undefined ? randomUUID() : row.callUuid;
    const reason =
      row.reason ??
      (callUuid === null
        ? '话单校验失败: variables.uuid(invalid_format)'
        : '租户不存在');
    const answeredAt = answeredText === null ? null : beijingTime(answeredText);
    const startedAt = answeredAt
      ? new Date(answeredAt.getTime() - 5_000)
      : beijingTime('2026-09-10 10:00:00');
    const endedAt = new Date(
      (answeredAt ?? startedAt).getTime() + (answeredAt ? seconds : 20) * 1000,
    );
    const identified = callUuid !== null;
    const billingNumber =
      row.billingNumber !== undefined
        ? row.billingNumber
        : identified
          ? (normalizeDialedNumber(callee) ?? null)
          : null;
    return {
      tenantTag: row.tag ?? 'TESTTAG',
      callUuid,
      ...(identified
        ? { startedAt, endedAt }
        : {
            // 校验失败的行没有通话身份：以原文定位。
            rawId: randomUUID(),
            rawReceivedAt: new Date(),
          }),
      answeredAt: identified ? answeredAt : null,
      reason,
      caller: '075586001234',
      callee,
      billingNumber,
      durationSeconds: identified && answeredAt ? seconds : 0,
      hangupCause: row.hangupCause ?? 'NORMAL_CLEARING',
      unverified: row.unverified ?? false,
    };
  });
  return withAdmin(owner.db, (tx) =>
    tx
      .insert(unassignedCdrs)
      .values(values)
      .returning({ id: unassignedCdrs.id, callUuid: unassignedCdrs.callUuid }),
  );
}

/**
 * 一通已接通并已扣费的话单（owner 连接）：cdrs 一行加幂等键 call:<UUID> 的扣费流水，和生产路径一样，
 * 所以删除话单的「有费用而无流水」检查认为它已扣费。chargeLedger 为 false 时只写话单，模拟尚未扣费。
 */
export async function chargedCall(
  owner: Connection,
  tenantId: string,
  options: {
    answeredAt: string;
    /** 默认 2 个计费分钟、0.1 元。 */
    charge?: string;
    startedAt?: string;
    ledger?: boolean;
    callUuid?: string;
  },
): Promise<string> {
  const callUuid = options.callUuid ?? randomUUID();
  const answeredAt = beijingTime(options.answeredAt);
  const startedAt = options.startedAt
    ? beijingTime(options.startedAt)
    : new Date(answeredAt.getTime() - 5_000);
  const charge = options.charge ?? '0.1';
  await withAdmin(owner.db, async (tx) => {
    await lockTenants(tx, [tenantId]);
    await tx.insert(cdrs).values({
      tenantId,
      callUuid,
      startedAt,
      answeredAt,
      endedAt: new Date(answeredAt.getTime() + 61_000),
      caller: '075586001234',
      callee: '+8613800138000',
      billingNumber: '8613800138000',
      durationSeconds: 61,
      billedMinutes: '2',
      matchedPrefix: '86',
      country: '中国',
      iso: 'CN',
      rate: '0.0500',
      charge,
      hangupCause: 'NORMAL_CLEARING',
    });
    if (options.ledger !== false) {
      await tx.insert(ledgerEntries).values({
        tenantId,
        kind: 'call_charge',
        amount: `-${charge}`,
        note: `通话扣费 ${callUuid} 8613800138000`,
        idempotencyKey: callChargeKey(callUuid),
        occurredAt: answeredAt,
        createdAt: new Date(answeredAt.getTime() + 66_000),
      });
    }
  });
  return callUuid;
}
