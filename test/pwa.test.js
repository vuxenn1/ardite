// Installing Ardite as an app: the manifest, its icons and the service worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const file = (f) => new URL(`../public/${f}`, import.meta.url);
const manifest = JSON.parse(fs.readFileSync(file('manifest.webmanifest'), 'utf8'));
// a PNG's width and height, from its header
const pngSize = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)];

test('the manifest makes Ardite installable, with PNG icons of the sizes it says', () => {
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  const pngs = manifest.icons.filter((i) => i.type === 'image/png');
  for (const icon of manifest.icons) assert.ok(fs.existsSync(file(icon.src.slice(1))), icon.src);
  for (const icon of pngs) {
    const buf = fs.readFileSync(file(icon.src.slice(1)));
    assert.equal(buf.subarray(1, 4).toString(), 'PNG', icon.src);
    assert.deepEqual(pngSize(buf), icon.sizes.split('x').map(Number), icon.src);
  }
  // phones want both of these
  assert.ok(pngs.some((i) => i.sizes === '192x192' && i.purpose === 'any'));
  assert.ok(pngs.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
  assert.deepEqual(pngSize(fs.readFileSync(file('apple-touch-icon.png'))), [180, 180]);
});

test('links shared to the app arrive as /?url=, which the page opens', () => {
  assert.equal(manifest.share_target.action, '/');
  assert.equal(manifest.share_target.method, 'GET');
  assert.deepEqual(manifest.share_target.params, { title: 'title', text: 'text', url: 'url' });
  const app = fs.readFileSync(file('js/app.js'), 'utf8');
  assert.match(app, /params\.get\('url'\)/);
  assert.match(app, /params\.get\('text'\)/);
});

test('the page links the manifest, the iPhone icon and the service worker', () => {
  const html = fs.readFileSync(file('index.html'), 'utf8');
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/);
  assert.match(fs.readFileSync(file('js/app.js'), 'utf8'), /serviceWorker\.register\('\/sw\.js'\)/);
  // the service worker only steps in when a page can't load, it never keeps old copies
  const sw = fs.readFileSync(file('sw.js'), 'utf8');
  assert.match(sw, /request\.mode !== 'navigate'/);
  assert.doesNotMatch(sw, /caches\./);
});
