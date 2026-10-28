import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createZip, fileCrc32 } from '../zip.js';

// Reads a stored (uncompressed) ZIP through its central directory, the way unzip tools do
function readZip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'end of central directory record');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central directory header');
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    assert.equal(buf.readUInt32LE(offset), 0x04034b50, 'local header');
    const dataStart = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const data = buf.subarray(dataStart, dataStart + size);
    assert.equal(zlib.crc32(data) >>> 0, crc, `crc of ${name}`);
    files[name] = data.toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

test('createZip builds a valid archive of the exact announced size', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ardite-zip-'));
  try {
    const a = path.join(dir, 'a.txt');
    const b = path.join(dir, 'b.txt');
    fs.writeFileSync(a, 'hello');
    fs.writeFileSync(b, 'Şarkı '.repeat(1000));
    const entries = [];
    for (const [file, name] of [[a, '01 - Video.mp4'], [b, '02 - Şarkı [x].en.srt']]) {
      entries.push({ name, path: file, size: fs.statSync(file).size, crc: await fileCrc32(file) });
    }
    const { length, stream } = createZip(entries);
    const out = path.join(dir, 'out.zip');
    await pipeline(stream, fs.createWriteStream(out));
    const buf = fs.readFileSync(out);
    assert.equal(buf.length, length);
    assert.deepEqual(readZip(buf), {
      '01 - Video.mp4': 'hello',
      '02 - Şarkı [x].en.srt': 'Şarkı '.repeat(1000),
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
