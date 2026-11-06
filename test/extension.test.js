// The browser extension (extension/): what it asks for, what its buttons open and the ZIP Ardite
// hands out with its own address filled in.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import { startServer } from '../.github/test-server.mjs';

const file = (f) => new URL(`../extension/${f}`, import.meta.url);
const json = (f) => JSON.parse(fs.readFileSync(file(f), 'utf8'));
const manifest = json('manifest.json');

test('the extension asks for as little as possible and has everything it names', () => {
  assert.equal(manifest.manifest_version, 3);
  // no access to any website: only the tab you click it on, a menu item and its own setting
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'contextMenus', 'storage']);
  assert.equal(manifest.host_permissions, undefined);
  for (const [size, icon] of Object.entries(manifest.icons)) {
    const buf = fs.readFileSync(file(icon));
    assert.deepEqual([buf.readUInt32BE(16), buf.readUInt32BE(20)], [Number(size), Number(size)], icon);
  }
  for (const f of [manifest.background.service_worker, ...manifest.background.scripts, manifest.options_ui.page]) {
    assert.ok(fs.existsSync(file(f)), f);
  }
  // every __MSG_x__ and getMessage('x') has a text, in every language
  const used = new Set();
  for (const m of JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)) used.add(m[1]);
  for (const f of ['background.js', 'options.html']) {
    for (const m of fs.readFileSync(file(f), 'utf8').matchAll(/getMessage\('(\w+)'\)|data-msg="(\w+)"/g)) used.add(m[1] || m[2]);
  }
  const en = Object.keys(json('_locales/en/messages.json')).sort();
  assert.deepEqual(Object.keys(json('_locales/tr/messages.json')).sort(), en);
  assert.deepEqual([...used].filter((k) => !en.includes(k)), []);
});

// background.js with a stand-in for the browser's extension API
function loadBackground({ saved } = {}) {
  const listeners = {};
  const created = [];
  const on = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const chrome = {
    storage: { sync: { get: async () => (saved ? { address: saved } : {}) } },
    runtime: { getURL: (p) => `ext://${p}`, onInstalled: on('installed') },
    tabs: { create: async (o) => created.push(o) },
    action: { onClicked: on('action') },
    contextMenus: { create: (o) => created.push({ menu: o }), onClicked: on('menu') },
    i18n: { getMessage: (k) => `[${k}]` },
  };
  const fetch = async (url) => ({ json: async () => (url === 'ext://defaults.json' ? json('defaults.json') : null) });
  vm.runInNewContext(fs.readFileSync(file('background.js'), 'utf8'), { chrome, fetch, globalThis: { chrome } });
  return { listeners, created };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
// objects made inside the sandbox, as plain data
const plain = (x) => JSON.parse(JSON.stringify(x));

test('the toolbar button opens Ardite with the page, next to it', async () => {
  const { listeners, created } = loadBackground();
  listeners.action({ url: 'https://www.youtube.com/watch?v=abc&t=5', index: 3 });
  await settle();
  assert.deepEqual(plain(created), [{ url: 'http://localhost:7878/?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabc%26t%3D5', index: 4 }]);

  // a page that isn't on the web just opens Ardite
  listeners.action({ url: 'chrome://newtab/', index: 0 });
  await settle();
  assert.equal(created[1].url, 'http://localhost:7878/');
});

test('the menu item sends the link, or the page, to the address set in the options', async () => {
  const { listeners, created } = loadBackground({ saved: 'http://192.168.1.20:7878/' });
  listeners.installed();
  assert.deepEqual(plain(created.shift().menu), { id: 'ardite', title: '[menu]', contexts: ['link', 'page', 'video', 'audio'] });
  listeners.menu({ linkUrl: 'https://x.com/a/status/1', pageUrl: 'https://x.com/home' }, { index: 0 });
  listeners.menu({ pageUrl: 'https://vimeo.com/5' }, { index: 0 });
  await settle();
  assert.deepEqual(created.map((c) => c.url), [
    'http://192.168.1.20:7878/?url=https%3A%2F%2Fx.com%2Fa%2Fstatus%2F1',
    'http://192.168.1.20:7878/?url=https%3A%2F%2Fvimeo.com%2F5',
  ]);
});

// The files in a ZIP of stored (not compressed) entries, like zip.js writes
function unzip(buf) {
  const files = {};
  for (let i = 0; buf.readUInt32LE(i) === 0x04034b50;) {
    const size = buf.readUInt32LE(i + 18);
    const nameLength = buf.readUInt16LE(i + 26);
    const start = i + 30 + nameLength + buf.readUInt16LE(i + 28);
    files[buf.subarray(i + 30, i + 30 + nameLength).toString()] = buf.subarray(start, start + size);
    i = start + size;
  }
  return files;
}

let s;
before(async () => {
  s = await startServer();
});
after(() => s?.stop());

test('Ardite hands out the extension with its own address in it', async () => {
  const res = await new Promise((resolve, reject) => http.get(`${s.base}/ardite-extension.zip`, (r) => {
    const chunks = [];
    r.on('data', (c) => chunks.push(c));
    r.on('end', () => resolve({ status: r.statusCode, type: r.headers['content-type'], body: Buffer.concat(chunks) }));
  }).on('error', reject));
  assert.equal(res.status, 200);
  assert.equal(res.type, 'application/zip');
  const files = unzip(res.body);
  assert.deepEqual(JSON.parse(files['ardite-extension/defaults.json']), { address: s.base });
  assert.deepEqual(files['ardite-extension/manifest.json'], fs.readFileSync(file('manifest.json')));
  assert.ok(files['ardite-extension/icons/icon-128.png'] && files['ardite-extension/_locales/tr/messages.json']);
});
