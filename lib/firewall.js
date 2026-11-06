// Letting phones on the home network reach Ardite through the computer's firewall.
// Windows: an inbound rule for the port on private networks (needs administrator rights, so the
// command asks for them), plus two things that silently block phones: an old "block" rule for
// Node.js, and a home network Windows marks as Public. Linux: only a hint, since firewalls differ
// and need root. macOS asks by itself the first time Ardite listens.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const RULE_NAME = 'Ardite (video downloader)';

// Runs a PowerShell command and returns what it printed
async function ps(command) {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
    { windowsHide: true, timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}
// PowerShell's single-quoted strings: a quote is doubled
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
// ConvertTo-Json gives a single object instead of a list of one
const list = (text) => (text ? [].concat(JSON.parse(text)) : []);

export async function isAdmin() {
  if (process.platform !== 'win32') return process.getuid?.() === 0;
  try {
    await run('net', ['session'], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// Runs this same command again with administrator rights (Windows asks the user) and waits for it
export async function runElevated(node, args) {
  const argList = args.map((a) => `'"${String(a).replace(/'/g, "''")}"'`).join(',');
  await ps(`Start-Process -FilePath ${psq(node)} -ArgumentList ${argList} -Verb RunAs -Wait`);
}

export async function firewallRuleExists() {
  if (process.platform !== 'win32') return null; // unknown
  try {
    await run('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${RULE_NAME}`], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// The rule for the port (replacing an older one, e.g. for another port). Needs administrator rights.
export async function addFirewallRule(port) {
  await ps(`Remove-NetFirewallRule -DisplayName ${psq(RULE_NAME)} -ErrorAction SilentlyContinue; `
    + `New-NetFirewallRule -DisplayName ${psq(RULE_NAME)} -Direction Inbound -Protocol TCP -LocalPort ${Number(port)} -Action Allow -Profile Private | Out-Null`);
}

export async function removeFirewallRule() {
  await ps(`Remove-NetFirewallRule -DisplayName ${psq(RULE_NAME)} -ErrorAction SilentlyContinue`);
}

// Clicking "Cancel" on an earlier Windows firewall prompt creates a rule blocking node.exe, which
// wins over the allow rule. Returns those rules for the given programs: [{ name, title }]
export async function nodeBlockRules(programs) {
  const paths = programs.map(psq).join(',');
  return list(await ps(`$p = @(${paths}); Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | `
    + 'Where-Object { $p -contains $_.Program } | Get-NetFirewallRule | '
    + "Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' -and $_.Enabled -eq 'True' } | "
    + 'ForEach-Object { @{ name = $_.Name; title = $_.DisplayName } } | ConvertTo-Json -Compress'));
}

export async function disableRules(names) {
  if (names.length) await ps(`Disable-NetFirewallRule -Name ${names.map(psq).join(',')}`);
}

// Networks Windows marks as Public (phones can't connect there): [{ name, index }]
export async function publicNetworks() {
  return list(await ps("Get-NetConnectionProfile | Where-Object NetworkCategory -eq 'Public' | "
    + 'ForEach-Object { @{ name = $_.Name; index = $_.InterfaceIndex } } | ConvertTo-Json -Compress'));
}

export async function makePrivate(index) {
  await ps(`Set-NetConnectionProfile -InterfaceIndex ${Number(index)} -NetworkCategory Private`);
}

// Linux: which firewall tool is there, to say how to open the port (null: none found)
export async function linuxFirewallHint(port) {
  const has = (cmd) => run('sh', ['-c', `command -v ${cmd}`]).then(() => true, () => false);
  if (await has('ufw')) return `sudo ufw allow ${port}/tcp`;
  if (await has('firewall-cmd')) return `sudo firewall-cmd --permanent --add-port=${port}/tcp && sudo firewall-cmd --reload`;
  return null;
}
