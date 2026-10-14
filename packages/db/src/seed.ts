import { inArray, sql } from 'drizzle-orm';
import {
  beijingTime,
  decimal,
  longestPrefix,
  money,
  normalizeDialedNumber,
  parseRateCsv,
  priceCall,
  type Currency,
  type RateEntry,
} from '@fs-billing/rating';
import { lockTenants, withAdmin, type PoolDb, type Tx } from './client.js';
import { ensureCdrPartitions } from './partitions.js';
import { createRateVersion } from './rates.js';
import {
  admins,
  balanceAlertSettings,
  callUuids,
  cdrs,
  portalAccounts,
  rateVersions,
  tenants,
  unassignedCdrs,
  type LedgerKind,
} from './schema.js';

// 示例数据取自设计稿（管理后台第一批：租户列表与 ABC001 余额流水）和 pages.md §1.6。

const ADMINS = {
  wang: { email: 'wangmin@example.com', name: '王敏' },
  li: { email: 'lijun@example.com', name: '李俊' },
} as const;
type AdminKey = keyof typeof ADMINS;

interface SeedTenant {
  readonly code: string;
  readonly name: string;
  readonly currency: Currency;
  readonly status: 'active' | 'disabled';
  readonly overdraft: string;
  readonly balance: string;
  readonly monthSpend: string;
  readonly pending: string;
}

const TENANTS: readonly SeedTenant[] = [
  {
    code: 'HZX014',
    name: '杭州星讯通信有限公司',
    currency: 'CNY',
    status: 'active',
    overdraft: '100.00',
    balance: '-100.36',
    monthSpend: '1862.40',
    pending: '0',
  },
  {
    code: 'GLB009',
    name: 'Global Voice Partners',
    currency: 'USD',
    status: 'active',
    overdraft: '15.00',
    balance: '-15.02',
    monthSpend: '274.90',
    pending: '0',
  },
  {
    code: 'ABC001',
    name: '深圳市某某科技有限公司',
    currency: 'CNY',
    status: 'active',
    overdraft: '100.00',
    balance: '-35.20',
    monthSpend: '2486.30',
    pending: '500.00',
  },
  {
    code: 'XYZ002',
    name: 'Global Trade Ltd',
    currency: 'USD',
    status: 'active',
    overdraft: '15.00',
    balance: '-4.82',
    monthSpend: '386.15',
    pending: '0',
  },
  {
    code: 'GZT007',
    name: '广州通达云科技有限公司',
    currency: 'CNY',
    status: 'active',
    overdraft: '100.00',
    balance: '86.50',
    monthSpend: '1240.75',
    pending: '1000.00',
  },
  {
    code: 'SGN011',
    name: 'Lion City Telecom Pte Ltd',
    currency: 'USD',
    status: 'active',
    overdraft: '15.00',
    balance: '12.30',
    monthSpend: '97.60',
    pending: '0',
  },
  {
    code: 'BJH003',
    name: '北京华联信息技术有限公司',
    currency: 'CNY',
    status: 'active',
    overdraft: '100.00',
    balance: '1286.40',
    monthSpend: '3105.20',
    pending: '0',
  },
  {
    code: 'SHC005',
    name: '上海辰星网络科技有限公司',
    currency: 'CNY',
    status: 'active',
    overdraft: '300.00',
    balance: '8950.00',
    monthSpend: '6720.85',
    pending: '0',
  },
  {
    code: 'NYC021',
    name: 'Hudson Contact Center Inc',
    currency: 'USD',
    status: 'active',
    overdraft: '15.00',
    balance: '2140.00',
    monthSpend: '812.40',
    pending: '0',
  },
  {
    code: 'CDT018',
    name: '成都某某贸易有限公司',
    currency: 'CNY',
    status: 'disabled',
    overdraft: '100.00',
    balance: '0',
    monthSpend: '0',
    pending: '0',
  },
];

const RATES_CSV = `prefix,country,rate
86,中国,0.0500
1,美国/加拿大,0.0100
1876,牙买加,0.2500
44,英国,0.0200
447,英国手机,0.0450
81,日本,0.0350
65,新加坡,0.0280
852,中国香港,0.0300`;

const FIRST_VERSION_AT = '2026-09-01 00:00:00';
// 阶段 1 的调价示例：447 自 2026-10-01 00:00（北京时间）起 0.0480。
const ABC001_OCTOBER_AT = '2026-10-01 00:00:00';

type SeedEntry = {
  /** 写入时间（北京时间）。 */
  readonly at: string;
  readonly amount: string;
  readonly note: string;
} & (
  | { readonly kind: 'call_charge'; readonly occurredAt: string }
  | {
      readonly kind: Exclude<LedgerKind, 'call_charge'>;
      readonly admin: AdminKey;
    }
);

/** 按日汇总的通话扣费：发生在通话当日（取当日最后一秒），次日写入。 */
const callCharge = (
  callDay: string,
  at: string,
  amount: string,
  note: string,
): SeedEntry => ({
  at,
  kind: 'call_charge',
  occurredAt: `${callDay} 23:59:59`,
  amount,
  note,
});

/** 设计稿中 ABC001 的 10 条流水，以及在其之前、使 9 月 23 日赊账前余额为 −39.74 的历史。 */
function abc001Ledger(): SeedEntry[] {
  const history: SeedEntry[] = [
    {
      at: '2026-09-01 10:00:00',
      kind: 'recharge',
      amount: '1931.10',
      note: '银行转账预存',
      admin: 'li',
    },
  ];
  // 9 月 1 日至 22 日的通话，次日 00:05 扣费；合计 1970.84，与设计稿本月消费 2486.30 一致。
  for (let day = 1; day <= 22; day++) {
    const callDay = `2026-09-${String(day).padStart(2, '0')}`;
    const postedAt = `2026-09-${String(day + 1).padStart(2, '0')} 00:05:00`;
    history.push(
      callCharge(
        callDay,
        postedAt,
        day === 22 ? '-89.66' : '-89.58',
        `${callDay} 通话扣费（种子汇总）`,
      ),
    );
  }
  return [
    ...history,
    {
      at: '2026-09-23 10:15:36',
      kind: 'credit_recharge',
      amount: '500.00',
      note: '月结，10月5日前付款',
      admin: 'li',
    },
    callCharge(
      '2026-09-23',
      '2026-09-24 00:05:12',
      '-86.05',
      '2026-09-23 通话扣费，共 1,692 通',
    ),
    callCharge(
      '2026-09-24',
      '2026-09-25 00:05:08',
      '-83.48',
      '2026-09-24 通话扣费，共 1,610 通',
    ),
    {
      at: '2026-09-25 15:10:27',
      kind: 'gift',
      amount: '20.00',
      note: '9月24日线路故障补偿',
      admin: 'wang',
    },
    {
      at: '2026-09-25 15:12:03',
      kind: 'gift',
      amount: '20.00',
      note: '9月24日线路故障补偿',
      admin: 'wang',
    },
    callCharge(
      '2026-09-25',
      '2026-09-26 00:05:10',
      '-90.12',
      '2026-09-25 通话扣费，共 1,731 通',
    ),
    callCharge(
      '2026-09-26',
      '2026-09-27 00:05:11',
      '-85.90',
      '2026-09-26 通话扣费，共 1,655 通',
    ),
    {
      at: '2026-09-27 16:20:41',
      kind: 'adjustment',
      amount: '-20.00',
      note: '冲正 9月25日重复赠送',
      admin: 'wang',
    },
    callCharge(
      '2026-09-27',
      '2026-09-28 00:05:09',
      '-81.27',
      '2026-09-27 通话扣费，共 1,588 通',
    ),
    callCharge(
      '2026-09-28',
      '2026-09-29 00:05:12',
      '-88.64',
      '2026-09-28 通话扣费，共 1,702 通',
    ),
  ];
}

/** 其他租户：预存 + 赊账 − 本月消费 = 设计稿中的余额。 */
function summaryLedger(tenant: SeedTenant): SeedEntry[] {
  const recharge = decimal(tenant.balance)
    .plus(tenant.monthSpend)
    .minus(tenant.pending);
  const entries: SeedEntry[] = [];
  if (recharge.gt(0)) {
    entries.push({
      at: '2026-09-01 10:00:00',
      kind: 'recharge',
      amount: recharge.toFixed(2),
      note: '银行转账预存',
      admin: 'li',
    });
  }
  if (decimal(tenant.pending).gt(0)) {
    entries.push({
      at: '2026-09-20 11:00:00',
      kind: 'credit_recharge',
      amount: tenant.pending,
      note: '月结，10月5日前付款',
      admin: 'li',
    });
  }
  if (decimal(tenant.monthSpend).gt(0)) {
    entries.push(
      callCharge(
        '2026-09-28',
        '2026-09-29 00:05:00',
        decimal(tenant.monthSpend).neg().toFixed(2),
        '2026-09-01 至 2026-09-28 通话扣费（种子汇总）',
      ),
    );
  }
  return entries;
}

interface SeedCdr {
  readonly code: string;
  readonly callUuid: string;
  readonly startedAt: string;
  /** 振铃秒数；undefined 表示未接通。 */
  readonly ringSeconds?: number;
  readonly talkSeconds: number;
  readonly caller: string;
  readonly callee: string;
  readonly hangupCause: string;
}

const CDRS: readonly SeedCdr[] = [
  {
    code: 'ABC001',
    callUuid: 'a0000001-0000-4000-8000-000000000001',
    startedAt: '2026-09-28 14:03:10',
    ringSeconds: 12,
    talkSeconds: 230,
    caller: '075586001234',
    callee: '+447700900123',
    hangupCause: 'NORMAL_CLEARING',
  },
  {
    code: 'ABC001',
    callUuid: 'a0000001-0000-4000-8000-000000000002',
    startedAt: '2026-09-28 14:10:00',
    ringSeconds: 5,
    talkSeconds: 1,
    caller: '075586001234',
    callee: '+18765550100',
    hangupCause: 'NORMAL_CLEARING',
  },
  {
    code: 'ABC001',
    callUuid: 'a0000001-0000-4000-8000-000000000003',
    startedAt: '2026-09-28 14:20:00',
    talkSeconds: 30,
    caller: '075586001234',
    callee: '13800138000',
    hangupCause: 'NO_ANSWER',
  },
  {
    code: 'GZT007',
    callUuid: 'a0000007-0000-4000-8000-000000000001',
    startedAt: '2026-09-28 09:30:00',
    ringSeconds: 8,
    talkSeconds: 190,
    caller: '02088880000',
    callee: '13912345678',
    hangupCause: 'NORMAL_CLEARING',
  },
  {
    code: 'GZT007',
    callUuid: 'a0000007-0000-4000-8000-000000000002',
    startedAt: '2026-09-28 09:40:00',
    ringSeconds: 6,
    talkSeconds: 60,
    caller: '02088880000',
    callee: '0085291234567',
    hangupCause: 'NORMAL_CLEARING',
  },
];

function sampleRates<C extends Currency>(
  currency: C,
  csv = RATES_CSV,
): readonly RateEntry<C>[] {
  const parsed = parseRateCsv(csv, currency);
  if (!parsed.ok)
    throw new Error(`种子费率无效：${JSON.stringify(parsed.errors)}`);
  return parsed.entries;
}

const seconds = (at: Date, n: number) => new Date(at.getTime() + n * 1000);

/**
 * 写入开发种子数据。幂等：重复执行不新增任何行。
 * 分两个事务：lock_tenants 要在事务的任何写入之前调用，所以先提交管理员与租户，再在新事务里锁租户写费率和流水。
 */
export async function seedDatabase(db: PoolDb): Promise<void> {
  const { adminIds, tenantIds } = await withAdmin(db, seedTenants);
  const idOf = (code: string) => tenantIds.get(code)!;
  // 样例话单落在 2026 年 9、10 月。建分区不能放进下面持租户锁的事务。
  await ensureCdrPartitions(db, {
    moment: beijingTime('2026-09-01 00:00:00'),
  });
  await withAdmin(db, async (tx) => {
    await lockTenants(tx, [...tenantIds.values()]);
    const seeded = new Set(
      (
        await tx
          .selectDistinct({ tenantId: rateVersions.tenantId })
          .from(rateVersions)
      ).map((r) => r.tenantId),
    );
    for (const t of TENANTS) {
      const tenantId = idOf(t.code);
      if (!seeded.has(tenantId)) {
        await createRateVersion(tx, tenantId, sampleRates(t.currency), {
          effectiveFrom: beijingTime(FIRST_VERSION_AT),
          adminId: adminIds.li,
        });
        if (t.code === 'ABC001') {
          await createRateVersion(
            tx,
            tenantId,
            sampleRates(
              t.currency,
              RATES_CSV.replace('447,英国手机,0.0450', '447,英国手机,0.0480'),
            ),
            {
              effectiveFrom: beijingTime(ABC001_OCTOBER_AT),
              adminId: adminIds.wang,
            },
          );
        }
      }

      const ledger = t.code === 'ABC001' ? abc001Ledger() : summaryLedger(t);
      // 历史时间只有 owner 连接能写。应用角色没有 created_at 的 INSERT 权限。
      for (const e of ledger) {
        const createdAt = beijingTime(e.at);
        const occurredAt =
          e.kind === 'call_charge' ? beijingTime(e.occurredAt) : createdAt;
        await tx.execute(sql`
          insert into ledger_entries (
            tenant_id, kind, amount, note, created_by, idempotency_key, occurred_at, created_at
          ) values (
            ${tenantId},
            ${e.kind},
            ${money(t.currency, e.amount).value.toFixed()},
            ${e.note},
            ${e.kind === 'call_charge' ? null : adminIds[e.admin]},
            ${`seed:${e.at}:${e.kind}`},
            ${occurredAt},
            ${createdAt}
          )
          on conflict (tenant_id, idempotency_key) do nothing
        `);
      }
    }

    const registered = await registeredCallUuids(tx);
    await seedCdrs(tx, idOf, registered);
    if (!registered.has(UNASSIGNED_CALL_UUID)) {
      const callee = '+6591234567';
      const billingNumber = normalizeDialedNumber(callee);
      if (!billingNumber) throw new Error('种子未归属话单号码格式错误');
      await tx.insert(unassignedCdrs).values({
        tenantTag: 'ABC01',
        callUuid: UNASSIGNED_CALL_UUID,
        reason: '租户不存在',
        startedAt: beijingTime('2026-09-28 15:00:00'),
        answeredAt: beijingTime('2026-09-28 15:00:09'),
        endedAt: beijingTime('2026-09-28 15:02:09'),
        caller: '075586001299',
        callee,
        billingNumber,
        durationSeconds: 120,
      });
    }
  });
}

async function seedTenants(tx: Tx): Promise<{
  adminIds: Record<AdminKey, string>;
  tenantIds: Map<string, string>;
}> {
  const adminIds = await seedAdmins(tx);
  await tx
    .insert(tenants)
    .values(
      TENANTS.map((t) => ({
        code: t.code,
        name: t.name,
        currency: t.currency,
        status: t.status,
        overdraftLimit: t.overdraft,
      })),
    )
    .onConflictDoNothing({ target: tenants.code });
  const rows = await tx
    .select({ id: tenants.id, code: tenants.code })
    .from(tenants)
    .where(
      inArray(
        tenants.code,
        TENANTS.map((t) => t.code),
      ),
    );
  const tenantIds = new Map(rows.map((r) => [r.code, r.id]));
  const idOf = (code: string) => tenantIds.get(code)!;

  await tx
    .insert(portalAccounts)
    .values(
      TENANTS.map((t) => ({
        tenantId: idOf(t.code),
        email: `${t.code.toLowerCase()}@example.com`,
      })),
    )
    .onConflictDoNothing({ target: portalAccounts.email });
  await tx
    .insert(balanceAlertSettings)
    .values(
      TENANTS.map((t) => ({
        tenantId: idOf(t.code),
        threshold: t.currency === 'CNY' ? '100.00' : '20.00',
        emails: ['billing-ops@example.com'],
      })),
    )
    .onConflictDoNothing({ target: balanceAlertSettings.tenantId });
  return { adminIds, tenantIds };
}

const UNASSIGNED_CALL_UUID = 'a00000ff-0000-4000-8000-000000000001';

/** 插入触发器在唯一冲突前就写登记表，ON CONFLICT 挡不住；重复执行时先查登记表跳过。 */
async function registeredCallUuids(tx: Tx): Promise<Set<string>> {
  const rows = await tx
    .select({ callUuid: callUuids.callUuid })
    .from(callUuids)
    .where(
      inArray(callUuids.callUuid, [
        ...CDRS.map((c) => c.callUuid),
        UNASSIGNED_CALL_UUID,
      ]),
    );
  return new Set(rows.map((r) => r.callUuid));
}

async function seedAdmins(tx: Tx): Promise<Record<AdminKey, string>> {
  await tx
    .insert(admins)
    .values(Object.values(ADMINS))
    .onConflictDoNothing({ target: admins.email });
  const rows = await tx
    .select({ id: admins.id, email: admins.email })
    .from(admins)
    .where(
      inArray(
        admins.email,
        Object.values(ADMINS).map((a) => a.email),
      ),
    );
  const byEmail = new Map(rows.map((r) => [r.email, r.id]));
  return {
    wang: byEmail.get(ADMINS.wang.email)!,
    li: byEmail.get(ADMINS.li.email)!,
  };
}

async function seedCdrs(
  tx: Tx,
  idOf: (code: string) => string,
  existing: ReadonlySet<string>,
): Promise<void> {
  const entries = sampleRates('CNY');
  for (const c of CDRS.filter((c) => !existing.has(c.callUuid))) {
    const startedAt = beijingTime(c.startedAt);
    const dialed = normalizeDialedNumber(c.callee);
    if (!dialed) throw new Error(`种子话单 ${c.callUuid} 号码格式错误`);
    const base = {
      tenantId: idOf(c.code),
      callUuid: c.callUuid,
      startedAt,
      caller: c.caller,
      callee: c.callee,
      billingNumber: dialed,
      hangupCause: c.hangupCause,
    };
    if (c.ringSeconds === undefined) {
      await tx
        .insert(cdrs)
        .values({ ...base, endedAt: seconds(startedAt, c.talkSeconds) });
      continue;
    }
    const entry = longestPrefix(entries, dialed);
    if (!entry) throw new Error(`种子话单 ${c.callUuid} 无费率`);
    const answeredAt = seconds(startedAt, c.ringSeconds);
    const priced = priceCall(c.talkSeconds, entry.perMinute);
    await tx.insert(cdrs).values({
      ...base,
      answeredAt,
      endedAt: seconds(answeredAt, c.talkSeconds),
      durationSeconds: c.talkSeconds,
      billedMinutes: priced.billedMinutes.toFixed(),
      matchedPrefix: entry.prefix,
      country: entry.country,
      rate: entry.perMinute.perMinute.toFixed(4),
      charge: priced.charge.value.toFixed(),
    });
  }
}
