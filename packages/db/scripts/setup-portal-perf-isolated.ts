import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { z } from 'zod';
import { connect, databaseEnvironmentSchema } from '../src/client.js';
import { ensureCdrPartitions } from '../src/partitions.js';
import { seedDatabase } from '../src/seed.js';

const TARGET_DATABASE = 'fs_billing_perf_pr3_uuid_v4';
const SOURCE_DATABASE = 'fs_billing_perf';
const OWNER_ROLE = 'fs_billing';
const APP_ROLE = 'fs_billing_app';
const AUTH_ROLE = 'fs_billing_auth';
const AUDIT_ROLE = 'fs_billing_audit';
const IDENTITY_ROLE = 'fs_billing_identity';
const PERF_AS_OF = '2026-10-17T04:00:00Z';
const PERF_TENANTS = [
  ['00000000-0000-4000-8000-000000000001', 'PORTALBIG', 3_000_000],
  ['00000000-0000-4000-8000-000000000002', 'PORTALS1', 30_000],
  ['00000000-0000-4000-8000-000000000003', 'PORTALS2', 30_000],
  ['00000000-0000-4000-8000-000000000004', 'PORTALS3', 30_000],
  ['00000000-0000-4000-8000-000000000005', 'EXPORT50K', 50_000],
  ['00000000-0000-4000-8000-000000000006', 'EXPORT100K', 100_000],
  ['00000000-0000-4000-8000-000000000007', 'EXPORT200K', 200_000],
] as const;
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const migrationsFolder = fileURLToPath(
  new URL('../migrations', import.meta.url),
);
const evidencePath = fileURLToPath(
  new URL(
    '../../../docs/evidence/phase-6/isolated-db-provenance.json',
    import.meta.url,
  ),
);
const progressPath = fileURLToPath(
  new URL(
    '../../../docs/evidence/phase-6/isolated-db-setup-progress.json',
    import.meta.url,
  ),
);
const recoveryAttestationPath = fileURLToPath(
  new URL(
    '../../../docs/evidence/phase-6/isolated-db-create-recovery-attestation.json',
    import.meta.url,
  ),
);
const migrationJournalSchema = z.object({
  entries: z.array(z.object({ tag: z.string() })),
});
const environment = databaseEnvironmentSchema.parse(process.env);

async function expectedMigrationHashes() {
  const journal = await readFile(
    fileURLToPath(new URL('../migrations/meta/_journal.json', import.meta.url)),
  );
  const parsed = migrationJournalSchema.parse(
    JSON.parse(journal.toString('utf8')),
  );
  const hashes: string[] = [];
  for (const entry of parsed.entries) {
    const migration = await readFile(
      fileURLToPath(new URL(`../migrations/${entry.tag}.sql`, import.meta.url)),
    );
    hashes.push(createHash('sha256').update(migration).digest('hex'));
  }
  return {
    journalSha256: createHash('sha256').update(journal).digest('hex'),
    hashes,
  };
}

function databaseUrl(source: string, database: string): string {
  const url = new URL(source);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert(
    [`/${SOURCE_DATABASE}`, '/fs_billing'].includes(url.pathname),
    'database credentials must come from the configured local billing endpoint',
  );
  url.pathname = `/${database}`;
  return url.toString();
}

const ownerUrl = databaseUrl(environment.DATABASE_URL, TARGET_DATABASE);
const appUrl = databaseUrl(environment.APP_DATABASE_URL, TARGET_DATABASE);
const authUrl = databaseUrl(environment.AUTH_DATABASE_URL!, TARGET_DATABASE);
const maintenanceUrl = new URL(ownerUrl);
maintenanceUrl.pathname = '/postgres';

function localDiskAvailableBytes(): number {
  const output = execFileSync('df', ['-Pk', '/private/tmp'], {
    encoding: 'utf8',
  });
  const row = output.trim().split('\n').at(-1)?.trim().split(/\s+/);
  assert(row && row.length >= 4, 'could not parse local disk free space');
  const availableKiB = Number(row[3]);
  assert(Number.isSafeInteger(availableKiB) && availableKiB > 0);
  return availableKiB * 1024;
}

function postgresVolumeAvailableBytes(dataDirectory: string): number {
  const mountsText = execFileSync(
    'docker',
    ['inspect', '--format', '{{json .Mounts}}', 'fs-billing-postgres-1'],
    { encoding: 'utf8' },
  );
  const mounts = z
    .array(
      z.object({
        Type: z.string(),
        Name: z.string().optional(),
        Destination: z.string(),
      }),
    )
    .parse(JSON.parse(mountsText));
  const mount = mounts.find(
    (candidate) => candidate.Destination === dataDirectory,
  );
  assert.equal(mount?.Type, 'volume');
  assert.equal(mount?.Name, 'fs-billing_postgres_data');
  const output = execFileSync(
    'docker',
    ['exec', 'fs-billing-postgres-1', 'df', '-Pk', dataDirectory],
    { encoding: 'utf8' },
  );
  const row = output.trim().split('\n').at(-1)?.trim().split(/\s+/);
  assert(
    row && row.length >= 4,
    'could not parse PostgreSQL volume free space',
  );
  const availableKiB = Number(row[3]);
  assert(Number.isSafeInteger(availableKiB) && availableKiB > 0);
  return availableKiB * 1024;
}

async function verifyExistingCredentialsAndRoles() {
  const urls = [
    ['owner', environment.DATABASE_URL, OWNER_ROLE],
    ['app', environment.APP_DATABASE_URL, APP_ROLE],
    ['auth', environment.AUTH_DATABASE_URL!, AUTH_ROLE],
  ] as const;
  const connections = await Promise.all(
    urls.map(async ([label, url, expectedRole]) => {
      const client = new pg.Client({
        connectionString: databaseUrl(url, SOURCE_DATABASE),
        connectionTimeoutMillis: 2_000,
      });
      await client.connect();
      try {
        const result = await client.query<{
          database: string;
          role: string;
          createdb: boolean;
        }>(`select current_database() as database, current_user as role,
          (select rolcreatedb from pg_roles where rolname=current_user) as createdb`);
        const identity = result.rows[0];
        assert(identity);
        assert.equal(identity.database, SOURCE_DATABASE);
        assert.equal(identity.role, expectedRole);
        if (label === 'owner') assert.equal(identity.createdb, true);
        return { label, database: identity.database, role: identity.role };
      } finally {
        await client.end();
      }
    }),
  );

  const owner = new pg.Client({
    connectionString: databaseUrl(environment.DATABASE_URL, SOURCE_DATABASE),
    connectionTimeoutMillis: 2_000,
  });
  await owner.connect();
  try {
    const result = await owner.query<{ rolname: string; rolcreatedb: boolean }>(
      `select rolname, rolcreatedb from pg_roles
       where rolname=any($1::text[]) order by rolname`,
      [[OWNER_ROLE, APP_ROLE, AUTH_ROLE, AUDIT_ROLE, IDENTITY_ROLE]],
    );
    assert.deepEqual(
      result.rows.map((row) => row.rolname),
      [APP_ROLE, AUDIT_ROLE, AUTH_ROLE, IDENTITY_ROLE, OWNER_ROLE].sort(),
      'required owner/app/auth/identity/audit roles are not all present',
    );
    assert.equal(
      result.rows.find((row) => row.rolname === OWNER_ROLE)?.rolcreatedb,
      true,
      'fs_billing must retain CREATEDB for the isolated fixture database',
    );
  } finally {
    await owner.end();
  }
  return connections;
}

async function storagePreflight() {
  const maintenance = new pg.Client({
    connectionString: maintenanceUrl.toString(),
    connectionTimeoutMillis: 2_000,
  });
  await maintenance.connect();
  let dataDirectory: string;
  let sourceDatabaseBytes: number;
  let snapshotDatabaseBytes: number;
  try {
    const result = await maintenance.query<{
      data_directory: string;
      source_bytes: string;
      snapshot_bytes: string;
      target_exists: boolean;
    }>(
      `select current_setting('data_directory') as data_directory,
       pg_database_size($1)::text as source_bytes,
       pg_database_size($2)::text as snapshot_bytes,
       exists(select 1 from pg_database where datname=$3) as target_exists`,
      [
        SOURCE_DATABASE,
        'fs_billing_perf_uuidfix_snapshot_57ac698a76da',
        TARGET_DATABASE,
      ],
    );
    const row = result.rows[0];
    assert(row);
    assert.equal(row.target_exists, false, `${TARGET_DATABASE} already exists`);
    dataDirectory = row.data_directory;
    sourceDatabaseBytes = Number(row.source_bytes);
    snapshotDatabaseBytes = Number(row.snapshot_bytes);
    assert(
      Number.isSafeInteger(sourceDatabaseBytes) && sourceDatabaseBytes > 0,
    );
    assert(
      Number.isSafeInteger(snapshotDatabaseBytes) && snapshotDatabaseBytes > 0,
    );
  } finally {
    await maintenance.end();
  }
  const availableBytes = postgresVolumeAvailableBytes(dataDirectory!);
  const requiredBytes = Math.max(
    4 * sourceDatabaseBytes!,
    3 * (sourceDatabaseBytes! + snapshotDatabaseBytes!) + 2 * 1024 ** 3,
  );
  assert(
    availableBytes > requiredBytes,
    'PostgreSQL data volume lacks the conservative isolated-fixture space margin',
  );
  return {
    dataDirectory: dataDirectory!,
    sourceDatabaseBytes: sourceDatabaseBytes!,
    snapshotDatabaseBytes: snapshotDatabaseBytes!,
    availableBytes,
    requiredBytes,
  };
}

async function preflight() {
  const credentials = await verifyExistingCredentialsAndRoles();
  const storage = await storagePreflight();
  return {
    mode: 'preflight',
    sourceDatabase: SOURCE_DATABASE,
    targetDatabase: TARGET_DATABASE,
    ownerRole: OWNER_ROLE,
    roleConnections: credentials,
    requiredRolesPresent: [
      OWNER_ROLE,
      APP_ROLE,
      AUTH_ROLE,
      IDENTITY_ROLE,
      AUDIT_ROLE,
    ],
    createdbAvailable: true,
    targetAbsent: true,
    availableLocalDiskBytes: localDiskAvailableBytes(),
    postgresDataDirectory: storage.dataDirectory,
    sourceDatabaseBytes: storage.sourceDatabaseBytes,
    snapshotDatabaseBytes: storage.snapshotDatabaseBytes,
    postgresDataVolumeAvailableBytes: storage.availableBytes,
    conservativeRequiredDataVolumeBytes: storage.requiredBytes,
    asOf: PERF_AS_OF,
    fixtures: PERF_TENANTS.map(([id, code, cdrs]) => ({ id, code, cdrs })),
  };
}

function perfSeedEnvironment() {
  return {
    ...process.env,
    PERF_TARGET_DATABASE: TARGET_DATABASE,
    PERF_DATABASE_URL: ownerUrl,
    PERF_APP_DATABASE_URL: appUrl,
    PERF_AUTH_DATABASE_URL: authUrl,
    PERF_AS_OF,
  };
}

async function runPerfFixtureSeed(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'pnpm',
      ['--dir', 'packages/db', 'exec', 'tsx', 'scripts/portal-perf.ts', 'seed'],
      { cwd: repoRoot, env: perfSeedEnvironment(), stdio: 'inherit' },
    );
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`portal-perf seed exited code=${code} signal=${signal}`),
        );
    });
  });
}

async function existingTargetPreSeedFacts() {
  const verify = new pg.Client({
    connectionString: ownerUrl,
    connectionTimeoutMillis: 2_000,
  });
  await verify.connect();
  try {
    const identity = await verify.query<{
      database: string;
      role: string;
      oid: number;
      database_owner: string;
      version: string;
      tenant_count: string;
      admin_rows: string;
      migrations: string;
    }>(
      `select current_database() as database, current_user as role, version(),
       (select oid from pg_database where datname=current_database())::int as oid,
       (select pg_get_userbyid(datdba) from pg_database where datname=current_database()) as database_owner,
       (select count(*)::text from public.tenants) as tenant_count,
       (select coalesce(json_agg(json_build_object('id',a.id::text,'auth_user_id',u.id::text,'email',u.email,'name',a.name) order by u.email),'[]'::json)::text
         from public.admins a join auth."user" u on u.id=a.auth_user_id) as admin_rows,
       (select coalesce(json_agg(json_build_object('hash',hash,'created_at',created_at::text) order by id),'[]'::json)::text from drizzle.__drizzle_migrations) as migrations`,
    );
    const db = identity.rows[0];
    assert(db);
    assert.equal(db.database, TARGET_DATABASE);
    assert.equal(db.role, OWNER_ROLE);
    assert.equal(db.database_owner, OWNER_ROLE);
    const adminRows = JSON.parse(db.admin_rows) as Array<{
      id: string;
      auth_user_id: string;
      email: string;
      name: string;
    }>;
    const migrations = JSON.parse(db.migrations) as Array<{
      hash: string;
      created_at: string;
    }>;
    assert(Number(db.tenant_count) > 0, 'baseline tenants are absent');
    assert.deepEqual(
      adminRows
        .map(({ auth_user_id, email, name }) => [auth_user_id, email, name])
        .sort((left, right) => left[0]!.localeCompare(right[0]!)),
      [
        ['seed:admin:li', 'lijun@example.com', '李俊'],
        ['seed:admin:wang', 'wangmin@example.com', '王敏'],
      ],
      'baseline admin identities differ from seed.ts',
    );
    const expectedMigrations = await expectedMigrationHashes();
    assert.deepEqual(
      migrations.map(({ hash }) => hash),
      expectedMigrations.hashes,
      'applied migration SQL hashes do not exactly match the repository journal',
    );
    const fixtureState = await verify.query<{
      tenant_rows: string;
      cdr_rows: string;
      registry_rows: string;
      ledger_rows: string;
    }>(
      `select
       (select count(*)::text from public.tenants where id=any($1::uuid[]) or code=any($2::text[])) as tenant_rows,
       (select count(*)::text from public.cdrs where tenant_id=any($1::uuid[])) as cdr_rows,
       (select count(*)::text from public.call_uuids where tenant_id=any($1::uuid[])) as registry_rows,
       (select count(*)::text from public.ledger_entries where tenant_id=any($1::uuid[])) as ledger_rows`,
      [PERF_TENANTS.map(([id]) => id), PERF_TENANTS.map(([, code]) => code)],
    );
    assert.deepEqual(
      fixtureState.rows[0],
      {
        tenant_rows: '0',
        cdr_rows: '0',
        registry_rows: '0',
        ledger_rows: '0',
      },
      'refusing finish because some performance fixture rows already exist',
    );
    const roles = await verify.query<{ rolname: string }>(
      `select rolname from pg_roles where rolname=any($1::text[]) order by rolname`,
      [[OWNER_ROLE, APP_ROLE, AUTH_ROLE, IDENTITY_ROLE, AUDIT_ROLE]],
    );
    assert.deepEqual(
      roles.rows.map((row) => row.rolname),
      [OWNER_ROLE, APP_ROLE, AUTH_ROLE, IDENTITY_ROLE, AUDIT_ROLE].sort(),
    );
    return {
      databaseOid: db.oid,
      owner: db.database_owner,
      postgresVersion: db.version,
      baselineTenantCount: Number(db.tenant_count),
      baselineAdminRows: adminRows,
      migrations,
      migrationJournalSha256: expectedMigrations.journalSha256,
      fixtureState: fixtureState.rows[0],
      roles: roles.rows.map((row) => row.rolname),
    };
  } finally {
    await verify.end();
  }
}

async function finishExistingTarget(): Promise<void> {
  const roleConnections = await verifyExistingCredentialsAndRoles();
  const facts = await existingTargetPreSeedFacts();
  const runId = 'isolated-db-setup-runner-recovery-20261019';
  await writeFile(
    recoveryAttestationPath,
    `${JSON.stringify(
      {
        type: 'recovery-attestation',
        originalCommand:
          'node --env-file=../../.env --import tsx scripts/setup-portal-perf-isolated.ts create (cwd packages/db)',
        originalExecSessionId: 45394,
        observedOuterExitCode: 1,
        failureStage:
          'portal-perf child command startup, after baseline migration and seed',
        observedError:
          'ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL: Command "tsx" not found from repository root',
        originalRawToolOutputPersisted: false,
        originalOsPidCaptured: false,
        databaseOidAtRecovery: facts.databaseOid,
        verifiedOwnerAtRecovery: facts.owner,
        verifiedAppliedMigrationHashes: facts.migrations.map(
          ({ hash }) => hash,
        ),
        verifiedBaselineAdminRows: facts.baselineAdminRows,
        verifiedPerfFixtureRowsBeforeRetry: facts.fixtureState,
      },
      null,
      2,
    )}\n`,
    { flag: 'wx' },
  );
  const progress = {
    runId,
    status: 'ready-to-seed',
    sourceDatabase: SOURCE_DATABASE,
    targetDatabase: TARGET_DATABASE,
    recoveryMode:
      'finish-only-after-new-target-baseline-and-empty-fixture-verification',
    recoveryAttestationPath,
    originalExecSessionId: 45394,
    originalOsPidCaptured: false,
    databaseOid: facts.databaseOid,
    owner: facts.owner,
    roleConnections,
    baselineTenantCount: facts.baselineTenantCount,
    baselineAdminRows: facts.baselineAdminRows,
    appliedMigrations: facts.migrations,
    requiredRoles: facts.roles,
    fixtureRowsBeforeSeed: facts.fixtureState,
    asOf: PERF_AS_OF,
  };
  await writeFile(progressPath, `${JSON.stringify(progress, null, 2)}\n`, {
    flag: 'wx',
  });
  await runPerfFixtureSeed();
  const fixtureCounts = await verifyFixtureCounts();
  const setupSource = await readFile(fileURLToPath(import.meta.url));
  const portalSeedSource = await readFile(
    fileURLToPath(new URL('./portal-perf.ts', import.meta.url)),
  );
  const journal = await readFile(
    fileURLToPath(new URL('../migrations/meta/_journal.json', import.meta.url)),
  );
  const provenance = {
    completedAt: new Date().toISOString(),
    sourceDatabase: SOURCE_DATABASE,
    targetDatabase: TARGET_DATABASE,
    ownerRole: OWNER_ROLE,
    appRole: APP_ROLE,
    authRole: AUTH_ROLE,
    identityRole: IDENTITY_ROLE,
    auditRole: AUDIT_ROLE,
    postgresVersion: facts.postgresVersion,
    databaseOid: facts.databaseOid,
    asOf: PERF_AS_OF,
    migrationCount: facts.migrations.length,
    appliedMigrations: facts.migrations,
    migrationJournalSha256: createHash('sha256').update(journal).digest('hex'),
    setupSourceSha256: createHash('sha256').update(setupSource).digest('hex'),
    portalPerfSourceSha256: createHash('sha256')
      .update(portalSeedSource)
      .digest('hex'),
    roleConnections,
    baselineAdminRows: facts.baselineAdminRows,
    fixtureCounts,
    newSetupPermanentWritesToSource: false,
    newSetupPermanentWritesToSnapshot: false,
    priorRunnerRecoveryAttestation: recoveryAttestationPath,
  };
  await writeFile(evidencePath, `${JSON.stringify(provenance, null, 2)}\n`, {
    flag: 'wx',
  });
  await writeFile(
    progressPath,
    `${JSON.stringify({ ...progress, status: 'complete', provenance }, null, 2)}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({ event: 'isolated_fixture_ready', ...provenance })}\n`,
  );
}

async function finishPreflight(): Promise<void> {
  const roleConnections = await verifyExistingCredentialsAndRoles();
  const facts = await existingTargetPreSeedFacts();
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: 'finish-preflight',
        sourceDatabase: SOURCE_DATABASE,
        targetDatabase: TARGET_DATABASE,
        databaseOid: facts.databaseOid,
        owner: facts.owner,
        roleConnections,
        baselineTenantCount: facts.baselineTenantCount,
        baselineAdminRows: facts.baselineAdminRows,
        appliedMigrations: facts.migrations,
        migrationJournalSha256: facts.migrationJournalSha256,
        requiredRoles: facts.roles,
        fixtureRowsBeforeSeed: facts.fixtureState,
        asOf: PERF_AS_OF,
      },
      null,
      2,
    )}\n`,
  );
}

async function verifyFixtureCounts() {
  const verify = new pg.Client({
    connectionString: ownerUrl,
    connectionTimeoutMillis: 2_000,
  });
  await verify.connect();
  try {
    const result = await verify.query<{
      id: string;
      code: string;
      cdrs: string;
    }>(
      `select t.id::text,t.code,count(c.call_uuid)::text as cdrs
       from public.tenants t left join public.cdrs c on c.tenant_id=t.id
       where t.id=any($1::uuid[]) group by t.id,t.code order by t.id`,
      [PERF_TENANTS.map(([id]) => id)],
    );
    assert.deepEqual(
      result.rows.map((row) => [row.id, row.code, Number(row.cdrs)]),
      PERF_TENANTS.map(([id, code, cdrs]) => [id, code, cdrs]),
    );
    return result.rows;
  } finally {
    await verify.end();
  }
}

async function createAndSeed(): Promise<void> {
  const preflightFacts = await preflight();
  const storageAtCreate = await storagePreflight();
  const maintenance = new pg.Client({
    connectionString: maintenanceUrl.toString(),
    connectionTimeoutMillis: 2_000,
  });
  await maintenance.connect();
  try {
    const result = await maintenance.query<{ exists: boolean }>(
      'select exists(select 1 from pg_database where datname=$1) as exists',
      [TARGET_DATABASE],
    );
    assert.equal(
      result.rows[0]?.exists,
      false,
      `${TARGET_DATABASE} already exists`,
    );
    assert(storageAtCreate.availableBytes > storageAtCreate.requiredBytes);
    assert.equal(
      storageAtCreate.dataDirectory,
      preflightFacts.postgresDataDirectory,
    );
    await maintenance.query(
      `create database ${TARGET_DATABASE} owner ${OWNER_ROLE}`,
    );
  } finally {
    await maintenance.end();
  }

  const { db, pool } = connect(ownerUrl, {
    max: 2,
    connectionTimeoutMillis: 2_000,
  });
  let migrationsApplied: number;
  let baselineSeeded: boolean;
  try {
    await migrate(db, { migrationsFolder });
    const migrationState = await pool.query<{ count: string }>(
      'select count(*)::text as count from drizzle.__drizzle_migrations',
    );
    migrationsApplied = Number(migrationState.rows[0]?.count ?? '0');
    await ensureCdrPartitions(db, { moment: new Date(PERF_AS_OF) });
    await seedDatabase(db);
    baselineSeeded = true;
    const existingFixtures = await pool.query<{ count: string }>(
      `select count(*)::text as count from public.tenants
       where id=any($1::uuid[]) or code=any($2::text[])`,
      [PERF_TENANTS.map(([id]) => id), PERF_TENANTS.map(([, code]) => code)],
    );
    assert.equal(existingFixtures.rows[0]?.count, '0');
  } finally {
    await pool.end();
  }

  await runPerfFixtureSeed();

  const verify = new pg.Client({
    connectionString: ownerUrl,
    connectionTimeoutMillis: 2_000,
  });
  await verify.connect();
  let fixtureCounts: Array<{ id: string; code: string; cdrs: string }>;
  let identity: { database: string; role: string; version: string } | undefined;
  try {
    const dbIdentity = await verify.query<{
      database: string;
      role: string;
      version: string;
    }>('select current_database() as database,current_user as role,version()');
    identity = dbIdentity.rows[0];
    assert(identity);
    assert.equal(identity.database, TARGET_DATABASE);
    assert.equal(identity.role, OWNER_ROLE);
    const result = await verify.query<{
      id: string;
      code: string;
      cdrs: string;
    }>(
      `select t.id::text,t.code,count(c.call_uuid)::text as cdrs
       from public.tenants t left join public.cdrs c on c.tenant_id=t.id
       where t.id=any($1::uuid[]) group by t.id,t.code order by t.id`,
      [PERF_TENANTS.map(([id]) => id)],
    );
    fixtureCounts = result.rows;
    assert.deepEqual(
      fixtureCounts.map((row) => [row.id, row.code, Number(row.cdrs)]),
      PERF_TENANTS.map(([id, code, cdrs]) => [id, code, cdrs]),
    );
  } finally {
    await verify.end();
  }

  const setupSource = await readFile(fileURLToPath(import.meta.url));
  const portalSeedSource = await readFile(
    fileURLToPath(new URL('./portal-perf.ts', import.meta.url)),
  );
  const journal = await readFile(
    fileURLToPath(new URL('../migrations/meta/_journal.json', import.meta.url)),
  );
  const provenance = {
    createdAt: new Date().toISOString(),
    sourceDatabase: SOURCE_DATABASE,
    targetDatabase: TARGET_DATABASE,
    ownerRole: OWNER_ROLE,
    appRole: APP_ROLE,
    authRole: AUTH_ROLE,
    identityRole: IDENTITY_ROLE,
    auditRole: AUDIT_ROLE,
    postgresVersion: identity?.version,
    asOf: PERF_AS_OF,
    migrationCount: migrationsApplied,
    migrationJournalSha256: createHash('sha256').update(journal).digest('hex'),
    setupSourceSha256: createHash('sha256').update(setupSource).digest('hex'),
    portalPerfSourceSha256: createHash('sha256')
      .update(portalSeedSource)
      .digest('hex'),
    setupCommand:
      'node --env-file=../../.env --import tsx scripts/setup-portal-perf-isolated.ts create (cwd packages/db)',
    perfSeedCommand:
      'pnpm --dir packages/db exec tsx scripts/portal-perf.ts seed (environment injected by setup runner)',
    roleConnections: preflightFacts.roleConnections,
    availableLocalDiskBytesBeforeCreate: preflightFacts.availableLocalDiskBytes,
    postgresDataDirectory: storageAtCreate.dataDirectory,
    postgresDataVolumeAvailableBytesBeforeCreate:
      storageAtCreate.availableBytes,
    conservativeRequiredDataVolumeBytes: storageAtCreate.requiredBytes,
    sourceDatabaseBytesBeforeCreate: storageAtCreate.sourceDatabaseBytes,
    snapshotDatabaseBytesBeforeCreate: storageAtCreate.snapshotDatabaseBytes,
    baselineSeeded,
    fixtureCounts,
    createdDatabaseOnly: TARGET_DATABASE,
    newSetupPermanentWritesToSource: false,
    newSetupPermanentWritesToSnapshot: false,
  };
  await writeFile(evidencePath, `${JSON.stringify(provenance, null, 2)}\n`, {
    flag: 'wx',
  });
  process.stdout.write(
    `${JSON.stringify({ event: 'isolated_fixture_ready', ...provenance })}\n`,
  );
}

const mode = process.argv[2];
if (mode === 'preflight') {
  process.stdout.write(`${JSON.stringify(await preflight(), null, 2)}\n`);
} else if (mode === 'create') {
  await createAndSeed();
} else if (mode === 'finish') {
  await finishExistingTarget();
} else if (mode === 'finish-preflight') {
  await finishPreflight();
} else {
  throw new Error(
    'usage: setup-portal-perf-isolated.ts preflight | create | finish-preflight | finish',
  );
}
