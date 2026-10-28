// Ardite web UI
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

// ---------- link box & preview ----------

const form = $('#form');
const input = $('#url');
const previewEl = $('#preview');
const optsPanel = $('#optsPanel');
// The options live in the card of the video they apply to. While no video is shown they're
// parked in a hidden holder, so they stay in the page and keep their state.
const parkPanel = () => $('#optsHolder').append(optsPanel);
let preview = null; // { url, data, error, promise, scope, selected:Set }
let previewSeq = 0;
let previewTimer;

function updateInputButtons() {
  const has = input.value.trim().length > 0;
  $('#clearBtn').hidden = !has;
  $('#pasteBtn').hidden = has || !navigator.clipboard?.readText;
}

function resetPreview() {
  clearTimeout(previewTimer);
  previewSeq++;
  preview = null;
  parkPanel();
  previewEl.hidden = true;
  previewEl.className = 'card preview';
  previewEl.replaceChildren();
  renderOpts();
}

function loadPreview(url) {
  const seq = ++previewSeq;
  preview = { url, data: null, error: null, scope: 'video', selected: new Set() };
  // trimming and subtitles belong to one video; a new link starts without them
  resetTrim();
  resetSubs();
  parkPanel();
  previewEl.hidden = false;
  previewEl.className = 'card preview';
  previewEl.replaceChildren(h('div', { class: 'pv-row' },
    h('div', { class: 'thumb skeleton' }),
    h('div', { class: 'pv-info' },
      h('div', { class: 'skeleton sk-line', style: 'width: 85%' }),
      h('div', { class: 'skeleton sk-line', style: 'width: 55%' }),
      h('div', { class: 'skeleton sk-line', style: 'width: 30%; height: 11px' }))));

  const current = preview;
  current.promise = api('/api/info', { method: 'POST', body: { url } })
    .then((data) => {
      if (seq !== previewSeq) return;
      current.data = data;
      if (data.type === 'playlist') {
        current.scope = data.video ? 'video' : 'playlist';
        current.selected = new Set(data.entries.filter((e) => !e.unavailable).map((e) => e.index));
      }
      renderPreview();
      renderOpts();
    })
    .catch((e) => {
      if (seq !== previewSeq) return;
      current.error = e;
      parkPanel();
      previewEl.className = 'card preview error';
      previewEl.replaceChildren(h('div', {}, errText(e), e.data?.detail && h('small', {}, e.data.detail)));
    });
  return current.promise;
}

function videoRow(v) {
  const thumb = h('div', { class: 'thumb' }, img(v.thumbnail), v.duration && h('span', { class: 'dur' }, fmtDuration(v.duration)));
  const best = v.heights?.[0];
  return h('div', { class: 'pv-row video' }, thumb, h('div', { class: 'pv-info' },
    h('div', { class: 'pv-title', title: v.title }, v.title || t('untitled')),
    h('div', { class: 'meta' },
      v.uploader && h('span', {}, v.uploader),
      v.site && h('span', { class: 'badge' }, v.site),
      best && h('span', { class: 'badge' }, t('upTo', qualityLabel(String(best), v.fps?.[best]))),
      !v.hasVideo && h('span', { class: 'badge' }, t('audioOnly')))));
}

function playlistRow(p) {
  const thumb = h('div', { class: 'thumb' }, img(p.thumbnail),
    h('span', { class: 'count' }, icon('list'), String(p.count)));
  return h('div', { class: 'pv-row playlist' }, thumb, h('div', { class: 'pv-info' },
    h('div', { class: 'pv-title', title: p.title }, p.title),
    h('div', { class: 'meta' },
      p.uploader && h('span', {}, p.uploader),
      h('span', { class: 'badge' }, t('playlistBadge', p.count)))));
}

function batchButtonLabel(n) {
  if (!n) return t('batch.select');
  return settings.mode === 'audio'
    ? t('batch.audio', n, settings.audioFormat === 'best' ? t('batch.audioAny') : settings.audioFormat.toUpperCase())
    : t('batch.video', n);
}

function renderPreview() {
  const p = preview;
  const d = p?.data;
  if (!d) return;
  previewEl.className = 'card preview';

  if (d.type === 'video') {
    previewEl.replaceChildren(videoRow(d), optsPanel);
    return;
  }

  const parts = [];
  if (d.video) {
    parts.push(h('div', { class: 'scope' }, h('div', { class: 'mini-seg' },
      h('button', { type: 'button', 'aria-pressed': String(p.scope === 'video'), onclick: () => setScope('video') }, t('scope.video')),
      h('button', { type: 'button', 'aria-pressed': String(p.scope === 'playlist'), onclick: () => setScope('playlist') }, t('scope.playlist', d.count)))));
  }

  if (p.scope === 'video' && d.video) {
    parts.unshift(videoRow(d.video));
    previewEl.replaceChildren(...parts, optsPanel);
    return;
  }

  parts.unshift(playlistRow(d));
  parts.push(optsPanel);
  const available = d.entries.filter((e) => !e.unavailable);
  const n = p.selected.size;
  const all = n === available.length && n > 0;

  parts.push(h('div', { class: 'pl-toolbar' },
    h('label', {},
      h('input', {
        type: 'checkbox', class: 'check', checked: all, indeterminate: n > 0 && !all,
        onchange: (e) => {
          p.selected = e.target.checked ? new Set(available.map((x) => x.index)) : new Set();
          renderPreview();
        },
      }),
      t('selectAll')),
    h('span', {}, t('selected', n, d.entries.length))));

  const list = h('ul', { class: 'pl-list' }, d.entries.map((e) => h('li', { class: e.unavailable ? 'off' : null },
    h('label', {},
      h('input', {
        type: 'checkbox', class: 'check', checked: p.selected.has(e.index), disabled: e.unavailable,
        onchange: (ev) => {
          if (ev.target.checked) p.selected.add(e.index);
          else p.selected.delete(e.index);
          updatePlaylistCounters();
        },
      }),
      h('span', { class: 'pl-idx' }, String(e.index)),
      h('div', { class: 'pl-thumb' }, img(e.thumbnail)),
      h('div', { class: 'pl-text' },
        h('div', { class: 'pl-name', title: e.title }, e.title),
        h('div', { class: 'pl-dur' }, e.unavailable ? t('unavailable') : fmtDuration(e.duration)))))));
  parts.push(list);

  if (d.truncated) parts.push(h('p', { class: 'hint' }, t('truncated', d.entries.length)));
  parts.push(h('button', { type: 'button', class: 'primary-btn wide', 'data-batch-btn': '', disabled: !n, onclick: startBatch },
    icon('save'), batchButtonLabel(n)));

  const scroll = $('.pl-list', previewEl)?.scrollTop || 0;
  previewEl.replaceChildren(...parts);
  list.scrollTop = scroll;
}

// Update only the counters while ticking boxes (keeps the list's scroll position)
function updatePlaylistCounters() {
  const d = preview.data;
  const n = preview.selected.size;
  const available = d.entries.filter((e) => !e.unavailable).length;
  const all = $('.pl-toolbar input', previewEl);
  all.checked = n === available && n > 0;
  all.indeterminate = n > 0 && n < available;
  $('.pl-toolbar span', previewEl).textContent = t('selected', n, d.entries.length);
  const btn = $('[data-batch-btn]', previewEl);
  btn.disabled = !n;
  btn.replaceChildren(icon('save'), batchButtonLabel(n));
}

function setScope(scope) {
  preview.scope = scope;
  renderPreview();
  renderOpts();
}

function schedulePreview(immediate = false) {
  clearTimeout(previewTimer);
  updateInputButtons();
  const url = extractUrl(input.value);
  if (!url) return resetPreview();
  if (preview?.url === url) return;
  previewTimer = setTimeout(() => loadPreview(url), immediate ? 0 : 450);
}

input.addEventListener('input', () => schedulePreview());
input.addEventListener('paste', () => setTimeout(() => schedulePreview(true), 0));

$('#clearBtn').addEventListener('click', () => {
  clearInput();
  input.focus();
});

$('#pasteBtn').addEventListener('click', async () => {
  try {
    const url = extractUrl(await navigator.clipboard.readText());
    if (!url) return toast(t('toast.noClipLink'));
    input.value = url;
    schedulePreview(true);
  } catch {
    toast(t('toast.clipFail'));
  }
});

const looksLikePlaylist = (url) => /[?&]list=|\/playlist\b/i.test(url);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = extractUrl(input.value);
  if (!url) {
    form.classList.remove('shake');
    void form.offsetWidth;
    form.classList.add('shake');
    toast(input.value.trim() ? t('toast.notLink') : t('toast.pasteFirst'));
    return;
  }

  // Playlist links need the preview first, so we know what to download
  if (looksLikePlaylist(url)) {
    if (preview?.url !== url) loadPreview(url);
    if (!preview.data && !preview.error) {
      toast(t('toast.loadingPlaylist'));
      await preview.promise;
    }
    if (preview?.url !== url) return;
    if (preview.error) return toast(errText(preview.error));
    if (preview.data?.type === 'playlist' && preview.scope === 'playlist') return startBatch();
  }
  const trim = readTrim(url);
  if (trim === undefined) return;
  const subs = readSubs(url);
  if (subs === undefined) return;
  startJob(url, { trim, subs });
});

// ---------- options ----------

function setMode(mode) {
  settings.mode = mode;
  saveSettings();
  for (const b of $$('.segmented button')) b.setAttribute('aria-selected', String(b.dataset.mode === mode));
  renderOpts();
  if (preview?.data?.type === 'playlist' && preview.scope === 'playlist') updatePlaylistCounters();
}

for (const b of $$('.segmented button')) b.addEventListener('click', () => setMode(b.dataset.mode));

function chip(label, pressed, onClick) {
  return h('button', { type: 'button', class: 'chip', 'aria-pressed': String(pressed), onclick: onClick }, label);
}

// ---------- trim (download only part of a video) ----------

const trimUI = { open: false };
const trimAllowed = () => !(preview?.data?.type === 'playlist' && preview.scope === 'playlist');

// "83", "1:23", "1:02:03", "1:23.5" -> seconds; '' -> null; anything else -> NaN
function parseClock(s) {
  s = String(s || '').trim().replace(',', '.');
  if (!s) return null;
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(s)) return NaN;
  return s.split(':').map(Number).reduce((acc, p) => acc * 60 + p, 0);
}

function fmtClock(sec) {
  return sec ? fmtDuration(sec) : '0:00';
}

const trimLabel = (trim) => trim && `✂ ${fmtClock(trim.start)}–${trim.end == null ? t('trim.endPh') : fmtClock(trim.end)}`;

function previewVideo(url) {
  if (preview?.url !== url) return null;
  return preview.data?.type === 'video' ? preview.data : preview.data?.video || null;
}

const trimFrom = $('#trimFrom');
const trimTo = $('#trimTo');
const trimStartEl = $('#trimStart');
const trimEndEl = $('#trimEnd');
const currentDuration = () => (preview?.url && previewVideo(preview.url)?.duration) || 0;

function trimChip() {
  return h('button', {
    type: 'button', class: 'chip with-icon', 'aria-pressed': String(trimUI.open), 'aria-controls': 'trimBox',
    onclick: () => {
      trimUI.open = !trimUI.open;
      if (trimUI.open) setupTrimRange();
      renderOpts();
    },
  }, icon('cut'), t('trim'));
}

// The slider runs from 0:00 to the video's length; the time boxes show (and can fine-tune) it
function setupTrimRange() {
  const duration = Math.floor(currentDuration());
  $('#trimRange').hidden = !duration;
  if (!duration) return;
  trimFrom.max = trimTo.max = String(duration);
  const start = parseClock(trimStartEl.value);
  const end = parseClock(trimEndEl.value);
  trimFrom.value = String(Number.isFinite(start) && start != null ? start : 0);
  trimTo.value = String(Number.isFinite(end) && end != null ? end : duration);
  syncTrimFromSlider();
}

function syncTrimFromSlider(moved) {
  let a = Number(trimFrom.value);
  let b = Number(trimTo.value);
  // keep at least one second between the handles
  if (a > b - 1) {
    if (moved === trimFrom) a = Math.max(0, b - 1);
    else b = Math.min(Number(trimTo.max), a + 1);
    trimFrom.value = String(a);
    trimTo.value = String(b);
  }
  trimStartEl.value = fmtClock(a);
  trimEndEl.value = fmtClock(b);
  trimStartEl.removeAttribute('aria-invalid');
  trimEndEl.removeAttribute('aria-invalid');
  paintTrimRange();
}

function paintTrimRange() {
  const max = Number(trimTo.max) || 1;
  const a = Number(trimFrom.value);
  const b = Number(trimTo.value);
  const fill = $('#trimRange .range-fill');
  fill.style.left = `${(a / max) * 100}%`;
  fill.style.width = `${((b - a) / max) * 100}%`;
  // the start handle goes on top when it's near the end, so it can still be dragged back
  trimFrom.style.zIndex = a > max / 2 ? '3' : '1';
  $('#trimLen').textContent = b > a ? `✂ ${fmtClock(b - a)}` : '';
  updateGoLabel();
}

for (const el of [trimFrom, trimTo]) el.addEventListener('input', () => syncTrimFromSlider(el));

// Typed times move the slider when they make sense
for (const el of [trimStartEl, trimEndEl]) {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') form.requestSubmit();
  });
  el.addEventListener('input', () => {
    el.removeAttribute('aria-invalid');
    const v = parseClock(el.value);
    if (Number.isFinite(v) && v != null && !$('#trimRange').hidden) {
      (el === trimStartEl ? trimFrom : trimTo).value = String(Math.min(v, Number(trimTo.max)));
      paintTrimRange();
    } else {
      updateGoLabel();
    }
  });
}

function renderTrim() {
  $('#trimBox').hidden = !(trimUI.open && trimAllowed());
  const duration = currentDuration();
  trimEndEl.placeholder = duration ? fmtClock(duration) : t('trim.endPh');
}

// Returns the trim to send: null for the whole video, undefined if the times are wrong.
// quiet: only work it out (for the download button's label), without messages.
function readTrim(url, quiet = false) {
  if (!trimUI.open || !trimAllowed()) return null;
  const start = parseClock(trimStartEl.value);
  let end = parseClock(trimEndEl.value);
  if (!quiet) {
    trimStartEl.removeAttribute('aria-invalid');
    trimEndEl.removeAttribute('aria-invalid');
  }
  const bad = (el, message) => {
    if (quiet) return undefined;
    el.setAttribute('aria-invalid', 'true');
    el.focus();
    toast(message);
    return undefined;
  };
  if (Number.isNaN(start)) return bad(trimStartEl, t('trim.invalid'));
  if (Number.isNaN(end)) return bad(trimEndEl, t('trim.invalid'));
  if (end != null && end <= (start || 0)) return bad(trimEndEl, t('trim.order'));
  const duration = previewVideo(url)?.duration;
  if (duration && (start || 0) >= duration) return bad(trimStartEl, t('trim.tooLong', fmtClock(duration)));
  if (duration && end != null && end > duration + 1) return bad(trimEndEl, t('trim.tooLong', fmtClock(duration)));
  if (duration && end != null && end >= Math.floor(duration)) end = null; // up to the end
  if (!start && end == null) return null;
  return { start: start || 0, end, precise: $('#trimPrecise').checked };
}

function resetTrim() {
  trimUI.open = false;
  trimStartEl.value = '';
  trimEndEl.value = '';
  $('#trimLen').textContent = '';
  $('#trimPrecise').checked = false;
  renderTrim();
}

// ---------- subtitles ----------

const subsUI = { open: false, shown: new Set() };

// Language names in the viewer's language: "Türkçe", "İngilizce (otomatik)"
function langName(code, fallback) {
  const base = code.replace(/-orig$/, '');
  let name = fallback || base;
  try {
    name = new Intl.DisplayNames([lang], { type: 'language' }).of(base) || name;
  } catch { /* keep the fallback */ }
  name = name.charAt(0).toLocaleUpperCase(lang) + name.slice(1);
  return /-orig$/.test(code) ? `${name} (${t('subs.autoShort')})` : name;
}

const baseOf = (code) => code.replace(/-orig$/, '').split('-')[0].toLowerCase();

// Languages offered to pick from when the video's own list isn't known (playlists)
const COMMON_LANGS = ['tr', 'en', 'de', 'fr', 'es', 'it', 'pt', 'ru', 'ar', 'ja', 'ko', 'zh', 'nl', 'pl', 'az', 'fa', 'hi', 'id', 'uk', 'el', 'sv'];

// The current single video's subtitles from the preview, or null (playlist or no preview yet)
function previewSubs() {
  if (!preview?.data || !trimAllowed()) return null;
  return previewVideo(preview.url)?.subs || null;
}

// The video's subtitle codes for the remembered languages, in the order they were picked.
// A remembered language matches any of its variants (en -> en-US).
function pickedCodes(list) {
  const codes = [];
  for (const pref of settings.subLangs) {
    const hit = list.find((s) => s.code === pref) || list.find((s) => baseOf(s.code) === baseOf(pref));
    if (hit && !codes.includes(hit.code)) codes.push(hit.code);
  }
  return codes;
}

// Rows to show: { code, name, checked }, picked languages first in their order
function subsRows() {
  const subs = previewSubs();
  if (subs) {
    const picked = pickedCodes(subs.list);
    for (const c of picked) subsUI.shown.add(c);
    const rank = (c) => (picked.includes(c) ? picked.indexOf(c) : picked.length);
    return subs.list.filter((s) => subsUI.shown.has(s.code))
      .sort((a, b) => rank(a.code) - rank(b.code))
      .map((s) => ({ code: s.code, name: langName(s.code, s.name), checked: picked.includes(s.code) }));
  }
  for (const c of settings.subLangs) subsUI.shown.add(c);
  return [...subsUI.shown].map((code) => ({ code, name: langName(code), checked: settings.subLangs.includes(code) }));
}

function toggleSubLang(code, on) {
  const others = settings.subLangs.filter((c) => c !== code && c !== baseOf(code) && baseOf(c) !== baseOf(code));
  settings.subLangs = on ? [...others, code] : others;
  saveSettings();
  updateGoLabel();
}

function subsChip() {
  return h('button', {
    type: 'button', class: 'chip with-icon', 'aria-pressed': String(subsUI.open), 'aria-controls': 'subsBox',
    onclick: () => {
      subsUI.open = !subsUI.open;
      renderOpts();
    },
  }, icon('cc'), t('subs'));
}

function renderSubs() {
  const box = $('#subsBox');
  box.hidden = !(subsUI.open && settings.mode === 'video');
  if (box.hidden) return;

  const subs = previewSubs();
  const parts = [];
  if (subs && !subs.list.length && !subs.auto) {
    parts.push(h('p', { class: 'hint' }, t('subs.noneHere')));
  } else {
    const rows = subsRows();
    const list = h('div', { class: 'subs-langs' }, rows.map((r) => h('label', { class: 'trim-precise' },
      h('input', {
        type: 'checkbox', class: 'check', checked: r.checked,
        onchange: (e) => { toggleSubLang(r.code, e.target.checked); },
      }),
      h('span', {}, r.name))));
    parts.push(list);

    // other languages go into a drop-down so long lists stay short
    const more = (subs ? subs.list.map((s) => s.code) : COMMON_LANGS).filter((c) => !rows.some((r) => r.code === c));
    if (more.length) {
      parts.push(h('select', {
        class: 'subs-add', 'aria-label': t('subs.add'),
        onchange: (e) => {
          const code = e.target.value;
          if (!code) return;
          subsUI.shown.add(code);
          toggleSubLang(code, true);
          renderSubs();
        },
      }, h('option', { value: '' }, '+ ' + t('subs.add')),
      more.map((c) => ({ c, name: langName(c, subs?.list.find((s) => s.code === c)?.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, lang))
        .map(({ c, name }) => h('option', { value: c }, name))));
    }

    // YouTube's automatic subtitle in the video's own language
    if (!subs || subs.auto) {
      parts.push(h('label', { class: 'trim-precise' },
        h('input', {
          type: 'checkbox', class: 'check', checked: settings.subAuto,
          onchange: (e) => { settings.subAuto = e.target.checked; saveSettings(); updateGoLabel(); },
        }),
        h('span', {}, subs?.auto ? t('subs.autoOne', langName(subs.auto.code.replace(/-orig$/, ''))) : t('subs.autoAny'))));
    }
  }

  parts.push(h('label', { class: 'trim-precise' },
    h('input', {
      type: 'checkbox', class: 'check', checked: settings.subSrt,
      onchange: (e) => { settings.subSrt = e.target.checked; saveSettings(); },
    }),
    h('span', {}, t('subs.srt'))));
  parts.push(h('p', { class: 'hint' }, t('subs.hint')));
  box.replaceChildren(...parts);
}

// What to send: null when off, undefined (after a message) when nothing usable is chosen.
// quiet: only work it out, without messages.
function readSubs(url, quiet = false) {
  if (!subsUI.open || settings.mode !== 'video') return null;
  const say = (key) => {
    if (!quiet) toast(t(key));
    return undefined;
  };
  const subs = url ? previewVideo(url)?.subs : previewSubs();
  let langs = settings.subLangs;
  let auto = settings.subAuto;
  if (subs) {
    langs = pickedCodes(subs.list);
    auto = auto && !!subs.auto;
    if (!subs.list.length && !subs.auto) return say('subs.noneHere');
  }
  if (!langs.length && !auto) return say('subs.pickOne');
  return { langs, auto, srt: settings.subSrt };
}

function resetSubs() {
  subsUI.open = false;
  subsUI.shown.clear();
  renderSubs();
}

// "Altyazı: TR, EN (oto)" on a finished download
function subsLabel(s) {
  if (!s) return '';
  if (s.failed) return t('subs.failed');
  if (!s.langs?.length) return t('subs.missing');
  const short = (c) => c.replace(/-orig$/, '').toUpperCase() + (/-orig$/.test(c) ? ` (${t('subs.autoShort')})` : '');
  return `${t('subs')}: ${s.langs.map(short).join(', ')}`;
}

const AUDIO_CHOICES = () => [['mp3', 'MP3'], ['m4a', 'M4A'], ['opus', 'OPUS'], ['wav', 'WAV'], ['best', t('fmt.original')]];

// Quality choices for the video in the card, plus which one is selected
function qualityChoices() {
  const d = preview?.data;
  const v = d?.type === 'video' ? d : d?.video && preview.scope === 'video' ? d.video : null;
  const heights = v?.heights || [];
  const fps = v?.fps || {};
  let list = ['max', '2160', '1440', '1080', '720', '480', '360'];
  if (heights.length) list = ['max', ...new Set(heights.filter((x) => x >= 240).map(String))].slice(0, 7);
  const selected = list.includes(String(settings.quality)) ? String(settings.quality) : 'max';
  return { list, selected, fps, best: heights[0] };
}

function renderOpts() {
  const box = $('#opts');
  const hint = $('#optsHint');
  hint.hidden = true;
  renderTrim();
  renderSubs();
  // trimming and subtitles are per video, so they're left out for whole playlists
  const extras = [];
  if (trimAllowed()) extras.push(trimChip());
  if (settings.mode === 'video') extras.push(subsChip());
  $('#extras').replaceChildren(...extras);
  $('#cardGo').hidden = !trimAllowed();

  if (settings.mode === 'audio') {
    $('#optsLabel').textContent = t('opts.format');
    box.replaceChildren(...AUDIO_CHOICES().map(([v, label]) => chip(label, settings.audioFormat === v, () => {
      settings.audioFormat = v;
      saveSettings();
      renderOpts();
      if (preview?.data?.type === 'playlist' && preview.scope === 'playlist') updatePlaylistCounters();
    })));
    updateGoLabel();
    return;
  }

  $('#optsLabel').textContent = t('opts.quality');
  const { list, selected, fps } = qualityChoices();
  box.replaceChildren(...list.map((v) => chip(qualityLabel(v, fps[v]), v === selected, () => {
    settings.quality = v;
    saveSettings();
    renderOpts();
  })));

  if (settings.codec === 'h264' && selected === 'max') {
    hint.hidden = false;
    const [before, after] = t('hint.auto').split('{settings}');
    hint.replaceChildren(before, h('button', { type: 'button', onclick: openSettings }, t('settings')), after || '');
  }
  updateGoLabel();
}

// The card's download button sums up what will be downloaded: "İndir · 1080p60 · ✂ 0:15 · TR"
function updateGoLabel() {
  const btn = $('#cardGo');
  if (btn.hidden || !preview?.url) return;
  const parts = [t('download')];
  if (settings.mode === 'audio') {
    parts.push(AUDIO_CHOICES().find(([v]) => v === settings.audioFormat)?.[1]);
  } else {
    const { selected, fps, best } = qualityChoices();
    // "Best" shows what it will most likely be, e.g. 4K60
    const q = selected === 'max' && settings.codec !== 'h264' && best ? String(best) : selected;
    parts.push(qualityLabel(q, fps[q]));
  }
  const trim = readTrim(preview.url, true);
  if (trim) parts.push(`✂ ${fmtClock((trim.end ?? currentDuration()) - trim.start)}`);
  if (subsUI.open && settings.mode === 'video') {
    const s = readSubs(preview.url, true);
    if (s) parts.push([...s.langs.map((c) => baseOf(c).toUpperCase()), s.auto ? t('subs.autoShort') : ''].filter(Boolean).join(', '));
  }
  btn.replaceChildren(icon('save'), parts.filter(Boolean).join(' · '));
}

$('#cardGo').addEventListener('click', () => form.requestSubmit());

const currentOptions = () => ({
  mode: settings.mode,
  quality: settings.quality,
  codec: settings.codec,
  audioFormat: settings.audioFormat,
});

function clearInput() {
  input.value = '';
  resetTrim();
  resetSubs();
  resetPreview();
  updateInputButtons();
}

// ---------- single downloads ----------

const tasks = new Map(); // id -> task (single job or playlist batch)

function persistTasks() {
  store.set('tasks', [...tasks.values()].map((t) => ({ kind: t.kind, id: t.data.id, meta: t.meta, saved: t.saved })));
}

// extra.trim: { start, end, precise } to download only part of the video
// extra.subs: { langs, auto, srt } to add subtitles
async function startJob(url, extra = {}) {
  const v = previewVideo(url);
  const meta = { url, mode: settings.mode, title: v?.title || null, thumbnail: v?.thumbnail || null, subs: extra.subs || null };
  const goBtn = $('#goBtn');
  goBtn.disabled = true;
  try {
    const body = { url, title: meta.title, ...currentOptions(), trim: extra.trim || null, subs: extra.subs || null };
    const job = await api('/api/jobs', { method: 'POST', body });
    addTask('job', job, meta, false);
    clearInput();
  } catch (e) {
    toast(errText(e));
  } finally {
    goBtn.disabled = false;
  }
}

async function startBatch() {
  const d = preview?.data;
  if (!d || d.type !== 'playlist') return;
  const entries = d.entries.filter((e) => preview.selected.has(e.index) && !e.unavailable)
    .map((e) => ({ index: e.index, url: e.url, title: e.title }));
  if (!entries.length) return toast(t('toast.selectOne'));
  const subs = readSubs(null);
  if (subs === undefined) return;
  const meta = { url: preview.url, mode: settings.mode, title: d.title, thumbnail: d.thumbnail };
  try {
    const batch = await api('/api/batches', { method: 'POST', body: { url: preview.url, title: d.title, entries, ...currentOptions(), subs } });
    addTask('batch', batch, meta, false);
    clearInput();
  } catch (e) {
    toast(errText(e));
  }
}

function addTask(kind, data, meta, saved, append = false) {
  const task = { kind, data, meta, saved, el: h('article', { class: 'card job' }), es: null, expanded: false };
  tasks.set(data.id, task);
  if (append) $('#jobs').append(task.el);
  else $('#jobs').prepend(task.el);
  render(task);
  persistTasks();
  if (!taskFinished(task)) connect(task);
}

const taskFinished = (t) => (t.kind === 'batch' ? t.data.finished : isFinal(t.data.status));
const taskPath = (t) => `/api/${t.kind === 'batch' ? 'batches' : 'jobs'}/${t.data.id}`;

function connect(task) {
  const es = new EventSource(taskPath(task) + '/events');
  task.es = es;
  es.onmessage = (e) => update(task, JSON.parse(e.data));
  es.onerror = async () => {
    if (taskFinished(task)) return es.close();
    // connection dropped (e.g. phone screen locked), check if the task still exists
    try {
      update(task, await api(taskPath(task)));
    } catch (err) {
      if (err.status === 404) {
        es.close();
        removeTask(task);
      }
    }
  };
}

function update(task, data) {
  const wasFinished = taskFinished(task);
  task.data = data;
  render(task);
  if (!taskFinished(task) || wasFinished) return;
  task.es?.close();

  // the server records finished downloads in the shared history
  if (task.kind === 'batch') {
    loadHistory();
    toast(data.failed ? t('toast.playlistReadyFailed', data.failed) : t('toast.playlistReady'));
  } else if (data.status === 'done') {
    loadHistory();
    if (settings.autoSave && !task.saved) saveTask(task);
  } else if (data.status === 'error') {
    toast(errText(data.error, 'err.failed'));
  }
}

function saveTask(task) {
  task.saved = true;
  persistTasks();
  download(`/api/jobs/${task.data.id}/file`);
  saveSrt(task.data);
}

// .srt files asked for next to the video; spaced out so the browser accepts them all
async function saveSrt(d) {
  for (const s of d.subs?.srt || []) {
    await new Promise((r) => setTimeout(r, 800));
    download(`/api/jobs/${d.id}/subs/${s.i}`);
  }
}

function removeTask(task) {
  task.es?.close();
  task.el.remove();
  tasks.delete(task.data.id);
  persistTasks();
}

async function cancelTask(task) {
  try {
    await api(taskPath(task), { method: 'DELETE' });
  } catch { /* already gone */ }
  removeTask(task);
}

function render(task) {
  if (task.kind === 'batch') renderBatch(task);
  else renderJob(task);
}

function jobStatusText(d) {
  if (d.status === 'queued') return t('st.queued');
  if (d.status === 'done' && isLowQuality(d)) {
    return t('warn.lowQuality', qualityLabel(String(d.media.height), d.media.fps), qualityLabel(String(d.expected)));
  }
  if (d.status === 'done') return [t('st.ready'), trimLabel(d.trim), mediaLabel(d.media), subsLabel(d.subs), fmtBytes(d.size)].filter(Boolean).join(' · ');
  if (d.status === 'error') return errText(d.error, 'st.failed');
  if (d.status === 'canceled') return t('st.canceled');
  const p = d.progress || {};
  const parts = [phaseText(d.phase), trimLabel(d.trim)];
  if (d.status === 'running' && p.downloaded != null) {
    parts.push(p.total ? `${fmtBytes(p.downloaded)} / ${fmtBytes(p.total)}` : fmtBytes(p.downloaded));
    if (p.speed) parts.push(fmtBytes(p.speed) + '/s');
    if (p.eta) parts.push(fmtEta(p.eta));
  }
  return parts.filter(Boolean).join(' · ') + (d.status === 'processing' ? '…' : '');
}

function taskThumb(meta, fallback) {
  return h('div', { class: 'thumb' }, icon(fallback), img(meta.thumbnail));
}

function closeButton(task) {
  const final = taskFinished(task);
  return h('button', {
    type: 'button', class: 'icon-btn ghost',
    'aria-label': final ? t('remove') : t('cancel'), title: final ? t('remove') : t('cancel'),
    // finished batches are deleted on the server too, to free the disk space right away
    onclick: () => (final && task.kind !== 'batch' ? removeTask(task) : cancelTask(task)),
  }, icon('close'));
}

function renderJob(task) {
  const { data: d, meta } = task;
  const title = d.title || meta.title || meta.url;
  const percent = d.progress?.percent;
  const indeterminate = d.status === 'processing' || d.status === 'queued' || (d.status === 'running' && percent == null);

  const actions = h('div', { class: 'job-actions' });
  if (d.status === 'done') {
    actions.append(h('a', {
      class: 'primary-btn', href: `/api/jobs/${d.id}/file`, download: '',
      onclick: () => { task.saved = true; persistTasks(); },
    }, icon('save'), t('save')));
    if (d.subs?.srt?.length) {
      actions.append(h('button', { type: 'button', class: 'secondary-btn', title: t('subs.saveSrt'), onclick: () => saveSrt(d) }, 'SRT'));
    }
  }
  if (d.status === 'error' || (d.status === 'done' && isLowQuality(d))) {
    actions.append(h('button', { type: 'button', class: 'secondary-btn', onclick: () => { removeTask(task); setMode(meta.mode); startJob(meta.url, { trim: d.trim, subs: meta.subs }); } }, t('retry')));
  }
  actions.append(closeButton(task));

  task.el.className = `card job ${d.status}${d.status === 'done' && isLowQuality(d) ? ' warn' : ''}`;
  task.el.replaceChildren(h('div', { class: 'job-row' },
    taskThumb(meta, meta.mode === 'audio' ? 'audio' : 'video'),
    h('div', {},
      h('div', { class: 'job-title', title }, title),
      h('div', { class: 'job-status', title: d.error?.detail || '' }, jobStatusText(d)),
      h('div', { class: 'bar' + (indeterminate ? ' indeterminate' : '') },
        h('span', { style: `width:${d.status === 'done' ? 100 : percent || 0}%` }))),
    actions));
}

function batchStatusText(d) {
  if (d.finished) {
    if (!d.done) return d.canceled === d.total ? t('st.canceled') : t('st.allFailed');
    return [t('files', d.done), fmtBytes(d.size), d.failed && t('nFailed', d.failed)].filter(Boolean).join(' · ');
  }
  const active = d.items.filter((i) => i.status === 'running' || i.status === 'processing').length;
  return [t('b.progress', d.done, d.total), active && t('b.active', active), d.failed && t('nFailed', d.failed)].filter(Boolean).join(' · ');
}

function itemState(i) {
  if (i.status === 'done') return h('span', { class: 'it-state ok' }, fmtBytes(i.size) || t('st.ready'));
  if (i.status === 'error') return h('span', { class: 'it-state bad', title: i.error ? errText({ code: i.errorCode, message: i.error }) : '' }, t('st.failed'));
  if (i.status === 'canceled') return h('span', { class: 'it-state' }, t('st.canceled'));
  if (i.status === 'queued') return h('span', { class: 'it-state' }, t('st.queuedShort'));
  return h('span', { class: 'it-state' }, i.percent != null && i.status === 'running' ? `${Math.floor(i.percent)}%` : '…');
}

async function saveAll(task) {
  const done = task.data.items.filter((i) => i.status === 'done');
  toast(t('toast.saving', done.length));
  for (const i of done) {
    download(`/api/jobs/${i.id}/file`);
    await new Promise((r) => setTimeout(r, 800));
  }
}

function renderBatch(task) {
  const { data: d, meta } = task;
  const status = d.finished ? (d.done ? 'done' : 'error') : 'running';

  const actions = h('div', { class: 'batch-actions' });
  if (d.finished && d.done) {
    actions.append(
      h('a', { class: 'primary-btn', href: `/api/batches/${d.id}/zip`, download: '' }, icon('zip'), t('zip')),
      h('button', { type: 'button', class: 'secondary-btn', onclick: () => saveAll(task) }, icon('save'), t('saveAll')));
  }

  const scroll = $('.items', task.el)?.scrollTop || 0;
  const list = task.expanded ? h('ul', { class: 'items' }, d.items.map((i) => h('li', {},
    h('div', { style: 'min-width:0' },
      h('div', { class: 'it-name', title: i.title || '' }, i.title || t('item')),
      itemState(i)),
    i.status === 'done' ? h('a', { class: 'it-save', href: `/api/jobs/${i.id}/file`, download: '', title: t('save'), 'aria-label': t('save') }, icon('save')) : null))) : null;

  task.el.className = `card job batch ${status}`;
  task.el.replaceChildren(
    h('div', { class: 'job-row' },
      taskThumb(meta, 'list'),
      h('div', {},
        h('div', { class: 'job-title', title: d.title }, d.title),
        h('div', { class: 'job-status' }, batchStatusText(d)),
        h('div', { class: 'bar' }, h('span', { style: `width:${d.percent}%` }))),
      h('div', { class: 'job-actions' }, closeButton(task))),
    actions,
    h('button', {
      type: 'button', class: 'toggle-btn', 'aria-expanded': String(task.expanded),
      onclick: () => { task.expanded = !task.expanded; render(task); },
    }, task.expanded ? t('items.hide') : t('items.show', d.total), icon('chevron')),
    list);
  if (list) list.scrollTop = scroll;
}

async function restoreTasks() {
  const saved = store.get('tasks', []);
  const results = await Promise.allSettled(saved.map((item) => api(`/api/${item.kind === 'batch' ? 'batches' : 'jobs'}/${item.id}`)));
  results.forEach((r, i) => {
    // rejected ones have expired on the server
    if (r.status === 'fulfilled') addTask(saved[i].kind, r.value, saved[i].meta, saved[i].saved, true);
  });
  persistTasks();
}

// ---------- history ----------

const locale = () => (lang === 'en' ? 'en-GB' : lang);
const makeDateFormat = () => new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
let fmtDate = makeDateFormat();
// for the history table: "28 Oct 2026" and "14:03"
const fmtDay = (d) => new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
const fmtTime = (d) => new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' }).format(d);

// The history lives on the PC and is shared by all devices: only titles and links, no files.
// The home page shows the latest few; the full list is a table in its own window.
const HISTORY_RECENT = 5;
let historyList = [];

async function loadHistory() {
  try {
    historyList = await api('/api/history');
    renderHistory();
    renderHistoryTable();
  } catch { /* server may be down */ }
}

// Copies text, also on phones where the clipboard API isn't allowed (plain http on the home network).
// "within" is where a helper text box may go: inside an open dialog, the rest of the page can't be used.
async function copyText(text, within = document.body) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall back below */ }
  const box = h('textarea', { readonly: true, style: 'position:fixed;top:0;left:0;opacity:0;pointer-events:none' });
  box.value = text;
  within.append(box);
  box.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch { /* not supported */ }
  box.remove();
  return ok;
}

// "Video · 1080p60 · VP9", "Audio · MP3", "Playlist · 12 files"
function historyQuality(item) {
  if (item.kind === 'playlist') return [t('kind.playlist'), t('files', item.count || 0)].join(' · ');
  if (item.mode === 'audio') return [t('kind.audio'), item.ext?.toUpperCase()].filter(Boolean).join(' · ');
  return [t('kind.video'), mediaLabel(item.media) || item.ext?.toUpperCase()].filter(Boolean).join(' · ');
}

function renderHistoryTable() {
  const dlg = $('#historyDlg');
  if (!dlg.open) return;
  const q = $('#histSearch').value.trim().toLocaleLowerCase(locale());
  const rows = q
    ? historyList.filter((i) => [i.title, i.site, i.url].some((v) => v && v.toLocaleLowerCase(locale()).includes(q)))
    : historyList;
  $('#histCount').textContent = t('history.count', rows.length, historyList.length);
  $('#histClear').hidden = !historyList.length;
  const empty = $('#histEmpty');
  empty.hidden = rows.length > 0;
  empty.textContent = historyList.length ? t('history.noMatch') : t('history.empty');

  $('#histRows').replaceChildren(...rows.map((item) => {
    const title = item.title || item.url || t('untitled');
    const extras = [item.site, trimLabel(item.trim), item.subs && subsLabel({ langs: item.subs })].filter(Boolean).join(' · ');
    const copy = h('button', {
      type: 'button', class: 'hist-btn', title: item.url, disabled: !item.url,
      onclick: async () => {
        const ok = await copyText(item.url, dlg);
        copy.replaceChildren(icon(ok ? 'check' : 'copy'), ok ? t('copied') : t('copyFailed'));
        setTimeout(() => copy.replaceChildren(icon('copy'), t('copyLink')), 1600);
      },
    }, icon('copy'), t('copyLink'));
    return h('tr', {},
      h('td', { class: 'hist-date' }, h('div', {}, fmtDay(item.date)), h('small', {}, fmtTime(item.date))),
      h('td', { class: 'hist-item' },
        h('div', { class: 'hist-title' },
          icon(item.kind === 'playlist' ? 'list' : item.mode === 'audio' ? 'audio' : 'video'),
          h('span', { title }, title)),
        extras && h('small', {}, extras)),
      h('td', { class: 'hist-quality' }, historyQuality(item)),
      h('td', { class: 'hist-size' }, fmtBytes(item.size) || '—'),
      h('td', { class: 'hist-device' }, item.device ? t('device.' + item.device) : '—'),
      h('td', { class: 'hist-actions' },
        copy,
        item.url && h('button', {
          type: 'button', class: 'hist-btn',
          onclick: () => { dlg.close(); historyAgain(item); },
        }, t('again')),
        h('button', {
          type: 'button', class: 'icon-btn ghost h-remove', title: t('remove'), 'aria-label': t('remove'),
          onclick: () => removeHistory(item),
        }, icon('close'))));
  }));
}

function openHistory() {
  $('#histSearch').value = '';
  $('#historyDlg').showModal();
  renderHistoryTable();
  loadHistory();
}

$('#historyBtn').addEventListener('click', openHistory);
$('#historyClose').addEventListener('click', () => $('#historyDlg').close());
$('#histSearch').addEventListener('input', renderHistoryTable);
$('#histClear').addEventListener('click', () => clearHistory());

function historyAgain(item) {
  setMode(item.mode);
  if (item.kind === 'playlist') {
    input.value = item.url;
    updateInputButtons();
    loadPreview(item.url);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else {
    const subs = item.subs?.length
      ? { langs: item.subs.filter((c) => !/-orig$/.test(c)), auto: item.subs.some((c) => /-orig$/.test(c)), srt: settings.subSrt }
      : null;
    startJob(item.url, { trim: item.trim, subs });
  }
}

async function removeHistory(item) {
  historyList = historyList.filter((e) => e.id !== item.id);
  renderHistory();
  renderHistoryTable();
  try {
    await api(`/api/history/${item.id}`, { method: 'DELETE' });
  } catch { loadHistory(); }
}

function renderHistory() {
  $('#historySec').hidden = historyList.length === 0;
  const items = historyList.slice(0, HISTORY_RECENT).map((item) => {
    const isList = item.kind === 'playlist';
    const meta = [
      fmtDate.format(item.date),
      item.device && t('device.' + item.device),
      trimLabel(item.trim),
      item.subs && subsLabel({ langs: item.subs }),
      item.site,
      isList ? t('files', item.count || 0) : mediaLabel(item.media) || item.ext?.toUpperCase(),
      fmtBytes(item.size),
    ];
    const title = item.title || item.url || t('untitled');
    return h('li', {},
      h('div', { class: 'h-icon' }, icon(isList ? 'list' : item.mode === 'audio' ? 'audio' : 'video')),
      h('div', { style: 'min-width:0' },
        item.url
          ? h('a', { class: 'h-title', href: item.url, target: '_blank', rel: 'noopener noreferrer', title }, title)
          : h('div', { class: 'h-title', title }, title),
        h('div', { class: 'h-meta' }, meta.filter(Boolean).join(' · '))),
      h('div', { class: 'h-actions' },
        item.url && h('button', { type: 'button', class: 'h-again', onclick: () => historyAgain(item) }, t('again')),
        h('button', {
          type: 'button', class: 'icon-btn ghost h-remove', title: t('remove'), 'aria-label': t('remove'),
          onclick: () => removeHistory(item),
        }, icon('close'))));
  });
  items.push(h('li', { class: 'h-more' }, h('button', {
    type: 'button', class: 'link-btn', onclick: openHistory,
  }, t('history.all', historyList.length))));
  $('#history').replaceChildren(...items);
}

async function clearHistory() {
  if (!confirm(t('history.confirmClear'))) return;
  historyList = [];
  renderHistory();
  renderHistoryTable();
  try {
    await api('/api/history', { method: 'DELETE' });
  } catch { loadHistory(); }
}

$('#clearHistory').addEventListener('click', clearHistory);

// pick up downloads made on other devices when coming back to the tab
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadHistory();
});

// history used to be kept per browser; it now lives on the PC
try { localStorage.removeItem('ardite.history'); } catch { /* ignore */ }

// ---------- settings ----------

const settingsDlg = $('#settingsDlg');

function openSettings() {
  for (const r of $$('input[name="codec"]', settingsDlg)) r.checked = r.value === settings.codec;
  $('input[name="autoSave"]', settingsDlg).checked = settings.autoSave;
  applyTheme();
  markLang();
  settingsDlg.showModal();
}

$('#settingsBtn').addEventListener('click', openSettings);

settingsDlg.addEventListener('change', (e) => {
  if (e.target.name === 'codec') { settings.codec = e.target.value; settings.codecChosen = true; }
  if (e.target.name === 'autoSave') settings.autoSave = e.target.checked;
  saveSettings();
  renderOpts();
});

for (const b of $$('[data-theme-val]')) {
  b.addEventListener('click', () => {
    settings.theme = b.dataset.themeVal;
    saveSettings();
    applyTheme();
  });
}

function markLang() {
  for (const b of $$('[data-lang-val]')) b.setAttribute('aria-pressed', String(b.dataset.langVal === settings.lang));
}

// Re-renders everything in the new language without reloading the page
function applyLang() {
  setLang(settings.lang);
  fmtDate = makeDateFormat();
  applyI18n();
  markLang();
  renderOpts();
  renderPreview();
  for (const task of tasks.values()) render(task);
  renderHistory();
  renderHistoryTable();
  renderFoot();
  renderUpdate();
}

for (const b of $$('[data-lang-val]')) {
  b.addEventListener('click', () => {
    settings.lang = b.dataset.langVal;
    saveSettings();
    applyLang();
  });
}

// close dialogs when clicking the backdrop
for (const dlg of $$('dialog')) {
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
}

// ---------- phone connection ----------

const isLocalHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
// isTouch is defined at the top (it also picks the default video format)

function renderQr(url) {
  for (const el of $$('[data-lan]')) el.textContent = url;
  if (typeof window.qrcode !== 'function') return;
  const qr = window.qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  for (const el of $$('[data-qr]')) el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

let serverStatus = null;

// "Running on your home PC · v1.4.0 · yt-dlp 2026.10.26", the version linking to its release notes
function renderFoot() {
  const s = serverStatus;
  if (!s) return;
  const repo = s.repo || $('#githubLink').href;
  const released = /^\d+\.\d+\.\d+$/.test(s.version || '');
  const version = s.version && h('a', {
    href: released ? `${repo}/releases/tag/v${s.version}` : repo,
    target: '_blank', rel: 'noopener noreferrer', title: released ? t('foot.release', s.version) : null,
  }, released ? `v${s.version}` : 'dev');
  const parts = [t('foot'), version, `yt-dlp ${s.ytdlp || '?'}`].filter(Boolean);
  $('#footInfo').replaceChildren(...parts.flatMap((p, i) => (i ? [' · ', p] : [p])));
}

// "New version available" bar; closing it hides it until the next version comes out
// While an update runs: { version, from, text, error?, done? }
let updating = null;

function renderUpdate() {
  const bar = $('#updateBar');
  if (updating) {
    bar.hidden = false;
    bar.classList.toggle('busy', !updating.error && !updating.done);
    bar.replaceChildren(...[
      h('span', {}, updating.text),
      updating.error && h('button', { type: 'button', class: 'link-btn update-go', onclick: installUpdate }, t('update.retry')),
      updating.error && h('button', {
        type: 'button', class: 'icon-btn ghost', title: t('close'), 'aria-label': t('close'),
        onclick: () => { updating = null; renderUpdate(); },
      }, icon('close'))].filter(Boolean));
    return;
  }
  bar.classList.remove('busy');
  const u = serverStatus?.update;
  if (!u || store.get('dismissedUpdate') === u.version) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.replaceChildren(
    h('span', {}, t('update.text', u.version)),
    u.canInstall ? h('button', { type: 'button', class: 'primary-btn update-go', onclick: installUpdate }, t('update.install')) : '',
    h('a', { href: u.url, target: '_blank', rel: 'noopener noreferrer' }, u.canInstall ? t('update.whatsNew') : t('update.link')),
    h('button', {
      type: 'button', class: 'icon-btn ghost', title: t('close'), 'aria-label': t('close'),
      onclick: () => { store.set('dismissedUpdate', u.version); renderUpdate(); },
    }, icon('close')));
}

// One-click update: the server downloads and checks the package, then restarts itself with
// the new version. This page follows along and reloads once the new version answers.
async function installUpdate() {
  const u = serverStatus?.update;
  if (!u || !confirm(t('update.confirm', u.version))) return;
  const from = serverStatus.version;
  updating = { version: u.version, from, text: t('update.downloading', 0) };
  renderUpdate();
  try {
    await api('/api/update', { method: 'POST' });
  } catch (e) {
    updating = { ...updating, error: true, text: errText(e, 'err.updateFailed') };
    return renderUpdate();
  }

  const started = Date.now();
  let serverWentAway = false;
  const step = async () => {
    if (!updating || updating.error) return;
    if (!serverWentAway) {
      try {
        const s = await api('/api/update');
        if (s.state === 'downloading') updating.text = t('update.downloading', s.percent ?? 0);
        else if (s.state === 'installing') updating.text = t('update.installing');
        else if (s.state === 'restarting') updating.text = t('update.restarting');
        else if (s.state === 'error') {
          updating = { ...updating, error: true, text: errText({ code: s.code }, 'err.updateFailed') };
          return renderUpdate();
        }
      } catch {
        // the old server has stopped; from now on wait for Ardite to answer again
        serverWentAway = true;
        updating.text = t('update.restarting');
      }
    } else {
      try {
        const s = await api('/api/status');
        if (s.version === updating.version) {
          updating = { ...updating, done: true, text: t('update.done', updating.version) };
          renderUpdate();
          setTimeout(() => location.reload(), 1500);
          return;
        }
        // the old version came back: the updater put the backup back
        if (s.version === updating.from && Date.now() - started > 15000) {
          updating = { ...updating, error: true, text: t('update.rolledBack') };
          return renderUpdate();
        }
      } catch { /* still restarting */ }
    }
    if (Date.now() - started > 4 * 60 * 1000) {
      updating = { ...updating, error: true, text: t('update.slow') };
      return renderUpdate();
    }
    renderUpdate();
    setTimeout(step, 1000);
  };
  step();
}

async function loadStatus() {
  try {
    const s = await api('/api/status');
    serverStatus = s;
    if (s.repo) $('#githubLink').href = s.repo;
    const lan = s.lan?.[0];
    renderFoot();
    renderUpdate();
    $('#aboutLine').textContent = `Ardite ${s.version ? 'v' + s.version : ''} · yt-dlp ${s.ytdlp || '?'}${lan ? ' · ' + lan : ''}`;
    if (lan) {
      renderQr(lan);
      $('#phoneBtn').hidden = isTouch;
      if (isLocalHost && !isTouch) {
        $('.layout').classList.add('with-aside');
        $('#phoneCard').hidden = false;
      }
    }
  } catch { /* server may be down */ }
}

$('#phoneBtn').addEventListener('click', () => $('#phoneDlg').showModal());

// ---------- startup ----------

applyI18n();
applyTheme();
setMode(settings.mode === 'audio' ? 'audio' : 'video');
updateInputButtons();
loadHistory();
restoreTasks();
loadStatus();

// Links shared from another app or shortcut: /?url=... starts right away
{
  const params = new URLSearchParams(location.search);
  const shared = extractUrl(params.get('url') || params.get('u') || params.get('text') || '');
  if (shared) {
    const mode = params.get('mode');
    if (mode === 'audio' || mode === 'video') setMode(mode);
    history.replaceState(null, '', '/');
    input.value = shared;
    updateInputButtons();
    if (looksLikePlaylist(shared)) loadPreview(shared);
    else startJob(shared);
  } else if (!isTouch) {
    input.focus();
  }
}
