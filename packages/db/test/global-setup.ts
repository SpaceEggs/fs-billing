import { existsSync } from 'node:fs';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { connect, databaseEnvironmentSchema } from '../src/client.js';
import { migrateDatabase } from '../src/migrate.js';
import { seedDatabase } from '../src/seed.js';

const TEST_DATABASE = 'fs_billing_test';

declare module 'vitest' {
  export interface ProvidedContext {
    ownerUrl: string;
    appUrl: string;
  }
}

function onDatabase(url: string, database: string): string {
  const next = new URL(url);
  next.pathname = `/${database}`;
  return next.toString();
}

/** 每次运行都在全新的 fs_billing_test 库上执行与 pnpm db:migrate、pnpm db:seed 相同的代码。 */
export default async function setup(project: TestProject) {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const env = databaseEnvironmentSchema.parse(process.env);

  const admin = new pg.Client({ connectionString: env.DATABASE_URL });
  try {
    await admin.connect();
  } catch (error) {
    throw new Error(
      `pnpm test:db 需要 PostgreSQL（${new URL(env.DATABASE_URL).host}）：先执行 pnpm db:up`,
      { cause: error },
    );
  }
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
  await admin.end();

  const testEnv = {
    DATABASE_URL: onDatabase(env.DATABASE_URL, TEST_DATABASE),
    APP_DATABASE_URL: onDatabase(env.APP_DATABASE_URL, TEST_DATABASE),
  };
  await migrateDatabase(testEnv);
  const { db, pool } = connect(testEnv.DATABASE_URL);
  await seedDatabase(db);
  await pool.end();

  project.provide('ownerUrl', testEnv.DATABASE_URL);
  project.provide('appUrl', testEnv.APP_DATABASE_URL);
}
