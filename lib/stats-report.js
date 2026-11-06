// Statistics: the numbers the statistics page shows and the CSV, computed from the records
// stats.js keeps. No files and no state here, so it can be tested on its own.

// What a record holds (all optional except date and outcome)
export const FIELDS = ['date', 'outcome', 'error', 'kind', 'mode', 'site', 'extractor', 'count', 'size', 'duration', 'took',
  'height', 'fps', 'codec', 'hdr', 'ext', 'trimmed', 'subs', 'playlist', 'device', 'deviceName'];

const QUALITY_STEPS = [4320, 2160, 1440, 1080, 720, 480, 360];
// 1080 -> "1080p", 2160 -> "4K", a vertical 1080x1920 counts as 1080p (see shortSide)
export function qualityName(height) {
  if (!height) return null;
  const step = QUALITY_STEPS.find((s) => height >= s * 0.95) || 'low';
  return step === 4320 ? '8K' : step === 2160 ? '4K' : step === 'low' ? '<360p' : `${step}p`;
}

const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const dayKey = (d) => `${monthKey(d)}-${String(d.getDate()).padStart(2, '0')}`;

// [{ key, count, bytes }] biggest first, the rest summed up as "other" past `top`
function rank(map, top = 8) {
  const list = [...map.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.count - a.count || b.bytes - a.bytes);
  if (list.length <= top) return list;
  const rest = list.slice(top - 1).reduce((o, v) => ({ key: 'other', count: o.count + v.count, bytes: o.bytes + v.bytes }), { key: 'other', count: 0, bytes: 0 });
  return [...list.slice(0, top - 1), rest];
}

function tally(map, key, count, bytes) {
  if (key == null || key === '') return;
  const v = map.get(key) || { count: 0, bytes: 0 };
  v.count += count;
  v.bytes += bytes;
  map.set(key, v);
}

// Everything in local time (the PC's, which is also the phones' at home)
export function summarize(list, now = Date.now()) {
  const done = list.filter((r) => r.outcome === 'done');
  const failed = list.filter((r) => r.outcome === 'error');
  const sites = new Map();
  const devices = new Map();
  const qualities = new Map();
  const codecs = new Map();
  const audio = new Map();
  const months = new Map();
  const days = new Map();
  const weekdays = Array(7).fill(0); // Monday first
  const hours = Array(24).fill(0);
  let downloads = 0;
  let bytes = 0;
  let seconds = 0;
  let timedBytes = 0;
  let timedMs = 0;
  let video = 0;
  let audioCount = 0;
  let gifs = 0;
  let trimmed = 0;
  let withSubs = 0;
  let fromPlaylists = 0;

  for (const r of done) {
    const n = r.count || 1;
    const size = r.size || 0;
    const d = new Date(r.date);
    downloads += n;
    bytes += size;
    seconds += r.duration || 0;
    if (r.took > 0 && size > 0) {
      timedBytes += size;
      timedMs += r.took;
    }
    if (r.mode === 'audio') audioCount += n;
    else if (r.mode === 'gif') gifs += n;
    else video += n;
    if (r.trimmed) trimmed += n;
    if (r.subs) withSubs += n;
    if (r.playlist || r.kind === 'playlist') fromPlaylists += n;
    tally(sites, r.site || 'other', n, size);
    tally(devices, r.deviceName || r.device || 'other', n, size);
    if (!r.mode || r.mode === 'video') tally(qualities, qualityName(r.height), n, size);
    if (!r.mode || r.mode === 'video') tally(codecs, r.codec, n, size);
    if (r.mode === 'audio') tally(audio, r.ext && r.ext.toUpperCase(), n, size);
    tally(months, monthKey(d), n, size);
    tally(days, dayKey(d), n, size);
    weekdays[(d.getDay() + 6) % 7] += n;
    hours[d.getHours()] += n;
  }

  // the last 12 months and the last 30 days, empty ones included, oldest first
  const today = new Date(now);
  const lastMonths = [];
  for (let i = 11; i >= 0; i--) {
    const key = monthKey(new Date(today.getFullYear(), today.getMonth() - i, 1));
    lastMonths.push({ key, ...(months.get(key) || { count: 0, bytes: 0 }) });
  }
  const lastDays = [];
  for (let i = 29; i >= 0; i--) {
    const key = dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i));
    lastDays.push({ key, ...(days.get(key) || { count: 0, bytes: 0 }) });
  }
  const busiest = [...days.entries()].sort((a, b) => b[1].count - a[1].count)[0];

  return {
    since: list.reduce((min, r) => (min == null || r.date < min ? r.date : min), null),
    total: { downloads, bytes, seconds: Math.round(seconds), failed: failed.length, video, audio: audioCount, gif: gifs },
    successRate: done.length + failed.length ? done.length / (done.length + failed.length) : null,
    speed: timedMs ? Math.round(timedBytes / (timedMs / 1000)) : null, // bytes per second
    extras: { trimmed, withSubs, fromPlaylists },
    thisMonth: lastMonths[11],
    lastMonth: lastMonths[10],
    months: lastMonths,
    days: lastDays,
    busiestDay: busiest ? { key: busiest[0], ...busiest[1] } : null,
    weekdays,
    hours,
    sites: rank(sites),
    devices: rank(devices),
    qualities: rank(qualities),
    codecs: rank(codecs, 5),
    audioFormats: rank(audio, 5),
  };
}

// Every record as CSV (for a spreadsheet)
export function statsCsv(list) {
  const cols = FIELDS;
  const cell = (v) => {
    if (v == null) return '';
    if (typeof v === 'boolean') return v ? 'yes' : '';
    let s = String(v);
    // a device name like "=1+1" would run as a formula in a spreadsheet
    if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = list.map((r) => cols.map((c) => cell(c === 'date' ? new Date(r.date).toISOString() : r[c])).join(','));
  return [cols.join(','), ...rows].join('\r\n') + '\r\n';
}
