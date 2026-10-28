// Ardite: a self-hosted video downloader for your home network.
// Downloads with yt-dlp into a temp folder, then streams the file to whichever
// device made the request (the PC itself or a phone on the same Wi-Fi).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createZip, fileCrc32 } from './zip.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const BIN = path.join(ROOT, 'bin');
const EXE = process.platform === 'win32' ? '.exe' : '';
const YTDLP = path.join(BIN, 'yt-dlp' + EXE);
const FFPROBE = path.join(BIN, 'ffprobe' + EXE);
const WORK = path.join(os.tmpdir(), 'ardite-jobs');
const LOG_FILE = path.join(DATA, 'ardite.log');

fs.mkdirSync(DATA, { recursive: true });

const config = {
  port: 7878,
  host: '0.0.0.0',
  maxConcurrent: 2,
  keepFilesMinutes: 30,
  maxPlaylistItems: 500,
  cookiesFromBrowser: '', // e.g. "firefox", for sites that require login
  updateCheck: true, // look for new Ardite releases on GitHub
  repo: 'vuxenn1/ardite',
  ...readJson(path.join(DATA, 'config.json')),
};
if (process.env.PORT) config.port = Number(process.env.PORT);
const COOKIES_FILE = path.join(DATA, 'cookies.txt');
const HISTORY_FILE = path.join(DATA, 'history.json');
const HISTORY_MAX = 500;

// ---------- logging ----------

try {
  if (fs.statSync(LOG_FILE).size > 1024 * 1024) fs.rmSync(LOG_FILE);
} catch { /* no log yet */ }

function log(...parts) {
  const line = `[${new Date().toLocaleString('en-GB')}] ${parts.join(' ')}`;
  console.log(line);
  fs.appendFile(LOG_FILE, line + '\n', () => {});
}

function readJson(file) {
  try {
    // Notepad may save UTF-8 with a BOM, which JSON.parse rejects
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return {};
  }
}

// ---------- helpers ----------

function lanAddresses() {
  const skip = /vEthernet|VirtualBox|VMware|WSL|Docker|Loopback|WARP|Cloudflare|Tailscale|ZeroTier|Hamachi|Bluetooth/i;
  const list = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (skip.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      list.push(a.address);
    }
  }
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  return list.sort((a, b) => rank(a) - rank(b));
}

function commonArgs() {
  const args = [
    '--no-warnings',
    '--no-colors',
    '--ffmpeg-location', BIN,
    // YouTube needs a JavaScript runtime for signature solving; reuse the Node we're running on
    '--js-runtimes', `node:${process.execPath}`,
  ];
  if (fs.existsSync(COOKIES_FILE)) args.push('--cookies', COOKIES_FILE);
  else if (config.cookiesFromBrowser) args.push('--cookies-from-browser', config.cookiesFromBrowser);
  return args;
}

function isValidUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// Turns yt-dlp errors into short, human-readable messages.
// "code" lets the web UI show the message in the viewer's language.
function friendlyError(raw) {
  const msg = (raw || '').replace(/^ERROR:\s*/, '').trim();
  const rules = [
    [/Unsupported URL/i, 'unsupported', 'This site or link isn\'t supported.'],
    [/Sign in to confirm (your age|you.re not a bot)/i, 'signin', 'YouTube wants you to sign in. Adding cookies should fix it (see README.md).'],
    [/private video|This video is private/i, 'private', 'This video is private.'],
    [/login required|requires? (a )?log ?in|rate-limit reached|cookies/i, 'login', 'This content requires login. Adding cookies should fix it (see README.md).'],
    [/Requested format is not available/i, 'format', 'That quality isn\'t available for this video. Try another one.'],
    [/Video unavailable|not available|has been removed|404/i, 'notFound', 'Video not found or removed.'],
    [/Unable to download webpage|getaddrinfo|timed out|Connection/i, 'network', 'Couldn\'t reach the site. Check your internet connection.'],
    [/No video formats found|There is no video in this post|No video could be found/i, 'noVideo', 'No downloadable video found at this link.'],
    [/Not found/i, 'notFound', 'Video not found or removed.'],
  ];
  for (const [re, code, text] of rules) if (re.test(msg)) return { code, message: text, detail: msg };
  return { code: 'failed', message: 'Download failed.', detail: msg || 'Unknown error' };
}

const fail = (code, message) => ({ code, message });

function lastError(stderr) {
  const lines = stderr.split(/\r?\n/).filter((l) => l.startsWith('ERROR:'));
  return lines.length ? lines[lines.length - 1] : stderr.trim().split(/\r?\n/).pop();
}

function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], () => {});
  } else {
    proc.kill('SIGKILL');
  }
}

// ---------- info (preview) ----------

// The JSON fetched for the preview is reused for the download, so downloads start faster.
const infoCache = new Map(); // url -> { file, time }
const INFO_TTL = 20 * 60 * 1000;

function fetchInfo(url, playlist) {
  return new Promise((resolve, reject) => {
    const args = [...commonArgs(), '-J', '--flat-playlist', playlist ? '--yes-playlist' : '--no-playlist', '--', url];
    const proc = spawn(YTDLP, args, { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => killTree(proc), 120000);
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    // 'close' also fires after a spawn error, so it handles both cases
    proc.on('error', (e) => (err += e.message));
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(friendlyError(lastError(err)));
      try {
        resolve({ json: out, info: JSON.parse(out) });
      } catch {
        reject(friendlyError('Invalid response'));
      }
    });
  });
}

function bestThumb(thumbs) {
  if (!Array.isArray(thumbs) || !thumbs.length) return null;
  const sized = thumbs.filter((t) => t.url && t.width);
  if (sized.length) return sized.reduce((a, b) => (b.width > a.width ? b : a)).url;
  return thumbs.filter((t) => t.url).pop()?.url || null;
}

const isVideoFormat = (f) => (f.vcodec && f.vcodec !== 'none') || (!f.vcodec && f.height);
// "res" in yt-dlp is the smaller side, so vertical 1080x1920 counts as 1080p
const shortSide = (w, h) => Math.min(h || 0, w || h || 0) || h || 0;

function summarizeVideo(info) {
  const heights = new Set();
  const fps = {}; // highest frame rate per resolution, e.g. { 1080: 60 }
  let hasVideo = false;
  for (const f of info.formats || []) {
    if (isVideoFormat(f)) {
      hasVideo = true;
      const h = shortSide(f.width, f.height);
      if (h) {
        heights.add(h);
        if (f.fps) fps[h] = Math.max(fps[h] || 0, Math.round(f.fps));
      }
    }
  }
  if (!info.formats?.length) hasVideo = !!(info.height || info.vcodec !== 'none');
  return {
    fps,
    type: 'video',
    title: info.title || info.id,
    uploader: info.uploader || info.channel || info.creator || null,
    duration: info.duration || null,
    thumbnail: info.thumbnail || bestThumb(info.thumbnails),
    site: info.extractor_key || info.extractor || null,
    heights: [...heights].filter((h) => h >= 144).sort((a, b) => b - a),
    hasVideo,
  };
}

function entryUrl(e) {
  if (isValidUrl(e.url)) return e.url;
  if (isValidUrl(e.webpage_url)) return e.webpage_url;
  if (e.id && /youtube/i.test(e.ie_key || '')) return `https://www.youtube.com/watch?v=${e.id}`;
  return null;
}

function summarizePlaylist(info) {
  const entries = [];
  for (const [i, e] of (info.entries || []).entries()) {
    if (!e) continue;
    const url = entryUrl(e);
    if (!url) continue;
    const title = e.title || e.id || url;
    entries.push({
      index: i + 1,
      url,
      title,
      duration: e.duration || null,
      thumbnail: bestThumb(e.thumbnails) || e.thumbnail || null,
      // private/deleted videos and nested playlists (e.g. channel tabs) can't be downloaded as one file
      unavailable: /^\[(private|deleted|unavailable)( video)?\]$/i.test(title)
        || e._type === 'playlist' || /Tab$/.test(e.ie_key || ''),
    });
  }
  return {
    type: 'playlist',
    title: info.title || 'Playlist',
    uploader: info.uploader || info.channel || null,
    site: info.extractor_key || info.extractor || null,
    count: entries.length,
    thumbnail: entries.find((e) => !e.unavailable && e.thumbnail)?.thumbnail || bestThumb(info.thumbnails),
    entries: entries.slice(0, config.maxPlaylistItems),
    truncated: entries.length > config.maxPlaylistItems,
  };
}

// Best resolution on offer, used to notice when a site hands out a lower quality than usual
function videoStats(info) {
  let maxAll = 0;
  let maxH264 = 0;
  for (const f of info.formats || []) {
    if (!isVideoFormat(f)) continue;
    const h = shortSide(f.width, f.height);
    maxAll = Math.max(maxAll, h);
    if (/^(avc|h264)/i.test(f.vcodec || '')) maxH264 = Math.max(maxH264, h);
  }
  return { maxAll, maxH264 };
}

function cacheInfo(url, json, info) {
  const file = path.join(WORK, 'info-' + crypto.createHash('sha1').update(url).digest('hex') + '.json');
  fs.writeFileSync(file, json);
  infoCache.set(url, { file, time: Date.now(), stats: videoStats(info) });
}

// Links like youtube.com/watch?v=X&list=Y are both a video and a playlist
function linkKind(url) {
  const u = new URL(url);
  const list = u.searchParams.has('list') || /\/(playlist|sets|album)s?\b/i.test(u.pathname);
  const video = u.searchParams.has('v') || /(^|\.)youtu\.be$/i.test(u.hostname) || /\/shorts\//.test(u.pathname);
  return { list, video };
}

async function getInfo(url) {
  const kind = linkKind(url);
  if (!kind.list) {
    const res = await fetchInfo(url, false);
    if (res.info._type === 'playlist') return summarizePlaylist(res.info);
    cacheInfo(url, res.json, res.info);
    return summarizeVideo(res.info);
  }

  const [list, single] = await Promise.allSettled([
    fetchInfo(url, true),
    kind.video ? fetchInfo(url, false) : Promise.reject(null),
  ]);
  const video = single.status === 'fulfilled' && single.value.info._type !== 'playlist' ? single.value : null;
  if (video) cacheInfo(url, video.json, video.info);

  if (list.status === 'fulfilled' && list.value.info._type === 'playlist') {
    const summary = summarizePlaylist(list.value.info);
    if (video) summary.video = summarizeVideo(video.info);
    return summary;
  }
  if (video) return summarizeVideo(video.info);
  if (list.status === 'fulfilled') {
    // Only looked like a playlist (e.g. a "list" query parameter on a single video)
    cacheInfo(url, list.value.json, list.value.info);
    return summarizeVideo(list.value.info);
  }
  throw list.reason;
}

// ---------- download jobs ----------

const jobs = new Map();
const batches = new Map();
const queue = [];
let running = 0;

const AUDIO_FORMATS = ['mp3', 'm4a', 'opus', 'wav', 'best'];
const isFinal = (status) => status === 'done' || status === 'error' || status === 'canceled';

function publicJob(job) {
  return {
    id: job.id,
    url: job.url,
    mode: job.opts.mode,
    trim: job.opts.trim || null,
    status: job.status,
    phase: job.phase,
    progress: job.progress,
    title: job.title,
    fileName: job.fileName,
    size: job.size,
    media: job.media || null,
    expected: job.expected || null,
    error: job.error,
  };
}

// The resolution the chosen settings should give, if the preview told us what's on offer
function expectedHeight(opts, stats) {
  if (!stats || opts.mode === 'audio') return null;
  const cap = opts.quality === 'max' ? Infinity : Number(opts.quality);
  const best = opts.codec === 'h264' && opts.quality === 'max' ? stats.maxH264 || stats.maxAll : stats.maxAll;
  const h = Math.min(cap, best);
  return h > 0 && Number.isFinite(h) ? h : null;
}

const CODEC_NAMES = [[/^av0?1/i, 'AV1'], [/^vp0?9/i, 'VP9'], [/^(avc|h264)/i, 'H.264'], [/^(hev|hvc|h265)/i, 'H.265'], [/^vp0?8/i, 'VP8']];
const codecName = (c) => CODEC_NAMES.find(([re]) => re.test(c))?.[1] || String(c).split('.')[0].toUpperCase();

// Reads the quality from the finished file itself. More reliable than what yt-dlp
// reports, e.g. after an exact trim the video is re-encoded to H.264.
function probeMedia(file) {
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=codec_name,width,height,avg_frame_rate,color_transfer', '-of', 'json', file];
    execFile(FFPROBE, args, { windowsHide: true, timeout: 20000 }, (err, out) => {
      if (err) return resolve(null);
      try {
        const s = JSON.parse(out).streams?.[0];
        if (!s || /^(mjpeg|png|bmp)$/.test(s.codec_name)) return resolve(null);
        const [n, d] = String(s.avg_frame_rate || '0/1').split('/').map(Number);
        const hdr = s.color_transfer === 'smpte2084' ? 'HDR10' : s.color_transfer === 'arib-std-b67' ? 'HLG' : null;
        resolve({
          height: shortSide(s.width, s.height) || null,
          fps: d ? Math.round(n / d) || null : null,
          codec: codecName(s.codec_name),
          hdr,
        });
      } catch {
        resolve(null);
      }
    });
  });
}

// Line printed by yt-dlp once the final file is in place: what was actually downloaded
function parseDone(job, line) {
  const parts = line.split('|');
  const [, width, height, fps, vcodec, , range] = parts;
  // the title is last because it may itself contain "|"; file names can't hold ":" and the like
  const title = parts.slice(7).join('|').trim();
  if (!job.title && title && title !== 'NA') job.title = title.slice(0, 300);
  const num = (v) => (v && v !== 'NA' && v !== 'None' ? Number(v) : null);
  if (!vcodec || vcodec === 'none' || vcodec === 'NA') return;
  const h = shortSide(num(width), num(height));
  job.media = {
    height: h || null,
    fps: num(fps) ? Math.round(num(fps)) : null,
    codec: codecName(vcodec),
    hdr: range && range !== 'SDR' && range !== 'NA' && range !== 'None' ? range : null,
  };
}

function emit(job, force = false) {
  if (job.batch) emitBatch(job.batch, force);
  const now = Date.now();
  if (!force && now - job.lastEmit < 250) return;
  job.lastEmit = now;
  const data = `data: ${JSON.stringify(publicJob(job))}\n\n`;
  for (const res of job.listeners) res.write(data);
}

function buildArgs(job, source) {
  const o = job.opts;
  const cut = o.trim ? ` (${fileClock(o.trim.start)}-${o.trim.end == null ? 'end' : fileClock(o.trim.end)})` : '';
  const name = (job.prefix ? `${job.prefix} - ` : '') + `%(title).150B [%(id)s]${cut}.%(ext)s`;
  const args = [
    ...commonArgs(),
    '--no-playlist',
    '--newline',
    '--progress',
    '--progress-delta', '0.4',
    '--progress-template',
    'download:ARDITE|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.vcodec)s|%(info.acodec)s',
    // report what was really downloaded; --print would otherwise silence the log lines we read
    '--no-quiet',
    '--print', 'after_move:ARDITE_DONE|%(width)s|%(height)s|%(fps)s|%(vcodec)s|%(acodec)s|%(dynamic_range)s|%(title)s',
    '-o', path.join(job.dir, name),
  ];

  if (o.mode === 'audio') {
    // Cutting YouTube's WebM (Opus) audio starts ~10 s early; M4A cuts exactly, so prefer it for trims
    args.push('-f', o.trim ? 'ba[ext=m4a]/ba/b' : 'ba/b', '-x', '--audio-quality', '0', '--embed-metadata');
    if (o.audioFormat !== 'best') args.push('--audio-format', o.audioFormat);
    if (o.audioFormat !== 'wav') args.push('--embed-thumbnail');
  } else {
    // Streams are never re-encoded, only put together into an MP4 (VP9 and Opus fit in MP4 too)
    const res = o.quality === 'max' ? '' : `res:${o.quality}`;
    if (o.codec === 'h264') {
      // Prefer H.264 + AAC, which plays everywhere (iPhone included), usually up to 1080p.
      // An explicitly chosen quality wins over the codec (picking 4K gets 4K).
      args.push('-S', [res, 'vcodec:h264', 'acodec:aac'].filter(Boolean).join(','), '--merge-output-format', 'mp4');
    } else {
      // Highest resolution, then highest frame rate. Among equal ones prefer VP9 in SDR:
      // AV1 4K60 stutters on GPUs without AV1 decoding, and HDR looks washed out on normal screens.
      args.push('-S', [res || 'res', 'fps', 'vcodec:vp9', 'acodec:aac'].join(','), '--merge-output-format', 'mp4');
    }
  }

  if (o.trim) {
    // Only the chosen part is downloaded. Without --force-keyframes-at-cuts the streams are
    // copied untouched (lossless) and the cut snaps to the nearest keyframe.
    args.push('--download-sections', `*${o.trim.start}-${o.trim.end ?? 'inf'}`);
    if (o.trim.precise) args.push('--force-keyframes-at-cuts');
  }

  if (source.infoFile) args.push('--load-info-json', source.infoFile);
  else args.push('--', job.url);
  return args;
}

function parseProgress(job, line) {
  const [, done, total, estimate, speed, eta, vcodec, acodec] = line.split('|');
  const num = (v) => (v && v !== 'NA' && v !== 'None' ? Number(v) : null);
  const t = num(total) ?? num(estimate);
  const d = num(done);
  const isAudioPart = vcodec === 'none' && acodec !== 'none';
  const isVideoPart = acodec === 'none' && vcodec !== 'none';
  job.status = 'running';
  // a trimmed part is fetched by ffmpeg, which reports no useful progress
  job.phase = job.opts.trim ? 'trimming'
    : job.opts.mode === 'audio' || isAudioPart ? 'downloading-audio'
    : isVideoPart ? 'downloading-video' : 'downloading';
  job.progress = {
    percent: t && d != null ? Math.min(100, (d / t) * 100) : null,
    downloaded: d,
    total: t,
    speed: num(speed),
    eta: num(eta),
  };
  emit(job);
}

function parseLog(job, line) {
  const stages = [
    [/^\[Merger\]/, 'merging'],
    [/^\[ExtractAudio\]/, 'converting'],
    [/^\[(EmbedThumbnail|Metadata)\]/, 'cover'],
    [/^\[(Fixup\w*|VideoRemuxer|VideoConvertor)\]/, 'finishing'],
  ];
  for (const [re, phase] of stages) {
    if (re.test(line)) {
      job.phase = phase;
      job.status = 'processing';
      job.progress = { ...job.progress, percent: null };
      emit(job, true);
      return;
    }
  }
}

function runJob(job, source = { infoFile: infoCache.get(job.url)?.file }) {
  job.status = 'running';
  job.phase = job.opts.trim ? 'trimming' : 'starting';
  job.media = null;
  emit(job, true);
  fs.mkdirSync(job.dir, { recursive: true });

  const proc = spawn(YTDLP, buildArgs(job, source), { windowsHide: true });
  job.proc = proc;
  let stderr = '';
  let buffer = '';

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      if (line.startsWith('ARDITE|')) parseProgress(job, line);
      else if (line.startsWith('ARDITE_DONE|')) parseDone(job, line);
      else parseLog(job, line);
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => (stderr += d));

  proc.on('close', (code) => {
    job.proc = null;
    if (job.status === 'canceled') return finish(job);

    if (code !== 0 && source.infoFile) {
      // The cached info may be stale (e.g. expired stream URLs), so retry from the link
      log(`[${job.id}] cached info failed, retrying from link`);
      infoCache.delete(job.url);
      fs.rmSync(job.dir, { recursive: true, force: true });
      return runJob(job, {});
    }

    // YouTube sometimes answers 403 on a stream URL for a moment; a fresh attempt usually works
    const transient = /HTTP Error (403|5\d\d)|Connection reset|timed out|IncompleteRead/i.test(stderr);
    if (code !== 0 && transient && (job.attempts = (job.attempts || 0) + 1) <= 2) {
      log(`[${job.id}] transient error, retry ${job.attempts}/2`);
      fs.rmSync(job.dir, { recursive: true, force: true });
      job.phase = 'retrying';
      emit(job, true);
      return setTimeout(() => (job.status === 'canceled' ? finish(job) : runJob(job, {})), 3000 * job.attempts);
    }

    if (code !== 0) {
      job.status = 'error';
      job.error = friendlyError(lastError(stderr));
      log(`[${job.id}] ERROR: ${job.error.detail}`);
      fs.rmSync(job.dir, { recursive: true, force: true });
      return finish(job);
    }

    const files = fs.readdirSync(job.dir)
      .filter((f) => !/\.(part|ytdl|temp|json|webp|jpg|png)$/i.test(f) && !f.includes('.part-Frag'))
      .map((f) => ({ f, size: fs.statSync(path.join(job.dir, f)).size }))
      .sort((a, b) => b.size - a.size);

    if (!files.length) {
      job.status = 'error';
      job.error = { ...fail('noFile', 'No file was produced.'), detail: stderr.slice(-500) };
      return finish(job);
    }

    job.file = path.join(job.dir, files[0].f);
    job.fileName = files[0].f;
    job.size = files[0].size;
    job.title = job.title || path.parse(files[0].f).name.replace(/ \[[^\]]+\]( \([^)]*\))?$/, '');

    const complete = (probed) => {
      if (job.status === 'canceled') return finish(job);
      if (probed) job.media = probed;
      job.status = 'done';
      job.phase = 'ready';
      job.progress = { ...job.progress, percent: 100 };
      const m = job.media;
      const quality = m ? ` ${m.height}p${m.fps || ''} ${m.codec}${m.hdr ? ' ' + m.hdr : ''}` : '';
      log(`[${job.id}] done: ${job.fileName} (${(job.size / 1048576).toFixed(1)} MB${quality})`);
      if (m?.height && job.expected && m.height < job.expected) {
        log(`[${job.id}] lower quality than offered: got ${m.height}p, expected ${job.expected}p`);
      }
      finish(job);
    };
    if (job.opts.mode === 'video' && fs.existsSync(FFPROBE)) probeMedia(job.file).then(complete);
    else complete(null);
  });

  // 'close' also fires after a spawn error, so the job is finished only there
  proc.on('error', (e) => (stderr += e.message));
}

// ---------- download history ----------

// Shared by all devices. Only small details are kept (title, link, site, device),
// never the files themselves, which stay on whichever device downloaded them.
let history = readJson(HISTORY_FILE);
if (!Array.isArray(history)) history = [];

function saveHistory() {
  try {
    const tmp = HISTORY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(history));
    fs.renameSync(tmp, HISTORY_FILE);
  } catch (e) {
    log('could not save history:', e.message);
  }
}

function addHistory(entry) {
  let site = null;
  try {
    site = new URL(entry.url).hostname.replace(/^(www|m|mobile|music)\./, '');
    if (site === 'youtu.be') site = 'youtube.com';
  } catch { /* keep null */ }
  history.unshift({ id: crypto.randomBytes(4).toString('hex'), date: Date.now(), site, ...entry });
  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
  saveHistory();
}

// A rough device type from the browser, shown next to each history entry
function deviceOf(req) {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1' || lanAddresses().includes(ip)) return 'pc';
  const ua = req.headers['user-agent'] || '';
  if (/iPhone/.test(ua)) return 'iphone';
  if (/iPad/.test(ua)) return 'ipad';
  if (/Android/.test(ua)) return 'android';
  if (/Windows/.test(ua)) return 'windows';
  if (/Macintosh/.test(ua)) return 'mac';
  if (/Linux|CrOS/.test(ua)) return 'linux';
  return 'other';
}

function finish(job) {
  running--;
  emit(job, true);
  for (const res of job.listeners) res.end();
  job.listeners.clear();
  if (!job.batch && job.status === 'done') {
    addHistory({
      kind: 'video',
      mode: job.opts.mode,
      title: job.title,
      url: job.url,
      ext: path.extname(job.fileName).slice(1),
      media: job.media || null,
      trim: job.opts.trim || null,
      size: job.size,
      device: job.device,
    });
  }
  if (job.batch) {
    // Playlist items are kept until the whole playlist is done, so the ZIP has everything
    if (job.batch.removed) removeJob(job);
    else checkBatchDone(job.batch);
  } else {
    const keep = job.status === 'done' ? config.keepFilesMinutes * 60000 : 10 * 60000;
    job.cleanup = setTimeout(() => removeJob(job), keep);
  }
  pump();
}

function removeJob(job) {
  clearTimeout(job.cleanup);
  fs.rm(job.dir, { recursive: true, force: true }, () => {});
  jobs.delete(job.id);
}

function cancelJob(job) {
  if (isFinal(job.status)) return;
  const wasQueued = job.status === 'queued';
  job.status = 'canceled';
  job.phase = 'canceled';
  if (wasQueued) emit(job, true);
  else killTree(job.proc); // finish() runs when the process exits
}

function pump() {
  while (running < config.maxConcurrent && queue.length) {
    const job = queue.shift();
    if (job.status !== 'queued') continue;
    running++;
    runJob(job);
  }
}

function parseOptions(body) {
  return {
    mode: body.mode === 'audio' ? 'audio' : 'video',
    quality: /^\d{3,4}$/.test(String(body.quality)) ? String(body.quality) : 'max',
    codec: body.codec === 'best' ? 'best' : 'h264',
    audioFormat: AUDIO_FORMATS.includes(body.audioFormat) ? body.audioFormat : 'mp3',
    trim: null,
  };
}

// { start, end, precise } in seconds; end null means "to the end". undefined = invalid.
function parseTrim(t) {
  if (t == null) return null;
  if (typeof t !== 'object') return undefined;
  const start = t.start == null || t.start === '' ? 0 : Number(t.start);
  const end = t.end == null || t.end === '' ? null : Number(t.end);
  const ok = (n) => Number.isFinite(n) && n >= 0 && n <= 48 * 3600;
  if (!ok(start) || (end != null && (!ok(end) || end <= start))) return undefined;
  if (start === 0 && end == null) return null;
  const round = (n) => Math.round(n * 1000) / 1000;
  return { start: round(start), end: end == null ? null : round(end), precise: t.precise === true };
}

// 83 -> "1m23s" for file names (":" isn't allowed in Windows file names)
function fileClock(sec) {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}h${pad(m)}m${pad(s % 60)}s` : `${m}m${pad(s % 60)}s`;
}

function createJob(url, opts, extra = {}) {
  const id = crypto.randomBytes(6).toString('hex');
  const job = {
    id,
    url,
    opts,
    status: 'queued',
    phase: 'queued',
    progress: { percent: null },
    title: typeof extra.title === 'string' ? extra.title.slice(0, 300) : null,
    prefix: extra.prefix || null,
    batch: extra.batch || null,
    device: extra.device || null,
    expected: expectedHeight(opts, infoCache.get(url)?.stats),
    dir: path.join(WORK, id),
    listeners: new Set(),
    lastEmit: 0,
  };
  jobs.set(id, job);
  queue.push(job);
  const cut = opts.trim ? ` cut ${opts.trim.start}-${opts.trim.end ?? "end"}${opts.trim.precise ? " exact" : ""}` : "";
  if (!job.batch) log(`[${id}] new job: ${opts.mode} ${opts.quality}/${opts.codec}/${opts.audioFormat}${cut} ${url}`);
  pump();
  return job;
}

// ---------- playlists (batches) ----------

function publicBatch(batch) {
  const items = batch.jobs.map((j) => ({
    id: j.id,
    title: j.title,
    status: j.status,
    phase: j.phase,
    percent: j.progress?.percent ?? null,
    size: j.size ?? null,
    error: j.error?.message ?? null,
    errorCode: j.error?.code ?? null,
  }));
  const count = (s) => items.filter((i) => i.status === s).length;
  const active = items.filter((i) => i.status !== 'canceled');
  const progressSum = active.reduce((n, i) => n + (isFinal(i.status) ? 100 : i.percent || 0), 0);
  return {
    id: batch.id,
    url: batch.url,
    title: batch.title,
    mode: batch.opts.mode,
    total: items.length,
    done: count('done'),
    failed: count('error'),
    canceled: count('canceled'),
    finished: items.every((i) => isFinal(i.status)),
    percent: active.length ? progressSum / active.length : 100,
    size: items.reduce((n, i) => n + (i.size || 0), 0),
    items,
  };
}

function emitBatch(batch, force = false) {
  const now = Date.now();
  if (!force && now - batch.lastEmit < 600) return;
  batch.lastEmit = now;
  const data = `data: ${JSON.stringify(publicBatch(batch))}\n\n`;
  for (const res of batch.listeners) res.write(data);
}

function checkBatchDone(batch) {
  if (!batch.jobs.every((j) => isFinal(j.status))) return;
  const s = publicBatch(batch);
  log(`[batch ${batch.id}] finished: ${s.done} ok, ${s.failed} failed, ${s.canceled} canceled`);
  if (s.done && !batch.recorded) {
    batch.recorded = true;
    addHistory({
      kind: 'playlist',
      mode: batch.opts.mode,
      title: batch.title,
      url: isValidUrl(batch.url) ? batch.url : null,
      count: s.done,
      size: s.size,
      device: batch.device,
    });
  }
  for (const res of batch.listeners) res.end();
  batch.listeners.clear();
  clearTimeout(batch.cleanup);
  batch.cleanup = setTimeout(() => removeBatch(batch), config.keepFilesMinutes * 60000);
}

function removeBatch(batch) {
  batch.removed = true;
  clearTimeout(batch.cleanup);
  for (const job of batch.jobs) {
    if (!isFinal(job.status)) cancelJob(job);
    // running jobs are removed in finish() once their process exits
    if (!job.proc) removeJob(job);
  }
  batches.delete(batch.id);
}

function createBatch(body, device) {
  const opts = parseOptions(body);
  const entries = (Array.isArray(body.entries) ? body.entries : [])
    .filter((e) => e && isValidUrl(e.url))
    .slice(0, config.maxPlaylistItems);
  if (!entries.length) throw Object.assign(new Error('No videos selected.'), { code: 'noSelection' });

  const id = crypto.randomBytes(6).toString('hex');
  const batch = {
    id,
    url: body.url,
    title: String(body.title || 'Playlist').slice(0, 300),
    opts,
    device,
    jobs: [],
    listeners: new Set(),
    lastEmit: 0,
  };
  batches.set(id, batch);
  const width = Math.max(2, String(Math.max(...entries.map((e, i) => Number(e.index) || i + 1))).length);
  for (const [i, e] of entries.entries()) {
    const prefix = String(Number(e.index) || i + 1).padStart(width, '0');
    batch.jobs.push(createJob(e.url, opts, { title: e.title, prefix, batch }));
  }
  log(`[batch ${id}] new playlist: ${entries.length} items, ${opts.mode}: ${batch.title}`);
  return batch;
}

async function serveZip(res, batch) {
  const done = batch.jobs.filter((j) => j.status === 'done' && j.file && fs.existsSync(j.file));
  if (!done.length) return sendJson(res, 404, fail('nothingDone', 'Nothing finished yet.'));
  const entries = [];
  for (const j of done) {
    j.crc ??= await fileCrc32(j.file);
    entries.push({ name: j.fileName, path: j.file, size: j.size, crc: j.crc });
  }
  const { length, stream } = createZip(entries);
  const name = batch.title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'playlist';
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': contentDisposition(name + '.zip'),
    'Content-Length': length,
    'Cache-Control': 'no-store',
  });
  // pipeline() closes the files if the client aborts or a read fails
  pipeline(stream, res, () => {});
}

// ---------- Ardite update check ----------

// Release packages get their version from the git tag; running from source shows "0.0.0-dev"
const VERSION = readJson(path.join(ROOT, 'package.json')).version || '0.0.0-dev';
let latestRelease = null; // { version, url }

function isNewer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// Only asks GitHub which release is the latest; nothing is downloaded or installed automatically
async function checkForUpdate() {
  if (!config.updateCheck || !/^\d+\.\d+\.\d+$/.test(VERSION)) return;
  try {
    const res = await fetch(`https://api.github.com/repos/${config.repo}/releases/latest`, {
      headers: { 'User-Agent': 'Ardite', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return;
    const r = await res.json();
    const version = String(r.tag_name || '').replace(/^v/, '');
    const url = String(r.html_url || '');
    if (!/^\d+\.\d+\.\d+$/.test(version) || !url.startsWith('https://github.com/')) return;
    if (isNewer(version, VERSION) && latestRelease?.version !== version) log(`New Ardite version available: v${version}`);
    latestRelease = { version, url };
  } catch { /* offline, try again later */ }
}

// ---------- yt-dlp self-update ----------

let ytdlpVersion = null;

function readVersion() {
  execFile(YTDLP, ['--version'], { windowsHide: true }, (err, out) => {
    if (!err) ytdlpVersion = out.trim();
  });
}

function updateYtdlp() {
  if (running > 0) return;
  execFile(YTDLP, ['-U'], { windowsHide: true, timeout: 180000 }, (err, out) => {
    const text = (out || '').trim().split(/\r?\n/).pop();
    if (text) log('yt-dlp update:', text);
    readVersion();
  });
}

// ---------- HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8'); // keeps multi-byte characters intact across chunks
    req.on('data', (c) => {
      data += c;
      if (data.length > 2 * 1024 * 1024) {
        reject(new Error('too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        reject(new Error('bad json'));
      }
    });
  });
}

function contentDisposition(name) {
  const ascii = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '') || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function serveFile(req, res, job) {
  if (!job || job.status !== 'done' || !fs.existsSync(job.file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('File not found or expired.');
  }
  const size = fs.statSync(job.file).size;
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': contentDisposition(job.fileName),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    if (start >= size || start < 0 || end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    end = Math.min(end, size - 1);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return pipeline(fs.createReadStream(job.file, { start, end }), res, () => {});
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  pipeline(fs.createReadStream(job.file), res, () => {});
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function openEvents(req, res, target, snapshot, final) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  if (final) return res.end();
  target.listeners.add(res);
  req.on('close', () => target.listeners.delete(res));
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');

  try {
    if (pathname === '/api/status' && req.method === 'GET') {
      return sendJson(res, 200, {
        name: 'Ardite',
        version: VERSION,
        update: latestRelease && isNewer(latestRelease.version, VERSION) ? latestRelease : null,
        ytdlp: ytdlpVersion,
        port: config.port,
        lan: lanAddresses().map((ip) => `http://${ip}:${config.port}`),
        cookies: fs.existsSync(COOKIES_FILE) ? 'file' : config.cookiesFromBrowser || null,
      });
    }

    if (pathname === '/api/history') {
      if (req.method === 'GET') return sendJson(res, 200, history);
      if (req.method === 'DELETE') {
        history = [];
        saveHistory();
        return sendJson(res, 200, { ok: true });
      }
    }
    const hm = /^\/api\/history\/([a-f0-9]+)$/.exec(pathname);
    if (hm && req.method === 'DELETE') {
      history = history.filter((e) => e.id !== hm[1]);
      saveHistory();
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/info' && req.method === 'POST') {
      const body = await readBody(req);
      if (!isValidUrl(body.url)) return sendJson(res, 400, fail('invalidUrl', 'Enter a valid link.'));
      try {
        return sendJson(res, 200, await getInfo(body.url));
      } catch (e) {
        return sendJson(res, 422, e?.message ? e : fail('noInfo', 'Couldn\'t get video info.'));
      }
    }

    if (pathname === '/api/jobs' && req.method === 'POST') {
      const body = await readBody(req);
      if (!isValidUrl(body.url)) return sendJson(res, 400, fail('invalidUrl', 'Enter a valid link.'));
      const opts = parseOptions(body);
      opts.trim = parseTrim(body.trim);
      if (opts.trim === undefined) return sendJson(res, 400, fail('badTrim', 'Invalid trim times.'));
      return sendJson(res, 201, publicJob(createJob(body.url, opts, { title: body.title, device: deviceOf(req) })));
    }

    if (pathname === '/api/batches' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        return sendJson(res, 201, publicBatch(createBatch(body, deviceOf(req))));
      } catch (e) {
        return sendJson(res, 400, fail(e.code, e.message));
      }
    }

    const jm = /^\/api\/jobs\/([a-f0-9]+)(\/(events|file))?$/.exec(pathname);
    if (jm) {
      const job = jobs.get(jm[1]);
      const sub = jm[3];
      if (!job) {
        if (sub === 'file') {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('File not found or expired.');
        }
        return sendJson(res, 404, fail('jobNotFound', 'Job not found.'));
      }
      if (!sub && req.method === 'GET') return sendJson(res, 200, publicJob(job));
      if (!sub && req.method === 'DELETE') {
        if (isFinal(job.status)) {
          if (!job.batch) removeJob(job);
        } else {
          cancelJob(job);
          if (job.status === 'canceled' && !job.proc) job.cleanup = setTimeout(() => removeJob(job), 60000);
        }
        return sendJson(res, 200, { ok: true });
      }
      if (sub === 'events' && req.method === 'GET') return openEvents(req, res, job, publicJob(job), isFinal(job.status));
      if (sub === 'file' && (req.method === 'GET' || req.method === 'HEAD')) return serveFile(req, res, job);
    }

    const bm = /^\/api\/batches\/([a-f0-9]+)(\/(events|zip))?$/.exec(pathname);
    if (bm) {
      const batch = batches.get(bm[1]);
      const sub = bm[3];
      if (!batch) return sendJson(res, 404, fail('playlistNotFound', 'Playlist not found.'));
      if (!sub && req.method === 'GET') return sendJson(res, 200, publicBatch(batch));
      if (!sub && req.method === 'DELETE') {
        removeBatch(batch);
        return sendJson(res, 200, { ok: true });
      }
      if (sub === 'events' && req.method === 'GET') {
        const snap = publicBatch(batch);
        return openEvents(req, res, batch, snap, snap.finished);
      }
      if (sub === 'zip' && req.method === 'GET') return serveZip(res, batch);
    }

    if (req.method === 'GET') return serveStatic(req, res, pathname);
    res.writeHead(405);
    res.end();
  } catch (e) {
    log('request error:', e.message);
    if (!res.headersSent) sendJson(res, 400, fail('badRequest', 'Bad request.'));
    else res.end();
  }
});

// ---------- startup ----------

if (!fs.existsSync(YTDLP)) {
  console.error('yt-dlp not found. Run the setup first: node setup.js');
  process.exit(1);
}

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log(`Port ${config.port} is in use. Ardite is probably already running.`);
    process.exit(0);
  }
  throw e;
});

server.listen(config.port, config.host, () => {
  log(`Ardite is running at http://localhost:${config.port}`);
  for (const ip of lanAddresses()) log(`  On your phone: http://${ip}:${config.port}`);
  readVersion();
  setTimeout(updateYtdlp, 5000);
  setInterval(updateYtdlp, 12 * 60 * 60 * 1000);
  setTimeout(checkForUpdate, 8000);
  setInterval(checkForUpdate, 12 * 60 * 60 * 1000);
  // drop stale preview info
  setInterval(() => {
    for (const [url, entry] of infoCache) {
      if (Date.now() - entry.time > INFO_TTL) {
        fs.rm(entry.file, { force: true }, () => {});
        infoCache.delete(url);
      }
    }
  }, 60000);
});

function shutdown() {
  for (const job of jobs.values()) killTree(job.proc);
  fs.rmSync(WORK, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
