import { DEFAULT_ADMIN_CSV_MAX_BYTES } from '@fs-billing/shared';

/** 「下载 CSV 模板」：UTF-8 带 BOM（Excel 才能认出中文），CRLF 换行，表头加一行示例。 */
export const rateCsvTemplate = {
  filename: '费率模板.csv',
  text: '\uFEFF前缀,国家,费率\r\n1,美国,0.0500\r\n',
};

export function csvTooLarge(bytes: number) {
  return bytes > DEFAULT_ADMIN_CSV_MAX_BYTES;
}

/** 原样保留字节，由服务端识别 UTF-8 / GBK。 */
export async function fileToBase64(file: Blob) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk)
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  return btoa(binary);
}

/**
 * 与服务端相同的解码与分行：先 UTF-8 后 GBK，都严格解码（不静默替换坏字节）；
 * 去掉 BOM 后按 `\r?\n` 分行，第 n 行即服务端错误里的 `line: n`（表头算第 1 行）。
 * 两种编码都失败时返回 null。
 */
export function decodeCsvLines(bytes: Uint8Array): string[] | null {
  for (const encoding of ['utf-8', 'gbk']) {
    try {
      return new TextDecoder(encoding, { fatal: true })
        .decode(bytes)
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/);
    } catch {
      // 换下一种编码。
    }
  }
  return null;
}

/** 错误列表的「原始内容」，只用于显示；取不到或为空行时为「—」。 */
export function csvRawLine(lines: readonly string[] | null, line: number) {
  return lines?.[line - 1] || '—';
}
