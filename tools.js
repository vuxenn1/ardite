// Downloads the tools Ardite runs: yt-dlp, ffmpeg (with ffprobe) and the QR code library.
// Every file is checked against a SHA-256 hash before it's used: yt-dlp and ffmpeg against the
// checksum lists published with their releases, the QR library (a fixed version) against a known hash.
// A damaged or swapped download is thrown away and the tool already in place is kept.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { execFileSync } from 'node:child_process';

// "release" is GitHub's API answer for the release; GitHub computes a SHA-256 of every file
// it hosts, which always matches the file. The checksum list ("sums") is only a fallback:
// it's served through a cache and can lag behind for a while after a new build is published.
export const SOURCES = {
  ytdlp: {
    url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
    release: 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest',
    sums: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS',
  },
  ffmpeg: {
    url: 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
    release: 'https://api.github.com/repos/yt-dlp/FFmpeg-Builds/releases/tags/latest',
    sums: 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/checksums.sha256',
  },
  qrcode: {
    url: 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js',
    sha256: '18ae399f81182bc9de916e9c77b195df20cc58d6f2d55a62b085a299f1bf1780',
  },
};

// ffmpeg is updated about once a month (its builds change daily, so "newer" alone isn't a reason)
export const FFMPEG_MAX_AGE = 30 * 86400000;

const toolError = (message, code = 'toolBadFile') => Object.assign(new Error(message), { code });

// "<hash>  <file name>" lines (sha256sum format, "*" marks binary mode) -> Map(name -> hash)
export function parseSums(text) {
  const sums = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([a-f0-9]{64}) [ *](.+)$/i.exec(line.trim());
    if (m) sums.set(m[2].trim(), m[1].toLowerCase());
  }
  return sums;
}

const get = (url, headers) => fetch(url, { redirect: 'follow', headers, signal: AbortSignal.timeout(30000) });

// The file to download and the hash it must have: { url, sha256 }
async function resolve(source) {
  if (source.sha256) return { url: source.url, sha256: source.sha256 };
  const name = path.basename(new URL(source.url).pathname);
  if (source.release) {
    try {
      const res = await get(source.release, { 'User-Agent': 'Ardite', Accept: 'application/vnd.github+json' });
      const asset = res.ok ? (await res.json()).assets?.find((a) => a?.name === name) : null;
      const sha256 = /^sha256:([a-f0-9]{64})$/.exec(String(asset?.digest || ''))?.[1];
      // https only (plain http just for this PC, used by the tests)
      if (sha256 && /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(asset.browser_download_url || '')) {
        return { url: asset.browser_download_url, sha256 };
      }
    } catch { /* GitHub's API unreachable or rate-limited: use the checksum list */ }
  }
  const res = await get(source.sums);
  if (!res.ok) throw toolError(`Could not get the checksums: HTTP ${res.status}`, 'toolDownloadFailed');
  const sha256 = parseSums(await res.text()).get(name);
  if (!sha256) throw toolError('The checksum list has no entry for this file');
  return { url: source.url, sha256 };
}

async function fetchChecked({ url, sha256 }, dest, onProgress) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60000) });
  if (!res.ok || !res.body) throw toolError(`HTTP ${res.status}`, 'toolDownloadFailed');
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  let done = 0;
  const count = new Transform({
    transform(chunk, _enc, cb) {
      done += chunk.length;
      hash.update(chunk);
      onProgress?.(done, total);
      cb(null, chunk);
    },
  });
  const tmp = dest + '.part';
  try {
    await pipeline(Readable.fromWeb(res.body), count, fs.createWriteStream(tmp));
    const got = hash.digest('hex');
    if (got !== sha256) throw toolError(`Checksum mismatch (expected ${sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…)`);
    fs.renameSync(tmp, dest);
    return got;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Downloads to "<dest>.part", checks the hash and only then puts the file in place.
// A mismatch is tried once more with a fresh hash, in case a new build came out meanwhile.
// onProgress(done, total) is called while downloading.
export async function download(source, dest, { onProgress, retryDelay = 5000 } = {}) {
  try {
    return await fetchChecked(await resolve(source), dest, onProgress);
  } catch (e) {
    if (e.code !== 'toolBadFile' || source.sha256) throw e;
    await new Promise((r) => setTimeout(r, retryDelay));
    return fetchChecked(await resolve(source), dest, onProgress);
  }
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(p, name);
      if (found) return found;
    } else if (entry.name.toLowerCase() === name) {
      return p;
    }
  }
  return null;
}

const ffmpegInfoFile = (bin) => path.join(bin, 'ffmpeg.json');

// { sha256, installed } of the ffmpeg in bin/, or null when it was put there by an older Ardite
export function ffmpegInfo(bin) {
  try {
    const info = JSON.parse(fs.readFileSync(ffmpegInfoFile(bin), 'utf8'));
    return Number.isFinite(info.installed) ? info : null;
  } catch {
    return null;
  }
}

export function ffmpegDue(bin, now = Date.now()) {
  const info = ffmpegInfo(bin);
  return !info || now - info.installed > FFMPEG_MAX_AGE;
}

// Downloads ffmpeg, checks it and copies ffmpeg.exe and ffprobe.exe into bin/.
// canReplace() is asked right before copying, so a download that started meanwhile isn't disturbed.
export async function installFfmpeg(bin, { onProgress, onExtract, canReplace = () => true } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ardite-ffmpeg-'));
  try {
    const zip = path.join(work, 'ffmpeg.zip');
    const sha256 = await download(SOURCES.ffmpeg, zip, { onProgress });
    onExtract?.();
    // tar.exe that ships with Windows 10+ can extract zip files
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-xf', zip, '-C', work], { stdio: 'ignore', windowsHide: true });
    const files = ['ffmpeg.exe', 'ffprobe.exe'].map((name) => {
      const src = findFile(work, name);
      if (!src) throw toolError(`${name} not found in the archive`);
      return { name, src };
    });
    if (!canReplace()) throw toolError('busy', 'toolBusy');
    for (const f of files) fs.copyFileSync(f.src, path.join(bin, f.name));
    fs.writeFileSync(ffmpegInfoFile(bin), JSON.stringify({ sha256, installed: Date.now() }));
    return sha256;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
