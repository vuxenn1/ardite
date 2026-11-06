// Starting, stopping and checking the Ardite server from the outside (the `ardite` command).
// The server notes its process id in data/ardite.pid; whether it's really Ardite is always asked
// on its port, so a stale file or another program on the port is never taken for it.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT, RUNTIME_NODE, PID_FILE } from './config.js';

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isWin = process.platform === 'win32';

// The Node.js to run the server with: the package's own, otherwise the one running this
export const serverNode = () => (fs.existsSync(RUNTIME_NODE) ? RUNTIME_NODE : process.execPath);

// A request to Ardite on this PC: { status, data }. Through node:http with no connection kept
// open, not fetch(): on Windows, Node can crash when the command exits while fetch() still holds
// a connection ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)").
export function callArdite(port, pathname, { method = 'GET', body, timeout = 3000 } = {}) {
  const origin = `http://127.0.0.1:${port}`;
  return new Promise((resolve, reject) => {
    const req = http.request(origin + pathname, {
      method,
      agent: false,
      timeout,
      headers: { Connection: 'close', ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json' }) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (text += d));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(text) });
        } catch {
          resolve({ status: res.statusCode, data: null });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

// The answer of /api/status when Ardite runs on the port, otherwise null
export async function probe(port) {
  try {
    const { data } = await callArdite(port, '/api/status');
    return data?.name === 'Ardite' ? data : null;
  } catch {
    return null;
  }
}

// Whether anything at all listens on the port of this PC
export function portBusy(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(2000);
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => (socket.destroy(), resolve(false)));
  });
}

// "TCP  0.0.0.0:7878  0.0.0.0:0  LISTENING  1234" (netstat -ano) -> 1234
export function pidFromNetstat(text, port) {
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
    if (m && Number(m[1]) === port) return Number(m[2]);
  }
  return null;
}

// The process listening on the port (might be another program), or null when that can't be told
export async function listenerPid(port) {
  try {
    if (isWin) return pidFromNetstat((await run('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true })).stdout, port);
    const { stdout } = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
    return Number(stdout.trim().split('\n')[0]) || null;
  } catch {
    return null;
  }
}

export async function programName(pid) {
  try {
    if (isWin) {
      const { stdout } = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true });
      return /^"([^"]+)"/.exec(stdout.trim())?.[1] || null;
    }
    return (await run('ps', ['-p', String(pid), '-o', 'comm='])).stdout.trim() || null;
  } catch {
    return null;
  }
}

function readPidFile() {
  try {
    const { pid, port } = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    return Number.isInteger(pid) ? { pid, port } : null;
  } catch {
    return null;
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

async function waitFor(check, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(300);
  }
  return !!(await check());
}

// { state: 'running', status } | { state: 'conflict', pid, name } | { state: 'stopped' }
export async function serverState(port) {
  const status = await probe(port);
  if (status) return { state: 'running', status };
  if (!(await portBusy(port))) return { state: 'stopped' };
  const pid = await listenerPid(port);
  return { state: 'conflict', pid, name: pid ? await programName(pid) : null };
}

// Starts the server in the background, on its own (it keeps running when this command ends).
// Returns the new state once it answers, or { state: 'failed' } after `wait` ms.
export async function startServer(port, { wait = 15000 } = {}) {
  const before = await serverState(port);
  if (before.state !== 'stopped') return before;
  spawn(serverNode(), [path.join(ROOT, 'server.js')], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  const ok = await waitFor(async () => !!(await probe(port)), wait);
  return ok ? { state: 'started', status: await probe(port) } : { state: 'failed' };
}

// Stops the server and the downloads it runs. Returns false when Ardite wasn't running.
export async function stopServer(port) {
  if (!(await probe(port))) return false;
  const noted = readPidFile();
  const pid = noted?.port === port && alive(noted.pid) ? noted.pid : await listenerPid(port);
  if (!pid) throw new Error('could not find the Ardite process');
  if (isWin) {
    // Windows has no polite stop for a program without a window: the server and the tools it
    // runs go together
    await run('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
  } else {
    process.kill(pid, 'SIGTERM'); // the server stops its downloads, then exits
    if (!(await waitFor(() => !alive(pid), 5000))) process.kill(pid, 'SIGKILL');
  }
  await waitFor(async () => !(await portBusy(port)), 10000);
  if (readPidFile()?.pid === pid) fs.rmSync(PID_FILE, { force: true });
  return true;
}
