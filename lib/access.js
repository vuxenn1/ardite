// Who may use Ardite: never other websites, and with a PIN set only devices that entered it.
// This PC itself never needs the PIN (see auth.js for how PINs and sessions are kept).
import os from 'node:os';
import path from 'node:path';
import { DATA, config, saveConfig } from './config.js';
import { log } from './log.js';
import { fail, hostAllowed, originAllowed } from './core.js';
import { validPin, hashPin, checkPin, parseCookies, createLimiter, createSessions } from './auth.js';
import { clientIp, isThisPc, deviceOf } from './network.js';
import { sendJson, sendText, readBody } from './http.js';

// ---------- other websites ----------

// Names this PC answers to, besides IP addresses and localhost (see hostAllowed in core.js)
const hostNames = [os.hostname(), ...(Array.isArray(config.allowedHosts) ? config.allowedHosts : [])];
const loggedHosts = new Set();

// A page on another site must not start downloads or read anything here.
// Returns true when the request was refused (and answered).
export function refuseForeign(req, res) {
  const host = req.headers.host || '';
  if (!hostAllowed(host, hostNames)) {
    if (!loggedHosts.has(host) && loggedHosts.size < 50) {
      loggedHosts.add(host);
      log(`refused a request for the address "${host}" (add it to allowedHosts in data/config.json if it's yours)`);
    }
    sendText(res, 403, `Ardite doesn't answer to "${host}". Open it with this PC's IP address instead, `
      + 'or add this name to "allowedHosts" in data/config.json.');
    return true;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && !originAllowed(req.headers.origin, host)) {
    log(`refused a ${req.method} ${req.url.split('?')[0]} from another website (${req.headers.origin})`);
    sendJson(res, 403, fail('forbidden', 'Requests from other websites are not allowed.'));
    return true;
  }
  return false;
}

// ---------- PIN (optional) ----------

const sessions = createSessions(path.join(DATA, 'sessions.json'));
// wrong PINs per device, and from all devices together so many devices can't share the guessing
const pinTries = createLimiter();
const pinTriesAll = createLimiter({ free: 20 });
const SESSION_COOKIE = `ardite_${config.port}`;

export const pinOn = () => !!config.pin?.hash;
export const signedIn = (req) => !pinOn() || isThisPc(req) || sessions.check(parseCookies(req.headers.cookie)[SESSION_COOKIE]);

function setSessionCookie(res, req) {
  const token = sessions.add(deviceOf(req));
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${365 * 86400}`);
}

const pinStatus = (req) => ({ pin: pinOn(), thisPc: isThisPc(req), devices: sessions.size });

// Unlocking, and setting or removing the PIN. Returns true when the request was handled here.
export async function handlePin(req, res, pathname) {
  const reply = (status, data) => (sendJson(res, status, data), true);
  if (pathname === '/api/unlock' && req.method === 'POST') {
    if (signedIn(req)) return reply(200, { ok: true });
    const ip = clientIp(req);
    const wait = Math.max(pinTries.wait(ip), pinTriesAll.wait('*'));
    if (wait) return reply(429, { ...fail('pinWait', 'Too many wrong PINs. Wait a bit.'), wait: Math.ceil(wait / 1000) });
    const { pin } = await readBody(req);
    if (!checkPin(pin, config.pin)) {
      pinTries.fail(ip);
      pinTriesAll.fail('*');
      log(`wrong PIN from ${ip}`);
      return reply(401, fail('pinWrong', 'Wrong PIN.'));
    }
    pinTries.ok(ip);
    setSessionCookie(res, req);
    log(`device unlocked with the PIN (${deviceOf(req)}, ${ip})`);
    return reply(200, { ok: true });
  }

  if (pathname !== '/api/pin') return false;
  if (!signedIn(req)) return reply(401, fail('locked', 'Enter the PIN.'));
  if (req.method === 'GET') return reply(200, pinStatus(req));
  if (req.method === 'PUT') {
    const { pin } = await readBody(req);
    if (!validPin(pin)) return reply(400, fail('pinFormat', 'The PIN needs 4 to 64 characters.'));
    saveConfig({ pin: hashPin(pin) });
    // a new PIN signs every other device out; the one that set it stays in
    sessions.clear();
    if (!isThisPc(req)) setSessionCookie(res, req);
    log('PIN set, other devices signed out');
    return reply(200, pinStatus(req));
  }
  if (req.method === 'DELETE') {
    saveConfig({ pin: '' });
    sessions.clear();
    log('PIN removed');
    return reply(200, pinStatus(req));
  }
  return false;
}
