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

export async function launchBrowser(executable) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ardite-browser-'));
  const port = await freePort();
  const proc = spawn(executable, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });
  const devtools = `http://127.0.0.1:${port}`;
  await waitFor(() => fetch(`${devtools}/json/version`).then(() => true, () => false), 'the browser to start');

  return {
    // Opens a page; JavaScript errors on it are collected in page.errors
    async open(url) {
      const tab = await (await fetch(`${devtools}/json/new?${url}`, { method: 'PUT' })).json();
      const ws = new WebSocket(tab.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
      });
      let seq = 0;
      const pending = new Map();
      const errors = [];
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        } else if (msg.method === 'Runtime.exceptionThrown') {
          const d = msg.params.exceptionDetails;
          errors.push(d.exception?.description || d.text);
        } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
          errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
        }
      };
      const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
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
