// Managing Ardite on this computer: setting it up, starting and stopping it, autostart, the
// firewall and updates. Works the same on Windows, Linux and macOS; the .bat files (Windows) and
// the "ardite" script (Linux, macOS) only run this with the right Node.js.
// Usage: node ardite.js <command> [--pause] [--no-open]   (node ardite.js help lists the commands)
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { config, ROOT, RUNTIME_NODE } from './lib/config.js';
import { lanAddresses } from './lib/network.js';
import { serverNode, serverState, startServer, stopServer, probe, callArdite } from './lib/service.js';
import { autostartOn, enableAutostart, disableAutostart } from './lib/autostart.js';
import {
  isAdmin, runElevated, firewallRuleExists, addFirewallRule, removeFirewallRule,
  nodeBlockRules, disableRules, publicNetworks, makePrivate, linuxFirewallHint,
} from './lib/firewall.js';

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SELF = fileURLToPath(import.meta.url);
const PORT = config.port;
const URL_HERE = `http://localhost:${PORT}`;
const isWin = process.platform === 'win32';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [command = 'help', sub] = args.filter((a) => !a.startsWith('--'));

// ---------- output ----------

const paint = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = paint(32);
const yellow = paint(33);
const red = paint(31);
const say = (s = '') => console.log(s ? `  ${s}` : '');

async function ask(question) {
  if (!process.stdin.isTTY) return '';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`  ${question} `)).trim();
  } finally {
    rl.close();
  }
}
const yes = async (question) => /^[yY]/.test(await ask(`${question} (Y/N)`));

// ---------- commands ----------

async function start() {
  const r = await startServer(PORT);
  if (r.state === 'running') say(`Ardite is already running: ${URL_HERE}`);
  else if (r.state === 'started') say(green(`Ardite started: ${URL_HERE}`));
  else if (r.state === 'conflict') portConflict(r);
  else {
    say(red('Ardite could not be started. See data/ardite.log for details.'));
    return false;
  }
  return r.state !== 'conflict';
}

function portConflict({ pid, name }) {
  const who = pid ? ` (${name || 'unknown'}, PID ${pid})` : '';
  say(red(`Port ${PORT} is used by another program${who}.`));
  say('Close it, or set another port in data/config.json, e.g. { "port": 7879 }');
}

async function stop() {
  if (await stopServer(PORT)) say('Ardite stopped.');
  else say('Ardite is not running.');
}

async function status() {
  const s = await serverState(PORT);
  say();
  if (s.state === 'running') say(green(`Status    : RUNNING (v${s.status.version})`));
  else if (s.state === 'conflict') say(red(`Status    : stopped (port ${PORT} is used by another program${s.pid ? `, PID ${s.pid}` : ''})`));
  else say(yellow('Status    : stopped'));
  say(`Autostart : ${(await autostartOn(ROOT)) ? 'on' : 'off'}`);
  if (isWin) say(`Firewall  : ${(await firewallRuleExists()) ? 'allowed' : 'no rule'}`);
  say(`This PC   : ${URL_HERE}`);
  for (const ip of lanAddresses()) say(`Phone     : http://${ip}:${PORT}`);
  say();
}

function openPage() {
  if (isWin) spawn('rundll32', ['url.dll,FileProtocolHandler', URL_HERE], { detached: true, stdio: 'ignore' }).unref();
  else if (process.platform === 'darwin') spawn('open', [URL_HERE], { detached: true, stdio: 'ignore' }).unref();
  else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) spawn('xdg-open', [URL_HERE], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  else say(`Open ${URL_HERE} in a browser (or this computer's address on a phone, see "ardite status").`);
}

async function autostart(on) {
  try {
    say(green(on ? await enableAutostart(ROOT, serverNode()) : await disableAutostart(ROOT)));
  } catch (e) {
    say(yellow(`Autostart: ${e.message}`));
  }
}

// The Node.js programs a Windows "block" rule may name: the package's own and an installed one
async function nodePrograms() {
  const found = new Set([RUNTIME_NODE, process.execPath]);
  try {
    for (const p of (await run('where', ['node'], { windowsHide: true })).stdout.split(/\r?\n/)) if (p.trim()) found.add(p.trim());
  } catch { /* no installed Node.js */ }
  return [...found].filter((p) => fs.existsSync(p));
}

async function firewall(on) {
  if (!isWin) {
    if (!on) return;
    const hint = process.platform === 'linux' ? await linuxFirewallHint(PORT) : null;
    if (hint) say(`If phones can't connect, open port ${PORT} in the firewall: ${hint}`);
    return;
  }
  if (!(await isAdmin())) {
    say(on ? 'Asking for firewall permission so your phone can connect (click Yes)...' : 'Asking for permission to remove the firewall rule (click Yes)...');
    try {
      await runElevated(process.execPath, [SELF, 'firewall', on ? 'on' : 'off', '--elevated']);
    } catch {
      say(yellow('Permission was not given; nothing changed.'));
      return;
    }
    const exists = await firewallRuleExists();
    if (on) say(exists ? green(`Firewall: devices on your home network can reach port ${PORT}.`) : yellow('Firewall: no rule was added.'));
    else say(exists ? yellow('Firewall: the rule is still there.') : 'Firewall rule removed.');
    return;
  }

  // with administrator rights (from the elevated window, or run as administrator)
  if (!on) {
    await removeFirewallRule();
    say('Firewall rule removed.');
    if (flags.has('--elevated')) await sleep(1000);
    return;
  }
  await addFirewallRule(PORT);
  say(green(`Firewall: devices on your home network can reach port ${PORT}.`));
  let asked = false;
  const blocks = await nodeBlockRules(await nodePrograms()).catch(() => []);
  if (blocks.length) {
    asked = true;
    say(yellow('A firewall rule is BLOCKING incoming connections to Node.js; phones will not be able to connect.'));
    if (await yes('Disable these block rules?')) {
      await disableRules(blocks.map((b) => b.name));
      say(green('Disabled.'));
    }
  }
  for (const n of await publicNetworks().catch(() => [])) {
    asked = true;
    say();
    say(yellow(`The network '${n.name}' is marked as Public in Windows.`));
    say('Your home network must be Private for phones to connect.');
    if (await yes('If this is your home network, make it Private?')) {
      await makePrivate(n.index);
      say(green('Network set to Private.'));
    }
  }
  if (flags.has('--elevated')) {
    if (asked) await ask('Press Enter to close');
    else await sleep(2000);
  }
}

async function install() {
  // tools first: without yt-dlp the server doesn't start
  const setup = spawnSync(serverNode(), [path.join(ROOT, 'setup.js')], { cwd: ROOT, stdio: 'inherit' });
  if (setup.status !== 0) throw new Error('the setup did not finish (see above)');
  await autostart(true);
  await firewall(true);
  if (await probe(PORT)) await stop();
  const ok = await start();
  await status();
  if (ok && !flags.has('--no-open')) openPage();
  say(ok ? 'Setup complete.' : 'Setup finished, but Ardite is not running.');
}

async function uninstall() {
  say('Ardite will be stopped, and autostart and the firewall rule will be removed.');
  await stop();
  await autostart(false);
  if (isWin) await firewall(false);
  say(`Done. You can delete this folder yourself: ${ROOT}`);
}

// Asks the running Ardite to install the newest release. Follows it until Ardite restarts, then
// leaves: the update replaces runtime/node.exe, which this command may be running on.
async function update() {
  const before = await probe(PORT);
  if (!before) throw new Error('Ardite is not running. Start it first: ardite start');
  if (!before.update) return say(`You have the latest version (v${before.version}).`);
  if (!before.update.canInstall) {
    return say(`v${before.update.version} is out, but this copy can't update itself (it runs from the source code; use git pull).`);
  }
  const res = await callArdite(PORT, '/api/update', { method: 'POST', body: {}, timeout: 60000 });
  if (res.status !== 202) throw new Error(`the update could not start (${res.data?.code || res.status})`);
  say(`Downloading v${before.update.version}...`);
  const end = Date.now() + 15 * 60000;
  while (Date.now() < end) {
    await sleep(1000);
    const st = await callArdite(PORT, '/api/update').then((r) => r.data, () => null);
    if (st?.state === 'error') throw new Error(`the update failed (${st.code}${st.detail ? ': ' + st.detail : ''})`);
    // "restarting", or already gone: the updater has taken over
    if (!st || st.state === 'restarting') {
      say(green(`Installing v${before.update.version}. Ardite restarts by itself in a minute or so.`));
      say('Check with "ardite status"; if anything goes wrong, see data/update/update.log');
      return;
    }
  }
  throw new Error('the download is taking too long; try again later');
}

const HELP = `
  Ardite ${'-'.repeat(40)}
  install            download the tools, start Ardite now and at every login, open it
  start | stop | restart
  status             running or not, and the addresses to open on a phone
  open               open Ardite in the browser
  update             install the newest version
  autostart on|off   start Ardite when you log in
  firewall on|off    let phones through the firewall (Windows)
  uninstall          stop Ardite, remove autostart and the firewall rule
`;

const COMMANDS = {
  install,
  start,
  stop,
  restart: async () => {
    await stop();
    await sleep(500);
    return start();
  },
  status,
  open: openPage,
  update,
  uninstall,
  autostart: () => autostart(sub !== 'off'),
  firewall: () => firewall(sub !== 'off'),
  help: () => console.log(HELP),
};

let code = 0;
try {
  const fn = COMMANDS[command];
  if (!fn) {
    console.log(`\n  Unknown command: ${command}`);
    console.log(HELP);
    code = 1;
  } else if ((await fn()) === false) {
    code = 1;
  }
} catch (e) {
  say(red(`Error: ${e.message}`));
  code = 1;
}

// Opened by double-clicking a .bat file: keep the window open long enough to read it
if (flags.has('--pause')) {
  if (['start', 'stop', 'restart'].includes(command) && !code) await sleep(3000);
  else await ask('Press Enter to close');
}
process.exit(code);
