// Ardite web UI, part 5: Settings (device name, yt-dlp, logins, PIN, theme, language) and the PIN lock screen.

// ---------- settings ----------

const settingsDlg = $('#settingsDlg');

function openSettings() {
  for (const r of $$('input[name="codec"]', settingsDlg)) r.checked = r.value === settings.codec;
  $('input[name="autoSave"]', settingsDlg).checked = settings.autoSave;
  const name = $('#deviceName');
  name.value = settings.deviceName || '';
  name.placeholder = autoDeviceName();
  applyTheme();
  markLang();
  settingsDlg.showModal();
  loadLogin();
  loadPin();
  loadYtdlp();
}

// This device's name in the history and statistics (empty: the made-up one, shown as placeholder)
$('#deviceName').addEventListener('input', (e) => {
  settings.deviceName = e.target.value.trim();
  saveSettings();
});
// Enter would submit the settings form and close it
$('#deviceName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') e.preventDefault();
});

// ---------- yt-dlp update (Settings) ----------

let ytdlp = null; // { version, channel, updating, waiting, last, result }
let ytdlpTimer;

async function loadYtdlp() {
  try {
    ytdlp = await api('/api/ytdlp');
  } catch { ytdlp = null; }
  renderYtdlp();
  // the versions line below shows it too
  if (serverStatus && ytdlp?.version && serverStatus.ytdlp !== ytdlp.version) {
    serverStatus.ytdlp = ytdlp.version;
    renderAbout();
  }
}

function ytdlpText() {
  if (ytdlp.updating) return t('ytdlp.updating');
  if (ytdlp.waiting) return t('ytdlp.waiting');
  if (!ytdlp.last) return t('ytdlp.auto');
  const when = fmtDate.format(ytdlp.last);
  if (ytdlp.result === 'updated') return t('ytdlp.updated', when);
  if (ytdlp.result === 'current') return t('ytdlp.current', when);
  return t('ytdlp.failed', when);
}

function renderYtdlp() {
  const box = $('#ytdlpBox');
  box.hidden = !ytdlp;
  if (!ytdlp) return;
  const busy = ytdlp.updating || ytdlp.waiting;
  const nightly = ytdlp.channel === 'nightly';
  box.replaceChildren(
    h('div', { class: 'row ytdlp-row' },
      h('span', {}, h('b', {}, `yt-dlp ${ytdlp.version || ''}${nightly ? ' · nightly' : ''}`), h('small', {}, ytdlpText())),
      h('button', { type: 'button', class: 'hist-btn', disabled: busy, onclick: updateYtdlp }, t('ytdlp.check'))),
    h('label', { class: 'switch-row' },
      h('span', {}, h('b', {}, t('ytdlp.nightly')), h('small', {}, t('ytdlp.nightlyDesc'))),
      h('input', { type: 'checkbox', class: 'switch', checked: nightly, disabled: busy, onchange: (e) => setYtdlpChannel(e.target.checked) })));
  // follow along while it runs
  clearTimeout(ytdlpTimer);
  if (busy && settingsDlg.open) ytdlpTimer = setTimeout(loadYtdlp, 1500);
}

async function updateYtdlp() {
  try {
    ytdlp = await api('/api/ytdlp/update', { method: 'POST' });
  } catch (err) { toast(errText(err)); }
  renderYtdlp();
}

// switches between the stable and nightly yt-dlp; the server installs the other one right away
async function setYtdlpChannel(nightly) {
  try {
    ytdlp = await api('/api/ytdlp/channel', { method: 'PUT', body: { channel: nightly ? 'nightly' : 'stable' } });
  } catch (err) { toast(errText(err)); }
  renderYtdlp();
}

$('#settingsBtn').addEventListener('click', openSettings);

// ---------- login for videos that need it (a setting of the PC, shared by all devices) ----------

let login = null; // { active, file, browser, firefox }
let loginTest = null; // { busy } or the last test result

async function loadLogin() {
  try {
    login = await api('/api/login');
  } catch { login = null; }
  loginTest = null;
  renderLogin();
}

function loginStatusText() {
  if (login.file && !login.file.ok) return t('login.fileBad');
  if (login.file) return t('login.fileOn', login.file.count, login.file.youtube);
  if (login.browser) return t('login.firefoxOn');
  return t('login.none');
}

function renderLogin() {
  const box = $('#loginBox');
  if (!login) return box.replaceChildren();
  const parts = [h('p', { class: 'login-status' + (login.active ? ' on' : '') }, loginStatusText(),
    login.file?.date && h('small', {}, fmtDate.format(login.file.date)))];

  const buttons = h('div', { class: 'login-actions' },
    h('button', { type: 'button', class: 'hist-btn', onclick: () => $('#cookieFile').click() },
      login.file ? t('login.replace') : t('login.upload')),
    login.file && h('button', { type: 'button', class: 'hist-btn', onclick: removeCookies }, t('remove')),
    login.active && h('button', { type: 'button', class: 'hist-btn', disabled: !!loginTest?.busy, onclick: runLoginTest },
      loginTest?.busy ? t('login.testing') : t('login.test')));
  parts.push(buttons);
  if (loginTest && !loginTest.busy) {
    parts.push(h('p', { class: 'login-result ' + (loginTest.ok ? 'ok' : 'bad') },
      loginTest.ok ? t('login.testOk', loginTest.count) : t('login.testFail', loginTest.detail || '')));
  }

  // Firefox's own login, only when Firefox is on this PC
  if (login.firefox) {
    parts.push(h('label', { class: 'switch-row' },
      h('span', {}, h('b', {}, t('login.firefox')),
        h('small', {}, login.file ? `${t('login.firefoxDesc')} ${t('login.fileWins')}` : t('login.firefoxDesc'))),
      h('input', {
        type: 'checkbox', class: 'switch', checked: login.browser === 'firefox',
        onchange: async (e) => {
          try {
            login = await api('/api/login/browser', { method: 'PUT', body: { browser: e.target.checked ? 'firefox' : '' } });
          } catch (err) { toast(errText(err)); }
          loginTest = null;
          renderLogin();
        },
      })));
  }
  parts.push(h('p', { class: 'tiny login-help' }, t('login.help')));
  box.replaceChildren(...parts);
}

$('#cookieFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const res = await fetch('/api/login/file', { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: await file.text() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message || t('err.generic')), { code: data.code });
    login = data;
    loginTest = null;
    renderLogin();
  } catch (err) {
    toast(errText(err));
  }
});

async function removeCookies() {
  try {
    login = await api('/api/login/file', { method: 'DELETE' });
  } catch (err) { toast(errText(err)); }
  loginTest = null;
  renderLogin();
}

async function runLoginTest() {
  loginTest = { busy: true };
  renderLogin();
  try {
    loginTest = await api('/api/login/test', { method: 'POST' });
  } catch (err) {
    loginTest = { ok: false, detail: errText(err) };
  }
  renderLogin();
}

// ---------- PIN lock (a setting of the PC, for all other devices) ----------

let pinState = null; // { pin, thisPc, devices }

async function loadPin() {
  try {
    pinState = await api('/api/pin');
  } catch { pinState = null; }
  renderPin();
}

function renderPin() {
  const box = $('#pinBox');
  if (!pinState) return box.replaceChildren();
  const input = h('input', {
    type: 'password', class: 'pin-input', autocomplete: 'new-password',
    placeholder: t(pinState.pin ? 'pin.new' : 'pin.choose'), 'aria-label': t(pinState.pin ? 'pin.new' : 'pin.choose'),
    // Enter would submit the settings form and close it
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); savePin(input.value); } },
  });
  box.replaceChildren(
    h('p', { class: 'login-status' + (pinState.pin ? ' on' : '') }, pinState.pin ? t('pin.on', pinState.devices) : t('pin.off')),
    h('div', { class: 'pin-row' }, input,
      h('button', { type: 'button', class: 'hist-btn', onclick: () => savePin(input.value) }, t(pinState.pin ? 'pin.change' : 'pin.set'))),
    pinState.pin && h('div', { class: 'login-actions' },
      h('button', { type: 'button', class: 'hist-btn', onclick: removePin }, t('pin.remove'))),
    h('p', { class: 'tiny login-help' }, t('pin.help')));
}

async function savePin(pin) {
  if (pin.length < 4) return toast(t('err.pinFormat'));
  try {
    pinState = await api('/api/pin', { method: 'PUT', body: { pin } });
    toast(t('pin.saved'));
  } catch (err) { toast(errText(err)); }
  renderPin();
}

async function removePin() {
  if (!confirm(t('pin.removeConfirm'))) return;
  try {
    pinState = await api('/api/pin', { method: 'DELETE' });
    toast(t('pin.removed'));
  } catch (err) { toast(errText(err)); }
  renderPin();
}

// The lock screen: shown when the server says this device needs the PIN
const lockDlg = $('#lockDlg');
lockDlg.addEventListener('cancel', (e) => e.preventDefault()); // Esc doesn't get around it

function showLock() {
  if (lockDlg.open) return;
  for (const d of $$('dialog[open]')) d.close();
  lockDlg.showModal();
  $('#lockPin').focus();
}

$('#lockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = $('#lockError');
  const pin = $('#lockPin');
  try {
    await api('/api/unlock', { method: 'POST', body: { pin: pin.value } });
    location.reload(); // starts the page again, now signed in
  } catch (err) {
    error.textContent = err.code === 'pinWait' && err.data?.wait ? t('lock.wait', err.data.wait) : errText(err);
    error.hidden = false;
    pin.select();
  }
});

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
  renderLogin();
  renderPin();
  renderYtdlp();
  renderFoot();
  renderUpdate();
  renderAbout();
  renderStats();
}

for (const b of $$('[data-lang-val]')) {
  b.addEventListener('click', () => {
    settings.lang = b.dataset.langVal;
    saveSettings();
    applyLang();
  });
}

// close dialogs when clicking the backdrop (not the PIN lock: only the right PIN closes it)
for (const dlg of $$('dialog')) {
  if (dlg === lockDlg) continue;
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
}
