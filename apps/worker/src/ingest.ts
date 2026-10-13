import { eq, sql } from 'drizzle-orm';
import {
  lockTenants,
  loadRatingTenant,
  schema,
  withSystem,
  type Db,
  type Tx,
} from '@fs-billing/db';
import { findRate, parseDialedNumber, priceCall } from '@fs-billing/rating';
import { modJsonCdrSchema, type ParsedCdr } from '@fs-billing/shared';
import { invalidCdrIdentitySchema } from './invalid-cdr.js';
import type { ChargeQueue } from './queue.js';

export function postgresError(
  error: unknown,
): { code: string; constraint?: unknown; message: string } | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ('code' in current && typeof current.code === 'string') {
      return {
        code: current.code,
        constraint: 'constraint' in current ? current.constraint : undefined,
        message: current.message,
      };
    }
  }
  return undefined;
}

export async function recordAlert(
  db: Db,
  kind: 'cdr_failed' | 'partition_failed',
  description: string,
): Promise<void> {
  await withSystem(db, async (tx) => {
    await lockTenants(tx, []);
    await tx
      .insert(schema.systemAlerts)
      .values({ kind, description, affectedCalls: 1 });
  });
}

async function park(tx: Tx, cdr: ParsedCdr, reason: string) {
  await tx.insert(schema.unassignedCdrs).values({
    ...cdr,
    durationSeconds: cdr.billsec,
    reason,
  });
  await tx.insert(schema.systemAlerts).values({
    kind: 'cdr_failed',
    description: `${cdr.callUuid}: ${reason}`,
    affectedCalls: 1,
  });
  return 'unassigned' as const;
}

export async function ingestCdr(db: Db, queue: ChargeQueue, body: string) {
  // 原文先独立提交；后续解析、去重或任务入队失败都不能撤销这次推送的原文。
  const [raw] = await withSystem(db, async (tx) => {
    await lockTenants(tx, []);
    // Date 只保留毫秒；原文定位键使用相同精度，避免驱动截断微秒。
    return tx
      .insert(schema.rawCdrs)
      .values({ body, receivedAt: sql`date_trunc('milliseconds', now())` })
      .returning();
  });
  if (!raw) throw new Error('原始话单未保存');
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    await recordAlert(db, 'cdr_failed', `${raw.id}: 话单 JSON 格式错误`);
    return { status: 'invalid' as const, rawId: raw.id };
  }
  const parsed = modJsonCdrSchema.safeParse(payload);
  if (!parsed.success) {
    const { variables: identity } = invalidCdrIdentitySchema.parse(payload);
    await withSystem(db, async (tx) => {
      await lockTenants(tx, []);
      await tx.insert(schema.unassignedCdrs).values({
        // 无效推送以原文定位，UUID 留在原文中，不能占用通话去重闸门。
        callUuid: null,
        tenantTag: identity.billing_tenant,
        caller: identity.caller_id_number,
        callee: identity.destination_number,
        rawId: raw.id,
        rawReceivedAt: raw.receivedAt,
        reason: `话单校验失败: ${parsed.error.message}`,
      });
      await tx.insert(schema.systemAlerts).values({
        kind: 'cdr_failed',
        description: `${raw.id}: 话单校验失败: ${parsed.error.message}`,
        affectedCalls: 1,
      });
    });
    return { status: 'unassigned' as const, rawId: raw.id };
  }
  const cdr = parsed.data;
  try {
    const status = await withSystem(db, async (tx) => {
      const [tenant] = await tx
        .select()
        .from(schema.tenants)
        .where(eq(schema.tenants.code, cdr.tenantTag));
      await lockTenants(tx, tenant ? [tenant.id] : []);
      await tx.execute(sql`select set_config('app.cdr_ingest', 'true', true)`);
      // 入库触发器允许阶段 8 认领未归属登记；HTTP 重推不能走认领流程。
      const [registered] = await tx
        .select()
        .from(schema.callUuids)
        .where(eq(schema.callUuids.callUuid, cdr.callUuid));
      if (registered) return 'duplicate' as const;
      // FreeSWITCH 超时放行的信号随首次有效话单到达；去重后告警，重推不重复记。
      if (cdr.unverified) {
        await tx.insert(schema.systemAlerts).values({
          tenantId: tenant?.id ?? null,
          kind: 'auth_timeout',
          description: `${cdr.callUuid}: FreeSWITCH 授权未验证，按 1800 秒放行`,
          affectedCalls: 1,
        });
      }
      if (!tenant)
        return park(tx, cdr, cdr.tenantTag ? '租户不存在' : '缺少租户标签');
      const dialed = parseDialedNumber(cdr.callee);
      if (!dialed) return park(tx, cdr, '号码格式错误');
      const ratingTenant = await loadRatingTenant(tx, tenant.code);
      const entry =
        cdr.answeredAt &&
        ratingTenant &&
        findRate(ratingTenant.rates, dialed, cdr.answeredAt);
      if (cdr.answeredAt && !entry) return park(tx, cdr, '接通时无费率');
      const priced = entry
        ? priceCall(cdr.billsec, entry.perMinute)
        : undefined;
      await tx.insert(schema.cdrs).values({
        ...cdr,
        tenantId: tenant.id,
        durationSeconds: cdr.billsec,
        billedMinutes: priced?.billedMinutes.toFixed() ?? '0',
        charge: priced?.charge.value.toFixed() ?? '0',
        matchedPrefix: entry ? entry.prefix : null,
        country: entry ? entry.country : null,
        rate: entry ? entry.perMinute.perMinute.toFixed() : null,
      });
      await queue.enqueue(tx, { tenantId: tenant.id, callUuid: cdr.callUuid });
      return 'queued' as const;
    });
    return { status, rawId: raw.id };
  } catch (error) {
    const pg = postgresError(error);
    if (pg?.code === '23505' && pg.constraint === 'call_uuids_pkey') {
      return { status: 'duplicate' as const, rawId: raw.id };
    }
    throw error;
  }
}
