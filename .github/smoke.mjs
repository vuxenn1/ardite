// Starts a packaged Ardite and checks that it really works. The release workflow runs this
// before publishing, so a broken package (e.g. a missing file) never reaches anyone.
// Usage: node .github/smoke.mjs <app folder> [expected version]
// The app folder needs bin/yt-dlp(.exe); runtime/node(.exe) is used when it's there.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const appDir = path.resolve(process.argv[2] || '.');
const expectedVersion = process.argv[3];
const port = Number(process.env.SMOKE_PORT) || 7990;
const base = `http://127.0.0.1:${port}`;
const bundled = path.join(appDir, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
const node = fs.existsSync(bundled) ? bundled : process.execPath;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ardite-smoke-'));

let output = '';
const server = spawn(node, ['server.js'], {
  cwd: appDir,
  env: { ...process.env, PORT: String(port), TEMP: tmp, TMP: tmp, TMPDIR: tmp },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => (output += d));
server.stderr.on('data', (d) => (output += d));

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
const get = async (p, init) => {
  const res = await fetch(base + p, init);
  return { status: res.status, type: res.headers.get('content-type') || '', text: await res.text() };
};
// fetch() won't send a made-up Host header or use another local address, so these go through http.
// Requests from 127.0.0.2 count as another device (only 127.0.0.1 is "this PC").
const raw = (p, method, headers, { body = method === 'POST' ? '{}' : undefined, from } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, localAddress: from }, (res) => {
    let text = '';
    res.on('data', (d) => (text += d));
    res.on('end', () => resolve({ status: res.statusCode, text }));
  });
  req.on('error', reject);
  req.end(body);
});

try {
  // wait for the server to come up
  let status = null;
  for (let i = 0; i < 60 && !status; i++) {
    if (server.exitCode !== null) break;
    try {
      status = JSON.parse((await get('/api/status')).text);
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  check(!!status, `server answers on ${base}`);
  if (!status) throw new Error('server did not start');

  check(status.name === 'Ardite', 'status says Ardite');
  if (expectedVersion) check(status.version === expectedVersion, `version is ${expectedVersion} (got ${status.version})`);

  // the page and every script and stylesheet it loads (vendor files come from setup, not the package)
  const page = await get('/');
  check(page.status === 200 && page.type.includes('text/html'), 'page loads');
  const assets = [...page.text.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css|svg|webmanifest))"/g)]
    .map((m) => m[1])
    .filter((p) => !p.startsWith('/vendor/'));
  check(assets.length >= 4, `page links its files (${assets.join(', ')})`);
  for (const a of assets) check((await get(a)).status === 200, `serves ${a}`);

  // a few API answers that need no internet
  const history = await get('/api/history');
  check(history.status === 200 && Array.isArray(JSON.parse(history.text)), 'history answers');
  const bad = await get('/api/info', { method: 'POST', body: JSON.stringify({ url: 'not a link' }) });
  check(bad.status === 400 && JSON.parse(bad.text).code === 'invalidUrl', 'rejects a bad link');
  const missing = await get('/api/jobs/abcdef');
  check(missing.status === 404 && JSON.parse(missing.text).code === 'jobNotFound', 'unknown download is a 404');
  const escape = await get('/..%2f..%2fserver.js');
  check(escape.status === 403 || escape.status === 404, 'files outside public/ are not served');

  // HTTPS on the same port, with the certificate phones install (and a page that explains how)
  check(status.https === true, 'HTTPS is on');
  const crt = await new Promise((resolve, reject) => http.get(`${base}/ardite.crt`, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
  }).on('error', reject));
  check(crt.status === 200 && new crypto.X509Certificate(crt.body).ca, 'serves the certificate for phones');
  const secure = await new Promise((resolve) => https.get(`https://127.0.0.1:${port}/api/status`,
    { ca: new crypto.X509Certificate(crt.body).toString(), agent: false }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => resolve(text));
    }).on('error', (e) => resolve(e.message)));
  check(/"name":"Ardite"/.test(secure), `answers on https:// with that certificate (${secure.slice(0, 60)})`);
  check((await get('/secure')).status === 200, 'serves the HTTPS setup page');

  // the browser extension, as a ZIP set to this address
  const ext = await new Promise((resolve, reject) => http.get(`${base}/ardite-extension.zip`, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
  }).on('error', reject));
  check(ext.status === 200 && ext.body.includes('ardite-extension/manifest.json') && ext.body.includes(`"address": "${base}"`),
    'serves the browser extension with this address in it');

  // other websites can't use Ardite
  check((await raw('/api/history', 'GET', { Host: `evil.example:${port}` })).status === 403, 'refuses a foreign address (DNS rebinding)');
  check((await raw('/api/jobs', 'POST', { Origin: 'https://evil.example', 'Content-Type': 'text/plain' })).status === 403,
    'refuses a download started by another website');
  check((await raw('/api/info', 'POST', { Origin: base })).status === 400, 'accepts its own page');

  // with a PIN, other devices are locked out until they enter it; this PC never is
  const json = { Origin: base, 'Content-Type': 'application/json' };
  check((await raw('/api/pin', 'PUT', json, { body: '{"pin":"2468"}' })).status === 200, 'sets a PIN');
  check(JSON.parse((await raw('/api/status', 'GET', {}, { from: '127.0.0.2' })).text).locked === true, 'another device sees the lock');
  check((await raw('/api/history', 'GET', {}, { from: '127.0.0.2' })).status === 401, 'another device can\'t read the history');
  check((await get('/api/history')).status === 200, 'this PC needs no PIN');
  check((await raw('/api/unlock', 'POST', json, { body: '{"pin":"2468"}', from: '127.0.0.2' })).status === 200, 'the right PIN unlocks');
  check((await raw('/api/pin', 'DELETE', { Origin: base })).status === 200, 'removes the PIN');
} catch (e) {
  failures.push(e.message);
} finally {
  // wait for the server to really exit before removing its temp folder
  if (server.exitCode === null) {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch { /* the OS cleans its temp folder eventually */ }
}

if (failures.length) {
  console.log('\nServer output:\n' + output);
  console.log(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed');
