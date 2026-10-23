import { readFileSync } from 'node:fs';

/**
 * 号码归一化的共用用例（freeswitch/tests/dialed-cases.tsv）的读取。
 * packages/rating/src/dialed.test.ts 与 tests/dialed-cases.test.ts 用它；Lua 测试读同一个文件，
 * 转义规则必须与 billing_authorize_test.lua 里的 unescape 一致。
 */
export type DialedCase =
  | {
      readonly kind: 'valid';
      readonly dialed: string;
      readonly billing: string;
    }
  | { readonly kind: 'invalid'; readonly dialed: string };

export const DIALED_CASES_PATH = new URL(
  '../freeswitch/tests/dialed-cases.tsv',
  import.meta.url,
);

const ESCAPES: Readonly<Record<string, string>> = {
  t: '\t',
  n: '\n',
  r: '\r',
  s: ' ',
  e: '',
  '\\': '\\',
};

/** 还原字段里的转义；未知转义和结尾的单个反斜杠都报错。 */
export function unescapeField(field: string): string {
  return field.replace(/\\([\s\S]?)/g, (_, char: string) => {
    const value = ESCAPES[char];
    if (value === undefined) throw new Error(`未知转义 \\${char}`);
    return value;
  });
}

export function parseDialedCases(text: string): DialedCase[] {
  const cases: DialedCase[] = [];
  text.split('\n').forEach((line, index) => {
    if (line === '' || line.startsWith('#')) return;
    const where = `第 ${index + 1} 行`;
    const fields = line.split('\t');
    const [kind, dialed, billing] = fields;
    if (kind === 'valid' && fields.length === 3) {
      cases.push({
        kind,
        dialed: unescapeField(dialed ?? ''),
        billing: unescapeField(billing ?? ''),
      });
    } else if (kind === 'invalid' && fields.length === 2) {
      cases.push({ kind, dialed: unescapeField(dialed ?? '') });
    } else {
      throw new Error(`${where}格式不对：${JSON.stringify(line)}`);
    }
  });
  return cases;
}

export function loadDialedCases(): DialedCase[] {
  return parseDialedCases(readFileSync(DIALED_CASES_PATH, 'utf8'));
}

export function validCases(cases: readonly DialedCase[]) {
  return cases.flatMap((c) => (c.kind === 'valid' ? [c] : []));
}

export function invalidCases(cases: readonly DialedCase[]) {
  return cases.flatMap((c) => (c.kind === 'invalid' ? [c] : []));
}
