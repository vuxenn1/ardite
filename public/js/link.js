// Ardite web UI, part 2: the link box, the preview card and the download options
// (quality, trim, subtitles).

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
// Cancels the preview request still in progress; the server then stops working on it
let previewAbort = null;
const stopPreviewRequest = () => previewAbort?.abort();

function updateInputButtons() {
  const has = input.value.trim().length > 0;
  $('#clearBtn').hidden = !has;
  $('#pasteBtn').hidden = has || !navigator.clipboard?.readText;
}

function resetPreview() {
  clearTimeout(previewTimer);
  stopPreviewRequest();
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
  stopPreviewRequest();
  previewAbort = new AbortController();
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
  current.promise = api('/api/info', { method: 'POST', body: { url }, signal: previewAbort.signal })
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
  // a GIF needs a short part (they get big fast)
  if (settings.mode === 'gif' && !(trim && trim.end != null && trim.end - trim.start <= GIF_MAX_SECONDS)) {
    trimEndEl.setAttribute('aria-invalid', 'true');
    trimEndEl.focus();
    return toast(t('gif.tooLong', GIF_MAX_SECONDS));
  }
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

// GIFs: always made from a short part (the server allows up to 30 s), in one of three sizes
const GIF_MAX_SECONDS = 30;
const GIF_START_SECONDS = 5; // the part picked at first
const GIF_SIZES = () => [[320, t('gif.small')], [480, t('gif.medium')], [640, t('gif.large')]];
const trimShown = () => (trimUI.open || settings.mode === 'gif') && trimAllowed();

// In GIF mode the trim box is always open and starts with the first few seconds
function prepareGifTrim() {
  const duration = Math.floor(currentDuration());
  if (!duration) return;
  if (!trimStartEl.value && !trimEndEl.value) {
    trimStartEl.value = fmtClock(0);
    trimEndEl.value = fmtClock(Math.min(GIF_START_SECONDS, duration));
  }
  setupTrimRange();
}

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
  $('#trimBox').hidden = !trimShown();
  // a GIF is always cut exactly, so the choice (and its explanation) isn't offered there;
  // the GIF hint above says what to do
  $('.trim-precise').hidden = settings.mode === 'gif';
  $('#trimHint').hidden = settings.mode === 'gif';
  const duration = currentDuration();
  trimEndEl.placeholder = duration ? fmtClock(duration) : t('trim.endPh');
}

// Returns the trim to send: null for the whole video, undefined if the times are wrong.
// quiet: only work it out (for the download button's label), without messages.
function readTrim(url, quiet = false) {
  if (!trimShown()) return null;
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
  // up to the end (a GIF keeps its end: the server checks the part's length)
  if (settings.mode !== 'gif' && duration && end != null && end >= Math.floor(duration)) end = null;
  if (!start && end == null) return null;
  return { start: start || 0, end, precise: settings.mode === 'gif' || $('#trimPrecise').checked };
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
  // a GIF is made from a part of one video, so not offered for whole playlists
  $('.segmented [data-mode="gif"]').disabled = !trimAllowed();
  if (settings.mode === 'gif' && !trimAllowed()) return setMode('video');
  if (settings.mode === 'gif') prepareGifTrim();
  renderTrim();
  renderSubs();
  // trimming and subtitles are per video, so they're left out for whole playlists; a GIF's
  // trim box is always open, so it needs no button
  const extras = [];
  if (trimAllowed() && settings.mode !== 'gif') extras.push(trimChip());
  if (settings.mode === 'video') extras.push(subsChip());
  $('#extras').replaceChildren(...extras);
  $('#cardGo').hidden = !trimAllowed();

  if (settings.mode === 'gif') {
    $('#optsLabel').textContent = t('opts.size');
    box.replaceChildren(...GIF_SIZES().map(([w, label]) => chip(label, settings.gifWidth === w, () => {
      settings.gifWidth = w;
      saveSettings();
      renderOpts();
    })));
    hint.hidden = false;
    hint.replaceChildren(t('gif.hint', GIF_MAX_SECONDS));
    updateGoLabel();
    return;
  }

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
  if (settings.mode === 'gif') {
    parts[0] = t('gif.make');
    parts.push(GIF_SIZES().find(([w]) => w === settings.gifWidth)?.[1]);
  } else if (settings.mode === 'audio') {
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
  gifWidth: settings.gifWidth,
});

function clearInput() {
  input.value = '';
  resetTrim();
  resetSubs();
  resetPreview();
  updateInputButtons();
}
