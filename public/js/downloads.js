// Ardite web UI, part 3: downloads and playlists in progress, with their live updates.

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
    if (data.error?.code === 'diskFull') loadStatus(); // shows the warning bar
  }
}

function saveTask(task) {
  task.saved = true;
  persistTasks();
  download(`/api/jobs/${task.data.id}/file`);
  saveSrt(task.data);
  render(task); // shows "Saved"
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

// saved: this device already saved the file (by itself or with the button)
function jobStatusText(d, saved) {
  if (d.status === 'queued') return t('st.queued');
  if (d.status === 'done' && isLowQuality(d)) {
    return t('warn.lowQuality', qualityLabel(String(d.media.height), d.media.fps), qualityLabel(String(d.expected)));
  }
  if (d.status === 'done') {
    const what = d.mode === 'gif' ? 'GIF' : mediaLabel(d.media);
    return [saved ? `${t('st.saved')} ✓` : t('st.ready'), trimLabel(d.trim), what, subsLabel(d.subs), fmtBytes(d.size)].filter(Boolean).join(' · ');
  }
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
    // once saved, saving again is a quiet option rather than the main button
    actions.append(h('a', {
      class: task.saved ? 'secondary-btn' : 'primary-btn', href: `/api/jobs/${d.id}/file`, download: '',
      onclick: () => { task.saved = true; persistTasks(); setTimeout(() => render(task)); },
    }, icon('save'), t(task.saved ? 'saveAgain' : 'save')));
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
    taskThumb(meta, meta.mode === 'audio' || meta.mode === 'gif' ? meta.mode : 'video'),
    h('div', {},
      h('div', { class: 'job-title', title }, title),
      h('div', { class: 'job-status', title: d.error?.detail || '' }, jobStatusText(d, task.saved)),
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
  // locked (PIN): keep the list, the page reloads and tries again once the PIN is entered
  if (results.some((r) => r.reason?.status === 401)) return;
  results.forEach((r, i) => {
    // rejected ones have expired on the server
    if (r.status === 'fulfilled') addTask(saved[i].kind, r.value, saved[i].meta, saved[i].saved, true);
  });
  persistTasks();
}
