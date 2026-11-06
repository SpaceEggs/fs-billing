import type { Locale } from './index.js';
import { en } from './en/index.js';
import { zh } from './zh/index.js';

export type MessageParams = Readonly<Record<string, unknown>>;

const catalogs = { zh, en } as const satisfies Record<Locale, unknown>;

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/gu;

function lookup(
  catalog: unknown,
  namespace: string,
  path: string,
): string | undefined {
  let value = (catalog as Record<string, unknown>)[namespace];
  for (const part of path.split('.')) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return typeof value === 'string' ? value : undefined;
}

/**
 * 按目录键取文案：`namespace:path.to.value`，缺省命名空间为 common。
 * 占位符写成 `{{name}}`，缺失的参数原样保留，便于暴露漏传。
 * shared 只放数据；这里只做纯查表和插值，不引入 i18next。
 */
export function translate(
  locale: Locale,
  key: string,
  params?: MessageParams,
): string {
  const separator = key.indexOf(':');
  const namespace = separator === -1 ? 'common' : key.slice(0, separator);
  const path = separator === -1 ? key : key.slice(separator + 1);
  const value =
    lookup(catalogs[locale], namespace, path) ??
    lookup(catalogs.zh, namespace, path);
  if (value === undefined) return key;
  if (!params) return value;
  return value.replace(PLACEHOLDER, (match, name: string) => {
    const param = params[name];
    if (param === undefined) return match;
    return typeof param === 'string' || typeof param === 'number'
      ? String(param)
      : JSON.stringify(param);
  });
}
