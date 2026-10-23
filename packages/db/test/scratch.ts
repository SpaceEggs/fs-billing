import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, inject } from 'vitest';
import { connect, type Connection } from '../src/client.js';
import { migrateDatabase } from '../src/migrate.js';
import { seedDatabase } from '../src/seed.js';

/**
 * 单独的库：测试要提交会改变种子数字的操作（例如把 ABC01 的 326 条分配给 ABC001），
 * 不能写进共享测试库，否则阶段 7 的 −35.20 等数字会被后面的测试看到变了。
 * 在 beforeAll 里迁移（和播种），afterAll 里删库；每个测试文件各用各的。
 */
export function scratchDatabase(options: { seed: boolean }): {
  readonly app: Connection;
  readonly owner: Connection;
} {
  const state: { app?: Connection; owner?: Connection } = {};
  const name = `fs_billing_ops_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const urlFor = (source: string, database: string) => {
    const url = new URL(source);
    url.pathname = `/${database}`;
    return url.toString();
  };

  beforeAll(async () => {
    const admin = new pg.Client({
      connectionString: urlFor(inject('ownerUrl'), 'postgres'),
    });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${name}`);
    } finally {
      await admin.end();
    }
    const ownerUrl = urlFor(inject('ownerUrl'), name);
    const appUrl = urlFor(inject('appUrl'), name);
    await migrateDatabase({
      DATABASE_URL: ownerUrl,
      APP_DATABASE_URL: appUrl,
    });
    state.owner = connect(ownerUrl);
    state.app = connect(appUrl);
    if (options.seed) await seedDatabase(state.owner.db);
  }, 180_000);

  afterAll(async () => {
    await state.app?.pool.end();
    await state.owner?.pool.end();
    const admin = new pg.Client({
      connectionString: urlFor(inject('ownerUrl'), 'postgres'),
    });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  return {
    get app() {
      if (!state.app) throw new Error('临时库还没有建好（beforeAll 之前）');
      return state.app;
    },
    get owner() {
      if (!state.owner) throw new Error('临时库还没有建好（beforeAll 之前）');
      return state.owner;
    },
  };
}
