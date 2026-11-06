// Statistics: one small record per finished or failed download, kept in data/stats.jsonl.
// Unlike the history (the last 500 downloads, with titles and links) it has no limit and no
// titles or links, only numbers, so it can grow for years. Clearing the history keeps it;
// the statistics window has its own reset. See stats-report.js for what's made of it. The first time, the downloads already in the history are copied in.
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.js';
import { log } from './log.js';
import { FIELDS } from './stats-report.js';

const STATS_FILE = path.join(DATA, 'stats.jsonl');

let records = null;

function load() {
  if (records) return records;
  records = [];
  try {
    for (const line of fs.readFileSync(STATS_FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch { /* a line cut short by a crash: skip it */ }
    }
  } catch { /* none yet */ }
  return records;
}

function clean(record) {
  const out = {};
  for (const k of FIELDS) if (record[k] != null && record[k] !== '' && record[k] !== false) out[k] = record[k];
  return out;
}

export function addStat(record) {
  const r = clean({ date: Date.now(), ...record });
  load().push(r);
  fs.appendFile(STATS_FILE, JSON.stringify(r) + '\n', (e) => e && log('could not save statistics:', e.message));
}

// The history entries saved before statistics existed become the first records (once)
export function seedStats(history) {
  if (fs.existsSync(STATS_FILE)) return;
  records = [...history].reverse().map((e) => clean({
    date: e.date,
    outcome: 'done',
    kind: e.kind,
    mode: e.mode,
    site: e.site,
    count: e.kind === 'playlist' ? e.count : undefined,
    size: e.size,
    height: e.media?.height,
    fps: e.media?.fps,
    codec: e.media?.codec,
    hdr: e.media?.hdr,
    ext: e.ext,
    trimmed: !!e.trim,
    subs: e.subs?.length,
    device: e.device,
    deviceName: e.deviceName,
  }));
  try {
    fs.writeFileSync(STATS_FILE, records.map((r) => JSON.stringify(r) + '\n').join(''));
    if (records.length) log(`statistics started with the ${records.length} downloads already in the history`);
  } catch (e) {
    log('could not save statistics:', e.message);
  }
}

export const listStats = () => load();

export function resetStats() {
  records = [];
  fs.writeFileSync(STATS_FILE, '');
}
