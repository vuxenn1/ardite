// Makes the PNG icons phones need to install Ardite as an app, from public/icon.svg, in a headless
// Edge or Chrome. Run it again after changing the icon: node .github/make-icons.mjs
//   icon-192.png, icon-512.png   the icon as it is (see-through corners)
//   icon-maskable-512.png        full square, the drawing smaller, for Android's own shapes
//   apple-touch-icon.png         full square, 180 px (iPhone rounds the corners itself)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launchBrowser } from './browser.mjs';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const svg = fs.readFileSync(path.join(PUBLIC, 'icon.svg'), 'utf8');
// the drawing without the rounded background, to place on a full square
const drawing = svg.replace(/<rect width="64" height="64"[^>]*\/>/, '').replace(/<\/?svg[^>]*>/g, '');
const fill = /<rect width="64" height="64"[^>]*fill="([^"]+)"/.exec(svg)[1];
const square = (scale) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${fill}"/>`
  + `<g transform="translate(32 32) scale(${scale}) translate(-32 -32)">${drawing}</g></svg>`;

const ICONS = [
  ['icon-192.png', 192, svg, true],
  ['icon-512.png', 512, svg, true],
  ['icon-maskable-512.png', 512, square(0.7), false],
  ['apple-touch-icon.png', 180, square(0.82), false],
];

const browser = await launchBrowser(findBrowser());
try {
  for (const [name, size, image, transparent] of ICONS) {
    const html = `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:transparent">${image.replace('<svg ', `<svg width="${size}" height="${size}" style="display:block" `)}</body></html>`;
    const page = await browser.open(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
    await page.emulate({ width: size, height: size });
    fs.writeFileSync(path.join(PUBLIC, name), await page.screenshot({ transparent }));
    page.close();
    console.log(name);
  }
} finally {
  await browser.close();
}
