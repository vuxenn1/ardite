// Downloads the tools Ardite runs: yt-dlp, ffmpeg (with ffprobe) and the QR code library, in the
// builds for the system Ardite runs on.
// Every file is checked against a SHA-256 hash before it's used: yt-dlp and ffmpeg against the
// checksum lists published with their releases, the QR library (a fixed version) against a known hash.
// A damaged or swapped download is thrown away and the tool already in place is kept.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const isMusl = () => process.platform === 'linux' && !process.report?.getReport?.().header?.glibcVersionRuntime;

// The builds for a system: yt-dlp's own builds, and ffmpeg from yt-dlp's FFmpeg-Builds. Those have
// no macOS build, so on macOS ffmpeg comes from Homebrew ("brew install ffmpeg", see config.js).
// null: a system with no builds to download (yt-dlp and ffmpeg can still be put into bin/ by hand).
export function toolTarget(platform = process.platform, arch = process.arch, musl = isMusl()) {
  if (platform === 'win32') {
    return arch === 'arm64'
      ? { ytdlp: 'yt-dlp_arm64.exe', ffmpeg: 'ffmpeg-master-latest-winarm64-gpl.zip' }
      : { ytdlp: 'yt-dlp.exe', ffmpeg: 'ffmpeg-master-latest-win64-gpl.zip' };
  }
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) {
    const arm = arch === 'arm64';
    return {
      ytdlp: `yt-dlp_${musl ? 'musllinux' : 'linux'}${arm ? '_aarch64' : ''}`,
      ffmpeg: `ffmpeg-master-latest-linux${arm ? 'arm' : ''}64-gpl.tar.xz`,
    };
  }
  if (platform === 'darwin') return { ytdlp: 'yt-dlp_macos', ffmpeg: null };
  return null;
}

// "release" is GitHub's API answer for the release; GitHub computes a SHA-256 of every file
// it hosts, which always matches the file. The checksum list ("sums") is only a fallback:
// it's served through a cache and can lag behind for a while after a new build is published.
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
const FFMPEG_URL = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/';

export const ytdlpSource = (target = toolTarget()) => ({
  url: YTDLP_URL + target.ytdlp,
  release: 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest',
  sums: YTDLP_URL + 'SHA2-256SUMS',
});

export const ffmpegSource = (target = toolTarget()) => (target?.ffmpeg ? {
  url: FFMPEG_URL + target.ffmpeg,
  release: 'https://api.github.com/repos/yt-dlp/FFmpeg-Builds/releases/tags/latest',
  sums: FFMPEG_URL + 'checksums.sha256',
} : null);

export const QRCODE_SOURCE = {
  url: 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js',
  sha256: '18ae399f81182bc9de916e9c77b195df20cc58d6f2d55a62b085a299f1bf1780',
};

// ffmpeg is updated about once a month (its builds change daily, so "newer" alone isn't a reason)
export const FFMPEG_MAX_AGE = 30 * 86400000;

// Files that releases up to v1.6.0 shipped and later ones don't (they moved to lib/ and public/js/).
// Those releases had no files.txt, so an update can't know to remove them; setup does it instead.
// Newer changes are handled by files.txt in scripts/update.mjs and don't belong in this list.
export const LEFTOVERS = ['core.js', 'subs.js', 'zip.js', 'updater.js', 'public/app.js'];

// Removes the leftovers from an Ardite folder; returns the ones removed. Only once the new layout
// (lib/) is really there, so a half-copied update can't lose anything still needed.
export function removeLeftovers(root) {
  if (!fs.existsSync(path.join(root, 'lib', 'routes.js'))) return [];
  return LEFTOVERS.filter((rel) => {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file, { force: true });
    return true;
  });
}

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

// tar can unpack both the zip (Windows) and the .tar.xz (Linux) archives. Windows 10+ ships its
// own at a fixed place; elsewhere it's the system's.
export const tarCommand = () => (process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  : 'tar');

// Puts a new program file in place: copied next to it first, then swapped in at once, so a
// half-copied file is never run (and Linux allows it even while the old one still runs)
export function placeProgram(src, dest) {
  const tmp = dest + '.new';
  fs.copyFileSync(src, tmp);
  if (process.platform !== 'win32') fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, dest);
}

// Downloads ffmpeg, checks it and puts ffmpeg and ffprobe into bin/.
// canReplace() is asked right before copying, so a download that started meanwhile isn't disturbed.
export async function installFfmpeg(bin, { onProgress, onExtract, canReplace = () => true, target = toolTarget() } = {}) {
  const source = ffmpegSource(target);
  if (!source) throw toolError('no ffmpeg build for this system', 'toolUnsupported');
  const exe = target.ffmpeg.endsWith('.zip') ? '.exe' : '';
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ardite-ffmpeg-'));
  try {
    const archive = path.join(work, target.ffmpeg);
    const sha256 = await download(source, archive, { onProgress });
    onExtract?.();
    // run without blocking the server
    await execFileAsync(tarCommand(), ['-xf', archive, '-C', work], { windowsHide: true, timeout: 5 * 60000 });
    const files = ['ffmpeg', 'ffprobe'].map((name) => {
      const src = findFile(work, name + exe);
      if (!src) throw toolError(`${name} not found in the archive`);
      return { name: name + exe, src };
    });
    if (!canReplace()) throw toolError('busy', 'toolBusy');
    for (const f of files) placeProgram(f.src, path.join(bin, f.name));
    fs.writeFileSync(ffmpegInfoFile(bin), JSON.stringify({ sha256, installed: Date.now() }));
    return sha256;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
