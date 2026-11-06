// Runs the real server in a temp folder with a stand-in for yt-dlp (.github/fake-yt-dlp.mjs),
// so downloads, the queue, retries, the disk check and previews are tested without internet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, waitFor, sleep } from '../.github/test-server.mjs';

const job = (s, id) => s.call(`/api/jobs/${id}`).then((r) => r.data);
const finished = (s, id) => waitFor(async () => {
  const j = await job(s, id);
  return ['done', 'error', 'canceled'].includes(j.status) && j;
}, `job ${id} to finish`);
const start = async (s, url, extra = {}) => (await s.call('/api/jobs', 'POST', { url, mode: 'video', ...extra })).data;

// one download at a time, so the queue order is easy to see
let s;
before(async () => {
  s = await startServer({ config: { maxConcurrent: 1, minFreeGB: 0.5 } });
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

test('a canceled download stays canceled while yt-dlp still prints progress on its way out', async () => {
  // yt-dlp takes a moment to stop; a progress line in that moment used to mark the job as running
  // again, and it then ended as an error. A fast download prints such lines all the time.
  for (let i = 0; i < 4; i++) {
    const j = await start(s, `https://fake.test/race${i}?ms=6000&chatty=1`);
    await waitFor(() => s.calls().some((c) => c.what === 'download-start' && c.id === `race${i}`), 'the download to start');
    await sleep(40);
    await s.call(`/api/jobs/${j.id}`, 'DELETE');
    // the job reads "canceled" at once; what counts is how it ends once yt-dlp has really stopped
    await sleep(800);
    assert.equal((await job(s, j.id)).status, 'canceled', `try ${i + 1}`);
  }
});

test('a passing 403 is retried and the download still works', async () => {
  const j = await start(s, 'https://fake.test/r1?flaky=1');
  assert.equal((await finished(s, j.id)).status, 'done');
  assert.equal(s.calls().filter((c) => c.what === 'download-start' && c.id === 'r1').length, 2);
  assert.match(s.log(), /transient error, retry 1\/2/);
});

test('yt-dlp switches to the nightly channel and back to stable', async () => {
  // (other checks, like the one 5 s after start, may run in between, so only the outcome counts)
  const settled = (channel, version) => waitFor(async () => {
    const st = (await s.call('/api/ytdlp')).data;
    return st.channel === channel && st.version === version && !st.updating && !st.waiting;
  }, `yt-dlp ${channel}`);

  assert.equal((await s.call('/api/ytdlp/channel', 'PUT', { channel: 'nightly' })).status, 202);
  await settled('nightly', '2099.01.02.000000');
  assert.match(s.log(), /Updated yt-dlp to nightly/);

  await s.call('/api/ytdlp/channel', 'PUT', { channel: 'stable' });
  await settled('stable', '2099.01.01');
  assert.match(s.log(), /Updated yt-dlp to stable/);

  // anything else means stable
  await s.call('/api/ytdlp/channel', 'PUT', { channel: 'beta' });
  await settled('stable', '2099.01.01');
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
  const tight = await startServer({ config: { minFreeGB: 1e9 } });
  try {
    const j = await start(tight, 'https://fake.test/n1');
    const done = await finished(tight, j.id);
    assert.equal(done.error.code, 'diskFull');
    assert.ok(!tight.calls().some((c) => c.what === 'download-start'), 'yt-dlp never ran');
  } finally {
    await tight.stop();
  }
});

test('a download keeps its length, channel, time taken and the device name in the history', async () => {
  const name = 'Ayşe\'nin telefonu';
  const who = { 'X-Ardite-Device': encodeURIComponent(name), 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/130' };
  const j = (await s.call('/api/jobs', 'POST', { url: 'https://fake.test/n1?ms=300', mode: 'video' }, who)).data;
  assert.equal((await finished(s, j.id)).status, 'done');
  const entry = (await s.call('/api/history')).data[0];
  assert.equal(entry.deviceName, name);
  assert.equal(entry.duration, 60); // 60.4 s, rounded
  assert.equal(entry.channel, 'Fake channel | with a bar');
  assert.ok(entry.took >= 300, `took ${entry.took} ms`);
});

test('statistics count every download, give a CSV and can be reset', async () => {
  const st = (await s.call('/api/stats')).data;
  assert.ok(st.total.downloads >= 4, `${st.total.downloads} downloads`);
  assert.ok(st.total.failed >= 1, 'failed downloads count too');
  assert.ok(st.devices.some((d) => d.key === 'Ayşe\'nin telefonu'));
  assert.equal(st.months.length, 12);
  assert.ok(st.speed > 0);

  const csv = await s.call('/api/stats.csv');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const text = csv.data.toString('utf8');
  assert.ok(text.startsWith('﻿date,outcome,'), 'a BOM so Excel reads it as UTF-8');
  assert.ok(text.split('\r\n').length > st.total.downloads, 'a row per record');

  assert.equal((await s.call('/api/stats', 'DELETE')).status, 200);
  assert.equal((await s.call('/api/stats')).data.total.downloads, 0);
  // the history stays
  assert.ok((await s.call('/api/history')).data.length > 0);
});

test('statistics start with the downloads already in the history', async () => {
  const history = [
    { id: 'a1', date: Date.now() - 86400000, kind: 'video', mode: 'video', site: 'youtube.com', size: 500, media: { height: 1080, codec: 'VP9' }, device: 'pc' },
    { id: 'b2', date: Date.now(), kind: 'playlist', mode: 'audio', site: 'youtube.com', count: 3, size: 900, device: 'android' },
  ];
  const old = await startServer({ history });
  try {
    const st = (await old.call('/api/stats')).data;
    assert.equal(st.total.downloads, 4);
    assert.equal(st.total.bytes, 1400);
    assert.deepEqual(st.qualities, [{ key: '1080p', count: 1, bytes: 500 }]);
  } finally {
    await old.stop();
  }
});

test('a trimmed part is counted with its own length, not the whole video\'s', async () => {
  const j = await start(s, 'https://fake.test/part1', { trim: { start: 10, end: 25 } });
  assert.equal((await finished(s, j.id)).status, 'done');
  assert.equal((await s.call('/api/history')).data[0].duration, 15);
});

test('a GIF needs a short part with an end', async () => {
  for (const trim of [null, { start: 0, end: 45 }, { start: 5 }]) {
    const r = await s.call('/api/jobs', 'POST', { url: 'https://fake.test/g0', mode: 'gif', trim });
    assert.equal(r.status, 400, JSON.stringify(trim));
    assert.equal(r.data.code, 'gifLength');
  }
});

test('a GIF without ffmpeg ends with a clear error (the stand-in makes no real video)', async () => {
  const j = await start(s, 'https://fake.test/g1', { mode: 'gif', gifWidth: 320, trim: { start: 0, end: 4 } });
  const done = await finished(s, j.id);
  assert.equal(done.status, 'error');
  assert.equal(done.error.code, 'gifFailed');
  assert.match(s.log(), /new job: gif 320px cut 0-4/);
  // the stand-in was asked for the picture only, cut exactly
  assert.ok(s.calls().some((c) => c.what === 'download-start' && c.id === 'g1'));
});
