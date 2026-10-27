import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { connect, withSystem } from '../src/client.js';
import { ensureCdrPartitions } from '../src/partitions.js';
import {
  LocalArchiveStore,
  archiveFileKey,
  archiveMonth,
  loadManifest,
  readArchivedRawCdr,
  restoreRawCdrMonth,
  runRawArchive,
  type ArchiveCheckpoint,
} from '../src/raw-archive/index.js';

// 阶段 8 PR 3 的耗时：归档一个月 raw_cdrs 分区（导出、校验、分离）、DETACH 的锁对并发入库的影响、取回与整月恢复。
// 会写库：只允许在 fs_billing_perf 的克隆库上运行（不是 fs_billing_perf 本身）。
//   CREATE DATABASE fs_billing_perf_p8pr3 TEMPLATE fs_billing_perf;  然后对它执行 pnpm db:migrate
//   PERF_OWNER_URL=postgresql://fs_billing:…@127.0.0.1:5432/fs_billing_perf_p8pr3 \
//   PERF_APP_URL=postgresql://fs_billing_app:…@127.0.0.1:5432/fs_billing_perf_p8pr3 \
//   pnpm --filter @fs-billing/db exec tsx scripts/raw-archive-perf.ts seed|run
// 夹具：用 SQL 按 FreeSWITCH mod_json_cdr 的形状合成原文（随机的 UUID、端口、SIP Call-ID 等），不是真实话单。
const command = process.argv[2];
const ownerUrl = z.url().parse(process.env.PERF_OWNER_URL);
const appUrl = z.url().parse(process.env.PERF_APP_URL);
for (const [url, user] of [
  [ownerUrl, 'fs_billing'],
  [appUrl, 'fs_billing_app'],
] as const) {
  const parsed = new URL(url);
  assert(parsed.pathname.startsWith('/fs_billing_perf_'), '只允许克隆库');
  assert.notEqual(parsed.pathname, '/fs_billing_perf');
  assert.equal(parsed.username, user);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname));
}

const BIG_MONTH = '2026-03-01';
const BIG_ROWS = 246_574; // PORTALBIG 2026-09 的话单数（阶段 8 PR 1 实测），作为一个月的量级。
const SMALL_MONTHS = ['2026-02-01', '2026-01-01', '2025-12-01'];
const SMALL_ROWS = 20_000;
const sleep = (n: number) => new Promise((resolve) => setTimeout(resolve, n));
const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

// ---------------------------------------------------------------- 入库负载（子进程）
if (command === 'load') {
  const seconds = Number(process.argv[3]);
  const writers = Number(process.argv[4] ?? 4);
  const pauseMs = Number(process.argv[5] ?? 25);
  const app = connect(appUrl, { max: writers });
  const body = JSON.stringify({ variables: { filler: 'x'.repeat(6000) } });
  const samples: [number, number][] = [];
  let stop = false;
  process.on('message', (message) => {
    if (message === 'stop') stop = true;
  });
  setTimeout(() => (stop = true), seconds * 1000);
  await Promise.all(
    Array.from({ length: writers }, async () => {
      while (!stop) {
        const started = performance.now();
        const at = Date.now();
        // 与 Worker 入库一样：系统身份、一个事务、插入一行原文。
        await withSystem(app.db, (tx) =>
          tx.execute(sql`insert into raw_cdrs (body) values (${body})`),
        );
        samples.push([at, performance.now() - started]);
        await sleep(pauseMs);
      }
    }),
  );
  await app.pool.end();
  process.send?.({ samples }, () => process.exit(0));
  await sleep(5000);
  process.exit(0);
}

const owner = connect(ownerUrl, { max: 4 });
const app = connect(appUrl, { max: 6 });
const pct = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
  );
};
const summarize = (values: number[]) =>
  `n=${values.length} p50=${pct(values, 0.5).toFixed(1)} p95=${pct(values, 0.95).toFixed(1)} p99=${pct(values, 0.99).toFixed(1)} max=${Math.max(0, ...values).toFixed(1)} ms`;

/** 启动入库负载子进程；stop() 返回 [时间戳, 耗时] 样本。 */
function startLoad(seconds: number) {
  const child = fork(process.argv[1]!, ['load', String(seconds)], {
    execArgv: ['--import', 'tsx'],
    env: process.env,
  });
  const result = new Promise<[number, number][]>((resolve, reject) => {
    child.once('message', (message: { samples: [number, number][] }) =>
      resolve(message.samples),
    );
    child.once('error', reject);
    child.once(
      'exit',
      (code) => code !== 0 && reject(new Error(`负载进程退出 ${code}`)),
    );
  });
  return {
    stop: () => {
      child.send('stop');
      return result;
    },
    result,
  };
}

const bodyTemplateKeys = (() => {
  // FreeSWITCH 通道变量的样子：名字固定；值有的固定（编解码器、标志位），有的每条通话不同（哈希、端口、UUID）。
  const stable: [string, string][] = [
    ['direction', 'inbound'],
    ['is_outbound', 'true'],
    ['presence_id', ''],
    ['sip_via_protocol', 'udp'],
    ['sofia_profile_name', 'internal'],
    ['recovery_profile_name', 'internal'],
    ['sip_local_network_addr', '10.0.0.10'],
    ['sip_network_ip', '10.0.0.77'],
    ['sip_invite_domain', '10.0.0.10'],
    ['sip_req_scheme', 'sip'],
    ['sip_to_scheme', 'sip'],
    ['sip_from_scheme', 'sip'],
    ['sip_contact_scheme', 'sip'],
    ['sip_allow', 'INVITE, ACK, BYE, CANCEL, OPTIONS, INFO, MESSAGE, UPDATE'],
    ['sip_user_agent', 'Cisco-SIPGateway/IOS-12.x'],
    ['endpoint_disposition', 'ANSWER'],
    ['originate_disposition', 'SUCCESS'],
    ['DIALSTATUS', 'SUCCESS'],
    ['read_codec', 'PCMA'],
    ['read_rate', '8000'],
    ['write_codec', 'PCMA'],
    ['write_rate', '8000'],
    ['video_possible', 'false'],
    ['rtp_use_codec_name', 'PCMA'],
    ['rtp_use_codec_rate', '8000'],
    ['rtp_use_codec_ptime', '20'],
    ['rtp_use_codec_channels', '1'],
    ['rtp_audio_recv_pt', '8'],
    ['rtp_2833_send_payload', '101'],
    ['rtp_2833_recv_payload', '101'],
    ['dtmf_type', 'rfc2833'],
    ['rtp_audio_in_raw_bytes', '0'],
    ['rtp_audio_in_dtmf_packet_count', '0'],
    ['rtp_audio_in_cng_packet_count', '0'],
    ['rtp_audio_in_flush_packet_count', '0'],
    ['rtp_audio_in_skip_packet_count', '0'],
    ['rtp_audio_out_cng_packet_count', '0'],
    ['rtp_audio_out_dtmf_packet_count', '0'],
    ['rtp_audio_out_skip_packet_count', '0'],
    ['export_vars', 'RFC2822_DATE,RFC2822_DATE'],
    ['current_application', 'bridge'],
    ['call_timeout', '60'],
    ['continue_on_fail', 'true'],
    ['hangup_after_bridge', 'true'],
    ['ignore_early_media', 'true'],
    ['bypass_media', 'false'],
    ['proxy_media', 'false'],
    ['sip_h_X-Billing', 'v1'],
    ['transfer_ringback', '$${hold_music}'],
    ['rtp_secure_media', 'false'],
    ['switch_r_sdp', ''],
    ['verto_enabled', 'false'],
    ['srtp_enabled', 'false'],
    ['failure_causes', 'NORMAL_CLEARING'],
  ];
  // [名字, 随机值的十六进制长度]
  const random: [string, number][] = [
    ['sip_call_id', 32],
    ['sip_from_tag', 12],
    ['sip_to_tag', 12],
    ['sip_h_Call-ID', 32],
    ['sip_h_P-Asserted-Identity', 14],
    ['sip_network_port', 5],
    ['sip_via_host', 8],
    ['sip_via_port', 5],
    ['sip_via_rport', 5],
    ['sip_received_port', 5],
    ['sip_contact_user', 10],
    ['sip_contact_port', 5],
    ['sip_contact_uri', 22],
    ['sip_from_user_stripped', 10],
    ['sip_from_uri', 26],
    ['sip_to_uri', 26],
    ['sip_req_uri', 26],
    ['sip_full_via', 40],
    ['sip_full_from', 36],
    ['sip_full_to', 36],
    ['sip_h_Via', 40],
    ['sip_h_From', 36],
    ['sip_h_To', 36],
    ['sip_h_CSeq', 6],
    ['sip_h_Contact', 30],
    ['rtp_local_sdp_str', 64],
    ['switch_m_sdp', 64],
    ['sip_recover_via', 40],
    ['sip_recover_contact', 30],
    ['sip_authorized', 4],
    ['uuid_bleg', 32],
    ['signal_bond', 32],
    ['originating_leg_uuid', 32],
    ['bridge_channel', 24],
    ['bridge_uuid', 32],
    ['last_bridge_to', 32],
    ['rtp_audio_in_media_packet_count', 5],
    ['rtp_audio_in_packet_count', 5],
    ['rtp_audio_out_media_packet_count', 5],
    ['rtp_audio_out_packet_count', 5],
    ['rtp_audio_out_raw_bytes', 7],
    ['rtp_audio_out_media_bytes', 7],
    ['rtp_audio_in_media_bytes', 7],
    ['rtp_audio_in_jb_packet_count', 5],
    ['rtp_audio_rtcp_packet_count', 4],
    ['rtp_audio_in_mean_interval', 5],
    ['rtp_audio_in_jitter_min_variance', 8],
    ['rtp_audio_in_jitter_max_variance', 8],
    ['rtp_audio_in_jitter_loss_rate', 4],
    ['rtp_audio_in_jitter_burst_rate', 4],
    ['rtp_audio_in_mean_abs_jitter', 8],
    ['rtp_audio_in_quality_percentage', 3],
    ['rtp_audio_in_packet_loss_percentage', 3],
    ['local_media_ip', 8],
    ['local_media_port', 5],
    ['advertised_media_ip', 8],
    ['remote_media_ip', 8],
    ['remote_media_port', 5],
    ['endpoint_disposition_ext', 20],
    ['sip_codec_negotiation_str', 30],
    ['sip_nat_detected', 4],
    ['sip_h_X-Trace', 24],
    ['sip_h_X-Gateway', 12],
    ['sip_term_status', 3],
    ['sip_term_cause', 3],
    ['proto_specific_hangup_cause', 14],
    ['hangup_cause_q850', 2],
    ['sip_hangup_disposition', 18],
    ['switch_r_hangup_ts', 16],
  ];
  return { stable, random };
})();

/** 生成一个月的原文：每行约 6–7 KB，和设计估算的一个月 1.7 GB 同量级。 */
async function seedMonth(month: string, rows: number) {
  const started = performance.now();
  await ensureCdrPartitions(app.db, {
    moment: new Date(`${month}T12:00:00+08:00`),
    monthsAhead: 0,
  });
  await owner.pool.query(
    `
    with m as (
      select ($1::date::timestamp at time zone 'Asia/Shanghai') as lo,
             extract(epoch from ((($1::date + interval '1 month')::timestamp at time zone 'Asia/Shanghai')
               - ($1::date::timestamp at time zone 'Asia/Shanghai')))::float8 as secs
    ), vars as (
      select key as k, value as v from jsonb_each_text($3::jsonb)
    ), randoms as (
      select name, len from jsonb_to_recordset($4::jsonb) as r(name text, len int)
    )
    insert into raw_cdrs (id, received_at, body)
    select gen_random_uuid(),
      m.lo + make_interval(secs => (g::float8 / $2::int) * (m.secs - 3600)) + ((g * 7919) % 1000000) * interval '1 microsecond',
      '{' || E'\n' ||
      '  "core-uuid": "' || gen_random_uuid() || '",' || E'\n' ||
      '  "switchname": "fs-a",' || E'\n' ||
      '  "channel_data": {' || E'\n' ||
      '    "state": "CS_REPORTING",' || E'\n' ||
      '    "direction": "inbound",' || E'\n' ||
      '    "state_number": "11",' || E'\n' ||
      '    "flags": "0=1;1=1;3=1;20=1;37=1;38=1;40=1;43=1;48=1;53=1;75=1;98=1;112=1;113=1;122=1;134=1",' || E'\n' ||
      '    "caps": "1=1;2=1;3=1;4=1;5=1;6=1;"' || E'\n' ||
      '  },' || E'\n' ||
      '  "variables": {' || E'\n' ||
      '    "uuid": "' || gen_random_uuid() || '",' || E'\n' ||
      '    "billing_tenant": "ABC001",' || E'\n' ||
      '    "start_epoch": "' || (1772294400 + g * 10) || '",' || E'\n' ||
      '    "answer_epoch": "' || (1772294400 + g * 10 + 9) || '",' || E'\n' ||
      '    "end_epoch": "' || (1772294400 + g * 10 + 199) || '",' || E'\n' ||
      '    "billsec": "' || (30 + g % 300) || '",' || E'\n' ||
      '    "caller_id_number": "0755' || (8600000 + g % 99999) || '",' || E'\n' ||
      '    "destination_number": "+' || (447700000000 + (g * 7919) % 99999999) || '",' || E'\n' ||
      '    "hangup_cause": "NORMAL_CLEARING",' || E'\n' ||
      (select string_agg(format('    %s: %s', to_json(s.k), to_json(s.v)), E',\n' order by s.k) from (
         select k, v from vars
         union all
         select name, case when len <= 5 then (10000 + (hashtext(g::text || name) & 32767))::text
                           else substr(md5(g::text || name) || md5(name || g::text), 1, len) end
         from randoms
       ) s) || E'\n' ||
      '  },' || E'\n' ||
      '  "callflow": [' || E'\n' ||
      '    {"dialplan": "XML", "caller_profile": {"username": "ABC001", "caller_id_number": "0755' || (8600000 + g % 99999) || '", "network_addr": "10.0.0.77", "uuid": "' || gen_random_uuid() || '", "rdnis": "", "ani": "", "aniii": "", "context": "billing", "source": "mod_sofia", "chan_name": "sofia/internal/ABC001@10.0.0.10"},' || E'\n' ||
      '     "times": {"created_time": "' || (1772294400000000 + g * 10000000) || '", "answered_time": "' || (1772294409000000 + g * 10000000) || '", "hangup_time": "' || (1772294599000000 + g * 10000000) || '"}},' || E'\n' ||
      '    {"dialplan": "XML", "caller_profile": {"username": "ABC001", "caller_id_number": "0755' || (8600000 + g % 99999) || '", "network_addr": "10.0.0.77", "uuid": "' || gen_random_uuid() || '", "context": "billing", "source": "mod_sofia", "chan_name": "sofia/gateway/upstream/+447700900123"},' || E'\n' ||
      '     "times": {"created_time": "' || (1772294401000000 + g * 10000000) || '", "answered_time": "' || (1772294409000000 + g * 10000000) || '", "hangup_time": "' || (1772294599000000 + g * 10000000) || '"}}' || E'\n' ||
      '  ]' || E'\n' ||
      '}' || E'\n'
    from m, generate_series(1::bigint, $2::bigint) as g
    `,
    [
      month,
      rows,
      JSON.stringify(Object.fromEntries(bodyTemplateKeys.stable)),
      JSON.stringify(
        bodyTemplateKeys.random.map(([name, len]) => ({ name, len })),
      ),
    ],
  );
  const { rows: stats } = await owner.pool.query<{
    n: string;
    avg: string;
    body_bytes: string;
    heap: string;
  }>(
    `select count(*)::text as n, round(avg(octet_length(body)))::text as avg, sum(octet_length(body))::text as body_bytes,
            pg_total_relation_size($2::regclass)::text as heap
     from raw_cdrs where received_at >= ($1::date::timestamp at time zone 'Asia/Shanghai')
       and received_at < (($1::date + interval '1 month')::timestamp at time zone 'Asia/Shanghai')`,
    [month, `raw_cdrs_${month.slice(0, 4)}_${month.slice(5, 7)}`],
  );
  const s = stats[0]!;
  console.log(
    `seed ${month.slice(0, 7)}: ${s.n} rows, avg body ${s.avg} B, body total ${mb(Number(s.body_bytes))} MB, partition on disk (incl. TOAST) ${mb(Number(s.heap))} MB, ${((performance.now() - started) / 1000).toFixed(1)} s`,
  );
}

const execFileAsync = promisify(execFile);

try {
  if (command === 'seed') {
    await seedMonth(BIG_MONTH, BIG_ROWS);
    for (const month of SMALL_MONTHS) await seedMonth(month, SMALL_ROWS);
    await owner.pool.query('vacuum analyze raw_cdrs');
  } else if (command === 'run') {
    const dir = await mkdtemp(join(tmpdir(), 'fsb-archive-perf-'));
    const store = new LocalArchiveStore(dir);
    const options = { afterMonths: 6, graceDays: 7 };
    console.log(`# 归档目录 ${dir}（运行结束后删除）`);
    const t: Record<string, number> = {};
    const mark = (name: ArchiveCheckpoint | 'start' | 'end') =>
      (t[name] = performance.now());

    // ---- 1. 基线：只有入库负载
    console.log(
      '# 1. 入库负载基线（4 个写入者，每次插入后停 25 ms，实测约 120 次/秒；整行 6 KB 原文）',
    );
    const baseline = startLoad(20);
    const baselineSamples = await baseline.result;
    console.log(
      `baseline ingest latency: ${summarize(baselineSamples.map(([, ms]) => ms))}`,
    );

    // 分离函数在持有分区 ACCESS EXCLUSIVE 锁（不是父表的）时重算指纹，单独计时这一次全分区扫描。
    const scanStarted = performance.now();
    await owner.pool.query(
      `select count(*), sum(octet_length(body)), bit_xor(hashtextextended(id::text || body, 0)) from raw_cdrs_${BIG_MONTH.slice(0, 4)}_${BIG_MONTH.slice(5, 7)}`,
    );
    console.log(
      `fingerprint scan of the whole ${BIG_MONTH.slice(0, 7)} partition (count, sum(octet_length), bit_xor(hash)), warm cache: ${((performance.now() - scanStarted) / 1000).toFixed(1)} s`,
    );

    // ---- 2. 归档一个月（PORTALBIG 量级），入库负载同时在跑
    console.log(
      `# 2. 归档 ${BIG_MONTH.slice(0, 7)}（${BIG_ROWS} 行）：导出、校验、分离，入库负载同时在跑`,
    );
    const delay = monitorEventLoopDelay({ resolution: 5 });
    let rssPeak = 0;
    const rssTimer = setInterval(
      () => (rssPeak = Math.max(rssPeak, process.memoryUsage().rss)),
      200,
    );
    // 监视 raw_cdrs 父表上的 ACCESS EXCLUSIVE 锁：第一次、最后一次看到它的时间就是 DETACH 持有父表锁的窗口。
    const lockWindow: { first?: number; last?: number } = {};
    let watching = true;
    const watcher = (async () => {
      while (watching) {
        const { rows } = await owner.pool.query<{ held: boolean }>(
          `select exists (select 1 from pg_locks where locktype = 'relation' and relation = 'raw_cdrs'::regclass
             and mode = 'AccessExclusiveLock' and granted) as held`,
        );
        if (rows[0]!.held) {
          const now = performance.now();
          lockWindow.first ??= now;
          lockWindow.last = now;
        }
        await sleep(2);
      }
    })();
    const load = startLoad(600);
    await sleep(2000);
    delay.enable();
    mark('start');
    const wall = Date.now();
    const stage = await archiveMonth(app.db, store, BIG_MONTH, {
      ...options,
      onCheckpoint: (point) => void mark(point),
    });
    mark('end');
    delay.disable();
    const during = await load.stop();
    watching = false;
    await watcher;
    clearInterval(rssTimer);
    const manifest = (await loadManifest(app.db, BIG_MONTH))!;
    assert.equal(stage, 'detached');
    const sec = (a: number | undefined, b: number | undefined) =>
      (((b ?? 0) - (a ?? 0)) / 1000).toFixed(1);
    console.log(
      `stage=${stage} rows=${manifest.rows} body=${mb(manifest.bodyBytes!)} MB file=${mb(manifest.fileBytes!)} MB chunks=${manifest.chunks!.length}`,
    );
    console.log(
      `compression ratio (body bytes / file bytes): ${(manifest.bodyBytes! / manifest.fileBytes!).toFixed(2)}x (file = ${((manifest.fileBytes! / manifest.bodyBytes!) * 100).toFixed(1)}% of the original text)`,
    );
    console.log(
      `export (start -> exported, includes the sort in PostgreSQL): ${sec(t.start, t.exported)} s`,
    );
    console.log(
      `verify (exported -> verified; file hash + decode + second pass over the partition): ${sec(t.exported, t.verified)} s`,
    );
    console.log(
      `publish + manifest (verified -> marked): ${sec(t.verified, t.marked)} s`,
    );
    console.log(
      `detach step (marked -> committed; re-hash of the file + raw_cdrs_detach_partition): ${sec(t.marked, t.end)} s`,
    );
    console.log(
      `total wall time: ${sec(t.start, t.end)} s (${(Date.now() - wall) / 1000} s by Date)`,
    );
    console.log(
      `export throughput: ${(manifest.bodyBytes! / 1024 / 1024 / ((t.exported! - t.start!) / 1000)).toFixed(1)} MB/s of body text, ${(manifest.rows! / ((t.exported! - t.start!) / 1000)).toFixed(0)} rows/s`,
    );
    console.log(
      `Worker-process RSS peak while archiving: ${mb(rssPeak)} MB; event loop delay p50=${(delay.percentile(50) / 1e6).toFixed(1)} p99=${(delay.percentile(99) / 1e6).toFixed(1)} max=${(delay.max / 1e6).toFixed(1)} ms (resolution 5 ms)`,
    );
    console.log(
      `parent-table ACCESS EXCLUSIVE window seen by a 2 ms poller: ${lockWindow.first === undefined ? 'not seen (shorter than the poll interval)' : `${(lockWindow.last! - lockWindow.first).toFixed(0)} ms (first seen +${sec(t.start, lockWindow.first)} s)`}`,
    );
    const phase = (from: number | undefined, to: number | undefined) =>
      during
        .filter(
          ([at]) =>
            at >= wall + (from! - t.start!) && at <= wall + (to! - t.start!),
        )
        .map(([, ms]) => ms);
    console.log(
      `ingest latency while exporting:  ${summarize(phase(t.start, t.exported))}`,
    );
    console.log(
      `ingest latency while verifying:  ${summarize(phase(t.exported, t.verified))}`,
    );
    console.log(
      `ingest latency during detach step: ${summarize(phase(t.marked, t.end))}`,
    );
    console.log(
      `ingest latency whole run:        ${summarize(during.map(([, ms]) => ms))}`,
    );
    const worst = during.reduce((a, b) => (b[1] > a[1] ? b : a), [0, 0] as [
      number,
      number,
    ]);
    console.log(
      `slowest single insert: ${worst[1].toFixed(1)} ms at +${((worst[0] - wall) / 1000).toFixed(1)} s (detach step began at +${sec(t.start, t.marked)} s)`,
    );

    // 用 ops 的办法检查归档文件：gzip -t、zcat | wc -l（多成员 gzip 整体可解压）。
    const file = join(dir, archiveFileKey(BIG_MONTH));
    const started = performance.now();
    await execFileAsync('gzip', ['-t', file]);
    console.log(
      `gzip -t ${archiveFileKey(BIG_MONTH)}: ok in ${((performance.now() - started) / 1000).toFixed(1)} s (${mb((await stat(file)).size)} MB)`,
    );
    let lines = 0;
    const zstart = performance.now();
    await new Promise<void>((resolve, reject) => {
      createReadStream(file)
        .pipe(createGunzip())
        .on('data', (chunk: Buffer) => {
          for (const byte of chunk) if (byte === 10) lines++;
        })
        .on('end', resolve)
        .on('error', reject);
    });
    console.log(
      `zcat | wc -l equivalent: ${lines} lines in ${((performance.now() - zstart) / 1000).toFixed(1)} s`,
    );
    assert.equal(lines, manifest.rows);

    // ---- 3. 取回一条、整月恢复（丢弃之后）
    const detachedAt = manifest.detachedAt!;
    const dropped = await runRawArchive(app.db, store, {
      ...options,
      asOf: new Date(detachedAt.getTime() + 8 * 86_400_000),
    });
    console.log(
      `drop after the grace period: dropped=${dropped.dropped.join(',')} failures=${dropped.failures.length}`,
    );
    // 取回单条：分区已丢弃，数据库里没有这个月了。id 与 received_at 取自文件本身，各取几个不同位置的成员。
    const { gunzipSync } = await import('node:zlib');
    const single: number[] = [];
    for (const fraction of [0, 0.2, 0.4, 0.6, 0.8, 0.999]) {
      const chunk =
        manifest.chunks![Math.floor(fraction * manifest.chunks!.length)]!;
      const bytes = await store.readRange(
        archiveFileKey(BIG_MONTH),
        chunk.offset,
        chunk.length,
      );
      const first = JSON.parse(
        gunzipSync(bytes).toString('utf8').split('\n')[0]!,
      ) as { id: string; receivedAt: string };
      const began = performance.now();
      const restored = await readArchivedRawCdr(app.db, store, {
        id: first.id,
        receivedAt: first.receivedAt,
      });
      single.push(performance.now() - began);
      assert.equal(restored.sha256.length, 64);
    }
    console.log(
      `restore one record (partition dropped; manifest query + read one ~1000-row member + gunzip + hash), 6 members across the file: ${single.map((ms) => ms.toFixed(0)).join(', ')} ms`,
    );
    const restoreStart = performance.now();
    const restoredMonth = await restoreRawCdrMonth(app.db, store, BIG_MONTH);
    console.log(
      `restore whole month from the file: ${restoredMonth.rows} rows in ${((performance.now() - restoreStart) / 1000).toFixed(1)} s (hash of every member and row, insert, partition fingerprint check)`,
    );

    // ---- 4. DETACH 的锁：两种被挡住的情形（小月份，指纹扫描很快，剩下的就是等锁）
    console.log(
      '# 3. DETACH 被挡住时对入库的影响（2026-02，2 万行；入库负载同时在跑）',
    );
    const archiveSmall = async (
      month: string,
      label: string,
      blocker: (() => Promise<() => Promise<void>>) | null,
    ) => {
      const probe = startLoad(120);
      await sleep(1500);
      let release: (() => Promise<void>) | null = null;
      if (blocker) release = await blocker();
      const marks: { detachStart?: number } = {};
      const attempt = await archiveMonth(app.db, store, month, {
        ...options,
        onCheckpoint: (point) =>
          void (point === 'marked' && (marks.detachStart = Date.now())),
      }).then(
        () => 'detached',
        (error: unknown) => `failed (${(error as Error).message})`,
      );
      const finished = Date.now();
      await sleep(500);
      if (release) await release();
      const samples = await probe.stop();
      // 窗口：从分离这一步开始（校验、清单已经做完）到它返回；加 500 ms 看尾巴。
      const window = samples
        .filter(([at]) => at >= marks.detachStart! && at <= finished + 500)
        .map(([, ms]) => ms);
      console.log(
        `${label}: detach step ${attempt} after ${finished - marks.detachStart!} ms; ingest during that window: ${summarize(window)}`,
      );
    };
    // (a) 没有阻塞者
    await archiveSmall(SMALL_MONTHS[0]!, 'no blocker', null);
    // (b) 一个读老分区的长事务：DETACH 在分区锁上等 3 秒后放弃，父表没被锁，入库不受影响
    await archiveSmall(
      SMALL_MONTHS[1]!,
      'reader of the old partition',
      async () => {
        const client = await owner.pool.connect();
        await client.query('begin');
        await client.query(`select count(*) from raw_cdrs_2026_01`);
        return async () => {
          await client.query('rollback');
          client.release();
        };
      },
    );
    // 让 (b) 的月份在读者走后能继续：清掉失败状态，再来一次（读者已释放）
    await archiveMonth(app.db, store, SMALL_MONTHS[1]!, options).catch(
      () => undefined,
    );
    // (c) 一个读当前月分区（通过父表）的长事务：持有 raw_cdrs 父表的 ACCESS SHARE，但不碰老分区。
    // 范围必须是常量（规划时剪掉老分区）；用 now() 之类的稳定表达式会锁住所有分区，就变成了 (b)。
    // DETACH 在父表锁上排队，后到的插入跟着等，最多到 lock_timeout。
    await archiveSmall(
      SMALL_MONTHS[2]!,
      'reader of raw_cdrs (current partition only, constant range)',
      async () => {
        const { rows } = await owner.pool.query<{ lo: string; hi: string }>(
          `select to_char(date_trunc('month', now() at time zone 'Asia/Shanghai'), 'YYYY-MM-DD"T"HH24:MI:SS') || '+08' as lo,
                  to_char(date_trunc('month', now() at time zone 'Asia/Shanghai') + interval '1 month', 'YYYY-MM-DD"T"HH24:MI:SS') || '+08' as hi`,
        );
        const client = await owner.pool.connect();
        await client.query('begin');
        await client.query(
          `select count(*) from raw_cdrs where received_at >= '${rows[0]!.lo}' and received_at < '${rows[0]!.hi}'`,
        );
        return async () => {
          await client.query('rollback');
          client.release();
        };
      },
    );
    await archiveMonth(app.db, store, SMALL_MONTHS[2]!, options).catch(
      () => undefined,
    );
    console.log(
      `# done; load average at the end: ${(await import('node:os'))
        .loadavg()
        .map((n) => n.toFixed(2))
        .join(' ')}`,
    );
    await rm(dir, { recursive: true, force: true });
  } else {
    throw new Error('用法：raw-archive-perf.ts seed | run');
  }
} finally {
  await owner.pool.end();
  await app.pool.end();
}
