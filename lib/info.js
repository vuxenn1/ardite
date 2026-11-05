// Video info for the preview (yt-dlp -J). At most a few previews run at once, the others wait
// their turn. The same link asked for twice (e.g. from two devices) shares one yt-dlp run, and a
// run nobody waits for anymore (the page was closed or another link pasted) is stopped.
// The info is kept for a while and reused by the download, so downloads start faster.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { config, WORK } from './config.js';
import { ytdlp, commonArgs, killTree, ytdlpReady, maybeUpdateYtdlp } from './ytdlp.js';
import { friendlyError, lastError, summarizeVideo, summarizePlaylist, videoStats, linkKind } from './core.js';

const INFO_MAX = 3;
const INFO_TTL = 20 * 60 * 1000;

const cache = new Map(); // url -> { file, time, stats }
let running = 0;
const waiting = [];
const runs = new Map(); // "video|<url>" or "list|<url>" -> { promise, users, proc, gone }

const canceledError = () => Object.assign(new Error('canceled'), { code: 'canceled' });

export const infoBusy = () => running > 0;

// ---------- the cache, also read by downloads ----------

export const cachedInfoFile = (url) => cache.get(url)?.file;
export const cachedStats = (url) => cache.get(url)?.stats;
export const forgetInfo = (url) => cache.delete(url);

function cacheInfo(url, json, info) {
  const file = path.join(WORK, 'info-' + crypto.createHash('sha1').update(url).digest('hex') + '.json');
  fs.writeFileSync(file, json);
  cache.set(url, { file, time: Date.now(), stats: videoStats(info) });
}

// The info of a video previewed a few minutes ago, without asking yt-dlp again
function cachedInfo(url) {
  const c = cache.get(url);
  if (!c || Date.now() - c.time > INFO_TTL) return null;
  try {
    return JSON.parse(fs.readFileSync(c.file, 'utf8'));
  } catch {
    return null;
  }
}

export function dropStaleInfo() {
  for (const [url, entry] of cache) {
    if (Date.now() - entry.time > INFO_TTL) {
      fs.rm(entry.file, { force: true }, () => {});
      cache.delete(url);
    }
  }
}

// ---------- running yt-dlp -J ----------

function slot() {
  if (running < INFO_MAX) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function freeSlot() {
  const next = waiting.shift();
  if (next) next(); // the slot passes straight on
  else running--;
}

function fetchInfo(url, playlist, signal) {
  const key = `${playlist ? 'list' : 'video'}|${url}`;
  let run = runs.get(key);
  if (!run) {
    run = { users: 0, proc: null, gone: false };
    run.promise = runInfo(run, url, playlist).finally(() => {
      if (runs.get(key) === run) runs.delete(key);
    });
    runs.set(key, run);
  }
  run.users++;
  return new Promise((resolve, reject) => {
    const leave = () => {
      reject(canceledError());
      if (--run.users > 0) return;
      run.gone = true;
      if (runs.get(key) === run) runs.delete(key);
      killTree(run.proc);
    };
    if (signal?.aborted) return leave();
    signal?.addEventListener('abort', leave, { once: true });
    run.promise.then(resolve, reject).finally(() => signal?.removeEventListener('abort', leave));
  });
}

async function runInfo(run, url, playlist) {
  await slot();
  try {
    await ytdlpReady(); // yt-dlp may be replacing itself
    if (run.gone) throw canceledError(); // given up while waiting
    return await spawnInfo(run, url, playlist);
  } finally {
    freeSlot();
    maybeUpdateYtdlp();
  }
}

function spawnInfo(run, url, playlist) {
  return new Promise((resolve, reject) => {
    const args = [...commonArgs(), '-J', '--flat-playlist', playlist ? '--yes-playlist' : '--no-playlist', '--', url];
    const proc = spawn(...ytdlp(args), { windowsHide: true });
    run.proc = proc;
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

// What the preview shows for a link: a video, a playlist, or a playlist link that also points at
// one of its videos (youtube.com/watch?v=X&list=Y), then both. signal: the asker went away.
export async function getInfo(url, signal) {
  const kind = linkKind(url);
  if (!kind.list) {
    const cached = cachedInfo(url);
    if (cached) return summarizeVideo(cached);
    const res = await fetchInfo(url, false, signal);
    if (res.info._type === 'playlist') return summarizePlaylist(res.info, config.maxPlaylistItems);
    cacheInfo(url, res.json, res.info);
    return summarizeVideo(res.info);
  }

  const [list, single] = await Promise.allSettled([
    fetchInfo(url, true, signal),
    kind.video ? fetchInfo(url, false, signal) : Promise.reject(null),
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
