// Logins for videos that need one: a cookies.txt uploaded from the browser (any browser, via an
// extension) or Firefox's own login. Chrome and Edge encrypt their cookies on Windows in a way
// yt-dlp can't read, so they aren't offered. The cookies themselves are never sent to any page.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config, saveConfig } from './config.js';
import { log } from './log.js';
import { parseCookiesTxt } from './core.js';
import { COOKIES_FILE, ytdlp, commonArgs } from './ytdlp.js';

const LOGIN_BROWSERS = ['firefox'];

// Folders that hold Firefox profiles on this system (the same places yt-dlp looks)
export function firefoxProfileRoots(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'darwin') return [path.join(home, 'Library', 'Application Support', 'Firefox', 'Profiles')];
  if (platform !== 'win32') {
    return [
      path.join(home, '.mozilla', 'firefox'),
      path.join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox'), // Ubuntu's snap
      path.join(home, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox'), // Flatpak
    ];
  }
  const roots = [path.join(env.APPDATA || '', 'Mozilla', 'Firefox', 'Profiles')];
  // the Microsoft Store version keeps its profiles elsewhere
  try {
    const packages = path.join(env.LOCALAPPDATA || '', 'Packages');
    for (const p of fs.readdirSync(packages)) {
      if (p.startsWith('Mozilla.Firefox')) roots.push(path.join(packages, p, 'LocalCache', 'Roaming', 'Mozilla', 'Firefox', 'Profiles'));
    }
  } catch { /* no Packages folder */ }
  return roots;
}

function firefoxInstalled() {
  for (const root of firefoxProfileRoots()) {
    try {
      if (fs.readdirSync(root).some((p) => fs.existsSync(path.join(root, p, 'cookies.sqlite')))) return true;
    } catch { /* not there */ }
  }
  return false;
}

export function loginStatus() {
  let file = null;
  if (fs.existsSync(COOKIES_FILE)) {
    const info = parseCookiesTxt(fs.readFileSync(COOKIES_FILE, 'utf8'));
    file = { ...info, date: fs.statSync(COOKIES_FILE).mtimeMs };
  }
  const browser = config.cookiesFromBrowser || null;
  return {
    // the file wins when both are set; a damaged file isn't used at all
    active: file?.ok ? 'file' : browser ? 'browser' : null,
    file,
    browser,
    firefox: firefoxInstalled(),
  };
}

// Keeps an uploaded cookies.txt; returns the error code when it isn't one
export function saveCookiesFile(text) {
  const info = parseCookiesTxt(text);
  if (!info.ok) return info.reason === 'empty' ? 'cookiesEmpty' : 'cookiesFormat';
  fs.writeFileSync(COOKIES_FILE + '.tmp', text);
  fs.renameSync(COOKIES_FILE + '.tmp', COOKIES_FILE);
  log(`cookies.txt added (${info.count} cookies, ${info.sites} sites${info.youtube ? ', YouTube included' : ''})`);
  return null;
}

export function removeCookiesFile() {
  fs.rmSync(COOKIES_FILE, { force: true });
  log('cookies.txt removed');
}

// "firefox" or '' (off); false when that browser can't be used here
export function setLoginBrowser(value) {
  if (value && (!LOGIN_BROWSERS.includes(value) || (value === 'firefox' && !firefoxInstalled()))) return false;
  saveConfig({ cookiesFromBrowser: value });
  log(value ? `using the ${value} login` : 'browser login turned off');
  return true;
}

// Asks yt-dlp to load the current login, using a harmless page instead of a video site
export function testLogin() {
  return new Promise((resolve) => {
    const args = [...commonArgs(), '--simulate', '--no-playlist', '--', 'https://example.com/'];
    execFile(...ytdlp(args), { windowsHide: true, timeout: 60000 }, (err, stdout, stderr) => {
      const out = `${stdout}\n${stderr}`;
      const extracted = /Extracted (\d+) cookies/.exec(out);
      // only problems with the login count; the page itself has no video, so other errors are expected
      const problem = out.split(/\r?\n/)
        .filter((l) => l.startsWith('ERROR:') && /cookie|DPAPI|decrypt|database|keyring/i.test(l)).pop();
      if (problem) return resolve({ ok: false, detail: problem.replace(/^ERROR:\s*/, '') });
      if (err?.killed) return resolve({ ok: false, detail: 'timed out' });
      resolve({ ok: true, count: extracted ? Number(extracted[1]) : null });
    });
  });
}
