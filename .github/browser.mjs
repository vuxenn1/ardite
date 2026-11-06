// A tiny headless browser driver for test/ui.test.js: starts Edge or Chrome with a throwaway
// profile and talks to it over the DevTools protocol (no extra packages needed).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { freePort, sleep, waitFor } from './test-server.mjs';

// ARDITE_BROWSER, or Edge / Chrome where Windows, macOS or Linux usually keep them
export function findBrowser() {
  const candidates = [
    process.env.ARDITE_BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/microsoft-edge',
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

// args: extra command line switches, e.g. to trust a test certificate
export async function launchBrowser(executable, args = []) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ardite-browser-'));
  const port = await freePort();
  const proc = spawn(executable, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,900',
    // the browser's own built-in extensions run scripts on every page and sometimes fail there
    '--disable-extensions', '--disable-component-extensions-with-background-pages',
    ...args,
    'about:blank',
  ], { stdio: 'ignore' });
  const devtools = `http://127.0.0.1:${port}`;
  // every request has a time limit, so a browser that hangs fails the test instead of stalling it
  await waitFor(() => fetch(`${devtools}/json/version`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false), 'the browser to start');

  return {
    // Opens a page; JavaScript errors on it are collected in page.errors
    async open(url) {
      const tab = await (await fetch(`${devtools}/json/new?${url}`, { method: 'PUT', signal: AbortSignal.timeout(10000) })).json();
      const ws = new WebSocket(tab.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
      });
      let seq = 0;
      const pending = new Map();
      const errors = [];
      // only the page's own errors count, not those of the browser's extensions (chrome-extension://…)
      const fromBrowser = (where) => /^(chrome|edge)(-extension)?:\/\//.test(where || '');
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        } else if (msg.method === 'Runtime.exceptionThrown') {
          // with where it happened, e.g. "(/js/settings.js:42)"
          const d = msg.params.exceptionDetails;
          if (fromBrowser(d.url)) return;
          const where = d.url ? ` (${d.url.replace(/^https?:\/\/[^/]+/, '')}:${d.lineNumber + 1})` : '';
          errors.push(`${d.exception?.description || d.text}${where}`);
        } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
          const frame = msg.params.stackTrace?.callFrames?.[0];
          if (fromBrowser(frame?.url)) return;
          const where = frame ? ` (${frame.url.replace(/^https?:\/\/[^/]+/, '')}:${frame.lineNumber + 1})` : '';
          errors.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}${where}`);
        }
      };
      const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`the browser didn't answer ${method}`));
        }, 30000);
        pending.set(id, {
          resolve: (v) => (clearTimeout(timer), resolve(v)),
          reject: (e) => (clearTimeout(timer), reject(e)),
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
      // runs `body` (the inside of an async function) in the page and returns its result
      const run = async (body) => {
        const r = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
      };
      await send('Runtime.enable');
      await send('Page.enable');
      // reloads and waits for the new page: the mark on the old one tells them apart
      const reload = async () => {
        await run('window.__oldPage = true').catch(() => {});
        await send('Page.reload');
        await waitFor(() => run('return !window.__oldPage && document.readyState === "complete"').catch(() => false), 'the page to load');
        await sleep(300);
      };
      // the tab started loading before we listened, so start it again to see everything
      await reload();
      return {
        errors,
        run,
        // waits until `body` returns something truthy
        until: (body, what, timeout) => waitFor(() => run(body).catch(() => false), what, timeout),
        reload,
        // a phone-sized screen and/or the dark theme, e.g. { width: 390, height: 844, dark: true }
        async emulate({ width = 1280, height = 900, dark = false } = {}) {
          await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
          await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
        },
        // a PNG of what the page shows now, for looking at a layout while working on it
        async screenshot() {
          return Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
        },
        close: () => ws.close(),
      };
    },
    async close() {
      proc.kill();
      await new Promise((r) => (proc.exitCode !== null ? r() : proc.once('exit', r)));
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    },
  };
}
