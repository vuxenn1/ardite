// The web page over https:// in a real browser that trusts Ardite's certificate, the way a phone
// does once it's set up: the page works, and the setup page (/secure) on http:// says "Done".
// Skipped when no Edge or Chrome is installed, like ui.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import tls from 'node:tls';
import { startServer } from '../.github/test-server.mjs';
import { findBrowser, launchBrowser } from '../.github/browser.mjs';

const BROWSER = findBrowser();
const skip = BROWSER ? false : 'no Edge or Chrome found (set ARDITE_BROWSER to use another one)';
const STEP = 60000;

// The hash of the key in the server's certificate, which the browser is told to trust
// (a stand-in for installing the authority, which can't be done in a throwaway browser)
const keyHash = (port) => new Promise((resolve, reject) => {
  const socket = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
    const der = socket.getPeerX509Certificate().publicKey.export({ type: 'spki', format: 'der' });
    socket.end();
    resolve(crypto.createHash('sha256').update(der).digest('base64'));
  });
  socket.on('error', reject);
});

let server;
let browser;
before(async () => {
  if (skip) return;
  server = await startServer();
  browser = await launchBrowser(BROWSER, [`--ignore-certificate-errors-spki-list=${await keyHash(server.port)}`]);
}, { timeout: 60000 });

after(async () => {
  await browser?.close();
  await server?.stop();
});

test('the page works over https://', { skip, timeout: STEP }, async () => {
  const page = await browser.open(`https://127.0.0.1:${server.port}/`);
  await page.until(`return location.protocol === 'https:' && document.querySelector('#aboutLine').textContent.includes('yt-dlp 2099.01.01')`, 'the page over https');
  // Settings says the connection is secure
  await page.run(`document.querySelector('#settingsBtn').click(); return true`);
  await page.until(`return !document.querySelector('#secureSet').hidden && /secure/.test(document.querySelector('#secureBox').textContent)`, 'the secure line');
  assert.deepEqual(page.errors, []);
  page.close();
});

test('the setup page notices when https:// works on the device', { skip, timeout: STEP }, async () => {
  const page = await browser.open(`${server.base}/secure`);
  await page.until(`return document.querySelector('#secureCheck').classList.contains('ok')
    && !document.querySelector('#secureOpen').hidden`, 'the Done line');
  assert.equal(await page.run(`return document.querySelector('#secureOpen').href`), `https://127.0.0.1:${server.port}/`);
  assert.deepEqual(page.errors, []);
  page.close();
});
