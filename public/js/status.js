// Ardite web UI, part 6: the PC's status: phone QR code, footer and Ardite updates.

// ---------- phone connection ----------

// isTouch and isLocalHost are defined in base.js

// A QR code as SVG markup ('' while the QR library hasn't loaded)
function qrSvg(url) {
  if (typeof window.qrcode !== 'function') return '';
  const qr = window.qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

function renderQr(url) {
  for (const el of $$('[data-lan]')) el.textContent = url;
  const svg = qrSvg(url);
  for (const el of $$('[data-qr]')) el.innerHTML = svg;
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

// The versions line under Settings and the warning when the PC's disk is almost full
function renderAbout() {
  const s = serverStatus;
  if (!s) return;
  const lan = s.lan?.[0];
  const free = s.disk?.free != null ? ' · ' + t('disk.free', fmtBytes(s.disk.free)) : '';
  $('#aboutLine').textContent = `Ardite ${s.version ? 'v' + s.version : ''} · yt-dlp ${s.ytdlp || '?'}${lan ? ' · ' + lan : ''}${free}`;
  const diskBar = $('#diskBar');
  diskBar.hidden = !s.disk?.low;
  if (s.disk?.low) diskBar.replaceChildren(h('span', {}, t('disk.low', fmtBytes(s.disk.free), fmtBytes(s.disk.min))));
}

async function loadStatus() {
  try {
    const s = await api('/api/status');
    if (s.locked) return showLock();
    serverStatus = s;
    if (s.repo) $('#githubLink').href = s.repo;
    const lan = s.lan?.[0];
    renderFoot();
    renderUpdate();
    renderAbout();
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
