import { expect } from '@playwright/test';
import { test } from './admin';
import { callChargeEntries, cdrTotals, tenantBalance } from './db';

/**
 * 阶段 8 验收 1 与 2 在种子数据上的真实走一遍：把 ABC01 的 326 条分配给 ABC001。
 * 它改动 ABC001（余额 −35.20 变为 −93.55、9 月账单变为待重新生成），其他用例依赖 ABC001 的种子数字，
 * 所以默认不运行，只在 FSB_ABC01_ASSIGN=1 且数据库是刚迁移播种的新库时运行，并且要排在其余用例之后
 * （跑完需重建数据库才能再跑 pnpm test:e2e）。其余 e2e 用夹具租户走同一条路径，不碰种子。
 */
test.skip(
  process.env['FSB_ABC01_ASSIGN'] !== '1',
  '会改动种子的 ABC001，仅在 FSB_ABC01_ASSIGN=1 且数据库是新库时运行',
);

test('assigns the ABC01 group to ABC001: 324 rows charged 58.35, 2 without a rate stay, a replay charges nothing', async ({
  page,
}) => {
  const search = await page.request.get(
    '/api/admin/tenants?search=ABC001&pageSize=5',
  );
  const abc001 = (
    (await search.json()) as { items: { id: string; code: string }[] }
  ).items.find((tenant) => tenant.code === 'ABC001');
  if (!abc001) throw new Error('ABC001 not found');
  const balanceBefore = await tenantBalance(abc001.id);
  expect(Number(balanceBefore)).toBe(-35.2);
  const chargesBefore = (await callChargeEntries(abc001.id)).length;
  const cdrsBefore = (await cdrTotals(abc001.id)).count;

  await page.goto('/admin/unassigned?tag=ABC01');
  await page
    .getByRole('button', { name: '选择「标签 ABC01」全部 326 条' })
    .click();
  await page.getByRole('button', { name: '归属到租户' }).click();
  const dialog = page.getByRole('dialog', { name: '归属到租户' });
  await dialog.getByRole('combobox', { name: /^归属到租户/ }).click();
  await page.getByRole('option', { name: /ABC001/ }).click();
  await expect(dialog).toContainText('实际归属324 条');
  await expect(dialog).toContainText('扣费合计¥58.35');
  await expect(dialog).toContainText('匹配不到费率2 条');
  const assigned = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === '/api/admin/unassigned-cdrs/assign' &&
      request.method() === 'POST',
  );
  await dialog.getByRole('button', { name: '确认归属 324 条并扣费' }).click();
  await expect(dialog.getByRole('heading', { name: '归属完成' })).toBeVisible();
  await expect(dialog).toContainText(
    '已归属 324 条到 ABC001，扣费 ¥58.35（-¥35.20 → -¥93.55）',
  );
  await expect(dialog).toContainText('2 条匹配不到费率，留在待处理');
  // 补扣费落在已出账的 9 月：提示该月账单要重新生成。
  await expect(dialog).toContainText('2026年9月 · 已出账，需重新生成');
  await dialog.getByRole('button', { name: '完成' }).click();

  // 余额减少 58.35，流水里多 324 条通话扣费，话单多 324 条。
  expect(Number(await tenantBalance(abc001.id))).toBe(-93.55);
  expect((await callChargeEntries(abc001.id)).length).toBe(chargesBefore + 324);
  expect((await cdrTotals(abc001.id)).count).toBe(cdrsBefore + 324);

  // 剩下的就是 2 条无费率的话单，仍是待处理。
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(3);
  await expect(page.getByRole('table')).toContainText('18765551234');
  await expect(page.getByRole('table')).toContainText('18765559876');

  // 同一批重复提交只扣费一次：同一幂等键重放，余额与流水不变。
  const request = await assigned;
  const replay = await page.request.post('/api/admin/unassigned-cdrs/assign', {
    data: request.postDataJSON() as object,
  });
  expect(replay.status()).toBe(200);
  expect(await replay.json()).toMatchObject({
    replayed: true,
    assigned: 324,
    chargeTotal: '58.35',
  });
  expect(Number(await tenantBalance(abc001.id))).toBe(-93.55);
  expect((await callChargeEntries(abc001.id)).length).toBe(chargesBefore + 324);
});
