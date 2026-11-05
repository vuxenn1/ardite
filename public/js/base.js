// Ardite web UI, part 1: per-device settings, small helpers and the theme.
// The page loads these scripts in order (see index.html); they share one scope, like a single file.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ---------- per-device settings ----------

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('ardite.' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('ardite.' + key, JSON.stringify(value));
    } catch { /* private mode etc. */ }
  },
};

const isTouch = matchMedia('(pointer: coarse)').matches;

const settings = {
  mode: 'video',
  quality: 'max',
  // PCs get the best quality (4K, 60 fps); phones get H.264, which every phone can play
  codec: isTouch ? 'h264' : 'best',
  audioFormat: 'mp3',
  autoSave: true,
  // remembered subtitle choices; subtitles themselves are off until turned on for a download
  subLangs: [...new Set([lang, 'en'])],
  subAuto: false,
  subSrt: false,
  theme: 'auto',
  lang: 'auto',
  ...store.get('settings', {}),
};
// Older versions defaulted to H.264 everywhere, which caps YouTube at 1080p.
// Move PCs to the best quality unless someone picked a format in Settings.
if (!isTouch && !settings.codecChosen) settings.codec = 'best';
const saveSettings = () => store.set('settings', settings);

// ---------- small helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'indeterminate' || k === 'disabled') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

function icon(name) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.innerHTML = ICONS[name];
  return el;
}

const ICONS = {
  video: '<rect x="3" y="5" width="13" height="14" rx="2.5"/><path d="M16 10l5-3v10l-5-3"/>',
  audio: '<path d="M9 18V6l11-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  list: '<path d="M4 6h11M4 11h11M4 16h7"/><path d="M17 14v6l4-3z"/>',
  save: '<path d="M12 4v12M6.5 10.5 12 16l5.5-5.5M5 20h14"/>',
  zip: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M11 9h1M11 12h1M11 15h1"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  cc: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10.5 10.2a2.3 2.3 0 1 0 0 3.6M17 10.2a2.3 2.3 0 1 0 0 3.6"/>',
  cut: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>',
};

function img(src) {
  return src ? h('img', { src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() }) : null;
}

function fmtBytes(n) {
  if (n == null || !isFinite(n) || n <= 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

function fmtDuration(sec) {
  if (!sec) return '';
  sec = Math.round(sec);
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

function fmtEta(sec) {
  if (sec == null || !isFinite(sec)) return '';
  sec = Math.max(1, Math.round(sec));
  if (sec < 60) return t('eta.s', sec);
  return t('eta.m', Math.floor(sec / 60), sec % 60);
}

// Server errors carry a code so they can be shown in the viewer's language
function errText(e, fallback = 'err.generic') {
  if (!e) return t(fallback);
  const code = e.code || e.errorCode;
  if (code && hasText('err.' + code)) return t('err.' + code);
  return e.message || t(fallback);
}

const phaseText = (phase) => (phase && hasText('phase.' + phase) ? t('phase.' + phase) : phase);

// "1080p", "4K"; with a frame rate above 30 it becomes "1080p60", "4K60"
function qualityLabel(q, fps) {
  if (q === 'max') return settings.codec === 'h264' ? t('q.auto') : t('q.best');
  const n = Number(q);
  const label = n >= 4320 ? '8K' : n >= 2160 ? '4K' : n + 'p';
  return fps > 30 ? label + fps : label;
}

// What a finished download really is, e.g. "4K60 · VP9" or "1080p · H.264 · HDR10"
function mediaLabel(m) {
  if (!m?.height) return '';
  return [qualityLabel(String(m.height), m.fps), m.codec, m.hdr].filter(Boolean).join(' · ');
}

const isLowQuality = (d) => d.media?.height && d.expected && d.media.height < d.expected;

function extractUrl(text) {
  const m = /https?:\/\/[^\s<>"']+/i.exec(text || '');
  return m ? m[0] : null;
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.code === 'locked') showLock();
  if (!res.ok) throw Object.assign(new Error(data.message || t('err.generic')), { status: res.status, data, code: data.code });
  return data;
}

function download(href) {
  const a = h('a', { href, download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}

const isFinal = (s) => s === 'done' || s === 'error' || s === 'canceled';

// ---------- theme ----------

function applyTheme() {
  const root = document.documentElement;
  if (settings.theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = settings.theme;
  for (const b of $$('[data-theme-val]')) b.setAttribute('aria-pressed', String(b.dataset.themeVal === settings.theme));
}
