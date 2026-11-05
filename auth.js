// PIN protection: off until a PIN is set in Settings. With a PIN, every other device has to enter
// it once; it then gets a session cookie and stays signed in. This PC itself never needs the PIN.
// The PIN is stored only as a salted scrypt hash, sessions only as SHA-256 hashes of their token.
import fs from 'node:fs';
import crypto from 'node:crypto';

// 4 to 64 characters, digits or anything else, no line breaks or other control characters
export const validPin = (pin) => typeof pin === 'string' && pin.length >= 4 && pin.length <= 64 && !/[\x00-\x1f\x7f]/.test(pin);

export function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pin), salt, 32).toString('hex') };
}

export function checkPin(pin, stored) {
  if (typeof pin !== 'string' || !stored?.salt || !/^[a-f0-9]{64}$/.test(stored.hash || '')) return false;
  const given = Buffer.from(hashPin(pin, stored.salt).hash, 'hex');
  return crypto.timingSafeEqual(given, Buffer.from(stored.hash, 'hex'));
}

// "a=1; b=2" -> { a: '1', b: '2' }
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Wrong PINs: the first few are free, then each one waits twice as long (30 s, 1 min, 2 min...
// up to an hour), so guessing even a 4-digit PIN would take months.
export function createLimiter({ free = 5, base = 30000, max = 3600000, now = Date.now } = {}) {
  const tries = new Map(); // key -> { fails, until }
  return {
    // milliseconds to wait before the next try, 0 when it may try now
    wait(key) {
      const t = tries.get(key);
      return t && t.until > now() ? t.until - now() : 0;
    },
    fail(key) {
      const t = tries.get(key) || { fails: 0, until: 0 };
      t.fails++;
      if (t.fails >= free) t.until = now() + Math.min(max, base * 2 ** (t.fails - free));
      tries.set(key, t);
      if (tries.size > 1000) tries.delete(tries.keys().next().value);
    },
    ok(key) {
      tries.delete(key);
    },
  };
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const MAX_SESSIONS = 200;
const SESSION_DAYS = 365;

// Signed-in devices, kept in a file so a restart doesn't sign everyone out
export function createSessions(file, now = Date.now) {
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(list)) list = [];
  } catch { /* none yet */ }
  const fresh = (s) => now() - s.lastSeen < SESSION_DAYS * 86400000;
  list = list.filter((s) => s && /^[a-f0-9]{64}$/.test(s.hash) && fresh(s));

  const save = () => {
    try {
      fs.writeFileSync(file + '.tmp', JSON.stringify(list));
      fs.renameSync(file + '.tmp', file);
    } catch { /* not critical: devices would only have to enter the PIN again */ }
  };

  return {
    // returns the token for the cookie; only its hash is kept
    add(device) {
      const token = crypto.randomBytes(32).toString('hex');
      list.push({ hash: sha256(token), device, created: now(), lastSeen: now() });
      if (list.length > MAX_SESSIONS) list.sort((a, b) => b.lastSeen - a.lastSeen).length = MAX_SESSIONS;
      save();
      return token;
    },
    check(token) {
      if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
      const s = list.find((x) => x.hash === sha256(token));
      if (!s || !fresh(s)) return false;
      // written at most once a day, not on every request
      if (now() - s.lastSeen > 86400000) {
        s.lastSeen = now();
        save();
      }
      return true;
    },
    remove(token) {
      if (!token) return;
      const hash = sha256(token);
      list = list.filter((x) => x.hash !== hash);
      save();
    },
    clear() {
      list = [];
      save();
    },
    get size() {
      return list.length;
    },
  };
}
