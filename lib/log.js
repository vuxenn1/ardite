// data/ardite.log. It's moved to ardite.old.log once it passes 1 MB (replacing the older one),
// also while Ardite runs for weeks, so the two together never take more than about 2 MB.
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.js';

const LOG_FILE = path.join(DATA, 'ardite.log');
const OLD_LOG = path.join(DATA, 'ardite.old.log');
const LOG_MAX = 1024 * 1024;

let logSize = 0;
try {
  logSize = fs.statSync(LOG_FILE).size;
} catch { /* no log yet */ }

function rotateLog() {
  try {
    fs.renameSync(LOG_FILE, OLD_LOG); // replaces the previous old log
  } catch { /* nothing to move */ }
  logSize = 0;
}
if (logSize > LOG_MAX) rotateLog();

export function log(...parts) {
  const line = `[${new Date().toLocaleString('en-GB')}] ${parts.join(' ')}\n`;
  process.stdout.write(line);
  logSize += Buffer.byteLength(line);
  if (logSize > LOG_MAX) rotateLog();
  fs.appendFile(LOG_FILE, line, () => {});
}
