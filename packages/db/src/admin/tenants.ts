import { randomUUID } from 'node:crypto';
import { and, eq, or, sql, getTableColumns } from 'drizzle-orm';
import {
  decimal,
  rate,
  type RateEntry,
  type Currency,
} from '@fs-billing/rating';
import {
  DEFAULT_TENANT_OVERDRAFT_LIMIT,
  adminAmountRequestSchemas,
  type AdminAmountRequestSchemas,
  adminTenantEditRequestSchema,
  adminTenantCopyConsistencySchema,
  adminTenantsQuerySchema,
  type AdminTenantCreateRequest,
  type AdminTenantEditRequest,
  type AdminTenantSettingsRequest,
  type AdminTenantDetailResponse,
  type AdminTenantsQuery,
  type AdminTenantsResponse,
  type AuditPayload,
  type AuditChange,
} from '@fs-billing/shared';
import { lockTenants, withAdmin, type Db, type Tx } from '../client.js';
import { databaseNow } from '../clock.js';
import { readTenantUsageOverview, tenantMonthSpendSql } from '../usage.js';
import { NotFoundError } from '../errors.js';
import { createRateVersion } from '../rates.js';
import { likeContains } from './like.js';
import {
  tenants,
  tenantBalances,
  balanceAlertSettings,
  rateVersions,
  rateEntries,
} from '../schema.js';
import { writeAudit } from './audit.js';
import { AdminServiceError } from './errors.js';
import { parseInitialRateCsv } from './csv.js';

type TenantInput = {
  db: Db | Tx;
  actor: AuditPayload['actor'];
  tenantId: string;
};

const balance = sql<string>`coalesce(${tenantBalances.balance}, 0)::text`;
const available = sql<string>`(coalesce(${tenantBalances.balance}, 0) + ${tenants.overdraftLimit})::text`;
const threshold = sql<string>`coalesce(${balanceAlertSettings.threshold}, 0)::text`;
const health = sql<AdminTenantDetailResponse['health']>`case
 when ${tenants.status} = 'disabled' then 'disabled'
 when coalesce(${tenantBalances.balance},0) + ${tenants.overdraftLimit} <= 0 then 'suspended'
 when coalesce(${tenantBalances.balance},0) < 0 then 'overdraft'
 when ${balanceAlertSettings.tenantId} is not null and coalesce(${tenantBalances.balance},0) < ${balanceAlertSettings.threshold} then 'low_balance'
 else 'normal' end`;
const monthConsumption = tenantMonthSpendSql(tenants.id);
const pendingReceivable = sql<string>`coalesce((select sum(amount) from receivables r where r.tenant_id = ${tenants.id} and r.status = 'pending'),0)::text`;
function tenantRows(tx: Tx) {
  return tx
    .select({
      ...getTableColumns(tenants),
      balance,
      availableBalance: available,
      health,
      monthConsumption,
      pendingReceivable,
      settingsId: balanceAlertSettings.tenantId,
      lowBalanceThreshold: threshold,
      emails: sql<
        string[]
      >`coalesce(${balanceAlertSettings.emails}, array[]::text[])`,
    })
    .from(tenants)
    .leftJoin(tenantBalances, eq(tenantBalances.tenantId, tenants.id))
    .leftJoin(
      balanceAlertSettings,
      eq(balanceAlertSettings.tenantId, tenants.id),
    );
}
function summary(row: Awaited<ReturnType<typeof tenantRows>>[number]) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    currency: row.currency,
    status: row.status,
    health: row.health,
    settingsConfigured: Boolean(row.settingsId),
    balance: row.balance,
    overdraftLimit: row.overdraftLimit,
    availableBalance: row.availableBalance,
    monthConsumption: row.monthConsumption,
    pendingReceivable: row.pendingReceivable,
  };
}
function detail(
  row: Awaited<ReturnType<typeof tenantRows>>[number],
): AdminTenantDetailResponse {
  if (!row.settingsId) throw new Error('租户缺少余额提醒设置');
  return {
    ...summary(row),
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    remark: row.remark,
    createdAt: row.createdAt.toISOString(),
    settings: {
      emails: row.emails,
      lowBalanceThreshold: row.lowBalanceThreshold,
      overdraftLimit: row.overdraftLimit,
    },
  };
}
export async function readTenant(
  tx: Tx,
  tenantId: string,
): Promise<AdminTenantDetailResponse> {
  const [row] = await tenantRows(tx).where(eq(tenants.id, tenantId));
  if (!row) throw new AdminServiceError('NOT_FOUND', '租户不存在');
  return detail(row);
}
export function getTenant({
  db,
  tenantId,
}: Pick<TenantInput, 'db' | 'tenantId'>) {
  return withAdmin(db, (tx) => readTenant(tx, tenantId));
}
export async function getTenantOverview({
  db,
  tenantId,
}: Pick<TenantInput, 'db' | 'tenantId'>) {
  try {
    return await withAdmin(db, (tx) => readTenantUsageOverview(tx, tenantId));
  } catch (error) {
    if (error instanceof NotFoundError)
      throw new AdminServiceError('NOT_FOUND', error.message);
    throw error;
  }
}
export function listTenants({
  db,
  query,
}: {
  db: Db | Tx;
  query: AdminTenantsQuery;
}): Promise<AdminTenantsResponse> {
  const input = adminTenantsQuerySchema.parse(query);
  return withAdmin(db, async (tx) => {
    const filter = and(
      input.search
        ? or(
            sql`${tenants.code} ilike ${likeContains(input.search)} escape '\\'`,
            sql`${tenants.name} ilike ${likeContains(input.search)} escape '\\'`,
          )
        : undefined,
      input.currency ? eq(tenants.currency, input.currency) : undefined,
      input.status ? sql`${health} = ${input.status}` : undefined,
    );
    const [count] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(tenants)
      .leftJoin(tenantBalances, eq(tenantBalances.tenantId, tenants.id))
      .leftJoin(
        balanceAlertSettings,
        eq(balanceAlertSettings.tenantId, tenants.id),
      )
      .where(filter);
    const rows = await tenantRows(tx)
      .where(filter)
      .orderBy(
        sql`case ${health} when 'suspended' then 0 when 'overdraft' then 1 when 'low_balance' then 2 when 'normal' then 3 else 4 end`,
        tenants.currency,
        sql`coalesce(${tenantBalances.balance},0)`,
        tenants.code,
        tenants.id,
      )
      .limit(input.pageSize)
      .offset((input.page - 1) * input.pageSize);
    return {
      items: rows.map(summary),
      pagination: {
        page: input.page,
        pageSize: input.pageSize,
        total: count?.total ?? 0,
      },
    };
  });
}

export async function createTenant({
  db,
  actor,
  creatorEmail,
  request,
  amountRequests = adminAmountRequestSchemas,
}: {
  db: Db | Tx;
  actor: AuditPayload['actor'];
  creatorEmail: string;
  request: AdminTenantCreateRequest;
  amountRequests?: AdminAmountRequestSchemas;
}) {
  const input = amountRequests.tenantCreate.parse(request);
  const id = randomUUID();
  try {
    return await withAdmin(db, async (tx) => {
      await lockTenants(
        tx,
        input.initialRates.kind === 'copy'
          ? [id, input.initialRates.sourceTenantId]
          : [id],
      );
      let entries: readonly RateEntry<Currency>[] = [];
      switch (input.initialRates.kind) {
        case 'blank':
          break;
        case 'entries':
          entries = input.initialRates.entries.map((entry) => ({
            prefix: entry.prefix,
            country: entry.country,
            iso: entry.iso,
            description: entry.description,
            perMinute: rate(input.currency, entry.rate),
          }));
          break;
        case 'csv': {
          const bytes = Buffer.from(
            input.initialRates.file.contentBase64,
            'base64',
          );
          entries = parseInitialRateCsv(bytes, input.currency);
          break;
        }
        case 'copy': {
          const source = input.initialRates;
          const [version] = await tx
            .select({
              id: rateVersions.id,
              tenantId: rateVersions.tenantId,
              currency: tenants.currency,
            })
            .from(rateVersions)
            .innerJoin(tenants, eq(tenants.id, rateVersions.tenantId))
            .where(eq(rateVersions.id, source.sourceVersionId));
          if (
            !version ||
            version.tenantId !== source.sourceTenantId.toLowerCase()
          )
            throw new AdminServiceError('NOT_FOUND', '来源版本不存在');
          if (version.currency !== input.currency)
            throw new AdminServiceError('CURRENCY_MISMATCH', '来源币种不符');
          adminTenantCopyConsistencySchema.parse({
            ...source,
            sourceTenantId: version.tenantId,
            sourceVersionId: version.id,
            sourceVersion: version,
            targetCurrency: input.currency,
          });
          entries = (
            await tx
              .select()
              .from(rateEntries)
              .where(eq(rateEntries.rateVersionId, version.id))
          ).map((entry) => ({
            prefix: entry.prefix,
            country: entry.country,
            iso: entry.iso,
            description: entry.description,
            perMinute: rate(input.currency, entry.rate),
          }));
          break;
        }
      }
      const settings = amountRequests.settings.parse({
        ...input.settings,
        overdraftLimit:
          input.settings.overdraftLimit ??
          DEFAULT_TENANT_OVERDRAFT_LIMIT[input.currency],
        emails: input.settings.emails ?? [creatorEmail],
      });
      await tx.insert(tenants).values({
        id,
        code: input.code,
        name: input.name,
        currency: input.currency,
        overdraftLimit: settings.overdraftLimit,
        contactName: input.contactName,
        contactPhone: input.contactPhone,
        remark: input.remark,
      });
      await tx.insert(balanceAlertSettings).values({
        tenantId: id,
        threshold: settings.lowBalanceThreshold,
        emails: settings.emails,
      });
      const version = await createRateVersion(tx, id, entries, {
        adminId: actor.id,
      });
      const tenant = await readTenant(tx, id);
      const auditId = randomUUID();
      await writeAudit(tx, {
        id: auditId,
        actor,
        occurredAt: tenant.createdAt,
        tenantId: id,
        target: { kind: 'tenant', id },
        action: 'tenant_create',
        content: {
          summary: '创建租户',
          changes: [],
          code: input.code,
          currency: input.currency,
          rateVersionId: version.id,
        },
      });
      return {
        auditId,
        tenant,
        initialRateVersionId: version.id,
        effectiveFrom: version.effectiveFrom.toISOString(),
      };
    });
  } catch (error) {
    for (
      let current = error;
      current instanceof Error;
      current = current.cause
    ) {
      if (
        'code' in current &&
        current.code === '23505' &&
        'constraint' in current &&
        typeof current.constraint === 'string' &&
        (current.constraint === 'tenants_code_case_insensitive' ||
          current.constraint === 'tenants_code_key')
      )
        throw new AdminServiceError('TENANT_CODE_EXISTS', '租户编码已存在');
    }
    throw error;
  }
}

async function auditTenant(
  tx: Tx,
  actor: AuditPayload['actor'],
  tenantId: string,
  action:
    | 'tenant_edit'
    | 'tenant_enable'
    | 'tenant_disable'
    | 'tenant_settings_update',
  changes: AuditChange[],
) {
  const auditId = randomUUID();
  await writeAudit(tx, {
    id: auditId,
    actor,
    occurredAt: (await databaseNow(tx)).toISOString(),
    tenantId,
    target: { kind: 'tenant', id: tenantId },
    action,
    content: { summary: action, changes },
  });
  return { auditId };
}
export function editTenant({
  db,
  actor,
  tenantId,
  request,
}: TenantInput & { request: AdminTenantEditRequest }) {
  const input = adminTenantEditRequestSchema.parse(request);
  return withAdmin(db, async (tx) => {
    await lockTenants(tx, [tenantId]);
    const before = await readTenantCore(tx, tenantId);
    const fields = ['name', 'contactName', 'contactPhone', 'remark'] as const;
    const changes = fields
      .filter((field) => before[field] !== input[field])
      .map((field) => ({
        field,
        before: before[field],
        after: input[field],
      }));
    if (changes.length === 0) return { auditId: null };
    await tx.update(tenants).set(input).where(eq(tenants.id, tenantId));
    return auditTenant(tx, actor, before.id, 'tenant_edit', changes);
  });
}
function setTenantStatus(
  { db, actor, tenantId }: TenantInput,
  status: 'active' | 'disabled',
) {
  return withAdmin(db, async (tx) => {
    await lockTenants(tx, [tenantId]);
    const before = await readTenantCore(tx, tenantId);
    if (before.status === status) return { auditId: null };
    await tx.update(tenants).set({ status }).where(eq(tenants.id, tenantId));
    return auditTenant(
      tx,
      actor,
      before.id,
      status === 'active' ? 'tenant_enable' : 'tenant_disable',
      [{ field: 'status', before: before.status, after: status }],
    );
  });
}
export const disableTenant = (input: TenantInput) =>
  setTenantStatus(input, 'disabled');
export const enableTenant = (input: TenantInput) =>
  setTenantStatus(input, 'active');
export function updateTenantSettings({
  db,
  actor,
  tenantId,
  request,
  amountRequests = adminAmountRequestSchemas,
}: TenantInput & {
  request: AdminTenantSettingsRequest;
  amountRequests?: AdminAmountRequestSchemas;
}) {
  const input = amountRequests.settings.parse(request);
  return withAdmin(db, async (tx) => {
    await lockTenants(tx, [tenantId]);
    const before = await readTenant(tx, tenantId);
    const afterOverdraft = decimal(input.overdraftLimit).toFixed();
    const afterThreshold = decimal(input.lowBalanceThreshold).toFixed();
    const changes: AuditChange[] = [];
    if (!decimal(before.overdraftLimit).eq(afterOverdraft))
      changes.push({
        field: 'overdraftLimit',
        before: decimal(before.overdraftLimit).toFixed(),
        after: afterOverdraft,
      });
    if (!decimal(before.settings.lowBalanceThreshold).eq(afterThreshold))
      changes.push({
        field: 'lowBalanceThreshold',
        before: decimal(before.settings.lowBalanceThreshold).toFixed(),
        after: afterThreshold,
      });
    if (
      before.settings.emails.length !== input.emails.length ||
      before.settings.emails.some(
        (email, index) => email !== input.emails[index],
      )
    )
      changes.push({
        field: 'emails',
        before: before.settings.emails,
        after: input.emails,
      });
    if (changes.length === 0) return { auditId: null };
    await tx
      .update(tenants)
      .set({ overdraftLimit: input.overdraftLimit })
      .where(eq(tenants.id, tenantId));
    await tx
      .insert(balanceAlertSettings)
      .values({
        tenantId,
        threshold: input.lowBalanceThreshold,
        emails: input.emails,
      })
      .onConflictDoUpdate({
        target: balanceAlertSettings.tenantId,
        set: { threshold: input.lowBalanceThreshold, emails: input.emails },
      });
    return auditTenant(tx, actor, before.id, 'tenant_settings_update', changes);
  });
}

export async function readTenantCore(tx: Tx, tenantId: string) {
  const [tenant] = await tx
    .select()
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant) throw new AdminServiceError('NOT_FOUND', '租户不存在');
  return tenant;
}
