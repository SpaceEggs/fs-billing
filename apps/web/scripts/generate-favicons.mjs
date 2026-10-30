import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';

const publicDir = new URL('../public/', import.meta.url);
const svg = await readFile(new URL('favicon-portal.svg', publicDir));
const source = `data:image/svg+xml;base64,${svg.toString('base64')}`;
const browser = await chromium.launch();

try {
  const page = await browser.newPage({ colorScheme: 'light' });
  async function render(size, apple = false) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;width:100%;height:100%;background:${apple ? '#18181b' : 'transparent'}}img{display:block;width:100%;height:100%;${apple ? 'padding:12px;box-sizing:border-box' : ''}}</style><img src="${source}">`,
    );
    await page.locator('img').evaluate((img) => img.decode());
    return page.screenshot({ omitBackground: !apple });
  }

  const images = [await render(16), await render(32)];
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  for (const [index, png] of images.entries()) {
    const entry = 6 + index * 16;
    header[entry] = index === 0 ? 16 : 32;
    header[entry + 1] = header[entry];
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  }
  await writeFile(
    new URL('favicon.ico', publicDir),
    Buffer.concat([header, ...images]),
  );
  await writeFile(
    new URL('apple-touch-icon.png', publicDir),
    await render(180, true),
  );
} finally {
  await browser.close();
}
