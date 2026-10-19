import assert from 'node:assert/strict';
import { createHash, randomUUID, type Hash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { cdrFields } from '@fs-billing/shared';
import { z } from 'zod';

const OLD_DATABASE = 'fs_billing_perf';
const NEW_DATABASE = 'fs_billing_perf_pr3_uuid_v4';
const OWNER = 'fs_billing';
const BATCH_SIZE = 10_000;
const TENANTS = [
  ['00000000-0000-4000-8000-000000000001', 'PORTALBIG', 3_000_000, true],
  ['00000000-0000-4000-8000-000000000002', 'PORTALS1', 30_000, true],
  ['00000000-0000-4000-8000-000000000003', 'PORTALS2', 30_000, true],
  ['00000000-0000-4000-8000-000000000004', 'PORTALS3', 30_000, true],
  ['00000000-0000-4000-8000-000000000005', 'EXPORT50K', 50_000, false],
  ['00000000-0000-4000-8000-000000000006', 'EXPORT100K', 100_000, false],
  ['00000000-0000-4000-8000-000000000007', 'EXPORT200K', 200_000, false],
] as const;
const TENANT_IDS = TENANTS.map(([id]) => id);
const CHARGE_IDS = TENANTS.filter((tenant) => tenant[3]).map(
  (tenant) => tenant[0],
);
const NO_CHARGE_IDS = TENANTS.filter((tenant) => !tenant[3]).map(
  (tenant) => tenant[0],
);
const IDS_SQL = `array[${TENANT_IDS.map((id) => `'${id}'::uuid`).join(',')}]`;
const CHARGE_IDS_SQL = `array[${CHARGE_IDS.map((id) => `'${id}'::uuid`).join(',')}]`;
const NO_CHARGE_IDS_SQL = `array[${NO_CHARGE_IDS.map((id) => `'${id}'::uuid`).join(',')}]`;
const OUTPUT_PATH = resolve(
  import.meta.dirname,
  '../../../docs/evidence/phase-6/fixture-crosscheck-20261019T092700Z.json',
);
const EVIDENCE_DIRECTORY = resolve(
  import.meta.dirname,
  '../../../docs/evidence/phase-6',
);
const CDR_COMPONENT_EVIDENCE = 'fixture-crosscheck-20261019T092228Z.json';
const CDR_COMPONENT_SHA256 =
  '11bf710dd0da2af81b7d098bd8f35c551586832f58bb0e1191a7d0b446999127';
const LEDGER_ACTOR_EVIDENCE = 'ledger-diagnostic-20261019T093425Z.json';
const LEDGER_ACTOR_SHA256 =
  'dc62d2d8fa1de044062d86800fa4156a8fbf7d1df5051ffc7fb9195bc1a6a350';
const PORTAL_PERF_SEED_SHA256 =
  '5fcab8723830d6f849c5453efd14127861a04aa4b09bc061669ef5b7a344a443';
const LEDGER_FINANCIAL_ONLY = process.argv.includes('--ledger-financial-only');

function urlFor(database: string): string {
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert(['/fs_billing', `/${OLD_DATABASE}`].includes(url.pathname));
  url.pathname = `/${database}`;
  return url.toString();
}

async function connect(database: string) {
  const client = new pg.Client({
    connectionString: urlFor(database),
    application_name: `phase6_fixture_verify_${database}`,
    connectionTimeoutMillis: 2_000,
  });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    const identity = await client.query<{
      database: string;
      role: string;
      server_version: string;
    }>(
      `select current_database() as database,current_user as role,
       current_setting('server_version') as server_version`,
    );
    assert.equal(identity.rows[0]?.database, database);
    assert.equal(identity.rows[0]?.role, OWNER);
    const row = identity.rows[0];
    assert(row);
    return { client, identity: row };
  } catch (error) {
    if (connected) await client.end().catch(() => undefined);
    throw error;
  }
}

function timestamp(value: Date | string | null): string | null {
  return value === null
    ? null
    : value instanceof Date
      ? value.toISOString()
      : value;
}

async function readCursor<T extends pg.QueryResultRow>(
  client: pg.Client,
  cursorName: string,
  query: string,
  accept: (rows: T[]) => void,
): Promise<number> {
  await client.query('begin isolation level read committed read only');
  await client.query("set local statement_timeout='30min'");
  await client.query(`declare ${cursorName} no scroll cursor for ${query}`);
  let rowsRead = 0;
  try {
    for (;;) {
      const result = await client.query<T>(
        `fetch forward ${BATCH_SIZE} from ${cursorName}`,
      );
      if (result.rows.length === 0) break;
      rowsRead += result.rows.length;
      accept(result.rows);
    }
  } finally {
    await client.query(`close ${cursorName}`);
    await client.query('rollback');
  }
  return rowsRead;
}

type CdrRow = {
  tenant_id: string;
  call_uuid: string;
  started_at: string;
  answered_at: string | null;
  ended_at: string;
  caller: string;
  callee: string;
  billing_number: string;
  duration_seconds: number;
  billed_minutes: string;
  matched_prefix: string | null;
  country: string | null;
  rate: string | null;
  charge: string;
  hangup_cause: string;
  unverified: boolean;
};

type LedgerRow = {
  tenant_id: string;
  kind: string;
  amount: string;
  note: string;
  created_by_auth_user: string | null;
  occurred_at: string;
  multiplicity: string;
};

type FinancialLedgerRow = {
  tenant_id: string;
  kind: string;
  amount_text: string;
  amount_scale: string;
  amount_trimmed: string;
  note: string;
  occurred_at: string;
  multiplicity: string;
};

const crosscheckDbSchema = z
  .object({
    identity: z
      .object({
        database: z.string(),
        role: z.string(),
        server_version: z.string(),
      })
      .passthrough(),
    cdr: z
      .object({
        rows: z.number(),
        schema: z.string(),
        zodAccepted: z.number(),
        zodRejected: z.number(),
        tenantCounts: z.record(z.string(), z.number()),
        nonUuidFieldSha256ByTenant: z.record(z.string(), z.string()),
      })
      .passthrough(),
    legacyUuidState: z
      .object({
        rows: z.string(),
        legacy_seed_uuid_rows: z.string(),
        nonlegacy_rows: z.string(),
      })
      .passthrough()
      .nullable(),
    ledger: z
      .object({
        rows: z.number(),
        tenantCounts: z.record(z.string(), z.number()),
      })
      .passthrough(),
    groupedFacts: z
      .object({
        cdrByTenant: z.array(z.unknown()),
        cdrByCountryStatusVerification: z.array(z.unknown()),
        ledgerByTenantKindMonth: z.array(z.unknown()),
        callChargeByTenant: z.array(z.unknown()),
        callChargeKeyRefs: z.unknown(),
        cdrRegistryAndRawUnassignedRefs: z
          .object({
            cdr_rows: z.string(),
            registry_rows: z.string(),
            cdr_without_registry: z.string(),
            registry_without_cdr: z.string(),
            raw_cdr_rows: z.string(),
            fixture_raw_rows: z.string(),
            unassigned_rows: z.string(),
            fixture_unassigned_rows: z.string(),
          })
          .passthrough(),
        ledgerActorIdentities: z.array(z.unknown()),
      })
      .passthrough(),
  })
  .passthrough();

const cdrCrosscheckEvidenceSchema = z
  .object({
    status: z.literal('failed'),
    oldDatabase: z.literal(OLD_DATABASE),
    targetDatabase: z.literal(NEW_DATABASE),
    comparisonFailure: z.string(),
    comparisons: z
      .object({
        cdrNonUuidFieldsExactPerTenant: z.literal(true),
        groupedCdrLedgerFactsExact: z.literal(true),
      })
      .passthrough(),
    results: z.object({
      [OLD_DATABASE]: crosscheckDbSchema,
      [NEW_DATABASE]: crosscheckDbSchema,
    }),
  })
  .passthrough();

const manualActorRowSchema = z.object({
  tenant_id: z.string(),
  kind: z.string(),
  auth_user_id: z.string(),
  email: z.string(),
  name: z.string(),
  rows: z.string(),
  amount: z.string(),
  first_occurred: z.string(),
  last_occurred: z.string(),
});

const ledgerActorEvidenceSchema = z
  .object({
    readOnly: z.literal(true),
    equal: z.literal(false),
    oldDatabase: z.literal(OLD_DATABASE),
    newDatabase: z.literal(NEW_DATABASE),
    comparison: z.string(),
    oldEventRows: z.number(),
    newEventRows: z.number(),
    manualLedgerActorSummary: z.object({
      old: z.array(manualActorRowSchema),
      new: z.array(manualActorRowSchema),
    }),
  })
  .passthrough();

function updateHash(hash: Hash, value: unknown) {
  hash.update(`${JSON.stringify(value)}\n`);
}

async function readPinnedEvidence(filename: string, expectedSha256: string) {
  const path = resolve(EVIDENCE_DIRECTORY, filename);
  const bytes = await readFile(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha256, expectedSha256, `${filename} SHA-256 changed`);
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  return { path: `docs/evidence/phase-6/${filename}`, sha256, parsed };
}

function verifyPinnedComponents(
  cdrEvidence: z.infer<typeof cdrCrosscheckEvidenceSchema>,
  actorEvidence: z.infer<typeof ledgerActorEvidenceSchema>,
) {
  const oldResult = cdrEvidence.results[OLD_DATABASE];
  const newResult = cdrEvidence.results[NEW_DATABASE];
  assert.equal(oldResult.identity.database, OLD_DATABASE);
  assert.equal(newResult.identity.database, NEW_DATABASE);
  assert.equal(oldResult.identity.role, OWNER);
  assert.equal(newResult.identity.role, OWNER);
  assert.equal(oldResult.cdr.rows, 3_440_000);
  assert.equal(newResult.cdr.rows, 3_440_000);
  assert.equal(
    oldResult.cdr.zodAccepted + oldResult.cdr.zodRejected,
    3_440_000,
  );
  assert.equal(newResult.cdr.zodAccepted, 3_440_000);
  assert.equal(newResult.cdr.zodRejected, 0);
  assert.equal(
    oldResult.cdr.schema,
    'packages/shared/src/api/cdr-fields.ts:cdrFields.callUuid',
  );
  assert.equal(newResult.cdr.schema, oldResult.cdr.schema);
  const expectedTenantCounts = Object.fromEntries(
    TENANTS.map(([id, , count]) => [id, count]),
  );
  assert.deepEqual(oldResult.cdr.tenantCounts, expectedTenantCounts);
  assert.deepEqual(newResult.cdr.tenantCounts, expectedTenantCounts);
  assert.deepEqual(
    newResult.cdr.nonUuidFieldSha256ByTenant,
    oldResult.cdr.nonUuidFieldSha256ByTenant,
  );
  assert.match(cdrEvidence.comparisonFailure, /ledger event multiset differs/);
  assert.match(cdrEvidence.comparisonFailure, /stable actor/);
  assert.deepEqual(newResult.groupedFacts, oldResult.groupedFacts);
  const refs = oldResult.groupedFacts.cdrRegistryAndRawUnassignedRefs;
  assert.deepEqual(
    newResult.groupedFacts.cdrRegistryAndRawUnassignedRefs,
    refs,
  );
  assert.equal(refs.cdr_rows, '3440000');
  assert.equal(refs.registry_rows, '3440000');
  assert.equal(refs.cdr_without_registry, '0');
  assert.equal(refs.registry_without_cdr, '0');
  assert.equal(refs.raw_cdr_rows, '0');
  assert.equal(refs.fixture_raw_rows, '0');
  assert.equal(refs.fixture_unassigned_rows, '0');
  assert.equal(oldResult.legacyUuidState?.rows, '3440000');
  assert.equal(oldResult.legacyUuidState?.legacy_seed_uuid_rows, '3440000');
  assert.equal(oldResult.legacyUuidState?.nonlegacy_rows, '0');
  assert.equal(newResult.legacyUuidState, null);

  const oldActors = actorEvidence.manualLedgerActorSummary.old;
  const newActors = actorEvidence.manualLedgerActorSummary.new;
  assert.equal(oldActors.length, 12);
  assert.equal(newActors.length, 12);
  assert(oldActors.every((row) => row.auth_user_id === 'seed:admin:wang'));
  assert(newActors.every((row) => row.auth_user_id === 'seed:admin:li'));
  const financialProjection = (rows: typeof oldActors) =>
    rows
      .map(
        ({
          tenant_id,
          kind,
          rows: count,
          amount,
          first_occurred,
          last_occurred,
        }) => ({
          tenant_id,
          kind,
          rows: count,
          amount,
          first_occurred,
          last_occurred,
        }),
      )
      .sort((left, right) =>
        `${left.tenant_id}:${left.kind}`.localeCompare(
          `${right.tenant_id}:${right.kind}`,
        ),
      );
  assert.deepEqual(
    financialProjection(oldActors),
    financialProjection(newActors),
  );
  for (const tenantId of CHARGE_IDS) {
    for (const [kind, expectedRows] of [
      ['recharge', '13'],
      ['gift', '13'],
      ['adjustment', '12'],
    ] as const) {
      assert.equal(
        oldActors.find((row) => row.tenant_id === tenantId && row.kind === kind)
          ?.rows,
        expectedRows,
      );
    }
  }
  assert.equal(actorEvidence.oldEventRows, 1);
  assert.equal(actorEvidence.newEventRows, 2);

  return {
    cdr: {
      sourceArtifact: CDR_COMPONENT_EVIDENCE,
      sourceArtifactSha256: CDR_COMPONENT_SHA256,
      sourceOverallStatus: cdrEvidence.status,
      sourceFailure: cdrEvidence.comparisonFailure,
      nonUuidFieldSha256ByTenant: {
        old: oldResult.cdr.nonUuidFieldSha256ByTenant,
        new: newResult.cdr.nonUuidFieldSha256ByTenant,
      },
      tenantCounts: {
        old: oldResult.cdr.tenantCounts,
        new: newResult.cdr.tenantCounts,
      },
      oldUuid: {
        zodAccepted: oldResult.cdr.zodAccepted,
        zodRejected: oldResult.cdr.zodRejected,
        legacyUuidState: oldResult.legacyUuidState,
      },
      newUuid: {
        zodAccepted: newResult.cdr.zodAccepted,
        zodRejected: newResult.cdr.zodRejected,
      },
      groupedCdrLedgerFactsExact: true,
      cdrRegistryAndRawUnassignedRefs: {
        old: refs,
        new: newResult.groupedFacts.cdrRegistryAndRawUnassignedRefs,
      },
    },
    priorLedgerActorDiagnostic: {
      sourceArtifact: LEDGER_ACTOR_EVIDENCE,
      sourceArtifactSha256: LEDGER_ACTOR_SHA256,
      completeLedgerScan: false,
      firstDifferenceCounterpartRows: {
        old: actorEvidence.oldEventRows,
        new: actorEvidence.newEventRows,
      },
      manualActorFinancialProjectionExact: true,
      oldActor: 'seed:admin:wang',
      newActor: 'seed:admin:li',
      manualActorFinancialProjection: {
        old: financialProjection(oldActors),
        new: financialProjection(newActors),
      },
      actorSelectionSource: {
        sourceFile: 'packages/db/scripts/portal-perf.ts',
        sourceSha256: PORTAL_PERF_SEED_SHA256,
        query: 'select id from admins order by id limit 1',
        insertColumn: 'ledger_entries.created_by',
        evidenceMeaning:
          'The performance fixture chooses its synthetic admin at seed time; it does not establish a difference in packages/db/src/seed.ts baseline actor semantics.',
      },
    },
  };
}

async function financialLedgerStream(client: pg.Client) {
  const query = `select tenant_id::text,kind,amount::text as amount_text,
      scale(amount)::text as amount_scale,trim_scale(amount)::text as amount_trimmed,
      note,to_char(occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_at,
      count(*)::text as multiplicity
    from public.ledger_entries where tenant_id=any(${IDS_SQL})
    group by tenant_id,kind,amount::text,scale(amount),trim_scale(amount)::text,note,occurred_at
    order by tenant_id,occurred_at,kind,amount::text,scale(amount),trim_scale(amount)::text,note`;
  const hash = createHash('sha256');
  const perTenantHashes = new Map<string, Hash>(
    TENANT_IDS.map((id) => [id, createHash('sha256')]),
  );
  const counts = new Map<string, number>(TENANT_IDS.map((id) => [id, 0]));
  const groupRows = await readCursor<FinancialLedgerRow>(
    client,
    'fixture_ledger_financial_cursor',
    query,
    (batch) => {
      for (const row of batch) {
        const normalized = [
          row.tenant_id,
          row.occurred_at,
          row.kind,
          row.amount_text,
          row.amount_scale,
          row.amount_trimmed,
          row.note,
          row.multiplicity,
        ];
        updateHash(hash, normalized);
        const tenantHash = perTenantHashes.get(row.tenant_id);
        assert(tenantHash, `unexpected ledger tenant ${row.tenant_id}`);
        updateHash(tenantHash, normalized);
        counts.set(
          row.tenant_id,
          (counts.get(row.tenant_id) ?? 0) + Number(row.multiplicity),
        );
      }
    },
  );
  const manualActors = await client.query<{
    tenant_id: string;
    kind: string;
    profile_id: string | null;
    auth_user_id: string | null;
    rows: string;
    amount: string;
    first_occurred: string;
    last_occurred: string;
  }>(
    `select l.tenant_id::text,l.kind,l.created_by::text as profile_id,
       u.id as auth_user_id,count(*)::text as rows,sum(l.amount)::text as amount,
       to_char(min(l.occurred_at) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as first_occurred,
       to_char(max(l.occurred_at) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as last_occurred
     from public.ledger_entries l
     left join public.admins a on a.id=l.created_by
     left join auth."user" u on u.id=a.auth_user_id
     where l.tenant_id=any(${IDS_SQL}) and l.created_by is not null
     group by l.tenant_id,l.kind,l.created_by,u.id
     order by l.tenant_id,l.kind,u.id`,
  );
  assert.equal(manualActors.rows.length, 12);
  assert(manualActors.rows.every((row) => row.profile_id && row.auth_user_id));
  return {
    rows: [...counts.values()].reduce((sum, count) => sum + count, 0),
    groupedRows: groupRows,
    sha256: hash.digest('hex'),
    sha256ByTenant: Object.fromEntries(
      [...perTenantHashes.entries()].map(([tenantId, item]) => [
        tenantId,
        item.digest('hex'),
      ]),
    ),
    tenantCounts: Object.fromEntries(counts),
    amountComparison: {
      amountTextPreserved: true,
      amountScalePreserved: true,
      trimScaleRecordedOnly: true,
      normalizationApplied: false,
    },
    actorReferenceCheck: {
      allNonNullCreatedByReferencesResolve: true,
      nonNullCreatedByGroups: manualActors.rows.length,
    },
    manualActors: manualActors.rows,
  };
}

function financialOnlyOutputFilename() {
  const suffix = `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`;
  return `ledger-financial-only-${suffix}.json`;
}

async function verifyLedgerFinancialOnly() {
  const outputFilename = financialOnlyOutputFilename();
  const outputPath = resolve(EVIDENCE_DIRECTORY, outputFilename);
  const evidence: Record<string, unknown> = {
    schema: 'phase6-ledger-financial-only/v1',
    artifactPath: `docs/evidence/phase-6/${outputFilename}`,
    readOnly: true,
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: 'running',
    sourceEvidence: {},
    databases: {},
    comparisons: {
      ledgerFinancialEventMultisetExact: 'pending',
      actorIdentical: false,
      allowedFixtureMetadataDifference: false,
    },
    includedLedgerFields: [
      'tenant_id',
      'occurred_at (UTC, six fractional digits)',
      'kind',
      'amount::text (original value text)',
      'scale(amount)',
      'trim_scale(amount)::text (recorded, not used to normalize)',
      'note',
      'multiplicity',
    ],
    excludedLedgerFields: [
      'created_by / mapped auth_user_id (reported independently below as allowed seed metadata difference)',
      'id (generated primary key)',
      'idempotency_key (includes corrected call_uuid)',
      'created_at (seed insertion time differs)',
    ],
    previousLedgerDiagnostic: {},
  };

  try {
    const [cdrPinned, actorPinned] = await Promise.all([
      readPinnedEvidence(CDR_COMPONENT_EVIDENCE, CDR_COMPONENT_SHA256),
      readPinnedEvidence(LEDGER_ACTOR_EVIDENCE, LEDGER_ACTOR_SHA256),
    ]);
    const cdrEvidence = cdrCrosscheckEvidenceSchema.parse(cdrPinned.parsed);
    const actorEvidence = ledgerActorEvidenceSchema.parse(actorPinned.parsed);
    const componentEvidence = verifyPinnedComponents(
      cdrEvidence,
      actorEvidence,
    );
    evidence.sourceEvidence = componentEvidence;
    evidence.previousLedgerDiagnostic = {
      sourceArtifact: actorPinned.path,
      sourceArtifactSha256: actorPinned.sha256,
      sourceOverallEqual: actorEvidence.equal,
      originalComparison: actorEvidence.comparison,
      originalScanWasPartial: true,
      firstDifferenceRowsConsumed: {
        old: actorEvidence.oldEventRows,
        new: actorEvidence.newEventRows,
      },
    };

    const databaseResults: Record<
      string,
      Awaited<ReturnType<typeof financialLedgerStream>> & {
        identity: { database: string; role: string; server_version: string };
      }
    > = {};
    evidence.databases = databaseResults;
    for (const database of [OLD_DATABASE, NEW_DATABASE] as const) {
      process.stderr.write(
        `${JSON.stringify({ event: 'financial-ledger-database-start', database })}\n`,
      );
      const { client, identity } = await connect(database);
      try {
        const ledger = await financialLedgerStream(client);
        const expected = cdrEvidence.results[database].ledger;
        assert.equal(ledger.rows, expected.rows);
        assert.deepEqual(ledger.tenantCounts, expected.tenantCounts);
        databaseResults[database] = { identity, ...ledger };
        evidence.databases = databaseResults;
      } finally {
        await client.end();
      }
    }
    const oldLedger = databaseResults[OLD_DATABASE];
    const newLedger = databaseResults[NEW_DATABASE];
    assert(oldLedger && newLedger, 'both database scans must complete');
    assert.equal(oldLedger.identity.database, OLD_DATABASE);
    assert.equal(newLedger.identity.database, NEW_DATABASE);
    assert.equal(oldLedger.identity.role, OWNER);
    assert.equal(newLedger.identity.role, OWNER);
    assert.deepEqual(newLedger.tenantCounts, oldLedger.tenantCounts);
    assert.deepEqual(newLedger.sha256ByTenant, oldLedger.sha256ByTenant);
    assert.equal(newLedger.sha256, oldLedger.sha256);

    const compareActorSummary = (
      rows: typeof oldLedger.manualActors,
      expectedRows: z.infer<typeof manualActorRowSchema>[],
      expectedActor: string,
    ) => {
      assert(rows.every((row) => row.auth_user_id === expectedActor));
      const financial = rows.map(
        ({
          tenant_id,
          kind,
          rows: count,
          amount,
          first_occurred,
          last_occurred,
        }) => ({
          tenant_id,
          kind,
          rows: count,
          amount,
          first_occurred,
          last_occurred,
        }),
      );
      const expected = expectedRows.map(
        ({
          tenant_id,
          kind,
          rows: count,
          amount,
          first_occurred,
          last_occurred,
        }) => ({
          tenant_id,
          kind,
          rows: count,
          amount,
          first_occurred,
          last_occurred,
        }),
      );
      const sort = (
        left: { tenant_id: string; kind: string },
        right: { tenant_id: string; kind: string },
      ) =>
        `${left.tenant_id}:${left.kind}`.localeCompare(
          `${right.tenant_id}:${right.kind}`,
        );
      assert.deepEqual(financial.sort(sort), expected.sort(sort));
      return financial;
    };
    const sourceActors = actorEvidence.manualLedgerActorSummary;
    const oldActorFinancial = compareActorSummary(
      oldLedger.manualActors,
      sourceActors.old,
      'seed:admin:wang',
    );
    const newActorFinancial = compareActorSummary(
      newLedger.manualActors,
      sourceActors.new,
      'seed:admin:li',
    );
    assert.deepEqual(oldActorFinancial, newActorFinancial);
    const oldActorIds = [
      ...new Set(oldLedger.manualActors.map((row) => row.auth_user_id)),
    ];
    const newActorIds = [
      ...new Set(newLedger.manualActors.map((row) => row.auth_user_id)),
    ];
    assert.deepEqual(oldActorIds, ['seed:admin:wang']);
    assert.deepEqual(newActorIds, ['seed:admin:li']);
    assert.notDeepEqual(oldActorIds, newActorIds);

    evidence.comparisons = {
      ledgerFinancialEventMultisetExact: true,
      actorIdentical: false,
      allowedFixtureMetadataDifference: true,
      actorDifference: {
        field: 'ledger_entries.created_by mapped to auth.user.id',
        old: oldActorIds,
        new: newActorIds,
        cause:
          'The seed picks its baseline admin by admins.id order; independent fixture seeds selected different admins.',
        financialFieldsAndMultiplicityRemainExact: true,
      },
      actorReferencesValid: true,
      manualActorFinancialProjectionExact: true,
    };
    evidence.status = 'partial-verified-allowed-actor-difference';
    evidence.completedAt = new Date().toISOString();
    await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
      flag: 'wx',
    });
    process.stdout.write(
      `${JSON.stringify({ event: 'ledger_financial_only_complete', output: outputPath, ...evidence })}\n`,
    );
  } catch (error) {
    evidence.status = 'failed';
    evidence.completedAt = new Date().toISOString();
    evidence.failure =
      error instanceof Error
        ? `${error.name}: ${error.message}`.replace(
            /postgres(?:ql)?:\/\/[^\s"']+/g,
            '[redacted-url]',
          )
        : 'unknown failure';
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
      flag: 'wx',
    });
    process.stderr.write(
      `${JSON.stringify({ event: 'ledger_financial_only_failed', output: outputPath, failure: evidence.failure })}\n`,
    );
    process.exitCode = 1;
  }
}

async function cdrStream(client: pg.Client) {
  const query = `select tenant_id::text,call_uuid::text,
      to_char(started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as started_at,
      to_char(answered_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as answered_at,
      to_char(ended_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ended_at,
      caller,callee,billing_number,duration_seconds,billed_minutes::text,
      matched_prefix,country,rate::text,charge::text,hangup_cause,unverified
    from public.cdrs where tenant_id=any(${IDS_SQL})
    order by tenant_id,started_at`;
  const hashes = new Map<string, Hash>(
    TENANT_IDS.map((id) => [id, createHash('sha256')]),
  );
  const counts = new Map<string, number>(TENANT_IDS.map((id) => [id, 0]));
  const uuidVersionCounts: Record<string, number> = {};
  const uuidVariantCounts: Record<string, number> = {};
  const parser = cdrFields.callUuid;
  let accepted = 0;
  let rejected = 0;
  const rows = await readCursor<CdrRow>(
    client,
    'fixture_cdr_cursor',
    query,
    (batch) => {
      for (const row of batch) {
        const hash = hashes.get(row.tenant_id);
        assert(hash, `unexpected fixture tenant ${row.tenant_id}`);
        counts.set(row.tenant_id, (counts.get(row.tenant_id) ?? 0) + 1);
        const uuidResult = parser.safeParse(row.call_uuid);
        if (uuidResult.success) accepted += 1;
        else rejected += 1;
        const lower = row.call_uuid.toLowerCase();
        const version = lower.slice(14, 15);
        const variant = lower.slice(19, 20);
        uuidVersionCounts[version] = (uuidVersionCounts[version] ?? 0) + 1;
        uuidVariantCounts[variant] = (uuidVariantCounts[variant] ?? 0) + 1;
        updateHash(hash, [
          row.tenant_id,
          timestamp(row.started_at),
          timestamp(row.answered_at),
          timestamp(row.ended_at),
          row.caller,
          row.callee,
          row.billing_number,
          row.duration_seconds,
          row.billed_minutes,
          row.matched_prefix,
          row.country,
          row.rate,
          row.charge,
          row.hangup_cause,
          row.unverified,
        ]);
      }
    },
  );
  assert.equal(rows, 3_440_000);
  assert.equal(accepted + rejected, rows);
  return {
    rows,
    schema: 'packages/shared/src/api/cdr-fields.ts:cdrFields.callUuid',
    zodAccepted: accepted,
    zodRejected: rejected,
    uuidVersionCounts,
    uuidVariantCounts,
    tenantCounts: Object.fromEntries(counts),
    nonUuidFieldSha256ByTenant: Object.fromEntries(
      [...hashes.entries()].map(([tenantId, hash]) => [
        tenantId,
        hash.digest('hex'),
      ]),
    ),
  };
}

async function ledgerStream(client: pg.Client) {
  const query = `select l.tenant_id::text,l.kind,l.amount::text,l.note,
      auth_user.id as created_by_auth_user,
      to_char(l.occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_at,
      count(*)::text as multiplicity
    from public.ledger_entries l
    left join public.admins a on a.id=l.created_by
    left join auth."user" auth_user on auth_user.id=a.auth_user_id
    where l.tenant_id=any(${IDS_SQL})
    group by l.tenant_id,l.kind,l.amount,l.note,auth_user.id,l.occurred_at
    order by l.tenant_id,l.kind,l.occurred_at,l.amount,l.note,auth_user.id`;
  const actorReferenceCheck = await client.query<{ dangling: string }>(
    `select count(*)::text as dangling from public.ledger_entries l
     left join public.admins a on a.id=l.created_by
     left join auth."user" u on u.id=a.auth_user_id
     where l.tenant_id=any(${IDS_SQL}) and l.created_by is not null and u.id is null`,
  );
  assert.equal(actorReferenceCheck.rows[0]?.dangling, '0');
  const hash = createHash('sha256');
  const perTenantHashes = new Map<string, Hash>(
    TENANT_IDS.map((id) => [id, createHash('sha256')]),
  );
  const counts = new Map<string, number>(TENANT_IDS.map((id) => [id, 0]));
  const groupRows = await readCursor<LedgerRow>(
    client,
    'fixture_ledger_cursor',
    query,
    (batch) => {
      for (const row of batch) {
        const normalized = [
          row.tenant_id,
          row.kind,
          row.amount,
          row.note,
          row.created_by_auth_user,
          timestamp(row.occurred_at),
          row.multiplicity,
        ];
        updateHash(hash, normalized);
        const tenantHash = perTenantHashes.get(row.tenant_id);
        assert(tenantHash, `unexpected ledger tenant ${row.tenant_id}`);
        updateHash(tenantHash, normalized);
        counts.set(
          row.tenant_id,
          (counts.get(row.tenant_id) ?? 0) + Number(row.multiplicity),
        );
      }
    },
  );
  return {
    rows: [...counts.values()].reduce((sum, count) => sum + count, 0),
    groupedRows: groupRows,
    semantics:
      'compares the exact event multiset grouped by tenant/occurred_at/kind/amount/note/stable auth_user_id plus multiplicity; excludes generated ledger id, call_uuid-derived idempotency_key, and insertion created_at',
    sha256: hash.digest('hex'),
    tenantCounts: Object.fromEntries(counts),
    sha256ByTenant: Object.fromEntries(
      [...perTenantHashes.entries()].map(([tenantId, item]) => [
        tenantId,
        item.digest('hex'),
      ]),
    ),
  };
}

async function groupedFacts(client: pg.Client) {
  const cdr = await client.query<Record<string, string | boolean | null>>(
    `select tenant_id::text,country,answered_at is not null as answered,unverified,
       count(*)::text as rows,sum(billed_minutes)::text as billed_minutes,
       sum(charge)::text as charge,min(started_at)::text as first_started,
       max(started_at)::text as last_started
     from public.cdrs where tenant_id=any(${IDS_SQL})
     group by tenant_id,country,answered,unverified order by tenant_id,country nulls first,answered,unverified`,
  );
  const ledger = await client.query<Record<string, string | null>>(
    `select tenant_id::text,kind,date_trunc('month',occurred_at)::text as occurred_month,
       count(*)::text as rows,sum(amount)::text as amount,
       min(occurred_at)::text as first_occurred,max(occurred_at)::text as last_occurred
     from public.ledger_entries where tenant_id=any(${IDS_SQL})
     group by tenant_id,kind,date_trunc('month',occurred_at)
     order by tenant_id,kind,occurred_month`,
  );
  const ledgerCharges = await client.query<Record<string, string | null>>(
    `select tenant_id::text,count(*)::text as call_charge_rows,
       sum(amount)::text as amount_sum,min(occurred_at)::text as first_occurred,
       max(occurred_at)::text as last_occurred
     from public.ledger_entries where tenant_id=any(${IDS_SQL}) and kind='call_charge'
     group by tenant_id order by tenant_id`,
  );
  const chargeRefs = await client.query<Record<string, string>>(
    `select
       (select count(*)::text from public.ledger_entries l
        where l.tenant_id=any(${CHARGE_IDS_SQL}) and l.kind='call_charge'
          and not exists (select 1 from public.cdrs c
            where c.tenant_id=l.tenant_id and ('call:'||c.call_uuid::text)=l.idempotency_key)) as dangling_charge_keys,
       (select count(*)::text from public.ledger_entries l
        where l.tenant_id=any(${NO_CHARGE_IDS_SQL}) and l.kind='call_charge') as export_charge_rows`,
  );
  const cdrRows = await client.query<Record<string, string>>(
    `select tenant_id::text,count(*)::text as cdrs,
       count(*) filter(where answered_at is not null)::text as answered,
       count(*) filter(where answered_at is null)::text as unanswered,
       sum(billed_minutes)::text as billed_minutes,sum(charge)::text as charge,
       count(*) filter(where unverified)::text as unverified,
       min(started_at)::text as first_started,max(started_at)::text as last_started
     from public.cdrs where tenant_id=any(${IDS_SQL}) group by tenant_id order by tenant_id`,
  );
  const references = await client.query<Record<string, string>>(
    `select
       (select count(*)::text from public.cdrs where tenant_id=any(${IDS_SQL})) as cdr_rows,
       (select count(*)::text from public.call_uuids where tenant_id=any(${IDS_SQL})) as registry_rows,
       (select count(*)::text from public.cdrs c where c.tenant_id=any(${IDS_SQL}) and not exists(
         select 1 from public.call_uuids r where r.call_uuid=c.call_uuid and r.tenant_id=c.tenant_id and r.started_at=c.started_at)) as cdr_without_registry,
       (select count(*)::text from public.call_uuids r where r.tenant_id=any(${IDS_SQL}) and not exists(
         select 1 from public.cdrs c where c.call_uuid=r.call_uuid and c.tenant_id=r.tenant_id and c.started_at=r.started_at)) as registry_without_cdr,
       (select count(*)::text from public.raw_cdrs) as raw_cdr_rows,
       (select count(*)::text from public.raw_cdrs where tenant_id=any(${IDS_SQL})) as fixture_raw_rows,
       (select count(*)::text from public.unassigned_cdrs) as unassigned_rows,
       (select count(*)::text from public.unassigned_cdrs where assigned_tenant_id=any(${IDS_SQL})) as fixture_unassigned_rows`,
  );
  const actorIdentities = await client.query<{
    auth_user_id: string;
    email: string;
    name: string;
  }>(
    `select u.id as auth_user_id,u.email,a.name
     from public.admins a join auth."user" u on u.id=a.auth_user_id
     order by u.id`,
  );
  return {
    cdrByTenant: cdrRows.rows,
    cdrByCountryStatusVerification: cdr.rows,
    ledgerByTenantKindMonth: ledger.rows,
    callChargeByTenant: ledgerCharges.rows,
    callChargeKeyRefs: chargeRefs.rows[0],
    cdrRegistryAndRawUnassignedRefs: references.rows[0],
    ledgerActorIdentities: actorIdentities.rows,
  };
}

async function legacyUuidState(client: pg.Client) {
  const result = await client.query<{
    rows: string;
    legacy_seed_uuid_rows: string;
    nonlegacy_rows: string;
  }>(
    `with numbered as (
       select tenant_id,call_uuid,row_number() over(partition by tenant_id order by started_at) as fixture_index
       from public.cdrs where tenant_id=any(${IDS_SQL})
     ), expected as (
       select tenant_id,call_uuid,
         md5(tenant_id::text||':'||fixture_index::text)::uuid as legacy_uuid
       from numbered
     )
     select count(*)::text as rows,
       count(*) filter(where call_uuid=legacy_uuid)::text as legacy_seed_uuid_rows,
       count(*) filter(where call_uuid<>legacy_uuid)::text as nonlegacy_rows
     from expected`,
  );
  assert.equal(result.rows[0]?.rows, '3440000');
  assert.equal(result.rows[0]?.legacy_seed_uuid_rows, '3440000');
  assert.equal(result.rows[0]?.nonlegacy_rows, '0');
  return result.rows[0];
}

async function backendGone() {
  const maintenanceUrl = new URL(urlFor(OLD_DATABASE));
  maintenanceUrl.pathname = '/postgres';
  const maintenance = new pg.Client({
    connectionString: maintenanceUrl.toString(),
    connectionTimeoutMillis: 2_000,
  });
  await maintenance.connect();
  try {
    const result = await maintenance.query<{
      pid: number;
      datname: string | null;
      usename: string | null;
      state: string | null;
      backend_type: string | null;
    }>(
      `select pid,datname,usename,state,backend_type
       from pg_stat_activity where pid=456504`,
    );
    assert.equal(
      result.rows.length,
      0,
      'prior cancelled source backend still exists',
    );
    return { pid: 456504, present: false };
  } finally {
    await maintenance.end();
  }
}

async function main() {
  const runStarted = new Date().toISOString();
  const backend = await backendGone();
  const databaseResults: Record<string, unknown> = {};
  for (const database of [OLD_DATABASE, NEW_DATABASE]) {
    process.stderr.write(
      `${JSON.stringify({ event: 'database-start', database })}\n`,
    );
    const { client, identity } = await connect(database);
    try {
      const cdr = await cdrStream(client);
      process.stderr.write(
        `${JSON.stringify({ event: 'cdr-stream-complete', database, rows: cdr.rows, zodAccepted: cdr.zodAccepted, zodRejected: cdr.zodRejected })}\n`,
      );
      const ledger = await ledgerStream(client);
      process.stderr.write(
        `${JSON.stringify({ event: 'ledger-stream-complete', database, rows: ledger.rows })}\n`,
      );
      const facts = await groupedFacts(client);
      const legacy =
        database === OLD_DATABASE ? await legacyUuidState(client) : null;
      const rowState = await client.query<Record<string, string>>(
        `select
         (select count(*)::text from public.tenants where id=any(${IDS_SQL})) as fixture_tenants,
         (select count(*)::text from public.ledger_entries where tenant_id=any(${NO_CHARGE_IDS_SQL}) and kind='call_charge') as export_charge_rows,
         (select count(*)::text from public.raw_cdrs) as raw_rows,
         (select count(*)::text from public.unassigned_cdrs) as unassigned_rows`,
      );
      databaseResults[database] = {
        identity,
        cdr,
        ledger,
        groupedFacts: facts,
        legacyUuidState: legacy,
        rowState: rowState.rows[0],
      };
    } finally {
      await client.end();
    }
  }
  const oldResult = databaseResults[OLD_DATABASE] as {
    cdr: Awaited<ReturnType<typeof cdrStream>>;
    ledger: Awaited<ReturnType<typeof ledgerStream>>;
    groupedFacts: Awaited<ReturnType<typeof groupedFacts>>;
  };
  const newResult = databaseResults[NEW_DATABASE] as typeof oldResult;
  const evidence: Record<string, unknown> = {
    readOnly: true,
    startedAt: runStarted,
    status: 'partial-before-comparisons',
    completedAt: null,
    targetDatabase: NEW_DATABASE,
    oldDatabase: OLD_DATABASE,
    oldCancelledBackend: backend,
    previousAttempt: {
      log: 'docs/evidence/phase-6/fixture-crosscheck-run-20261019T091911Z.log',
      exitCode: 1,
      failure:
        'strict ledger per-tenant row digest differed after CDR digest and grouped facts matched',
      rawComparisonArtifactPersisted: false,
    },
    schema:
      'packages/shared/src/api/cdr-fields.ts:cdrFields.callUuid (z.uuid())',
    timestampPrecision:
      'All CDR started/answered/ended and ledger occurred_at values are formatted from PostgreSQL at UTC with six fractional digits; no JavaScript Date millisecond truncation.',
    cdrComparisonFields: [
      'tenant_id',
      'started_at',
      'answered_at',
      'ended_at',
      'caller',
      'callee',
      'billing_number',
      'duration_seconds',
      'billed_minutes',
      'matched_prefix',
      'country',
      'rate',
      'charge',
      'hangup_cause',
      'unverified',
    ],
    intentionallyExcludedCdrFields: [
      'call_uuid (corrected to RFC UUID in the new fixture)',
      'received_at (ingestion time changes when independently seeded)',
    ],
    intentionallyExcludedLedgerFields: [
      'id (generated primary key)',
      'idempotency_key (includes corrected call_uuid)',
      'created_at (seed insertion time differs)',
    ],
    ledgerActorNormalization:
      'created_by profile UUID is mapped through admins/auth.user to stable auth_user_id; actor identity mappings are included in groupedFacts',
    results: databaseResults,
    comparisons: {
      cdrNonUuidFieldsExactPerTenant: 'pending',
      ledgerEventMultisetExactPerTenant: 'pending',
      groupedCdrLedgerFactsExact: 'pending',
      newFixtureAllCdrUuidsAcceptedByZod: 'pending',
      oldFixtureStillUsesLegacyMd5Uuids: 'pending',
      priorBackendGone: true,
    },
  };
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: 'wx',
  });
  const comparisons = evidence.comparisons as Record<string, unknown>;
  try {
    assert.deepEqual(
      newResult.cdr.nonUuidFieldSha256ByTenant,
      oldResult.cdr.nonUuidFieldSha256ByTenant,
      'deterministic non-UUID CDR fields differ between source and isolated target',
    );
    comparisons.cdrNonUuidFieldsExactPerTenant = true;
    assert.deepEqual(
      newResult.groupedFacts,
      oldResult.groupedFacts,
      'CDR country/status/money/date or ledger category/amount/time facts differ',
    );
    comparisons.groupedCdrLedgerFactsExact = true;
    assert.deepEqual(
      newResult.ledger.sha256ByTenant,
      oldResult.ledger.sha256ByTenant,
      'ledger event multiset differs by tenant (stable actor, occurred_at, kind, amount, note, multiplicity)',
    );
    comparisons.ledgerEventMultisetExactPerTenant = true;
    assert.equal(oldResult.cdr.rows, 3_440_000);
    assert.equal(newResult.cdr.rows, 3_440_000);
    assert.equal(newResult.cdr.zodAccepted, 3_440_000);
    assert.equal(newResult.cdr.zodRejected, 0);
    comparisons.newFixtureAllCdrUuidsAcceptedByZod = true;
    comparisons.oldFixtureStillUsesLegacyMd5Uuids = true;
    evidence.status = 'passed';
    evidence.completedAt = new Date().toISOString();
    process.stderr.write(
      `${JSON.stringify({ event: 'comparisons-complete' })}\n`,
    );
  } catch (error) {
    evidence.status = 'failed';
    evidence.completedAt = new Date().toISOString();
    evidence.comparisonFailure =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    await writeFile(OUTPUT_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
    throw error;
  }
  await writeFile(OUTPUT_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(
    JSON.stringify({ event: 'fixture_crosscheck_complete', ...evidence }) +
      '\n',
  );
}

if (LEDGER_FINANCIAL_ONLY) await verifyLedgerFinancialOnly();
else await main();
