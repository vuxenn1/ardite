// The updater (scripts/update.mjs): its parts, and whole updates of a small stand-in app, one
// that works and one whose new version doesn't start (the old one must come back).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileList, staleFiles, makeBackup, copyOver, removeStale } from '../scripts/update.mjs';
import { freePort, waitFor } from '../.github/test-server.mjs';

const UPDATER = fileURLToPath(new URL('../scripts/update.mjs', import.meta.url));

// Windows (its virus scanner) can hold on to just-written files for a few seconds
const remove = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
const temp = (t, cleanUp = true) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ardite-update-test-'));
  if (cleanUp) t.after(() => remove(dir));
  return dir;
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const write = (root, files) => {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
};
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const has = (root, rel) => fs.existsSync(path.join(root, rel));

test('readFileList takes only plain paths inside the app, never data or bin', (t) => {
  const dir = temp(t);
  write(dir, { 'files.txt': 'server.js\r\npublic/js/app.js\n../evil.js\n/etc/passwd\nC:\\x.js\ndata/config.json\nbin/yt-dlp\na/./b.js\n\n' });
  assert.deepEqual(readFileList(dir), ['server.js', 'public/js/app.js']);
  assert.deepEqual(readFileList(path.join(dir, 'none')), []);
});

test('backup, copy and stale files: only what the update touches', (t) => {
  const dir = temp(t);
  const app = path.join(dir, 'app');
  const pkg = path.join(app, 'data', 'update', 'new', 'Ardite');
  write(app, {
    'files.txt': 'server.js\nold.js\nlib/gone.js\nlib/kept.js\n',
    'server.js': 'v1',
    'old.js': 'old',
    'lib/gone.js': 'gone',
    'lib/kept.js': 'v1',
    'data/history.json': '[]',
    'bin/yt-dlp': 'tool',
  });
  write(pkg, { 'files.txt': 'server.js\nlib/kept.js\n', 'server.js': 'v2', 'lib/kept.js': 'v2', 'public/new.js': 'new' });

  const stale = staleFiles(app, pkg);
  assert.deepEqual(stale, ['old.js', 'lib/gone.js']);

  const backup = path.join(app, 'data', 'update', 'backup');
  assert.deepEqual(makeBackup(app, pkg, stale, backup), []);
  assert.equal(read(backup, 'server.js'), 'v1');
  assert.equal(read(backup, 'old.js'), 'old');
  assert.equal(read(backup, 'lib/gone.js'), 'gone');
  assert.ok(!has(backup, 'data') && !has(backup, 'bin'), 'data and bin are not backed up');

  copyOver(pkg, app);
  removeStale(app, stale);
  assert.equal(read(app, 'server.js'), 'v2');
  assert.equal(read(app, 'lib/kept.js'), 'v2');
  assert.equal(read(app, 'public/new.js'), 'new');
  assert.ok(!has(app, 'old.js') && !has(app, 'lib/gone.js'));
  assert.equal(read(app, 'data/history.json'), '[]');
  assert.equal(read(app, 'bin/yt-dlp'), 'tool');

  // a backup inside a folder that would be backed up is never copied into itself
  write(pkg, { 'data/x': 'odd package' });
  assert.deepEqual(makeBackup(app, pkg, [], backup), ['data']);
});

// A tiny server that answers like Ardite with the version in its package.json
const SERVER = `import http from 'node:http';
import fs from 'node:fs';
const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const { port } = JSON.parse(fs.readFileSync('data/config.json', 'utf8'));
fs.writeFileSync('data/ardite.pid', String(process.pid));
http.createServer((req, res) => res.end(JSON.stringify({ name: 'Ardite', version }))).listen(port, '127.0.0.1');
`;
const BROKEN = 'process.exit(1);\n';

async function setUp(t, newServer) {
  const dir = temp(t, false);
  const app = path.join(dir, 'app');
  const pkg = path.join(app, 'data', 'update', 'new', 'Ardite');
  const port = await freePort();
  write(app, {
    'package.json': '{"version":"1.0.0","type":"module"}',
    'server.js': SERVER,
    'setup.js': '(await import("node:fs")).default.writeFileSync("data/setup.txt", "old");\n',
    'files.txt': 'package.json\nserver.js\nsetup.js\nold-only.js\n',
    'old-only.js': 'old',
    'data/config.json': JSON.stringify({ port }),
    'data/history.json': '["kept"]',
    'bin/yt-dlp': 'tool',
  });
  write(pkg, {
    'package.json': '{"version":"1.1.0","type":"module"}',
    'server.js': newServer,
    'setup.js': '(await import("node:fs")).default.writeFileSync("data/setup.txt", "new");\n',
    'files.txt': 'package.json\nserver.js\nsetup.js\nextra/new.txt\n',
    'extra/new.txt': 'new',
  });
  fs.copyFileSync(UPDATER, path.join(app, 'data', 'update', 'update.mjs'));

  const status = () => fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(2000) })
    .then((r) => r.json(), () => null);
  // stops whatever server runs from the app at the end, then removes it
  t.after(async () => {
    const pid = Number(has(app, 'data/ardite.pid') && read(app, 'data/ardite.pid'));
    if (pid && alive(pid)) {
      process.kill(pid);
      await waitFor(() => !alive(pid), 'the server to stop');
    }
    remove(dir);
  });

  // the running "old version", which exits right after starting the updater (like the server does)
  const old = spawn(process.execPath, ['server.js'], { cwd: app, stdio: 'ignore' });
  await waitFor(async () => (await status())?.version === '1.0.0', 'the old version to start');
  const updater = spawn(process.execPath, [path.join(app, 'data', 'update', 'update.mjs'),
    '--app', app, '--new', pkg, '--port', String(port), '--version', '1.1.0', '--old-version', '1.0.0',
    '--old-pid', String(old.pid), '--wait', '5'], { cwd: path.join(app, 'data', 'update'), stdio: 'ignore' });
  setTimeout(() => old.kill(), 300);
  const code = await new Promise((r) => updater.once('exit', r));
  return { app, code, status, log: read(app, 'data/update/update.log') };
}

test('an update puts the new version in place and starts it', { timeout: 90000 }, async (t) => {
  const { app, code, status, log } = await setUp(t, SERVER);
  assert.equal(code, 0, log);
  assert.equal((await status())?.version, '1.1.0');
  assert.match(log, /updating v1\.0\.0 -> v1\.1\.0/);
  assert.match(log, /removed old-only\.js \(not part of v1\.1\.0\)/);
  assert.match(log, /updated to v1\.1\.0/);
  assert.equal(read(app, 'extra/new.txt'), 'new');
  assert.ok(!has(app, 'old-only.js'));
  assert.equal(read(app, 'data/setup.txt'), 'new', 'the new setup ran');
  assert.equal(read(app, 'data/history.json'), '["kept"]');
  assert.equal(read(app, 'bin/yt-dlp'), 'tool');
  assert.ok(!has(app, 'data/update/new'), 'the unpacked package is removed');
});

test('a new version that does not start is replaced by the old one again', { timeout: 90000 }, async (t) => {
  const { app, code, status, log } = await setUp(t, BROKEN);
  assert.equal(code, 1, log);
  assert.match(log, /v1\.1\.0 did not start/);
  assert.match(log, /rolled back to v1\.0\.0/);
  assert.equal((await status())?.version, '1.0.0');
  assert.equal(read(app, 'server.js'), SERVER);
  assert.equal(read(app, 'package.json'), '{"version":"1.0.0","type":"module"}');
  assert.equal(read(app, 'old-only.js'), 'old', 'removed files come back too');
  assert.equal(read(app, 'data/history.json'), '["kept"]');
});
