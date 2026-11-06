import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, qualityName, statsCsv } from '../lib/stats-report.js';

// local dates, the way the statistics page counts them
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
const NOW = at(2026, 11, 6, 15);

const RECORDS = [
  { date: at(2026, 11, 6, 9), outcome: 'done', mode: 'video', site: 'youtube.com', size: 300, duration: 60, took: 3000, height: 1080, codec: 'H.264', ext: 'mp4', device: 'android', deviceName: 'Ayşe telefon' },
  { date: at(2026, 11, 6, 9), outcome: 'done', mode: 'video', site: 'youtube.com', size: 700, duration: 120, took: 7000, height: 2160, codec: 'VP9', ext: 'mp4', device: 'pc', trimmed: true },
  { date: at(2026, 11, 2, 21), outcome: 'done', mode: 'audio', site: 'instagram.com', size: 100, duration: 30, ext: 'mp3', device: 'pc', subs: 1 },
  { date: at(2026, 10, 15, 21), outcome: 'done', kind: 'playlist', mode: 'video', site: 'youtube.com', count: 4, size: 2000, device: 'pc' },
  { date: at(2026, 10, 15, 22), outcome: 'error', error: 'format', mode: 'video', site: 'x.com', device: 'pc' },
];

test('summarize counts downloads, sizes, time and the success rate', () => {
  const s = summarize(RECORDS, NOW);
  assert.deepEqual(s.total, { downloads: 7, bytes: 3100, seconds: 210, failed: 1, video: 6, audio: 1, gif: 0 });
  assert.equal(s.successRate, 4 / 5);
  assert.equal(s.speed, 100); // 1000 bytes in 10 s; downloads without a time don't count
  assert.deepEqual(s.extras, { trimmed: 1, withSubs: 1, fromPlaylists: 4 });
  assert.equal(s.since, at(2026, 10, 15, 21));
});

test('summarize splits by site, device, quality, codec and audio format', () => {
  const s = summarize(RECORDS, NOW);
  assert.deepEqual(s.sites[0], { key: 'youtube.com', count: 6, bytes: 3000 });
  assert.deepEqual(s.devices.map((d) => [d.key, d.count]), [['pc', 6], ['Ayşe telefon', 1]]);
  assert.deepEqual(s.qualities.map((q) => q.key), ['4K', '1080p']); // same count: the bigger one first
  assert.deepEqual(s.codecs.map((c) => c.key).sort(), ['H.264', 'VP9']);
  assert.deepEqual(s.audioFormats, [{ key: 'MP3', count: 1, bytes: 100 }]);
});

test('summarize lays out months, days, weekdays and hours', () => {
  const s = summarize(RECORDS, NOW);
  assert.equal(s.months.length, 12);
  assert.deepEqual(s.thisMonth, { key: '2026-11', count: 3, bytes: 1100 });
  assert.deepEqual(s.lastMonth, { key: '2026-10', count: 4, bytes: 2000 });
  assert.equal(s.months[0].key, '2025-12');
  assert.equal(s.days.length, 30);
  assert.equal(s.days.at(-1).key, '2026-11-06');
  assert.equal(s.days.at(-1).count, 2);
  assert.deepEqual(s.busiestDay, { key: '2026-10-15', count: 4, bytes: 2000 });
  assert.equal(s.weekdays.reduce((a, b) => a + b), 7);
  assert.equal(s.weekdays[4], 2); // Friday, 6 Nov 2026
  assert.equal(s.hours[21], 5);
});

test('summarize works with no records and keeps big lists short', () => {
  const empty = summarize([], NOW);
  assert.equal(empty.total.downloads, 0);
  assert.equal(empty.successRate, null);
  assert.equal(empty.speed, null);
  assert.equal(empty.since, null);
  const many = Array.from({ length: 12 }, (_, i) => ({ date: NOW, outcome: 'done', site: `site${i}.com`, size: 1 }));
  const sites = summarize(many, NOW).sites;
  assert.equal(sites.length, 8);
  assert.deepEqual(sites.at(-1), { key: 'other', count: 5, bytes: 5 });
});

test('qualityName names video heights like the rest of Ardite', () => {
  assert.equal(qualityName(1080), '1080p');
  assert.equal(qualityName(1072), '1080p'); // a little short, still 1080p
  assert.equal(qualityName(2160), '4K');
  assert.equal(qualityName(4320), '8K');
  assert.equal(qualityName(240), '<360p');
  assert.equal(qualityName(null), null);
});

test('statsCsv writes one row per record and keeps spreadsheets safe', () => {
  const csv = statsCsv([
    { date: at(2026, 11, 6), outcome: 'done', site: 'youtube.com', trimmed: true, deviceName: '=HYPERLINK("x")' },
  ]);
  const [head, row] = csv.trim().split('\r\n');
  assert.ok(head.startsWith('date,outcome,error,kind,mode,site'));
  assert.match(row, /^2026-11-06T\d\d:00:00\.000Z,done,,,,youtube\.com,/);
  assert.ok(row.includes(',yes,'));
  // a name that looks like a formula is kept as text
  assert.ok(row.endsWith(`"'=HYPERLINK(""x"")"`));
});
