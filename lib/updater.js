// One-click update for release packages.
// The server downloads the new package for its system, checks it and unpacks it next to itself,
// then hands over to scripts/update.mjs and exits. That runs on a copy of Node.js in data/update,
// since Windows doesn't let a running program's own node.exe be replaced. It backs up the current
// files, copies the new ones, starts Ardite again and, if the new version doesn't come up, puts
// the backup back and starts the old version.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isNewer } from './core.js';
import { tarCommand } from './tools.js';

// The release package for a system (the release workflow builds one for each)
export function packageName(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return 'Ardite-win64.zip'; // also runs on Windows on ARM
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) return `Ardite-linux-${arch}.tar.gz`;
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) return `Ardite-macos-${arch}.tar.gz`;
  return null;
}

const EXE = process.platform === 'win32' ? '.exe' : '';
const SEMVER = /^\d+\.\d+\.\d+$/;
// Packages only come over https; plain http is allowed for this PC itself (local test feeds)
const safeUrl = (u) => u.startsWith('https://') || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u);

// The parts of a GitHub "latest release" answer that matter here, or null if it doesn't look right
export function readRelease(r, asset = packageName()) {
  const version = String(r?.tag_name || '').replace(/^v/, '');
  const url = String(r?.html_url || '');
  if (!SEMVER.test(version) || !url.startsWith('https://')) return null;
  const a = asset ? (r.assets || []).find((x) => x?.name === asset) : null;
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
  const script = path.join(root, 'scripts', 'update.mjs');
  const ASSET = packageName();
  let state = { state: 'idle' };

  // Only a release package can replace itself; running from source means git pull
  const supported = () => !!ASSET
    && SEMVER.test(version)
    && fs.existsSync(path.join(root, 'runtime', 'node' + EXE))
    && fs.existsSync(script);

  // The copy of Node.js the last update ran on can only go once that has finished
  setTimeout(() => {
    if (state.state !== 'idle') return;
    for (const f of ['node' + EXE, 'update.mjs']) {
      try {
        fs.rmSync(path.join(dir, f), { force: true });
      } catch { /* still running: next time */ }
    }
  }, 2 * 60 * 1000).unref();

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

  function unpack(archive, into) {
    return new Promise((resolve, reject) => {
      execFile(tarCommand(), ['-xf', archive, '-C', into], { windowsHide: true, timeout: 5 * 60 * 1000 }, (err) => {
        if (err) reject(Object.assign(err, { code: 'updateBadFile' }));
        else resolve();
      });
    });
  }

  async function run(release) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    set({ state: 'downloading', version: release.version, percent: 0 });
    const archive = path.join(dir, ASSET);
    const sha256 = await download(release.asset, archive);
    log(`update v${release.version} downloaded (sha256 ${sha256}${release.asset.sha256 ? ', verified' : ''})`);

    set({ state: 'installing', version: release.version });
    const unpacked = path.join(dir, 'new');
    fs.mkdirSync(unpacked);
    await unpack(archive, unpacked);
    const app = path.join(unpacked, 'Ardite');
    let pkg = {};
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
    } catch { /* checked below */ }
    // scripts/start-hidden.vbs: updates from v1.8 and older start the new version with it
    const needed = ['server.js', 'ardite.js', 'lib/routes.js', `runtime/node${EXE}`, 'public/index.html', 'scripts/update.mjs'];
    if (process.platform === 'win32') needed.push('scripts/start-hidden.vbs');
    const complete = needed.every((f) => fs.existsSync(path.join(app, f)));
    if (pkg.version !== release.version || !complete) {
      throw Object.assign(new Error(`package says ${pkg.version}`), { code: 'updateBadFile' });
    }
    fs.rmSync(archive, { force: true });

    if (isBusy()) throw Object.assign(new Error('a download started'), { code: 'updateBusy' });

    // The updater and the Node.js it runs on are copies, since the originals get replaced. It's
    // started on its own (detached), so it keeps running when this server exits.
    const node = path.join(dir, 'node' + EXE);
    const runner = path.join(dir, 'update.mjs');
    fs.copyFileSync(process.execPath, node);
    fs.copyFileSync(script, runner);
    const child = spawn(node, [runner, '--app', root, '--new', app, '--port', String(port),
      '--version', release.version, '--old-version', version, '--old-pid', String(process.pid)],
    { cwd: dir, detached: true, stdio: 'ignore', windowsHide: true });
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
