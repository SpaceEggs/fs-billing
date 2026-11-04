import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { connect } from '../src/client.js';

/**
 * 在有历史数据（0003 结构，billing_number 已回填）的临时库上验证 0004 的 guard。
 *
 *   pnpm --filter @fs-billing/db exec tsx --env-file-if-exists=../../.env \
 *     scripts/guard-0004.ts --out-dir ../../docs/evidence/phase-10/guard-0004 \
 *     --source-db fsb_rehearse_0003
 *
 * 场景：
 *   valid-upgrade     合法数据应用 0004 成功，记录耗时、持锁采样与约束状态
 *   invalid-null      cdrs.billing_number IS NULL
 *   invalid-format    cdrs.billing_number 位数不足（0003 允许、0004 拒绝）
 *   invalid-unassigned unassigned_cdrs 号码与 reason 不对应
 *   atomicity         每个失败场景后核对：仍可空、旧约束在、新约束不在、迁移记录无 0004
 *
 * 脚本只创建和删除临时库，拒绝把 fs_billing 当目标；证据里不含电话号码与连接串。
 */
const migrationsFolder = fileURLToPath(
  new URL('../migrations', import.meta.url),
);
const defaultOutDir = fileURLToPath(
  new URL('../../../docs/evidence/phase-10/guard-0004', import.meta.url),
);
// 开发机直接运行时从仓库根的 .env 读取；服务器上由运维环境提供 DATABASE_URL。
if (!process.env.DATABASE_URL) {
  const envPath = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}
const ownerUrl = process.env.DATABASE_URL;
if (!ownerUrl) throw new Error('需要 DATABASE_URL（owner 连接）');
// DATABASE_URL 只提供主机、端口与角色；脚本只连 postgres 和临时库，不连 fs_billing。
const owner = new URL(ownerUrl);
const adminUrl = new URL(owner);
adminUrl.pathname = '/postgres';

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}
interface Journal {
  entries: JournalEntry[];
}

interface Options {
  outDir: string;
  sourceDb: string;
  cdrs: number;
  scenario: 'all' | Scenario;
  machineLabel: string;
}
type Scenario =
  'valid' | 'invalid-null' | 'invalid-format' | 'invalid-unassigned';

const scenarioFile: Record<Scenario, string> = {
  valid: 'valid-upgrade.txt',
  'invalid-null': 'invalid-null.txt',
  'invalid-format': 'invalid-format.txt',
  'invalid-unassigned': 'invalid-unassigned.txt',
};

function parseOptions(argv: string[]): Options {
  const options: Options = {
    outDir: defaultOutDir,
    sourceDb: '',
    cdrs: 3_000_000,
    scenario: 'all',
    machineLabel: '开发机（非服务器 B）',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    switch (arg) {
      case '--out-dir':
        if (!value) throw new Error('--out-dir 需要参数');
        options.outDir = value;
        i += 1;
        break;
      case '--source-db':
        if (!value) throw new Error('--source-db 需要参数');
        options.sourceDb = value;
        i += 1;
        break;
      case '--cdrs':
        if (!value) throw new Error('--cdrs 需要参数');
        options.cdrs = Number(value);
        i += 1;
        break;
      case '--scenario': {
        if (!value) throw new Error('--scenario 需要参数');
        const allowed = [
          'all',
          'valid',
          'invalid-null',
          'invalid-format',
          'invalid-unassigned',
        ] as const;
        if (!allowed.includes(value as (typeof allowed)[number]))
          throw new Error(`未知场景：${value}`);
        options.scenario = value as Options['scenario'];
        i += 1;
        break;
      }
      case '--machine-label':
        if (!value) throw new Error('--machine-label 需要参数');
        options.machineLabel = value;
        i += 1;
        break;
      case '-h':
      case '--help':
        console.log(
          '用法：guard-0004.ts [--out-dir DIR] [--source-db 0003库] [--cdrs N] ' +
            '[--scenario all|valid|invalid-null|invalid-format|invalid-unassigned] ' +
            '[--machine-label 文字]',
        );
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  if (!Number.isSafeInteger(options.cdrs) || options.cdrs <= 0)
    throw new Error('--cdrs 必须是正整数');
  if (options.sourceDb && !/^[a-z_][a-z0-9_]*$/.test(options.sourceDb))
    throw new Error('--source-db 不是合法数据库名');
  if (options.sourceDb === 'fs_billing')
    throw new Error('拒绝把 fs_billing 当源库');
  return options;
}

async function readJournal(folder = migrationsFolder): Promise<Journal> {
  const parsed: unknown = JSON.parse(
    await readFile(join(folder, 'meta', '_journal.json'), 'utf8'),
  );
  return parsed as Journal;
}

async function journalEntry(tagPrefix: string): Promise<JournalEntry> {
  const journal = await readJournal();
  const entry = journal.entries.find((item) => item.tag.startsWith(tagPrefix));
  if (!entry) throw new Error(`journal 里找不到 ${tagPrefix}`);
  return entry;
}

/** 只含 0000–<upToTag> 的迁移目录，模拟当时的历史库结构。 */
async function copyMigrationsUpTo(upToTag: string): Promise<{
  folder: string;
  appliedTag: string;
}> {
  const folder = await mkdtemp(join(tmpdir(), 'fsb-guard-0004-'));
  await cp(migrationsFolder, folder, { recursive: true });
  const journal = await readJournal(folder);
  const at = journal.entries.findIndex((entry) => entry.tag === upToTag);
  if (at < 0) throw new Error(`journal 里找不到 ${upToTag}`);
  journal.entries = journal.entries.slice(0, at + 1);
  await writeFile(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify(journal),
  );
  return { folder, appliedTag: upToTag };
}

function adminClient(): pg.Client {
  return new pg.Client({ connectionString: adminUrl.toString() });
}

async function dropDatabase(name: string): Promise<void> {
  const admin = adminClient();
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

async function createDatabase(name: string, template?: string): Promise<void> {
  const admin = adminClient();
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    if (template) {
      await admin.query(`CREATE DATABASE ${name} TEMPLATE ${template}`);
    } else {
      await admin.query(`CREATE DATABASE ${name}`);
    }
  } finally {
    await admin.end();
  }
}

function databaseUrl(name: string): string {
  const url = new URL(ownerUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}

function scratchName(scenario: Scenario): string {
  return `fs_billing_guard_${scenario.replaceAll('-', '_')}_${randomUUID()
    .replaceAll('-', '')
    .slice(0, 10)}`;
}

function section(title: string): string {
  return `\n## ${title}\n`;
}

interface LockSample {
  at: number;
  mode: string;
}

const lockStrength = new Map<string, number>([
  ['AccessExclusiveLock', 8],
  ['ExclusiveLock', 7],
  ['ShareRowExclusiveLock', 6],
  ['ShareLock', 5],
  ['ShareUpdateExclusiveLock', 4],
  ['RowExclusiveLock', 3],
  ['RowShareLock', 2],
  ['AccessShareLock', 1],
]);

/** 采样迁移连接持有的关系锁；锁一直持到提交，所以首末采样跨度约等于持锁时长。 */
async function startLockSampler(targetDatabase: string): Promise<{
  stop: () => Promise<{ mode: string; spanMs: number; samples: number }>;
}> {
  const client = new pg.Client({
    connectionString: databaseUrl(targetDatabase),
    application_name: 'fsb-guard-0004-sampler',
  });
  await client.connect();
  const samples: LockSample[] = [];
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    client
      .query<{ mode: string }>(
        `select l.mode
         from pg_locks l
         join pg_stat_activity a on a.pid = l.pid
         where a.application_name = 'fsb-guard-0004-migration'
           and l.locktype = 'relation'`,
      )
      .then((result) => {
        const at = performance.now();
        for (const row of result.rows) samples.push({ at, mode: row.mode });
      })
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  }, 100);
  let result: { mode: string; spanMs: number; samples: number } | undefined;
  return {
    async stop() {
      if (result) return result;
      clearInterval(timer);
      await client.end().catch(() => undefined);
      if (samples.length === 0) {
        result = { mode: '', spanMs: 0, samples: 0 };
        return result;
      }
      const strongest = samples.reduce((best, sample) =>
        (lockStrength.get(sample.mode) ?? 0) >
        (lockStrength.get(best.mode) ?? 0)
          ? sample
          : best,
      );
      const matching = samples.filter(
        (sample) => sample.mode === strongest.mode,
      );
      result = {
        mode: strongest.mode,
        spanMs:
          Math.max(...matching.map((sample) => sample.at)) -
          Math.min(...matching.map((sample) => sample.at)),
        samples: matching.length,
      };
      return result;
    },
  };
}

async function apply0004(targetDatabase: string): Promise<{
  elapsedMs: number;
  locks: { mode: string; spanMs: number; samples: number };
}> {
  const { folder } = await copyMigrationsUpTo('0004_billing_number_not_null');
  const { db, pool } = connect(databaseUrl(targetDatabase), {
    max: 1,
    application_name: 'fsb-guard-0004-migration',
  });
  const sampler = await startLockSampler(targetDatabase);
  const started = performance.now();
  try {
    await migrate(db, { migrationsFolder: folder });
    return {
      elapsedMs: Math.round((performance.now() - started) * 10) / 10,
      locks: await sampler.stop(),
    };
  } finally {
    await sampler.stop().catch(() => undefined);
    await pool.end();
    await rm(folder, { recursive: true, force: true });
  }
}

async function seedValid(targetDatabase: string, rows: number): Promise<void> {
  const client = new pg.Client({
    connectionString: databaseUrl(targetDatabase),
  });
  await client.connect();
  const tenantId = '00000000-0000-4000-8000-0000000000aa';
  try {
    await client.query(`select set_config('app.scope', 'system', false)`);
    await client.query(
      `insert into tenants (id, code, name, currency, overdraft_limit)
       values ($1, 'GUARD0004', '0004 合法数据', 'CNY', 1000)
       on conflict (id) do nothing`,
      [tenantId],
    );
    await client.query(
      `select cdr_ensure_partitions(date_trunc('month', now()) - interval '13 months', 14)`,
    );
    const chunk = 100_000;
    for (let first = 1; first <= rows; first += chunk) {
      const last = Math.min(first + chunk - 1, rows);
      await client.query('begin');
      try {
        await client.query(`set local synchronous_commit = off`);
        await client.query(
          `insert into cdrs (
             tenant_id, call_uuid, started_at, answered_at, ended_at, caller,
             callee, matched_prefix, country, rate, charge, duration_seconds,
             billed_minutes, hangup_cause, unverified, billing_number
           )
           select
             $1::uuid,
             md5($1::text || ':' || i::text)::uuid,
             t.started,
             case when t.answered then t.started + interval '5 seconds' end,
             t.started + case when t.answered
               then interval '5 seconds' + make_interval(secs => t.dur)
               else interval '30 seconds' end,
             '861' || lpad((i::bigint * 7919 % 1000000000)::text, 9, '0'),
             c.prefix || t.national,
             case when t.answered then c.prefix end,
             case when t.answered then c.name end,
             case when t.answered then c.rate end,
             case when t.answered then ceil(t.dur / 60.0) * c.rate else 0 end,
             case when t.answered then t.dur else 0 end,
             case when t.answered then ceil(t.dur / 60.0) else 0 end,
             case when t.answered then 'NORMAL_CLEARING' else 'NO_ANSWER' end,
             false,
             c.prefix || t.national
           from generate_series($2::int, $3::int) i
           cross join lateral (
             select
               date_trunc('month', now()) - interval '13 months'
                 + (interval '14 months') * ((i - 1)::float8 / $4::int) as started,
               (i % 100) < 95 as answered,
               1 + (i % 300) as dur,
               lpad((i::bigint * 104729 % 1000000000)::text, 9, '0') as national
           ) t
           cross join lateral (
             select prefix, name, rate
             from (values
               ('86', '中国', 0.0500::numeric),
               ('1', '美国/加拿大', 0.0100::numeric),
               ('44', '英国', 0.0200::numeric),
               ('81', '日本', 0.0350::numeric)
             ) v(prefix, name, rate)
             offset (i % 4) limit 1
           ) c`,
          [tenantId, first, last, rows],
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
      process.stderr.write(`seed ${last}/${rows}\n`);
    }
    await client.query('vacuum (analyze) cdrs');
  } finally {
    await client.end();
  }
}

async function prepare0003(
  targetDatabase: string,
  data: Scenario,
  rows: number,
): Promise<void> {
  await createDatabase(targetDatabase);
  const { folder } = await copyMigrationsUpTo('0003_billing_number');
  const { db, pool } = connect(databaseUrl(targetDatabase), { max: 1 });
  try {
    await migrate(db, { migrationsFolder: folder });
  } finally {
    await pool.end();
    await rm(folder, { recursive: true, force: true });
  }
  // 非法场景也要有当前月分区，才能插进 cdrs 再让 0004 的 guard 读到。
  const partitions = new pg.Client({
    connectionString: databaseUrl(targetDatabase),
  });
  await partitions.connect();
  try {
    await partitions.query(`select set_config('app.scope', 'system', false)`);
    await partitions.query(`select cdr_ensure_partitions(now(), 1)`);
  } finally {
    await partitions.end();
  }
  if (data === 'valid') await seedValid(targetDatabase, rows);
}

async function sourceFacts(sourceDb: string): Promise<{
  rows: number;
  applied: number;
  billingColumn: boolean;
  invalidNumbers: number;
}> {
  const client = new pg.Client({ connectionString: databaseUrl(sourceDb) });
  await client.connect();
  try {
    const result = await client.query<{
      rows: string;
      applied: string;
      billing_column: boolean;
      invalid_numbers: string;
    }>(
      `select
         (select count(*)::text from cdrs) as rows,
         (select count(*)::text from drizzle.__drizzle_migrations) as applied,
         exists (
           select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'cdrs'
             and column_name = 'billing_number'
         ) as billing_column,
         (select count(*)::text from cdrs
          where billing_number is null
             or billing_number !~ '^[1-9][0-9]{5,14}$') as invalid_numbers`,
    );
    const row = result.rows[0];
    if (!row) throw new Error('读不到源库状态');
    return {
      rows: Number(row.rows),
      applied: Number(row.applied),
      billingColumn: row.billing_column,
      invalidNumbers: Number(row.invalid_numbers),
    };
  } finally {
    await client.end();
  }
}

interface ScenarioReport {
  lines: string[];
}

async function validScenario(
  options: Options,
  when0004: number,
): Promise<ScenarioReport> {
  const name = scratchName('valid');
  const report: ScenarioReport = { lines: [] };
  let sourceDescription: string;
  try {
    if (options.sourceDb) {
      const facts = await sourceFacts(options.sourceDb);
      if (facts.applied !== 4)
        throw new Error(
          `源库 ${options.sourceDb} 应已应用 0000–0003（实际 ${facts.applied} 条记录）`,
        );
      if (!facts.billingColumn) throw new Error('源库没有 billing_number 列');
      if (facts.invalidNumbers !== 0)
        throw new Error(
          `源库仍有 ${facts.invalidNumbers} 条不合法的 billing_number`,
        );
      await createDatabase(name, options.sourceDb);
      sourceDescription = `从 ${options.sourceDb} 模板复制，${facts.rows} 条 cdrs`;
      report.lines.push(
        section('源库核对'),
        `源库：${options.sourceDb}`,
        `cdrs 行数：${facts.rows}`,
        `drizzle 迁移记录：${facts.applied} 条（0000–0003）`,
        `billing_number 列：存在；不合法的存量行：0`,
      );
    } else {
      await prepare0003(name, 'valid', options.cdrs);
      sourceDescription = `原型数据 ${options.cdrs} 条`;
    }

    const before = await sourceFacts(name);
    const result = await apply0004(name);
    const client = new pg.Client({ connectionString: databaseUrl(name) });
    await client.connect();
    try {
      const check = await client.query<{
        not_null: boolean;
        validated_cdrs: boolean;
        validated_unassigned: boolean;
        validated_reason: boolean;
        migration_rows: string;
        invalid_numbers: string;
      }>(
        `select
           (select attnotnull from pg_attribute
            where attrelid = 'cdrs'::regclass and attname = 'billing_number') as not_null,
           (select convalidated from pg_constraint
            where conrelid = 'cdrs'::regclass
              and conname = 'cdrs_billing_number_check') as validated_cdrs,
           (select convalidated from pg_constraint
            where conrelid = 'unassigned_cdrs'::regclass
              and conname = 'unassigned_cdrs_billing_number_check') as validated_unassigned,
           (select convalidated from pg_constraint
            where conrelid = 'unassigned_cdrs'::regclass
              and conname = 'unassigned_cdrs_billing_number_reason_check') as validated_reason,
           (select count(*)::text from drizzle.__drizzle_migrations
            where created_at = $1) as migration_rows,
           (select count(*)::text from cdrs
            where billing_number is null
               or billing_number !~ '^[1-9][0-9]{5,14}$') as invalid_numbers`,
        [when0004],
      );
      const row = check.rows[0]!;
      report.lines.push(
        section('合法数据升级成功'),
        `数据库：${name}`,
        `数据：${sourceDescription}`,
        `演练前 cdrs 行数：${before.rows}`,
        `0004 墙钟耗时：${result.elapsedMs} ms`,
        `锁采样：最强 ${result.locks.mode || '（未采到）'}，跨度 ${Math.round(result.locks.spanMs)} ms，样本 ${result.locks.samples} 个`,
        '',
        '检查：',
        `  cdrs.billing_number NOT NULL：${row.not_null}`,
        `  cdrs_billing_number_check 已 VALIDATE：${row.validated_cdrs}`,
        `  unassigned_cdrs_billing_number_check 已 VALIDATE：${row.validated_unassigned}`,
        `  unassigned_cdrs_billing_number_reason_check 已 VALIDATE：${row.validated_reason}`,
        `  drizzle 记录 0004：${row.migration_rows} 行`,
        `  仍不合法 / 为空的 billing_number：${row.invalid_numbers} 行`,
      );
      if (
        !row.not_null ||
        !row.validated_cdrs ||
        !row.validated_unassigned ||
        !row.validated_reason ||
        row.migration_rows !== '1' ||
        row.invalid_numbers !== '0'
      ) {
        throw new Error('合法升级后的状态不符合预期');
      }
    } finally {
      await client.end();
    }
    report.lines.push(section('结论'), '通过：合法数据可以升级到 0004。');
    return report;
  } finally {
    await dropDatabase(name);
  }
}

async function atomicityFacts(
  targetDatabase: string,
  when0004: number,
): Promise<Record<string, string | boolean>> {
  const client = new pg.Client({
    connectionString: databaseUrl(targetDatabase),
  });
  await client.connect();
  try {
    const result = await client.query<{
      not_null: boolean;
      cdrs_check: string | null;
      unassigned_check: string | null;
      reason_check: string;
      migration_rows: string;
    }>(
      `select
         (select attnotnull from pg_attribute
          where attrelid = 'cdrs'::regclass and attname = 'billing_number') as not_null,
         (select pg_get_constraintdef(oid) from pg_constraint
          where conrelid = 'cdrs'::regclass
            and conname = 'cdrs_billing_number_check') as cdrs_check,
         (select pg_get_constraintdef(oid) from pg_constraint
          where conrelid = 'unassigned_cdrs'::regclass
            and conname = 'unassigned_cdrs_billing_number_check') as unassigned_check,
         (select count(*)::text from pg_constraint
          where conrelid = 'unassigned_cdrs'::regclass
            and conname = 'unassigned_cdrs_billing_number_reason_check') as reason_check,
         (select count(*)::text from drizzle.__drizzle_migrations
          where created_at = $1) as migration_rows`,
      [when0004],
    );
    const row = result.rows[0]!;
    return {
      'cdrs.billing_number 仍可空': !row.not_null,
      '旧 cdrs 约束仍在': (row.cdrs_check ?? '').includes('IS NULL'),
      '旧 unassigned 约束仍在': (row.unassigned_check ?? '').includes(
        'IS NULL',
      ),
      '新 reason 约束不存在': row.reason_check === '0',
      '迁移记录没有 0004': row.migration_rows === '0',
    };
  } finally {
    await client.end();
  }
}

async function invalidScenario(
  scenario: Exclude<Scenario, 'valid'>,
  when0004: number,
): Promise<{ report: ScenarioReport; atomicity: string[] }> {
  const name = scratchName(scenario);
  const report: ScenarioReport = { lines: [] };
  const atomicity: string[] = [];
  try {
    await prepare0003(name, scenario, 0);
    const client = new pg.Client({ connectionString: databaseUrl(name) });
    await client.connect();
    try {
      await client.query(
        `insert into tenants (id, code, name, currency, overdraft_limit)
         values ('00000000-0000-4000-8000-0000000000aa', 'GUARD0004',
           '0004 非法数据', 'CNY', 1000)`,
      );
      if (scenario === 'invalid-unassigned') {
        await client.query(
          `insert into unassigned_cdrs (
             tenant_tag, call_uuid, reason, started_at, ended_at, caller, callee,
             billing_number
           ) values (
             'GUARD0004', gen_random_uuid(), '租户不存在',
             now(), now() + interval '10 seconds', '8613800000000',
             '8613800000000', null
           )`,
        );
        report.lines.push(
          section('构造的非法数据'),
          'unassigned_cdrs：billing_number IS NULL，reason = 租户不存在',
          '（0003 允许；0004 的 reason 对应关系要求号码为空时 reason 必须是格式/校验失败）',
        );
      } else {
        const billingNumber = scenario === 'invalid-null' ? null : '123';
        await client.query(
          `insert into cdrs (
             tenant_id, call_uuid, started_at, answered_at, ended_at, caller,
             callee, matched_prefix, country, rate, charge, duration_seconds,
             billed_minutes, hangup_cause, unverified, billing_number
           ) values (
             '00000000-0000-4000-8000-0000000000aa', gen_random_uuid(),
             now(), now() + interval '1 second', now() + interval '10 seconds',
             '8613800000000', '8613800000000', '86', '中国', 0.0500, 0.0500,
             10, 1, 'NORMAL_CLEARING', false, $1
           )`,
          [billingNumber],
        );
        report.lines.push(
          section('构造的非法数据'),
          scenario === 'invalid-null'
            ? 'cdrs.billing_number = NULL'
            : "cdrs.billing_number = '123'（0003 的 ^[1-9][0-9]{0,14}$ 允许，0004 的 ^[1-9][0-9]{5,14}$ 拒绝）",
        );
      }
    } finally {
      await client.end();
    }

    let errorMessage = '';
    try {
      await apply0004(name);
      throw new Error('0004 意外成功');
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      const cause =
        error && typeof error === 'object' && 'cause' in error
          ? (error as { cause?: unknown }).cause
          : undefined;
      if (cause instanceof Error) errorMessage = cause.message;
    }
    report.lines.push(section('0004 结果'), `错误：${errorMessage}`);
    if (
      !errorMessage.includes(
        'reset the dev database before 0004: legacy billing_number rows present',
      )
    ) {
      throw new Error(`错误信息不符合 guard 预期：${errorMessage}`);
    }
    const facts = await atomicityFacts(name, when0004);
    report.lines.push(section('原子性核对（失败后）'));
    for (const [label, passed] of Object.entries(facts)) {
      report.lines.push(`  ${label}：${passed}`);
      atomicity.push(`  ${name} ${label}：${passed}`);
      if (!passed) throw new Error(`原子性检查失败：${label}`);
    }
    report.lines.push(
      section('结论'),
      '通过：guard 拒绝非法数据，迁移整体回滚，临时库保持 0003 结构。',
    );
    return { report, atomicity };
  } finally {
    await dropDatabase(name);
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const when0004 = (await journalEntry('0004_billing_number_not_null')).when;
  await mkdir(options.outDir, { recursive: true });
  const summary: string[] = [
    '# 0004 guard 验证',
    '',
    `机器：${options.machineLabel}`,
    '数据来源：0003 结构的历史库；非法场景各用一个临时库。',
    '本文件不含电话号码、密钥或连接串。',
    '',
  ];
  const scenarios: Scenario[] =
    options.scenario === 'all'
      ? ['valid', 'invalid-null', 'invalid-format', 'invalid-unassigned']
      : [options.scenario];
  const atomicityLines: string[] = [];

  for (const scenario of scenarios) {
    if (scenario === 'valid') {
      const report = await validScenario(options, when0004);
      const text = `${summary.join('\n')}\n${report.lines.join('\n')}\n`;
      await writeFile(join(options.outDir, scenarioFile[scenario]), text);
      process.stdout.write(text);
    } else {
      const { report, atomicity } = await invalidScenario(scenario, when0004);
      const text = `${summary.join('\n')}\n${report.lines.join('\n')}\n`;
      await writeFile(join(options.outDir, scenarioFile[scenario]), text);
      process.stdout.write(text);
      atomicityLines.push(...atomicity);
    }
  }

  if (options.scenario === 'all') {
    const text = `${summary.join('\n')}\n## 三个非法场景的原子性核对\n${atomicityLines.join('\n')}\n`;
    await writeFile(join(options.outDir, 'atomicity.txt'), text);
    process.stdout.write(text);
  }
}

await main();
