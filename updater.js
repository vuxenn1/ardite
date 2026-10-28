// One-click update for release packages on Windows.
// The server downloads the new package, checks it and unpacks it next to itself, then hands over
// to scripts/update.ps1 and exits: a running program can't replace its own node.exe. The script
// backs up the current files, copies the new ones, starts Ardite again and, if the new version
// doesn't come up, puts the backup back and starts the old version.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isNewer } from './core.js';

const ASSET = 'Ardite-win64.zip';
const SEMVER = /^\d+\.\d+\.\d+$/;
// Packages only come over https; plain http is allowed for this PC itself (local test feeds)
const safeUrl = (u) => u.startsWith('https://') || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u);

// The parts of a GitHub "latest release" answer that matter here, or null if it doesn't look right
export function readRelease(r) {
  const version = String(r?.tag_name || '').replace(/^v/, '');
  const url = String(r?.html_url || '');
  if (!SEMVER.test(version) || !url.startsWith('https://')) return null;
  const a = (r.assets || []).find((x) => x?.name === ASSET);
  const download = String(a?.browser_download_url || '');
  const sha256 = /^sha256:([a-f0-9]{64})$/.exec(String(a?.digest || ''))?.[1] || null;
  return {
    version,
    url,
    asset: safeUrl(download) ? { url: download, size: Number(a.size) || null, sha256 } : null,
  };
}

export function createUpdater({ root, data, version, port, log, isBusy, shutdown, feedUrl }) {
  const dir = path.join(data, 'update');
  const script = path.join(root, 'scripts', 'update.ps1');
  let state = { state: 'idle' };

  // Only a release package on Windows can replace itself; running from source means git pull
  const supported = () => process.platform === 'win32'
    && SEMVER.test(version)
    && fs.existsSync(path.join(root, 'runtime', 'node.exe'))
    && fs.existsSync(script);

  const set = (s) => {
    state = s;
    if (s.state === 'error') log(`update failed: ${s.code}${s.detail ? ' (' + s.detail + ')' : ''}`);
  };

  async function latest() {
    const res = await fetch(feedUrl, {
      headers: { 'User-Agent': 'Ardite', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'updateCheckFailed' });
    return readRelease(await res.json());
  }

  async function download(asset, file) {
    const res = await fetch(asset.url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (!res.ok || !res.body) throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'updateDownloadFailed' });
    const total = Number(res.headers.get('content-length')) || asset.size || 0;
    const hash = crypto.createHash('sha256');
    let done = 0;
    const count = new Transform({
      transform(chunk, _enc, cb) {
        done += chunk.length;
        hash.update(chunk);
        state = { ...state, percent: total ? Math.min(99, Math.floor((done / total) * 100)) : null };
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), count, fs.createWriteStream(file));
    const sha256 = hash.digest('hex');
    if (asset.sha256 && sha256 !== asset.sha256) {
      throw Object.assign(new Error('checksum mismatch'), { code: 'updateBadFile' });
    }
    return sha256;
  }

  function unpack(zip, into) {
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    return new Promise((resolve, reject) => {
      execFile(tar, ['-xf', zip, '-C', into], { windowsHide: true, timeout: 5 * 60 * 1000 }, (err) => {
        if (err) reject(Object.assign(err, { code: 'updateBadFile' }));
        else resolve();
      });
    });
  }

  async function run(release) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    set({ state: 'downloading', version: release.version, percent: 0 });
    const zip = path.join(dir, ASSET);
    const sha256 = await download(release.asset, zip);
    log(`update v${release.version} downloaded (sha256 ${sha256}${release.asset.sha256 ? ', verified' : ''})`);

    set({ state: 'installing', version: release.version });
    const unpacked = path.join(dir, 'new');
    fs.mkdirSync(unpacked);
    await unpack(zip, unpacked);
    const app = path.join(unpacked, 'Ardite');
    let pkg = {};
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
    } catch { /* checked below */ }
    const complete = ['server.js', 'runtime/node.exe', 'public/index.html', 'scripts/start-hidden.vbs']
      .every((f) => fs.existsSync(path.join(app, f)));
    if (pkg.version !== release.version || !complete) {
      throw Object.assign(new Error(`package says ${pkg.version}`), { code: 'updateBadFile' });
    }
    fs.rmSync(zip, { force: true });

    if (isBusy()) throw Object.assign(new Error('a download started'), { code: 'updateBusy' });

    // The script runs from a copy, since the original gets replaced while it runs
    const runner = path.join(dir, 'update.ps1');
    fs.copyFileSync(script, runner);
    // Started through "cmd /c start": a PowerShell spawned straight from Node dies when Node exits,
    // even when detached. The command line is built by hand so paths with spaces stay intact.
    const q = (s) => `"${s}"`;
    const line = ['/d', '/c', 'start', '""', '/min', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-File', q(runner), '-AppDir', q(root), '-NewDir', q(app), '-Port', String(port),
      '-Version', release.version, '-OldVersion', version, '-OldPid', String(process.pid)].join(' ');
    const child = spawn('cmd.exe', [line], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
    child.unref();
    log(`handing over to the updater for v${release.version}, restarting`);
    set({ state: 'restarting', version: release.version });
    // give the browser a moment to hear "restarting" before the server goes away
    setTimeout(shutdown, 800);
  }

  return {
    supported,
    status: () => state,

    // Starts an update in the background; throws { code } when it can't start
    async start() {
      if (!supported()) throw Object.assign(new Error('not a release package'), { code: 'updateUnavailable' });
      if (['downloading', 'installing', 'restarting'].includes(state.state)) {
        throw Object.assign(new Error('already updating'), { code: 'updateRunning' });
      }
      if (isBusy()) throw Object.assign(new Error('downloads running'), { code: 'updateBusy' });
      const release = await latest();
      if (!release?.asset || !isNewer(release.version, version)) {
        throw Object.assign(new Error('no newer release'), { code: 'updateNone' });
      }
      set({ state: 'downloading', version: release.version, percent: 0 });
      run(release).catch((e) => {
        set({ state: 'error', code: e.code || 'updateFailed', detail: e.message });
        fs.rmSync(dir, { recursive: true, force: true });
      });
      return release;
    },
  };
}
