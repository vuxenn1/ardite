// Installs an Ardite update that the server has downloaded and unpacked (see lib/updater.js).
// Runs from a copy in data/update, on a copy of Node.js, while the server stops: backs up the
// current files, copies the new ones over, starts Ardite and checks it answers with the new version.
// If it doesn't, the backup is put back and the old version is started again.
// Self-contained on purpose (only Node's own modules): the files of lib/ are replaced while it runs.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EXE = process.platform === 'win32' ? '.exe' : '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --app <dir> --new <dir> --port <n> --version <v> --old-version <v> --old-pid <n> [--wait <s>]
export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase());
    opts[key] = argv[i + 1];
  }
  for (const k of ['app', 'new', 'port', 'version', 'oldVersion']) {
    if (!opts[k]) throw new Error(`missing --${k}`);
  }
  return {
    app: path.resolve(opts.app),
    newDir: path.resolve(opts.new),
    port: Number(opts.port),
    version: opts.version,
    oldVersion: opts.oldVersion,
    oldPid: Number(opts.oldPid) || 0,
    wait: Number(opts.wait) || 40, // seconds a version gets to start
  };
}

// Release packages list their files in files.txt ("public/js/app.js" etc.). Only plain relative
// paths count: nothing in data or bin, nothing outside the folder.
export function readFileList(dir) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(dir, 'files.txt'), 'utf8');
  } catch {
    return [];
  }
  return text.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !/\\|:|^\/|(^|\/)\.\.?(\/|$)/.test(l) && !/^(data|bin)(\/|$)/.test(l));
}

// Files the previous version shipped (its files.txt) that the new package doesn't contain: left
// behind they could confuse the new version. Only files really missing from the new package are
// picked, so a damaged list can never remove anything the new version needs.
export const staleFiles = (app, newDir) => readFileList(app).filter((rel) => !fs.existsSync(path.join(newDir, rel)));

const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
};

// Backs up exactly what is about to be replaced or removed; data and bin aren't in the package
// and stay as they are. Returns the names of what was left out.
export function makeBackup(app, newDir, stale, backup) {
  fs.rmSync(backup, { recursive: true, force: true });
  fs.mkdirSync(backup, { recursive: true });
  const names = new Set([...fs.readdirSync(newDir), ...stale.map((rel) => rel.split('/')[0])]);
  const skipped = [];
  for (const name of names) {
    const current = path.join(app, name);
    if (!fs.existsSync(current)) continue;
    // never copy a folder that holds the backup itself: it would copy into itself without end
    if (inside(backup, current)) {
      skipped.push(name);
      continue;
    }
    fs.cpSync(current, path.join(backup, name), { recursive: true, force: true, preserveTimestamps: true });
  }
  return skipped;
}

// Copies every file and folder from one place over another (folders are merged). A file is
// removed before the new one goes in where that's allowed (not Windows): Linux refuses to write
// into a program that's still running, but lets it be replaced.
export function copyOver(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      copyOver(src, dest);
    } else {
      if (process.platform !== 'win32') fs.rmSync(dest, { force: true });
      fs.copyFileSync(src, dest);
    }
  }
}

export function removeStale(app, stale, log = () => {}) {
  for (const rel of stale) {
    const file = path.join(app, rel);
    try {
      if (!fs.statSync(file).isFile()) continue;
    } catch {
      continue;
    }
    fs.rmSync(file, { force: true });
    log(`removed ${rel}`);
    // and its folder, if that's now empty
    const dir = path.dirname(file);
    if (dir !== app && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  }
}

// Programs running from the Ardite folder (its Node.js, yt-dlp, ffmpeg), except this updater and
// anything in data/ (where this updater's own copy of Node.js lives)
function programsInside(app) {
  const data = path.join(app, 'data');
  const ours = (exe) => exe && inside(exe, app) && !inside(exe, data);
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Where-Object ExecutablePath | ForEach-Object { "$($_.ProcessId)|$($_.Name)|$($_.ExecutablePath)" }'],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      return out.split(/\r?\n/).map((l) => l.split('|')).filter(([pid, , exe]) => Number(pid) !== process.pid && ours(exe?.trim()))
        .map(([pid, name]) => ({ pid: Number(pid), name }));
    }
    let list = [];
    if (process.platform === 'linux') {
      // each process's program, as Linux keeps it (other users' processes can't be read: skipped)
      for (const pid of fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
        try {
          list.push({ pid: Number(pid), exe: fs.readlinkSync(`/proc/${pid}/exe`) });
        } catch { /* gone or not ours */ }
      }
    } else {
      // macOS shows the program's full path as its "command"
      const out = execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8', timeout: 10000 });
      list = out.split('\n').map((l) => /^\s*(\d+)\s+(.+)$/.exec(l)).filter(Boolean)
        .map((m) => ({ pid: Number(m[1]), exe: m[2].trim() }));
    }
    return list.filter((p) => p.pid !== process.pid && ours(p.exe)).map((p) => ({ pid: p.pid, name: path.basename(p.exe) }));
  } catch {
    return [];
  }
}

function stopPrograms(app) {
  for (const p of programsInside(app)) {
    try {
      process.kill(p.pid, 'SIGKILL');
    } catch { /* already gone */ }
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

async function answers(port, version) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(3000) });
    const s = await res.json();
    return s.name === 'Ardite' && s.version === version;
  } catch {
    return false;
  }
}

// Waits by the clock, not by attempts, so a slow check can't stretch the wait
async function waitRunning(port, version, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await answers(port, version)) return true;
    await sleep(500);
  }
  return false;
}

const appNode = (app) => {
  const bundled = path.join(app, 'runtime', 'node' + EXE);
  return fs.existsSync(bundled) ? bundled : process.execPath;
};

// Starts the server in the background, on its own (it keeps running when this updater ends)
function startArdite(app) {
  spawn(appNode(app), ['server.js'], { cwd: app, detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

export async function runUpdate(o) {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const logFile = path.join(dir, 'update.log');
  const backup = path.join(dir, 'backup');
  // local time, "2026-11-06 19:48:57"
  const stamp = () => {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().replace('T', ' ').slice(0, 19);
  };
  const log = (m) => fs.appendFileSync(logFile, `[${stamp()}] ${m}\n`);

  async function restoreBackup() {
    log('putting the previous version back');
    stopPrograms(o.app);
    await sleep(1000);
    copyOver(backup, o.app);
    startArdite(o.app);
    if (await waitRunning(o.port, o.oldVersion, o.wait)) log(`rolled back to v${o.oldVersion}`);
    else log('the previous version did not start either; run "ardite start", or "ardite install"');
  }

  let stale = [];
  try {
    log(`updating v${o.oldVersion} -> v${o.version} in ${o.app}`);
    // 1. wait for the server to stop (it exits right after starting this updater)
    for (let i = 0; i < 60 && o.oldPid && alive(o.oldPid); i++) await sleep(500);
    stopPrograms(o.app);
    await sleep(1000);
    // 2. back up
    stale = staleFiles(o.app, o.newDir);
    for (const name of makeBackup(o.app, o.newDir, stale, backup)) log(`not backing up ${name} (the backup is inside it)`);
    log('backup done');
  } catch (e) {
    log(`could not prepare the update: ${e.message}`);
    startArdite(o.app);
    return 1;
  }

  try {
    // 3. new files in. Windows can keep a program file (runtime\node.exe) locked for a while after
    // the program has stopped, e.g. while antivirus looks at it, so this is tried for about 30 s.
    for (let attempt = 1; ; attempt++) {
      try {
        copyOver(o.newDir, o.app);
        break;
      } catch (e) {
        if (attempt >= 10) throw e;
        const running = programsInside(o.app).map((p) => `${p.name} (PID ${p.pid})`).join(', ') || 'nothing';
        log(`files still in use, trying again in 3 s (${attempt}/9): ${e.message} Running from the folder: ${running}`);
        await sleep(3000);
        stopPrograms(o.app);
      }
    }
    log('new files copied');
    removeStale(o.app, stale, (m) => log(`${m} (not part of v${o.version})`));

    // 4. tools: downloads anything a new version needs and updates yt-dlp
    const setup = spawnSync(appNode(o.app), ['setup.js'], { cwd: o.app, encoding: 'utf8', windowsHide: true, timeout: 15 * 60000 });
    fs.writeFileSync(path.join(dir, 'setup.log'), `${setup.stdout || ''}${setup.stderr || ''}`);
    if (setup.status !== 0) log(`setup exited with ${setup.status ?? setup.error?.message} (see setup.log)`);

    // 5. start and check
    startArdite(o.app);
    if (await waitRunning(o.port, o.version, o.wait)) {
      log(`updated to v${o.version}`);
      // the unpacked package (data/update/new/Ardite: the "new" folder goes with it)
      const unpacked = path.basename(path.dirname(o.newDir)) === 'new' ? path.dirname(o.newDir) : o.newDir;
      fs.rmSync(unpacked, { recursive: true, force: true });
      return 0;
    }
    log(`v${o.version} did not start`);
  } catch (e) {
    log(`update failed: ${e.message}`);
  }
  await restoreBackup();
  return 1;
}

// real paths on both sides: on macOS /var is a link to /private/var, and Node reports the latter
const realPath = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
if (process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url))) {
  process.exitCode = await runUpdate(parseArgs(process.argv.slice(2)));
}
