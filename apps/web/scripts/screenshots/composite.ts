import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const gap = 32;
const background = [228, 228, 231, 255] as const;

/** 把设计稿（左）与实现（右）顶部对齐拼成一张图，不缩放。 */
export function writeComposite(
  designPath: string,
  appPath: string,
  outPath: string,
) {
  const design = PNG.sync.read(readFileSync(designPath));
  const app = PNG.sync.read(readFileSync(appPath));
  const width = design.width + app.width + gap * 3;
  const height = Math.max(design.height, app.height) + gap * 2;
  const out = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) out.data.set(background, i * 4);
  PNG.bitblt(design, out, 0, 0, design.width, design.height, gap, gap);
  PNG.bitblt(
    app,
    out,
    0,
    0,
    app.width,
    app.height,
    gap * 2 + design.width,
    gap,
  );
  writeFileSync(outPath, PNG.sync.write(out));
}
