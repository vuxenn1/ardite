// Starts a throwaway Ardite for the tests: a copy of this repo in a temp folder, its own port and
// data, and the stand-in yt-dlp (fake-yt-dlp.mjs), so nothing needs internet or touches a real install.
// Kept out of test/ because `node --test` runs every file there as a test.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(REPO, '.github', 'fake-yt-dlp.mjs');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

// Polls until check() returns something truthy
export async function waitFor(check, what, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

// config: data/config.json; history: data/history.json to start with
export async function startServer({ config = {}, history } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ardite-server-test-'));
  const app = path.join(dir, 'app');
  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(app, 'data'), { recursive: true });
  fs.mkdirSync(state);
  for (const f of fs.readdirSync(REPO)) if (f.endsWith('.js')) fs.copyFileSync(path.join(REPO, f), path.join(app, f));
  for (const d of ['lib', 'public']) fs.cpSync(path.join(REPO, d), path.join(app, d), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(app, 'package.json'));
  fs.writeFileSync(path.join(app, 'data', 'config.json'), JSON.stringify({ updateCheck: false, ...config }));
  if (history) fs.writeFileSync(path.join(app, 'data', 'history.json'), JSON.stringify(history));

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: app,
    env: { ...process.env, PORT: String(port), TEMP: dir, TMP: dir, TMPDIR: dir, ARDITE_YTDLP: FAKE, FAKE_YTDLP_STATE: state },
    stdio: 'ignore',
  });
  await waitFor(() => fetch(base + '/api/status', { signal: AbortSignal.timeout(2000) }).then(() => true, () => false), 'the server to start');

  const call = async (p, method = 'GET', body, headers = {}) => {
    const res = await fetch(base + p, {
      signal: AbortSignal.timeout(30000),
      method,
      headers: { Origin: base, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  return {
    port,
    base,
    call,
    // the stand-in's notes, e.g. "download-start a1"
    calls: () => read(path.join(state, 'calls.log')).split('\n').filter(Boolean).map((l) => {
      const [time, what, id] = l.split(' ');
      return { time: Number(time), what, id };
    }),
    log: () => read(path.join(app, 'data', 'ardite.log')),
    async stop() {
      proc.kill();
      await new Promise((r) => (proc.exitCode !== null ? r() : proc.once('exit', r)));
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}
