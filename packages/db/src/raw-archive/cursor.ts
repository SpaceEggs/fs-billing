import { sql } from 'drizzle-orm';
import type { Tx } from '../client.js';

export interface ExportRow {
  id: string;
  /** `YYYY-MM-DDTHH:MM:SS.ffffffZ`，数据库按文本给出。 */
  receivedAt: string;
  /** 数据库算的 sha256(convert_to(body, 'UTF8'))。 */
  sha256: string;
  bodyBytes: number;
  /** hashtextextended(id::text || body, 0)，64 位整数的十进制文本。 */
  rowHash: string;
  /** tenant_id 或 call_uuid 非空：归档格式不含这两列，不能静默丢掉。 */
  linked: boolean;
  /** 校验游标（withBody = false）没有原文。 */
  body: string | null;
}

interface RawExportRow extends Record<string, unknown> {
  id: string;
  received_at: string;
  sha256: string;
  body_bytes: string;
  row_hash: string;
  linked: boolean;
  body: string | null;
}

/** 每次 FETCH 的行数：原文最大约 1 MiB，一批最多几十 MB。 */
const FETCH_ROWS = 100;

/**
 * 在调用方的 REPEATABLE READ 只读事务里打开 raw_cdrs_export_cursor（SECURITY DEFINER，直接按分区名读，
 * 不碰父表），分批 FETCH，行按 (received_at, id) 排序。
 */
export async function* exportRows(
  tx: Tx,
  month: string,
  withBody: boolean,
): AsyncGenerator<ExportRow[]> {
  await tx.execute(
    sql`select raw_cdrs_export_cursor(${month}::date, ${withBody})`,
  );
  for (;;) {
    const { rows } = await tx.execute<RawExportRow>(
      sql.raw(`FETCH FORWARD ${FETCH_ROWS} FROM raw_cdrs_export`),
    );
    if (rows.length === 0) break;
    yield rows.map((row) => ({
      id: row.id,
      receivedAt: row.received_at,
      sha256: row.sha256,
      bodyBytes: Number(row.body_bytes),
      rowHash: row.row_hash,
      linked: row.linked,
      body: row.body,
    }));
  }
  await tx.execute(sql.raw('CLOSE raw_cdrs_export'));
}
