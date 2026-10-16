import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { repoRoot } from '../../e2e/env';

const designDir = join(repoRoot, 'design/设计系统规范确认');

/** 设计稿里的一个画框：文件、section[data-screen-label] 与画框上方的标签文字。 */
export type DesignFrame = { file: string; section: string; label: string };

/** 在本地端口提供设计稿目录（稿件经 support.js 渲染，不能用 file://）。返回地址与关闭函数。 */
export async function serveDesigns() {
  const server = createServer((request, response) => {
    const path = normalize(
      decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname),
    );
    const file = join(designDir, path);
    if (!file.startsWith(designDir)) return void response.writeHead(403).end();
    try {
      const type = extname(file) === '.js' ? 'text/javascript' : 'text/html';
      response
        .writeHead(200, { 'content-type': `${type}; charset=utf-8` })
        .end(readFileSync(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No design server address');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 打开设计稿、切换主题，截取标签下方的画框到 `path`。 */
export async function captureDesignFrame(
  page: Page,
  origin: string,
  frame: DesignFrame,
  theme: 'light' | 'dark',
  path: string,
  timeout = 30_000,
) {
  await page.setViewportSize({ width: 2400, height: 1600 });
  const url = `${origin}/${encodeURIComponent(frame.file)}`;
  if (page.url() !== url) await page.goto(url);
  const themed = page.locator('[data-theme]').first();
  await expect(themed).toBeVisible({ timeout });
  await themed.evaluate(
    (element, value) => element.setAttribute('data-theme', value),
    theme,
  );
  const label = page
    .locator(`section[data-screen-label="${frame.section}"]`)
    .getByText(frame.label, { exact: true });
  await expect(label).toHaveCount(1, { timeout });
  const target = label.locator(
    'xpath=ancestor-or-self::div[1]/following-sibling::div[1]',
  );
  await target.scrollIntoViewIfNeeded();
  await target.screenshot({ path, timeout });
}
