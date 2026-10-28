// Subtitles: which ones a video has, downloading them with yt-dlp, shifting them for
// trimmed videos and embedding them into the MP4 as tracks that can be switched on and off.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Subtitle tracks in MP4 need ISO 639-2 codes ("tur"); ffmpeg drops two-letter ones ("tr")
const ISO3 = {
  af: 'afr', am: 'amh', ar: 'ara', az: 'aze', be: 'bel', bg: 'bul', bn: 'ben', bs: 'bos', ca: 'cat',
  cs: 'ces', cy: 'cym', da: 'dan', de: 'deu', el: 'ell', en: 'eng', es: 'spa', et: 'est', eu: 'eus',
  fa: 'fas', fi: 'fin', fr: 'fra', ga: 'gle', gl: 'glg', gu: 'guj', he: 'heb', iw: 'heb', hi: 'hin',
  hr: 'hrv', hu: 'hun', hy: 'hye', id: 'ind', in: 'ind', is: 'isl', it: 'ita', ja: 'jpn', jv: 'jav',
  ka: 'kat', kk: 'kaz', km: 'khm', kn: 'kan', ko: 'kor', ku: 'kur', ky: 'kir', lo: 'lao', lt: 'lit',
  lv: 'lav', mk: 'mkd', ml: 'mal', mn: 'mon', mr: 'mar', ms: 'msa', my: 'mya', nb: 'nob', ne: 'nep',
  nl: 'nld', no: 'nor', pa: 'pan', pl: 'pol', ps: 'pus', pt: 'por', ro: 'ron', ru: 'rus', si: 'sin',
  sk: 'slk', sl: 'slv', so: 'som', sq: 'sqi', sr: 'srp', sv: 'swe', sw: 'swa', ta: 'tam', te: 'tel',
  th: 'tha', tl: 'tgl', tr: 'tur', uk: 'ukr', ur: 'urd', uz: 'uzb', vi: 'vie', zh: 'zho', zu: 'zul',
};

const baseLang = (code) => String(code).replace(/-orig$/, '').split('-')[0].toLowerCase();
const isAuto = (code) => /-orig$/.test(code);

function iso3(code) {
  const base = baseLang(code);
  if (/^[a-z]{3}$/.test(base)) return base;
  return ISO3[base] || 'und';
}

// "Türkçe", "English (auto)": the language named in itself, shown by video players
function trackTitle(code) {
  let name = code;
  try {
    name = new Intl.DisplayNames([baseLang(code)], { type: 'language' }).of(code.replace(/-orig$/, '')) || code;
    name = name.charAt(0).toLocaleUpperCase(baseLang(code)) + name.slice(1);
  } catch { /* keep the code */ }
  return isAuto(code) ? `${name} (auto)` : name;
}

// What the preview shows: subtitles written by people, plus YouTube's automatic one
// in the video's own language ("en-orig"). Machine translations into other languages are left out.
export function summarizeSubs(info) {
  const list = Object.entries(info.subtitles || {})
    .filter(([code, formats]) => code !== 'live_chat' && Array.isArray(formats) && formats.length)
    .map(([code, formats]) => ({ code, name: formats[0].name || code }));
  const autoCode = Object.keys(info.automatic_captions || {}).find(isAuto);
  const auto = autoCode ? { code: autoCode, name: info.automatic_captions[autoCode][0]?.name || autoCode } : null;
  return { list, auto };
}

// { langs: ['tr', 'en'], auto: bool, srt: bool } from the request; null when nothing is asked for
export function parseSubsOption(s) {
  if (!s || typeof s !== 'object') return null;
  const langs = (Array.isArray(s.langs) ? s.langs : [])
    .map(String)
    .filter((c) => /^[a-zA-Z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(c))
    .slice(0, 10);
  const auto = s.auto === true;
  if (!langs.length && !auto) return null;
  return { langs: [...new Set(langs)], auto, srt: s.srt === true };
}

export function subtitleArgs(subs) {
  const langs = [...subs.langs];
  if (subs.auto) langs.push('.*-orig'); // the automatic subtitle in the video's own language
  const args = ['--write-subs', '--sub-langs', langs.join(','), '--convert-subs', 'srt'];
  if (subs.auto) args.push('--write-auto-subs');
  return args;
}

// Subtitle files yt-dlp wrote next to the video: "<video name>.<lang>.srt"
export function findSubFiles(dir, videoFile) {
  const base = path.parse(videoFile).name + '.';
  const found = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith(base)) continue;
    if (/\.(vtt|ttml|srv\d|json3)$/i.test(f)) {
      fs.rmSync(path.join(dir, f), { force: true }); // leftovers from the conversion to SRT
      continue;
    }
    if (!/\.srt$/i.test(f)) continue;
    const lang = f.slice(base.length, -4);
    if (lang) found.push({ lang, name: f, path: path.join(dir, f) });
  }
  // keep the order the languages were asked in, automatic ones last
  return found.sort((a, b) => Number(isAuto(a.lang)) - Number(isAuto(b.lang)));
}

const SRT_TIME = /(\d+):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{3})/;

function srtStamp(ms) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(Math.floor(ms % 1000), 3)}`;
}

// yt-dlp downloads the subtitles of the whole video, so for a trimmed part they are moved
// to start at 0 and anything outside the part is dropped
export function shiftSrt(text, startSec, endSec) {
  const offset = Math.round(startSec * 1000);
  const length = endSec == null ? Infinity : Math.round((endSec - startSec) * 1000);
  const out = [];
  for (const block of text.replace(/^﻿/, '').split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const i = lines.findIndex((l) => SRT_TIME.test(l));
    if (i < 0) continue;
    const m = SRT_TIME.exec(lines[i]).slice(1).map(Number);
    let a = ((m[0] * 60 + m[1]) * 60 + m[2]) * 1000 + m[3] - offset;
    let b = ((m[4] * 60 + m[5]) * 60 + m[6]) * 1000 + m[7] - offset;
    if (b <= 0 || a >= length) continue;
    a = Math.max(0, a);
    b = Math.min(b, length);
    const body = lines.slice(i + 1).join('\n').trim();
    if (body) out.push(`${out.length + 1}\n${srtStamp(a)} --> ${srtStamp(b)}\n${body}`);
  }
  return out.join('\n\n') + '\n';
}

// Puts the subtitles into the MP4 as switchable tracks (the video itself is only copied).
// Returns the ffmpeg process through onSpawn so a cancel can stop it.
export function embedSubs(ffmpeg, videoFile, tracks, onSpawn) {
  const out = videoFile.replace(/\.mp4$/i, '.subs.mp4');
  const args = ['-v', 'error', '-y', '-i', videoFile];
  for (const t of tracks) args.push('-i', t.path);
  args.push('-map', '0:v?', '-map', '0:a?');
  tracks.forEach((t, i) => args.push('-map', `${i + 1}:0`));
  args.push('-c', 'copy', '-c:s', 'mov_text');
  tracks.forEach((t, i) => {
    args.push(`-metadata:s:s:${i}`, `language=${iso3(t.lang)}`, `-metadata:s:s:${i}`, `title=${trackTitle(t.lang)}`);
    // the first track shows by default, since subtitles were asked for
    args.push(`-disposition:s:${i}`, i === 0 ? 'default' : '0');
  });
  args.push(out);

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { windowsHide: true });
    onSpawn?.(proc);
    let err = '';
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', (e) => (err += e.message));
    proc.on('close', (code) => {
      if (code === 0) {
        fs.renameSync(out, videoFile);
        resolve();
      } else {
        fs.rmSync(out, { force: true });
        reject(new Error(err.trim().split(/\r?\n/).pop() || `ffmpeg exited with ${code}`));
      }
    });
  });
}
