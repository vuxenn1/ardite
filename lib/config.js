// Where Ardite keeps its files, and its settings: data/config.json over the defaults below.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC = path.join(ROOT, 'public');
export const DATA = path.join(ROOT, 'data');
export const BIN = path.join(ROOT, 'bin');
const EXE = process.platform === 'win32' ? '.exe' : '';
export const FFMPEG = path.join(BIN, 'ffmpeg' + EXE);
export const FFPROBE = path.join(BIN, 'ffprobe' + EXE);
// The tests run a stand-in for yt-dlp (a Node script, see .github/fake-yt-dlp.mjs) through ARDITE_YTDLP
export const YTDLP = process.env.ARDITE_YTDLP || path.join(BIN, 'yt-dlp' + EXE);
const CONFIG_FILE = path.join(DATA, 'config.json');

fs.mkdirSync(DATA, { recursive: true });

export function readJson(file) {
  try {
    // Notepad may save UTF-8 with a BOM, which JSON.parse rejects
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return {};
  }
}

export const config = {
  port: 7878,
  host: '0.0.0.0',
  maxConcurrent: 2,
  keepFilesMinutes: 30,
  maxPlaylistItems: 500,
  cookiesFromBrowser: '', // e.g. "firefox", for sites that require login
  updateCheck: true, // look for new Ardite releases on GitHub
  repo: 'vuxenn1/ardite',
  allowedHosts: [], // extra names this PC is opened with, e.g. a Tailscale name
  tempFolder: '', // where downloads wait to be saved; Windows' temp folder when empty
  minFreeGB: 2, // downloads don't start with less free space than this
  ...readJson(CONFIG_FILE),
};
if (process.env.PORT) config.port = Number(process.env.PORT);

// Temp folder for downloads. It's emptied at start, so each port (each Ardite) gets its own.
export const WORK = path.join(config.tempFolder || os.tmpdir(), `ardite-jobs-${config.port}`);

// Release packages get their version from the git tag; running from source shows "0.0.0-dev"
export const VERSION = readJson(path.join(ROOT, 'package.json')).version || '0.0.0-dev';

// Changes data/config.json and the running settings together; '' or null removes a setting
export function saveConfig(patch) {
  const next = { ...readJson(CONFIG_FILE), ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === '' || v == null) delete next[k];
  fs.writeFileSync(CONFIG_FILE + '.tmp', JSON.stringify(next, null, 2));
  fs.renameSync(CONFIG_FILE + '.tmp', CONFIG_FILE);
  Object.assign(config, patch);
}
