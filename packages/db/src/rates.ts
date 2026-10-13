import { asc, eq } from 'drizzle-orm';
import {
  money,
  rate,
  type Currency,
  type RateEntry,
  type RateVersion,
  type Tenant,
} from '@fs-billing/rating';
import type { Tx } from './client.js';
import {
  rateEntries,
  rateVersions,
  tenantBalances,
  tenants,
} from './schema.js';

/**
 * 新建整表费率版本。不传 effectiveFrom 即“立即生效”，由数据库 now() 填写。
 * 数据库拒绝早于已有版本的生效时间（包括已排定未来版本时的立即生效）。
 */
export async function createRateVersion<C extends Currency>(
  tx: Tx,
  tenantId: string,
  entries: readonly RateEntry<C>[],
  options: { readonly effectiveFrom?: Date; readonly adminId?: string } = {},
): Promise<{ id: string; effectiveFrom: Date }> {
  const [version] = await tx
    .insert(rateVersions)
    .values({
      tenantId,
      createdBy: options.adminId ?? null,
      ...(options.effectiveFrom && { effectiveFrom: options.effectiveFrom }),
    })
    .returning({
      id: rateVersions.id,
      effectiveFrom: rateVersions.effectiveFrom,
    });
  if (entries.length > 0) {
    await tx.insert(rateEntries).values(
      entries.map((entry) => ({
        tenantId,
        rateVersionId: version!.id,
        prefix: entry.prefix,
        country: entry.country,
        rate: entry.perMinute.perMinute.toFixed(),
      })),
    );
  }
  return version!;
}

/** 从数据库读取授权所需的租户：状态、币种、缓存余额、透支额度与全部费率版本。 */
export async function loadRatingTenant(
  tx: Tx,
  code: string,
): Promise<Tenant<Currency> | undefined> {
  const [row] = await tx
    .select({
      id: tenants.id,
      code: tenants.code,
      status: tenants.status,
      currency: tenants.currency,
      overdraftLimit: tenants.overdraftLimit,
      balance: tenantBalances.balance,
    })
    .from(tenants)
    .innerJoin(tenantBalances, eq(tenantBalances.tenantId, tenants.id))
    .where(eq(tenants.code, code));
  if (!row) return undefined;

  const rows = await tx
    .select({
      versionId: rateVersions.id,
      effectiveFrom: rateVersions.effectiveFrom,
      prefix: rateEntries.prefix,
      country: rateEntries.country,
      rate: rateEntries.rate,
    })
    .from(rateVersions)
    .leftJoin(rateEntries, eq(rateEntries.rateVersionId, rateVersions.id))
    .where(eq(rateVersions.tenantId, row.id))
    .orderBy(asc(rateVersions.effectiveFrom));

  const versions = new Map<
    string,
    { effectiveFrom: Date; entries: RateEntry<Currency>[] }
  >();
  for (const r of rows) {
    let version = versions.get(r.versionId);
    if (!version) {
      version = { effectiveFrom: r.effectiveFrom, entries: [] };
      versions.set(r.versionId, version);
    }
    if (r.prefix !== null && r.country !== null && r.rate !== null) {
      version.entries.push({
        prefix: r.prefix,
        country: r.country,
        perMinute: rate(row.currency, r.rate),
      });
    }
  }

  return {
    code: row.code,
    status: row.status,
    currency: row.currency,
    balance: money(row.currency, row.balance),
    overdraft: money(row.currency, row.overdraftLimit),
    rates: {
      currency: row.currency,
      versions: [...versions.values()] satisfies RateVersion<Currency>[],
    },
  };
}
