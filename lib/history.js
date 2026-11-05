// The download history, shared by all devices. Only small details are kept (title, link, site,
// device), never the files themselves, which stay on whichever device downloaded them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA, readJson } from './config.js';
import { log } from './log.js';
import { cleanUrl, siteOf } from './core.js';

const HISTORY_FILE = path.join(DATA, 'history.json');
const HISTORY_MAX = 500;

let history = readJson(HISTORY_FILE);
if (!Array.isArray(history)) history = [];

function save() {
  try {
    fs.writeFileSync(HISTORY_FILE + '.tmp', JSON.stringify(history));
    fs.renameSync(HISTORY_FILE + '.tmp', HISTORY_FILE);
  } catch (e) {
    log('could not save history:', e.message);
  }
}

// Entries saved by older versions still have tracking parameters and short-link site names
function tidy() {
  let changed = false;
  for (const e of history) {
    if (!e?.url) continue;
    const url = cleanUrl(e.url);
    const site = siteOf(url);
    if (url !== e.url || site !== e.site) {
      Object.assign(e, { url, site });
      changed = true;
    }
  }
  return changed;
}
if (tidy()) save();

export const listHistory = () => history;

export function addHistory(entry) {
  // the link without tracking parameters (the download itself used the original)
  const url = entry.url ? cleanUrl(entry.url) : entry.url;
  history.unshift({ id: crypto.randomBytes(4).toString('hex'), date: Date.now(), site: url ? siteOf(url) : null, ...entry, url });
  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
  save();
}

export function removeHistory(id) {
  history = history.filter((e) => e.id !== id);
  save();
}

export function clearHistory() {
  history = [];
  save();
}
