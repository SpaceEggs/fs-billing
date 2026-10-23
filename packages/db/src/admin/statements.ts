import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { decimal } from '@fs-billing/rating';
import {
  adminStatementRegenerateResponseSchema,
  adminStatementsQuerySchema,
  adminStatementsResponseSchema,
  adminTenantStatementResponseSchema,
  adminTenantStatementsResponseSchema,
  type AdminStatementListRow,
  type AdminStatementRegenerateRequest,
  type AdminStatementRegenerateResponse,
  type AdminStatementsQuery,
  type AdminStatementsResponse,
  type AdminTenantStatementResponse,
  type AdminTenantStatementRow,
  type AdminTenantStatementsResponse,
  type AuditPayload,
  type Currency,
} from '@fs-billing/shared';
import { withAdmin, type Db, type Tx } from '../client.js';
import { NotFoundError } from '../errors.js';
import {
  addMonths,
  currentStatementMonth,
  databaseInstant,
  listMissingStatements,
  listStatementHeadersForMonth,
  monthKey,
  parseStatementMonth,
  readStatementMonthList,
  readStatementView,
  regenerateStatement,
  StatementError,
  type StatementFigures,
  type StatementHeader,
  type StatementState,
} from '../statements/index.js';
import { writeAudit } from './audit.js';
import { AdminServiceError } from './errors.js';

type Actor = AuditPayload['actor'];

const iso = (value: Date) => value.toISOString();

function regenerable(state: StatementState, detailsDeleted: boolean) {
  const reason =
    state === 'in_progress'
      ? ('in_progress' as const)
      : detailsDeleted
        ? ('details_deleted' as const)
        : null;
  return { allowed: reason === null, reason };
}

function headerFields(header: StatementHeader | null) {
  return {
    generatedAt: header ? iso(header.generatedAt) : null,
    firstGeneratedAt: header ? iso(header.firstGeneratedAt) : null,
    version: header?.version ?? 0,
    detailsDeleted: header?.detailsDeleted ?? false,
    reconcileStatus: header?.reconcileStatus ?? null,
  };
}

/**
 * 后台账单页：一个月份内全部租户，按币种分组（不跨币种相加），组内按租户编码升序。
 * 应有而缺账单行的租户是 `pending` 且 figures 为 null（「未生成」），不为每个缺失行做实时聚合。
 * 合计只算 final 行，由服务端在全量行上算。当前北京月还没有应有的账单，返回空分组。
 */
export function listAdminStatements({
  db,
  query,
}: {
  db: Db;
  query: AdminStatementsQuery;
}): Promise<AdminStatementsResponse> {
  const input = adminStatementsQuerySchema.parse(query);
  return withAdmin(db, async (tx) => {
    const asOf = await databaseInstant(tx);
    const current = await currentStatementMonth(tx, asOf);
    const month = input.month
      ? parseStatementMonth(input.month)
      : addMonths(current, -1);
    if (month > current)
      throw new AdminServiceError(
        'VALIDATION_ERROR',
        `${monthKey(month)} 晚于当前北京月`,
      );
    const rows: { currency: Currency; row: AdminStatementListRow }[] = [];
    if (month < current) {
      const { rows: tenantRows } = await tx.execute<{
        id: string;
        code: string;
        name: string;
        currency: Currency;
      }>(sql`select id, code, name, currency from tenants`);
      const tenants = new Map(tenantRows.map((row) => [row.id, row]));
      for (const header of await listStatementHeadersForMonth(tx, month)) {
        const tenant = tenants.get(header.tenantId);
        if (!tenant) continue;
        rows.push({
          currency: tenant.currency,
          row: {
            tenant: { id: tenant.id, code: tenant.code, name: tenant.name },
            month: monthKey(month),
            state: 'final',
            figures: figuresOf(header),
            ...headerFields(header),
            regenerable: regenerable('final', header.detailsDeleted),
          },
        });
      }
      // 只看这一个月份：from 与 through 都是它。
      for (const missing of await listMissingStatements(tx, {
        from: month,
        through: month,
        asOf,
      })) {
        const tenant = tenants.get(missing.tenantId);
        if (!tenant || missing.month !== month) continue;
        rows.push({
          currency: tenant.currency,
          row: {
            tenant: { id: tenant.id, code: tenant.code, name: tenant.name },
            month: monthKey(month),
            state: 'pending',
            figures: null,
            ...headerFields(null),
            regenerable: regenerable('pending', false),
          },
        });
      }
    }
    const groups = [...new Set(rows.map((entry) => entry.currency))]
      .sort()
      .map((currency) => {
        const items = rows
          .filter((entry) => entry.currency === currency)
          .map((entry) => entry.row)
          .sort((a, b) => a.tenant.code.localeCompare(b.tenant.code, 'en'));
        return {
          currency,
          tenantCount: items.length,
          totals: totalsOf(items),
          items,
        };
      });
    return adminStatementsResponseSchema.parse({
      month: monthKey(month),
      asOf: iso(asOf),
      groups,
    });
  });
}

function figuresOf(source: StatementFigures): StatementFigures {
  return {
    openingBalance: source.openingBalance,
    recharge: source.recharge,
    gift: source.gift,
    adjustment: source.adjustment,
    callCharges: source.callCharges,
    closingBalance: source.closingBalance,
    calls: source.calls,
    callMinutes: source.callMinutes,
  };
}

/** 只算 final 行（有 figures 的行）。 */
function totalsOf(items: readonly AdminStatementListRow[]): StatementFigures {
  const sum = (pick: (figures: StatementFigures) => string) =>
    items
      .reduce(
        (total, item) =>
          item.figures ? total.plus(pick(item.figures)) : total,
        decimal('0'),
      )
      .toFixed();
  const canonical = (value: string) => (decimal(value).isZero() ? '0' : value);
  return {
    openingBalance: canonical(sum((f) => f.openingBalance)),
    recharge: canonical(sum((f) => f.recharge)),
    gift: canonical(sum((f) => f.gift)),
    adjustment: canonical(sum((f) => f.adjustment)),
    callCharges: canonical(sum((f) => f.callCharges)),
    closingBalance: canonical(sum((f) => f.closingBalance)),
    calls: Number(sum((f) => String(f.calls))),
    callMinutes: canonical(sum((f) => f.callMinutes)),
  };
}

/** 租户详情「账单」标签页：全部月份，待生成的月份也实时算出数字。 */
export function listAdminTenantStatements({
  db,
  tenantId,
}: {
  db: Db;
  tenantId: string;
}): Promise<AdminTenantStatementsResponse> {
  return withAdmin(db, async (tx) => {
    const list = await readStatementMonthList(tx, tenantId);
    const items: AdminTenantStatementRow[] = list.items.map((item) => ({
      month: monthKey(item.month),
      state: item.state,
      figures: item.figures,
      ...headerFields(item.header),
      regenerable: regenerable(
        item.state,
        item.header?.detailsDeleted ?? false,
      ),
    }));
    return adminTenantStatementsResponseSchema.parse({
      currency: list.tenant.currency,
      tenant: {
        id: list.tenant.id,
        code: list.tenant.code,
        name: list.tenant.name,
      },
      asOf: iso(list.asOf),
      items,
    });
  });
}

async function generatorOf(tx: Tx, adminId: string | null) {
  if (adminId === null) return null;
  const { rows } = await tx.execute<{ name: string }>(
    sql`select name from admins where id = ${adminId}::uuid`,
  );
  return { id: adminId, name: rows[0]?.name ?? '未知管理员' };
}

/** 后台账单详情：在门户详情之外有版本、生成人、核对结果、差额和是否可重新生成。 */
export function readAdminTenantStatement({
  db,
  tenantId,
  month,
}: {
  db: Db;
  tenantId: string;
  month: string;
}): Promise<AdminTenantStatementResponse> {
  return withAdmin(db, async (tx) => {
    const view = await readStatementView(tx, tenantId, month);
    const header = view.header;
    return adminTenantStatementResponseSchema.parse({
      currency: view.tenant.currency,
      tenant: {
        id: view.tenant.id,
        code: view.tenant.code,
        name: view.tenant.name,
      },
      month: monthKey(view.month),
      state: view.state,
      period: view.period,
      asOf: view.asOf ? iso(view.asOf) : null,
      generatedAt: header ? iso(header.generatedAt) : null,
      firstGeneratedAt: header ? iso(header.firstGeneratedAt) : null,
      detailsDeleted: header?.detailsDeleted ?? false,
      version: header?.version ?? 0,
      generatedBy: await generatorOf(tx, header?.generatedBy ?? null),
      reconcile: header
        ? {
            status: header.reconcileStatus,
            reconciledAt: header.reconciledAt ? iso(header.reconciledAt) : null,
            diff: header.reconcileDiff,
          }
        : null,
      breakdownGap: view.breakdownGap,
      regenerable: regenerable(view.state, header?.detailsDeleted ?? false),
      figures: view.figures,
      countries: view.countries,
      days: view.days,
    });
  });
}

/**
 * 管理员重新生成一个月份的账单（`repeatable read`），同一事务写 `statement_regenerate` 操作日志，
 * 含 before / after / changed；结果无变化时不加版本，仍写日志。待生成的月份（expectedVersion 0）等同补建。
 * 业务拒绝映射成 409：话单已删除、月份未结束、版本过期。月份晚于当前北京月是 400。
 */
export function regenerateAdminTenantStatement({
  db,
  actor,
  tenantId,
  month,
  request,
}: {
  db: Db;
  actor: Actor;
  tenantId: string;
  month: string;
  request: AdminStatementRegenerateRequest;
}): Promise<AdminStatementRegenerateResponse> {
  const first = parseStatementMonth(month);
  return withAdmin(
    db,
    async (tx) => {
      if (first > (await currentStatementMonth(tx)))
        throw new AdminServiceError(
          'VALIDATION_ERROR',
          `${monthKey(first)} 晚于当前北京月`,
        );
      let result;
      try {
        result = await regenerateStatement(tx, tenantId, first, {
          expectedVersion: request.expectedVersion,
          adminId: actor.id,
        });
      } catch (error) {
        if (error instanceof StatementError)
          throw new AdminServiceError(error.code, error.message);
        throw error;
      }
      const { rows } = await tx.execute<{ code: string }>(
        sql`select code from tenants where id = ${tenantId}::uuid`,
      );
      const code = rows[0]?.code;
      if (!code) throw new NotFoundError('租户不存在');
      const { before, after } = result;
      const auditId = randomUUID();
      const label = result.created
        ? '补建'
        : result.changed
          ? '重新生成'
          : '重新生成（无变化）';
      await writeAudit(tx, {
        id: auditId,
        actor,
        occurredAt: new Date().toISOString(),
        tenantId,
        target: { kind: 'statement', id: result.statement.id },
        action: 'statement_regenerate',
        content: {
          summary: `${label} ${code} ${monthKey(first)} 月账单`,
          changes: [],
          month: monthKey(first),
          created: result.created,
          changed: result.changed,
          before,
          after,
        },
      });
      return adminStatementRegenerateResponseSchema.parse({
        auditId,
        month: monthKey(first),
        created: result.created,
        changed: result.changed,
        before,
        after,
        staleFollowingMonths: result.staleFollowingMonths.map(monthKey),
      });
    },
    { isolationLevel: 'repeatable read' },
  );
}
