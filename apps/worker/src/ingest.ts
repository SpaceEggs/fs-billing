import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  AlertKeys,
  CDR_MONTH_DELETED_REASON,
  lockTenants,
  lockUnassignedAlerts,
  loadRatingTenant,
  priceAndInsertCdr,
  raiseAlert,
  recoverClearedUnassignedAlerts,
  schema,
  withSystem,
  type Db,
  type RaiseAlertInput,
  type Tx,
} from '@fs-billing/db';
import { resolveBillingNumber } from '@fs-billing/rating';
import {
  INVALID_NUMBER_REASON,
  modJsonCdrSchema,
  summarizeCdrIssues,
  type ParsedCdr,
} from '@fs-billing/shared';
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

/** 自成事务的告警写入（入库之外的写入点用）；同一 kind + subjectKey 合并成一条。 */
export async function recordAlert(
  db: Db,
  input: RaiseAlertInput,
): Promise<void> {
  await withSystem(db, async (tx) => {
    await lockTenants(tx, []);
    await raiseAlert(tx, input);
  });
}

async function park(
  tx: Tx,
  cdr: ParsedCdr,
  reason: string,
  billingNumber: string | null,
) {
  // 停放写待处理行并累加未归属告警：先拿这一族告警的互斥锁（正常入库不拿）。
  await lockUnassignedAlerts(tx);
  await tx.insert(schema.unassignedCdrs).values({
    ...cdr,
    billingNumber,
    durationSeconds: cdr.billsec,
    reason,
  });
  // 同原因（租户不存在再加标签）合并成一条告警，不是每个 UUID 一条。
  await raiseAlert(tx, {
    kind: 'cdr_failed',
    subjectKey: AlertKeys.unassigned(reason, cdr.tenantTag),
    description: `话单停放到未归属：${reason}${
      reason === '租户不存在' ? `（标签 ${cdr.tenantTag}）` : ''
    }，最近一通 ${cdr.callUuid}`,
    calls: 1,
  });
  return 'unassigned' as const;
}

/**
 * 修正重推通过校验后，原文里能解析出同一 UUID 的待处理校验失败行标为已解决（superseded）；
 * 某个原因的待处理行因此清零时，同原因的无效输入告警恢复（同一事务）。
 */
async function supersedeInvalidRows(tx: Tx, callUuid: string) {
  // 绝大多数有效话单没有对应的校验失败行：先不加锁地看一眼，有才拿告警族的互斥锁再改。
  const [candidate] = await tx
    .select({ id: schema.unassignedCdrs.id })
    .from(schema.unassignedCdrs)
    .where(
      and(
        sql`${schema.unassignedCdrs.callUuid} IS NULL`,
        eq(schema.unassignedCdrs.status, 'pending'),
        eq(schema.unassignedCdrs.candidateCallUuid, callUuid),
      ),
    )
    .limit(1);
  if (!candidate) return;
  await lockUnassignedAlerts(tx);
  const superseded = await tx
    .update(schema.unassignedCdrs)
    .set({
      status: 'superseded',
      resolvedAt: sql`now()`,
      supersededByCallUuid: callUuid,
    })
    .where(
      and(
        sql`${schema.unassignedCdrs.callUuid} IS NULL`,
        eq(schema.unassignedCdrs.status, 'pending'),
        eq(schema.unassignedCdrs.candidateCallUuid, callUuid),
      ),
    )
    .returning({
      reason: schema.unassignedCdrs.reason,
      tenantTag: schema.unassignedCdrs.tenantTag,
    });
  await recoverClearedUnassignedAlerts(
    tx,
    superseded.map((row) => ({ ...row, callUuid: null })),
  );
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
    // JSON 损坏没有 UUID，也不写待处理行：全局一条，每次推送累加，描述只写最近一次的原文 id。
    await recordAlert(db, {
      kind: 'cdr_failed',
      subjectKey: AlertKeys.invalidJson,
      description: `话单 JSON 格式错误，最近一次原文 ${raw.id}`,
      calls: 1,
    });
    return { status: 'invalid' as const, rawId: raw.id };
  }
  const parsed = modJsonCdrSchema.safeParse(payload);
  if (!parsed.success) {
    const { variables: identity } = invalidCdrIdentitySchema.parse(payload);
    const reason = summarizeCdrIssues(parsed.error);
    const sha256 = createHash('sha256').update(body, 'utf8').digest('hex');
    await withSystem(db, async (tx) => {
      await lockTenants(tx, []);
      await lockUnassignedAlerts(tx);
      // 同一份原文（字节完全相同）合并成一行，只计推送次数；已忽略的行同样合并，不会再冒出来。
      // 冲突目标与局部唯一索引 unassigned_cdrs_invalid_body 一致；xmax = 0 表示这次是新插入的。
      const [row] = await tx
        .insert(schema.unassignedCdrs)
        .values({
          // 无效推送以原文定位，UUID 留在原文中，不能占用通话去重闸门。
          callUuid: null,
          candidateCallUuid: identity.uuid ?? null,
          tenantTag: identity.billing_tenant.toUpperCase(),
          caller: identity.caller_id_number,
          callee: identity.destination_number,
          rawId: raw.id,
          rawReceivedAt: raw.receivedAt,
          rawSha256: sha256,
          lastPushedAt: sql`now()`,
          reason,
        })
        .onConflictDoUpdate({
          target: schema.unassignedCdrs.rawSha256,
          targetWhere: sql`call_uuid IS NULL AND status IN ('pending', 'ignored')`,
          set: {
            pushCount: sql`${schema.unassignedCdrs.pushCount} + 1`,
            lastPushedAt: sql`now()`,
          },
        })
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      // 再次推送同一原文不写第二条告警（阶段 8 决定 42）。新的一份原文按结构化原因合并：
      // 同一种校验失败无论多少份不同原文，只有一条告警，affected_calls 为不同原文份数。
      if (row?.inserted) {
        await raiseAlert(tx, {
          kind: 'cdr_failed',
          subjectKey: AlertKeys.invalidCdr(reason),
          description: `${reason}（最近一份原文 ${raw.id}）`,
          calls: 1,
        });
      }
    });
    return { status: 'unassigned' as const, rawId: raw.id };
  }
  const cdr = {
    ...parsed.data,
    tenantTag: parsed.data.tenantTag.toUpperCase(),
  };
  const resolved = resolveBillingNumber({
    dialedNumber: cdr.callee,
    billingNumber: cdr.billingNumber,
  });
  try {
    const status = await withSystem(db, async (tx) => {
      // 未验证话单的 auth_timeout 告警放在最后写：停放 / 修正稿先拿未归属告警族的锁，
      // 所以所有路径的告警锁顺序都是「未归属族 → fs-authorize」，不会成环。
      const outcome = await (async () => {
        const [tenant] = await tx
          .select()
          .from(schema.tenants)
          .where(eq(sql`upper(${schema.tenants.code})`, cdr.tenantTag));
        await lockTenants(tx, tenant ? [tenant.id] : []);
        await tx.execute(
          sql`select set_config('app.cdr_ingest', 'true', true)`,
        );
        // 通过校验的话单入库（入队、停放、重复都算「该通话已有身份」）：同一事务里解决它之前的校验失败行。
        await supersedeInvalidRows(tx, cdr.callUuid);
        // 入库触发器允许阶段 8 认领未归属登记；HTTP 重推不能走认领流程。
        const [registered] = await tx
          .select()
          .from(schema.callUuids)
          .where(eq(schema.callUuids.callUuid, cdr.callUuid));
        if (registered) return 'duplicate' as const;
        if ('error' in resolved)
          return park(
            tx,
            cdr,
            resolved.error === 'mismatch'
              ? '计费号码不一致'
              : INVALID_NUMBER_REASON,
            resolved.error === 'mismatch' ? resolved.billingNumber : null,
          );
        if (!tenant)
          return park(
            tx,
            cdr,
            cdr.tenantTag ? '租户不存在' : '缺少租户标签',
            resolved.billingNumber,
          );
        const verifiedBillingNumber = resolved.billingNumber;
        const ratingTenant = await loadRatingTenant(tx, tenant.code);
        // 定价与写 cdrs 在 packages/db 的 priceAndInsertCdr，未归属话单的分配与这里共用。
        const inserted = await priceAndInsertCdr(
          tx,
          { id: tenant.id, rating: ratingTenant },
          cdr,
          verifiedBillingNumber,
        );
        if (inserted.status === 'no_rate')
          return park(tx, cdr, '接通时无费率', verifiedBillingNumber);
        // 删除话单之后属于该月的新话单不能再进账（阶段 8 决定 38）。删除持有同一把租户锁，
        // 上面的 lockTenants 之后读到的标志就是最新已提交的。
        if (inserted.status === 'month_deleted')
          return park(tx, cdr, CDR_MONTH_DELETED_REASON, verifiedBillingNumber);
        await queue.enqueue(tx, {
          tenantId: tenant.id,
          callUuid: cdr.callUuid,
        });
        return 'queued' as const;
      })();
      // FreeSWITCH 超时放行的信号随首次有效话单到达；去重后告警，重推不重复记。
      // 全局一条（租户为空），事件累加；各租户的受影响数从 cdrs 的 unverified 取。
      if (cdr.unverified && outcome !== 'duplicate') {
        await raiseAlert(tx, {
          kind: 'auth_timeout',
          subjectKey: AlertKeys.authTimeout,
          description: `FreeSWITCH 授权未验证，按 1800 秒放行，最近一通 ${cdr.callUuid}（按话单到达时间记录）`,
          calls: 1,
        });
      }
      return outcome;
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
