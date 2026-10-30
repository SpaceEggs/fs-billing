import { and, eq, inArray, sql } from 'drizzle-orm';
import { authAccounts, authUsers } from './auth-schema.js';
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
import {
  lockTenants,
  withAdmin,
  withSystem,
  type PoolDb,
  type Tx,
} from './client.js';
import { databaseNow } from './clock.js';
import { ensureCdrPartitions } from './partitions.js';
import { callChargeKey } from './ledger.js';
import { createRateVersion } from './rates.js';
import { seedSystemAlerts } from './seed-alerts.js';
import {
  planAbc01Unassigned,
  planEmptyTagUnassigned,
  planIgnoredUnassigned,
  type PlannedUnassigned,
} from './seed-unassigned.js';
import {
  currentMonthSeedMonth,
  planAbc001Calls,
  planCurrentMonthCalls,
  type FixedCall,
  type PlannedCall,
} from './seed-calls.js';
import {
  generateStatement,
  listMissingStatements,
} from './statements/index.js';
import {
  admins,
  balanceAlertSettings,
  callUuids,
  cdrs,
  emailOutbox,
  portalAccounts,
  rateVersions,
  tenants,
  unassignedCdrs,
  type LedgerKind,
} from './schema.js';

// 示例数据取自设计稿（管理后台第一批：租户列表）和 pages.md §1.6。
// ABC001 的流水与话单取自客户门户第二批的月账单（阶段 7 决定 20）：8 月（12 日开户）与 9 月，
// 逐通话单 + 逐通扣费流水，由 seed-calls.ts 确定性地生成。

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
    pending: '300.00',
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
    pending: '2800.00',
  },
  {
    code: 'SHC005',
    name: '上海辰星网络科技有限公司',
    currency: 'CNY',
    status: 'active',
    overdraft: '300.00',
    balance: '8950.00',
    monthSpend: '6720.85',
    pending: '2000.00',
  },
  {
    code: 'NYC021',
    name: 'Hudson Contact Center Inc',
    currency: 'USD',
    status: 'active',
    overdraft: '15.00',
    balance: '2140.00',
    monthSpend: '812.40',
    pending: '1400.00',
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

export const RATES_CSV = `ISO,Country,Destination Prefix,Description,Rate
CN,中国,86,,0.0500
,美国/加拿大,1,,0.0100
JM,牙买加,1876,,0.2500
GB,英国,44,,0.0200
GB,英国,447,手机,0.0450
JP,日本,81,,0.0350
SG,新加坡,65,,0.0280
HK,中国香港,852,,0.0300`;

export const OCTOBER_RATES_CSV = RATES_CSV.replace(
  'GB,英国,447,手机,0.0450',
  'GB,英国,447,手机,0.0480',
);
if (OCTOBER_RATES_CSV === RATES_CSV) throw new Error('种子 447 调价未生效');

const FIRST_VERSION_AT = '2026-09-01 00:00:00';
// ABC001 在设计稿里 2026-08-12 开户，费率表自开户起生效。
const ABC001_OPENED_AT = '2026-08-12 09:30:00';
// 种子播种后生成的账单月份上界（含）：账单只生成已结束的月份，之后的月份由每日任务补建。
const LAST_SEED_STATEMENT_MONTH = '2026-09-01';
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

/**
 * ABC001 的人工流水，取自客户门户第二批的月账单（`客户门户 第二批.dc.html:629-633`）：
 * 8 月充值 3,000.00、赠送 50.00；9 月充值 800.00、赊账 500.00、调账 −25.50，没有赠送。
 * 通话扣费不在这里：每通一笔，由 seed-calls.ts 生成。
 * 播种月（2026-10 起）另有一笔与当月通话等额的预存。
 */
function abc001Ledger(currentMonthRecharge?: {
  at: string;
  amount: string;
}): SeedEntry[] {
  const entries: SeedEntry[] = [
    {
      at: '2026-08-12 10:15:00',
      kind: 'recharge',
      amount: '3000.00',
      note: '银行转账预存',
      admin: 'li',
    },
    {
      at: '2026-08-12 10:20:00',
      kind: 'gift',
      amount: '50.00',
      note: '开户赠送',
      admin: 'wang',
    },
    {
      at: '2026-09-10 14:20:08',
      kind: 'recharge',
      amount: '800.00',
      note: '银行转账 · 招行尾号 6621',
      admin: 'li',
    },
    {
      at: '2026-09-23 10:15:36',
      kind: 'credit_recharge',
      amount: '500.00',
      note: '月结，10月5日前付款',
      admin: 'li',
    },
    {
      at: '2026-09-26 16:20:41',
      kind: 'adjustment',
      amount: '-25.50',
      note: '9月25日重复扣费冲正',
      admin: 'wang',
    },
  ];
  // 当前月的预存：恰为当月 20 通扣费的合计，播种前后余额不变（见 seed-calls.ts）。
  if (currentMonthRecharge) {
    entries.push({
      at: currentMonthRecharge.at,
      kind: 'recharge',
      amount: currentMonthRecharge.amount,
      note: '银行转账预存',
      admin: 'li',
    });
  }
  return entries;
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

/**
 * ABC001 原有的两条已接通示例话单（9-28）并入 9 月的逐通分配，同时补写它们缺的扣费流水。
 * 第三条未接通的示例话单仍在 CDRS 里，不计入通话数。
 */
const ABC001_FIXED_CALLS: readonly FixedCall[] = [
  {
    callUuid: 'a0000001-0000-4000-8000-000000000001',
    key: 'UKM',
    startedAt: '2026-09-28 14:03:10',
    ringSeconds: 12,
    talkSeconds: 230,
    caller: '075586001234',
    callee: '+447700900123',
    hangupCause: 'NORMAL_CLEARING',
  },
  {
    callUuid: 'a0000001-0000-4000-8000-000000000002',
    key: 'JM',
    startedAt: '2026-09-28 14:10:00',
    ringSeconds: 5,
    talkSeconds: 1,
    caller: '075586001234',
    callee: '+18765550100',
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
export async function seedDatabase(
  db: PoolDb,
  options: {
    passwordHash?: string;
    /** 测试用的“现在”，默认数据库时钟。 */
    now?: Date;
  } = {},
): Promise<void> {
  const { adminIds, tenantIds } = await withAdmin(db, seedTenants);
  if (options.passwordHash !== undefined) {
    const passwordHash = options.passwordHash;
    await db.transaction(async (tx) => {
      const users = await tx
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(
          inArray(authUsers.email, [
            ...Object.values(ADMINS).map((a) => a.email),
            ...TENANTS.map((t) => `${t.code.toLowerCase()}@example.com`),
          ]),
        );
      for (const user of users) {
        await tx
          .insert(authAccounts)
          .values({
            id: `seed:credential:${user.id}`,
            accountId: user.id,
            providerId: 'credential',
            userId: user.id,
            password: passwordHash,
            updatedAt: new Date(),
          })
          .onConflictDoNothing({ target: authAccounts.id });
      }
    });
  }
  const idOf = (code: string) => tenantIds.get(code)!;
  // 样例话单落在 2026 年 8、9、10 月。建分区不能放进下面持租户锁的事务。
  await ensureCdrPartitions(db, {
    moment: beijingTime('2026-08-01 00:00:00'),
    monthsAhead: 2,
  });
  // 当前月 1 日凌晨的 20 通话单（以数据库时钟决定是哪个月，播种时它们一定已经发生）。
  const now = options.now ?? (await withAdmin(db, databaseNow));
  const currentMonth = currentMonthSeedMonth(now);
  const currentPlan = currentMonth
    ? planCurrentMonthCalls({
        month: currentMonth,
        tenantCode: 'ABC001',
        entries: sampleRates('CNY', OCTOBER_RATES_CSV),
        caller: '075586001234',
      })
    : null;
  if (currentMonth)
    await ensureCdrPartitions(db, {
      moment: beijingTime(`${currentMonth} 00:00:00`),
      monthsAhead: 0,
    });
  await withAdmin(db, async (tx) => {
    await lockTenants(tx, [...tenantIds.values()]);
    // 发件箱是 0021 才有的：迁移测试会在更早的结构上播种，那时没有触发器，也就没有什么可清。
    const { rows: outbox } = await tx.execute<{ present: boolean }>(
      sql`select to_regclass('public.email_outbox') is not null as present`,
    );
    // 播种写流水之前发件箱里已有的行：之后只清这些之外新排的余额通知。
    const hasOutbox = outbox[0]?.present === true;
    const outboxBefore = new Set(
      hasOutbox
        ? (await tx.select({ id: emailOutbox.id }).from(emailOutbox)).map(
            (row) => row.id,
          )
        : [],
    );
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
          effectiveFrom: beijingTime(
            t.code === 'ABC001' ? ABC001_OPENED_AT : FIRST_VERSION_AT,
          ),
          adminId: adminIds.li,
        });
        if (t.code === 'ABC001') {
          await createRateVersion(
            tx,
            tenantId,
            sampleRates(t.currency, OCTOBER_RATES_CSV),
            {
              effectiveFrom: beijingTime(ABC001_OCTOBER_AT),
              adminId: adminIds.wang,
            },
          );
        }
      }

      const ledger =
        t.code === 'ABC001'
          ? abc001Ledger(
              currentPlan
                ? {
                    at: currentPlan.rechargeAt,
                    amount: currentPlan.rechargeAmount,
                  }
                : undefined,
            )
          : summaryLedger(t);
      // 阶段 9 PR 8 之前的种子里，这些租户没有赊账：预存 = 余额 + 本月消费。流水只能新增、不能改，旧库里那笔预存的金额
      // 留不回来；此时再补赊账会让余额凭空多出赊账额（随后账单核对也会报不一致）。所以旧库上跳过新增的赊账，
      // 保持原样（待收款合计不会是稿上的 ¥6,300 / $1,700，要对上稿得重置库）。
      const legacy =
        t.code !== 'ABC001' &&
        (await hasLegacySeedRecharge(tx, tenantId, ledger));
      // 历史时间只有 owner 连接能写。应用角色没有 created_at 的 INSERT 权限。
      for (const e of ledger) {
        if (legacy && e.kind === 'credit_recharge') continue;
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
    await seedAbc001Calls(
      tx,
      idOf('ABC001'),
      planAbc001Calls({
        tenantCode: 'ABC001',
        entries: sampleRates('CNY'),
        fixedCalls: ABC001_FIXED_CALLS,
        caller: '075586001234',
      }),
    );
    if (currentPlan)
      await seedAbc001Calls(tx, idOf('ABC001'), [...currentPlan.calls]);
    await seedCdrs(tx, idOf, registered);
    await chargeSampleCdrs(tx, idOf);
    await seedUnassigned(tx, registered, adminIds);
    await seedSystemAlerts(tx, now, tenantIds);
    // 种子写的是历史，不是事件：余额触发器在播种时为越线的种子租户排进发件箱的余额通知，只清掉这些
    // （开始播种流水前的发件箱快照之外、种子租户的 balance_* 行），免得 Worker 起来后把「余额不足」邮件真的发出去。
    // 状态行保留，标志已经跟上最终余额。不依赖事务开始时间或事务号。
    if (hasOutbox) {
      const queued = await tx
        .select({ id: emailOutbox.id })
        .from(emailOutbox)
        .where(
          and(
            inArray(emailOutbox.template, ['balance_low', 'balance_suspended']),
            inArray(emailOutbox.tenantId, [...tenantIds.values()]),
          ),
        );
      const fresh = queued
        .map((row) => row.id)
        .filter((id) => !outboxBefore.has(id));
      if (fresh.length > 0)
        await tx.delete(emailOutbox).where(inArray(emailOutbox.id, fresh));
    }
  });
  await seedStatements(db, tenantIds);
}

/**
 * 旧版种子（阶段 9 PR 8 之前）写下的预存：同一个幂等键、金额不同于现在要写的金额。
 * 只在租户有「预存 + 赊账」两条汇总流水时才可能（预存 = 余额 + 本月消费 − 待收款）。
 */
async function hasLegacySeedRecharge(
  tx: Tx,
  tenantId: string,
  ledger: readonly SeedEntry[],
): Promise<boolean> {
  const recharge = ledger.find((e) => e.kind === 'recharge');
  if (!recharge || !ledger.some((e) => e.kind === 'credit_recharge'))
    return false;
  const { rows } = await tx.execute<{ amount: string }>(sql`
    select amount::text as amount from ledger_entries
    where tenant_id = ${tenantId} and idempotency_key = ${`seed:${recharge.at}:${recharge.kind}`}`);
  const existing = rows[0]?.amount;
  return existing !== undefined && !decimal(existing).eq(recharge.amount);
}

/**
 * 与每日生成任务相同的取数与写入函数：只为种子租户补齐从第一个应有月份到 2026-09 的账单
 * （ABC001 是 8、9 月，其余租户只有 9 月；只生成已结束的月份）。幂等：已有的账单不动；
 * 库里别的租户（例如测试建的）不在种子范围内，不会被生成。
 */
async function seedStatements(
  db: PoolDb,
  tenantIds: ReadonlyMap<string, string>,
): Promise<void> {
  for (const tenantId of tenantIds.values()) {
    const missing = await withSystem(db, (tx) =>
      listMissingStatements(tx, { tenantId }),
    );
    for (const entry of missing) {
      if (entry.month > LAST_SEED_STATEMENT_MONTH) continue;
      await withSystem(
        db,
        (tx) => generateStatement(tx, entry.tenantId, entry.month),
        { isolationLevel: 'repeatable read' },
      );
    }
  }
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
        ...(t.code === 'ABC001' && {
          createdAt: beijingTime(ABC001_OPENED_AT),
        }),
      })),
    )
    .onConflictDoNothing({ target: tenants.code });
  // 设计稿写 ABC001「创建于 2026-08-12」；已存在的行也回填（owner 连接，触发器不限制 created_at）。
  await tx
    .update(tenants)
    .set({ createdAt: beijingTime(ABC001_OPENED_AT) })
    .where(eq(tenants.code, 'ABC001'));
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

  for (const t of TENANTS) {
    await tx
      .insert(authUsers)
      .values({
        id: `seed:portal:${t.code}`,
        name: t.name,
        email: `${t.code.toLowerCase()}@example.com`,
      })
      .onConflictDoNothing({ target: authUsers.email });
  }
  const portalUsers = await tx
    .select({ id: authUsers.id, email: authUsers.email })
    .from(authUsers)
    .where(
      inArray(
        authUsers.email,
        TENANTS.map((t) => `${t.code.toLowerCase()}@example.com`),
      ),
    );
  const portalUserIds = new Map(portalUsers.map((u) => [u.email, u.id]));
  await tx
    .insert(portalAccounts)
    .values(
      TENANTS.map((t) => ({
        tenantId: idOf(t.code),
        authUserId: portalUserIds.get(`${t.code.toLowerCase()}@example.com`)!,
      })),
    )
    .onConflictDoNothing({ target: portalAccounts.authUserId });
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

function unassignedValues(row: PlannedUnassigned) {
  return {
    tenantTag: row.tenantTag,
    callUuid: row.callUuid,
    reason: row.reason,
    startedAt: row.startedAt,
    answeredAt: row.answeredAt,
    endedAt: row.endedAt,
    caller: row.caller,
    callee: row.callee,
    billingNumber: row.billingNumber,
    durationSeconds: row.durationSeconds,
    hangupCause: row.hangupCause,
  };
}

/**
 * 未归属话单：ABC01 的 326 条（阶段 8 验收 1），加上设计稿的 12 条空标签待处理和 5 条已忽略（决定 47）。
 * 已登记的 UUID 跳过，重复播种不增行。
 */
async function seedUnassigned(
  tx: Tx,
  registered: ReadonlySet<string>,
  adminIds: Record<AdminKey, string>,
): Promise<void> {
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
      hangupCause: 'NORMAL_CLEARING',
    });
  }
  const pending = [
    ...planAbc01Unassigned(),
    ...planEmptyTagUnassigned(),
  ].filter((row) => !registered.has(row.callUuid));
  if (pending.length > 0)
    await tx.insert(unassignedCdrs).values(pending.map(unassignedValues));
  const ignored = planIgnoredUnassigned().filter(
    (row) => !registered.has(row.callUuid),
  );
  if (ignored.length > 0)
    await tx.insert(unassignedCdrs).values(
      ignored.map((row) => ({
        ...unassignedValues(row),
        status: 'ignored' as const,
        ignoreReason: row.ignoreReason,
        resolvedBy: adminIds[row.admin],
        resolvedAt: row.resolvedAt,
      })),
    );
}

/** 插入触发器在唯一冲突前就写登记表，ON CONFLICT 挡不住；重复执行时先查登记表跳过。 */
async function registeredCallUuids(tx: Tx): Promise<Set<string>> {
  const rows = await tx
    .select({ callUuid: callUuids.callUuid })
    .from(callUuids)
    .where(
      inArray(callUuids.callUuid, [
        ...CDRS.map((c) => c.callUuid),
        UNASSIGNED_CALL_UUID,
        ...planAbc01Unassigned().map((row) => row.callUuid),
        ...planEmptyTagUnassigned().map((row) => row.callUuid),
        ...planIgnoredUnassigned().map((row) => row.callUuid),
      ]),
    );
  return new Set(rows.map((r) => r.callUuid));
}

async function seedAdmins(tx: Tx): Promise<Record<AdminKey, string>> {
  const byEmail = new Map<string, string>();
  for (const [key, admin] of Object.entries(ADMINS)) {
    await tx
      .insert(authUsers)
      .values({ id: `seed:admin:${key}`, ...admin })
      .onConflictDoNothing({ target: authUsers.email });
    const [user] = await tx
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.email, admin.email));
    await tx
      .insert(admins)
      .values({ authUserId: user!.id, name: admin.name })
      .onConflictDoNothing({ target: admins.authUserId });
    const [profile] = await tx
      .select({ id: admins.id })
      .from(admins)
      .where(eq(admins.authUserId, user!.id));
    byEmail.set(admin.email, profile!.id);
  }
  return {
    wang: byEmail.get(ADMINS.wang.email)!,
    li: byEmail.get(ADMINS.li.email)!,
  };
}

const BULK_NOTE = (callUuid: string, billingNumber: string) =>
  `通话扣费 ${callUuid} ${billingNumber}`;

/**
 * ABC001 8、9 月的逐通话单与逐通扣费流水（决定 20）。流水用生产的幂等键 `call:<uuid>`（callChargeKey），
 * 所以 Worker 的补扣对账认为这些话单已扣过费，不会再扣一次；occurred_at 是接通时间，created_at 是挂机后数秒。
 * 两张表各用一条 INSERT ... SELECT jsonb_to_recordset 批量写入；已有的话单与流水按 UUID / 幂等键跳过，重复播种不增行
 * （话单的插入触发器在唯一冲突前就写登记表，ON CONFLICT 挡不住，所以必须先查）。
 */
async function seedAbc001Calls(
  tx: Tx,
  tenantId: string,
  planned: readonly PlannedCall[],
): Promise<void> {
  const uuids = JSON.stringify(planned.map((c) => c.callUuid));
  const registered = new Set(
    (
      await tx.execute<{ call_uuid: string }>(sql`
        select c.call_uuid::text as call_uuid from call_uuids c
        where c.call_uuid in (select jsonb_array_elements_text(${uuids}::jsonb)::uuid)`)
    ).rows.map((r) => r.call_uuid),
  );
  const unchargedRows = await tx.execute<{ call_uuid: string }>(sql`
    select u as call_uuid from jsonb_array_elements_text(${uuids}::jsonb) as u
    where not exists (
      select 1 from ledger_entries l
      where l.tenant_id = ${tenantId}::uuid and l.idempotency_key = 'call:' || u)`);
  const uncharged = new Set(unchargedRows.rows.map((r) => r.call_uuid));

  const cdrRows = planned.filter((c) => !registered.has(c.callUuid));
  if (cdrRows.length > 0) {
    await tx.execute(sql`
      insert into cdrs (
        tenant_id, call_uuid, started_at, answered_at, ended_at, caller, callee, billing_number,
        duration_seconds, billed_minutes, matched_prefix, country, iso, description, rate, charge,
        hangup_cause, received_at
      )
      select ${tenantId}::uuid, r.call_uuid, r.started_at, r.answered_at, r.ended_at, r.caller, r.callee,
        r.billing_number, r.duration_seconds, r.billed_minutes, r.matched_prefix, r.country,
        nullif(r.iso, ''), nullif(r.description, ''), r.rate, r.charge, r.hangup_cause, r.received_at
      from jsonb_to_recordset(${JSON.stringify(cdrRows.map(cdrJson))}::jsonb) as r(
        call_uuid uuid, started_at timestamptz, answered_at timestamptz, ended_at timestamptz,
        caller text, callee text, billing_number text, duration_seconds int, billed_minutes numeric,
        matched_prefix text, country text, iso text, description text, rate numeric, charge numeric,
        hangup_cause text, received_at timestamptz)`);
  }
  const ledgerRows = planned.filter((c) => uncharged.has(c.callUuid));
  if (ledgerRows.length > 0) {
    await tx.execute(sql`
      insert into ledger_entries (
        tenant_id, kind, amount, note, created_by, idempotency_key, occurred_at, created_at
      )
      select ${tenantId}::uuid, 'call_charge', r.amount, r.note, null, r.idempotency_key, r.occurred_at, r.created_at
      from jsonb_to_recordset(${JSON.stringify(ledgerRows.map(ledgerJson))}::jsonb) as r(
        amount numeric, note text, idempotency_key text, occurred_at timestamptz, created_at timestamptz)
      on conflict (tenant_id, idempotency_key) do nothing`);
  }
}

/** 挂机后 2 秒话单入库，3 秒扣费入账。 */
const afterHangup = (call: PlannedCall, secondsLater: number) =>
  new Date(call.endedAt.getTime() + secondsLater * 1000).toISOString();

function cdrJson(call: PlannedCall) {
  return {
    call_uuid: call.callUuid,
    started_at: call.startedAt.toISOString(),
    answered_at: call.answeredAt.toISOString(),
    ended_at: call.endedAt.toISOString(),
    caller: call.caller,
    callee: call.callee,
    billing_number: call.billingNumber,
    duration_seconds: call.durationSeconds,
    billed_minutes: call.billedMinutes.toString(),
    matched_prefix: call.matchedPrefix,
    country: call.country,
    iso: call.iso,
    description: call.description,
    rate: call.perMinute,
    charge: call.charge,
    hangup_cause: call.hangupCause,
    received_at: afterHangup(call, 2),
  };
}

function ledgerJson(call: PlannedCall) {
  return {
    amount: decimal(call.charge).neg().toFixed(),
    note: BULK_NOTE(call.callUuid, call.billingNumber),
    idempotency_key: callChargeKey(call.callUuid),
    occurred_at: call.answeredAt.toISOString(),
    created_at: afterHangup(call, 3),
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
      iso: entry.iso || null,
      description: entry.description || null,
      rate: entry.perMinute.perMinute.toFixed(4),
      charge: priced.charge.value.toFixed(),
    });
  }
}

/**
 * 已接通的示例话单（目前是 GZT007 的两条，ABC001 的两条已并入逐通分配）也要有扣费流水，
 * 用生产的幂等键 `call:<UUID>`：否则 Worker 的补扣对账会把近 30 天内有费用而无该键的话单再扣一次。
 * 流水不是按“余额 + 本月消费 − 赊账”算出的汇总流水的一部分，所以 GZT007 的余额是 86.50 − 0.23 = 86.27。
 * 已有的流水按幂等键跳过，重复播种不增行。
 */
async function chargeSampleCdrs(
  tx: Tx,
  idOf: (code: string) => string,
): Promise<void> {
  const entries = sampleRates('CNY');
  for (const c of CDRS.filter((c) => c.ringSeconds !== undefined)) {
    const dialed = normalizeDialedNumber(c.callee);
    const entry = dialed && longestPrefix(entries, dialed);
    if (!dialed || !entry) throw new Error(`种子话单 ${c.callUuid} 无费率`);
    const priced = priceCall(c.talkSeconds, entry.perMinute);
    if (priced.charge.value.isZero()) continue;
    const answeredAt = seconds(beijingTime(c.startedAt), c.ringSeconds!);
    const endedAt = seconds(answeredAt, c.talkSeconds);
    await tx.execute(sql`
      insert into ledger_entries (
        tenant_id, kind, amount, note, created_by, idempotency_key, occurred_at, created_at
      ) values (
        ${idOf(c.code)}, 'call_charge', ${priced.charge.value.neg().toFixed()},
        ${BULK_NOTE(c.callUuid, dialed)}, null, ${callChargeKey(c.callUuid)},
        ${answeredAt}, ${seconds(endedAt, 3)}
      )
      on conflict (tenant_id, idempotency_key) do nothing
    `);
  }
}
