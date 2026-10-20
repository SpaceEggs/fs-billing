import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  adminCdrsQuerySchema,
  portalCdrsQuerySchema,
} from '@fs-billing/shared';
import { connections, createTenant } from '../../test/support.js';
import { withAdmin } from '../client.js';
import { ensureCdrPartitions } from '../partitions.js';
import { cdrs } from '../schema.js';
import { listPortalCdrCountries, listPortalCdrs } from './cdrs.js';
import { listAdminCdrCountries, listAdminCdrs } from '../admin/cdrs.js';

const { app } = connections();
const range = { from: '2026-09-01', to: '2026-09-30' };

beforeAll(() =>
  ensureCdrPartitions(app.db, {
    moment: new Date('2026-09-01T00:00:00+08:00'),
  }),
);

async function addCall({
  at,
  tenantId,
  answered = true,
  country = '英国',
  unverified = false,
  callUuid = randomUUID(),
}: {
  at: string;
  tenantId: string;
  answered?: boolean;
  country?: string;
  unverified?: boolean;
  callUuid?: string;
}) {
  const answeredAt = answered ? new Date(at) : null;
  const startedAt = new Date(Date.parse(at) - 60_000);
  return withAdmin(app.db, (tx) =>
    tx.insert(cdrs).values({
      iso: null,
      description: null,
      tenantId,
      callUuid,
      startedAt,
      answeredAt,
      endedAt: new Date(Date.parse(at) + 60_000),
      caller: '1001',
      callee: '+447700900123',
      billingNumber: '447700900123',
      durationSeconds: answered ? 60 : 0,
      billedMinutes: answered ? '1' : '0',
      matchedPrefix: answered ? '44' : null,
      country: answered ? country : null,
      rate: answered ? '0.2500' : null,
      charge: answered ? '0.25' : '0',
      hangupCause: answered ? 'NORMAL_CLEARING' : 'NO_ANSWER',
      unverified,
    }),
  );
}

describe('portal CDR queries', () => {
  it('uses the Beijing answered date, applies filters, and counts hidden unanswered rows', async () => {
    const tenant = await createTenant(app, 'CNY');
    await addCall({
      tenantId: tenant.id,
      at: '2026-09-28T16:30:00Z',
      unverified: true,
    });
    await addCall({
      tenantId: tenant.id,
      at: '2026-09-28T16:32:00Z',
      country: '中国',
    });
    await addCall({
      tenantId: tenant.id,
      at: '2026-09-28T16:33:00Z',
      answered: false,
    });

    const previousDay = await listPortalCdrs({
      db: app.db,
      tenantId: tenant.id,
      query: portalCdrsQuerySchema.parse({
        from: '2026-09-28',
        to: '2026-09-28',
      }),
    });
    expect(previousDay.pagination.total).toBe(0);

    const result = await listPortalCdrs({
      db: app.db,
      tenantId: tenant.id,
      query: portalCdrsQuerySchema.parse(range),
    });
    expect(result.pagination.total).toBe(2);
    expect(result.summary).toEqual({
      billedMinutes: '2',
      charge: '0.50',
      unansweredCalls: 1,
    });
    expect(result.items.map((row) => row.country)).toEqual(['中国', '英国']);
    expect(result.items.some((row) => 'unverified' in row)).toBe(false);

    const countryFiltered = await listPortalCdrs({
      db: app.db,
      tenantId: tenant.id,
      query: portalCdrsQuerySchema.parse({ ...range, country: '英国' }),
    });
    expect(countryFiltered.pagination.total).toBe(1);
    expect(countryFiltered.summary.unansweredCalls).toBe(0);

    const countries = await listPortalCdrCountries({
      db: app.db,
      tenantId: tenant.id,
      ...range,
    });
    expect(countries.countries).toEqual(['中国', '英国']);
  });

  it('includes unanswered rows only in all status and leaves totals on an empty page', async () => {
    const tenant = await createTenant(app, 'CNY');
    await addCall({
      tenantId: tenant.id,
      at: '2026-09-28T16:30:00Z',
      answered: false,
    });
    const answered = await listPortalCdrs({
      db: app.db,
      tenantId: tenant.id,
      query: portalCdrsQuerySchema.parse(range),
    });
    expect(answered.items).toHaveLength(0);

    const all = await listPortalCdrs({
      db: app.db,
      tenantId: tenant.id,
      query: portalCdrsQuerySchema.parse({ ...range, status: 'all' }),
    });
    expect(all.pagination.total).toBe(1);
    expect(all.summary.unansweredCalls).toBe(1);
    const emptyPage = await listPortalCdrs({
      db: app.db,
      tenantId: tenant.id,
      query: portalCdrsQuerySchema.parse({ ...range, status: 'all', page: 2 }),
    });
    expect(emptyPage.items).toEqual([]);
    expect(emptyPage.pagination.total).toBe(1);

    const ancient = await listPortalCdrs({
      db: app.db,
      tenantId: tenant.id,
      query: portalCdrsQuerySchema.parse({
        from: '0001-01-01',
        to: '0001-01-31',
      }),
    });
    expect(ancient.items).toEqual([]);
  });

  it('does not expose unverified fields to portal JSON while admins can filter and count them', async () => {
    const tenant = await createTenant(app, 'CNY');
    await addCall({
      tenantId: tenant.id,
      at: '2026-09-28T16:30:00Z',
      unverified: true,
    });
    await addCall({ tenantId: tenant.id, at: '2026-09-28T16:32:00Z' });
    const portal = await listPortalCdrs({
      db: app.db,
      tenantId: tenant.id,
      query: portalCdrsQuerySchema.parse(range),
    });
    expect(JSON.stringify(portal)).not.toContain('unverified');

    const admin = await listAdminCdrs({
      db: app.db,
      tenantId: tenant.id,
      query: adminCdrsQuerySchema.parse(range),
    });
    expect(admin.summary.unverifiedCalls).toBe(1);
    expect(admin.items.map((row) => row.unverified)).toEqual([false, true]);

    const onlyUnverified = await listAdminCdrs({
      db: app.db,
      tenantId: tenant.id,
      query: adminCdrsQuerySchema.parse({ ...range, unverifiedOnly: true }),
    });
    expect(onlyUnverified.pagination.total).toBe(1);
    expect(onlyUnverified.summary.unverifiedCalls).toBe(1);
    const adminCountries = await listAdminCdrCountries({
      db: app.db,
      tenantId: tenant.id,
      ...range,
    });
    expect(adminCountries.countries).toEqual(['英国']);
  });
});

it('returns ISO, country and description separately and groups country options across descriptions', async () => {
  const tenant = await createTenant(app, 'CNY');
  for (const [index, description] of ['', '手机'].entries()) {
    await withAdmin(app.db, (tx) =>
      tx.insert(cdrs).values({
        tenantId: tenant.id,
        callUuid: randomUUID(),
        startedAt: new Date(`2026-09-28T00:0${index}:00Z`),
        answeredAt: new Date(`2026-09-28T00:0${index}:01Z`),
        endedAt: new Date(`2026-09-28T00:0${index}:31Z`),
        caller: '1001',
        callee: index ? '447700900123' : '442071234567',
        billingNumber: index ? '447700900123' : '442071234567',
        matchedPrefix: index ? '447' : '44',
        durationSeconds: 30,
        billedMinutes: '1',
        iso: 'GB',
        country: '英国',
        description: description || null,
        rate: '0.02',
        charge: '0.02',
        hangupCause: 'NORMAL_CLEARING',
      }),
    );
  }
  await addCall({
    tenantId: tenant.id,
    at: '2026-09-28T00:03:00Z',
    answered: false,
  });
  const query = portalCdrsQuerySchema.parse({ ...range, country: '英国' });
  for (const result of [
    await listPortalCdrs({ db: app.db, tenantId: tenant.id, query }),
    await listAdminCdrs({
      db: app.db,
      tenantId: tenant.id,
      query: adminCdrsQuerySchema.parse(query),
    }),
  ]) {
    expect(result.pagination.total).toBe(2);
    expect(
      result.items.map(({ iso, country, description }) => ({
        iso,
        country,
        description,
      })),
    ).toEqual([
      { iso: 'GB', country: '英国', description: '手机' },
      { iso: 'GB', country: '英国', description: null },
    ]);
  }
  expect(
    await listPortalCdrCountries({ db: app.db, tenantId: tenant.id, ...range }),
  ).toEqual({ countries: ['英国'] });
  expect(
    await listAdminCdrCountries({ db: app.db, tenantId: tenant.id, ...range }),
  ).toEqual({ countries: ['英国'] });
  const all = await listPortalCdrs({
    db: app.db,
    tenantId: tenant.id,
    query: portalCdrsQuerySchema.parse({ ...range, status: 'all' }),
  });
  expect(all.items.find((row) => row.answeredAt === null)).toMatchObject({
    iso: null,
    description: null,
  });
});
