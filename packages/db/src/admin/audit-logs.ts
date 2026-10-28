import { sql } from 'drizzle-orm';
import {
  auditActionSchema,
  auditChangeSchema,
  auditLabelActions,
  auditLabelOf,
  auditTargetKindSchema,
  type AdminAuditLog,
  type AdminAuditLogsQuery,
  type AuditChange,
} from '@fs-billing/shared';
import { z } from 'zod';
import { cdrTimestamp } from '../cdr-query.js';
import { withAdmin, type Db, type Tx } from '../client.js';

const detailsSchema = z.object({
  target: z
    .object({ kind: auditTargetKindSchema, id: z.uuid() })
    .nullish()
    .catch(null),
  content: z
    .object({
      summary: z.string().trim().min(1).nullish().catch(null),
      changes: z.array(auditChangeSchema).catch([]),
    })
    .nullish()
    .catch(null),
});

export interface AuditLogList {
  readonly range: { readonly from: string; readonly to: string };
  readonly items: readonly AdminAuditLog[];
  readonly total: number;
}

const knownActions = auditActionSchema.options;

/**
 * 操作日志列表（只读，阶段 8 决定 43）：北京日范围（默认最近 30 天，含今天）、管理员、操作标签、租户，
 * 按 created_at 降序。标签在这里展开成 action 集合；只列出 auditActionSchema 里的 action。
 * 走 operation_logs_created、operation_logs_tenant_created、operation_logs_action_created；
 * 100 万行下带筛选的耗时见 docs/evidence/phase-8。
 */
export function listAuditLogs(
  db: Db | Tx,
  query: AdminAuditLogsQuery,
): Promise<AuditLogList> {
  const actions = query.label ? auditLabelActions[query.label] : knownActions;
  return withAdmin(db, async (tx) => {
    // 日期按数据库时钟的北京日算，默认到今天为止最近 30 天。
    const { rows: ranges } = await tx.execute<{ from: string; to: string }>(sql`
      select to_char(coalesce(${query.from ?? null}::date, coalesce(${query.to ?? null}::date, today) - 29), 'YYYY-MM-DD') as "from",
        to_char(coalesce(${query.to ?? null}::date, today), 'YYYY-MM-DD') as "to"
      from (select (statement_timestamp() at time zone 'Asia/Shanghai')::date as today) t`);
    const range = ranges[0]!;
    const filters = sql.join(
      [
        sql`l.created_at >= (${range.from}::date)::timestamp at time zone 'Asia/Shanghai'`,
        sql`l.created_at < (${range.to}::date + 1)::timestamp at time zone 'Asia/Shanghai'`,
        sql`l.action in (${sql.join(
          actions.map((action) => sql`${action}`),
          sql`, `,
        )})`,
        ...(query.adminId ? [sql`l.admin_id = ${query.adminId}::uuid`] : []),
        ...(query.tenantId ? [sql`l.tenant_id = ${query.tenantId}::uuid`] : []),
      ],
      sql` and `,
    );
    const { rows: counts } = await tx.execute<{ count: number }>(
      sql`select count(*)::int as count from operation_logs l where ${filters}`,
    );
    const { rows } = await tx.execute<{
      id: string;
      created_at: string;
      admin_id: string | null;
      admin_name: string | null;
      actor_label: string | null;
      action: string;
      tenant_id: string | null;
      tenant_code: string | null;
      tenant_name: string | null;
      details: unknown;
    }>(sql`
      select l.id, ${cdrTimestamp(sql`l.created_at`)} as created_at, l.admin_id, a.name as admin_name, l.actor_label, l.action,
        l.tenant_id, t.code as tenant_code, t.name as tenant_name, l.details
      from (
        select * from operation_logs l
        where ${filters}
        order by l.created_at desc, l.id
        limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}
      ) l
      left join admins a on a.id = l.admin_id
      left join tenants t on t.id = l.tenant_id
      order by l.created_at desc, l.id`);
    return {
      range,
      total: counts[0]?.count ?? 0,
      items: rows.map((row): AdminAuditLog => {
        const action = auditActionSchema.parse(row.action);
        const details = detailsSchema.parse(row.details ?? {});
        const changes: AuditChange[] = details.content?.changes ?? [];
        return {
          id: row.id,
          occurredAt: row.created_at,
          actor:
            row.admin_id !== null && row.admin_name !== null
              ? { kind: 'admin', id: row.admin_id, name: row.admin_name }
              : { kind: 'system', label: row.actor_label ?? '未知来源' },
          action,
          label: auditLabelOf(action),
          tenant:
            row.tenant_id !== null &&
            row.tenant_code !== null &&
            row.tenant_name !== null
              ? {
                  id: row.tenant_id,
                  code: row.tenant_code,
                  name: row.tenant_name,
                }
              : null,
          target: details.target ?? null,
          summary: details.content?.summary ?? action,
          changes,
        };
      }),
    };
  });
}
