import { z } from 'zod';
import { DEFAULT_LOCALE, LOCALES } from '../i18n/index.js';

export const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';

/** 导出请求的语言；缺省中文，非法值让请求 schema 返回 400。 */
export const exportLocaleSchema = z.enum(LOCALES).default(DEFAULT_LOCALE);

/** 账单汇总导出没有筛选，只带语言；没有 body 时由契约层按可选处理。 */
export const exportLocaleRequestSchema = z.strictObject({
  locale: exportLocaleSchema,
});

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
