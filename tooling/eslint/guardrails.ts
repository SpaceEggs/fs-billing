import eslintComments from '@eslint-community/eslint-plugin-eslint-comments';
import type { ESLint } from 'eslint';

const localTimeMessage =
  '禁止使用本地时区 Date 方法，改用 packages/shared/src/api/beijing-time.ts 或 packages/rating/src/time.ts（beijingDay/beijingMonth/beijingTime），或 getUTC*/Date.UTC 并显式 +08:00';

const ledgerMessage =
  '禁止直接 insert(ledgerEntries)，改用 appendLedgerEntry / appendLedgerEntries（packages/db/src/ledger.ts）';

const alertMessage =
  '禁止直接 insert(systemAlerts)，改用 raiseAlert / recoverAlert（packages/db/src/alerts.ts）';

const consoleMessage =
  '禁止 console.*，改用 pino logger（apps/api/src/logging.ts、apps/worker/src/redact.ts；错误经 packages/db/src/log-safe.ts 的 scrubErrorForLog 脱敏）';

const fetchMessage =
  '禁止直接 fetch / XMLHttpRequest，改用 apps/web/src/lib/api.ts 的 callApi / apiQuery（组件经 TanStack Query 取数）';

export const localTimeRestrictedSyntax = [
  {
    selector:
      'CallExpression[callee.property.name=/^(getHours|getDate|getMonth|getFullYear|getDay|setHours|setDate|toLocaleDateString|toDateString)$/]',
    message: localTimeMessage,
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length>=2]",
    message: localTimeMessage,
  },
];

const insertCall = (
  table: 'ledgerEntries' | 'systemAlerts',
  message: string,
) => ({
  selector: [
    `CallExpression[callee.property.name='insert'][arguments.0.name='${table}']`,
    `CallExpression[callee.property.name='insert'][arguments.0.property.name='${table}']`,
    `CallExpression[callee.name='insert'][arguments.0.name='${table}']`,
    `CallExpression[callee.name='insert'][arguments.0.property.name='${table}']`,
  ].join(', '),
  message,
});

export const ledgerRestrictedSyntax = [
  insertCall('ledgerEntries', ledgerMessage),
];

export const alertRestrictedSyntax = [insertCall('systemAlerts', alertMessage)];

export const consoleRestrictedGlobals = {
  checkGlobalObject: true,
  globalObjects: ['global'],
  globals: [{ name: 'console', message: consoleMessage }],
};

export const consoleRestrictedImports = {
  paths: [
    { name: 'console', message: consoleMessage },
    { name: 'node:console', message: consoleMessage },
  ],
};

export const fetchRestrictedGlobals = {
  checkGlobalObject: true,
  globalObjects: ['global'],
  globals: [
    { name: 'fetch', message: fetchMessage },
    { name: 'XMLHttpRequest', message: fetchMessage },
  ],
};

const requireDescription = eslintComments.rules['require-description']!;

export const eslintCommentsPlugin: ESLint.Plugin = {
  ...eslintComments,
  rules: {
    ...eslintComments.rules,
    'require-description': {
      ...requireDescription,
      meta: {
        ...requireDescription.meta,
        messages: {
          missingDescription:
            'eslint-disable 必须写明原因，改用 /* eslint-disable 规则 -- 原因 */',
        },
      },
    },
  },
};
