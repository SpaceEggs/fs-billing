import { readFile } from 'node:fs/promises';
import { expect, test as base, type Page } from '@playwright/test';
import { accounts } from './accounts';
import { createTenant, test as adminTest } from './admin';
import { expectPath, loginAs } from './helpers';
import { openPortalCustomer } from './portal';

// 种子（阶段 7 PR 1）：ABC001 的 8 月、9 月账单是月账单设计稿的数字；播种月 1 日凌晨另有 20 通话单（共 ¥3.51、81 分钟）
// 和一笔等额预存。播种月就是运行时的北京月（北京时间固定 UTC+8）。
const beijingNow = new Date(Date.now() + 8 * 3_600_000);
const month = beijingNow.toISOString().slice(0, 7);
const today = beijingNow.toISOString().slice(0, 10);
const dayOfMonth = Number(today.slice(8));
const monthTitle = `${month.slice(0, 4)}年${Number(month.slice(5))}月`;

const fingerprints = ['version', 'generatedBy', 'reconcile', 'breakdown'];

/** 汇总算式在电脑上是一行（稿 2a），手机是一列；只取当前可见的那一份。 */
const equation = (page: Page) =>
  page
    .getByRole('region', { name: '账单汇总' })
    .locator(':scope > div:visible');
const table = (page: Page, name: string) =>
  page.getByRole('region', { name }).getByRole('table');

base.describe('ABC001 的月账单', () => {
  base.beforeEach(async ({ page }) => {
    await loginAs(page, '/login', accounts.customer);
    await expectPath(page, '/');
  });

  base(
    'shows the August and September statements of the mockup',
    async ({ page }) => {
      const list = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/portal/statements' &&
          response.ok(),
      );
      await page
        .getByRole('navigation', { name: '主导航' })
        .getByRole('link', { name: '月账单' })
        .click();
      await expectPath(page, '/portal/statements');
      // 原始响应里没有后台才有的字段，也没有租户 id。
      const raw = await (await list).text();
      for (const field of [...fingerprints, 'tenantId'])
        expect(raw).not.toContain(field);

      await expect(
        page.getByRole('heading', { name: '月账单', level: 1 }),
      ).toBeVisible();
      const rows = page.getByRole('table').getByRole('row');
      // 表头、播种月（进行中）、9 月、8 月；8 月之前 ABC001 还没有开户。
      await expect(rows).toHaveCount(4);
      await expect(rows.nth(2)).toContainText('2026年9月');
      await expect(rows.nth(2)).not.toContainText('本月（进行中）');
      for (const text of [
        '¥1,176.60',
        '¥1,300.00',
        '¥0.00',
        '-¥25.50',
        '¥2,486.30',
        '-¥35.20',
        '49,726',
      ])
        await expect(rows.nth(2)).toContainText(text);
      for (const text of [
        '¥0.00',
        '¥3,000.00',
        '¥50.00',
        '¥1,873.40',
        '¥1,176.60',
        '37,468',
      ])
        await expect(rows.nth(3)).toContainText(text);

      // 8 月：0 + 3,000.00 + 50.00 ± 0.00 − 1,873.40 = 1,176.60。
      await rows.nth(3).click();
      await expectPath(page, '/portal/statements/2026-08');
      await expect(
        page.getByRole('heading', { name: '2026年8月' }),
      ).toBeVisible();
      await expect(equation(page)).toHaveText(
        /期初余额\s*¥0\.00\s*\+\s*充值\s*¥3,000\.00\s*\+\s*赠送\s*¥50\.00\s*±\s*调账\s*¥0\.00\s*−\s*通话扣费\s*¥1,873\.40\s*9,642 通 · 37,468分钟\s*=\s*期末余额\s*¥1,176\.60/,
      );
      await expect(
        page.getByText('2026-08-12（开户）至 2026-08-31'),
      ).toBeVisible();
      await expect(
        page.getByText(/账单生成于/).filter({ visible: true }),
      ).toBeVisible();

      // 9 月：1,176.60 + 1,300.00 + 0.00 − 25.50 − 2,486.30 = −35.20，调账与期末为红色负数。
      await page.goto('/portal/statements/2026-09');
      await expect(equation(page)).toHaveText(
        /期初余额\s*¥1,176\.60\s*\+\s*充值\s*¥1,300\.00\s*\+\s*赠送\s*¥0\.00\s*±\s*调账\s*-¥25\.50\s*−\s*通话扣费\s*¥2,486\.30\s*12,804 通 · 49,726分钟\s*=\s*期末余额\s*-¥35\.20/,
      );
      await expect(equation(page).getByText('-¥25.50')).toHaveClass(/text-neg/);
      await expect(equation(page).getByText('-¥35.20')).toHaveClass(/text-neg/);
      await expect(page.getByText('2026-09-01 至 2026-09-30')).toBeVisible();
      await expect(page.getByText('本月（进行中）')).toHaveCount(0);
    },
  );

  base(
    'lists countries only by country with each share of the call charges',
    async ({ page }) => {
      await page.goto('/portal/statements/2026-08');
      const countries = table(page, '按国家汇总');
      await expect(countries.getByRole('columnheader')).toHaveText([
        '国家',
        '通话数',
        '计费分钟',
        '占比',
        '费用',
      ]);
      const rows = countries.getByRole('row');
      // 表头、7 个国家（英国手机并入英国）、合计。
      await expect(rows).toHaveCount(9);
      await expect(rows.nth(1)).toHaveText(
        /中国\s*7,350\s*28,803分钟\s*76\.9%\s*¥1,440\.15/,
      );
      await expect(rows.nth(2)).toHaveText(
        /牙买加\s*145\s*700分钟\s*9\.3%\s*¥175\.00/,
      );
      await expect(rows.nth(3)).toHaveText(
        /英国\s*792\s*2,900分钟\s*5\.8%\s*¥108\.00/,
      );
      await expect(countries.getByText('英国手机')).toHaveCount(0);
      await expect(rows.last()).toHaveText(
        /合计\s*9,642\s*37,468分钟\s*¥1,873\.40/,
      );

      await page.goto('/portal/statements/2026-09');
      const september = table(page, '按国家汇总').getByRole('row');
      await expect(september.nth(1)).toHaveText(
        /中国\s*9,820\s*38,476分钟\s*77\.4%\s*¥1,923\.80/,
      );
      await expect(september.last()).toHaveText(
        /合计\s*12,804\s*49,726分钟\s*¥2,486\.30/,
      );
    },
  );

  base(
    'counts the days of the period and zero-fills the days without calls',
    async ({ page }) => {
      // 8 月从开户日 12 日起，共 20 天。
      await page.goto('/portal/statements/2026-08');
      await expect(
        page.getByRole('region', { name: '按日汇总' }).getByText('20 天'),
      ).toBeVisible();
      const august = table(page, '按日汇总').getByRole('row');
      await expect(august).toHaveCount(22);
      await expect(august.nth(1)).toContainText('2026-08-12');
      await expect(august.nth(20)).toContainText('2026-08-31');
      await expect(august.last()).toHaveText(
        /合计\s*9,642\s*37,468分钟\s*¥1,873\.40/,
      );

      // 播种月只有 1 日有通话，其余每一天也有一行，全为 0。
      await page.goto(`/portal/statements/${month}`);
      await expect(
        page
          .getByRole('region', { name: '按日汇总' })
          .getByText(`${dayOfMonth} 天`, { exact: true }),
      ).toBeVisible();
      const days = table(page, '按日汇总').getByRole('row');
      await expect(days).toHaveCount(dayOfMonth + 2);
      await expect(days.nth(1)).toHaveText(
        new RegExp(`${month}-01\\s*20\\s*81分钟\\s*¥3\\.51`),
      );
      if (dayOfMonth > 1) {
        await expect(days.nth(2)).toHaveText(
          new RegExp(`${month}-02\\s*0\\s*0分钟\\s*¥0\\.00`),
        );
        await expect(days.nth(dayOfMonth)).toHaveText(
          new RegExp(`${today}\\s*(今日 · 截至当前\\s*)?0\\s*0分钟\\s*¥0\\.00`),
        );
      }
    },
  );

  base(
    'shows the live month first with 本月（进行中） and the 20 seeded calls',
    async ({ page }) => {
      await page.goto('/portal/statements');
      const live = page.getByRole('table').getByRole('row').nth(1);
      await expect(live).toContainText(monthTitle);
      await expect(live).toContainText('本月（进行中）');
      // 20 通话单 ¥3.51，被等额预存抵平：期初与期末都是 −¥35.20。
      await expect(live).toContainText('¥3.51');
      await expect(live).toContainText('-¥35.20');
      await expect(live).toContainText('81');
      await expect(page.getByText(/本月数据实时更新，截至/)).toBeVisible();

      await live.click();
      await expectPath(page, `/portal/statements/${month}`);
      await expect(
        page.getByText('本月（进行中）', { exact: true }).first(),
      ).toBeVisible();
      await expect(
        page.getByText(
          /本月尚未结束，以下数据截至今日并实时更新；.*凌晨生成正式账单/,
        ),
      ).toBeVisible();
      await expect(equation(page)).toHaveText(
        /期初余额\s*-¥35\.20\s*\+\s*充值\s*¥3\.51\s*\+\s*赠送\s*¥0\.00\s*±\s*调账\s*¥0\.00\s*−\s*通话扣费\s*¥3\.51\s*20 通 · 81分钟\s*=\s*期末余额\s*-¥35\.20/,
      );
      await expect(
        page
          .getByText(/^数据截至 \d{4}-\d\d-\d\d \d\d:\d\d:\d\d · 实时更新$/)
          .filter({ visible: true }),
      ).toBeVisible();
      await expect(page.getByText(/账单生成于/)).toHaveCount(0);
      if (dayOfMonth > 1)
        await expect(page.getByText('今日 · 截至当前')).toHaveCount(1);
    },
  );

  base(
    'downloads the long-format summary CSV whose amounts add up to the closing balance',
    async ({ page }) => {
      await page.goto('/portal/statements/2026-09');
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: '导出 CSV（汇总）' }).click();
      const file = await download;
      expect(file.suggestedFilename()).toBe(
        'statement_ABC001_2026-09-01_2026-09-30.csv',
      );
      const text = await readFile((await file.path()) ?? '', 'utf8');
      expect(text.charCodeAt(0)).toBe(0xfeff);
      const lines = text.slice(1).trimEnd().split('\r\n');
      expect(lines[0]).toBe('类别,项目,通话数,计费分钟,金额（CNY）');
      const summary = lines
        .slice(1)
        .map((line) => line.split(','))
        .filter(([kind]) => kind === '汇总');
      expect(summary.map(([, item]) => item)).toEqual([
        '期初余额',
        '充值',
        '赠送',
        '调账',
        '通话扣费',
        '期末余额',
      ]);
      // 期初 + 充值 + 赠送 + 调账 + 通话扣费（负数）= 期末。
      const cents = (value: string | undefined) =>
        Math.round(Number(value ?? 'NaN') * 100);
      const amounts = summary.map((row) => cents(row[4]));
      expect(amounts.slice(0, 5).reduce((sum, value) => sum + value, 0)).toBe(
        amounts[5],
      );
      expect(amounts[5]).toBe(-3520);
      expect(summary[4]?.[4]).toBe('-2486.3');
      expect(
        lines.some((line) => line.startsWith('国家,中国,9820,38476,')),
      ).toBe(true);
      expect(lines.filter((line) => line.startsWith('日期,'))).toHaveLength(29);
    },
  );

  base(
    'downloads the answered CDRs of the month, as many rows as the statement call count',
    async ({ page }) => {
      await page.goto('/portal/statements/2026-08');
      const download = page.waitForEvent('download');
      await page
        .getByRole('button', { name: '导出 CSV（该月话单明细）' })
        .click();
      const file = await download;
      expect(file.suggestedFilename()).toBe(
        'cdrs_ABC001_2026-08-01_2026-08-31.csv',
      );
      const text = await readFile((await file.path()) ?? '', 'utf8');
      const lines = text.slice(1).trimEnd().split('\r\n');
      // 15 列，不含后台才有的验证状态；只含已接通话单，行数等于账单的通话数 9,642。
      expect(lines[0]?.split(',')).toHaveLength(15);
      expect(lines[0]).not.toContain('验证');
      expect(lines.length - 1).toBe(9642);
      expect(text).not.toContain('未接通');
    },
  );

  base(
    'keeps the raw statement response free of internal fields',
    async ({ page }) => {
      const detail = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/portal/statements/2026-09',
      );
      await page.goto('/portal/statements/2026-09');
      const raw = await (await detail).text();
      for (const field of [...fingerprints, 'tenantId', 'unverified'])
        expect(raw).not.toContain(field);
      expect(JSON.parse(raw)).toMatchObject({
        month: '2026-09',
        state: 'final',
        figures: { closingBalance: '-35.2', calls: 12804 },
      });
    },
  );

  base(
    'has a print button and hides navigation and buttons under print media',
    async ({ page }) => {
      await page.goto('/portal/statements/2026-09');
      await expect(equation(page)).toBeVisible();
      const nav = page.getByRole('navigation', { name: '主导航' });
      const buttons = page.getByRole('button', {
        name: /^(导出 CSV（汇总）|导出 CSV（该月话单明细）|打印)$/,
      });
      await expect(nav).toBeVisible();
      // 电脑一排三个；手机底部的两个导出按钮在电脑上隐藏。
      await expect(buttons).toHaveCount(3);
      await expect(page.getByRole('button', { name: '打印' })).toBeVisible();

      await page.emulateMedia({ media: 'print' });
      await expect(nav).toBeHidden();
      await expect(page.getByRole('button', { name: '打印' })).toBeHidden();
      await expect(
        page.getByRole('button', { name: '导出 CSV（汇总）' }),
      ).toBeHidden();
      // 账单本身仍在，深色主题也按浅色打印。
      await expect(equation(page)).toBeVisible();
      await expect(table(page, '按国家汇总')).toBeVisible();
    },
  );

  base('opens the print dialog from the print button', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { printed: number }).printed = 0;
      window.print = () => {
        (window as unknown as { printed: number }).printed += 1;
      };
    });
    await page.goto('/portal/statements/2026-09');
    await page.getByRole('button', { name: '打印' }).click();
    expect(
      await page.evaluate(
        () => (window as unknown as { printed: number }).printed,
      ),
    ).toBe(1);
  });

  base(
    'answers a month before the opening or a malformed month with a not-found view',
    async ({ page }) => {
      await page.goto('/portal/statements/2026-01');
      await expect(page.getByText('月账单加载失败')).toBeVisible();
      await expect(page.getByText('内容不存在或已被删除')).toBeVisible();
      await page.goto('/portal/statements/2026-13');
      await expect(
        page.getByRole('heading', { name: '找不到这个页面' }),
      ).toBeVisible();
    },
  );

  base(
    'lays the list and the detail out as cards on a phone',
    async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto('/portal/statements');
      await expect(page.getByRole('table')).toBeHidden();
      const cards = page.getByRole('listitem');
      await expect(cards).toHaveCount(3);
      await expect(cards.nth(2)).toContainText('2026年8月');
      await expect(cards.nth(2)).toContainText('期初¥0.00');
      await expect(cards.nth(2)).toContainText('期末¥1,176.60');
      await cards.nth(2).click();
      await expectPath(page, '/portal/statements/2026-08');
      await expect(equation(page)).toContainText('期末余额');
      await expect(equation(page)).toContainText('¥1,176.60');
      // 手机顶栏 ‹ 返回，底部是两个导出按钮。
      await expect(
        page.getByRole('link', { name: '返回月账单' }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: '导出 CSV（汇总）' }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: '导出 CSV（该月话单明细）' }),
      ).toBeVisible();
      // 页面没有横向滚动。
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    },
  );
});

adminTest(
  'shows the empty state only without statements and activity',
  async ({ page, browser }) => {
    const tenant = await createTenant(page);
    const customer = await openPortalCustomer(page, browser, tenant);
    await customer.page.goto('/portal/statements');
    await expect(customer.page.getByText('还没有账单')).toBeVisible();
    await expect(
      customer.page.getByText(
        '账户开通后，本月账单会实时显示在这里；每月 1 日凌晨生成上月正式账单。',
      ),
    ).toBeVisible();
    await expect(customer.page.getByRole('table')).toHaveCount(0);
    await customer.context.close();
  },
);
