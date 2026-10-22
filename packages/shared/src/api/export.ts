import { z } from 'zod';

export const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';

/**
 * CSV 导出的成功响应是分块写出的原始 CSV 文本，不是 JSON。路由用 reply.hijack() 直接写 socket，
 * 绕过响应序列化；这里的 string 只让契约登记 200 的媒体类型。
 */
export const csvExportResponseSchema = z.string();

type ExportKind = 'cdrs' | 'ledger' | 'statement';

/** 租户编码只含字母和数字，文件名全是 ASCII，Content-Disposition 不需要 filename*。 */
export function exportFilename(
  kind: ExportKind,
  tenantCode: string,
  range: { from: string; to: string },
): string {
  return `${kind}_${tenantCode}_${range.from}_${range.to}.csv`;
}

export function contentDisposition(filename: string): string {
  return `attachment; filename="${filename}"`;
}
