// The `ardite` command on a throwaway copy of Ardite: starting, status, stopping and a port taken
// by another program. Autostart and the firewall change the system, so only their texts are
// tested (platform.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePort } from '../.github/test-server.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const FAKE = path.join(REPO, '.github', 'fake-yt-dlp.mjs');

test('ardite start, status and stop', { timeout: 120000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ardite-manager-test-'));
  const app = path.join(dir, 'app');
  fs.mkdirSync(path.join(app, 'data'), { recursive: true });
  for (const f of fs.readdirSync(REPO)) if (f.endsWith('.js')) fs.copyFileSync(path.join(REPO, f), path.join(app, f));
  for (const d of ['lib', 'public']) fs.cpSync(path.join(REPO, d), path.join(app, d), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(app, 'package.json'));
  fs.writeFileSync(path.join(app, 'data', 'config.json'), JSON.stringify({ updateCheck: false }));
  const port = await freePort();
  const pidFile = path.join(app, 'data', 'ardite.pid');

  t.after(async () => {
    try {
      process.kill(JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid); // left running by a failed check
      await new Promise((r) => setTimeout(r, 500));
    } catch { /* stopped */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const ardite = (...args) => new Promise((resolve) => {
    execFile(process.execPath, [path.join(app, 'ardite.js'), ...args], {
      cwd: dir,
      timeout: 60000,
      env: { ...process.env, PORT: String(port), ARDITE_YTDLP: FAKE, TEMP: dir, TMP: dir, TMPDIR: dir },
    }, (err, stdout) => resolve({ code: err ? err.code : 0, out: stdout }));
  });

  let r = await ardite('start');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`Ardite started: http://localhost:${port}`));
  const { pid } = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0);

  r = await ardite('status');
  assert.match(r.out, /Status\s+: RUNNING \(v0\.0\.0-dev\)/);
  assert.match(r.out, /Autostart : (on|off)/);
  assert.match(r.out, new RegExp(`This PC\\s+: http://localhost:${port}`));

  r = await ardite('start');
  assert.match(r.out, /already running/);

  r = await ardite('stop');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Ardite stopped/);
  assert.ok(!fs.existsSync(pidFile), 'the pid file is gone');
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(2000) }));

  r = await ardite('stop');
  assert.match(r.out, /not running/);
  r = await ardite('status');
  assert.match(r.out, /Status\s+: stopped/);

  // another program on the port: never taken for Ardite, never stopped
  const other = net.createServer((s) => s.end()).listen(port, '127.0.0.1');
  t.after(() => other.close());
  await new Promise((res) => other.once('listening', res));
  r = await ardite('start');
  assert.equal(r.code, 1);
  assert.match(r.out, new RegExp(`Port ${port} is used by another program`));
  r = await ardite('stop');
  assert.match(r.out, /not running/);
  assert.ok(other.listening);
});

test('ardite lists its commands, and refuses unknown ones', async () => {
  const run = (...args) => new Promise((resolve) => {
    execFile(process.execPath, [path.join(REPO, 'ardite.js'), ...args], { timeout: 30000 },
      (err, stdout) => resolve({ code: err ? err.code : 0, out: stdout }));
  });
  let r = await run('help');
  assert.equal(r.code, 0);
  for (const c of ['install', 'start', 'status', 'update', 'autostart', 'uninstall']) assert.match(r.out, new RegExp(`\\b${c}\\b`));
  r = await run('fly');
  assert.equal(r.code, 1);
  assert.match(r.out, /Unknown command: fly/);
});
