// Renders the Tabi mark to the PNG icons in public/icons, in Chromium, from
// the same geometry as components/TabiMark.tsx. Run after changing the mark:
//   npm run icons
//
//   icon<N>.png                   the app icon (manifest "icons": extensions page, store, notifications):
//                                 a white mark on a cobalt rounded square
//   toolbar-<light|dark>-<N>.png  the toolbar icon, one colour, never animated
//   toolbar-<light|dark>-waiting-<N>.png  the same with an amber dot: a task needs you

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const OUT = path.resolve('public/icons');
const INK = { light: '#121212', dark: '#F1F1EF' };
const ACCENT = '#2B45D8';
const AMBER = '#FFB23F';

/** The mark at `size` px in `color`, as in TabiMark (left, top, width, height as fractions; capsules; tilted 15°). */
function mark(size: number, color: string): string {
  const capsule = ([l, t, w, h]: number[]) =>
    `<div style="position:absolute;left:${l * size}px;top:${t * size}px;width:${w * size}px;height:${h * size}px;border-radius:${(w * size) / 2}px;background:${color}"></div>`;
  return `<div style="position:absolute;inset:0;transform:rotate(15deg)">${capsule([0.11, 0.24, 0.27, 0.34])}${capsule([0.44, 0.08, 0.43, 0.84])}</div>`;
}

/** The toolbar mark; `waiting` adds a 7/16 amber dot at bottom right with a 1.5/16 gap cut out of the mark around it. */
function toolbar(size: number, color: string, waiting: boolean): string {
  if (!waiting) return `<div style="position:relative;width:${size}px;height:${size}px">${mark(size, color)}</div>`;
  const dot = (7 / 16) * size;
  const gap = (1.5 / 16) * size;
  const c = size - dot / 2;
  const cut = `radial-gradient(circle at ${c}px ${c}px, transparent ${dot / 2 + gap}px, #000 ${dot / 2 + gap + 0.5}px)`;
  return `<div style="position:relative;width:${size}px;height:${size}px">
    <div style="position:absolute;inset:0;-webkit-mask-image:${cut};mask-image:${cut}">${mark(size, color)}</div>
    <div style="position:absolute;left:${size - dot}px;top:${size - dot}px;width:${dot}px;height:${dot}px;border-radius:50%;background:${AMBER}"></div>
  </div>`;
}

/** The app icon: a white mark on a cobalt rounded square, with the store's padding at 48px and up. */
function tile(size: number): string {
  const pad = size >= 48 ? size * 0.125 : 0;
  const inner = size - pad * 2;
  const m = inner * 0.62;
  return `<div style="position:relative;width:${size}px;height:${size}px">
    <div style="position:absolute;left:${pad}px;top:${pad}px;width:${inner}px;height:${inner}px;border-radius:${inner * 0.22}px;background:${ACCENT}">
      <div style="position:absolute;left:${(inner - m) / 2}px;top:${(inner - m) / 2}px;width:${m}px;height:${m}px">${mark(m, '#FFFFFF')}</div>
    </div>
  </div>`;
}

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function render(file: string, size: number, html: string): Promise<void> {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${html}</body></html>`);
  fs.writeFileSync(path.join(OUT, file), await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
  console.log(`  ${file}`);
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await render(`icon${size}.png`, size, tile(size));
  for (const [theme, ink] of Object.entries(INK)) await render(`toolbar-${theme}-${size}.png`, size, toolbar(size, ink, false));
}
// Chrome's toolbar uses 16 and 32 (on high-density screens)
for (const size of [16, 32]) {
  for (const [theme, ink] of Object.entries(INK)) await render(`toolbar-${theme}-waiting-${size}.png`, size, toolbar(size, ink, true));
}
await browser.close();
