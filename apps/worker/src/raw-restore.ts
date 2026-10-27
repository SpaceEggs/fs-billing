import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  ArchiveError,
  LocalArchiveStore,
  connect,
  databaseEnvironmentSchema,
  loadManifest,
  readArchivedRawCdr,
  restoreRawCdrMonth,
  stageOf,
} from '@fs-billing/db';

export interface RestoreIo {
  stdout: Writable;
  stderr: Writable;
}

const restoreEnvironment = z.object({
  APP_DATABASE_URL: databaseEnvironmentSchema.shape.APP_DATABASE_URL,
  RAW_CDR_ARCHIVE_DIR: z
    .string()
    .refine((value) => isAbsolute(value), '归档目录必须是绝对路径'),
});

const write = (stream: Writable, data: Buffer | string) =>
  new Promise<void>((resolve, reject) => {
    stream.write(data, (error) => (error ? reject(error) : resolve()));
  });

/** pnpm 会把 `--` 原样传给脚本；parseArgs 把它当成“之后全是位置参数”，所以先去掉开头的一个。 */
const normalizeArgs = (argv: readonly string[]) =>
  argv[0] === '--' ? argv.slice(1) : [...argv];

async function withContext<T>(
  env: NodeJS.ProcessEnv,
  io: RestoreIo,
  run: (context: {
    db: ReturnType<typeof connect>['db'];
    store: LocalArchiveStore;
  }) => Promise<T>,
): Promise<T | undefined> {
  const parsed = restoreEnvironment.safeParse(env);
  if (!parsed.success) {
    await write(
      io.stderr,
      `配置错误：需要 APP_DATABASE_URL 和绝对路径的 RAW_CDR_ARCHIVE_DIR（${parsed.error.issues.map((issue) => issue.path.join('.')).join('、')}）\n`,
    );
    return undefined;
  }
  const connection = connect(parsed.data.APP_DATABASE_URL, { max: 2 });
  try {
    return await run({
      db: connection.db,
      store: new LocalArchiveStore(parsed.data.RAW_CDR_ARCHIVE_DIR),
    });
  } finally {
    await connection.pool.end();
  }
}

/** 错误信息只含归档自己写的文字，不含原文；其他错误只报名称。 */
const messageOf = (error: unknown) =>
  error instanceof ArchiveError
    ? error.message
    : `${error instanceof Error ? error.name : '未知错误'}（详见 Worker 日志或数据库）`;

/**
 * 只读取回一条原始话单：校验成员哈希和原文哈希后，把 body 的 UTF-8 字节原样写到标准输出（或 --out 文件），
 * 不加换行。不写数据库，不写操作日志。退出码 0 成功，1 失败（哈希对不上时不输出任何内容）。
 */
export async function runRestoreSingle(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: RestoreIo,
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: normalizeArgs(argv),
      options: {
        id: { type: 'string' },
        'received-at': { type: 'string' },
        out: { type: 'string' },
      },
      strict: true,
    }));
  } catch (error) {
    await write(io.stderr, `${messageOf(error)}\n`);
    return 2;
  }
  if (!values.id || !values['received-at']) {
    await write(
      io.stderr,
      '用法：raw:restore -- --id <uuid> --received-at <时间> [--out <文件>]\n  received-at 用 raw_cdrs.received_at 的完整微秒时间，如 2026-03-14T08:21:09.123456Z\n',
    );
    return 2;
  }
  const query = { id: values.id, receivedAt: values['received-at'] };
  const result = await withContext(env, io, async ({ db, store }) => {
    try {
      const restored = await readArchivedRawCdr(db, store, query);
      if (values.out)
        await writeFile(values.out, restored.bytes, {
          flag: 'wx',
          mode: 0o600,
        });
      else await write(io.stdout, restored.bytes);
      return 0;
    } catch (error) {
      await write(io.stderr, `恢复失败：${messageOf(error)}\n`);
      return 1;
    }
  });
  return result ?? 2;
}

/**
 * 整月恢复（运维脚本）：宽限期内把 …_archived 挂回，或从归档文件重建已丢弃的分区；
 * 校验哈希与分区指纹，不符整体回滚。--dry-run 只报告清单里这个月的状态。
 */
export async function runRestoreMonth(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: RestoreIo,
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: normalizeArgs(argv),
      options: { month: { type: 'string' }, 'dry-run': { type: 'boolean' } },
      strict: true,
    }));
  } catch (error) {
    await write(io.stderr, `${messageOf(error)}\n`);
    return 2;
  }
  const match = /^(\d{4}-(?:0[1-9]|1[0-2]))$/.exec(values.month ?? '');
  if (!match) {
    await write(
      io.stderr,
      '用法：raw:restore-month -- --month <YYYY-MM> [--dry-run]\n',
    );
    return 2;
  }
  const month = `${match[1]}-01`;
  const result = await withContext(env, io, async ({ db, store }) => {
    try {
      if (values['dry-run']) {
        const manifest = await loadManifest(db, month);
        await write(
          io.stdout,
          manifest
            ? `${match[1]}：${stageOf(manifest)}，${manifest.rows ?? 0} 行，文件 ${manifest.fileKey ?? '-'}\n`
            : `${match[1]}：清单里没有\n`,
        );
        return 0;
      }
      const summary = await restoreRawCdrMonth(db, store, month);
      await write(
        io.stdout,
        `${match[1]} 已恢复（${summary.method === 'reattached' ? '挂回宽限期内的分区' : '从归档文件重建'}），${summary.rows} 行；30 天内不再归档该月\n`,
      );
      return 0;
    } catch (error) {
      await write(io.stderr, `恢复失败：${messageOf(error)}\n`);
      return 1;
    }
  });
  return result ?? 2;
}
