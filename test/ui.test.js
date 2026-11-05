// The web UI in a real browser (headless Edge or Chrome) against a throwaway Ardite with the
// stand-in yt-dlp: the page is clicked through like a person would, and any JavaScript error on
// it fails the run. Skipped when no Edge or Chrome is installed (ARDITE_BROWSER can point to one).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startServer, freePort, sleep } from '../.github/test-server.mjs';
import { findBrowser, launchBrowser } from '../.github/browser.mjs';

const BROWSER = findBrowser();
const skip = BROWSER ? false : 'no Edge or Chrome found (set ARDITE_BROWSER to use another one)';

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
});

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

test('the page starts: texts, history and status line', { skip }, async () => {
  await page.until(`return document.querySelector('.hero h1').textContent.trim().length > 5`, 'the texts');
  await page.until(historyHas(2), 'the history');
  await page.until(`return document.querySelector('#aboutLine').textContent.includes('yt-dlp 2099.01.01')`, 'the status line');
});

test('a pasted link shows its preview, quality choices and both modes', { skip }, async () => {
  await paste(page, 'https://fake.test/ui1?size=2000&ms=400');
  await page.until(`return document.querySelector('#preview').textContent.includes('Video ui1')`, 'the preview');
  await page.until(`return document.querySelectorAll('#opts button').length > 1`, 'the quality choices');
  await click(page, '[data-mode="audio"]');
  await page.until(`return document.querySelector('[data-mode="audio"]').getAttribute('aria-selected') === 'true'`, 'audio mode');
  await click(page, '[data-mode="video"]');
});

test('a download runs to the end, goes into the history and is still there after a reload', { skip }, async () => {
  await click(page, '#cardGo');
  await page.until(`return document.querySelectorAll('#jobs .job').length === 1`, 'the download card');
  await page.until(`return /1080p/.test(document.querySelector('#jobs .job').textContent)`, 'the finished download');
  await page.until(historyHas(3), 'the history entry');
  await page.reload();
  await page.until(`return document.querySelectorAll('#jobs .job').length === 1`, 'the card after a reload');
});

test('Settings: yt-dlp update, PIN and login sections, language', { skip }, async () => {
  await click(page, '#settingsBtn');
  await page.until(`return document.querySelector('#settingsDlg').open && document.querySelector('#ytdlpBox').textContent.includes('2099.01.01')`, 'the yt-dlp row');
  await page.until(`return !!document.querySelector('#pinBox input') && !!document.querySelector('#loginBox button')`, 'the PIN and login sections');
  await click(page, '#ytdlpBox button');
  await page.until(`return /Up to date/.test(document.querySelector('#ytdlpBox').textContent)`, 'the update result');
  // the nightly switch installs the other yt-dlp and shows it; switching back returns to stable
  await click(page, '#ytdlpBox input.switch');
  await page.until(`return document.querySelector('#ytdlpBox').textContent.includes('yt-dlp 2099.01.02.000000 · nightly')
    && document.querySelector('#ytdlpBox input.switch').checked`, 'nightly');
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

test('the history window lists every download', { skip }, async () => {
  await click(page, '#historyBtn');
  await page.until(`return document.querySelector('#historyDlg').open && document.querySelectorAll('#histRows tr').length === 3`, 'the history window');
  await click(page, '#historyClose');
});

test('another device gets the PIN lock screen, and only the right PIN opens it', { skip }, async () => {
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

test('no JavaScript errors on the pages', { skip }, () => {
  assert.deepEqual([...page.errors, ...(phone?.errors || [])], []);
});
