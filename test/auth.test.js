import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validPin, hashPin, checkPin, parseCookies, createLimiter, createSessions } from '../lib/auth.js';

test('validPin wants 4 to 64 characters without control characters', () => {
  for (const pin of ['1234', 'abcd', 'uzun bir şifre', 'x'.repeat(64)]) assert.equal(validPin(pin), true, pin);
  for (const pin of ['123', '', 'x'.repeat(65), 'ab\ncd', 1234, null, undefined]) assert.equal(validPin(pin), false, String(pin));
});

test('a PIN is stored hashed and checked against the hash', () => {
  const stored = hashPin('2468');
  assert.match(stored.salt, /^[a-f0-9]{32}$/);
  assert.match(stored.hash, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(stored).includes('2468'));
  assert.equal(checkPin('2468', stored), true);
  assert.equal(checkPin('2469', stored), false);
  assert.equal(checkPin(2468, stored), false);
  assert.equal(checkPin('2468', null), false);
  assert.equal(checkPin('2468', { salt: 'x', hash: 'broken' }), false);
  // the same PIN gets a different salt each time
  assert.notEqual(hashPin('2468').hash, stored.hash);
});

test('parseCookies reads a Cookie header', () => {
  assert.deepEqual(parseCookies('a=1; ardite_7878=abc; b='), { a: '1', ardite_7878: 'abc', b: '' });
  assert.deepEqual(parseCookies(undefined), {});
});

test('the limiter makes each wrong PIN after the free ones wait twice as long', () => {
  let clock = 0;
  const l = createLimiter({ free: 3, base: 1000, max: 5000, now: () => clock });
  l.fail('a');
  l.fail('a');
  assert.equal(l.wait('a'), 0);
  l.fail('a');
  assert.equal(l.wait('a'), 1000);
  l.fail('a');
  assert.equal(l.wait('a'), 2000);
  l.fail('a');
  l.fail('a');
  assert.equal(l.wait('a'), 5000); // capped
  assert.equal(l.wait('b'), 0); // others aren't affected
  clock += 5000;
  assert.equal(l.wait('a'), 0);
  l.ok('a');
  l.fail('a');
  assert.equal(l.wait('a'), 0); // a right PIN starts over
});

test('sessions survive a restart, keep only hashes and can be cleared', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ardite-auth-'));
  try {
    const file = path.join(dir, 'sessions.json');
    let clock = 1_000_000;
    const s = createSessions(file, () => clock);
    const token = s.add('android');
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.equal(s.check(token), true);
    assert.equal(s.check('0'.repeat(64)), false);
    assert.equal(s.check('not a token'), false);
    assert.ok(!fs.readFileSync(file, 'utf8').includes(token));

    // a restart reads them back
    const again = createSessions(file, () => clock);
    assert.equal(again.check(token), true);
    assert.equal(again.size, 1);

    // unused for a year: gone
    clock += 366 * 86400000;
    assert.equal(createSessions(file, () => clock).check(token), false);

    clock = 1_000_000;
    const t2 = again.add('iphone');
    again.remove(token);
    assert.equal(again.check(token), false);
    assert.equal(again.check(t2), true);
    again.clear();
    assert.equal(again.check(t2), false);
    assert.equal(again.size, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
