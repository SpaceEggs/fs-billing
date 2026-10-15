import { sql } from 'drizzle-orm';
import type { Tx } from './client.js';
import { tenants } from './schema.js';

export async function databaseNow(tx: Tx): Promise<Date> {
  const [instant] = await tx
    .select({ at: sql`clock_timestamp()`.mapWith(tenants.createdAt) })
    .from(sql`(select 1) as clock`);
  if (!instant) throw new Error('数据库未返回时间');
  return instant.at;
}
