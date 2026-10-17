import { readFile } from 'node:fs/promises';
import pg, { type Client as PgClient } from 'pg';
import { adminId, connections, pgError, tenantId } from '../test/support.js';
import { describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

const { app, owner } = connections();

const catalogRowSchema = z.object({
  name: z.string().regex(/^[a-z_][a-z0-9_]*$/),
  tenant_column: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/)
    .nullable(),
  key_columns: z.array(z.string().regex(/^[a-z_][a-z0-9_]*$/)),
  policy_names: z.array(z.string()),
  tenant_read_qual: z.string().nullable(),
  app_can_select: z.boolean(),
});

type CatalogRelation =
  | {
      kind: 'tenant-read';
      name: string;
      tenantColumn: string;
      keyColumns: string[];
      qual: string;
      appCanSelect: boolean;
    }
  | {
      kind: 'staff-only';
      name: string;
      tenantColumn: string | null;
      keyColumns: string[];
    }
  | {
      kind: 'admin-previews';
      name: string;
      tenantColumn: string | null;
      keyColumns: string[];
    };

type TenantReadRelation = Extract<CatalogRelation, { kind: 'tenant-read' }>;

type ScopeCase = {
  name: string;
  scope: string | null;
  tenantIdSetting: string | null;
  expected: 'none' | 'tenant-a' | 'tenant-b' | 'both' | 'legacy';
};

type QueryOutcome =
  { kind: 'rows'; rowKeys: string[] } | { kind: 'error'; code: string };

const identifiers = (values: string[]) =>
  values.map(quoteIdentifier).join(', ');

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value))
    throw new Error(`Unexpected catalog identifier: ${value}`);
  return `"${value}"`;
}

async function discoverRelations(client: PgClient): Promise<CatalogRelation[]> {
  const result = await client.query(`
    SELECT c.relname AS name,
      CASE
        WHEN EXISTS (
          SELECT FROM pg_attribute a
          WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
            AND a.attnum > 0 AND NOT a.attisdropped
        ) THEN 'tenant_id'
        WHEN c.relname = 'tenants' AND EXISTS (
          SELECT FROM pg_attribute a
          WHERE a.attrelid = c.oid AND a.attname = 'id'
            AND a.attnum > 0 AND NOT a.attisdropped
        ) THEN 'id'
        ELSE NULL
      END AS tenant_column,
      ARRAY(
        SELECT a.attname::text
        FROM pg_index i
        CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
        WHERE i.indrelid = c.oid AND i.indisprimary
          AND k.ordinality <= i.indnkeyatts
        ORDER BY k.ordinality
      ) AS key_columns,
      ARRAY(
        SELECT p.polname::text
        FROM pg_policy p
        WHERE p.polrelid = c.oid
        ORDER BY p.polname
      ) AS policy_names,
      (
        SELECT pg_get_expr(p.polqual, p.polrelid)
        FROM pg_policy p
        WHERE p.polrelid = c.oid AND p.polname = 'tenant_read'
      ) AS tenant_read_qual,
      has_table_privilege('fs_billing_app', c.oid, 'SELECT') AS app_can_select
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relrowsecurity
      AND NOT c.relispartition
      AND (
        EXISTS (
          SELECT FROM pg_attribute a
          WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
            AND a.attnum > 0 AND NOT a.attisdropped
        )
        OR (c.relname = 'tenants' AND EXISTS (
          SELECT FROM pg_attribute a
          WHERE a.attrelid = c.oid AND a.attname = 'id'
            AND a.attnum > 0 AND NOT a.attisdropped
        ))
        OR EXISTS (
          SELECT FROM pg_policy p
          WHERE p.polrelid = c.oid AND p.polname = 'staff_only'
        )
      )
    ORDER BY c.relname
  `);
  const rows = z.array(catalogRowSchema).parse(result.rows);

  return rows.map((row) => {
    const kinds = row.policy_names.filter((name) =>
      ['tenant_read', 'staff_only', 'admin_previews'].includes(name),
    );
    if (kinds.length !== 1)
      throw new Error(
        `${row.name} has unexpected policy classes: ${kinds.join(', ')}`,
      );
    const [kind] = kinds;
    if (kind === 'tenant_read') {
      if (!row.tenant_column || !row.tenant_read_qual)
        throw new Error(`${row.name} lacks a tenant key or tenant_read USING`);
      if (row.key_columns.length === 0)
        throw new Error(`${row.name} has no primary key for row comparison`);
      return {
        kind: 'tenant-read',
        name: row.name,
        tenantColumn: row.tenant_column,
        keyColumns: row.key_columns,
        qual: row.tenant_read_qual,
        appCanSelect: row.app_can_select,
      };
    }
    if (kind === 'staff_only')
      return {
        kind: 'staff-only',
        name: row.name,
        tenantColumn: row.tenant_column,
        keyColumns: row.key_columns,
      };
    if (kind === 'admin_previews')
      return {
        kind: 'admin-previews',
        name: row.name,
        tenantColumn: row.tenant_column,
        keyColumns: row.key_columns,
      };
    throw new Error(`Unexpected policy class: ${kind}`);
  });
}

async function readCdrLeaves(client: PgClient): Promise<string[]> {
  const result = await client.query(`
    SELECT c.relname AS name
    FROM pg_partition_tree('public.cdrs'::regclass) t
    JOIN pg_class c ON c.oid = t.relid
    WHERE t.isleaf
    ORDER BY c.relname
  `);
  return z
    .array(z.object({ name: z.string().regex(/^[a-z_][a-z0-9_]*$/) }))
    .parse(result.rows)
    .map((row) => row.name);
}

async function insertSupplementalFixturesWithAppScopeUnset(
  client: PgClient,
  tenantIds: [string, string],
  adminId: string,
): Promise<void> {
  try {
    const orderedTenantIds = [...tenantIds].sort();
    for (const tenantId of orderedTenantIds)
      await client.query(
        'SELECT pg_advisory_xact_lock(tenant_lock_key($1::uuid))',
        [tenantId],
      );
    await client.query("SELECT set_config('app.tenant_locks', $1, true)", [
      '{' + orderedTenantIds.join(',') + '}',
    ]);

    for (const tenantId of tenantIds) {
      const ledgerResult = await client.query(
        `INSERT INTO ledger_entries
           (tenant_id, kind, amount, note, created_by, idempotency_key)
         VALUES ($1, 'credit_recharge', 20, '', $2, $3),
           ($1, 'adjustment', -1, 'RLS fixture', $2, $4)
         RETURNING id, kind`,
        [
          tenantId,
          adminId,
          `pr1:${tenantId}:credit`,
          `pr1:${tenantId}:adjustment`,
        ],
      );
      const ledgerRows = z
        .array(
          z.object({
            id: z.string().uuid(),
            kind: z.enum(['credit_recharge', 'adjustment']),
          }),
        )
        .parse(ledgerResult.rows);
      const ledgerIds = new Map(ledgerRows.map((row) => [row.kind, row.id]));
      const creditId = ledgerIds.get('credit_recharge');
      const adjustmentId = ledgerIds.get('adjustment');
      if (!creditId || !adjustmentId)
        throw new Error(`Fixture ledger rows are incomplete for ${tenantId}`);

      const settlementResult = await client.query(
        `INSERT INTO receivable_settlements
           (tenant_id, ledger_entry_id, received_on, confirmed_by)
         VALUES ($1, $2, current_date, $3)
         RETURNING id`,
        [tenantId, creditId, adminId],
      );
      const settlement = z
        .object({ id: z.string().uuid() })
        .parse(settlementResult.rows[0]);
      await client.query(
        `INSERT INTO receivable_settlement_reversals
           (tenant_id, settlement_id, reason, reversed_by)
         VALUES ($1, $2, 'RLS fixture', $3)`,
        [tenantId, settlement.id, adminId],
      );
      await client.query(
        `INSERT INTO receivable_voids
           (tenant_id, ledger_entry_id, adjustment_ledger_entry_id, reason, voided_by)
         VALUES ($1, $2, $3, 'RLS fixture', $4)`,
        [tenantId, creditId, adjustmentId, adminId],
      );
      await client.query(
        `INSERT INTO monthly_statements
           (tenant_id, month, opening_balance, recharge, gift, adjustment,
            call_charges, closing_balance, call_minutes)
         VALUES ($1, date_trunc('month', current_date)::date, 0, 0, 0, 0, 0, 0, 0)
         ON CONFLICT (tenant_id, month) DO NOTHING`,
        [tenantId],
      );
      await client.query(
        `INSERT INTO balance_alert_deliveries (tenant_id, kind, balance, recipients)
         VALUES ($1, 'low_balance', 0, ARRAY['pr1@example.invalid'])`,
        [tenantId],
      );
    }
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function fixtureRows(
  client: PgClient,
  relation: TenantReadRelation,
  tenantIds: [string, string],
): Promise<Map<string, string[]>> {
  const tenantColumn = quoteIdentifier(relation.tenantColumn);
  const keys = identifiers(relation.keyColumns);
  const table = quoteIdentifier(relation.name);
  const result = await client.query(
    `SELECT ${tenantColumn} AS tenant_id,
        jsonb_build_array(${keys})::text AS row_key
     FROM public.${table}
     WHERE ${tenantColumn} = ANY($1::uuid[])
     ORDER BY ${tenantColumn}, ${keys}`,
    [tenantIds],
  );
  const rows = z
    .array(z.object({ tenant_id: z.string().uuid(), row_key: z.string() }))
    .parse(result.rows);
  const byTenant = new Map<string, string[]>();
  for (const row of rows) {
    const tenantRows = byTenant.get(row.tenant_id) ?? [];
    tenantRows.push(row.row_key);
    byTenant.set(row.tenant_id, tenantRows);
  }
  return byTenant;
}

function scopeCases(tenantAId: string, tenantBId: string): ScopeCase[] {
  const invalid = 'not-a-uuid';
  return [
    { name: 'unset', scope: null, tenantIdSetting: null, expected: 'none' },
    {
      name: 'tenant-id-only',
      scope: null,
      tenantIdSetting: tenantAId,
      expected: 'none',
    },
    {
      name: 'tenant-missing-id',
      scope: 'tenant',
      tenantIdSetting: null,
      expected: 'none',
    },
    {
      name: 'tenant-empty-id',
      scope: 'tenant',
      tenantIdSetting: '',
      expected: 'none',
    },
    {
      name: 'empty-scope',
      scope: '',
      tenantIdSetting: tenantAId,
      expected: 'none',
    },
    {
      name: 'unknown-scope',
      scope: 'unknown',
      tenantIdSetting: tenantAId,
      expected: 'none',
    },
    {
      name: 'tenant-a',
      scope: 'tenant',
      tenantIdSetting: tenantAId,
      expected: 'tenant-a',
    },
    {
      name: 'tenant-b',
      scope: 'tenant',
      tenantIdSetting: tenantBId,
      expected: 'tenant-b',
    },
    { name: 'admin', scope: 'admin', tenantIdSetting: null, expected: 'both' },
    {
      name: 'system',
      scope: 'system',
      tenantIdSetting: null,
      expected: 'both',
    },
    {
      name: 'invalid-without-scope',
      scope: null,
      tenantIdSetting: invalid,
      expected: 'legacy',
    },
    {
      name: 'invalid-tenant',
      scope: 'tenant',
      tenantIdSetting: invalid,
      expected: 'legacy',
    },
    {
      name: 'invalid-admin',
      scope: 'admin',
      tenantIdSetting: invalid,
      expected: 'legacy',
    },
    {
      name: 'invalid-system',
      scope: 'system',
      tenantIdSetting: invalid,
      expected: 'legacy',
    },
    {
      name: 'invalid-unknown-scope',
      scope: 'unknown',
      tenantIdSetting: invalid,
      expected: 'legacy',
    },
    {
      name: 'invalid-empty-scope',
      scope: '',
      tenantIdSetting: invalid,
      expected: 'legacy',
    },
  ];
}

async function setScope(client: PgClient, scopeCase: ScopeCase): Promise<void> {
  if (scopeCase.scope !== null)
    await client.query("SELECT set_config('app.scope', $1, true)", [
      scopeCase.scope,
    ]);
  if (scopeCase.tenantIdSetting !== null)
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [
      scopeCase.tenantIdSetting,
    ]);
}

async function readKeys(
  client: PgClient,
  relation: TenantReadRelation,
  tenantIds: [string, string],
  useLegacyPredicate: boolean,
): Promise<QueryOutcome> {
  const tenantColumn = quoteIdentifier(relation.tenantColumn);
  const keys = identifiers(relation.keyColumns);
  const table = quoteIdentifier(relation.name);
  const legacyFilter = useLegacyPredicate
    ? `AND app_can_see(${tenantColumn}) IS TRUE`
    : '';
  await client.query('SAVEPOINT row_visibility');
  try {
    const result = await client.query(
      `SELECT jsonb_build_array(${keys})::text AS row_key
       FROM public.${table}
       WHERE ${tenantColumn} = ANY($1::uuid[]) ${legacyFilter}`,
      [tenantIds],
    );
    const rowKeys = z
      .array(z.object({ row_key: z.string() }))
      .parse(result.rows)
      .map((row) => row.row_key)
      .sort();
    await client.query('RELEASE SAVEPOINT row_visibility');
    return { kind: 'rows', rowKeys };
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT row_visibility');
    await client.query('RELEASE SAVEPOINT row_visibility');
    const parsed = z.object({ code: z.string() }).safeParse(error);
    if (parsed.success) return { kind: 'error', code: parsed.data.code };
    throw error;
  }
}

function expectedRows(
  expected: ScopeCase['expected'],
  rowsA: string[],
  rowsB: string[],
): QueryOutcome | null {
  if (expected === 'legacy') return null;
  if (expected === 'none') return { kind: 'rows', rowKeys: [] };
  if (expected === 'tenant-a')
    return { kind: 'rows', rowKeys: [...rowsA].sort() };
  if (expected === 'tenant-b')
    return { kind: 'rows', rowKeys: [...rowsB].sort() };
  return { kind: 'rows', rowKeys: [...rowsA, ...rowsB].sort() };
}

async function backendPid(client: PgClient): Promise<number> {
  const result = await client.query('SELECT pg_backend_pid() AS pid');
  return z.object({ pid: z.number() }).parse(result.rows[0]).pid;
}

async function freshOwnerConnection(): Promise<PgClient> {
  const client = new pg.Client({ connectionString: inject('ownerUrl') });
  await client.connect();
  return client;
}

async function assertAppRole(client: PgClient): Promise<void> {
  const result = await client.query(
    'SELECT r.rolname AS name, r.rolsuper, r.rolbypassrls ' +
      'FROM pg_roles r WHERE r.rolname = current_user',
  );
  const role = z
    .object({
      name: z.literal('fs_billing_app'),
      rolsuper: z.literal(false),
      rolbypassrls: z.literal(false),
    })
    .parse(result.rows[0]);
  expect(role).toEqual({
    name: 'fs_billing_app',
    rolsuper: false,
    rolbypassrls: false,
  });
}

async function expectInitPlans(
  client: PgClient,
  tenantId: string,
): Promise<void> {
  await client.query('SAVEPOINT plan_probe');
  try {
    await setScope(client, {
      name: 'tenant-a',
      scope: 'tenant',
      tenantIdSetting: tenantId,
      expected: 'tenant-a',
    });
    await client.query('SET LOCAL ROLE fs_billing_app');
    await assertAppRole(client);
    const result = await client.query(
      'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' +
        'SELECT call_uuid FROM public.cdrs ' +
        'WHERE tenant_id = $1::uuid LIMIT 1',
      [tenantId],
    );
    const explainRows = z
      .array(z.object({ 'QUERY PLAN': z.unknown() }))
      .parse(result.rows);
    const document = z
      .array(z.object({ Plan: z.unknown() }))
      .parse(explainRows[0]?.['QUERY PLAN']);
    const planNodeSchema = z
      .object({
        Plans: z.array(z.unknown()).optional(),
        'Parent Relationship': z.string().optional(),
        'Subplan Name': z.string().optional(),
        'Actual Loops': z.number().optional(),
        'Actual Rows': z.number().optional(),
      })
      .passthrough();
    const planNodes: z.infer<typeof planNodeSchema>[] = [];
    const visitPlan = (raw: unknown): void => {
      const node = planNodeSchema.parse(raw);
      planNodes.push(node);
      for (const child of node.Plans ?? []) visitPlan(child);
    };
    const rootPlan = document[0]?.Plan;
    if (!rootPlan) throw new Error('EXPLAIN returned no plan');
    visitPlan(rootPlan);
    const initPlans = planNodes.filter(
      (node) =>
        node['Parent Relationship'] === 'InitPlan' ||
        node['Subplan Name']?.startsWith('InitPlan'),
    );
    expect(initPlans.length).toBeGreaterThanOrEqual(3);
    expect(initPlans.every((node) => node['Actual Loops'] === 1)).toBe(true);
    expect(planNodes.some((node) => (node['Actual Rows'] ?? 0) > 0)).toBe(true);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT plan_probe');
    await client.query('RELEASE SAVEPOINT plan_probe');
  }
}

async function expectCdrLeavesDenied(client: PgClient): Promise<void> {
  const leaves = await readCdrLeaves(client);
  expect(leaves.length).toBeGreaterThan(0);
  for (const leaf of leaves) {
    const relationName = 'public.' + quoteIdentifier(leaf);
    const privilege = await client.query(
      'SELECT has_table_privilege($1, $2::regclass, $3) AS allowed',
      ['fs_billing_app', relationName, 'SELECT'],
    );
    expect(
      z.object({ allowed: z.boolean() }).parse(privilege.rows[0]).allowed,
      leaf,
    ).toBe(false);
  }

  await client.query('SAVEPOINT cdr_leaf_access');
  try {
    await client.query('SET LOCAL ROLE fs_billing_app');
    await assertAppRole(client);
    for (const leaf of leaves) {
      const relationName = 'public.' + quoteIdentifier(leaf);
      await client.query('SAVEPOINT leaf_select');
      const error = await pgError(
        client.query('SELECT * FROM ' + relationName + ' LIMIT 0'),
      );
      await client.query('ROLLBACK TO SAVEPOINT leaf_select');
      await client.query('RELEASE SAVEPOINT leaf_select');
      expect(error.code, leaf).toBe('42501');
    }
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT cdr_leaf_access');
    await client.query('RELEASE SAVEPOINT cdr_leaf_access');
  }
}

describe('RLS InitPlan tenant_read', () => {
  it('preserves tenant visibility and plans helper reads as InitPlans', async () => {
    const tenantAId = await tenantId(app, 'ABC001');
    const tenantBId = await tenantId(app, 'GZT007');
    const tenantIds: [string, string] = [tenantAId, tenantBId];
    const actorId = await adminId(owner);
    let tenantReads: TenantReadRelation[] | undefined;

    for (const [index, scopeCase] of scopeCases(
      tenantAId,
      tenantBId,
    ).entries()) {
      const client = await freshOwnerConnection();
      try {
        await client.query('BEGIN');
        try {
          await insertSupplementalFixturesWithAppScopeUnset(
            client,
            tenantIds,
            actorId,
          );
          if (index === 0) {
            const catalogRelations = await discoverRelations(client);
            tenantReads = catalogRelations.filter(
              (relation): relation is TenantReadRelation =>
                relation.kind === 'tenant-read',
            );
            const adminPreviewTables = catalogRelations
              .filter((relation) => relation.kind === 'admin-previews')
              .map((relation) => relation.name)
              .sort();
            expect(tenantReads).toHaveLength(13);
            expect(adminPreviewTables).toEqual(['admin_rate_previews']);
            expect(tenantReads.every((relation) => relation.appCanSelect)).toBe(
              true,
            );

            const migration = await readFile(
              new URL('../migrations/0015_rls_initplan.sql', import.meta.url),
              'utf8',
            );
            const targets = Array.from(
              migration.matchAll(
                /ALTER\s+POLICY\s+tenant_read\s+ON\s+([a-z_][a-z0-9_]*)\s+USING/gi,
              ),
              (match) =>
                z
                  .string()
                  .regex(/^[a-z_][a-z0-9_]*$/)
                  .parse(match[1]),
            );
            expect(targets).toHaveLength(13);
            expect(new Set(targets).size).toBe(13);
            expect([...targets].sort()).toEqual(
              tenantReads.map((relation) => relation.name).sort(),
            );
            expect(
              tenantReads.find((relation) => relation.name === 'tenants')
                ?.tenantColumn,
            ).toBe('id');
            expect(
              tenantReads
                .filter((relation) => relation.name !== 'tenants')
                .every((relation) => relation.tenantColumn === 'tenant_id'),
            ).toBe(true);
            for (const relation of tenantReads) {
              expect(relation.qual, relation.name).toMatch(
                /\(\s*SELECT\s+app_is_operator\(\)/i,
              );
              expect(relation.qual, relation.name).toMatch(
                /\(\s*SELECT\s+app_scope\(\)/i,
              );
              expect(relation.qual, relation.name).toMatch(
                new RegExp(
                  relation.tenantColumn +
                    '\\s*=\\s*\\(\\s*SELECT\\s+app_tenant_id\\(',
                  'i',
                ),
              );
              expect(relation.qual, relation.name).not.toContain(
                'app_can_see(',
              );
            }
          }
          if (!tenantReads) throw new Error('Catalog inventory was not loaded');

          const rowsByRelation = new Map<string, Map<string, string[]>>();
          for (const relation of tenantReads) {
            const rows = await fixtureRows(client, relation, tenantIds);
            const rowsA = rows.get(tenantAId) ?? [];
            const rowsB = rows.get(tenantBId) ?? [];
            expect(
              rowsA.length,
              relation.name + ' tenant A fixture',
            ).toBeGreaterThan(0);
            expect(
              rowsB.length,
              relation.name + ' tenant B fixture',
            ).toBeGreaterThan(0);
            rowsByRelation.set(relation.name, rows);
          }

          await setScope(client, scopeCase);
          const settings = z
            .object({
              scope: z.string().nullable(),
              tenant_id: z.string().nullable(),
            })
            .parse(
              (
                await client.query(
                  "SELECT current_setting('app.scope', true) AS scope, " +
                    "current_setting('app.tenant_id', true) AS tenant_id",
                )
              ).rows[0],
            );
          expect(settings, scopeCase.name).toEqual({
            scope: scopeCase.scope,
            tenant_id: scopeCase.tenantIdSetting,
          });

          const pid = await backendPid(client);
          let roleChecked = false;
          for (const relation of tenantReads) {
            const oracle = await readKeys(client, relation, tenantIds, true);
            await client.query('SET LOCAL ROLE fs_billing_app');
            if (!roleChecked) {
              await assertAppRole(client);
              roleChecked = true;
            }
            const actual = await readKeys(client, relation, tenantIds, false);
            await client.query('RESET ROLE');
            expect(await backendPid(client), scopeCase.name).toBe(pid);
            expect(actual, relation.name + ' / ' + scopeCase.name).toEqual(
              oracle,
            );

            const rowsByTenant = rowsByRelation.get(relation.name);
            const rowsA = rowsByTenant?.get(tenantAId);
            const rowsB = rowsByTenant?.get(tenantBId);
            if (!rowsA || !rowsB)
              throw new Error('Missing fixture keys for ' + relation.name);
            const expected = expectedRows(scopeCase.expected, rowsA, rowsB);
            if (expected)
              expect(actual, relation.name + ' / ' + scopeCase.name).toEqual(
                expected,
              );
          }

          if (index === 0) {
            await expectInitPlans(client, tenantAId);
            await expectCdrLeavesDenied(client);
          }
        } finally {
          await client.query('ROLLBACK');
        }
      } finally {
        await client.end();
      }
    }

    if (!tenantReads) throw new Error('Tenant policy inventory was not loaded');

    const cdrs = tenantReads.find((relation) => relation.name === 'cdrs');
    if (!cdrs)
      throw new Error('The cdrs tenant_read policy was not discovered');
    const ownerClient = await owner.pool.connect();
    const appClient = await app.pool.connect();
    try {
      const appPid = await backendPid(appClient);
      for (const scopeCase of [
        {
          name: 'pool-tenant-a',
          scope: 'tenant',
          tenantIdSetting: tenantAId,
          expected: 'tenant-a',
        },
        {
          name: 'pool-tenant-b',
          scope: 'tenant',
          tenantIdSetting: tenantBId,
          expected: 'tenant-b',
        },
        {
          name: 'pool-system',
          scope: 'system',
          tenantIdSetting: '',
          expected: 'both',
        },
        {
          name: 'pool-unknown',
          scope: 'unknown',
          tenantIdSetting: tenantAId,
          expected: 'none',
        },
        {
          name: 'pool-empty',
          scope: '',
          tenantIdSetting: tenantBId,
          expected: 'none',
        },
        {
          name: 'pool-tenant-a-again',
          scope: 'tenant',
          tenantIdSetting: tenantAId,
          expected: 'tenant-a',
        },
      ] satisfies ScopeCase[]) {
        await ownerClient.query('BEGIN');
        try {
          await appClient.query('BEGIN');
          try {
            await setScope(ownerClient, scopeCase);
            await setScope(appClient, scopeCase);
            const oracle = await readKeys(ownerClient, cdrs, tenantIds, true);
            const actual = await readKeys(appClient, cdrs, tenantIds, false);
            expect(await backendPid(appClient), scopeCase.name).toBe(appPid);
            expect(actual, scopeCase.name).toEqual(oracle);
            const seededRows = await fixtureRows(ownerClient, cdrs, tenantIds);
            const rowsA = seededRows.get(tenantAId) ?? [];
            const rowsB = seededRows.get(tenantBId) ?? [];
            expect(rowsA.length).toBeGreaterThan(0);
            expect(rowsB.length).toBeGreaterThan(0);
            const expected = expectedRows(scopeCase.expected, rowsA, rowsB);
            if (expected) expect(actual, scopeCase.name).toEqual(expected);
          } finally {
            await appClient.query('ROLLBACK');
          }
        } finally {
          await ownerClient.query('ROLLBACK');
        }
      }
    } finally {
      ownerClient.release();
      appClient.release();
    }
  });
});
