// Downloads: each one is a job that runs yt-dlp into its own temp folder; the finished file waits
// there until a device saves it. Playlists (batches) are a job per video plus a ZIP of them all.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { config, WORK, FFMPEG, FFPROBE } from './config.js';
import { log } from './log.js';
import {
  isValidUrl, friendlyError, fail, lastError, shortSide, expectedHeight, codecName, parseOptions,
  fileClock, lowOnSpace, nextJob, siteOf,
} from './core.js';
import { subtitleArgs, findSubFiles, shiftSrt, embedSubs } from './subs.js';
import { createZip, fileCrc32 } from './zip.js';
import {
  ytdlp, commonArgs, killTree, requestYtdlpUpdate, maybeUpdateYtdlp, ytdlpBusy, lastYtdlpCheck,
} from './ytdlp.js';
import { cachedInfoFile, cachedStats, forgetInfo } from './info.js';
import { MIN_FREE, freeSpace, gb, diskFull } from './disk.js';
import { addHistory } from './history.js';
import { addStat } from './stats.js';

const jobs = new Map();
const batches = new Map();
const queue = [];
const active = new Set(); // jobs running now

// Errors that often mean a site changed and yt-dlp needs an update
const SITE_CHANGED = new Set(['failed', 'noVideo', 'format']);

export const isFinal = (status) => status === 'done' || status === 'error' || status === 'canceled';
export const getJob = (id) => jobs.get(id);
export const getBatch = (id) => batches.get(id);
export const jobsRunning = () => active.size;
// nothing running or waiting (updates of Ardite and ffmpeg wait for this)
export const idle = () => !active.size && !queue.some((j) => j.status === 'queued');

export function stopAllJobs() {
  for (const job of jobs.values()) killTree(job.proc);
}

// ---------- what pages see ----------

export function publicJob(job) {
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

export function publicBatch(batch) {
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
  const wanted = items.filter((i) => i.status !== 'canceled');
  const progressSum = wanted.reduce((n, i) => n + (isFinal(i.status) ? 100 : i.percent || 0), 0);
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
    percent: wanted.length ? progressSum / wanted.length : 100,
    size: items.reduce((n, i) => n + (i.size || 0), 0),
    items,
  };
}

// Sends the job's state to the pages following it (server-sent events), at most 4 times a second
function emit(job, force = false) {
  if (job.batch) emitBatch(job.batch, force);
  const now = Date.now();
  if (!force && now - job.lastEmit < 250) return;
  job.lastEmit = now;
  const data = `data: ${JSON.stringify(publicJob(job))}\n\n`;
  for (const res of job.listeners) res.write(data);
}

function emitBatch(batch, force = false) {
  const now = Date.now();
  if (!force && now - batch.lastEmit < 600) return;
  batch.lastEmit = now;
  const data = `data: ${JSON.stringify(publicBatch(batch))}\n\n`;
  for (const res of batch.listeners) res.write(data);
}

// ---------- running yt-dlp ----------

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
    // for the history and statistics: length, site and channel (last, it may contain "|")
    '--print', 'after_move:ARDITE_META|%(duration)s|%(extractor_key)s|%(channel,uploader)s',
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

const num = (v) => (v && v !== 'NA' && v !== 'None' ? Number(v) : null);

// "ARDITE|downloaded|total|estimate|speed|eta|vcodec|acodec" (see --progress-template)
function parseProgress(job, line) {
  const [, done, total, estimate, speed, eta, vcodec, acodec] = line.split('|');
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
  watchSpace(job);
  emit(job);
}

// Line printed by yt-dlp once the final file is in place: what was actually downloaded
function parseDone(job, line) {
  const parts = line.split('|');
  const [, width, height, fps, vcodec, , range] = parts;
  // the title is last because it may itself contain "|"; file names can't hold ":" and the like
  const title = parts.slice(7).join('|').trim();
  if (!job.title && title && title !== 'NA') job.title = title.slice(0, 300);
  if (!vcodec || vcodec === 'none' || vcodec === 'NA') return;
  job.media = {
    height: shortSide(num(width), num(height)) || null,
    fps: num(fps) ? Math.round(num(fps)) : null,
    codec: codecName(vcodec),
    hdr: range && range !== 'SDR' && range !== 'NA' && range !== 'None' ? range : null,
  };
}

// "ARDITE_META|duration|site|channel": details for the history and statistics
function parseMeta(job, line) {
  const [, duration, extractor, ...channel] = line.split('|');
  const name = channel.join('|').trim();
  job.meta = {
    duration: num(duration) ? Math.round(num(duration)) : null,
    extractor: extractor && extractor !== 'NA' ? extractor : null,
    channel: name && name !== 'NA' ? name.slice(0, 200) : null,
  };
}

// The steps after downloading, from yt-dlp's log lines
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

// Stops a running download before it fills the disk (checked every few seconds)
function watchSpace(job) {
  const now = Date.now();
  if (job.abort || now - (job.spaceChecked || 0) < 3000) return;
  job.spaceChecked = now;
  const p = job.progress;
  const free = freeSpace();
  if (lowOnSpace(free, MIN_FREE, { remaining: p.total && p.downloaded != null ? p.total - p.downloaded : 0 })) {
    job.abort = diskFull(free);
    log(`[${job.id}] stopped: the disk is almost full (${gb(free)} free)`);
    killTree(job.proc);
  }
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

function endWithError(job, error) {
  job.status = 'error';
  job.error = error;
  fs.rmSync(job.dir, { recursive: true, force: true });
  return finish(job);
}

function runJob(job, source = { infoFile: cachedInfoFile(job.url) }) {
  const free = freeSpace();
  if (lowOnSpace(free, MIN_FREE, { starting: true })) {
    log(`[${job.id}] not started: only ${gb(free)} free on the disk (minFreeGB is ${gb(MIN_FREE)})`);
    return endWithError(job, diskFull(free));
  }
  job.status = 'running';
  job.startedAt ??= Date.now(); // a retry keeps counting from the first try
  job.phase = job.opts.trim ? 'trimming' : 'starting';
  job.media = null;
  emit(job, true);
  fs.mkdirSync(job.dir, { recursive: true });

  const proc = spawn(...ytdlp(buildArgs(job, source)), { windowsHide: true });
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
      else if (line.startsWith('ARDITE_META|')) parseMeta(job, line);
      else parseLog(job, line);
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => (stderr += d));
  // 'close' also fires after a spawn error, so the job is finished only there
  proc.on('error', (e) => (stderr += e.message));

  proc.on('close', (code) => {
    job.proc = null;
    if (job.status === 'canceled') return finish(job);
    if (job.abort) return endWithError(job, job.abort);

    if (code !== 0 && source.infoFile) {
      // The cached info may be stale (e.g. expired stream URLs), so retry from the link
      log(`[${job.id}] cached info failed, retrying from link`);
      forgetInfo(job.url);
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
      const error = friendlyError(lastError(stderr));
      log(`[${job.id}] ERROR: ${error.detail}`);
      return endWithError(job, error);
    }

    const files = fs.readdirSync(job.dir)
      .filter((f) => !/\.(part|ytdl|temp|json|webp|jpg|png|srt|vtt)$/i.test(f) && !f.includes('.part-Frag'))
      .map((f) => ({ f, size: fs.statSync(path.join(job.dir, f)).size }))
      .sort((a, b) => b.size - a.size);
    if (!files.length) return endWithError(job, { ...fail('noFile', 'No file was produced.'), detail: stderr.slice(-500) });

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

// ---------- the queue ----------

// Every finished or failed download (playlist items too) counts in the statistics
function recordStat(job) {
  if (job.status !== 'done' && job.status !== 'error') return;
  const done = job.status === 'done';
  addStat({
    outcome: job.status,
    error: done ? null : job.error?.code,
    kind: 'video',
    mode: job.opts.mode,
    site: siteOf(job.url),
    extractor: job.meta?.extractor,
    size: done ? job.size : null,
    duration: job.meta?.duration,
    took: done && job.startedAt ? Date.now() - job.startedAt : null,
    height: job.media?.height,
    fps: job.media?.fps,
    codec: job.media?.codec,
    hdr: job.media?.hdr,
    ext: done ? path.extname(job.fileName).slice(1).toLowerCase() : null,
    trimmed: !!job.opts.trim,
    subs: job.subs?.langs?.length,
    playlist: !!job.batch,
    device: job.device,
    deviceName: job.deviceName,
  });
}

function finish(job) {
  active.delete(job);
  emit(job, true);
  for (const res of job.listeners) res.end();
  job.listeners.clear();
  recordStat(job);
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
      duration: job.meta?.duration ?? null,
      channel: job.meta?.channel ?? null,
      took: job.startedAt ? Date.now() - job.startedAt : null,
      device: job.device,
      deviceName: job.deviceName,
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
  // a site may have changed: look for a yt-dlp update, at most once an hour
  if (job.status === 'error' && SITE_CHANGED.has(job.error?.code) && Date.now() - lastYtdlpCheck() > 3600000) {
    requestYtdlpUpdate('after a failed download');
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

// A page closing a download: cancels it, or frees its file right away when it's finished
export function deleteJob(job) {
  if (isFinal(job.status)) {
    if (!job.batch) removeJob(job);
    return;
  }
  cancelJob(job);
  if (job.status === 'canceled' && !job.proc) job.cleanup = setTimeout(() => removeJob(job), 60000);
}

// Starts queued downloads while there's room; see nextJob in core.js for the order
export function pump() {
  // A yt-dlp update waits for running downloads and goes before queued ones; meanwhile
  // nothing new starts (the update takes a few seconds, then pump() runs again)
  maybeUpdateYtdlp();
  if (ytdlpBusy()) return;
  for (;;) {
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].status !== 'queued') queue.splice(i, 1);
    const job = nextJob(queue, [...active], config.maxConcurrent);
    if (!job) return;
    queue.splice(queue.indexOf(job), 1);
    active.add(job);
    runJob(job);
  }
}

export function createJob(url, opts, extra = {}) {
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
    // what kind of device asked ("android") and the name it goes by ("Ayşe's phone")
    device: extra.device || extra.batch?.device || null,
    deviceName: extra.deviceName || extra.batch?.deviceName || null,
    expected: expectedHeight(opts, cachedStats(url)),
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
      failed: s.failed || null,
      size: s.size,
      duration: batch.jobs.reduce((n, j) => n + (j.status === 'done' && j.meta?.duration || 0), 0) || null,
      took: Date.now() - batch.createdAt,
      device: batch.device,
      deviceName: batch.deviceName,
    });
  }
  for (const res of batch.listeners) res.end();
  batch.listeners.clear();
  clearTimeout(batch.cleanup);
  batch.cleanup = setTimeout(() => removeBatch(batch), config.keepFilesMinutes * 60000);
}

export function removeBatch(batch) {
  batch.removed = true;
  clearTimeout(batch.cleanup);
  for (const job of batch.jobs) {
    if (!isFinal(job.status)) cancelJob(job);
    // running jobs are removed in finish() once their process exits
    if (!job.proc) removeJob(job);
  }
  batches.delete(batch.id);
}

// who: { device, deviceName } of the device that asked
export function createBatch(body, who = {}) {
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
    device: who.device || null,
    deviceName: who.deviceName || null,
    createdAt: Date.now(),
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

// The finished videos of a playlist (and the .srt files asked for) as one ZIP, or null
export async function batchZip(batch) {
  const done = batch.jobs.filter((j) => j.status === 'done' && j.file && fs.existsSync(j.file));
  if (!done.length) return null;
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
  const name = batch.title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'playlist';
  return { name: name + '.zip', zip: createZip(entries) };
}
