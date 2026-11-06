// Ardite web UI, part 7: the statistics window: everything downloaded on every device, counted on
// the PC. Each chart has one series, so one color and no legend; numbers are always written out
// next to the bars or shown when hovering one, never left to the bar's length alone.

const statsDlg = $('#statsDlg');
let statsData = null;

const fmtNum = (n) => new Intl.NumberFormat(locale()).format(n);
const fmtPercent = (x) => new Intl.NumberFormat(locale(), { style: 'percent', maximumFractionDigits: 0 }).format(x);
const pad2 = (n) => String(n).padStart(2, '0');
// "2026-11-06" -> a local date
const dateOf = (key) => {
  const [y, m, d = 1] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};

function fmtLength(sec) {
  if (sec >= 3600) return t('stats.hoursN', new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(sec / 3600));
  return t('stats.minutesN', Math.round(sec / 60));
}

async function openStats() {
  statsDlg.showModal();
  await loadStats();
}

async function loadStats() {
  try {
    statsData = await api('/api/stats');
  } catch (err) {
    statsData = null;
    toast(errText(err));
  }
  renderStats();
}

// A headline number
function tile(label, value, note) {
  return h('div', { class: 'stat-tile' }, h('span', {}, label), h('b', {}, value), note && h('small', {}, note));
}

function block(title, ...content) {
  return h('section', { class: 'stat-block' }, h('h3', {}, title), ...content);
}

// Vertical bars along time or a cycle (months, weekdays, hours). tip(item, i) is the full text of
// a bar, shown on hover and read out by screen readers.
function columns(items, { label, tip, values = true, current = -1 }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return h('div', { class: 'cols', role: 'img', 'aria-label': items.map(tip).join('; ') },
    items.map((item, i) => h('div', { class: 'col' + (i === current ? ' current' : ''), title: tip(item, i) },
      h('small', {}, values && item.count ? fmtNum(item.count) : ''),
      h('span', { class: 'col-track' }, h('i', { style: `height: ${(item.count / max) * 100}%` })),
      h('em', {}, label(item, i)))));
}

// Horizontal bars, biggest first, each with its name and number written out
function ranking(title, items, nameOf) {
  if (!items?.length) return null;
  const max = Math.max(1, ...items.map((i) => i.count));
  return block(title, h('ul', { class: 'rank' }, items.map((item) => {
    const name = item.key === 'other' ? t('stats.other') : nameOf(item.key);
    return h('li', { title: `${name}: ${t('stats.countN', item.count)} · ${fmtBytes(item.bytes) || '0 B'}` },
      h('span', { class: 'rank-name' }, name),
      h('span', { class: 'rank-track' }, h('i', { style: `width: ${(item.count / max) * 100}%` })),
      h('span', { class: 'rank-value' }, fmtNum(item.count)));
  })));
}

// Device kinds from before device names ("android") read as their name; names stay as typed
const DEVICE_KINDS = ['pc', 'iphone', 'ipad', 'android', 'windows', 'mac', 'linux', 'other'];
const deviceKeyName = (key) => (DEVICE_KINDS.includes(key) ? t('device.' + key) : key);

function renderStats() {
  const body = $('#statsBody');
  const s = statsData;
  if (!s) return body.replaceChildren();
  if (!s.total.downloads && !s.total.failed) return body.replaceChildren(h('p', { class: 'hint' }, t('stats.empty')));

  const monthShort = (key) => new Intl.DateTimeFormat(locale(), { month: 'short' }).format(dateOf(key));
  const monthLong = (key) => new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric' }).format(dateOf(key));
  // 1 January 2024 was a Monday, and the week starts on Monday here
  const weekday = (i, style = 'short') => new Intl.DateTimeFormat(locale(), { weekday: style }).format(new Date(2024, 0, 1 + i));
  const peakHour = s.hours.indexOf(Math.max(...s.hours));
  const change = s.thisMonth.count - s.lastMonth.count;
  const notes = [
    s.busiestDay && t('stats.busiest', fmtDay(dateOf(s.busiestDay.key)), fmtNum(s.busiestDay.count)),
    t('stats.extras', fmtNum(s.extras.trimmed), fmtNum(s.extras.withSubs), fmtNum(s.extras.fromPlaylists)),
  ];

  body.replaceChildren(
    s.since && h('p', { class: 'tiny stats-since' }, t('stats.since', fmtDay(s.since))),
    h('div', { class: 'stat-tiles' },
      tile(t('stats.downloads'), fmtNum(s.total.downloads), t('stats.split', fmtNum(s.total.video), fmtNum(s.total.audio))),
      tile(t('stats.size'), fmtBytes(s.total.bytes) || '0 B'),
      // downloads from before Ardite counted lengths have none, so 0 means "not known"
      tile(t('stats.length'), s.total.seconds ? fmtLength(s.total.seconds) : '—'),
      tile(t('stats.speed'), s.speed ? fmtBytes(s.speed) + '/s' : '—'),
      tile(t('stats.success'), s.successRate == null ? '—' : fmtPercent(s.successRate), s.total.failed ? t('stats.failedN', fmtNum(s.total.failed)) : null),
      tile(t('stats.thisMonth'), fmtNum(s.thisMonth.count), t('stats.lastMonth', fmtNum(s.lastMonth.count), change))),
    block(t('stats.months'), columns(s.months, {
      label: (m) => monthShort(m.key),
      tip: (m) => `${monthLong(m.key)}: ${t('stats.countN', m.count)} · ${fmtBytes(m.bytes) || '0 B'}`,
      current: s.months.length - 1,
    })),
    h('div', { class: 'stat-pair' },
      block(t('stats.weekdays'), columns(s.weekdays.map((count) => ({ count })), {
        label: (_, i) => weekday(i),
        tip: (w, i) => `${weekday(i, 'long')}: ${t('stats.countN', w.count)}`,
      })),
      block(t('stats.hours'), columns(s.hours.map((count) => ({ count })), {
        label: (_, i) => (i % 6 === 0 ? pad2(i) : ''),
        tip: (hr, i) => `${pad2(i)}:00–${pad2(i)}:59: ${t('stats.countN', hr.count)}`,
        values: false,
      }), h('p', { class: 'tiny' }, t('stats.peakHour', `${pad2(peakHour)}:00`)))),
    h('div', { class: 'stat-grid' },
      ranking(t('stats.sites'), s.sites, (k) => k),
      ranking(t('stats.devices'), s.devices, deviceKeyName),
      ranking(t('stats.qualities'), s.qualities, (k) => k),
      ranking(t('stats.audio'), s.audioFormats, (k) => k),
      ranking(t('stats.codecs'), s.codecs, (k) => k)),
    h('p', { class: 'tiny' }, notes.filter(Boolean).join(' · ')));
}

$('#statsBtn').addEventListener('click', openStats);
$('#statsClose').addEventListener('click', () => statsDlg.close());
$('#statsReset').addEventListener('click', async () => {
  if (!confirm(t('stats.resetConfirm'))) return;
  try {
    await api('/api/stats', { method: 'DELETE' });
  } catch (err) { toast(errText(err)); }
  loadStats();
});
