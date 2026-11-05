// Runs the real server in a temp folder with a stand-in for yt-dlp (.github/fake-yt-dlp.mjs),
// so downloads, the queue, retries, the disk check and previews are tested without internet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(REPO, '.github', 'fake-yt-dlp.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

async function startServer(config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ardite-server-test-'));
  const app = path.join(dir, 'app');
  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(app, 'data'), { recursive: true });
  fs.mkdirSync(state);
  for (const f of fs.readdirSync(REPO)) if (f.endsWith('.js')) fs.copyFileSync(path.join(REPO, f), path.join(app, f));
  for (const dir of ['lib', 'public']) fs.cpSync(path.join(REPO, dir), path.join(app, dir), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(app, 'package.json'));
  fs.writeFileSync(path.join(app, 'data', 'config.json'), JSON.stringify({ updateCheck: false, ...config }));

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: app,
    env: { ...process.env, PORT: String(port), TEMP: dir, TMP: dir, TMPDIR: dir, ARDITE_YTDLP: FAKE, FAKE_YTDLP_STATE: state },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(base + '/api/status');
      break;
    } catch {
      await sleep(100);
    }
  }

  const call = async (p, method = 'GET', body) => {
    const res = await fetch(base + p, {
      method,
      headers: { Origin: base, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  return {
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

// Polls until check() returns something truthy
async function waitFor(check, what, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

const job = (s, id) => s.call(`/api/jobs/${id}`).then((r) => r.data);
const finished = (s, id) => waitFor(async () => {
  const j = await job(s, id);
  return ['done', 'error', 'canceled'].includes(j.status) && j;
}, `job ${id} to finish`);
const start = async (s, url, extra = {}) => (await s.call('/api/jobs', 'POST', { url, mode: 'video', ...extra })).data;

// one download at a time, so the queue order is easy to see
let s;
before(async () => {
  s = await startServer({ maxConcurrent: 1, minFreeGB: 0.5 });
});
after(() => s?.stop());

test('a download finishes, can be saved and goes into the history without tracking parameters', async () => {
  const j = await start(s, 'https://fake.test/a1?size=5000&ms=200&utm_source=share');
  const done = await finished(s, j.id);
  assert.equal(done.status, 'done');
  assert.equal(done.size, 5000);
  assert.deepEqual(done.media, { height: 1080, fps: 30, codec: 'H.264', hdr: null });

  const file = await s.call(`/api/jobs/${j.id}/file`);
  assert.equal(file.status, 200);
  assert.equal(file.data.length, 5000);
  assert.match(file.headers.get('content-disposition'), /Video a1 \[a1\]\.mp4/);

  const history = (await s.call('/api/history')).data;
  assert.equal(history[0].url, 'https://fake.test/a1?size=5000&ms=200');
  assert.equal(history[0].site, 'fake.test');
});

test('a single video starts at once while a playlist fills every slot', async () => {
  const entries = [1, 2, 3].map((i) => ({ index: i, url: `https://fake.test/q${i}?ms=2000`, title: `Item ${i}` }));
  const batch = (await s.call('/api/batches', 'POST', { url: 'https://fake.test/list/q', title: 'Q', entries, mode: 'video' })).data;
  await waitFor(async () => (await s.call(`/api/batches/${batch.id}`)).data.items[0].status === 'running', 'the playlist to start');

  const single = await start(s, 'https://fake.test/q-single?ms=200');
  assert.equal((await finished(s, single.id)).status, 'done');
  // it didn't wait: the first playlist item is still running, the others still queued
  const items = (await s.call(`/api/batches/${batch.id}`)).data.items;
  assert.deepEqual(items.map((i) => i.status), ['running', 'queued', 'queued']);
  await s.call(`/api/batches/${batch.id}`, 'DELETE');
});

test('canceling a download stops yt-dlp', async () => {
  const j = await start(s, 'https://fake.test/c1?ms=8000');
  await waitFor(() => s.calls().some((c) => c.what === 'download-start' && c.id === 'c1'), 'the download to start');
  await s.call(`/api/jobs/${j.id}`, 'DELETE');
  assert.equal((await finished(s, j.id)).status, 'canceled');
  await sleep(500);
  assert.ok(!s.calls().some((c) => c.what === 'download-end' && c.id === 'c1'), 'the stand-in was stopped before it finished');
});

test('a passing 403 is retried and the download still works', async () => {
  const j = await start(s, 'https://fake.test/r1?flaky=1');
  assert.equal((await finished(s, j.id)).status, 'done');
  assert.equal(s.calls().filter((c) => c.what === 'download-start' && c.id === 'r1').length, 2);
  assert.match(s.log(), /transient error, retry 1\/2/);
});

test('a failed download explains why and looks for a yt-dlp update', async () => {
  // a fresh server: its own check 5 s after start hasn't run yet, so this one isn't skipped
  const fresh = await startServer();
  try {
    const j = await start(fresh, 'https://fake.test/f1?fail=format');
    const done = await finished(fresh, j.id);
    assert.equal(done.status, 'error');
    assert.equal(done.error.code, 'format');
    await waitFor(() => /yt-dlp update \(after a failed download\)/.test(fresh.log()), 'the yt-dlp update check');
    assert.ok(fresh.calls().some((c) => c.what === 'update'));
  } finally {
    await fresh.stop();
  }
});

test('a download that would fill the disk is stopped', async () => {
  // claims a petabyte: more than any disk has free
  const j = await start(s, 'https://fake.test/d1?ms=3000&total=1e15');
  const done = await finished(s, j.id);
  assert.equal(done.status, 'error');
  assert.equal(done.error.code, 'diskFull');
  assert.match(s.log(), /stopped: the disk is almost full/);
});

test('a finished playlist downloads as one ZIP', async () => {
  const entries = [1, 2].map((i) => ({ index: i, url: `https://fake.test/z${i}?size=300`, title: `Item ${i}` }));
  const batch = (await s.call('/api/batches', 'POST', { url: 'https://fake.test/list/z', title: 'My list', entries, mode: 'video' })).data;
  await waitFor(async () => (await s.call(`/api/batches/${batch.id}`)).data.finished, 'the playlist to finish');
  const zip = await s.call(`/api/batches/${batch.id}/zip`);
  assert.equal(zip.status, 200);
  assert.equal(zip.data.subarray(0, 2).toString(), 'PK');
  const text = zip.data.toString('latin1');
  assert.ok(text.includes('1 - Video z1 [z1].mp4') && text.includes('2 - Video z2 [z2].mp4'), 'both videos are in it');
  assert.equal(Number(zip.headers.get('content-length')), zip.data.length);
});

test('previews: three at once at most, and the same link shares one run', async () => {
  const ids = ['p1', 'p2', 'p3', 'p4', 'p5'];
  const answers = await Promise.all([...ids, 'p1'].map((id) => s.call('/api/info', 'POST', { url: `https://fake.test/${id}?ms=600` })));
  assert.deepEqual(answers.map((a) => a.status), [200, 200, 200, 200, 200, 200]);
  assert.equal(answers[5].data.title, 'Video p1');

  const calls = s.calls().filter((c) => ids.includes(c.id) && c.what.startsWith('info-'));
  assert.equal(calls.filter((c) => c.what === 'info-start').length, 5, 'one run per link');
  let running = 0;
  let most = 0;
  for (const c of calls.sort((a, b) => a.time - b.time || (a.what === 'info-end' ? -1 : 1))) {
    running += c.what === 'info-start' ? 1 : -1;
    most = Math.max(most, running);
  }
  assert.ok(most <= 3, `at most 3 at once (saw ${most})`);
});

test('a preview nobody waits for anymore is stopped', async () => {
  const gone = new AbortController();
  const request = fetch(`${s.base}/api/info`, {
    method: 'POST',
    headers: { Origin: s.base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://fake.test/gone2?ms=8000' }),
    signal: gone.signal,
  }).catch(() => {});
  await waitFor(() => s.calls().some((c) => c.what === 'info-start' && c.id === 'gone2'), 'the preview to start');
  gone.abort();
  await request;
  await sleep(1000);
  assert.ok(!s.calls().some((c) => c.what === 'info-end' && c.id === 'gone2'), 'the stand-in was stopped');
});

test('no download starts without enough free disk space', async () => {
  const tight = await startServer({ minFreeGB: 1e9 });
  try {
    const j = await start(tight, 'https://fake.test/n1');
    const done = await finished(tight, j.id);
    assert.equal(done.error.code, 'diskFull');
    assert.ok(!tight.calls().some((c) => c.what === 'download-start'), 'yt-dlp never ran');
  } finally {
    await tight.stop();
  }
});
