import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { connections, createTenant, pgError } from '../test/support.js';
import { setAccountLocale } from './account-locale.js';

const { app, owner } = connections();

async function user(): Promise<string> {
  const id = randomUUID();
  await owner.pool.query(
    'INSERT INTO auth."user"(id,name,email) VALUES ($1,$2,$3)',
    [id, 'locale fixture', `${id}@example.invalid`],
  );
  return id;
}

async function localeOf(table: 'admins' | 'portal_accounts', id: string) {
  const { rows } = await owner.pool.query<{ locale: string | null }>(
    `SELECT locale FROM public.${table} WHERE id = $1`,
    [id],
  );
  return rows[0]?.locale ?? null;
}

describe('setAccountLocale', () => {
  it('writes only the session profile and leaves the other account untouched', async () => {
    const [tenantA, tenantB] = [
      await createTenant(app, 'CNY'),
      await createTenant(app, 'CNY'),
    ];
    const [a, b] = [await user(), await user()];
    const [profileA, profileB] = [randomUUID(), randomUUID()];
    await owner.pool.query(
      'INSERT INTO public.portal_accounts(id,auth_user_id,tenant_id) VALUES ($1,$2,$3),($4,$5,$6)',
      [profileA, a, tenantA.id, profileB, b, tenantB.id],
    );

    expect(
      await setAccountLocale(
        app.db,
        {
          kind: 'customer',
          profileId: profileA,
          authUserId: a,
          tenantId: tenantA.id,
        },
        'en',
      ),
    ).toBe(true);
    expect(await localeOf('portal_accounts', profileA)).toBe('en');
    expect(await localeOf('portal_accounts', profileB)).toBeNull();

    // A 的 profileId 配 B 的 authUserId 或 B 的租户都不命中任何行。
    for (const target of [
      {
        kind: 'customer' as const,
        profileId: profileA,
        authUserId: b,
        tenantId: tenantA.id,
      },
      {
        kind: 'customer' as const,
        profileId: profileA,
        authUserId: a,
        tenantId: tenantB.id,
      },
    ])
      expect(await setAccountLocale(app.db, target, 'zh')).toBe(false);
    expect(await localeOf('portal_accounts', profileA)).toBe('en');
  });

  it('writes an admin locale and rejects values outside zh and en', async () => {
    const authUser = await user();
    const profileId = randomUUID();
    await owner.pool.query(
      'INSERT INTO public.admins(id,auth_user_id,name) VALUES ($1,$2,$3)',
      [profileId, authUser, 'locale admin'],
    );

    expect(
      await setAccountLocale(
        app.db,
        { kind: 'admin', profileId, authUserId: authUser, tenantId: null },
        'zh',
      ),
    ).toBe(true);
    expect(await localeOf('admins', profileId)).toBe('zh');

    expect(
      await pgError(
        owner.pool.query('UPDATE public.admins SET locale = $2 WHERE id = $1', [
          profileId,
          'ja',
        ]),
      ),
    ).toMatchObject({ code: '23514', constraint: 'admins_locale_check' });
  });
});
