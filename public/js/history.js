// Ardite web UI, part 4: the download history shared by all devices.

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
