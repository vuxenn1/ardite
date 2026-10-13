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

const settings = {
  mode: 'video',
  quality: 'max',
  codec: 'h264',
  audioFormat: 'mp3',
  autoSave: true,
  theme: 'auto',
  ...store.get('settings', {}),
};
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
  if (sec < 60) return `${Math.max(1, Math.round(sec))}s left`;
  return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s left`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function qualityLabel(q) {
  if (q === 'max') return settings.codec === 'h264' ? 'Auto' : 'Best';
  const n = Number(q);
  if (n >= 4320) return '8K';
  if (n >= 2160) return '4K';
  return n + 'p';
}

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
  if (!res.ok) throw Object.assign(new Error(data.message || 'Something went wrong.'), { status: res.status, data });
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
let preview = null; // { url, data, error, promise, scope, selected:Set }
let previewSeq = 0;
let previewTimer;

function updateInputButtons() {
  const has = input.value.trim().length > 0;
  $('#clearBtn').hidden = !has;
  $('#pasteBtn').hidden = has || !navigator.clipboard?.readText;
}

function resetPreview() {
  previewSeq++;
  preview = null;
  previewEl.hidden = true;
  previewEl.className = 'card preview';
  previewEl.replaceChildren();
  renderOpts();
}

function loadPreview(url) {
  const seq = ++previewSeq;
  preview = { url, data: null, error: null, scope: 'video', selected: new Set() };
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
      previewEl.className = 'card preview error';
      previewEl.replaceChildren(h('div', {}, e.message, e.data?.detail && h('small', {}, e.data.detail)));
    });
  return current.promise;
}

function videoRow(v) {
  const thumb = h('div', { class: 'thumb' }, img(v.thumbnail), v.duration && h('span', { class: 'dur' }, fmtDuration(v.duration)));
  const best = v.heights?.[0];
  return h('div', { class: 'pv-row video' }, thumb, h('div', { class: 'pv-info' },
    h('div', { class: 'pv-title', title: v.title }, v.title || 'Untitled'),
    h('div', { class: 'meta' },
      v.uploader && h('span', {}, v.uploader),
      v.site && h('span', { class: 'badge' }, v.site),
      best && h('span', { class: 'badge' }, 'up to ' + qualityLabel(String(best))),
      !v.hasVideo && h('span', { class: 'badge' }, 'audio only'))));
}

function playlistRow(p) {
  const thumb = h('div', { class: 'thumb' }, img(p.thumbnail),
    h('span', { class: 'count' }, icon('list'), String(p.count)));
  return h('div', { class: 'pv-row playlist' }, thumb, h('div', { class: 'pv-info' },
    h('div', { class: 'pv-title', title: p.title }, p.title),
    h('div', { class: 'meta' },
      p.uploader && h('span', {}, p.uploader),
      h('span', { class: 'badge' }, 'Playlist · ' + plural(p.count, 'video')))));
}

function batchButtonLabel(n) {
  if (!n) return 'Select videos to download';
  return settings.mode === 'audio'
    ? `Download ${n} as ${settings.audioFormat === 'best' ? 'audio' : settings.audioFormat.toUpperCase()}`
    : `Download ${plural(n, 'video')}`;
}

function renderPreview() {
  const p = preview;
  const d = p?.data;
  if (!d) return;
  previewEl.className = 'card preview';

  if (d.type === 'video') {
    previewEl.replaceChildren(videoRow(d));
    return;
  }

  const parts = [];
  if (d.video) {
    parts.push(h('div', { class: 'scope' }, h('div', { class: 'mini-seg' },
      h('button', { type: 'button', 'aria-pressed': String(p.scope === 'video'), onclick: () => setScope('video') }, 'This video'),
      h('button', { type: 'button', 'aria-pressed': String(p.scope === 'playlist'), onclick: () => setScope('playlist') }, `Whole playlist (${d.count})`))));
  }

  if (p.scope === 'video' && d.video) {
    parts.unshift(videoRow(d.video));
    previewEl.replaceChildren(...parts);
    return;
  }

  parts.unshift(playlistRow(d));
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
      'Select all'),
    h('span', {}, `${n} of ${d.entries.length} selected`)));

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
        h('div', { class: 'pl-dur' }, e.unavailable ? 'Unavailable' : fmtDuration(e.duration)))))));
  parts.push(list);

  if (d.truncated) parts.push(h('p', { class: 'hint' }, `Only the first ${d.entries.length} videos are shown.`));
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
  $('.pl-toolbar span', previewEl).textContent = `${n} of ${d.entries.length} selected`;
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
  input.value = '';
  resetPreview();
  updateInputButtons();
  input.focus();
});

$('#pasteBtn').addEventListener('click', async () => {
  try {
    const url = extractUrl(await navigator.clipboard.readText());
    if (!url) return toast('No link on the clipboard.');
    input.value = url;
    schedulePreview(true);
  } catch {
    toast('Couldn\'t read the clipboard — paste the link manually.');
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
    toast(input.value.trim() ? 'That doesn\'t look like a link.' : 'Paste a link first.');
    return;
  }

  // Playlist links need the preview first, so we know what to download
  if (looksLikePlaylist(url)) {
    if (preview?.url !== url) loadPreview(url);
    if (!preview.data && !preview.error) {
      toast('Loading the playlist…');
      await preview.promise;
    }
    if (preview?.url !== url) return;
    if (preview.error) return toast(preview.error.message);
    if (preview.data?.type === 'playlist' && preview.scope === 'playlist') return startBatch();
  }
  startJob(url);
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

function renderOpts() {
  const box = $('#opts');
  const hint = $('#optsHint');
  hint.hidden = true;

  if (settings.mode === 'audio') {
    const formats = [['mp3', 'MP3'], ['m4a', 'M4A'], ['opus', 'OPUS'], ['wav', 'WAV'], ['best', 'Original']];
    box.replaceChildren(...formats.map(([v, label]) => chip(label, settings.audioFormat === v, () => {
      settings.audioFormat = v;
      saveSettings();
      renderOpts();
      if (preview?.data?.type === 'playlist' && preview.scope === 'playlist') updatePlaylistCounters();
    })));
    return;
  }

  const d = preview?.data;
  const heights = (d?.type === 'video' ? d.heights : d?.video && preview.scope === 'video' ? d.video.heights : null) || [];
  let list = ['max', '2160', '1440', '1080', '720', '480', '360'];
  if (heights.length) list = ['max', ...new Set(heights.filter((x) => x >= 240).map(String))].slice(0, 7);
  const selected = list.includes(String(settings.quality)) ? String(settings.quality) : 'max';
  box.replaceChildren(...list.map((v) => chip(qualityLabel(v), v === selected, () => {
    settings.quality = v;
    saveSettings();
    renderOpts();
  })));

  if (settings.codec === 'h264' && selected === 'max') {
    hint.hidden = false;
    hint.replaceChildren(
      'Auto picks the best MP4 that plays everywhere (usually 1080p on YouTube). For 4K, pick 4K or switch to “Highest quality” in ',
      h('button', { type: 'button', onclick: openSettings }, 'Settings'), '.');
  }
}

const currentOptions = () => ({
  mode: settings.mode,
  quality: settings.quality,
  codec: settings.codec,
  audioFormat: settings.audioFormat,
});

function clearInput() {
  input.value = '';
  resetPreview();
  updateInputButtons();
}

// ---------- single downloads ----------

const tasks = new Map(); // id -> task (single job or playlist batch)

function persistTasks() {
  store.set('tasks', [...tasks.values()].map((t) => ({ kind: t.kind, id: t.data.id, meta: t.meta, saved: t.saved })));
}

async function startJob(url) {
  const v = preview?.url === url ? (preview.data?.type === 'video' ? preview.data : preview.data?.video) : null;
  const meta = { url, mode: settings.mode, title: v?.title || null, thumbnail: v?.thumbnail || null };
  const goBtn = $('#goBtn');
  goBtn.disabled = true;
  try {
    const job = await api('/api/jobs', { method: 'POST', body: { url, title: meta.title, ...currentOptions() } });
    addTask('job', job, meta, false);
    clearInput();
  } catch (e) {
    toast(e.message);
  } finally {
    goBtn.disabled = false;
  }
}

async function startBatch() {
  const d = preview?.data;
  if (!d || d.type !== 'playlist') return;
  const entries = d.entries.filter((e) => preview.selected.has(e.index) && !e.unavailable)
    .map((e) => ({ index: e.index, url: e.url, title: e.title }));
  if (!entries.length) return toast('Select at least one video.');
  const meta = { url: preview.url, mode: settings.mode, title: d.title, thumbnail: d.thumbnail };
  try {
    const batch = await api('/api/batches', { method: 'POST', body: { url: preview.url, title: d.title, entries, ...currentOptions() } });
    addTask('batch', batch, meta, false);
    clearInput();
  } catch (e) {
    toast(e.message);
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
    // connection dropped (e.g. phone screen locked) — is the task still there?
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

  if (task.kind === 'batch') {
    addHistory({ kind: 'playlist', url: task.meta.url, mode: task.meta.mode, title: data.title, count: data.done, size: data.size });
    toast(data.failed ? `Playlist ready — ${data.failed} failed.` : 'Playlist ready.');
  } else if (data.status === 'done') {
    addHistory({ kind: 'video', url: task.meta.url, mode: task.meta.mode, title: data.title || task.meta.title, size: data.size, ext: (data.fileName || '').split('.').pop() });
    if (settings.autoSave && !task.saved) saveTask(task);
  } else if (data.status === 'error') {
    toast(data.error?.message || 'Download failed.');
  }
}

function saveTask(task) {
  task.saved = true;
  persistTasks();
  download(`/api/jobs/${task.data.id}/file`);
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
  if (d.status === 'queued') return 'Waiting in queue…';
  if (d.status === 'done') return ['Ready', fmtBytes(d.size)].filter(Boolean).join(' · ');
  if (d.status === 'error') return d.error?.message || 'Failed';
  if (d.status === 'canceled') return 'Canceled';
  const p = d.progress || {};
  const parts = [d.phase];
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
    'aria-label': final ? 'Remove' : 'Cancel', title: final ? 'Remove' : 'Cancel',
    onclick: () => (final ? (task.kind === 'batch' ? cancelTask(task) : removeTask(task)) : cancelTask(task)),
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
    }, icon('save'), 'Save'));
  }
  if (d.status === 'error') {
    actions.append(h('button', { type: 'button', class: 'secondary-btn', onclick: () => { removeTask(task); setMode(meta.mode); startJob(meta.url); } }, 'Retry'));
  }
  actions.append(closeButton(task));

  task.el.className = `card job ${d.status}`;
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
    if (!d.done) return d.canceled === d.total ? 'Canceled' : 'All downloads failed';
    return [plural(d.done, 'file'), fmtBytes(d.size), d.failed && `${d.failed} failed`].filter(Boolean).join(' · ');
  }
  const active = d.items.filter((i) => i.status === 'running' || i.status === 'processing').length;
  return [`${d.done} of ${d.total} done`, active && `downloading ${active}`, d.failed && `${d.failed} failed`].filter(Boolean).join(' · ');
}

function itemState(i) {
  if (i.status === 'done') return h('span', { class: 'it-state ok' }, fmtBytes(i.size) || 'Ready');
  if (i.status === 'error') return h('span', { class: 'it-state bad', title: i.error || '' }, 'Failed');
  if (i.status === 'canceled') return h('span', { class: 'it-state' }, 'Canceled');
  if (i.status === 'queued') return h('span', { class: 'it-state' }, 'Queued');
  return h('span', { class: 'it-state' }, i.percent != null && i.status === 'running' ? `${Math.floor(i.percent)}%` : '…');
}

async function saveAll(task) {
  const done = task.data.items.filter((i) => i.status === 'done');
  toast(`Saving ${plural(done.length, 'file')}… your browser may ask to allow multiple downloads.`);
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
      h('a', { class: 'primary-btn', href: `/api/batches/${d.id}/zip`, download: '' }, icon('zip'), 'Download ZIP'),
      h('button', { type: 'button', class: 'secondary-btn', onclick: () => saveAll(task) }, icon('save'), 'Save all'));
  }

  const oldList = $('.items', task.el);
  const scroll = oldList?.scrollTop || 0;
  const list = task.expanded ? h('ul', { class: 'items' }, d.items.map((i) => h('li', {},
    h('div', { style: 'min-width:0' },
      h('div', { class: 'it-name', title: i.title || '' }, i.title || 'Video'),
      itemState(i)),
    i.status === 'done' ? h('a', { class: 'it-save', href: `/api/jobs/${i.id}/file`, download: '', title: 'Save', 'aria-label': 'Save' }, icon('save')) : null))) : null;

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
    }, task.expanded ? 'Hide items' : `Show ${plural(d.total, 'item')}`, icon('chevron')),
    list);
  if (list) list.scrollTop = scroll;
}

async function restoreTasks() {
  const saved = store.get('tasks', []);
  for (const item of saved) {
    try {
      const data = await api(`/api/${item.kind === 'batch' ? 'batches' : 'jobs'}/${item.id}`);
      addTask(item.kind, data, item.meta, item.saved, true);
    } catch { /* expired */ }
  }
  persistTasks();
}

// ---------- history ----------

function addHistory(entry) {
  const list = store.get('history', []);
  list.unshift({ ...entry, date: Date.now() });
  store.set('history', list.slice(0, 40));
  renderHistory();
}

function renderHistory() {
  const list = store.get('history', []);
  $('#historySec').hidden = list.length === 0;
  const fmtDate = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  $('#history').replaceChildren(...list.map((item) => {
    const isList = item.kind === 'playlist';
    const meta = isList
      ? [fmtDate.format(item.date), plural(item.count || 0, 'file'), fmtBytes(item.size)]
      : [fmtDate.format(item.date), item.ext?.toUpperCase(), fmtBytes(item.size)];
    return h('li', {},
      h('div', { class: 'h-icon' }, icon(isList ? 'list' : item.mode === 'audio' ? 'audio' : 'video')),
      h('div', { style: 'min-width:0' },
        h('div', { class: 'h-title', title: item.title }, item.title),
        h('div', { class: 'h-meta' }, meta.filter(Boolean).join(' · '))),
      h('button', {
        type: 'button', class: 'h-again',
        onclick: () => {
          setMode(item.mode);
          if (isList) {
            input.value = item.url;
            updateInputButtons();
            loadPreview(item.url);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          } else {
            startJob(item.url);
          }
        },
      }, 'Again'));
  }));
}

$('#clearHistory').addEventListener('click', () => {
  store.set('history', []);
  renderHistory();
});

// ---------- settings ----------

const settingsDlg = $('#settingsDlg');

function openSettings() {
  for (const r of $$('input[name="codec"]', settingsDlg)) r.checked = r.value === settings.codec;
  $('input[name="autoSave"]', settingsDlg).checked = settings.autoSave;
  applyTheme();
  settingsDlg.showModal();
}

$('#settingsBtn').addEventListener('click', openSettings);

settingsDlg.addEventListener('change', (e) => {
  if (e.target.name === 'codec') settings.codec = e.target.value;
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

// close dialogs when clicking the backdrop
for (const dlg of $$('dialog')) {
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
}

// ---------- phone connection ----------

const isLocalHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const isTouch = matchMedia('(pointer: coarse)').matches;

function renderQr(url) {
  for (const el of $$('[data-lan]')) el.textContent = url;
  if (typeof window.qrcode !== 'function') return;
  const qr = window.qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  for (const el of $$('[data-qr]')) el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

async function loadStatus() {
  try {
    const s = await api('/api/status');
    const lan = s.lan?.[0];
    $('#footInfo').textContent = `Running on your home PC · yt-dlp ${s.ytdlp || '?'}`;
    $('#aboutLine').textContent = `Ardite · yt-dlp ${s.ytdlp || '?'}${lan ? ' · ' + lan : ''}`;
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

applyTheme();
setMode(settings.mode === 'audio' ? 'audio' : 'video');
updateInputButtons();
renderHistory();
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
