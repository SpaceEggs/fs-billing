#!/usr/bin/env node
// Drive one mapped feature of a launched run through the real browser path.
// Usage: drive.mjs <feature|all> [--headed]
//   features: customer-login admin-login login-errors session-expiry cross-tenant
//             logout theme-and-mobile not-found
// Evidence: docs/evidence/verify-fs-billing/<RUN_ID>/<feature>/ (steps.md, result.json,
//           *.png, *.aria.yml, browser-http.txt, *.sql.txt). Exit 0 PASS, 1 FAIL, 2 precondition missing.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url));
const repo = execFileSync(
  'git',
  ['-C', scripts, 'rev-parse', '--show-toplevel'],
  { encoding: 'utf8' },
).trim();
const stateRoot =
  process.env.VERIFY_STATE_ROOT ??
  join(process.env.TMPDIR ?? '/tmp', 'verify-fs-billing');
const runId =
  process.env.VERIFY_RUN_ID ??
  readFileSync(join(stateRoot, 'current'), 'utf8').trim();
const state = join(stateRoot, runId);
const env = Object.fromEntries(
  readFileSync(join(state, 'run.env'), 'utf8')
    .split('\n')
    .filter((line) => line.includes('='))
    .map((line) => [
      line.slice(0, line.indexOf('=')),
      line.slice(line.indexOf('=') + 1),
    ]),
);
// Playwright is a devDependency of apps/web; resolve it from there.
const { chromium, expect } = createRequire(join(repo, 'apps/web/package.json'))(
  '@playwright/test',
);

const feature = process.argv[2];
const headed = process.argv.includes('--headed');
const web = env.VERIFY_WEB_ORIGIN;
const password = env.SEED_AUTH_PASSWORD;
const out = join(
  repo,
  'docs/evidence/verify-fs-billing',
  runId,
  feature ?? 'none',
);
const secrets = [
  'BETTER_AUTH_SECRET',
  'SEED_AUTH_PASSWORD',
  'PG_OWNER_PASSWORD',
  'PG_APP_PASSWORD',
  'PG_AUTH_PASSWORD',
]
  .map((key) => env[key])
  .filter(Boolean);
// Keep in sync with VERIFY_SENSITIVE_JSON in lib.sh.
const sensitiveJsonFields =
  /("(?:password|currentPassword|newPassword|temporaryPassword|token|secret)"\s*:\s*")(?:[^"\\]|\\.)*"/g;
const redact = (text) =>
  secrets
    .reduce((acc, secret) => acc.split(secret).join('[REDACTED]'), String(text))
    .replace(/(session_token=)[^;\s"]+/g, '$1[REDACTED]')
    .replace(sensitiveJsonFields, '$1[REDACTED]"');
const httpLog = 'browser-http.txt';
const credentialStamp = join(state, 'credential-at');
const credentialPaths = new Set([
  '/api/auth/login',
  '/api/auth/change-password',
]);
// The API allows 30 credential requests per minute per IP in a fixed window that opens at
// the first request. 61 s after the last one, the window has reset.
const rateLimitWindowMs = 61_000;

class Precondition extends Error {}
const steps = [];
function write(name, content) {
  writeFileSync(join(out, name), redact(content));
}
function sql(name, query) {
  const result = execFileSync(join(scripts, 'sql.sh'), [query], {
    encoding: 'utf8',
    env: { ...process.env, VERIFY_RUN_ID: runId },
  });
  write(`${name}.sql.txt`, `-- ${query}\n${result}`);
  return result;
}
/** Single value from the run's DB, through sql.sh's container guards. */
function scalar(query) {
  return execFileSync(join(scripts, 'sql.sh'), ['--value', query], {
    encoding: 'utf8',
    env: { ...process.env, VERIFY_RUN_ID: runId },
  }).trim();
}
function api(name, args) {
  const result = execFileSync(join(scripts, 'api.sh'), args, {
    encoding: 'utf8',
    env: { ...process.env, VERIFY_RUN_ID: runId },
  });
  write(`${name}.http`, result);
  const status = Number(/^HTTP\/1\.1 (\d+)/m.exec(result)?.[1]);
  const bodyText = result.trim().split('\n').at(-1);
  try {
    return { status, body: JSON.parse(bodyText) };
  } catch {
    return { status, body: null };
  }
}
/** Repo command through with-env.sh (run env wins over the root .env); output is redacted. */
function cli(name, args) {
  let result;
  try {
    result = execFileSync(join(scripts, 'with-env.sh'), args, {
      encoding: 'utf8',
      env: { ...process.env, VERIFY_RUN_ID: runId },
    });
  } catch (error) {
    write(`${name}.cli.txt`, `$ ${args.join(' ')}\n${error.stdout ?? ''}`);
    throw new Error(`${args.join(' ')} exited ${error.status}`, {
      cause: error,
    });
  }
  write(`${name}.cli.txt`, `$ ${args.join(' ')}\n${result}`);
  return result;
}
/** The page the journey last opened or acted on; steps capture it before and after. */
let focus;
async function capture(name) {
  if (!focus || focus.isClosed() || focus.url() === 'about:blank') return;
  try {
    await aria(focus, name);
    await shot(focus, name);
  } catch (error) {
    write(`${name}.capture-error.txt`, String(error?.message ?? error));
  }
}
async function step(id, action, fn) {
  const started = Date.now();
  const prefix = `s${String(steps.length + 1).padStart(2, '0')}-${id}`;
  await capture(`${prefix}-before`);
  try {
    const detail = await fn();
    steps.push({
      id,
      action,
      result: 'PASS',
      detail: detail ?? '',
      ms: Date.now() - started,
    });
  } catch (error) {
    steps.push({
      id,
      action,
      result: error instanceof Precondition ? 'BLOCKED' : 'FAIL',
      detail: String(error?.message ?? error)
        .split('\n')
        .slice(0, 6)
        .join(' / '),
      ms: Date.now() - started,
    });
    throw error;
  } finally {
    await capture(`${prefix}-after`);
  }
}

let browser;
async function newPage(options = {}) {
  const context = await browser.newContext({
    baseURL: web,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    ...options,
  });
  const page = await context.newPage();
  focus = page;
  page.on('request', (request) => {
    if (credentialPaths.has(new URL(request.url()).pathname))
      writeFileSync(credentialStamp, String(Math.floor(Date.now() / 1000)));
  });
  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith('/api/')) return;
    let body;
    try {
      body = await response.text();
    } catch (error) {
      body = `<body unavailable: ${error?.message ?? error}>`;
    }
    const sent = response.request().postData();
    const shown = sent ?? '';
    appendFileSync(
      join(out, httpLog),
      redact(
        `${new Date().toISOString()} ${response.request().method()} ${url.pathname}${url.search} ${shown} -> ${response.status()} ${body}\n`,
      ),
    );
  });
  return page;
}
async function shot(page, name) {
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
}
async function aria(page, name, locator = page.locator('body')) {
  write(`${name}.aria.yml`, await locator.ariaSnapshot());
}
function path(page) {
  const url = new URL(page.url());
  return `${url.pathname}${url.search}`;
}
async function expectPath(page, expected) {
  focus = page;
  await expect.poll(() => path(page), { timeout: 10_000 }).toBe(expected);
}
/** Fill and submit the login form; resolves with the /api/auth/login response. */
async function submitLogin(page, email, secret = password) {
  focus = page;
  await page.getByLabel('登录邮箱').fill(email);
  await page.getByLabel('密码', { exact: true }).fill(secret);
  const response = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/auth/login' &&
      r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '登录', exact: true }).click();
  return response;
}
async function loginAs(page, loginPath, email) {
  await page.goto(loginPath);
  const response = await submitLogin(page, email);
  if (response.status() !== 200)
    throw new Error(
      `login ${email} -> ${response.status()} ${await response.text()}`,
    );
}
const sessionsOf = (email) =>
  `SELECT count(*) FROM auth.session s JOIN auth."user" u ON u.id = s.user_id WHERE u.email = '${email}' AND s.expires_at > now()`;
function requireUnlocked(email) {
  const row = scalar(
    `SELECT coalesce(max(locked_until)::text, '') FROM auth.login_failures WHERE email_key = '${email}' AND locked_until > now()`,
  );
  if (row)
    throw new Precondition(
      `${email} is locked until ${row}; run auth:unlock (see login-errors.md) or relaunch`,
    );
}

const journeys = {
  async 'customer-login'() {
    requireUnlocked('abc001@example.com');
    const page = await newPage();
    await step('entry-redirect', 'visit / signed out', async () => {
      await page.goto('/');
      await expectPath(page, '/login');
      await expect(
        page.getByRole('heading', { name: '登录', exact: true }),
      ).toBeVisible();
      await aria(page, '01-login-form');
      await shot(page, '01-login-form');
      return 'redirected to /login, heading 登录';
    });
    await step(
      'portal-login',
      'submit abc001@example.com + seeded password on /login',
      async () => {
        const response = await submitLogin(page, 'abc001@example.com');
        expect(response.status()).toBe(200);
        const body = await response.json();
        expect(body.identity.kind).toBe('customer');
        expect(body.identity.tenant.code).toBe('ABC001');
        await expectPath(page, '/');
        return `POST /api/auth/login 200 kind=customer tenant=ABC001`;
      },
    );
    await step(
      'balance',
      'portal home shows tenant crumb and balance',
      async () => {
        await expect(page.getByRole('heading', { name: '首页' })).toBeVisible();
        await expect(
          page.getByText('ABC001 · 深圳市某某科技有限公司'),
        ).toBeVisible();
        const region = page.getByRole('region', { name: '当前余额' });
        await expect(region).toContainText('-¥35.20');
        await expect(region).toContainText('CNY');
        await expect(page.locator('html')).toHaveAttribute(
          'data-product',
          'portal',
        );
        await aria(page, '02-portal-home');
        await shot(page, '02-portal-home');
        return 'region 当前余额 = -¥35.20 CNY';
      },
    );
    await step(
      'db-side-effects',
      'session row exists and DB balance matches UI',
      async () => {
        const result = sql(
          '03-session-and-balance',
          `SELECT u.email, s.expires_at > now() + interval '6 days' AS week_ttl, s.ip_address, (SELECT to_char(b.balance,'FM999999990.00') FROM tenant_balances b JOIN tenants t ON t.id=b.tenant_id WHERE t.code='ABC001') AS db_balance FROM auth.session s JOIN auth."user" u ON u.id=s.user_id WHERE u.email='abc001@example.com' ORDER BY s.created_at DESC LIMIT 1`,
        );
        expect(result).toMatch(/abc001@example\.com \| t\s+\|.*\| -35\.20/);
        return 'auth.session row (7-day TTL) for abc001; tenant_balances ABC001 = -35.20';
      },
    );
    await step(
      'usd-balance',
      'USD tenant glb009 sees dollar balance',
      async () => {
        const usd = await newPage();
        await loginAs(usd, '/login', 'glb009@example.com');
        await expect(
          usd.getByRole('region', { name: '当前余额' }),
        ).toContainText('-$15.02');
        await shot(usd, '04-usd-home');
        return 'region 当前余额 = -$15.02';
      },
    );
  },

  async 'admin-login'() {
    requireUnlocked('wangmin@example.com');
    requireUnlocked('abc001@example.com');
    await step('entry-redirect', 'visit /admin signed out', async () => {
      const page = await newPage();
      await page.goto('/admin');
      await expectPath(page, '/admin/login');
      await expect(
        page.getByRole('heading', { name: '登录管理后台' }),
      ).toBeVisible();
      await expect(page.getByText('客户请使用客户门户登录')).toBeVisible();
      await aria(page, '01-admin-login');
      await shot(page, '01-admin-login');
    });
    await step(
      'admin-shell',
      'wangmin@example.com logs in on /admin/login',
      async () => {
        const page = await newPage();
        await loginAs(page, '/admin/login', 'wangmin@example.com');
        await expectPath(page, '/admin');
        await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
        await expect(
          page.getByRole('button', { name: '账号菜单' }),
        ).toContainText('王敏');
        await expect(page.getByText('欢迎，王敏。')).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute(
          'data-product',
          'admin',
        );
        await aria(page, '02-admin-home');
        await shot(page, '02-admin-home');
        expect(
          Number(scalar(sessionsOf('wangmin@example.com'))),
        ).toBeGreaterThan(0);
        sql(
          '02-admin-session',
          `SELECT u.email, a.name AS admin_profile, s.expires_at > now() AS live FROM auth.session s JOIN auth."user" u ON u.id=s.user_id JOIN admins a ON a.auth_user_id=u.id WHERE u.email='wangmin@example.com'`,
        );
      },
    );
    await step(
      'kind-decides-zone',
      'customer abc001 logs in on /admin/login, then visits /admin',
      async () => {
        const page = await newPage();
        await loginAs(page, '/admin/login', 'abc001@example.com');
        await expectPath(page, '/');
        await expect(page.getByRole('heading', { name: '首页' })).toBeVisible();
        await page.goto('/admin');
        await expectPath(page, '/');
        await shot(page, '03-customer-via-admin-login');
        return 'landed on / (portal), /admin bounces to /';
      },
    );
    await step(
      'admin-via-portal-login',
      'admin logs in on /login',
      async () => {
        const page = await newPage();
        await loginAs(page, '/login', 'wangmin@example.com');
        await expectPath(page, '/admin');
      },
    );
  },

  async 'login-errors'() {
    const lockTarget = 'hzx014@example.com';
    requireUnlocked('abc001@example.com');
    requireUnlocked(lockTarget);
    if (
      scalar(
        `SELECT count(*) FROM auth.login_failures WHERE email_key='${lockTarget}'`,
      ) !== '0'
    )
      throw new Precondition(
        `${lockTarget} already has a failure counter; run auth:unlock first`,
      );
    const page = await newPage();
    await page.goto('/login');
    let unknown;
    await step(
      'same-message',
      'unknown email vs wrong password give identical status, code, message',
      async () => {
        const a = await submitLogin(
          page,
          'nobody-verify@example.com',
          'wrong-password-verify',
        );
        await expect(
          page.getByRole('button', { name: '登录', exact: true }),
        ).toBeEnabled();
        await expect(page.getByRole('alert')).toHaveText(
          '登录邮箱或密码错误请检查后重新输入',
        );
        unknown = { status: a.status(), ...(await a.json()).error };
        await shot(page, '01-unknown-email');
        const b = await submitLogin(
          page,
          'abc001@example.com',
          'wrong-password-verify',
        );
        await expect(
          page.getByRole('button', { name: '登录', exact: true }),
        ).toBeEnabled();
        await expect(page.getByRole('alert')).toHaveText(
          '登录邮箱或密码错误请检查后重新输入',
        );
        const wrong = { status: b.status(), ...(await b.json()).error };
        await shot(page, '02-wrong-password');
        expect([wrong.status, wrong.code, wrong.message]).toEqual([
          unknown.status,
          unknown.code,
          unknown.message,
        ]);
        expect(wrong.status).toBe(401);
        sql(
          '03-counters-after-one-failure',
          `SELECT email_key, failed_count, locked_until FROM auth.login_failures WHERE email_key IN ('nobody-verify@example.com','abc001@example.com') ORDER BY 1`,
        );
        const counters = scalar(
          `SELECT string_agg(email_key || '=' || failed_count || '/' || (locked_until IS NULL), ',' ORDER BY email_key) FROM auth.login_failures WHERE email_key IN ('nobody-verify@example.com','abc001@example.com')`,
        );
        expect(counters).toBe(
          'abc001@example.com=1/true,nobody-verify@example.com=1/true',
        );
        return `both ${wrong.status} ${wrong.code} "${wrong.message}"`;
      },
    );
    await step(
      'clear-abc001',
      'correct password clears abc001 counter',
      async () => {
        const ok = await submitLogin(page, 'abc001@example.com');
        expect(ok.status()).toBe(200);
        expect(
          scalar(
            `SELECT count(*) FROM auth.login_failures WHERE email_key='abc001@example.com'`,
          ),
        ).toBe('0');
        cli('04-unlock-unknown', [
          'pnpm',
          '--filter',
          '@fs-billing/api',
          'auth:unlock',
          'nobody-verify@example.com',
        ]);
      },
    );
    const lock = await newPage();
    await step(
      'lockout',
      `5 wrong passwords for ${lockTarget} lock the account`,
      async () => {
        await lock.goto('/login');
        const seen = [];
        for (let attempt = 1; attempt <= 5; attempt += 1) {
          const r = await submitLogin(
            lock,
            lockTarget,
            `wrong-password-${attempt}`,
          );
          const body = await r.json();
          seen.push(
            `${attempt}:${r.status()} ${body.error.code}${body.error.retryAfterSeconds ? ` retry=${body.error.retryAfterSeconds}` : ''}`,
          );
          if (attempt < 5) {
            expect([r.status(), body.error.code]).toEqual([
              401,
              'INVALID_CREDENTIALS',
            ]);
            await expect(
              lock.getByRole('button', { name: '登录', exact: true }),
            ).toBeEnabled();
          } else {
            expect([r.status(), body.error.code]).toEqual([
              429,
              'ACCOUNT_LOCKED',
            ]);
            expect(body.error.retryAfterSeconds).toBeGreaterThan(850);
          }
        }
        const alert = lock.getByRole('alert');
        await expect(alert).toContainText('登录失败次数过多，已暂时锁定');
        await expect(alert).toContainText(/请在 1[45]分\d{2}秒 后重试/);
        const wait = lock.getByRole('button', {
          name: /^请在 \d+分\d{2}秒 后重试$/,
        });
        await expect(wait).toBeDisabled();
        await expect(lock.getByLabel('登录邮箱')).toBeDisabled();
        const first = await wait.textContent();
        await lock.waitForTimeout(2200);
        const second = await wait.textContent();
        expect(second).not.toBe(first);
        await aria(lock, '05-locked');
        await shot(lock, '05-locked');
        const row = sql(
          '06-lock-counter',
          `SELECT email_key, failed_count, locked_until > now() + interval '14 minutes' AS locked_15m FROM auth.login_failures WHERE email_key='${lockTarget}'`,
        );
        expect(row).toMatch(/hzx014@example\.com \|\s+5 \| t/);
        return `${seen.join(', ')}; countdown "${first}" -> "${second}"; counter failed_count=5`;
      },
    );
    await step(
      'locked-correct-password',
      'correct password while locked is still refused',
      async () => {
        const r = api('07-locked-correct-password', [
          'login',
          lockTarget,
          'locked',
        ]);
        expect([r.status, r.body?.error?.code]).toEqual([
          429,
          'ACCOUNT_LOCKED',
        ]);
        return `429 ACCOUNT_LOCKED retryAfterSeconds=${r.body.error.retryAfterSeconds}`;
      },
    );
    await step(
      'emergency-unlock',
      'owner runs auth:unlock; counter row deleted; login works',
      async () => {
        const output = cli('08-auth-unlock', [
          'pnpm',
          '--filter',
          '@fs-billing/api',
          'auth:unlock',
          lockTarget,
        ]);
        expect(output).toContain('解除锁定计数 1 行');
        expect(
          scalar(
            `SELECT count(*) FROM auth.login_failures WHERE email_key='${lockTarget}'`,
          ),
        ).toBe('0');
        sql(
          '09-counter-after-unlock',
          `SELECT count(*) AS counter_rows FROM auth.login_failures WHERE email_key='${lockTarget}'`,
        );
        await lock.reload();
        const r = await submitLogin(lock, lockTarget);
        expect(r.status()).toBe(200);
        await expectPath(lock, '/');
        await expect(
          lock.getByText('HZX014 · 杭州星讯通信有限公司'),
        ).toBeVisible();
        await shot(lock, '10-after-unlock');
        return output.trim().split('\n').at(-1);
      },
    );
    await step(
      'disabled',
      'disabled tenant cdt018 sees the disabled message, no session kept',
      async () => {
        const page2 = await newPage();
        await page2.goto('/login');
        const r = await submitLogin(page2, 'cdt018@example.com');
        expect([r.status(), (await r.json()).error.code]).toEqual([
          403,
          'ACCOUNT_DISABLED',
        ]);
        await expect(page2.getByRole('alert')).toContainText('该账号已停用');
        await expect(page2.getByRole('alert')).toContainText(
          '如需恢复使用，请联系客服',
        );
        await shot(page2, '11-disabled');
        expect(scalar(sessionsOf('cdt018@example.com'))).toBe('0');
        sql(
          '12-disabled-state',
          `SELECT t.code, t.status, (SELECT count(*) FROM auth.session s JOIN auth."user" u ON u.id=s.user_id WHERE u.email='cdt018@example.com') AS sessions FROM tenants t WHERE t.code='CDT018'`,
        );
        return '403 ACCOUNT_DISABLED; 0 session rows';
      },
    );
  },

  async 'session-expiry'() {
    requireUnlocked('abc001@example.com');
    requireUnlocked('lijun@example.com');
    await step(
      'expired-redirect',
      'expired session + deep link with query -> login -> back to the same URL',
      async () => {
        const page = await newPage();
        await loginAs(page, '/login', 'abc001@example.com');
        await expectPath(page, '/');
        sql(
          '01-expire-sessions',
          `UPDATE auth.session SET expires_at = now() - interval '1 minute' WHERE user_id = (SELECT id FROM auth."user" WHERE email='abc001@example.com') RETURNING expires_at < now() AS expired`,
        );
        await page.goto('/?tab=ledger&type=%E5%85%85%E5%80%BC');
        await expectPath(page, '/login?reason=expired');
        const banner = page.getByRole('status');
        await expect(banner).toContainText('登录已过期，请重新登录');
        await expect(banner).toContainText('登录后将返回之前的页面');
        await aria(page, '02-expired-banner');
        await shot(page, '02-expired-banner');
        await submitLogin(page, 'abc001@example.com');
        await expectPath(page, '/?tab=ledger&type=%E5%85%85%E5%80%BC');
        await expect(page.getByRole('heading', { name: '首页' })).toBeVisible();
        await shot(page, '03-returned');
      },
    );
    await step(
      'revoked-dialog',
      'session deleted while on /admin?view=verify -> dialog -> re-login returns',
      async () => {
        const page = await newPage();
        await loginAs(page, '/admin/login', 'lijun@example.com');
        await expectPath(page, '/admin');
        await page.goto('/admin?view=verify');
        await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
        sql(
          '04-revoke-sessions',
          `DELETE FROM auth.session WHERE user_id = (SELECT id FROM auth."user" WHERE email='lijun@example.com') RETURNING 'revoked' AS result`,
        );
        // Stand-in for the user returning to the tab: React Query refetches on visibilitychange.
        await page.evaluate(() =>
          document.dispatchEvent(
            new Event('visibilitychange', { bubbles: true }),
          ),
        );
        const dialog = page.getByRole('dialog', {
          name: '登录已过期，请重新登录',
        });
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText('登录后将回到当前页面');
        await aria(page, '05-expired-dialog', dialog);
        await shot(page, '05-expired-dialog');
        await dialog.getByRole('button', { name: '重新登录' }).click();
        await expectPath(page, '/admin/login?reason=expired');
        await submitLogin(page, 'lijun@example.com');
        await expectPath(page, '/admin?view=verify');
        await shot(page, '06-returned');
      },
    );
    await step(
      'cross-zone-fallback',
      'remembered /admin path + customer login falls back to /',
      async () => {
        const page = await newPage();
        await page.goto('/admin?from=portal-user');
        await expectPath(page, '/admin/login');
        await submitLogin(page, 'abc001@example.com');
        await expectPath(page, '/');
      },
    );
  },

  async 'cross-tenant'() {
    for (const email of [
      'abc001@example.com',
      'glb009@example.com',
      'wangmin@example.com',
    ])
      requireUnlocked(email);
    /** The complete /api/portal/context body this customer may see, built from our DB. */
    const permittedContext = (email, amount) =>
      JSON.parse(
        scalar(
          `SELECT json_build_object('identity', json_build_object('kind', 'customer', 'profileId', p.id, 'email', u.email, 'tenant', json_build_object('id', t.id, 'code', t.code, 'name', t.name, 'currency', t.currency)), 'balance', json_build_object('currency', t.currency, 'amount', '${amount}')) FROM portal_accounts p JOIN tenants t ON t.id = p.tenant_id JOIN auth."user" u ON u.id = p.auth_user_id WHERE u.email = '${email}'`,
        ),
      );
    const expectedA = permittedContext('abc001@example.com', '-35.20');
    const expectedB = permittedContext('glb009@example.com', '-15.02');
    await step(
      'own-tenant-only',
      'A and B each read /api/portal/context and only see their own tenant',
      async () => {
        expect(
          api('01-login-a', ['login', 'abc001@example.com', 'a']).status,
        ).toBe(200);
        expect(
          api('02-login-b', ['login', 'glb009@example.com', 'b']).status,
        ).toBe(200);
        const a = api('03-context-a', ['GET', '/api/portal/context', 'a']);
        const b = api('04-context-b', ['GET', '/api/portal/context', 'b']);
        expect([
          expectedA.identity.tenant.code,
          expectedA.balance.currency,
        ]).toEqual(['ABC001', 'CNY']);
        expect([
          expectedB.identity.tenant.code,
          expectedB.balance.currency,
        ]).toEqual(['GLB009', 'USD']);
        expect([a.status, a.body]).toStrictEqual([200, expectedA]);
        expect([b.status, b.body]).toStrictEqual([200, expectedB]);
        sql(
          '05-tenant-ids',
          `SELECT t.code, t.id, b.balance FROM tenants t JOIN tenant_balances b ON b.tenant_id=t.id WHERE t.code IN ('ABC001','GLB009') ORDER BY 1`,
        );
        return 'A sees ABC001 -35.20 CNY only; B sees GLB009 -15.02 USD only';
      },
    );
    await step(
      'customer-to-admin',
      'customer cookie on admin API -> 403, no side effect',
      async () => {
        const ctx = api('06-customer-admin-context', [
          'GET',
          '/api/admin/context',
          'a',
        ]);
        expect([ctx.status, ctx.body.error.code]).toEqual([403, 'FORBIDDEN']);
        const target = scalar(
          `SELECT p.id FROM portal_accounts p JOIN tenants t ON t.id=p.tenant_id WHERE t.code='GLB009'`,
        );
        const credentialAt = `SELECT a.updated_at FROM auth.account a JOIN auth."user" u ON u.id=a.user_id WHERE u.email='glb009@example.com'`;
        const before = scalar(credentialAt);
        const reset = api('07-customer-reset-b-password', [
          'POST',
          `/api/admin/portal-accounts/${target}/reset-password`,
          'a',
        ]);
        expect([reset.status, reset.body.error.code]).toEqual([
          403,
          'FORBIDDEN',
        ]);
        const after = scalar(credentialAt);
        write(
          '08-b-credential-before-after.sql.txt',
          `-- ${credentialAt}\nbefore reset attempt: ${before}\nafter reset attempt: ${after}\n`,
        );
        expect(after).toBe(before);
        expect(
          scalar(
            `SELECT count(*) FROM operation_logs WHERE action='reset_password'`,
          ),
        ).toBe('0');
        sql(
          '08-no-reset-side-effect',
          `SELECT u.email, a.updated_at, (SELECT count(*) FROM operation_logs WHERE action='reset_password') AS reset_logs FROM auth.account a JOIN auth."user" u ON u.id=a.user_id WHERE u.email='glb009@example.com'`,
        );
        return 'GET /api/admin/context 403; reset-password on B 403; B credential untouched; 0 audit rows';
      },
    );
    await step(
      'admin-to-portal',
      'admin cookie on portal API -> 403',
      async () => {
        expect(
          api('09-login-admin', ['login', 'wangmin@example.com', 'admin'])
            .status,
        ).toBe(200);
        const r = api('10-admin-portal-context', [
          'GET',
          '/api/portal/context',
          'admin',
        ]);
        expect([r.status, r.body.error.code]).toEqual([403, 'FORBIDDEN']);
      },
    );
    await step('anonymous', 'no cookie -> 401 UNAUTHENTICATED', async () => {
      const r = api('11-anonymous-context', ['GET', '/api/portal/context']);
      expect([r.status, r.body.error.code, r.body.error.action]).toEqual([
        401,
        'UNAUTHENTICATED',
        'reauthenticate',
      ]);
    });
    for (const jar of ['a', 'b', 'admin'])
      api(`12-logout-${jar}`, ['POST', '/api/auth/logout', jar]);
    await step(
      'idor-suite',
      'pnpm test:idor (live OpenAPI enumeration, RLS) on a scratch fs_billing_test in our container',
      async () => {
        const output = cli('13-test-idor', ['pnpm', 'test:idor']);
        expect(output).toMatch(/Tests\s+\d+ passed/);
        expect(output).not.toMatch(/failed/);
        return output.match(/Tests\s+.*/)[0];
      },
    );
  },

  async logout() {
    requireUnlocked('abc001@example.com');
    const page = await newPage();
    let cookie;
    /** Send the browser's complete signed session cookie, outside the browser. */
    const replay = async (label) => {
      const r = await fetch(`${web}/api/auth/session`, {
        headers: { cookie: `${cookie.name}=${cookie.value}` },
      });
      const body = await r.json();
      appendFileSync(
        join(out, httpLog),
        redact(
          `${new Date().toISOString()} replay ${label}: GET /api/auth/session (full signed cookie) -> ${r.status} ${JSON.stringify(body)}\n`,
        ),
      );
      return { status: r.status, body };
    };
    await step(
      'desktop-menu',
      'account menu -> 退出登录 removes the session row',
      async () => {
        await loginAs(page, '/login', 'abc001@example.com');
        await expectPath(page, '/');
        cookie = (await page.context().cookies()).find(
          (c) => c.name === 'better-auth.session_token',
        );
        const token = decodeURIComponent(cookie.value).split('.')[0];
        secrets.push(token, cookie.value);
        // Match on a hash so the token never appears in a command line or error message.
        const sessionRows = `SELECT count(*) FROM auth.session WHERE encode(sha256(convert_to(token, 'UTF8')), 'hex') = '${createHash('sha256').update(token).digest('hex')}'`;
        expect(scalar(sessionRows)).toBe('1');
        const live = await replay('before logout');
        expect([live.status, live.body.identity?.email]).toEqual([
          200,
          'abc001@example.com',
        ]);
        await page.getByRole('button', { name: '账号菜单' }).click();
        const menu = page.getByRole('menu');
        await expect(menu).toContainText('abc001@example.com');
        await aria(page, '01-account-menu', menu);
        await shot(page, '01-account-menu');
        await page.getByRole('menuitem', { name: '退出登录' }).click();
        await expectPath(page, '/login');
        expect(scalar(sessionRows)).toBe('0');
        write(
          '02-session-row.sql.txt',
          `-- SELECT count(*) FROM auth.session WHERE token=<this browser's session token>\nbefore logout: 1\nafter logout: 0\n`,
        );
        expect(
          (await page.context().cookies()).some(
            (c) => c.name === 'better-auth.session_token',
          ),
        ).toBe(false);
        await shot(page, '03-after-logout');
        return 'session row for this cookie deleted; cookie cleared';
      },
    );
    await step(
      'revisit',
      'revisit / after logout -> /login; the same signed cookie that worked before logout -> 401',
      async () => {
        await page.goto('/');
        await expectPath(page, '/login');
        const r = await replay('after logout');
        expect([r.status, r.body.error.code]).toEqual([401, 'UNAUTHENTICATED']);
        return 'old cookie: 200 before logout, 401 UNAUTHENTICATED after';
      },
    );
    await step(
      'mobile-sheet',
      '375px: 账号菜单 sheet -> 退出登录',
      async () => {
        const mobile = await newPage({
          viewport: { width: 375, height: 812 },
          isMobile: true,
          hasTouch: true,
        });
        await loginAs(mobile, '/login', 'abc001@example.com');
        await expectPath(mobile, '/');
        const before = Number(scalar(sessionsOf('abc001@example.com')));
        await mobile.getByRole('button', { name: '账号菜单' }).click();
        const sheet = mobile.getByRole('dialog', { name: '账号菜单' });
        await sheet.getByRole('button', { name: '退出登录' }).click();
        await expectPath(mobile, '/login');
        const after = Number(scalar(sessionsOf('abc001@example.com')));
        write(
          '05-mobile-sessions.sql.txt',
          `-- ${sessionsOf('abc001@example.com')}\nbefore logout: ${before}\nafter logout: ${after}\n`,
        );
        expect(after).toBe(before - 1);
        await shot(mobile, '04-mobile-after-logout');
        return `live abc001 sessions ${before} -> ${before - 1}`;
      },
    );
  },

  async 'theme-and-mobile'() {
    requireUnlocked('abc001@example.com');
    const page = await newPage({ colorScheme: 'light' });
    const theme = () => page.locator('html').getAttribute('data-theme');
    const stored = () =>
      page.evaluate(() => localStorage.getItem('fs-billing.theme'));
    await loginAs(page, '/login', 'abc001@example.com');
    await expectPath(page, '/');
    await step(
      'desktop-dark',
      '◐ 主题 -> 深色, persists across reload',
      async () => {
        await page.getByRole('button', { name: '主题' }).click();
        await aria(page, '01-theme-menu', page.getByRole('menu'));
        await page.getByRole('menuitemradio', { name: '深色' }).click();
        await expect.poll(theme).toBe('dark');
        expect(await stored()).toBe('dark');
        await page.reload();
        await expect(page.getByRole('heading', { name: '首页' })).toBeVisible();
        expect(await theme()).toBe('dark');
        await shot(page, '02-dark-after-reload');
      },
    );
    await step('desktop-light', '主题 -> 浅色', async () => {
      await page.getByRole('button', { name: '主题' }).click();
      await page.getByRole('menuitemradio', { name: '浅色' }).click();
      await expect.poll(theme).toBe('light');
      expect(await stored()).toBe('light');
    });
    await step(
      'system',
      '主题 -> 跟随系统 follows prefers-color-scheme live',
      async () => {
        await page.getByRole('button', { name: '主题' }).click();
        await page.getByRole('menuitemradio', { name: '跟随系统' }).click();
        expect(await stored()).toBe('system');
        await page.emulateMedia({ colorScheme: 'dark' });
        await expect.poll(theme).toBe('dark');
        await page.emulateMedia({ colorScheme: 'light' });
        await expect.poll(theme).toBe('light');
      },
    );
    const mobile = await newPage({
      viewport: { width: 375, height: 812 },
      isMobile: true,
      hasTouch: true,
      colorScheme: 'light',
    });
    await step(
      'mobile-layout',
      '375px portal home: no horizontal overflow, mobile header',
      async () => {
        await loginAs(mobile, '/login', 'abc001@example.com');
        await expectPath(mobile, '/');
        await expect(
          mobile.getByRole('region', { name: '当前余额' }),
        ).toContainText('-¥35.20');
        await expect(
          mobile.getByRole('button', { name: '打开导航' }),
        ).toBeVisible();
        const width = await mobile.evaluate(
          () => document.documentElement.scrollWidth,
        );
        expect(width).toBeLessThanOrEqual(375);
        await aria(mobile, '03-mobile-home');
        await shot(mobile, '03-mobile-home');
        return `scrollWidth ${width}`;
      },
    );
    await step(
      'account-sheet',
      '账号菜单 sheet shows identity and theme radios; 深色 applies',
      async () => {
        await mobile.getByRole('button', { name: '账号菜单' }).click();
        const sheet = mobile.getByRole('dialog', { name: '账号菜单' });
        await expect(sheet).toContainText('abc001@example.com');
        await expect(sheet).toContainText('深圳市某某科技有限公司 · ABC001');
        const group = sheet.getByRole('radiogroup', { name: '主题' });
        await aria(mobile, '04-account-sheet', sheet);
        await group.getByText('深色').click();
        await expect
          .poll(() => mobile.locator('html').getAttribute('data-theme'))
          .toBe('dark');
        await expect(group.getByRole('radio', { name: '深色' })).toBeChecked();
        await shot(mobile, '04-account-sheet-dark');
        await mobile.keyboard.press('Escape');
      },
    );
    await step(
      'nav-drawer',
      '☰ 打开导航 shows the 导航 drawer with 首页',
      async () => {
        await mobile.getByRole('button', { name: '打开导航' }).click();
        const drawer = mobile.getByRole('dialog', { name: '导航' });
        await expect(
          drawer.getByRole('link', { name: '首页' }),
        ).toHaveAttribute('aria-current', 'page');
        await shot(mobile, '05-nav-drawer');
      },
    );
  },

  async 'not-found'() {
    requireUnlocked('abc001@example.com');
    requireUnlocked('wangmin@example.com');
    await step(
      'portal-signed-out',
      '/no-such-page signed out -> 404, 返回首页 -> /login',
      async () => {
        const page = await newPage();
        await page.goto('/no-such-page');
        await expect(
          page.getByRole('heading', { name: '找不到这个页面' }),
        ).toBeVisible();
        await expect(
          page.getByText('页面不存在或链接已失效，请检查地址是否正确'),
        ).toBeVisible();
        await aria(page, '01-portal-404');
        await shot(page, '01-portal-404');
        await page.getByRole('link', { name: '返回首页' }).click();
        await expectPath(page, '/login');
      },
    );
    await step(
      'admin-signed-out',
      '/admin/no-such-page signed out -> admin 404, 返回首页 -> /admin/login',
      async () => {
        const page = await newPage();
        await page.goto('/admin/no-such-page');
        await expect(
          page.getByRole('heading', { name: '找不到这个页面' }),
        ).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute(
          'data-product',
          'admin',
        );
        await shot(page, '02-admin-404-signed-out');
        await page.getByRole('link', { name: '返回首页' }).click();
        await expectPath(page, '/admin/login');
      },
    );
    await step(
      'admin-in-shell',
      'signed-in admin /admin/no-such-page -> 404 inside the shell',
      async () => {
        const page = await newPage();
        await loginAs(page, '/admin/login', 'wangmin@example.com');
        await expectPath(page, '/admin');
        await page.goto('/admin/no-such-page');
        await expect(
          page.getByRole('heading', { name: '找不到这个页面' }),
        ).toBeVisible();
        await expect(
          page.getByRole('button', { name: '账号菜单' }),
        ).toBeVisible();
        await expect(page.getByText('返回首页即回到「概览」')).toBeVisible();
        await aria(page, '03-admin-404-shell');
        await shot(page, '03-admin-404-shell');
        await page.getByRole('link', { name: '返回首页' }).click();
        await expectPath(page, '/admin');
      },
    );
    await step(
      'portal-in-shell',
      'signed-in customer /x/y -> 404 inside the portal shell',
      async () => {
        const page = await newPage();
        await loginAs(page, '/login', 'abc001@example.com');
        await page.goto('/x/y');
        await expect(
          page.getByRole('heading', { name: '找不到这个页面' }),
        ).toBeVisible();
        await expect(
          page.getByText('ABC001 · 深圳市某某科技有限公司'),
        ).toBeVisible();
        await shot(page, '04-portal-404-shell');
      },
    );
    await step('api-404', 'GET /api/no-such-route -> JSON 404', async () => {
      const r = api('05-api-404', ['GET', '/api/no-such-route']);
      expect([r.status, r.body.error.code]).toEqual([404, 'NOT_FOUND']);
    });
  },
};

if (feature === 'all') {
  // One child per feature, so each gets its own evidence dir and its own rate-limit wait.
  const results = [];
  for (const name of Object.keys(journeys)) {
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), name, ...process.argv.slice(3)],
      { stdio: 'inherit' },
    );
    results.push([
      name,
      child.status === 0 ? 'PASS' : child.status === 2 ? 'BLOCKED' : 'FAIL',
    ]);
  }
  console.log(
    [
      '',
      '| feature | result |',
      '|---|---|',
      ...results.map(([name, result]) => `| ${name} | ${result} |`),
    ].join('\n'),
  );
  const outcomes = results.map(([, result]) => result);
  process.exit(
    outcomes.includes('FAIL') ? 1 : outcomes.includes('BLOCKED') ? 2 : 0,
  );
}
if (!journeys[feature]) {
  console.error(
    `usage: drive.mjs <${Object.keys(journeys).join('|')}|all> [--headed]`,
  );
  if (feature === 'freeswitch-sipp')
    console.error(
      'freeswitch-sipp is a separate surface; see features/freeswitch-sipp.md',
    );
  process.exit(2);
}
if (existsSync(credentialStamp)) {
  const wait =
    Number(readFileSync(credentialStamp, 'utf8')) * 1000 +
    rateLimitWindowMs -
    Date.now();
  if (wait > 0) {
    console.log(
      `waiting ${Math.ceil(wait / 1000)} s for the API's credential rate-limit window (30/min/IP) to reset`,
    );
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}
mkdirSync(out, { recursive: true });
browser = await chromium.launch({ headless: !headed });
let status = 'PASS';
let reason = '';
try {
  await journeys[feature]();
} catch (error) {
  status = error instanceof Precondition ? 'BLOCKED' : 'FAIL';
  reason = String(error?.message ?? error)
    .split('\n')
    .slice(0, 8)
    .join('\n');
} finally {
  await browser.close();
}
const lines = [
  `# ${feature} — ${status}`,
  '',
  `run ${runId}, ${new Date().toISOString()}, web ${web}`,
  '',
  '| step | action | result | detail |',
  '|---|---|---|---|',
];
for (const s of steps)
  lines.push(
    `| ${s.id} | ${s.action} | ${s.result} | ${String(s.detail).replaceAll('|', '\\|')} |`,
  );
if (reason) lines.push('', '```', reason, '```');
write('steps.md', lines.join('\n') + '\n');
write(
  'result.json',
  JSON.stringify({ runId, feature, status, reason, steps }, null, 2),
);
console.log(redact(lines.join('\n')));
console.log(`evidence: ${out}`);
process.exit(status === 'PASS' ? 0 : status === 'BLOCKED' ? 2 : 1);
