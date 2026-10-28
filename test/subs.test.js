import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarizeSubs, parseSubsOption, subtitleArgs, findSubFiles, shiftSrt } from '../subs.js';

const SRT = [
  '1', '00:00:00,000 --> 00:00:07,000', 'Before the part', '',
  '2', '00:00:58,500 --> 00:01:02,000', 'Overlaps the start', '',
  '3', '00:01:05,250 --> 00:01:07,000', 'Inside', 'two lines', '',
  '4', '00:01:14,000 --> 00:01:20,000', 'Overlaps the end', '',
  '5', '00:02:00,000 --> 00:02:03,000', 'After the part', '',
].join('\r\n');

test('shiftSrt moves a trimmed part to start at 0 and drops the rest', () => {
  assert.equal(shiftSrt(SRT, 60, 75), [
    '1', '00:00:00,000 --> 00:00:02,000', 'Overlaps the start', '',
    '2', '00:00:05,250 --> 00:00:07,000', 'Inside', 'two lines', '',
    '3', '00:00:14,000 --> 00:00:15,000', 'Overlaps the end', '',
  ].join('\n'));
});

test('shiftSrt keeps everything after the start when there is no end', () => {
  assert.equal(shiftSrt(SRT, 119, null), '1\n00:00:01,000 --> 00:00:04,000\nAfter the part\n');
});

test('shiftSrt copes with a BOM, dots in times and hours', () => {
  const srt = '﻿1\n01:00:10.500 --> 01:00:12.000\nLate\n';
  assert.equal(shiftSrt(srt, 3600, null), '1\n00:00:10,500 --> 00:00:12,000\nLate\n');
});

test('summarizeSubs lists real subtitles and only the original automatic one', () => {
  const s = summarizeSubs({
    subtitles: { en: [{ name: 'English' }], 'pt-BR': [{ name: 'Portuguese (Brazil)' }], live_chat: [{}], empty: [] },
    automatic_captions: { tr: [{ name: 'Turkish' }], 'en-orig': [{ name: 'English (Original)' }] },
  });
  assert.deepEqual(s.list.map((x) => x.code), ['en', 'pt-BR']);
  assert.deepEqual(s.auto, { code: 'en-orig', name: 'English (Original)' });
  assert.deepEqual(summarizeSubs({}), { list: [], auto: null });
});

test('parseSubsOption keeps valid language codes only', () => {
  assert.deepEqual(parseSubsOption({ langs: ['tr', 'tr', 'pt-BR', 'x; rm -rf /', 5], auto: true, srt: true }), {
    langs: ['tr', 'pt-BR'], auto: true, srt: true,
  });
  assert.equal(parseSubsOption({ langs: [] }), null);
  assert.equal(parseSubsOption(null), null);
  assert.equal(parseSubsOption('tr'), null);
  assert.deepEqual(parseSubsOption({ auto: true }), { langs: [], auto: true, srt: false });
});

test('subtitleArgs asks yt-dlp for the right subtitles', () => {
  assert.deepEqual(subtitleArgs({ langs: ['tr', 'en'], auto: false }),
    ['--write-subs', '--sub-langs', 'tr,en', '--convert-subs', 'srt']);
  assert.deepEqual(subtitleArgs({ langs: ['tr'], auto: true }),
    ['--write-subs', '--sub-langs', 'tr,.*-orig', '--convert-subs', 'srt', '--write-auto-subs']);
});

test('findSubFiles finds the video\'s .srt files and clears leftovers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ardite-subs-'));
  try {
    const video = path.join(dir, 'Clip [id] (1m00s-1m15s).mp4');
    for (const f of ['Clip [id] (1m00s-1m15s).mp4', 'Clip [id] (1m00s-1m15s).en-orig.srt',
      'Clip [id] (1m00s-1m15s).tr.srt', 'Clip [id] (1m00s-1m15s).tr.vtt', 'Other.en.srt']) {
      fs.writeFileSync(path.join(dir, f), 'x');
    }
    const found = findSubFiles(dir, video);
    assert.deepEqual(found.map((f) => f.lang), ['tr', 'en-orig']); // automatic one last
    assert.equal(fs.existsSync(path.join(dir, 'Clip [id] (1m00s-1m15s).tr.vtt')), false);
    assert.equal(fs.existsSync(path.join(dir, 'Other.en.srt')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
