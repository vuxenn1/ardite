// Starting Ardite automatically when the user logs in, the way each system does it:
// - Windows: a "Run" entry in the user's registry, starting scripts/start-hidden.vbs (no window)
// - Linux: a systemd user service
// - macOS: a LaunchAgent
// None of these need administrator rights. The texts are built by pure functions (tested).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_NAME = 'Ardite';
// Versions up to 1.8 put a shortcut into the Startup folder instead
const startupShortcut = () => path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Ardite.lnk');
const SERVICE = 'ardite.service';
const LABEL = 'io.github.vuxenn1.ardite';
const serviceFile = (home = os.homedir()) => path.join(home, '.config', 'systemd', 'user', SERVICE);
const agentFile = (home = os.homedir()) => path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);

// The command Windows runs at login
export function windowsRunCommand(root, windir = process.env.SystemRoot || 'C:\\Windows') {
  return `"${path.win32.join(windir, 'System32', 'wscript.exe')}" "${path.win32.join(root, 'scripts', 'start-hidden.vbs')}"`;
}

// systemd's quoting: inside "...", backslashes and quotes are escaped, "%" is doubled
const sdQuote = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;

// KillMode=process: an update started from the server must survive the server's exit
export function systemdUnit(root, node) {
  return [
    '[Unit]',
    'Description=Ardite video downloader',
    'Wants=network-online.target',
    'After=network-online.target',
    '',
    '[Service]',
    `WorkingDirectory=${sdQuote(root)}`,
    `ExecStart=${sdQuote(node)} ${sdQuote(path.posix.join(root, 'server.js'))}`,
    'Restart=on-failure',
    'RestartSec=5',
    'KillMode=process',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// AbandonProcessGroup: an update started from the server must survive the server's exit
export function launchAgent(root, node) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(path.posix.join(root, 'server.js'))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(root)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`;
}

// The folder with a separator at the end, so "C:/Ardite" doesn't also match "C:/Ardite-old"
const inFolder = (root) => path.join(root, path.sep).toLowerCase();

// Whether a file names a path in this Ardite folder (a .lnk keeps its paths as UTF-16 text)
function mentions(file, root) {
  try {
    const buf = fs.readFileSync(file);
    const want = inFolder(root);
    // UTF-16 text may start at an odd byte, so it's read both ways
    return [buf.toString('latin1'), buf.toString('utf16le'), buf.subarray(1).toString('utf16le')]
      .some((text) => text.toLowerCase().includes(want));
  } catch {
    return false;
  }
}

// The command in the "Run" entry, or null
async function runEntry() {
  try {
    const { stdout } = await run('reg', ['query', RUN_KEY, '/v', RUN_NAME], { windowsHide: true });
    return /REG_SZ\s+(.*)$/m.exec(stdout)?.[1].trim() || null;
  } catch {
    return null;
  }
}
const ours = (command, root) => !!command && command.toLowerCase().includes(inFolder(root));

const systemctl = (...args) => run('systemctl', ['--user', ...args]);

// Whether this Ardite folder starts at login (an entry for another copy doesn't count)
export async function autostartOn(root) {
  if (process.platform === 'win32') return ours(await runEntry(), root) || mentions(startupShortcut(), root);
  return mentions(process.platform === 'darwin' ? agentFile() : serviceFile(), root);
}

// Returns a sentence for the user. root: the Ardite folder; node: the Node.js to run it with.
export async function enableAutostart(root, node) {
  if (process.platform === 'win32') {
    await run('reg', ['add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', windowsRunCommand(root), '/f'], { windowsHide: true });
    // the old way, so it doesn't start twice
    if (mentions(startupShortcut(), root)) fs.rmSync(startupShortcut(), { force: true });
    return 'Ardite will start automatically when you log in to Windows.';
  }
  if (process.platform === 'darwin') {
    fs.mkdirSync(path.dirname(agentFile()), { recursive: true });
    fs.writeFileSync(agentFile(), launchAgent(root, node));
    return 'Ardite will start automatically when you log in to this Mac.';
  }
  try {
    await systemctl('--version');
  } catch {
    throw new Error('this system has no systemd, so Ardite can\'t start by itself. Start it with "./ardite start".');
  }
  fs.mkdirSync(path.dirname(serviceFile()), { recursive: true });
  fs.writeFileSync(serviceFile(), systemdUnit(root, node));
  await systemctl('daemon-reload').catch(() => {});
  await systemctl('enable', SERVICE);
  // also before anyone logs in (e.g. a Raspberry Pi without a screen); may need permission
  const linger = await run('loginctl', ['enable-linger', os.userInfo().username]).then(() => true, () => false);
  return linger
    ? 'Ardite will start automatically when this computer starts.'
    : 'Ardite will start automatically when you log in.';
}

// Only this folder's entries are removed; another copy of Ardite keeps its own
export async function disableAutostart(root) {
  if (process.platform === 'win32') {
    if (ours(await runEntry(), root)) await run('reg', ['delete', RUN_KEY, '/v', RUN_NAME, '/f'], { windowsHide: true });
    if (mentions(startupShortcut(), root)) fs.rmSync(startupShortcut(), { force: true });
  } else if (process.platform === 'darwin') {
    if (mentions(agentFile(), root)) fs.rmSync(agentFile(), { force: true });
  } else if (mentions(serviceFile(), root)) {
    await systemctl('disable', SERVICE).catch(() => {});
    fs.rmSync(serviceFile(), { force: true });
    await systemctl('daemon-reload').catch(() => {});
  }
  return 'Autostart is off.';
}
