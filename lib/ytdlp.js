// Running yt-dlp: the options every run shares (the login included), stopping runs, and keeping
// yt-dlp up to date.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { BIN, DATA, YTDLP, config } from './config.js';
import { log } from './log.js';
import { parseCookiesTxt } from './core.js';

export const COOKIES_FILE = path.join(DATA, 'cookies.txt');

// [command, args] for spawn/execFile; a .js/.mjs stand-in (the tests') runs with this Node
export const ytdlp = (args) => (/\.m?js$/i.test(YTDLP) ? [process.execPath, [YTDLP, ...args]] : [YTDLP, args]);

// Stops a tool and everything it started
export function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], () => {});
  } else {
    proc.kill('SIGKILL');
  }
}

// A damaged cookies.txt would make every download fail, so it's left out (Settings says so)
export function cookiesFileOk() {
  try {
    return parseCookiesTxt(fs.readFileSync(COOKIES_FILE, 'utf8')).ok;
  } catch {
    return false;
  }
}

export function commonArgs() {
  const args = [
    '--no-warnings',
    '--no-colors',
    '--ffmpeg-location', BIN,
    // YouTube needs a JavaScript runtime for signature solving; reuse the Node we're running on
    '--js-runtimes', `node:${process.execPath}`,
  ];
  if (cookiesFileOk()) args.push('--cookies', COOKIES_FILE);
  else if (config.cookiesFromBrowser) args.push('--cookies-from-browser', config.cookiesFromBrowser);
  return args;
}

// ---------- updates ----------
// Sites change often, so yt-dlp needs frequent updates. It replaces its own .exe, so the update
// only runs while nothing uses yt-dlp: one asked for during downloads waits until they're done,
// and downloads and previews started during the update (a few seconds) wait for it.

let version = null;
const update = { pending: false, promise: null, reason: null, last: 0, result: null };
// Set by server.js: whether nothing uses yt-dlp right now, and what to do after an update
const hooks = { isFree: () => true, afterUpdate: () => {} };
export const useYtdlpHooks = (h) => Object.assign(hooks, h);

export const ytdlpVersion = () => version;
export const lastYtdlpCheck = () => update.last;
// asked for or running: new downloads don't start meanwhile
export const ytdlpBusy = () => update.pending || !!update.promise;

export async function ytdlpReady() {
  while (update.promise) await update.promise;
}

export function readVersion() {
  return new Promise((resolve) => {
    execFile(...ytdlp(['--version']), { windowsHide: true }, (err, out) => {
      if (!err) version = out.trim();
      resolve();
    });
  });
}

export function requestYtdlpUpdate(reason) {
  update.pending = true;
  update.reason ??= reason;
  maybeUpdateYtdlp();
}

// Runs an update that was asked for, once nothing uses yt-dlp
export function maybeUpdateYtdlp() {
  if (!update.pending || update.promise || !hooks.isFree()) return;
  update.pending = false;
  update.promise = new Promise((resolve) => {
    execFile(...ytdlp(['-U']), { windowsHide: true, timeout: 180000 }, (err, out, errOut) => {
      const text = `${out || ''}\n${errOut || ''}`.trim().split(/\r?\n/).pop() || err?.message || '';
      update.result = /^Updated yt-dlp/i.test(text) ? 'updated' : /up to date/i.test(text) ? 'current' : 'failed';
      update.last = Date.now();
      log(`yt-dlp update${update.reason ? ` (${update.reason})` : ''}: ${text}`);
      update.reason = null;
      readVersion().then(resolve);
    });
  }).finally(() => {
    update.promise = null;
    hooks.afterUpdate(); // downloads that waited for the update
  });
}

export function ytdlpStatus() {
  return {
    version,
    updating: !!update.promise,
    waiting: update.pending, // asked for, waiting for downloads to finish
    last: update.last || null,
    result: update.result,
  };
}
