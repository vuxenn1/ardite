import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (f) => fs.readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');

// i18n.js is a browser script; run it with just enough of a browser around it
function loadStrings() {
  const sandbox = {
    navigator: { languages: ['en'] },
    document: { documentElement: {} },
    localStorage: { getItem: () => null },
  };
  vm.runInNewContext(`${read('i18n.js')}\nthis.STRINGS = STRINGS;`, sandbox);
  return sandbox.STRINGS;
}

const STRINGS = loadStrings();

test('every language has the same texts', () => {
  const en = Object.keys(STRINGS.en).sort();
  for (const [lang, strings] of Object.entries(STRINGS)) {
    assert.deepEqual(Object.keys(strings).sort(), en, `keys of ${lang}`);
  }
});

test('texts that take values are functions in every language', () => {
  for (const [key, value] of Object.entries(STRINGS.en)) {
    for (const [lang, strings] of Object.entries(STRINGS)) {
      assert.equal(typeof strings[key], typeof value, `${lang}.${key}`);
    }
  }
});

test('every text the page asks for exists', () => {
  const used = new Set();
  // t('key') calls in app.js (not other methods that end in "t", like get('key'))
  for (const m of read('app.js').matchAll(/(?<![\w.$])t\('([\w.-]+)'/g)) used.add(m[1]);
  // keys built at run time: 'err.' + code, 'phase.' + phase, 'device.' + name
  const html = read('index.html');
  for (const m of html.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)) used.add(m[1]);
  for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const pair of m[1].split(',')) used.add(pair.split(':')[1].trim());
  }
  // keys built at run time ('err.' + code) are checked in the next test
  const missing = [...used].filter((k) => !k.endsWith('.') && !(k in STRINGS.en));
  assert.deepEqual(missing, []);
});

test('every error code and phase the server sends has a text', () => {
  const codes = new Set();
  for (const f of ['core.js', 'server.js', 'updater.js']) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/\[\/.*?\/i?, '(\w+)', '/g)) codes.add(`err.${m[1]}`); // friendlyError rules
    for (const m of src.matchAll(/fail\('(\w+)'/g)) codes.add(`err.${m[1]}`);
    for (const m of src.matchAll(/code: '(\w+)'/g)) codes.add(`err.${m[1]}`);
    // job.phase = ...; (all the values a statement can set) and phase: '...' in objects
    for (const m of src.matchAll(/phase = ([^;]+);/g)) {
      for (const v of m[1].matchAll(/'([a-z-]+)'/g)) if (v[1] !== 'audio' && v[1] !== 'video') codes.add(`phase.${v[1]}`);
    }
    for (const m of src.matchAll(/phase: '([a-z-]+)'/g)) codes.add(`phase.${m[1]}`);
    // stages read from yt-dlp's log, e.g. [/^\[Merger\]/, 'merging']
    for (const m of src.matchAll(/\[\/\^\\\[[^\n]*?\/, '([a-z-]+)'\]/g)) codes.add(`phase.${m[1]}`);
  }
  for (const m of fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8').matchAll(/return '(\w+)';/g)) {
    codes.add(`device.${m[1]}`);
  }
  // make sure the search itself works, so this test can't pass by finding nothing
  for (const k of ['err.signin', 'err.badTrim', 'err.updateBusy', 'phase.merging', 'phase.starting', 'phase.downloading-video', 'phase.queued', 'device.pc']) {
    assert.ok(codes.has(k), `found ${k}`);
  }
  const missing = [...codes].filter((k) => !(k in STRINGS.en));
  assert.deepEqual(missing, []);
});
