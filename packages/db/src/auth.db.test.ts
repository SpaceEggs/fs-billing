import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getTableConfig } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { connections, createTenant, pgError } from '../test/support.js';
import * as authSchema from './auth-schema.js';

const { app, owner } = connections();
const auth = new pg.Pool({ connectionString: inject('authUrl') });
afterAll(() => auth.end());

async function user() {
  const id = randomUUID();
  await owner.pool.query(
    'INSERT INTO auth."user"(id,name,email) VALUES ($1,$2,$3)',
    [id, 'identity fixture', `${id}@example.invalid`],
  );
  return id;
}

async function identity(id: string) {
  const { rows } = await app.pool.query<{
    kind: string;
    profile_id: string | null;
    tenant_id: string | null;
    profile_name: string | null;
    profile_status: string | null;
    tenant_code: string | null;
    tenant_name: string | null;
    tenant_currency: string | null;
    tenant_status: string | null;
  }>('SELECT * FROM public.resolve_auth_identity($1)', [id]);
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe('auth catalog and privilege boundary', () => {
  it('auth tables have no RLS and are not owned by runtime roles', async () => {
    const { rows } = await owner.pool.query<{
      relname: string;
      relrowsecurity: boolean;
      owner: string;
    }>(`SELECT relname, relrowsecurity, pg_get_userbyid(relowner) AS owner
      FROM pg_class WHERE relnamespace='auth'::regnamespace AND relkind='r' ORDER BY relname`);
    expect(rows.map((r) => r.relname)).toEqual([
      'account',
      'login_failures',
      'session',
      'user',
      'verification',
    ]);
    for (const row of rows) {
      expect(row.relrowsecurity).toBe(false);
      expect([
        'fs_billing_app',
        'fs_billing_auth',
        'fs_billing_identity',
      ]).not.toContain(row.owner);
    }
  });

  it('roles cannot inherit or create privileges and have no membership', async () => {
    const { rows } = await owner.pool
      .query(`SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit
      FROM pg_roles WHERE rolname IN ('fs_billing_auth','fs_billing_identity') ORDER BY rolname`);
    expect(rows).toEqual([
      {
        rolname: 'fs_billing_auth',
        rolcanlogin: true,
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
      },
      {
        rolname: 'fs_billing_identity',
        rolcanlogin: false,
        rolsuper: false,
        rolbypassrls: true,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
      },
    ]);
    expect(
      (
        await owner.pool.query(`SELECT FROM pg_auth_members WHERE member IN
      (SELECT oid FROM pg_roles WHERE rolname IN ('fs_billing_auth','fs_billing_identity'))`)
      ).rowCount,
    ).toBe(0);
  });

  it('auth role has CRUD only on five auth tables and no schema CREATE', async () => {
    for (const table of [
      'user',
      'session',
      'account',
      'verification',
      'login_failures',
    ]) {
      const { rows } = await owner.pool.query(
        `SELECT
        has_table_privilege('fs_billing_auth',$1,'SELECT') AS select,
        has_table_privilege('fs_billing_auth',$1,'INSERT') AS insert,
        has_table_privilege('fs_billing_auth',$1,'UPDATE') AS update,
        has_table_privilege('fs_billing_auth',$1,'DELETE') AS delete,
        has_table_privilege('fs_billing_auth',$1,'TRUNCATE') AS truncate`,
        [`auth."${table}"`],
      );
      expect(rows).toEqual([
        {
          select: true,
          insert: true,
          update: true,
          delete: true,
          truncate: false,
        },
      ]);
    }
    expect(
      (
        await owner.pool.query(
          `SELECT has_schema_privilege('fs_billing_auth','auth','CREATE') AS allowed`,
        )
      ).rows,
    ).toEqual([{ allowed: false }]);
    expect(
      (
        await owner.pool.query(
          `SELECT FROM pg_default_acl WHERE defaclnamespace='auth'::regnamespace`,
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await owner.pool.query(
          `SELECT FROM pg_class WHERE relnamespace='auth'::regnamespace AND relkind='S'`,
        )
      ).rowCount,
    ).toBe(0);
    const id = randomUUID();
    await auth.query(
      'INSERT INTO auth."user"(id,name,email) VALUES ($1,$2,$3)',
      [id, 'CRUD fixture', `${id}@example.invalid`],
    );
    await auth.query('UPDATE auth."user" SET name=$2 WHERE id=$1', [
      id,
      'updated',
    ]);
    expect(
      (await auth.query('SELECT name FROM auth."user" WHERE id=$1', [id])).rows,
    ).toEqual([{ name: 'updated' }]);
    await auth.query(
      "INSERT INTO auth.session(id,user_id,token,expires_at,updated_at) VALUES ($1,$1,$2,now()+interval '1 hour',now())",
      [id, randomUUID()],
    );
    await auth.query('UPDATE auth.session SET user_agent=$2 WHERE id=$1', [
      id,
      'fixture agent',
    ]);
    expect(
      (
        await auth.query('SELECT user_agent FROM auth.session WHERE id=$1', [
          id,
        ])
      ).rows,
    ).toEqual([{ user_agent: 'fixture agent' }]);
    await auth.query(
      "INSERT INTO auth.account(id,account_id,provider_id,user_id,password,updated_at) VALUES($1,$1,'credential',$1,'before',now())",
      [id],
    );
    await auth.query('UPDATE auth.account SET password=$2 WHERE id=$1', [
      id,
      'after',
    ]);
    expect(
      (await auth.query('SELECT password FROM auth.account WHERE id=$1', [id]))
        .rows,
    ).toEqual([{ password: 'after' }]);
    await auth.query('DELETE FROM auth.account WHERE id=$1', [id]);
    expect(
      (await auth.query('SELECT id FROM auth.account WHERE id=$1', [id])).rows,
    ).toEqual([]);
    await auth.query(
      "INSERT INTO auth.verification(id,identifier,value,expires_at) VALUES($1,$1,'before',now()+interval '1 hour')",
      [id],
    );
    await auth.query('UPDATE auth.verification SET value=$2 WHERE id=$1', [
      id,
      'after',
    ]);
    expect(
      (
        await auth.query('SELECT value FROM auth.verification WHERE id=$1', [
          id,
        ])
      ).rows,
    ).toEqual([{ value: 'after' }]);
    await auth.query('DELETE FROM auth.verification WHERE id=$1', [id]);
    expect(
      (await auth.query('SELECT id FROM auth.verification WHERE id=$1', [id]))
        .rows,
    ).toEqual([]);
    await auth.query(
      'INSERT INTO auth.login_failures(email_key,window_id,failed_count,last_failed_at) VALUES($1,$2,1,now())',
      [id, randomUUID()],
    );
    await auth.query(
      'UPDATE auth.login_failures SET failed_count=2 WHERE email_key=$1',
      [id],
    );
    expect(
      (
        await auth.query(
          'SELECT failed_count FROM auth.login_failures WHERE email_key=$1',
          [id],
        )
      ).rows,
    ).toEqual([{ failed_count: 2 }]);
    await auth.query('DELETE FROM auth.login_failures WHERE email_key=$1', [
      id,
    ]);
    expect(
      (
        await auth.query(
          'SELECT email_key FROM auth.login_failures WHERE email_key=$1',
          [id],
        )
      ).rows,
    ).toEqual([]);
    await auth.query('DELETE FROM auth.session WHERE id=$1', [id]);
    expect(
      (await auth.query('SELECT id FROM auth.session WHERE id=$1', [id])).rows,
    ).toEqual([]);
    await auth.query(
      "INSERT INTO auth.session(id,user_id,token,expires_at,updated_at) VALUES ($1,$1,$2,now()+interval '1 hour',now())",
      [id, randomUUID()],
    );
    await auth.query('DELETE FROM auth."user" WHERE id=$1', [id]);
    expect(
      (await auth.query('SELECT FROM auth.session WHERE user_id=$1', [id]))
        .rowCount,
    ).toBe(0);
  });

  it('actual cross-boundary accesses fail with 42501', async () => {
    for (const statement of [
      'SELECT * FROM public.admins',
      'SELECT * FROM public.tenants',
      "SELECT * FROM public.resolve_auth_identity('missing')",
    ]) {
      expect((await pgError(auth.query(statement))).code).toBe('42501');
    }
    for (const statement of [
      'SELECT * FROM auth.account',
      'SELECT * FROM auth.session',
    ]) {
      expect((await pgError(app.pool.query(statement))).code).toBe('42501');
    }
  });

  it('identity function is restricted SQL STABLE with exact search_path', async () => {
    const { rows } = await owner.pool
      .query(`SELECT pg_get_userbyid(p.proowner) AS owner,
      p.prosecdef,p.provolatile,l.lanname,p.proconfig,
      has_function_privilege('fs_billing_auth',p.oid,'EXECUTE') AS auth,
      has_function_privilege('fs_billing_app',p.oid,'EXECUTE') AS app,
      EXISTS (SELECT FROM aclexplode(p.proacl) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public
      FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid='public.resolve_auth_identity(text)'::regprocedure`);
    expect(rows).toEqual([
      {
        owner: 'fs_billing_identity',
        prosecdef: true,
        provolatile: 's',
        lanname: 'sql',
        proconfig: ['search_path=pg_catalog, pg_temp'],
        auth: false,
        app: true,
        public: false,
      },
    ]);
    const grants = await owner.pool.query<{
      table_name: string;
      column_name: string;
    }>(`SELECT table_name,column_name FROM information_schema.column_privileges
      WHERE grantee='fs_billing_identity' AND table_schema='public' ORDER BY table_name,column_name`);
    expect(grants.rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
      'admins.auth_user_id',
      'admins.id',
      'admins.name',
      'admins.status',
      'portal_accounts.auth_user_id',
      'portal_accounts.id',
      'portal_accounts.status',
      'portal_accounts.tenant_id',
      'tenants.code',
      'tenants.currency',
      'tenants.id',
      'tenants.name',
      'tenants.status',
    ]);
    expect(
      (
        await owner.pool.query(
          `SELECT has_table_privilege('fs_billing_identity','public.admins','SELECT') AS whole`,
        )
      ).rows,
    ).toEqual([{ whole: false }]);
  });

  it('Drizzle auth schema matches actual columns', async () => {
    const { rows } = await owner.pool.query<{
      table_name: string;
      column_name: string;
    }>(
      `SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='auth'`,
    );
    for (const table of Object.values(authSchema)) {
      const config = getTableConfig(table);
      expect(
        rows
          .filter((r) => r.table_name === config.name)
          .map((r) => r.column_name)
          .sort(),
      ).toEqual(config.columns.map((c) => c.name).sort());
    }
    expect(
      (
        await owner.pool
          .query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name IN ('admins','portal_accounts') AND column_name='email'`)
      ).rows,
    ).toEqual([]);
  });
});

describe('identity cardinality before status', () => {
  it('returns none for zero matches', async () => {
    expect(await identity(await user())).toEqual({
      kind: 'none',
      profile_id: null,
      tenant_id: null,
      profile_name: null,
      profile_status: null,
      tenant_code: null,
      tenant_name: null,
      tenant_currency: null,
      tenant_status: null,
    });
  });

  it('returns admin including a disabled profile status', async () => {
    const id = await user();
    const profile = z
      .object({ id: z.uuid() })
      .parse(
        (
          await owner.pool.query<{ id: string }>(
            'INSERT INTO public.admins(auth_user_id,name,status) VALUES ($1,$2,$3) RETURNING id',
            [id, 'disabled admin', 'disabled'],
          )
        ).rows[0],
      );
    expect(await identity(id)).toMatchObject({
      kind: 'admin',
      profile_id: profile.id,
      profile_name: 'disabled admin',
      profile_status: 'disabled',
      tenant_id: null,
    });
  });

  it('returns customer with disabled account and tenant states', async () => {
    const id = await user();
    const tenant = await createTenant(owner, 'USD');
    await owner.pool.query('UPDATE public.tenants SET status=$2 WHERE id=$1', [
      tenant.id,
      'disabled',
    ]);
    const profile = z
      .object({ id: z.uuid() })
      .parse(
        (
          await owner.pool.query<{ id: string }>(
            'INSERT INTO public.portal_accounts(auth_user_id,tenant_id,status) VALUES ($1,$2,$3) RETURNING id',
            [id, tenant.id, 'disabled'],
          )
        ).rows[0],
      );
    expect(await identity(id)).toMatchObject({
      kind: 'customer',
      profile_id: profile.id,
      tenant_id: tenant.id,
      profile_status: 'disabled',
      tenant_status: 'disabled',
      tenant_code: tenant.code,
      tenant_currency: 'USD',
    });
  });

  it('active admin plus disabled customer is ambiguous', async () => {
    const id = await user();
    const tenant = await createTenant(owner, 'CNY');
    await owner.pool.query(
      'INSERT INTO public.admins(auth_user_id,name) VALUES ($1,$2)',
      [id, 'active admin'],
    );
    await owner.pool.query(
      'INSERT INTO public.portal_accounts(auth_user_id,tenant_id,status) VALUES ($1,$2,$3)',
      [id, tenant.id, 'disabled'],
    );
    expect(await identity(id)).toMatchObject({
      kind: 'ambiguous',
      profile_id: null,
      tenant_id: null,
      profile_status: null,
    });
  });

  it('UNIQUE, NOT NULL, FK and RESTRICT apply independently to both profiles', async () => {
    const tenant = await createTenant(owner, 'CNY');
    for (const table of ['admins', 'portal_accounts']) {
      const insert =
        table === 'admins'
          ? (id: string | null) =>
              owner.pool.query(
                'INSERT INTO public.admins(auth_user_id,name) VALUES ($1,$2)',
                [id, 'constraint fixture'],
              )
          : (id: string | null) =>
              owner.pool.query(
                'INSERT INTO public.portal_accounts(auth_user_id,tenant_id) VALUES ($1,$2)',
                [id, tenant.id],
              );
      expect((await pgError(insert(null))).code).toBe('23502');
      expect((await pgError(insert(randomUUID()))).code).toBe('23503');
      const id = await user();
      await insert(id);
      expect((await pgError(insert(id))).code).toBe('23505');
      expect(
        (
          await pgError(
            owner.pool.query('DELETE FROM auth."user" WHERE id=$1', [id]),
          )
        ).code,
      ).toBe('23503');
    }
  });
});

async function legacyDatabase(run: (pool: pg.Pool) => Promise<void>) {
  const name = `auth_migration_${randomUUID().replaceAll('-', '')}`;
  await owner.pool.query(`CREATE DATABASE ${name}`);
  const url = new URL(inject('ownerUrl'));
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
  try {
    for (const file of [
      '0000_init',
      '0001_worker_gate',
      '0002_worker_reliability',
      '0003_billing_number',
      '0004_billing_number_not_null',
    ]) {
      await pool.query(
        await readFile(
          new URL(`../migrations/${file}.sql`, import.meta.url),
          'utf8',
        ),
      );
    }
    await run(pool);
  } finally {
    await pool.end();
    await owner.pool.query(`DROP DATABASE ${name} WITH (FORCE)`);
  }
}

describe('legacy profile migration', () => {
  it('preserves profile IDs and references, normalizes email, creates no login credential', async () => {
    await legacyDatabase(async (pool) => {
      const profile = z
        .object({ id: z.uuid() })
        .parse(
          (
            await pool.query<{ id: string }>(
              "INSERT INTO admins(email,name) VALUES ('Legacy@Example.invalid','Legacy') RETURNING id",
            )
          ).rows[0],
        );
      const tenant = z
        .object({ id: z.uuid() })
        .parse(
          (
            await pool.query<{ id: string }>(
              "INSERT INTO tenants(code,name,currency,overdraft_limit) VALUES ('LEG001','Legacy tenant','CNY',0) RETURNING id",
            )
          ).rows[0],
        );
      const portal = z
        .object({ id: z.uuid() })
        .parse(
          (
            await pool.query<{ id: string }>(
              "INSERT INTO portal_accounts(email,tenant_id) VALUES ('Portal@Example.invalid',$1) RETURNING id",
              [tenant.id],
            )
          ).rows[0],
        );
      await pool.query('BEGIN');
      await pool.query("SELECT set_config('app.scope','admin',true)");
      await pool.query('SELECT lock_tenants(ARRAY[$1::uuid])', [tenant.id]);
      await pool.query(
        "INSERT INTO ledger_entries(tenant_id,kind,amount,created_by,idempotency_key) VALUES($1,'recharge',10,$2,'legacy:recharge')",
        [tenant.id, profile.id],
      );
      await pool.query('COMMIT');
      const ledgerSql =
        'SELECT id,tenant_id,created_by,amount,idempotency_key FROM ledger_entries';
      const beforeLedger = await pool.query<{
        id: string;
        tenant_id: string;
        created_by: string;
        amount: string;
        idempotency_key: string;
      }>(ledgerSql);
      await pool.query('BEGIN');
      await pool.query(
        await readFile(
          new URL('../migrations/0005_auth.sql', import.meta.url),
          'utf8',
        ),
      );
      await pool.query('COMMIT');
      expect(
        (
          await pool.query(
            'SELECT a.id,u.email FROM admins a JOIN auth."user" u ON u.id=a.auth_user_id',
          )
        ).rows,
      ).toEqual([{ id: profile.id, email: 'legacy@example.invalid' }]);
      expect(
        (
          await pool.query<{ id: string; tenant_id: string; email: string }>(
            'SELECT p.id,p.tenant_id,u.email FROM portal_accounts p JOIN auth."user" u ON u.id=p.auth_user_id',
          )
        ).rows,
      ).toEqual([
        {
          id: portal.id,
          tenant_id: tenant.id,
          email: 'portal@example.invalid',
        },
      ]);
      expect(beforeLedger.rows).toHaveLength(1);
      expect(beforeLedger.rows[0]).toMatchObject({
        tenant_id: tenant.id,
        created_by: profile.id,
        amount: '10',
      });
      expect(
        (
          await pool.query<{
            id: string;
            tenant_id: string;
            created_by: string;
            amount: string;
            idempotency_key: string;
          }>(ledgerSql)
        ).rows,
      ).toEqual(beforeLedger.rows);
      expect((await pool.query('SELECT FROM auth.account')).rowCount).toBe(0);
    });
  });

  it('normalized cross-table duplicate fails without partial structure', async () => {
    await legacyDatabase(async (pool) => {
      await pool.query(
        "INSERT INTO admins(email,name) VALUES ('Duplicate@Example.invalid','Legacy')",
      );
      const tenant = z
        .object({ id: z.uuid() })
        .parse(
          (
            await pool.query<{ id: string }>(
              "INSERT INTO tenants(code,name,currency,overdraft_limit) VALUES ('DUP001','Duplicate','CNY',0) RETURNING id",
            )
          ).rows[0],
        );
      await pool.query(
        'INSERT INTO portal_accounts(email,tenant_id) VALUES ($1,$2)',
        ['duplicate@example.invalid', tenant.id],
      );
      await pool.query('BEGIN');
      expect(
        (
          await pgError(
            pool.query(
              await readFile(
                new URL('../migrations/0005_auth.sql', import.meta.url),
                'utf8',
              ),
            ),
          )
        ).message,
      ).toContain('normalized profile email conflict');
      await pool.query('ROLLBACK');
      expect(
        (await pool.query("SELECT to_regnamespace('auth') AS schema")).rows,
      ).toEqual([{ schema: null }]);
      expect(
        (
          await pool.query(
            "SELECT column_name FROM information_schema.columns WHERE table_name='admins' AND column_name IN ('email','auth_user_id')",
          )
        ).rows,
      ).toEqual([{ column_name: 'email' }]);
    });
  });
});

it('auth migration ledger records the current SQL bytes and window id is required UUID', async () => {
  const sql = await readFile(
    new URL('../migrations/0005_auth.sql', import.meta.url),
    'utf8',
  );
  const hash = createHash('sha256').update(sql).digest('hex');
  const ledger = await owner.pool.query<{ hash: string }>(
    'SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at=$1',
    [1792281600000],
  );
  expect(ledger.rows).toEqual([{ hash }]);
  const column = await owner.pool.query(
    "SELECT data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='auth' AND table_name='login_failures' AND column_name='window_id'",
  );
  expect(column.rows).toEqual([
    { data_type: 'uuid', is_nullable: 'NO', column_default: null },
  ]);
  const email = `${randomUUID()}@example.invalid`;
  expect(
    (
      await pgError(
        auth.query(
          'INSERT INTO auth.login_failures(email_key,failed_count,last_failed_at) VALUES($1,1,now())',
          [email],
        ),
      )
    ).code,
  ).toBe('23502');
});
