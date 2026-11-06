// The web UI in a real browser (headless Edge or Chrome) against a throwaway Ardite with the
// stand-in yt-dlp: the page is clicked through like a person would, and any JavaScript error on
// it fails the run. Skipped when no Edge or Chrome is installed (ARDITE_BROWSER can point to one).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startServer, freePort, sleep, waitFor } from '../.github/test-server.mjs';
import { findBrowser, launchBrowser } from '../.github/browser.mjs';

const BROWSER = findBrowser();
const skip = BROWSER ? false : 'no Edge or Chrome found (set ARDITE_BROWSER to use another one)';
// each step fails after a minute instead of hanging (slow CI machines need far less)
const STEP = 60000;

const HISTORY = [
  { id: 'aa11', date: Date.now() - 60000, kind: 'video', mode: 'video', title: 'First video', url: 'https://fake.test/h1', site: 'fake.test', size: 1000, device: 'pc' },
  { id: 'bb22', date: Date.now() - 120000, kind: 'video', mode: 'audio', title: 'Second video', url: 'https://fake.test/h2', site: 'fake.test', size: 2000, device: 'android' },
];

let server;
let browser;
let page; // the page on this PC
let phone; // the page as another device sees it (see the relay below)
let relay;

before(async () => {
  if (skip) return;
  server = await startServer({ history: HISTORY });
  browser = await launchBrowser(BROWSER);
  page = await browser.open(`${server.base}/`);
}, { timeout: 60000 });

after(async () => {
  page?.close();
  phone?.close();
  relay?.close();
  await browser?.close();
  await server?.stop();
});

const paste = (p, url) => p.run(`const i = document.querySelector('#url'); i.value = ${JSON.stringify(url)}; i.dispatchEvent(new Event('input')); return true`);
const historyHas = (n) => `return document.querySelectorAll('#history li:not(.h-more)').length === ${n}`;
const click = (p, selector) => p.run(`document.querySelector(${JSON.stringify(selector)}).click(); return true`);

test('the page starts: texts, history and status line', { skip, timeout: STEP }, async () => {
  await page.until(`return document.querySelector('.hero h1').textContent.trim().length > 5`, 'the texts');
  await page.until(historyHas(2), 'the history');
  await page.until(`return document.querySelector('#aboutLine').textContent.includes('yt-dlp 2099.01.01')`, 'the status line');
});

test('a pasted link shows its preview, quality choices and both modes', { skip, timeout: STEP }, async () => {
  await paste(page, 'https://fake.test/ui1?size=2000&ms=400');
  await page.until(`return document.querySelector('#preview').textContent.includes('Video ui1')`, 'the preview');
  await page.until(`return document.querySelectorAll('#opts button').length > 1`, 'the quality choices');
  await click(page, '[data-mode="audio"]');
  await page.until(`return document.querySelector('[data-mode="audio"]').getAttribute('aria-selected') === 'true'`, 'audio mode');
  await click(page, '[data-mode="video"]');
});

test('GIF mode opens a short part by itself and won\'t take a long one', { skip, timeout: STEP }, async () => {
  await click(page, '[data-mode="gif"]');
  await page.until(`return !document.querySelector('#trimBox').hidden
    && document.querySelector('#trimStart').value === '0:00' && document.querySelector('#trimEnd').value === '0:05'`, 'the first 5 seconds');
  assert.deepEqual(await page.run(`return [...document.querySelectorAll('#opts button')].map((b) => b.textContent)`), ['Small', 'Medium', 'Large']);
  assert.match(await page.run(`return document.querySelector('#cardGo').textContent`), /^Make GIF · Medium · ✂ 0:05$/);
  assert.ok(await page.run(`return document.querySelector('.trim-precise').hidden && !document.querySelector('#extras button')`), 'no cut or subtitle buttons');
  // more than 30 seconds isn't sent
  await page.run(`const e = document.querySelector('#trimEnd'); e.value = '0:45'; e.dispatchEvent(new Event('input')); return true`);
  await click(page, '#cardGo');
  await page.until(`return document.querySelector('#trimEnd').getAttribute('aria-invalid') === 'true'`, 'the too-long part refused');
  assert.equal(await page.run(`return document.querySelectorAll('#jobs .job').length`), 0);
  await click(page, '[data-mode="video"]');
  await page.until(`return document.querySelector('#trimBox').hidden && /^Download/.test(document.querySelector('#cardGo').textContent)`, 'back to video');
});

test('a download runs to the end, goes into the history and is still there after a reload', { skip, timeout: STEP }, async () => {
  await click(page, '#cardGo');
  await page.until(`return document.querySelectorAll('#jobs .job').length === 1`, 'the download card');
  await page.until(`return /1080p/.test(document.querySelector('#jobs .job').textContent)`, 'the finished download');
  // it was saved by itself, so the card says so and saving again is the quiet option
  await page.until(`return /Saved ✓/.test(document.querySelector('#jobs .job .job-status').textContent)
    && document.querySelector('#jobs .job a').textContent === 'Save again'`, 'the saved state');
  await page.until(historyHas(3), 'the history entry');
  await page.reload();
  await page.until(`return document.querySelectorAll('#jobs .job').length === 1`, 'the card after a reload');
});

test('Settings: yt-dlp update, PIN and login sections, language', { skip, timeout: STEP }, async () => {
  await click(page, '#settingsBtn');
  await page.until(`return document.querySelector('#settingsDlg').open && document.querySelector('#ytdlpBox').textContent.includes('2099.01.01')`, 'the yt-dlp row');
  await page.until(`return !!document.querySelector('#pinBox input') && !!document.querySelector('#loginBox button')`, 'the PIN and login sections');
  // Ardite checks for a yt-dlp update by itself 5 s after starting, so "Up to date" may already be
  // there: wait for this check on the server too, then for the page to show it's done
  const updates = () => server.calls().filter((c) => c.what === 'update').length;
  const done = updates();
  await click(page, '#ytdlpBox button');
  await waitFor(async () => {
    const s = (await server.call('/api/ytdlp')).data;
    return updates() > done && !s.updating && !s.waiting;
  }, 'the update check');
  await page.until(`return /Up to date/.test(document.querySelector('#ytdlpBox').textContent)
    && !document.querySelector('#ytdlpBox input.switch').disabled`, 'the update result');
  // the nightly switch installs the other yt-dlp and shows it; switching back returns to stable
  await click(page, '#ytdlpBox input.switch');
  await page.until(`return document.querySelector('#ytdlpBox').textContent.includes('yt-dlp 2099.01.02.000000 · nightly')
    && document.querySelector('#ytdlpBox input.switch').checked
    && document.querySelector('#aboutLine').textContent.includes('yt-dlp 2099.01.02.000000')`, 'nightly');
  await click(page, '#ytdlpBox input.switch');
  await page.until(`return document.querySelector('#ytdlpBox b').textContent === 'yt-dlp 2099.01.01'
    && !document.querySelector('#ytdlpBox input.switch').checked`, 'back to stable');
  await click(page, '[data-lang-val="tr"]');
  // everything in Settings follows the language, also the parts filled in by the server's answers
  await page.until(`return document.documentElement.lang === 'tr'
    && /Güncel/.test(document.querySelector('#ytdlpBox').textContent)
    && /Kapalı/.test(document.querySelector('#pinBox').textContent)
    && /boş/.test(document.querySelector('#aboutLine').textContent)`, 'everything in Turkish');
  await page.run(`document.querySelector('[data-lang-val="en"]').click(); document.querySelector('#settingsDlg').close(); return true`);
});

test('the history window lists every download', { skip, timeout: STEP }, async () => {
  await click(page, '#historyBtn');
  await page.until(`return document.querySelector('#historyDlg').open && document.querySelectorAll('#histRows tr').length === 3`, 'the history window');
  await click(page, '#historyClose');
});

test('another device gets the PIN lock screen, and only the right PIN opens it', { skip, timeout: STEP }, async () => {
  // Requests from 127.0.0.2 don't count as this PC; a browser can't choose that address itself,
  // so it goes through a small relay that connects to Ardite from 127.0.0.2
  const port = await freePort();
  relay = net.createServer((c) => {
    const s = net.connect({ host: '127.0.0.1', port: server.port, localAddress: '127.0.0.2' });
    c.pipe(s).pipe(c);
    c.on('error', () => s.destroy());
    s.on('error', () => c.destroy());
  }).listen(port, '127.0.0.1');
  phone = await browser.open(`http://127.0.0.1:${port}/`);

  // a download on that device before there's a PIN
  await paste(phone, 'https://fake.test/phone1?size=1500');
  await phone.until(`return document.querySelector('#preview').textContent.includes('Video phone1')`, 'the preview on the other device');
  await click(phone, '#cardGo');
  await phone.until(`return /1080p/.test(document.querySelector('#jobs .job')?.textContent || '')`, 'its download');

  // the PC sets a PIN, the other device comes back
  assert.equal((await server.call('/api/pin', 'PUT', { pin: '2468' })).status, 200);
  await phone.reload();
  await phone.until(`return document.querySelector('#lockDlg').open`, 'the lock screen');
  await sleep(500);
  assert.ok(await phone.run(`return (localStorage.getItem('ardite.tasks') || '').includes('job')`), 'its download list is kept while locked');

  await phone.run(`document.querySelector('#lockDlg').dispatchEvent(new MouseEvent('click', { bubbles: true })); return true`);
  assert.ok(await phone.run(`return document.querySelector('#lockDlg').open`), 'clicking outside does not close it');

  await phone.run(`document.querySelector('#lockPin').value = '0000'; document.querySelector('#lockForm').requestSubmit(); return true`);
  await phone.until(`return !document.querySelector('#lockError').hidden`, 'the wrong-PIN message');

  await phone.run(`document.querySelector('#lockPin').value = '2468'; document.querySelector('#lockForm').requestSubmit(); return true`);
  await phone.until(`return document.querySelector('#url') && !document.querySelector('#lockDlg').open && document.querySelectorAll('#history li:not(.h-more)').length === 4`, 'the unlocked page');
  await phone.until(`return document.querySelectorAll('#jobs .job').length === 1`, 'its download card, back');
});

test('a device name typed in Settings goes into the history', { skip, timeout: STEP }, async () => {
  await click(page, '#settingsBtn');
  // without a name, one is made up from the device and browser; on this PC it starts with "PC"
  assert.match(await page.run(`return document.querySelector('#deviceName').placeholder`), /^PC · /);
  await page.run(`const i = document.querySelector('#deviceName'); i.value = 'Salon PC'; i.dispatchEvent(new Event('input')); document.querySelector('#settingsDlg').close(); return true`);
  await paste(page, 'https://fake.test/named1?size=900');
  await page.until(`return document.querySelector('#preview').textContent.includes('Video named1')`, 'the preview');
  await click(page, '#cardGo');
  await page.until(`return document.querySelector('#history li')?.textContent.includes('Salon PC')`, 'the name in the history');
});

test('the statistics window counts the downloads', { skip, timeout: STEP }, async () => {
  await click(page, '#statsBtn');
  await page.until(`return document.querySelector('#statsDlg').open && document.querySelectorAll('#statsBody .stat-tile').length === 6`, 'the headline numbers');
  // 2 from the history it started with, 2 downloaded here, 1 on the other device
  assert.equal(await page.run(`return document.querySelector('#statsBody .stat-tile b').textContent`), '5');
  await page.until(`return [...document.querySelectorAll('#statsBody .rank-name')].some((n) => n.textContent === 'Salon PC')`, 'the device name');
  assert.equal(await page.run(`return document.querySelectorAll('#statsBody .cols').length`), 3); // months, weekdays, hours
  await click(page, '#statsClose');
});

test('no JavaScript errors on the pages', { skip, timeout: STEP }, () => {
  assert.deepEqual([...page.errors, ...(phone?.errors || [])], []);
});
