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
import {
  isValidUrl, friendlyError, fail, lastError, shortSide, summarizeVideo, summarizePlaylist,
  videoStats, linkKind, expectedHeight, codecName, parseOptions, parseTrim, fileClock, isNewer,
  contentDisposition,
} from './core.js';
import { subtitleArgs, findSubFiles, shiftSrt, embedSubs } from './subs.js';
import { createUpdater, readRelease } from './updater.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const BIN = path.join(ROOT, 'bin');
const EXE = process.platform === 'win32' ? '.exe' : '';
const YTDLP = path.join(BIN, 'yt-dlp' + EXE);
const FFPROBE = path.join(BIN, 'ffprobe' + EXE);
const FFMPEG = path.join(BIN, 'ffmpeg' + EXE);
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
// Temp folder for downloads. It's emptied at start, so each port (each Ardite) gets its own.
const WORK = path.join(os.tmpdir(), `ardite-jobs-${config.port}`);
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

function cacheInfo(url, json, info) {
  const file = path.join(WORK, 'info-' + crypto.createHash('sha1').update(url).digest('hex') + '.json');
  fs.writeFileSync(file, json);
  infoCache.set(url, { file, time: Date.now(), stats: videoStats(info) });
}

async function getInfo(url) {
  const kind = linkKind(url);
  if (!kind.list) {
    const res = await fetchInfo(url, false);
    if (res.info._type === 'playlist') return summarizePlaylist(res.info, config.maxPlaylistItems);
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
    const summary = summarizePlaylist(list.value.info, config.maxPlaylistItems);
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
    subs: job.opts.subs ? {
      langs: job.subs?.langs || [],
      srt: (job.subs?.files || []).map((f, i) => ({ i, lang: f.lang })),
      failed: !!job.skipSubs,
    } : null,
    error: job.error,
  };
}

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
    // Downloaded as .srt files; they're embedded (and shifted for trims) after the download
    if (o.subs && !job.skipSubs) args.push(...subtitleArgs(o.subs));
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

    // YouTube sometimes refuses subtitle requests (e.g. HTTP 429); get the video without them
    if (code !== 0 && job.opts.subs && !job.skipSubs && /subtitle/i.test(lastError(stderr))) {
      log(`[${job.id}] subtitles failed, retrying without them: ${lastError(stderr)}`);
      job.skipSubs = true;
      fs.rmSync(job.dir, { recursive: true, force: true });
      return runJob(job, {});
    }

    if (code !== 0) {
      job.status = 'error';
      job.error = friendlyError(lastError(stderr));
      log(`[${job.id}] ERROR: ${job.error.detail}`);
      fs.rmSync(job.dir, { recursive: true, force: true });
      return finish(job);
    }

    const files = fs.readdirSync(job.dir)
      .filter((f) => !/\.(part|ytdl|temp|json|webp|jpg|png|srt|vtt)$/i.test(f) && !f.includes('.part-Frag'))
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
    const probe = () => (job.opts.mode === 'video' && fs.existsSync(FFPROBE) ? probeMedia(job.file) : Promise.resolve(null));
    if (job.opts.subs && !job.skipSubs) {
      addSubtitles(job)
        .catch((e) => log(`[${job.id}] could not add subtitles: ${e.message}`))
        .then(probe)
        .then(complete);
    } else {
      probe().then(complete);
    }
  });

  // 'close' also fires after a spawn error, so the job is finished only there
  proc.on('error', (e) => (stderr += e.message));
}

// Shifts the subtitles of a trimmed part, embeds them into the MP4 and keeps
// the .srt files only if they were asked for as well
async function addSubtitles(job) {
  // in the order the languages were picked (the first one shows by default), automatic ones last
  const order = job.opts.subs.langs;
  const rank = (lang) => {
    if (/-orig$/.test(lang)) return order.length;
    const i = order.findIndex((c) => c === lang || c.split('-')[0] === lang.split('-')[0]);
    return i < 0 ? order.length - 0.5 : i;
  };
  const files = findSubFiles(job.dir, job.file).sort((a, b) => rank(a.lang) - rank(b.lang));
  job.subs = { langs: files.map((f) => f.lang), files: [] };
  if (!files.length) return;

  const trim = job.opts.trim;
  if (trim) {
    for (const f of files) fs.writeFileSync(f.path, shiftSrt(fs.readFileSync(f.path, 'utf8'), trim.start, trim.end));
  }

  if (/\.mp4$/i.test(job.file) && fs.existsSync(FFMPEG)) {
    job.status = 'processing';
    job.phase = 'subtitles';
    emit(job, true);
    await embedSubs(FFMPEG, job.file, files, (proc) => (job.proc = proc));
    job.proc = null;
    job.size = fs.statSync(job.file).size;
  }

  if (job.opts.subs.srt) job.subs.files = files;
  else for (const f of files) fs.rmSync(f.path, { force: true });
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
      subs: job.subs?.langs?.length ? job.subs.langs : null,
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
  const cut = opts.trim ? ` cut ${opts.trim.start}-${opts.trim.end ?? 'end'}${opts.trim.precise ? ' exact' : ''}` : '';
  const subs = opts.subs ? ` subs ${[...opts.subs.langs, opts.subs.auto ? 'auto' : ''].filter(Boolean).join('+')}${opts.subs.srt ? ' srt' : ''}` : '';
  if (!job.batch) log(`[${id}] new job: ${opts.mode} ${opts.quality}/${opts.codec}/${opts.audioFormat}${cut}${subs} ${url}`);
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
    // .srt files that were asked for go next to their video
    for (const f of j.subs?.files || []) {
      if (!fs.existsSync(f.path)) continue;
      f.crc ??= await fileCrc32(f.path);
      entries.push({ name: f.name, path: f.path, size: fs.statSync(f.path).size, crc: f.crc });
    }
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
// GitHub's "latest release"; updateFeed can point elsewhere (used to test updates)
const UPDATE_FEED = config.updateFeed || `https://api.github.com/repos/${config.repo}/releases/latest`;
let latestRelease = null; // { version, url, asset }

// Only asks which release is the latest; installing happens when someone presses "Update now"
async function checkForUpdate() {
  if (!config.updateCheck || !/^\d+\.\d+\.\d+$/.test(VERSION)) return;
  try {
    const res = await fetch(UPDATE_FEED, {
      headers: { 'User-Agent': 'Ardite', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return;
    const release = readRelease(await res.json());
    if (!release) return;
    if (isNewer(release.version, VERSION) && latestRelease?.version !== release.version) {
      log(`New Ardite version available: v${release.version}`);
    }
    latestRelease = release;
  } catch { /* offline, try again later */ }
}

const updater = createUpdater({
  root: ROOT,
  data: DATA,
  version: VERSION,
  port: config.port,
  feedUrl: UPDATE_FEED,
  log,
  // never restart in the middle of someone's download
  isBusy: () => running > 0 || queue.some((j) => j.status === 'queued'),
  shutdown: () => shutdown(),
});

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

// file: the job's video by default, or one of its .srt files
function serveFile(req, res, job, file = job && { path: job.file, name: job.fileName }) {
  if (!job || job.status !== 'done' || !file || !fs.existsSync(file.path)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('File not found or expired.');
  }
  const filePath = file.path;
  const size = fs.statSync(filePath).size;
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': contentDisposition(file.name),
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
    return pipeline(fs.createReadStream(filePath, { start, end }), res, () => {});
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  pipeline(fs.createReadStream(filePath), res, () => {});
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
        update: latestRelease && isNewer(latestRelease.version, VERSION)
          ? { version: latestRelease.version, url: latestRelease.url, canInstall: !!latestRelease.asset && updater.supported() }
          : null,
        ytdlp: ytdlpVersion,
        port: config.port,
        repo: `https://github.com/${config.repo}`,
        lan: lanAddresses().map((ip) => `http://${ip}:${config.port}`),
        cookies: fs.existsSync(COOKIES_FILE) ? 'file' : config.cookiesFromBrowser || null,
      });
    }

    if (pathname === '/api/update') {
      if (req.method === 'GET') return sendJson(res, 200, updater.status());
      if (req.method === 'POST') {
        try {
          const release = await updater.start();
          log(`update to v${release.version} started`);
          return sendJson(res, 202, updater.status());
        } catch (e) {
          return sendJson(res, 409, fail(e.code || 'updateFailed', e.message));
        }
      }
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

    const jm = /^\/api\/jobs\/([a-f0-9]+)(\/(events|file|subs)(\/(\d+))?)?$/.exec(pathname);
    if (jm) {
      const job = jobs.get(jm[1]);
      const sub = jm[3];
      if (!job) {
        if (sub === 'file' || sub === 'subs') {
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
      if (sub === 'subs' && jm[5] != null && req.method === 'GET') return serveFile(req, res, job, job.subs?.files?.[Number(jm[5])] || null);
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
