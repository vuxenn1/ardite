import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { parseSums, download, ffmpegDue, FFMPEG_MAX_AGE } from '../lib/tools.js';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

test('parseSums reads sha256sum lists', () => {
  const a = 'a'.repeat(64);
  const b = 'B'.repeat(64);
  const sums = parseSums(`${a}  yt-dlp.exe\r\n${b} *ffmpeg-master-latest-win64-gpl.zip\nnot a line\n`);
  assert.equal(sums.get('yt-dlp.exe'), a);
  assert.equal(sums.get('ffmpeg-master-latest-win64-gpl.zip'), 'b'.repeat(64));
  assert.equal(sums.size, 2);
});

test('ffmpegDue: about once a month, and right away for an ffmpeg of unknown age', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ardite-tools-'));
  try {
    assert.equal(ffmpegDue(bin), true);
    const installed = Date.now();
    fs.writeFileSync(path.join(bin, 'ffmpeg.json'), JSON.stringify({ sha256: 'x', installed }));
    assert.equal(ffmpegDue(bin, installed + 86400000), false);
    assert.equal(ffmpegDue(bin, installed + FFMPEG_MAX_AGE + 1), true);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('download keeps a file only when its hash matches', async (t) => {
  const good = 'the real tool';
  let base;
  let builds = 0; // how often the "new build" file was fetched
  const files = {
    '/tool.exe': () => good,
    '/SUMS': () => `${sha(good)}  tool.exe\n${'0'.repeat(64)}  other.exe\n${sha('new build')}  new.exe\n`,
    '/other.exe': () => 'something else',
    // the first download comes out damaged, the second is fine
    '/new.exe': () => (builds++ ? 'new build' : 'damaged build'),
    '/release': () => JSON.stringify({ assets: [
      { name: 'tool.exe', digest: `sha256:${sha(good)}`, browser_download_url: `${base}/tool.exe` },
      { name: 'bad.exe', digest: `sha256:${sha(good)}`, browser_download_url: `${base}/other.exe` },
    ] }),
    '/stale-release': () => JSON.stringify({ assets: [] }),
  };
  const server = http.createServer((req, res) => {
    if (!(req.url in files)) return res.writeHead(404).end();
    res.end(files[req.url]());
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ardite-tools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const opts = { retryDelay: 0 };

  // checked against GitHub's own hash of the file
  const dest = path.join(dir, 'tool.exe');
  assert.equal(await download({ url: `${base}/tool.exe`, release: `${base}/release` }, dest, opts), sha(good));
  assert.equal(fs.readFileSync(dest, 'utf8'), good);
  await assert.rejects(download({ url: `${base}/bad.exe`, release: `${base}/release` }, path.join(dir, 'x'), opts), { code: 'toolBadFile' });

  // or against the published list when the release has no hash for it
  assert.equal(await download({ url: `${base}/tool.exe`, release: `${base}/stale-release`, sums: `${base}/SUMS` }, dest, opts), sha(good));

  // a mismatch is tried once more
  assert.equal(await download({ url: `${base}/new.exe`, sums: `${base}/SUMS` }, path.join(dir, 'new.exe'), opts), sha('new build'));
  assert.equal(builds, 2);
  fs.rmSync(path.join(dir, 'new.exe'));

  // a mismatch leaves the file that was there before untouched and no .part behind
  await assert.rejects(download({ url: `${base}/other.exe`, sums: `${base}/SUMS` }, dest, opts), { code: 'toolBadFile' });
  assert.equal(fs.readFileSync(dest, 'utf8'), good);
  assert.deepEqual(fs.readdirSync(dir), ['tool.exe']);

  // a fixed hash works too, and a file missing from the list is refused
  await assert.rejects(download({ url: `${base}/tool.exe`, sha256: sha('nope') }, path.join(dir, 'x')), { code: 'toolBadFile' });
  await assert.rejects(download({ url: `${base}/tool.exe`, sums: `${base}/missing` }, path.join(dir, 'x')), { code: 'toolDownloadFailed' });
  assert.deepEqual(fs.readdirSync(dir), ['tool.exe']);
});
